// The rules that keep three scripts from doing harm (scripts/guards.mjs): the
// build must not empty the wrong folder, the development server must not hand
// out private files, and the Android signing set-up must not replace the only
// copy of a key's password. Each rule is a plain function, so the dangerous
// cases are tried here on made-up names: no folder is emptied, no server is
// started and no key is read. A few facts are read from the scripts' own text,
// because running those scripts here would do the very thing being guarded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILD_FOLDER, outputProblem, partsBelow, mayServe, requestedFile, isThrowawayKeyFile, signingProblem,
} from '../scripts/guards.mjs';

const WINDOWS = process.platform === 'win32';
const repoFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// A made-up app folder: C:\made-up\app on Windows, /made-up/app elsewhere.
const APP = resolve('/made-up/app');
const STATES = ['nothing', 'build', 'other']; // what an output folder can hold

// ---- inside or outside a folder

test('a path is inside a folder, or it is not', () => {
  assert.deepEqual(partsBelow(APP, APP), []);
  assert.deepEqual(partsBelow(APP, resolve(APP, 'www')), ['www']);
  assert.deepEqual(partsBelow(APP, resolve(APP, 'data', 'posts.json')), ['data', 'posts.json']);
  assert.deepEqual(partsBelow(APP, resolve(APP, '..cache')), ['..cache'], 'a name that only begins with two dots is inside');
  assert.equal(partsBelow(APP, resolve(APP, '..')), null);
  assert.equal(partsBelow(APP, resolve(APP, '..', 'app2')), null, 'a neighbour whose name begins the same way');
  assert.equal(partsBelow(APP, resolve(APP, '..', '..')), null);
  assert.equal(partsBelow(APP, resolve('/elsewhere/app')), null);
});

test('on Windows: another drive and a network share are outside, and capitals do not count', { skip: !WINDOWS && 'Windows paths' }, () => {
  assert.equal(partsBelow('C:\\made-up\\app', 'D:\\made-up\\app\\www'), null);
  assert.equal(partsBelow('C:\\made-up\\app', '\\\\server\\share\\app\\www'), null);
  assert.deepEqual(partsBelow('C:\\Made-Up\\App', 'c:\\made-up\\app\\WWW'), ['WWW']);
});

// ---- the build: scripts/build-web.mjs empties its output folder first

// The kind of list build-web.mjs gives: what the build reads from, and the rest of what the repository keeps.
const SOURCES = ['index.html', 'app.js', 'core', 'data', 'icons', 'vendor', 'tiles', 'scripts', 'node_modules', 'config.js', 'sw.js', 'package.json',
  'android', 'ios', 'native', 'docs', 'tests', '.git', '.github'];
/** Why `--out=<out>` is refused for a folder in the state `holds`; null when the build may go ahead. */
const refusal = (out, { target = 'pwa', holds = 'nothing' } = {}) =>
  outputProblem({ root: APP, out: resolve(APP, out), target, holds, sources: SOURCES });
const refused = (out, options, why) => assert.equal(typeof refusal(out, options), 'string', why || `--out=${out} ${JSON.stringify(options || {})}`);
const allowed = (out, options, why) => assert.equal(refusal(out, options), null, why || `--out=${out} ${JSON.stringify(options || {})}`);

test('the usual output folders may be emptied, even after a build that stopped part-way', () => {
  for (const holds of STATES) {
    allowed(BUILD_FOLDER.pwa, { target: 'pwa', holds });
    allowed(BUILD_FOLDER.native, { target: 'native', holds });
    allowed('.build-check', { target: 'pwa', holds });
    allowed('.build-check', { target: 'native', holds });
  }
});

test("the app's folder itself, and anything outside it, is never an output", () => {
  for (const holds of STATES) {
    for (const out of ['', '.', './', 'www/..', 'data/../']) assert.equal(refusal(out, { holds }), "it is the app's folder itself", `--out=${out}`);
    for (const out of ['..', '../', '../neighbour', '../app2', '../..', resolve('/elsewhere/www'), resolve('/')]) {
      assert.equal(refusal(out, { holds }), "it is outside the app's folder", `--out=${out}`);
    }
  }
});

test('on Windows: another drive is never an output', { skip: !WINDOWS && 'Windows paths' }, () => {
  for (const out of ['D:\\', 'D:\\www', '\\\\server\\share\\www']) {
    assert.equal(outputProblem({ root: 'C:\\made-up\\app', out, target: 'pwa', holds: 'nothing', sources: SOURCES }), "it is outside the app's folder", out);
  }
});

test("the app's own files and folders are never an output, whatever they hold", () => {
  for (const holds of STATES) {
    for (const name of SOURCES) refused(name, { holds });
    // Capitals do not make it another folder on Windows.
    for (const name of ['DATA', 'Vendor', 'CORE', 'Node_Modules', 'Index.HTML']) {
      assert.equal(refusal(name, { holds }), "the app's own files live there", name);
    }
  }
  assert.equal(refusal('tiles'), "the app's own files live there", 'even before the street map has been fetched');
});

test('an output is a folder directly inside the app, not somewhere deeper', () => {
  for (const out of ['vendor/new', 'www/sub', 'docs/site', 'somewhere/new', 'android/app/src/main/assets/public']) {
    for (const holds of STATES) {
      assert.equal(refusal(out, { holds }), "the output must be a folder directly inside the app's folder, not inside another folder", out);
    }
  }
});

test('any other folder is only emptied when it is new, empty or an earlier build', () => {
  allowed('preview-build', { holds: 'nothing' });
  allowed('preview-build', { holds: 'build' });
  allowed('preview-build', { holds: 'build', target: 'native' });
  // A folder nobody listed, with something in it that this script did not build.
  for (const out of ['preview-build', 'notes', 'old-site', '.cache', 'worker-new']) {
    assert.equal(refusal(out, { holds: 'other' }), 'it holds files that are not a build made by this script', out);
  }
  refused('WWW', { holds: 'other' }, 'only the build folders by their exact names are emptied whatever they hold');
});

test('a web build can never go where Capacitor copies the phone build from', () => {
  for (const holds of STATES) {
    for (const out of [BUILD_FOLDER.native, 'WWW-NATIVE', 'Www-Native', 'www-native.', 'www-native...']) refused(out, { target: 'pwa', holds });
  }
  allowed(BUILD_FOLDER.pwa, { target: 'native', holds: 'build' }, 'the other way round does no harm: nothing copies from www');
});

test('a name that could be a second name for another folder is refused', () => {
  // A Windows short name, a name with a colon, a dot or a space at the end:
  // each can open, or sit beside, a folder that has another name.
  for (const out of ['WWW-NA~1', 'DATA~1', 'www-native::$INDEX_ALLOCATION', 'www:x', 'www ', 'my build', 'www-native\u00a0',
    'www.', 'data.', 'CORE..', 'preview-build.', '...']) {
    for (const holds of STATES) {
      for (const target of ['pwa', 'native']) {
        assert.match(refusal(out, { target, holds }) || '', /^its name may only have/, `--out=${out}`);
      }
    }
  }
  allowed('preview.build', { holds: 'nothing' }, 'a dot inside a name is fine');
  allowed('preview_build-2', { holds: 'nothing' });
});

test('a name Windows keeps for its own devices is never an output', () => {
  // Node can make a folder called "nul", which Explorer, Command Prompt and
  // git then cannot open or delete in the usual way. The same names with an
  // ending are refused too: Windows can read nul.txt as the same device.
  for (const out of ['nul', 'NUL', 'Nul', 'con', 'aux', 'prn', 'COM1', 'com0', 'com9', 'lpt9', 'LPT1', 'nul.txt', 'NUL.tar.gz', 'con.build', 'aux.1']) {
    for (const holds of STATES) {
      for (const target of ['pwa', 'native']) {
        assert.equal(refusal(out, { target, holds }), 'that name belongs to Windows itself, so it cannot be a folder', `--out=${out}`);
      }
    }
  }
  // Names that only begin like one, or only end like one, are ordinary names.
  for (const out of ['console', 'null', 'com10', 'lpt', 'auxiliary', 'nul-build', 'nul_1', 'build.nul', 'old.con']) {
    allowed(out, { holds: 'nothing' });
    allowed(out, { holds: 'build', target: 'native' });
  }
});

test('the build checks its output folder before the one place it deletes anything', () => {
  // Read from the script, not run: running it would build.
  const source = repoFile('scripts/build-web.mjs');
  const deletes = [...source.matchAll(/\brm(?:Sync|dir|dirSync)?\(|\bunlink(?:Sync)?\(/g)];
  assert.equal(deletes.length, 1, 'build-web.mjs deletes in exactly one place');
  const asks = source.indexOf('outputProblem({');
  const stops = source.indexOf('if (refused) throw');
  assert.ok(asks > 0 && stops > asks && stops < deletes[0].index, 'it asks, and stops if refused, before it deletes');
});

test('the phone build has a folder of its own, and that is the one Capacitor copies', () => {
  assert.notEqual(BUILD_FOLDER.native, BUILD_FOLDER.pwa);
  assert.equal(JSON.parse(repoFile('capacitor.config.json')).webDir, BUILD_FOLDER.native);
  const ignored = repoFile('.gitignore').split(/\r?\n/).map((line) => line.trim());
  for (const folder of Object.values(BUILD_FOLDER)) assert.ok(ignored.includes(`${folder}/`), `${folder}/ is in .gitignore`);
  const { scripts } = JSON.parse(repoFile('package.json'));
  assert.match(scripts['build:native'], /build-web\.mjs --target=native( |$)/);
  assert.doesNotMatch(scripts['build:native'], /--out=/, 'the phone build goes to its own folder');
  assert.ok(scripts.preview.endsWith(`serve.mjs ${BUILD_FOLDER.pwa}`), 'the preview serves the web build');
  for (const name of ['cap:sync', 'cap:sync:android', 'cap:sync:ios']) {
    assert.match(scripts[name], /^npm run build:native && npx cap sync\b/, `${name} makes the phone build first`);
  }
});

// ---- the development server: scripts/serve.mjs

const SITE = resolve('/made-up/site');
const served = (address) => requestedFile(SITE, address);

test("the development server serves the app's files", () => {
  assert.equal(served('/'), SITE);
  assert.equal(served('/index.html'), resolve(SITE, 'index.html'));
  assert.equal(served('/core/posts.js'), resolve(SITE, 'core', 'posts.js'));
  assert.equal(served('/tiles/basemap.pmtiles'), resolve(SITE, 'tiles', 'basemap.pmtiles'));
  assert.equal(served('/docs/mobile-preview.html'), resolve(SITE, 'docs', 'mobile-preview.html'));
  assert.equal(served('/a%20b/c.txt'), resolve(SITE, 'a b', 'c.txt'));
  assert.equal(served('//data/./posts.json'), resolve(SITE, 'data', 'posts.json'));
  // Names that only look like the private ones.
  assert.equal(served('/android-notes.txt'), resolve(SITE, 'android-notes.txt'));
  assert.equal(served('/iosevka.woff2'), resolve(SITE, 'iosevka.woff2'));
  assert.equal(served('/native/marker-post-plugin/android/build.gradle'), resolve(SITE, 'native', 'marker-post-plugin', 'android', 'build.gradle'));
  assert.equal(served('/data/keystore.properties.md'), resolve(SITE, 'data', 'keystore.properties.md'));
});

test('it never serves hidden files, the phone projects or signing files', () => {
  for (const address of [
    '/.git/config', '/.git/', '/.gitignore', '/.env', '/.env.local', '/.github/workflows/pages.yml', '/worker-vms/.wrangler/state', '/docs/.hidden',
    '/android/keystore.properties', '/android/app/build.gradle', '/android', '/android/', '/ANDROID/local.properties', '/Android/app/',
    '/ios/App/Podfile', '/ios', '/IOS/App/App/Info.plist',
    '/keystore.properties', '/x/y/keystore.properties', '/KEYSTORE.PROPERTIES', '/keys/release.jks', '/debug.keystore',
    '/markerpost-android.p12', '/X.P12', '/AuthKey_ABC123DEFG.p8', '/Marker_Post.mobileprovision',
    '/%2egit/config', '/%61ndroid/keystore.properties',
  ]) assert.equal(served(address), null, address);
});

test('it never serves anything outside the folder', () => {
  for (const address of [
    '/../secret.txt', '/data/../../secret.txt', '/%2e%2e/secret.txt', '/..%2f..%2fsecret.txt', '/data/..%2f..%2f..%2fsecret.txt',
    '/a/..%5c..%5cb', '/..\\secret.txt', '/c%3a/Windows/win.ini', '/C:/Windows/win.ini',
    '/index.html::$DATA', '/index.html%00.png', '/%E0%A4%A',
  ]) assert.equal(served(address), null, address);
});

test('the same rule is put to where a file really is on disk', () => {
  // The server asks again with the real path, so a link or a short name cannot lead round the rule.
  assert.equal(mayServe(null), false, 'outside the folder');
  assert.equal(mayServe([]), true, 'the folder itself');
  assert.equal(mayServe(['data', 'posts.json']), true);
  assert.equal(mayServe(['android', 'app', 'build.gradle']), false);
  assert.equal(mayServe(['Android']), false);
  assert.equal(mayServe(['ios', 'App', 'Podfile']), false);
  assert.equal(mayServe(['.git', 'config']), false);
  assert.equal(mayServe(['docs', '.hidden', 'x.txt']), false);
  assert.equal(mayServe(['docs', 'keystore.properties']), false);
  assert.equal(mayServe(['native', 'marker-post-plugin', 'android', 'build.gradle']), true);
});

test('the development server listens on this computer only', () => {
  // Read from the script, not run: running it would open a port.
  const source = repoFile('scripts/serve.mjs');
  const calls = [...source.matchAll(/\.listen\(([^)]*)/g)].map((m) => m[1].split(',').map((arg) => arg.trim()));
  assert.ok(calls.length > 0, 'serve.mjs listens somewhere');
  for (const args of calls) assert.equal(args[1], 'host', 'every listen() says which address to listen on');
  const hosts = [...source.matchAll(/\blisten\('([^']*)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(hosts, ['127.0.0.1', '::1'], "only this computer's own two addresses");
});

// ---- the Android signing set-up: scripts/setup-android-signing.mjs

const OWN = { storeFile: 'C:/Users/someone/marker-post-keys/markerpost-android.p12', storePassword: 'made-up' };
const ONE_BUILD = { storeFile: 'C:/Users/someone/AppData/Local/Temp/markerpost-key-Ab12Cd/markerpost-android.p12', storePassword: 'also-made-up' };

test('a key made for one build is told from your own by where it is kept', () => {
  for (const file of [
    ONE_BUILD.storeFile, 'C:\\Users\\someone\\AppData\\Local\\Temp\\markerpost-key-Ab12Cd\\markerpost-android.p12',
    '/tmp/markerpost-key-a1B2c3/markerpost-android.p12', 'markerpost-key-000000/markerpost-android.p12',
  ]) assert.equal(isThrowawayKeyFile(file), true, file);
  for (const file of [
    OWN.storeFile, '/home/someone/marker-post-keys/markerpost-android.p12', '', undefined, null,
    '/tmp/markerpost-key-a1B2c3/other.p12', '/tmp/markerpost-key-a1B2c3/sub/markerpost-android.p12',
    '/tmp/markerpost-key-toolong1/markerpost-android.p12', '/tmp/my-markerpost-key-a1B2c3/markerpost-android.p12',
    '/tmp/markerpost-key-a1B2c3/markerpost-android.p12.bak',
  ]) assert.equal(isThrowawayKeyFile(file), false, String(file));
});

test('--throwaway never replaces the password file of your own key', () => {
  assert.equal(signingProblem({ throwaway: true, keyExists: false, saved: null }), null, 'a clean checkout, as on GitHub');
  assert.equal(signingProblem({ throwaway: true, keyExists: false, saved: ONE_BUILD }), null, 'a file left by an earlier one-build key');
  for (const keyExists of [false, true]) {
    assert.equal(signingProblem({ throwaway: true, keyExists, saved: OWN }), 'throwaway-over-own-password');
    // A file that does not say which key it is for is treated as yours.
    assert.equal(signingProblem({ throwaway: true, keyExists, saved: { storePassword: 'made-up' } }), 'throwaway-over-own-password');
    assert.equal(signingProblem({ throwaway: true, keyExists, saved: {} }), 'throwaway-over-own-password');
  }
});

test('a normal run only goes on when your key and its password file belong together', () => {
  const run = (keyExists, saved) => signingProblem({ throwaway: false, keyExists, saved });
  assert.equal(run(false, null), null, 'first run: a new key is made');
  assert.equal(run(false, ONE_BUILD), null, 'a leftover one-build file may be replaced');
  assert.equal(run(false, OWN), 'key-missing', 'the password of a key that is not there is not written over');
  assert.equal(run(false, { storePassword: 'made-up' }), 'key-missing');
  assert.equal(run(true, null), 'password-file-missing');
  assert.equal(run(true, ONE_BUILD), 'password-file-is-throwaway', 'what an old --throwaway run left behind');
  assert.equal(run(true, { storeFile: OWN.storeFile }), 'password-missing');
  assert.equal(run(true, { ...OWN, storePassword: '' }), 'password-missing');
  assert.equal(run(true, OWN), null, 'the script then proves that the password opens the key');
  assert.equal(run(true, { ...OWN, storeFile: 'D:/restored/marker-post-keys/markerpost-android.p12' }), null, 'a backup restored somewhere else');
});

test('the Android signing set-up writes the password file in one place only, after its checks', () => {
  // Read from the script, not run: it handles real keys.
  const source = repoFile('scripts/setup-android-signing.mjs');
  const writes = [...source.matchAll(/writeFileSync\(PROPERTIES\b/g)];
  assert.equal(writes.length, 1, 'one place writes android/keystore.properties');
  const checked = source.indexOf('signingProblem({');
  assert.ok(checked > 0 && checked < writes[0].index, 'the checks come first');
});

// ---- the browser driver: scripts/browser.mjs

test('a script that has started a browser still cleans up when it is interrupted', () => {
  // Ctrl+C and its relatives end Node without the 'exit' event the clean-up
  // hangs on, so exitOnSignals() turns them into a normal exit. Tried in a
  // child process each time, because a signal ends the process that gets it.
  // No browser is started: importing browser.mjs starts nothing.
  const browser = new URL('../scripts/browser.mjs', import.meta.url).href;
  const child = (body) => spawnSync(process.execPath,
    ['--input-type=module', '-e', `import { exitOnSignals } from ${JSON.stringify(browser)};\n${body}`], { encoding: 'utf8', timeout: 30000 });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const r = child(`
      process.once('exit', (code) => console.log('clean-up ran, code ' + code));
      exitOnSignals(); exitOnSignals();
      console.log('listeners ' + process.listenerCount('${signal}'));
      setTimeout(() => process.emit('${signal}'), 20);
      setTimeout(() => console.log('still running'), 10000);
    `);
    assert.equal(r.status, 130, `${signal}: ${r.stderr}`);
    assert.match(r.stdout, /listeners 1\n/, `${signal}: asked twice, listening once`);
    assert.match(r.stdout, /clean-up ran, code 130/, signal);
    assert.doesNotMatch(r.stdout, /still running/, signal);
  }
  // The emulator check imports browser.mjs only to attach to a page: that alone must not change what Ctrl+C does.
  const plain = child("console.log('listeners ' + process.listenerCount('SIGINT'));");
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /listeners 0\n/);
});

test('the browser driver arranges its clean-up before it waits for the browser to start', () => {
  // Read from the script, not run: running it would start a browser. An
  // interruption during the ten seconds it may wait must find the clean-up in place.
  const source = repoFile('scripts/browser.mjs');
  const started = source.indexOf('const child = spawn(exe');
  const arranged = source.indexOf("process.once('exit', stop);", started);
  const interrupts = source.indexOf('exitOnSignals();', arranged);
  const waits = source.indexOf('/json/version', started);
  assert.ok(started > 0 && arranged > started && interrupts > arranged && waits > interrupts);
  assert.equal(source.slice(started, arranged).includes('await '), false, 'nothing is waited for between starting the browser and arranging to stop it');
});

// ---- the iPhone signing set-up: scripts/setup-ios-signing.mjs

test('the iPhone signing set-up stops a real run, before any question, in a window that cannot hide what is pasted', () => {
  // Read from the script, not run: it talks to GitHub.
  const source = repoFile('scripts/setup-ios-signing.mjs');
  assert.ok(source.includes('const CAN_HIDE = Boolean(process.stdin.isTTY);'), 'it knows whether pasted text can be hidden');
  // Everything above the opening line only sets things up; the work starts below it.
  const begins = source.indexOf('console.log(`Marker Post: setting up');
  const stops = source.indexOf('if (!CAN_HIDE && !DRY)');
  const first = (text) => source.indexOf(text, begins);
  assert.ok(begins > 0 && stops > begins, 'the stop is there');
  for (const next of ['await ask(', 'await yes(', "run('gh'", 'change(']) {
    assert.ok(first(next) > stops, `the stop comes before the first ${next}`);
  }
  // The two secret questions say what this window will really do, not a fixed promise.
  assert.equal([...source.matchAll(/secret: true \}\)/g)].length, 2, 'two secret questions');
  assert.equal([...source.matchAll(/\(\$\{UNSEEN\}\): `, \{ secret: true \}\)/g)].length, 2, 'both word it from what the window can do');
});
