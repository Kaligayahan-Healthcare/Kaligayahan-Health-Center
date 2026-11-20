"""Protection against automated (bot) bookings, requests and sign-ups.

1. Built-in challenge (always on, no account needed): before a form is accepted, the visitor's
   browser must solve a small puzzle the server hands out (find a number that makes a SHA-256
   hash start with zeros). It takes a person's phone well under a second, but makes sending
   hundreds of fake bookings slow and costly. Each puzzle is signed by the server, works once,
   and expires after 10 minutes.
2. Cloudflare Turnstile (optional, free): the "I am not a robot" check. It switches on when the
   "turnstile" site key and secret are filled in config.json.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import urllib.parse
import urllib.request

from . import crypto
from .config import CONFIG, SECRETS

KEY = crypto.derive(SECRETS["master_key"], "challenge-v1")
TTL = 600
_used: dict[str, float] = {}
_lock = threading.Lock()


def bits() -> int:
    b = int(CONFIG.get("challenge_bits") or 16)
    return max(4, min(24, b - b % 4))                # whole hex digits


def new_challenge() -> dict:
    body = base64.urlsafe_b64encode(json.dumps({"n": secrets.token_hex(8), "t": int(time.time()), "b": bits()}).encode()).decode().rstrip("=")
    sig = hmac.new(KEY, body.encode(), hashlib.sha256).hexdigest()[:32]
    return {"token": f"{body}.{sig}", "bits": bits()}


def check_solution(pow_value: str) -> bool:
    """`pow_value` is "<token>:<answer>". True only once per token, within 10 minutes."""
    if not isinstance(pow_value, str) or len(pow_value) > 300 or ":" not in pow_value:
        return False
    token, answer = pow_value.rsplit(":", 1)
    if "." not in token or not answer.isdigit() or len(answer) > 12:
        return False
    body, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(hmac.new(KEY, body.encode(), hashlib.sha256).hexdigest()[:32], sig):
        return False
    try:
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except ValueError:
        return False
    if time.time() - int(data.get("t", 0)) > TTL:
        return False
    zeros = int(data.get("b", 16)) // 4
    if not hashlib.sha256(pow_value.encode()).hexdigest().startswith("0" * zeros):
        return False
    with _lock:
        now = time.time()
        for k in [k for k, v in _used.items() if now - v > TTL]:
            del _used[k]
        if token in _used:
            return False                              # each puzzle works once
        _used[token] = now
    return True


# ---------- Cloudflare Turnstile (optional) ----------
def turnstile_site_key() -> str:
    t = CONFIG.get("turnstile") or {}
    return t.get("site_key", "") if isinstance(t, dict) and (SECRETS.get("turnstile_secret") or t.get("secret")) else ""


def check_turnstile(token: str, ip: str) -> bool:
    t = CONFIG.get("turnstile") or {}
    secret = SECRETS.get("turnstile_secret") or (t.get("secret") if isinstance(t, dict) else "")
    if not secret:
        return True
    if not token or len(token) > 2048:
        return False
    data = urllib.parse.urlencode({"secret": secret, "response": token, "remoteip": ip}).encode()
    try:
        req = urllib.request.Request("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=data, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            return bool(json.loads(r.read()).get("success"))
    except Exception:
        return False                                   # cannot check: refuse rather than let bots through


TESTING = bool(os.environ.get("BKHC_TESTING"))
