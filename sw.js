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

// The app itself (the page, its code, styles and fonts) is the files of this
// build other than its data. It is saved once, as a set, when the worker
// installs, and not piece by piece afterwards: the saved app is then always
// one whole build, never a mixture of two. Data files change without a new
// build, so a good answer for one is saved whenever it arrives; so is
// anything that is not in the list (and unbuilt, nothing is). An address
// with a query counts as the app only when it is the page that is asked for:
// the saved copy of any other file is found by its exact address.
const HOME = new URL('./', self.location.href);
const BUILT = new Set(BUILD.assets.map((path) => new URL(path, HOME).href));
const DATA = new URL('data/', HOME).href;
const isApp = (request, url) => BUILT.has(url.origin + url.pathname) && !url.href.startsWith(DATA)
  && (!url.search || request.mode === 'navigate');

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

// The network is asked first, and told to check with the site (`no-cache`),
// so that a new release and fresh data are picked up: a still-fresh entry in
// the browser's own HTTP cache must not be reused after a deployment. The
// saved copy is the fallback, and it is marked, so the app can say "saved
// copy" instead of presenting old data as fresh.
const MARK = 'X-Markerpost-Cache';
const isSaved = (response) => response.headers.get(MARK) === 'fallback';
async function asSaved(hit) {
  const headers = new Headers(hit.headers);
  headers.set(MARK, 'fallback');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}
async function cacheFallback(request) {
  const hit = await caches.match(request, { cacheName: CACHE }) || await caches.match(request);
  return hit ? asSaved(hit) : null;
}

// What can be sent without the network: the saved copy. When the page itself
// is asked for, the saved page will do whatever the rest of the address says.
// Nothing else may stand in: a request for data or code must never be
// answered with HTML disguised as a dataset.
async function withoutNetwork(request) {
  const hit = await cacheFallback(request);
  if (hit || request.mode !== 'navigate') return hit;
  const page = await caches.match('index.html');
  return page ? asSaved(page) : null;
}

// The network is not waited for without limit. On a weak signal a request can
// hang for minutes, and that left a blank screen although the whole app was
// on the device. When there is a saved copy the network gets PATIENCE_MS to
// answer; then the copy is sent, and the download carries on for the cache.
// With nothing saved the network is all there is, and it is waited for.
// (data.js gives the page's own data requests a second longer, and reads
// these caches itself when a download that has started is slow to finish. It
// relies on the cache names, the "markerpost-" prefix, and on a good answer
// for a data file always being saved.)
const PATIENCE_MS = 3000;
// Once the network has been too slow, the requests that follow are not each
// made to wait again: for SLOW_FOR_MS a data file gets only HURRY_MS, and the
// app itself is sent from the saved build at once (its page, and the files of
// a page that is not on record: see below). A quick answer from the network
// ends it.
const HURRY_MS = 400;
const SLOW_FOR_MS = 15000;
let slowUntil = 0;

// A page is all one build. The time limit, applied file by file, could put
// one together from two: just after a release the site holds a newer build
// than the one saved here, and a saved file would stand in for each of the
// site's files that happened to be slow. So the choice is made once, when the
// page itself is answered, and the page's own files follow it for as long as
// the page lives:
//   "saved"  the page belongs to the build saved here: it was answered with
//            the saved page, or by the site with that very build (see
//            buildOnSite). Its files come from the saved build at once, and
//            the network is not asked.
//   "site"   the site answered with something else: as a rule, a newer
//            build. Its files come from the site, however slow. A saved copy
//            stands in only if a request fails outright, as it did before
//            there was a time limit (the page may then be part one build,
//            part the other).
// The record is lost when the browser stops this worker between requests, and
// some pages were never on it (opened before this worker took charge, or in a
// browser that does not say which page a request is from). Their files get
// the time limit, as data files always do.
const pages = new Map(); // a page's client id -> "saved" | "site"
const PAGES_KEPT = 30;
function remember(id, build) {
  pages.delete(id);
  pages.set(id, build);
  if (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value); // the oldest goes
}

/**
 * How one request is to be answered. It only works the answer out: the same
 * question always gets the same one.
 *   app    it is for a file of this build (isApp)
 *   page   it is for a page (a navigation)
 *   from   the build of the page that is asking: "saved", "site", or nothing
 *          when that is not on record
 *   slow   the network has just been too slow
 * Returns { saved: true } to send the saved copy at once without asking the
 * network. Otherwise { limit }: how long (ms) the network is given before a
 * saved copy is sent instead, or null to wait for it however long it takes.
 */
function plan({ app, page, from, slow }) {
  if (app && !page && from === 'saved') return { saved: true };
  if (app && !page && from === 'site') return { limit: null };
  if (app && slow) return { saved: true };
  return { limit: slow ? HURRY_MS : PATIENCE_MS };
}

/** The promise's value, or nothing if it fails or `ms` pass first. Never rejects. */
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, Math.max(0, ms));
  promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(); });
});

const INDEX = new URL('index.html', HOME).href;
const CONFIG = new URL('config.js', HOME).href;
/**
 * Which build the site is serving, going by the page it has just sent
 * (`page`) and its config.js, asked for at the same moment (`config`).
 *   "site"   another build: the page is not the saved page, or config.js is
 *            not the saved one. config.js carries the build's id, so it
 *            differs whenever any file of the app does.
 *   "saved"  the build saved here. The page is the saved page, byte for
 *            byte, so with the saved files it is exactly the saved build,
 *            whatever else the site holds.
 * Fails when either cannot be read.
 */
async function buildOnSite(page, config) {
  const text = async (response) => {
    if (!response || !response.ok) throw new Error('nothing to compare');
    return response.text();
  };
  const saved = (address) => caches.match(address, { cacheName: CACHE });
  if (await text(page) !== await text(await saved(INDEX))) return 'site';
  return await text(await config) === await text(await saved(CONFIG)) ? 'saved' : 'site';
}

/**
 * The app's own page has been answered with `response`. Work out which build
 * the page belongs to, put that on record (under `id`) for the files it is
 * about to ask for, and hand back what the page is to be sent. `config` is
 * the site's config.js when the site was asked, and `left` is how much of
 * the network's time (ms) remains. If the site cannot show in that time which
 * build it is serving, the page is slow in all but its first few bytes, and
 * the saved page is sent instead.
 */
async function placePage(request, response, config, id, left) {
  let build = isSaved(response) ? 'saved' : 'site';
  if (config && response.ok && build === 'site') {
    build = await within(buildOnSite(response.clone(), config), left);
    const instead = build ? null : await withoutNetwork(request).catch(() => null);
    if (instead) {
      slowUntil = Date.now() + SLOW_FOR_MS;
      if (response.body) response.body.cancel().catch(() => {}); // nobody will read it
      response = instead;
    }
    build = build || (instead ? 'saved' : 'site');
  }
  remember(id, build);
  return response;
}

/**
 * Ask the network. `limit` is how long (ms) it is given when there is a saved
 * copy to send instead; null waits for it however long it takes. `answer` is
 * what the page is sent. `kept` settles when there is nothing left to save,
 * which can be long after the page was answered: until then the worker must
 * stay running.
 */
function viaNetwork(request, app, limit) {
  const started = Date.now();
  let timer = null;
  let settled = false; // the network has answered, or failed
  let sent = false;    // the page was sent the saved copy instead of waiting
  let saving = null;   // set while a good answer is being written to the cache

  // A data file is asked for by its address, not with the page's own request.
  // A request made with the page's request ends when the page stops waiting
  // (data.js gives up after two minutes, and a tab can be closed at any
  // moment), and the copy being saved would be lost with it.
  const byAddress = request.mode !== 'navigate' && request.url.startsWith(DATA);
  const network = fetch(byAddress ? request.url : request, { cache: 'no-cache' }).then((res) => {
    settled = true;
    clearTimeout(timer);
    if (Date.now() - started < PATIENCE_MS) slowUntil = 0; // the network is quick (again)
    // An HTTP error must not overwrite the last usable offline snapshot.
    if (res.ok && !app) {
      const copy = sent ? res : res.clone();
      saving = caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
    } else if (sent && res.body) {
      res.body.cancel().catch(() => {}); // nobody will read it: let the connection go
    }
    return res;
  }, (err) => {
    settled = true;
    clearTimeout(timer);
    throw err;
  });

  // (Once the page has the saved copy, a late answer is for the cache only.)
  const fromNetwork = network.then(
    (res) => (res.ok || sent ? res : cacheFallback(request).then((hit) => hit || res)),
    () => (sent ? null : withoutNetwork(request).then((hit) => hit || new Response('Offline and not cached', { status: 503 }))),
  );
  const kept = app ? Promise.resolve() : network.then(() => saving, () => {});
  if (limit == null) return { answer: fromNetwork, kept };

  // Too slow: the saved copy, if there is one. (The saved page stands in for
  // the app's own page only. Another page on the site that is merely slow is
  // waited for, not swapped for this one.)
  const tooSlow = new Promise((resolve) => {
    timer = setTimeout(() => (app ? withoutNetwork(request) : cacheFallback(request)).then((hit) => {
      if (settled || !hit) return; // the network got there first, or nothing is saved
      sent = true;
      if (limit >= PATIENCE_MS) slowUntil = Date.now() + SLOW_FOR_MS;
      resolve(hit);
    }, () => {}), limit);
  });
  return { answer: Promise.race([fromNetwork, tooSlow]), kept };
}

self.addEventListener('fetch', (e) => {
  const request = e.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The base map archive is read in byte ranges (partial responses cannot be
  // cached) or straight from its own cache by the page. Leave it to the browser.
  if (url.pathname.endsWith('.pmtiles') || request.headers.has('range')) return;
  const started = Date.now();
  const app = isApp(request, url), page = request.mode === 'navigate';
  // The app's own page, in a browser that says which page a request is from:
  // the build it belongs to goes on record, under the id its requests will carry.
  const id = app && page ? e.resultingClientId : '';
  const how = plan({ app, page, from: pages.get(e.clientId), slow: started < slowUntil });
  let answer, config = null;
  if (how.saved) {
    // (A file that is not saved after all is asked for from the network.)
    answer = withoutNetwork(request).catch(() => null)
      .then((hit) => hit || viaNetwork(request, true, PATIENCE_MS).answer);
  } else {
    const asked = viaNetwork(request, app, how.limit);
    answer = asked.answer;
    // Stay running until the copy is saved. The page may have its answer
    // already, and be relying on finding the new copy here next time.
    e.waitUntil(asked.kept);
    if (id) {
      config = fetch(CONFIG, { cache: 'no-cache' });
      config.catch(() => {}); // it may never be looked at
    }
  }
  if (id) {
    answer = answer.then((response) =>
      // (Whatever goes wrong in placing it, the page is still answered.)
      placePage(request, response, config, id, PATIENCE_MS - (Date.now() - started)).catch(() => response));
  }
  e.respondWith(answer);
});
