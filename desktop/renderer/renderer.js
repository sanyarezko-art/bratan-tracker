// БРАТАН desktop — renderer.
// Talks to main via window.bratan (contextBridge). No Node / fs / net here.

'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
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
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- state ----------

/** infoHash -> { el, snapshot } */
const cards = new Map();

// ---------- UI rendering ----------

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

  // Wire per-card buttons once.
  el.querySelector('.copy-magnet').addEventListener('click', async () => {
    const field = el.querySelector('.magnet-field');
    const ok = await copyText(field.value);
    const btn = el.querySelector('.copy-magnet');
    btn.textContent = ok ? 'Скопировано' : 'Ошибка';
    setTimeout(() => (btn.textContent = 'Скопировать'), 1200);
  });
  el.querySelector('.remove-torrent').addEventListener('click', async () => {
    await api.removeTorrent(snap.infoHash);
    cards.delete(snap.infoHash);
    el.remove();
    if (!cards.size) $('#torrents-empty')?.removeAttribute('hidden');
    updateCount();
  });
  el.querySelector('.reveal-file').addEventListener('click', () => {
    const cur = cards.get(snap.infoHash)?.snapshot;
    const first = cur?.files?.[0];
    if (!first) return api.openDownloadDir();
    // main appends the torrent name to downloads path; file.path is relative
    // to the torrent root, so the absolute path isn't directly known here.
    // Fall back to just opening the downloads dir.
    api.openDownloadDir();
  });

  renderCard(snap);
  return el;
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
  const magnetField = el.querySelector('.magnet-field');
  const filesEl = el.querySelector('.torrent-files');
  const revealBtn = el.querySelector('.reveal-file');

  nameEl.textContent = snap.name || '(получаем метаданные…)';
  metaEl.textContent = [
    snap.length ? fmtBytes(snap.length) : '',
    snap.infoHash ? snap.infoHash.slice(0, 10) + '…' : '',
  ].filter(Boolean).join(' · ');

  magnetField.value = snap.magnetURI || '';

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

  // Files list
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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

async function addMagnet(uri) {
  if (!uri?.trim()) return;
  try {
    const snap = await api.addMagnet(uri.trim());
    mountCard(snap);
    updateCount();
  } catch (err) {
    alert('Не удалось открыть magnet: ' + (err?.message || err));
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

function initMagnetForm() {
  $('#add-magnet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#magnet-input');
    const val = input.value;
    if (!val.trim()) return;
    input.value = '';
    addMagnet(val);
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
  api.onDeepLinkMagnet((magnet) => addMagnet(magnet));
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
  initMagnetForm();
  initVersion();
  initStreams();
  restoreExisting();
});
