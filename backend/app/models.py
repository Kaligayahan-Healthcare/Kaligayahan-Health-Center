"""Strict validation for everything that comes in.

Every field has a type, a length limit and, where possible, a fixed list of allowed values or a
pattern. Unknown fields are dropped. Control characters are removed from text. Anything that
does not pass is rejected before it reaches the database.
"""
from __future__ import annotations

import re
from typing import Annotated, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, model_validator

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩]")


def _clean(s: str) -> str:
    return _CTRL.sub("", s).strip()


def Text(n: int):
    return Annotated[str, StringConstraints(max_length=n), AfterValidator(_clean)]


def Pat(p: str, n: int = 40):
    return Annotated[str, StringConstraints(pattern=p, max_length=n)]


Id = Pat(r"^[A-Za-z0-9_-]{1,40}$")
Date = Pat(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$", 10)
Time = Pat(r"^([01]\d|2[0-3]):[0-5]\d$", 5)
OptTime = Pat(r"^(([01]\d|2[0-3]):[0-5]\d)?$", 5)
SvcCode = Pat(r"^[A-Z]{2,4}$", 4)
Mobile = Annotated[str, StringConstraints(pattern=r"^((09|\+639)\d{9})?$", max_length=13), AfterValidator(lambda s: "0" + s[3:] if s.startswith("+63") else s)]   # +639... and 09... are the same number
Email = Annotated[str, StringConstraints(max_length=120, pattern=r"^([^\s@<>\"'`]+@[^\s@<>\"'`]+\.[^\s@<>\"'`]{2,})?$"), AfterValidator(lambda s: s.lower())]
Int = lambda lo, hi: Annotated[int, Field(ge=lo, le=hi)]
Ms = Annotated[int, Field(ge=0, le=10**14)]           # a time stamp in milliseconds
Mins = Annotated[int, Field(ge=0, le=24 * 60 * 2)]    # minutes after midnight (values past midnight allowed)


class Strict(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=False)


# ---------- records the staff pages save ----------
class Validation(Strict):
    status: Literal["pending", "approved", "rejected"]
    proof: Text(80) = ""


class Ticket(Strict):
    id: Id
    date: Date
    svc: SvcCode
    prio: Literal["senior", "pwd", "pregnant", "regular"]
    source: Literal["online", "walkin"]
    num: Pat(r"^[A-Z]{2,4}-P?\d{1,4}$", 12)
    origNum: Optional[Pat(r"^[A-Z]{2,4}-P?\d{1,4}$", 12)] = None
    origPrio: Optional[Literal["senior", "pwd", "pregnant", "regular"]] = None
    name: Text(80)
    age: Optional[Int(0, 120)] = None
    contact: Mobile = ""
    email: Email = ""
    address: Text(120) = ""
    concern: Optional[Literal["", "fever", "cough", "bp", "sugar", "diarrhea", "wound", "other"]] = ""
    code: Pat(r"^KLG-[A-Z0-9]{5,6}$", 10)
    cmin: Mins
    status: Literal["waiting", "called", "serving", "served", "void", "cancelled"]
    confirmed: Optional[bool] = False
    calledMin: Optional[Mins] = None
    calledAt: Optional[Ms] = None
    doneMin: Optional[Mins] = None
    voidAuto: Optional[bool] = None
    nNear: Optional[bool] = None
    smsOff: Optional[bool] = None
    consentAt: Optional[Ms] = None
    anon: Optional[bool] = None
    val: Optional[Validation] = None


class Medicine(Strict):
    id: Id
    name: Text(80)
    form: Text(30) = ""
    stock: Int(0, 10_000_000)
    cap: Int(1, 10_000_000)
    thr: Int(0, 10_000_000)
    freq: Int(0, 10_000_000) = 0
    use: Text(200) = ""
    status: Literal["available", "low", "out"]
    updated: Optional[Date] = None


class MedRequest(Strict):
    id: Id
    code: Pat(r"^REQ-\d{1,7}$", 11)
    date: Date
    name: Text(80)
    contact: Mobile = ""
    email: Email = ""
    medId: Id
    qty: Int(1, 100_000)
    note: Text(300) = ""
    status: Literal["pending", "ready", "forwarded", "claimed", "cancelled"]
    consentAt: Optional[Ms] = None
    anon: Optional[bool] = None


class Leave(Strict):
    id: Id
    first: Date
    last: Date
    reason: Text(120) = ""


class Doctor(Strict):
    id: Id
    name: Text(80)
    role: Text(100) = ""
    days: list[Int(0, 6)] = Field(max_length=7)
    start: Time
    end: Time
    available: bool
    limit: Int(0, 1000)
    note: Text(200) = ""
    leaves: Optional[list[Leave]] = Field(default=None, max_length=60)   # days off / leave periods

    @model_validator(mode="after")
    def _leave_order(self):
        self.leaves = sorted([l for l in (self.leaves or []) if l.first <= l.last], key=lambda l: l.first)
        return self


class Service(Strict):
    code: SvcCode
    name: Text(60)
    tl: Text(60) = ""
    icon: Pat(r"^[a-z]{1,20}$", 20)
    desc: Text(300) = ""
    avg: Int(1, 240)
    limit: Int(0, 1000)
    walkin: Int(0, 1000)
    open: bool
    note: Text(200) = ""


class Announcement(Strict):
    id: Id
    type: Literal["leave", "schedule", "cutoff", "advisory", "general"]
    title: Text(150)
    body: Text(2000) = ""
    date: Date
    pinned: bool = False


class Closure(Strict):
    id: Id
    date: Date
    type: Literal["closed", "hours", "open"]
    open: OptTime = ""
    close: OptTime = ""
    reason: Text(200) = ""


class Message(Strict):
    id: Id
    ts: Ms
    date: Date
    ch: Literal["email", "sms"]
    to: Annotated[str, StringConstraints(max_length=120, pattern=r"^([^\s@<>\"'`]+@[^\s@<>\"'`]+\.[^\s@<>\"'`]{2,}|(09|\+639)\d{9})$")]
    tid: Text(40) = ""
    num: Text(20) = ""
    text: Text(1000)


class Session(Strict):
    id: Pat(r"^[a-z]{1,10}$", 10)
    name: Text(30)
    tl: Text(30) = ""
    start: Time
    cutoff: Time


class CutNow(Strict):
    date: Date
    reason: Text(200)
    at: Optional[Mins] = None


class Center(Strict):
    open: Time
    close: Time
    days: list[Int(0, 6)] = Field(max_length=7)
    lunchStart: OptTime = ""
    lunchEnd: OptTime = ""
    sessions: list[Session] = Field(min_length=1, max_length=4)
    force: Literal["auto", "open", "closed"] = "auto"
    forceNote: Text(200) = ""
    lockSite: bool = False
    demo: bool = False
    grace: Int(3, 60) = 15
    autoHolidays: bool = True
    noticeDays: Int(1, 14) = 1
    smsOn: bool = False
    cutNow: Optional[CutNow] = None
    restockPct: Int(5, 60) = 20
    pharmacyEmail: Email = ""

    @model_validator(mode="after")
    def _sane_hours(self):
        tm = lambda v: int(v[:2]) * 60 + int(v[3:5])
        if tm(self.close) <= tm(self.open):
            raise ValueError("closing time must be later than opening time")
        self.sessions.sort(key=lambda s: tm(s.start))          # the last session is always the latest (hard cut-off)
        if any(tm(s.cutoff) <= tm(s.start) for s in self.sessions):
            raise ValueError("each cut-off must be later than its start time")
        return self


class Pending(Strict):
    id: Id
    effective: Date
    sessions: list[dict] = Field(max_length=4)
    reason: Text(200) = ""
    created: Optional[Date] = None


COLLECTION_MODELS = {"tickets": Ticket, "medicines": Medicine, "medRequests": MedRequest, "doctors": Doctor,
                     "services": Service, "announcements": Announcement, "closures": Closure, "sms": Message}


def check_pending(items: list) -> list:
    out = []
    for p in items[:20]:
        x = Pending.model_validate(p).model_dump()
        x["sessions"] = [{"start": _time(s.get("start")), "cutoff": _time(s.get("cutoff"))} for s in x["sessions"]]
        out.append(x)
    return out


def _time(v) -> str:
    if not isinstance(v, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
        raise ValueError("bad time")
    return v


def check_turned(d: dict) -> dict:
    if not isinstance(d, dict) or len(d) > 1000:
        raise ValueError("bad turned-away counts")
    out = {}
    for k, v in d.items():
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(k)) or not isinstance(v, int) or not 0 <= v <= 100000:
            raise ValueError("bad turned-away counts")
        out[k] = v
    return out


# ---------- forms residents send ----------
class BookIn(Strict):
    svc: SvcCode
    prio: Literal["senior", "pwd", "pregnant", "regular"]
    name: Annotated[str, StringConstraints(min_length=3, max_length=80), AfterValidator(_clean)]
    age: Int(0, 120)
    contact: Mobile = ""
    email: Email = ""
    address: Annotated[str, StringConstraints(min_length=1, max_length=120), AfterValidator(_clean)]
    concern: Literal["", "fever", "cough", "bp", "sugar", "diarrhea", "wound", "other"] = ""
    proof: Text(80) = ""
    resident: Literal[True]
    consent: Literal[True]
    smsOk: bool = True
    device: Pat(r"^[A-Za-z0-9_-]{16,64}$", 64)
    website: Text(200) = ""       # hidden field: people leave it empty, simple bots fill it in
    elapsed: Int(0, 86_400_000) = 0  # how long the form was open (ms)
    pow: Annotated[str, StringConstraints(max_length=300)] = ""     # the solved anti-bot puzzle
    captcha: Annotated[str, StringConstraints(max_length=2048)] = ""  # Cloudflare Turnstile answer (when switched on)


class TicketKey(Strict):
    id: Id
    code: Pat(r"^KLG-[A-Z0-9]{5,6}$", 10)


class MineIn(Strict):
    items: list[TicketKey] = Field(max_length=20)


class FindIn(Strict):
    code: Pat(r"^KLG-?[A-Za-z0-9]{5,6}$", 10)


class CodeIn(Strict):
    code: Pat(r"^KLG-[A-Z0-9]{5,6}$", 10)


class MedReqIn(Strict):
    medId: Id
    qty: Int(1, 1000)
    name: Annotated[str, StringConstraints(min_length=3, max_length=80), AfterValidator(_clean)]
    contact: Mobile = ""
    email: Email = ""
    note: Text(300) = ""
    consent: Literal[True]
    website: Text(200) = ""
    elapsed: Int(0, 86_400_000) = 0
    pow: Annotated[str, StringConstraints(max_length=300)] = ""
    captcha: Annotated[str, StringConstraints(max_length=2048)] = ""


class SubscribeIn(Strict):
    email: Annotated[str, StringConstraints(min_length=6, max_length=120, pattern=r"^[^\s@<>\"'`]+@[^\s@<>\"'`]+\.[^\s@<>\"'`]{2,}$"), AfterValidator(lambda s: s.lower())]
    website: Text(200) = ""
    elapsed: Int(0, 86_400_000) = 0
    pow: Annotated[str, StringConstraints(max_length=300)] = ""
    captcha: Annotated[str, StringConstraints(max_length=2048)] = ""


class TurnedIn(Strict):
    svc: SvcCode
    device: Pat(r"^[A-Za-z0-9_-]{16,64}$", 64)


# ---------- staff forms ----------
class LoginIn(Strict):
    user: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=200)]


class PasswordIn(Strict):
    old: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    new: Annotated[str, StringConstraints(min_length=1, max_length=200)]


Role = Literal["admin", "bhw", "pharmacy"]


class UserAddIn(Strict):
    name: Annotated[str, StringConstraints(min_length=2, max_length=60), AfterValidator(_clean)]
    user: Pat(r"^[a-z0-9.]{3,20}$", 20)
    role: Role


class RoleIn(Strict):
    role: Role


# ---------- plain-language messages for rejected input ----------
LABELS = {"name": "Name", "title": "Title", "body": "Message", "note": "Note", "reason": "Reason", "forceNote": "Notice text",
          "address": "Address / purok", "email": "Email address", "contact": "Mobile number", "role": "Role / specialty", "use": "What it is for",
          "age": "Age", "qty": "Quantity", "limit": "Limit per day", "walkin": "Walk-in slots", "avg": "Average minutes", "stock": "Stock on hand",
          "cap": "Full stock", "thr": "Low-stock level", "start": "Start time", "end": "End time", "open": "Opening time", "close": "Closing time",
          "code": "Code", "user": "Username", "password": "Password", "new": "New password", "old": "Current password", "grace": "Grace period",
          "text": "Message text", "days": "Duty days", "desc": "Description", "to": "Recipient", "proof": "ID to show", "svc": "Service",
          "prio": "Patient type", "cutoff": "Cut-off time", "restockPct": "Restock level", "noticeDays": "Notice days", "medId": "Medicine",
          "lunchStart": "Lunch start", "lunchEnd": "Lunch end", "pharmacyEmail": "Pharmacy email", "freq": "Used per month", "form": "Form"}
SPECIAL = {"consent": "Please tick the box to agree to the Privacy Notice.",
           "resident": "Online queueing is for Barangay Kaligayahan residents. Please tick the box to continue."}


def friendly(err: dict) -> str:
    loc = [str(x) for x in err.get("loc", []) if not isinstance(x, int) and x != "body"]
    field = loc[-1] if loc else "request"
    if field in SPECIAL:
        return SPECIAL[field]
    label, t, ctx = LABELS.get(field, field), err.get("type", ""), err.get("ctx") or {}
    if t == "string_too_long":
        return f"{label} is too long (at most {ctx.get('max_length')} characters)."
    if t == "string_too_short":
        return f"{label} is too short."
    if t == "string_pattern_mismatch":
        return f"{label} is not in the expected format."
    if t in ("less_than_equal", "less_than"):
        return f"{label} must be {ctx.get('le', ctx.get('lt'))} or less."
    if t in ("greater_than_equal", "greater_than"):
        return f"{label} must be at least {ctx.get('ge', ctx.get('gt'))}."
    if t == "missing":
        return f"{label} is missing."
    if t.startswith(("int", "float")):
        return f"{label} must be a whole number."
    return f"Please check this field: {label}."

def check_monthly(v) -> list:
    """Monthly history from a backup file: only well-formed rows are kept."""
    out = []
    for m in (v if isinstance(v, list) else [])[:60]:
        if not isinstance(m, dict) or not re.fullmatch(r"\d{4}-\d{2}", str(m.get("ym", ""))):
            continue
        num = lambda x: x if isinstance(x, int) and 0 <= x <= 10_000_000 else 0
        conc = m.get("concerns") if isinstance(m.get("concerns"), dict) else {}
        out.append({"ym": m["ym"], "days": num(m.get("days")), "avg": num(m.get("avg")), "total": num(m.get("total")),
                    "concerns": {k: num(x) for k, x in conc.items() if k in ("fever", "cough", "bp", "sugar", "diarrhea", "wound", "other")}})
    return out


def check_stock_hist(v) -> dict:
    """Stock history from a backup file: {medicine id: {date: count}}; anything else is dropped."""
    out = {}
    for mid, h in (v if isinstance(v, dict) else {}).items():
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", str(mid)) or not isinstance(h, dict):
            continue
        days = {d: n for d, n in h.items() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d)) and isinstance(n, int) and 0 <= n <= 10_000_000}
        out[mid] = dict(sorted(days.items())[-30:])
    return out

# ---------- email & text-message settings (Settings page) ----------
Host = Annotated[str, StringConstraints(max_length=120, pattern=r"^([A-Za-z0-9.-]+)?$")]


class EmailSettingsIn(Strict):
    host: Host = ""
    port: Int(1, 65535) = 587
    user: Annotated[str, StringConstraints(max_length=120)] = ""
    password: Optional[Annotated[str, StringConstraints(max_length=200)]] = None   # None = keep the saved one
    sender: Email = ""
    starttls: bool = True


class SmsSettingsIn(Strict):
    provider: Literal["", "semaphore"] = ""
    api_key: Optional[Annotated[str, StringConstraints(max_length=200, pattern=r"^[A-Za-z0-9_-]*$")]] = None
    sender: Annotated[str, StringConstraints(max_length=11, pattern=r"^[A-Za-z0-9 ]*$")] = ""


class TestTo(Strict):
    to: Annotated[str, StringConstraints(max_length=120, pattern=r"^([^\s@<>\"'`]+@[^\s@<>\"'`]+\.[^\s@<>\"'`]{2,}|(09|\+639)\d{9})$")]

class TurnstileIn(Strict):
    site_key: Annotated[str, StringConstraints(max_length=100, pattern=r"^[A-Za-z0-9_-]*$")] = ""
    secret: Optional[Annotated[str, StringConstraints(max_length=200, pattern=r"^[A-Za-z0-9_.-]*$")]] = None