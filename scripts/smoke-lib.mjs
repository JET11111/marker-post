// Shared by the simulator and emulator checks (smoke-ios.mjs, smoke-android.mjs):
// a realistic drive to feed the phone's GPS, and small helpers.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const APP_ID = JSON.parse(readFileSync(`${ROOT}capacitor.config.json`, 'utf8')).appId;
export const SPEED = 31; // metres per second, about 70 mph

/**
 * The M27 A carriageway from post 17/0 to 24/0, as recorded: 71 posts, 7 km,
 * travelling with the traffic. Driving it at SPEED takes a little under four
 * minutes, and every position is within a few metres of a recorded post, so
 * the app must show M27, an A carriageway post between 17.0 and 24.0, and
 * (because the vehicle is moving) the carriageway as confirmed.
 */
export function route() {
  const posts = JSON.parse(readFileSync(`${ROOT}data/posts.json`, 'utf8'));
  return posts
    .filter((p) => p.road === 'M27' && p.direction === 'A' && p.distance >= 17 && p.distance <= 24)
    .sort((a, b) => a.distance - b.distance)
    .map((p) => ({ lat: p.lat, lng: p.lng, km: p.distance }));
}
export const EXPECT = { road: 'M27', letter: 'A', minKm: 17, maxKm: 24 };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a command and return its output; stop with a clear message if it fails. */
export function run(cmd, args, { allowFailure = false, binary = false, timeout = 120000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: binary ? 'buffer' : 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    if (allowFailure) return binary ? Buffer.alloc(0) : '';
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.error?.message || String(r.stderr || r.stdout).trim().slice(0, 600)}`);
  }
  return r.stdout;
}

/** Wait for check() to return something, trying once a second. */
export async function until(what, check, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (e) { last = e; }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

const failures = [];
/** Record a check. The script carries on, so one run reports everything that is wrong. */
export function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(what);
}
export function finish() {
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}
