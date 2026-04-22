// БРАТАН — relay signaling client.
//
// Opens a single WebSocket to our tiny FastAPI relay (see ../server/). The
// relay only routes short JSON envelopes — file bytes are NEVER sent over
// this channel, and the relay can't even read the envelope fields that we
// consider sensitive (everything except the sender/recipient pair).
//
// Auth: server sends a random nonce, we sign it with our ed25519 private
// key and send the 52-char БРАТАН-ID + signature. No sessions, no tokens.
//
// Auto-reconnect with exponential backoff so a brief network blip doesn't
// take presence offline for the whole session. Every time we reconnect
// successfully we also re-announce our active seeds to the same contact
// list — this is how "my friend's app restarted; he still sees my files"
// works.

'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

// The default URL is baked in at build time — users who want to run a
// private relay can set the BRATAN_RELAY_URL environment variable.
const DEFAULT_RELAY_URL = 'wss://bratan-relay-ygaxcdvd.fly.dev/ws';
const AUTH_REALM = 'bratan-relay-v1';

// Backoff: 1s, 2s, 4s, 8s, 16s, max 60s. Resets on every successful connect.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

// Keep-alive ping every 25s so Fly.io's idle proxy doesn't cut the socket.
const PING_INTERVAL_MS = 25_000;

class RelayClient extends EventEmitter {
  constructor({ url, identityData, sign, myId }) {
    super();
    this.url = url || process.env.BRATAN_RELAY_URL || DEFAULT_RELAY_URL;
    this.identityData = identityData;
    this.sign = sign;         // (identityData, messageString) -> Buffer
    this.myId = myId;
    this.ws = null;
    this.state = 'disconnected';  // 'disconnected' | 'connecting' | 'connected' | 'closed'
    this.backoff = BACKOFF_MIN_MS;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.closedByUser = false;
  }

  start() {
    this.closedByUser = false;
    this._connect();
  }

  stop() {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'bye'); } catch { /* ignore */ }
    }
    this._setState('closed');
  }

  isConnected() { return this.state === 'connected'; }

  /** Send a signed offer envelope to a specific contact id. Returns false if
   *  the socket is not (yet) authenticated. */
  send(toId, env) {
    if (!this.isConnected()) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'send', to: toId, env }));
      return true;
    } catch (err) {
      console.warn('[relay] send failed:', err?.message || err);
      return false;
    }
  }

  /** Ask the relay which of `ids` are currently connected. */
  queryPresence(ids) {
    if (!this.isConnected() || !Array.isArray(ids)) return false;
    try {
      this.ws.send(JSON.stringify({ t: 'presence', ids: ids.slice(0, 256) }));
      return true;
    } catch { return false; }
  }

  // ---- internal ---------------------------------------------------------

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  _scheduleReconnect() {
    if (this.closedByUser) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _connect() {
    if (this.closedByUser) return;
    this._setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
    } catch (err) {
      console.warn('[relay] connect sync throw:', err?.message || err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    let authed = false;

    ws.on('open', () => {
      // Server will send a challenge immediately; we reply in 'message'.
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      const kind = msg && msg.t;

      if (kind === 'challenge' && !authed) {
        const realm = typeof msg.realm === 'string' ? msg.realm : AUTH_REALM;
        const nonce = String(msg.nonce || '');
        if (!nonce) { try { ws.close(); } catch { /* */ } return; }
        let sig;
        try {
          sig = this.sign(this.identityData, `${realm}|${nonce}`);
        } catch (err) {
          console.warn('[relay] sign failed:', err?.message || err);
          try { ws.close(); } catch { /* */ }
          return;
        }
        ws.send(JSON.stringify({ t: 'hello', id: this.myId, sig: sig.toString('base64') }));
        return;
      }

      if (kind === 'welcome') {
        authed = true;
        this.backoff = BACKOFF_MIN_MS;
        this._setState('connected');
        this._startPing();
        this.emit('authenticated');
        return;
      }

      if (kind === 'msg') {
        this.emit('msg', { from: String(msg.from || ''), env: msg.env || null });
        return;
      }

      if (kind === 'presence') {
        this.emit('presence', Array.isArray(msg.online) ? msg.online : []);
        return;
      }

      if (kind === 'error') {
        console.warn('[relay] server error:', msg.code, msg.message);
        this.emit('error', new Error(`${msg.code}: ${msg.message}`));
      }
    });

    const cleanup = () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.ws === ws) this.ws = null;
      this._setState(this.closedByUser ? 'closed' : 'disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
      console.warn('[relay] socket error:', err?.message || err);
      // 'close' fires right after 'error', so don't double-schedule here.
    });
  }

  _startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.isConnected() || !this.ws) return;
      try { this.ws.send(JSON.stringify({ t: 'ping' })); } catch { /* ignore */ }
    }, PING_INTERVAL_MS);
  }
}

module.exports = { RelayClient, DEFAULT_RELAY_URL };
