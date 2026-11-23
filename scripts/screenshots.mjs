#!/usr/bin/env node
// Take the screenshots shown in the README, from the real app.
//
//   node scripts/screenshots.mjs            into docs/images/app/
//   node scripts/screenshots.mjs some/dir   somewhere else
//
// It builds the web app, serves it on this computer for a minute, and drives
// the Chrome that is already installed. The position is simulated (and the app
// says so on screen), so nothing here needs GPS or shows where anyone is.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitOnSignals, launch } from './browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(process.argv[2] || join(ROOT, 'docs', 'images', 'app'));
const PORT = 8200 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}/`;

// Simulated fixes: latitude, longitude, direction of travel, speed in metres per second.
const M27 = '50.93795,-1.352527,110,30';      // M27 between junctions 5 and 7
const WINCHESTER = '51.0605,-1.3005,20,25';   // beside the M3 at Winchester
const CHILWORTH = '50.9585,-1.4000,90,25';    // M3 / M27 interchange

const PHONE = { width: 390, height: 844, scale: 2 };
const SHOTS = [
  { file: 'nearest-light.png', view: 'nearest', sim: M27, dark: false },
  { file: 'nearest-dark.png', view: 'nearest', sim: M27, dark: true },
  { file: 'nearest-landscape-dark.png', view: 'nearest', sim: M27, dark: true, size: { width: 844, height: 390, scale: 2 } },
  { file: 'map-light.png', view: 'map', sim: CHILWORTH, dark: false, locate: true },
  { file: 'map-dark.png', view: 'map', sim: WINCHESTER, dark: true, locate: true },
  { file: 'signs-dark.png', view: 'signs', sim: M27, dark: true },
  { file: 'goto-light.png', view: 'goto', sim: M27, dark: false },
];

const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-web.mjs'), '--target=pwa'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs'), join(ROOT, 'www'), String(PORT)], { stdio: 'ignore' });
const stopServer = () => { try { server.kill(); } catch { /* already gone */ } };
process.once('exit', stopServer);
// Ctrl+C ends Node without that 'exit' event. Make it a normal exit, so the
// server (and, once it is started, the browser) is stopped then too.
exitOnSignals();

let up = false;
for (let i = 0; i < 50 && !up; i++) {
  up = await fetch(BASE).then((r) => r.ok, () => false);
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) { stopServer(); throw new Error('The local preview server did not start.'); }

mkdirSync(OUT, { recursive: true });
const browser = await launch();
try {
  for (const shot of SHOTS) {
    const page = await browser.page({ ...(shot.size || PHONE), dark: shot.dark });
    await page.goto(`${BASE}?sim=${shot.sim}&theme=${shot.dark ? 'dark' : 'light'}#${shot.view}`, { waitMs: shot.view === 'map' ? 5000 : 1500 });
    if (shot.locate) {
      // Centre the map on the simulated position, then give the tiles time to draw.
      await page.click('#map-locate');
      await page.wait(4500);
    }
    await page.screenshot(join(OUT, shot.file));
    const problems = page.logs.filter((l) => l.type === 'exception');
    console.log(`  ${shot.file}${problems.length ? `  (page errors: ${problems.map((p) => p.text.split('\n')[0]).join('; ')})` : ''}`);
    await page.send('Page.close').catch(() => {});
    page.socket.close();
  }
} finally {
  await browser.close();
  stopServer();
}
console.log(`Screenshots written to ${OUT}`);
