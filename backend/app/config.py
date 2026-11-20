"""Paths, settings and secret keys.

Where things live
-----------------
* The live database, the secret keys and the logs are kept in the Windows user's private
  app-data folder (%LOCALAPPDATA%\\KaligayahanHealthCenter). That folder is readable only by
  the signed-in Windows user, and it is NOT inside OneDrive (a sync tool copying a database
  while it is being written can corrupt it).
* Encrypted backups and the live Excel workbook go to "<project>/database/", which is easy to
  find. Because the project sits in OneDrive, the encrypted backups also get an off-site copy.
"""
from __future__ import annotations

import base64
import json
import os
import secrets
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
WEBSITE = PROJECT / "website"


def _data_dir() -> Path:
    if os.environ.get("BKHC_DATA_DIR"):
        return Path(os.environ["BKHC_DATA_DIR"])
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "KaligayahanHealthCenter"


DATA = _data_dir()
DB_PATH = DATA / "bkhc.sqlite3"
SECRETS_PATH = DATA / "secrets.json"
CONFIG_PATH = DATA / "config.json"
KIT_PATH = DATA / "RECOVERY-KIT.txt"
LOG_DIR = DATA / "logs"
TLS_DIR = DATA / "tls"

DEFAULT_CONFIG = {
    "host": "127.0.0.1",          # 127.0.0.1 = only this computer. Use "0.0.0.0" with "https": true for the clinic network.
    "port": 8123,
    "https": False,
    "allowed_hosts": [],          # extra names / IP addresses the site may be opened with, e.g. ["192.168.1.20"]
    "session_idle_minutes": 30,
    "session_max_hours": 12,
    "backup_dir": "",             # default: <project>/database/backups
    "backup_mirror_dir": "",      # optional second copy, e.g. "E:\\BKHC-backups" on a USB drive
    "backup_hourly_keep": 48,
    "backup_daily_keep": 30,
    "backup_monthly_keep": 3,          # backups hold personal data: keep them no longer than about 90 days
    "excel_dir": "",              # default: the private app-data folder (a shortcut is put in the project folder)
    "mail_daily_cap": 500,         # at most this many emails a day
    "challenge_bits": 16,          # anti-bot puzzle size (16 = well under a second on a phone)
    "turnstile": {"site_key": ""},  # Cloudflare Turnstile site key (the secret goes in secrets.json via Settings)
    # Put the address of a reverse proxy / tunnel here (e.g. ["127.0.0.1"] for Cloudflare Tunnel or nginx on this PC)
    # so the real visitor's address is used for rate limits and the staff-network check.
    "trusted_proxies": [],
    "excel_password_protect": True,
    "excel_feed_remote": False,   # allow the live Excel feed from other computers (needs https)
    # The staff portal (/staff) and the staff sign-in only answer these addresses: this computer and
    # the clinic's own network. To anyone else on the internet they do not exist (404).
    # Email sending (off until filled in). See backend/README.md. For Gmail use an "app password".
    "smtp": {"host": "", "port": 587, "user": "", "password": "", "from": "", "starttls": True},
    "staff_networks": ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fe80::/10", "fc00::/7"],
}


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def load_config() -> dict:
    DATA.mkdir(parents=True, exist_ok=True)
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    else:
        _write_private(CONFIG_PATH, json.dumps(DEFAULT_CONFIG, indent=2))
    return cfg


def _readable_password() -> str:
    alpha = "abcdefghjkmnpqrstuvwxyz"
    digits = "23456789"
    part = lambda n, a: "".join(secrets.choice(a) for _ in range(n))
    return f"BKHC-{part(4, alpha)}-{part(4, digits)}-{part(4, alpha)}"


def load_secrets() -> dict:
    """One random master key protects everything. It is created on the first start and
    written to RECOVERY-KIT.txt so it can be copied to a USB drive or printed."""
    if SECRETS_PATH.exists():
        return json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
    master = base64.b64encode(secrets.token_bytes(32)).decode()
    sec = {
        "master_key": master,
        "excel_feed_key": secrets.token_urlsafe(24),
        "excel_password": _readable_password(),
    }
    _write_private(SECRETS_PATH, json.dumps(sec, indent=2))
    _write_private(KIT_PATH, (
        "BARANGAY KALIGAYAHAN HEALTH CENTER - RECOVERY KIT\n"
        "=================================================\n\n"
        "Keep a copy of this file OFFLINE (USB drive or printed, in a locked drawer).\n"
        "Do NOT put it in OneDrive, email or chat.\n\n"
        "Without this key, the encrypted backups and the personal details in the\n"
        "database cannot be read - not even by the health center.\n\n"
        f"MASTER KEY:\n{master}\n\n"
        "To restore a backup on a new computer:\n"
        "  backend\\.venv\\Scripts\\python.exe backend\\tools\\restore_backup.py <backup-file> --key   (then type the MASTER KEY when asked)\n"
    ))
    return sec


CONFIG = load_config()
SECRETS = load_secrets()

OUT = Path(os.environ["BKHC_OUT_DIR"]) if os.environ.get("BKHC_OUT_DIR") else PROJECT / "database"
BACKUP_DIR = Path(CONFIG["backup_dir"]) if CONFIG.get("backup_dir") else OUT / "backups"
EXCEL_DIR = Path(CONFIG["excel_dir"]) if CONFIG.get("excel_dir") else (OUT / "excel" if os.environ.get("BKHC_OUT_DIR") else DATA / "excel")
