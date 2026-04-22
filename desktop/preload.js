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
  addMagnet: (magnet) => ipcRenderer.invoke('torrent:add-magnet', magnet),
  removeTorrent: (infoHash) => ipcRenderer.invoke('torrent:remove', infoHash),
  pauseTorrent: (infoHash) => ipcRenderer.invoke('torrent:pause', infoHash),
  resumeTorrent: (infoHash) => ipcRenderer.invoke('torrent:resume', infoHash),

  pickFiles: () => ipcRenderer.invoke('pick-files'),
  openDownloadDir: () => ipcRenderer.invoke('open-download-dir'),
  revealFile: (absPath) => ipcRenderer.invoke('reveal-file', absPath),

  onTorrentUpdate: (handler) => subscribe('torrent:update', handler),
  onTorrentError: (handler) => subscribe('torrent:error', handler),
  onDeepLinkMagnet: (handler) => subscribe('deep-link-magnet', handler),
});
