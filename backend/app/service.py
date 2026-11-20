"""What each kind of user may see and change, plus the automatic jobs.

Residents never write to the database directly. They can only:
  book a queue number, view / cancel their own number (with its code),
  request a medicine, and subscribe to email updates.
Each of these is checked here against the server's own clock and rules.

Staff save their changes through `apply_sync`. Each role may change only certain kinds of
records, every record is validated, ticket codes cannot be altered, and messages can only be
added, never edited or deleted.
"""
from __future__ import annotations

import hmac
from typing import Any

from pydantic import ValidationError

from . import crypto, db, logic as L, models as M
from .security import audit, now_ms

PUBLIC_TICKET = ("id", "date", "svc", "prio", "source", "num", "origNum", "cmin", "status", "calledMin", "calledAt", "doneMin", "confirmed")
PUBLIC_REQ = ("id", "code", "date", "medId", "qty", "status")
OWN_TICKET = PUBLIC_TICKET + ("name", "age", "contact", "email", "address", "concern", "code", "val", "smsOff", "consentAt")

WRITE = {
    "admin": {"tickets", "medicines", "medRequests", "doctors", "services", "announcements", "closures", "sms", "subs", "center", "turned", "pending", "sample"},
    "bhw": {"tickets", "doctors", "announcements", "sms", "subs", "turned"},
    "pharmacy": {"medicines", "medRequests", "sms", "center.restockPct"},
}
KEEP_PERSONAL_DAYS, KEEP_RECORD_DAYS, KEEP_MESSAGE_DAYS = 90, 400, 60


class Refused(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def first_run_setup() -> None:
    if db.is_empty():
        with db.tx():
            db.kv_set("center", L.default_center())
            for s in L.default_services():
                db.upsert("services", s, "setup")
            db.kv_set("created", L.now()["date"])
            db.kv_set("sample", False)
            db.kv_set("hoursV", 2)
        db.bump()
    update_hours()


def update_hours() -> None:
    """One-time update (Nov 2026): the clinic is open until 8 PM and online queueing for the
    afternoon closes at 7 PM. Only the old default times (5 PM / 4 PM) are changed."""
    if db.kv_get("hoursV"):
        return
    c = db.kv_get("center") or {}
    changed = False
    if c.get("close") == "17:00":
        c["close"] = "20:00"
        changed = True
    for s in c.get("sessions") or []:
        if s.get("id") == "pm" and s.get("cutoff") == "16:00":
            s["cutoff"] = "19:00"
            changed = True
    with db.tx():
        if changed:
            db.kv_set("center", c)                     # every other setting is kept exactly as it was
        db.kv_set("hoursV", 2)
    if changed:
        audit("settings.hours", "center", {"close": "20:00", "afternoon_cutoff": "19:00"}, actor="system")
        db.bump()


# ---------- what the browser receives ----------
RECENT_DAYS = 45            # staff screens get full records for this many days; older ones only as report counts
SMALL_KV = ("center", "turned", "pending", "stockHist", "sample", "created")


def small_state(T: str | None = None, decrypt: bool = True, requests: bool = False) -> dict:
    """Settings, services, doctors, medicines and only today's queue: all most actions need."""
    return db.load_state(decrypt, tickets_from=T or L.now()["date"], sms=False, requests=requests)


def public_state() -> dict:
    T = L.now()["date"]
    S = small_state(T, decrypt=False)
    center = {k: v for k, v in (S["center"] or {}).items() if k != "pharmacyEmail"}
    return {"v": 2, "rev": 3, "center": center, "services": S["services"], "doctors": S["doctors"], "medicines": S["medicines"],
            "closures": S["closures"], "announcements": S["announcements"], "pending": S["pending"], "sample": S["sample"],
            "created": S["created"], "tickets": [{k: t.get(k) for k in PUBLIC_TICKET} for t in S["tickets"] if t.get("date") == T],
            "medRequests": [], "sms": [], "subs": [], "turned": {}, "monthly": [], "stockHist": {}, "users": []}


def _for_role(role: str, coll: str, items: list) -> list:
    if coll == "tickets" and role == "pharmacy":
        return [{k: t.get(k) for k in PUBLIC_TICKET} for t in items]
    if coll == "sms" and role == "pharmacy":
        return [m for m in items if m.get("num") == "STOCK" or str(m.get("num", "")).startswith("REQ-")]
    if coll == "medRequests" and role == "bhw":
        return [{k: r.get(k) for k in PUBLIC_REQ} for r in items]
    return items


def staff_state(role: str, since: int | None = None, reports: bool = False) -> dict:
    """Everything a staff screen needs. With `since`, only what changed after that moment."""
    cursor = db.stamp()                       # every change committed before this moment is included
    if since and db.tombstones_cover(since):
        out = {"delta": True, "cursor": cursor, "changes": {}, "deleted": db.deleted_since(since)}
        cut = L.add_days(L.now()["date"], -RECENT_DAYS)
        for coll in db.SCHEMA:
            rows = db.changed_since(coll, since)
            if coll == "tickets":
                rows = [{k: t.get(k) for k in db.COMPACT_TICKET} if t["date"] < cut else t for t in rows if reports or t["date"] >= cut]
            if rows:
                out["changes"][coll] = _for_role(role, coll, rows)
        empty = {"turned": {}, "pending": [], "stockHist": {}, "sample": False}
        for k in SMALL_KV:
            v = db.kv_get(k)
            out[k] = empty.get(k) if v is None and k in empty else v
        out["subs"] = [] if role == "pharmacy" else db.subscribers()
        return out
    T = L.now()["date"]
    cut = L.add_days(T, -RECENT_DAYS)
    S = db.load_state(True, tickets_from=cut, sms=600)
    if reports:
        S["tickets"] = db.compact_tickets(cut) + S["tickets"]
    months = {m["ym"]: m for m in (S["monthly"] or []) if isinstance(m, dict) and m.get("ym")}
    months.update({m["ym"]: m for m in db.monthly_history(T[:7])})
    S["monthly"] = [months[k] for k in sorted(months)][-24:]
    for coll in ("tickets", "sms", "medRequests"):
        S[coll] = _for_role(role, coll, S[coll])
    S["sms"].sort(key=lambda m: m.get("ts") or 0)
    if role == "pharmacy":
        S["subs"] = []
    S["cursor"] = cursor
    return S


# ---------- messages (simulated email / SMS, stored in the database) ----------
def channel_for(S, t) -> str | None:
    if t.get("email"):
        return "email"
    return "sms" if S["center"].get("smsOn") and t.get("contact") else None


def send(S, t, text: str) -> None:
    if t.get("smsOff"):
        return
    ch = channel_for(S, t)
    if not ch:
        return
    n = L.now()
    m = {"id": L.new_id("m"), "ts": now_ms(), "date": t.get("date") or n["date"], "ch": ch,
         "to": t["email"] if ch == "email" else t["contact"], "tid": t.get("id", ""), "num": t.get("num", ""), "text": "BKHC: " + text}
    S["sms"].append(m)
    db.upsert("sms", m, "system")


def notify_near(S, code: str) -> None:
    for i, t in enumerate(L.line_for(S, code)[:3]):
        if t.get("nNear"):
            continue
        t["nNear"] = True
        db.upsert("tickets", t, "system")
        ahead = "you are next" if i == 0 else f"{i} patient{'s' if i > 1 else ''} ahead of you"
        send(S, t, f"{t['num']}: {ahead}. Please go to the health center now and wait near the triage desk.")


def own_view(t) -> dict:
    return {k: t.get(k) for k in OWN_TICKET}


# ---------- resident actions ----------
def bot_check(website: str, elapsed: int, minimum_ms: int, pow: str = "", captcha: str = "", ip: str = "") -> None:
    """Bot screening: a hidden field people never see must stay empty, a person needs a few
    seconds to fill in a form, the browser must solve the server's puzzle (botguard), and, when
    switched on, the Cloudflare Turnstile check must pass."""
    if website:
        raise Refused("Please try again.", 400)
    if elapsed < minimum_ms:
        raise Refused("That was very fast. Please check your details, then tap the button again.", 429)
    from . import botguard
    if not botguard.check_solution(pow):
        raise Refused("The security check did not finish. Please tap the button again.", 429)
    if not botguard.check_turnstile(captcha, ip):
        raise Refused("Please complete the 'I am not a robot' check, then try again.", 429)


def count_turned_away(svc: str, device: str) -> None:
    """A resident found a service full online: count it once per device, service and day."""
    T = L.now()["date"]
    key = crypto.blind(db.KEYS.index, "turned", f"{T}:{svc}:{device}")
    S = small_state(T, decrypt=False)
    s = next((x for x in S["services"] if x["code"] == svc), None)
    if not s or not s.get("open") or L.counts(S, svc)["online"] < (s.get("limit") or 0):
        return                                     # only counted when the service really is full
    with db.tx():
        seen = db.kv_get("turnedSeen") or {}
        if seen.get("date") != T:
            seen = {"date": T, "keys": []}
        if key in seen["keys"] or len(seen["keys"]) > 5000:
            return
        seen["keys"].append(key)
        db.kv_set("turnedSeen", seen)
        turned = db.kv_get("turned") or {}
        turned[T] = int(turned.get(T, 0)) + 1
        db.kv_set("turned", turned)
    db.bump()


def book(inp: M.BookIn, ip: str) -> dict:
    bot_check(inp.website, inp.elapsed, 2000, inp.pow, inp.captcha, ip)
    with db.tx():
        T = L.now()["date"]
        S = small_state(T)
        dev = crypto.blind(db.KEYS.index, "device", inp.device)
        con = db.conn()
        # the same phone asking again (for example its first reply was lost on a weak signal): give back that ticket
        mine = con.execute("SELECT id FROM tickets WHERE date=? AND svc=? AND status IN ('waiting','called','serving') AND device_bi=?",
                           (T, inp.svc, dev)).fetchone()
        if mine:
            return {**own_view(db.get("tickets", mine[0])), "existing": True}
        q = L.queue_state(S)
        if not q["open"]:
            raise Refused("Online queueing is closed. " + q["reason"] + ".", 409)
        s = next((x for x in S["services"] if x["code"] == inp.svc), None)
        if not s:
            raise Refused("That service does not exist.")
        st = L.service_state(S, s)
        if not st["ok"]:
            raise Refused(f"{s['name']}: {st['t']}. {st.get('sub', '')}", 409)
        if inp.prio == "senior" and inp.age < 60:
            raise Refused('The senior citizen lane is for ages 60 and above. Tap "change" and choose Regular patient.')
        if inp.prio != "regular" and not inp.proof:
            raise Refused("Please choose the ID or document you will show.")
        # one active number per person per service per day: the same mobile or email from another phone
        for col, fp in (("contact_bi", crypto.blind(db.KEYS.index, "contact", inp.contact)),
                        ("email_bi", crypto.blind(db.KEYS.index, "email", inp.email))):
            if not fp:
                continue
            dup = con.execute(f"SELECT num FROM tickets WHERE date=? AND svc=? AND status IN ('waiting','called','serving') AND {db.q(col)}=?",
                              (T, s["code"], fp)).fetchone()
            if dup:
                what = {"contact_bi": "mobile number", "email_bi": "email address"}[col]
                raise Refused(f"There is already an active number ({dup[0]}) for {s['name']} today from this {what}. Only one number per person per service is allowed. "
                              "If you no longer need it, cancel it on “My ticket” first.", 409)
        code = L.new_code()
        while db.find_by_blind("tickets", "code", code, "AND date=?", (T,)):
            code = L.new_code()
        t = {"id": L.new_id("t"), "date": T, "svc": s["code"], "prio": inp.prio, "source": "online", "consentAt": now_ms(),
             "num": L.next_num(S, s["code"], inp.prio), "name": inp.name, "age": inp.age, "contact": inp.contact, "email": inp.email,
             "concern": (inp.concern or "other") if s["code"] == "CU" else "", "address": inp.address, "code": code,
             "cmin": L.now()["min"], "status": "waiting", "confirmed": False, "calledMin": None, "calledAt": None, "doneMin": None,
             "smsOff": not inp.smsOk, "val": None if inp.prio == "regular" else {"status": "pending", "proof": inp.proof}}
        db.upsert("tickets", t, "resident", extra={"device_bi": dev})
        S["tickets"].append(t)
        send(S, t, f"Your queue number is {t['num']} for {s['name']}. Code {t['code']}. {L.ahead_of(S, t)} ahead of you, about {L.est_wait(S, t)} min. "
                   "We will message you when your turn is near.")
        notify_near(S, s["code"])
    db.bump()
    audit("ticket.book", t["num"], {"svc": t["svc"], "prio": t["prio"]}, actor="resident", ip=ip)
    return own_view(t)


def _own(tid: str, code: str):
    t = db.get("tickets", tid)
    if not t or t.get("date") != L.now()["date"] or not hmac.compare_digest(str(t.get("code", "")), code):
        return None
    return t


def my_tickets(inp: M.MineIn) -> list:
    return [own_view(t) for t in (_own(i.id, i.code) for i in inp.items) if t]


def find_ticket(code: str) -> dict | None:
    code = code.upper()
    if not code.startswith("KLG-"):
        code = "KLG-" + code[3:]
    hits = db.find_by_blind("tickets", "code", code, "AND date=?", (L.now()["date"],))
    return own_view(hits[0]) if hits else None


def cancel_ticket(tid: str, code: str, ip: str) -> dict:
    with db.tx():
        t = _own(tid, code)
        if not t:
            raise Refused("Ticket not found.", 404)
        if t["status"] != "waiting":
            raise Refused("Only a number that is still waiting can be cancelled.", 409)
        t["status"] = "cancelled"
        db.upsert("tickets", t, "resident")
        S = small_state(decrypt=False)
        send(S, t, f"{t['num']} has been cancelled. Thank you.")
    db.bump()
    audit("ticket.cancel", t["num"], None, actor="resident", ip=ip)
    return own_view(t)


def med_request(inp: M.MedReqIn, ip: str) -> dict:
    bot_check(inp.website, inp.elapsed, 2000, inp.pow, inp.captcha, ip)
    if not inp.email and not inp.contact:
        raise Refused("Please enter your email address or mobile number so we can tell you when it is ready.")
    with db.tx():
        S = small_state(decrypt=False)
        if L.queue_state(S).get("cut"):
            raise Refused("Requests are closed for today: the cut-off has been reached.", 409)
        m = next((x for x in S["medicines"] if x["id"] == inp.medId), None)
        if not m:
            raise Refused("Please choose a medicine from the list.")
        T = L.now()["date"]
        for field, val in (("contact", inp.contact), ("email", inp.email)):
            if val and any(r["medId"] == inp.medId and r["status"] == "pending"
                           for r in db.find_by_blind("medRequests", field, val, "AND date=?", (T,))):
                raise Refused("You already sent a request for this medicine today. Please wait for our message.", 409)
        codes = db.conn().execute("SELECT code FROM med_requests WHERE code LIKE 'REQ-%'").fetchall()
        top = max([1040, int(db.kv_get("reqSeq", 0) or 0)] + [int(r[0][4:]) for r in codes if r[0][4:].isdigit()])
        db.kv_set("reqSeq", top + 1)            # request numbers are never reused, even after old requests are deleted
        r = {"id": L.new_id("r"), "consentAt": now_ms(), "code": f"REQ-{top + 1}", "date": T, "name": inp.name, "contact": inp.contact,
             "email": inp.email, "medId": inp.medId, "qty": inp.qty, "note": inp.note, "status": "pending"}
        db.upsert("medRequests", r, "resident")
        send(S, {"contact": r["contact"], "email": r["email"], "date": T, "id": r["id"], "num": r["code"]},
             f"We received your request {r['code']} for {m['name']} x{r['qty']}. We will message you when it is ready.")
    db.bump()
    audit("medrequest.add", r["code"], {"medicine": m["name"], "qty": r["qty"]}, actor="resident", ip=ip)
    return r


def subscribe(email: str, ip: str, website: str = "", elapsed: int = 0, base_url: str = "", pow: str = "", captcha: str = "") -> str:
    """Double opt-in: the address only starts receiving updates after its owner taps the link
    in the confirmation email (so nobody can sign up someone else's inbox)."""
    from . import mailer
    bot_check(website, elapsed, 1000, pow, captcha, ip)
    if not mailer.enabled():
        raise Refused("Email updates are not available yet. Please check this website or call the health center for schedule changes.", 409)
    with db.tx():
        token = db.add_subscriber(email)
        if token:
            S = small_state(decrypt=False)
            send(S, {"email": email, "date": L.now()["date"], "id": "", "num": "ALL"},
                 "Please confirm that you want email updates from the Barangay Kaligayahan Health Center (schedule changes, holidays "
                 f"and cut-offs). Open this link to confirm: {base_url}/api/public/subscribe/confirm?t={token}\n"
                 "If you did not ask for this, ignore this email and you will not hear from us again.")
    if token:
        db.bump()
        audit("subscribe.pending", "", None, actor="resident", ip=ip)
    return "pending" if token else "already"


# ---------- staff saves ----------
def apply_sync(user, changes: dict, ip: str) -> list[str]:
    """Returns the records that were NOT saved because someone else changed them first."""
    role = user["role"]
    allowed = WRITE.get(role, set())
    if not isinstance(changes, dict):
        raise Refused("Bad request.")
    summary: list[str] = []
    conflicts: list[str] = []
    med_changed = False
    with db.tx():
        T = L.now()["date"]
        S = small_state(T)
        code_map: dict[str, str] = {}
        num_map: dict[str, tuple[str, str]] = {}
        for coll, Model in M.COLLECTION_MODELS.items():
            ch = changes.get(coll)
            if not ch:
                continue
            if coll not in allowed:
                raise Refused(f"Your account cannot change {coll}.", 403)
            if not isinstance(ch, dict):
                raise Refused("Bad request.")
            spec = db.SCHEMA[coll]
            key = spec["key"]
            ups, dels = ch.get("upsert") or ch.get("insert") or [], ch.get("delete") or []
            if not isinstance(ups, list) or not isinstance(dels, list):
                raise Refused("Bad request.")
            if len(ups) > 3000 or len(dels) > 3000:
                raise Refused("Too many changes at once.")
            bases = ch.get("base") or {}
            if not isinstance(bases, dict) or any(not isinstance(r, dict) for r in ups):
                raise Refused("Bad request.")
            existing = db.get_many(coll, [r.get(key) for r in ups] + [k for k in dels if isinstance(k, str)])
            if coll == "sms" and dels:
                raise Refused("Messages cannot be deleted.", 403)
            for raw in ups:
                old0, base = existing.get(raw.get(key)), bases.get(raw.get(key))
                if old0 and coll != "sms" and not isinstance(base, dict):
                    conflicts.append(f"{COLL_LABEL.get(coll, coll)} {_label(coll, old0)}")   # no starting version: never overwrite blindly
                    continue
                if old0 and isinstance(base, dict) and coll != "sms":
                    # merge field by field against the version this screen started from: fields nobody
                    # else touched are applied; a field someone else changed in the meantime is a conflict
                    changed = {f: v for f, v in raw.items() if base.get(f) != v}
                    clash = [f for f, v in changed.items() if old0.get(f) != base.get(f) and old0.get(f) != v]
                    if clash:
                        conflicts.append(f"{COLL_LABEL.get(coll, coll)} {_label(coll, old0)}")
                        continue
                    if not changed:
                        continue
                    raw = {**old0, **changed}
                try:
                    rec = Model.model_validate(raw).model_dump()
                except ValidationError as e:
                    raise Refused(f"{COLL_LABEL.get(coll, coll)} “{_label(coll, raw if isinstance(raw, dict) else {})}”: {_first_error(e)}")
                old = existing.get(rec[key])
                if coll == "sms":
                    if old:
                        continue                                  # messages are add-only
                    if not known_recipient(rec["to"], S):
                        raise Refused("Messages can only be sent to patients, requesters and subscribers already in the records.", 403)
                    for a, b in code_map.items():
                        rec["text"] = rec["text"].replace(a, b)
                    if rec["tid"] in num_map:
                        rec["text"] = rec["text"].replace(*num_map[rec["tid"]])
                if coll == "tickets":
                    if rec["status"] == "called" and (not old or old["status"] != "called"):
                        rec["calledAt"] = now_ms()                # the server's clock decides the arrival deadline
                    if old:
                        rec["code"] = old["code"]                 # a ticket's code never changes
                        if rec["num"] != old["num"]:              # a new number (e.g. moved to the regular lane): keep it unique
                            same_day = S["tickets"] if rec["date"] == T else db.read_all("tickets", False, "WHERE date=?", (rec["date"],))
                            if any(t["id"] != rec["id"] and t["num"] == rec["num"] for t in same_day):
                                rec["num"] = L.next_num(S, rec["svc"], rec["prio"])
                    else:
                        clash = rec["date"] != T or db.find_by_blind("tickets", "code", rec["code"])
                        if clash:
                            new = L.new_code()
                            code_map[rec["code"]] = new
                            rec["code"] = new
                        same_day = S["tickets"] if rec["date"] == T else db.read_all("tickets", False, "WHERE date=?", (rec["date"],))
                        if any(t["date"] == rec["date"] and t["num"] == rec["num"] for t in same_day):
                            new_num = L.next_num(S, rec["svc"], rec["prio"])
                            num_map[rec["id"]] = (rec["num"], new_num)
                            rec["num"] = new_num
                        S["tickets"].append(rec)
                if coll == "medicines":
                    med_changed = True
                db.upsert(coll, rec, user["username"])
                summary.append(f"{'edit' if old else 'add'} {coll}:{_label(coll, rec)}" + (f" ({_diff(old, rec)})" if old else ""))
            for k in dels:
                if not isinstance(k, str) or len(k) > 40:
                    raise Refused("Bad id.")
                base = bases.get(k)
                if k in existing and isinstance(base, dict) and any(existing[k].get(f) != v for f, v in base.items()):
                    conflicts.append(f"{COLL_LABEL.get(coll, coll)} {_label(coll, existing[k])}")   # changed by someone else: not deleted
                    continue
                if k in existing:
                    db.delete(coll, k)
                    summary.append(f"delete {coll}:{_label(coll, existing[k])}")
                    med_changed |= coll == "medicines"
        if "subs" in changes:
            if "subs" not in allowed:
                raise Refused("Your account cannot change subscribers.", 403)
            subs = changes["subs"]
            if not isinstance(subs, list) or len(subs) > 5000:
                raise Refused("Bad subscriber list.")
            try:
                clean = [M.SubscribeIn(email=e).email for e in subs]
            except (ValidationError, TypeError):
                raise Refused("A subscriber email address is not valid.")
            db.set_subscribers(clean)
            summary.append(f"subscribers: {len(clean)}")
        kv = changes.get("kv") or {}
        if not isinstance(kv, dict):
            raise Refused("Bad request.")
        if "center" in kv:
            try:
                new_center = M.Center.model_validate(kv["center"]).model_dump()
            except ValidationError as e:
                raise Refused(f"Settings: {_first_error(e)}")
            if "center" in allowed:
                db.kv_set("center", new_center)
                summary.append(f"settings ({_diff(S['center'], new_center)})")
            elif "center.restockPct" in allowed:
                c = dict(S["center"])
                c["restockPct"] = new_center["restockPct"]
                db.kv_set("center", c)
                summary.append(f"restock level {new_center['restockPct']}%")
            else:
                raise Refused("Your account cannot change settings.", 403)
        for k, check in (("turned", M.check_turned), ("pending", M.check_pending), ("sample", bool)):
            if k in kv:
                if k not in allowed:
                    raise Refused(f"Your account cannot change {k}.", 403)
                try:
                    db.kv_set(k, check(kv[k]))
                except (ValueError, ValidationError):
                    raise Refused(f"Invalid {k}.")
                summary.append(k)
        if med_changed:
            S2 = small_state(T, decrypt=False)
            if record_stock(S2):
                db.kv_set("stockHist", S2["stockHist"])
    if summary:
        db.bump()
        audit("staff.save", "", summary[:60], actor=user["username"], role=role, ip=ip)
    if conflicts:
        audit("staff.conflict", "", conflicts[:20], actor=user["username"], role=role, ip=ip)
    return conflicts


def known_recipient(to: str, S) -> bool:
    """Staff screens may only send messages to people already in the records (or the pharmacy),
    so the clinic's email account cannot be used to write to arbitrary addresses."""
    to = "0" + to[3:] if to.startswith("+63") else to
    if to.strip().lower() == str(S["center"].get("pharmacyEmail") or "").lower():
        return True
    con = db.conn()
    for table, col, kind in (("tickets", "email_bi", "email"), ("tickets", "contact_bi", "contact"), ("med_requests", "email_bi", "email"),
                             ("med_requests", "contact_bi", "contact"), ("subscribers", "email_bi", "email")):
        fp = crypto.blind(db.KEYS.index, kind, to)
        if fp and con.execute(f"SELECT 1 FROM {db.q(table)} WHERE {db.q(col)}=? LIMIT 1", (fp,)).fetchone():
            return True
    return False


COLL_LABEL = {"tickets": "Queue ticket", "medicines": "Medicine", "medRequests": "Medicine request", "doctors": "Doctor / staff",
              "services": "Service", "announcements": "Announcement", "closures": "Special date", "sms": "Message"}


def _first_error(e: ValidationError) -> str:
    return M.friendly(e.errors()[0])


def _label(coll, rec) -> str:
    return str(rec.get("num") or rec.get("code") or rec.get("name") or rec.get("title") or rec.get("date") or rec.get("id"))[:40]


def _diff(old, new) -> str:
    if not old:
        return ""
    keys = [k for k in new if k not in ("name", "contact", "email", "address", "note", "text", "to", "code") and old.get(k) != new.get(k)]
    return ", ".join(f"{k}: {str(old.get(k))[:20]}→{str(new.get(k))[:20]}" for k in keys[:8])


def restore(data: dict, keep_users: bool, actor: str, ip: str) -> dict:
    """Replace all records with a backup made by the website's 'Download a backup' button
    (or the sample data). Everything is validated first; nothing changes if any record fails."""
    if not isinstance(data, dict) or data.get("v") != 2:
        raise Refused("This file is not a backup from this website.")
    clean: dict[str, list] = {}
    for coll, Model in M.COLLECTION_MODELS.items():
        items = data.get(coll) or []
        if not isinstance(items, list) or len(items) > 200000:
            raise Refused(f"Bad {coll} list.")
        out = []
        for raw in items:
            if coll == "sms":
                raw = {**raw, "to": raw.get("to") or "", "text": raw.get("text") or ""}
                if not raw["to"]:
                    continue
            try:
                out.append(Model.model_validate(raw).model_dump())
            except ValidationError as e:
                raise Refused(f"A {coll} record is not valid ({_first_error(e)}). Nothing was changed.")
        clean[coll] = out
    try:
        center = M.Center.model_validate(data.get("center") or {}).model_dump()
        turned = M.check_turned(data.get("turned") or {})
        pending = M.check_pending(data.get("pending") or [])
        subs = [M.SubscribeIn(email=e).email for e in (data.get("subs") or [])]
    except (ValueError, ValidationError) as e:
        raise Refused(f"The settings in this file are not valid. Nothing was changed. ({str(e)[:120]})")
    monthly = M.check_monthly(data.get("monthly"))
    stock_hist = M.check_stock_hist(data.get("stockHist"))
    from . import backup
    backup.make("before-restore")
    with db.tx():
        c = db.conn()
        for coll, spec in db.SCHEMA.items():
            c.execute(f"DELETE FROM {db.q(spec['table'])}")
            for rec in clean[coll]:
                db.upsert(coll, rec, actor)
        db.set_subscribers(subs)
        db.kv_set("center", center)
        db.kv_set("turned", turned)
        db.kv_set("pending", pending)
        db.kv_set("monthly", monthly[:60])
        db.kv_set("stockHist", stock_hist)
        db.kv_set("sample", bool(data.get("sample")))
        db.kv_set("created", data.get("created") if isinstance(data.get("created"), str) else L.now()["date"])
    db.bump()
    counts = {k: len(v) for k, v in clean.items()}
    audit("data.restore", "", {"counts": counts, "keepUsers": keep_users}, actor=actor, role="admin", ip=ip)
    return counts


# ---------- automatic jobs (run every few seconds by the server) ----------
def record_stock(S) -> bool:
    T, ch = L.now()["date"], False
    hist = S.get("stockHist")
    if not isinstance(hist, dict):
        hist, ch = {}, True
    S["stockHist"] = hist
    for m in S["medicines"]:
        h = hist.get(m["id"])
        if not isinstance(h, dict):
            h = hist[m["id"]] = {}
            ch = True
        if h.get(T) != m["stock"]:
            h[T] = m["stock"]
            ch = True
        for d in sorted(h)[:-30]:
            del h[d]
            ch = True
    for mid in [k for k in hist if k not in {m["id"] for m in S["medicines"]}]:
        del hist[mid]
        ch = True
    return ch


def tick() -> bool:
    """The automatic jobs. Each runs on its own: a problem in one is logged and never stops the others."""
    import logging
    log = logging.getLogger("bkhc")
    changed = False
    with db.tx():
        n = L.now()
        T = n["date"]
        S = small_state(T)
        g = (S["center"].get("grace") or 15) * 60000

        def close_tickets():
            ch = False
            # earlier days still open (left waiting / being served when the day ended)
            stale = db.read_all("tickets", True, "WHERE date < ? AND status IN ('waiting','called','serving')", (T,))
            for t in list(S["tickets"]) + stale:
                if t["date"] == T and t["status"] == "called" and t.get("calledAt") and now_ms() - t["calledAt"] > g:
                    t["status"], t["voidAuto"] = "void", True
                    db.upsert("tickets", t, "system")
                    send(S, t, f"{t['num']} was voided because you did not arrive within {S['center'].get('grace', 15)} minutes after being called. "
                               "You may get a new number or ask at the triage desk.")
                    notify_near(S, t["svc"])
                    ch = True
                elif t["date"] < T and t["status"] in ("waiting", "called"):
                    t["status"], t["voidAuto"] = "void", True
                    db.upsert("tickets", t, "system")
                    ch = True
                elif t["date"] < T and t["status"] == "serving":
                    t["status"] = "served"
                    db.upsert("tickets", t, "system")
                    ch = True
            return ch

        def planned_changes():
            ch = False
            due = [p for p in S["pending"] if p["effective"] <= T]
            if due:
                for p in sorted(due, key=lambda x: x["effective"]):
                    S["center"]["sessions"] = [{**s, **(p["sessions"][i] if i < len(p["sessions"]) else {})} for i, s in enumerate(S["center"]["sessions"])]
                db.kv_set("pending", [p for p in S["pending"] if p["effective"] > T])
                ch = True
            if S["center"].get("cutNow") and S["center"]["cutNow"].get("date", T) < T:
                S["center"]["cutNow"] = None
                ch = True
            if ch:
                db.kv_set("center", S["center"])
            return ch

        def stock():
            ch = False
            if record_stock(S):
                db.kv_set("stockHist", S["stockHist"])
                ch = True
            low = [m for m in S["medicines"] if L.needs_reorder(S, m)]
            if low and S.get("lastRestockMail") != T and n["min"] >= 7 * 60:
                db.kv_set("lastRestockMail", T)
                text = (f"BKHC: Restock reminder — {len(low)} medicine{'s are' if len(low) > 1 else ' is'} at or below {L.restock_pct(S)}% of full stock: "
                        + "; ".join(f"{x['name']} {x['stock']}/{x['cap']}" for x in low) + ".")[:990]
                db.upsert("sms", {"id": L.new_id("m"), "ts": now_ms(), "date": T, "ch": "email", "tid": "", "num": "STOCK", "text": text,
                                  "to": S["center"].get("pharmacyEmail") or "pharmacy@kaligayahan.example"}, "system")
                ch = True
            return ch

        def clean_up():
            if S.get("lastTrim") == T:
                return False
            if trim_old(S):                       # done in small batches, so the site never stalls
                db.kv_set("lastTrim", T)
            return True

        for job in (close_tickets, planned_changes, stock, clean_up):
            try:
                changed |= bool(job())
            except Exception:
                log.exception("automatic job %s failed", job.__name__)
    if changed:
        db.bump()
    return changed

TRIM_BATCH = 1000


def trim_old(S) -> bool:
    """Personal details are removed from records older than 90 days (counts stay for reports);
    records older than 400 days and messages older than 60 days are deleted.
    Works in batches; returns True when nothing is left to do."""
    T = L.now()["date"]
    p_cut, r_cut, m_cut = L.add_days(T, -KEEP_PERSONAL_DAYS), L.add_days(T, -KEEP_RECORD_DAYS), L.add_days(T, -KEEP_MESSAGE_DAYS)
    con, more = db.conn(), False

    def ids(sql, args):
        nonlocal more
        rows = [r[0] for r in con.execute(sql + " LIMIT ?", (*args, TRIM_BATCH)).fetchall()]
        more |= len(rows) == TRIM_BATCH
        return rows

    for i in ids("SELECT id FROM tickets WHERE date < ?", (r_cut,)):
        db.delete("tickets", i)
    old = db.read_all("tickets", True, "WHERE date < ? AND (anon IS NULL OR anon = 0) LIMIT ?", (p_cut, TRIM_BATCH))
    more |= len(old) == TRIM_BATCH
    for t in old:
        t.update({"name": "(removed)", "contact": "", "email": "", "address": "", "anon": True})
        db.upsert("tickets", t, "system")
    for i in ids("SELECT id FROM messages WHERE date < ?", (m_cut,)):
        db.delete("sms", i)
    for i in ids("SELECT id FROM med_requests WHERE status IN ('claimed','cancelled') AND date < ?", (p_cut,)):
        db.delete("medRequests", i)
    old = db.read_all("medRequests", True, "WHERE date < ? AND (anon IS NULL OR anon = 0) LIMIT ?", (p_cut, TRIM_BATCH))
    more |= len(old) == TRIM_BATCH
    for r in old:
        r.update({"name": "(removed)", "contact": "", "email": "", "note": "", "anon": True})
        db.upsert("medRequests", r, "system")
    turned = {d: v for d, v in (S["turned"] or {}).items() if d >= r_cut}
    if turned != S["turned"]:
        db.kv_set("turned", turned)
    con.execute("DELETE FROM login_failures WHERE last<?", (now_ms() - 7 * 24 * 3600000,))
    db.prune_tombstones()
    return not more
