// The street base map: one PMTiles archive (tiles/basemap.pmtiles) of
// OpenStreetMap vector tiles covering the patch. This module finds the best
// way to read it and registers it with MapLibre.
//
//   Native apps   the archive is bundled in the app: always available, no signal needed.
//   Web app       read over the network in byte ranges (only the tiles on
//                 screen are fetched) unless the user has chosen to keep the
//                 street map on the phone, in which case that saved copy is used.
//
// If the archive cannot be read at all the map still works: it shows the
// National Highways network and marker posts on a plain background.

import { isNative } from './platform.js';

const ARCHIVE_URL = new URL('tiles/basemap.pmtiles', document.baseURI).href;
const CACHE_NAME = 'markerpost-basemap-v1'; // sw.js leaves caches with this prefix alone
export const BASEMAP_ATTRIBUTION = '© OpenStreetMap';

// How long to wait for the tile reader's script, and for an answer about the
// archive itself (its header, its metadata, its size). A stalled connection
// must end in "no street map for now", which the map can try again, and never
// in a wait with no end.
const SCRIPT_TIMEOUT_MS = 15000;
const HEADER_TIMEOUT_MS = 8000;

let libPromise = null;
function loadPmtiles() {
  if (globalThis.pmtiles) return Promise.resolve(globalThis.pmtiles);
  // The tile reader calls AbortSignal.throwIfAborted(), which web views older
  // than Chrome 100 lack. Supplying it keeps the street map working there.
  if (typeof AbortSignal !== 'undefined' && !AbortSignal.prototype.throwIfAborted) {
    AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
      if (this.aborted) throw this.reason ?? new DOMException('Aborted', 'AbortError');
    };
  }
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // After a failure the next call starts again with a fresh request.
      const fail = () => { libPromise = null; reject(new Error('The map tile reader failed to load')); };
      const timer = setTimeout(fail, SCRIPT_TIMEOUT_MS);
      s.src = 'vendor/pmtiles/pmtiles.js';
      s.onload = () => { clearTimeout(timer); if (globalThis.pmtiles) resolve(globalThis.pmtiles); else fail(); };
      s.onerror = () => { clearTimeout(timer); fail(); };
      document.head.append(s);
    });
  }
  return libPromise;
}

/**
 * Reads byte ranges over HTTP and takes exactly the bytes asked for. The
 * local server inside the Android app answers a range request by sending
 * from the start offset to the end of the file; reading only what is needed
 * and then cancelling makes that harmless.
 */
class RangeSource {
  /** `ArchiveChanged` is the tile reader's own error class for "this is a different file now". */
  constructor(url, ArchiveChanged) { this.url = url; this.ArchiveChanged = ArchiveChanged; this.mustReload = false; }
  getKey() { return this.url; }
  async getBytes(offset, length, signal, wantedEtag) {
    // The reader passes no signal when it reads the archive's header and its
    // metadata. Those reads get a time limit of their own, which also covers
    // receiving the bytes.
    let timer, timedOut = false;
    if (!signal) {
      const ctl = new AbortController();
      timer = setTimeout(() => { timedOut = true; ctl.abort(); }, HEADER_TIMEOUT_MS);
      signal = ctl.signal;
    }
    try {
      const res = await fetch(this.url, {
        signal,
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        ...(this.mustReload ? { cache: 'reload' } : {}),
      });
      // The archive's contents change about once a month, but its ETag changes
      // every time the website is published again, and that is many times a
      // day (whenever the sign data changes): GitHub Pages makes the ETag
      // from the time of the deploy and the file's size. The reader keeps the
      // old file's index in memory, so an answer under a different ETag, or
      // an offset past the file's end, must make it read the index again
      // rather than cut tiles from the wrong place (see forgivingCache). From
      // then on the browser's own cache is bypassed too, or it could hand
      // back parts of the old file.
      const tag = res.headers.get('ETag');
      const etag = tag && !tag.startsWith('W/') ? tag : undefined;
      if ((wantedEtag && etag && etag !== wantedEtag) || (res.status === 416 && offset > 0)) {
        this.mustReload = true;
        res.body?.cancel().catch(() => {});
        throw new this.ArchiveChanged('The street map archive changed');
      }
      if (res.status !== 206 && !(res.status === 200 && offset === 0)) {
        throw new Error(`Base map archive: HTTP ${res.status}`);
      }
      if (!res.body) return { data: (await res.arrayBuffer()).slice(0, length), etag };
      const reader = res.body.getReader();
      const out = new Uint8Array(length);
      let n = 0;
      while (n < length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.byteLength, length - n);
        out.set(value.subarray(0, take), n);
        n += take;
      }
      reader.cancel().catch(() => {});
      return { data: out.buffer.slice(0, n), etag };
    } catch (e) {
      if (timedOut) throw new Error(`Base map archive: no answer in ${HEADER_TIMEOUT_MS / 1000} s`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reads from a copy held on the device. */
class BlobSource {
  constructor(blob, key) { this.blob = blob; this.key = key; }
  getKey() { return this.key; }
  async getBytes(offset, length) {
    return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
  }
}

async function savedResponse() {
  if (isNative || !('caches' in globalThis)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(ARCHIVE_URL)) || null;
  } catch { return null; }
}

let protocol = null;
let opened = 0;

/**
 * The date of the OpenStreetMap data inside an archive, as a function that
 * reads it from the archive's own metadata the first time it is called.
 * Resolves an ISO date string, or null when the archive does not say.
 * Rejects when the metadata cannot be read; the next call then tries again.
 */
function dataDateReader(archive) {
  let reading = null;
  return () => {
    if (!reading) {
      reading = archive.getMetadata().then((meta) => {
        const stamp = meta?.['planetiler:osm:osmosisreplicationtime'];
        if (stamp) return stamp;
        // Otherwise the day of the Protomaps build it was cut from ("20261122").
        const build = /^(\d{4})(\d{2})(\d{2})$/.exec(meta?.['markerpost:build'] || '');
        return build ? `${build[1]}-${build[2]}-${build[3]}` : null;
      });
      reading.catch(() => { reading = null; });
    }
    return reading;
  };
}

/**
 * What the tile reader remembers of one archive: its header and its index.
 *
 * The reader's usual memory is a poor fit for a phone that loses signal. It
 * keeps a read that failed, and answers every tile after it with that same
 * failure without asking the network again. And when it finds that the
 * archive has changed (see RangeSource) it throws the old header away before
 * it has the new one. One lost connection at the wrong moment, and there
 * would be no street map until the app was restarted.
 *
 * This one is built on the reader's plainer memory, which keeps only what
 * was read successfully, and it keeps the header it has until a newer one
 * has been read in its place. While the changed archive's header cannot be
 * had, the old one stays in use. That is safe: where the server sends ETags,
 * as GitHub Pages does, every answer is checked against the header's before
 * a byte of it is used.
 *
 * The plainer memory does not share one read between tiles that are asked
 * for together. That costs nothing while the whole index arrives with the
 * header, as it does for an archive of this size (it has no leaf directories).
 */
function forgivingCache(lib) {
  let memory = new lib.ResolvedValueCache();
  let renewing = null; // the changed archive's header, while it is being read
  return {
    // During a change, wait for the new header; failing that, carry on with the old.
    getHeader: (source) => (renewing ? renewing.catch(() => memory.getHeader(source)) : memory.getHeader(source)),
    getDirectory: (...args) => memory.getDirectory(...args),
    // The reader calls this when an answer came from a different file, and
    // asks for the header again straight afterwards. Every tile on its way
    // says so at about the same time: one read of the new header serves them all.
    invalidate(source) {
      if (!renewing) {
        const fresh = new lib.ResolvedValueCache();
        renewing = fresh.getHeader(source).then(
          (header) => { memory = fresh; renewing = null; return header; },
          (e) => { renewing = null; throw e; },
        );
        renewing.catch(() => {}); // not a fault to report: the old header stays in use
      }
      return Promise.resolve();
    },
  };
}

/**
 * Open the base map and register it with MapLibre. Always settles, and never
 * rejects: every wait on the way has a time limit.
 * Resolves { available: false, reason } or
 * { available: true, url, mode: 'bundled' | 'saved' | 'online', maxzoom, dataDate }
 * where dataDate() resolves the date of the street data (see dataDateReader).
 */
export async function openBasemap(maplibregl) {
  let lib;
  try { lib = await loadPmtiles(); } catch (e) { return { available: false, reason: String(e.message || e) }; }
  if (!protocol) {
    // A tile the archive does not hold must be an error, not an empty tile:
    // MapLibre then keeps drawing the overview tile it already has, instead
    // of blanking the map away from the network corridors.
    protocol = new lib.Protocol({ errorOnMissingTile: true });
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
  // A copy kept on the phone comes first. If it cannot be read, the published
  // file is still worth trying: better than no street map at all.
  const ways = [];
  const saved = await savedResponse();
  if (saved) {
    // A fresh key each time, so a newly saved copy replaces the old reader.
    ways.push({ mode: 'saved', source: async () => new BlobSource(await saved.blob(), `saved-basemap-${++opened}`) });
  }
  ways.push({ mode: isNative ? 'bundled' : 'online', source: async () => new RangeSource(ARCHIVE_URL, lib.EtagMismatch) });

  const reasons = [];
  for (const way of ways) {
    try {
      const source = await way.source();
      const archive = new lib.PMTiles(source, forgivingCache(lib));
      const header = await archive.getHeader();
      protocol.add(archive);
      return { available: true, url: `pmtiles://${source.getKey()}`, mode: way.mode, maxzoom: header.maxZoom, dataDate: dataDateReader(archive) };
    } catch (e) {
      reasons.push(`${way.mode}: ${String(e?.message || e)}`);
    }
  }
  return { available: false, reason: reasons.join('; ') };
}

/** Keeping the street map on the phone (web app only; the native apps bundle it). */
export const offlineBasemap = {
  supported: !isNative && 'caches' in globalThis,

  /** { saved, bytes, savedAt } */
  async status() {
    const res = await savedResponse();
    if (!res) return { saved: false };
    return {
      saved: true,
      bytes: Number(res.headers.get('Content-Length')) || null,
      savedAt: res.headers.get('X-Markerpost-Saved') || null,
    };
  },

  /** Size of the download in bytes, or null if it cannot be determined (offline, no answer in time, or no archive published). */
  async size() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HEADER_TIMEOUT_MS);
    try {
      const res = await fetch(ARCHIVE_URL, { method: 'HEAD', signal: ctl.signal });
      const n = Number(res.headers.get('Content-Length'));
      return res.ok && n > 0 ? n : null;
    } catch { return null; } finally { clearTimeout(timer); }
  },

  /** Download the whole archive and keep it. onProgress(receivedBytes, totalBytes | null). */
  async save(onProgress = () => {}, signal) {
    const res = await fetch(ARCHIVE_URL, { signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`Street map download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || null;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
    if (total && received !== total) throw new Error('Street map download was incomplete');
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const cache = await caches.open(CACHE_NAME);
    await cache.put(ARCHIVE_URL, new Response(blob, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(blob.size),
        'X-Markerpost-Saved': new Date().toISOString(),
      },
    }));
    // Ask the browser not to evict it under storage pressure (it may refuse).
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    return { saved: true, bytes: blob.size };
  },

  async remove() {
    try { await caches.delete(CACHE_NAME); } catch { /* nothing to remove */ }
    return { saved: false };
  },
};
