// БРАТАН — long-lived ed25519 identity.
//
// One keypair per install. Public key is the user's "БРАТАН-ID" (base32,
// 52 chars). The private key signs share links so recipients can verify the
// magnet actually came from the person they think it came from.
//
// Stored in app.getPath('userData')/identity.json. Never sent anywhere;
// never copied into render process.

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// RFC 4648 lowercase base32, no padding — friendlier to read/paste.
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const B32_LOOKUP = (() => {
  const m = Object.create(null);
  for (let i = 0; i < B32_ALPHABET.length; i++) m[B32_ALPHABET[i]] = i;
  return m;
})();

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toLowerCase().replace(/[^a-z2-7]/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32_LOOKUP[ch];
    if (v === undefined) continue;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// SPKI DER prefix for an Ed25519 public key; the 32 raw bytes follow it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKeyFromDerB64(derB64) {
  const der = Buffer.from(derB64, 'base64');
  return der.subarray(der.length - 32);
}

function derFromRawPublicKey(raw) {
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

function identityFile(userDataDir) {
  return path.join(userDataDir, 'identity.json');
}

function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    version: 1,
    publicKeyDerB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPkcs8B64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

function loadOrCreate(userDataDir) {
  const file = identityFile(userDataDir);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data
        && typeof data.publicKeyDerB64 === 'string'
        && typeof data.privateKeyPkcs8B64 === 'string') {
      return data;
    }
  } catch { /* regenerate on missing / corrupt */ }

  const fresh = generate();
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* */ }
  fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  return fresh;
}

function publicId(data) {
  return base32Encode(rawPublicKeyFromDerB64(data.publicKeyDerB64));
}

function isValidPublicId(id) {
  if (typeof id !== 'string') return false;
  const clean = id.toLowerCase().replace(/[^a-z2-7]/g, '');
  if (clean.length !== 52) return false;
  try {
    const raw = base32Decode(clean);
    return raw.length === 32;
  } catch { return false; }
}

function sign(data, message) {
  const priv = crypto.createPrivateKey({
    key: Buffer.from(data.privateKeyPkcs8B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
  return crypto.sign(null, msg, priv);
}

function verify(publicIdStr, message, signature) {
  try {
    const raw = base32Decode(publicIdStr);
    if (raw.length !== 32) return false;
    const pub = crypto.createPublicKey({
      key: derFromRawPublicKey(raw),
      format: 'der',
      type: 'spki',
    });
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
    const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
    return crypto.verify(null, msg, pub, sig);
  } catch { return false; }
}

module.exports = {
  loadOrCreate,
  publicId,
  isValidPublicId,
  sign,
  verify,
  base32Encode,
  base32Decode,
};
