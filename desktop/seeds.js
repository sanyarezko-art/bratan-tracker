// Persistence for active seeds.
//
// We save a tiny record for each torrent the user is currently seeding so
// that when the app quits & restarts the raздача resumes automatically.
// Without this, "close the app = stop seeding" means the friend across the
// internet never completes their download.
//
// Record shape:
//   { infoHash, magnetURI, name, length, savedAt }
//
// The actual file data is NOT stored here — only the magnet, which is just
// the 40-char info hash + file list metadata. On resume, WebTorrent
// re-hashes the user's local copy and re-seeds it.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

function seedsFile(userDataDir) {
  return path.join(userDataDir, 'seeds.json');
}

function load(userDataDir) {
  try {
    const raw = fs.readFileSync(seedsFile(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.seeds)) {
      return data.seeds.filter((s) => s && typeof s.infoHash === 'string' && typeof s.magnetURI === 'string');
    }
  } catch { /* first run or corrupt → empty */ }
  return [];
}

function save(userDataDir, seeds) {
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* */ }
  fs.writeFileSync(
    seedsFile(userDataDir),
    JSON.stringify({ version: 1, seeds }, null, 2),
    { mode: 0o600 },
  );
}

function upsert(userDataDir, record) {
  const hash = String(record?.infoHash || '').toLowerCase();
  if (!hash) return load(userDataDir);
  const all = load(userDataDir);
  const idx = all.findIndex((s) => s.infoHash === hash);
  const entry = {
    infoHash: hash,
    magnetURI: String(record.magnetURI || ''),
    name: String(record.name || ''),
    length: Number.isFinite(record.length) ? record.length : 0,
    filePaths: Array.isArray(record.filePaths) ? record.filePaths.slice(0, 64) : [],
    savedAt: new Date().toISOString(),
  };
  if (idx >= 0) all[idx] = { ...all[idx], ...entry };
  else all.push(entry);
  save(userDataDir, all);
  return all;
}

function remove(userDataDir, infoHash) {
  const hash = String(infoHash || '').toLowerCase();
  const all = load(userDataDir).filter((s) => s.infoHash !== hash);
  save(userDataDir, all);
  return all;
}

module.exports = { load, save, upsert, remove };
