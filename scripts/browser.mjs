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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  const base = `http://127.0.0.1:${port}`;
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`${base}/json/version`)).json(); } catch { await sleep(100); }
  }
  // Chrome is a family of processes, and on Windows ending the one that was
  // started can leave the rest running for good. So: end every browser process
  // that was started with this throwaway profile (it is named on each one's
  // command line), which can never match your own Chrome.
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { child.kill(); } catch { /* already gone */ }
    if (process.platform !== 'win32') return;
    const marker = basename(profile).replace(/'/g, "''");
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -match '^(chrome|msedge)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore', timeout: 20000 });
  };
  if (!version) { stop(); throw new Error('Chrome did not start its debugging port.'); }
  // Never leave the throwaway browser running if the script stops early.
  process.once('exit', stop);

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
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

function connect(url) {
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
