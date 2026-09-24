// Service worker: precache app shell + dataset for full offline use.
const CACHE = "markerpost-v26-mobile-map";
const ASSETS = [
  ".",
  "index.html",
  "styles.css",
  "app.js",
  "map.mjs",
  "map-details.mjs",
  "map.css",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "data/network.json",
  "data/posts-supplemental.json",
  "manifest.json",
  "data/posts.json",
  "data/junctions.json",
  "data/eras.json",
  "data/vms.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for same-origin: always fresh when online, cache as offline
// fallback. Keeps full offline use without ever serving a stale app shell.
async function cacheFallback(request) {
  const hit = await caches.match(request);
  if (!hit) return null;
  const headers = new Headers(hit.headers);
  headers.set("X-Markerpost-Cache", "fallback");
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // An HTTP error must not overwrite the last usable offline snapshot.
        if (!res.ok) return cacheFallback(e.request).then((hit) => hit || res);
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => cacheFallback(e.request).then((hit) => {
        if (hit) return hit;
        // JSON/module requests must never receive HTML disguised as a dataset.
        if (e.request.mode === "navigate") return caches.match("index.html");
        return new Response("Offline and not cached", { status: 503 });
      }))
  );
});
