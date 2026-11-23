#!/usr/bin/env node
// Run the Android app on an emulator and check that it really works. Used by
// the "android" workflow inside an emulator on GitHub; it needs adb on the PATH.
//
//   node scripts/smoke-android.mjs <path to the debug APK> <folder for the pictures> [path to the release APK]
//
// The release APK (the build that would go to a store) is found beside the debug
// one when it is not named. It cannot be looked inside, so it is only checked
// for starting and staying up.
//
// The emulator's GPS is fed a drive along the M27. The script then looks inside
// the app (a debug build lets a tool read its web page) and checks that:
//   * the app starts and shows an M27 A-carriageway post for that drive;
//   * the map draws, with no errors recorded;
//   * live tracking puts the post in an ongoing notification, and stops cleanly;
//   * the home screen widget draws in each of its states with nothing cut off,
//     by day, by night and with large text, on a screen only the debug build has.
// It also takes pictures of each step, kept with the run.
//
// What it cannot check: a real phone's GPS, battery behaviour, or the widget on
// a real home screen (nothing can place one there from the command line).

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connect } from './browser.mjs';
import { APP_ID, EXPECT, SPEED, check, finish, route, run, sleep, until } from './smoke-lib.mjs';

const [apk, outDir] = process.argv.slice(2);
if (!apk || !outDir) {
  console.error('Usage: node scripts/smoke-android.mjs <path to the debug APK> <folder for the pictures>');
  process.exit(2);
}
const OUT = resolve(outDir);
mkdirSync(OUT, { recursive: true });
const releaseApk = process.argv[4] || (() => {
  const folder = dirname(resolve(apk));
  const found = readdirSync(folder).find((f) => f.endsWith('.apk') && !f.includes('-debug'));
  return found ? join(folder, found) : null;
})();
const adb = (...args) => run('adb', args);
const quiet = (...args) => run('adb', args, { allowFailure: true });
const shot = (name) => {
  writeFileSync(join(OUT, `${name}.png`), run('adb', ['exec-out', 'screencap', '-p'], { binary: true }));
  console.log(`  picture: ${name}.png`);
};
const openLink = (path) => adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `markerpost://${path}`, APP_ID);
// Debug builds only: the home screen widget in each of its states (see below).
const PREVIEW = `${APP_ID}/io.github.jet11111.markerpost.nativecore.WidgetPreviewActivity`;

// ------------------------------------------------------------ a moving GPS

// NMEA sentences, the text a real GPS receiver produces. They carry speed and
// direction of travel as well as position, which the emulator's simpler
// "geo fix" command does not (it always reports a heading of north).
//
// The emulator's receiver reads exactly two sentences, in exactly the layout
// the emulator itself writes (device/generic/goldfish, hals/gnss/GnssHwListener.cpp):
//   $GPGGA,hhmmss,ddmm.mmmm,N,dddmm.mmmm,W,1,10,0.8,60.0,M,0.,M,,,*cs
//   $GPRMC,hhmmss,A,ddmm.mmmm,N,dddmm.mmmm,W,knots,course,ddmmyy,0.0,W*cs
// A time with decimals, or an empty field near the end, and it ignores the lot.
// Only $GPRMC produces a position; $GPGGA gives it the altitude.
const points = route();
const R = 6371000, rad = Math.PI / 180;
const dist = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin((b.lat - a.lat) * rad / 2) ** 2
  + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2));
const bearing = (a, b) => (Math.atan2(Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad),
  Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad)) / rad + 360) % 360;
const along = [0];
for (let i = 1; i < points.length; i++) along.push(along[i - 1] + dist(points[i - 1], points[i]));
function positionAt(metres) {
  const d = Math.min(metres, along[along.length - 1] - 1);
  let i = 1;
  while (i < along.length - 1 && along[i] < d) i++;
  const a = points[i - 1], b = points[i], t = (d - along[i - 1]) / (along[i] - along[i - 1]);
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, course: bearing(a, b) };
}
const two = (n) => String(n).padStart(2, '0');
function nmea(body) {
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}
function degMin(value, width) {
  const abs = Math.abs(value), deg = Math.floor(abs), min = (abs - deg) * 60;
  return `${String(deg).padStart(width, '0')}${min.toFixed(4).padStart(7, '0')}`;
}
let travelled = 0;
function feedGps() {
  const p = positionAt(travelled);
  travelled += SPEED;
  const now = new Date();
  const time = `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  const date = `${two(now.getUTCDate())}${two(now.getUTCMonth() + 1)}${two(now.getUTCFullYear() % 100)}`;
  const lat = `${degMin(p.lat, 2)},${p.lat >= 0 ? 'N' : 'S'}`, lng = `${degMin(p.lng, 3)},${p.lng >= 0 ? 'E' : 'W'}`;
  const knots = (SPEED / 0.514444).toFixed(1);
  quiet('emu', 'geo', 'nmea', nmea(`GPGGA,${time},${lat},${lng},1,10,0.8,60.0,M,0.,M,,,`));
  quiet('emu', 'geo', 'nmea', nmea(`GPRMC,${time},A,${lat},${lng},${knots},${p.course.toFixed(1)},${date},0.0,W`));
}

// ---------------------------------------------------------------- the test

adb('wait-for-device');
// A freshly started emulator is slow, and Android then offers to close its own
// home screen ("Pixel Launcher isn't responding") on top of the app. Those boxes
// are switched off for the test, as Android's own test tools do.
quiet('shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1');
quiet('shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS');
quiet('shell', 'cmd', 'uimode', 'night', 'yes');
// -g answers "allow" to the location and notification questions, as a person would.
adb('install', '-r', '-g', apk);
feedGps();
const gps = setInterval(feedGps, 1000);

let page = null;
try {
  adb('shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`);

  // A debug build lets a tool attach to the app's web page, exactly as Chrome's own inspector does.
  // Every app with a web view has a debugging socket of its own, named after
  // its process. Another app's can come first in the list (on a slow start the
  // phone's own apps are still opening theirs), so the app's own is tried
  // first, by its process id, and then any other.
  page = await until('the app to open its page', async () => {
    const pid = quiet('shell', 'pidof', APP_ID).trim().split(/\s+/)[0];
    const found = [...quiet('shell', 'cat', '/proc/net/unix').matchAll(/@(webview_devtools_remote_(\d+))/g)];
    const sockets = [...new Set([...found.filter((m) => m[2] === pid), ...found].map((m) => m[1]))];
    for (const socket of sockets) {
      adb('forward', 'tcp:9339', `localabstract:${socket}`);
      const targets = await fetch('http://127.0.0.1:9339/json').then((r) => r.json()).catch(() => []);
      const target = targets.find((t) => t.type === 'page' && /localhost/.test(t.url));
      if (target) return connect(target.webSocketDebuggerUrl);
    }
    return null;
  }, 90000);
  await page.send('Runtime.enable');
  const read = (expression) => page.eval(expression);
  const text = (id) => read(`document.getElementById(${JSON.stringify(id)})?.textContent?.trim() || ''`);

  check(await read('window.Capacitor?.getPlatform?.()') === 'android', 'the page is running inside the Android app');
  check(await read("(await import('./config.js')).default.target") === 'native', 'it is the phone build of the web app');
  check(await read("document.getElementById('tab-vehicle')?.classList.contains('hidden')") === true, 'the Vehicle tab is not in the phone build');

  // The first page shows the post's reference without the records' leading "P": "20/9A" is 20.9 km, carriageway A.
  const REF = /^P?(\d+)\/(\d)([A-Z])$/;
  const ref = await until('a post to be shown', async () => {
    const shown = await text('np-ref'); // a dash until the first GPS fix
    return REF.test(shown) ? shown : null;
  }, 90000);
  const km = Number(`${REF.exec(ref)[1]}.${REF.exec(ref)[2]}`);
  const road = await text('np-road');
  const seen = /last location=Location\[gps ([-\d.]+),([-\d.]+)/.exec(quiet('shell', 'dumpsys', 'location'));
  console.log(`  the phone's GPS last reported: ${seen ? `${Number(seen[1]).toFixed(3)}, ${Number(seen[2]).toFixed(3)}` : 'nothing'} (the drive starts at ${points[0].lat.toFixed(3)}, ${points[0].lng.toFixed(3)})`);
  check(road === EXPECT.road, 'the road is the M27', road);
  check(km >= EXPECT.minKm && km <= EXPECT.maxKm, 'the post is on the stretch being driven', ref);
  await until('the carriageway to be confirmed from the direction of travel', async () =>
    read("document.getElementById('np-ref')?.dataset.confirmed === 'true' && /A$/.test(document.getElementById('np-ref').textContent.trim())"), 40000)
    .then(() => check(true, 'the A carriageway is chosen from the direction of travel while moving'),
      async () => check(false, 'the A carriageway is chosen from the direction of travel while moving', `showing ${await text('np-ref')}, "${await text('np-meta')}"`));
  console.log(`  showing: ${road} ${await text('np-ref')} · ${await text('np-section')} · ${await text('np-meta')}`);
  shot('1-nearest-dark');

  openLink('map');
  await sleep(15000);
  check(await read("Boolean(document.querySelector('#view-map canvas'))"), 'the map has drawn');
  shot('2-map-dark');

  openLink('live/start');
  await until('live tracking to start', async () => (await text('live-label')) === 'Stop live tracking', 30000)
    .then(() => check(true, 'live tracking starts'),
      async () => check(false, 'live tracking starts', `button says "${await text('live-label')}", toast "${await text('toast')}"`));
  const notification = await until('the ongoing notification to show a post', async () => {
    const dump = quiet('shell', 'dumpsys', 'notification', '--noredact');
    const mine = dump.split(/\n(?=\s*NotificationRecord)/).find((block) => block.includes(`pkg=${APP_ID}`));
    const title = /android\.title=(?:String|CharSequence)?\s*\(([^)]*)\)/.exec(mine || '')?.[1] || '';
    const body = /android\.text=(?:String|CharSequence)?\s*\(([^)]*)\)/.exec(mine || '')?.[1] || '';
    return /^M27 \d+\.\d [AB]$/.test(title) ? { title, body } : null;
  }, 40000).catch((e) => ({ error: e.message }));
  check(!notification.error, 'the notification shows the post', notification.error || `${notification.title} | ${notification.body}`);
  // The time comes first, so it is never the part a one-line notification cuts off.
  if (!notification.error) check(/^Updated \d\d:\d\d( · |$)/.test(notification.body), 'the notification text starts with the time', notification.body);
  shot('3-live-tracking-on');
  quiet('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(2500);
  shot('4-notification-shade');
  quiet('shell', 'cmd', 'statusbar', 'collapse');

  // Screen off and on again: tracking must carry on, and the lock screen shows the notification.
  quiet('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
  await sleep(12000);
  quiet('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await sleep(2500);
  shot('5-lock-screen');
  quiet('shell', 'wm', 'dismiss-keyguard');
  quiet('shell', 'input', 'keyevent', 'KEYCODE_MENU');
  await sleep(1500);
  const after = quiet('shell', 'dumpsys', 'notification', '--noredact');
  check(after.includes(`pkg=${APP_ID}`), 'tracking is still running after the screen was off');

  openLink('live/stop');
  await until('live tracking to stop', async () => (await text('live-label')) === 'Start live tracking', 30000)
    .then(() => check(true, 'live tracking stops'), () => check(false, 'live tracking stops'));
  // A slow emulator can take a few seconds to take the notification down, so
  // it is given up to 20 s, and the time it took is reported: a notification
  // that stays (or comes back) still fails.
  const stopAsked = Date.now();
  await until('the notification to go', async () => !quiet('shell', 'dumpsys', 'notification', '--noredact').includes(`pkg=${APP_ID}`), 20000)
    .then(() => check(true, 'the notification has gone', `after ${((Date.now() - stopAsked) / 1000).toFixed(1)} s`),
      () => check(false, 'the notification has gone', 'still there 20 s after tracking stopped'));

  quiet('shell', 'cmd', 'uimode', 'night', 'no');
  openLink('nearest');
  await sleep(4000);
  shot('6-nearest-light');
  openLink('signs');
  await sleep(5000);
  shot('7-signs-light');

  const report = await read("(await import('./diagnostics.js')).report()");
  writeFileSync(join(OUT, 'diagnostics.txt'), `${report}\n`);
  const errors = String(report).split('\n').filter((line) => / ERROR /.test(line));
  check(errors.length === 0, 'the app recorded no errors', errors.slice(0, 3).join(' | '));

  // The home screen widget. Nothing can place one on a home screen from the
  // command line, so the debug build has a screen that draws it in each of its
  // states with the widget's own code (WidgetPreviewActivity.kt). The screen
  // measures what it drew, marks in red any tile with something cut off, and
  // writes that to the log with what the notification would say for the same
  // posts. It draws itself again when the colours or the text size change.
  const previewLog = () => {
    const all = quiet('logcat', '-d', '-s', 'MarkerPostPreview:I');
    const start = all.lastIndexOf('Marker Post widget, debug preview');
    return start < 0 ? '' : all.slice(start);
  };
  const tileLine = (log, tile, part) => log.split('\n').find((l) => l.includes(`${tile}: ${part} [`)) || 'nothing in the log';
  // quiet(), so that a build without the screen fails this check and not the whole run.
  quiet('shell', 'am', 'start', '-W', '-n', PREVIEW);
  await sleep(4000);
  shot('8-widget-light');
  const day = previewLog();
  writeFileSync(join(OUT, 'widget-preview.txt'), day);
  check(day.includes('day colours, text size 1.0'), 'the widget preview screen opens', day.split('\n')[0] || 'nothing in the log from it');
  check(/checked 7 tiles, 0 with something cut/.test(day), 'nothing on the widget is cut off at the ordinary text size',
    day.split('\n').filter((l) => /cut \[(?!nothing)/.test(l) || /checked \d+ tiles/.test(l)).join(' | '));
  check(/Letter not confirmed: title \[M27 17\.4 A\] text \[Updated \d\d:\d\d · Check carriageway · J4 – J5\] chip \[17\.4\]/.test(day),
    'a carriageway letter that is not confirmed is said in words on the notification', tileLine(day, 'Letter not confirmed', 'title'));
  check(/Far from a post: title \[M3 117\.4\] text \[Updated \d\d:\d\d · Nearest recorded post · 1\.24 km away · Check carriageway\] chip \[\]/.test(day),
    'far from a post the notification says so straight after the time, with no letter and no chip', tileLine(day, 'Far from a post', 'title'));
  check(/No GPS \(stale\): title \[M27 17\.4 A\] text \[No GPS since \d\d:\d\d · last known post · J4 – J5\] chip \[\]/.test(day),
    'a stale notification says "No GPS since" and has no chip', tileLine(day, 'No GPS (stale)', 'title'));

  quiet('shell', 'cmd', 'uimode', 'night', 'yes');
  await sleep(4000);
  shot('9-widget-dark');
  check(previewLog().includes('night colours'), 'the widget preview is drawn again in the night colours');
  quiet('shell', 'cmd', 'uimode', 'night', 'no');

  // Text 30% larger: the setting most likely to squeeze the post number out.
  quiet('shell', 'settings', 'put', 'system', 'font_scale', '1.3');
  await sleep(5000);
  shot('10-widget-large-text');
  const large = previewLog();
  quiet('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
  writeFileSync(join(OUT, 'widget-preview-large-text.txt'), large);
  check(large.includes('text size 1.3'), 'the widget preview is drawn again with large text', large.split('\n')[0]);
  for (const tile of ['Letter confirmed', 'Letter not confirmed', 'No GPS (stale)', 'Long line']) {
    const measured = tileLine(large, tile, 'number');
    check(measured.includes('cut [nothing]'), `with large text nothing is cut off on a widget of ordinary size: ${tile}`, measured.replace(/^.*MarkerPostPreview: /, ''));
  }
  // The smallest widget with large text is at the limit of what can fit. Reported, not failed.
  for (const tile of ['Link, earlier day', 'Far from a post', 'No GPS, earlier day']) {
    console.log(`  smallest widget, large text: ${tileLine(large, tile, 'number').replace(/^.*MarkerPostPreview: /, '')}`);
  }

  // The release build: same code, built the way a store build is. It replaces
  // the debug build on the emulator (both are signed with the same key here).
  if (releaseApk) {
    try { page.socket.close(); } catch { /* already closed */ }
    page = null;
    quiet('logcat', '-b', 'crash', '-c');
    adb('install', '-r', '-g', releaseApk);
    adb('shell', 'am', 'start', '-W', '-n', `${APP_ID}/.MainActivity`);
    await sleep(20000);
    check(Boolean(quiet('shell', 'pidof', APP_ID).trim()), 'the release build starts and keeps running');
    const crashes = quiet('logcat', '-d', '-b', 'crash', '-t', '200');
    check(!crashes.includes(APP_ID), 'the release build did not crash', crashes.split('\n').filter((l) => /FATAL|Exception/.test(l)).slice(0, 2).join(' | '));
    shot('11-release-build');
    // The widget preview screen must not be in the build that goes to a store.
    // "am" reports its refusal as an error, which run() would throw away, so
    // the phone's own shell is asked to keep the words and report success.
    const refused = quiet('shell', `am start -W -n ${PREVIEW} 2>&1; true`);
    check(/does not exist|Error type 3/.test(refused), 'the widget preview screen is not in the release build', refused.trim().split('\n').pop());
  } else {
    console.log('  note: no release APK beside the debug one, so only the debug build was run.');
  }
} catch (e) {
  check(false, 'the check ran to the end', e.message);
  try { shot('failure'); } catch { /* no picture possible */ }
} finally {
  clearInterval(gps);
  quiet('shell', 'settings', 'put', 'system', 'font_scale', '1.0');
  try { page?.socket.close(); } catch { /* already closed */ }
  writeFileSync(join(OUT, 'logcat.txt'), quiet('logcat', '-d', '-t', '4000'));
}
finish();
