'use strict';

/** Limiteur de requêtes simple en mémoire, par IP. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now - e.start > windowMs) { e = { start: now, n: 0 }; hits.set(key, e); }
    if (++e.n > max) return res.status(429).json({ error: 'Trop de requêtes, réessaie dans un instant' });
    next();
  };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { rateLimit, asyncRoute };
