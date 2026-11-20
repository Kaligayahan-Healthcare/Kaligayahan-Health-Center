# The database in Supabase

The website's server stays on the health center computer (it checks every request, the staff
roles, the bot protection and the encryption). The **records** are kept in Supabase, a hosted
PostgreSQL database, the same way as in the QCPL Lost & Found system.

**What Supabase can see:** only scrambled data. Names, mobile numbers, emails, addresses, ticket
codes and message texts are encrypted on this computer **before** they are sent. The key stays in
`RECOVERY-KIT.txt` and on this computer, never on Supabase. Staff passwords are stored as Argon2
hashes.

## How it works

- **Supabase holds the real data.** Every change is saved there first, in one transaction. If
  Supabase can't be reached, the change is refused with "please try again in a minute", and nothing is half-saved.
- **A working copy for fast reading.** The server keeps a copy, `bkhc-working-copy.sqlite3`
  in `%LOCALAPPDATA%\KaligayahanHealthCenter`.
  - It is refilled from Supabase at every start, and every change is written to it right after Supabase.
  - Pages, staff screens and refreshes are read from it, so they are as fast as before and still open during an internet outage.
  - Nothing is ever kept only on this computer, and a new computer gets everything back from Supabase.
- **One server at a time.** A running server holds a "lease" on the database, renewed every 30 seconds.
  - A second server pointed at the same Supabase refuses to start and names the computer that has it.
  - If a server crashes, the same computer takes over at once. Another computer can take over after 90 seconds.
  - If another server takes the lease anyway, this one refuses changes until it is restarted.
- **Never starts on an empty Supabase** while this computer still has the records, so an empty database can never replace the real one.
- **Backups:** every hour the server copies the whole Supabase database into an encrypted backup in
  `database\backups` (OneDrive keeps a copy off this computer). Use **Settings → Test the latest backup** once a month.

## 1. Create the Supabase project (about 5 minutes)

1. Go to **supabase.com** and sign up. Use the health center's own email account.
   - Turn on two-factor authentication: profile picture → **Account preferences → Security**.
2. Click **New project**.
   - **Name:** `kaligayahan-health-center`.
   - **Database password:** click **Generate a password** and keep it safe.
   - **Region:** the health center's project is in **Northeast Asia (Tokyo)**. Use the same region if the project is ever re-created, or update the privacy documents if it changes.
3. Wait about 2 minutes until it is ready.
4. Click **Connect** → **Session pooler** (port 5432) and copy the **URI**.
   - Not the Transaction pooler (port 6543).
   - Not Direct connection, unless your internet has IPv6.
5. Paste it into Notepad and replace `[YOUR-PASSWORD]` (including the brackets) with the database password.

Never paste this connection string into a chat, an email or a document. It is the key to the database.
You do **not** need Supabase's Project URL, "anon" key or "service_role" key: this system has no
photos to store, and the server talks to the database directly.

## 2. Connect (double-click)

Double-click **`Connect to Supabase.bat`** in the project folder and paste the connection string
when asked. Nothing is shown while you paste.

- It stops the website if it is running, and starts it again at the end.
- It checks the connection, and refuses one that is not encrypted.
- It creates the private schema `bkhc`, locks every table and adds the report views.
- It copies every record from this computer (if there are any) and checks that the counts match.
- It saves the connection string in `secrets.json`, which only this Windows user can read.
- The old database file is kept, renamed `bkhc.sqlite3.moved-to-supabase-<date>`.

The server window then shows `Database: Supabase (PostgreSQL, Tokyo), private schema bkhc`.
In the staff portal, **Settings → Secure database** says **Stored on Supabase (Tokyo)**.

## 3. Stronger: check Supabase's certificate (recommended)

By default the connection is encrypted. With the certificate, the server also checks that it is
really talking to your Supabase project and not to an impostor on the network.

1. In Supabase: **Project Settings → Database → SSL Configuration → Download certificate**.
2. Drag the downloaded file (`prod-ca-2021.crt`) onto **`Connect to Supabase.bat`**.

It tests the certificate first and changes nothing if the check fails.

## Looking at the data in Supabase

In **Table Editor**, choose schema **bkhc**.

- Personal details appear only as scrambled bytes in the `pii` column. That is how it should be.
- For reports, use the ready-made views. None of them contains personal details.

| View | What's in it |
|---|---|
| `v_queue_daily` | Patients per day and service: served, no-show, cancelled, still waiting, online, priority lane |
| `v_queue_monthly` | The same per month |
| `v_concerns_monthly` | Reasons for the visit per month |
| `v_medicine_stock` | Medicines, stock, restock level, status |
| `v_medicine_requests_daily` | Medicine requests per day and medicine |
| `v_doctor_schedule` | Doctors' weekdays, hours and days off |
| `v_services` | Services, average minutes and daily limits |
| `v_messages_daily` | Emails and texts per day, and how many were sent |

In **SQL Editor** you can run, for example, `SELECT * FROM bkhc.v_queue_monthly ORDER BY month;`.

**Only read.** Make every change through the website, so the rules, roles and activity log apply.
The working copy only learns about changes made by the server.

## After moving

| Item | What to do |
|---|---|
| **Free plan** | 500 MB database (this system uses a few MB a year). Supabase may pause free projects after about a week with little activity, and emails a warning first. The running server uses the database all the time, so this mostly happens when the computer is off for a long time. To resume: supabase.com → the project → **Restore project**. For an always-on clinic system, the Pro plan (no pausing, daily backups by Supabase) is worth considering. |
| **Internet outage** | Pages still open from the working copy. Saving shows "The records server cannot be reached right now. Nothing was changed." and works again by itself when the internet is back. |
| **Privacy notice** | The website's Privacy Notice says automatically that the data is in a secured cloud database (Supabase), names the region, and says it is encrypted before it is sent. List Supabase as a **personal information processor** in the PIA and the NPC registration (see PRIVACY-COMPLIANCE.md). |
| **Data processing agreement** | In Supabase: **Organization settings → Legal documents**, sign the **DPA**. Keep a copy with the privacy documents. |

## Security on Supabase

- The tables are in their own schema, `bkhc`, not in `public`. Supabase's automatic web API (the
  "anon" and "authenticated" keys) serves only `public`, so these tables are never published.
  - Do **not** add `bkhc` under **Project Settings → Data API → Exposed schemas**.
- **Row-level security** is on for every table, with no rules.
- The `anon` and `authenticated` roles have no access to anything. This is re-applied at every start, so a wrong setting changed in the dashboard is undone.
- The report views run with the reader's rights (`security_invoker`), so they cannot be used to get around this.
- The activity log refuses changes and deletion inside the database, and its entries are chained with a secret key.
- The connection is always encrypted (`sslmode=require`), or certificate-checked (`verify-full`) once the certificate is added.

## If something goes wrong

| Problem | Fix |
|---|---|
| `password authentication failed` | Reset the password (**Project Settings → Database → Reset database password**), then double-click `Connect to Supabase.bat` again with the new connection string. |
| `could not translate host name` / timeout | Check the internet. Use the **Session pooler** string. |
| "Another copy of the server is using the Supabase database" | Close the other server (the message names the computer). If it was switched off or crashed, wait 90 seconds and start again. |
| "The Supabase database is empty, but this computer still has the records" | Double-click `Connect to Supabase.bat` to copy them. |
| "Cannot reach the Supabase database" when starting | Internet down, or the project is paused (see above). |
| Restore a backup | `backend\tools\restore_backup.py <file>`. It first saves the current Supabase data as a "before-restore" backup, then replaces the records on Supabase and refills the working copy. |
| Stop using Supabase | `connect_supabase.py --back-to-local` copies everything back to this computer. Delete the Supabase project yourself afterwards (**Project Settings → General → Delete project**). |

## For developers: testing on PostgreSQL

The same 61 tests run on PostgreSQL when `BKHC_TEST_DATABASE_URL` points to an **empty test
database on this computer**. Its `bkhc` schema is wiped first, so addresses on other computers are refused.
