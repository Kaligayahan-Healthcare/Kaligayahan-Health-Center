"""Clinic rules, checked on the server (a port of the same rules in website/app.js).

The server never trusts the browser's clock or its idea of whether the queue is open: hours,
holidays, the 4:00 PM hard cut-off, slot limits and queue numbers are all decided here.
`S` is the same shape as the website's state object.
"""
from __future__ import annotations

import re
import secrets
from datetime import date as _date, datetime, timedelta, timezone

MNL = timezone(timedelta(hours=8))          # Philippine time (no daylight saving)
DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
ACTIVE = ("waiting", "called", "serving")


def now() -> dict:
    d = datetime.now(MNL)
    return {"date": d.strftime("%Y-%m-%d"), "min": d.hour * 60 + d.minute, "dow": (d.weekday() + 1) % 7,
            "ts": int(d.timestamp() * 1000)}


def to_min(t) -> int:
    parts = str(t or "0:0").split(":")
    return int(parts[0] or 0) * 60 + int((parts[1] if len(parts) > 1 else 0) or 0)


def fmt(mins) -> str:
    mins = round(mins)
    h, m = (mins // 60) % 24, mins % 60
    return f"{h % 12 or 12}:{m:02d} {'PM' if h >= 12 else 'AM'}"


def fmt_t(t) -> str:
    return fmt(to_min(t))


def fmt24(mins: int) -> str:
    return f"{mins // 60:02d}:{mins % 60:02d}"


def add_days(ds: str, n: int) -> str:
    return (_date.fromisoformat(ds) + timedelta(days=n)).isoformat()


def dow_of(ds: str) -> int:
    return (_date.fromisoformat(ds).weekday() + 1) % 7


def date_short(ds: str) -> str:
    d = _date.fromisoformat(ds)
    return d.strftime("%a, %b ") + str(d.day)


def date_long(ds: str) -> str:
    d = _date.fromisoformat(ds)
    return d.strftime("%A, %B ") + f"{d.day}, {d.year}"


# ---------- Philippine holidays (Holy Week moves with Easter) ----------
def easter(y: int) -> str:
    a, b, c = y % 19, y // 100, y % 100
    d, e, f = b // 4, b % 4, (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1
    return f"{y}-{month:02d}-{day:02d}"


_hol: dict[int, dict] = {}


def ph_holidays(y: int) -> dict:
    if y in _hol:
        return _hol[y]
    E = easter(y)
    heroes = f"{y}-08-31"
    while dow_of(heroes) != 1:
        heroes = add_days(heroes, -1)
    H = {}
    for d, n in [(f"{y}-01-01", "New Year's Day"), (add_days(E, -3), "Maundy Thursday (Holy Week)"),
                 (add_days(E, -2), "Good Friday (Holy Week)"), (add_days(E, -1), "Black Saturday (Holy Week)"),
                 (f"{y}-04-09", "Araw ng Kagitingan"), (f"{y}-05-01", "Labor Day"), (f"{y}-06-12", "Independence Day"),
                 (f"{y}-08-19", "Quezon City Day"), (f"{y}-08-21", "Ninoy Aquino Day"), (heroes, "National Heroes Day"),
                 (f"{y}-11-01", "All Saints' Day"), (f"{y}-11-02", "All Souls' Day"), (f"{y}-11-30", "Bonifacio Day"),
                 (f"{y}-12-08", "Feast of the Immaculate Conception"), (f"{y}-12-24", "Christmas Eve"),
                 (f"{y}-12-25", "Christmas Day"), (f"{y}-12-30", "Rizal Day"), (f"{y}-12-31", "Last day of the year")]:
        H[d] = n
    _hol[y] = H
    return H


# ---------- schedule ----------
def day_rule(S, ds):
    m = next((c for c in S["closures"] if c.get("date") == ds), None)
    if m:
        if m.get("type") == "hours":
            return {"hours": True, "open": m.get("open"), "close": m.get("close"), "reason": m.get("reason")}
        if m.get("type") == "open":
            return {"reopen": True, "reason": m.get("reason")}
        return {"closed": True, "reason": m.get("reason")}
    h = ph_holidays(int(ds[:4])).get(ds) if S["center"].get("autoHolidays") else None
    return {"closed": True, "reason": h, "auto": True} if h else None


def closure_on(S, ds):
    r = day_rule(S, ds)
    return r if r and r.get("closed") else None


def hours_on(S, ds):
    r = day_rule(S, ds)
    if r and r.get("hours"):
        return {"open": r["open"], "close": r["close"], "special": r["reason"]}
    return {"open": S["center"]["open"], "close": S["center"]["close"]}


def is_clinic_day(S, ds) -> bool:
    r = day_rule(S, ds)
    return (not r.get("closed")) if r else dow_of(ds) in S["center"]["days"]


def sessions_on(S, ds):
    h, out = hours_on(S, ds), []
    for s in S["center"]["sessions"]:
        start = h["open"] if to_min(s["start"]) < to_min(h["open"]) else s["start"]
        if to_min(s["cutoff"]) > to_min(h["close"]) - 60 and h.get("special"):
            cutoff = fmt24(min(to_min(s["cutoff"]), to_min(h["close"]) - 60))
        else:
            cutoff = s["cutoff"]
        if to_min(start) < to_min(cutoff):
            out.append({**s, "start": start, "cutoff": cutoff})
    return out


def next_open(S) -> str:
    n = now()
    for i in range(1, 30):
        d = add_days(n["date"], i)
        if is_clinic_day(S, d):
            return ("tomorrow" if i == 1 else date_short(d)) + ", " + fmt_t(hours_on(S, d)["open"])
    return "soon"


def center_status(S) -> dict:
    n, c = now(), S["center"]
    cl, h = closure_on(S, n["date"]), hours_on(S, n["date"])
    if c.get("force") == "closed":
        return {"open": False, "state": "closed", "reason": c.get("forceNote") or "Temporarily closed by the health center"}
    if c.get("force") == "open":
        return {"open": True, "state": "open", "reason": c.get("forceNote") or "Open today"}
    if cl:
        return {"open": False, "state": "closed", "reason": "Closed today: " + str(cl["reason"])}
    if not is_clinic_day(S, n["date"]):
        return {"open": False, "state": "closed", "reason": "No clinic today. Opens " + next_open(S)}
    if n["min"] < to_min(h["open"]):
        return {"open": False, "state": "closed", "reason": "Opens today at " + fmt_t(h["open"])}
    if n["min"] >= to_min(h["close"]):
        return {"open": False, "state": "closed", "reason": "Closed for the day. Opens " + next_open(S)}
    if c.get("lunchStart") and to_min(c["lunchStart"]) <= n["min"] < to_min(c["lunchEnd"]) and to_min(h["close"]) > to_min(c["lunchEnd"]):
        return {"open": True, "state": "lunch", "reason": "Back at " + fmt_t(c["lunchEnd"])}
    return {"open": True, "state": "open", "reason": f"Open until {fmt_t(h['close'])} today"}


def queue_state(S) -> dict:
    c, cs, n = S["center"], center_status(S), now()
    ss = sessions_on(S, n["date"])
    cut_now = c.get("cutNow")
    if cut_now and cut_now.get("date") == n["date"]:
        return {"open": False, "cut": True, "reason": f"Queue closed early today: {cut_now.get('reason')}"}
    hard = ss[-1]["cutoff"] if ss else None
    if hard and n["min"] >= to_min(hard):          # the hard daily cut-off: nothing bypasses it
        return {"open": False, "cut": True, "reason": f"Today's cut-off ({fmt_t(hard)}) has been reached. All services are closed until {next_open(S)}"}
    if c.get("demo"):
        return {"open": True, "reason": "Practice mode", "demo": True}
    if c.get("force") == "closed" or (not cs["open"] and cs["state"] == "closed"):
        return {"open": False, "reason": cs["reason"]}
    if not ss:
        return {"open": False, "reason": "No queue sessions today"}
    for s in ss:
        if to_min(s["start"]) <= n["min"] < to_min(s["cutoff"]):
            return {"open": True, "reason": f"{s['name']} queue is open until {fmt_t(s['cutoff'])}"}
    if n["min"] < to_min(ss[0]["start"]):
        return {"open": False, "reason": f"Queue numbers start at {fmt_t(ss[0]['start'])}"}
    return {"open": False, "reason": f"The queue is closed right now. Opens again {next_open(S)}"}


# ---------- queue ----------
def today_tickets(S):
    T = now()["date"]
    return [t for t in S["tickets"] if t.get("date") == T]


def line_for(S, code):
    L = [t for t in today_tickets(S) if t.get("svc") == code and t.get("status") == "waiting"]
    return sorted(L, key=lambda t: (t.get("prio") == "regular", t.get("cmin") or 0, t.get("num") or ""))


def current_for(S, code):
    return next((t for t in today_tickets(S) if t.get("svc") == code and t.get("status") in ("called", "serving")), None)


def counts(S, code):
    tt = [t for t in today_tickets(S) if t.get("svc") == code and t.get("status") != "cancelled"]
    return {"online": sum(t.get("source") == "online" for t in tt), "walkin": sum(t.get("source") == "walkin" for t in tt)}


def service_state(S, s) -> dict:
    c = counts(S, s["code"])
    left = max(0, (s.get("limit") or 0) - c["online"])
    if not s.get("open"):
        return {"ok": False, "t": "Not available today", "sub": s.get("note") or ""}
    q = queue_state(S)
    if not q["open"]:
        return {"ok": False, "t": "Closed · cut-off reached" if q.get("cut") else "Queue closed now", "sub": q["reason"]}
    if left <= 0:
        return {"ok": False, "t": "Online slots full", "sub": "Walk-ins may still be accepted at the center"}
    return {"ok": True, "t": "Accepting patients", "sub": f"{left} online slots left"}


def next_num(S, svc: str, prio: str) -> str:
    rx = re.compile(rf"^{re.escape(svc)}-\d" if prio == "regular" else rf"^{re.escape(svc)}-P\d")
    # one more than the highest number already issued today (never re-uses a deleted ticket's number)
    used = [int(m.group(1)) for t in today_tickets(S) if t.get("svc") == svc for v in (t.get("num") or "", t.get("origNum") or "")
            if rx.match(v) and (m := re.search(r"(\d+)$", v))]
    n = max(used, default=0) + 1
    return f"{svc}-{'' if prio == 'regular' else 'P'}{n:02d}"


def ahead_of(S, t) -> int:
    if t.get("status") != "waiting":
        return 0
    return next((i for i, x in enumerate(line_for(S, t["svc"])) if x["id"] == t["id"]), 0)


def est_wait(S, t) -> int:
    s = next((x for x in S["services"] if x["code"] == t["svc"]), {"avg": 10})
    return round((ahead_of(S, t) + (0.5 if current_for(S, t["svc"]) else 0)) * (s.get("avg") or 10))


CODE_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def new_code() -> str:
    return "KLG-" + "".join(secrets.choice(CODE_ALPHA) for _ in range(6))   # 31^6: hard to guess


def new_id(prefix: str = "") -> str:
    return prefix + secrets.token_hex(6)


def med_status_for(stock: int, thr: int) -> str:
    return "out" if stock <= 0 else "low" if stock <= thr else "available"


def restock_pct(S) -> int:
    return int(S["center"].get("restockPct") or 20)


def needs_reorder(S, m) -> bool:
    return (m.get("stock") or 0) <= (m.get("cap") or 0) * restock_pct(S) / 100


# ---------- default setup for a brand-new database ----------
def default_center():
    return {"open": "08:00", "close": "20:00", "days": [1, 2, 3, 4, 5, 6], "lunchStart": "12:00", "lunchEnd": "13:00",
            "sessions": [{"id": "am", "name": "Morning", "tl": "Umaga", "start": "08:00", "cutoff": "11:00"},
                         {"id": "pm", "name": "Afternoon", "tl": "Hapon", "start": "13:00", "cutoff": "19:00"}],
            "force": "auto", "forceNote": "", "lockSite": False, "demo": False, "grace": 15,
            "autoHolidays": True, "noticeDays": 1, "smsOn": False, "cutNow": None, "restockPct": 20,
            "pharmacyEmail": "pharmacy@kaligayahan.example"}


def default_services():
    return [
        {"code": "CU", "name": "General Check-up", "tl": "Konsulta", "icon": "steth", "desc": "For fever, cough, blood pressure follow-up and other common illnesses.", "avg": 12, "limit": 40, "walkin": 15, "open": True, "note": ""},
        {"code": "AR", "name": "Anti-Rabies", "tl": "Bakuna kontra rabies", "icon": "paw", "desc": "Vaccine after an animal bite or scratch. Bring your bite record card.", "avg": 10, "limit": 25, "walkin": 10, "open": True, "note": ""},
        {"code": "VX", "name": "Vaccination", "tl": "Bakuna / Immunization", "icon": "syringe", "desc": "Child immunization, flu and pneumonia vaccines for senior citizens.", "avg": 8, "limit": 40, "walkin": 15, "open": True, "note": ""},
        {"code": "PN", "name": "Prenatal Check-up", "tl": "Para sa buntis", "icon": "baby", "desc": "Check-up for pregnant women. Bring your MCH booklet.", "avg": 15, "limit": 20, "walkin": 8, "open": True, "note": ""},
        {"code": "DN", "name": "Dental", "tl": "Ngipin", "icon": "tooth", "desc": "Tooth extraction and dental check-up.", "avg": 20, "limit": 15, "walkin": 5, "open": True, "note": ""},
    ]
