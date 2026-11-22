#!/usr/bin/env node
// Static checks: every script parses, every file the app imports exists, and
// both build targets package cleanly. Run by CI and by "npm run check". Needs
// "npm install" first: the phone build copies Capacitor's runtime from node_modules.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = ['app.js', 'platform.js', 'data.js', 'theme.js', 'dom.js', 'diagnostics.js', 'config.js', 'map.js', 'map-details.js', 'map-style.js', 'basemap.js', 'core/geo.js', 'core/posts.js', 'sw.js'];
const SCRIPTS = ['scripts/build-web.mjs', 'scripts/serve.mjs', 'scripts/fetch-basemap.mjs', 'scripts/fetch-network.mjs', 'scripts/fetch-vms.mjs', 'scripts/vendor.mjs', 'scripts/browser.mjs'];
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

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`OK  ${APP.length + SCRIPTS.length} files parse, imports resolve, both targets build`);
