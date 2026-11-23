// platform.js inside the phone apps, against stand-ins for the Capacitor
// plugins that behave as the real ones do (their error codes and the way a
// missing plugin fails were read from node_modules/@capacitor).

import assert from 'node:assert/strict';
import { deferred, flush, test, watchUnhandled } from './data-fakes.mjs';

const coded = (code, message) => Object.assign(new Error(message), { code });
const LOCATION_OFF = () => coded('OS-PLUG-GLOC-0007', 'Location services are not enabled.');
const DENIED = () => coded('OS-PLUG-GLOC-0003', 'Location permission request was denied.');
const TIMED_OUT = () => coded('OS-PLUG-GLOC-0010', 'Could not obtain location in time. Try with a higher timeout.');

// The Geolocation plugin: the phone's settings are the fields, the calls are counted.
const geo = {
  services: true,        // location switched on for the whole phone
  permission: 'granted', // what the app is allowed
  answer: 'granted',     // what the user says when asked
  pendingAnswer: null,   // set to a deferred to keep the system prompt on screen
  pendingWatch: null,    // set to a deferred to hold up the start of a watch
  broken: false,         // the plugin cannot be reached at all (nothing to do with the phone's settings)
  checks: 0, asks: 0, nextId: 1,
  watches: new Map(), cleared: [], lastOptions: null,
  reset(settings = {}) {
    Object.assign(this, { services: true, permission: 'granted', answer: 'granted', pendingAnswer: null, pendingWatch: null, broken: false, checks: 0, asks: 0, cleared: [] }, settings);
    this.watches.clear();
  },
  async checkPermissions() {
    this.checks++;
    if (this.broken) throw new Error('The plugin did not answer');
    if (!this.services) throw LOCATION_OFF();
    return { location: this.permission, coarseLocation: this.permission };
  },
  async requestPermissions(options) {
    if (!this.services) throw LOCATION_OFF();
    assert.deepEqual(options, { permissions: ['location'] });
    this.asks++;
    if (this.pendingAnswer) await this.pendingAnswer.promise;
    this.permission = this.answer;
    return { location: this.permission, coarseLocation: this.permission };
  },
  async watchPosition(options, callback) {
    const id = String(this.nextId++);
    this.lastOptions = options;
    if (this.pendingWatch) await this.pendingWatch.promise;
    this.watches.set(id, callback);
    return id;
  },
  async clearWatch({ id }) {
    this.cleared.push(id);
    if (!this.watches.delete(id)) throw coded('OS-PLUG-GLOC-0012', 'WatchId not found.');
  },
  /** The callback of the one watch that should be running. */
  only() {
    assert.equal(this.watches.size, 1, 'exactly one watch is running');
    return [...this.watches.values()][0];
  },
};

// The App plugin: listeners, and a way for the test to bring the app to the front.
const app = {
  listeners: new Map(), minimized: 0, launchUrl: null,
  addListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return Promise.resolve({ remove: async () => { this.listeners.get(event).delete(fn); } });
  },
  emit(event, data) { for (const fn of [...(this.listeners.get(event) || [])]) fn(data); },
  comeToFront() { this.emit('appStateChange', { isActive: true }); },
  count(event) { return this.listeners.get(event)?.size || 0; },
  async minimizeApp() { this.minimized++; },
  async getLaunchUrl() { return this.launchUrl ? { url: this.launchUrl } : undefined; },
};

// The app's own plugin, with switches to make its calls fail.
const markerPost = {
  failStop: false, failStatus: false, active: true, published: [],
  async stopTracking() { if (this.failStop) throw new Error('bridge lost'); this.active = false; return { active: false }; },
  async getTrackingStatus() { if (this.failStatus) throw new Error('bridge lost'); return this.active ? { active: true, since: 123 } : { active: false }; },
  async publishPost(snapshot) { this.published.push(snapshot); return {}; },
};

// A plugin that is not in the app. Capacitor does not throw for one: every
// call returns a promise that rejects (createPluginMethodWrapper in @capacitor/core).
const missing = (name) => new Proxy({}, {
  get: (_, method) => () => Promise.reject(new Error(`"${name}" plugin is not implemented on android`)),
});

const plugins = { Geolocation: geo, App: app, MarkerPost: markerPost };
globalThis.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'android',
  registerPlugin: (name) => plugins[name] || missing(name),
};
const page = { documentElement: { dataset: {} }, visibilityState: 'visible' };
globalThis.document = page;
const unhandled = watchUnhandled();

const P = await import('../platform.js');

const RETRY = 3000;
// What the app is told when a refusal, or location being off, has been put
// right: not a failure, but word that the last report no longer holds.
const LOOKING = { code: 2, reason: 'looking', message: 'Location is available again' };
/** Start a watch that records what it reports and is stopped when the test ends. */
function watching(t, settings) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  geo.reset(settings);
  page.visibilityState = 'visible';
  const seen = { fixes: [], errors: [] };
  seen.stop = P.watchPosition((fix) => seen.fixes.push(fix), (err) => seen.errors.push(err));
  t.after(() => seen.stop());
  return seen;
}
const position = (extra = {}) => ({ timestamp: 1700000000000, coords: { latitude: 50.9, longitude: -1.3, accuracy: 4, speed: 30, heading: 200, course: 110, ...extra } });

test('the plugin\'s error codes are read the same way on both phones', () => {
  assert.equal(P.geoBlock(DENIED()), 'refused');
  assert.equal(P.geoBlock(coded('OS-PLUG-GLOC-0008', 'restricted')), 'refused');
  assert.equal(P.geoBlock(LOCATION_OFF()), 'off');
  assert.equal(P.geoBlock(TIMED_OUT()), null);
  assert.equal(P.geoBlock(new Error('anything else')), null);
  assert.equal(P.geoBlock(undefined), null);
});

test('with permission already given the watch starts without asking, and fixes carry the direction of travel', async (t) => {
  const seen = watching(t);
  await flush();
  assert.equal(geo.asks, 0);
  assert.deepEqual(geo.lastOptions, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000, interval: 1000, minimumUpdateInterval: 1000 });
  geo.only()(position());
  assert.deepEqual(seen.fixes, [{ lat: 50.9, lng: -1.3, accuracy: 4, heading: 110, speed: 30, timestamp: 1700000000000 }]);
  assert.equal('simulated' in seen.fixes[0], false, 'a real position is never flagged as simulated');
  assert.deepEqual(seen.errors, []);
});

test('on first use the user is asked once, and the watch starts when they allow it', async (t) => {
  const seen = watching(t, { permission: 'prompt', answer: 'granted' });
  await flush();
  assert.equal(geo.asks, 1);
  assert.equal(geo.watches.size, 1);
  assert.deepEqual(seen.errors, []);
});

test('after a refusal the app says so once, never asks again, and starts by itself when permission is given in Settings', async (t) => {
  const seen = watching(t, { permission: 'prompt', answer: 'denied', pendingAnswer: deferred() });
  await flush();
  assert.equal(geo.asks, 1);
  // The system prompt sends the app to the back; closing it brings the app forward again.
  app.comeToFront();
  await flush();
  geo.pendingAnswer.resolve();
  await flush();
  assert.deepEqual(seen.errors, [{ code: 1, message: 'Location permission refused' }]);

  // Coming forward again, and the passing of time, only look: the prompt is not put back up.
  app.comeToFront();
  await flush();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(RETRY); await flush(); }
  assert.equal(geo.asks, 1, 'asked once only');
  assert.equal(seen.errors.length, 1, 'said once only');
  assert.equal(geo.watches.size, 0);

  // The user allows location in Settings and returns: nothing restarts the app, so the watch must.
  geo.permission = 'granted';
  app.comeToFront();
  await flush();
  // The app is told at once that "refused" no longer holds, before any fix has come.
  assert.deepEqual(seen.errors.slice(1), [LOOKING]);
  assert.equal(seen.fixes.length, 0);
  geo.only()(position());
  assert.equal(seen.fixes.length, 1);
  assert.equal(geo.asks, 1);
});

test('when what was wrong is put right the app is told so once, without waiting for the first fix', async (t) => {
  // Location was blocked for the app; the user allows it in Settings and comes back.
  const seen = watching(t, { permission: 'denied', answer: 'denied' });
  await flush();
  assert.deepEqual(seen.errors, [{ code: 1, message: 'Location permission refused' }]);
  geo.permission = 'granted';
  app.comeToFront();
  await flush();
  assert.deepEqual(seen.errors.slice(1), [LOOKING]);
  assert.equal(geo.watches.size, 1, 'and the watch has started');
  // A cold GPS can take most of a minute. Nothing more is said while it does,
  // however often the app is brought forward.
  app.comeToFront();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(RETRY); await flush(); }
  assert.equal(seen.fixes.length, 0);
  assert.equal(seen.errors.length, 2, 'said once');
  geo.only()(position());
  assert.equal(seen.fixes.length, 1);
});

test('the same when the plugin could not be reached and then can; and what goes wrong again is said again', async (t) => {
  const seen = watching(t, { broken: true });
  await flush();
  assert.deepEqual(seen.errors, [{ code: 2, message: 'The plugin did not answer' }]);
  geo.broken = false;
  t.mock.timers.tick(RETRY);
  await flush();
  assert.deepEqual(seen.errors.slice(1), [LOOKING]);
  assert.equal(geo.watches.size, 1);

  // Location is then switched off, and on again: each report is of a change.
  geo.services = false;
  geo.only()(null, LOCATION_OFF());
  await flush();
  geo.services = true;
  t.mock.timers.tick(RETRY);
  await flush();
  assert.deepEqual(seen.errors.map((e) => e.reason), [undefined, 'looking', 'location-off', 'looking']);
});

test('with location switched off for the phone the app says so once and starts when it is switched on', async (t) => {
  const seen = watching(t, { services: false, permission: 'prompt', answer: 'granted' });
  await flush();
  assert.deepEqual(seen.errors, [{ code: 2, reason: 'location-off', message: 'Location services are not enabled.' }]);
  assert.equal(geo.asks, 0, 'nothing can be asked while location is off');

  for (let i = 0; i < 3; i++) { t.mock.timers.tick(RETRY); await flush(); }
  assert.equal(seen.errors.length, 1, 'said once only');
  assert.ok(geo.checks >= 4, 'it keeps looking');

  // Switched on from the quick settings: the app never left the screen, so only the timer notices.
  geo.services = true;
  t.mock.timers.tick(RETRY);
  await flush();
  assert.equal(geo.asks, 1, 'the question is put now, for the first time');
  assert.equal(geo.watches.size, 1);
  assert.deepEqual(seen.errors.slice(1), [LOOKING], 'and the app is told that "switched off" no longer holds');
});

test('permission taken away while watching: the watch is cleared, the app says so, and it recovers', async (t) => {
  const seen = watching(t);
  await flush();
  const first = [...geo.watches.keys()][0];
  geo.permission = 'denied';
  geo.only()(null, DENIED());
  await flush();
  assert.deepEqual(seen.errors, [{ code: 1, message: 'Location permission refused' }]);
  assert.deepEqual(geo.cleared, [first]);

  for (let i = 0; i < 3; i++) { t.mock.timers.tick(RETRY); await flush(); }
  assert.equal(geo.watches.size, 0, 'no watch is started while permission is refused');
  assert.equal(geo.asks, 0, 'permission that was given and then taken away is not asked for again');
  assert.equal(seen.errors.length, 1);

  geo.permission = 'granted';
  app.comeToFront();
  await flush();
  assert.equal(geo.watches.size, 1);
});

test('location switched off while watching is reported as location off, not as a GPS fault', async (t) => {
  const seen = watching(t);
  await flush();
  geo.services = false;
  geo.only()(null, LOCATION_OFF());
  await flush();
  assert.deepEqual(seen.errors, [{ code: 2, reason: 'location-off', message: 'Location services are not enabled.' }]);
  geo.services = true;
  t.mock.timers.tick(RETRY);
  await flush();
  assert.equal(geo.watches.size, 1);
});

test('a passing problem is reported and the watch starts again three seconds later', async (t) => {
  const seen = watching(t);
  await flush();
  geo.only()(null, TIMED_OUT());
  await flush();
  assert.deepEqual(seen.errors, [{ code: 2, message: 'Could not obtain location in time. Try with a higher timeout.' }]);
  assert.equal(geo.watches.size, 0);

  t.mock.timers.tick(RETRY - 1);
  await flush();
  assert.equal(geo.watches.size, 0);
  t.mock.timers.tick(1);
  await flush();
  geo.only()(position());
  assert.equal(seen.fixes.length, 1);

  // No position and no error is treated the same way. (Nothing was said in
  // between: a passing problem leaves nothing to take back.)
  geo.only()(null);
  assert.deepEqual(seen.errors.slice(1), [{ code: 2, message: 'No position' }]);
});

test('nothing is retried while the app is out of sight', async (t) => {
  const seen = watching(t);
  await flush();
  geo.only()(null, TIMED_OUT());
  page.visibilityState = 'hidden';
  const checksBefore = geo.checks;
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(RETRY); await flush(); }
  assert.equal(geo.checks, checksBefore);
  assert.equal(geo.watches.size, 0);

  page.visibilityState = 'visible';
  t.mock.timers.tick(RETRY);
  await flush();
  assert.equal(geo.watches.size, 1);
  assert.equal(seen.errors.length, 1);
});

test('coming back to the app restarts a failed watch at once, and leaves a running one alone', async (t) => {
  const seen = watching(t);
  await flush();
  const checks = geo.checks;
  app.comeToFront();
  await flush();
  assert.equal(geo.checks, checks, 'a running watch is not looked at again');
  assert.equal(geo.watches.size, 1);

  // The watch fails while the phone is in a pocket.
  geo.only()(null, TIMED_OUT());
  page.visibilityState = 'hidden';
  t.mock.timers.tick(RETRY);
  await flush();
  assert.equal(geo.watches.size, 0);

  page.visibilityState = 'visible';
  app.comeToFront();
  await flush();
  assert.equal(geo.watches.size, 1, 'no three-second wait on the way back');
  // The timer that was waiting does not start a second watch.
  t.mock.timers.tick(RETRY);
  await flush();
  assert.equal(geo.watches.size, 1);
  assert.equal(seen.errors.length, 1);
  assert.equal(geo.asks, 0);
});

test('stopping clears the watch and stops looking', async (t) => {
  const listenersBefore = app.count('appStateChange');
  const seen = watching(t, { permission: 'denied', answer: 'denied' });
  await flush();
  assert.equal(app.count('appStateChange'), listenersBefore + 1);
  seen.stop();
  await flush();
  assert.equal(app.count('appStateChange'), listenersBefore, 'its listener is removed');
  const checks = geo.checks;
  geo.permission = 'granted';
  app.comeToFront();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(RETRY); await flush(); }
  assert.equal(geo.checks, checks);
  assert.equal(geo.watches.size, 0);
});

test('a watch stopped while it was still starting does not stay running', async (t) => {
  const seen = watching(t, { pendingWatch: deferred() });
  await flush();
  seen.stop();
  geo.pendingWatch.resolve();
  await flush();
  assert.equal(geo.watches.size, 0);
  assert.equal(geo.cleared.length, 1);
  assert.deepEqual(seen.errors, []);
});

test('a plugin that is missing does not stop the app or fill the problem log', async () => {
  for (const kind of ['light', 'selection', 'success', 'warning']) P.haptic(kind); // Haptics is not in this app
  P.setSystemBars(true);                                                          // nor is SystemBars
  await P.keepAwake();                                                            // MarkerPost has no setKeepAwake here
  await flush();
  assert.deepEqual(unhandled, []);
});

test('the back button, app links and the last known post still reach the plugins', async () => {
  let handled = true;
  P.onBackButton(() => handled);
  app.emit('backButton', {});
  assert.equal(app.minimized, 0, 'a press the app handled does not send it to the background');
  handled = false;
  app.emit('backButton', {});
  assert.equal(app.minimized, 1);

  const links = [];
  app.launchUrl = 'markerpost://map';
  P.onAppLink((link) => links.push(link));
  await flush();
  app.emit('appUrlOpen', { url: 'markerpost://live/start' });
  app.emit('appUrlOpen', { url: 'https://example.test/not-ours' });
  assert.deepEqual(links, ['map', 'live/start']);

  const states = [];
  P.onAppState((active) => states.push(active));
  app.emit('appStateChange', { isActive: false });
  app.comeToFront();
  assert.deepEqual(states, [false, true]);

  P.publishPost({ ref: 'P20/9A' });
  await flush();
  assert.deepEqual(markerPost.published, [{ ref: 'P20/9A' }]);
  assert.deepEqual(unhandled, []);
});

test('a stop that did not get through is never reported as stopped', async () => {
  Object.assign(markerPost, { failStop: false, failStatus: false, active: true });
  assert.deepEqual(await P.live.stop(), { active: false });

  // The request fails but the native side can still be asked: its answer is the truth.
  Object.assign(markerPost, { failStop: true, failStatus: false, active: true });
  assert.deepEqual(await P.live.stop(), { active: true, since: 123, reason: 'stop-failed' });
  Object.assign(markerPost, { failStop: true, failStatus: false, active: false });
  assert.deepEqual(await P.live.stop(), { active: false });

  // Neither call gets through: it was running, and nothing says it has stopped.
  Object.assign(markerPost, { failStop: true, failStatus: true, active: true });
  assert.deepEqual(await P.live.stop(), { active: true, reason: 'stop-failed' });
});
