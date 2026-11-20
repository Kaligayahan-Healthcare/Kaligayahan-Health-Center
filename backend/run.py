"""Start the Barangay Kaligayahan Health Center server.

    backend\\.venv\\Scripts\\python.exe backend\\run.py

Settings are in %LOCALAPPDATA%\\KaligayahanHealthCenter\\config.json.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import config, db, security, service  # noqa: E402


def ensure_cert() -> tuple[str, str]:
    """A self-signed certificate for using the site on the clinic network over HTTPS."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert, key = config.TLS_DIR / "cert.pem", config.TLS_DIR / "key.pem"
    if cert.exists() and key.exists():
        return str(cert), str(key)
    config.TLS_DIR.mkdir(parents=True, exist_ok=True)
    k = ec.generate_private_key(ec.SECP256R1())
    names = {"localhost", socket.gethostname(), *config.CONFIG.get("allowed_hosts", [])}
    sans = []
    for n in names:
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            sans.append(x509.DNSName(n))
    sans.append(x509.IPAddress(ipaddress.ip_address("127.0.0.1")))
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Kaligayahan Health Center")])
    now = dt.datetime.now(dt.timezone.utc)
    c = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(k.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=825))
         .add_extension(x509.SubjectAlternativeName(sans), critical=False).sign(k, hashes.SHA256()))
    key.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    cert.write_bytes(c.public_bytes(serialization.Encoding.PEM))
    return str(cert), str(key)


def main() -> None:
    import uvicorn

    cfg = config.CONFIG
    host, port, https = cfg["host"], int(cfg["port"]), bool(cfg.get("https"))
    if host not in ("127.0.0.1", "localhost") and not https:
        print("\n  For safety, the site is only shared on the network over HTTPS.")
        print('  Set "https": true in config.json (or set "host" back to "127.0.0.1").\n')
        sys.exit(1)
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            print(f"\n  Port {port} is already in use - the server may already be running.\n")
            sys.exit(2)

    try:
        db.conn()
    except db.StartupRefused as e:
        print("\n  " + str(e).replace("\n", "\n  ") + "\n")
        sys.exit(4)
    except Exception as e:
        if not db.PG:
            raise
        print("\n  Cannot reach the Supabase database.")
        print("  - Check this computer's internet connection.")
        print("  - Check that the Supabase project is not paused (supabase.com -> your project).")
        print("  - If the database password was changed, run backend\\tools\\connect_supabase.py again.")
        print(f"\n  Details: {str(e).splitlines()[0][:200]}\n")
        sys.exit(3)
    service.first_run_setup()
    made = security.ensure_default_users()
    scheme = "https" if https else "http"
    print("\n  Barangay Kaligayahan Health Center - secure server")
    print("  -------------------------------------------------")
    print(f"  Website:    {scheme}://localhost:{port}")
    print(f"  Staff:      {scheme}://localhost:{port}/staff   (not linked from the public site)")
    if db.PG:
        print(f"  Database:   Supabase (PostgreSQL, {db.region()}), private schema {db.PG_SCHEMA}")
        print(f"              working copy for fast reading: {db.WORK_PATH}")
    else:
        print(f"  Database:   {config.DB_PATH}")
    print(f"  Backups:    {config.BACKUP_DIR}")
    print(f"  Excel:      {config.EXCEL_DIR}")
    if made:
        print("\n  FIRST START - one-time staff passwords (must be changed at first login):")
        for u, r, pw in made:
            print(f"     {u:<10} {pw}")
        print(f"  (also saved in {config.DATA / 'FIRST-LOGIN-PASSWORDS.txt'})")
        print(f"\n  IMPORTANT: copy {config.KIT_PATH}")
        print("  to a USB drive or print it. Without it, backups cannot be restored on another computer.")
    print("\n  Keep this window open while the site is in use. Press Ctrl+C to stop.\n")

    # a shortcut to the live Excel folder (the workbook itself stays out of OneDrive, it holds personal data)
    try:
        config.EXCEL_DIR.mkdir(parents=True, exist_ok=True)
        (config.PROJECT / "Open Live Excel folder.url").write_text(
            "[InternetShortcut]\nURL=" + config.EXCEL_DIR.as_uri() + "\n", encoding="utf-8")
    except OSError:
        pass

    ssl = {}
    if https:
        certfile, keyfile = ensure_cert()
        ssl = {"ssl_certfile": certfile, "ssl_keyfile": keyfile}
    proxies = [str(p) for p in cfg.get("trusted_proxies") or []]
    if proxies:
        print(f"  Behind a reverse proxy / tunnel: trusting forwarded addresses from {', '.join(proxies)}\n")
    uvicorn.run("app.main:app", host=host, port=port, access_log=False, server_header=False, date_header=False,
                proxy_headers=bool(proxies), forwarded_allow_ips=",".join(proxies) if proxies else None, log_level="warning", **ssl)


if __name__ == "__main__":
    main()
