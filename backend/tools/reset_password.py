"""Emergency: give a staff account a new one-time password (for example if every administrator
is locked out). Must be run on the server computer itself, by its Windows user.

    backend\\.venv\\Scripts\\python.exe backend\\tools\\reset_password.py admin
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    from app import db, security
    u = security.user_by_name(sys.argv[1])
    if not u:
        sys.exit(f"No account named {sys.argv[1]!r}. Accounts: " + ", ".join(x["user"] for x in security.users()))
    pw = security.temp_password()
    security.set_password(u["id"], pw, True)
    with db.LOCK:                                   # unlock this account from every address
        db.conn().execute("DELETE FROM login_failures WHERE key LIKE ?", (f"u:{u['username']}|%",))
    security.audit("user.reset.console", u["username"], None, actor="console")
    print(f"New one-time password for {u['username']}: {pw}\nIt must be changed at the next login.")
    db.conn().close()


if __name__ == "__main__":
    main()
