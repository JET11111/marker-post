// data.js in the phone apps: there is no service worker. Reference data is
// read from the files inside the app; the snapshots are refreshed from the
// published site when it answers in time, kept on the phone, and otherwise
// taken from what the phone already holds.

import assert from 'node:assert/strict';
import { fakeIndexedDB, fakeNetwork, flush, test, watchUnhandled } from './data-fakes.mjs';

// The inside of a phone app, as far as data.js and platform.js need it. Set
// before the modules are loaded: platform.js decides "native" as it loads.
globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: () => ({}) };
globalThis.document = { baseURI: 'https://localhost/', documentElement: { dataset: {} } };
const phone = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: phone, configurable: true, writable: true });
const net = fakeNetwork();
globalThis.fetch = net.fetch;
const db = fakeIndexedDB();
globalThis.indexedDB = db;
const unhandled = watchUnhandled();

const { default: config } = await import('../config.js');
const { loadBundled, loadSnapshot } = await import('../data.js');

const hosted = (name) => `${config.hostedBase}data/${name}`;   // the published site
const inApp = (name) => `data/${name}`;                        // the file inside the app
const fakeTime = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });
const snapshot = (fetched, extra = {}) => ({ fetched, signs: [], ...extra });
const options = { stamp: (d) => d.fetched, validate: (d) => Boolean(d && Array.isArray(d.signs)) };

test('a quick download is used, reported as downloaded just now and kept on the phone', async (t) => {
  fakeTime(t);
  net.answer(hosted('fast.json'), snapshot('2026-11-22T10:00:00Z'));
  net.answer(inApp('fast.json'), snapshot('2026-11-01T10:00:00Z'));
  const result = await loadSnapshot('fast.json', options);
  assert.equal(result.origin, 'network');
  assert.equal(result.data.fetched, '2026-11-22T10:00:00Z');
  assert.equal(net.calls.find((c) => c.url === hosted('fast.json')).init.cache, 'no-cache');
  assert.equal(net.count(inApp('fast.json')), 0, 'the file inside the app is not read when the site answers in time');
  await flush();
  assert.equal(db.saved('fast.json').fetched, '2026-11-22T10:00:00Z');
});

test('a slow download costs four seconds: the copy inside the app is shown, and the download is kept when it arrives', async (t) => {
  fakeTime(t);
  const request = net.stall(hosted('slow.json'));
  net.answer(inApp('slow.json'), snapshot('2026-11-01T10:00:00Z'));
  const load = loadSnapshot('slow.json', { ...options, timeoutMs: 20000 });
  let settled = false;
  load.then(() => { settled = true; });

  t.mock.timers.tick(3999);
  await flush();
  assert.equal(settled, false, 'still waiting just before four seconds');
  t.mock.timers.tick(1);
  const shown = await load;
  assert.equal(shown.origin, 'bundled');
  assert.equal(shown.data.fetched, '2026-11-01T10:00:00Z');
  assert.equal(db.saved('slow.json'), undefined);

  // The download finishes after the screen has moved on: it is kept for next time.
  request.release(snapshot('2026-11-22T10:00:00Z'));
  await flush();
  assert.equal(db.saved('slow.json').fetched, '2026-11-22T10:00:00Z');

  // Next time, with no connection, that download is what the phone shows.
  phone.onLine = false;
  const later = await loadSnapshot('slow.json', options);
  phone.onLine = true;
  assert.equal(later.origin, 'saved');
  assert.equal(later.data.fetched, '2026-11-22T10:00:00Z');
  assert.equal(net.count(hosted('slow.json')), 1, 'offline, the site is not asked');
});

test('the caller is told when a slow download lands, so the screen need not wait for next time', async (t) => {
  fakeTime(t);
  const request = net.stall(hosted('lands.json'));
  net.answer(inApp('lands.json'), snapshot('2026-11-01T10:00:00Z'));
  const late = [];
  const load = loadSnapshot('lands.json', { ...options, timeoutMs: 20000, onLate: (result) => late.push(result) });
  t.mock.timers.tick(4000);
  assert.equal((await load).origin, 'bundled');
  await flush();
  assert.deepEqual(late, [], 'nothing has arrived yet');

  request.release(snapshot('2026-11-22T10:00:00Z'));
  await flush();
  assert.equal(late.length, 1, 'told once');
  assert.equal(late[0].origin, 'network');
  assert.equal(late[0].data.fetched, '2026-11-22T10:00:00Z');
  assert.equal(db.saved('lands.json').fetched, '2026-11-22T10:00:00Z', 'and it is kept on the phone, as before');

  // A download that turns out to be incomplete is neither announced nor kept.
  const broken = net.stall(hosted('lands-broken.json'));
  net.answer(inApp('lands-broken.json'), snapshot('2026-11-01T10:00:00Z'));
  const second = loadSnapshot('lands-broken.json', { ...options, onLate: (result) => late.push(result) });
  t.mock.timers.tick(4000);
  assert.equal((await second).origin, 'bundled');
  broken.release({ fetched: '2026-11-22T10:00:00Z', signs: 'not a list' });
  await flush();
  assert.equal(late.length, 1);
  assert.equal(db.saved('lands-broken.json'), undefined);
  assert.deepEqual(unhandled, []);
});

test('freshOnly on the phone: a newer download or nothing, and what the phone holds is not read again', async (t) => {
  fakeTime(t);
  net.answer(inApp('again.json'), snapshot('2026-11-01T10:00:00Z'));
  const request = net.stall(hosted('again.json'));
  const late = [];
  const load = loadSnapshot('again.json', { ...options, freshOnly: true, onLate: (result) => late.push(result) });
  t.mock.timers.tick(4000);
  assert.equal(await load, null, 'nothing newer within four seconds');
  assert.equal(net.count(inApp('again.json')), 0, 'the file inside the app is not read: the caller is already showing it');

  request.release(snapshot('2026-11-22T10:00:00Z'));
  await flush();
  assert.equal(late.length, 1);
  assert.equal(late[0].data.fetched, '2026-11-22T10:00:00Z');
  assert.equal(db.saved('again.json').fetched, '2026-11-22T10:00:00Z', 'and it is kept on the phone all the same');

  // A quick download is the answer itself.
  net.answer(hosted('again.json'), snapshot('2026-11-23T10:00:00Z'));
  const quick = await loadSnapshot('again.json', { ...options, freshOnly: true });
  assert.equal(quick.origin, 'network');
  assert.equal(quick.data.fetched, '2026-11-23T10:00:00Z');

  // With no connection the site is not asked, and there is nothing newer.
  phone.onLine = false;
  const before = net.calls.length;
  assert.equal(await loadSnapshot('again.json', { ...options, freshOnly: true }), null);
  phone.onLine = true;
  assert.equal(net.calls.length, before);
  assert.deepEqual(unhandled, []);
});

test('the newer of the kept download and the copy inside the app is used', async (t) => {
  fakeTime(t);
  // An app update can bundle a newer file than the last download.
  net.answer(hosted('newer.json'), snapshot('2026-10-01T00:00:00Z'));
  net.answer(inApp('newer.json'), snapshot('2026-11-01T00:00:00Z'));
  assert.equal((await loadSnapshot('newer.json', options)).origin, 'network');
  await flush();
  net.fail(hosted('newer.json'));
  const result = await loadSnapshot('newer.json', options);
  assert.equal(result.origin, 'bundled');
  assert.equal(result.data.fetched, '2026-11-01T00:00:00Z');
});

test('a download that is incomplete is neither used nor kept', async (t) => {
  fakeTime(t);
  net.answer(hosted('broken.json'), { fetched: '2026-11-22T10:00:00Z', signs: 'not a list' });
  net.answer(inApp('broken.json'), snapshot('2026-11-01T10:00:00Z'));
  const result = await loadSnapshot('broken.json', options);
  assert.equal(result.origin, 'bundled');
  await flush();
  assert.equal(db.saved('broken.json'), undefined);
});

test('refresh: false uses what the phone holds and leaves the network alone', async (t) => {
  fakeTime(t);
  net.answer(hosted('quiet.json'), snapshot('2026-11-22T10:00:00Z'));
  net.answer(inApp('quiet.json'), snapshot('2026-11-01T10:00:00Z'));
  assert.equal((await loadSnapshot('quiet.json', { ...options, refresh: false })).origin, 'bundled');
  assert.equal(net.count(hosted('quiet.json')), 0);
});

test('with nothing usable on the phone the download gets the full time, then the load fails', async (t) => {
  fakeTime(t);
  net.stall(hosted('none.json'));
  const load = loadSnapshot('none.json', { ...options, timeoutMs: 20000 }); // no file inside the app either
  let settled = false;
  load.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(4000);
  await flush();
  t.mock.timers.tick(15999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(load, /none\.json did not load in 20 seconds/);

  phone.onLine = false;
  await assert.rejects(loadSnapshot('nowhere.json', options), /nowhere\.json is unavailable/);
  phone.onLine = true;
});

test('reference data is read from inside the app and never from the published site', async (t) => {
  fakeTime(t);
  net.answer(inApp('posts.json'), [{ ref: 'P1/0A' }]);
  assert.deepEqual(await loadBundled('posts.json', { cache: 'force-cache' }), [{ ref: 'P1/0A' }]);
  assert.equal(net.count(hosted('posts.json')), 0);
  // A file that is not in the app fails at once (the caller decides whether that matters).
  await assert.rejects(loadBundled('missing.json'), /Failed to fetch/);
  await flush();
  assert.deepEqual(unhandled, []);
});
