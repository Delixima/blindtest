'use strict';
(async () => {
  const { $, $$, esc, api, toast } = BT;
  await BT.init();

  // ---------- Paramètres d'URL ----------
  const params = new URLSearchParams(location.search);
  const pathCode = (location.pathname.match(/^\/room\/([A-Za-z0-9]{5})$/) || [])[1];
  let roomCode = (pathCode || params.get('code') || '').toUpperCase();
  const createMode = params.get('create') === '1' && !roomCode;
  if (!roomCode && !createMode) { location.href = '/'; return; }

  // ---------- État client ----------
  const S = {
    joined: false,
    me: null,
    hostId: null,
    status: 'waiting',
    settings: null,
    players: [],
    round: null,      // manche en cours
    found: { title: false, artist: false },
    roundEnded: false,
    lastResults: null,
    knownPlayers: new Map(),
  };
  const isHost = () => S.me && S.me === S.hostId;

  // ---------- Audio ----------
  const audio = new Audio();
  audio.preload = 'auto';
  const volume = $('#volume');
  volume.value = localStorage.getItem('bt_volume') ?? 70;
  const applyVolume = () => { audio.volume = Math.pow(volume.value / 100, 1.6); };
  applyVolume();
  volume.addEventListener('input', () => { applyVolume(); localStorage.setItem('bt_volume', volume.value); });

  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  async function unlockAudio() {
    try { audio.src = SILENCE; await audio.play(); audio.pause(); } catch { /* ignore */ }
  }

  let playTimer = null;
  function scheduleAudio(r) {
    clearTimeout(playTimer);
    audio.pause();
    audio.src = r.audioUrl;
    audio.load();
    const expected = () => r.offsetSec + Math.max(0, (clock.now() - r.startAt) / 1000);
    const go = () => {
      if (S.round !== r || S.roundEnded) return;
      const start = () => {
        if (S.round !== r || S.roundEnded) return;
        try { audio.currentTime = Math.min(expected(), 29.5); } catch { /* ignore */ }
        audio.play().catch(() => toast('Son bloqué : clique sur la page pour l\'activer', 'err'));
      };
      if (audio.readyState >= 1) start();
      else audio.addEventListener('loadedmetadata', start, { once: true });
    };
    // Correction de dérive une fois la lecture lancée
    audio.addEventListener('playing', function fix() {
      if (S.round !== r) return;
      const diff = audio.currentTime - expected();
      if (Math.abs(diff) > 0.25) { try { audio.currentTime = expected(); } catch { /* ignore */ } }
    }, { once: true });
    const wait = r.startAt - clock.now();
    playTimer = setTimeout(go, Math.max(0, wait));
  }

  function fadeOut(ms = 800) {
    const v0 = audio.volume;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      audio.volume = v0 * (1 - k);
      if (k < 1) requestAnimationFrame(step);
      else { audio.pause(); applyVolume(); }
    };
    requestAnimationFrame(step);
  }

  // ---------- Socket ----------
  const socket = io({ transports: ['websocket', 'polling'], autoConnect: false });
  const clock = BT.createClock(socket);
  const emit = (ev, data) => new Promise((res) => (data === undefined ? socket.emit(ev, res) : socket.emit(ev, data, res)));

  // ---------- Vues ----------
  function show(view) {
    for (const v of ['waiting', 'game', 'results']) $('#view-' + v).classList.toggle('hidden', v !== view);
  }

  // ---------- Entrée dans la salle ----------
  const overlay = $('#join-overlay');
  const pseudoField = $('#join-pseudo-field');
  const pseudoInput = $('#join-pseudo');
  if (!BT.me.user) {
    pseudoField.classList.remove('hidden');
    pseudoInput.value = BT.getPseudo();
  }
  $('#join-title').textContent = createMode ? 'Créer la salle' : `Rejoindre la salle ${roomCode}`;
  if (createMode) $('#join-btn').textContent = 'Créer et rejoindre';

  $('#join-btn').addEventListener('click', async () => {
    if (!BT.me.user) {
      const p = pseudoInput.value.trim();
      if (!BT.validPseudo(p)) { toast('Pseudo invalide (2 à 20 caractères)', 'err'); pseudoInput.focus(); return; }
      BT.setPseudo(p);
      BT.renderHeader();
    }
    $('#join-btn').disabled = true;
    await unlockAudio();
    socket.connect();
  });
  pseudoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-btn').click(); });

  socket.on('connect', async () => {
    await clock.sync();
    let res;
    if (!S.joined && createMode) {
      res = await emit('room:create', {
        name: params.get('name') || '',
        isPublic: params.get('visibility') !== 'private',
        maxPlayers: parseInt(params.get('max'), 10) || 8,
        pseudo: BT.getPseudo(),
      });
    } else {
      res = await emit('room:join', { code: roomCode, pseudo: BT.getPseudo() });
    }
    if (!res?.ok) {
      toast(res?.error || 'Impossible de rejoindre', 'err');
      socket.disconnect();
      $('#join-btn').disabled = false;
      if (res?.error === 'Salle introuvable') setTimeout(() => (location.href = '/lobby'), 1500);
      return;
    }
    if (!S.joined) {
      roomCode = res.state.code;
      history.replaceState(null, '', '/room/' + roomCode);
      overlay.classList.add('hidden');
      sysMsg(res.rejoined ? 'Reconnecté à la salle.' : 'Tu as rejoint la salle.');
    } else {
      sysMsg('Reconnecté.');
    }
    S.joined = true;
    applyState(res.state);
  });
  socket.on('disconnect', () => { if (S.joined) sysMsg('Connexion perdue, reconnexion...'); });
  socket.on('connect_error', () => { if (!S.joined) { toast('Connexion au serveur impossible', 'err'); $('#join-btn').disabled = false; } });

  function applyState(st) {
    S.me = st.you;
    S.hostId = st.hostId;
    S.status = st.status;
    S.settings = st.settings;
    S.lastResults = st.lastResults;
    document.title = `${st.name} - Blindtest`;
    $('#room-name').textContent = st.name;
    $('#room-code').textContent = st.code;
    $('#room-vis').textContent = st.isPublic ? 'Publique' : 'Privée';
    S.maxPlayers = st.maxPlayers;
    setPlayers(st.players, st.hostId, true);
    renderSettings();
    if (st.status === 'playing' && st.round) {
      show('game');
      startRound(st.round, st.round.found);
    } else if (st.status === 'playing') {
      show('game');
      setStageWaiting('Prochaine manche...');
    } else {
      show('waiting');
    }
  }

  // ---------- Joueurs ----------
  function setPlayers(players, hostId, silent = false) {
    if (hostId) S.hostId = hostId;
    if (!silent) {
      const ids = new Set(players.map((p) => p.id));
      for (const p of players) if (!S.knownPlayers.has(p.id)) sysMsg(`${p.pseudo} a rejoint.`);
      for (const [id, name] of S.knownPlayers) if (!ids.has(id)) sysMsg(`${name} est parti.`);
    }
    S.knownPlayers = new Map(players.map((p) => [p.id, p.pseudo]));
    S.players = players;
    renderPlayers();
    renderActions();
  }

  function renderPlayers() {
    const mode = S.round?.mode || S.settings?.mode || 'both';
    const inRound = S.status === 'playing';
    const sorted = inRound ? [...S.players].sort((a, b) => b.score - a.score) : S.players;
    $('#player-count').textContent = `${S.players.length}/${S.maxPlayers || '?'}`;
    $('#players').innerHTML = sorted.map((p) => {
      const f = p.found || { title: false, artist: false };
      const done = mode === 'title' ? f.title : mode === 'artist' ? f.artist : f.title && f.artist;
      const partial = !done && (f.title || f.artist);
      const cls = [p.id === S.me ? 'me' : '', !p.connected ? 'off' : '', inRound && done ? 'done' : '', inRound && partial ? 'partial' : ''].join(' ');
      const dots = mode === 'both'
        ? `<span class="found-dots" title="Titre / Artiste"><i class="${f.title ? 'on' : ''}"></i><i class="${f.artist ? 'on' : ''}"></i></span>`
        : `<span class="found-dots"><i class="${done ? 'on' : ''}"></i></span>`;
      let right;
      if (inRound) right = `${dots}<span class="pscore">${p.score}</span>`;
      else right = p.id === S.hostId ? '<span class="badge host">Hôte</span>' : p.ready ? '<span class="badge ok">Prêt</span>' : '<span class="badge">Pas prêt</span>';
      return `<li class="${cls}">${BT.avatar(p.pseudo)}<span class="pname">${esc(p.pseudo)}${p.registered ? ' <span class="muted small">★</span>' : ''}</span>${!p.connected ? '<span class="badge off">Hors ligne</span>' : ''}${right}</li>`;
    }).join('');
  }

  socket.on('room:players', ({ players, hostId }) => setPlayers(players, hostId));
  socket.on('room:host', ({ hostId, pseudo }) => {
    S.hostId = hostId;
    sysMsg(`${pseudo} est maintenant l'hôte.`);
    if (hostId === S.me) toast('Tu es maintenant l\'hôte', 'ok');
    renderSettings();
  });

  // ---------- Paramètres ----------
  const SRC_LABEL = { chart: 'Top Deezer', genre: 'Genre', artist: 'Artiste', playlist: 'Playlist' };
  const MODE_LABEL = { title: 'Titre seul', artist: 'Artiste seul', both: 'Titre + artiste' };
  const START_LABEL = { start: 'Début', random: 'Aléatoire', middle: 'Milieu' };

  function setSeg(id, value) { $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === value)); }

  function renderSettings() {
    const s = S.settings;
    if (!s) return;
    const host = isHost();
    $('#settings-form').classList.toggle('hidden', !host);
    $('#settings-summary').classList.toggle('hidden', host);
    $('#host-note').textContent = host ? 'Tu es l\'hôte' : 'Réglée par l\'hôte';
    $('#settings-summary').innerHTML = `
      <dt>Source</dt><dd>${esc(s.source.label || SRC_LABEL[s.source.type])}</dd>
      <dt>Manches</dt><dd>${s.rounds}</dd>
      <dt>Durée</dt><dd>${s.roundSeconds} s</dd>
      <dt>À deviner</dt><dd>${MODE_LABEL[s.mode]}</dd>
      <dt>Extrait</dt><dd>${START_LABEL[s.startPosition]}</dd>`;
    if (host) {
      setSeg('src-type', s.source.type);
      $$('[data-src]').forEach((el) => el.classList.toggle('hidden', el.dataset.src !== s.source.type));
      if (s.source.type === 'genre') loadGenres(s.source.value);
      $('#source-info').textContent = s.source.type !== 'chart' && s.source.label ? `Sélection : ${s.source.label}` : '';
      if (document.activeElement !== $('#rounds')) { $('#rounds').value = s.rounds; $('#rounds-label').textContent = s.rounds; }
      if (document.activeElement !== $('#seconds')) { $('#seconds').value = s.roundSeconds; $('#seconds-label').textContent = s.roundSeconds; }
      setSeg('mode', s.mode);
      setSeg('start-pos', s.startPosition);
    }
    renderActions();
  }

  function renderActions() {
    const me = S.players.find((p) => p.id === S.me);
    const host = isHost();
    $('#ready-btn').classList.toggle('hidden', host || S.status !== 'waiting');
    $('#start-btn').classList.toggle('hidden', !host || S.status !== 'waiting');
    if (me && !host) {
      $('#ready-btn').textContent = me.ready ? 'Pas prêt' : 'Je suis prêt';
      $('#ready-btn').className = 'btn big ' + (me.ready ? '' : 'ok');
    }
    const others = S.players.filter((p) => p.id !== S.hostId && p.connected);
    const notReady = others.filter((p) => !p.ready);
    let hint = '';
    if (host) {
      if (S.players.filter((p) => p.connected).length < 2) hint = 'Partage le code pour inviter des joueurs.';
      else if (notReady.length) hint = `En attente : ${notReady.map((p) => p.pseudo).join(', ')}`;
      else hint = 'Tout le monde est prêt !';
    } else hint = me?.ready ? 'En attente du lancement par l\'hôte...' : '';
    $('#start-hint').textContent = hint;
  }

  async function pushSettings(patch) {
    const res = await emit('room:settings', patch);
    if (!res?.ok) toast(res?.error || 'Erreur', 'err');
  }

  $$('#src-type button').forEach((b) => b.addEventListener('click', () => {
    const type = b.dataset.v;
    if (type === 'chart') pushSettings({ source: { type, value: '0', label: 'Top Deezer' } });
    else {
      // On affiche le champ, la source sera envoyée une fois choisie
      setSeg('src-type', type);
      $$('[data-src]').forEach((el) => el.classList.toggle('hidden', el.dataset.src !== type));
      $('#source-info').textContent = 'Choisis une source pour valider.';
      if (type === 'genre') loadGenres();
    }
  }));

  let genresLoaded = false;
  async function loadGenres(selected) {
    const sel = $('#genre');
    if (!genresLoaded) {
      try {
        const genres = await api('/api/deezer/genres');
        sel.innerHTML = '<option value="">Choisir un genre</option>' + genres.filter((g) => g.id !== 0).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
        genresLoaded = true;
      } catch (e) { sel.innerHTML = '<option value="">Erreur de chargement</option>'; return; }
    }
    if (selected !== undefined) sel.value = selected;
  }
  $('#genre').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (e.target.value) pushSettings({ source: { type: 'genre', value: e.target.value, label: 'Genre : ' + opt.textContent } });
  });

  let artistTimer = null;
  const artistInput = $('#artist');
  const suggest = $('#artist-suggest');
  artistInput.addEventListener('input', () => {
    clearTimeout(artistTimer);
    const q = artistInput.value.trim();
    if (q.length < 2) { suggest.classList.add('hidden'); return; }
    artistTimer = setTimeout(async () => {
      try {
        const list = await api('/api/deezer/artists?q=' + encodeURIComponent(q));
        if (!list.length) { suggest.classList.add('hidden'); return; }
        suggest.innerHTML = list.map((a) => `<button type="button" data-id="${a.id}" data-name="${esc(a.name)}"><img src="${esc(a.picture)}" alt="" loading="lazy">${esc(a.name)}<span class="muted small" style="margin-left:auto">${(a.fans || 0).toLocaleString('fr-FR')} fans</span></button>`).join('');
        suggest.classList.remove('hidden');
      } catch { suggest.classList.add('hidden'); }
    }, 300);
  });
  suggest.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    artistInput.value = b.dataset.name;
    suggest.classList.add('hidden');
    pushSettings({ source: { type: 'artist', value: b.dataset.id, label: 'Artiste : ' + b.dataset.name } });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.suggest')) suggest.classList.add('hidden'); });

  $('#playlist-check').addEventListener('click', async () => {
    const url = $('#playlist').value.trim();
    if (!url) return;
    $('#playlist-check').disabled = true;
    try {
      const p = await api('/api/deezer/playlist?url=' + encodeURIComponent(url));
      if (!p.playable) throw new Error('Aucun morceau jouable dans cette playlist');
      await pushSettings({ source: { type: 'playlist', value: String(p.id), label: `Playlist : ${p.title} (${p.playable} titres)` } });
    } catch (e) { toast(e.message, 'err'); }
    $('#playlist-check').disabled = false;
  });
  $('#playlist').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#playlist-check').click(); } });

  $('#rounds').addEventListener('input', (e) => { $('#rounds-label').textContent = e.target.value; });
  $('#rounds').addEventListener('change', (e) => pushSettings({ rounds: +e.target.value }));
  $('#seconds').addEventListener('input', (e) => { $('#seconds-label').textContent = e.target.value; });
  $('#seconds').addEventListener('change', (e) => pushSettings({ roundSeconds: +e.target.value }));
  $$('#mode button').forEach((b) => b.addEventListener('click', () => pushSettings({ mode: b.dataset.v })));
  $$('#start-pos button').forEach((b) => b.addEventListener('click', () => pushSettings({ startPosition: b.dataset.v })));

  socket.on('room:settings', (s) => { S.settings = s; renderSettings(); });

  $('#ready-btn').addEventListener('click', () => {
    const me = S.players.find((p) => p.id === S.me);
    socket.emit('room:ready', !me?.ready);
  });
  $('#start-btn').addEventListener('click', async () => {
    $('#start-btn').disabled = true;
    const res = await emit('room:start');
    $('#start-btn').disabled = false;
    if (!res?.ok) toast(res?.error || 'Impossible de lancer', 'err');
  });

  // ---------- Déroulement ----------
  socket.on('game:loading', () => $('#loading-overlay').classList.remove('hidden'));
  socket.on('game:aborted', ({ error }) => { $('#loading-overlay').classList.add('hidden'); if (!isHost()) toast(error, 'err'); });

  let countdownTimer = null;
  socket.on('game:start', ({ startAt, totalRounds, warning, settings }) => {
    $('#loading-overlay').classList.add('hidden');
    S.status = 'playing';
    S.settings = settings;
    S.totalRounds = totalRounds;
    S.players.forEach((p) => { p.score = 0; p.found = { title: false, artist: false }; });
    renderPlayers();
    renderActions();
    show('game');
    setStageWaiting('C\'est parti !');
    const ov = $('#countdown-overlay');
    $('#countdown-warning').textContent = warning || '';
    ov.classList.remove('hidden');
    clearInterval(countdownTimer);
    const tick = () => {
      const left = Math.ceil((startAt - clock.now()) / 1000);
      $('#countdown').textContent = Math.max(1, left);
      if (left <= 0) { clearInterval(countdownTimer); ov.classList.add('hidden'); }
    };
    tick();
    countdownTimer = setInterval(tick, 200);
  });

  function setStageWaiting(text) {
    $('#round-label').textContent = text;
    $('#timer-text').textContent = '--';
    $('#reveal').classList.add('hidden');
    $('#play-zone').classList.add('hidden');
    $('#cover-wrap').classList.remove('revealed');
  }

  function renderTargets() {
    const mode = S.round?.mode || 'both';
    const t = [];
    if (mode !== 'artist') t.push(`<span class="target ${S.found.title ? 'on' : ''}">${S.found.title ? '✓ ' : ''}Titre</span>`);
    if (mode !== 'title') t.push(`<span class="target ${S.found.artist ? 'on' : ''}">${S.found.artist ? '✓ ' : ''}Artiste</span>`);
    $('#targets').innerHTML = t.join('');
  }

  const answerInput = $('#answer');
  function startRound(r, found) {
    $('#countdown-overlay').classList.add('hidden');
    clearInterval(countdownTimer);
    S.round = r;
    S.roundEnded = false;
    S.status = 'playing';
    S.found = found || { title: false, artist: false };
    // Nouvelle manche : on remet les statuts à zéro (en reconnexion, l'état serveur les fournit déjà)
    if (!found) S.players.forEach((p) => { p.found = { title: false, artist: false }; });
    show('game');
    $('#round-label').textContent = `Manche ${r.round} / ${r.totalRounds}`;
    $('#reveal').classList.add('hidden');
    $('#play-zone').classList.remove('hidden');
    $('#cover-wrap').classList.remove('revealed');
    $('#cover').removeAttribute('src');
    $('#feedback').textContent = '';
    $('#feedback').className = 'feedback';
    answerInput.className = '';
    answerInput.value = '';
    answerInput.placeholder = r.mode === 'title' ? 'Le titre...' : r.mode === 'artist' ? 'L\'artiste...' : 'Titre ou artiste...';
    const done = isDone(S.found, r.mode);
    answerInput.disabled = done;
    if (done) setFeedback('Bravo, tout trouvé !', 'ok');
    renderTargets();
    renderPlayers();
    scheduleAudio(r);
    requestAnimationFrame(animateTimer);
    setTimeout(() => { if (!answerInput.disabled) answerInput.focus({ preventScroll: true }); }, Math.max(0, r.startAt - clock.now()));
  }

  function isDone(f, mode) {
    return mode === 'title' ? f.title : mode === 'artist' ? f.artist : f.title && f.artist;
  }

  function animateTimer() {
    const r = S.round;
    if (!r || S.roundEnded) return;
    const now = clock.now();
    const bar = $('#timer-bar');
    if (now < r.startAt) {
      bar.style.transform = 'scaleX(1)';
      $('#timer-text').textContent = 'Écoute...';
    } else {
      const left = Math.max(0, r.endAt - now);
      bar.style.transform = `scaleX(${left / r.durationMs})`;
      $('#timer-text').textContent = Math.ceil(left / 1000) + ' s';
      $('#timer').classList.toggle('low', left < 5000);
    }
    requestAnimationFrame(animateTimer);
  }

  function setFeedback(text, cls) {
    const fb = $('#feedback');
    fb.textContent = text;
    fb.className = 'feedback ' + (cls || '');
  }

  socket.on('round:start', (r) => startRound(r));

  $('#answer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = answerInput.value.trim();
    if (!text || !S.round || S.roundEnded) return;
    answerInput.value = '';
    const res = await emit('round:answer', text);
    if (!res) return;
    if (!res.ok) {
      const msgs = { rate_limited: 'Doucement...', not_started: 'Attends le début de l\'extrait', too_late: 'Trop tard !', already_done: 'Déjà tout trouvé' };
      if (msgs[res.reason]) setFeedback(msgs[res.reason], 'bad');
      return;
    }
    answerInput.classList.remove('wrong', 'right');
    void answerInput.offsetWidth; // relance l'animation
    if (res.correct) {
      S.found = res.found;
      answerInput.classList.add('right');
      const parts = [];
      if (res.newTitle) parts.push('Titre');
      if (res.newArtist) parts.push('Artiste');
      setFeedback(`${parts.join(' + ')} trouvé${parts.length > 1 ? 's' : ''} ! +${res.points}`, 'ok');
      renderTargets();
      if (res.done) { answerInput.disabled = true; setTimeout(() => setFeedback(`Bravo, tout trouvé ! +${res.points}`, 'ok'), 900); }
    } else {
      answerInput.classList.add('wrong');
      setFeedback('Non...', 'bad');
    }
  });

  socket.on('round:progress', ({ playerId, found }) => {
    const p = S.players.find((x) => x.id === playerId);
    if (p) p.found = found;
    renderPlayers();
  });

  let nextTimer = null;
  socket.on('round:end', (d) => {
    S.roundEnded = true;
    clearTimeout(playTimer);
    answerInput.disabled = true;
    $('#timer-bar').style.transform = 'scaleX(0)';
    $('#timer-text').textContent = 'Terminé';
    const img = $('#cover');
    if (d.track.cover) {
      img.onload = () => $('#cover-wrap').classList.add('revealed');
      img.src = d.track.cover;
    } else $('#cover-wrap').classList.add('revealed');
    $('#play-zone').classList.add('hidden');
    $('#reveal').classList.remove('hidden');
    $('#reveal-title').textContent = d.track.title;
    $('#reveal-artist').textContent = (d.track.artists?.length ? d.track.artists : [d.track.artist]).join(', ');
    $('#reveal-album').textContent = d.track.album ? 'Album : ' + d.track.album : '';
    $('#round-results').innerHTML = d.results.map((r) => {
      const what = [r.title ? 'titre' : '', r.artist ? 'artiste' : ''].filter(Boolean).join(' + ');
      const extra = [r.timeMs != null ? BT.fmtMs(r.timeMs) : '', r.bonuses.includes('first_title') || r.bonuses.includes('first_artist') ? '1er' : '', r.streak > 1 ? `série ${r.streak}` : ''].filter(Boolean).join(' · ');
      return `<li>${BT.avatar(r.pseudo)}<span><b>${esc(r.pseudo)}</b><br><span class="muted small">${what || 'rien trouvé'}${extra ? ' · ' + extra : ''}</span></span><span class="pts ${r.points ? '' : 'zero'}">+${r.points}</span></li>`;
    }).join('');
    for (const l of d.leaderboard) {
      const p = S.players.find((x) => x.id === l.playerId);
      if (p) p.score = l.score;
    }
    renderPlayers();
    clearInterval(nextTimer);
    if (d.nextAt) {
      const tick = () => {
        const left = Math.ceil((d.nextAt - clock.now()) / 1000);
        $('#next-in').textContent = left > 0 ? `Manche suivante dans ${left} s` : 'Chargement...';
        if (left <= 0) clearInterval(nextTimer);
      };
      tick();
      nextTimer = setInterval(tick, 250);
    } else $('#next-in').textContent = 'Dernière manche ! Résultats dans un instant...';
  });

  socket.on('game:end', (res) => {
    clearInterval(nextTimer);
    fadeOut(1500);
    S.status = 'waiting';
    S.round = null;
    S.lastResults = res;
    renderResults(res);
    show('results');
  });

  function renderResults({ ranking, stats, history, reason }) {
    $('#results-reason').textContent = reason || '';
    const top = ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    const cls = ['p2', 'p1', 'p3'];
    $('#podium').innerHTML = order.map((p, i) => (p ? `
      <div class="step ${cls[i]}">
        ${BT.avatar(p.pseudo)}
        <div class="who">${esc(p.pseudo)}</div>
        <div class="sc">${p.score} pts</div>
        <div class="block">${p.rank}</div>
      </div>` : '<div class="step"></div>')).join('');
    $('#results-stats').innerHTML = `
      <div class="stat"><div class="v">${stats.roundsPlayed}</div><div class="k">Manches jouées</div></div>
      <div class="stat"><div class="v">${stats.fastest ? BT.fmtMs(stats.fastest.timeMs) : '-'}</div><div class="k">Réponse la plus rapide${stats.fastest ? ' · ' + esc(stats.fastest.pseudo) : ''}</div></div>
      <div class="stat"><div class="v">${stats.bestStreak ? stats.bestStreak.streak : '-'}</div><div class="k">Meilleure série${stats.bestStreak ? ' · ' + esc(stats.bestStreak.pseudo) : ''}</div></div>`;
    $('#results-table').innerHTML = ranking.map((p) => `
      <tr><td class="rank-${p.rank}">${p.rank}</td><td>${esc(p.pseudo)}${p.playerId === S.me ? ' <span class="muted small">(toi)</span>' : ''}</td>
      <td class="num">${p.correctCount}</td><td class="num">${BT.fmtMs(p.bestTimeMs)}</td><td class="num">${p.bestStreak}</td><td class="num"><b>${p.score}</b></td></tr>`).join('');
    $('#results-tracks').innerHTML = history.map((h) => `<li>${esc(h.artist)} - ${esc(h.title)}</li>`).join('');
  }

  $('#back-btn').addEventListener('click', () => { show('waiting'); renderSettings(); renderPlayers(); });

  socket.on('room:closed', ({ reason }) => { toast(reason, 'err'); setTimeout(() => (location.href = '/lobby'), 2000); });

  // ---------- Chat ----------
  function addChat(html) {
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    const el = document.createElement('div');
    el.innerHTML = html;
    log.appendChild(el.firstChild);
    while (log.children.length > 150) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function sysMsg(text) { addChat(`<div class="sys">${esc(text)}</div>`); }
  socket.on('chat:message', ({ pseudo, text }) => addChat(`<div class="m"><b>${esc(pseudo)}</b> ${esc(text)}</div>`));
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat:send', text);
    input.value = '';
  });

  // ---------- Divers ----------
  $('#room-code').addEventListener('click', async () => {
    const link = `${location.origin}/room/${roomCode}`;
    try { await navigator.clipboard.writeText(link); toast('Lien copié : ' + link, 'ok'); } catch { toast(link); }
  });
  $('#leave-btn').addEventListener('click', async () => {
    if (S.joined) await emit('room:leave');
    location.href = '/lobby';
  });
})();
