'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

let db;

function init(dbPath = config.server.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pseudo TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT NOT NULL,
      host_id TEXT,
      settings_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS game_players (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      pseudo TEXT NOT NULL,
      final_score INTEGER NOT NULL DEFAULT 0,
      rank INTEGER,
      correct_count INTEGER NOT NULL DEFAULT 0,
      best_time_ms INTEGER,
      best_streak INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS rounds (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      deezer_track_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      PRIMARY KEY (game_id, round_number)
    );

    CREATE TABLE IF NOT EXISTS answers (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      player TEXT NOT NULL,
      correct_title INTEGER NOT NULL DEFAULT 0,
      correct_artist INTEGER NOT NULL DEFAULT 0,
      response_time_ms INTEGER,
      points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, round_number, player)
    );

    CREATE TABLE IF NOT EXISTS cache_playlists (
      deezer_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cache_api (
      cache_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gp_user ON game_players(user_id);
    CREATE INDEX IF NOT EXISTS idx_games_ended ON games(ended_at);
  `);
  prepare();
  return db;
}

const q = {};

function prepare() {
  q.insertUser = db.prepare('INSERT INTO users (pseudo, password_hash, created_at) VALUES (?, ?, ?)');
  q.userByPseudo = db.prepare('SELECT * FROM users WHERE pseudo = ?');
  q.userById = db.prepare('SELECT id, pseudo, created_at FROM users WHERE id = ?');

  q.insertGame = db.prepare('INSERT INTO games (room_code, host_id, settings_json, started_at) VALUES (?, ?, ?, ?)');
  q.endGame = db.prepare('UPDATE games SET ended_at = ? WHERE id = ?');
  q.deleteGame = db.prepare('DELETE FROM games WHERE id = ?');
  q.insertRound = db.prepare(
    'INSERT OR REPLACE INTO rounds (game_id, round_number, deezer_track_id, title, artist) VALUES (?, ?, ?, ?, ?)'
  );
  q.insertAnswer = db.prepare(`INSERT OR REPLACE INTO answers
    (game_id, round_number, player, correct_title, correct_artist, response_time_ms, points)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  q.insertGamePlayer = db.prepare(`INSERT OR REPLACE INTO game_players
    (game_id, player_id, user_id, pseudo, final_score, rank, correct_count, best_time_ms, best_streak)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  q.getPlaylistCache = db.prepare('SELECT data_json, fetched_at FROM cache_playlists WHERE deezer_id = ?');
  q.setPlaylistCache = db.prepare('INSERT OR REPLACE INTO cache_playlists (deezer_id, data_json, fetched_at) VALUES (?, ?, ?)');
  q.getApiCache = db.prepare('SELECT data_json, fetched_at FROM cache_api WHERE cache_key = ?');
  q.setApiCache = db.prepare('INSERT OR REPLACE INTO cache_api (cache_key, data_json, fetched_at) VALUES (?, ?, ?)');
  q.purgeApiCache = db.prepare('DELETE FROM cache_api WHERE fetched_at < ?');
}

// ---------- Utilisateurs ----------
function createUser(pseudo, hash) {
  const info = q.insertUser.run(pseudo, hash, Date.now());
  return Number(info.lastInsertRowid);
}
const getUserByPseudo = (pseudo) => q.userByPseudo.get(pseudo);
const getUserById = (id) => q.userById.get(id);

// ---------- Parties ----------
function createGame(roomCode, hostId, settings) {
  const info = q.insertGame.run(roomCode, hostId, JSON.stringify(settings), Date.now());
  return Number(info.lastInsertRowid);
}
const saveRound = (gameId, n, track) => q.insertRound.run(gameId, n, track.id, track.title, track.artist);
const saveAnswer = (gameId, n, a) =>
  q.insertAnswer.run(gameId, n, a.player, a.title ? 1 : 0, a.artist ? 1 : 0, a.timeMs ?? null, a.points);

const finishGame = (gameId, players) =>
  db.transaction(() => {
    q.endGame.run(Date.now(), gameId);
    for (const p of players) {
      q.insertGamePlayer.run(
        gameId, p.playerId, p.userId || null, p.pseudo, p.score, p.rank,
        p.correctCount, p.bestTimeMs ?? null, p.bestStreak
      );
    }
  })();

const deleteGame = (gameId) => q.deleteGame.run(gameId);

// ---------- Cache ----------
function getPlaylistCache(id, maxAge) {
  const row = q.getPlaylistCache.get(String(id));
  if (!row || Date.now() - row.fetched_at > maxAge) return null;
  return JSON.parse(row.data_json);
}
const setPlaylistCache = (id, data) => q.setPlaylistCache.run(String(id), JSON.stringify(data), Date.now());
function getApiCache(key, maxAge) {
  const row = q.getApiCache.get(key);
  if (!row || Date.now() - row.fetched_at > maxAge) return null;
  return JSON.parse(row.data_json);
}
const setApiCache = (key, data) => q.setApiCache.run(key, JSON.stringify(data), Date.now());
const purgeApiCache = (maxAge) => q.purgeApiCache.run(Date.now() - maxAge);

// ---------- Classements ----------
const PERIODS = { week: 7 * 864e5, month: 30 * 864e5 };

function leaderboard(period = 'all', limit = 50) {
  const since = PERIODS[period] ? Date.now() - PERIODS[period] : 0;
  return db.prepare(`
    SELECT u.id AS userId, u.pseudo,
      SUM(gp.final_score) AS totalPoints,
      COUNT(*) AS gamesPlayed,
      SUM(CASE WHEN gp.rank = 1 THEN 1 ELSE 0 END) AS wins,
      MAX(gp.final_score) AS bestScore
    FROM game_players gp
    JOIN games g ON g.id = gp.game_id
    JOIN users u ON u.id = gp.user_id
    WHERE g.ended_at IS NOT NULL AND g.ended_at >= ?
    GROUP BY u.id
    ORDER BY totalPoints DESC, wins DESC
    LIMIT ?`).all(since, limit);
}

function profile(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  const stats = db.prepare(`
    SELECT COUNT(*) AS gamesPlayed,
      COALESCE(SUM(gp.final_score), 0) AS totalPoints,
      COALESCE(SUM(CASE WHEN gp.rank = 1 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(MAX(gp.final_score), 0) AS bestScore,
      MIN(gp.best_time_ms) AS bestTimeMs,
      COALESCE(MAX(gp.best_streak), 0) AS bestStreak
    FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE gp.user_id = ? AND g.ended_at IS NOT NULL`).get(userId);
  const acc = db.prepare(`
    SELECT COUNT(*) AS answered,
      COALESCE(SUM(a.correct_title), 0) AS titles,
      COALESCE(SUM(a.correct_artist), 0) AS artists,
      COALESCE(SUM(CASE WHEN a.correct_title = 1 OR a.correct_artist = 1 THEN 1 ELSE 0 END), 0) AS anyCorrect
    FROM answers a
    JOIN game_players gp ON gp.game_id = a.game_id AND gp.player_id = a.player
    WHERE gp.user_id = ?`).get(userId);
  const roundsPlayed = db.prepare(`
    SELECT COUNT(*) AS n FROM rounds r
    JOIN game_players gp ON gp.game_id = r.game_id
    WHERE gp.user_id = ?`).get(userId).n;
  const history = db.prepare(`
    SELECT g.id AS gameId, g.room_code AS roomCode, g.started_at AS startedAt, g.ended_at AS endedAt,
      gp.final_score AS score, gp.rank,
      (SELECT COUNT(*) FROM game_players x WHERE x.game_id = g.id) AS players,
      (SELECT COUNT(*) FROM rounds r WHERE r.game_id = g.id) AS rounds
    FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE gp.user_id = ? AND g.ended_at IS NOT NULL
    ORDER BY g.ended_at DESC LIMIT 50`).all(userId);
  return {
    user,
    stats: {
      ...stats,
      roundsPlayed,
      titlesFound: acc.titles,
      artistsFound: acc.artists,
      successRate: roundsPlayed ? Math.round((acc.anyCorrect / roundsPlayed) * 100) : 0,
    },
    history,
  };
}

module.exports = {
  init,
  get raw() { return db; },
  createUser, getUserByPseudo, getUserById,
  createGame, saveRound, saveAnswer, finishGame, deleteGame,
  getPlaylistCache, setPlaylistCache, getApiCache, setApiCache, purgeApiCache,
  leaderboard, profile,
};
