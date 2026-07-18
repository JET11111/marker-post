# Vehicle lookup relay

Powers the app's **Vehicle** tab: registration in → make, model, age, colour,
fuel, MOT status (and, when DVLA access exists, tax status and weight class).
All keys stay server-side in this Cloudflare Worker.

- **DVSA MOT history** (required, registration open) — make, model, colour,
  fuel, age, MOT validity. Covers cars, bikes, vans, and HGV/PSV annual tests.
- **DVLA Vehicle Enquiry Service** (optional) — adds tax status and
  weight/class. New-key registration is currently closed ("system upgrades");
  the Worker runs happily without it and upgrades the moment a key is added.

## One-time setup

### 1. Register for the DVSA MOT history API (free, only you can)

<https://documentation.history.mot.api.gov.uk/mot-history-api/register> — you
receive a **client id**, **client secret**, **API key** and a **token URL**.

### 2. Deploy — one command

From this directory:

```bash
bash setup.sh
```

Logs you in to Cloudflare if needed, prompts for the four DVSA values (stored
encrypted, never in git), offers an optional DVLA key prompt, deploys, and runs
a test lookup.

Keep the worker name `vehicle-lookup` — the app expects
`https://vehicle-lookup.<your-subdomain>.workers.dev/`.

### 3. Later: add DVLA when registration reopens

Watch <https://register-for-ves.driver-vehicle-licensing.api.gov.uk/> (or email
DvlaAPIAccess@dvla.gov.uk asking to be notified). When you have a key:

```bash
npx wrangler secret put DVLA_KEY
```

Tax and weight class appear on the card immediately — no code changes.

## Test

```bash
curl "https://vehicle-lookup.<your-subdomain>.workers.dev/?reg=AB12CDE"
```

- `500 Relay not configured` → a DVSA secret is missing (the message names it).
- `MOT HTTP 401/403` in a note → DVSA credentials wrong.
- A card without tax → normal until DVLA_KEY is set.

## Behaviour notes

- Results are edge-cached for 5 minutes per registration.
- If an upstream is down you still get a partial card; `notes` says what's
  missing. 404 only when every configured source has no record.

## Terms

Both APIs have acceptable-use terms (DVLA's requires a legitimate interest in
the vehicle you query). This relay is for your own use; keep the worker URL to
yourself — it holds no secrets, but it spends your API quota.
