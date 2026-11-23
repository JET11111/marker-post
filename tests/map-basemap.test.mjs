// The street map file while the web app is open: basemap.js with the real
// tile reader (vendor/pmtiles/pmtiles.js) against a made-up website.
//
// The website is published again many times a day, and each time the file
// gets a new ETag although its contents change only once a month. The app
// then reads the file's header again. These tests are about what happens
// when that read fails: the street map must come back by itself, and bytes
// from a new file must never be cut up with an old file's index.
// PROPOSED FILE: save as tests/map-basemap.test.mjs (the imports are written for that place).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// ---- a page, as far as basemap.js and platform.js need one. Set before they load.
globalThis.document = { baseURI: 'https://app.test/', documentElement: { dataset: {} } };
// The tile reader is a plain script that defines the global "pmtiles"; basemap.js uses it when it is already there.
globalThis.pmtiles = new Function(`${await readFile(new URL('../vendor/pmtiles/pmtiles.js', import.meta.url), 'utf8')}\nreturn pmtiles;`)();

// ---- a small archive in the PMTiles 3 layout, nothing compressed
const TILE = { root: 0, child: 1 }; // the numbers of tiles 0/0/0 and 1/0/0; tile 1/1/1 is in neither file
const text = (s) => new TextEncoder().encode(s);
const varint = (n) => { const out = []; for (; n > 127; n = Math.floor(n / 128)) out.push((n % 128) + 128); out.push(n); return out; };
function archive(tiles, osmDate) {
  const dir = varint(tiles.length);
  tiles.forEach(([id], i) => dir.push(...varint(id - (i ? tiles[i - 1][0] : 0))));
  tiles.forEach(() => dir.push(...varint(1)));                 // each entry is one tile
  tiles.forEach(([, data]) => dir.push(...varint(data.length)));
  let at = 0;
  for (const [, data] of tiles) { dir.push(...varint(at + 1)); at += data.length; }
  const root = Uint8Array.from(dir);
  const meta = text(JSON.stringify({ 'planetiler:osm:osmosisreplicationtime': osmDate }));
  const header = new Uint8Array(127), view = new DataView(header.buffer);
  const put = (offset, n) => view.setBigUint64(offset, BigInt(n), true);
  header.set(text('PMTiles')); header[7] = 3;
  put(8, 127); put(16, root.length);                           // root directory
  put(24, 127 + root.length); put(32, meta.length);            // metadata
  put(40, 127 + root.length + meta.length); put(48, 0);        // no leaf directories
  put(56, 127 + root.length + meta.length); put(64, at);       // tile data
  put(72, tiles.length); put(80, tiles.length); put(88, tiles.length);
  header.set([1, 1, 1, 1, 0, 1], 96);                          // clustered, no compression, vector tiles, zoom 0 to 1
  [-20000000, 500000000, -5000000, 520000000].forEach((n, i) => view.setInt32(102 + 4 * i, n, true));
  return Buffer.concat([header, root, meta, ...tiles.map(([, data]) => data)]);
}
// Two months' files. The second holds different tiles at different places.
const NOVEMBER = archive([[TILE.root, text('november, the whole patch')], [TILE.child, text('november, north-west')]], '2026-11-22T04:00:00Z');
const DECEMBER = archive([[TILE.root, text('december: whole patch')], [TILE.child, text('december: the north-west quarter')]], '2026-12-20T04:00:00Z');

// A failure nobody handled would reach the app's problem log as "Unhandled: …".
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason?.message || reason)));

// ---- the website
const ADDRESS = 'https://app.test/tiles/basemap.pmtiles';
const site = {};
function publish(bytes, etag) { Object.assign(site, { bytes, etag }); }
function reset() {
  Object.assign(site, { failHeaderReads: 0, down: false, requests: [] });
  publish(NOVEMBER, '"deploy-1"');
  unhandled.length = 0; // each test answers for its own
}
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), ADDRESS);
  const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range')).map(Number);
  site.requests.push(`${from === 0 ? 'header' : 'part'}${init.cache ? ` (${init.cache})` : ''}`);
  // An answer never arrives in the same turn as its request: tiles asked for
  // together are all on their way before the first of them is answered.
  await new Promise((resolve) => setImmediate(resolve));
  if (site.down) throw new TypeError('Failed to fetch');
  if (from === 0 && site.failHeaderReads > 0) { site.failHeaderReads--; throw new TypeError('Failed to fetch'); }
  if (from >= site.bytes.length) return new Response(null, { status: 416, headers: { ETag: site.etag } });
  return new Response(site.bytes.subarray(from, to + 1), { status: 206, headers: { ETag: site.etag } });
};

// ---- MapLibre, as far as basemap.js needs it: somewhere to register the reader
let ask = null;
const maplibre = { addProtocol(name, fn) { assert.equal(name, 'pmtiles'); ask = fn; } };
const { openBasemap } = await import('../basemap.js');

/** Open the street map afresh, as the map does at start. */
async function open() {
  reset();
  const found = await openBasemap(maplibre);
  assert.equal(found.available, true, found.reason);
  assert.equal(found.url, `pmtiles://${ADDRESS}`);
  site.requests = [];
  return {
    found,
    /** One tile's bytes as text, or "FAILED: why". */
    tile: (z, x, y) => ask({ url: `${found.url}/${z}/${x}/${y}`, type: 'arrayBuffer' }, new AbortController())
      .then((r) => new TextDecoder().decode(r.data), (e) => `FAILED: ${e.message}`),
    /** What MapLibre asks for first, every time a style with the street map is set. */
    describe: () => ask({ url: found.url, type: 'json' }, new AbortController())
      .then((r) => r.data, (e) => `FAILED: ${e.message}`),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a street map that will not open says why, and the next attempt starts afresh', async () => {
  reset();
  site.failHeaderReads = 1;
  const failed = await openBasemap(maplibre);
  assert.equal(failed.available, false);
  assert.match(failed.reason, /^online: Failed to fetch$/);
  const found = await openBasemap(maplibre);
  assert.equal(found.available, true);
  assert.equal(found.mode, 'online');
  assert.equal(found.maxzoom, 1);
  assert.equal(await found.dataDate(), '2026-11-22T04:00:00Z');
});

test('tiles are read in parts; a tile the archive does not hold is an error, not an empty tile', async () => {
  const { tile } = await open();
  assert.equal(await tile(0, 0, 0), 'november, the whole patch');
  assert.equal(await tile(1, 0, 0), 'november, north-west');
  assert.deepEqual(site.requests, ['part', 'part'], 'the header read at opening serves every tile');
  assert.equal(await tile(1, 1, 1), 'FAILED: Tile not found.');
});

test('the site is published again with the same file: the header is read once more and the map carries on', async () => {
  const { tile } = await open();
  assert.equal(await tile(0, 0, 0), 'november, the whole patch');
  publish(NOVEMBER, '"deploy-2"');
  site.requests = [];
  assert.equal(await tile(1, 0, 0), 'november, north-west');
  // The answer under the new ETag is not used; the header is read past the browser's cache, then the tile again.
  assert.deepEqual(site.requests, ['part', 'header (reload)', 'part (reload)']);
  site.requests = [];
  assert.equal(await tile(0, 0, 0), 'november, the whole patch');
  assert.deepEqual(site.requests, ['part (reload)'], 'and after that there is nothing more to read again');
  await settle();
  assert.deepEqual(unhandled, []);
});

test('published again, and the one read of the header fails: the street map comes back by itself', async () => {
  const { found, tile, describe } = await open();
  assert.equal(await tile(0, 0, 0), 'november, the whole patch');
  publish(NOVEMBER, '"deploy-2"');
  site.failHeaderReads = 1;
  assert.match(await tile(1, 0, 0), /^FAILED: /, 'this one tile is lost');
  // Still no signal when the appearance changes (dusk). MapLibre asks what the
  // street map is once for each style and never again: it must be told now,
  // or there is no street map until the style is next set.
  site.down = true;
  site.requests = [];
  assert.deepEqual(await describe(), { tiles: [`${found.url}/{z}/{x}/{y}`], minzoom: 0, maxzoom: 1, bounds: [-2, 50, -0.5, 52] });
  assert.deepEqual(site.requests, [], 'from what is already known, with no request');
  // Signal returns. The next tile asked for reads the header again, and everything works as before.
  site.down = false;
  assert.equal(await tile(1, 0, 0), 'november, north-west');
  assert.ok(site.requests.includes('header (reload)'));
  assert.equal(await tile(0, 0, 0), 'november, the whole patch');
  assert.equal(await found.dataDate(), '2026-11-22T04:00:00Z');
  await settle();
  assert.deepEqual(unhandled, [], 'and nothing is left for the problem log as an unhandled failure');
});

test('with no signal at all nothing is thrown away, and the map carries on when signal returns', async () => {
  const { tile, describe } = await open();
  site.down = true;
  assert.match(await tile(0, 0, 0), /^FAILED: Failed to fetch$/);
  assert.match(await tile(1, 0, 0), /^FAILED: Failed to fetch$/);
  assert.deepEqual(site.requests, ['part', 'part'], 'the header in hand is not asked for again');
  assert.equal((await describe()).maxzoom, 1);
  // The site was published while there was no signal.
  publish(NOVEMBER, '"deploy-2"');
  site.down = false;
  assert.equal(await tile(0, 0, 0), 'november, the whole patch');
  await settle();
  assert.deepEqual(unhandled, []);
});

test('tiles asked for together share one read of the new header', async () => {
  const { tile } = await open();
  publish(NOVEMBER, '"deploy-2"');
  site.failHeaderReads = 1;
  const lost = await Promise.all([tile(0, 0, 0), tile(1, 0, 0), tile(0, 0, 0), tile(1, 0, 0)]);
  assert.ok(lost.every((t) => t.startsWith('FAILED: ')));
  assert.equal(site.requests.filter((r) => r.startsWith('header')).length, 1);
  site.requests = [];
  const back = await Promise.all([tile(0, 0, 0), tile(1, 0, 0), tile(0, 0, 0), tile(1, 0, 0)]);
  assert.deepEqual(back, ['november, the whole patch', 'november, north-west', 'november, the whole patch', 'november, north-west']);
  assert.equal(site.requests.filter((r) => r.startsWith('header')).length, 1);
  await settle();
  assert.deepEqual(unhandled, []);
});

test("a new month's file is never cut up with the old file's index", async () => {
  const { tile } = await open();
  assert.equal(await tile(1, 0, 0), 'november, north-west');
  // December's file is published: other tiles, at other places in the file.
  publish(DECEMBER, '"deploy-2"');
  site.failHeaderReads = 2;
  // While the new header cannot be read, tiles fail. They are not made from December's bytes at November's places.
  assert.match(await tile(1, 0, 0), /^FAILED: /);
  assert.match(await tile(0, 0, 0), /^FAILED: /);
  // Once it can be read, the tiles are December's own.
  assert.equal(await tile(1, 0, 0), 'december: the north-west quarter');
  assert.equal(await tile(0, 0, 0), 'december: whole patch');
  await settle();
  assert.deepEqual(unhandled, []);
});

test('a file that has become shorter is treated as a different file', async () => {
  const { tile } = await open();
  // No ETag changes here: the answer "416, past the end" is the only sign.
  publish(NOVEMBER.subarray(0, NOVEMBER.length - 30), site.etag);
  assert.match(await tile(1, 0, 0), /^FAILED: The street map archive changed$/);
  assert.ok(site.requests.includes('header (reload)'), 'the header was read again');
  publish(NOVEMBER, site.etag);
  assert.equal(await tile(1, 0, 0), 'november, north-west');
});
