// sw.js, run here against stand-ins for the browser's Cache Storage, network
// and clock. A real service worker cannot be started in Node, so its
// lifecycle is not tested; what it saves, what it serves, how long it waits,
// which build each page is kept to and what it leaves alone are. The last
// three tests join it to data.js: the page is answered by the worker when the
// network stalls, reads the worker's saved copy straight from its cache, and
// recognises its fallback answer.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { deferred, fakeNetwork, flush, jsonResponse, test } from './data-fakes.mjs';

const BASE = 'https://example.test/app/';
const at = (path) => new URL(path, BASE).href;
const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const BUILD_BLOCK = /\/\*__BUILD__\*\/[\s\S]*?\/\*__END_BUILD__\*\//; // the block scripts/build-web.mjs rewrites
const BUILD = { version: '2.0.0-abc12345', assets: [] };
const APP_CACHE = 'markerpost-2.0.0-abc12345';

// The page that the last two tests load data.js into. Set before it is loaded.
globalThis.document = { baseURI: at('index.html?q=M27#map'), documentElement: { dataset: {} } };
const { loadSnapshot } = await import('../data.js');

/**
 * Cache Storage as far as sw.js and data.js use it.
 * initial: { cacheName: { path: data } } in the order the caches were made.
 * Set `hold` to a deferred to keep every write waiting, as a slow disk would.
 */
function cacheStorage(initial, fetch) {
  const store = new Map();
  const key = (request) => at(typeof request === 'string' ? request : request.url);
  const entries = (name) => { if (!store.has(name)) store.set(name, new Map()); return store.get(name); };
  for (const [name, files] of Object.entries(initial)) {
    for (const [path, data] of Object.entries(files)) entries(name).set(at(path), jsonResponse(data));
  }
  const storage = {
    store, hold: null,
    async open(name) {
      entries(name);
      return {
        // As in a browser, the whole body is read before the copy exists: a
        // download that fails part-way saves nothing, and the copy that was
        // there stays.
        async put(request, response) {
          if (storage.hold) await storage.hold.promise;
          const body = await response.arrayBuffer();
          entries(name).set(key(request), new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
        },
        // All or nothing, as in a browser: one file that fails saves none.
        async addAll(requests) {
          const got = await Promise.all(requests.map(async (request) => {
            const response = await fetch(request);
            if (!response.ok) throw new TypeError(`${key(request)} returned ${response.status}`);
            return [key(request), response];
          }));
          for (const [url, response] of got) entries(name).set(url, response);
        },
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(request, { cacheName } = {}) {
      for (const name of cacheName ? [cacheName] : [...store.keys()]) {
        const hit = store.get(name)?.get(key(request));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    has: (name, path) => Boolean(store.get(name)?.has(at(path))),
    read: (name, path) => store.get(name).get(at(path)).clone().json(),
    text: (name, path) => store.get(name).get(at(path)).clone().text(),
  };
  return storage;
}

/** Load sw.js as a browser would and hand back ways to send it events. */
function startWorker({ build = BUILD, saved = {} } = {}) {
  const net = fakeNetwork();
  // The worker's own requests: by address, or with a Request (one it was
  // handed by a page, or one it made itself). As in a browser, a request made
  // with a page's Request is given up when the page gives up; a request made
  // by address is the worker's own, and is not.
  const fetch = (request, init = {}) => (typeof request === 'string'
    ? net.fetch(at(request), init)
    : net.fetch(request.url, { cache: request.cache, ...(request.signal ? { signal: request.signal } : {}), ...init }));
  const caches = cacheStorage(saved, fetch);
  const listeners = {};
  const did = { skipWaiting: 0, claim: 0 };
  class Request {
    constructor(url, init = {}) { this.url = at(url); this.method = 'GET'; this.headers = new Headers(); Object.assign(this, init); }
  }
  const self = {
    location: new URL('sw.js', BASE),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { did.skipWaiting++; },
    clients: { claim: async () => { did.claim++; } },
  };
  const code = build ? source.replace(BUILD_BLOCK, `/*__BUILD__*/ ${JSON.stringify(build)} /*__END_BUILD__*/`) : source;
  // The clock is looked up at each call, so a test that fakes time fakes the worker's time too.
  const clock = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    Date: { now: () => Date.now() },
  };
  const scope = { self, caches, fetch, Request, Response, Headers, URL, console, ...clock };
  vm.runInNewContext(code, scope, { filename: 'sw.js' });

  /**
   * Send one event. `ids` says which page it concerns, as a browser does: a
   * request for a page carries the id that page will have (resultingClientId),
   * and each of the page's own requests then carries it as clientId.
   * `lifetime` settles when the worker says it has finished with the event.
   */
  const send = (type, request, ids = {}) => {
    let answer = null;
    const waits = [];
    listeners[type]({
      request, clientId: '', resultingClientId: '', ...ids,
      respondWith(promise) { answer = Promise.resolve(promise); },
      waitUntil(promise) { waits.push(Promise.resolve(promise)); },
    });
    const lifetime = Promise.all(waits);
    lifetime.catch(() => {});
    return { handled: answer !== null, answer, lifetime };
  };
  return {
    net, caches, did,
    /** The worker's rule for how a request is answered: a plain function, asked directly. */
    plan: scope.plan,
    install: () => send('install').lifetime,
    activate: () => send('activate').lifetime,
    /** A page asks for a file. Resolves { handled, response, lifetime }. */
    async fetch(request, ids) {
      const sent = send('fetch', request, ids);
      return { handled: sent.handled, response: sent.handled ? await sent.answer : null, lifetime: sent.lifetime };
    },
  };
}

/** A request from the page, as the worker sees it. `signal` is the page's way of giving the request up. */
const get = (path, { mode = 'cors', headers = {}, method = 'GET', signal } = {}) =>
  ({ url: at(path), method, mode, headers: new Headers(headers), ...(signal ? { signal } : {}) });
const marked = (response) => response.headers.get('X-Markerpost-Cache') === 'fallback';

/**
 * A browser tab: its page, then that page's own requests, as the worker sees
 * them. (Existing tests that pass no ids are the browser that gives none, or
 * a page this worker never saw being opened.)
 */
let tabs = 0;
function openTab(worker) {
  const id = `tab-${++tabs}`;
  return {
    /** The tab asks for the app's page. */
    open: (path = '') => worker.fetch(get(path, { mode: 'navigate' }), { resultingClientId: id }),
    /** The page, once open, asks for one of its own files. */
    get: (path) => worker.fetch(get(path), { clientId: id }),
  };
}

test('the build block is where scripts/build-web.mjs expects it, and unbuilt the worker still loads', () => {
  assert.match(source, BUILD_BLOCK);
  assert.match(source, /const BUILD = \/\*__BUILD__\*\/ \{ version: 'dev', assets: \[\] \} \/\*__END_BUILD__\*\/;/);
  const worker = startWorker({ build: null });
  assert.equal(typeof worker.install, 'function');
});

test('installing saves every file of the build in the build\'s own cache, or none of them', async () => {
  const build = { version: '2.0.0-abc12345', assets: ['.', 'app.js', 'data/posts.json', 'data/post-sections.json'] };
  const worker = startWorker({ build });
  for (const path of build.assets) worker.net.answer(at(path), { file: path });
  await worker.install();
  assert.deepEqual([...worker.caches.store.get(APP_CACHE).keys()], build.assets.map(at));
  assert.ok(worker.net.calls.every((call) => call.init.cache === 'reload'), 'fetched afresh, past the browser\'s own cache');
  assert.equal(worker.did.skipWaiting, 1);

  // One file missing: nothing is saved and the new worker does not take over.
  const broken = startWorker({ build });
  for (const path of build.assets.slice(1)) broken.net.answer(at(path), { file: path });
  broken.net.answer(at('.'), 'Not found', { status: 404 });
  await assert.rejects(broken.install());
  assert.equal(broken.caches.store.get(APP_CACHE).size, 0);
  assert.equal(broken.did.skipWaiting, 0);
});

test('activating removes this app\'s older caches and nothing else', async () => {
  const worker = startWorker({
    saved: {
      'markerpost-v27-mobile-map': { 'data/posts.json': [] },
      'markerpost-basemap-v1': { 'tiles/hampshire.pmtiles': 'the street map, downloaded once' },
      'another-app-v1': { 'x.json': {} },
      [APP_CACHE]: { 'data/posts.json': [] },
      'markerpost-2.0.0-older000': { 'data/posts.json': [] },
    },
  });
  await worker.activate();
  assert.deepEqual(await worker.caches.keys(), ['markerpost-basemap-v1', 'another-app-v1', APP_CACHE]);
  assert.equal(worker.did.claim, 1);
});

test('requests the worker must leave to the browser', async () => {
  const worker = startWorker();
  const left = [
    get('data/vms.json', { method: 'POST' }),
    { ...get('x.json'), url: 'https://elsewhere.test/app/x.json' },   // another site (the sign relay, map tiles)
    get('tiles/hampshire.pmtiles'),                                    // the street map archive
    get('tiles/hampshire.pmtiles', { headers: { range: 'bytes=0-16383' } }),
    get('data/network.json', { headers: { range: 'bytes=0-99' } }),    // any request for part of a file
  ];
  for (const request of left) {
    const { handled } = await worker.fetch(request);
    assert.equal(handled, false, `${request.method} ${request.url}`);
  }
  assert.equal(worker.net.calls.length, 0);
});

test('a good answer is passed on, saved, and the worker stays up until it is saved', async () => {
  const worker = startWorker();
  worker.net.answer(at('data/vms.json'), { v: 'fresh' });
  worker.caches.hold = deferred(); // the write to the cache is slow
  const { response, lifetime } = await worker.fetch(get('data/vms.json'));
  assert.equal(worker.net.calls[0].init.cache, 'no-cache', 'always checked with the site, never the browser\'s own copy');
  assert.deepEqual(await response.json(), { v: 'fresh' });
  assert.equal(marked(response), false);

  // The page has its answer; the copy is still being written.
  let finished = false;
  lifetime.then(() => { finished = true; });
  await flush();
  assert.equal(worker.caches.has('markerpost-2.0.0-abc12345', 'data/vms.json'), false);
  assert.equal(finished, false, 'the worker has not said it is done');
  worker.caches.hold.resolve();
  await lifetime;
  assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/vms.json'), { v: 'fresh' });
});

test('when the network fails the saved copy is served, and marked as a saved copy', async () => {
  const worker = startWorker({ saved: { [APP_CACHE]: { 'data/vms.json': { v: 'saved' } } } });
  worker.net.fail(at('data/vms.json'));
  const { response, lifetime } = await worker.fetch(get('data/vms.json'));
  assert.equal(response.status, 200);
  assert.equal(marked(response), true);
  assert.deepEqual(await response.json(), { v: 'saved' });
  await lifetime;

  // A copy kept by an older version of the app will do when this one has none yet.
  const updated = startWorker({ saved: { 'markerpost-v27-mobile-map': { 'data/vms.json': { v: 'older' } }, [APP_CACHE]: {} } });
  updated.net.fail(at('data/vms.json'));
  const old = (await updated.fetch(get('data/vms.json'))).response;
  assert.equal(marked(old), true);
  assert.deepEqual(await old.json(), { v: 'older' });
});

test('an error from the site never overwrites the saved copy', async () => {
  const worker = startWorker({ saved: { [APP_CACHE]: { 'data/vms.json': { v: 'saved' } } } });
  worker.net.answer(at('data/vms.json'), 'Service unavailable', { status: 503 });
  const { response, lifetime } = await worker.fetch(get('data/vms.json'));
  await lifetime;
  assert.equal(marked(response), true);
  assert.deepEqual(await response.json(), { v: 'saved' });
  assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/vms.json'), { v: 'saved' });

  // With nothing saved the error itself is passed on, and still nothing is saved.
  const empty = startWorker();
  empty.net.answer(at('data/vms.json'), 'Service unavailable', { status: 503 });
  const passed = await empty.fetch(get('data/vms.json'));
  await passed.lifetime;
  assert.equal(passed.response.status, 503);
  assert.equal(marked(passed.response), false);
  assert.equal(empty.caches.has(APP_CACHE, 'data/vms.json'), false);
});

test('the page itself is never served in answer to a request for data or code', async () => {
  const worker = startWorker({ saved: { [APP_CACHE]: { 'index.html': '<!doctype html><title>Marker Post</title>' } } });
  for (const path of ['data/network.json', 'map.js']) {
    worker.net.fail(at(path));
    const { response } = await worker.fetch(get(path));
    assert.equal(response.status, 503, path);
    assert.doesNotMatch(await response.text(), /<!doctype html>/i, path);
  }
  // Opening the app at an address that was never saved is different: the page is the right answer.
  worker.net.fail(at('?q=M27'));
  const { response } = await worker.fetch(get('?q=M27', { mode: 'navigate' }));
  assert.match(await response.text(), /<!doctype html>/i);
});

// ------------------------------------------------ a slow or stalled network

const fakeTime = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
/** Whether a request has been answered yet, without waiting for it. */
function watch(promise) {
  const state = { answered: false };
  promise.then(() => { state.answered = true; }, () => { state.answered = true; });
  return state;
}
const PAGE = '<!doctype html><title>Marker Post</title>';
// config.js is written by the build, and carries the build's id.
const CONFIG = 'export default { build: "abc12345" };';
// A build as scripts/build-web.mjs lists it, and that build saved on the device.
const RELEASE = { version: '2.0.0-abc12345', assets: ['.', 'index.html', 'app.js', 'map.js', 'config.js', 'data/posts.json', 'data/vms.json'] };
const installed = () => ({
  [APP_CACHE]: {
    '.': PAGE, 'index.html': PAGE, 'app.js': 'saved code', 'map.js': 'saved map code', 'config.js': CONFIG,
    'data/posts.json': { v: 'saved posts' }, 'data/vms.json': { v: 'saved signs' },
  },
});
// The next release, as it stands on the site before this device has saved it.
const NEW_PAGE = '<!doctype html><title>Marker Post</title><p>Release 2</p>';
const NEW_CONFIG = 'export default { build: "def67890" };';

test('a stalled network costs three seconds, not the data: the saved copy is sent, marked, and the download is kept when it arrives', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  const request = worker.net.stall(at('data/vms.json'));
  const asked = worker.fetch(get('data/vms.json'));
  const state = watch(asked);

  t.mock.timers.tick(2999);
  await flush();
  assert.equal(state.answered, false, 'the network is still being waited for just before three seconds');
  t.mock.timers.tick(1);
  const { response, lifetime } = await asked;
  assert.equal(marked(response), true);
  assert.deepEqual(await response.json(), { v: 'saved signs' });
  assert.equal(worker.net.calls[0].aborted, false, 'the download is left running');

  // The page has its answer. The worker stays up for the download, and keeps it.
  const kept = watch(lifetime);
  await flush();
  assert.equal(kept.answered, false);
  request.release({ v: 'fresh signs' });
  await lifetime;
  assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/vms.json'), { v: 'fresh signs' });
});

test('a late answer that is an error, or no answer at all, leaves the saved copy as it was', async (t) => {
  fakeTime(t);
  for (const end of ['error', 'failure']) {
    const worker = startWorker({ build: RELEASE, saved: installed() });
    const request = worker.net.stall(at('data/vms.json'));
    const asked = worker.fetch(get('data/vms.json'));
    t.mock.timers.tick(3000);
    const { response, lifetime } = await asked;
    assert.deepEqual(await response.json(), { v: 'saved signs' }, end);
    if (end === 'error') request.release('Service unavailable', { status: 503 }); else request.drop();
    await lifetime;
    assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/vms.json'), { v: 'saved signs' }, end);
  }
});

test('with nothing saved the network is all there is, and it is waited for', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  const request = worker.net.stall(at('data/new.json'));
  const asked = worker.fetch(get('data/new.json'));
  const state = watch(asked);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(state.answered, false);
  request.release({ v: 'fresh' });
  const { response, lifetime } = await asked;
  assert.equal(marked(response), false);
  assert.deepEqual(await response.json(), { v: 'fresh' });
  await lifetime;
  assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/new.json'), { v: 'fresh' });
});

test('another page on the site that is merely slow is waited for, not swapped for the app\'s page', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  const request = worker.net.stall(at('ntis.html'));
  const asked = worker.fetch(get('ntis.html', { mode: 'navigate' }));
  const state = watch(asked);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(state.answered, false, 'nothing of its own is saved, so the network is waited for');
  request.release('<!doctype html><title>NTIS</title>');
  assert.match(await (await asked).response.text(), /NTIS/);

  // With no connection at all the app's page is better than nothing, as it always was.
  worker.net.fail(at('other.html'));
  const offline = await worker.fetch(get('other.html', { mode: 'navigate' }));
  assert.equal(await offline.response.text(), PAGE);
});

// These three are a browser that does not say which page a request is from,
// or a page the worker never saw being opened: nothing is on record about
// it, so its files get the time limit. ("One build to a page", further down,
// is a browser that does say.)

test('opening the app on a stalled network costs one wait: the saved page, then the rest of the saved app at once', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  for (const path of ['?sim=50.9,-1.3', 'app.js', 'map.js', 'data/posts.json']) worker.net.stall(at(path));

  // The page itself: three seconds for the network, then the saved page, whatever the address asks for.
  const page = worker.fetch(get('?sim=50.9,-1.3', { mode: 'navigate' }));
  const state = watch(page);
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(state.answered, false);
  t.mock.timers.tick(1);
  assert.equal(await (await page).response.text(), PAGE);
  assert.equal(worker.net.count(at('config.js')), 0, 'with nowhere to record the answer, the site is not asked which build it has');

  // Its code is not made to wait again, and the network is not asked: every
  // file of the app comes from the one saved build.
  const before = worker.net.calls.length;
  for (const [path, body] of [['app.js', 'saved code'], ['map.js', 'saved map code']]) {
    const { response } = await worker.fetch(get(path));
    assert.equal(await response.text(), body, path);
  }
  assert.equal(worker.net.calls.length, before, 'no request was made for the app\'s own files');

  // Data is still asked for, but given only a moment.
  const data = worker.fetch(get('data/posts.json'));
  const dataState = watch(data);
  t.mock.timers.tick(399);
  await flush();
  assert.equal(dataState.answered, false);
  t.mock.timers.tick(1);
  const posts = (await data).response;
  assert.equal(marked(posts), true);
  assert.deepEqual(await posts.json(), { v: 'saved posts' });
  assert.equal(worker.net.calls.length, before + 1);
});

test('a quick answer from the network ends the hurry, and so does fifteen seconds', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  const slowDown = async () => {
    worker.net.stall(at('data/vms.json'));
    const asked = worker.fetch(get('data/vms.json'));
    t.mock.timers.tick(3000);
    assert.equal(marked((await asked).response), true);
  };
  /** How the app's own code is answered now: at once from the saved build, or by asking the network. */
  const code = async () => {
    const { response } = await worker.fetch(get('app.js'));
    return response.text();
  };
  worker.net.answer(at('app.js'), 'code from the site');

  await slowDown();
  assert.equal(await code(), 'saved code', 'in a hurry: the saved build');
  // The connection comes back: a data file is answered within the moment it is given.
  worker.net.answer(at('data/posts.json'), { v: 'fresh posts' });
  const fresh = (await worker.fetch(get('data/posts.json'))).response;
  assert.equal(marked(fresh), false);
  assert.deepEqual(await fresh.json(), { v: 'fresh posts' });
  assert.equal(await code(), 'code from the site', 'the network is asked first again');

  await slowDown();
  t.mock.timers.tick(14999);
  assert.equal(await code(), 'saved code');
  t.mock.timers.tick(1);
  assert.equal(await code(), 'code from the site', 'after fifteen seconds the network is asked first again');
});

test('the saved build is not changed piece by piece, whatever the site sends; a slow file is answered from it', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });

  // A new release is on the site. Its files are passed on to the page...
  worker.net.answer(at('app.js'), 'release 2 code');
  const passed = await worker.fetch(get('app.js'));
  assert.equal(await passed.response.text(), 'release 2 code');
  assert.equal(marked(passed.response), false);
  worker.net.answer(at('?q=M27'), 'release 2 page');
  const page = await worker.fetch(get('?q=M27', { mode: 'navigate' }));
  assert.equal(await page.response.text(), 'release 2 page');
  await Promise.all([passed.lifetime, page.lifetime]);
  await flush();
  // ...but the saved app stays the build that was installed, whole.
  assert.equal(await worker.caches.text(APP_CACHE, 'app.js'), 'saved code');
  assert.equal(worker.caches.has(APP_CACHE, '?q=M27'), false);

  // The same when the new file arrives too late to be used.
  const slow = worker.net.stall(at('map.js'));
  const asked = worker.fetch(get('map.js'));
  t.mock.timers.tick(3000);
  const { response, lifetime } = await asked;
  assert.equal(await response.text(), 'saved map code');
  slow.release('release 2 map code');
  await lifetime;
  await flush();
  assert.equal(await worker.caches.text(APP_CACHE, 'map.js'), 'saved map code');

  // Data, and a file that is not part of the build, are saved whenever a good answer arrives.
  // So is a file asked for with a query: its saved copy is found by that exact address.
  worker.net.answer(at('data/vms.json'), { v: 'fresh signs' });
  worker.net.answer(at('ntis.js'), 'the NTIS page\'s own code');
  worker.net.answer(at('app.js?v=2'), 'code asked for by another name');
  for (const path of ['data/vms.json', 'ntis.js', 'app.js?v=2']) await (await worker.fetch(get(path))).lifetime;
  assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/vms.json'), { v: 'fresh signs' });
  assert.equal(await worker.caches.text(APP_CACHE, 'ntis.js'), 'the NTIS page\'s own code');
  assert.equal(await worker.caches.text(APP_CACHE, 'app.js?v=2'), 'code asked for by another name');
  assert.equal(await worker.caches.text(APP_CACHE, 'app.js'), 'saved code');

  // Unbuilt (local development) there is no list, so the worker saves what the app fetches.
  const dev = startWorker({ build: null });
  dev.net.answer(at('app.js'), 'code on the desk');
  await (await dev.fetch(get('app.js'))).lifetime;
  assert.equal(await dev.caches.text('markerpost-dev', 'app.js'), 'code on the desk');
});

test('a page that stops waiting does not stop a data download: the copy is still saved', async () => {
  const worker = startWorker({ build: RELEASE, saved: installed() });
  // The answer starts at once and the rest of it crawls in: a big file on a weak signal.
  const body = worker.net.trickle(at('data/vms.json'));
  const page = new AbortController();
  const { response, lifetime } = await worker.fetch(get('data/vms.json', { signal: page.signal }));
  assert.equal(marked(response), false, 'the answer started in time, so it is the site\'s');
  body.push('{"v":');
  await flush();

  // The page gives the request up (data.js does after two minutes; closing the tab does at once).
  page.abort();
  await flush();
  body.push('"fresh signs"}');
  body.end();
  await lifetime;
  assert.deepEqual(await worker.caches.read(APP_CACHE, 'data/vms.json'), { v: 'fresh signs' }, 'the download carried on for the cache');
  const call = worker.net.calls[0];
  assert.equal(call.init.signal, undefined, 'the request was the worker\'s own, by address');
  assert.equal(call.init.cache, 'no-cache');

  // Anything that is not data is still asked for with the page's own request, and is given up with it.
  worker.net.stall(at('ntis.js'));
  const gone = new AbortController();
  const asked = worker.fetch(get('ntis.js', { signal: gone.signal }));
  await flush();
  gone.abort();
  await asked;
  assert.equal(worker.net.calls.at(-1).aborted, true);
});

// ------------------------------------------------------ one build to a page

test('how a request is answered: the rule itself, asked directly', () => {
  const { plan } = startWorker({ build: RELEASE });
  const ask = (question) => ({ ...plan({ app: false, page: false, from: undefined, slow: false, ...question }) });

  // The app's own files follow the build of the page that asks for them.
  assert.deepEqual(ask({ app: true, from: 'saved' }), { saved: true });
  assert.deepEqual(ask({ app: true, from: 'saved', slow: true }), { saved: true });
  assert.deepEqual(ask({ app: true, from: 'site' }), { limit: null });
  assert.deepEqual(ask({ app: true, from: 'site', slow: true }), { limit: null }, 'not even when the network has just been slow');
  // A page that is not on record: the time limit, and no second wait once the network has been slow.
  assert.deepEqual(ask({ app: true }), { limit: 3000 });
  assert.deepEqual(ask({ app: true, slow: true }), { saved: true });
  // The page itself is asked for from the site, unless the network has just been too slow.
  assert.deepEqual(ask({ app: true, page: true }), { limit: 3000 });
  assert.deepEqual(ask({ app: true, page: true, slow: true }), { saved: true });
  // Data, another page on the site, and anything else that is not part of the build: the time limit, whoever asks.
  for (const from of [undefined, 'saved', 'site']) {
    for (const page of [false, true]) {
      assert.deepEqual(ask({ from, page }), { limit: 3000 });
      assert.deepEqual(ask({ from, page, slow: true }), { limit: 400 });
    }
  }
});

test('the site has the build saved here: its page takes all its own files from the saved build, and asks the network for none', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  worker.net.answer(at('?sim=50.9,-1.3'), PAGE);
  worker.net.answer(at('config.js'), CONFIG);
  // After the page the signal goes: nothing more is answered.
  for (const path of ['app.js', 'map.js']) worker.net.stall(at(path));

  const tab = openTab(worker);
  const page = (await tab.open('?sim=50.9,-1.3')).response;
  assert.equal(await page.text(), PAGE);
  assert.equal(marked(page), false, 'the site\'s own answer, sent on as it came');
  assert.equal(worker.net.calls.find((call) => call.url === at('config.js')).init.cache, 'no-cache', 'the site is asked, not the browser\'s own copy');

  const before = worker.net.calls.length;
  assert.equal(await (await tab.get('app.js')).response.text(), 'saved code');
  // Minutes later the Map is opened for the first time: the same.
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(await (await tab.get('map.js')).response.text(), 'saved map code');
  assert.equal(worker.net.calls.length, before, 'no request was made for the app\'s own files');

  // Its data is still asked for from the site, as data always is.
  worker.net.answer(at('data/vms.json'), { v: 'fresh signs' });
  const signs = (await tab.get('data/vms.json')).response;
  assert.equal(marked(signs), false);
  assert.deepEqual(await signs.json(), { v: 'fresh signs' });
});

test('just after a release a page from the site is the new build throughout: a slow file is waited for, never swapped for the saved one', async (t) => {
  fakeTime(t);
  // Release 2 is on the site and release 1 is saved here. A release need not
  // change the page itself: config.js, with the build's id, always changes.
  for (const [changed, sitePage, siteConfig] of [
    ['the page', NEW_PAGE, NEW_CONFIG],
    ['the code only', PAGE, NEW_CONFIG],
    ['the page, on a site caught half-way through its release', NEW_PAGE, CONFIG],
  ]) {
    const worker = startWorker({ build: RELEASE, saved: installed() });
    worker.net.answer(at(''), sitePage);
    worker.net.answer(at('config.js'), siteConfig);
    // app.js is slow to start: a patchy link, or the new worker's own download competing with it.
    const slow = worker.net.stall(at('app.js'));
    worker.net.answer(at('map.js'), 'release 2 map code');
    worker.net.stall(at('data/vms.json'));

    const tab = openTab(worker);
    const page = (await tab.open()).response;
    assert.equal(marked(page), false, changed);
    assert.equal(await page.text(), sitePage, changed);

    const code = tab.get('app.js');
    const state = watch(code);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(state.answered, false, `${changed}: a minute on, still waiting for the site's own file`);
    slow.release('release 2 code');
    assert.equal(await (await code).response.text(), 'release 2 code', changed);

    // Its imports follow from the site as well, although the network has just been too slow for a data file.
    const signs = tab.get('data/vms.json');
    t.mock.timers.tick(3000);
    assert.equal(marked((await signs).response), true, 'data keeps its own rule: the saved copy at three seconds');
    assert.equal(await (await tab.get('map.js')).response.text(), 'release 2 map code', changed);

    // The saved build is untouched and whole, for the next start with no signal.
    await flush();
    assert.equal(await worker.caches.text(APP_CACHE, 'app.js'), 'saved code');
    assert.equal(await worker.caches.text(APP_CACHE, 'map.js'), 'saved map code');
    assert.equal(await worker.caches.text(APP_CACHE, 'index.html'), PAGE);
    assert.equal(await worker.caches.text(APP_CACHE, 'config.js'), CONFIG);
  }
});

test('a page of another build: a file that cannot be had at all is answered from the saved copy, as it always was', async () => {
  const worker = startWorker({ build: RELEASE, saved: installed() });
  worker.net.answer(at(''), NEW_PAGE);
  const tab = openTab(worker);
  await tab.open();

  worker.net.fail(at('map.js')); // the signal has gone
  const map = (await tab.get('map.js')).response;
  assert.equal(marked(map), true);
  assert.equal(await map.text(), 'saved map code');
  worker.net.answer(at('app.js'), 'Not found', { status: 404 }); // or the site answers with an error
  const code = (await tab.get('app.js')).response;
  assert.equal(marked(code), true);
  assert.equal(await code.text(), 'saved code');
});

test('a page that starts to arrive and then stalls, or a site that cannot show which build it has: the saved page at three seconds', async (t) => {
  fakeTime(t);
  for (const stalls of ['the rest of the page', 'the check on the build']) {
    const worker = startWorker({ build: RELEASE, saved: installed() });
    let body = null;
    if (stalls === 'the rest of the page') {
      body = worker.net.trickle(at('?q=M27'));
      worker.net.answer(at('config.js'), CONFIG);
    } else {
      worker.net.answer(at('?q=M27'), PAGE);
      worker.net.stall(at('config.js'));
    }
    worker.net.answer(at('app.js'), 'release 2 code');

    const tab = openTab(worker);
    const opening = tab.open('?q=M27');
    const state = watch(opening);
    await flush();
    if (body) body.push('<!doctype html>');
    t.mock.timers.tick(2999);
    await flush();
    assert.equal(state.answered, false, `${stalls}: the site has its three seconds`);
    t.mock.timers.tick(1);
    const page = (await opening).response;
    assert.equal(marked(page), true, stalls);
    assert.equal(await page.text(), PAGE, stalls);

    // The page that results is the saved build, and the network is not asked for its files.
    const before = worker.net.calls.length;
    assert.equal(await (await tab.get('app.js')).response.text(), 'saved code', stalls);
    assert.equal(worker.net.calls.length, before, stalls);
  }

  // With nothing saved there is nothing to send instead: the site's page is waited for, as before.
  const empty = startWorker({ build: RELEASE });
  empty.net.answer(at(''), NEW_PAGE);
  empty.net.stall(at('config.js'));
  const first = openTab(empty);
  assert.equal(await (await first.open()).response.text(), NEW_PAGE);
});

test('a page answered with the saved page keeps to the saved build for as long as it lives, whatever the network does next', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  worker.net.stall(at(''));
  const tab = openTab(worker);
  const opening = tab.open();
  t.mock.timers.tick(3000);
  assert.equal(marked((await opening).response), true);

  // The connection comes back, with a new release on the site, and the hurry is long over.
  worker.net.answer(at('data/vms.json'), { v: 'fresh signs' });
  assert.equal(marked((await tab.get('data/vms.json')).response), false);
  t.mock.timers.tick(60000);
  worker.net.answer(at(''), NEW_PAGE);
  worker.net.answer(at('config.js'), NEW_CONFIG);
  worker.net.answer(at('app.js'), 'release 2 code');
  worker.net.answer(at('map.js'), 'release 2 map code');
  const before = worker.net.calls.length;
  assert.equal(await (await tab.get('app.js')).response.text(), 'saved code');
  assert.equal(await (await tab.get('map.js')).response.text(), 'saved map code');
  assert.equal(worker.net.calls.length, before, 'the network is not asked for them');

  // The next page to be opened is asked for from the site again, and is the new release throughout...
  const next = openTab(worker);
  assert.equal(await (await next.open()).response.text(), NEW_PAGE);
  assert.equal(await (await next.get('app.js')).response.text(), 'release 2 code');
  // ...while the first page, still open, keeps to its own build.
  assert.equal(await (await tab.get('map.js')).response.text(), 'saved map code');
});

test('the worker keeps the last thirty pages on record; an older one gets the time limit for its files', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  worker.net.fail(at('')); // no connection: each page is answered with the saved page at once
  const opened = [];
  for (let i = 0; i < 31; i++) {
    const tab = openTab(worker);
    assert.equal(marked((await tab.open()).response), true);
    opened.push(tab);
  }
  worker.net.answer(at('app.js'), 'code from the site');
  assert.equal(await (await opened[30].get('app.js')).response.text(), 'saved code');
  assert.equal(await (await opened[1].get('app.js')).response.text(), 'saved code');
  // The first is no longer on record: the site is asked first, as for any page the worker does not know...
  assert.equal(await (await opened[0].get('app.js')).response.text(), 'code from the site');
  // ...and is given three seconds, not for ever.
  worker.net.stall(at('map.js'));
  const map = opened[0].get('map.js');
  t.mock.timers.tick(3000);
  assert.equal(await (await map).response.text(), 'saved map code');
});

test('a stalled network with the worker in charge: the page has the saved copy at three seconds, through the worker', async (t) => {
  fakeTime(t);
  const worker = startWorker({ build: RELEASE, saved: installed() });
  worker.net.stall(at('data/vms.json'));
  globalThis.caches = worker.caches;
  globalThis.fetch = async (url) => (await worker.fetch(get(url))).response;
  const load = loadSnapshot('vms.json', { timeoutMs: 8000 });
  await flush();
  // One second before the page would stop waiting and look in the cache itself.
  t.mock.timers.tick(3000);
  assert.deepEqual(await load, { data: { v: 'saved signs' }, origin: 'saved' });
});

test('a slow site: the page reads the copy this worker saved, straight from its cache', async (t) => {
  // Yesterday the worker saved a good answer.
  const worker = startWorker();
  worker.net.answer(at('data/network.json'), { fetchedAt: 'yesterday' });
  await (await worker.fetch(get('data/network.json'))).lifetime;

  // Today the connection is up but nothing comes back. The page (data.js)
  // stops waiting after a few seconds and looks in the worker's cache itself.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.caches = worker.caches;
  globalThis.fetch = () => new Promise(() => {});
  const load = loadSnapshot('network.json', { timeoutMs: 20000 });
  t.mock.timers.tick(4000);
  assert.deepEqual(await load, { data: { fetchedAt: 'yesterday' }, origin: 'saved' });
});

test('no connection: the page recognises the worker\'s fallback answer as a saved copy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = startWorker({ saved: { [APP_CACHE]: { 'data/vms.json': { fetched: 'earlier' } } } });
  worker.net.fail(at('data/vms.json'));
  globalThis.caches = worker.caches;
  // The page's requests go through the worker, as they do once it is in control.
  globalThis.fetch = async (url) => (await worker.fetch(get(url))).response;
  assert.deepEqual(await loadSnapshot('vms.json'), { data: { fetched: 'earlier' }, origin: 'saved' });

  // Back in signal, the same request is a download again.
  worker.net.answer(at('data/vms.json'), { fetched: 'now' });
  assert.deepEqual(await loadSnapshot('vms.json'), { data: { fetched: 'now' }, origin: 'network' });
});
