#!/usr/bin/env node
// Refresh the third-party files kept in vendor/. The app has no bundler, so
// the browser loads these files as they are; they are committed (as Leaflet
// was) so the site can be deployed without installing anything.
//
//   npm install            (devDependencies pin the exact versions)
//   node scripts/vendor.mjs
//
// It copies MapLibre GL JS, PMTiles and the Protomaps style package out of
// node_modules, downloads the map fonts and icon sheets the style needs, and
// writes vendor/README.md with versions, sources, licences and SHA-256 sums.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor');
const mod = (...p) => join(ROOT, 'node_modules', ...p);
const version = async (name) => JSON.parse(await readFile(mod(name, 'package.json'), 'utf8')).version;

const records = []; // { path, source, sha256, bytes }
async function put(rel, data, source) {
  const to = join(VENDOR, rel);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, data);
  records.push({ path: rel, source, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const copy = async (rel, from, source) => put(rel, await readFile(from), source);
async function download(rel, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  await put(rel, Buffer.from(await res.arrayBuffer()), url);
}

// Start clean so files dropped upstream do not linger. vendor/capacitor is
// produced by the native build, not kept here.
for (const dir of ['maplibre-gl', 'pmtiles', 'protomaps-basemaps', 'basemaps-assets', 'leaflet']) {
  await rm(join(VENDOR, dir), { recursive: true, force: true });
}

// --- MapLibre GL JS. Published as .mjs; stored as .js because not every
// --- embedded web view serves .mjs with a JavaScript content type.
const ml = await version('maplibre-gl');
await copy('maplibre-gl/maplibre-gl.js', mod('maplibre-gl', 'dist', 'maplibre-gl.mjs'), `maplibre-gl@${ml} dist/maplibre-gl.mjs`);
await copy('maplibre-gl/maplibre-gl-worker.js', mod('maplibre-gl', 'dist', 'maplibre-gl-worker.mjs'), `maplibre-gl@${ml} dist/maplibre-gl-worker.mjs`);
await copy('maplibre-gl/maplibre-gl.css', mod('maplibre-gl', 'dist', 'maplibre-gl.css'), `maplibre-gl@${ml} dist/maplibre-gl.css`);
await copy('maplibre-gl/LICENSE.txt', mod('maplibre-gl', 'LICENSE.txt'), `maplibre-gl@${ml} LICENSE.txt`);

// --- PMTiles reader (script build: defines the global "pmtiles").
const pm = await version('pmtiles');
await copy('pmtiles/pmtiles.js', mod('pmtiles', 'dist', 'pmtiles.js'), `pmtiles@${pm} dist/pmtiles.js`);
await copy('pmtiles/LICENSE', mod('pmtiles', 'LICENSE'), `pmtiles@${pm} LICENSE`).catch(async () => {
  await put('pmtiles/LICENSE', Buffer.from('PMTiles is published under the BSD 3-Clause licence: https://github.com/protomaps/PMTiles/blob/main/LICENSE\n'), 'note');
});

// --- Protomaps basemap style generator (ES module, no dependencies).
const bm = await version('@protomaps/basemaps');
await copy('protomaps-basemaps/basemaps.js', mod('@protomaps', 'basemaps', 'dist', 'esm', 'index.js'), `@protomaps/basemaps@${bm} dist/esm/index.js`);
await copy('protomaps-basemaps/LICENSE', mod('@protomaps', 'basemaps', 'LICENSE'), `@protomaps/basemaps@${bm} LICENSE`).catch(async () => {
  await put('protomaps-basemaps/LICENSE', Buffer.from('@protomaps/basemaps is published under the BSD 3-Clause licence: https://github.com/protomaps/basemaps/blob/main/LICENSE.md\n'), 'note');
});

// --- Map fonts (glyph ranges) and icon sheets from protomaps/basemaps-assets.
// Only the ranges UK labels use are kept: Latin, Latin Extended and general
// punctuation. If a label ever needs another range MapLibre draws it with a
// device font instead, so nothing breaks. Folder names avoid spaces so they
// are safe inside an Android or iOS app bundle; map-style.js maps the style's
// font names to them.
const ASSETS = 'https://protomaps.github.io/basemaps-assets';
const FONTS = { 'Noto Sans Regular': 'NotoSans-Regular', 'Noto Sans Medium': 'NotoSans-Medium', 'Noto Sans Italic': 'NotoSans-Italic' };
const RANGES = ['0-255', '256-511', '7680-7935', '8192-8447'];
for (const [name, folder] of Object.entries(FONTS)) {
  for (const range of RANGES) {
    await download(`basemaps-assets/fonts/${folder}/${range}.pbf`, `${ASSETS}/fonts/${encodeURIComponent(name)}/${range}.pbf`);
  }
}
for (const flavor of ['light', 'dark']) {
  for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
    await download(`basemaps-assets/sprites/v4/${flavor}${suffix}`, `${ASSETS}/sprites/v4/${flavor}${suffix}`);
  }
}
await put('basemaps-assets/LICENSE.md', Buffer.from(
  '# Map fonts and icons\n\n' +
  'From https://github.com/protomaps/basemaps-assets\n\n' +
  '- Fonts: Noto Sans (Regular, Medium, Italic), SIL Open Font License 1.1, https://openfontlicense.org\n' +
  '- Icon sheets: Protomaps basemap sprites v4, derived from MIT-licensed icon sets; see the repository for details.\n'), 'note');

const total = records.reduce((a, r) => a + r.bytes, 0);
const table = records.map((r) => `| \`${r.path}\` | ${r.bytes.toLocaleString('en-GB')} | \`${r.sha256}\` | ${r.source} |`).join('\n');
await writeFile(join(VENDOR, 'README.md'), `# Third-party files

Everything here is produced by \`node scripts/vendor.mjs\` from the versions
pinned in \`package.json\`. Do not edit these files by hand: change the pinned
version, run the script and commit the result.

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) | ${ml} | BSD-3-Clause | The map |
| [PMTiles](https://github.com/protomaps/PMTiles) | ${pm} | BSD-3-Clause | Reading the base-map archive |
| [Protomaps basemaps](https://github.com/protomaps/basemaps) | ${bm} | BSD-3-Clause | Base-map style (light and dark) |
| [Protomaps basemap assets](https://github.com/protomaps/basemaps-assets) | sprites v4 | OFL-1.1 (fonts), MIT-derived (icons) | Map label fonts and icons |

The MapLibre files are published upstream as \`.mjs\`; they are stored as
\`.js\` so that every embedded web view serves them as JavaScript. Their
contents are unchanged, as the checksums below show.

The base-map tiles themselves are not kept here or anywhere in the
repository. \`scripts/fetch-basemap.mjs\` cuts them from a Protomaps build of
OpenStreetMap data (© OpenStreetMap contributors, ODbL).

## Files (${records.length}, ${(total / 1048576).toFixed(2)} MB)

| File | Bytes | SHA-256 | Source |
| --- | ---: | --- | --- |
${table}
`);
console.log(`vendor/: ${records.length} files, ${(total / 1048576).toFixed(2)} MB (MapLibre ${ml}, PMTiles ${pm}, basemaps ${bm})`);
