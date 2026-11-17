'use strict';
const identity = require('./identity');
const { GameError } = require('./game');

/**
 * Branche les événements Socket.IO.
 * Rooms Socket.IO utilisées :
 *  - `room:CODE`   tous les sockets d'une salle de jeu
 *  - `player:PID`  tous les sockets d'un joueur (plusieurs onglets, reconnexion)
 *  - `lobby`       sockets qui regardent la liste des salles publiques
 */
function attach(io, rooms) {
  // Sockets par joueur et par salle, pour savoir si un joueur est vraiment parti
  const presence = new Map(); // `${code}|${pid}` -> Set(socket.id)

  io.use((socket, next) => {
    const id = identity.fromHandshake(socket.handshake.headers);
    if (!id.playerId) return next(new Error('no_identity'));
    socket.data.identity = id;
    next();
  });

  const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };
  const fail = (cb, e) => {
    if (!(e instanceof GameError)) console.error('[socket]', e);
    reply(cb, { ok: false, error: e instanceof GameError ? e.message : 'Erreur serveur' });
  };

  io.on('connection', (socket) => {
    const { playerId, user } = socket.data.identity;
    socket.join('player:' + playerId);
    socket.emit('identity', { playerId, user });

    socket.on('time:ping', (cb) => reply(cb, Date.now()));

    socket.on('lobby:subscribe', () => {
      socket.join('lobby');
      socket.emit('lobby:rooms', rooms.listPublic());
    });
    socket.on('lobby:unsubscribe', () => socket.leave('lobby'));

    const currentRoom = () => (socket.data.code ? rooms.get(socket.data.code) : null);

    function joinRoom(room, pseudoInput) {
      const pseudo = user ? user.pseudo : identity.cleanPseudo(pseudoInput);
      if (!pseudo) throw new GameError('Pseudo invalide (2 à 20 caractères, lettres, chiffres, espace, _ . -)');
      if (socket.data.code && socket.data.code !== room.code) leaveRoom(false);
      const { rejoined } = room.addPlayer({ id: playerId, pseudo, userId: user?.id });
      socket.data.code = room.code;
      socket.join('room:' + room.code);
      socket.leave('lobby');
      const key = room.code + '|' + playerId;
      if (!presence.has(key)) presence.set(key, new Set());
      presence.get(key).add(socket.id);
      return { ok: true, rejoined, state: room.stateFor(playerId) };
    }

    function leaveRoom(definitive) {
      const room = currentRoom();
      const code = socket.data.code;
      socket.data.code = null;
      if (!code) return;
      socket.leave('room:' + code);
      const key = code + '|' + playerId;
      const set = presence.get(key);
      if (set) { set.delete(socket.id); if (!set.size) presence.delete(key); }
      if (!room) return;
      if (definitive) {
        // Quitter volontairement : on retire le joueur de tous ses onglets
        presence.delete(key);
        io.in('player:' + playerId).socketsLeave('room:' + code);
        room.removePlayer(playerId);
      } else if (!presence.has(key)) {
        room.disconnect(playerId);
      }
    }

    socket.on('room:create', (data = {}, cb) => {
      try {
        const room = rooms.create({ name: data.name, isPublic: data.isPublic, maxPlayers: data.maxPlayers });
        const res = joinRoom(room, data.pseudo);
        reply(cb, res);
      } catch (e) { fail(cb, e); }
    });

    socket.on('room:join', (data = {}, cb) => {
      try {
        const room = rooms.get(data.code);
        if (!room) throw new GameError('Salle introuvable');
        reply(cb, joinRoom(room, data.pseudo));
      } catch (e) { fail(cb, e); }
    });

    socket.on('room:leave', (cb) => { leaveRoom(true); reply(cb, { ok: true }); });

    socket.on('room:ready', (ready) => currentRoom()?.setReady(playerId, ready));

    socket.on('room:settings', (settings, cb) => {
      try {
        const room = currentRoom();
        if (!room) throw new GameError('Pas dans une salle');
        reply(cb, { ok: true, settings: room.updateSettings(playerId, settings) });
      } catch (e) { fail(cb, e); }
    });

    socket.on('room:start', async (cb) => {
      try {
        const room = currentRoom();
        if (!room) throw new GameError('Pas dans une salle');
        reply(cb, { ok: true, ...(await room.start(playerId)) });
      } catch (e) {
        const room = currentRoom();
        if (room && room.status === 'waiting') room.emit('room', 'game:aborted', { error: e.message });
        fail(cb, e);
      }
    });

    socket.on('round:answer', (text, cb) => {
      const room = currentRoom();
      if (!room) return reply(cb, { ok: false, reason: 'no_room' });
      const r = room.answer(playerId, text);
      // On ne renvoie que l'état du joueur, jamais la bonne réponse
      reply(cb, r);
    });

    socket.on('chat:send', (text) => currentRoom()?.chat(playerId, text));

    socket.on('room:state', (cb) => {
      const room = currentRoom();
      reply(cb, room ? { ok: true, state: room.stateFor(playerId) } : { ok: false });
    });

    socket.on('disconnect', () => leaveRoom(false));
  });

  // Diffusion de la liste des salles publiques au lobby quand elle change
  let lastList = '';
  setInterval(() => {
    const list = rooms.listPublic();
    const json = JSON.stringify(list);
    if (json !== lastList) {
      lastList = json;
      io.to('lobby').emit('lobby:rooms', list);
    }
  }, 2000).unref();
}

module.exports = { attach };
