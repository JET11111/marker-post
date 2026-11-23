#!/usr/bin/env node
// Static checks: every script parses, every file the app imports exists, both
// build targets package cleanly, and Capacitor copies the phone build and
// nothing else. Run by CI and by "npm run check". Needs "npm install" first:
// the phone build copies Capacitor's runtime from node_modules.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_FOLDER } from './guards.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = ['app.js', 'platform.js', 'data.js', 'theme.js', 'dom.js', 'diagnostics.js', 'config.js', 'map.js', 'map-details.js', 'map-style.js', 'basemap.js', 'core/geo.js', 'core/posts.js', 'sw.js'];
// Every script, including the ones that can only be run on GitHub or by hand.
const SCRIPTS = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).sort().map((f) => `scripts/${f}`);
let failed = 0;
const fail = (message) => { failed++; console.error(`FAIL  ${message}`); };

for (const file of [...APP, ...SCRIPTS]) {
  if (!existsSync(join(ROOT, file))) { fail(`${file} is missing`); continue; }
  const r = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${file} does not parse\n${r.stderr}`);
}

// Every relative import in the app must point at a file that is shipped.
for (const file of APP) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  for (const m of source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = join(dirname(join(ROOT, file)), m[1]);
    if (!existsSync(target)) fail(`${file} imports ${m[1]}, which does not exist`);
    if (/\.mjs$/.test(m[1])) fail(`${file} imports ${m[1]}: browser modules must use .js (not every web view serves .mjs as JavaScript)`);
  }
}

for (const target of ['pwa', 'native']) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-web.mjs'), `--target=${target}`, '--out=.build-check'], { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) fail(`build for ${target} failed\n${r.stderr || r.stdout}`);
}
spawnSync(process.execPath, ['-e', "require('fs').rmSync('.build-check',{recursive:true,force:true})"], { cwd: ROOT });

// The phone apps are filled from Capacitor's webDir. It has to be the folder
// the phone build is written to: any other folder could hold a web build.
const { webDir } = JSON.parse(readFileSync(join(ROOT, 'capacitor.config.json'), 'utf8'));
if (webDir !== BUILD_FOLDER.native) fail(`capacitor.config.json: webDir is "${webDir}", but the phone build is written to "${BUILD_FOLDER.native}"`);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`OK  ${APP.length + SCRIPTS.length} files parse, imports resolve, both targets build, Capacitor copies ${BUILD_FOLDER.native}/`);
