# bratan-relay

Tiny signaling server for БРАТАН desktop clients. **No file data passes through
this server** — it only routes short JSON envelopes between authenticated peers
so a client can push "here's a new раздача" notifications to its contacts.

- Auth: ed25519 challenge. Client proves ownership of its БРАТАН-ID (52-char
  base32 public key) by signing a server-issued nonce.
- Routing: when A sends `{"t":"send","to":<id-of-B>,"env":...}`, server forwards
  as `{"t":"msg","from":<id-of-A>,"env":...}` to B's active socket. If B is
  offline, the message is dropped (A's client re-broadcasts on next start).
- Presence: `{"t":"presence","ids":[...]}` → server replies with the subset that
  is currently connected.

No database, no file store, no file proxy. Restart = state gone.

Run locally:

```
uv sync
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```
