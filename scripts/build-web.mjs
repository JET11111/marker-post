#!/usr/bin/env node
// Package the web app into www/ for one target. No bundling and no
// dependencies: it copies an explicit list of files, writes a config.js for
// the target, and (for the PWA) stamps the service worker with the list of
// files to keep for offline use.
//
//   node scripts/build-web.mjs --target=pwa      GitHub Pages / installed web app
//   node scripts/build-web.mjs --target=native   web assets for the iOS and Android shells
//
// Only files named here are ever published. Nothing else in the repository
// (workers, scripts, tests, local caches) can leak into a build.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const target = arg('target', 'pwa');
if (!['pwa', 'native'].includes(target)) throw new Error(`Unknown target "${target}" (use pwa or native)`);
const OUT = join(ROOT, arg('out', 'www'));

/** App shell: every file the app loads, by name. */
const SHELL = [
  'index.html', 'styles.css', 'map.css',
  'app.js', 'platform.js', 'data.js', 'theme.js', 'dom.js',
  'map.js', 'map-details.js', 'map-style.js', 'basemap.js',
  'core/geo.js', 'core/posts.js',
];
const DATA = ['posts.json', 'junctions.json', 'eras.json', 'posts-supplemental.json', 'network.json', 'vms.json'];
/** Whole folders of static assets (third-party code with licences, map fonts and icons, app icons). */
const ASSET_DIRS = ['icons', 'vendor'];
/** Web-app only: install manifest, service worker, and the standalone NTIS viewer that already lives on the site. */
const PWA_ONLY = ['manifest.json', 'ntis.html', 'ntis.js', 'ntis.css'];
/** The offline base map is generated (scripts/fetch-basemap.mjs), never committed. */
const BASEMAP = 'tiles/basemap.pmtiles';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
const posix = (p) => p.split(sep).join('/');
async function copy(rel) {
  const from = join(ROOT, rel), to = join(OUT, rel);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const missing = [...SHELL, ...DATA.map((f) => `data/${f}`), ...(target === 'pwa' ? PWA_ONLY : [])]
  .filter((rel) => !existsSync(join(ROOT, rel)));
if (missing.length) throw new Error(`Missing source files: ${missing.join(', ')}`);

for (const rel of SHELL) await copy(rel);
for (const f of DATA) await copy(`data/${f}`);
for (const dir of ASSET_DIRS) {
  if (!existsSync(join(ROOT, dir))) continue;
  for (const file of await walk(join(ROOT, dir))) {
    const rel = posix(relative(ROOT, file));
    if (rel.startsWith('vendor/capacitor/')) continue; // added below, for native only
    await copy(rel);
  }
}
if (target === 'pwa') for (const rel of PWA_ONLY) await copy(rel);

let basemapNote = 'not present: the map will show the road network without a street background';
if (existsSync(join(ROOT, BASEMAP))) {
  await copy(BASEMAP);
  basemapNote = `${((await stat(join(ROOT, BASEMAP))).size / 1048576).toFixed(1)} MB`;
}

if (target === 'native') {
  // The Capacitor runtime, so plugins are reachable without a bundler.
  const runtime = join(ROOT, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
  if (!existsSync(runtime)) throw new Error('Run "npm install" first: @capacitor/core is not installed.');
  await mkdir(join(OUT, 'vendor', 'capacitor'), { recursive: true });
  await cp(runtime, join(OUT, 'vendor', 'capacitor', 'capacitor.js'));
  const indexPath = join(OUT, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const hook = '<script type="module" src="app.js"></script>';
  if (!html.includes(hook)) throw new Error('index.html: module script tag not found');
  await writeFile(indexPath, html.replace(hook, `<script src="vendor/capacitor/capacitor.js"></script>\n  ${hook}`));
}

// A build id that changes only when the app's code or assets change. Data
// files are deliberately left out: the scheduled jobs republish them many
// times a day, and that must not force every phone to re-download the app.
const produced = (await walk(OUT)).map((f) => posix(relative(OUT, f))).sort();
const isData = (rel) => rel.startsWith('data/') || rel === BASEMAP;
const hash = createHash('sha256');
for (const rel of produced.filter((r) => !isData(r))) {
  hash.update(rel);
  hash.update(await readFile(join(OUT, rel)));
}
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const build = hash.digest('hex').slice(0, 8);

// config.js for this target.
const flag = (name, fallback) => (process.env[name] == null ? fallback : /^(1|true|yes|on)$/i.test(process.env[name]));
const baseConfig = (await import(new URL('../config.js', import.meta.url))).default;
const config = {
  ...baseConfig,
  target,
  version: pkg.version,
  build,
  features: {
    ...baseConfig.features,
    // Vehicle lookup depends on a personal relay and API terms: it stays out of
    // the native apps unless explicitly switched on (MP_VEHICLE=1).
    vehicle: flag('MP_VEHICLE', target === 'pwa'),
  },
};
await writeFile(join(OUT, 'config.js'),
  `// Generated by scripts/build-web.mjs for target "${target}". Edit config.js in the repository root instead.\n` +
  `export default ${JSON.stringify(config, null, 2)};\n`);

if (target === 'pwa') {
  // Service worker: stamp the version and the files to keep for offline use.
  // The base map archive is large and optional, so it is never precached; the
  // app offers it as an explicit download instead.
  const source = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const block = /\/\*__BUILD__\*\/[\s\S]*?\/\*__END_BUILD__\*\//;
  if (!block.test(source)) throw new Error('sw.js: build marker not found');
  const assets = ['.', ...produced.filter((r) => r !== BASEMAP && !r.startsWith('ntis.')), 'config.js']
    .filter((v, i, a) => a.indexOf(v) === i);
  await writeFile(join(OUT, 'sw.js'), source.replace(block,
    `/*__BUILD__*/ ${JSON.stringify({ version: `${pkg.version}-${build}`, assets })} /*__END_BUILD__*/`));
}

const total = (await Promise.all((await walk(OUT)).map(async (f) => (await stat(f)).size))).reduce((a, b) => a + b, 0);
console.log(`Built ${target} -> ${relative(ROOT, OUT) || '.'}  (${(await walk(OUT)).length} files, ${(total / 1048576).toFixed(1)} MB, build ${build})`);
console.log(`  vehicle lookup: ${config.features.vehicle ? 'on' : 'off'}   base map archive: ${basemapNote}`);
