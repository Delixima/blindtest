'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/me', (req, res) => {
  if (!req.identity.user) return res.status(401).json({ error: 'Connecte-toi pour voir ton profil' });
  res.json(db.profile(req.identity.user.id));
});

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = Number.isFinite(id) ? db.profile(id) : null;
  if (!p) return res.status(404).json({ error: 'Profil introuvable' });
  res.json(p);
});

module.exports = router;
