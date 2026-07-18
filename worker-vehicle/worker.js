// Vehicle lookup relay (Cloudflare Worker). Keeps the DVLA and DVSA
// credentials server-side, queries both APIs in parallel and returns the slim
// merged card the app renders. Same pattern as worker-vms.
//
// Deploy:   npx wrangler deploy    (from this directory)
// Secrets:  npx wrangler secret put DVLA_KEY
//           npx wrangler secret put MOT_CLIENT_ID
//           npx wrangler secret put MOT_CLIENT_SECRET
//           npx wrangler secret put MOT_API_KEY
// Vars:     MOT_TOKEN_URL in wrangler.toml (from your DVSA registration email)
import { normaliseReg, buildPayload } from "./lookup-shared.mjs";

const ORIGINS = ["https://jet11111.github.io", "http://localhost:8080"];
const DVLA_URL = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
const MOT_URL = "https://history.mot.api.gov.uk/v1/trade/vehicles/registration/";
const CACHE_SECS = 300; // per-reg edge cache: repeat taps don't burn API quota

// DVSA access tokens last ~60 min; cache per-isolate with a safety margin.
let tokenCache = { token: null, exp: 0 };
async function motToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 120000) return tokenCache.token;
  const res = await fetch(env.MOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.MOT_CLIENT_ID,
      client_secret: env.MOT_CLIENT_SECRET,
      scope: env.MOT_SCOPE || "https://tapi.dvsa.gov.uk/.default",
    }),
  });
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// Both callers return { ok, status, data | error } and never throw, so one
// upstream being down still yields a partial card from the other.
async function callDvla(env, reg) {
  try {
    const res = await fetch(DVLA_URL, {
      method: "POST",
      headers: { "x-api-key": env.DVLA_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ registrationNumber: reg }),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `DVLA HTTP ${res.status}` };
    return { ok: true, status: 200, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

async function callMot(env, reg) {
  try {
    const token = await motToken(env);
    const res = await fetch(MOT_URL + encodeURIComponent(reg), {
      headers: { Authorization: `Bearer ${token}`, "X-API-Key": env.MOT_API_KEY },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `MOT HTTP ${res.status}` };
    return { ok: true, status: 200, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...extra, ...cors },
      });

    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    // DVSA is required; DVLA is optional (registration currently closed) —
    // without it the card simply lacks tax status and weight class.
    const missing = ["MOT_CLIENT_ID", "MOT_CLIENT_SECRET", "MOT_API_KEY", "MOT_TOKEN_URL"]
      .filter((k) => !env[k] || String(env[k]).includes("REPLACE"));
    if (missing.length) {
      return json({ error: `Relay not configured: missing ${missing.join(", ")}` }, 500);
    }

    const reg = normaliseReg(new URL(req.url).searchParams.get("reg"));
    if (!reg) return json({ error: "Invalid registration" }, 400);

    const cache = caches.default;
    const cacheKey = new Request(`https://cache.invalid/veh/${reg}`);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }

    const [dvla, dvsa] = await Promise.all([
      env.DVLA_KEY
        ? callDvla(env, reg)
        : Promise.resolve({ ok: false, status: -1, error: "DVLA key not configured" }),
      callMot(env, reg),
    ]);
    const payload = buildPayload(reg, dvla, dvsa);

    if (!payload.found) {
      // No record on any configured source is a real "no such vehicle";
      // an upstream fault must not be cached or mistaken for one.
      const notFound = dvsa.status === 404 && (dvla.status === 404 || dvla.status === -1);
      if (notFound) return json({ ...payload, error: "No record found" }, 404);
      return json(
        { ...payload, error: `Lookup failed (${dvla.error || "?"}; ${dvsa.error || "?"})` },
        502
      );
    }

    const res = json(payload, 200, { "Cache-Control": `public, max-age=${CACHE_SECS}` });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
