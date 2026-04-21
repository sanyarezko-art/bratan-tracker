// БРАТАН-трекер — client logic
// Runs fully in the browser. No analytics, no cookies, no backend.

import WebTorrent from 'https://cdn.jsdelivr.net/npm/webtorrent@2.5.1/dist/webtorrent.min.js';
// Expose for devtools / quick scripting. Not used elsewhere in the code.
window.WebTorrent = WebTorrent;

const WT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];

// Public STUN servers help WebRTC punch through symmetric-ish NATs.
// No TURN by design — TURN would relay traffic through a third party.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 4,
};

// Per-torrent knobs. `maxConns` caps WebRTC peers in total on the client;
// `maxWebConns` is for HTTP webseeds per torrent (harmless if none).
const CLIENT_MAX_CONNS = 96;
const TORRENT_MAX_WEB_CONNS = 16;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  return (n / 10 ** (i * 3)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
};
const fmtRate = (n) => fmtBytes(n) + '/с';

const MEDIA_EXT = {
  video: ['mp4', 'webm', 'm4v', 'mkv', 'mov', 'ogv'],
  audio: ['mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a', 'aac'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'],
  text: ['txt', 'md', 'json', 'xml', 'csv', 'log', 'html', 'css', 'js', 'srt', 'vtt'],
};
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const kindOf = (name) => {
  const e = extOf(name);
  for (const [k, list] of Object.entries(MEDIA_EXT)) if (list.includes(e)) return k;
  return 'file';
};

const ICON = {
  video: '▶',
  audio: '♪',
  image: '🖼',
  text: '📄',
  file: '📦',
};

function buildShareLink(magnet) {
  const base = location.origin + location.pathname;
  return base + '#magnet=' + encodeURIComponent(magnet);
}

function parseShareLinkOrMagnet(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (s.startsWith('magnet:')) return s;
  try {
    const u = new URL(s);
    const hash = u.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const m = params.get('magnet');
    if (m) return decodeURIComponent(m);
  } catch {}
  return null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

function renderQR(container, text) {
  container.innerHTML = '';
  if (typeof window.qrcode !== 'function') {
    container.textContent = 'QR недоступен';
    return;
  }
  // type 0 = auto-detect, error correction 'M'
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const svg = container.querySelector('svg');
  if (svg) {
    svg.setAttribute('width', '180');
    svg.setAttribute('height', '180');
    svg.style.background = '#fff';
    svg.style.borderRadius = '8px';
    svg.style.padding = '6px';
  }
}

// ---------- WebTorrent client ----------

let client = null;
const torrents = new Map(); // infoHash -> { torrent, el, unsubs: [] }

function ensureClient() {
  if (client) return client;
  if (typeof WebTorrent !== 'function') {
    const banner = document.getElementById('wt-load-error');
    if (banner) banner.hidden = false;
    throw new Error('WebTorrent library failed to load');
  }
  client = new WebTorrent({
    maxConns: CLIENT_MAX_CONNS,
    tracker: {
      announce: WT_TRACKERS,
      rtcConfig: RTC_CONFIG,
    },
  });
  client.on('error', (err) => {
    console.warn('WebTorrent error:', err?.message || err);
  });
  return client;
}

function updateGlobalStats() {
  if (!client) return;
  $('#stat-peers').textContent = String(
    [...torrents.values()].reduce((n, t) => n + (t.torrent.numPeers || 0), 0),
  );
  $('#stat-down').textContent = fmtRate(client.downloadSpeed || 0);
  $('#stat-up').textContent = fmtRate(client.uploadSpeed || 0);
  const ratio = client.ratio || 0;
  $('#stat-ratio').textContent = ratio.toFixed(2);
}
setInterval(updateGlobalStats, 1000);

// ---------- Torrent UI ----------

function mountTorrentEl(torrent) {
  const tpl = $('#torrent-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.infohash = torrent.infoHash;
  $('#torrents').prepend(node);
  $('#torrents-empty')?.setAttribute('hidden', '');
  renderTorrentCard(node, torrent);
  return node;
}

function renderTorrentCard(el, torrent) {
  const nameEl = $('.torrent-name', el);
  const metaEl = $('.torrent-meta', el);
  const statsEl = $('.torrent-stats', el);
  const progBar = $('.torrent-progress > div', el);
  const magnetField = $('.magnet-field', el);
  const shareField = $('.share-field', el);
  const qrBox = $('.qr-box', el);
  const filesEl = $('.torrent-files', el);
  const copyMagnetBtn = $('.copy-magnet', el);
  const copyShareBtn = $('.copy-share', el);
  const qrBtn = $('.toggle-qr', el);
  const removeBtn = $('.remove-torrent', el);

  const setMagnet = () => {
    const m = torrent.magnetURI || '';
    magnetField.value = m;
    shareField.value = m ? buildShareLink(m) : '';
  };
  setMagnet();

  const setName = () => {
    nameEl.textContent = torrent.name || '(без имени, получаем метаданные…)';
    const totalBytes = torrent.length || 0;
    const pieceCount = torrent.pieces?.length || 0;
    metaEl.textContent = [
      fmtBytes(totalBytes),
      pieceCount ? pieceCount + ' кусков' : '',
      torrent.infoHash ? torrent.infoHash.slice(0, 10) + '…' : '',
    ].filter(Boolean).join(' · ');
  };
  setName();

  const renderFiles = () => {
    filesEl.innerHTML = '';
    if (!torrent.files?.length) return;
    for (const file of torrent.files) {
      const row = document.createElement('div');
      row.className = 'torrent-file';
      const kind = kindOf(file.name);
      row.innerHTML = `
        <span class="file-name"><span class="file-ico">${ICON[kind]}</span> ${escapeHtml(file.name)}</span>
        <span class="file-meta muted">${fmtBytes(file.length)}</span>
        <span class="file-actions"></span>
      `;
      const actions = $('.file-actions', row);
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn small';
      saveBtn.textContent = 'Сохранить';
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Готовим…';
        try {
          const blob = await fileToBlob(file);
          triggerDownload(blob, file.name);
          saveBtn.textContent = 'Сохранить';
        } catch (err) {
          console.error(err);
          saveBtn.textContent = 'Ошибка';
        } finally {
          saveBtn.disabled = false;
        }
      });
      actions.appendChild(saveBtn);

      if (kind === 'video' || kind === 'audio' || kind === 'image') {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn small';
        openBtn.textContent = kind === 'image' ? 'Показать' : 'Смотреть';
        openBtn.addEventListener('click', () => openMediaInline(row, file, kind, openBtn));
        actions.appendChild(openBtn);
      }

      filesEl.appendChild(row);
    }
  };

  const updateProgress = () => {
    const pct = Math.max(0, Math.min(1, torrent.progress || 0)) * 100;
    progBar.style.width = pct.toFixed(1) + '%';
    const parts = [];
    parts.push('прогресс ' + pct.toFixed(1) + '%');
    parts.push('пиров ' + (torrent.numPeers || 0));
    parts.push('↓ ' + fmtRate(torrent.downloadSpeed || 0));
    parts.push('↑ ' + fmtRate(torrent.uploadSpeed || 0));
    if (torrent.done) parts.push('готово');
    else if (torrent.timeRemaining && Number.isFinite(torrent.timeRemaining)) {
      parts.push('осталось ' + humanDuration(torrent.timeRemaining));
    }
    statsEl.textContent = parts.join(' · ');
  };

  // `download`/`upload` fire per chunk — can be hundreds of times per second.
  // Coalesce all progress-related events into a single DOM update per animation
  // frame. rAF also pauses in hidden tabs, so we stop burning cycles there.
  let rafPending = false;
  const scheduleProgress = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; updateProgress(); });
  };
  const onMeta = () => { setMagnet(); setName(); renderFiles(); scheduleProgress(); };

  torrent.on('metadata', onMeta);
  torrent.on('ready', onMeta);
  torrent.on('done', scheduleProgress);
  torrent.on('wire', scheduleProgress);
  torrent.on('noPeers', scheduleProgress);
  torrent.on('download', scheduleProgress);
  torrent.on('upload', scheduleProgress);
  // Safety-net slow tick so ETA / peer count still refresh when nothing is
  // actively flowing (e.g. all peers choked us).
  const onTick = setInterval(scheduleProgress, 1000);

  // Initial render (seeding case: metadata already present)
  if (torrent.name) onMeta();
  updateProgress();

  copyMagnetBtn.addEventListener('click', async () => {
    const ok = await copyText(magnetField.value);
    copyMagnetBtn.textContent = ok ? 'Скопировано' : 'Ошибка';
    setTimeout(() => (copyMagnetBtn.textContent = 'Скопировать'), 1200);
  });
  copyShareBtn.addEventListener('click', async () => {
    const ok = await copyText(shareField.value);
    copyShareBtn.textContent = ok ? 'Скопировано' : 'Ошибка';
    setTimeout(() => (copyShareBtn.textContent = 'Скопировать'), 1200);
  });
  qrBtn.addEventListener('click', () => {
    const hidden = qrBox.hasAttribute('hidden');
    if (hidden) {
      renderQR(qrBox, shareField.value);
      qrBox.removeAttribute('hidden');
      qrBtn.textContent = 'Скрыть QR';
    } else {
      qrBox.setAttribute('hidden', '');
      qrBtn.textContent = 'QR';
    }
  });

  removeBtn.addEventListener('click', () => {
    clearInterval(onTick);
    const rec = torrents.get(torrent.infoHash);
    if (rec) {
      torrents.delete(torrent.infoHash);
    }
    try { torrent.destroy(); } catch {}
    el.remove();
    if (!torrents.size) $('#torrents-empty')?.removeAttribute('hidden');
  });

  torrents.set(torrent.infoHash, { torrent, el, cleanup: () => clearInterval(onTick) });
}

function fileToBlob(file) {
  if (typeof file.blob === 'function') {
    // webtorrent 2.x
    return file.blob();
  }
  return new Promise((resolve, reject) => {
    if (typeof file.getBlob !== 'function') {
      reject(new Error('Нет getBlob/blob у файла'));
      return;
    }
    file.getBlob((err, blob) => err ? reject(err) : resolve(blob));
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function openMediaInline(row, file, kind, btn) {
  btn.disabled = true;
  btn.textContent = 'Загрузка…';
  try {
    if (kind === 'image') {
      const blob = await fileToBlob(file);
      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = url;
      img.alt = file.name;
      img.style.maxWidth = '100%';
      img.style.marginTop = '8px';
      img.style.borderRadius = '8px';
      row.parentElement.insertBefore(img, row.nextSibling);
    } else {
      const el = document.createElement(kind); // 'video' | 'audio'
      el.controls = true;
      el.preload = 'metadata';
      el.style.marginTop = '8px';
      el.style.width = '100%';
      if (typeof file.streamURL === 'string') {
        el.src = file.streamURL;
      } else if (typeof file.getBlobURL === 'function') {
        await new Promise((res, rej) => file.getBlobURL((err, url) => err ? rej(err) : (el.src = url, res())));
      } else {
        const blob = await fileToBlob(file);
        el.src = URL.createObjectURL(blob);
      }
      row.parentElement.insertBefore(el, row.nextSibling);
    }
    btn.textContent = 'Открыто';
    btn.disabled = true;
  } catch (err) {
    console.error(err);
    btn.textContent = 'Ошибка';
    btn.disabled = false;
  }
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' с';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' мин';
  const h = Math.round(m / 60);
  return h + ' ч';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Add / Seed ----------

function addMagnet(magnetURI) {
  if (!magnetURI) return;
  const cli = ensureClient();
  // Extract infohash (quick path) to de-dupe
  const ihMatch = magnetURI.match(/xt=urn:btih:([a-zA-Z0-9]+)/);
  const ih = ihMatch ? ihMatch[1].toLowerCase() : null;
  if (ih && torrents.has(ih)) {
    torrents.get(ih).el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  let torrent;
  try {
    torrent = cli.add(magnetURI, {
      announce: WT_TRACKERS,
      maxWebConns: TORRENT_MAX_WEB_CONNS,
    });
  } catch (err) {
    alert('Не удалось добавить magnet: ' + (err?.message || err));
    return;
  }
  mountTorrentEl(torrent);
  torrent.on('error', (err) => console.warn('torrent error:', err?.message || err));
}

function seedFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const cli = ensureClient();
  const torrent = cli.seed(files, {
    announce: WT_TRACKERS,
    maxWebConns: TORRENT_MAX_WEB_CONNS,
  });
  mountTorrentEl(torrent);
  torrent.on('error', (err) => console.warn('seed error:', err?.message || err));
}

// ---------- Catalog ----------

let catalogData = [];
async function loadCatalog() {
  const list = $('#catalog-list');
  try {
    const res = await fetch('catalog.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    catalogData = Array.isArray(data) ? data : (data.items || []);
  } catch (err) {
    list.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'muted small';
    div.textContent = 'Не удалось загрузить каталог: ' + (err?.message || err);
    list.appendChild(div);
    return;
  }
  renderCatalog();
}

function renderCatalog() {
  const list = $('#catalog-list');
  const q = ($('#catalog-search').value || '').trim().toLowerCase();
  list.innerHTML = '';
  const filtered = catalogData.filter((item) => {
    if (!q) return true;
    const hay = [item.title, item.description, ...(item.tags || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  $('#catalog-empty').hidden = filtered.length > 0;
  for (const item of filtered) {
    const el = document.createElement('div');
    el.className = 'catalog-item';
    el.innerHTML = `
      <div class="info">
        <div class="title">${escapeHtml(item.title || '(без названия)')}</div>
        ${item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : ''}
        ${item.size ? `<div class="muted small">Размер: ${escapeHtml(item.size)}</div>` : ''}
        ${item.tags?.length ? `<div class="tags">${item.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="actions"></div>
    `;
    const actions = $('.actions', el);
    const openBtn = document.createElement('button');
    openBtn.className = 'btn primary small';
    openBtn.type = 'button';
    openBtn.textContent = 'Открыть';
    openBtn.addEventListener('click', () => {
      addMagnet(item.magnet);
      $('#torrents-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Magnet';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(item.magnet);
      copyBtn.textContent = ok ? 'Скопировано' : 'Ошибка';
      setTimeout(() => (copyBtn.textContent = 'Magnet'), 1200);
    });
    actions.append(openBtn, copyBtn);
    list.appendChild(el);
  }
}

// ---------- Init ----------

function initDropZone() {
  const dz = $('#drop-zone');
  const input = $('#seed-file-input');
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { prevent(e); dz.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { prevent(e); dz.classList.remove('hover'); }));
  dz.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) seedFiles(files);
  });
  input.addEventListener('change', () => {
    if (input.files?.length) seedFiles(input.files);
    input.value = '';
  });
}

function initMagnetForm() {
  const form = $('#add-magnet-form');
  const input = $('#magnet-input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = parseShareLinkOrMagnet(input.value) || (input.value.trim().startsWith('magnet:') ? input.value.trim() : null);
    if (!val) {
      alert('Нужна magnet-ссылка или share-ссылка вида …#magnet=…');
      return;
    }
    addMagnet(val);
    input.value = '';
    $('#torrents-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function initCatalog() {
  loadCatalog();
  $('#catalog-search').addEventListener('input', renderCatalog);
}

function initHashShare() {
  const tryLoad = () => {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const m = params.get('magnet');
    if (m) {
      const magnet = decodeURIComponent(m);
      addMagnet(magnet);
      $('#torrents-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  window.addEventListener('hashchange', tryLoad);
  tryLoad();
}

function initBuildId() {
  $('#build-id').textContent = new Date().toISOString().slice(0, 16).replace('T', ' ');
}

function bootstrap() {
  initBuildId();
  initDropZone();
  initMagnetForm();
  initCatalog();
  initHashShare();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
