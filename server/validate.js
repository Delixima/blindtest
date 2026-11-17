'use strict';

/** Minuscules, sans accents, sans ponctuation, espaces simples. */
function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '') // l'amour -> lamour, don't -> dont
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Mentions parasites retirées uniquement en fin de titre (après nettoyage des parenthèses)
const TITLE_NOISE = /\s(\d{4}\s)?(remaster(ed)?|radio edit|single edit|edit|live|version|mono|stereo|bonus track|explicit|acoustic version|extended version)$/;

/** Retire parenthèses, crochets, suffixe " - xxx", feat., remaster, etc. */
function cleanTitle(title) {
  let t = String(title || '');
  t = t.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ');
  t = t.replace(/\s+[-–—]\s+.*$/, ' '); // " - Radio Edit", " - 2011 Remaster"...
  t = t.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, ' ');
  let n = normalize(t);
  for (let i = 0; i < 3; i++) {
    const stripped = n.replace(TITLE_NOISE, '').trim();
    if (!stripped || stripped === n) break;
    n = stripped;
  }
  return n;
}

/** Normalise un nom d'artiste et ignore "the" en tête. */
function cleanArtist(name) {
  return normalize(name).replace(/^the /, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Fautes tolérées selon la longueur de la réponse attendue. */
function maxDistance(len) {
  if (len <= 2) return 0; // "U2", "M" : pas de tolérance, sinon tout passe
  if (len <= 5) return 1;
  if (len <= 10) return 2;
  return 3;
}

function fuzzyEqual(answer, expected) {
  if (!answer || !expected) return false;
  if (answer === expected) return true;
  const a2 = answer.replace(/ /g, '');
  const e2 = expected.replace(/ /g, '');
  if (a2 === e2) return true;
  return levenshtein(a2, e2) <= maxDistance(e2.length);
}

function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

/** Variantes acceptées pour un titre. */
function titleVariants(title, titleShort) {
  return uniq([cleanTitle(title), cleanTitle(titleShort), normalize(titleShort), normalize(title)]);
}

function matchTitle(answer, title, titleShort) {
  const a = cleanTitle(answer) || normalize(answer);
  const raw = normalize(answer);
  return titleVariants(title, titleShort).some((v) => fuzzyEqual(a, v) || fuzzyEqual(raw, v));
}

function matchArtist(answer, artists) {
  const a = cleanArtist(answer);
  if (!a) return false;
  return uniq((artists || []).map(cleanArtist)).some((v) => fuzzyEqual(a, v));
}

/**
 * Vérifie une réponse selon le mode.
 * mode: 'title' | 'artist' | 'both'
 * En mode 'both', une saisie peut valider le titre, l'artiste, ou les deux
 * si elle est de la forme "artiste - titre" / "titre - artiste" / "titre by artiste".
 */
function checkAnswer(answer, track, mode = 'both') {
  const res = { title: false, artist: false };
  const text = String(answer || '').trim();
  if (!text || !track) return res;
  const artists = track.artists?.length ? track.artists : [track.artist];
  const wantTitle = mode === 'title' || mode === 'both';
  const wantArtist = mode === 'artist' || mode === 'both';

  if (wantTitle && matchTitle(text, track.title, track.titleShort)) res.title = true;
  if (wantArtist && matchArtist(text, artists)) res.artist = true;

  if (mode === 'both' && !(res.title && res.artist)) {
    // On essaie chaque séparateur individuellement (le titre peut lui-même contenir "by" ou " - ")
    const sep = /\s+[-–—]\s+|\s+by\s+|\s+par\s+|\s*\/\s*/gi;
    let m;
    while ((m = sep.exec(text)) && !(res.title && res.artist)) {
      const left = text.slice(0, m.index).trim();
      const right = text.slice(m.index + m[0].length).trim();
      if (!left || !right) continue;
      for (const [x, y] of [[left, right], [right, left]]) {
        if (matchTitle(x, track.title, track.titleShort) && matchArtist(y, artists)) {
          res.title = true; res.artist = true;
        }
      }
    }
  }
  return res;
}

module.exports = { normalize, cleanTitle, cleanArtist, levenshtein, maxDistance, fuzzyEqual, matchTitle, matchArtist, checkAnswer };
