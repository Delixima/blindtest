'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, sanitizeSettings } = require('../server/game');
const config = require('../server/config');

const TRACKS = [
  { id: 1, title: 'Formidable', titleShort: 'Formidable', artist: 'Stromae', artists: ['Stromae'], album: 'Racine carrée', cover: '', duration: 200 },
  { id: 2, title: 'Get Lucky (feat. Pharrell Williams)', titleShort: 'Get Lucky', artist: 'Daft Punk', artists: ['Daft Punk', 'Pharrell Williams'], album: 'RAM', cover: '', duration: 250 },
  { id: 3, title: 'Hello', titleShort: 'Hello', artist: 'Adele', artists: ['Adele'], album: '25', cover: '', duration: 290 },
  { id: 4, title: 'Dead Track', titleShort: 'Dead Track', artist: 'Nobody', artists: ['Nobody'], album: '', cover: '', duration: 1 },
];

function fakeDeezer({ deadIds = [] } = {}) {
  return {
    async getTracksForSource() { return TRACKS; },
    async getFreshTrack(id) {
      if (deadIds.includes(id)) return null;
      const t = TRACKS.find((x) => x.id === id);
      return { ...t, preview: `https://cdn.example/${id}.mp3` };
    },
  };
}

const timing = { startCountdownMs: 20, roundLeadMs: 10, betweenRoundsMs: 20 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(opts = {}) {
  const events = [];
  const mgr = new RoomManager({
    emitFactory: () => (target, event, data) => events.push({ target, event, data }),
    deezer: fakeDeezer(opts),
    timing,
  });
  const room = mgr.create({ name: 'Test', isPublic: true, maxPlayers: 4 });
  return { mgr, room, events, last: (ev) => [...events].reverse().find((e) => e.event === ev)?.data };
}

async function waitFor(fn, timeout = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await sleep(5); }
  throw new Error('timeout');
}

test('sanitizeSettings borne les valeurs', () => {
  const s = sanitizeSettings({ rounds: 999, roundSeconds: 2, mode: 'xxx', startPosition: 'middle', source: { type: 'artist', value: 'Muse' } });
  assert.equal(s.rounds, config.game.maxRounds);
  assert.equal(s.roundSeconds, config.game.minRoundSeconds);
  assert.equal(s.mode, 'both');
  assert.equal(s.startPosition, 'middle');
  assert.equal(s.source.type, 'artist');
});

test('hôte, pseudo unique, transfert d\'hôte', () => {
  const { room } = setup();
  room.addPlayer({ id: 'a', pseudo: 'Alice' });
  const { player } = room.addPlayer({ id: 'b', pseudo: 'alice' });
  assert.equal(room.hostId, 'a');
  assert.equal(player.pseudo, 'alice2');
  room.removePlayer('a');
  assert.equal(room.hostId, 'b');
});

test('salle pleine', () => {
  const { room } = setup();
  for (const id of ['a', 'b', 'c', 'd']) room.addPlayer({ id, pseudo: id });
  assert.throws(() => room.addPlayer({ id: 'e', pseudo: 'e' }), /pleine/);
});

test('lancement refusé si pas hôte ou joueurs pas prêts', async () => {
  const { room } = setup();
  room.addPlayer({ id: 'a', pseudo: 'A' });
  room.addPlayer({ id: 'b', pseudo: 'B' });
  await assert.rejects(room.start('b'), /hôte/);
  await assert.rejects(room.start('a'), /Pas prêts/);
});

test('partie complète : points, bonus, série, classement', async () => {
  const { room, events, last } = setup();
  room.addPlayer({ id: 'a', pseudo: 'A' });
  room.addPlayer({ id: 'b', pseudo: 'B' });
  room.setReady('b', true);
  room.updateSettings('a', { rounds: 5, roundSeconds: 10, mode: 'both' }); // borné à 3 jouables (4 pistes - 0 mortes)
  const { totalRounds } = await room.start('a');
  assert.equal(totalRounds, 4);

  // Manche 1
  const r1 = await waitFor(() => last('round:start'));
  assert.ok(!JSON.stringify(r1).includes('Formidable') && !JSON.stringify(r1).includes('cdn.example'), 'aucune réponse ni URL directe envoyée');
  await waitFor(() => Date.now() >= r1.startAt);
  const track1 = room.round.track;

  const wrong = room.answer('a', 'n importe quoi');
  assert.equal(wrong.correct, false);
  await sleep(config.limits.answerIntervalMs + 10);
  const spam1 = room.answer('a', 'x');
  const spam2 = room.answer('a', 'y');
  assert.equal(spam2.reason, 'rate_limited');
  await sleep(config.limits.answerIntervalMs + 10);

  const ok = room.answer('a', `${track1.artists[0]} - ${track1.titleShort}`);
  assert.equal(ok.correct, true);
  assert.equal(ok.done, true);
  // 2 catégories : base + vitesse (proche du max) + premier à trouver x2
  assert.ok(ok.points > 200 + 2 * config.points.firstFinder + 150, `points ${ok.points}`);
  const prog = last('round:progress');
  assert.equal(prog.playerId, 'a');
  assert.ok(!JSON.stringify(prog).includes(track1.artists[0]));

  const bTitle = room.answer('b', track1.titleShort);
  assert.equal(bTitle.newTitle, true);
  assert.ok(bTitle.points >= 100 && bTitle.points <= 200, 'pas de bonus premier pour B');
  await sleep(config.limits.answerIntervalMs + 10);
  room.answer('b', track1.artists[0]);
  const end1 = await waitFor(() => last('round:end'));
  assert.equal(end1.track.title, track1.title);
  assert.equal(end1.results.length, 2);

  // Manche 2 : seule A trouve -> bonus de série +10
  const r2 = await waitFor(() => events.filter((e) => e.event === 'round:start').length === 2 && last('round:start'));
  await waitFor(() => Date.now() >= r2.startAt);
  const t2 = room.round.track;
  const a2 = room.answer('a', t2.titleShort);
  assert.ok(a2.points >= 100 + config.points.firstFinder + config.points.streakPerRound);
  // B ne trouve rien : on force la fin
  room.endRound();
  const end2 = last('round:end');
  assert.equal(end2.results.find((x) => x.playerId === 'b').streak, 0);
  assert.equal(end2.results.find((x) => x.playerId === 'a').streak, 2);

  // Laisser finir la partie
  await waitFor(() => events.filter((e) => e.event === 'round:start').length === 3);
  room.endRound();
  await waitFor(() => events.filter((e) => e.event === 'round:start').length === 4);
  room.endRound();
  const end = await waitFor(() => last('game:end'));
  assert.equal(end.ranking[0].playerId, 'a');
  assert.equal(end.ranking[0].rank, 1);
  assert.equal(end.stats.roundsPlayed, 4);
  assert.equal(end.stats.bestStreak.pseudo, 'A');
  assert.equal(room.status, 'waiting');
});

test('piste sans preview sautée sans pénalité', async () => {
  const { room, events, last } = setup({ deadIds: [1, 2, 3] });
  room.addPlayer({ id: 'a', pseudo: 'A' });
  room.addPlayer({ id: 'b', pseudo: 'B' });
  room.setReady('b', true);
  await room.start('a');
  await waitFor(() => last('round:start'));
  assert.equal(room.round.track.id, 4);
  room.endRound();
  const end = await waitFor(() => last('game:end'));
  assert.ok(end.reason && /Plus de morceaux/.test(end.reason));
  assert.ok(end.ranking.every((r) => r.score === 0));
  assert.equal(events.filter((e) => e.event === 'round:start').length, 1);
});

test('reconnexion : score conservé, manche terminée quand les connectés ont fini', async () => {
  const { room, last } = setup();
  room.addPlayer({ id: 'a', pseudo: 'A' });
  room.addPlayer({ id: 'b', pseudo: 'B' });
  room.setReady('b', true);
  room.updateSettings('a', { mode: 'title' });
  await room.start('a');
  const r1 = await waitFor(() => last('round:start'));
  await waitFor(() => Date.now() >= r1.startAt);
  room.answer('a', room.round.track.titleShort);
  const scoreA = room.players.get('a').score;
  room.disconnect('a');
  assert.equal(room.players.get('a').connected, false);
  const { rejoined, player } = room.addPlayer({ id: 'a', pseudo: 'A' });
  assert.equal(rejoined, true);
  assert.equal(player.score, scoreA);
  const st = room.stateFor('a');
  assert.equal(st.round.found.title, true);
  // B se déconnecte : tous les connectés ont trouvé -> fin anticipée
  room.disconnect('b');
  await waitFor(() => last('round:end'));
  room.close();
});

test('cleanup supprime les salles vides et inactives', () => {
  const { mgr, room } = setup();
  const r2 = mgr.create({ name: 'Idle' });
  r2.addPlayer({ id: 'z', pseudo: 'Z' });
  r2.lastActivity = Date.now() - config.limits.roomIdleMs - 1;
  const removed = mgr.cleanup();
  assert.ok(removed.includes(room.code));
  assert.ok(removed.includes(r2.code));
  assert.equal(mgr.rooms.size, 0);
});

test('chat : message contenant la réponse masqué pendant la manche', async () => {
  const { room, last } = setup();
  room.addPlayer({ id: 'a', pseudo: 'A' });
  room.addPlayer({ id: 'b', pseudo: 'B' });
  assert.equal(room.chat('a', 'salut'), true);
  room.setReady('b', true);
  await room.start('a');
  await waitFor(() => last('round:start'));
  assert.equal(room.chat('b', room.round.track.titleShort), false);
  room.close();
});
