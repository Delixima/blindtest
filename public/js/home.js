'use strict';
(async () => {
  const { $, $$, esc, api, toast } = BT;
  await BT.init();

  const pseudoInput = $('#pseudo');
  pseudoInput.value = BT.getPseudo();
  if (BT.me.user) {
    pseudoInput.disabled = true;
    $('#pseudo-hint').textContent = 'Connecté : ton pseudo de compte est utilisé.';
  }
  pseudoInput.addEventListener('change', () => {
    const p = pseudoInput.value.trim();
    if (BT.validPseudo(p)) { BT.setPseudo(p); BT.renderHeader(); }
  });

  function requirePseudo() {
    if (BT.me.user) return true;
    const p = pseudoInput.value.trim();
    if (!BT.validPseudo(p)) {
      toast('Choisis un pseudo valide (2 à 20 caractères)', 'err');
      pseudoInput.focus();
      return false;
    }
    BT.setPseudo(p);
    return true;
  }

  const codeInput = $('#code');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requirePseudo()) return;
    const code = codeInput.value.trim();
    if (code.length !== 5) return toast('Le code fait 5 caractères', 'err');
    try {
      await api('/api/rooms/' + code);
      location.href = '/room/' + code;
    } catch (err) { toast(err.message, 'err'); }
  });

  let visibility = 'public';
  $$('#visibility button').forEach((b) => b.addEventListener('click', () => {
    visibility = b.dataset.v;
    $$('#visibility button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  const max = $('#max-players');
  max.addEventListener('input', () => { $('#max-label').textContent = max.value; });

  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!requirePseudo()) return;
    const params = new URLSearchParams({
      create: '1',
      name: $('#room-name').value.trim(),
      visibility,
      max: max.value,
    });
    location.href = '/game?' + params;
  });

  // ---------- Compte ----------
  const card = $('#account-card');
  function renderAccount() {
    if (BT.me.user) {
      card.innerHTML = `
        <h2>Mon compte</h2>
        <p>Connecté en tant que <b>${esc(BT.me.user.pseudo)}</b>.</p>
        <div class="row"><a class="btn" href="/profile">Voir mon profil</a><button class="btn danger" id="logout">Se déconnecter</button></div>`;
      $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
      return;
    }
    card.innerHTML = `
      <h2>Compte (optionnel)</h2>
      <p class="muted small">Garde ton historique, tes stats et apparais dans le classement global.</p>
      <div class="tabs seg" style="max-width:320px">
        <button type="button" class="on" data-tab="login">Connexion</button>
        <button type="button" data-tab="register">Inscription</button>
      </div>
      <form id="auth-form" class="stack" style="max-width:420px">
        <div class="field"><label for="a-pseudo">Pseudo</label><input type="text" id="a-pseudo" maxlength="20" autocomplete="username" required></div>
        <div class="field"><label for="a-pass">Mot de passe</label><input type="password" id="a-pass" maxlength="72" autocomplete="current-password" required></div>
        <button class="btn primary" type="submit" id="auth-submit">Se connecter</button>
      </form>`;
    let mode = 'login';
    $$('[data-tab]', card).forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.tab;
      $$('[data-tab]', card).forEach((x) => x.classList.toggle('on', x === b));
      $('#auth-submit').textContent = mode === 'login' ? 'Se connecter' : 'Créer le compte';
      $('#a-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    }));
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/auth/' + mode, { method: 'POST', body: { pseudo: $('#a-pseudo').value.trim(), password: $('#a-pass').value } });
        toast(mode === 'login' ? 'Connecté' : 'Compte créé', 'ok');
        setTimeout(() => location.reload(), 400);
      } catch (err) { toast(err.message, 'err'); }
    });
  }
  renderAccount();
})();
