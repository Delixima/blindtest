'use strict';
const crypto = require('crypto');
const config = require('./config');
const { checkAnswer } = require('./validate');

const G = config.game;
const P = config.points;
const L = config.limits;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MODES = ['title', 'artist', 'both'];
const START_POSITIONS = ['start', 'random', 'middle'];
const SOURCE_TYPES = ['chart', 'playlist', 'artist', 'genre'];

const clamp = (n, min, max, d) => {
  n = parseInt(n, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function defaultSettings() {
  return {
    source: { type: 'chart', value: '0', label: 'Top Deezer' },
    rounds: G.defaultRounds,
    roundSeconds: G.defaultRoundSeconds,
    mode: 'both',
    startPosition: 'random',
  };
}

function sanitizeSettings(input, current = defaultSettings()) {
  const s = { ...current, source: { ...current.source } };
  if (!input || typeof input !== 'object') return s;
  if (input.source && SOURCE_TYPES.includes(input.source.type)) {
    s.source = {
      type: input.source.type,
      value: String(input.source.value ?? '').slice(0, 200),
      label: String(input.source.label ?? '').slice(0, 80),
    };
  }
  if (input.rounds !== undefined) s.rounds = clamp(input.rounds, G.minRounds, G.maxRounds, s.rounds);
  if (input.roundSeconds !== undefined) s.roundSeconds = clamp(input.roundSeconds, G.minRoundSeconds, G.maxRoundSeconds, s.roundSeconds);
  if (MODES.includes(input.mode)) s.mode = input.mode;
  if (START_POSITIONS.includes(input.startPosition)) s.startPosition = input.startPosition;
  return s;
}

class GameError extends Error {}

class Room {
  /**
   * @param {object} opts
   * @param {(target: string, event: string, data: any) => void} opts.emit  target = 'room' ou un playerId
   * @param {object} opts.deezer  { getTracksForSource, getFreshTrack }
   * @param {object} [opts.db]    module db (optionnel pour les tests)
   */
  constructor({ code, name, isPublic, maxPlayers, emit, deezer, db, timing = {} }) {
    this.code = code;
    this.name = name;
    this.isPublic = !!isPublic;
    this.maxPlayers = maxPlayers;
    this.emit = emit;
    this.deezer = deezer;
    this.db = db || null;
    this.t = { ...G, ...timing }; // permet d'accélérer les tests
    this.players = new Map();
    this.hostId = null;
    this.settings = defaultSettings();
    this.status = 'waiting'; // waiting | starting | playing | ended
    this.lastActivity = Date.now();
    this.game = null;
    this.round = null;
    this.lastResults = null;
    this.timers = new Set();
    this.closed = false;
  }

  // ---------- utilitaires ----------
  touch() { this.lastActivity = Date.now(); }
  later(fn, ms) {
    const id = setTimeout(() => { this.timers.delete(id); if (!this.closed) fn(); }, ms);
    this.timers.add(id);
    return id;
  }
  clearTimers() { for (const id of this.timers) clearTimeout(id); this.timers.clear(); }
  connectedPlayers() { return [...this.players.values()].filter((p) => p.connected); }
  isHost(pid) { return this.hostId === pid; }

  // ---------- joueurs ----------
  addPlayer({ id, pseudo, userId }) {
    this.touch();
    const existing = this.players.get(id);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      if (existing.removeTimer) { clearTimeout(existing.removeTimer); this.timers.delete(existing.removeTimer); existing.removeTimer = null; }
      this.broadcastPlayers();
      return { player: existing, rejoined: true };
    }
    if (this.players.size >= this.maxPlayers) throw new GameError('Salle pleine');
    let name = pseudo;
    const taken = new Set([...this.players.values()].map((p) => p.pseudo.toLowerCase()));
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${pseudo}${i}`;
    const player = {
      id, pseudo: name, userId: userId || null,
      connected: true, ready: false, disconnectedAt: null, removeTimer: null,
      score: 0, streak: 0, bestStreak: 0, correctCount: 0, bestTimeMs: null,
      lastAnswerAt: 0, lastChatAt: 0,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.broadcastPlayers();
    return { player, rejoined: false };
  }

  /** Déconnexion réseau : on garde le joueur pendant le délai de grâce. */
  disconnect(pid) {
    const p = this.players.get(pid);
    if (!p || !p.connected) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    p.removeTimer = this.later(() => this.removePlayer(pid), L.reconnectGraceMs);
    this.broadcastPlayers();
    if (this.round && !this.round.ended) this.maybeEndRoundEarly();
  }

  /** Départ définitif (bouton quitter ou fin du délai de grâce). */
  removePlayer(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    if (p.removeTimer) { clearTimeout(p.removeTimer); this.timers.delete(p.removeTimer); }
    this.players.delete(pid);
    if (this.hostId === pid) {
      const next = this.connectedPlayers()[0] || [...this.players.values()][0];
      this.hostId = next ? next.id : null;
      if (next) this.emit('room', 'room:host', { hostId: next.id, pseudo: next.pseudo });
    }
    this.broadcastPlayers();
    if (this.round && !this.round.ended) this.maybeEndRoundEarly();
    if (this.status !== 'waiting' && this.players.size === 0) this.abortGame();
  }

  setReady(pid, ready) {
    const p = this.players.get(pid);
    if (!p || this.status !== 'waiting') return;
    p.ready = !!ready;
    this.touch();
    this.broadcastPlayers();
  }

  updateSettings(pid, input) {
    if (!this.isHost(pid)) throw new GameError("Seul l'hôte peut régler la partie");
    if (this.status !== 'waiting') throw new GameError('Partie en cours');
    this.settings = sanitizeSettings(input, this.settings);
    this.touch();
    this.emit('room', 'room:settings', this.settings);
    return this.settings;
  }

  broadcastPlayers() {
    this.emit('room', 'room:players', { hostId: this.hostId, players: this.playerList() });
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id, pseudo: p.pseudo, ready: p.ready, connected: p.connected,
      score: p.score, registered: !!p.userId, isHost: p.id === this.hostId,
      found: this.round ? this.round.found.get(p.id) || { title: false, artist: false } : null,
    }));
  }

  // ---------- partie ----------
  async start(pid) {
    if (!this.isHost(pid)) throw new GameError("Seul l'hôte peut lancer la partie");
    if (this.status !== 'waiting') throw new GameError('Partie déjà lancée');
    const present = this.connectedPlayers();
    if (present.length < (G.minPlayersToStart ?? 1)) throw new GameError(`Il faut au moins ${G.minPlayersToStart} joueurs`);
    const notReady = present.filter((p) => p.id !== this.hostId && !p.ready);
    if (notReady.length) throw new GameError(`Pas prêts : ${notReady.map((p) => p.pseudo).join(', ')}`);

    this.status = 'starting';
    this.touch();
    this.emit('room', 'game:loading', { message: 'Chargement des morceaux...' });

    let candidates;
    try {
      candidates = await this.deezer.getTracksForSource(this.settings.source);
    } catch (e) {
      this.status = 'waiting';
      throw new GameError(`Impossible de charger la source : ${e.message}`);
    }
    if (this.closed) return;
    if (!candidates || candidates.length === 0) {
      this.status = 'waiting';
      throw new GameError('Aucun morceau jouable pour cette source');
    }

    for (const p of this.players.values()) {
      Object.assign(p, { score: 0, streak: 0, bestStreak: 0, correctCount: 0, bestTimeMs: null });
    }
    const rounds = Math.min(this.settings.rounds, candidates.length);
    this.game = {
      id: this.db ? this.db.createGame(this.code, this.hostId, this.settings) : null,
      settings: { ...this.settings },
      totalRounds: rounds,
      pool: shuffle(candidates),
      poolIndex: 0,
      roundNumber: 0,
      history: [],
    };
    this.lastResults = null;
    this.status = 'playing';
    const startAt = Date.now() + this.t.startCountdownMs;
    this.emit('room', 'game:start', {
      totalRounds: rounds, startAt, serverNow: Date.now(), settings: this.game.settings,
      warning: rounds < this.settings.rounds ? `Seulement ${rounds} morceaux disponibles` : null,
    });
    this.later(() => this.nextRound(), this.t.startCountdownMs);
    return { totalRounds: rounds };
  }

  /** Prend la prochaine piste jouable du pool, en sautant celles sans preview. */
  async pickTrack() {
    const g = this.game;
    while (g.poolIndex < g.pool.length) {
      const candidate = g.pool[g.poolIndex++];
      try {
        const fresh = await this.deezer.getFreshTrack(candidate.id);
        if (fresh && fresh.preview) return fresh;
      } catch { /* piste indisponible : on passe */ }
      if (this.closed) return null;
    }
    return null;
  }

  async nextRound() {
    if (this.closed || this.status !== 'playing') return;
    const g = this.game;
    if (g.roundNumber >= g.totalRounds) return this.endGame();
    const track = await this.pickTrack();
    if (this.closed || this.status !== 'playing') return;
    if (!track) return this.endGame('Plus de morceaux disponibles');

    g.roundNumber += 1;
    const durationMs = g.settings.roundSeconds * 1000;
    const maxOffset = Math.max(0, G.previewLengthSec - g.settings.roundSeconds);
    let offsetSec = 0;
    if (g.settings.startPosition === 'middle') offsetSec = maxOffset / 2;
    else if (g.settings.startPosition === 'random') offsetSec = Math.round(Math.random() * maxOffset * 10) / 10;

    const startAt = Date.now() + this.t.roundLeadMs;
    this.round = {
      number: g.roundNumber,
      track,
      token: crypto.randomBytes(16).toString('hex'),
      startAt,
      endAt: startAt + durationMs,
      durationMs,
      offsetSec,
      found: new Map(),     // pid -> { title, artist }
      results: new Map(),   // pid -> { points, timeMs, title, artist }
      firstTitle: null,
      firstArtist: null,
      ended: false,
    };
    for (const p of this.players.values()) this.round.found.set(p.id, { title: false, artist: false });
    this.touch();
    this.emit('room', 'round:start', this.roundPayload());
    this.round.timer = this.later(() => this.endRound(), this.t.roundLeadMs + durationMs);
  }

  roundPayload() {
    const r = this.round;
    return {
      round: r.number,
      totalRounds: this.game.totalRounds,
      startAt: r.startAt,
      endAt: r.endAt,
      durationMs: r.durationMs,
      offsetSec: r.offsetSec,
      audioUrl: `/audio/${this.code}/${r.token}`,
      mode: this.game.settings.mode,
      serverNow: Date.now(),
    };
  }

  /** Renvoie l'URL preview si le jeton correspond à la manche en cours (proxy audio). */
  previewForToken(token) {
    const r = this.round;
    if (!r || !token || r.token !== token) return null;
    if (Date.now() > r.endAt + 10000) return null;
    return r.track.preview;
  }

  answer(pid, text) {
    const r = this.round;
    const p = this.players.get(pid);
    if (!p || !r || r.ended || this.status !== 'playing') return { ok: false, reason: 'no_round' };
    const now = Date.now();
    if (now - p.lastAnswerAt < L.answerIntervalMs) return { ok: false, reason: 'rate_limited' };
    p.lastAnswerAt = now;
    if (now < r.startAt) return { ok: false, reason: 'not_started' };
    if (now > r.endAt) return { ok: false, reason: 'too_late' };
    text = String(text || '').slice(0, L.maxAnswerLength).trim();
    if (!text) return { ok: false, reason: 'empty' };
    this.touch();

    const mode = this.game.settings.mode;
    const found = r.found.get(pid) || { title: false, artist: false };
    const wasDone = this.isDone(found, mode);
    if (wasDone) return { ok: false, reason: 'already_done' };

    const check = checkAnswer(text, r.track, mode);
    const newTitle = check.title && !found.title;
    const newArtist = check.artist && !found.artist;
    if (!newTitle && !newArtist) {
      return { ok: true, correct: false, found: { ...found }, done: false, points: 0 };
    }

    const elapsed = now - r.startAt;
    const speed = Math.round(P.speedBonusMax * Math.max(0, 1 - elapsed / r.durationMs));
    const res = r.results.get(pid) || { points: 0, timeMs: null, title: false, artist: false, bonuses: [] };
    let points = 0;
    const firstInRound = !res.title && !res.artist;

    if (newTitle) {
      found.title = true; res.title = true;
      points += P.title + speed;
      if (!r.firstTitle) { r.firstTitle = pid; points += P.firstFinder; res.bonuses.push('first_title'); }
    }
    if (newArtist) {
      found.artist = true; res.artist = true;
      points += P.artist + speed;
      if (!r.firstArtist) { r.firstArtist = pid; points += P.firstFinder; res.bonuses.push('first_artist'); }
    }
    if (firstInRound) {
      const streakBonus = Math.min(p.streak * P.streakPerRound, P.streakMax);
      if (streakBonus) { points += streakBonus; res.bonuses.push(`streak_${streakBonus}`); }
      res.timeMs = elapsed;
      if (p.bestTimeMs === null || elapsed < p.bestTimeMs) p.bestTimeMs = elapsed;
    }
    res.points += points;
    p.score += points;
    r.found.set(pid, found);
    r.results.set(pid, res);

    const done = this.isDone(found, mode);
    // Les autres voient seulement qui a trouvé quoi, jamais la réponse
    this.emit('room', 'round:progress', { playerId: pid, found: { ...found }, done });
    if (done) this.maybeEndRoundEarly();
    return { ok: true, correct: true, newTitle, newArtist, found: { ...found }, done, points };
  }

  isDone(found, mode) {
    if (mode === 'title') return found.title;
    if (mode === 'artist') return found.artist;
    return found.title && found.artist;
  }

  maybeEndRoundEarly() {
    const r = this.round;
    if (!r || r.ended) return;
    const present = this.connectedPlayers();
    if (present.length === 0) return;
    const mode = this.game.settings.mode;
    if (present.every((p) => this.isDone(r.found.get(p.id) || {}, mode))) {
      this.later(() => this.endRound(), 600); // petit délai pour laisser passer le feedback
    }
  }

  endRound() {
    const r = this.round;
    if (!r || r.ended || this.closed) return;
    r.ended = true;
    if (r.timer) { clearTimeout(r.timer); this.timers.delete(r.timer); }
    const g = this.game;
    const t = r.track;

    const results = [];
    for (const p of this.players.values()) {
      const res = r.results.get(p.id);
      const success = !!(res && (res.title || res.artist));
      if (success) {
        p.streak += 1;
        p.correctCount += 1;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
      } else {
        p.streak = 0;
      }
      results.push({
        playerId: p.id, pseudo: p.pseudo,
        title: !!res?.title, artist: !!res?.artist,
        points: res?.points || 0, timeMs: res?.timeMs ?? null,
        bonuses: res?.bonuses || [], streak: p.streak, score: p.score,
      });
    }
    results.sort((a, b) => b.points - a.points || (a.timeMs ?? 1e9) - (b.timeMs ?? 1e9));

    if (this.db && g.id) {
      try {
        this.db.saveRound(g.id, r.number, t);
        for (const res of results) {
          if (res.points || res.title || res.artist) {
            this.db.saveAnswer(g.id, r.number, { player: res.playerId, title: res.title, artist: res.artist, timeMs: res.timeMs, points: res.points });
          }
        }
      } catch (e) { console.error('[db] sauvegarde manche', e.message); }
    }
    g.history.push({ round: r.number, trackId: t.id, title: t.title, artist: t.artist });

    const isLast = g.roundNumber >= g.totalRounds;
    this.emit('room', 'round:end', {
      round: r.number,
      totalRounds: g.totalRounds,
      track: { id: t.id, title: t.title, artist: t.artist, artists: t.artists, album: t.album, cover: t.cover },
      results,
      leaderboard: this.standings(),
      nextAt: isLast ? null : Date.now() + this.t.betweenRoundsMs,
      isLast,
    });
    this.touch();
    this.later(() => (isLast ? this.endGame() : this.nextRound()), this.t.betweenRoundsMs);
  }

  standings() {
    const list = [...this.players.values()]
      .map((p) => ({ playerId: p.id, pseudo: p.pseudo, score: p.score, streak: p.streak, connected: p.connected }))
      .sort((a, b) => b.score - a.score);
    let rank = 0, prev = null;
    list.forEach((e, i) => { if (e.score !== prev) { rank = i + 1; prev = e.score; } e.rank = rank; });
    return list;
  }

  endGame(reason = null) {
    if (this.status !== 'playing' || this.closed) return;
    const g = this.game;
    this.clearTimers();
    // On conserve les minuteurs de suppression des joueurs déconnectés
    for (const p of this.players.values()) {
      if (!p.connected) p.removeTimer = this.later(() => this.removePlayer(p.id), Math.max(1000, L.reconnectGraceMs - (Date.now() - p.disconnectedAt)));
    }
    const ranking = this.standings().map((s) => {
      const p = this.players.get(s.playerId);
      return { ...s, userId: p.userId, correctCount: p.correctCount, bestTimeMs: p.bestTimeMs, bestStreak: p.bestStreak };
    });

    const withTime = ranking.filter((x) => x.bestTimeMs !== null);
    const fastest = withTime.sort((a, b) => a.bestTimeMs - b.bestTimeMs)[0] || null;
    const longest = ranking.slice().sort((a, b) => b.bestStreak - a.bestStreak)[0];
    const stats = {
      roundsPlayed: g.roundNumber,
      fastest: fastest ? { pseudo: fastest.pseudo, timeMs: fastest.bestTimeMs } : null,
      bestStreak: longest && longest.bestStreak > 0 ? { pseudo: longest.pseudo, streak: longest.bestStreak } : null,
    };

    if (this.db && g.id) {
      try {
        if (g.roundNumber === 0) this.db.deleteGame(g.id);
        else this.db.finishGame(g.id, ranking.map((x) => ({ ...x, playerId: x.playerId, pseudo: x.pseudo, score: x.score, rank: x.rank })));
      } catch (e) { console.error('[db] fin de partie', e.message); }
    }

    this.lastResults = { ranking, stats, history: g.history, reason };
    this.emit('room', 'game:end', this.lastResults);
    this.round = null;
    this.game = null;
    this.status = 'waiting';
    for (const p of this.players.values()) p.ready = false;
    this.touch();
    this.broadcastPlayers();
  }

  /** Abandon (salle vide ou fermée). */
  abortGame() {
    if (this.game?.id && this.db) {
      try { this.db.deleteGame(this.game.id); } catch { /* ignore */ }
    }
    this.clearTimers();
    this.round = null;
    this.game = null;
    this.status = 'waiting';
  }

  chat(pid, text) {
    const p = this.players.get(pid);
    if (!p) return false;
    const now = Date.now();
    if (now - p.lastChatAt < L.chatIntervalMs) return false;
    text = String(text || '').slice(0, L.maxChatLength).trim();
    if (!text) return false;
    // Pendant une manche, on masque un message qui contiendrait la réponse
    if (this.round && !this.round.ended) {
      const c = checkAnswer(text, this.round.track, 'both');
      if (c.title || c.artist) return false;
    }
    p.lastChatAt = now;
    this.touch();
    this.emit('room', 'chat:message', { playerId: pid, pseudo: p.pseudo, text, at: now });
    return true;
  }

  /** État complet pour un joueur (connexion / reconnexion). */
  stateFor(pid) {
    const r = this.round;
    return {
      code: this.code,
      name: this.name,
      isPublic: this.isPublic,
      maxPlayers: this.maxPlayers,
      hostId: this.hostId,
      status: this.status,
      settings: this.settings,
      players: this.playerList(),
      you: pid,
      game: this.game ? { totalRounds: this.game.totalRounds, round: this.game.roundNumber, settings: this.game.settings } : null,
      round: r && !r.ended ? { ...this.roundPayload(), found: r.found.get(pid) || { title: false, artist: false } } : null,
      standings: this.game ? this.standings() : null,
      lastResults: this.lastResults,
      serverNow: Date.now(),
    };
  }

  summary() {
    return {
      code: this.code, name: this.name, players: this.players.size, connected: this.connectedPlayers().length,
      maxPlayers: this.maxPlayers, status: this.status,
      host: this.players.get(this.hostId)?.pseudo || null,
      source: this.settings.source.label || this.settings.source.type,
    };
  }

  close() {
    this.closed = true;
    this.abortGame();
    for (const p of this.players.values()) if (p.removeTimer) clearTimeout(p.removeTimer);
  }
}

// ---------- Gestion des salles ----------
class RoomManager {
  constructor({ emitFactory, deezer, db, timing } = {}) {
    this.rooms = new Map();
    this.emitFactory = emitFactory;
    this.deezer = deezer;
    this.db = db;
    this.timing = timing;
  }

  generateCode() {
    for (let i = 0; i < 1000; i++) {
      let code = '';
      for (let j = 0; j < 5; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError('Impossible de générer un code');
  }

  create({ name, isPublic, maxPlayers }) {
    const code = this.generateCode();
    const room = new Room({
      code,
      name: String(name || '').trim().slice(0, L.roomNameMax) || `Salle ${code}`,
      isPublic: isPublic !== false,
      maxPlayers: clamp(maxPlayers, G.minPlayers, G.maxPlayers, G.defaultMaxPlayers),
      emit: this.emitFactory(code),
      deezer: this.deezer,
      db: this.db,
      timing: this.timing,
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase().trim()); }

  listPublic() {
    return [...this.rooms.values()]
      .filter((r) => r.isPublic && r.players.size > 0)
      .map((r) => r.summary())
      .sort((a, b) => (a.status === 'waiting' ? -1 : 1) - (b.status === 'waiting' ? -1 : 1) || b.players - a.players);
  }

  delete(code) {
    const r = this.rooms.get(code);
    if (r) { r.close(); this.rooms.delete(code); }
  }

  /** Supprime les salles vides ou inactives. */
  cleanup(now = Date.now()) {
    const removed = [];
    for (const [code, r] of this.rooms) {
      const empty = r.players.size === 0;
      const idle = now - r.lastActivity > L.roomIdleMs;
      const nobodyHere = r.connectedPlayers().length === 0 && now - r.lastActivity > L.reconnectGraceMs;
      if (empty || idle || nobodyHere) {
        if (idle && !empty) r.emit('room', 'room:closed', { reason: 'Salle fermée pour inactivité' });
        this.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }
}

module.exports = { Room, RoomManager, GameError, sanitizeSettings, defaultSettings, shuffle };
