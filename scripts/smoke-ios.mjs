#!/usr/bin/env node
// Run the iPhone app in a simulator and photograph it. Used by the "ios"
// workflow on one of GitHub's Macs; it needs Xcode, so it cannot run on Windows.
//
//   node scripts/smoke-ios.mjs <path to App.app> <folder for the pictures>
//
// Nothing can press a button in a simulator from the command line, so the app
// is driven with its links (markerpost://map, markerpost://live/start …) and
// the simulator's GPS is fed a drive along the M27.
//
// It fails if the app cannot be installed, stops running, or leaves a crash
// report. It cannot tell what is IN the pictures: they are kept with the run,
// to be looked at. The Lock Screen and CarPlay cannot be reached this way.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ID, SPEED, check, finish, route, run, sleep } from './smoke-lib.mjs';

const [appPath, outDir] = process.argv.slice(2);
if (!appPath || !outDir) {
  console.error('Usage: node scripts/smoke-ios.mjs <path to App.app> <folder for the pictures>');
  process.exit(2);
}
if (!existsSync(appPath)) throw new Error(`No app at ${appPath}`);
const OUT = resolve(outDir);
mkdirSync(OUT, { recursive: true });
const simctl = (...args) => run('xcrun', ['simctl', ...args]);
const startedAt = Date.now();

// The newest iPhone simulator on this machine. A recent iPhone has a Dynamic
// Island, which is where a running Live Activity shows outside the app.
const devices = JSON.parse(simctl('list', 'devices', 'available', '--json')).devices;
let best = null;
for (const [runtime, list] of Object.entries(devices)) {
  const m = /iOS-(\d+)-(\d+)/.exec(runtime);
  if (!m) continue;
  const version = Number(m[1]) * 1000 + Number(m[2]);
  for (const d of list) {
    if (!/^iPhone \d+( Pro)?$/.test(d.name)) continue;
    const model = Number(/^iPhone (\d+)/.exec(d.name)[1]) + (d.name.endsWith('Pro') ? 0.5 : 0);
    if (!best || version > best.version || (version === best.version && model > best.model)) {
      best = { udid: d.udid, name: d.name, runtime: `iOS ${m[1]}.${m[2]}`, version, model };
    }
  }
}
if (!best) throw new Error('No iPhone simulator is available on this machine');
const { udid } = best;
console.log(`Simulator: ${best.name}, ${best.runtime}`);

const shot = (name) => {
  simctl('io', udid, 'screenshot', join(OUT, `${name}.png`));
  console.log(`  picture: ${name}.png`);
};
const link = (path) => simctl('openurl', udid, `markerpost://${path}`);
const running = (pid) => run('ps', ['-p', String(pid)], { allowFailure: true }).includes(String(pid));

simctl('boot', udid);
simctl('bootstatus', udid, '-b');
try {
  simctl('ui', udid, 'appearance', 'dark');
  simctl('install', udid, appPath);
  // The same answer a person would give to the location question.
  simctl('privacy', udid, 'grant', 'location', APP_ID);
  // A drive along the M27, with the traffic, at about 70 mph. If this Xcode
  // cannot play a route, stand still on the first post instead and say so.
  const points = route().map((p) => `${p.lat},${p.lng}`);
  try {
    simctl('location', udid, 'start', `--speed=${SPEED}`, '--interval=1', ...points);
  } catch (e) {
    console.log(`  note: the simulator would not play a drive (${e.message.split('\n')[0]}); using a fixed position.`);
    simctl('location', udid, 'set', points[0]);
  }

  const launched = simctl('launch', udid, APP_ID).trim();
  const pid = Number(/:\s*(\d+)\s*$/.exec(launched)?.[1]);
  check(Number.isFinite(pid), 'the app launches', launched);

  await sleep(25000);
  check(running(pid), 'the app is still running after 25 seconds');
  shot('1-nearest-dark');

  link('map');
  await sleep(15000);
  shot('2-map-dark');

  link('live/start');
  await sleep(10000);
  check(running(pid), 'the app is still running after live tracking was started');
  shot('3-live-tracking-started');

  // Put another app in front. A running Live Activity then shows in the Dynamic Island.
  simctl('launch', udid, 'com.apple.Preferences');
  await sleep(8000);
  shot('4-dynamic-island-while-in-background');
  await sleep(12000);
  check(running(pid), 'the app keeps running in the background while tracking');
  shot('5-dynamic-island-twenty-seconds-later');

  link('live/stop');
  await sleep(6000);
  shot('6-live-tracking-stopped');

  simctl('ui', udid, 'appearance', 'light');
  link('nearest');
  await sleep(6000);
  shot('7-nearest-light');
  link('map');
  await sleep(12000);
  shot('8-map-light');
  check(running(pid), 'the app is still running at the end');

  // What the app and its extension wrote to the system log, for diagnosis.
  const seconds = Math.ceil((Date.now() - startedAt) / 1000) + 30;
  const log = run('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', `${seconds}s`, '--style', 'compact',
    '--predicate', 'process == "App" OR process == "MarkerPostWidgets" OR senderImagePath CONTAINS "MarkerPost"'],
  { allowFailure: true, timeout: 180000 });
  writeFileSync(join(OUT, 'system-log.txt'), log || '(no log output)\n');

  // A crash leaves a report behind.
  const reports = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  const crashes = existsSync(reports)
    ? readdirSync(reports).filter((f) => /^(App|MarkerPostWidgets)[-_].*\.(ips|crash)$/.test(f))
    : [];
  check(crashes.length === 0, 'no crash reports', crashes.join(', '));
  for (const f of crashes) run('cp', [join(reports, f), join(OUT, f)], { allowFailure: true });
} finally {
  run('xcrun', ['simctl', 'location', udid, 'clear'], { allowFailure: true });
  run('xcrun', ['simctl', 'shutdown', udid], { allowFailure: true });
}
finish();
