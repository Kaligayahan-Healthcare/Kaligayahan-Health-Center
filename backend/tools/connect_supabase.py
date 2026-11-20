"""Move the database to Supabase (or back to this computer).

    "%LOCALAPPDATA%\\KaligayahanHealthCenter\\venv\\Scripts\\python.exe" backend\\tools\\connect_supabase.py
    "%LOCALAPPDATA%\\KaligayahanHealthCenter\\venv\\Scripts\\python.exe" backend\\tools\\connect_supabase.py --back-to-local
    "%LOCALAPPDATA%\\KaligayahanHealthCenter\\venv\\Scripts\\python.exe" backend\\tools\\connect_supabase.py prod-ca-2021.crt

Easiest: double-click "Connect to Supabase.bat" (or drag Supabase's SSL certificate onto it).

Stop the server first. You are asked for the Supabase connection string (it is not shown while
you paste it and is never printed). The tool:

  1. checks the connection (encrypted with SSL),
  2. creates the private "bkhc" schema with row-level security on every table,
  3. copies every record from this computer's database into it and checks the counts,
  4. saves the connection string in secrets.json (private to this Windows user).

Personal details stay encrypted with this computer's master key, so Supabase only ever stores
scrambled values. The local database file is kept (renamed), never deleted.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import socket
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


def fail(msg: str) -> None:
    sys.exit("\n  " + msg.replace("\n", "\n  ") + "\n")


def check_url(url: str) -> str:
    url = url.strip().strip('"').strip("'")
    if not url.startswith(("postgresql://", "postgres://")):
        fail("That is not a connection string. In Supabase: Connect (top of the project page) ->\n"
             "Session pooler -> copy the URI. It starts with postgresql://")
    if "[YOUR-PASSWORD]" in url or "[" in url.split("@")[0]:
        fail("Replace [YOUR-PASSWORD] in the connection string with the database password first.")
    u = urlsplit(url)
    host, port = u.hostname or "", u.port or 5432
    if port == 6543:
        fail("This is the Transaction pooler (port 6543). Please copy the Session pooler string instead\n"
             "(Connect -> Session pooler, port 5432). The server keeps one steady connection.")
    if host.startswith("db.") and host.endswith(".supabase.co"):
        print("  Note: this is the Direct connection. It only works if this computer's internet has IPv6.\n"
              "  If the test below fails, use the Session pooler string instead (Connect -> Session pooler).")
    params = dict(parse_qsl(u.query))
    if host not in LOCAL_HOSTS:
        params["sslmode"] = "require" if params.get("sslmode") in (None, "", "disable", "allow", "prefer") else params["sslmode"]
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(params), ""))


def server_running(config) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", int(config.CONFIG.get("port", 8123)))) == 0


def save_url(config, url: str | None) -> None:
    sec = dict(config.SECRETS)
    if url:
        sec["database_url"] = url
    else:
        sec.pop("database_url", None)
    config._write_private(config.SECRETS_PATH, json.dumps(sec, indent=2))


def snapshot_local(config, dst: Path) -> bool:
    """A consistent copy of the local database file; False if there is none."""
    if not config.DB_PATH.exists():
        return False
    src = sqlite3.connect(config.DB_PATH.resolve().as_uri() + "?mode=ro", uri=True)
    out = sqlite3.connect(str(dst))
    src.backup(out)
    out.execute("PRAGMA journal_mode=DELETE")       # a single self-contained file (no -wal/-shm left behind)
    out.close()
    src.close()
    return True


def local_counts(path: Path) -> dict:
    c = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    out = {}
    for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        out[t] = c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    c.close()
    return out


def to_supabase(a) -> None:
    from app import config
    if config.SECRETS.get("database_url") and not a.yes:
        print("  This computer is already connected to a database server. Continuing replaces that connection.")
    if server_running(config):
        fail("Stop the server first (close its window), then run this again.")
    print("\n  Paste the Supabase connection string (Session pooler URI, with your database password).")
    print("  Nothing is shown while you paste. Press Enter when done.")
    url = check_url(os.environ.get("BKHC_CONNECT_URL") or getpass.getpass("  Connection string: "))

    import psycopg
    print("\n  1/4 Checking the connection...")
    try:
        with psycopg.connect(url, connect_timeout=20, prepare_threshold=None) as c:
            ver = c.execute("SHOW server_version").fetchone()[0]
            ssl_on = c.pgconn.ssl_in_use
            has = c.execute("SELECT to_regclass('bkhc.kv') IS NOT NULL").fetchone()[0]
            remote_center = has and c.execute("SELECT 1 FROM bkhc.kv WHERE key='center'").fetchone() is not None
    except Exception as e:
        msg = str(e).splitlines()[0][:220]
        hint = ""
        if "password authentication failed" in msg:
            hint = "\nThe database password is wrong. Reset it in Supabase: Project Settings -> Database -> Reset database password."
        elif "could not translate host name" in msg or "timeout" in msg.lower():
            hint = "\nCheck the internet connection, and use the Session pooler string (not Direct connection)."
        fail(f"Could not connect: {msg}{hint}")
    host = urlsplit(url).hostname
    if host not in LOCAL_HOSTS and not ssl_on:
        fail("The connection is not encrypted (SSL). Refusing to send data over it.")
    print(f"      Connected: PostgreSQL {ver}, encrypted: {'yes' if ssl_on else 'no (this computer)'}")

    tmp = config.DATA / f"move-to-supabase-{int(time.time())}.tmp"
    have_local = snapshot_local(config, tmp)
    try:
        if remote_center and have_local and not a.yes:
            print("\n  The Supabase project ALREADY has health center records.")
            print("  Type REPLACE to overwrite them with this computer's records,")
            print("  or KEEP to just connect and use the records already on Supabase.")
            ans = input("  REPLACE / KEEP: ").strip().upper()
            if ans == "KEEP":
                have_local = False
            elif ans != "REPLACE":
                fail("Cancelled. Nothing was changed.")
        os.environ["BKHC_DATABASE_URL"] = url
        from app import db
        if not db.PG:
            fail("Internal error: the database module did not switch to PostgreSQL.")
        db.SKIP_EMPTY_GUARD = True                 # this tool is what fills an empty Supabase
        print("  2/4 Creating the private schema and locking it (row-level security)...")
        db.conn()
        if have_local:
            print("  3/4 Copying the records (encrypted values are copied as they are)...")
            want = local_counts(tmp)
            got = db.import_sqlite(tmp)
            bad = {t: (want.get(t, 0), n) for t, n in got.items() if want.get(t, 0) != n}
            if bad:
                fail(f"The copy is incomplete {bad}. Nothing was switched over; the server still uses this computer.")
            print("      " + ", ".join(f"{t} {n}" for t, n in got.items() if n))
        else:
            print("  3/4 Nothing to copy (no records on this computer, or keeping the Supabase records).")
    finally:
        tmp.unlink(missing_ok=True)

    print("  4/4 Saving the connection (secrets.json, private to this Windows user)...")
    save_url(config, url)
    if have_local and config.DB_PATH.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(config.DB_PATH) + suffix)
            if p.exists():
                p.rename(Path(f"{config.DB_PATH}.moved-to-supabase-{stamp}{suffix}"))
        print(f"      The local database was kept as {config.DB_PATH.name}.moved-to-supabase-{stamp}")
    print("\n  Done. Start the server again: it now uses Supabase.")
    print("  Stronger: download Supabase's SSL certificate (Project Settings -> Database -> SSL Configuration)")
    print("  and drag it onto \"Connect to Supabase.bat\", so the server also checks it is really talking to Supabase.")
    print("  Backups still go to database\\backups on this computer every hour (a full copy of Supabase).")
    print("  Keep RECOVERY-KIT.txt safe: without the master key, the data on Supabase cannot be read by anyone.\n")


def back_to_local(a) -> None:
    from app import config
    if not config.SECRETS.get("database_url"):
        fail("This computer is not connected to Supabase; it already uses the local database.")
    if server_running(config):
        fail("Stop the server first (close its window), then run this again.")
    if config.DB_PATH.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(config.DB_PATH) + suffix)
            if p.exists():
                p.rename(Path(f"{config.DB_PATH}.replaced-{stamp}{suffix}"))
    from app import db
    print("  Copying every record from Supabase to this computer...")
    tmp = config.DATA / f"from-supabase-{int(time.time())}.tmp"
    try:
        db.export_sqlite(tmp)
        chk = sqlite3.connect(str(tmp))
        ok = chk.execute("PRAGMA integrity_check").fetchone()[0]
        chk.close()
        if ok != "ok":
            fail(f"The copy failed its check ({ok}). Nothing was switched over.")
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp.replace(config.DB_PATH)
    finally:
        tmp.unlink(missing_ok=True)
    save_url(config, None)
    print("  Done. The server now uses the database on this computer. The records on Supabase were not deleted;")
    print("  delete the Supabase project yourself when you no longer need it.\n")


def use_certificate(a) -> None:
    """Check Supabase's identity with its SSL certificate (sslmode=verify-full), not only encrypt."""
    import shutil
    from app import config
    src = Path(a.certificate.strip().strip('"'))
    url = config.SECRETS.get("database_url")
    if not url:
        fail("Connect to Supabase first (double-click \"Connect to Supabase.bat\"), then add the certificate.")
    if not src.is_file() or src.stat().st_size > 20000 or b"BEGIN CERTIFICATE" not in src.read_bytes():
        fail(f"{src} is not a certificate file. In Supabase: Project Settings -> Database -> SSL Configuration -> Download certificate.")
    if server_running(config):
        fail("Stop the server first (close its window), then run this again.")
    dst = config.DATA / "supabase-ca.crt"
    shutil.copyfile(src, dst)
    u = urlsplit(url)
    params = dict(parse_qsl(u.query))
    params.update({"sslmode": "verify-full", "sslrootcert": str(dst)})
    new = urlunsplit((u.scheme, u.netloc, u.path, urlencode(params), ""))
    import psycopg
    try:
        with psycopg.connect(new, connect_timeout=20) as c:
            c.execute("SELECT 1")
    except Exception as e:
        dst.unlink(missing_ok=True)
        fail(f"The certificate check failed, so nothing was changed: {str(e).splitlines()[0][:200]}\n"
             "Make sure it is the certificate of THIS Supabase project.")
    save_url(config, new)
    print("\n  Done. The server now checks Supabase's certificate on every connection (verify-full).")
    print("  Start the server again.\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("certificate", nargs="?", help="Supabase's SSL certificate file (.crt): check the server's identity too")
    ap.add_argument("--back-to-local", action="store_true", help="copy everything from Supabase back to this computer and stop using Supabase")
    ap.add_argument("--yes", action="store_true", help="do not ask questions (replaces records already on Supabase)")
    a = ap.parse_args()
    if a.certificate:
        use_certificate(a)
    else:
        (back_to_local if a.back_to_local else to_supabase)(a)


if __name__ == "__main__":
    main()
