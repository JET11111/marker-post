// platform.js inside a phone app in which no plugin answers (a build that went
// wrong, or a plugin that failed to load). Capacitor does not throw for a
// missing plugin: every call returns a promise that rejects
// (createPluginMethodWrapper in @capacitor/core). None of that may stop the
// app, fill the problem log, or be reported as something it is not.

import assert from 'node:assert/strict';
import { flush, test, watchUnhandled } from './data-fakes.mjs';

const missing = (name) => new Proxy({}, {
  get: (_, method) => () => Promise.reject(new Error(`"${name}" plugin is not implemented on android`)),
});
const asked = [];
globalThis.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'android',
  registerPlugin: (name) => { asked.push(name); return missing(name); },
};
globalThis.document = { documentElement: { dataset: {} }, visibilityState: 'visible' };
const unhandled = watchUnhandled();

const P = await import('../platform.js');

test('decoration and wiring fail without a sound', async () => {
  for (const kind of ['light', 'selection', 'success', 'warning']) P.haptic(kind);
  P.setSystemBars(false);
  P.publishPost({ ref: 'P20/9A' });
  P.onAppState(() => assert.fail('no plugin, so no events'));
  P.onAppLink(() => assert.fail('no plugin, so no links'));
  P.onBackButton(() => assert.fail('no plugin, so no back button'));
  P.live.onChange(() => assert.fail('no plugin, so no events'));
  await P.live.update({ useHeading: false });
  await P.keepAwake();
  await flush();
  assert.deepEqual(unhandled, []);
  // Each plugin is asked for once, however often it is used.
  assert.deepEqual([...asked].sort(), ['App', 'Haptics', 'MarkerPost', 'SystemBars']);
});

test('the position watch says once what is wrong, then keeps looking quietly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  const stop = P.watchPosition(() => assert.fail('there can be no position'), (err) => errors.push(err));
  await flush();
  assert.deepEqual(errors, [{ code: 2, message: '"Geolocation" plugin is not implemented on android' }]);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(3000); await flush(); }
  assert.equal(errors.length, 1, 'said once only');
  stop();
  await flush();
  assert.deepEqual(unhandled, []);
});

test('live tracking is never said to be running, or to have stopped, without an answer', async () => {
  assert.deepEqual(await P.live.status(), { active: false });
  assert.deepEqual(await P.live.start({ useHeading: true }), { active: false, reason: '"MarkerPost" plugin is not implemented on android' });
  // A stop that reaches nobody stopped nothing.
  assert.deepEqual(await P.live.stop(), { active: true, reason: 'stop-failed' });
});

test('a request that needs an answer fails for the caller to deal with', async () => {
  await assert.rejects(P.getCurrentPosition(), /"Geolocation" plugin is not implemented/);
  await assert.rejects(P.getJson('https://example.test/signs'), /"CapacitorHttp" plugin is not implemented/);
  await flush();
  assert.deepEqual(unhandled, []);
});
