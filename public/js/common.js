/* Fonctions partagées par toutes les pages */
'use strict';

const BT = (() => {
  const PSEUDO_KEY = 'bt_pseudo';
  let me = { playerId: null, user: null };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* vide */ }
    if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
    return data;
  }

  function toast(msg, type = '') {
    let box = $('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  const getPseudo = () => me.user?.pseudo || localStorage.getItem(PSEUDO_KEY) || '';
  function setPseudo(p) {
    localStorage.setItem(PSEUDO_KEY, p);
    document.cookie = `bt_pseudo=${encodeURIComponent(p)}; path=/; max-age=31536000; samesite=lax`;
  }
  const validPseudo = (p) => /^[\p{L}\p{N} _.\-]{2,20}$/u.test(String(p || '').trim());

  const COLORS = ['#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#14b8a6', '#ef4444', '#a855f7', '#0ea5e9', '#84cc16'];
  function colorFor(s) {
    let h = 0;
    for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  function avatar(pseudo) {
    return `<span class="avatar" style="background:${colorFor(pseudo)}">${esc(String(pseudo || '?').slice(0, 1).toUpperCase())}</span>`;
  }

  function fmtMs(ms) { return ms == null ? '-' : (ms / 1000).toFixed(2).replace('.', ',') + ' s'; }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderHeader() {
    const header = $('#topbar');
    if (!header) return;
    const page = document.body.dataset.page;
    const link = (href, label, key) => `<a href="${href}" class="${page === key ? 'active' : ''}">${label}</a>`;
    header.innerHTML = `
      <a class="logo" href="/">Blind<span>test</span></a>
      <nav class="nav">
        ${link('/lobby', 'Salles', 'lobby')}
        ${link('/leaderboard', 'Classement', 'leaderboard')}
        ${me.user ? link('/profile', 'Profil', 'profile') : link('/#compte', 'Compte', 'account')}
        <span class="whoami">${me.user ? `<b>${esc(me.user.pseudo)}</b>` : getPseudo() ? `Invité <b>${esc(getPseudo())}</b>` : ''}</span>
      </nav>`;
  }

  async function init() {
    try { me = await api('/api/auth/me'); } catch { /* hors ligne */ }
    if (me.user) setPseudo(me.user.pseudo);
    renderHeader();
    return me;
  }

  /** Synchronisation d'horloge avec le serveur (méthode NTP simplifiée). */
  function createClock(socket) {
    let offset = 0;
    let rtt = 0;
    const now = () => Date.now() + offset;
    async function sync(samples = 5) {
      const results = [];
      for (let i = 0; i < samples; i++) {
        const t0 = Date.now();
        const server = await new Promise((res) => {
          const to = setTimeout(() => res(null), 2000);
          socket.emit('time:ping', (ts) => { clearTimeout(to); res(ts); });
        });
        const t1 = Date.now();
        if (server) results.push({ rtt: t1 - t0, offset: server - (t0 + t1) / 2 });
        await new Promise((r) => setTimeout(r, 60));
      }
      if (results.length) {
        results.sort((a, b) => a.rtt - b.rtt);
        const best = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
        offset = best.reduce((s, r) => s + r.offset, 0) / best.length;
        rtt = best[0].rtt;
      }
      return { offset, rtt };
    }
    return { now, sync, get offset() { return offset; }, get rtt() { return rtt; } };
  }

  return { $, $$, esc, api, toast, init, getPseudo, setPseudo, validPseudo, avatar, colorFor, fmtMs, fmtDate, createClock, get me() { return me; }, renderHeader };
})();
