'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const period = ['week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'all';
  res.json({ period, entries: db.leaderboard(period, 100) });
});

module.exports = router;
