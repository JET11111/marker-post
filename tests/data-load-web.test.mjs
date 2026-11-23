// data.js in the web app: how long a load waits for the network, and what it
// falls back on. The rule under test: a few seconds when the service worker
// has kept a copy, much longer when it has not, and a download that carries on
// after its load has stopped waiting.

import assert from 'node:assert/strict';
import { deferred, fakeCaches, fakeNetwork, flush, test, watchUnhandled } from './data-fakes.mjs';

const BASE = 'https://example.test/app/';
const at = (name) => `${BASE}data/${name}`;      // how the service worker's caches name a file
const APP_CACHE = 'markerpost-2.0.0-abc12345';

// The browser, as far as data.js needs it. Set before the module is loaded.
globalThis.document = { baseURI: `${BASE}index.html?q=M27#map`, documentElement: { dataset: {} } };
const net = fakeNetwork();
globalThis.fetch = net.fetch;
const useCaches = (initial) => { globalThis.caches = fakeCaches(initial); return globalThis.caches; };
useCaches();
const unhandled = watchUnhandled();

const { loadBundled, loadSnapshot } = await import('../data.js');

const fakeTime = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });
/** Whether a promise has settled yet, without waiting for it. */
function watch(promise) {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}
const complete = (d) => Boolean(d && Array.isArray(d.signs));

test('a quick answer from the site is used and reported as downloaded just now', async (t) => {
  fakeTime(t);
  const caches = useCaches({ [APP_CACHE]: { [at('quick.json')]: { v: 'saved' } } });
  net.answer('data/quick.json', { v: 'fresh' });
  assert.deepEqual(await loadSnapshot('quick.json'), { data: { v: 'fresh' }, origin: 'network' });
  assert.equal(net.calls.at(-1).init.cache, 'no-cache', 'a snapshot is always checked with the site');
  assert.equal(caches.reads.length, 0, 'the saved copy is not read when the site answers in time');
});

test('an answer the service worker took from its saved copy is reported as saved', async (t) => {
  fakeTime(t);
  net.answer('data/worker.json', { v: 'old' }, { headers: { 'X-Markerpost-Cache': 'fallback' } });
  assert.deepEqual(await loadSnapshot('worker.json'), { data: { v: 'old' }, origin: 'saved' });
});

test('a slow connection costs four seconds, not the data: the saved copy is used and the download carries on', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: { [at('slow.json')]: { v: 'saved' } } });
  const request = net.stall('data/slow.json');
  const load = loadSnapshot('slow.json', { timeoutMs: 20000 });
  const state = watch(load);

  t.mock.timers.tick(3999);
  await flush();
  assert.equal(state.settled, false, 'still waiting for the site just before four seconds');

  t.mock.timers.tick(1);
  assert.deepEqual(await load, { data: { v: 'saved' }, origin: 'saved' });
  assert.equal(net.calls.at(-1).aborted, false, 'the download is left running');

  // A second load while that download is still running joins it: no new request.
  const again = loadSnapshot('slow.json', { timeoutMs: 20000 });
  await flush();
  assert.equal(net.count('data/slow.json'), 1);
  request.release({ v: 'fresh' });
  assert.deepEqual(await again, { data: { v: 'fresh' }, origin: 'network' });
});

test('with nothing saved the first download gets the full time, then fails honestly; a retry joins it', async (t) => {
  fakeTime(t);
  useCaches();
  const request = net.stall('data/first.json');
  const load = loadSnapshot('first.json', { timeoutMs: 20000 });
  const state = watch(load);

  // (The clock is moved in two steps because the load looks for a saved copy at four seconds.)
  t.mock.timers.tick(4000);
  await flush();
  t.mock.timers.tick(15999);
  await flush();
  assert.equal(state.settled, false, 'no giving up at four seconds when there is nothing to fall back on');

  t.mock.timers.tick(1);
  await assert.rejects(load, /first\.json did not load in 20 seconds/);
  assert.equal(net.calls.at(-1).aborted, false, 'the download is not thrown away');

  const retry = loadSnapshot('first.json', { timeoutMs: 20000 });
  await flush();
  assert.equal(net.count('data/first.json'), 1, 'the retry waits for the same download');
  request.release({ v: 'fresh' });
  assert.deepEqual(await retry, { data: { v: 'fresh' }, origin: 'network' });
});

test('a request that fails at once falls back at once', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: { [at('offline.json')]: { v: 'saved' } } });
  net.fail('data/offline.json');
  // No tick: the saved copy must arrive without any of the waiting time passing.
  assert.deepEqual(await loadSnapshot('offline.json'), { data: { v: 'saved' }, origin: 'saved' });

  useCaches();
  await assert.rejects(loadSnapshot('offline.json'), /Failed to fetch/);
});

test('an error from the site uses the saved copy, or is reported when there is none', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: { [at('gone.json')]: { v: 'saved' } } });
  net.answer('data/gone.json', 'Not found', { status: 404 });
  assert.deepEqual(await loadSnapshot('gone.json'), { data: { v: 'saved' }, origin: 'saved' });

  useCaches();
  await assert.rejects(loadSnapshot('gone.json'), /data\/gone\.json returned 404/);
});

test('an incomplete file from the site is not used: the saved copy is, if it is complete', async (t) => {
  fakeTime(t);
  net.answer('data/signs.json', { signs: 'not a list' });
  useCaches({ [APP_CACHE]: { [at('signs.json')]: { signs: [1, 2] } } });
  assert.deepEqual(await loadSnapshot('signs.json', { validate: complete }), { data: { signs: [1, 2] }, origin: 'saved' });

  useCaches({ [APP_CACHE]: { [at('signs.json')]: { signs: null } } });
  await assert.rejects(loadSnapshot('signs.json', { validate: complete }), /signs\.json is incomplete/);
});

test('the saved copy comes from the newest of the app\'s own caches, and only from those', async (t) => {
  fakeTime(t);
  net.fail('data/pick.json');
  useCaches({
    'another-app-v1': { [at('pick.json')]: { v: 'not ours' } },
    'markerpost-v27-mobile-map': { [at('pick.json')]: { v: 'older' } },
    'markerpost-basemap-v1': { [at('pick.json')]: { v: 'street map cache' } },
    [APP_CACHE]: { [at('pick.json')]: { v: 'newest' } },
  });
  assert.deepEqual(await loadSnapshot('pick.json'), { data: { v: 'newest' }, origin: 'saved' });

  // The newest cache has no usable copy (not yet filled, unreadable, incomplete): an older one is used.
  for (const newest of [{}, { [at('pick.json')]: 'not json' }, { [at('pick.json')]: { v: 'bad' } }]) {
    useCaches({ 'markerpost-v27-mobile-map': { [at('pick.json')]: { v: 'older' } }, [APP_CACHE]: newest });
    const result = await loadSnapshot('pick.json', { validate: (d) => d.v !== 'bad' });
    assert.deepEqual(result, { data: { v: 'older' }, origin: 'saved' });
  }

  useCaches({ 'another-app-v1': { [at('pick.json')]: { v: 'not ours' } }, 'markerpost-basemap-v1': { [at('pick.json')]: { v: 'x' } } });
  await assert.rejects(loadSnapshot('pick.json'), /Failed to fetch/);
});

test('refresh: false uses the saved copy and leaves the network alone', async (t) => {
  fakeTime(t);
  net.answer('data/still.json', { v: 'fresh' });
  useCaches({ [APP_CACHE]: { [at('still.json')]: { v: 'saved' } } });
  assert.deepEqual(await loadSnapshot('still.json', { refresh: false }), { data: { v: 'saved' }, origin: 'saved' });
  assert.equal(net.count('data/still.json'), 0);

  useCaches();
  await assert.rejects(loadSnapshot('still.json', { refresh: false }), /still\.json is unavailable/);
  assert.equal(net.count('data/still.json'), 0);
});

test('a download is given up after two minutes, so a dead request cannot hold up later loads', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: { [at('dead.json')]: { v: 'saved' } } });
  net.stall('data/dead.json');
  const first = loadSnapshot('dead.json');
  t.mock.timers.tick(4000);
  assert.equal((await first).origin, 'saved');

  t.mock.timers.tick(115999);
  await flush();
  assert.equal(net.calls.at(-1).aborted, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(net.calls.at(-1).aborted, true, 'given up at 120 seconds');

  // The next load starts a new request instead of waiting on the dead one.
  net.answer('data/dead.json', { v: 'fresh' });
  assert.deepEqual(await loadSnapshot('dead.json'), { data: { v: 'fresh' }, origin: 'network' });
  assert.equal(net.count('data/dead.json'), 2);
});

test('a load with no saved copy that outlasts the download reports that it took too long', async (t) => {
  fakeTime(t);
  useCaches();
  net.stall('data/long.json');
  const load = loadSnapshot('long.json', { timeoutMs: 600000 });
  const state = watch(load);
  t.mock.timers.tick(119999);
  await flush();
  assert.equal(state.settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(load, /data\/long\.json took too long/);
});

// ------------------------------------- a download that arrives after all

/** A load that records, in order, its own answer and anything it is told afterwards. */
function loadAndListen(name, options = {}) {
  const heard = { order: [], late: [] };
  heard.load = loadSnapshot(name, {
    ...options,
    onLate: (result) => { heard.late.push(result); heard.order.push(`late ${result.data.v}`); },
  });
  heard.load.then((r) => heard.order.push(`answer ${r.data.v}`), () => heard.order.push('failed'));
  return heard;
}

test('a download that arrives after its load stopped waiting is announced, once, after the load\'s own answer', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: { [at('lands.json')]: { v: 'saved' } } });
  const request = net.stall('data/lands.json');
  const heard = loadAndListen('lands.json', { timeoutMs: 20000 });
  t.mock.timers.tick(4000);
  assert.deepEqual(await heard.load, { data: { v: 'saved' }, origin: 'saved' });
  await flush();
  assert.deepEqual(heard.late, [], 'nothing has arrived yet');

  // Two seconds later the download finishes: today's copy, the moment it lands.
  t.mock.timers.tick(2000);
  request.release({ v: 'fresh' });
  await flush();
  assert.deepEqual(heard.late, [{ data: { v: 'fresh' }, origin: 'network' }]);
  assert.deepEqual(heard.order, ['answer saved', 'late fresh']);
  assert.equal(net.count('data/lands.json'), 1, 'it is the same download, not a second one');

  // A load without onLate is unchanged: it simply is not told.
  const quiet = net.stall('data/quiet.json');
  useCaches({ [APP_CACHE]: { [at('quiet.json')]: { v: 'saved' } } });
  const load = loadSnapshot('quiet.json');
  t.mock.timers.tick(4000);
  assert.deepEqual(await load, { data: { v: 'saved' }, origin: 'saved' });
  quiet.release({ v: 'fresh' });
  await flush();
  assert.deepEqual(unhandled, []);
});

test('nothing is announced when the download arrived in time, or when what arrives late is no better', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: Object.fromEntries(['prompt', 'worker', 'error', 'dropped', 'partial'].map((n) => [at(`${n}.json`), { v: 'saved', signs: [] }])) });

  // In time: the answer is the fresh copy itself.
  net.answer('data/prompt.json', { v: 'fresh' });
  const prompt = loadAndListen('prompt.json');
  assert.deepEqual(await prompt.load, { data: { v: 'fresh' }, origin: 'network' });

  // Late, and only the service worker's saved copy, an error, no answer at all, or an incomplete file.
  const ends = {
    worker: (request) => request.release({ v: 'saved', signs: [] }, { headers: { 'X-Markerpost-Cache': 'fallback' } }),
    error: (request) => request.release('Service unavailable', { status: 503 }),
    dropped: (request) => request.drop(),
    partial: (request) => request.release({ v: 'fresh', signs: 'not a list' }),
  };
  const all = [prompt];
  for (const [name, end] of Object.entries(ends)) {
    const request = net.stall(`data/${name}.json`);
    const heard = loadAndListen(`${name}.json`, { validate: complete });
    all.push(heard);
    t.mock.timers.tick(4000);
    assert.equal((await heard.load).origin, 'saved', name);
    end(request);
    await flush();
  }
  for (const heard of all) assert.deepEqual(heard.late, []);
  assert.deepEqual(unhandled, []);
});

test('a download that arrives while the saved copy is being read is the answer itself, not an afterthought', async (t) => {
  fakeTime(t);
  const caches = useCaches({ [APP_CACHE]: { [at('close.json')]: { v: 'saved' } } });
  // Reading the saved copy takes a moment, as it does for a file of several megabytes.
  const reading = deferred();
  const match = caches.match;
  caches.match = async (...args) => { await reading.promise; return match.apply(caches, args); };
  const request = net.stall('data/close.json');
  const heard = loadAndListen('close.json');
  t.mock.timers.tick(4000);
  await flush();
  request.release({ v: 'fresh' });
  await flush();
  reading.resolve();
  assert.deepEqual(await heard.load, { data: { v: 'fresh' }, origin: 'network' });
  await flush();
  assert.deepEqual(heard.order, ['answer fresh'], 'the caller is given the fresh copy once, and never the older one after it');
});

test('whatever the timing, the caller is never left holding the older copy after the fresh one', async (t) => {
  fakeTime(t);
  // The download lands in the same instant as the four seconds run out, and at each point around it.
  for (const landsAfter of [3999, 4000, 4001]) {
    const name = `tie-${landsAfter}.json`;
    useCaches({ [APP_CACHE]: { [at(name)]: { v: 'saved' } } });
    const request = net.stall(`data/${name}`);
    const heard = loadAndListen(name);
    t.mock.timers.tick(Math.min(landsAfter, 4000));
    if (landsAfter <= 4000) request.release({ v: 'fresh' });
    else { await heard.load; t.mock.timers.tick(1); request.release({ v: 'fresh' }); }
    await heard.load;
    await flush();
    assert.equal(heard.order.at(-1).slice(-5), 'fresh', `${landsAfter} ms: ${heard.order.join(', ')}`);
    assert.ok(heard.order.length <= 2 && heard.order[0].startsWith('answer'), `${landsAfter} ms: ${heard.order.join(', ')}`);
  }
});

test('the two answers cannot change places, however closely the download follows the saved copy', async (t) => {
  fakeTime(t);
  // A saved copy that is read in as few steps as the machine allows, and a
  // download whose last step the test takes itself. The download is made to
  // land 0, 1, 2 ... steps after the saved copy has been read: among those is
  // every order in which the last steps of the two can fall.
  const real = { fetch: globalThis.fetch, caches: globalThis.caches };
  let reading = null, body = null;
  globalThis.caches = {
    async keys() { return [APP_CACHE]; },
    async match() { await reading.promise; return { ok: true, json: async () => ({ v: 'saved' }) }; },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: () => body.promise });
  try {
    for (let steps = 0; steps <= 40; steps++) {
      reading = deferred();
      body = deferred();
      const heard = loadAndListen(`steps-${steps}.json`);
      t.mock.timers.tick(4000);
      await flush();
      reading.resolve();
      for (let i = 0; i < steps; i++) await null;
      body.resolve({ v: 'fresh' });
      await heard.load;
      await flush();
      const order = heard.order.join(', ');
      assert.ok(heard.order[0].startsWith('answer'), `${steps} steps: ${order}`);
      assert.equal(heard.order.at(-1).slice(-5), 'fresh', `${steps} steps: ${order}`);
      assert.ok(heard.order.length <= 2, `${steps} steps: ${order}`);
    }
  } finally {
    Object.assign(globalThis, real);
  }
});

test('a first download that outlasts its load is announced when it lands, although the load itself failed', async (t) => {
  fakeTime(t);
  useCaches();
  const request = net.stall('data/eventually.json');
  const heard = loadAndListen('eventually.json', { timeoutMs: 20000 });
  t.mock.timers.tick(4000);
  await flush();
  t.mock.timers.tick(16000);
  await assert.rejects(heard.load, /eventually\.json did not load in 20 seconds/);
  await flush();
  assert.deepEqual(heard.late, []);

  t.mock.timers.tick(15000);
  request.release({ v: 'fresh' });
  await flush();
  assert.deepEqual(heard.order, ['failed', 'late fresh']);
  assert.deepEqual(heard.late, [{ data: { v: 'fresh' }, origin: 'network' }]);
});

test('freshOnly: a caller that already shows the saved copy is given a newer one or nothing, and the saved copy is not read again', async (t) => {
  fakeTime(t);
  const caches = useCaches({ [APP_CACHE]: { [at('held.json')]: { v: 'saved', signs: [] } } });
  net.answer('data/held.json', { v: 'fresh', signs: [] });
  assert.deepEqual(await loadSnapshot('held.json', { freshOnly: true }), { data: { v: 'fresh', signs: [] }, origin: 'network' });

  // Slow: nothing at four seconds, and the download is announced when it lands.
  const request = net.stall('data/held.json');
  const late = [];
  const load = loadSnapshot('held.json', { freshOnly: true, timeoutMs: 20000, onLate: (result) => late.push(result) });
  const state = watch(load);
  t.mock.timers.tick(3999);
  await flush();
  assert.equal(state.settled, false, 'the site has its four seconds');
  t.mock.timers.tick(1);
  assert.equal(await load, null);
  request.release({ v: 'newer', signs: [] });
  await flush();
  assert.deepEqual(late, [{ data: { v: 'newer', signs: [] }, origin: 'network' }]);

  // No connection, an error, an incomplete file, only the service worker's
  // saved copy, or told to leave the network alone: nothing, at once, and no failure.
  const ask = (options) => loadSnapshot('held.json', { freshOnly: true, validate: complete, ...options });
  net.fail('data/held.json');
  assert.equal(await ask(), null);
  net.answer('data/held.json', 'Service unavailable', { status: 503 });
  assert.equal(await ask(), null);
  net.answer('data/held.json', { v: 'fresh', signs: 'not a list' });
  assert.equal(await ask(), null);
  net.answer('data/held.json', { v: 'saved', signs: [] }, { headers: { 'X-Markerpost-Cache': 'fallback' } });
  assert.equal(await ask(), null);
  assert.equal(await ask({ refresh: false }), null);

  assert.equal(caches.reads.length, 0, 'the saved copy was never read: the caller has it');
  assert.deepEqual(unhandled, []);
});

test('reference data: the site first, the saved copy after four seconds, thirty seconds when nothing is saved', async (t) => {
  fakeTime(t);
  useCaches();
  net.answer('data/posts-a.json', [{ ref: 'P1/0A' }]);
  assert.deepEqual(await loadBundled('posts-a.json', { cache: 'force-cache' }), [{ ref: 'P1/0A' }]);
  assert.equal(net.calls.at(-1).init.cache, 'force-cache', 'the caller\'s cache mode is passed on');

  // Saved by the service worker and the site is slow: four seconds, then the saved copy.
  useCaches({ [APP_CACHE]: { [at('posts-b.json')]: [{ ref: 'P2/0B' }] } });
  net.stall('data/posts-b.json');
  const slow = loadBundled('posts-b.json');
  const slowState = watch(slow);
  t.mock.timers.tick(3999);
  await flush();
  assert.equal(slowState.settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await slow, [{ ref: 'P2/0B' }]);

  // Nothing saved: the default wait is thirty seconds, and then the load fails.
  useCaches();
  net.stall('data/posts-c.json');
  const first = loadBundled('posts-c.json');
  const firstState = watch(first);
  t.mock.timers.tick(4000);
  await flush();
  t.mock.timers.tick(25999);
  await flush();
  assert.equal(firstState.settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(first, /posts-c\.json did not load in 30 seconds/);

  // A file that is not there (junction sections on a development server) fails at once.
  await assert.rejects(loadBundled('post-sections-missing.json'), /Failed to fetch/);
});

test('without Cache Storage (not a secure address) the app still loads from the site', async (t) => {
  fakeTime(t);
  delete globalThis.caches;
  net.answer('data/plain.json', { v: 'fresh' });
  assert.deepEqual(await loadSnapshot('plain.json'), { data: { v: 'fresh' }, origin: 'network' });
  net.fail('data/plain.json');
  await assert.rejects(loadSnapshot('plain.json'), /Failed to fetch/);
  useCaches();
});

test('a download that fails after its load stopped waiting is not an unhandled error', async (t) => {
  fakeTime(t);
  useCaches({ [APP_CACHE]: { [at('late.json')]: { v: 'saved' } } });
  const request = net.stall('data/late.json');
  const load = loadSnapshot('late.json');
  t.mock.timers.tick(4000);
  assert.equal((await load).origin, 'saved');
  request.drop();
  await flush();
  assert.deepEqual(unhandled, []);
});
