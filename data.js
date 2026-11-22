// Loading the app's data files, with an honest account of where each came from.
//
// Reference data (posts, junctions, ERA list) always comes from the copy that
// ships with the app, so the nearest-post lookup never waits on a network.
//
// Snapshots that change upstream (the road network, the sign snapshot) are
// refreshed when a connection allows:
//   * Web app: fetched from the site itself. Offline, the service worker hands
//     back its saved copy and marks it, and this module reports "saved".
//   * Native apps: fetched from the published site; the last good download is
//     kept on the device; the copy bundled in the app is the final fallback.
// Callers get { data, origin } and decide what to tell the user. Nothing here
// ever relabels an old file as fresh: every date shown in the UI is read from
// inside the data itself.

import config from './config.js';
import { isNative } from './platform.js';

const DB_NAME = 'markerpost';
const STORE = 'files';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function savedGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; } // storage unavailable: behave as if nothing was saved
}

async function savedSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* a failed save only costs the offline copy */ }
}

async function fetchJson(url, { timeoutMs = 12000, cache } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, ...(cache ? { cache } : {}) });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return { data: await res.json(), fallback: res.headers.get('X-Markerpost-Cache') === 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

/** Reference data that ships with the app. Throws if it cannot be read. */
export async function loadBundled(name, options = {}) {
  return (await fetchJson(`data/${name}`, options)).data;
}

const time = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };

/**
 * Load a snapshot that changes upstream.
 *   name      file name under data/
 *   stamp     (data) => the data's own "when was this produced" date string
 *   validate  (data) => true when the file is complete enough to use
 *   refresh   false to skip the network (use what is already on the device)
 * Resolves { data, origin } where origin is:
 *   "network"  downloaded just now
 *   "saved"    a copy kept from an earlier download (offline, or refresh failed)
 *   "bundled"  the copy that shipped inside the app
 * Rejects only when no usable copy exists at all.
 */
export async function loadSnapshot(name, { stamp = () => null, validate = () => true, refresh = true, timeoutMs = 12000 } = {}) {
  if (!isNative) {
    const { data, fallback } = await fetchJson(`data/${name}`, { timeoutMs, cache: 'no-cache' });
    if (!validate(data)) throw new Error(`${name} is incomplete`);
    return { data, origin: fallback ? 'saved' : 'network' };
  }

  if (refresh && navigator.onLine !== false) {
    try {
      const { data } = await fetchJson(`${config.hostedBase}data/${name}`, { timeoutMs, cache: 'no-cache' });
      if (validate(data)) {
        savedSet(name, data);
        return { data, origin: 'network' };
      }
    } catch { /* no connection or the site is unreachable: use what is on the device */ }
  }

  const [saved, bundled] = await Promise.all([
    savedGet(name),
    fetchJson(`data/${name}`).then((r) => r.data).catch(() => null),
  ]);
  const savedOk = saved && validate(saved), bundledOk = bundled && validate(bundled);
  if (savedOk && (!bundledOk || time(stamp(saved)) >= time(stamp(bundled)))) return { data: saved, origin: 'saved' };
  if (bundledOk) return { data: bundled, origin: 'bundled' };
  throw new Error(`${name} is unavailable`);
}
