#!/usr/bin/env node
// Cut the offline base map for the patch: a single PMTiles archive of vector
// tiles taken from a Protomaps daily planet build (OpenStreetMap data, ODbL).
//
//   node scripts/fetch-basemap.mjs                 build tiles/basemap.pmtiles
//   node scripts/fetch-basemap.mjs --dry-run       report tile count and size only
//   node scripts/fetch-basemap.mjs --build=20261122 --maxzoom=14 --corridor-km=3
//
// What it takes:
//   * every tile in the network bounding box up to --overview-zoom (default 12);
//   * above that, only tiles within --corridor-km of a National Highways road
//     link in data/network.json (the patrol corridors), up to --maxzoom.
// That keeps street-level detail where the network is and leaves out the
// countryside in between, which roughly halves the file.
//
// No dependencies (Node 22+ built-ins only) so the Pages workflow can run it.
// The archive is never committed: it is produced by CI and by this script.
// Protomaps asks that planet builds are copied, not hot-linked: this reads the
// build once, in merged byte ranges, and the app only ever reads our copy.

import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const opt = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const DRY = Boolean(opt('dry-run', false));
const MAXZOOM = Number(opt('maxzoom', 14));
const OVERVIEW_ZOOM = Number(opt('overview-zoom', 12));
const CORRIDOR_KM = Number(opt('corridor-km', 3));
const OUTPUT = join(ROOT, String(opt('output', 'tiles/basemap.pmtiles')));
const CONCURRENCY = 4;
const MERGE_GAP = 48 * 1024;        // join ranges separated by less than this
const MAX_RANGE = 12 * 1024 * 1024; // never ask for more than this in one request

// ------------------------------------------------------------ PMTiles v3

const TZ = Array.from({ length: 27 }, (_, z) => (4 ** z - 1) / 3); // tiles below zoom z

function zxyToTileId(z, x, y) {
  let d = 0;
  const xy = [x, y];
  for (let s = 2 ** z / 2; s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { xy[0] = s - 1 - xy[0]; xy[1] = s - 1 - xy[1]; }
      [xy[0], xy[1]] = [xy[1], xy[0]];
    }
  }
  return TZ[z] + d;
}

const u64 = (view, at) => Number(view.getBigUint64(at, true));

function parseHeader(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.subarray(0, 7).toString('latin1') !== 'PMTiles' || v.getUint8(7) !== 3) throw new Error('Not a PMTiles v3 archive');
  return {
    rootOffset: u64(v, 8), rootLength: u64(v, 16),
    metadataOffset: u64(v, 24), metadataLength: u64(v, 32),
    leafOffset: u64(v, 40), leafLength: u64(v, 48),
    dataOffset: u64(v, 56), dataLength: u64(v, 64),
    clustered: v.getUint8(96) === 1,
    internalCompression: v.getUint8(97), tileCompression: v.getUint8(98), tileType: v.getUint8(99),
    minZoom: v.getUint8(100), maxZoom: v.getUint8(101),
  };
}

function readDirectory(compressed, compression) {
  if (compression !== 2) throw new Error(`Unsupported directory compression ${compression} (expected gzip)`);
  const b = gunzipSync(compressed);
  let p = 0;
  const varint = () => {
    let result = 0, shift = 1; // multiply, not <<, so values above 2^31 stay exact
    for (;;) {
      const byte = b[p++];
      result += (byte & 0x7f) * shift;
      if (byte < 0x80) return result;
      shift *= 128;
    }
  };
  const n = varint();
  const entries = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last += varint(); entries[i] = { tileId: last, offset: 0, length: 0, run: 0 }; }
  for (let i = 0; i < n; i++) entries[i].run = varint();
  for (let i = 0; i < n; i++) entries[i].length = varint();
  for (let i = 0; i < n; i++) {
    const v = varint();
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

function writeDirectory(entries) {
  const bytes = [];
  const varint = (value) => {
    let v = value;
    while (v >= 0x80) { bytes.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    bytes.push(v);
  };
  varint(entries.length);
  let last = 0;
  for (const e of entries) { varint(e.tileId - last); last = e.tileId; }
  for (const e of entries) varint(e.run);
  for (const e of entries) varint(e.length);
  entries.forEach((e, i) => {
    varint(i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1);
  });
  return gzipSync(Buffer.from(bytes), { level: 9 });
}

/** Entry covering tileId, or null. Entries with run 0 point at a leaf directory. */
function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId < tileId) lo = mid + 1;
    else if (entries[mid].tileId > tileId) hi = mid - 1;
    else return entries[mid];
  }
  if (hi < 0) return null;
  const e = entries[hi];
  return e.run === 0 || tileId - e.tileId < e.run ? e : null;
}

// ------------------------------------------------------------ network I/O

let requests = 0, downloaded = 0;
async function range(url, offset, length, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206) throw new Error(`HTTP ${res.status} for a range request`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== length) throw new Error(`Short read: wanted ${length} bytes, got ${buf.length}`);
    requests++; downloaded += buf.length;
    return buf;
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    return range(url, offset, length, attempt + 1);
  }
}

async function latestBuild() {
  const pick = opt('build', null);
  if (pick) return String(pick).replace(/\.pmtiles$/, '');
  try {
    const builds = await (await fetch('https://build-metadata.protomaps.dev/builds.json')).json();
    const keys = builds.map((b) => String(b.key || '')).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort();
    if (keys.length) return keys.at(-1).replace('.pmtiles', '');
  } catch { /* fall through to probing recent dates */ }
  for (let back = 0; back < 9; back++) {
    const d = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
    const res = await fetch(`https://build.protomaps.com/${d}.pmtiles`, { method: 'HEAD' }).catch(() => null);
    if (res?.ok) return d;
  }
  throw new Error('Could not find a recent Protomaps build. Pass --build=YYYYMMDD.');
}

// ------------------------------------------------------------ tile selection

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function selectTiles() {
  const network = JSON.parse(await readFile(join(ROOT, 'data', 'network.json'), 'utf8'));
  const [west, south, east, north] = network.coverage.bounds;
  const tiles = new Set(); // "z/x/y"
  const clamp = (v, z) => Math.max(0, Math.min(2 ** z - 1, v));

  for (let z = 0; z <= Math.min(OVERVIEW_ZOOM, MAXZOOM); z++) {
    for (let x = lon2x(west, z); x <= lon2x(east, z); x++) {
      for (let y = lat2y(north, z); y <= lat2y(south, z); y++) tiles.add(`${z}/${x}/${y}`);
    }
  }

  // Corridor: sample every link at most ~400 m apart and take the tiles
  // within CORRIDOR_KM of each sample.
  const samples = [];
  for (const link of network.links) {
    const c = link.coordinates || [];
    for (let i = 0; i < c.length; i++) {
      samples.push(c[i]);
      if (i === 0) continue;
      const [lon1, lat1] = c[i - 1], [lon2, lat2] = c[i];
      const metres = Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 110540);
      const steps = Math.floor(metres / 400);
      for (let s = 1; s <= steps; s++) samples.push([lon1 + ((lon2 - lon1) * s) / (steps + 1), lat1 + ((lat2 - lat1) * s) / (steps + 1)]);
    }
  }
  for (let z = OVERVIEW_ZOOM + 1; z <= MAXZOOM; z++) {
    for (const [lon, lat] of samples) {
      const dLat = CORRIDOR_KM / 110.54, dLon = CORRIDOR_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
      const x0 = clamp(lon2x(Math.max(west, lon - dLon), z), z), x1 = clamp(lon2x(Math.min(east, lon + dLon), z), z);
      const y0 = clamp(lat2y(Math.min(north, lat + dLat), z), z), y1 = clamp(lat2y(Math.max(south, lat - dLat), z), z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.add(`${z}/${x}/${y}`);
    }
  }
  return { tiles, bounds: [west, south, east, north] };
}

// ------------------------------------------------------------ main

const started = Date.now();
const build = await latestBuild();
const SOURCE = `https://build.protomaps.com/${build}.pmtiles`;
console.log(`Source build ${build}`);

const head = await range(SOURCE, 0, 16384);
const header = parseHeader(head);
if (header.tileType !== 1) throw new Error('Source is not a vector (MVT) tileset');
if (MAXZOOM > header.maxZoom) throw new Error(`Source only goes to zoom ${header.maxZoom}`);
const rootDir = readDirectory(head.subarray(header.rootOffset, header.rootOffset + header.rootLength), header.internalCompression);

const leafCache = new Map();
async function lookup(tileId) {
  let entries = rootDir;
  for (let depth = 0; depth < 4; depth++) {
    const e = findEntry(entries, tileId);
    if (!e) return null;
    if (e.run > 0) return e;
    if (!leafCache.has(e.offset)) {
      leafCache.set(e.offset, range(SOURCE, header.leafOffset + e.offset, e.length)
        .then((b) => readDirectory(b, header.internalCompression)));
    }
    entries = await leafCache.get(e.offset);
  }
  throw new Error('Directory nesting too deep');
}

const { tiles, bounds } = await selectTiles();
const wanted = [...tiles].map((key) => {
  const [z, x, y] = key.split('/').map(Number);
  return { z, id: zxyToTileId(z, x, y) };
}).sort((a, b) => a.id - b.id);

// Resolve each tile to its content in the source. Tiles that are absent from
// the source (nothing there) are simply left out, as in the source.
const found = []; // { id, srcOffset, length }
const perZoom = new Map();
for (const t of wanted) {
  const e = await lookup(t.id);
  if (!e) continue;
  found.push({ id: t.id, z: t.z, srcOffset: e.offset, length: e.length });
  const z = perZoom.get(t.z) || { tiles: 0, bytes: 0 };
  z.tiles++; perZoom.set(t.z, z);
}
const contents = new Map(); // srcOffset -> { length, data, newOffset }
for (const f of found) {
  if (!contents.has(f.srcOffset)) {
    contents.set(f.srcOffset, { length: f.length });
    perZoom.get(f.z).bytes += f.length;
  }
}
const totalBytes = [...contents.values()].reduce((a, c) => a + c.length, 0);
console.log(`Selected ${found.length} tiles (${contents.size} distinct), ${(totalBytes / 1048576).toFixed(1)} MB of tile data`);
for (const z of [...perZoom.keys()].sort((a, b) => a - b)) {
  const s = perZoom.get(z);
  console.log(`  z${String(z).padStart(2)}  ${String(s.tiles).padStart(5)} tiles  ${(s.bytes / 1048576).toFixed(2).padStart(7)} MB`);
}
if (DRY) {
  console.log(`Dry run: ${requests} directory requests, nothing written.`);
  process.exit(0);
}

// Download: merge neighbouring ranges, a few requests at a time.
const order = [...contents.keys()].sort((a, b) => a - b);
const groups = [];
for (const off of order) {
  const len = contents.get(off).length, g = groups.at(-1);
  if (g && off - g.end <= MERGE_GAP && off + len - g.start <= MAX_RANGE) { g.end = off + len; g.items.push(off); }
  else groups.push({ start: off, end: off + len, items: [off] });
}
let done = 0;
async function worker() {
  for (;;) {
    const g = groups.shift();
    if (!g) return;
    const buf = await range(SOURCE, header.dataOffset + g.start, g.end - g.start);
    for (const off of g.items) {
      const c = contents.get(off);
      c.data = Buffer.from(buf.subarray(off - g.start, off - g.start + c.length)); // copy: let the big buffer go
    }
    done += g.items.length;
    if (process.stdout.isTTY) process.stdout.write(`\r  downloading ${done}/${contents.size} tiles`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (process.stdout.isTTY) process.stdout.write('\n');

// Sanity: every tile must be a complete gzip stream (the source's tile compression).
if (header.tileCompression === 2) {
  for (const [off, c] of contents) {
    try { gunzipSync(c.data); } catch { throw new Error(`Tile content at source offset ${off} is not valid gzip`); }
  }
}

// Lay the contents out in tile-id order (a "clustered" archive) and build entries.
let cursor = 0;
const entries = [];
for (const f of found) {
  const c = contents.get(f.srcOffset);
  if (c.newOffset === undefined) { c.newOffset = cursor; cursor += c.length; }
  const prev = entries.at(-1);
  if (prev && prev.offset === c.newOffset && prev.tileId + prev.run === f.id) prev.run++;
  else entries.push({ tileId: f.id, offset: c.newOffset, length: c.length, run: 1 });
}
const dataParts = [...contents.values()].filter((c) => c.newOffset !== undefined).sort((a, b) => a.newOffset - b.newOffset).map((c) => c.data);

// Directories: one root if it fits beside the header in the first 16 KB, else root + leaves.
let rootBytes = writeDirectory(entries), leafBytes = Buffer.alloc(0);
if (rootBytes.length > 16384 - 127) {
  for (let size = 4096; ; size *= 2) {
    const leaves = [], rootEntries = [];
    let leafCursor = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = writeDirectory(entries.slice(i, i + size));
      rootEntries.push({ tileId: entries[i].tileId, offset: leafCursor, length: leaf.length, run: 0 });
      leaves.push(leaf); leafCursor += leaf.length;
    }
    rootBytes = writeDirectory(rootEntries);
    leafBytes = Buffer.concat(leaves);
    if (rootBytes.length <= 16384 - 127) break;
  }
}

const srcMeta = JSON.parse(gunzipSync(await range(SOURCE, header.metadataOffset, header.metadataLength)).toString('utf8'));
const metadata = gzipSync(Buffer.from(JSON.stringify({
  ...srcMeta,
  name: 'Marker Post base map',
  description: `Extract of Protomaps build ${build} for the Hampshire patrol area. Full detail within ${CORRIDOR_KM} km of National Highways roads.`,
  attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
  'markerpost:build': build,
  'markerpost:extracted': new Date().toISOString(),
  'markerpost:bounds': bounds,
  'markerpost:overviewZoom': OVERVIEW_ZOOM,
  'markerpost:corridorKm': CORRIDOR_KM,
})), { level: 9 });

const out = Buffer.alloc(127);
out.write('PMTiles', 0, 'latin1');
out.writeUInt8(3, 7);
const rootOffset = 127, metadataOffset = rootOffset + rootBytes.length;
const leafOffset = metadataOffset + metadata.length, dataOffset = leafOffset + leafBytes.length;
const put64 = (value, at) => out.writeBigUInt64LE(BigInt(value), at);
put64(rootOffset, 8); put64(rootBytes.length, 16);
put64(metadataOffset, 24); put64(metadata.length, 32);
put64(leafOffset, 40); put64(leafBytes.length, 48);
put64(dataOffset, 56); put64(cursor, 64);
put64(found.length, 72); put64(entries.length, 80); put64(dataParts.length, 88);
out.writeUInt8(1, 96);                       // clustered
out.writeUInt8(2, 97);                       // directories and metadata: gzip
out.writeUInt8(header.tileCompression, 98);
out.writeUInt8(1, 99);                       // MVT
out.writeUInt8(0, 100); out.writeUInt8(MAXZOOM, 101);
const e7 = (deg) => Math.round(deg * 1e7);
out.writeInt32LE(e7(bounds[0]), 102); out.writeInt32LE(e7(bounds[1]), 106);
out.writeInt32LE(e7(bounds[2]), 110); out.writeInt32LE(e7(bounds[3]), 114);
out.writeUInt8(10, 118);
out.writeInt32LE(e7((bounds[0] + bounds[2]) / 2), 119); out.writeInt32LE(e7((bounds[1] + bounds[3]) / 2), 123);

await mkdir(dirname(OUTPUT), { recursive: true });
const tmp = `${OUTPUT}.tmp`;
await writeFile(tmp, Buffer.concat([out, rootBytes, metadata, leafBytes, ...dataParts]));
await rename(tmp, OUTPUT); // replace only once the new archive is complete
const size = 127 + rootBytes.length + metadata.length + leafBytes.length + cursor;
console.log(`Wrote ${OUTPUT}`);
console.log(`  ${(size / 1048576).toFixed(1)} MB, ${found.length} tiles, zoom 0-${MAXZOOM}, ${requests} requests, ${(downloaded / 1048576).toFixed(1)} MB downloaded, ${((Date.now() - started) / 1000).toFixed(0)} s`);
