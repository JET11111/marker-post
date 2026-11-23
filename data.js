// Loading the app's data files, with an honest account of where each came from.
//
// One rule sets how long a load waits for the network: a few seconds when a
// copy is already on the device, much longer when there is none. A slow or
// stalled connection therefore costs a short wait, never the data. A download
// still running when its load stops waiting carries on, and is kept for next
// time (by the service worker in the web app, by this module in the native
// apps). A caller that wants the fresh copy as soon as it lands, and not only
// next time, asks to be told (loadSnapshot's onLate).
//
// In the web app the service worker (sw.js) applies the same rule to each
// request as it leaves the page, a second sooner, so on a stalled connection
// it is usually the worker that answers, with its saved copy. The limit here
// is still needed: for a download that starts and then crawls, for a page the
// worker is not in charge of (a first visit, a forced reload), and in the
// native apps, which have no worker.
//
// Reference data (posts, junctions, ERA list, junction sections):
//   * Native apps: always the copy that ships inside the app, so the
//     nearest-post lookup never waits on a network.
//   * Web app: asked for from the site, so a new release is picked up. The
//     copy the service worker kept is used when the site is slow or cannot be
//     reached.
//
// Snapshots that change upstream (the road network, the sign snapshot) are
// refreshed when a connection allows:
//   * Web app: fetched from the site itself. Offline, slow or failing, the
//     copy the service worker kept is used and this module reports "saved".
//   * Native apps: fetched from the published site; the last good download is
//     kept on the device; the copy bundled in the app is the final fallback.
// Callers get { data, origin } and decide what to tell the user. Nothing here
// ever relabels an old file as fresh: every date shown in the UI is read from
// inside the data itself.

import config from './config.js';
import { isNative } from './platform.js';

/** How long a load waits for the network when a copy is already on the device. */
const WAIT_WITH_COPY_MS = 4000;
/** How long it waits when there is nothing on the device to fall back on. */
const WAIT_WITHOUT_COPY_MS = 30000;
/** A download still running after this long is given up, so it cannot hold up later loads for ever. */
const DOWNLOAD_LIMIT_MS = 120000;

// ------------------------------------- native apps: the last good download

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

// ---------------------------------------------------------------- downloads

// One download per address at a time. A load that stops waiting leaves its
// download running, and a later load of the same file joins it instead of
// starting again from nothing: on a slow connection that is the difference
// between finishing and never finishing.
const downloads = new Map();

/**
 * Resolves { data, fallback }; fallback is true when the service worker
 * answered with its saved copy because the network failed. `keep(data)` is
 * called with a finished download whether or not anyone is still waiting.
 */
function download(url, { cache, keep } = {}) {
  let job = downloads.get(url);
  if (job) return job;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOWNLOAD_LIMIT_MS);
  job = (async () => {
    try {
      const res = await fetch(url, { signal: ctl.signal, ...(cache ? { cache } : {}) });
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      const data = await res.json();
      if (keep) keep(data);
      return { data, fallback: res.headers.get('X-Markerpost-Cache') === 'fallback' };
    } catch (err) {
      throw ctl.signal.aborted ? new Error(`${url} took too long`) : err;
    } finally {
      clearTimeout(timer);
      downloads.delete(url);
    }
  })();
  job.catch(() => {}); // nobody may be waiting any more: a late failure is not a new problem
  downloads.set(url, job);
  return job;
}

// ----------------------------------------------------- copies on the device

const time = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };

// Web app: the copy of a data file that the service worker kept. It is read
// here directly, so it can be used however slow the network is and whichever
// version of the worker is running. sw.js names its caches
// "markerpost-<version>"; the newest is tried first. The street map's own
// cache (basemap.js, "markerpost-basemap-…") is not one of them.
async function savedByWorker(name, validate = () => true) {
  if (!('caches' in globalThis)) return null;
  try {
    const url = new URL(`data/${name}`, document.baseURI).href;
    const names = (await caches.keys())
      .filter((k) => k.startsWith('markerpost-') && !k.startsWith('markerpost-basemap-'))
      .reverse();
    for (const cacheName of names) {
      try {
        const hit = await caches.match(url, { cacheName, ignoreVary: true });
        if (!hit || !hit.ok) continue;
        const data = await hit.json();
        if (validate(data)) return { data, origin: 'saved' };
      } catch { /* an unreadable copy: try an older one */ }
    }
  } catch { /* storage unavailable: behave as if nothing was saved */ }
  return null;
}

// Native apps: the newer of the last good download and the copy bundled in the app.
async function onPhone(name, stamp, validate) {
  const [saved, bundled] = await Promise.all([
    savedGet(name),
    download(`data/${name}`).then((r) => r.data, () => null),
  ]);
  const savedOk = saved && validate(saved), bundledOk = bundled && validate(bundled);
  if (savedOk && (!bundledOk || time(stamp(saved)) >= time(stamp(bundled)))) return { data: saved, origin: 'saved' };
  if (bundledOk) return { data: bundled, origin: 'bundled' };
  return null;
}

// ------------------------------------------------------------- the one rule

/** Settles when `promise` does, or after `ms` if that comes first. For a promise that never rejects. */
function settledWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); });
  return Promise.race([promise, timeout]).then(() => clearTimeout(timer));
}

/**
 * Prefer the fresh copy, but do not wait long for it when there is a copy on
 * the device.
 *   fresh     promise of { data, origin } from the network; null to leave the network alone
 *   onDevice  () => { data, origin }, or null when the device holds no usable copy (may be async)
 *   timeoutMs the longest to wait when the device holds none
 *   late      called with the fresh { data, origin } if it arrives only after
 *             this load has stopped waiting for it (optional)
 */
async function freshOrOnDevice(name, fresh, onDevice, timeoutMs, late) {
  if (!fresh) {
    const copy = await onDevice();
    if (copy) return copy;
    throw new Error(`${name} is unavailable`);
  }
  // What became of the download, once that is known.
  let outcome = null;
  const settled = fresh.then((value) => { outcome = { ok: true, value }; }, (error) => { outcome = { ok: false, error }; });
  const patience = Math.min(WAIT_WITH_COPY_MS, timeoutMs);
  await settledWithin(settled, patience);
  if (outcome?.ok) return outcome.value;
  // Slow, stalled or failed: use the copy on the device if there is one.
  const copy = await onDevice();
  // Nothing to fall back on (a first visit, for example): give the download longer.
  if (!copy && !outcome) await settledWithin(settled, timeoutMs - patience);
  // (Looked at again because the download may have arrived while the device was being read.)
  if (outcome?.ok) return outcome.value;
  // This load stops waiting here. If its download is still running and
  // arrives after all, that is passed on.
  if (late) settled.then(() => { if (outcome.ok) late(outcome.value); });
  if (copy) return copy;
  throw outcome ? outcome.error : new Error(`${name} did not load in ${Math.round(timeoutMs / 1000)} seconds`);
}

const fromSite = ({ data, fallback }) => ({ data, origin: fallback ? 'saved' : 'network' });

/**
 * Reference data that ships with the app. Throws if it cannot be read.
 *   cache      the fetch cache mode, when the caller has a preference
 *   timeoutMs  the longest to wait when there is no copy on the device
 * With a copy on the device (web app) the wait is a few seconds at most.
 */
export async function loadBundled(name, { timeoutMs = WAIT_WITHOUT_COPY_MS, cache } = {}) {
  const fresh = download(`data/${name}`, { cache }).then(fromSite);
  // In the native apps the bundled file is the only copy: there is nothing behind it.
  const onDevice = () => (isNative ? null : savedByWorker(name));
  return (await freshOrOnDevice(name, fresh, onDevice, timeoutMs)).data;
}

/**
 * Load a snapshot that changes upstream.
 *   name      file name under data/
 *   stamp     (data) => the data's own "when was this produced" date string
 *   validate  (data) => true when the file is complete enough to use
 *   refresh   false to skip the network (use what is already on the device)
 *   timeoutMs the longest to wait when there is no usable copy on the device.
 *             With one, the network gets a few seconds and then the copy is used.
 *   onLate    (optional) see below
 *   freshOnly (optional) see below
 * Resolves { data, origin } where origin is:
 *   "network"  downloaded just now
 *   "saved"    a copy kept from an earlier download (offline, slow, or refresh failed)
 *   "bundled"  the copy that shipped inside the app
 * Rejects only when no usable copy exists at all.
 *
 * A load that stops waiting leaves its download running. With onLate the
 * caller hears of it if that download then arrives after all: onLate({ data,
 * origin: "network" }) is called, once at most, and never before this load's
 * own answer has been handed over. It follows an answer from the device, and
 * also a load that failed for want of one. It is not called for a download
 * that fails or is incomplete, or for an answer that is itself a saved copy.
 * It covers only the download this load was waiting on: when the service
 * worker has answered with its saved copy, the worker goes on downloading for
 * its cache alone, and only a later load will find that.
 *
 * freshOnly: true is for a caller that already has the copy on the device on
 * screen and is asking again for a newer one. The device is not read a second
 * time: the load resolves { data, origin: "network" } if that arrives within
 * the few seconds, and null if it does not (slow, failed, offline, or only a
 * saved copy to be had). It does not reject. onLate works as above.
 */
export function loadSnapshot(name, options) {
  // A late arrival is passed on by way of this load's own promise, so the
  // two can never reach the caller the wrong way round.
  const after = (tell) => own.then(tell, tell);
  const own = snapshot(name, options, after);
  return own;
}

// What a load is given in place of the copy on the device when its caller
// holds that copy already (freshOnly).
const HELD = { origin: 'held' };

async function snapshot(name, { stamp = () => null, validate = () => true, refresh = true, timeoutMs = 12000, onLate, freshOnly = false } = {}, after) {
  const usable = (r) => {
    if (!validate(r.data)) throw new Error(`${name} is incomplete`);
    return r;
  };
  const late = onLate && ((result) => { if (result.origin === 'network') after(() => onLate(result)); });
  const onDevice = (read) => (freshOnly ? () => HELD : read);
  const answer = (result) => (freshOnly && result.origin !== 'network' ? null : result);

  if (!isNative) {
    const fresh = refresh ? download(`data/${name}`, { cache: 'no-cache' }).then(usable).then(fromSite) : null;
    return answer(await freshOrOnDevice(name, fresh, onDevice(() => savedByWorker(name, validate)), timeoutMs, late));
  }

  const fresh = refresh && navigator.onLine !== false
    ? download(`${config.hostedBase}data/${name}`, {
      cache: 'no-cache',
      // The last good download, kept even if this load has stopped waiting for it.
      keep: (data) => { if (validate(data)) savedSet(name, data); },
    }).then(usable).then(({ data }) => ({ data, origin: 'network' }))
    : null;
  return answer(await freshOrOnDevice(name, fresh, onDevice(() => onPhone(name, stamp, validate)), timeoutMs, late));
}
