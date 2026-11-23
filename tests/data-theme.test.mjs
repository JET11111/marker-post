// theme.js: the browser's own colour (address bar, task switcher) follows the
// appearance the user chose from the moment the app starts, not only after
// the next change; and everyone who asked is told about every change.

import assert from 'node:assert/strict';
import { test } from './data-fakes.mjs';

const LIGHT = '#F2F2F7', DARK = '#0A0F1A'; // as index.html declares them

/**
 * A page as index.html leaves it for theme.js: a saved Light or Dark is
 * already on <html>, and there is one colour for a light system and one for a
 * dark system.
 */
function page({ choice = null, systemDark = false } = {}) {
  const light = { content: LIGHT }, dark = { content: DARK };
  const system = {
    matches: systemDark,
    listeners: [],
    addEventListener(type, fn) { this.listeners.push(fn); },
    /** The phone switches between day and night. */
    turn(isDark) { this.matches = isDark; for (const fn of this.listeners) fn(); },
  };
  const saved = new Map(choice ? [['mp-theme', choice]] : []);
  const root = { dataset: choice ? { theme: choice } : {} };
  globalThis.document = {
    documentElement: root,
    getElementById: (id) => ({ 'theme-color-light': light, 'theme-color-dark': dark })[id] || null,
  };
  globalThis.window = { matchMedia: () => system };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k), getItem: (k) => saved.get(k) ?? null },
  });
  return { light, dark, system, saved, root };
}

// The module reads the page as it loads, so each test loads its own copy.
let copies = 0;
const start = () => import(`../theme.js?copy=${++copies}`);

test('a saved Dark is on the browser\'s own colour from the start, on a phone set to light', async () => {
  const { light, dark } = page({ choice: 'dark', systemDark: false });
  const theme = await start();
  assert.equal(theme.themeChoice(), 'dark');
  assert.equal(theme.isDark(), true);
  assert.equal(light.content, DARK, 'the colour a light system uses is the dark one');
  assert.equal(dark.content, DARK);
});

test('a saved Light is on the browser\'s own colour from the start, on a phone set to dark', async () => {
  const { light, dark } = page({ choice: 'light', systemDark: true });
  const theme = await start();
  assert.equal(theme.themeChoice(), 'light');
  assert.equal(theme.isDark(), false);
  assert.equal(light.content, LIGHT);
  assert.equal(dark.content, LIGHT, 'the colour a dark system uses is the light one');
});

test('with no choice saved the browser follows the system, as index.html declares', async () => {
  const { light, dark } = page({ systemDark: true });
  const theme = await start();
  assert.equal(theme.themeChoice(), 'auto');
  assert.equal(theme.isDark(), true);
  assert.equal(light.content, LIGHT);
  assert.equal(dark.content, DARK);
});

test('a choice changes the colour, is saved, and is told to everyone listening, wherever it was made', async () => {
  const { light, dark, saved, root } = page({ systemDark: false });
  const theme = await start();
  const heard = [];
  theme.onThemeChange(() => { throw new Error('one listener failing'); });
  const forget = theme.onThemeChange((isDark) => heard.push(isDark));
  assert.deepEqual(heard, [], 'not called until something changes');

  theme.setTheme('dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(saved.get('mp-theme'), 'dark');
  assert.deepEqual([light.content, dark.content], [DARK, DARK]);
  assert.deepEqual(heard, [true], 'the other listeners still hear');

  theme.setTheme('light');
  assert.equal(saved.get('mp-theme'), 'light');
  assert.deepEqual([light.content, dark.content], [LIGHT, LIGHT]);

  // Back to Automatic: nothing saved, and the two colours as they were declared.
  theme.setTheme('auto');
  assert.equal('theme' in root.dataset, false);
  assert.equal(saved.has('mp-theme'), false);
  assert.deepEqual([light.content, dark.content], [LIGHT, DARK]);
  assert.deepEqual(heard, [true, false, false]);

  forget();
  theme.setTheme('dark');
  assert.deepEqual(heard, [true, false, false], 'no longer listening');

  const now = [];
  theme.onThemeChange((isDark) => now.push(isDark), { immediate: true });
  assert.deepEqual(now, [true], 'told straight away when asked to be');
});

test('the system changing is passed on only while the choice is Automatic', async () => {
  const { system } = page({ systemDark: false });
  const theme = await start();
  const heard = [];
  theme.onThemeChange((isDark) => heard.push(isDark));
  system.turn(true);
  assert.deepEqual(heard, [true]);
  assert.equal(theme.isDark(), true);

  theme.setTheme('light');
  heard.length = 0;
  system.turn(false);
  system.turn(true);
  assert.deepEqual(heard, [], 'Light stays light whatever the phone does');
  assert.equal(theme.isDark(), false);
});

test('a page without the two colour tags, or without storage, still works', async () => {
  const { root } = page({ systemDark: false });
  globalThis.document.getElementById = () => null;
  globalThis.localStorage = { setItem() { throw new Error('storage is blocked'); }, removeItem() { throw new Error('storage is blocked'); } };
  const theme = await start();
  theme.setTheme('dark');
  assert.equal(root.dataset.theme, 'dark', 'the choice lasts for this visit');
  theme.setTheme('auto');
  assert.equal(theme.themeChoice(), 'auto');
});
