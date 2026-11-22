// Service worker for the web app: keeps the app shell and the datasets on the
// device so everything except live sign data works with no signal.
//
// scripts/build-web.mjs replaces the block below with the build's version and
// file list. Served unbuilt (local development) the list is empty and the
// worker simply saves what the app fetches.
const BUILD = /*__BUILD__*/ { version: 'dev', assets: [] } /*__END_BUILD__*/;

const PREFIX = 'markerpost-';
const CACHE = `${PREFIX}${BUILD.version}`;
// The optional offline base map lives in its own cache, managed by the page
// (basemap.js). It is large, so it must survive app updates.
const BASEMAP_PREFIX = `${PREFIX}basemap-`;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(BUILD.assets.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    // Remove this app's older caches only: other pages on the same origin keep theirs.
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => k.startsWith(PREFIX) && k !== CACHE && !k.startsWith(BASEMAP_PREFIX))
        .map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Revalidate same-origin HTTP assets: a network-first fetch must not reuse a
// still-fresh browser HTTP cache entry after deployment. The cache is the
// offline fallback, and a fallback response is marked so the app can say
// "saved copy" instead of presenting old data as fresh.
async function cacheFallback(request) {
  const hit = await caches.match(request, { cacheName: CACHE }) || await caches.match(request);
  if (!hit) return null;
  const headers = new Headers(hit.headers);
  headers.set('X-Markerpost-Cache', 'fallback');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The base map archive is read in byte ranges (partial responses cannot be
  // cached) or straight from its own cache by the page. Leave it to the browser.
  if (url.pathname.endsWith('.pmtiles') || e.request.headers.has('range')) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
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
        if (e.request.mode === 'navigate') return caches.match('index.html');
        return new Response('Offline and not cached', { status: 503 });
      })),
  );
});
