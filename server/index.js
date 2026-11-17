'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./db');
const deezer = require('./deezer');
const identity = require('./identity');
const { RoomManager } = require('./game');
const sockets = require('./sockets');

db.init();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e5,
});

const rooms = new RoomManager({
  emitFactory: (code) => (target, event, data) => {
    if (target === 'room') io.to('room:' + code).emit(event, data);
    else io.to('player:' + target).emit(event, data);
  },
  deezer,
  db,
});

if (config.server.trustProxy) app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser(config.server.cookieSecret));
app.use(identity.middleware);

const { api, audio } = require('./routes/rooms')(rooms);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api', api);
app.use('/audio', audio);
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size, deezer: deezer.stats() }));

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '1h' }));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'game.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' });
});

sockets.attach(io, rooms);

const cleanup = setInterval(() => {
  const removed = rooms.cleanup();
  if (removed.length) console.log(`[rooms] supprimées : ${removed.join(', ')}`);
  db.purgeApiCache(config.deezer.dbCacheTtlMs * 4);
}, config.limits.cleanupIntervalMs);
cleanup.unref();

server.listen(config.server.port, config.server.host, () => {
  console.log(`Blindtest en écoute sur http://${config.server.host}:${config.server.port}`);
});

function shutdown() {
  console.log('Arrêt...');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io, rooms };
