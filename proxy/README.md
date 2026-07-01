# NTIS live-data proxy

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that lets the
**NTIS Data** page (`/ntis.html`) show **live** National Highways traffic data.

## Why it's needed

The page is a static site, so it can't:

1. **Hold your NTIS login** — public page code is readable by anyone.
2. **Call the NTIS feed directly** — browsers block cross-site requests unless
   the other server sends a CORS header, which NTIS does not.

This proxy solves both: it keeps your login as a **secret**, fetches the DATEX II
XML server-side, and returns it to the page with the right CORS header.

```
browser (ntis.html)  →  this proxy (holds login, adds CORS)  →  NTIS DATEX II feed
```

Cloudflare's free plan is plenty for this (100k requests/day).

---

## One-time setup (~5 minutes)

### 0. Get an NTIS account (only you can do this)

Register for National Highways DATEX II access and note your **username**,
**password**, and the **feed URL** they give you. That feed URL is what goes in
`NTIS_FEED_URL` below.

### 1. Install the tooling

```bash
npm install -g wrangler      # Cloudflare's CLI
wrangler login               # opens a browser to authorise your CF account
```

(A free Cloudflare account is created during `wrangler login` if you don't have one.)

### 2. Set the feed URL

Edit `wrangler.toml` and replace the `NTIS_FEED_URL` placeholder with your real
feed URL. Leave `ALLOW_ORIGIN` as the GitHub Pages URL (or `"*"` while testing).

### 3. Add your login as secrets (this is the part only you do)

Run these from inside the `proxy/` folder. Each command prompts you to paste the
value — it is stored encrypted by Cloudflare and never written to any file or git:

```bash
wrangler secret put NTIS_USER      # paste your NTIS username
wrangler secret put NTIS_PASS      # paste your NTIS password
```

### 4. Deploy

```bash
wrangler deploy
```

Wrangler prints a URL like:

```
https://ntis-proxy.<your-subdomain>.workers.dev
```

### 5. Point the page at it

Open **https://jet11111.github.io/marker-post/ntis.html**, paste that Worker URL
into the **DATEX II feed URL** box, and press **Fetch feed**. Live data. 🎉

The page remembers the URL, so you only paste it once.

---

## Test the proxy without the page

```bash
curl https://ntis-proxy.<your-subdomain>.workers.dev | head
```

You should get DATEX II XML. A `401` means the NTIS login is wrong; a `500` means
a secret/var is missing.

## Multiple feeds

To expose more than one NTIS feed (events, VMS signs, …), set `NTIS_FEEDS` in
`wrangler.toml` to a JSON map and call the proxy with `?feed=<name>`:

```toml
NTIS_FEEDS = '{"events":"https://.../events.xml","vms":"https://.../signs.xml"}'
```

## Security notes

- Your login lives only in Cloudflare's encrypted secret store — not in git, not
  in the page, not in this repo.
- `ALLOW_ORIGIN` restricts which site may call the proxy. Keep it set to your
  Pages URL in production so it isn't an open relay.
