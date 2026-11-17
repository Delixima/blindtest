'use strict';
(async () => {
  const { $, esc, toast } = BT;
  await BT.init();

  const list = $('#rooms');
  const STATUS = { waiting: ['En attente', 'ok'], starting: ['Démarrage', ''], playing: ['En jeu', 'host'] };

  function render(rooms) {
    if (!rooms.length) {
      list.innerHTML = '<div class="empty">Aucune salle publique pour le moment.<br>Crée la tienne et invite tes amis.</div>';
      return;
    }
    list.innerHTML = rooms.map((r) => {
      const [label, cls] = STATUS[r.status] || [r.status, ''];
      const full = r.players >= r.maxPlayers;
      return `<div class="room-item">
        ${BT.avatar(r.name)}
        <div class="grow">
          <div class="name">${esc(r.name)} <span class="badge ${cls}">${label}</span></div>
          <div class="meta">${r.players}/${r.maxPlayers} joueurs · hôte ${esc(r.host || '-')} · ${esc(r.source)}</div>
        </div>
        <a class="btn ${full ? '' : 'primary'}" href="/room/${esc(r.code)}" ${full ? 'aria-disabled="true" onclick="return false"' : ''}>${full ? 'Pleine' : 'Rejoindre'}</a>
      </div>`;
    }).join('');
  }

  const socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => { socket.emit('lobby:subscribe'); $('#live').textContent = 'Mise à jour en direct'; });
  socket.on('disconnect', () => { $('#live').textContent = 'Déconnecté, reconnexion...'; });
  socket.on('lobby:rooms', render);

  const code = $('#code');
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (code.value.length !== 5) return toast('Le code fait 5 caractères', 'err');
    location.href = '/room/' + code.value;
  });
})();
