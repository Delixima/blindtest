'use strict';
require('dotenv').config({ quiet: true });

const path = require('path');

const env = process.env;
const int = (v, d) => (v === undefined || v === '' || isNaN(parseInt(v, 10)) ? d : parseInt(v, 10));

module.exports = {
  server: {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: path.resolve(env.DB_PATH || './data/blindtest.db'),
    cookieSecret: env.COOKIE_SECRET || 'change-me-in-env',
    trustProxy: env.TRUST_PROXY !== 'false',
    secureCookies: env.SECURE_COOKIES === 'true',
  },

  points: {
    title: 100,
    artist: 100,
    speedBonusMax: 100, // dégressif linéaire de speedBonusMax à 0 sur la durée de la manche
    streakPerRound: 10, // par manche réussie consécutive (avant celle-ci)
    streakMax: 50,
    firstFinder: 25, // premier joueur à trouver une catégorie donnée
  },

  game: {
    minRounds: 5,
    maxRounds: 50,
    defaultRounds: 10,
    minRoundSeconds: 10,
    maxRoundSeconds: 30,
    defaultRoundSeconds: 20,
    minPlayers: 2,
    maxPlayers: 20,
    minPlayersToStart: int(env.MIN_PLAYERS_TO_START, 2),
    defaultMaxPlayers: 8,
    startCountdownMs: 5000,
    betweenRoundsMs: 5000,
    roundLeadMs: 2500, // délai entre l'annonce d'une manche et le départ de l'audio (préchargement)
    previewLengthSec: 30,
    trackPoolFactor: 2, // on charge rounds * facteur pistes candidates
  },

  limits: {
    answerIntervalMs: 500,
    chatIntervalMs: 700,
    reconnectGraceMs: 60 * 1000,
    roomIdleMs: 30 * 60 * 1000,
    cleanupIntervalMs: 60 * 1000,
    maxAnswerLength: 120,
    maxChatLength: 200,
    pseudoMin: 2,
    pseudoMax: 20,
    roomNameMax: 40,
  },

  deezer: {
    baseUrl: 'https://api.deezer.com',
    maxRequests: 45, // marge sous la limite officielle de 50
    windowMs: 5000,
    timeoutMs: 8000,
    memoryCacheTtlMs: 10 * 60 * 1000,
    memoryCacheMax: 500,
    dbCacheTtlMs: 6 * 60 * 60 * 1000,
  },
};
