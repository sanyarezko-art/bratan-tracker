// БРАТАН — Electron main process.
//
// Runs the full WebTorrent stack (TCP + UDP + uTP + DHT + WebRTC) in Node,
// and bridges events / commands to the renderer over IPC. The renderer is
// sandboxed with contextIsolation — it has no Node access.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

const identity = require('./identity');
const contacts = require('./contacts');
const share = require('./share');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');

// webtorrent 2.x is ESM-only with top-level await, so it can't be require()'d
// from our CommonJS main process. Use a one-shot dynamic import.
let WebTorrentPromise = null;
function loadWebTorrent() {
  if (!WebTorrentPromise) {
    WebTorrentPromise = import('webtorrent').then((mod) => mod.default || mod);
  }
  return WebTorrentPromise;
}

// ---------- single instance (so bratan:// links always hit the existing app) ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ---------- config ----------

const WT_TRACKERS = [
  // Hybrid list: WSS for pure-browser peers (if any), HTTP/UDP for desktop
  // peers (qBittorrent / Transmission / other БРАТАН instances).
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];

const DEFAULT_DOWNLOAD_DIR = path.join(app.getPath('downloads'), 'Bratan');

function ensureDownloadDir() {
  try { fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ---------- identity + contacts ----------

// Identity is loaded once on app ready; senderByInfoHash tracks the claimed
// sender of each magnet we've received via a signed share link. Our own
// seeds are tagged with our own public id so the renderer can label them.

let myIdentity = null;
const senderByInfoHash = new Map();

function userDataDir() { return app.getPath('userData'); }
function myPublicId() { return myIdentity ? identity.publicId(myIdentity) : null; }

function senderInfo(id) {
  if (!id) return null;
  if (id === myPublicId()) return { id, nickname: '', self: true, known: true };
  const rec = contacts.lookup(userDataDir(), id);
  return rec
    ? { id, nickname: rec.nickname, self: false, known: true }
    : { id, nickname: '', self: false, known: false };
}

// ---------- WebTorrent client (lives for the whole app lifetime) ----------

let client = null;
let clientPromise = null;
async function getClient() {
  if (client) return client;
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const WebTorrent = await loadWebTorrent();
    const c = new WebTorrent({
      // WebTorrent in Node auto-enables: tcp, utp, dht, lsd, webSeeds.
      // Bump a couple of knobs for sharing big files over slow networks.
      maxConns: 100,
      dht: true,
      lsd: true,
      utp: true,
      tcp: true,
      natUpnp: true,
      natPmp: true,
    });
    c.on('error', (err) => {
      // Non-fatal: log and keep going. Tracker connection failures arrive here.
      console.warn('[wt] client error:', err && err.message ? err.message : err);
    });
    client = c;
    return c;
  })();
  return clientPromise;
}

// ---------- windows ----------

let mainWindow = null;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    backgroundColor: '#0b0f14',
    title: 'БРАТАН',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    // External links go to the user's browser, not a new Electron window.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow = win;
  return win;
}

// ---------- protocol: bratan://magnet/<magnet URI> or bratan://share/v1/<…> ----------

if (!app.isDefaultProtocolClient('bratan')) app.setAsDefaultProtocolClient('bratan');

function parseDeepLink(url) {
  if (!url || typeof url !== 'string') return null;
  // Signed-share form is the new preferred shape.
  const shareDecoded = share.decode(url);
  if (shareDecoded) return shareDecoded;
  try {
    const u = new URL(url);
    if (u.protocol !== 'bratan:') return null;
    // Legacy: bratan://magnet/<magnet:?…> or bratan://?magnet=<urlenc>
    const raw = u.pathname.replace(/^\/*/, '') || u.hostname || '';
    if (raw.startsWith('magnet:')) return { kind: 'magnet', magnet: decodeURIComponent(raw) };
    const q = u.searchParams.get('magnet');
    if (q) return { kind: 'magnet', magnet: decodeURIComponent(q) };
  } catch { /* fallthrough */ }
  return null;
}

function maybeOpenPendingLink(argv) {
  const found = (argv || []).find((a) => typeof a === 'string' && a.startsWith('bratan:'));
  if (!found) return;
  const parsed = parseDeepLink(found);
  if (!parsed) return;
  if (mainWindow) mainWindow.webContents.send('deep-link', parsed);
  else app.once('browser-window-created', () => {
    setTimeout(() => mainWindow?.webContents.send('deep-link', parsed), 400);
  });
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  maybeOpenPendingLink(argv);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  const parsed = parseDeepLink(url);
  if (parsed && mainWindow) mainWindow.webContents.send('deep-link', parsed);
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  // Minimal menu so Ctrl+C/V/Z work and DevTools is reachable in dev.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'БРАТАН',
      submenu: [
        {
          label: 'Папка загрузок',
          click: () => { ensureDownloadDir(); shell.openPath(DEFAULT_DOWNLOAD_DIR); },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ]));

  ensureDownloadDir();
  try {
    myIdentity = identity.loadOrCreate(userDataDir());
  } catch (err) {
    console.error('[identity] failed to load/create:', err);
  }
  createMainWindow();
  maybeOpenPendingLink(process.argv);
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  // macOS convention is to keep the app alive in the dock, but the point of
  // this app is "close = stop seeding". Quit cleanly on every platform.
  app.quit();
});

app.on('before-quit', () => {
  if (client) {
    try { client.destroy(() => { /* noop */ }); } catch { /* ignore */ }
  }
});

// ---------- IPC: torrents ----------

// Coalesce per-torrent progress pushes to one per 250 ms so the renderer
// doesn't spend all its time in layout.
const progressTimers = new Map();

function snapshot(t) {
  const magnetURI = t.magnetURI || '';
  const claimedSender = t.infoHash ? senderByInfoHash.get(t.infoHash) || null : null;
  let shareURI = '';
  if (magnetURI && myIdentity) {
    try { shareURI = share.encode(myIdentity, magnetURI); } catch { /* ignore */ }
  }
  return {
    infoHash: t.infoHash || null,
    magnetURI,
    shareURI,
    name: t.name || '',
    length: t.length || 0,
    progress: t.progress || 0,
    downloadSpeed: t.downloadSpeed || 0,
    uploadSpeed: t.uploadSpeed || 0,
    numPeers: t.numPeers || 0,
    downloaded: t.downloaded || 0,
    uploaded: t.uploaded || 0,
    timeRemaining: Number.isFinite(t.timeRemaining) ? t.timeRemaining : null,
    done: !!t.done,
    paused: !!t.paused,
    files: (t.files || []).map((f) => ({ name: f.name, length: f.length, path: f.path })),
    ready: !!t.ready,
    sender: senderInfo(claimedSender),
  };
}

function attachTorrentListeners(t, webContents) {
  const push = () => {
    if (webContents.isDestroyed()) return;
    webContents.send('torrent:update', snapshot(t));
  };
  const schedule = () => {
    if (progressTimers.has(t.infoHash)) return;
    progressTimers.set(t.infoHash, setTimeout(() => {
      progressTimers.delete(t.infoHash);
      push();
    }, 250));
  };
  t.on('metadata', push);
  t.on('ready', push);
  t.on('done', push);
  t.on('noPeers', schedule);
  t.on('wire', schedule);
  t.on('download', schedule);
  t.on('upload', schedule);
  t.on('error', (err) => {
    if (webContents.isDestroyed()) return;
    webContents.send('torrent:error', { infoHash: t.infoHash, message: String(err?.message || err) });
  });
  // Push once so the renderer gets the seed's initial state.
  setTimeout(push, 0);
}

ipcMain.handle('torrent:list', async () => {
  const cli = await getClient();
  return cli.torrents.map(snapshot);
});

ipcMain.handle('torrent:seed-paths', async (event, paths) => {
  if (!Array.isArray(paths) || !paths.length) throw new Error('no paths');
  const cli = await getClient();
  return new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    cli.once('error', onErr);
    cli.seed(paths, { announce: WT_TRACKERS, path: DEFAULT_DOWNLOAD_DIR }, (torrent) => {
      cli.removeListener('error', onErr);
      // Our own seed: tag with our public id so the renderer shows "Раздаёшь ты".
      if (torrent.infoHash && myIdentity) senderByInfoHash.set(torrent.infoHash, myPublicId());
      attachTorrentListeners(torrent, event.sender);
      resolve(snapshot(torrent));
    });
  });
});

/** Accepts a raw magnet URI OR a bratan://share/v1/… link. */
ipcMain.handle('torrent:add-link', async (event, link) => {
  if (typeof link !== 'string' || !link.trim()) throw new Error('empty link');
  const parsed = share.decode(link.trim());
  if (!parsed) throw new Error('Не magnet-ссылка и не БРАТАН-share');
  const magnet = parsed.magnet;
  const claimedSender = parsed.kind === 'share' && parsed.valid ? parsed.sender : null;

  const cli = await getClient();
  return new Promise((resolve, reject) => {
    let resolved = false;
    const torrent = cli.add(magnet, {
      announce: WT_TRACKERS,
      path: DEFAULT_DOWNLOAD_DIR,
    });
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (torrent.infoHash && claimedSender) {
        senderByInfoHash.set(torrent.infoHash, claimedSender);
      }
      attachTorrentListeners(torrent, event.sender);
      resolve(snapshot(torrent));
    };
    torrent.on('infoHash', finish);
    torrent.once('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });
    setTimeout(finish, 3000);
  });
});

ipcMain.handle('torrent:remove', async (_event, infoHash) => {
  const cli = await getClient();
  const t = cli.get(infoHash);
  if (!t) return false;
  return new Promise((resolve) => {
    t.destroy({ destroyStore: false }, () => resolve(true));
  });
});

ipcMain.handle('torrent:pause', async (_event, infoHash) => {
  const cli = await getClient();
  const t = cli.get(infoHash);
  if (!t) return false;
  t.pause();
  return true;
});

ipcMain.handle('torrent:resume', async (_event, infoHash) => {
  const cli = await getClient();
  const t = cli.get(infoHash);
  if (!t) return false;
  t.resume();
  return true;
});

ipcMain.handle('open-download-dir', () => {
  ensureDownloadDir();
  shell.openPath(DEFAULT_DOWNLOAD_DIR);
});

ipcMain.handle('reveal-file', (_event, absPath) => {
  if (typeof absPath !== 'string' || !absPath) return false;
  shell.showItemInFolder(absPath);
  return true;
});

ipcMain.handle('pick-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбрать файлы для раздачи',
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:paths', () => ({
  downloads: DEFAULT_DOWNLOAD_DIR,
  home: os.homedir(),
}));

// ---------- IPC: identity + contacts ----------

ipcMain.handle('identity:me', async () => {
  if (!myIdentity) return null;
  const id = myPublicId();
  const qrDataURL = await QRCode.toDataURL(id, {
    margin: 1,
    width: 256,
    color: { dark: '#0b0f14', light: '#ffffff' },
  }).catch(() => '');
  return { id, qrDataURL };
});

ipcMain.handle('contacts:list', () => contacts.load(userDataDir()));

ipcMain.handle('contacts:add', (_event, rec) => {
  const list = contacts.add(userDataDir(), rec || {});
  return list;
});

ipcMain.handle('contacts:remove', (_event, id) => contacts.remove(userDataDir(), id));

ipcMain.handle('share:decode', (_event, link) => {
  const parsed = share.decode(link);
  if (!parsed) return null;
  if (parsed.kind === 'share') {
    return { ...parsed, senderInfo: senderInfo(parsed.sender) };
  }
  return parsed;
});

// ---------- auto-update ----------
//
// Release channel: GitHub Releases of this repo. electron-updater grabs
// latest.yml / latest-mac.yml / latest-linux.yml from the release assets.
//
// Honesty caveat: on macOS without code signing, Squirrel.Mac refuses to
// apply the update. We still run the *check*, but we never autoDownload
// there — instead we surface a banner that opens the GitHub Release page
// so the user can re-install manually. Windows NSIS and Linux AppImage
// don't need signing and do a full silent download + quit-and-install.

const UPDATE_CAN_AUTO_INSTALL = process.platform !== 'darwin';
let updateState = {
  status: 'idle',        // idle | checking | up-to-date | available | downloading | ready | error
  version: null,
  releaseUrl: null,
  percent: 0,
  error: null,
  canAutoInstall: UPDATE_CAN_AUTO_INSTALL,
};

function broadcastUpdate() {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateState);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    // Dev runs have no useful update to find.
    updateState = { ...updateState, status: 'idle' };
    return;
  }

  autoUpdater.autoDownload = UPDATE_CAN_AUTO_INSTALL;
  autoUpdater.autoInstallOnAppQuit = UPDATE_CAN_AUTO_INSTALL;
  autoUpdater.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => console.warn('[updater]', m),
    error: (m) => console.error('[updater]', m),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => {
    updateState = { ...updateState, status: 'checking', error: null };
    broadcastUpdate();
  });
  autoUpdater.on('update-available', (info) => {
    updateState = {
      ...updateState,
      status: UPDATE_CAN_AUTO_INSTALL ? 'downloading' : 'available',
      version: info?.version || null,
      releaseUrl: info?.version
        ? `https://github.com/sanyarezko-art/bratan-tracker/releases/tag/v${info.version}`
        : 'https://github.com/sanyarezko-art/bratan-tracker/releases/latest',
      error: null,
    };
    broadcastUpdate();
  });
  autoUpdater.on('update-not-available', () => {
    updateState = { ...updateState, status: 'up-to-date', error: null };
    broadcastUpdate();
  });
  autoUpdater.on('download-progress', (p) => {
    updateState = {
      ...updateState,
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(p?.percent || 0))),
    };
    broadcastUpdate();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = {
      ...updateState,
      status: 'ready',
      version: info?.version || updateState.version,
      percent: 100,
      error: null,
    };
    broadcastUpdate();
  });
  autoUpdater.on('error', (err) => {
    updateState = {
      ...updateState,
      status: 'error',
      error: err?.message || String(err),
    };
    broadcastUpdate();
  });

  // First check ~5 s after startup, then every 6 h.
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

ipcMain.handle('update:state', () => updateState);

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    updateState = { ...updateState, status: 'idle' };
    return updateState;
  }
  try { await autoUpdater.checkForUpdates(); } catch (err) {
    updateState = { ...updateState, status: 'error', error: err?.message || String(err) };
    broadcastUpdate();
  }
  return updateState;
});

ipcMain.handle('update:install', () => {
  if (updateState.status !== 'ready' || !UPDATE_CAN_AUTO_INSTALL) return false;
  // quitAndInstall(isSilent, isForceRunAfter)
  autoUpdater.quitAndInstall(false, true);
  return true;
});

ipcMain.handle('update:open-release', () => {
  shell.openExternal(updateState.releaseUrl
    || 'https://github.com/sanyarezko-art/bratan-tracker/releases/latest');
  return true;
});
