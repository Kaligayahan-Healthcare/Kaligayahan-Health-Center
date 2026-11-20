"""Encryption helpers.

* Personal details (names, mobile numbers, emails, addresses, ticket codes, message texts) are
  encrypted with AES-256-GCM before they are written to the database. Each value is bound to its
  table and row, so an encrypted value copied into another row will not open.
* Exact-match lookups (for example "is this mobile number already in line today?") use a keyed
  HMAC "blind index", so the database never holds the plain number.
* Backup files are compressed and then encrypted with their own key.
All keys are derived from the single master key in secrets.json.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def derive(master_b64: str, label: str) -> bytes:
    master = base64.b64decode(master_b64)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"bkhc:" + label.encode()).derive(master)


class Keys:
    def __init__(self, master_b64: str):
        self.field = derive(master_b64, "field-v1")
        self.index = derive(master_b64, "index-v1")
        self.backup = derive(master_b64, "backup-v1")


VERSION = b"\x01"


def seal(key: bytes, data: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return VERSION + nonce + AESGCM(key).encrypt(nonce, data, aad)


def unseal(key: bytes, blob: bytes, aad: bytes) -> bytes:
    if not blob or blob[:1] != VERSION:
        raise ValueError("unknown encrypted format")
    return AESGCM(key).decrypt(blob[1:13], blob[13:], aad)


def seal_json(key: bytes, obj, aad: str) -> bytes:
    return seal(key, json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode(), aad.encode())


def unseal_json(key: bytes, blob: bytes, aad: str):
    return json.loads(unseal(key, blob, aad.encode()))


def blind(key: bytes, kind: str, value: str | None) -> str | None:
    """Keyed fingerprint for exact-match search. Empty values give None."""
    v = (value or "").strip().lower()
    if not v:
        return None
    return hmac.new(key, f"{kind}:{v}".encode(), hashlib.sha256).hexdigest()


BACKUP_MAGIC = b"BKHCBAK1"


def encrypt_backup(key: bytes, raw: bytes, label: str) -> bytes:
    header = BACKUP_MAGIC + len(label).to_bytes(2, "big") + label.encode()
    return header + seal(key, gzip.compress(raw, 6), header)


def decrypt_backup(key: bytes, blob: bytes) -> tuple[bytes, str]:
    if not blob.startswith(BACKUP_MAGIC):
        raise ValueError("This is not a health center backup file.")
    n = int.from_bytes(blob[8:10], "big")
    header = blob[: 10 + n]
    return gzip.decompress(unseal(key, blob[10 + n:], header)), header[10:].decode()
