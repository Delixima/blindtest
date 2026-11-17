'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const identity = require('../identity');
const { rateLimit } = require('./util');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 10 });

router.get('/me', (req, res) => {
  const { user, playerId } = req.identity;
  res.json({ playerId, user });
});

router.post('/register', limiter, async (req, res) => {
  const pseudo = identity.cleanPseudo(req.body?.pseudo);
  const password = String(req.body?.password || '');
  if (!pseudo) return res.status(400).json({ error: 'Pseudo invalide (2 à 20 caractères)' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'Mot de passe : 6 à 72 caractères' });
  if (db.getUserByPseudo(pseudo)) return res.status(409).json({ error: 'Pseudo déjà pris' });
  const hash = await bcrypt.hash(password, 10);
  let id;
  try { id = db.createUser(pseudo, hash); } catch { return res.status(409).json({ error: 'Pseudo déjà pris' }); }
  identity.setUser(res, id);
  res.json({ user: db.getUserById(id), playerId: 'u:' + id });
});

router.post('/login', limiter, async (req, res) => {
  const pseudo = String(req.body?.pseudo || '').trim();
  const password = String(req.body?.password || '');
  const u = pseudo && db.getUserByPseudo(pseudo);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
  }
  identity.setUser(res, u.id);
  res.json({ user: db.getUserById(u.id), playerId: 'u:' + u.id });
});

router.post('/logout', (req, res) => {
  identity.clearUser(res);
  res.json({ ok: true });
});

module.exports = router;
