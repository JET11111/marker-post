// Live VMS relay (Cloudflare Worker). Keeps the NH subscription key
// server-side, fetches the current sign states on demand and serves the
// app's slim JSON with CORS. A ~20 s edge cache means rapid polling from
// the app can never hammer the NH API.
// Deploy:  npx wrangler deploy   (from this directory)
// Secret:  npx wrangler secret put DVMS_KEY
import { fetchSigns } from "../scripts/vms-shared.mjs";

const ORIGINS = ["https://jet11111.github.io", "http://localhost:8080"];

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const cache = caches.default;
    const cacheKey = new Request(new URL("/vms", req.url));
    let hit = await cache.match(cacheKey);
    if (!hit) {
      let body, status = 200;
      try {
        body = JSON.stringify(await fetchSigns(env.DVMS_KEY));
      } catch (e) {
        body = JSON.stringify({ error: String(e && e.message || e) });
        status = 502;
      }
      hit = new Response(body, {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": status === 200 ? "public, max-age=20" : "no-store",
        },
      });
      if (status === 200) ctx.waitUntil(cache.put(cacheKey, hit.clone()));
    }
    const res = new Response(hit.body, hit);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
