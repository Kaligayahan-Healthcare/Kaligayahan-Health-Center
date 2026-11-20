"""The database: Supabase (hosted PostgreSQL) or a local SQLite file, with encrypted personal details.

* Supabase is used when a database address ("database_url") is saved in secrets.json (see
  tools/connect_supabase.py). Without one, the local SQLite file is used. Both run the same code.
* Each kind of record has its own table with real typed columns. Personal details are kept
  together in one column ("pii") that is encrypted with AES-256-GCM BEFORE it leaves this
  computer, so the database (and Supabase) only ever stores scrambled values. The columns ending
  in "_bi" hold keyed fingerprints used only for exact-match lookups.
* With Supabase, Supabase holds the real data: every change is saved there first, in one
  transaction. The server also keeps a WORKING COPY (a SQLite file on this computer) that is
  refilled from Supabase at every start and receives the same changes, so pages are read
  locally (fast, and still readable during an internet outage) while nothing is ever kept only
  on this computer. Only one server may use the Supabase database at a time (a "lease").
* On Supabase the tables live in their own schema ("bkhc"), not in "public", so Supabase's
  automatic web API does not publish them. Row-level security is switched on with no rules and
  the "anon"/"authenticated" roles have no access, so the public Supabase keys cannot read
  anything. Only this server reads and writes.
* All SQL uses parameters ("?"); table and column names come only from the SCHEMA below, never
  from a request.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from . import crypto
from .config import DB_PATH, SECRETS

KEYS = crypto.Keys(SECRETS["master_key"])
LOCK = threading.RLock()
DATABASE_URL = os.environ.get("BKHC_DATABASE_URL") or SECRETS.get("database_url") or ""
PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
PG_SCHEMA = "bkhc"

# type codes: T text, I integer, B boolean, J json
SCHEMA = {
    "tickets": {
        "table": "tickets", "key": "id",
        "cols": {"id": "T", "date": "T", "svc": "T", "prio": "T", "source": "T", "num": "T", "origNum": "T", "origPrio": "T",
                 "age": "I", "concern": "T", "cmin": "I", "status": "T", "confirmed": "B", "calledMin": "I", "calledAt": "I",
                 "doneMin": "I", "voidAuto": "B", "nNear": "B", "smsOff": "B", "consentAt": "I", "anon": "B", "val": "J"},
        "pii": ["name", "contact", "email", "address", "code"],
        "bi": {"contact_bi": "contact", "email_bi": "email", "code_bi": "code"},
        "extra": {"device_bi": "T"},
        "index": ["date", "date,svc,status"],
        "rename": {"cmin": "c_min"},          # "cmin" is a reserved (system) column name in PostgreSQL
    },
    "medicines": {
        "table": "medicines", "key": "id",
        "cols": {"id": "T", "name": "T", "form": "T", "stock": "I", "cap": "I", "thr": "I", "freq": "I", "use": "T", "status": "T", "updated": "T"},
        "pii": [], "bi": {},
    },
    "medRequests": {
        "table": "med_requests", "key": "id",
        "cols": {"id": "T", "code": "T", "date": "T", "medId": "T", "qty": "I", "status": "T", "consentAt": "I", "anon": "B"},
        "pii": ["name", "contact", "email", "note"],
        "bi": {"contact_bi": "contact", "email_bi": "email"},
        "index": ["date"],
    },
    "doctors": {
        "table": "doctors", "key": "id",
        "cols": {"id": "T", "name": "T", "role": "T", "days": "J", "start": "T", "end": "T", "available": "B", "limit": "I", "note": "T", "leaves": "J"},
        "pii": [], "bi": {},
    },
    "services": {
        "table": "services", "key": "code",
        "cols": {"code": "T", "name": "T", "tl": "T", "icon": "T", "desc": "T", "avg": "I", "limit": "I", "walkin": "I", "open": "B", "note": "T"},
        "pii": [], "bi": {},
    },
    "announcements": {
        "table": "announcements", "key": "id",
        "cols": {"id": "T", "type": "T", "title": "T", "body": "T", "date": "T", "pinned": "B"},
        "pii": [], "bi": {},
    },
    "closures": {
        "table": "special_dates", "key": "id",
        "cols": {"id": "T", "date": "T", "type": "T", "open": "T", "close": "T", "reason": "T"},
        "pii": [], "bi": {},
    },
    "sms": {
        "table": "messages", "key": "id",
        "cols": {"id": "T", "ts": "I", "date": "T", "ch": "T", "tid": "T", "num": "T"},
        "pii": ["to", "text"], "bi": {},
        "index": ["date"],
    },
}
KV_KEYS = ("center", "turned", "pending", "monthly", "stockHist", "sample", "created", "lastRestockMail", "lastTrim", "lastBackup")


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def col(spec, field: str) -> str:
    """The database column that holds a record field (almost always the same name)."""
    return spec.get("rename", {}).get(field, field)


# ---------- connection ----------
class Row(tuple):
    """A result row usable both as row[0] and row["column"] (like sqlite3.Row)."""
    __slots__ = ()
    _names: list = []

    def __getitem__(self, k):
        if isinstance(k, str):
            return tuple.__getitem__(self, self._names.index(k))
        return tuple.__getitem__(self, k)

    def keys(self):
        return list(self._names)


def _row_factory(cursor):
    names = [d.name for d in cursor.description] if cursor.description else []
    cls = type("Row", (Row,), {"__slots__": (), "_names": names})
    return lambda values: cls(values)


class PgConn:
    """The same small interface as a sqlite3 connection ("?" placeholders, rows by name or number),
    on top of a PostgreSQL (Supabase) connection. Reconnects by itself after a dropped internet link."""

    def __init__(self):
        self._c = None
        self.in_tx = False
        self._open()

    def _open(self):
        import psycopg
        self._c = psycopg.connect(DATABASE_URL, autocommit=True, connect_timeout=15, prepare_threshold=None,
                                  row_factory=_row_factory, application_name="bkhc-server",
                                  keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3)
        self._c.execute("SET statement_timeout = '30s'")
        self._c.execute("SET idle_in_transaction_session_timeout = '60s'")
        self._c.execute(f"CREATE SCHEMA IF NOT EXISTS {PG_SCHEMA}")
        self._c.execute(f"SET search_path TO {PG_SCHEMA}")
        self.in_tx = False

    @staticmethod
    def _sql(sql: str) -> str:
        return sql.replace("%", "%%").replace("?", "%s")

    def execute(self, sql: str, params=()):
        import psycopg
        args = tuple(params) if params else None
        try:
            return self._c.execute(self._sql(sql), args)
        except psycopg.OperationalError:
            if self.in_tx or not (self._c.closed or self._c.broken):
                raise
        self._open()                                   # the link to the database was lost: reconnect once and retry
        return self._c.execute(self._sql(sql), args)

    def executemany(self, sql: str, rows) -> None:
        with self._c.cursor() as cur:               # sent in one batch (pipeline), not one trip per row
            cur.executemany(self._sql(sql), rows)

    def select_many(self, queries) -> list:
        """Several SELECTs sent together and answered together: one trip to Supabase instead of one each."""
        import psycopg

        def run():
            curs = []
            with self._c.pipeline():
                for sql, args in queries:
                    cur = self._c.cursor()
                    cur.execute(self._sql(sql), tuple(args) if args else None)
                    curs.append(cur)
            return [cur.fetchall() for cur in curs]
        try:
            return run()
        except psycopg.OperationalError:
            if self.in_tx or not (self._c.closed or self._c.broken):
                raise
        self._open()
        return run()

    def script(self, sql: str) -> None:
        self._c.execute(sql)

    def close(self) -> None:
        self._c.close()


class StartupRefused(RuntimeError):
    """The server must not start (another server holds the database, or Supabase is empty while
    this computer still has records). The message says what to do."""


class ServerBusy(sqlite3.OperationalError):
    """Another server took over the Supabase database: changes are refused until restart."""


WORK_PATH = DB_PATH.with_name("bkhc-working-copy.sqlite3")
LEASE_SECONDS = 90


def _open_sqlite(path) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=FULL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA secure_delete=ON")       # deleted personal data is overwritten, not left on disk
    c.execute("PRAGMA busy_timeout=15000")
    return c


def _route(sql: str) -> str:
    """Where a statement goes: 'local' (reads), 'both' (changes) or 'pg' (database administration)."""
    s = sql.lstrip()
    word = s.split(None, 1)[0].upper() if s else ""
    if word in ("INSERT", "UPDATE", "DELETE"):
        return "both"
    if word in ("SELECT", "WITH"):
        low = s.lower()
        return "pg" if ("pg_" in low or "information_schema" in low or "setval" in low or "has_schema_privilege" in low) else "local"
    if word == "PRAGMA":
        return "local"
    return "pg"


class MirrorConn:
    """Supabase + the working copy, with the same interface as a sqlite3 connection.
    Changes go to Supabase first and then to the working copy; reads come from the working copy."""

    def __init__(self, pg: "PgConn", local: sqlite3.Connection):
        self.pg, self.local = pg, local
        self.lease_lost = False

    # -- transactions (called by db.tx) --
    def begin(self) -> None:
        self._check_lease()
        self.pg.execute("BEGIN; SELECT pg_advisory_xact_lock(724100)")    # one trip; one writer at a time
        self.pg.in_tx = True
        self.local.execute("BEGIN IMMEDIATE")

    def commit(self) -> None:
        self.pg.execute("COMMIT")                  # Supabase first: only then is the change kept
        self.pg.in_tx = False
        try:
            self.local.execute("COMMIT")
        except sqlite3.Error:
            self.resync()

    def rollback(self) -> None:
        for c in (self.pg, self.local):
            try:
                c.execute("ROLLBACK")
            except Exception:
                pass
        self.pg.in_tx = False

    def _check_lease(self) -> None:
        if self.lease_lost:
            raise ServerBusy("Another copy of the server is now using the Supabase database. Restart this server.")

    def execute(self, sql: str, params=()):
        where = _route(sql)
        if where == "local":
            return self.local.execute(sql, params)
        if where == "pg":
            return self.pg.execute(sql, params)
        self._check_lease()
        with LOCK:
            if sql.lstrip().upper().startswith("INSERT INTO AUDIT_LOG"):
                # the activity log's numbering comes from Supabase, and the working copy uses the same number
                cur = self.pg.execute(sql.rstrip() + " RETURNING seq", params)
                seq = cur.fetchone()[0]
                head, rest = sql.split("(", 1)
                cols, vals = rest.split(") VALUES (", 1)
                local_sql = f"{head}(seq, {cols}) VALUES (?, {vals}"
                self._local_write(local_sql, (seq, *params))
                return cur
            cur = self.pg.execute(sql, params)
            self._local_write(sql, params)
            return cur

    def _local_write(self, sql, params) -> None:
        try:
            self.local.execute(sql, params)
        except sqlite3.Error:
            if self.pg.in_tx:
                raise                              # the whole transaction is undone on both sides
            self.resync()                          # saved on Supabase; bring the working copy back in line

    def executemany(self, sql: str, rows) -> None:
        rows = list(rows)
        self._check_lease()
        with LOCK:
            self.pg.executemany(sql, rows)
            try:
                self.local.executemany(sql, rows)
            except sqlite3.Error:
                if self.pg.in_tx:
                    raise
                self.resync()

    def resync(self, problem: bool = True) -> None:
        """Refill the working copy from Supabase (after a problem with the local file, or a restore)."""
        with LOCK:
            if problem:
                log_problem("working copy out of step; refilling it from Supabase")
            self.local.close()
            self.local = _fill_working_copy()

    def close(self) -> None:
        self.pg.close()
        self.local.close()


def log_problem(msg: str) -> None:
    import logging
    logging.getLogger("bkhc").warning(msg)


def _fill_working_copy() -> sqlite3.Connection:
    """A fresh working copy: every table copied from Supabase (one consistent snapshot)."""
    tmp = WORK_PATH.with_name(WORK_PATH.name + ".new")
    for suffix in ("", "-wal", "-shm"):
        Path(str(tmp) + suffix).unlink(missing_ok=True)
    export_sqlite(tmp)
    for suffix in ("-wal", "-shm"):
        Path(str(WORK_PATH) + suffix).unlink(missing_ok=True)
    os.replace(tmp, WORK_PATH)
    c = _open_sqlite(WORK_PATH)
    create_schema(c)
    return c


# ---------- the lease: only one server uses the Supabase database at a time ----------
_LEASE = {"owner": "", "thread": None}


def _lease_take(pg: "PgConn") -> None:
    import secrets as _s
    import socket
    host = socket.gethostname()
    owner = f"{host}:{os.getpid()}:{_s.token_hex(4)}"
    now = int(time.time() * 1000)
    pg.execute("CREATE TABLE IF NOT EXISTS server_lease (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, host TEXT, pid INTEGER, until BIGINT NOT NULL)")
    pg.execute("ALTER TABLE server_lease ENABLE ROW LEVEL SECURITY")
    pg.execute("BEGIN")
    try:
        r = pg.execute("SELECT owner, host, pid, until FROM server_lease WHERE id=1 FOR UPDATE").fetchone()
        if r and r[3] > now and r[0] != owner:
            same_pc_dead = r[1] == host and not _pid_alive(r[2])
            if not same_pc_dead:
                wait = max(1, round((r[3] - now) / 1000))
                raise StartupRefused(
                    f"Another copy of the server is using the Supabase database (computer \"{r[1]}\").\n"
                    f"Close that server first. If it was switched off or crashed, wait {wait} seconds and start again.")
        pg.execute("INSERT INTO server_lease (id, owner, host, pid, until) VALUES (1,?,?,?,?) "
                   "ON CONFLICT (id) DO UPDATE SET owner=excluded.owner, host=excluded.host, pid=excluded.pid, until=excluded.until",
                   (owner, host, os.getpid(), now + LEASE_SECONDS * 1000))
        pg.execute("COMMIT")
    except Exception:
        pg.execute("ROLLBACK")
        raise
    _LEASE["owner"] = owner
    import atexit
    atexit.register(_lease_release)
    if _LEASE["thread"] is None:
        th = threading.Thread(target=_lease_beat, name="supabase-lease", daemon=True)
        _LEASE["thread"] = th
        th.start()


def _pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if os.name == "nt":
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)      # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259                                         # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _lease_renew() -> None:
    c = _conn
    if not isinstance(c, MirrorConn) or not _LEASE["owner"]:
        return
    with LOCK:
        cur = c.pg.execute("UPDATE server_lease SET until=? WHERE id=1 AND owner=?",
                           (int(time.time() * 1000) + LEASE_SECONDS * 1000, _LEASE["owner"]))
        if cur.rowcount == 0:
            c.lease_lost = True
            log_problem("another server took over the Supabase database; changes are refused until restart")


def _lease_beat() -> None:
    while True:
        time.sleep(LEASE_SECONDS / 3)
        try:
            _lease_renew()
        except Exception as e:                       # internet down: try again at the next beat
            log_problem(f"could not renew the Supabase lease: {e}")


def _lease_release() -> None:
    c = _conn
    if isinstance(c, MirrorConn) and _LEASE["owner"]:
        try:
            with LOCK:
                c.pg.execute("DELETE FROM server_lease WHERE id=1 AND owner=?", (_LEASE["owner"],))
        except Exception:
            pass


SKIP_EMPTY_GUARD = False                 # set only by tools/connect_supabase.py, which copies the records


def _guard_empty_supabase(pg: "PgConn") -> None:
    """Never start on an empty Supabase while this computer still has the records."""
    if SKIP_EMPTY_GUARD:
        return
    if pg.execute("SELECT 1 FROM kv WHERE key='center'").fetchone():
        return
    if not DB_PATH.exists():
        return
    try:
        c = sqlite3.connect(DB_PATH.resolve().as_uri() + "?mode=ro", uri=True)
        has = c.execute("SELECT 1 FROM kv WHERE key='center'").fetchone()
        c.close()
    except sqlite3.Error:
        return
    if has:
        raise StartupRefused(
            "The Supabase database is empty, but this computer still has the health center's records\n"
            f"({DB_PATH}). Copy them first: double-click \"Connect to Supabase.bat\".")


_conn = None


def conn():
    global _conn
    if _conn is None:
        with LOCK:
            if _conn is None:
                if PG:
                    pg = PgConn()
                    create_schema(pg)
                    _guard_empty_supabase(pg)
                    _lease_take(pg)
                    _conn = MirrorConn(pg, _fill_working_copy())
                else:
                    c = _open_sqlite(DB_PATH)
                    create_schema(c)
                    _conn = c
    return _conn


def pg():
    """The Supabase connection itself (administration and checks only)."""
    c = conn()
    return c.pg if isinstance(c, MirrorConn) else c


def kind() -> str:
    return "supabase" if PG else "sqlite"


def columns(table: str, c=None) -> set:
    c = c or conn()
    if isinstance(c, MirrorConn):
        c = c.local
    if isinstance(c, PgConn):
        return {r[0] for r in c.execute("SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?", (PG_SCHEMA, table))}
    return {r[1] for r in c.execute(f"PRAGMA table_info({q(table)})")}


def ensure_column(table: str, col: str, decl: str, c=None) -> None:
    """Add a column that a newer version introduced (nothing happens when it exists)."""
    c = c or conn()
    if col not in columns(table, c):
        c.execute(f"ALTER TABLE {q(table)} ADD COLUMN {q(col)} {decl}")


IntegrityError: tuple = (sqlite3.IntegrityError,)
DatabaseError: tuple = (sqlite3.Error,)
if PG:
    import psycopg as _psycopg
    IntegrityError += (_psycopg.IntegrityError,)
    DatabaseError += (_psycopg.Error,)

EXTRA_TABLES = ["subscribers", "kv", "deletions", "users", "sessions", "login_failures", "audit_log"]
ALL_TABLES = [s["table"] for s in SCHEMA.values()] + EXTRA_TABLES


def create_schema(c) -> None:
    pg = isinstance(c, PgConn)
    T = {"T": "TEXT", "I": "BIGINT" if pg else "INTEGER", "B": "INTEGER", "J": "TEXT"}
    blob, big = ("BYTEA", "BIGINT") if pg else ("BLOB", "INTEGER")
    for spec in SCHEMA.values():
        cols = [f"{q(col(spec, k))} {T[t]}" + (" PRIMARY KEY" if k == spec["key"] else "") for k, t in spec["cols"].items()]
        cols += [f"pii {blob}"] if spec["pii"] else []
        cols += [f"{q(k)} TEXT" for k in spec["bi"]] + [f"{q(k)} {T[t]}" for k, t in spec.get("extra", {}).items()]
        cols += [f"updated_at {big}", "updated_by TEXT"]
        if spec["table"] == "messages":
            cols += ["mail_status TEXT", "mail_tries INTEGER"]
        c.execute(f"CREATE TABLE IF NOT EXISTS {q(spec['table'])} ({', '.join(cols)})")
        have = columns(spec["table"], c)              # an older database: add any column a newer version introduced
        for old, new in spec.get("rename", {}).items():
            if old in have and new not in have:
                c.execute(f"ALTER TABLE {q(spec['table'])} RENAME COLUMN {q(old)} TO {q(new)}")
                have = columns(spec["table"], c)
        for k, typ in spec["cols"].items():
            if col(spec, k) not in have:
                c.execute(f"ALTER TABLE {q(spec['table'])} ADD COLUMN {q(col(spec, k))} {T[typ]}")
        for ix in spec.get("index", []) + list(spec["bi"]) + ["updated_at"]:
            name = f"ix_{spec['table']}_{ix.replace(',', '_')}"
            c.execute(f"CREATE INDEX IF NOT EXISTS {q(name)} ON {q(spec['table'])} ({', '.join(q(col(spec, x)) for x in ix.split(','))})")
    seq = "seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY" if pg else "seq INTEGER PRIMARY KEY AUTOINCREMENT"
    for sql in (
        f"CREATE TABLE IF NOT EXISTS subscribers (email_bi TEXT PRIMARY KEY, pii {blob}, added_at {big}, confirmed INTEGER NOT NULL DEFAULT 1, token_hash TEXT)",
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
        f"CREATE TABLE IF NOT EXISTS deletions (coll TEXT NOT NULL, key TEXT NOT NULL, ts {big} NOT NULL)",
        "CREATE INDEX IF NOT EXISTS ix_deletions_ts ON deletions (ts)",
        f"""CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
            pw_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, created TEXT, last_login {big},
            pw_changed_at {big}, disabled INTEGER NOT NULL DEFAULT 0)""",
        f"""CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            csrf TEXT NOT NULL, created {big} NOT NULL, last_seen {big} NOT NULL, ip TEXT, agent TEXT)""",
        f"CREATE TABLE IF NOT EXISTS login_failures (key TEXT PRIMARY KEY, count INTEGER NOT NULL, locked_until {big} NOT NULL, last {big} NOT NULL)",
        f"""CREATE TABLE IF NOT EXISTS audit_log (
            {seq}, ts {big} NOT NULL, actor TEXT, role TEXT, ip TEXT,
            action TEXT NOT NULL, target TEXT, detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)""",
    ):
        c.execute(sql)
    for cname, decl in (("confirmed", "INTEGER NOT NULL DEFAULT 1"), ("token_hash", "TEXT")):   # databases from older versions
        ensure_column("subscribers", cname, decl, c)
    for cname, decl in (("mail_status", "TEXT"), ("mail_tries", "INTEGER")):
        ensure_column("messages", cname, decl, c)
    if pg:
        c.script(f"""
        CREATE OR REPLACE FUNCTION {PG_SCHEMA}.audit_append_only() RETURNS trigger LANGUAGE plpgsql
            SET search_path = '' AS $fn$ BEGIN RAISE EXCEPTION 'audit log is append-only'; END $fn$;
        DROP TRIGGER IF EXISTS audit_no_change ON {PG_SCHEMA}.audit_log;
        CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON {PG_SCHEMA}.audit_log
            FOR EACH ROW EXECUTE FUNCTION {PG_SCHEMA}.audit_append_only();
        DROP TRIGGER IF EXISTS audit_no_truncate ON {PG_SCHEMA}.audit_log;
        CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON {PG_SCHEMA}.audit_log
            FOR EACH STATEMENT EXECUTE FUNCTION {PG_SCHEMA}.audit_append_only();
        """)
        # ready-made report views (no personal details: those stay encrypted in "pii")
        for name, body in REPORT_VIEWS.items():
            c.execute(f"CREATE OR REPLACE VIEW {PG_SCHEMA}.{name} WITH (security_invoker = true) AS {body}")
        # Supabase publishes tables to the internet through its "anon" and "authenticated" roles.
        # Lock every table (row-level security with no rules) and take away all access to this schema.
        for tbl in ALL_TABLES:
            c.execute(f"ALTER TABLE {PG_SCHEMA}.{q(tbl)} ENABLE ROW LEVEL SECURITY")
        c.script(f"""
        DO $do$ DECLARE r text; BEGIN
          FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
            IF r = 'public' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
              EXECUTE format('REVOKE ALL ON SCHEMA {PG_SCHEMA} FROM %s', CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END);
              EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA {PG_SCHEMA} FROM %s', CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END);
              EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA {PG_SCHEMA} FROM %s', CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END);
              EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA {PG_SCHEMA} REVOKE ALL ON TABLES FROM %s', CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END);
            END IF;
          END LOOP;
        END $do$;
        """)
    else:
        c.executescript("""
        CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        """)


REPORT_VIEWS = {
    "v_queue_daily": """SELECT date, svc AS service, count(*) AS total,
        count(*) FILTER (WHERE status = 'served') AS served,
        count(*) FILTER (WHERE status = 'void') AS no_show,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE status IN ('waiting', 'called', 'serving')) AS still_waiting,
        count(*) FILTER (WHERE source = 'online') AS booked_online,
        count(*) FILTER (WHERE prio <> 'regular') AS priority_lane
        FROM tickets GROUP BY date, svc""",
    "v_queue_monthly": """SELECT substr(date, 1, 7) AS month, svc AS service, count(*) AS total,
        count(*) FILTER (WHERE status = 'served') AS served,
        count(*) FILTER (WHERE status = 'void') AS no_show
        FROM tickets GROUP BY substr(date, 1, 7), svc""",
    "v_concerns_monthly": """SELECT substr(date, 1, 7) AS month, concern, count(*) AS patients
        FROM tickets WHERE status <> 'cancelled' AND concern IS NOT NULL AND concern <> ''
        GROUP BY substr(date, 1, 7), concern""",
    "v_medicine_stock": """SELECT name, form, stock, thr AS restock_level, cap AS capacity, status, updated FROM medicines""",
    "v_medicine_requests_daily": """SELECT r.date, m.name AS medicine, count(*) AS requests, sum(r.qty) AS quantity,
        count(*) FILTER (WHERE r.status = 'claimed') AS claimed
        FROM med_requests r LEFT JOIN medicines m ON m.id = r."medId" GROUP BY r.date, m.name""",
    "v_doctor_schedule": """SELECT name, role, days AS weekdays, start, "end", available, "limit" AS daily_limit, note, leaves AS days_off FROM doctors""",
    "v_services": """SELECT code, name, avg AS average_minutes, "limit" AS daily_limit, walkin AS walk_in_slots, open, note FROM services""",
    "v_messages_daily": """SELECT date, ch AS channel, count(*) AS messages,
        count(*) FILTER (WHERE mail_status = 'sent') AS sent FROM messages GROUP BY date, ch""",
}


def region() -> str:
    """The Supabase data center, from the connection address (shown in the Privacy Notice)."""
    import re
    m = re.search(r"aws-\d+-([a-z]{2}-[a-z]+-\d)", DATABASE_URL)
    names = {"ap-southeast-1": "Singapore", "ap-northeast-1": "Tokyo", "ap-northeast-2": "Seoul", "ap-south-1": "Mumbai",
             "ap-southeast-2": "Sydney", "us-east-1": "North Virginia, USA", "us-west-1": "California, USA",
             "eu-central-1": "Frankfurt", "eu-west-1": "Ireland", "eu-west-2": "London", "sa-east-1": "Sao Paulo"}
    return names.get(m.group(1), m.group(1)) if m else ("this computer (test)" if "127.0.0.1" in DATABASE_URL or "localhost" in DATABASE_URL else "")


def size_kb() -> int:
    if PG:
        with LOCK:
            r = pg().execute("SELECT COALESCE(SUM(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                               "WHERE n.nspname=? AND c.relkind='r'", (PG_SCHEMA,)).fetchone()[0]
        return round(int(r) / 1024)
    return round(sum(p.stat().st_size for p in (DB_PATH, DB_PATH.with_name(DB_PATH.name + "-wal")) if p.exists()) / 1024)


# ---------- copying all tables to/from a plain SQLite file (backups, moving to Supabase) ----------
def export_sqlite(path) -> None:
    """Write every table into a new SQLite file (same layout as the local database).
    Used for backups when the data lives on Supabase."""
    dst = sqlite3.connect(str(path), isolation_level=None)
    try:
        create_schema(dst)
        dst.execute("DROP TRIGGER IF EXISTS audit_no_update")
        dst.execute("DROP TRIGGER IF EXISTS audit_no_delete")
        dst.execute("BEGIN")
        import psycopg
        # a separate read-only connection with one consistent snapshot, so the site keeps working meanwhile
        with psycopg.connect(DATABASE_URL, connect_timeout=15, prepare_threshold=None) as src:
            src.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            src.execute(f"SET LOCAL search_path TO {PG_SCHEMA}")
            src.execute("SET LOCAL statement_timeout = '120s'")
            for tbl in ALL_TABLES:
                cur = src.execute(f"SELECT * FROM {q(tbl)}" + (" ORDER BY seq" if tbl == "audit_log" else ""))
                names = [d.name for d in cur.description]
                sql = f"INSERT INTO {q(tbl)} ({', '.join(q(n) for n in names)}) VALUES ({', '.join('?' for _ in names)})"
                while True:
                    rows = cur.fetchmany(1000)
                    if not rows:
                        break
                    dst.executemany(sql, [tuple(bytes(v) if isinstance(v, memoryview) else v for v in r) for r in rows])
        dst.execute("COMMIT")
        dst.executescript("""
        CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
        """)
    finally:
        dst.close()


def import_sqlite(path) -> dict:
    """Replace every table with the contents of a SQLite file (a decrypted backup, or the old local
    database when moving to Supabase). All or nothing. Returns the number of rows per table."""
    src = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    counts = {}
    try:
        with tx():
            c = conn()
            if isinstance(c, MirrorConn):
                c = c.pg
            pg = isinstance(c, PgConn)
            if pg:
                c.execute("ALTER TABLE audit_log DISABLE TRIGGER audit_no_change")
            else:
                c.execute("DROP TRIGGER IF EXISTS audit_no_delete")
            for tbl in reversed(ALL_TABLES):              # sessions before users (foreign key)
                c.execute(f"DELETE FROM {q(tbl)}")
            for tbl in ALL_TABLES:
                have = columns(tbl, c)
                try:
                    cur = src.execute(f"SELECT * FROM {q(tbl)}" + (" ORDER BY seq" if tbl == "audit_log" else ""))
                except sqlite3.OperationalError:          # a table that older versions did not have
                    counts[tbl] = 0
                    continue
                names = [d[0] for d in cur.description if d[0] in have]
                over = " OVERRIDING SYSTEM VALUE" if pg and tbl == "audit_log" else ""
                sql = f"INSERT INTO {q(tbl)} ({', '.join(q(n) for n in names)}){over} VALUES ({', '.join('?' for _ in names)})"
                n = 0
                while True:
                    rows = cur.fetchmany(1000)
                    if not rows:
                        break
                    c.executemany(sql, [tuple(r[k] for k in names) for r in rows])
                    n += len(rows)
                counts[tbl] = n
            if pg:
                c.execute("ALTER TABLE audit_log ENABLE TRIGGER audit_no_change")
                c.execute("SELECT setval(pg_get_serial_sequence('audit_log','seq'), COALESCE((SELECT MAX(seq) FROM audit_log), 0) + 1, false)")
            else:
                c.execute("CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END")
    finally:
        src.close()
    if isinstance(_conn, MirrorConn):
        _conn.resync(problem=False)
    return counts


# ---------- value conversion ----------
def _to_db(t: str, v):
    if v is None:
        return None
    if t == "B":
        return 1 if v else 0
    if t == "J":
        return json.dumps(v, separators=(",", ":"), ensure_ascii=False)
    return v


def _from_db(t: str, v):
    if v is None:
        return None
    if t == "B":
        return bool(v)
    if t == "J":
        return json.loads(v)
    return v


def _aad(spec, key) -> str:
    return f"{spec['table']}:{key}"


def row_to_rec(spec, row, decrypt: bool) -> dict:
    rec = {k: _from_db(t, row[col(spec, k)]) for k, t in spec["cols"].items()}
    if spec["pii"]:
        if decrypt and row["pii"] is not None:
            try:
                rec.update(crypto.unseal_json(KEYS.field, row["pii"], _aad(spec, rec[spec["key"]])))
            except Exception:                     # tampered or damaged value: never crash, never guess
                rec.update({k: "(unreadable)" for k in spec["pii"]})
        elif not decrypt:
            pass
    return rec


def select_many(queries) -> list[list]:
    """Run several SELECTs; on Supabase they travel together in one round trip."""
    with LOCK:
        c = conn()
        if isinstance(c, MirrorConn):
            c = c.local
        return [c.execute(s, a).fetchall() for s, a in queries]


def read_all(coll: str, decrypt: bool = True, where: str = "", args: tuple = ()) -> list[dict]:
    spec = SCHEMA[coll]
    with LOCK:
        rows = conn().execute(f"SELECT * FROM {q(spec['table'])} {where}", args).fetchall()
    return [row_to_rec(spec, r, decrypt) for r in rows]


def get_many(coll: str, keys: list[str], decrypt: bool = True) -> dict[str, dict]:
    """Records by key (in chunks, so a long list stays within SQLite's parameter limit)."""
    spec, out = SCHEMA[coll], {}
    keys = [k for k in dict.fromkeys(keys) if isinstance(k, str)]
    for i in range(0, len(keys), 500):
        part = keys[i:i + 500]
        for r in read_all(coll, decrypt, f"WHERE {q(spec['key'])} IN ({','.join('?' for _ in part)})", tuple(part)):
            out[r[spec["key"]]] = r
    return out


# ---------- change tracking: lets a browser download only what changed since its last check ----------
_last_stamp = 0


def stamp() -> int:
    """A strictly increasing time stamp in milliseconds (two changes never share one)."""
    global _last_stamp
    with LOCK:
        _last_stamp = max(int(time.time() * 1000), _last_stamp + 1)
        return _last_stamp


TOMBSTONE_DAYS = 3


def changed_since(coll: str, since: int, decrypt: bool = True) -> list[dict]:
    return read_all(coll, decrypt, "WHERE updated_at > ?", (since,))


def deleted_since(since: int) -> dict[str, list[str]]:
    with LOCK:
        rows = conn().execute("SELECT coll, key FROM deletions WHERE ts > ?", (since,)).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["coll"], []).append(r["key"])
    return out


def tombstones_cover(since: int) -> bool:
    """False when deletions older than `since` may have been forgotten (the browser must reload everything)."""
    return since > int(time.time() * 1000) - TOMBSTONE_DAYS * 86400000 + 60000


def get(coll: str, key: str, decrypt: bool = True) -> dict | None:
    spec = SCHEMA[coll]
    with LOCK:
        row = conn().execute(f"SELECT * FROM {q(spec['table'])} WHERE {q(spec['key'])}=?", (key,)).fetchone()
    return row_to_rec(spec, row, decrypt) if row else None


def upsert(coll: str, rec: dict, actor: str = "", extra: dict | None = None) -> None:
    spec = SCHEMA[coll]
    vals = {col(spec, k): _to_db(t, rec.get(k)) for k, t in spec["cols"].items()}
    if spec["pii"]:
        pii = {k: rec.get(k, "") if rec.get(k) is not None else "" for k in spec["pii"]}
        vals["pii"] = crypto.seal_json(KEYS.field, pii, _aad(spec, rec[spec["key"]]))
        for bcol, field in spec["bi"].items():
            vals[bcol] = crypto.blind(KEYS.index, field, pii.get(field))
    for k, v in (extra or {}).items():
        if k in spec.get("extra", {}):
            vals[k] = v
    vals["updated_at"] = stamp()
    vals["updated_by"] = actor
    cols = list(vals)
    upd = ", ".join(f"{q(c)}=excluded.{q(c)}" for c in cols if c != spec["key"] and not (c in spec.get("extra", {}) and extra is None))
    sql = (f"INSERT INTO {q(spec['table'])} ({', '.join(q(c) for c in cols)}) VALUES ({', '.join('?' for _ in cols)}) "
           f"ON CONFLICT({q(spec['key'])}) DO UPDATE SET {upd}")
    with LOCK:
        conn().execute(sql, [vals[c] for c in cols])


def delete(coll: str, key: str) -> None:
    spec = SCHEMA[coll]
    with LOCK:
        conn().execute(f"DELETE FROM {q(spec['table'])} WHERE {q(spec['key'])}=?", (key,))
        conn().execute("INSERT INTO deletions (coll, key, ts) VALUES (?,?,?)", (coll, key, stamp()))


def prune_tombstones() -> None:
    with LOCK:
        conn().execute("DELETE FROM deletions WHERE ts < ?", (int(time.time() * 1000) - TOMBSTONE_DAYS * 86400000,))


def find_by_blind(coll: str, field: str, value: str, where: str = "", args: tuple = ()) -> list[dict]:
    spec = SCHEMA[coll]
    col = next(c for c, f in spec["bi"].items() if f == field)
    fp = crypto.blind(KEYS.index, field, value)
    if not fp:
        return []
    return read_all(coll, True, f"WHERE {q(col)}=? {where}", (fp, *args))


# ---------- subscribers (a list of emails; only confirmed addresses receive updates) ----------
SUBS_SQL = "SELECT email_bi, pii FROM subscribers WHERE confirmed=1 ORDER BY added_at"


def subscribers(rows=None) -> list[str]:
    if rows is None:
        with LOCK:
            rows = conn().execute(SUBS_SQL).fetchall()
    out = []
    for r in rows:
        try:
            out.append(crypto.unseal_json(KEYS.field, r["pii"], f"subscribers:{r['email_bi']}")["email"])
        except Exception:
            pass
    return out


def set_subscribers(emails: list[str]) -> None:
    """Staff edit the confirmed list (removing someone, or adding an address given in person)."""
    keep = {crypto.blind(KEYS.index, "email", e): e.strip().lower() for e in emails if e.strip()}
    with LOCK:
        c = conn()
        have = {r[0] for r in c.execute("SELECT email_bi FROM subscribers WHERE confirmed=1")}
        for bi in have - set(keep):
            c.execute("DELETE FROM subscribers WHERE email_bi=?", (bi,))
        for bi, e in keep.items():
            if bi not in have:
                c.execute("INSERT INTO subscribers (email_bi, pii, added_at, confirmed) VALUES (?,?,?,1) "
                          "ON CONFLICT(email_bi) DO UPDATE SET confirmed=1, token_hash=NULL",
                          (bi, crypto.seal_json(KEYS.field, {"email": e}, f"subscribers:{bi}"), int(time.time() * 1000)))


def add_subscriber(email: str) -> str | None:
    """A new (unconfirmed) sign-up. Returns the one-time confirmation token, or None if the
    address is already confirmed."""
    import hashlib
    import secrets as _s
    e = email.strip().lower()
    bi = crypto.blind(KEYS.index, "email", e)
    token = _s.token_urlsafe(24)
    th = hashlib.sha256(token.encode()).hexdigest()
    with LOCK:
        row = conn().execute("SELECT confirmed FROM subscribers WHERE email_bi=?", (bi,)).fetchone()
        if row and row[0]:
            return None
        conn().execute("INSERT INTO subscribers (email_bi, pii, added_at, confirmed, token_hash) VALUES (?,?,?,0,?) "
                       "ON CONFLICT(email_bi) DO UPDATE SET token_hash=excluded.token_hash",
                       (bi, crypto.seal_json(KEYS.field, {"email": e}, f"subscribers:{bi}"), int(time.time() * 1000), th))
    return token


def confirm_subscriber(token: str) -> bool:
    import hashlib
    th = hashlib.sha256(token.encode()).hexdigest()
    with LOCK:
        cur = conn().execute("UPDATE subscribers SET confirmed=1, token_hash=NULL WHERE token_hash=? AND confirmed=0", (th,))
        return cur.rowcount == 1

# ---------- key/value settings ----------
def kv_get(key: str, default=None):
    with LOCK:
        row = conn().execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def kv_many(keys) -> dict:
    """Several settings in one trip to the database."""
    keys = list(keys)
    with LOCK:
        rows = conn().execute(f"SELECT key, value FROM kv WHERE key IN ({','.join('?' for _ in keys)})", tuple(keys)).fetchall()
    return {r[0]: json.loads(r[1]) for r in rows}


def kv_set(key: str, value) -> None:
    with LOCK:
        conn().execute("INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                       (key, json.dumps(value, separators=(",", ":"), ensure_ascii=False)))


def rev() -> int:
    return int(kv_get("_rev", 0))


def bump() -> int:
    """Every saved change raises the revision number; browsers poll it to know when to refresh."""
    with LOCK:
        r = rev() + 1
        kv_set("_rev", r)
    from . import excel                       # refresh the live Excel workbook soon
    excel.schedule()
    return r


class tx:
    """with db.tx(): ... -- one all-or-nothing transaction (nested use is fine).
    The lock is always released, even if the database refuses to start or finish the transaction,
    so one failure can never freeze the whole site."""
    _local = threading.local()

    def __enter__(self):
        LOCK.acquire()
        depth = getattr(tx._local, "depth", 0)
        if depth == 0:
            try:
                c = conn()
                if isinstance(c, MirrorConn):
                    c.begin()                          # Supabase and the working copy together
                elif isinstance(c, PgConn):
                    c.execute("BEGIN")
                    c.in_tx = True
                    c.execute("SELECT pg_advisory_xact_lock(724100)")
                else:
                    c.execute("BEGIN IMMEDIATE")
            except Exception:
                _rollback()
                LOCK.release()
                raise
        tx._local.depth = depth + 1
        return self

    def __exit__(self, et, ev, tb):
        tx._local.depth -= 1
        try:
            if tx._local.depth == 0:
                if et:
                    _rollback()
                else:
                    try:
                        c = conn()
                        if isinstance(c, MirrorConn):
                            c.commit()
                        else:
                            c.execute("COMMIT")
                        _end_tx()
                    except Exception:
                        _rollback()
                        raise
        finally:
            LOCK.release()
        return False


def _rollback() -> None:
    if isinstance(_conn, MirrorConn):
        _conn.rollback()
        return
    try:
        conn().execute("ROLLBACK")
    except Exception:
        pass
    _end_tx()


def _end_tx() -> None:
    if isinstance(_conn, PgConn):
        _conn.in_tx = False
    elif isinstance(_conn, MirrorConn):
        _conn.pg.in_tx = False


# ---------- whole state (same shape as the website's S object) ----------
def load_state(decrypt: bool = True, tickets_from: str | None = None, sms: bool | int = True, requests: bool = True) -> dict:
    """The records in the website's S shape.
    tickets_from: only tickets on or after this date (most work needs only today's queue).
    sms: True = all messages, False = none, a number = only the newest N."""
    S = {"v": 2, "rev": 3}
    plan = []                                         # (collection, where, args): all read in one trip
    for coll in SCHEMA:
        if coll == "tickets" and tickets_from:
            plan.append((coll, "WHERE date >= ?", (tickets_from,)))
        elif coll == "sms" and sms is not True:
            if sms:
                plan.append((coll, "ORDER BY ts DESC LIMIT ?", (int(sms),)))
            else:
                S[coll] = []
        elif coll == "medRequests" and not requests:
            S[coll] = []
        else:
            plan.append((coll, "", ()))
    queries = [(f"SELECT * FROM {q(SCHEMA[c]['table'])} {w}", a) for c, w, a in plan]
    queries.append((f"SELECT key, value FROM kv WHERE key IN ({','.join('?' for _ in KV_KEYS)})", KV_KEYS))
    if decrypt:
        queries.append((SUBS_SQL, ()))
    res = select_many(queries)
    for (coll, _, _), rows in zip(plan, res):
        S[coll] = [row_to_rec(SCHEMA[coll], r, decrypt) for r in rows]
    S["subs"] = subscribers(res[len(plan) + 1]) if decrypt else []
    kv = {r[0]: json.loads(r[1]) for r in res[len(plan)]}
    for k in KV_KEYS:
        S[k] = kv.get(k)
    S["turned"] = S["turned"] or {}
    S["pending"] = S["pending"] or []
    S["monthly"] = S["monthly"] or []
    S["stockHist"] = S["stockHist"] or {}
    S["sample"] = bool(S["sample"])
    S["tickets"].sort(key=lambda t: (t.get("date") or "", t.get("cmin") or 0))
    S["sms"].sort(key=lambda m: m.get("ts") or 0)
    return S


COMPACT_TICKET = ("id", "date", "svc", "prio", "source", "status", "cmin", "calledMin", "doneMin", "concern")


def compact_tickets(before: str) -> list[dict]:
    """Older tickets for reports only: no names, contacts or codes, and nothing to decrypt."""
    spec = SCHEMA["tickets"]
    cols = ", ".join(q(col(spec, c)) for c in COMPACT_TICKET)
    with LOCK:
        rows = conn().execute(f"SELECT {cols} FROM tickets WHERE date < ? ORDER BY date, {q(col(spec, 'cmin'))}", (before,)).fetchall()
    return [dict(zip(COMPACT_TICKET, r)) for r in rows]


def monthly_history(before_month: str, months: int = 12) -> list[dict]:
    """Patients per month (for the staffing & surge planner), counted from the real records."""
    y, m = int(before_month[:4]), int(before_month[5:7])
    m -= months
    while m <= 0:
        m += 12
        y -= 1
    start = f"{y}-{m:02d}-01"
    with LOCK:
        rows = conn().execute("SELECT substr(date,1,7) AS ym, date, concern FROM tickets WHERE date >= ? AND date < ? AND status <> 'cancelled'",
                              (start, before_month + "-01")).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        x = out.setdefault(r["ym"], {"ym": r["ym"], "dates": set(), "total": 0, "concerns": {}})
        x["dates"].add(r["date"])
        x["total"] += 1
        if r["concern"]:
            x["concerns"][r["concern"]] = x["concerns"].get(r["concern"], 0) + 1
    res = []
    for ym in sorted(out):
        x = out[ym]
        days = len(x["dates"])
        res.append({"ym": ym, "days": days, "avg": round(x["total"] / days) if days else 0, "total": x["total"], "concerns": x["concerns"]})
    return res


def is_empty() -> bool:
    return kv_get("center") is None
