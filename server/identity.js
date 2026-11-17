'use strict';
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const config = require('./config');
const db = require('./db');

const PID = 'bt_pid';
const UID = 'bt_uid';
const YEAR = 365 * 864e5;

const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.server.secureCookies,
  signed: true,
  maxAge: YEAR,
});

function newGuestId() { return 'g:' + crypto.randomBytes(9).toString('base64url'); }

const PSEUDO_RE = /^[\p{L}\p{N} _.\-]+$/u;
function cleanPseudo(p) {
  const s = String(p || '').trim().replace(/\s+/g, ' ');
  if (s.length < config.limits.pseudoMin || s.length > config.limits.pseudoMax) return null;
  if (!PSEUDO_RE.test(s)) return null;
  return s;
}

/** Résout l'identité à partir des cookies signés déjà parsés. */
function resolve(signedCookies) {
  const uid = parseInt(signedCookies?.[UID], 10);
  const user = Number.isFinite(uid) ? db.getUserById(uid) : null;
  const guestId = signedCookies?.[PID] || null;
  return {
    user: user || null,
    guestId,
    playerId: user ? 'u:' + user.id : guestId,
  };
}

/** Middleware Express : garantit un identifiant invité et expose req.identity. */
function middleware(req, res, next) {
  if (!req.signedCookies[PID]) {
    const id = newGuestId();
    res.cookie(PID, id, cookieOpts());
    req.signedCookies[PID] = id;
  }
  req.identity = resolve(req.signedCookies);
  if (req.signedCookies[UID] && !req.identity.user) res.clearCookie(UID);
  next();
}

function setUser(res, userId) { res.cookie(UID, String(userId), cookieOpts()); }
function clearUser(res) { res.clearCookie(UID); }

/** Pour Socket.IO : lit les cookies de la poignée de main. */
function fromHandshake(headers) {
  const raw = cookie.parse(headers.cookie || '');
  const signed = cookieParser.signedCookies(raw, [config.server.cookieSecret]);
  return resolve(signed);
}

module.exports = { middleware, setUser, clearUser, fromHandshake, cleanPseudo, PID, UID };
