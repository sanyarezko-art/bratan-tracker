// Address book. A flat JSON file under userData/contacts.json.
//
// Record shape:
//   { id: string (БРАТАН-ID), nickname: string, addedAt: ISOString }

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const identity = require('./identity');

function contactsFile(userDataDir) {
  return path.join(userDataDir, 'contacts.json');
}

function load(userDataDir) {
  try {
    const raw = fs.readFileSync(contactsFile(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.contacts)) {
      return data.contacts.filter((c) => c && typeof c.id === 'string');
    }
  } catch { /* first run or corrupt → start empty */ }
  return [];
}

function save(userDataDir, contacts) {
  const dir = userDataDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  fs.writeFileSync(
    contactsFile(dir),
    JSON.stringify({ version: 1, contacts }, null, 2),
    { mode: 0o600 },
  );
}

function normalizeId(id) {
  return String(id || '').toLowerCase().replace(/[^a-z2-7]/g, '');
}

function add(userDataDir, rec) {
  const id = normalizeId(rec?.id);
  if (!identity.isValidPublicId(id)) {
    throw new Error('Некорректный БРАТАН-ID');
  }
  const nickname = String(rec?.nickname || '').trim().slice(0, 80);
  const all = load(userDataDir);
  const idx = all.findIndex((c) => c.id === id);
  const now = new Date().toISOString();
  if (idx >= 0) {
    all[idx] = { ...all[idx], id, nickname: nickname || all[idx].nickname || '' };
  } else {
    all.push({ id, nickname, addedAt: now });
  }
  save(userDataDir, all);
  return all;
}

function remove(userDataDir, id) {
  const clean = normalizeId(id);
  const all = load(userDataDir).filter((c) => c.id !== clean);
  save(userDataDir, all);
  return all;
}

function lookup(userDataDir, id) {
  const clean = normalizeId(id);
  return load(userDataDir).find((c) => c.id === clean) || null;
}

module.exports = { load, add, remove, lookup };
