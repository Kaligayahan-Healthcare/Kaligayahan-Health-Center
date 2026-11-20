"""Restore the database from an encrypted backup file.

    backend\\.venv\\Scripts\\python.exe backend\\tools\\restore_backup.py <backup.bkhc>
    backend\\.venv\\Scripts\\python.exe backend\\tools\\restore_backup.py <backup.bkhc> --key     (new computer: you are asked for the master key)

Stop the server first. The current database is kept, never deleted: the local file is renamed, or,
when the data is on Supabase, a "before-restore" backup of it is made first.
"""
from __future__ import annotations

import argparse
import json
import socket
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--key", action="store_true", help="ask for the master key from RECOVERY-KIT.txt (needed on a new computer)")
    ap.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    a = ap.parse_args()

    from app import config, crypto
    import getpass
    typed = getpass.getpass("Master key from RECOVERY-KIT.txt (not shown): ").strip() if a.key else ""
    master = typed or config.SECRETS["master_key"]
    keys = crypto.Keys(master)
    try:
        raw, label = crypto.decrypt_backup(keys.backup, a.file.read_bytes())
    except Exception:
        sys.exit("This backup cannot be opened: the key is wrong or the file was changed or damaged.")
    tmp = config.DATA / "restore-check.tmp"
    tmp.write_bytes(raw)
    c = sqlite3.connect(str(tmp))
    ok = c.execute("PRAGMA integrity_check").fetchone()[0]
    n = c.execute("SELECT COUNT(*) FROM tickets").fetchone()[0]
    c.close()
    if ok != "ok":
        tmp.unlink()
        sys.exit(f"The backup's database failed its integrity check: {ok}")
    print(f"Backup: {label} - {n} queue records - integrity OK")

    port = int(config.CONFIG.get("port", 8123))
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            tmp.unlink()
            sys.exit("Stop the server first (close its window), then run this again.")
    if not a.yes and input("Replace the current database with this backup? Type YES: ").strip() != "YES":
        tmp.unlink()
        sys.exit("Cancelled. Nothing was changed.")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    from app import db as dbm
    if dbm.PG:
        from app import backup
        try:
            if not (a.key and typed != config.SECRETS["master_key"]):
                kept = backup.make("before-restore")
                print(f"The current Supabase data was saved first as {kept.name}.")
            counts = dbm.import_sqlite(tmp)
        finally:
            tmp.unlink(missing_ok=True)
        print("Copied to Supabase: " + ", ".join(f"{k} {v}" for k, v in counts.items() if v))
        kept_as = "a before-restore backup"
    else:
        db = config.DB_PATH
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(db) + suffix)
            if p.exists():
                p.rename(Path(f"{db}.replaced-{stamp}{suffix}"))
        tmp.rename(db)
        kept_as = f"{db.name}.replaced-{stamp}"
    if typed and typed != config.SECRETS["master_key"]:
        sec = dict(config.SECRETS, master_key=typed)
        config._write_private(config.SECRETS_PATH, json.dumps(sec, indent=2))
        kit = config.KIT_PATH.read_text(encoding="utf-8") if config.KIT_PATH.exists() else ""
        old = config.SECRETS["master_key"]
        config._write_private(config.KIT_PATH, kit.replace(old, typed) if old in kit else f"MASTER KEY:\n{typed}\n")
        print("The master key from the recovery kit is now in use on this computer.")
    print(f"Restored. The previous database was kept as {kept_as}. Start the server again.")


if __name__ == "__main__":
    main()
