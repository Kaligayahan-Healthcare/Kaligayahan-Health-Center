"""Automatic encrypted backups.

* Hourly (kept 48), daily (kept 60) and monthly (kept 24) copies of the whole database, plus one
  before every restore and whenever an administrator presses "Back up now".
* Each copy is a complete SQLite file (taken with SQLite's online-backup feature, or, when the
  data is on Supabase, copied table by table from one consistent snapshot), checked with
  PRAGMA integrity_check, compressed, then encrypted with AES-256-GCM. So the backups stay on
  this computer and OneDrive even if the Supabase account is lost. A changed
  or damaged backup file will refuse to open instead of restoring bad data.
* Copies go to <project>/database/backups (OneDrive keeps an off-site copy) and, if set in
  config.json, to a second folder such as a USB drive.
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from . import crypto, db
from .config import BACKUP_DIR, CONFIG, DATA
from .logic import MNL

KEEP = {"hourly": CONFIG["backup_hourly_keep"], "daily": CONFIG["backup_daily_keep"], "monthly": CONFIG["backup_monthly_keep"],
        "manual": 30, "before-restore": 10}
STATUS = {"last": None, "last_error": "", "mirror_error": ""}
_lock = threading.Lock()


def folders() -> list[Path]:
    out = [BACKUP_DIR]
    if CONFIG.get("backup_mirror_dir"):
        out.append(Path(CONFIG["backup_mirror_dir"]))
    return out


def make(kind: str = "manual") -> Path:
    with _lock:
        stamp = datetime.now(MNL).strftime("%Y-%m-%d_%H%M%S")
        tmp = DATA / f"backup-{stamp}.tmp"
        try:
            if db.PG:                             # Supabase: copy every table into a SQLite file (same format as before)
                db.export_sqlite(tmp)
            else:
                with db.LOCK:
                    dst = sqlite3.connect(str(tmp))
                    db.conn().backup(dst)
                    dst.execute("PRAGMA journal_mode=DELETE")
                    dst.close()
            chk = sqlite3.connect(str(tmp))
            ok = chk.execute("PRAGMA integrity_check").fetchone()[0]
            chk.close()
            if ok != "ok":
                raise RuntimeError("integrity check failed: " + str(ok))
            blob = crypto.encrypt_backup(db.KEYS.backup, tmp.read_bytes(), f"{kind} {stamp}")
        finally:
            if tmp.exists():
                tmp.unlink()
        name = f"bkhc-{kind}-{stamp}.bkhc"
        first = None
        STATUS["mirror_error"] = ""
        for i, base in enumerate(folders()):
            try:
                d = base / kind
                d.mkdir(parents=True, exist_ok=True)
                part = d / (name + ".part")
                with open(part, "wb") as f:
                    f.write(blob)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(part, d / name)
                first = first or d / name
                prune(d, kind)
            except OSError as e:
                if i == 0:
                    STATUS["last_error"] = f"Could not write backup: {e}"
                    raise
                STATUS["mirror_error"] = f"Second backup folder not available ({base}): {e.strerror or e}"
        STATUS["last"] = {"kind": kind, "file": name, "at": int(time.time() * 1000), "size": len(blob)}
        STATUS["last_error"] = ""
        return first


def prune(folder: Path, kind: str) -> None:
    files = sorted(folder.glob(f"bkhc-{kind}-*.bkhc"))
    for f in files[: max(0, len(files) - KEEP.get(kind, 30))]:
        try:
            f.unlink()
        except OSError:
            pass


def _latest(kind: str) -> str | None:
    d = BACKUP_DIR / kind
    files = sorted(d.glob(f"bkhc-{kind}-*.bkhc")) if d.exists() else []
    return files[-1].name[len(f"bkhc-{kind}-"):-5] if files else None      # "2026-11-17_093000"


def due() -> list[str]:
    n = datetime.now(MNL)
    out = []
    last_h = _latest("hourly")
    if not last_h or datetime.strptime(last_h, "%Y-%m-%d_%H%M%S").replace(tzinfo=MNL).timestamp() < time.time() - 3600:
        out.append("hourly")
    if (_latest("daily") or "")[:10] != n.strftime("%Y-%m-%d"):
        out.append("daily")
    if (_latest("monthly") or "")[:7] != n.strftime("%Y-%m"):
        out.append("monthly")
    return out


def run_due() -> None:
    for kind in due():
        try:
            make(kind)
        except Exception as e:                    # keep the site running; the status card shows the problem
            STATUS["last_error"] = f"{kind} backup failed: {e}"


def status() -> dict:
    out = {"folder": str(BACKUP_DIR), "mirror": CONFIG.get("backup_mirror_dir") or "", "kinds": {}, **STATUS}
    total = 0
    for kind in KEEP:
        d = BACKUP_DIR / kind
        files = sorted(d.glob("*.bkhc")) if d.exists() else []
        total += sum(f.stat().st_size for f in files)
        out["kinds"][kind] = {"count": len(files), "latest": files[-1].name if files else None}
    out["total_mb"] = round(total / 1048576, 2)
    return out


def test_latest() -> dict:
    """A restore drill: open the newest backup, check it completely and count what is inside,
    without touching the live database."""
    files = sorted((f for f in BACKUP_DIR.glob("*/*.bkhc")), key=lambda f: f.stat().st_mtime)
    if not files:
        raise RuntimeError("There is no backup yet.")
    f = files[-1]
    raw, label = crypto.decrypt_backup(db.KEYS.backup, f.read_bytes())
    tmp = DATA / "backup-drill.tmp"
    tmp.write_bytes(raw)
    try:
        c = sqlite3.connect(str(tmp))
        ok = c.execute("PRAGMA integrity_check").fetchone()[0]
        counts = {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("tickets", "doctors", "medicines", "announcements", "users")}
        # personal details must still open with this computer's key
        row = c.execute("SELECT id, pii FROM tickets WHERE pii IS NOT NULL LIMIT 1").fetchone()
        c.close()
        readable = True
        if row:
            try:
                crypto.unseal_json(db.KEYS.field, row[1], f"tickets:{row[0]}")
            except Exception:
                readable = False
    finally:
        tmp.unlink(missing_ok=True)
    STATUS["drill"] = {"file": f.name, "at": int(time.time() * 1000), "ok": ok == "ok" and readable}
    return {"file": f.name, "label": label, "integrity": ok, "readable": readable, "counts": counts, "ok": ok == "ok" and readable}