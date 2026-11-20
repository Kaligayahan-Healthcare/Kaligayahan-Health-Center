# Secure server and database

The website (`../website`) is served by this Python server. The records are stored in one of two places:

- **Supabase** (hosted PostgreSQL, Tokyo, Japan), with a working copy on this computer for fast reading. See **docs/SUPABASE.md**; connect it with **Connect to Supabase.bat**.
- **A local SQLite database** on the health center computer, used until Supabase is connected.

Either way, personal details are encrypted on this computer before they are stored. Every browser
screen talks to the server, which sends only what changed every few seconds.

## Starting it

Double-click **`Start Website (localhost).bat`** in the project folder.

- **First start.** It needs internet once, for about a minute, to install the Python packages.
  - It prints **one-time passwords** for `admin`, `bhw` and `pharmacy`. They are also saved in `FIRST-LOGIN-PASSWORDS.txt`.
  - Each account must choose its own password at first login. When everyone has done so, that file is deleted automatically.
- **New database.** It starts empty, with only the clinic hours and the five services. Sign in as `admin` at the staff portal, then add the doctors, medicines and announcements.
- **Two separate sites.**
  - **Public website:** `http://localhost:8123/`, for residents only. It has no staff button, link or page.
  - **Staff portal:** `http://localhost:8123/staff`. Bookmark it on the staff computers.
  - The staff portal and the staff sign-in answer only this computer and the clinic's own network (the `staff_networks` setting). From anywhere else they return "Not Found". Search engines are told not to index them.
- **Recovery kit.** Copy **`RECOVERY-KIT.txt`** to a USB drive or print it. Keep it offline. Without it, backups cannot be restored on another computer.

| What | Where |
|---|---|
| Database (unless on Supabase), keys, settings (`config.json`), logs, **live Excel workbook** | `%LOCALAPPDATA%\KaligayahanHealthCenter\` (private to the Windows user, not in OneDrive). The project folder gets a shortcut, **Open Live Excel folder**. |
| Encrypted backups | `database\backups\` in the project folder (OneDrive keeps an off-site copy; the files cannot be read without the recovery kit) |

## Settings (`config.json`)

| Setting | What it does |
|---|---|
| Email and SMS | Fill these in from **Staff portal → Settings → Email & text messages**, and use **Send a test** to check them. Gmail needs an *app password*. SMS uses the Semaphore gateway (semaphore.co, Philippine numbers) and needs an API key from your Semaphore account. Passwords and keys go to `secrets.json` (private) and are never shown again. |
| `mail_daily_cap` | The most messages sent per day, for each channel (default 500). |
| Turnstile | The "I am not a robot" check. Fill it in from **Settings → "I am not a robot" check** with the keys of a free Cloudflare Turnstile widget. |
| `challenge_bits` | Size of the built-in anti-bot puzzle (default 16, about a second on an older phone; 12 is lighter). |
| `trusted_proxies` | **Required if the site is put behind a tunnel or reverse proxy** (Cloudflare Tunnel, ngrok, nginx). Put the proxy's address here, for example `["127.0.0.1"]`. Otherwise every visitor looks like this computer: the staff portal would be reachable from the internet, and one visitor could use up everyone's rate limits. |
| `staff_networks` | The addresses allowed to open the staff portal (default: this computer and private networks). Narrow it to the clinic's own network if guests use the same Wi-Fi. |
| `host`, `https`, `allowed_hosts` | Sharing on the clinic network (see below). |
| `backup_*_keep`, `backup_mirror_dir` | How many backups are kept (default: 48 hourly, 30 daily, 3 monthly, so personal data is not kept longer than about 90 days), and an optional second folder such as a USB drive. |

## How the data is protected

| Threat | Protection |
|---|---|
| Someone copies the database (or gets into the Supabase account) | Names, mobile numbers, emails, addresses, ticket codes and message texts are encrypted with **AES-256-GCM**. Each value is tied to its own row. Exact lookups use keyed HMAC fingerprints, never the plain value. |
| Stolen or guessed passwords | **Argon2id** hashes. At least 10 characters with letters and numbers, and common passwords are refused. One-time passwords must be changed first. After 5 wrong tries, that account is locked **from that address** for a growing time (1 minute, doubling up to 30). Someone else on the network cannot lock the real user out. |
| Session theft / unattended screen | Random 256-bit `HttpOnly`, `SameSite=Strict` cookie, stored only as a hash. The session ends after 30 minutes without activity (automatic refreshes do not count), after 12 hours, or when the password changes. |
| Another website sending changes (CSRF) | A per-session CSRF token on every staff change, plus `Origin` / `Sec-Fetch-Site` checks. |
| SQL injection, cross-site scripting | All queries use parameters. All text is escaped. A strict Content-Security-Policy. Control characters are removed. |
| Tampered requests / staff overstepping | The server checks cut-offs, slot limits, duplicates (the same mobile in `09…` or `+639…` form counts as one), roles, field lengths and formats. Ticket codes cannot be changed. Staff can only send messages to people already in the records. |
| Two people changing the same thing | Each save carries the version it started from. Changes to different fields merge. A field someone else changed first is refused, and the screen explains it ("Someone else changed this first"). |
| Guessing ticket codes | 6-character codes (887 million possibilities). Wrong guesses are limited per address, and there is a site-wide brake (300 wrong guesses in 10 minutes pauses ticket search). |
| Bots | A hidden field and a minimum time to fill in each form. A **built-in puzzle** the browser must solve for every booking, medicine request and sign-up (signed by the server, single use, expires after 10 minutes). Optional **Cloudflare Turnstile**. Rate limits per address: 8 bookings per 10 minutes and 30 per day. |
| Flooding | Request size limits and per-address limits on every public action. A brief cached copy of the public data serves many visitors cheaply. |
| Clickjacking, sniffing, DNS rebinding, disguised file names | `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and allowed host names only. Names like `STAFF.HTML` or `staff.html::$DATA` are refused. |
| Formula injection in Excel | Text starting with `=` is always stored as text. |
| Covering tracks | An append-only activity log, chained with a **secret key** (HMAC), so it cannot be rebuilt by someone who edits the file. Residents' addresses are stored shortened (e.g. `203.0.113.0`). |
| Email abuse | Email updates need a **confirmation click** (double opt-in). There is a daily sending cap, and line breaks are stripped from email headers. |
| Supabase's public web API | The tables are in a private schema (`bkhc`) that the web API does not serve. Row-level security is on for every table, and the `anon`/`authenticated` roles have no access; this is re-applied at every start. The connection is always encrypted. |
| Internet or Supabase outage | Clear "try again in a minute" message, nothing half-saved (every change is all-or-nothing), automatic reconnection. |
| Data loss | Encrypted backups (hourly, daily and monthly, plus one before every restore), integrity-checked. A damaged or altered backup refuses to open. A failed database lock can no longer freeze the site. |
| Keeping data too long | Personal details are removed after 90 days, records deleted after 400 days and messages after 60 days. Deleted data is overwritten. The Excel workbook lists only the last 90 days in detail. |
| One bad record stopping everything | Each automatic job (no-show voiding, planned changes, stock, clean-up) runs on its own. Restored files are checked before use. |

**Roles on the server:**

| Role | Can change |
|---|---|
| admin | everything |
| bhw | queue tickets, doctors, announcements, messages, subscribers |
| pharmacy | medicines, medicine requests, and the restock level (pharmacy never sees patient names) |

## Live Excel

1. **The workbook.** `LIVE DATA.xlsx` (open it from the **Open Live Excel folder** shortcut) is rebuilt at most once a minute after changes.
   - It is password-protected. Admins see the password in **Settings → Database, backups & live Excel**.
   - If it is open in Excel, it updates when closed.
2. **The live link.** In Settings, copy a sheet's link. In Excel, go to **Data → From Web**, paste it and choose **Load**. Then open **Properties** and tick **Refresh every 1 minutes**.
   - The links contain a secret key and work only on this computer.
   - Use **Change the key** if a link leaks.

## Using it on the clinic network

The site is shared on the network only over HTTPS. In `config.json`: `"host": "0.0.0.0", "https": true, "allowed_hosts": ["192.168.1.20"]`. The server creates a self-signed certificate; browsers show a one-time warning.

## More guides

- **docs/GOING-ONLINE.md**: putting the site on the internet (Cloudflare Tunnel), keeping the staff portal private, and Turnstile.
- **docs/PRIVACY-COMPLIANCE.md**: Data Privacy Act checklist, NPC registration, DPO letter template, and the breach procedure.
- **docs/SUPABASE.md**: moving the database to Supabase, security there, and what to do if it is unreachable.
- **docs/LAUNCH-TESTING.md**: load test on the real computer, a phone checklist, and staff checks.
- **Check server PC security.bat**: a read-only check of the computer's security (disk encryption, updates, firewall, antivirus, screen lock, password).
- **Settings → Test the latest backup**: opens the newest backup and checks that it would restore.

## Emergency tools

```bat
rem connect Supabase and move the records there (see docs/SUPABASE.md), or move back
"%LOCALAPPDATA%\KaligayahanHealthCenter\venv\Scripts\python.exe" backend\tools\connect_supabase.py
"%LOCALAPPDATA%\KaligayahanHealthCenter\venv\Scripts\python.exe" backend\tools\connect_supabase.py --back-to-local
```


```bat
rem restore a backup (stop the server first; the current database is kept, not deleted)
"%LOCALAPPDATA%\KaligayahanHealthCenter\venv\Scripts\python.exe" backend\tools\restore_backup.py database\backups\daily\<file>.bkhc
rem on a new computer add --key; you are then asked for the MASTER KEY (it is not shown or saved in the command history)

rem every admin locked out: make a new one-time password (also unlocks the account)
"%LOCALAPPDATA%\KaligayahanHealthCenter\venv\Scripts\python.exe" backend\tools\reset_password.py admin
```

## Tests

```bat
"%LOCALAPPDATA%\KaligayahanHealthCenter\venv\Scripts\python.exe" backend\tests\test_security.py
```

There are 61 attack and correctness tests: injection, CSRF, cross-site requests, role escalation, conflicting edits, code guessing, bots, brute force and lockout abuse, oversize and malformed input, encryption at rest, audit-log forgery, backup tampering, bad backup contents, a stuck database lock, Excel formula injection, email confirmation and sending, email settings, the anti-bot puzzle and Turnstile, doctors' days off, the backup restore test, the hidden staff portal, change-only refreshes, Supabase table privacy, the working copy, one server at a time, the empty-database guard and the report views. They use a throw-away folder. They can also run on PostgreSQL (see docs/SUPABASE.md).

## Offline demo

`Kaligayahan Health Center.html` and `Kaligayahan Health Center - Staff portal.html` work without the server, as the old browser-only prototype. Its first-time passwords are random and shown on the offline staff sign-in page.
