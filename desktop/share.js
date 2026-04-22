// Signed share-link format.
//
//   bratan://share/v1/<base64url of JSON {v,m,s,g}>
//
// where:
//   v — format version (1)
//   m — magnet URI (the actual payload)
//   s — sender's БРАТАН-ID (base32 ed25519 public key)
//   g — base64 of ed25519 signature over UTF-8 bytes of `m`
//
// Plain magnet URIs also work — they're treated as "anonymous" shares.

'use strict';

const identity = require('./identity');

const SHARE_SCHEME_PREFIX = 'bratan://share/v1/';

function encode(identityData, magnet) {
  if (typeof magnet !== 'string' || !magnet.startsWith('magnet:')) {
    throw new Error('need a magnet URI');
  }
  const sig = identity.sign(identityData, magnet);
  const payload = {
    v: 1,
    m: magnet,
    s: identity.publicId(identityData),
    g: sig.toString('base64'),
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return SHARE_SCHEME_PREFIX + b64;
}

/** Returns { kind: 'magnet', magnet } or
 *  { kind: 'share', magnet, sender, valid } or null. */
function decode(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;

  if (s.startsWith('magnet:')) {
    return { kind: 'magnet', magnet: s };
  }
  if (!s.startsWith(SHARE_SCHEME_PREFIX)) return null;

  const b64 = s.slice(SHARE_SCHEME_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(b64)) return null;

  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    if (payload.v !== 1) return null;
    if (typeof payload.m !== 'string' || !payload.m.startsWith('magnet:')) return null;
    if (typeof payload.s !== 'string' || !identity.isValidPublicId(payload.s)) return null;
    if (typeof payload.g !== 'string') return null;
    const sig = Buffer.from(payload.g, 'base64');
    const valid = identity.verify(payload.s, payload.m, sig);
    return { kind: 'share', magnet: payload.m, sender: payload.s, valid };
  } catch {
    return null;
  }
}

module.exports = { encode, decode, SHARE_SCHEME_PREFIX };
