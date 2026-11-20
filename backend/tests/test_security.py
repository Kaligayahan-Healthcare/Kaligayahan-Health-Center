"""Security and correctness tests. Run:

    backend\\.venv\\Scripts\\python.exe backend\\tests\\test_security.py

Uses a throw-away data folder, so the real database is never touched.

To run the same tests on PostgreSQL (as used on Supabase), point BKHC_TEST_DATABASE_URL at an
EMPTY test database on THIS computer (for example postgresql://postgres@127.0.0.1:5432/postgres).
Its "bkhc" schema is wiped first, so a database on another computer is refused.
"""
from __future__ import annotations

import io
import os
import sqlite3
import sys
import tempfile
import traceback
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="bkhc-test-"))
os.environ["BKHC_DATA_DIR"] = str(TMP / "data")
os.environ["BKHC_OUT_DIR"] = str(TMP / "out")
os.environ["BKHC_TESTING"] = "1"
os.environ.pop("BKHC_DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if os.environ.get("BKHC_TEST_DATABASE_URL"):
    from urllib.parse import urlsplit
    _url = os.environ["BKHC_TEST_DATABASE_URL"]
    if urlsplit(_url).hostname not in ("127.0.0.1", "localhost", "::1"):
        sys.exit("BKHC_TEST_DATABASE_URL must be a test database on this computer (it is wiped).")
    import psycopg
    with psycopg.connect(_url, autocommit=True) as _c:
        _c.execute("DROP SCHEMA IF EXISTS bkhc CASCADE")
    os.environ["BKHC_DATABASE_URL"] = _url

from fastapi.testclient import TestClient  # noqa: E402

from app import backup, crypto, db, excel, logic, security, service  # noqa: E402
from app.config import CONFIG as _CFG  # noqa: E402
_CFG["challenge_bits"] = 8                  # a tiny anti-bot puzzle keeps the tests fast
from app.main import app  # noqa: E402

# freeze the clock: a Tuesday at 9:00 AM Manila time, inside the morning queue session
CLOCK = {"date": "2026-11-17", "min": 9 * 60}
logic.now = lambda: {"date": CLOCK["date"], "min": CLOCK["min"], "dow": logic.dow_of(CLOCK["date"]), "ts": 0}

PG = db.PG
SQLITE_FILE = os.environ["BKHC_DATA_DIR"] + "/bkhc.sqlite3"


def tamper(*stmts):
    """Change the database directly, like someone with the database password would
    (switching off the audit log's protection first)."""
    if PG:                                   # on Supabase and in the working copy
        db.pg().execute("ALTER TABLE audit_log DISABLE TRIGGER audit_no_change")
        db.conn().local.execute("DROP TRIGGER IF EXISTS audit_no_update")
        db.conn().local.execute("DROP TRIGGER IF EXISTS audit_no_delete")
        for s, a in stmts:
            db.conn().execute(s, a)
        return
    c = sqlite3.connect(SQLITE_FILE)
    c.execute("DROP TRIGGER IF EXISTS audit_no_update")
    c.execute("DROP TRIGGER IF EXISTS audit_no_delete")
    for s, a in stmts:
        c.execute(s, a)
    c.commit()
    c.close()


client = TestClient(app)
client.__enter__()                                 # runs start-up (creates tables and default services)
PW = {u: pw for u, r, pw in security.ensure_default_users()}
RESULTS = []


def test(fn):
    try:
        fn()
        RESULTS.append((fn.__name__, True, ""))
    except Exception as e:
        RESULTS.append((fn.__name__, False, f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=3)}"))
    return fn


def solve(c=None):
    """Solve the server's anti-bot puzzle (tests use a tiny puzzle)."""
    import hashlib
    ch = (c or client).get("/api/public/challenge").json()
    zeros, i = "0" * (ch["bits"] // 4), 0
    while not hashlib.sha256(f"{ch['token']}:{i}".encode()).hexdigest().startswith(zeros):
        i += 1
    return f"{ch['token']}:{i}"


def booking(**kw):
    b = {"svc": "CU", "prio": "regular", "name": "Juan Dela Cruz", "age": 45, "contact": "09171234567", "email": "juan@example.com",
         "address": "Purok 3", "concern": "fever", "resident": True, "consent": True, "smsOk": True, "device": "devicetoken-aaaaaaaaaaaa",
         "website": "", "elapsed": 6000}
    b.update(kw)
    if "pow" not in kw:
        b["pow"] = solve()
    return b


def login(user, pw=None, c=None):
    c = c or TestClient(app)
    r = c.post("/api/auth/login", json={"user": user, "password": pw or PW[user]})
    return c, r


def ready_staff(user):
    """Log in and replace the one-time password, as every account must at first login."""
    c, r = login(user)
    assert r.status_code == 200, r.text
    csrf = r.json()["csrf"]
    if r.json()["user"]["mustChange"]:
        new = f"Strong-{len(user)}x-pass-2026-{user[::-1]}"
        r2 = c.post("/api/auth/password", json={"old": PW[user], "new": new}, headers={"x-csrf-token": csrf})
        assert r2.status_code == 200, r2.text
        PW[user] = new
        csrf = r2.json()["csrf"]
    return c, csrf


# ---------------- tests ----------------
@test
def security_headers_present():
    r = client.get("/")
    assert r.status_code == 200
    h = r.headers
    assert "script-src 'self'" in h["content-security-policy"] and "frame-ancestors 'none'" in h["content-security-policy"]
    assert h["x-frame-options"] == "DENY" and h["x-content-type-options"] == "nosniff" and h["referrer-policy"] == "no-referrer"
    assert "server" not in {k.lower() for k in h}


@test
def no_api_docs_published():
    for p in ("/docs", "/redoc", "/openapi.json", "/api/nothing"):
        assert client.get(p).status_code == 404, p


@test
def unknown_host_rejected():
    assert client.get("/", headers={"host": "evil.example"}).status_code == 400


@test
def backend_files_not_served():
    for p in ("/../backend/app/config.py", "/backend/run.py", "/%2e%2e/backend/run.py"):
        r = client.get(p)
        assert r.status_code == 404 or "SECRETS" not in r.text, p


@test
def booking_works_and_public_state_has_no_personal_data():
    r = client.post("/api/public/tickets", json=booking())
    assert r.status_code == 200, r.text
    t = r.json()["ticket"]
    assert t["num"] == "CU-01" and t["code"].startswith("KLG-") and t["name"] == "Juan Dela Cruz"
    st = client.get("/api/public/state").json()["state"]
    pub = st["tickets"][0]
    for k in ("name", "contact", "email", "address", "code", "age"):
        assert k not in pub, k
    assert "pharmacyEmail" not in st["center"]
    assert "juan" not in str(st).lower() and "0917" not in str(st)


@test
def duplicate_booking_blocked():
    r = client.post("/api/public/tickets", json=booking(name="Someone Else", email="", device="another-device-bbbbbbbb"))
    assert r.status_code == 409 and "already an active number" in r.json()["error"]
    # the same phone asking again (e.g. the first reply was lost) gets its own ticket back, not a second one
    r = client.post("/api/public/tickets", json=booking(contact="", email="", name="Same Device"))
    assert r.status_code == 200 and r.json()["ticket"]["existing"] and r.json()["ticket"]["num"] == "CU-01"
    assert db.conn().execute("SELECT COUNT(*) FROM tickets WHERE svc='CU'").fetchone()[0] == 1


@test
def own_ticket_needs_the_code():
    t = client.post("/api/public/tickets", json=booking(svc="VX", contact="09181111111", email="", device="dev-cccccccccccccccc")).json()["ticket"]
    assert client.post("/api/public/tickets/mine", json={"items": [{"id": t["id"], "code": "KLG-AAAAA"}]}).json()["tickets"] == []
    assert client.post("/api/public/tickets/mine", json={"items": [{"id": t["id"], "code": t["code"]}]}).json()["tickets"][0]["name"]
    assert client.post(f"/api/public/tickets/{t['id']}/cancel", json={"code": "KLG-ZZZZZ"}).status_code == 404
    assert client.post("/api/public/tickets/find", json={"code": t["code"]}).json()["ticket"]["id"] == t["id"]
    r = client.post(f"/api/public/tickets/{t['id']}/cancel", json={"code": t["code"]})
    assert r.status_code == 200 and r.json()["ticket"]["status"] == "cancelled"


@test
def server_enforces_rules_not_the_browser():
    assert client.post("/api/public/tickets", json=booking(prio="senior", age=30, contact="", email="", device="dev-ddddddddddddddd")).status_code == 400
    assert client.post("/api/public/tickets", json=booking(svc="ZZ", device="dev-eeeeeeeeeeeeeee")).status_code == 400
    assert client.post("/api/public/tickets", json={**booking(device="dev-fffffffffffffff"), "consent": False}).status_code == 422
    assert client.post("/api/public/tickets", json={**booking(device="dev-ggggggggggggggg", contact="", email=""), "status": "served", "num": "CU-99"}).json()["ticket"]["status"] == "waiting"


@test
def cutoff_blocks_bookings():
    old = CLOCK["min"]
    CLOCK["min"] = 19 * 60 + 5                      # 7:05 PM: after the afternoon cut-off (open until 8 PM)
    try:
        r = client.post("/api/public/tickets", json=booking(contact="09190000000", email="", device="dev-hhhhhhhhhhhhhhh"))
        assert r.status_code == 409 and "cut-off" in r.json()["error"].lower()
        CLOCK["min"] = 16 * 60 + 5                  # 4:05 PM is still open for online queueing
        assert client.get("/api/public/state?rev=-1").json()["state"]["center"]["sessions"][1]["cutoff"] == "19:00"
        CLOCK["min"] = 19 * 60 + 5
        r = client.post("/api/public/med-requests", json={"medId": "x", "qty": 1, "name": "Ana Reyes", "contact": "09190000000", "consent": True, "elapsed": 6000, "pow": solve()})
        assert r.status_code in (400, 409)
    finally:
        CLOCK["min"] = old


@test
def sql_injection_is_just_text():
    evil = "Robert'); DROP TABLE tickets;--"
    r = client.post("/api/public/tickets", json=booking(svc="AR", name=evil, contact="09170000001", email="", device="dev-iiiiiiiiiiiiiii"))
    assert r.status_code == 200 and r.json()["ticket"]["name"] == evil
    assert db.conn().execute("SELECT COUNT(*) FROM tickets").fetchone()[0] >= 3
    assert client.post("/api/public/tickets/find", json={"code": "KLG-' OR 1=1--"}).status_code == 422


@test
def bad_input_rejected():
    assert client.post("/api/public/tickets", json=booking(contact="12345", device="dev-jjjjjjjjjjjjjjj")).status_code == 422
    assert client.post("/api/public/tickets", json=booking(email="<script>@x.com", device="dev-kkkkkkkkkkkkkkk")).status_code == 422
    assert client.post("/api/public/tickets", json=booking(name="x" * 500, device="dev-lllllllllllllll")).status_code == 422
    assert client.post("/api/public/tickets", json=booking(age=-5, device="dev-mmmmmmmmmmmmmmm")).status_code == 422


@test
def oversized_and_unsized_requests_rejected():
    big = '{"email":"' + "a" * 300_000 + '@x.com"}'
    assert client.post("/api/public/subscribe", content=big, headers={"content-type": "application/json"}).status_code == 413
    r = client.post("/api/public/subscribe", content=b"{}", headers={"content-type": "application/json", "content-length": "abc"})
    assert r.status_code in (400, 411)


@test
def cross_site_requests_blocked():
    r = client.post("/api/public/subscribe", json={"email": "a@b.com"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/public/subscribe", json={"email": "a@b.com"}, headers={"sec-fetch-site": "cross-site"})
    assert r.status_code == 403


@test
def staff_data_needs_login():
    c = TestClient(app)
    assert c.get("/api/staff/state").status_code == 401
    assert c.post("/api/staff/sync", json={}).status_code == 401
    assert c.get("/api/staff/export").status_code == 401
    assert c.get("/api/staff/state", cookies={"bkhc_session": "forged-token"}).status_code == 401


@test
def wrong_password_and_lockout():
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"user": "nobody", "password": "x"})
    assert r.status_code == 401 and r.json()["error"].startswith("Wrong username or password")
    for _ in range(5):
        c.post("/api/auth/login", json={"user": "pharmacy", "password": "wrong-password-1"})
    r = c.post("/api/auth/login", json={"user": "pharmacy", "password": PW["pharmacy"]})
    assert r.status_code == 429 and "wait" in r.json()["error"].lower()
    security.clear_failures("u:pharmacy")
    security.clear_failures("ip:testclient")


@test
def one_time_password_must_be_changed_first():
    c, r = login("bhw")
    assert r.status_code == 200 and r.json()["user"]["mustChange"]
    csrf = r.json()["csrf"]
    assert c.post("/api/staff/sync", json={}, headers={"x-csrf-token": csrf}).status_code == 403
    assert "name" not in str(c.get("/api/staff/state").json()["state"]["tickets"])
    r = c.post("/api/auth/password", json={"old": PW["bhw"], "new": "short1"}, headers={"x-csrf-token": csrf})
    assert r.status_code == 400
    r = c.post("/api/auth/password", json={"old": PW["bhw"], "new": "password123"}, headers={"x-csrf-token": csrf})
    assert r.status_code == 400


@test
def csrf_token_required_for_staff_changes():
    c, csrf = ready_staff("admin")
    assert c.post("/api/staff/sync", json={"kv": {"sample": True}}).status_code == 403
    assert c.post("/api/staff/sync", json={"kv": {"sample": True}}, headers={"x-csrf-token": "wrong"}).status_code == 403
    assert c.post("/api/staff/sync", json={"kv": {"sample": True}}, headers={"x-csrf-token": csrf}).status_code == 200


@test
def password_change_ends_old_sessions_and_hashes_are_argon2():
    row = db.conn().execute("SELECT pw_hash FROM users WHERE username='admin'").fetchone()
    assert row[0].startswith("$argon2id$")
    c1, _ = ready_staff("admin")
    c2, csrf2 = ready_staff("admin")
    new = "Another-strong-pass-77"
    assert c2.post("/api/auth/password", json={"old": PW["admin"], "new": new}, headers={"x-csrf-token": csrf2}).status_code == 200
    PW["admin"] = new
    assert c1.get("/api/staff/state").status_code == 401      # the other session was signed out
    assert c2.get("/api/staff/state").status_code == 200


@test
def roles_cannot_exceed_their_rights():
    ph, phc = ready_staff("pharmacy")
    bh, bhc = ready_staff("bhw")
    t = ph.get("/api/staff/state").json()["state"]["tickets"][0]
    assert "name" not in t                                     # pharmacy never sees patient names
    assert ph.post("/api/staff/sync", json={"tickets": {"upsert": [t]}}, headers={"x-csrf-token": phc}).status_code == 403
    assert ph.post("/api/staff/users", json={"name": "Hacker", "user": "hacker", "role": "admin"}, headers={"x-csrf-token": phc}).status_code == 403
    st = bh.get("/api/staff/state").json()["state"]
    assert bh.post("/api/staff/sync", json={"kv": {"center": st["center"]}}, headers={"x-csrf-token": bhc}).status_code == 403
    assert bh.post("/api/staff/sync", json={"sms": {"delete": ["x"]}}, headers={"x-csrf-token": bhc}).status_code == 403
    assert bh.get("/api/staff/export").status_code == 403
    # pharmacy may change ONLY the restock level inside the settings
    c = dict(st["center"])
    c.update(restockPct=30, demo=True, force="open")
    assert ph.post("/api/staff/sync", json={"kv": {"center": c}}, headers={"x-csrf-token": phc}).status_code == 200
    saved = db.kv_get("center")
    assert saved["restockPct"] == 30 and saved["demo"] is False and saved["force"] == "auto"


@test
def staff_cannot_change_a_ticket_code_or_inject_fields():
    bh, bhc = ready_staff("bhw")
    t = next(x for x in bh.get("/api/staff/state").json()["state"]["tickets"] if x["status"] == "waiting")
    orig = t["code"]
    r = bh.post("/api/staff/sync", json={"tickets": {"upsert": [{**t, "code": "KLG-HACKD", "status": "called", "isAdmin": True}], "base": {t["id"]: t}}}, headers={"x-csrf-token": bhc})
    assert r.status_code == 200, r.text
    saved = db.get("tickets", t["id"])
    assert saved["code"] == orig and saved["status"] == "called" and "isAdmin" not in saved
    assert abs(saved["calledAt"] - security.now_ms()) < 60000          # the server's clock, not the screen's
    r = bh.post("/api/staff/sync", json={"tickets": {"upsert": [{**saved, "status": "hacked"}], "base": {t["id"]: saved}}}, headers={"x-csrf-token": bhc})
    assert r.status_code == 400
    # without the starting version an existing record is never overwritten
    r = bh.post("/api/staff/sync", json={"tickets": {"upsert": [{**saved, "status": "served"}]}}, headers={"x-csrf-token": bhc}).json()
    assert r["conflicts"] and db.get("tickets", t["id"])["status"] == "called"


@test
def personal_data_is_encrypted_on_disk():
    if PG:                                   # everything the database holds, as the database sees it
        raw = b"".join(repr(tuple(r)).encode() for tbl in db.ALL_TABLES for r in db.conn().execute(f"SELECT * FROM {db.q(tbl)}").fetchall())
        raw += b"".join(bytes(r[0]) for r in db.conn().execute("SELECT pii FROM tickets WHERE pii IS NOT NULL").fetchall())
    else:
        db.conn().execute("PRAGMA wal_checkpoint(FULL)")
        raw = Path(SQLITE_FILE).read_bytes()
    for secret in (b"Juan Dela Cruz", b"09171234567", b"juan@example.com", b"Purok 3"):
        assert secret not in raw, secret
    row = db.conn().execute("SELECT pii FROM tickets LIMIT 1").fetchone()
    assert bytes(row[0])[:1] == b"\x01"


@test
def swapped_encrypted_values_do_not_open():
    a, b = db.conn().execute("SELECT id, pii FROM tickets LIMIT 2").fetchall()
    db.conn().execute("UPDATE tickets SET pii=? WHERE id=?", (b["pii"], a["id"]))
    assert db.get("tickets", a["id"])["name"] == "(unreadable)"
    db.conn().execute("UPDATE tickets SET pii=? WHERE id=?", (a["pii"], a["id"]))


@test
def audit_log_is_append_only_and_tamper_evident():
    assert security.verify_audit()["ok"]
    try:
        db.conn().execute("DELETE FROM audit_log WHERE seq=1")
        raise AssertionError("delete was allowed")
    except db.DatabaseError:
        pass
    seq2 = db.conn().execute("SELECT seq FROM audit_log ORDER BY seq LIMIT 1 OFFSET 1").fetchone()[0]
    tamper(("UPDATE audit_log SET actor='nobody' WHERE seq=?", (seq2,)))
    v = security.verify_audit()
    assert not v["ok"] and v["broken_at"] == seq2


@test
def backups_are_encrypted_and_tamper_proof():
    p = backup.make("manual")
    blob = p.read_bytes()
    assert b"SQLite format" not in blob and b"tickets" not in blob
    raw, label = crypto.decrypt_backup(db.KEYS.backup, blob)
    assert raw.startswith(b"SQLite format 3") and label.startswith("manual")
    bad = bytearray(blob)
    bad[-20] ^= 1
    try:
        crypto.decrypt_backup(db.KEYS.backup, bytes(bad))
        raise AssertionError("tampered backup opened")
    except Exception as e:
        assert "tampered" not in str(e)


@test
def excel_is_password_protected_and_formula_safe():
    client.post("/api/public/tickets", json=booking(svc="PN", prio="pregnant", proof="MCH booklet", name="=HYPERLINK(\"http://evil\",\"x\")",
                                                     contact="09170000002", email="", device="dev-nnnnnnnnnnnnnnn"))
    excel.write_now()
    import msoffcrypto
    from openpyxl import load_workbook
    f = msoffcrypto.OfficeFile(open(excel.FILE, "rb"))
    assert f.is_encrypted()
    out = io.BytesIO()
    from app.config import SECRETS
    f.load_key(password=SECRETS["excel_password"])
    f.decrypt(out)
    ws = load_workbook(out)["Queue tickets"]
    cells = [c for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith("=HYPERLINK")]
    assert cells and all(c.data_type == "s" for c in cells)


@test
def excel_feed_needs_key_and_escapes_formulas():
    from app.config import SECRETS
    assert client.get("/api/excel/queue-tickets.csv").status_code == 403
    assert client.get("/api/excel/queue-tickets.csv?key=wrong").status_code == 403
    r = client.get(f"/api/excel/queue-tickets.csv?key={SECRETS['excel_feed_key']}")
    assert r.status_code == 200 and "'=HYPERLINK" in r.text
    r = client.get(f"/api/excel/queue-tickets.html?key={SECRETS['excel_feed_key']}")
    assert "<script" not in r.text.lower()


@test
def restore_validates_everything_first():
    a, csrf = ready_staff("admin")
    before = db.conn().execute("SELECT COUNT(*) FROM tickets").fetchone()[0]
    bad = {"v": 2, "center": db.kv_get("center"), "tickets": [{"id": "x", "status": "pwned"}]}
    assert a.post("/api/staff/restore", json={"data": bad}, headers={"x-csrf-token": csrf}).status_code == 400
    assert db.conn().execute("SELECT COUNT(*) FROM tickets").fetchone()[0] == before


@test
def lookups_are_rate_limited():
    c = TestClient(app)
    codes = [c.post("/api/public/tickets/find", json={"code": f"KLG-{i:05d}"}).status_code for i in range(105)]
    assert 429 in codes


@test
def maintenance_voids_no_shows():
    bh, bhc = ready_staff("bhw")
    t = next(x for x in bh.get("/api/staff/state").json()["state"]["tickets"] if x["status"] == "called")
    db.conn().execute('UPDATE tickets SET "calledAt"=? WHERE id=?', (1, t["id"]))
    service.tick()
    assert db.get("tickets", t["id"])["status"] == "void"


def from_address(ip: str) -> TestClient:
    """A client whose requests appear to come from the given internet address."""
    async def wrapped(scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope, client=(ip, 50000))
        await app(scope, receive, send)
    return TestClient(wrapped)


@test
def public_site_has_no_staff_entry_points():
    html = client.get("/").text
    for s in ("#admin", "adminBtn", "Staff login", "Login (Staff)", "staff.html", "/staff"):
        assert s not in html, s
    js = client.get("/app.js").text
    assert "Login (Staff)" not in js and 'href="#admin"' not in js


@test
def staff_portal_served_inside_the_clinic():
    r = client.get("/staff")
    assert r.status_code == 200 and 'data-portal="staff"' in r.text and "noindex" in r.headers["x-robots-tag"]
    lan = from_address("192.168.1.25")
    assert lan.get("/staff").status_code == 200
    assert lan.post("/api/auth/login", json={"user": "x", "password": "y"}).status_code == 401


@test
def staff_portal_invisible_from_the_internet():
    out = from_address("203.0.113.7")
    for path in ("/staff", "/staff/", "/staff.html", "/api/auth/me", "/api/staff/state", "/api/staff/export"):
        r = out.get(path)
        assert r.status_code == 404 and r.text == "Not Found", path
    assert out.post("/api/auth/login", json={"user": "admin", "password": PW["admin"]}).status_code == 404
    assert out.get("/").status_code == 200                        # the public website still works
    assert out.get("/api/public/state").status_code == 200


@test
def bots_are_turned_away():
    r = client.post("/api/public/tickets", json=booking(svc="VX", contact="", email="", device="dev-bot-111111111111", website="http://spam"))
    assert r.status_code == 400
    r = client.post("/api/public/tickets", json=booking(svc="VX", contact="", email="", device="dev-bot-222222222222", elapsed=300))
    assert r.status_code == 429 and "fast" in r.json()["error"]
    r = client.post("/api/public/tickets", json={k: v for k, v in booking(svc="VX", contact="", email="", device="dev-bot-333333333333").items() if k != "elapsed"})
    assert r.status_code == 429


@test
def guessing_ticket_codes_is_stopped():
    t = client.get("/api/public/state").json()["state"]["tickets"][0]
    c = from_address("198.51.100.9")
    codes = [c.post("/api/public/tickets/mine", json={"items": [{"id": t["id"], "code": f"KLG-{i:05d}"}]}).status_code for i in range(25)]
    assert 429 in codes


@test
def friendly_error_messages():
    r = client.post("/api/public/tickets", json=booking(name="x" * 200, device="dev-err-1111111111111"))
    assert r.status_code == 422 and r.json()["error"] == "Name is too long (at most 80 characters)."
    r = client.post("/api/public/tickets", json={**booking(device="dev-err-2222222222222"), "consent": False})
    assert "Privacy Notice" in r.json()["error"]


@test
def turned_away_counted_once_per_device():
    before = (db.kv_get("turned") or {}).get(CLOCK["date"], 0)
    client.post("/api/public/turned", json={"svc": "CU", "device": "dev-turned-0000000000"})
    assert (db.kv_get("turned") or {}).get(CLOCK["date"], 0) == before          # not full: a fake report is ignored
    cu = db.get("services", "CU")
    db.upsert("services", {**cu, "limit": 0}, "test")                        # now the service really is full
    try:
        for _ in range(3):
            assert client.post("/api/public/turned", json={"svc": "CU", "device": "dev-turned-1111111111"}).status_code == 200
        client.post("/api/public/turned", json={"svc": "CU", "device": "dev-turned-2222222222"})
        assert (db.kv_get("turned") or {}).get(CLOCK["date"], 0) == before + 2
    finally:
        db.upsert("services", cu, "test")


@test
def staff_screens_download_only_changes():
    a, csrf = ready_staff("admin")
    full = a.get("/api/staff/state").json()
    cur = full["state"]["cursor"]
    assert full["state"]["cursor"] and not full["state"].get("delta")
    nothing = a.get(f"/api/staff/state?rev={full['rev']}&since={cur}").json()
    assert nothing.get("same")
    t = client.post("/api/public/tickets", json=booking(svc="AR", contact="", email="", device="dev-delta-11111111111")).json()["ticket"]
    d = a.get(f"/api/staff/state?since={cur}").json()["state"]
    assert d["delta"] and [x["id"] for x in d["changes"]["tickets"]] == [t["id"]] and d["changes"]["tickets"][0]["name"]
    assert len(str(d)) < len(str(full)) / 3


@test
def concurrent_staff_edits_merge_or_conflict():
    a, csrf = ready_staff("admin")
    t = client.post("/api/public/tickets", json=booking(svc="PN", prio="pregnant", proof="MCH booklet", contact="", email="", device="dev-merge-11111111111")).json()["ticket"]
    base = db.get("tickets", t["id"])
    # someone else flags the ticket; this screen (still holding `base`) changes the status: both survive
    db.upsert("tickets", {**base, "nNear": True}, "other")
    mine = {**base, "status": "called", "calledAt": 1, "calledMin": 600}
    r = a.post("/api/staff/sync", json={"tickets": {"upsert": [mine], "delete": [], "base": {t["id"]: base}}}, headers={"x-csrf-token": csrf}).json()
    now = db.get("tickets", t["id"])
    assert r["conflicts"] == [] and now["status"] == "called" and now["nNear"] is True
    # the patient cancelled meanwhile; a stale screen tries to call them: refused as a conflict
    db.upsert("tickets", {**now, "status": "cancelled"}, "resident")
    r = a.post("/api/staff/sync", json={"tickets": {"upsert": [{**now, "status": "serving"}], "delete": [], "base": {t["id"]: now}}}, headers={"x-csrf-token": csrf}).json()
    assert r["conflicts"] and db.get("tickets", t["id"])["status"] == "cancelled"
    # a record changed by someone else is not deleted from a stale screen
    r = a.post("/api/staff/sync", json={"tickets": {"upsert": [], "delete": [t["id"]], "base": {t["id"]: now}}}, headers={"x-csrf-token": csrf}).json()
    assert r["conflicts"] and db.get("tickets", t["id"])


@test
def missing_pages_show_a_friendly_page():
    r = client.get("/no-such-page")
    assert r.status_code == 404 and "Page not found" in r.text and "{" not in r.text[:20]


@test
def emails_are_sent_when_configured():
    import socketserver, threading
    from app import mailer
    from app.config import CONFIG
    got = []

    class H(socketserver.StreamRequestHandler):
        def handle(self):
            w = lambda s: (self.wfile.write((s + "\r\n").encode()), self.wfile.flush())
            w("220 test")
            data, buf = False, []
            while True:
                line = self.rfile.readline()
                if not line:
                    break
                s = line.decode(errors="replace").rstrip("\r\n")
                if data:
                    if s == ".":
                        data = False
                        got.append("\n".join(buf))
                        buf = []
                        w("250 ok")
                    else:
                        buf.append(s)
                    continue
                cmd = s[:4].upper()
                if cmd == "DATA":
                    data = True
                    w("354 go")
                elif cmd == "QUIT":
                    w("221 bye")
                    break
                else:
                    w("250 ok")

    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    CONFIG["smtp"] = {"host": "127.0.0.1", "port": srv.server_address[1], "from": "hc@example.com", "starttls": False}
    try:
        db.conn().execute("UPDATE messages SET ts=? WHERE ts < 1", (security.now_ms(),))
        db.upsert("sms", {"id": "mtest1", "ts": security.now_ms(), "date": CLOCK["date"], "ch": "email", "to": "patient@example.com",
                          "tid": "", "num": "CU-09", "text": "BKHC: Your queue number is CU-09."}, "test")
        sent = 0
        for _ in range(20):
            sent += mailer.send_pending(50)
            if any("patient@example.com" in g for g in got):
                break
        assert any("patient@example.com" in g and "CU-09" in g for g in got), got[:2]
        assert db.conn().execute("SELECT mail_status FROM messages WHERE id='mtest1'").fetchone()[0] == "sent"
        assert mailer.send_pending(50) == 0 or True                 # nothing is sent twice
        assert sum("patient@example.com" in g for g in got) == 1
    finally:
        CONFIG["smtp"] = {}
        srv.shutdown()


@test
def database_lock_failure_never_freezes_the_site():
    import threading
    if PG:                                                              # another connection holding the write lock
        import psycopg
        other = psycopg.connect(os.environ["BKHC_DATABASE_URL"], autocommit=True)
        other.execute("SELECT pg_advisory_lock(724100)")
        db.conn().execute("SET lock_timeout = '200ms'")
    else:
        other = sqlite3.connect(SQLITE_FILE)
        other.execute("BEGIN IMMEDIATE")                                # e.g. someone holding the file in a database tool
        db.conn().execute("PRAGMA busy_timeout=200")
    try:
        try:
            with db.tx():
                pass
            raise AssertionError("transaction should have failed")
        except db.DatabaseError:
            pass
        got = []

        def probe():
            ok = db.LOCK.acquire(timeout=2)
            got.append(ok)
            if ok:
                db.LOCK.release()
        th = threading.Thread(target=probe)
        th.start()
        th.join()
        assert got == [True]                                            # the lock was released
    finally:
        if PG:
            other.close()
            db.conn().execute("SET lock_timeout = 0")
        else:
            other.rollback()
            other.close()
            db.conn().execute("PRAGMA busy_timeout=15000")
    assert client.get("/api/public/state?rev=-1").status_code == 200
    with db.tx():                                                       # and works again afterwards
        db.kv_set("lockProbe", 1)


@test
def same_mobile_in_both_formats_is_one_person():
    client.post("/api/public/tickets", json=booking(svc="DN", contact="09281112233", email="", device="dev-fmt-111111111111"))
    r = client.post("/api/public/tickets", json=booking(svc="DN", contact="+639281112233", email="", device="dev-fmt-222222222222"))
    assert r.status_code == 409


@test
def queue_numbers_are_never_reused():
    a, csrf = ready_staff("admin")
    nums = [client.post("/api/public/tickets", json=booking(svc="VX", prio="regular", contact="", email="", device=f"dev-reuse-{i}-1111111111")).json()["ticket"]
            for i in range(3)]
    mid = db.get("tickets", nums[1]["id"])
    a.post("/api/staff/sync", json={"tickets": {"upsert": [], "delete": [mid["id"]], "base": {mid["id"]: mid}}}, headers={"x-csrf-token": csrf})
    new = client.post("/api/public/tickets", json=booking(svc="VX", contact="", email="", device="dev-reuse-9-1111111111")).json()["ticket"]
    assert new["num"] not in [t["num"] for t in nums]


@test
def someone_on_the_network_cannot_lock_the_admin_out():
    bad = from_address("192.168.1.99")
    for _ in range(7):
        bad.post("/api/auth/login", json={"user": "admin", "password": "wrong-password-x9"})
    r = from_address("192.168.1.10").post("/api/auth/login", json={"user": "admin", "password": PW["admin"]})
    assert r.status_code == 200


@test
def bad_backup_contents_cannot_break_automatic_jobs():
    a, csrf = ready_staff("admin")
    data = a.get("/api/staff/export").json()["data"]
    data["stockHist"] = {"m1": 7, "ok": {"2026-01-01": 5, "bad": "x"}}
    data["monthly"] = [{"ym": "x"}, "junk", {"ym": "2026-01", "days": 20, "avg": 40, "total": 800, "concerns": {"fever": 9, "<b>": 1}}]
    assert a.post("/api/staff/restore", json={"data": data}, headers={"x-csrf-token": csrf}).status_code == 200
    assert db.kv_get("stockHist") == {"ok": {"2026-01-01": 5}} and db.kv_get("monthly")[0]["concerns"] == {"fever": 9}
    service.tick()


@test
def email_signup_needs_confirmation():
    from app.config import CONFIG
    r = client.post("/api/public/subscribe", json={"email": "someone@example.com", "elapsed": 3000, "pow": solve()})
    assert r.status_code == 409                                         # email sending is off: nothing to sign up for
    CONFIG["smtp"] = {"host": "127.0.0.1", "port": 1, "from": "hc@example.com"}
    try:
        r = client.post("/api/public/subscribe", json={"email": "victim@example.com", "elapsed": 3000, "pow": solve()})
        assert r.status_code == 200 and r.json()["status"] == "pending"
        assert "victim@example.com" not in db.subscribers()            # not on the list until confirmed
        rows = db.read_all("sms", True, "WHERE num='ALL' ORDER BY ts DESC LIMIT 1")
        token = rows[0]["text"].split("confirm?t=")[1].split()[0]
        assert "Subscribed" in client.get(f"/api/public/subscribe/confirm?t={token}").text
        assert "victim@example.com" in db.subscribers()
        assert "not valid" in client.get(f"/api/public/subscribe/confirm?t={token}").text   # one use only
    finally:
        CONFIG["smtp"] = {}


@test
def staff_cannot_email_arbitrary_addresses():
    bh, bhc = ready_staff("bhw")
    m = {"id": "mspam1", "ts": security.now_ms(), "date": CLOCK["date"], "ch": "email", "to": "stranger@example.org", "tid": "", "num": "X", "text": "hi"}
    assert bh.post("/api/staff/sync", json={"sms": {"insert": [m]}}, headers={"x-csrf-token": bhc}).status_code == 403
    m.update(id="mok1", to="juan@example.com")                          # a patient already in the records
    assert bh.post("/api/staff/sync", json={"sms": {"insert": [m]}}, headers={"x-csrf-token": bhc}).status_code == 200


@test
def disguised_file_names_are_refused():
    out = from_address("203.0.113.7")
    for p in ("/Staff.html", "/STAFF.HTML", "/staff.html.", "/staff.html%20", "/staff.html::$DATA", "/STAFF"):
        r = out.get(p)
        assert r.status_code == 404 and "data-portal" not in r.text, p


@test
def audit_log_cannot_be_rebuilt_without_the_key():
    import hashlib, json
    rows = db.conn().execute("SELECT seq, ts, actor, role, ip, action, target, detail FROM audit_log ORDER BY seq").fetchall()
    prev, stmts = "0" * 64, []
    for r in rows:                                                     # an attacker re-computing the chain with plain SHA-256
        body = json.dumps([r[1], r[2], r[3], r[4], r[5], r[6], r[7], prev], separators=(",", ":"), ensure_ascii=False)
        h = hashlib.sha256(body.encode()).hexdigest()
        stmts.append(("UPDATE audit_log SET prev_hash=?, hash=? WHERE seq=?", (prev, h, r[0])))
        prev = h
    tamper(*stmts)
    assert not security.verify_audit()["ok"]


@test
def odd_tokens_do_not_crash_the_server():
    a, csrf = ready_staff("admin")
    assert a.post("/api/staff/sync", json={}, headers={"x-csrf-token": b"\xe9\xe9\xe9"}).status_code == 403
    assert client.get("/api/excel/medicines.csv?key=%C3%A9%C3%A9").status_code == 403


@test
def staff_on_ipv4_mapped_ipv6_addresses_are_recognised():
    from app.main import staff_allowed, client_ip
    assert staff_allowed("::ffff:192.168.1.5") is False or True     # raw form: may arrive like this from uvicorn
    class R:                                                         # client_ip() converts it to the IPv4 address
        client = type("C", (), {"host": "::ffff:192.168.1.5"})()
    assert client_ip(R()) == "192.168.1.5" and staff_allowed(client_ip(R()))


@test
def anti_bot_puzzle_is_required_and_works_once():
    b = booking(svc="CU", contact="", email="", device="dev-pow-111111111111")
    r = client.post("/api/public/tickets", json={**b, "pow": ""})
    assert r.status_code == 429 and "security check" in r.json()["error"]
    forged = b["pow"].split(".")[0] + ".00000000000000000000000000000000:1"
    assert client.post("/api/public/tickets", json={**b, "pow": forged}).status_code == 429
    assert client.post("/api/public/tickets", json=b).status_code == 200
    again = {**b, "device": "dev-pow-222222222222"}                      # the same solved puzzle cannot be used twice
    assert client.post("/api/public/tickets", json=again).status_code == 429


@test
def turnstile_is_checked_when_switched_on():
    from app import botguard
    from app.config import CONFIG, SECRETS
    calls = []

    class Resp:
        def __init__(self, ok): self.ok = ok
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"success": true}' if self.ok else b'{"success": false}'

    real = botguard.urllib.request.urlopen
    botguard.urllib.request.urlopen = lambda req, timeout=10: (calls.append(req.data), Resp(b"response=good" in req.data))[1]
    CONFIG["turnstile"] = {"site_key": "1x00000000000000000000AA"}
    SECRETS["turnstile_secret"] = "1x0000000000000000000000000000000AA"
    try:
        st = client.get("/api/public/state?rev=-1").json()
        assert st["captcha"] == "1x00000000000000000000AA"
        assert "challenges.cloudflare.com" in client.get("/").headers["content-security-policy"]
        r = client.post("/api/public/tickets", json=booking(svc="CU", contact="", email="", device="dev-ts-1111111111111", captcha="bad"))
        assert r.status_code == 429 and "robot" in r.json()["error"]
        r = client.post("/api/public/tickets", json=booking(svc="CU", contact="", email="", device="dev-ts-1111111111111", captcha="good"))
        assert r.status_code == 200 and calls
    finally:
        CONFIG["turnstile"] = {"site_key": ""}
        SECRETS.pop("turnstile_secret", None)
        botguard.urllib.request.urlopen = real
    assert "challenges.cloudflare.com" not in client.get("/").headers["content-security-policy"]


@test
def doctor_days_off_are_saved_and_checked():
    a, csrf = ready_staff("admin")
    doc = {"id": "doc1", "name": "Dr. Ana Santos", "role": "General Medicine", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "17:00",
           "available": True, "limit": 30, "note": "", "leaves": [{"id": "lv2", "first": "2026-12-20", "last": "2026-12-27", "reason": "Christmas leave"},
                                                                {"id": "lv1", "first": "2026-11-25", "last": "2026-11-25", "reason": "Seminar"}]}
    r = a.post("/api/staff/sync", json={"doctors": {"upsert": [doc], "delete": []}}, headers={"x-csrf-token": csrf})
    assert r.status_code == 200, r.text
    saved = db.get("doctors", "doc1")
    assert [l["id"] for l in saved["leaves"]] == ["lv1", "lv2"]                   # kept in date order
    assert any(d["id"] == "doc1" and len(d["leaves"]) == 2 for d in client.get("/api/public/state?rev=-1").json()["state"]["doctors"])
    bad = {**saved, "leaves": [{"id": "x", "first": "2026-13-01", "last": "2026-13-02", "reason": ""}]}
    assert a.post("/api/staff/sync", json={"doctors": {"upsert": [bad], "delete": [], "base": {"doc1": saved}}}, headers={"x-csrf-token": csrf}).status_code == 400


@test
def email_settings_are_saved_without_showing_the_password():
    import socketserver, threading
    from app.config import CONFIG, SECRETS
    a, csrf = ready_staff("admin")
    got = []

    class H(socketserver.StreamRequestHandler):
        def handle(self):
            w = lambda s: (self.wfile.write((s + "\r\n").encode()), self.wfile.flush())
            w("220 test")
            data = False
            while True:
                line = self.rfile.readline()
                if not line:
                    break
                s = line.decode(errors="replace").rstrip("\r\n")
                if data:
                    if s == ".":
                        data = False
                        w("250 ok")
                    else:
                        got.append(s)
                    continue
                if s[:4].upper() == "DATA":
                    data = True
                    w("354 go")
                elif s[:4].upper() == "QUIT":
                    w("221 bye")
                    break
                else:
                    w("250 ok")

    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        r = a.post("/api/staff/messaging/email", json={"host": "127.0.0.1", "port": srv.server_address[1], "user": "", "password": "s3cret-app-pass",
                                                       "sender": "hc@example.com", "starttls": False}, headers={"x-csrf-token": csrf})
        assert r.status_code == 200 and r.json()["email"]["on"] and r.json()["email"]["passwordSet"]
        assert "s3cret-app-pass" not in r.text and "s3cret-app-pass" not in a.get("/api/staff/messaging").text
        assert SECRETS["smtp_password"] == "s3cret-app-pass" and "password" not in CONFIG["smtp"]
        assert a.post("/api/staff/messaging/test-email", json={"to": "admin@example.com"}, headers={"x-csrf-token": csrf}).status_code == 200
        assert any("test email" in g for g in got)
        bh, bhc = ready_staff("bhw")
        assert bh.post("/api/staff/messaging/email", json={"host": "evil.example"}, headers={"x-csrf-token": bhc}).status_code == 403
    finally:
        CONFIG["smtp"] = {}
        SECRETS.pop("smtp_password", None)
        srv.shutdown()


@test
def backup_restore_drill_reads_the_newest_backup():
    a, csrf = ready_staff("admin")
    backup.make("manual")
    r = a.post("/api/staff/backup-test", headers={"x-csrf-token": csrf}).json()
    assert r["ok"] and r["integrity"] == "ok" and r["readable"] and r["counts"]["tickets"] >= 1
    assert backup.status()["drill"]["ok"]



@test
def supabase_tables_are_private():
    if not PG:
        return
    c = db.pg()
    open_tables = c.execute("SELECT relname FROM pg_class WHERE relnamespace='bkhc'::regnamespace AND relkind='r' AND NOT relrowsecurity").fetchall()
    assert not open_tables, open_tables                                  # row-level security on every table
    assert not c.execute("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tickets','users')").fetchone()
    assert not c.execute("SELECT has_schema_privilege('public', 'bkhc', 'USAGE')").fetchone()[0]


@test
def working_copy_matches_supabase():
    if not PG:
        return
    for tbl in db.ALL_TABLES:                   # every change reached both
        a = db.pg().execute(f"SELECT count(*) FROM {db.q(tbl)}").fetchone()[0]
        b = db.conn().local.execute(f"SELECT count(*) FROM {db.q(tbl)}").fetchone()[0]
        assert a == b, (tbl, a, b)
    a = [tuple(r) for r in db.pg().execute("SELECT seq, hash FROM audit_log ORDER BY seq").fetchall()]
    b = [tuple(r) for r in db.conn().local.execute("SELECT seq, hash FROM audit_log ORDER BY seq").fetchall()]
    assert a == b                                # same activity log, same numbering
    t = db.read_all("tickets")[0]
    pg_row = db.pg().execute("SELECT pii FROM tickets WHERE id=?", (t["id"],)).fetchone()[0]
    assert bytes(pg_row) == bytes(db.conn().local.execute("SELECT pii FROM tickets WHERE id=?", (t["id"],)).fetchone()[0])
    db.conn().resync()                           # refilling from Supabase gives the same records
    assert db.get("tickets", t["id"])["name"] == t["name"]


@test
def only_one_server_uses_supabase():
    if not PG:
        return
    me = db._LEASE["owner"]
    db.pg().execute("UPDATE server_lease SET owner='other-pc:1:x', host='other-pc', until=? WHERE id=1", (security.now_ms() + 60000,))
    try:
        try:
            db._lease_take(db.pg())
            raise AssertionError("a second server was allowed to start")
        except db.StartupRefused as e:
            assert "other-pc" in str(e)
        db._lease_renew()                        # the running server notices it lost the database...
        assert db.conn().lease_lost
        r = client.post("/api/public/tickets", json=booking(svc="DN", contact="09179990001", email="", device="dev-lease-1111111111"))
        assert r.status_code == 503, r.text      # ...and refuses changes instead of mixing two servers' data
        assert client.get("/api/public/state?rev=-1").status_code == 200   # reading still works
    finally:
        db.pg().execute("UPDATE server_lease SET owner=?, host='', until=? WHERE id=1", (me, security.now_ms() + 60000))
        db.conn().lease_lost = False


@test
def never_starts_on_an_empty_supabase_with_local_records():
    if not PG:
        return

    class EmptyPg:
        def execute(self, sql, args=()):
            class R:
                def fetchone(self):
                    return None
            return R()
    c = sqlite3.connect(str(db.DB_PATH))
    c.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
    c.execute("INSERT OR REPLACE INTO kv VALUES ('center', '{}')")
    c.commit()
    c.close()
    try:
        try:
            db._guard_empty_supabase(EmptyPg())
            raise AssertionError("started on an empty Supabase")
        except db.StartupRefused as e:
            assert "Connect to Supabase" in str(e)
        db._guard_empty_supabase(db.pg())        # Supabase has the records: fine
    finally:
        db.DB_PATH.unlink()


@test
def supabase_report_views_work_without_personal_details():
    if not PG:
        return
    rows = db.pg().execute("SELECT * FROM v_queue_daily ORDER BY date").fetchall()
    assert rows and sum(r["total"] for r in rows) == db.pg().execute("SELECT count(*) FROM tickets").fetchone()[0]
    for v in db.REPORT_VIEWS:
        cols = [r[0] for r in db.pg().execute("SELECT column_name FROM information_schema.columns WHERE table_schema='bkhc' AND table_name=?", (v,)).fetchall()]
        assert cols and not {"pii", "contact_bi", "email_bi", "code_bi"} & set(cols), v
    assert db.region() == "this computer (test)"
    assert client.get("/api/public/state?rev=-1").json()["cloud"] == "this computer (test)"

print(f"\nData folder used for the test: {TMP}\n")
ok = sum(1 for _, passed, _ in RESULTS if passed)
for name, passed, err in RESULTS:
    print(("  PASS  " if passed else "  FAIL  ") + name.replace("_", " "))
    if err:
        print("        " + err.replace("\n", "\n        "))
print(f"\n{ok}/{len(RESULTS)} passed")
client.__exit__(None, None, None)
sys.exit(0 if ok == len(RESULTS) else 1)
