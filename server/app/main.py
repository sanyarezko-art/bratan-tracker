"""
БРАТАН relay — signaling-only WebSocket hub.

Flow:
  1. Client opens WS /ws.
  2. Server sends {"t": "challenge", "nonce": "<hex>"}.
  3. Client replies {"t": "hello", "id": "<52-char base32 pubkey>",
                     "sig": "<base64 ed25519 sig over nonce>"}.
  4. Server verifies the signature and responds {"t": "welcome"}.
  5. Authenticated clients can then:
        {"t": "send",    "to": "<id>", "env": {...opaque}}
        {"t": "presence","ids": ["<id>", ...]}
        {"t": "ping"}
     and receive:
        {"t": "msg",     "from": "<id>", "env": {...opaque}}
        {"t": "presence","online": ["<id>", ...]}
        {"t": "pong"}
        {"t": "error",   "code": "...", "message": "..."}

No file content ever flows through this server. The `env` is opaque to the
relay — it's a typed envelope the clients agree on (offer, revoke, etc.).
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from collections import defaultdict
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse

from .auth import verify_signature

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
log = logging.getLogger("bratan-relay")

# Realm string the client signs together with the nonce, so a signature issued
# for this relay cannot be replayed against some future verb.
AUTH_REALM = "bratan-relay-v1"

# Hard caps to prevent a misbehaving client from blowing up the relay.
MAX_MESSAGE_BYTES = 64 * 1024
MAX_ENV_BYTES = 32 * 1024
MAX_PRESENCE_IDS = 256
MAX_SOCKETS_PER_ID = 4

app = FastAPI(title="bratan-relay", version="0.4.0")

# id -> set of live sockets. Multiple clients per ID are tolerated (same user on
# several devices), but capped at MAX_SOCKETS_PER_ID to avoid abuse.
_sockets: dict[str, set[WebSocket]] = defaultdict(set)
_lock = asyncio.Lock()


@app.get("/")
async def root() -> PlainTextResponse:
    return PlainTextResponse("bratan-relay ok\n")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"ok": True, "connected": _connected_count()})


def _connected_count() -> int:
    return sum(len(s) for s in _sockets.values())


async def _register(public_id: str, ws: WebSocket) -> bool:
    async with _lock:
        bucket = _sockets[public_id]
        if len(bucket) >= MAX_SOCKETS_PER_ID:
            return False
        bucket.add(ws)
        return True


async def _unregister(public_id: str, ws: WebSocket) -> None:
    async with _lock:
        bucket = _sockets.get(public_id)
        if not bucket:
            return
        bucket.discard(ws)
        if not bucket:
            _sockets.pop(public_id, None)


async def _deliver(to_id: str, payload: dict[str, Any]) -> int:
    async with _lock:
        targets = list(_sockets.get(to_id, ()))
    if not targets:
        return 0
    delivered = 0
    for sock in targets:
        try:
            await sock.send_json(payload)
            delivered += 1
        except Exception:
            # The send failed — the socket will be cleaned up on its own
            # disconnect. We don't want one dead socket to block the others.
            continue
    return delivered


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    nonce_hex = secrets.token_hex(16)
    await ws.send_json({"t": "challenge", "nonce": nonce_hex, "realm": AUTH_REALM})

    public_id: str | None = None
    try:
        hello_raw = await asyncio.wait_for(ws.receive_json(), timeout=15)
    except (asyncio.TimeoutError, WebSocketDisconnect, Exception) as e:
        log.info("hello_timeout_or_error: %r", e)
        try:
            await ws.close(code=4000)
        except Exception:
            pass
        return

    if not isinstance(hello_raw, dict) or hello_raw.get("t") != "hello":
        await _close(ws, 4001, "hello expected")
        return

    claimed_id = str(hello_raw.get("id") or "")
    sig_b64 = str(hello_raw.get("sig") or "")
    message = f"{AUTH_REALM}|{nonce_hex}".encode()

    if not verify_signature(claimed_id, message, sig_b64):
        await _close(ws, 4002, "bad signature")
        return

    if not await _register(claimed_id, ws):
        await _close(ws, 4003, "too many sockets for this id")
        return

    public_id = claimed_id
    log.info("client connected id=%s total=%d", public_id, _connected_count())
    await ws.send_json({"t": "welcome", "id": public_id})

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_MESSAGE_BYTES:
                await _send_error(ws, "too_big", f"message exceeds {MAX_MESSAGE_BYTES} bytes")
                continue
            try:
                msg = _parse_json(raw)
            except ValueError:
                await _send_error(ws, "bad_json", "not valid JSON")
                continue

            kind = msg.get("t") if isinstance(msg, dict) else None
            if kind == "send":
                await _handle_send(public_id, msg)
            elif kind == "presence":
                await _handle_presence(ws, msg)
            elif kind == "ping":
                await ws.send_json({"t": "pong"})
            else:
                await _send_error(ws, "bad_type", f"unknown t={kind!r}")
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("ws loop error id=%s err=%r", public_id, exc)
    finally:
        if public_id:
            await _unregister(public_id, ws)
            log.info("client disconnected id=%s total=%d", public_id, _connected_count())


async def _handle_send(sender_id: str, msg: dict[str, Any]) -> None:
    to_id = str(msg.get("to") or "")
    env = msg.get("env")
    if not to_id or not isinstance(env, dict):
        return
    # Rough ceiling on env size so one client can't flood memory.
    import json as _json  # local import, only hit on send path

    try:
        env_len = len(_json.dumps(env))
    except Exception:
        return
    if env_len > MAX_ENV_BYTES:
        return
    await _deliver(to_id, {"t": "msg", "from": sender_id, "env": env})


async def _handle_presence(ws: WebSocket, msg: dict[str, Any]) -> None:
    ids = msg.get("ids")
    if not isinstance(ids, list):
        return
    ids = [str(x) for x in ids[:MAX_PRESENCE_IDS] if isinstance(x, str)]
    async with _lock:
        online = [pid for pid in ids if _sockets.get(pid)]
    await ws.send_json({"t": "presence", "online": online})


def _parse_json(raw: str) -> Any:
    import json as _json

    try:
        return _json.loads(raw)
    except _json.JSONDecodeError as e:
        raise ValueError(str(e)) from e


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    try:
        await ws.send_json({"t": "error", "code": code, "message": message})
    except Exception:
        pass


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    try:
        await ws.send_json({"t": "error", "code": "handshake", "message": reason})
    except Exception:
        pass
    try:
        await ws.close(code=code)
    except Exception:
        pass
