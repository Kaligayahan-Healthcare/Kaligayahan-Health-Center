# Putting the website online

Right now the site works only on the health center computer (`http://localhost:8123`). Residents' phones
need a real web address with HTTPS. The safest and cheapest way for a single clinic computer is a
**Cloudflare Tunnel**:

- The computer opens an outgoing connection to Cloudflare. No router changes are needed and nothing on the clinic network is exposed.
- Cloudflare provides the HTTPS certificate.
- The free plan is enough. You need a domain name, about ₱600–₱1,000 a year, or ask the city ICT office for a sub-domain.

## What you need to do (accounts are yours, not the website's)

1. **Domain.** Register a domain (for example `kaligayahanhc.ph`), or get a sub-domain from the city or barangay.
2. **Cloudflare account.** Create one at dash.cloudflare.com and add the domain. Cloudflare shows two "name servers"; enter them at the place where you bought the domain.
3. **Tunnel.** In Cloudflare go to **Zero Trust → Networks → Tunnels → Create a tunnel** and choose *Cloudflared*.
   - Install the connector on the health center computer using the command Cloudflare shows. It runs as a Windows service.
   - Add a **public hostname**: `www.<your-domain>` → service `http://localhost:8123`.
4. **Tell the server it is behind the tunnel.** Do this in `%LOCALAPPDATA%\KaligayahanHealthCenter\config.json`, then restart the server:
   ```json
   "trusted_proxies": ["127.0.0.1"],
   "allowed_hosts": ["www.<your-domain>"]
   ```
   - **Do not skip this.** Without it, every visitor looks like the health center computer. The staff portal would then be reachable from the internet, and one visitor could use up everyone's limits.
5. **Keep the staff portal private.** In Cloudflare, add a rule that blocks `/staff*` and `/api/staff/*` and `/api/auth/*` for everyone (staff use the portal at the clinic at `http://localhost:8123/staff`).
   - Example: **Security → WAF → Custom rules** → *URI Path starts with `/staff`* (or `/api/staff/` or `/api/auth/`) → **Block**.
6. **Anti-bot check.** In Cloudflare go to **Turnstile → Add widget** for `www.<your-domain>`, then paste the *site key* and *secret key* in **Staff portal → Settings → "I am not a robot" check**.
7. **Email.** Enter the email account in **Settings → Email & text messages** and send a test.
8. **Test from a phone on mobile data** (Wi-Fi off). See `LAUNCH-TESTING.md`.

## Keep the computer on

The site is only online while this computer is on, the server window is open and the internet works.

- **Power:** set Windows never to sleep while plugged in.
- **Battery backup:** use a UPS if possible.
- **Restarts:** after a power cut, double-click **Start Website (localhost).bat** again.

If the clinic cannot keep a computer running all day, a small cloud server (about ₱300–₱600 a month) is the alternative. The same `backend` folder runs there.
