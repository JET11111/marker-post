#!/usr/bin/env node
// Check, in a real browser, that the web app keeps working when the connection
// goes away or stalls, and that it says what it is showing.
//
//   node scripts/smoke-web.mjs
//
// It builds the web app, serves it from this computer with a server that can
// be told to go "down" (connections refused) or "stalled" (requests accepted
// and never answered, which is what a weak signal looks like), and drives the
// Chrome that is already installed. The position is simulated.
//
// What it checks:
//   1. online: the app loads, shows a post, and saves itself for offline use;
//   2. server down: a reload still shows the app and the post, the Signs tab
//      shows its saved copy and says it is a saved copy, never "Live";
//   3. server stalled: the same, and within a few seconds, not after a long wait;
//   4. back online: the map draws today's road data by itself, and Signs refreshes.
//
// Run it before a release that touches sw.js, data.js or the map's loading. It is
// not run on GitHub: it needs a desktop Chrome or Edge, and takes about two minutes.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// MARKERPOST_ROOT lets a copy of this file outside the repository test the repository.
const ROOT = process.env.MARKERPOST_ROOT || fileURLToPath(new URL('..', import.meta.url));
const { launch } = await import(pathToFileURL(join(ROOT, 'scripts', 'browser.mjs')).href);
const WWW = join(ROOT, 'www');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(what);
}

// ------------------------------------------------------------------ the build
const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-web.mjs'), '--target=pwa'], { encoding: 'utf8' });
if (built.status !== 0) { console.error(built.stdout, built.stderr); process.exit(1); }

// ----------------------------------------------------------------- the server
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.pbf': 'application/x-protobuf', '.pmtiles': 'application/octet-stream',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
let mood = 'up'; // 'up' | 'down' | 'stalled'
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  if (mood === 'down') { req.socket.destroy(); return; }
  if (mood === 'stalled') return; // accepted, never answered
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(WWW, path.endsWith('/') ? `${path}index.html` : path));
    if (file !== WWW && !file.startsWith(WWW + sep)) { res.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : info.size - 1, info.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      createReadStream(file).pipe(res);
    }
  } catch { res.writeHead(404).end(); }
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const setMood = (next) => {
  mood = next;
  // Connections kept open from before would still be answered: drop them.
  for (const s of sockets) s.destroy();
};
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;
const M27 = '50.93795,-1.352527,110,30'; // M27 A carriageway between junctions 5 and 7

// ---------------------------------------------------------------- the browser
const browser = await launch();
let exitCode = 0;
try {
  const page = await browser.page({ width: 390, height: 844, scale: 2 });
  // Only this computer's server: the live sign relay and anything else on the internet is out of reach.
  await page.send('Network.enable');
  await page.send('Network.setBlockedURLs', { urls: ['https://*'] });
  const text = (id) => page.eval(`document.getElementById(${JSON.stringify(id)})?.textContent?.trim() || ''`);
  const visible = (id) => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return Boolean(e) && !e.classList.contains('hidden') && e.getClientRects().length > 0; })()`);
  const until = async (what, test, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await test().catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(300);
    }
  };
  const REF = /^\d+\/\d[A-Z]$/;
  const openApp = async (hash = 'nearest') => {
    const started = Date.now();
    await page.goto('about:blank', { waitMs: 100 });
    await page.goto(`${BASE}?sim=${M27}#${hash}`, { waitMs: 300 }).catch((e) => { throw new Error(`the page did not load (${e.message})`); });
    await until('a post on the first page', async () => REF.test(await text('np-ref')), 25000);
    return Date.now() - started;
  };
  const signs = async () => {
    await page.eval("location.hash = 'signs'");
    await until('the sign list', async () => (await page.eval("document.querySelectorAll('#s-list > *').length")) > 0 || (await visible('s-stale')), 25000);
    await sleep(800);
    return {
      meta: await text('s-meta'),
      live: await page.eval("Boolean(document.querySelector('#view-signs .live-flag'))"),
      callout: (await visible('s-stale')) ? await text('s-stale') : '',
      cards: await page.eval("document.querySelectorAll('#s-list > *').length"),
    };
  };

  // 1. Online.
  await openApp();
  check(true, 'online: the app loads and shows a post', `${await text('np-road')} ${await text('np-ref')}`);
  await until('the app to save itself for offline use', () => page.eval("await navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller) || new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(true), { once: true })))"), 30000)
    .then(() => check(true, 'online: the service worker is in charge of the page'), (e) => check(false, 'online: the service worker is in charge of the page', e.message));
  const cached = (await page.eval("await (async () => { const names = await caches.keys(); let n = 0; for (const k of names) n += (await (await caches.open(k)).keys()).length; return JSON.stringify({ names, files: n }); })()").then(JSON.parse)) || {};
  cached.keys = cached.names || [];
  check(cached.files > 20, 'online: the app and its data are saved on the device', `${cached.files} files in ${cached.keys.join(', ')}`);
  const online = await signs();
  check(online.cards > 0, 'online: the Signs tab lists signs', `${online.cards} signs · ${online.meta}`);
  check(!online.live, 'online: signs from the published file are not called Live (only the relay is live)');

  // 2. Server down.
  setMood('down');
  let ms = await openApp().catch((e) => { check(false, 'server down: the app still opens and shows a post', e.message); return null; });
  if (ms != null) check(true, 'server down: the app still opens and shows a post', `${await text('np-ref')} after ${(ms / 1000).toFixed(1)} s`);
  const down = await signs().catch((e) => ({ error: e.message }));
  check(!down.error && down.cards > 0, 'server down: the Signs tab shows its saved copy', down.error || `${down.cards} signs`);
  check(!down.error && !down.live, 'server down: nothing on the Signs tab says Live');
  check(!down.error && /saved copy|could not refresh|not refreshed/i.test(`${down.callout} ${down.meta}`), 'server down: the Signs tab says it is showing a saved copy', down.error || down.callout || down.meta);

  // 3. Server stalled: a weak signal.
  setMood('stalled');
  ms = await openApp().catch((e) => { check(false, 'weak signal: the app still opens and shows a post', e.message); return null; });
  if (ms != null) {
    check(true, 'weak signal: the app still opens and shows a post', `${await text('np-ref')} after ${(ms / 1000).toFixed(1)} s`);
    check(ms < 12000, 'weak signal: the post is on screen within 12 seconds', `${(ms / 1000).toFixed(1)} s`);
  }
  const startedSigns = Date.now();
  const stalled = await signs().catch((e) => ({ error: e.message }));
  check(!stalled.error && stalled.cards > 0, 'weak signal: the Signs tab shows its saved copy', stalled.error || `${stalled.cards} signs after ${((Date.now() - startedSigns) / 1000).toFixed(1)} s`);
  check(!stalled.error && !stalled.live, 'weak signal: nothing on the Signs tab says Live');
  check(!stalled.error && /saved copy|could not refresh|not refreshed/i.test(`${stalled.callout} ${stalled.meta}`), 'weak signal: the Signs tab says it is showing a saved copy', stalled.error || stalled.callout || stalled.meta);
  // The map's road data comes from a saved copy too.
  await page.eval("location.hash = 'map'");
  const mapState = await until('the map or its message', async () => {
    const canvas = await page.eval("Boolean(document.querySelector('#view-map canvas'))");
    const message = await page.eval("document.querySelector('#view-map .map-loading')?.textContent?.trim() || ''");
    const pill = await page.eval("document.querySelector('.map-data-pill')?.textContent?.trim() || ''");
    return canvas && pill ? { canvas, pill } : /could not|check your connection/i.test(message) ? { message } : null;
  }, 40000).catch((e) => ({ message: e.message }));
  check(Boolean(mapState.canvas), 'weak signal: the Map tab draws from its saved road data', mapState.message || mapState.pill);

  // 3b. Today's road data comes through after all: the map draws it by itself.
  const pill = () => page.eval("document.querySelector('.map-data-pill')?.textContent?.trim() || ''");
  const earlier = await until('the map to say its road data is an earlier copy', async () => /Earlier copy/.test(await pill()), 25000).then(() => true, () => false);
  check(earlier, 'weak signal: the map says its road data is an earlier copy', await pill());
  setMood('up');
  const upAt = Date.now();
  const fresh = await until("the map to draw today's road data", async () => { const p = await pill(); return p && !/Earlier copy|Loading/.test(p) ? p : null; }, 70000).catch(() => null);
  check(Boolean(fresh), "back online: the map draws today's road data without being asked", fresh ? `"${fresh}" after ${((Date.now() - upAt) / 1000).toFixed(1)} s` : 'still the earlier copy after 70 s');

  // 4. Back online.
  setMood('up');
  await openApp();
  const back = await signs().catch((e) => ({ error: e.message }));
  check(!back.error && back.cards > 0 && !/saved copy/i.test(back.callout), 'back online: the Signs tab refreshes and drops the saved-copy notice', back.error || back.callout || back.meta);

  const errors = page.logs.filter((l) => ['error', 'exception', 'log-error'].includes(l.type) && !/net::ERR|Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION|ERR_EMPTY_RESPONSE/i.test(l.text || ''));
  for (const l of errors) console.log(`  page ${l.type}: ${String(l.text).slice(0, 300)}`);
  check(errors.length === 0, 'no unexpected errors in the page', errors.slice(0, 3).map((l) => l.text).join(' | '));
} catch (e) {
  check(false, 'the check ran to the end', e.message);
} finally {
  await browser.close();
  setMood('down');
  server.close();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`); exitCode = 1; } else console.log('\nAll checks passed.');
process.exit(exitCode);
