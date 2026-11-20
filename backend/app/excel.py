"""The live Excel workbook and the live Excel feed.

1. Live workbook: "database/excel/Kaligayahan Health Center - LIVE DATA.xlsx" is rewritten a few
   seconds after every change. It is password-protected (the password is shown to
   administrators in Settings). If someone has it open in Excel, the update waits until it is
   closed.
2. Live feed: Excel can pull each sheet straight from the server and refresh itself every minute
   (Data > From Web). The feed needs a secret key and, by default, only answers this computer.

Any text that starts with = is stored as plain text, so a name like "=HYPERLINK(...)" typed into
a form can never run as a formula in Excel.
"""
from __future__ import annotations

import csv
import html
import io
import os
import threading
import time
from datetime import datetime

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .config import CONFIG, EXCEL_DIR, SECRETS
from .logic import MNL, fmt

FILE = EXCEL_DIR / "Kaligayahan Health Center - LIVE DATA.xlsx"
STATUS = {"written": None, "waiting": False, "error": "", "rows": 0}
LANE = {"senior": "Senior", "pwd": "PWD", "pregnant": "Pregnant", "regular": "Regular"}
STATUS_T = {"waiting": "Waiting", "called": "Called", "serving": "Being served", "served": "Done", "void": "No-show (voided)", "cancelled": "Cancelled"}
DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def _t(m):
    return fmt(m) if isinstance(m, int) else ""


def _ms(ms):
    return datetime.fromtimestamp(ms / 1000, MNL).strftime("%Y-%m-%d %H:%M") if ms else ""


def sheets(S, audit_rows=None) -> dict[str, tuple[list, list]]:
    svc = {s["code"]: s["name"] for s in S["services"]}
    meds = {m["id"]: m["name"] for m in S["medicines"]}
    out = {}
    out["Queue tickets"] = (
        ["Date", "Queue no.", "Service", "Lane", "Source", "Status", "Patient name", "Age", "Mobile", "Email", "Address / purok", "Reason for visit",
         "Ticket code", "Issued", "Called", "Done", "Wait (min)", "Priority ID", "ID check"],
        [[t["date"], t["num"], svc.get(t["svc"], t["svc"]), LANE.get(t["prio"], t["prio"]), "Online" if t["source"] == "online" else "Walk-in",
          STATUS_T.get(t["status"], t["status"]), t.get("name", ""), t.get("age"), t.get("contact", ""), t.get("email", ""), t.get("address", ""),
          t.get("concern", ""), t.get("code", ""), _t(t.get("cmin")), _t(t.get("calledMin")), _t(t.get("doneMin")),
          (t["calledMin"] - t["cmin"]) if isinstance(t.get("calledMin"), int) and isinstance(t.get("cmin"), int) else None,
          (t.get("val") or {}).get("proof", ""), (t.get("val") or {}).get("status", "")] for t in sorted(S["tickets"], key=lambda x: (x["date"], x.get("cmin") or 0), reverse=True)])
    by_day: dict[str, dict] = {}
    for t in S["tickets"] + S.get("old_tickets", []):
        d = by_day.setdefault(t["date"], {"n": 0, "served": 0, "void": 0, "cancelled": 0, "online": 0, "walkin": 0, "prio": 0, "wait": []})
        d["n"] += 1
        d[t["status"]] = d.get(t["status"], 0) + 1
        d[t["source"]] += 1
        d["prio"] += t["prio"] != "regular"
        if isinstance(t.get("calledMin"), int) and t["status"] != "void":
            d["wait"].append(t["calledMin"] - t["cmin"])
    out["Daily summary"] = (
        ["Date", "Patients", "Served", "No-show", "Cancelled", "Turned away", "Online", "Walk-in", "Priority lane", "Average wait (min)"],
        [[day, d["n"], d["served"], d["void"], d["cancelled"], (S.get("turned") or {}).get(day, 0), d["online"], d["walkin"], d["prio"],
          round(sum(d["wait"]) / len(d["wait"])) if d["wait"] else None] for day, d in sorted(by_day.items(), reverse=True)])
    pct = int(S["center"].get("restockPct") or 20)
    out["Medicines"] = (
        ["Medicine", "Form", "Stock on hand", "Full stock", "% of full", "Low-stock level", "Status", f"Needs restock (<= {pct}%)", "Used per month", "Last updated", "Use"],
        [[m["name"], m["form"], m["stock"], m["cap"], round(m["stock"] * 100 / m["cap"]) if m["cap"] else 0, m["thr"],
          {"available": "Available", "low": "Low stock", "out": "Out of stock"}.get(m["status"], m["status"]),
          "YES" if m["stock"] <= m["cap"] * pct / 100 else "", m.get("freq"), m.get("updated", ""), m.get("use", "")] for m in sorted(S["medicines"], key=lambda x: x["name"])])
    out["Medicine requests"] = (
        ["Request no.", "Date", "Name", "Mobile", "Email", "Medicine", "Quantity", "Status", "Note"],
        [[r["code"], r["date"], r.get("name", ""), r.get("contact", ""), r.get("email", ""), meds.get(r["medId"], r["medId"]), r["qty"], r["status"], r.get("note", "")]
         for r in sorted(S["medRequests"], key=lambda x: x["date"], reverse=True)])
    out["Doctors & staff"] = (
        ["Name", "Role", "Duty days", "Start", "End", "Available today", "Patients per day", "Note", "Days off / leave"],
        [[d["name"], d["role"], ", ".join(DAYS[x] for x in sorted(d["days"])), d["start"], d["end"], "Yes" if d["available"] else "No", d["limit"], d.get("note", ""),
          "; ".join((l["first"] if l["first"] == l["last"] else f"{l['first']} to {l['last']}") + (f" ({l['reason']})" if l.get("reason") else "")
                    for l in (d.get("leaves") or []))] for d in S["doctors"]])
    out["Services"] = (
        ["Code", "Service", "Tagalog", "Online slots / day", "Walk-in slots / day", "Avg. minutes", "Offered", "Note"],
        [[s["code"], s["name"], s["tl"], s["limit"], s["walkin"], s["avg"], "Yes" if s["open"] else "No", s.get("note", "")] for s in S["services"]])
    out["Announcements"] = (["Date", "Type", "Title", "Message", "Pinned"],
                            [[a["date"], a["type"], a["title"], a["body"], "Yes" if a["pinned"] else ""] for a in sorted(S["announcements"], key=lambda x: x["date"], reverse=True)])
    out["Special dates"] = (["Date", "Type", "Opens", "Closes", "Reason"],
                            [[c["date"], c["type"], c.get("open", ""), c.get("close", ""), c.get("reason", "")] for c in sorted(S["closures"], key=lambda x: x["date"])])
    out["Messages sent"] = (["Sent", "Channel", "To", "Queue / request no.", "Message"],
                            [[_ms(m["ts"]), m["ch"], m.get("to", ""), m.get("num", ""), m.get("text", "")] for m in sorted(S["sms"], key=lambda x: x["ts"], reverse=True)])
    out["Email subscribers"] = (["Email"], [[e] for e in S.get("subs", [])])
    if audit_rows is not None:
        out["Activity log"] = (["#", "Time", "Who", "Role", "Address", "Action", "Item", "Details"],
                               [[a["seq"], _ms(a["ts"]), a["actor"], a["role"], a["ip"], a["action"], a["target"], a["detail"]] for a in audit_rows])
    return out


def _clean(v):
    if isinstance(v, str):
        return ILLEGAL_CHARACTERS_RE.sub("", v)
    return v


def build(S, audit_rows) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    head_fill, head_font = PatternFill("solid", fgColor="1F3FCF"), Font(bold=True, color="FFFFFF")
    data = sheets(S, audit_rows)
    info = wb.create_sheet("About")
    info["A1"] = "Barangay Kaligayahan Health Center - live data"
    info["A1"].font = Font(bold=True, size=14)
    info["A3"], info["B3"] = "Updated", datetime.now(MNL).strftime("%Y-%m-%d %H:%M:%S (Philippine time)")
    info["A4"], info["B4"] = "Updates", "This file is rewritten automatically a few seconds after every change. Close and reopen it to see new data."
    info["A5"], info["B5"] = "Privacy", "Contains personal and health information. Do not share, email or print without permission."
    for i, (name, (heads, rows)) in enumerate(data.items(), start=7):
        info.cell(row=i, column=1, value=name)
        info.cell(row=i, column=2, value=f"{len(rows)} rows")
    info.column_dimensions["A"].width, info.column_dimensions["B"].width = 22, 100
    total = 0
    for name, (heads, rows) in data.items():
        ws = wb.create_sheet(name[:31])
        ws.append(heads)
        for c in ws[1]:
            c.fill, c.font, c.alignment = head_fill, head_font, Alignment(vertical="center", wrap_text=True)
        widths = [len(h) + 2 for h in heads]
        for r in rows:
            ws.append([_clean(v) for v in r])
            for j, v in enumerate(r):
                widths[j] = max(widths[j], min(60, len(str(v)) + 2 if v is not None else 0))
        for row in ws.iter_rows(min_row=2):
            for c in row:
                if isinstance(c.value, str):
                    c.data_type = "s"             # never a formula
        for j, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(j)].width = max(8, w)
        ws.freeze_panes = "A2"
        if rows:
            ws.auto_filter.ref = f"A1:{get_column_letter(len(heads))}{len(rows) + 1}"
        total += len(rows)
    STATUS["rows"] = total
    buf = io.BytesIO()
    wb.save(buf)
    raw = buf.getvalue()
    if CONFIG.get("excel_password_protect", True):
        from msoffcrypto.format.ooxml import OOXMLFile
        src, enc = io.BytesIO(raw), io.BytesIO()
        OOXMLFile(src).encrypt(SECRETS["excel_password"], enc)
        raw = enc.getvalue()
    return raw


DETAIL_DAYS = 90      # personal details are removed after 90 days anyway; older days appear in the daily summary


def _state():
    from . import db
    from .logic import add_days, now
    cut = add_days(now()["date"], -DETAIL_DAYS)
    S = db.load_state(True, tickets_from=cut)
    S["old_tickets"] = db.compact_tickets(cut)
    return S


def write_now() -> None:
    from .security import recent_audit
    data = build(_state(), recent_audit(2000))
    EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_name(FILE.stem + ".updating.tmp")
    tmp.write_bytes(data)
    try:
        os.replace(tmp, FILE)
        STATUS.update(written=int(time.time() * 1000), waiting=False, error="")
    except PermissionError:
        STATUS["waiting"] = True                  # open in Excel right now: try again shortly
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# ---------- debounced background writer ----------
_dirty = threading.Event()


def schedule() -> None:
    _dirty.set()


def worker(stop: threading.Event) -> None:
    _dirty.set()                                    # write once at start-up
    while not stop.is_set():
        if _dirty.wait(5):
            time.sleep(3)                            # gather a burst of changes into one write
            _dirty.clear()
            try:
                write_now()
                stop.wait(60)                          # at most one rebuild a minute (it runs in the background)
            except PermissionError:
                _dirty.set()
                stop.wait(20)
            except Exception as e:
                STATUS["error"] = str(e)[:300]
                stop.wait(30)


# ---------- live feed for Excel "From Web" ----------
def feed(sheet_slug: str, as_html: bool) -> tuple[str, str] | None:
    from .security import recent_audit
    data = sheets(_state(), recent_audit(2000) if sheet_slug == "activity-log" else None)
    slugs = {name.lower().replace(" & ", "-").replace(" / ", "-").replace(" ", "-"): name for name in data}
    name = slugs.get(sheet_slug)
    if not name:
        return None
    heads, rows = data[name]
    safe = lambda v: "" if v is None else ("'" + v if isinstance(v, str) and v and v[0] in "=+-@\t\r" else str(v))
    if as_html:
        body = "".join("<tr>" + "".join(f"<td>{html.escape(safe(v))}</td>" for v in r) + "</tr>" for r in rows)
        return (f"<!doctype html><meta charset='utf-8'><title>{html.escape(name)}</title><table><thead><tr>"
                + "".join(f"<th>{html.escape(h)}</th>" for h in heads) + f"</tr></thead><tbody>{body}</tbody></table>", "text/html")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(heads)
    for r in rows:
        w.writerow([safe(v) for v in r])
    return "﻿" + buf.getvalue(), "text/csv"


def feed_names() -> list[tuple[str, str]]:
    names = ["Queue tickets", "Daily summary", "Medicines", "Medicine requests", "Doctors & staff", "Services", "Announcements",
             "Special dates", "Messages sent", "Email subscribers", "Activity log"]
    return [(n, n.lower().replace(" & ", "-").replace(" / ", "-").replace(" ", "-")) for n in names]
