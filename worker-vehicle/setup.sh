#!/usr/bin/env bash
# One-command setup for the vehicle lookup relay.
# Run from this directory:  bash setup.sh
# Have ready: DVLA API key; DVSA client id, client secret, API key, token URL.
set -euo pipefail
cd "$(dirname "$0")"

echo "── Vehicle lookup relay setup ─────────────────────────"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare — a browser window will open."
  npx wrangler login
fi

echo
echo "Paste each value when prompted (input is hidden by wrangler)."
echo
echo "1/5 DVLA API key (from your VES registration email)"
npx wrangler secret put DVLA_KEY
echo "2/5 DVSA client id"
npx wrangler secret put MOT_CLIENT_ID
echo "3/5 DVSA client secret"
npx wrangler secret put MOT_CLIENT_SECRET
echo "4/5 DVSA API key"
npx wrangler secret put MOT_API_KEY
echo "5/5 DVSA token URL (looks like https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token)"
npx wrangler secret put MOT_TOKEN_URL

echo
echo "Deploying…"
npx wrangler deploy

URL="https://vehicle-lookup.got2005lhs.workers.dev/?reg=AB12CDE"
echo
echo "Testing $URL"
sleep 3
curl -sS "$URL" | head -c 400 || true
echo
echo "── Done. If you saw JSON above (even 'No record found'), the app works now."
