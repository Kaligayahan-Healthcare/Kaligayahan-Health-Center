# Barangay Kaligayahan Health Center: availability tracking system

A website where residents see the health center's hours, services, doctors and medicine stock,
get a queue number from their phone, and follow their turn. Staff manage the queue, doctors'
schedules, medicines and announcements from a separate staff portal.

It is made for older and sick residents: large text, a text-size button, high contrast, read
aloud, and simple steps.

## What is in this repository

| Folder / file | What it is |
|---|---|
| `website/` | The website: `index.html` (public site), `staff.html` (staff portal), `app.js`, `styles.css`, fonts and images |
| `backend/` | The secure server (Python / FastAPI) that serves the website and keeps the records |
| `docs/` | Guides: Supabase database, going online, privacy compliance, launch testing |
| `Start Website (localhost).bat` | Starts the server (installs what it needs the first time) |
| `Connect to Supabase.bat` | Connects the database to Supabase (see `docs/SUPABASE.md`) |
| `Check server PC security.bat` | A read-only security check of the server computer |
| `Kaligayahan Health Center.html`, `... - Staff portal.html` | Offline demo copies that work without the server (data stays in that browser) |

## Running it (Windows)

1. Install **Python 3.12** from python.org (tick "Add python.exe to PATH").
2. Double-click **`Start Website (localhost).bat`**.
   - The first start takes about a minute and needs internet.
   - It prints one-time passwords for the staff accounts.
3. Open **http://localhost:8123** for the public site.
4. Open **http://localhost:8123/staff** for the staff portal. It only opens on the server computer and the clinic network.

More: `backend/README.md` (settings, security, backups, live Excel) and `docs/`.

## Important

- **The website needs its server.** GitHub Pages only serves files, so the site would run there
  as a demo: bookings would stay in each visitor's browser and never reach the health center.
  To put the real site online, use the server with a Cloudflare Tunnel (`docs/GOING-ONLINE.md`).
- **No patient data, keys or passwords are in this repository.** Records live in Supabase
  (encrypted before they are sent) and on the server computer. Keys are in
  `%LOCALAPPDATA%\KaligayahanHealthCenter`, never in the project folder.
