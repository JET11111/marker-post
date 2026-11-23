// A very small headless-Chrome driver for visual checks and screenshots.
// No dependencies: it starts the Chrome already installed on this machine
// with a throwaway profile and talks to it over the DevTools protocol.
//
//   import { launch } from './browser.mjs';
//   const browser = await launch();
//   const page = await browser.page({ width: 390, height: 844, dark: true });
//   await page.goto('http://localhost:8123/?sim=50.93795,-1.352527,110,30');
//   await page.screenshot('nearest-dark.png');
//   await browser.close();
//
// Used by scripts/screenshots.mjs. It never touches your normal Chrome profile.
//
// The browser it starts is stopped again however the script ends: normally, on
// an error, or when it is interrupted (Ctrl+C, Ctrl+Break, a closed window).
// Headless Chrome left running holds hundreds of megabytes each time. On
// Windows that includes the script being killed outright (Task Manager, a
// tool's time limit), which no code inside the script can act on: a small
// hidden stand-by clears up then (standBy below). On macOS and Linux a script
// killed with "kill -9" still leaves its browser behind.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let signalsHandled = false;
/**
 * Ctrl+C, Ctrl+Break, a closed window and a polite request to stop all end
 * Node WITHOUT its 'exit' event, so nothing registered with
 * process.once('exit') would run. This turns each of them into a normal exit,
 * so that clean-up does run. Safe to call more than once.
 *
 * It cannot help when Node is killed outright (Task Manager, taskkill /F, a
 * tool's time limit): no code in the script runs then. On Windows launch()
 * leaves that case to its stand-by.
 */
export function exitOnSignals() {
  if (signalsHandled) return;
  signalsHandled = true;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    // "on", not "once": a second, impatient Ctrl+C must not cut the clean-up short.
    process.on(signal, () => process.exit(130));
  }
}

/**
 * PowerShell that ends every browser process started with this throwaway
 * profile. The profile is named on each one's command line, so it can never
 * match your own Chrome.
 */
const sweepCommand = (profile) =>
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile).replace(/'/g, "''")}*' -and $_.Name -match '^(chrome|msedge)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;

/**
 * Windows only. A hidden PowerShell that stands by for as long as the browser
 * is in use, for the one way out no code in the script can act on: Node being
 * killed outright. Windows then ends the browser process that was started, but
 * not the rest of its family.
 *
 * It waits for the script to end. If the throwaway profile is still there once
 * it has, the script's own clean-up did not run or did not finish, so it ends
 * the family and removes the profile. It ends by itself when the profile has
 * gone (a normal close) or the script has ended, and while the script is
 * running it does nothing at all.
 */
function standBy(profile) {
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const cmd = join(system, 'cmd.exe');
  const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The command goes through cmd, which would take a " or a % in a folder's name for its own.
  if (!existsSync(cmd) || !existsSync(powershell) || /["%]/.test(profile + powershell)) return;
  const pid = process.pid;
  const folder = profile.replace(/'/g, "''");
  const script = [
    // Wait for the script, looking every two seconds whether the profile has gone.
    // "Older than me": once the script has ended, Windows may give its number to another program.
    '$me = (Get-Process -Id $PID).StartTime',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `if ($p -and $p.StartTime -lt $me) { while (-not $p.WaitForExit(2000)) { if (-not (Test-Path -LiteralPath '${folder}')) { exit } } }`,
    // Only once the script has really gone: never while it may still be using the browser.
    `if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath '${folder}')) { ${sweepCommand(profile)}; Start-Sleep -Seconds 1; Remove-Item -LiteralPath '${folder}' -Recurse -Force -ErrorAction SilentlyContinue }`,
  ].join('; ');
  // Started through cmd's "start", so that it is not a child of this script:
  // on Windows, Node's own children end when Node does, and a tool that stops
  // the script "and everything it started" would stop the stand-by as well.
  const starter = spawn(`start "" /b "${powershell}" -NoProfile -NonInteractive -Command "${script}"`,
    { shell: cmd, stdio: 'ignore', windowsHide: true });
  starter.on('error', () => { /* no stand-by this time: every other way out is still covered */ });
  starter.unref();
}

export async function launch({ port = 9333 + Math.floor(Math.random() * 500), headless = true } = {}) {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome or Edge executable.');
  const profile = await mkdtemp(join(tmpdir(), 'markerpost-chrome-'));
  const child = spawn(exe, [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    // Software WebGL so the vector map renders without a GPU.
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    'about:blank',
  ], { stdio: 'ignore' });

  // Chrome is a family of processes, and on Windows ending the one that was
  // started can leave the rest running for good. So the whole family is ended:
  // first through the process that was started, while it is still there to
  // find the others by; then every browser process that was started with this
  // throwaway profile (it is named on each one's command line), which can
  // never match your own Chrome. Everything here is synchronous, because it
  // also has to work from an 'exit' handler.
  const windows = process.platform === 'win32';
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Only while Node still holds the process: afterwards Windows may give its number to another program.
    if (windows && child.pid && child.exitCode === null && child.signalCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    }
    try { child.kill(); } catch { /* already gone */ }
    if (windows) {
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', sweepCommand(profile)],
        { stdio: 'ignore', timeout: 20000, windowsHide: true });
    }
    // The throwaway profile goes too. A file Windows has not let go of yet is left for the stand-by, or the temp clean-up.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* still in use */ }
  };
  // From this line on the browser must not outlive the script, however it
  // ends, including while it is still waiting for the browser to start.
  process.once('exit', stop);
  exitOnSignals();
  if (windows) standBy(profile);

  const base = `http://127.0.0.1:${port}`;
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`${base}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) { stop(); throw new Error('Chrome did not start its debugging port.'); }

  const pages = [];
  return {
    version: version.Browser,
    async page(options = {}) {
      const target = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
      const p = await connect(target.webSocketDebuggerUrl);
      pages.push(p);
      await p.send('Page.enable');
      await p.send('Runtime.enable');
      await p.send('Log.enable');
      await p.configure(options);
      return p;
    },
    async close() {
      for (const p of pages) { try { p.socket.close(); } catch { /* already closed */ } }
      stop();
      process.removeListener('exit', stop);
      // The processes have only just ended: one more go at any profile file that was still in use.
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

/** Attach to a page that is already open, by its DevTools WebSocket address (used for the Android emulator check). */
export function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const waiters = new Set();
    const page = {
      socket,
      /** Console messages and page errors, for assertions. */
      logs: [],
      send(method, params = {}) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      waitEvent(method, timeoutMs = 15000) {
        return new Promise((res, rej) => {
          const w = { method, res };
          waiters.add(w);
          setTimeout(() => { if (waiters.delete(w)) rej(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
        });
      },

      /** width/height in CSS px; scale = device pixel ratio; dark = prefers-color-scheme. */
      async configure({ width = 390, height = 844, scale = 2, dark = false, mobile = true, position } = {}) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
        if (position) {
          await page.send('Browser.grantPermissions', { permissions: ['geolocation'] }).catch(() => {});
          await page.send('Emulation.setGeolocationOverride', { latitude: position.lat, longitude: position.lng, accuracy: position.accuracy ?? 5 });
        }
      },
      async goto(address, { waitMs = 600 } = {}) {
        const loaded = page.waitEvent('Page.loadEventFired', 30000).catch(() => null);
        const r = await page.send('Page.navigate', { url: address });
        if (r.errorText) throw new Error(`${address}: ${r.errorText}`);
        // A change of #hash alone is a same-document navigation: no load event follows.
        if (r.loaderId) await loaded;
        await sleep(waitMs);
      },
      /** Evaluate an expression in the page (top-level await allowed) and return its value. */
      async eval(expression) {
        const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result.value;
      },
      async click(selector) {
        return page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('No element ' + ${JSON.stringify(selector)}); e.click(); return true; })()`);
      },
      /** A mouse click at a point (CSS px), for canvas content such as the map. */
      async clickAt(x, y) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
        await sleep(80);
      },
      /** A real tap at a point, for canvas content such as the map. */
      async tap(x, y) {
        for (const type of ['touchStart', 'touchEnd']) {
          await page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [{ x, y }] : [] });
        }
        await sleep(80);
      },
      /** file: where to save the PNG (omit to get the bytes back). transparent: keep the page background see-through. */
      async screenshot(file, { fullPage = false, transparent = false } = {}) {
        if (transparent) await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
        if (transparent) await page.send('Emulation.setDefaultBackgroundColorOverride');
        const bytes = Buffer.from(r.data, 'base64');
        if (!file) return bytes;
        await writeFile(file, bytes);
        return file;
      },
      wait: sleep,
    };

    socket.addEventListener('open', () => resolve(page));
    socket.addEventListener('error', (e) => reject(new Error(`DevTools socket error: ${e.message || 'unknown'}`)));
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        page.logs.push({ type: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        page.logs.push({ type: 'exception', text: msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text });
      } else if (msg.method === 'Log.entryAdded') {
        page.logs.push({ type: `log-${msg.params.entry.level}`, text: `${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim() });
      }
      for (const w of [...waiters]) {
        if (w.method === msg.method) { waiters.delete(w); w.res(msg.params); }
      }
    });
  });
}
