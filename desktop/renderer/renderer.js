// БРАТАН desktop — renderer.
// Talks to main via window.bratan (contextBridge). No Node / fs / net here.

'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const api = window.bratan;

// ---------- helpers ----------

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  return (n / 10 ** (i * 3)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}
const fmtRate = (n) => fmtBytes(n) + '/с';

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' с';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' мин';
  const h = Math.round(m / 60);
  return h + ' ч';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shortId(id) {
  if (!id || id.length < 12) return id || '';
  return id.slice(0, 6) + '…' + id.slice(-6);
}

// ---------- state ----------

/** infoHash -> { el, snapshot } */
const cards = new Map();
let myId = '';

// ---------- torrents ----------

function mountCard(snap) {
  if (!snap.infoHash) return null;
  if (cards.has(snap.infoHash)) {
    renderCard(snap);
    return cards.get(snap.infoHash).el;
  }
  const tpl = $('#torrent-tpl');
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.infohash = snap.infoHash;
  $('#torrents').prepend(el);
  $('#torrents-empty')?.setAttribute('hidden', '');
  cards.set(snap.infoHash, { el, snapshot: snap });

  el.querySelector('.copy-share').addEventListener('click', async () => {
    const field = el.querySelector('.share-field');
    const btn = el.querySelector('.copy-share');
    const ok = await copyText(field.value);
    btn.textContent = ok ? 'Скопировано' : 'Ошибка';
    setTimeout(() => (btn.textContent = 'Скопировать'), 1200);
  });
  el.querySelector('.copy-magnet').addEventListener('click', async () => {
    const field = el.querySelector('.magnet-field');
    const btn = el.querySelector('.copy-magnet');
    const ok = await copyText(field.value);
    btn.textContent = ok ? 'Скопировано' : 'Ошибка';
    setTimeout(() => (btn.textContent = 'Magnet'), 1200);
  });
  el.querySelector('.remove-torrent').addEventListener('click', async () => {
    await api.removeTorrent(snap.infoHash);
    cards.delete(snap.infoHash);
    el.remove();
    if (!cards.size) $('#torrents-empty')?.removeAttribute('hidden');
    updateCount();
  });
  el.querySelector('.reveal-file').addEventListener('click', () => {
    api.openDownloadDir();
  });

  renderCard(snap);
  return el;
}

function renderSenderBadge(el, sender) {
  const badge = el.querySelector('.sender-badge');
  if (!badge) return;
  if (!sender) {
    badge.hidden = true;
    badge.textContent = '';
    badge.className = 'sender-badge';
    return;
  }
  badge.hidden = false;
  badge.className = 'sender-badge';
  if (sender.self) {
    badge.classList.add('self');
    badge.innerHTML = '<strong>Раздаёшь ты</strong> <span class="muted small">' + escapeHtml(shortId(sender.id)) + '</span>';
    return;
  }
  if (sender.known && sender.nickname) {
    badge.classList.add('contact');
    badge.innerHTML = 'От: <strong>' + escapeHtml(sender.nickname) + '</strong> <span class="muted small">' + escapeHtml(shortId(sender.id)) + '</span>';
    return;
  }
  if (sender.known) {
    badge.classList.add('contact');
    badge.innerHTML = 'От контакта <span class="muted small">' + escapeHtml(shortId(sender.id)) + '</span>';
    return;
  }
  badge.classList.add('unknown');
  badge.innerHTML = 'От: незнакомый <span class="muted small">' + escapeHtml(shortId(sender.id)) + '</span> '
    + '<button type="button" class="btn small link add-sender-to-contacts">Добавить в контакты</button>';
  const addBtn = badge.querySelector('.add-sender-to-contacts');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const nick = prompt('Ник для контакта ' + shortId(sender.id), '');
      if (nick === null) return;
      try {
        await api.addContact({ id: sender.id, nickname: nick });
        await refreshContacts();
      } catch (err) {
        alert('Не удалось добавить: ' + (err?.message || err));
      }
    });
  }
}

function renderCard(snap) {
  const rec = cards.get(snap.infoHash);
  if (!rec) return;
  rec.snapshot = snap;
  const { el } = rec;

  const nameEl = el.querySelector('.torrent-name');
  const metaEl = el.querySelector('.torrent-meta');
  const statsEl = el.querySelector('.torrent-stats');
  const progBar = el.querySelector('.torrent-progress > div');
  const shareField = el.querySelector('.share-field');
  const magnetField = el.querySelector('.magnet-field');
  const filesEl = el.querySelector('.torrent-files');
  const revealBtn = el.querySelector('.reveal-file');

  nameEl.textContent = snap.name || '(получаем метаданные…)';
  metaEl.textContent = [
    snap.length ? fmtBytes(snap.length) : '',
    snap.infoHash ? snap.infoHash.slice(0, 10) + '…' : '',
  ].filter(Boolean).join(' · ');

  shareField.value = snap.shareURI || '';
  magnetField.value = snap.magnetURI || '';

  renderSenderBadge(el, snap.sender);

  const pct = Math.max(0, Math.min(1, snap.progress || 0)) * 100;
  progBar.style.width = pct.toFixed(1) + '%';

  const parts = [
    'прогресс ' + pct.toFixed(1) + '%',
    'пиров ' + (snap.numPeers || 0),
    '↓ ' + fmtRate(snap.downloadSpeed || 0),
    '↑ ' + fmtRate(snap.uploadSpeed || 0),
  ];
  if (snap.done) parts.push('готово');
  else if (snap.timeRemaining != null) parts.push('осталось ' + humanDuration(snap.timeRemaining));
  statsEl.textContent = parts.join(' · ');

  filesEl.innerHTML = '';
  for (const f of snap.files || []) {
    const row = document.createElement('div');
    row.className = 'torrent-file';
    row.innerHTML = `<span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                     <span class="muted small">${fmtBytes(f.length)}</span>`;
    filesEl.appendChild(row);
  }

  revealBtn.hidden = !snap.done;
}

function updateCount() {
  $('#count-pill').textContent = String(cards.size);
  if (!cards.size) $('#torrents-empty')?.removeAttribute('hidden');
}

// ---------- global stats ----------

function recalcGlobalStats() {
  let peers = 0, down = 0, up = 0;
  for (const { snapshot } of cards.values()) {
    peers += snapshot.numPeers || 0;
    down += snapshot.downloadSpeed || 0;
    up += snapshot.uploadSpeed || 0;
  }
  $('#stat-peers').textContent = String(peers);
  $('#stat-down').textContent = fmtRate(down);
  $('#stat-up').textContent = fmtRate(up);
}
setInterval(recalcGlobalStats, 700);

// ---------- actions ----------

async function seedPaths(paths) {
  if (!paths?.length) return;
  try {
    const snap = await api.seedPaths(paths);
    mountCard(snap);
    updateCount();
  } catch (err) {
    alert('Не удалось добавить раздачу: ' + (err?.message || err));
  }
}

async function addLink(link) {
  if (!link?.trim()) return;
  try {
    const snap = await api.addLink(link.trim());
    mountCard(snap);
    updateCount();
    // If the share pointed to an unknown sender, refresh the badge after the
    // renderer-side contacts list update — handled by the add-sender-to-contacts
    // button inside the badge itself.
  } catch (err) {
    alert('Не удалось открыть: ' + (err?.message || err));
  }
}

// ---------- contacts ----------

async function refreshContacts() {
  const list = await api.listContacts();
  const box = $('#contacts');
  box.querySelectorAll('.contact').forEach((n) => n.remove());
  $('#contacts-count-pill').textContent = String(list.length);
  if (!list.length) {
    $('#contacts-empty')?.removeAttribute('hidden');
  } else {
    $('#contacts-empty')?.setAttribute('hidden', '');
  }
  const tpl = $('#contact-tpl');
  for (const c of list) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.querySelector('.contact-nick').textContent = c.nickname || '(без ника)';
    el.querySelector('.contact-id').textContent = c.id;
    el.querySelector('.remove-contact').addEventListener('click', async () => {
      if (!confirm('Удалить контакт ' + (c.nickname || shortId(c.id)) + '?')) return;
      await api.removeContact(c.id);
      await refreshContacts();
      // Re-render already-loaded torrent cards so sender labels reflect the removal.
      for (const { snapshot } of cards.values()) renderCard(snapshot);
    });
    box.appendChild(el);
  }
  // Existing torrent cards may reference this contact; re-pull sender info.
  for (const { snapshot, el } of cards.values()) {
    if (snapshot.sender && snapshot.sender.id && !snapshot.sender.self) {
      const match = list.find((c) => c.id === snapshot.sender.id);
      snapshot.sender = {
        id: snapshot.sender.id,
        nickname: match?.nickname || '',
        self: false,
        known: !!match,
      };
      renderSenderBadge(el, snapshot.sender);
    }
  }
}

// ---------- wiring ----------

function initDropZone() {
  const dz = $('#drop-zone');
  const pickBtn = $('#btn-pick-files');

  ['dragenter', 'dragover'].forEach((ev) => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag-over'); });
  });
  dz.addEventListener('drop', (e) => {
    const items = [...(e.dataTransfer?.files || [])];
    const paths = items.map((f) => f.path).filter(Boolean);
    if (paths.length) seedPaths(paths);
  });

  pickBtn.addEventListener('click', async () => {
    const paths = await api.pickFiles();
    if (paths?.length) seedPaths(paths);
  });
}

function initLinkForm() {
  $('#add-link-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#link-input');
    const val = input.value;
    if (!val.trim()) return;
    input.value = '';
    addLink(val);
  });
}

function initContactForm() {
  $('#add-contact-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nick = $('#contact-nickname').value.trim();
    const id = $('#contact-id').value.trim();
    if (!id) return;
    try {
      await api.addContact({ id, nickname: nick });
      $('#contact-nickname').value = '';
      $('#contact-id').value = '';
      await refreshContacts();
    } catch (err) {
      alert('Не удалось добавить контакт: ' + (err?.message || err));
    }
  });
}

function initTopbar() {
  $('#btn-open-downloads').addEventListener('click', () => api.openDownloadDir());
}

async function initVersion() {
  try {
    const v = await api.version();
    $('#app-version').textContent = 'v' + v;
  } catch { /* ignore */ }
}

async function initIdentity() {
  try {
    const me = await api.me();
    if (!me) return;
    myId = me.id;
    $('#my-id').value = me.id;
    if (me.qrDataURL) $('#my-qr').src = me.qrDataURL;
    $('#btn-copy-id').addEventListener('click', async () => {
      const btn = $('#btn-copy-id');
      const ok = await copyText(me.id);
      btn.textContent = ok ? 'Скопировано' : 'Ошибка';
      setTimeout(() => (btn.textContent = 'Скопировать'), 1200);
    });
  } catch (err) {
    console.warn('identity failed:', err);
  }
}

function initStreams() {
  api.onTorrentUpdate((snap) => {
    if (!snap?.infoHash) return;
    if (cards.has(snap.infoHash)) renderCard(snap);
    else mountCard(snap);
    updateCount();
  });
  api.onTorrentError(({ infoHash, message }) => {
    console.warn('torrent error', infoHash, message);
  });
  api.onDeepLink((parsed) => {
    if (!parsed) return;
    // parsed is either { kind: 'magnet', magnet } or { kind: 'share', magnet, sender, valid }
    // Reconstruct the original share URI or magnet and feed it through the regular addLink path.
    if (parsed.kind === 'share') {
      // The renderer doesn't know the original base64 payload, so hand the
      // magnet directly — the main process already tagged the sender in the
      // share-decode step when parsing the deep link, but not for re-adds via
      // the regular add-link IPC. Safer: re-encode via server hint. For now,
      // add the magnet and rely on a subsequent signed share to claim the
      // sender.
      addLink(parsed.magnet);
    } else {
      addLink(parsed.magnet);
    }
  });
}

// ---------- auto-update banner ----------

let updateDismissedAt = 0;

function renderUpdateBanner(state) {
  const banner = $('#update-banner');
  const title = $('#update-title');
  const sub = $('#update-subtitle');
  const action = $('#btn-update-action');
  if (!banner || !state) return;

  const s = state.status;
  const ver = state.version ? ('v' + state.version) : '';

  // We keep the banner hidden for idle/checking/up-to-date and hide it while
  // the user explicitly dismissed the latest prompt for this version.
  if (s === 'idle' || s === 'checking' || s === 'up-to-date') {
    banner.hidden = true;
    return;
  }

  if (updateDismissedAt && state.version && updateDismissedAt === state.version) {
    banner.hidden = true;
    return;
  }

  if (s === 'available') {
    title.textContent = 'Новая версия ' + (ver || '');
    sub.textContent = state.canAutoInstall
      ? 'Готовлю обновление…'
      : 'На macOS без подписи автоустановка невозможна — открою страницу, скачай DMG.';
    action.textContent = state.canAutoInstall ? 'Жду загрузку…' : 'Открыть страницу релиза';
    action.disabled = !!state.canAutoInstall;
    action.dataset.role = state.canAutoInstall ? 'wait' : 'open';
    banner.hidden = false;
    return;
  }

  if (s === 'downloading') {
    title.textContent = 'Качаю ' + (ver || 'обновление') + '…';
    const pct = Number.isFinite(state.percent) ? state.percent : 0;
    sub.textContent = pct + '%';
    action.textContent = 'Жду загрузку…';
    action.disabled = true;
    action.dataset.role = 'wait';
    banner.hidden = false;
    return;
  }

  if (s === 'ready') {
    title.textContent = 'Обновление ' + (ver || '') + ' готово';
    sub.textContent = 'Перезапустить сейчас или при следующем закрытии.';
    action.textContent = 'Установить и перезапустить';
    action.disabled = false;
    action.dataset.role = 'install';
    banner.hidden = false;
    return;
  }

  if (s === 'error') {
    title.textContent = 'Не получилось проверить обновление';
    sub.textContent = state.error || '';
    action.textContent = 'Открыть релизы вручную';
    action.disabled = false;
    action.dataset.role = 'open';
    banner.hidden = false;
  }
}

function initUpdateBanner() {
  const action = $('#btn-update-action');
  const dismiss = $('#btn-update-dismiss');
  if (!action || !dismiss) return;

  action.addEventListener('click', async () => {
    const role = action.dataset.role;
    if (role === 'install') {
      await api.installUpdate();
    } else if (role === 'open') {
      await api.openReleasePage();
    }
  });
  dismiss.addEventListener('click', async () => {
    const state = await api.getUpdateState();
    updateDismissedAt = state?.version || 1;
    $('#update-banner').hidden = true;
  });

  api.onUpdateState((state) => renderUpdateBanner(state));
  api.getUpdateState().then(renderUpdateBanner).catch(() => {});
}

async function restoreExisting() {
  try {
    const list = await api.listTorrents();
    for (const snap of list) mountCard(snap);
    updateCount();
  } catch (err) {
    console.warn('list failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTopbar();
  initDropZone();
  initLinkForm();
  initContactForm();
  initVersion();
  initIdentity();
  initUpdateBanner();
  initStreams();
  refreshContacts();
  restoreExisting();
});
