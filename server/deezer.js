'use strict';
const config = require('./config');
const db = require('./db');

const C = config.deezer;

// ---------- File d'attente avec throttling (fenêtre glissante) ----------
const queue = [];
const stamps = [];
let timer = null;

function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  if (timer) return;
  while (queue.length) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] >= C.windowMs) stamps.shift();
    if (stamps.length >= C.maxRequests) {
      timer = setTimeout(() => { timer = null; pump(); }, C.windowMs - (now - stamps[0]) + 5);
      return;
    }
    stamps.push(now);
    const job = queue.shift();
    job.fn().then(job.resolve, job.reject);
  }
}

// ---------- Cache mémoire (LRU simple) ----------
const mem = new Map();
function memGet(key) {
  const e = mem.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { mem.delete(key); return undefined; }
  mem.delete(key); mem.set(key, e); // remonte en tête
  return e.val;
}
function memSet(key, val, ttl = C.memoryCacheTtlMs) {
  mem.set(key, { val, exp: Date.now() + ttl });
  while (mem.size > C.memoryCacheMax) mem.delete(mem.keys().next().value);
}

function dbReady() { try { return !!db.raw; } catch { return false; } }

// ---------- Requête brute ----------
class DeezerError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function rawGet(path, params = {}, attempt = 0) {
  const url = new URL(C.baseUrl + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await schedule(() =>
    fetch(url, { signal: AbortSignal.timeout(C.timeoutMs), headers: { Accept: 'application/json' } })
  );
  if (!res.ok) throw new DeezerError(`HTTP ${res.status} sur ${path}`, res.status);
  const json = await res.json();
  if (json && json.error) {
    // code 4 = quota dépassé : on attend une fenêtre et on réessaie
    if (json.error.code === 4 && attempt < 3) {
      await new Promise((r) => setTimeout(r, C.windowMs));
      return rawGet(path, params, attempt + 1);
    }
    throw new DeezerError(json.error.message || 'Erreur Deezer', json.error.code);
  }
  return json;
}

/** GET avec cache mémoire puis SQLite (cache_api). */
async function cachedGet(path, params = {}, { dbTtl = C.dbCacheTtlMs, memTtl = C.memoryCacheTtlMs } = {}) {
  const key = path + '?' + new URLSearchParams(params).toString();
  const m = memGet(key);
  if (m !== undefined) return m;
  if (dbTtl && dbReady()) {
    const d = db.getApiCache(key, dbTtl);
    if (d) { memSet(key, d, memTtl); return d; }
  }
  const data = await rawGet(path, params);
  memSet(key, data, memTtl);
  if (dbTtl && dbReady()) db.setApiCache(key, data);
  return data;
}

// ---------- Normalisation des pistes ----------
function toTrack(t) {
  if (!t || !t.id || !t.preview || t.readable === false) return null;
  const artists = [];
  if (t.artist?.name) artists.push(t.artist.name);
  for (const c of t.contributors || []) if (c.name && !artists.includes(c.name)) artists.push(c.name);
  return {
    id: t.id,
    title: t.title,
    titleShort: t.title_short || t.title,
    artist: t.artist?.name || '',
    artists,
    album: t.album?.title || '',
    cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    duration: t.duration || 0,
  };
}

/** Version stockable (sans URL preview, qui expire). */
const stripPreview = ({ preview, ...rest }) => rest;
const listTracks = (arr) => (arr || []).map(toTrack).filter(Boolean);

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

// ---------- Sources ----------
/** Extrait un ID de playlist depuis un ID brut ou une URL deezer.com. */
function parsePlaylistId(input) {
  const s = String(input || '').trim();
  if (/^\d{1,15}$/.test(s)) return s;
  const m = s.match(/deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d+)/i);
  return m ? m[1] : null;
}

async function getPlaylist(id, maxTracks = 500) {
  id = String(id);
  const memKey = 'playlist:' + id;
  const m = memGet(memKey);
  if (m) return m;
  if (dbReady()) {
    const cached = db.getPlaylistCache(id, C.dbCacheTtlMs);
    if (cached) { memSet(memKey, cached); return cached; }
  }
  const meta = await rawGet(`/playlist/${id}`, { limit: 0 });
  const tracks = [];
  for (let index = 0; index < maxTracks; index += 100) {
    const page = await rawGet(`/playlist/${id}/tracks`, { limit: 100, index });
    tracks.push(...listTracks(page.data));
    if (!page.next || !page.data?.length) break;
  }
  const data = {
    id: meta.id,
    title: meta.title,
    picture: meta.picture_medium || '',
    tracks: dedupe(tracks).map(stripPreview),
  };
  memSet(memKey, data);
  if (dbReady()) db.setPlaylistCache(id, data);
  return data;
}

async function searchArtists(q, limit = 8) {
  if (!q || !q.trim()) return [];
  const res = await cachedGet('/search/artist', { q: q.trim(), limit });
  return (res.data || []).map((a) => ({ id: a.id, name: a.name, picture: a.picture_medium, fans: a.nb_fan }));
}

async function getArtistTracks(artistIdOrName) {
  let id = artistIdOrName;
  let name = null;
  if (!/^\d+$/.test(String(id))) {
    const found = await searchArtists(String(id), 1);
    if (!found.length) return { name: String(artistIdOrName), tracks: [] };
    id = found[0].id;
    name = found[0].name;
  }
  const top = await cachedGet(`/artist/${id}/top`, { limit: 100 });
  let tracks = listTracks(top.data);
  if (!name) name = tracks[0]?.artist || String(id);
  if (tracks.length < 30) {
    const s = await cachedGet('/search', { q: `artist:"${name}"`, limit: 100 });
    tracks = tracks.concat(listTracks(s.data).filter((t) => t.artist.toLowerCase() === name.toLowerCase()));
  }
  return { id: Number(id), name, tracks: dedupe(tracks).map(stripPreview) };
}

async function search(q, limit = 25) {
  const res = await cachedGet('/search', { q, limit });
  return listTracks(res.data).map(stripPreview);
}

async function getChart(genreId = 0) {
  const res = await cachedGet(`/chart/${Number(genreId) || 0}/tracks`, { limit: 100 }, { dbTtl: 60 * 60 * 1000 });
  return dedupe(listTracks(res.data)).map(stripPreview);
}

async function getGenres() {
  const res = await cachedGet('/genre', {}, { dbTtl: 7 * 864e5 });
  return (res.data || []).map((g) => ({ id: g.id, name: g.name, picture: g.picture_medium }));
}

/**
 * Piste fraîche juste avant une manche : URL preview signée récente + contributeurs.
 * Jamais mise en cache longue durée.
 */
async function getFreshTrack(id) {
  const t = await rawGet(`/track/${Number(id)}`);
  const track = toTrack(t);
  if (!track) return null;
  return { ...track, preview: t.preview };
}

/** Charge la liste de pistes candidates selon la source choisie. */
async function getTracksForSource(source) {
  switch (source?.type) {
    case 'playlist': {
      const id = parsePlaylistId(source.value);
      if (!id) throw new DeezerError('Playlist invalide');
      return (await getPlaylist(id)).tracks;
    }
    case 'artist': return (await getArtistTracks(source.value)).tracks;
    case 'genre': return getChart(source.value);
    case 'chart':
    default: return getChart(0);
  }
}

/** Lecture d'un preview (pour le proxy audio). */
async function fetchPreview(url, range) {
  const headers = {};
  if (range) headers.Range = range;
  return fetch(url, { headers, signal: AbortSignal.timeout(15000) });
}

function stats() {
  return { queued: queue.length, inWindow: stamps.length, memCache: mem.size };
}

module.exports = {
  DeezerError,
  parsePlaylistId, getPlaylist, searchArtists, getArtistTracks, search, getChart, getGenres,
  getFreshTrack, getTracksForSource, fetchPreview, stats,
  _rawGet: rawGet, _toTrack: toTrack,
};
