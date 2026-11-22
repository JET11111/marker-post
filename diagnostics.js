// A small in-app problem log. An iPhone's web view cannot be inspected without
// a Mac, so when something goes wrong on the phone this is the only way to see
// what it was: Settings and about → Copy diagnostics.
//
// Nothing here leaves the device unless the user copies it. It records error
// text and counts only: no positions, no registrations, no post references.

import config from './config.js';

const MAX = 60;
const entries = [];
const counters = Object.create(null);
const listeners = new Set();

function push(level, message) {
  entries.push({ at: new Date().toISOString(), level, message: String(message).slice(0, 400) });
  if (entries.length > MAX) entries.shift();
  for (const fn of listeners) { try { fn(); } catch { /* a listener must not break logging */ } }
}

/** Record a problem. level: "error" | "warn" | "info". */
export function note(level, message) { push(level, message); }

/** Count something that is only worth knowing in aggregate (e.g. graphics context losses). */
export function count(name) { counters[name] = (counters[name] || 0) + 1; }

export function problemCount() { return entries.filter((e) => e.level === 'error').length; }

export function onChange(fn) { listeners.add(fn); }

/** The whole log as plain text, with enough about the device to make sense of it. */
export function report() {
  const canvas = document.createElement('canvas');
  const webgl2 = Boolean(canvas.getContext && canvas.getContext('webgl2'));
  const lines = [
    `Marker Post ${config.version} (${config.target}, build ${config.build})`,
    `Platform: ${document.documentElement.dataset.platform || 'web'}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`,
    `Online: ${navigator.onLine}  WebGL2: ${webgl2}`,
    `Counters: ${Object.keys(counters).length ? Object.entries(counters).map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    ...(entries.length ? entries.map((e) => `${e.at} ${e.level.toUpperCase()} ${e.message}`) : ['No problems recorded.']),
  ];
  return lines.join('\n');
}

window.addEventListener('error', (e) => {
  const where = e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno || 0})` : '';
  push('error', `${e.message || 'Script error'}${where}`);
});
window.addEventListener('unhandledrejection', (e) => {
  push('error', `Unhandled: ${e.reason?.message || e.reason || 'unknown reason'}`);
});
