# Vehicle lookup relay

> **PARKED (July 2026):** DVLA closed new VES API registrations ("system
> upgrades"), so this feature can't go fully live yet. The app UI has been
> removed from production (see git history for `app.js`/`index.html` circa the
> "Add Vehicle tab" commit) and this worker is kept for when registration
> reopens — check https://register-for-ves.driver-vehicle-licensing.api.gov.uk/

Powers the app's **Vehicle** tab: registration in → make, model, age, colour,
fuel, plain-English class, tax and MOT status out. Merges two official APIs
server-side so the keys never touch the browser:

- **DVLA Vehicle Enquiry Service** — tax status, colour, fuel, year, class/weight
- **DVSA MOT history** — model, MOT fallback

## One-time setup

### 1. Register for the two (free) APIs — only you can

- **DVLA VES**: apply at
  <https://register-for-ves.driver-vehicle-licensing.api.gov.uk/> → you get an
  **API key** by email.
- **DVSA MOT history**: register at
  <https://documentation.history.mot.api.gov.uk/mot-history-api/register> → you
  get a **client id**, **client secret**, **API key** and a **token URL**.

### 2. Deploy — one command

From this directory:

```bash
bash setup.sh
```

It logs you in to Cloudflare if needed, prompts you to paste the five values
(DVLA key; DVSA client id, client secret, API key, token URL — all stored
encrypted by Cloudflare, never in git), deploys the worker, and runs a test
lookup at the end.

Manual equivalent: the five `npx wrangler secret put` commands listed in
`wrangler.toml`, then `npx wrangler deploy`. Keep the worker name
`vehicle-lookup` — the app expects
`https://vehicle-lookup.<your-subdomain>.workers.dev/`.

### 3. Test

```bash
curl "https://vehicle-lookup.<your-subdomain>.workers.dev/?reg=AB12CDE"
```

- `500 Relay not configured` → a secret/var is missing (the message names it).
- `MOT HTTP 401/403` in a note → DVSA credentials wrong.
- `DVLA HTTP 403` → DVLA key wrong.

## Behaviour notes

- Results are edge-cached for 5 minutes per registration.
- If one API is down you still get a partial card; the missing bits are named
  in `notes`.
- 404 is returned only when **both** APIs have no record.

## Terms

Both APIs have acceptable-use terms (DVLA's requires a legitimate interest in
the vehicle you query). This relay is for your own use; keep the worker URL to
yourself — it holds no secrets, but it spends your API quota.
