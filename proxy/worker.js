// NTIS DATEX II proxy — Cloudflare Worker.
//
// Why this exists: the browser page (ntis.html) can't call the NTIS feed
// directly because (a) the feed needs a login, which must never live in public
// page code, and (b) browsers block cross-site fetches without a CORS header.
// This tiny server sits in the middle: it holds the login as a secret, fetches
// the DATEX II XML, and hands it back to the page with the right CORS header.
//
// Secrets/vars are supplied at deploy time — nothing sensitive is in this file:
//   NTIS_USER, NTIS_PASS   (secrets)  -> `wrangler secret put NTIS_USER` etc.
//   NTIS_FEED_URL          (var)      -> the DATEX II feed URL from your account
//   ALLOW_ORIGIN           (var)      -> which site may call this proxy
//   NTIS_FEEDS             (var,opt)  -> JSON map of name->url for multiple feeds

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    if (!env.NTIS_USER || !env.NTIS_PASS) {
      return new Response(
        "Proxy not configured: set NTIS_USER and NTIS_PASS secrets.",
        { status: 500, headers: cors }
      );
    }

    // Pick the upstream feed. Default is NTIS_FEED_URL; if NTIS_FEEDS (a JSON
    // map) is set, ?feed=<name> selects one of several feeds.
    let feedUrl = env.NTIS_FEED_URL;
    const wanted = new URL(request.url).searchParams.get("feed");
    if (wanted && env.NTIS_FEEDS) {
      try {
        const map = JSON.parse(env.NTIS_FEEDS);
        if (map[wanted]) feedUrl = map[wanted];
      } catch { /* ignore malformed map, fall back to default */ }
    }
    if (!feedUrl) {
      return new Response("Proxy not configured: set NTIS_FEED_URL.", {
        status: 500, headers: cors,
      });
    }

    const auth = "Basic " + btoa(`${env.NTIS_USER}:${env.NTIS_PASS}`);
    let upstream;
    try {
      upstream = await fetch(feedUrl, {
        headers: { Authorization: auth, Accept: "application/xml" },
      });
    } catch (e) {
      return new Response(`Upstream fetch failed: ${e.message}`, {
        status: 502, headers: cors,
      });
    }

    // Pass the DATEX II XML straight through (status preserved so auth errors
    // from NTIS surface clearly on the page).
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
