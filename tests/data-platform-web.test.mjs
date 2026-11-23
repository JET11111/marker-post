// platform.js in a browser: the made-up position used for desk testing says
// what it is on every path, a real position is never marked as made up, and
// the browser's own geolocation is passed on as it always was.

import assert from 'node:assert/strict';
import { flush, test, watchUnhandled } from './data-fakes.mjs';

// A browser, as far as platform.js needs one. Set before the module is loaded:
// with no Capacitor on the page it decides "web" as it loads.
const page = {
  documentElement: { dataset: {} },
  visibilityState: 'visible',
  listeners: [],
  addEventListener(type, fn) { this.listeners.push({ type, fn }); },
};
globalThis.document = page;
const address = { search: '' };
globalThis.location = address;

// The browser's geolocation: every call is recorded and the test answers it.
const gps = {
  watches: new Map(), cleared: [], asked: [], nextId: 1,
  watchPosition(ok, fail, options) {
    const id = this.nextId++;
    this.watches.set(id, { ok, fail, options });
    return id;
  },
  clearWatch(id) { this.cleared.push(id); this.watches.delete(id); },
  getCurrentPosition(ok, fail, options) { this.asked.push({ ok, fail, options }); },
  reset() { this.watches.clear(); this.cleared = []; this.asked = []; },
  /** The one watch that should be running. */
  only() {
    assert.equal(this.watches.size, 1, 'exactly one watch is running');
    return [...this.watches.entries()][0];
  },
};
const browser = { geolocation: gps };
Object.defineProperty(globalThis, 'navigator', { value: browser, configurable: true, writable: true });
const unhandled = watchUnhandled();

const P = await import('../platform.js');

const M27 = '50.93795,-1.352527,110,30'; // latitude, longitude, direction of travel, metres per second
/** Start a watch that records what it reports. */
function watching(search) {
  address.search = search;
  gps.reset();
  const seen = { fixes: [], errors: [] };
  seen.stop = P.watchPosition((fix) => seen.fixes.push(fix), (err) => seen.errors.push(err));
  return seen;
}
const reading = (extra = {}) => ({ timestamp: 1700000000000, coords: { latitude: 50.9, longitude: -1.3, accuracy: 8, heading: 200, speed: 12, ...extra } });

test('a browser is not a phone app', () => {
  assert.equal(P.isNative, false);
  assert.equal(P.platform, 'web');
  assert.equal(page.documentElement.dataset.platform, 'web');
});

test('a made-up position says what it is, on the watch and on a single reading', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const before = Date.now();
  const seen = watching(`?sim=${M27}`);
  assert.equal(seen.fixes.length, 1, 'the first one arrives at once');
  t.mock.timers.tick(3000);
  assert.equal(seen.fixes.length, 4, 'then one a second');
  for (const fix of seen.fixes) {
    const { timestamp, ...rest } = fix;
    assert.deepEqual(rest, { lat: 50.93795, lng: -1.352527, accuracy: 5, heading: 110, speed: 30, simulated: true });
    assert.ok(timestamp >= before && timestamp <= Date.now(), 'it carries the time it was made');
  }

  // The map's locate button asks for one position. It gets the made-up one,
  // marked, and never the real one mixed in with it.
  const { timestamp, ...one } = await P.getCurrentPosition();
  assert.deepEqual(one, { lat: 50.93795, lng: -1.352527, accuracy: 5, heading: 110, speed: 30, simulated: true });
  assert.ok(timestamp >= before && timestamp <= Date.now());
  assert.equal(gps.watches.size, 0, 'the real GPS is not watched');
  assert.equal(gps.asked.length, 0, 'nor asked');

  seen.stop();
  t.mock.timers.tick(5000);
  assert.equal(seen.fixes.length, 4, 'stopping stops it');
  assert.deepEqual(seen.errors, []);
});

test('a made-up position without a direction or speed leaves them unknown', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const seen = watching('?q=M27&sim=50.9,-1.3');
  const { timestamp, ...rest } = seen.fixes[0];
  assert.deepEqual(rest, { lat: 50.9, lng: -1.3, accuracy: 5, heading: null, speed: null, simulated: true });
  assert.equal((await P.getCurrentPosition()).simulated, true);
  seen.stop();
});

test('an address that does not give a position leaves the real GPS in charge', async () => {
  for (const search of ['', '?sim=', '?sim=here', '?sim=50.9', '?simulated=50.9,-1.3']) {
    const seen = watching(search);
    const [, watch] = gps.only();
    watch.ok(reading());
    assert.equal(seen.fixes.length, 1, search);
    assert.equal('simulated' in seen.fixes[0], false, search);
    seen.stop();
  }
});

test('a real position is never marked as made up, and the browser\'s failures keep their meaning', async () => {
  const seen = watching('');
  const [id, watch] = gps.only();
  assert.deepEqual(watch.options, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });

  watch.ok(reading());
  assert.deepEqual(seen.fixes, [{ lat: 50.9, lng: -1.3, accuracy: 8, heading: 200, speed: 12, timestamp: 1700000000000 }]);
  assert.equal('simulated' in seen.fixes[0], false);
  // Standing still a browser gives no direction (null or NaN) and may give no speed.
  watch.ok(reading({ heading: null, speed: null }));
  assert.equal(seen.fixes[1].heading, null);
  assert.equal(seen.fixes[1].speed, null);

  watch.fail({ code: 1, message: 'User denied Geolocation' });
  watch.fail({ code: 2, message: 'Position unavailable' });
  watch.fail({ code: 3, message: 'Timeout expired' });
  assert.deepEqual(seen.errors, [
    { code: 1, message: 'User denied Geolocation' },
    { code: 2, message: 'Position unavailable' },
    { code: 2, message: 'Timeout expired' },
  ]);

  seen.stop();
  assert.deepEqual(gps.cleared, [id]);

  // One position for the map's locate button: the browser's own, unmarked.
  const one = P.getCurrentPosition();
  assert.deepEqual(gps.asked[0].options, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  gps.asked[0].ok(reading());
  assert.deepEqual(await one, { lat: 50.9, lng: -1.3, accuracy: 8, heading: 200, speed: 12, timestamp: 1700000000000 });
  const refused = P.getCurrentPosition();
  const denial = { code: 1, message: 'User denied Geolocation' };
  gps.asked[1].fail(denial);
  await assert.rejects(refused, (err) => err === denial);
});

test('a browser with no geolocation says so', async () => {
  delete browser.geolocation;
  try {
    const seen = watching('');
    assert.deepEqual(seen.errors, [{ code: 0, message: 'No geolocation on this device' }]);
    assert.deepEqual(seen.fixes, []);
    seen.stop();
    await assert.rejects(P.getCurrentPosition(), /No geolocation on this device/);
  } finally {
    browser.geolocation = gps;
  }
});

test('the parts that belong to the phone apps do nothing in a browser', async () => {
  for (const kind of ['light', 'selection', 'success', 'warning']) P.haptic(kind);
  P.setSystemBars(true);
  P.publishPost({ ref: 'P20/9A' });
  P.onAppLink(() => assert.fail('a web page has no app links'));
  P.onBackButton(() => assert.fail('a web page has no back button of its own'));
  P.live.onChange(() => assert.fail('there is no live tracking in a browser'));
  await P.live.update({ useHeading: true });
  await P.keepAwake(); // this browser has no wake lock: nothing to do

  assert.equal(P.live.supported, false);
  assert.deepEqual(await P.live.status(), { active: false });
  assert.deepEqual(await P.live.stop(), { active: false });

  // Coming back to the tab is the browser's version of coming back to the app.
  const states = [];
  P.onAppState((active) => states.push(active));
  const listener = page.listeners.find((l) => l.type === 'visibilitychange');
  page.visibilityState = 'hidden';
  listener.fn();
  page.visibilityState = 'visible';
  listener.fn();
  assert.deepEqual(states, [false, true]);

  await flush();
  assert.deepEqual(unhandled, []);
});
