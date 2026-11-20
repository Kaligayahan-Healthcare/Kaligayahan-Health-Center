"""Sends the messages the system writes (queue numbers, "your turn is near", ready medicine,
schedule changes): emails through an SMTP mail server (Gmail, Brevo...) and, optionally, text
messages (SMS) through the Semaphore SMS gateway (semaphore.co, Philippine numbers).

Both are OFF until an administrator fills them in under Settings -> Email & text messages (or in
config.json). Passwords and API keys are kept in secrets.json (private), never in config.json and
never sent back to the browser.

Messages are sent in the background. Only recent messages are sent (an old notice is never sent
late), each is tried up to 3 times, there is a daily cap, and failures are shown in Settings.
"""
from __future__ import annotations

import json
import logging
import re
import smtplib
import ssl
import time
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from . import crypto, db
from .config import CONFIG, CONFIG_PATH, SECRETS, SECRETS_PATH, _write_private

log = logging.getLogger("bkhc")
MAX_AGE_MS = 2 * 3600 * 1000        # never send a notice older than 2 hours
STATUS = {"sent": 0, "failed": 0, "last_error": "", "sms_sent": 0, "sms_failed": 0, "sms_last_error": ""}
SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages"


# ---------- settings ----------
def settings() -> dict:
    s = CONFIG.get("smtp") or {}
    s = dict(s) if isinstance(s, dict) else {}
    s["password"] = SECRETS.get("smtp_password") or s.get("password", "")
    return s


def enabled() -> bool:
    s = settings()
    return bool(s.get("host") and s.get("from"))


def sms_settings() -> dict:
    s = CONFIG.get("sms") or {}
    s = dict(s) if isinstance(s, dict) else {}
    s["api_key"] = SECRETS.get("sms_api_key", "")
    return s


def sms_enabled() -> bool:
    s = sms_settings()
    return s.get("provider") == "semaphore" and bool(s.get("api_key"))


def public_settings() -> dict:
    """What an administrator sees in Settings (never the password or API key itself)."""
    s, m = settings(), sms_settings()
    return {"email": {"host": s.get("host", ""), "port": int(s.get("port") or 587), "user": s.get("user", ""), "from": s.get("from", ""),
                      "starttls": bool(s.get("starttls", True)), "passwordSet": bool(s.get("password")), "on": enabled()},
            "sms": {"provider": m.get("provider", ""), "sender": m.get("sender", ""), "keySet": bool(m.get("api_key")), "on": sms_enabled()},
            "dailyCap": int(CONFIG.get("mail_daily_cap") or 500), "status": dict(STATUS)}


def _save() -> None:
    disk = {}
    try:
        disk = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    for k in ("smtp", "sms"):
        if k in CONFIG:
            disk[k] = {x: v for x, v in CONFIG[k].items() if x not in ("password", "api_key")}
    _write_private(CONFIG_PATH, json.dumps(disk, indent=2))
    _write_private(SECRETS_PATH, json.dumps(SECRETS, indent=2))


def save_email(host: str, port: int, user: str, password: str | None, sender: str, starttls: bool) -> None:
    CONFIG["smtp"] = {"host": host, "port": port, "user": user, "from": sender, "starttls": starttls}
    if password is not None:
        SECRETS["smtp_password"] = password
    _save()


def save_sms(provider: str, api_key: str | None, sender: str) -> None:
    CONFIG["sms"] = {"provider": provider, "sender": sender}
    if api_key is not None:
        SECRETS["sms_api_key"] = api_key
    _save()


# ---------- sending ----------
def ensure_columns() -> None:
    db.conn()                     # the sending columns are created with the table (db.create_schema)


def _connect(s: dict):
    port = int(s.get("port") or 587)
    ctx = ssl.create_default_context()
    if port == 465:
        smtp = smtplib.SMTP_SSL(s["host"], port, timeout=20, context=ctx)
    else:
        smtp = smtplib.SMTP(s["host"], port, timeout=20)
        if s.get("starttls", True):
            smtp.starttls(context=ctx)
    if s.get("user"):
        smtp.login(s["user"], s.get("password", ""))
    return smtp


def _clean(s) -> str:
    return " ".join(str(s or "").split())[:200]        # no line breaks in headers (no header injection)


def _email(s: dict, to: str, num: str, text: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr(("Barangay Kaligayahan Health Center", _clean(s["from"])))
    msg["To"] = _clean(to)
    num = _clean(num)
    msg["Subject"] = "Barangay Kaligayahan Health Center" + (f" · {num}" if num and num not in ("ALL", "STOCK", "TEST") else "")
    msg["Message-ID"] = make_msgid(domain="kaligayahan.local")
    msg.set_content(str(text).removeprefix("BKHC: ") + "\n\n-- \nThis is an automatic message from the Barangay Kaligayahan Health Center."
                    "\nPlease do not reply. Hotline: 0963-154-1440.")
    return msg


def _sms_number(n: str) -> str:
    d = re.sub(r"\D", "", n or "")
    return "0" + d[2:] if d.startswith("63") else d


def send_sms(number: str, text: str) -> None:
    """One text message through Semaphore. Raises on failure."""
    s = sms_settings()
    data = {"apikey": s["api_key"], "number": _sms_number(number), "message": str(text)[:900]}
    if s.get("sender"):
        data["sendername"] = s["sender"]
    req = urllib.request.Request(SEMAPHORE_URL, data=urllib.parse.urlencode(data).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode("utf-8", "replace")
    if r.status >= 300 or '"message_id"' not in body:
        raise RuntimeError(f"SMS gateway answered: {body[:200]}")


def _sent_today(ch: str) -> int:
    start = int(time.time() // 86400 * 86400 * 1000)
    with db.LOCK:
        return db.conn().execute("SELECT COUNT(*) FROM messages WHERE mail_status='sent' AND ch=? AND ts >= ?", (ch, start)).fetchone()[0]


def _mark(mid: str, status: str | None, tries: int | None = None) -> None:
    with db.LOCK:
        db.conn().execute("UPDATE messages SET mail_status=?, mail_tries=COALESCE(?, mail_tries) WHERE id=?", (status, tries, mid))


def send_pending(batch: int = 20) -> int:
    """Send waiting messages. Returns how many were sent."""
    email_on, sms_on = enabled(), sms_enabled()
    if not email_on and not sms_on:
        return 0
    ensure_columns()
    now = int(time.time() * 1000)
    cap = int(CONFIG.get("mail_daily_cap") or 500)
    with db.LOCK:
        c = db.conn()
        c.execute("UPDATE messages SET mail_status='skipped' WHERE mail_status IS NULL AND ts < ?", (now - MAX_AGE_MS,))
        if not email_on:
            c.execute("UPDATE messages SET mail_status='skipped' WHERE mail_status IS NULL AND ch='email'")
        if not sms_on:
            c.execute("UPDATE messages SET mail_status='skipped' WHERE mail_status IS NULL AND ch='sms'")
        rows = c.execute("SELECT * FROM messages WHERE mail_status IS NULL ORDER BY ts LIMIT ?", (batch,)).fetchall()
    if not rows:
        return 0
    sent, smtp = 0, None
    s = settings()
    try:
        for r in rows:
            if _sent_today(r["ch"]) >= cap:
                STATUS["last_error"] = "Daily message limit reached; the rest are skipped if they get too old."
                break
            try:
                pii = crypto.unseal_json(db.KEYS.field, r["pii"], f"messages:{r['id']}")
                msg = _email(s, pii["to"], r["num"], pii["text"]) if r["ch"] == "email" else None
            except Exception as e:                                       # a damaged message is set aside, never blocks the rest
                _mark(r["id"], "failed")
                log.warning("message %s could not be prepared: %s", r["id"], e)
                continue
            try:
                if r["ch"] == "email":
                    if smtp is None:
                        smtp = _connect(s)
                    smtp.send_message(msg)
                    STATUS["sent"] += 1
                else:
                    send_sms(pii["to"], str(pii["text"]).removeprefix("BKHC: ")[:900])
                    STATUS["sms_sent"] += 1
                _mark(r["id"], "sent")
                sent += 1
            except Exception as e:
                tries = (r["mail_tries"] or 0) + 1
                _mark(r["id"], "failed" if tries >= 3 else None, tries)
                key = "last_error" if r["ch"] == "email" else "sms_last_error"
                STATUS["failed" if r["ch"] == "email" else "sms_failed"] += 1
                STATUS[key] = f"{type(e).__name__}: {e}"[:300]
                log.warning("sending message %s failed: %s", r["id"], STATUS[key])
                if r["ch"] == "email" and smtp is None:
                    break                                                # cannot reach the mail server: try again later
    finally:
        if smtp is not None:
            try:
                smtp.quit()
            except Exception:
                pass
    return sent


def test_email(to: str) -> None:
    s = settings()
    smtp = _connect(s)
    try:
        smtp.send_message(_email(s, to, "TEST", "This is a test email from the health center website. Email sending works."))
    finally:
        try:
            smtp.quit()
        except Exception:
            pass
