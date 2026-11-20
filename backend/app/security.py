"""Staff accounts, sessions, login lockout, rate limits and the audit log.

* Passwords: Argon2id (memory-hard, the current recommended password hash). Plain passwords
  are never stored or logged.
* Sessions: a random 256-bit token in an HttpOnly, SameSite=Strict cookie. Only a SHA-256 of
  the token is stored, so a copied database cannot be used to log in. Sessions end after
  inactivity and after a maximum age, and on logout or password change.
* CSRF: every change made by staff must carry the per-session CSRF token in a header.
* Lockout: repeated wrong passwords lock the account and the address for a growing time.
* Audit log: every staff action and login is written to an append-only log in which each entry
  includes the hash of the previous one, so a deleted or edited entry is detectable.
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import json
import secrets
import threading
import time

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from . import crypto, db
import os

from .config import CONFIG, DATA, SECRETS

TESTING = bool(os.environ.get("BKHC_TESTING"))

PH = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=2)
DUMMY_HASH = PH.hash(secrets.token_hex(16))       # used so unknown usernames take as long as real ones

ROLES = {
    "admin": {"label": "Administrator", "tabs": ["dash", "queue", "appts", "doctors", "meds", "ann", "sms", "reports", "settings", "users", "account"]},
    "bhw": {"label": "Health worker (BHW / nurse)", "tabs": ["dash", "queue", "appts", "doctors", "ann", "sms", "account"]},
    "pharmacy": {"label": "Pharmacy staff", "tabs": ["dash", "meds", "account"]},
}

COMMON = {"password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "kaligayahan",
          "kaligayahan1", "barangay123", "healthcenter", "admin1234", "letmein123", "iloveyou1", "welcome123"}


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------- passwords ----------
def password_problem(pw: str, username: str = "") -> str:
    if len(pw) < 10:
        return "Use at least 10 characters."
    if not any(c.isalpha() for c in pw) or not any(c.isdigit() for c in pw):
        return "Use both letters and numbers."
    if username and username.lower() in pw.lower():
        return "Do not put the username inside the password."
    if pw.lower() in COMMON or len(set(pw)) < 5:
        return "That password is too easy to guess. Choose another."
    return ""


def hash_pw(pw: str) -> str:
    return PH.hash(pw)


def verify_pw(stored: str | None, pw: str) -> bool:
    try:
        return PH.verify(stored or DUMMY_HASH, pw) and stored is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def temp_password() -> str:
    a, d = "abcdefghjkmnpqrstuvwxyz", "23456789"
    return "".join(secrets.choice(a) for _ in range(7)) + "".join(secrets.choice(d) for _ in range(3)) + "".join(secrets.choice(a) for _ in range(2))


# ---------- users ----------
def user_public(u) -> dict:
    return {"id": u["id"], "user": u["username"], "name": u["name"], "role": u["role"], "mustChange": bool(u["must_change"]),
            "created": u["created"], "lastLogin": u["last_login"], "disabled": bool(u["disabled"])}


def users() -> list:
    with db.LOCK:
        return [user_public(u) for u in db.conn().execute("SELECT * FROM users ORDER BY created, username").fetchall()]


def user_by_id(uid: str):
    with db.LOCK:
        return db.conn().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def user_by_name(name: str):
    with db.LOCK:
        return db.conn().execute("SELECT * FROM users WHERE username=?", (name.strip().lower(),)).fetchone()


def create_user(username: str, name: str, role: str, pw: str, must_change: bool = True) -> str:
    uid = "u" + secrets.token_hex(6)
    with db.LOCK:
        db.conn().execute("INSERT INTO users (id, username, name, role, pw_hash, must_change, created, pw_changed_at) VALUES (?,?,?,?,?,?,?,?)",
                          (uid, username.lower(), name, role, hash_pw(pw), 1 if must_change else 0, time.strftime("%Y-%m-%d"), now_ms()))
    return uid


def set_password(uid: str, pw: str, must_change: bool) -> None:
    with db.LOCK:
        db.conn().execute("UPDATE users SET pw_hash=?, must_change=?, pw_changed_at=? WHERE id=?", (hash_pw(pw), 1 if must_change else 0, now_ms(), uid))
        db.conn().execute("DELETE FROM sessions WHERE user_id=?", (uid,))     # sign out everywhere
        left = db.conn().execute("SELECT COUNT(*) FROM users WHERE must_change=1").fetchone()[0]
    first = DATA / "FIRST-LOGIN-PASSWORDS.txt"
    if not left and first.exists():                     # everyone has chosen their own password: remove the one-time list
        try:
            first.unlink()
        except OSError:
            pass


def ensure_default_users() -> list[tuple[str, str, str]]:
    """First start only: three accounts with random one-time passwords that must be changed."""
    with db.LOCK:
        if db.conn().execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            return []
    made = []
    for username, name, role in [("admin", "Administrator", "admin"), ("bhw", "Health worker", "bhw"), ("pharmacy", "Pharmacy staff", "pharmacy")]:
        pw = temp_password()
        create_user(username, name, role, pw)
        made.append((username, role, pw))
    lines = ["FIRST LOGIN - one-time passwords (each account must choose a new password at first login)", ""]
    lines += [f"  {u:<10} {pw}    ({ROLES[r]['label']})" for u, r, pw in made]
    lines += ["", "Delete this file after everyone has logged in once."]
    (DATA / "FIRST-LOGIN-PASSWORDS.txt").write_text("\n".join(lines), encoding="utf-8")
    return made


# ---------- sessions ----------
COOKIE = "bkhc_session"


def _th(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(uid: str, ip: str, agent: str) -> tuple[str, str]:
    token, csrf, t = secrets.token_urlsafe(32), secrets.token_urlsafe(24), now_ms()
    with db.LOCK:
        db.conn().execute("INSERT INTO sessions (token_hash, user_id, csrf, created, last_seen, ip, agent) VALUES (?,?,?,?,?,?,?)",
                          (_th(token), uid, csrf, t, t, ip, (agent or "")[:200]))
        db.conn().execute("UPDATE users SET last_login=? WHERE id=?", (t, uid))
        # at most 5 open sessions per account
        db.conn().execute("DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY last_seen DESC LIMIT 5)", (uid, uid))
    return token, csrf


def get_session(token: str | None, touch: bool = True):
    """Returns (user_row, session_row) or (None, None). touch=False: do not count as activity."""
    if not token or len(token) > 100:
        return None, None
    t = now_ms()
    idle, max_age = CONFIG["session_idle_minutes"] * 60000, CONFIG["session_max_hours"] * 3600000
    with db.LOCK:
        s = db.conn().execute("SELECT * FROM sessions WHERE token_hash=?", (_th(token),)).fetchone()
        if not s:
            return None, None
        if t - s["last_seen"] > idle or t - s["created"] > max_age:
            db.conn().execute("DELETE FROM sessions WHERE token_hash=?", (s["token_hash"],))
            return None, None
        u = db.conn().execute("SELECT * FROM users WHERE id=?", (s["user_id"],)).fetchone()
        if not u or u["disabled"]:
            return None, None
        if touch and t - s["last_seen"] > 20000:
            db.conn().execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (t, s["token_hash"]))
    return u, s


def end_session(token: str | None) -> None:
    if token:
        with db.LOCK:
            db.conn().execute("DELETE FROM sessions WHERE token_hash=?", (_th(token),))


def purge_sessions() -> None:
    cut = now_ms() - CONFIG["session_max_hours"] * 3600000
    with db.LOCK:
        db.conn().execute("DELETE FROM sessions WHERE created<? OR last_seen<?", (cut, now_ms() - CONFIG["session_idle_minutes"] * 60000))


def csrf_ok(session, header: str | None) -> bool:
    return bool(header) and hmac.compare_digest(session["csrf"].encode(), header.encode("utf-8", "replace"))


# ---------- login lockout ----------
def lock_left(key: str) -> int:
    with db.LOCK:
        r = db.conn().execute("SELECT locked_until FROM login_failures WHERE key=?", (key,)).fetchone()
    return max(0, (r["locked_until"] - now_ms()) // 1000) if r else 0


def record_failure(key: str) -> int:
    """Returns seconds locked. 5 tries free, then 1 min, 2, 4 ... up to 30 minutes."""
    t = now_ms()
    with db.LOCK:
        r = db.conn().execute("SELECT count, last FROM login_failures WHERE key=?", (key,)).fetchone()
        count = (r["count"] if r and t - r["last"] < 24 * 3600000 else 0) + 1
        lock = 0 if count < 5 else min(1800, 60 * 2 ** (count - 5))
        db.conn().execute("INSERT INTO login_failures (key, count, locked_until, last) VALUES (?,?,?,?) "
                          "ON CONFLICT(key) DO UPDATE SET count=excluded.count, locked_until=excluded.locked_until, last=excluded.last",
                          (key, count, t + lock * 1000, t))
    return lock


def clear_failures(key: str) -> None:
    with db.LOCK:
        db.conn().execute("DELETE FROM login_failures WHERE key=?", (key,))


# ---------- rate limits (per address) ----------
class RateLimiter:
    def __init__(self):
        self.hits: dict[tuple, collections.deque] = {}
        self.lock = threading.Lock()

    def allow(self, bucket: str, ip: str, limit: int, per_seconds: int, exact: bool = False, count: bool = True) -> bool:
        if not exact and (ip in ("127.0.0.1", "::1") or (ip == "testclient" and TESTING)):
            limit *= 10                                   # a shared kiosk / the staff PC itself
        t = time.monotonic()
        with self.lock:
            if len(self.hits) > 50000:
                self.hits.clear()
            q = self.hits.setdefault((bucket, ip), collections.deque())
            while q and t - q[0] > per_seconds:
                q.popleft()
            if len(q) >= limit:
                return False
            if count:
                q.append(t)
            return True


LIMITER = RateLimiter()


# ---------- audit log (hash-chained with a secret key, append-only) ----------
AUDIT_KEY = crypto.derive(SECRETS["master_key"], "audit-v1")


def _chain(body: str) -> str:
    # keyed: someone who edits the database file cannot recompute a valid chain without the master key
    return hmac.new(AUDIT_KEY, body.encode(), hashlib.sha256).hexdigest()


def short_ip(ip: str) -> str:
    """Residents' addresses are shortened in the log (privacy): 203.0.113.0, 2001:db8:1::"""
    import ipaddress
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip[:40]
    return str(ipaddress.ip_network(f"{a}/{24 if a.version == 4 else 48}", strict=False).network_address)
def audit(action: str, target: str = "", detail=None, actor: str = "", role: str = "", ip: str = "") -> None:
    ts = now_ms()
    if actor == "resident" or not actor:
        ip = short_ip(ip) if ip else ip
    det = detail if isinstance(detail, str) else json.dumps(detail, separators=(",", ":"), ensure_ascii=False) if detail is not None else ""
    det = det[:4000]
    with db.LOCK:
        prev = db.conn().execute("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").fetchone()
        prev_hash = prev["hash"] if prev else "0" * 64
        body = json.dumps([ts, actor, role, ip, action, target, det, prev_hash], separators=(",", ":"), ensure_ascii=False)
        h = _chain(body)
        db.conn().execute("INSERT INTO audit_log (ts, actor, role, ip, action, target, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
                          (ts, actor, role, ip, action, target, det, prev_hash, h))


def verify_audit() -> dict:
    prev = "0" * 64
    n = 0
    with db.LOCK:
        rows = db.conn().execute("SELECT * FROM audit_log ORDER BY seq").fetchall()
    for r in rows:
        body = json.dumps([r["ts"], r["actor"], r["role"], r["ip"], r["action"], r["target"], r["detail"], r["prev_hash"]], separators=(",", ":"), ensure_ascii=False)
        if r["prev_hash"] != prev or not hmac.compare_digest(_chain(body), r["hash"]):
            return {"ok": False, "entries": len(rows), "broken_at": r["seq"]}
        prev, n = r["hash"], n + 1
    return {"ok": True, "entries": n}


def recent_audit(limit: int = 200) -> list[dict]:
    with db.LOCK:
        rows = db.conn().execute("SELECT seq, ts, actor, role, ip, action, target, detail FROM audit_log ORDER BY seq DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
