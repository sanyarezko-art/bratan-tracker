// BRATAN bridge — classical BitTorrent <-> browser WebRTC.
//
// What this process does:
//   1. Runs `webtorrent-hybrid`, which speaks BOTH classical TCP/UDP/DHT
//      (like qBittorrent / Transmission) and WebRTC/WSS (like browsers).
//      That makes it a dual-stack peer: it can fetch pieces from classical
//      seeders AND re-offer those pieces to browser peers over WebRTC.
//
//   2. Runs a WSS `bittorrent-tracker` server so browsers have a discovery
//      point that always knows about the bridge peer, even if public WSS
//      trackers are flaky.
//
//   3. Exposes a minimal HTTP API:
//        GET  /health            -> { ok: true, peers, torrents }
//        GET  /api/torrents      -> current torrents the bridge is joined to
//        POST /api/torrents      -> { magnet } — ask the bridge to join a swarm
//
// What this process does NOT do:
//   - No request logging, no auth tokens, no cookies. Persistence is purely
//     in-RAM; kill the VM and state is gone (by design).
//   - No per-user accounting. Any visitor who opens the same magnet gets the
//     same cached pieces for free.
//   - No storage of torrent data beyond the running process's lifetime
//     (uses the default in-memory chunk store).

import http from 'node:http';
import { Server as TrackerServer } from 'bittorrent-tracker';
import WebTorrent from 'webtorrent';
import wrtc from '@roamhq/wrtc';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Allowlist of origins that may call the HTTP API / connect to the WSS tracker.
// Kept permissive on purpose — this bridge only serves public magnets and must
// be reachable from any fork of the static frontend. If you want to lock it
// down, set BRATAN_ALLOWED_ORIGINS to a comma-separated list.
const ALLOWED_ORIGINS = (process.env.BRATAN_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Cap concurrent torrents — Fly free tier is 256 MB / 1 shared vCPU, keep it
// honest. The earliest-idle torrent gets evicted once we hit the cap.
const MAX_TORRENTS = Number(process.env.BRATAN_MAX_TORRENTS) || 6;

// ---------- HTTP server (shared by tracker + API) ----------
const server = http.createServer();

server.on('request', (req, res) => {
  // CORS: the static frontend lives on github.io, the bridge on fly.dev —
  // cross-origin by definition.
  const origin = req.headers.origin || '*';
  const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  if (ok) {
    res.setHeader('access-control-allow-origin', origin === '*' ? '*' : origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return handleHealth(res);
  if (req.method === 'GET' && url.pathname === '/api/torrents') return handleListTorrents(res);
  if (req.method === 'POST' && url.pathname === '/api/torrents') return handleAddTorrent(req, res);

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

// ---------- WebTorrent with both TCP/UDP/DHT and WebRTC ----------
// @roamhq/wrtc gives us a WebRTC stack in Node, so the bridge can offer
// pieces it fetched from classical peers back to browser peers over
// WebRTC. Without this, the bridge would be TCP-only and browsers could
// not read from it.
const wt = new WebTorrent({
  dht: true,
  maxConns: 100,
  tracker: { wrtc },
});
wt.on('error', (err) => console.warn('[wt] error:', err?.message || err));

function torrentSummary(t) {
  return {
    infoHash: t.infoHash,
    name: t.name || null,
    progress: t.progress || 0,
    numPeers: t.numPeers || 0,
    downloadSpeed: t.downloadSpeed || 0,
    uploadSpeed: t.uploadSpeed || 0,
    length: t.length || 0,
    downloaded: t.downloaded || 0,
    uploaded: t.uploaded || 0,
    done: Boolean(t.done),
    // lastActivity lets us evict the oldest-idle torrent when we hit MAX_TORRENTS.
    lastActivity: t._bratanLastActivity || 0,
  };
}
function touchActivity(t) { t._bratanLastActivity = Date.now(); }

function evictIfNeeded() {
  if (wt.torrents.length <= MAX_TORRENTS) return;
  const oldest = [...wt.torrents].sort((a, b) =>
    (a._bratanLastActivity || 0) - (b._bratanLastActivity || 0)
  )[0];
  if (oldest) {
    console.log('[bridge] evicting', oldest.infoHash, oldest.name || '');
    oldest.destroy();
  }
}

function readJsonBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function handleHealth(res) {
  const peers = wt.torrents.reduce((n, t) => n + (t.numPeers || 0), 0);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    ok: true,
    uptime: Math.floor(process.uptime()),
    torrents: wt.torrents.length,
    peers,
    maxTorrents: MAX_TORRENTS,
  }));
}

function handleListTorrents(res) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ torrents: wt.torrents.map(torrentSummary) }));
}

async function handleAddTorrent(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_body', detail: String(e?.message || e) }));
    return;
  }
  const magnet = typeof body?.magnet === 'string' ? body.magnet.trim() : '';
  if (!magnet.startsWith('magnet:')) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected_magnet' }));
    return;
  }
  // If we already have it, surface the current state.
  const existing = wt.torrents.find((t) => magnet.includes(t.infoHash));
  if (existing) {
    touchActivity(existing);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ existing: true, torrent: torrentSummary(existing) }));
    return;
  }
  // Hand the magnet to the hybrid client. It will join DHT, reach out to
  // classical peers via TCP/UDP, and simultaneously announce itself on our
  // WSS tracker so browser peers find it.
  try {
    const t = wt.add(magnet, { announce: [`ws://${req.headers.host}`] });
    touchActivity(t);
    t.on('warning', (w) => console.warn('[wt] warn:', w?.message || w));
    t.on('error',   (e) => console.warn('[wt] err :', e?.message || e));
    t.on('wire',    () => touchActivity(t));
    t.on('download',() => touchActivity(t));
    evictIfNeeded();
    // Respond immediately — don't wait for metadata, the client polls /api/torrents.
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, infoHash: t.infoHash }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'add_failed', detail: String(e?.message || e) }));
  }
}

// ---------- WSS tracker mounted on the same HTTP server ----------
const tracker = new TrackerServer({
  udp: false,
  http: false,
  ws: true,
  stats: false,
  filter: (infoHash, params, cb) => {
    // Only allow info-hashes the bridge itself has joined. Keeps the tracker
    // scoped to our bridge's swarm and prevents it from being used as a
    // generic public tracker for unrelated torrents.
    const known = wt.torrents.some((t) => t.infoHash === infoHash);
    if (known) return cb(null);
    cb(new Error('infoHash not known to bridge'));
  },
});
tracker.on('error', (err) => console.warn('[tracker] error:', err?.message || err));
tracker.on('warning', (err) => console.warn('[tracker] warn:', err?.message || err));

// bittorrent-tracker's Server exposes `.onWebSocketConnection(socket)` as its
// public API for externally-managed WS sockets. We mount a single
// `WebSocketServer` on our shared `http.Server` and forward every incoming
// socket into the tracker — this keeps the tracker + HTTP API on one port,
// which matches Fly.io's single-internal-port expectation.
const wss = new WebSocketServer({ server, path: '/' });
wss.on('connection', (socket, req) => {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.includes('*') && origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.close(1008, 'origin not allowed');
    return;
  }
  tracker.onWebSocketConnection(socket);
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] wss tracker at ws://${HOST}:${PORT}/`);
  console.log(`[bridge] max torrents: ${MAX_TORRENTS}`);
});

// Graceful shutdown — Fly sends SIGTERM on deploys.
function shutdown(signal) {
  console.log(`[bridge] ${signal} received, shutting down`);
  try { tracker.close(); } catch {}
  try { wt.destroy(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
