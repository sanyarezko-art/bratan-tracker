// Preload: the only bridge between the sandboxed renderer and Node/Electron.
// Exposes a narrow, typed-feeling API on window.bratan.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Forward specific main→renderer events via callback subscription.
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('bratan', {
  version: () => ipcRenderer.invoke('app:version'),
  paths: () => ipcRenderer.invoke('app:paths'),

  listTorrents: () => ipcRenderer.invoke('torrent:list'),
  seedPaths: (paths) => ipcRenderer.invoke('torrent:seed-paths', paths),
  addLink: (link) => ipcRenderer.invoke('torrent:add-link', link),
  removeTorrent: (infoHash) => ipcRenderer.invoke('torrent:remove', infoHash),
  pauseTorrent: (infoHash) => ipcRenderer.invoke('torrent:pause', infoHash),
  resumeTorrent: (infoHash) => ipcRenderer.invoke('torrent:resume', infoHash),

  pickFiles: () => ipcRenderer.invoke('pick-files'),
  openDownloadDir: () => ipcRenderer.invoke('open-download-dir'),
  revealFile: (absPath) => ipcRenderer.invoke('reveal-file', absPath),

  me: () => ipcRenderer.invoke('identity:me'),
  listContacts: () => ipcRenderer.invoke('contacts:list'),
  addContact: (rec) => ipcRenderer.invoke('contacts:add', rec),
  removeContact: (id) => ipcRenderer.invoke('contacts:remove', id),
  decodeLink: (link) => ipcRenderer.invoke('share:decode', link),

  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleasePage: () => ipcRenderer.invoke('update:open-release'),

  onTorrentUpdate: (handler) => subscribe('torrent:update', handler),
  onTorrentError: (handler) => subscribe('torrent:error', handler),
  onDeepLink: (handler) => subscribe('deep-link', handler),
  onUpdateState: (handler) => subscribe('update:state', handler),
});
