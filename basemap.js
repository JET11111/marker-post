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
      s.src = 'vendor/pmtiles/pmtiles.js';
      s.onload = () => resolve(globalThis.pmtiles);
      s.onerror = () => { libPromise = null; reject(new Error('The map tile reader failed to load')); };
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
  constructor(url) { this.url = url; }
  getKey() { return this.url; }
  async getBytes(offset, length, signal) {
    const res = await fetch(this.url, { signal, headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206 && !(res.status === 200 && offset === 0)) {
      throw new Error(`Base map archive: HTTP ${res.status}`);
    }
    if (!res.body) return { data: (await res.arrayBuffer()).slice(0, length) };
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
    return { data: out.buffer.slice(0, n) };
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
 * Open the base map and register it with MapLibre.
 * Resolves { available: false, reason } or
 * { available: true, url, mode: 'bundled' | 'saved' | 'online', maxzoom }.
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
  let source, mode;
  const saved = await savedResponse();
  if (saved) {
    // A fresh key each time, so a newly saved copy replaces the old reader.
    source = new BlobSource(await saved.blob(), `saved-basemap-${++opened}`);
    mode = 'saved';
  } else {
    source = new RangeSource(ARCHIVE_URL);
    mode = isNative ? 'bundled' : 'online';
  }
  const archive = new lib.PMTiles(source);
  try {
    const header = await archive.getHeader();
    protocol.add(archive);
    return { available: true, url: `pmtiles://${source.getKey()}`, mode, maxzoom: header.maxZoom };
  } catch (e) {
    return { available: false, reason: String(e?.message || e) };
  }
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

  /** Size of the download in bytes, or null if it cannot be determined (offline, or no archive published). */
  async size() {
    try {
      const res = await fetch(ARCHIVE_URL, { method: 'HEAD' });
      const n = Number(res.headers.get('Content-Length'));
      return res.ok && n > 0 ? n : null;
    } catch { return null; }
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
