"""
ed25519 auth for БРАТАН relay.

A client's БРАТАН-ID is the lowercase RFC-4648 base32 encoding of the raw 32-byte
ed25519 public key. To prove ownership, the client signs the server-issued nonce
verbatim. That's it — no session tokens, no refresh, no cookies.
"""

from __future__ import annotations

import base64

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

_B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
_B32_LOOKUP = {c: i for i, c in enumerate(_B32_ALPHABET)}


def decode_public_id(public_id: str) -> bytes:
    """Decode a БРАТАН-ID (lowercase base32, no padding) into its 32 raw bytes."""
    clean = "".join(c for c in str(public_id or "").lower() if c in _B32_LOOKUP)
    out = bytearray()
    bits = 0
    value = 0
    for ch in clean:
        value = (value << 5) | _B32_LOOKUP[ch]
        bits += 5
        if bits >= 8:
            out.append((value >> (bits - 8)) & 0xFF)
            bits -= 8
    if len(out) != 32:
        raise ValueError(f"expected 32-byte public key, got {len(out)}")
    return bytes(out)


def verify_signature(public_id: str, message: bytes, signature_b64: str) -> bool:
    """Return True iff `signature_b64` is a valid ed25519 signature over `message`."""
    try:
        raw_pub = decode_public_id(public_id)
        sig = base64.b64decode(signature_b64, validate=False)
    except Exception:
        return False
    try:
        VerifyKey(raw_pub).verify(message, sig)
        return True
    except (BadSignatureError, ValueError):
        return False
