'use strict';
const express = require('express');
const { Readable } = require('stream');
const deezer = require('../deezer');
const { rateLimit, asyncRoute } = require('./util');

/** Routes REST des salles, des sources Deezer et du proxy audio. */
module.exports = function roomsRoutes(rooms) {
  const api = express.Router();
  const dzLimiter = rateLimit({ windowMs: 10_000, max: 20 });

  api.get('/rooms', (req, res) => res.json(rooms.listPublic()));

  api.get('/rooms/:code', (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return res.status(404).json({ error: 'Salle introuvable' });
    res.json(room.summary());
  });

  api.get('/deezer/genres', dzLimiter, asyncRoute(async (req, res) => {
    res.json(await deezer.getGenres());
  }));

  api.get('/deezer/artists', dzLimiter, asyncRoute(async (req, res) => {
    res.json(await deezer.searchArtists(String(req.query.q || '').slice(0, 80)));
  }));

  api.get('/deezer/playlist', dzLimiter, asyncRoute(async (req, res) => {
    const id = deezer.parsePlaylistId(req.query.url);
    if (!id) return res.status(400).json({ error: 'URL ou ID de playlist invalide' });
    try {
      const p = await deezer.getPlaylist(id);
      res.json({ id: p.id, title: p.title, picture: p.picture, playable: p.tracks.length });
    } catch (e) {
      res.status(404).json({ error: 'Playlist introuvable ou privée' });
    }
  }));

  // Proxy audio : le client ne voit jamais l'URL Deezer (qui pourrait trahir la piste)
  const audio = express.Router();
  audio.get('/:code/:token', asyncRoute(async (req, res) => {
    const room = rooms.get(req.params.code);
    const url = room && room.players.has(req.identity.playerId) ? room.previewForToken(req.params.token) : null;
    if (!url) return res.status(404).end();
    const upstream = await deezer.fetchPreview(url, req.headers.range);
    if (!upstream.ok && upstream.status !== 206) return res.status(502).end();
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  }));

  return { api, audio };
};
