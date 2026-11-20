"""The web server: serves the website and the API.

Protection layers on every request
----------------------------------
1. Allowed host names only (blocks DNS-rebinding tricks).
2. Changes (POST/PUT/DELETE) must come from this site's own pages: the Origin and
   Sec-Fetch-Site headers are checked, and staff changes also need the CSRF token.
3. Request bodies have a size limit; a request without a stated size is refused.
4. Rate limits per address (stricter for login, booking and lookups).
5. Strict validation of every field (see models.py).
6. Security headers: Content-Security-Policy (only this site's own scripts may run),
   no framing, no sniffing, no referrer, no camera/microphone/location.
7. No API documentation pages are published, and errors never reveal internals.
"""
from __future__ import annotations

import hmac
import os
import ipaddress
import json
import logging
import logging.handlers
import secrets
import threading
import time
from contextlib import asynccontextmanager

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import backup, botguard, db, excel, logic as L, mailer, models as M, service
from .config import CONFIG, CONFIG_PATH, DATA, DB_PATH, LOG_DIR, SECRETS, SECRETS_PATH, WEBSITE, _write_private
from .security import (COOKIE, LIMITER, ROLES, audit, create_session, clear_failures, csrf_ok, end_session, get_session,
                       lock_left, password_problem, purge_sessions, record_failure, recent_audit, set_password, temp_password,
                       user_by_id, user_by_name, user_public, users, verify_audit, verify_pw, create_user)

LOG_DIR.mkdir(parents=True, exist_ok=True)
log = logging.getLogger("bkhc")
log.setLevel(logging.INFO)
_h = logging.handlers.RotatingFileHandler(LOG_DIR / "server.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
_h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
log.addHandler(_h)

STOP = threading.Event()


def _loop(fn, every: float, name: str):
    def run():
        while not STOP.is_set():
            try:
                fn()
            except Exception:
                log.exception("%s failed", name)
            STOP.wait(every)
    t = threading.Thread(target=run, name=name, daemon=True)
    t.start()


@asynccontextmanager
async def lifespan(app):
    db.conn()
    service.first_run_setup()
    _loop(service.tick, 10, "maintenance")
    _loop(purge_sessions, 300, "sessions")
    _loop(backup.run_due, 60, "backups")
    mailer.ensure_columns()
    _loop(mailer.send_pending, 15, "mail")
    threading.Thread(target=excel.worker, args=(STOP,), name="excel", daemon=True).start()
    log.info("server started")
    yield
    STOP.set()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"] + (["testserver"] if os.environ.get("BKHC_TESTING") else []) + list(CONFIG.get("allowed_hosts") or [])
app.add_middleware(GZipMiddleware, minimum_size=1200)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=HOSTS)

def csp() -> str:
    """Only this site's own scripts may run. Cloudflare Turnstile is allowed only when it is switched on."""
    cf = " https://challenges.cloudflare.com" if botguard.turnstile_site_key() else ""
    return ("default-src 'self'; script-src 'self'" + cf + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
            "connect-src 'self'; frame-src https://www.google.com https://maps.google.com" + cf + "; frame-ancestors 'none'; base-uri 'none'; "
            "form-action 'self'; object-src 'none'")

SIZE_LIMIT = {"/api/staff/restore": 30_000_000, "/api/staff/sync": 8_000_000}
UNSAFE = ("POST", "PUT", "PATCH", "DELETE")


def client_ip(request: Request) -> str:
    """The visitor's address. Behind a trusted reverse proxy or tunnel (config "trusted_proxies"),
    uvicorn has already replaced it with the real visitor's address from X-Forwarded-For."""
    host = request.client.host if request.client else "unknown"
    a = None
    try:
        a = ipaddress.ip_address(host)
    except ValueError:
        return host
    return str(a.ipv4_mapped) if a.version == 6 and a.ipv4_mapped else host


# ---------- the staff portal is invisible outside the clinic ----------
STAFF_NETS = []
for _n in CONFIG.get("staff_networks") or []:
    try:
        STAFF_NETS.append(ipaddress.ip_network(_n, strict=False))
    except ValueError:
        log.warning("ignored bad staff_networks entry %r", _n)


TESTING = bool(os.environ.get("BKHC_TESTING"))


def ip_obj(ip: str):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    return a.ipv4_mapped or a if a.version == 6 else a      # ::ffff:192.168.1.5 is really 192.168.1.5


def staff_allowed(ip: str) -> bool:
    if ip == "testclient" and TESTING:
        return True
    a = ip_obj(ip)
    return bool(a) and any(a in n for n in STAFF_NETS)


def is_staff_path(path: str) -> bool:
    p = path.lower()
    return p.startswith(("/staff", "/api/auth/", "/api/staff/"))


def odd_path(path: str) -> bool:
    """Windows treats STAFF.HTML, 'staff.html.' and 'staff.html::$DATA' as the same file:
    refuse such names outright so no file can be reached by a disguised name."""
    from urllib.parse import unquote
    raw = unquote(path)
    return ":" in raw or "\\" in raw or any(seg != seg.rstrip(". ") for seg in raw.split("/") if seg)


@app.middleware("http")
async def guard(request: Request, call_next):
    t0 = time.perf_counter()
    path, ip = request.url.path, client_ip(request)
    if odd_path(path):
        return PlainTextResponse("Not Found", 404)
    staff_path = is_staff_path(path)
    if staff_path and not staff_allowed(ip):
        log.warning("staff area requested from outside the clinic network: %s %s", ip, path)
        return PlainTextResponse("Not Found", 404)        # looks exactly like a page that does not exist
    if request.method in UNSAFE:
        cl = request.headers.get("content-length")
        if cl is None or not cl.isdigit():
            return JSONResponse({"error": "Request size is required."}, 411)
        if int(cl) > SIZE_LIMIT.get(path, 200_000):
            return JSONResponse({"error": "That request is too large."}, 413)
        origin, site = request.headers.get("origin"), request.headers.get("sec-fetch-site")
        own = f"{request.url.scheme}://{request.headers.get('host', '')}"
        if (origin and origin != own) or (site and site not in ("same-origin", "none")):
            log.warning("blocked cross-site %s %s from %s (origin %s)", request.method, path, ip, origin)
            return JSONResponse({"error": "Requests from other websites are not allowed."}, 403)
    if path.startswith("/api/") and not LIMITER.allow("all", ip, 3000, 60):
        return JSONResponse({"error": "Too many requests. Please wait a minute."}, 429)
    try:
        resp = await call_next(request)
    except Exception:
        log.exception("error on %s %s", request.method, path)
        resp = JSONResponse({"error": "Something went wrong on the server. Please try again."}, 500)
    h = resp.headers
    h["Content-Security-Policy"] = csp()
    h["X-Content-Type-Options"] = "nosniff"
    h["X-Frame-Options"] = "DENY"
    h["Referrer-Policy"] = "no-referrer"
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
    h["Cross-Origin-Opener-Policy"] = "same-origin"
    h["Cross-Origin-Resource-Policy"] = "same-origin"
    if CONFIG.get("https"):
        h["Strict-Transport-Security"] = "max-age=31536000"
    if staff_path or path.startswith("/api/"):
        h["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        h["Cache-Control"] = "no-store"
    elif path == "/" or path.endswith((".html", ".js", ".css")):
        h["Cache-Control"] = "no-cache"
    if path.startswith("/api/") and not path.startswith("/api/public/state") and not path.startswith("/api/staff/state"):
        log.info("%s %s %s %s %.0fms", ip, request.method, path, resp.status_code, (time.perf_counter() - t0) * 1000)
    return resp


@app.exception_handler(RequestValidationError)
async def _bad_input(request, exc: RequestValidationError):
    err = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(x) for x in err.get("loc", [])[1:]) or "request"
    return JSONResponse({"error": M.friendly(err), "field": field}, 422)


@app.exception_handler(HTTPException)
async def _http(request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, exc.status_code)


@app.exception_handler(service.Refused)
async def _refused(request, exc: service.Refused):
    return JSONResponse({"error": exc.message}, exc.status)


async def _db_down(request, exc):
    """The database (Supabase) could not be reached or refused: a clear message, never a crash page.
    Nothing half-done is kept: every change runs in an all-or-nothing transaction."""
    logging.getLogger("bkhc").error("database error on %s: %s", request.url.path, str(exc)[:300])
    return JSONResponse({"error": "The records server cannot be reached right now. Nothing was changed. Please try again in a minute."}, 503,
                        headers={"Retry-After": "30"})


for _cls in db.DatabaseError:
    app.add_exception_handler(_cls, _db_down)


def limit(bucket: str, n: int, per: int):
    def dep(request: Request):
        if not LIMITER.allow(bucket, client_ip(request), n, per):
            raise HTTPException(429, "Too many tries. Please wait a few minutes and try again.")
    return Depends(dep)


# ---------- staff session ----------
class Staff:
    def __init__(self, user, session):
        self.user, self.session = user, session
        self.role = user["role"]

    def can(self, tab: str) -> bool:
        return tab in ROLES.get(self.role, {"tabs": []})["tabs"]


def staff(write: bool = False, tab: str | None = None, allow_must_change: bool = False):
    def dep(request: Request) -> Staff:
        # automatic background refreshes do not count as activity, so an unattended
        # screen still signs itself out after the idle time
        u, s = get_session(request.cookies.get(COOKIE), touch=request.headers.get("x-background") != "1")
        if not u:
            raise HTTPException(401, "Your session has ended. Please log in again.")
        if write and not csrf_ok(s, request.headers.get("x-csrf-token")):
            raise HTTPException(403, "Security check failed. Please reload the page and try again.")
        if u["must_change"] and not allow_must_change:
            raise HTTPException(403, "Please change your password first.")
        st = Staff(u, s)
        if tab and not st.can(tab):
            audit("denied", tab, request.url.path, actor=u["username"], role=u["role"], ip=client_ip(request))
            raise HTTPException(403, "Your account cannot do this.")
        return st
    return Depends(dep)


def set_cookie(resp: Response, token: str, request: Request):
    resp.set_cookie(COOKIE, token, httponly=True, samesite="strict", path="/", secure=request.url.scheme == "https",
                    max_age=CONFIG["session_max_hours"] * 3600)


# ---------- auth ----------
@app.post("/api/auth/login", dependencies=[limit("login", 20, 600)])
def login(inp: M.LoginIn, request: Request, response: Response):
    ip, name = client_ip(request), inp.user.strip().lower()
    # locks apply to this account FROM this address (someone else on the network cannot lock the real user out)
    ukey = f"u:{name}|{ip}"
    wait = max(lock_left(ukey), lock_left("ip:" + ip))
    if wait:
        raise HTTPException(429, f"Too many wrong tries. Please wait {wait // 60} min {wait % 60} s.")
    u = user_by_name(name)
    if not verify_pw(u["pw_hash"] if u else None, inp.password) or (u and u["disabled"]):
        lk = max(record_failure(ukey), record_failure("ip:" + ip))
        audit("login.failed", u["username"] if u else "(unknown name)", None, ip=ip)   # never log what was typed: it may be a password
        raise HTTPException(401, "Wrong username or password." + (f" Login is locked for {lk // 60 or 1} minute(s)." if lk else ""))
    clear_failures(ukey)
    clear_failures("ip:" + ip)
    token, csrf = create_session(u["id"], ip, request.headers.get("user-agent", ""))
    set_cookie(response, token, request)
    audit("login", u["username"], None, actor=u["username"], role=u["role"], ip=ip)
    return {"user": user_public(user_by_id(u["id"])), "csrf": csrf, "tabs": ROLES[u["role"]]["tabs"]}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    u, s = get_session(request.cookies.get(COOKIE))
    if u and csrf_ok(s, request.headers.get("x-csrf-token")):
        end_session(request.cookies.get(COOKIE))
        audit("logout", u["username"], None, actor=u["username"], role=u["role"], ip=client_ip(request))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request):
    u, s = get_session(request.cookies.get(COOKIE))
    if not u:
        return {"user": None}
    return {"user": user_public(u), "csrf": s["csrf"], "tabs": ROLES[u["role"]]["tabs"]}


@app.post("/api/auth/password", dependencies=[limit("pw", 10, 600)])
def change_password(inp: M.PasswordIn, request: Request, response: Response, st: Staff = staff(write=True, allow_must_change=True)):
    if not verify_pw(st.user["pw_hash"], inp.old):
        raise HTTPException(400, "The current password is not correct.")
    p = password_problem(inp.new, st.user["username"])
    if p:
        raise HTTPException(400, p)
    if inp.new == inp.old:
        raise HTTPException(400, "Choose a password different from the current one.")
    set_password(st.user["id"], inp.new, False)          # also ends every other session
    token, csrf = create_session(st.user["id"], client_ip(request), request.headers.get("user-agent", ""))
    set_cookie(response, token, request)
    audit("password.change", st.user["username"], None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"user": user_public(user_by_id(st.user["id"])), "csrf": csrf, "tabs": ROLES[st.role]["tabs"]}


# ---------- public (residents) ----------
_PUBLIC_CACHE: dict = {}


@app.get("/api/public/state", dependencies=[limit("state", 1500, 60)])
def public_state(rev: int = -1):
    r = db.rev()
    if rev == r:
        return {"rev": r, "same": True}
    key = (r, L.now()["date"])                 # the public view only changes with the data or the date
    if key not in _PUBLIC_CACHE:
        _PUBLIC_CACHE.clear()
        _PUBLIC_CACHE[key] = service.public_state()
    return {"rev": r, "state": _PUBLIC_CACHE[key], "serverTime": L.now(), "mail": mailer.enabled(), "sms": mailer.sms_enabled(), "captcha": botguard.turnstile_site_key(), "cloud": db.region() if db.PG else ""}


@app.post("/api/public/tickets", dependencies=[limit("book", 8, 600), limit("bookday", 30, 86400)])
def book(inp: M.BookIn, request: Request):
    return {"ticket": service.book(inp, client_ip(request))}


@app.get("/api/public/challenge", dependencies=[limit("challenge", 60, 600)])
def challenge():
    return botguard.new_challenge()


@app.post("/api/public/tickets/mine", dependencies=[limit("mine", 60, 60)])
def mine(inp: M.MineIn, request: Request):
    found = service.my_tickets(inp)
    # wrong codes count against the address, so ticket codes cannot be guessed by trying many
    for _ in range(len(inp.items) - len(found)):
        if not LIMITER.allow("minefail", client_ip(request), 20, 600) or not LIMITER.allow("codemiss-all", "*", 300, 600, exact=True):
            raise HTTPException(429, "Too many tries. Please wait a few minutes and try again.")
    return {"tickets": found}


@app.post("/api/public/tickets/find", dependencies=[limit("find", 10, 300)])
def find(inp: M.FindIn, request: Request):
    if not LIMITER.allow("codemiss-all", "*", 300, 600, exact=True, count=False):   # site-wide brake against guessing from many addresses
        raise HTTPException(429, "Ticket search is busy. Please try again in a few minutes, or ask at the triage desk.")
    t = service.find_ticket(inp.code)
    if not t:
        LIMITER.allow("codemiss-all", "*", 300, 600, exact=True)
        audit("ticket.find.miss", "", None, actor="resident", ip=client_ip(request))
        raise HTTPException(404, "No ticket today with that code. Check the letters and try again.")
    return {"ticket": t}


@app.post("/api/public/tickets/{tid}/cancel", dependencies=[limit("cancel", 10, 600)])
def cancel(tid: str, inp: M.CodeIn, request: Request):
    if len(tid) > 40:
        raise HTTPException(404, "Ticket not found.")
    return {"ticket": service.cancel_ticket(tid, inp.code, client_ip(request))}


@app.post("/api/public/med-requests", dependencies=[limit("medreq", 5, 600)])
def med_request(inp: M.MedReqIn, request: Request):
    return {"request": service.med_request(inp, client_ip(request))}


@app.post("/api/public/subscribe", dependencies=[limit("sub", 5, 600)])
def subscribe(inp: M.SubscribeIn, request: Request):
    status = service.subscribe(inp.email, client_ip(request), inp.website, inp.elapsed, str(request.base_url).rstrip("/"), inp.pow, inp.captcha)
    return {"ok": True, "status": status}


@app.get("/api/public/subscribe/confirm", dependencies=[limit("subconfirm", 20, 600)])
def subscribe_confirm(t: str = ""):
    ok = 10 <= len(t) <= 64 and db.confirm_subscriber(t)
    if ok:
        db.bump()
        audit("subscribe.confirmed", "", None, actor="resident")
    msg = ("You will now get email updates about schedule changes, holidays and cut-offs." if ok else
           "This link has already been used or is not valid. If you still want updates, sign up again on the website.")
    return Response(f"<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                    f"<title>Email updates · Kaligayahan Health Center</title><link rel='stylesheet' href='/styles.css'>"
                    f"<main class='wrap page'><section class='card' style='max-width:560px;margin:60px auto;text-align:center'>"
                    f"<h1>{'Subscribed' if ok else 'Link not valid'}</h1><p>{msg}</p><p><a class='btn primary' href='/'>Go to the website</a></p></section></main>",
                    media_type="text/html")


@app.post("/api/public/turned", dependencies=[limit("turned", 20, 600)])
def turned(inp: M.TurnedIn):
    service.count_turned_away(inp.svc, inp.device)
    return {"ok": True}


# ---------- staff ----------
@app.get("/api/staff/state")
def staff_state(rev: int = -1, since: int = 0, st: Staff = staff(allow_must_change=True)):
    """Full data on the first load; after that only what changed since `since` (the cursor
    returned last time), so refreshing stays fast however large the records grow."""
    r = db.rev()
    if rev == r:
        return {"rev": r, "same": True}
    if st.user["must_change"]:
        return {"rev": r, "state": service.public_state(), "serverTime": L.now(), "mail": mailer.enabled()}
    S = service.staff_state(st.role, since or None, reports=st.can("reports"))
    S["users"] = users() if st.can("users") else []
    return {"rev": r, "state": S, "serverTime": L.now()}


@app.post("/api/staff/sync", dependencies=[limit("sync", 240, 60)])
def sync(request: Request, changes: dict = Body(...), st: Staff = staff(write=True)):
    conflicts = service.apply_sync(st.user, changes, client_ip(request))
    return {"rev": db.rev(), "ok": True, "conflicts": conflicts}


@app.post("/api/staff/users")
def user_add(inp: M.UserAddIn, request: Request, st: Staff = staff(write=True, tab="users")):
    if user_by_name(inp.user):
        raise HTTPException(409, "That username is already taken.")
    pw = temp_password()
    try:
        uid = create_user(inp.user, inp.name, inp.role, pw)
    except db.IntegrityError:
        raise HTTPException(409, "That username is already taken.")
    audit("user.add", inp.user, {"role": inp.role}, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"user": user_public(user_by_id(uid)), "tempPassword": pw, "users": users()}


@app.post("/api/staff/users/{uid}/reset")
def user_reset(uid: str, request: Request, st: Staff = staff(write=True, tab="users")):
    u = user_by_id(uid)
    if not u:
        raise HTTPException(404, "Account not found.")
    pw = temp_password()
    set_password(uid, pw, True)
    audit("user.reset", u["username"], None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"user": user_public(user_by_id(uid)), "tempPassword": pw, "users": users()}


def _admins_left(excluding: str) -> int:
    with db.LOCK:
        return db.conn().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0 AND id<>?", (excluding,)).fetchone()[0]


@app.delete("/api/staff/users/{uid}")
def user_delete(uid: str, request: Request, st: Staff = staff(write=True, tab="users")):
    u = user_by_id(uid)
    if not u:
        raise HTTPException(404, "Account not found.")
    if uid == st.user["id"]:
        raise HTTPException(400, "You cannot remove your own account.")
    with db.tx():                                # check and change together, so two admins at once cannot remove the last one
        if u["role"] == "admin" and _admins_left(uid) < 1:
            raise HTTPException(400, "Keep at least one administrator account.")
        db.conn().execute("DELETE FROM users WHERE id=?", (uid,))
    audit("user.delete", u["username"], None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"users": users()}


@app.post("/api/staff/users/{uid}/role")
def user_role(uid: str, inp: M.RoleIn, request: Request, st: Staff = staff(write=True, tab="users")):
    u = user_by_id(uid)
    if not u:
        raise HTTPException(404, "Account not found.")
    with db.tx():
        if u["role"] == "admin" and inp.role != "admin" and _admins_left(uid) < 1:
            raise HTTPException(400, "Keep at least one administrator account.")
        db.conn().execute("UPDATE users SET role=? WHERE id=?", (inp.role, uid))
        db.conn().execute("DELETE FROM sessions WHERE user_id=?", (uid,))        # new role takes effect at next login
    audit("user.role", u["username"], {"from": u["role"], "to": inp.role}, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"users": users()}


@app.get("/api/staff/export")
def export(request: Request, st: Staff = staff(tab="settings")):
    S = db.load_state(decrypt=True)
    audit("data.export", "", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    body = json.dumps({"app": "bkhc", "exported": time.strftime("%Y-%m-%dT%H:%M:%S"), "data": S}, ensure_ascii=False)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="bkhc-backup-{L.now()["date"]}.json"'})


@app.post("/api/staff/restore", dependencies=[limit("restore", 5, 600)])
def restore(request: Request, payload: dict = Body(...), st: Staff = staff(write=True, tab="settings")):
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    counts = service.restore(data, bool(payload.get("keepUsers", True)), st.user["username"], client_ip(request))
    return {"ok": True, "counts": counts}


@app.post("/api/staff/backup-now", dependencies=[limit("backupnow", 6, 600)])
def backup_now(request: Request, st: Staff = staff(write=True, tab="settings")):
    p = backup.make("manual")
    audit("backup.manual", p.name, None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"ok": True, "file": p.name, "status": backup.status()}


@app.post("/api/staff/backup-test", dependencies=[limit("backuptest", 10, 600)])
def backup_test(request: Request, st: Staff = staff(write=True, tab="settings")):
    try:
        out = backup.test_latest()
    except Exception as e:
        out = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
    audit("backup.drill", out.get("file", ""), {"ok": out["ok"]}, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return out

@app.get("/api/staff/system")
def system(request: Request, st: Staff = staff(tab="settings")):
    base = str(request.base_url).rstrip("/")
    key = SECRETS["excel_feed_key"]
    return {
        "backup": backup.status(),
        "excel": {"file": str(excel.FILE), "password": SECRETS["excel_password"] if CONFIG.get("excel_password_protect", True) else "",
                  **excel.STATUS, "feeds": [{"name": n, "csv": f"{base}/api/excel/{s}.csv?key={key}", "html": f"{base}/api/excel/{s}.html?key={key}"}
                                           for n, s in excel.feed_names()],
                  "remote": bool(CONFIG.get("excel_feed_remote"))},
        "audit": verify_audit(),
        "db": {"kind": db.kind(), "region": db.region() if db.PG else "", "file": "Supabase (PostgreSQL), schema " + db.PG_SCHEMA if db.PG else str(DB_PATH), "size_kb": db.size_kb()},
        "data_dir": str(DATA), "https": bool(CONFIG.get("https")),
    }


def _messaging() -> dict:
    t = CONFIG.get("turnstile") or {}
    return {**mailer.public_settings(), "turnstile": {"siteKey": t.get("site_key", "") if isinstance(t, dict) else "", "secretSet": bool(SECRETS.get("turnstile_secret")),
                                                       "on": bool(botguard.turnstile_site_key())}}


@app.get("/api/staff/messaging")
def messaging(st: Staff = staff(tab="settings")):
    return _messaging()


@app.post("/api/staff/botguard", dependencies=[limit("msgset", 20, 600)])
def botguard_settings(inp: M.TurnstileIn, request: Request, st: Staff = staff(write=True, tab="settings")):
    CONFIG["turnstile"] = {"site_key": inp.site_key}
    if inp.secret is not None:
        SECRETS["turnstile_secret"] = inp.secret
    mailer._save()
    disk = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
    disk["turnstile"] = {"site_key": inp.site_key}
    _write_private(CONFIG_PATH, json.dumps(disk, indent=2))
    _PUBLIC_CACHE.clear()
    db.bump()
    audit("settings.turnstile", "on" if botguard.turnstile_site_key() else "off", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return _messaging()


@app.post("/api/staff/messaging/email", dependencies=[limit("msgset", 20, 600)])
def messaging_email(inp: M.EmailSettingsIn, request: Request, st: Staff = staff(write=True, tab="settings")):
    if inp.host and not inp.sender:
        raise HTTPException(400, "Enter the email address the messages come from.")
    mailer.save_email(inp.host, inp.port, inp.user, inp.password, inp.sender, inp.starttls)
    audit("settings.email", inp.host or "(off)", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    _PUBLIC_CACHE.clear()
    db.bump()
    return _messaging()


@app.post("/api/staff/messaging/sms", dependencies=[limit("msgset", 20, 600)])
def messaging_sms(inp: M.SmsSettingsIn, request: Request, st: Staff = staff(write=True, tab="settings")):
    mailer.save_sms(inp.provider, inp.api_key, inp.sender)
    audit("settings.sms", inp.provider or "(off)", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    _PUBLIC_CACHE.clear()
    db.bump()
    return _messaging()


@app.post("/api/staff/messaging/test-email", dependencies=[limit("msgtest", 6, 600)])
def messaging_test_email(inp: M.TestTo, request: Request, st: Staff = staff(write=True, tab="settings")):
    if not mailer.enabled():
        raise HTTPException(400, "Save the email settings first.")
    if "@" not in inp.to:
        raise HTTPException(400, "Enter an email address.")
    try:
        mailer.test_email(inp.to)
    except Exception as e:
        raise HTTPException(400, f"The test email could not be sent: {type(e).__name__}: {str(e)[:200]}")
    audit("settings.email.test", "", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"ok": True}


@app.post("/api/staff/messaging/test-sms", dependencies=[limit("msgtest", 6, 600)])
def messaging_test_sms(inp: M.TestTo, request: Request, st: Staff = staff(write=True, tab="settings")):
    if not mailer.sms_enabled():
        raise HTTPException(400, "Save the text-message settings first.")
    if "@" in inp.to:
        raise HTTPException(400, "Enter a mobile number (09...).")
    try:
        mailer.send_sms(inp.to, "Test message from the Barangay Kaligayahan Health Center website. Text messages work.")
    except Exception as e:
        raise HTTPException(400, f"The test text could not be sent: {type(e).__name__}: {str(e)[:200]}")
    audit("settings.sms.test", "", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"ok": True}

@app.post("/api/staff/excel-key", dependencies=[limit("feedkey", 5, 600)])
def rotate_feed_key(request: Request, st: Staff = staff(write=True, tab="settings")):
    SECRETS["excel_feed_key"] = secrets.token_urlsafe(24)
    _write_private(SECRETS_PATH, json.dumps(SECRETS, indent=2))
    audit("excel.feed.rotate", "", None, actor=st.user["username"], role=st.role, ip=client_ip(request))
    return {"ok": True}


@app.get("/api/staff/audit")
def audit_log(st: Staff = staff(tab="settings")):
    return {"entries": recent_audit(300), "check": verify_audit()}


# ---------- live Excel feed ----------
@app.get("/api/excel/{name}", dependencies=[limit("feed", 120, 60)])
def excel_feed(name: str, request: Request, key: str = ""):
    ip = client_ip(request)
    a = ip_obj(ip)
    local = bool(a and a.is_loopback) or (ip == "testclient" and TESTING)
    if not local and not CONFIG.get("excel_feed_remote"):
        raise HTTPException(403, "The Excel feed only works on the health center computer.")
    if not key or not hmac.compare_digest(key.encode("utf-8", "replace"), SECRETS["excel_feed_key"].encode()):
        raise HTTPException(403, "Wrong or missing feed key.")
    slug, _, ext = name.rpartition(".")
    if ext not in ("csv", "html"):
        raise HTTPException(404, "Not found.")
    out = excel.feed(slug, ext == "html")
    if not out:
        raise HTTPException(404, "Not found.")
    return Response(out[0], media_type=out[1] + "; charset=utf-8")


@app.get("/api/{rest:path}")
def api_404(rest: str):
    raise HTTPException(404, "Not found.")


@app.get("/staff")
def staff_portal():
    return FileResponse(str(WEBSITE / "staff.html"), media_type="text/html")


@app.get("/staff/")
def staff_portal_slash():
    return RedirectResponse("/staff", 308)


@app.get("/healthz")
def health():
    return PlainTextResponse("ok")


app.mount("/", StaticFiles(directory=str(WEBSITE), html=True), name="site")
