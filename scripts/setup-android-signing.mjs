#!/usr/bin/env node
// One-off: make your own Android signing key and hand it to GitHub.
//
//   node scripts/setup-android-signing.mjs             do it (asks before anything leaves this computer)
//   node scripts/setup-android-signing.mjs --dry-run   show what would happen; nothing is kept, changed or sent
//   node scripts/setup-android-signing.mjs --throwaway a key for one build only (what the GitHub workflow
//                                                      uses when the repository has no key of its own).
//                                                      Not for a computer set up with your own key: where
//                                                      android/keystore.properties holds that key's
//                                                      password, it refuses.
//
// Why you want this. Android only installs an update over an app that was
// signed with the same key. Without a key of your own, every build from GitHub
// is signed with a throwaway one, and you have to uninstall the app before each
// new build. With one, new builds simply install over the old.
//
// What it does, in order:
//   1. makes a key (a password-protected .p12 file) in a folder OUTSIDE this
//      repository: <your home folder>/marker-post-keys/
//   2. writes android/keystore.properties, which git ignores, so builds on this
//      computer use the key too;
//   3. asks, then stores the key and its password as four encrypted GitHub
//      secrets on this repository (MP_KEYSTORE_BASE64, MP_KEYSTORE_PASSWORD,
//      MP_KEY_ALIAS, MP_KEY_PASSWORD). The "android" workflow reads them.
//
// The key never goes into the repository. Keep a copy of the folder somewhere
// safe (a password manager or a USB stick): if it is lost, the only cost is
// that you uninstall the app once and install a build signed with a new key.
//
// What it will not do: replace a key, or the only readable copy of a key's
// password. That copy is android/keystore.properties (GitHub's cannot be read
// back). If the key and that file do not belong together it stops, says what
// to put back, and changes nothing. Run again on a computer that is already
// set up, it checks that the saved password opens the key before using either.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isThrowawayKeyFile, signingProblem } from './guards.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry-run');
const THROWAWAY = process.argv.includes('--throwaway');
const ALIAS = 'markerpost';
const KEY_FILE = 'markerpost-android.p12';
/** Your own key: outside the repository. This script makes it once and never replaces it. */
const OWN_KEY = join(homedir(), 'marker-post-keys', KEY_FILE);
const PROPERTIES = join(ROOT, 'android', 'keystore.properties');

const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options });
const ok = (r) => !r.error && r.status === 0;
const fail = (message) => { console.error(`\n${message}`); process.exit(1); };

function findOpenssl() {
  const candidates = ['openssl'];
  // Git for Windows ships OpenSSL but does not put it on the PATH.
  const git = run(process.platform === 'win32' ? 'where' : 'which', ['git']);
  if (ok(git)) {
    const gitRoot = dirname(dirname(git.stdout.split(/\r?\n/)[0].trim()));
    candidates.push(join(gitRoot, 'mingw64', 'bin', 'openssl.exe'), join(gitRoot, 'usr', 'bin', 'openssl.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
  return candidates.find((c) => ok(run(c, ['version']))) || null;
}

function readProperties(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([^#=\s]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Does this password open this key file? It is passed through the environment, not the command line, so other programs cannot see it. */
const opens = (openssl, keystore, password, env = process.env) =>
  run(openssl, ['pkcs12', '-in', keystore, '-passin', 'env:MP_STORE_PASSWORD', '-noout'], { env: { ...env, MP_STORE_PASSWORD: password } });

console.log(DRY ? 'Dry run: this shows what would happen. Nothing is kept, changed or sent.\n' : '');

// ------------------------------------------------- 0. what is here already

// Decided before anything is made or written: see signingProblem in guards.mjs.
const saved = existsSync(PROPERTIES) ? readProperties(PROPERTIES) : null;
const reuse = !THROWAWAY && existsSync(OWN_KEY);
// The way on when the right password file cannot be put back. Nothing is ever deleted for you.
const NO_COPY = 'If you have no copy, that key cannot be used any more: move the key and that file out of the way,\n'
  + 'then run this again to make a new one.';
const stop = {
  'throwaway-over-own-password':
    'android/keystore.properties holds the password of your own signing key, and --throwaway would replace it.\n'
    + '--throwaway is only for a computer with no key of its own (the GitHub build). Nothing was changed.',
  'password-file-missing':
    `A key already exists at ${OWN_KEY}, but android/keystore.properties (which holds its password) does not.\n`
    + 'Restore that file from your backup, or move the old key out of the way to start again with a new one.',
  'password-file-is-throwaway':
    `android/keystore.properties was written for a one-build key, so it does not hold the password of your own key at ${OWN_KEY}.\n`
    + `Put back the copy of that file you backed up. Nothing was changed or sent.\n${NO_COPY}`,
  'password-missing':
    `android/keystore.properties has no storePassword line, so it cannot open your key at ${OWN_KEY}.\n`
    + `Put back the copy of that file you backed up. Nothing was changed.\n${NO_COPY}`,
  'key-missing':
    `android/keystore.properties holds the password of a signing key, but there is no key at ${OWN_KEY}.\n`
    + 'Restore the marker-post-keys folder from your backup. Or, to start again with a new key, first move that file somewhere safe.\n'
    + 'Nothing was changed.',
}[signingProblem({ throwaway: THROWAWAY, keyExists: reuse, saved })];
if (stop) fail(stop);

// A password is only ever written where git cannot pick it up.
const ignored = run('git', ['check-ignore', '-q', 'android/keystore.properties'], { cwd: ROOT });
if (ignored.error) fail('Git was not found, so it could not be checked that git ignores android/keystore.properties. Install Git and run this again.');
if (!ok(ignored)) fail('android/keystore.properties is not ignored by git. Refusing to write a password where it could be committed.');

// ---------------------------------------------------------------- 1. the key

let keystore, password;
// A key this run made, until its password is safely on disk. Without the
// password it is useless, and it would block the next run ("a key already
// exists"), so it is removed again if the run stops before then.
let unsaved = null;
process.once('exit', () => { if (unsaved) rmSync(unsaved, { recursive: true, force: true }); });

if (reuse) {
  // Never replace an existing key: apps already installed were signed with it.
  keystore = OWN_KEY;
  password = saved.storePassword;
  // Prove that the saved password opens this key before the file is rewritten
  // or anything is offered to GitHub: a pair that does not match would break
  // signing on this computer and on GitHub alike.
  const openssl = findOpenssl();
  if (!openssl) {
    fail('OpenSSL was not found, so the saved password could not be checked against your key.\n'
      + 'It comes with Git for Windows; install Git, or OpenSSL, and run this again.');
  }
  const check = opens(openssl, keystore, password);
  if (!ok(check)) {
    const said = String(check.stderr || check.error || '').trim().split(/\r?\n/)[0];
    fail(`The password in android/keystore.properties does not open your key at ${keystore}.\n`
      + `Put back the copy of that file you backed up. Nothing was changed or sent.\n${NO_COPY}${said ? `\n(OpenSSL said: ${said})` : ''}`);
  }
  console.log(`Using the key you already have: ${keystore}\nThe saved password opens it.`);
} else {
  const openssl = findOpenssl();
  if (!openssl) fail('OpenSSL was not found. It comes with Git for Windows; install Git, or OpenSSL, and run this again.');
  const temporary = DRY || THROWAWAY;
  const keyDir = temporary ? mkdtempSync(join(tmpdir(), 'markerpost-key-')) : dirname(OWN_KEY);
  mkdirSync(keyDir, { recursive: true });
  keystore = join(keyDir, KEY_FILE);
  unsaved = temporary ? keyDir : keystore;
  password = randomBytes(24).toString('base64url');
  const work = mkdtempSync(join(tmpdir(), 'markerpost-make-'));
  let problem = null;
  try {
    // A config of our own, so this does not depend on where OpenSSL was installed.
    const config = join(work, 'openssl.cnf');
    writeFileSync(config, '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = Marker Post\n');
    const env = { ...process.env, OPENSSL_CONF: config, MP_STORE_PASSWORD: password };
    const key = join(work, 'key.pem'), cert = join(work, 'cert.pem');
    // Valid for 30 years: an Android key is meant to outlive the app.
    const made = run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '10950', '-nodes',
      '-config', config, '-keyout', key, '-out', cert], { env });
    if (!ok(made)) throw new Error(`OpenSSL could not make the key:\n${made.stderr || made.error}`);
    // The password is passed through the environment, not the command line, so other programs cannot see it.
    const packed = run(openssl, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', ALIAS,
      '-out', keystore, '-passout', 'env:MP_STORE_PASSWORD'], { env });
    if (!ok(packed)) throw new Error(`OpenSSL could not write the key file:\n${packed.stderr || packed.error}`);
    const check = opens(openssl, keystore, password, env);
    if (!ok(check)) throw new Error(`The new key file could not be read back:\n${check.stderr || check.error}`);
  } catch (e) {
    problem = e.message;
  } finally {
    // key.pem in there is the private key with no password on it. It must not
    // outlive this block, which is why nothing above ends the script itself.
    rmSync(work, { recursive: true, force: true });
  }
  if (problem) fail(problem); // the half-made key goes too: see `unsaved`
  console.log(DRY
    ? `Would make ${THROWAWAY ? 'a signing key for this build only' : `a new signing key: ${OWN_KEY}`}.\n`
      + '(One was just made in a temporary folder, to prove that this computer can.)'
    : THROWAWAY ? 'Made a signing key for this build only.' : `Made a new signing key: ${keystore}`);
}

// ------------------------------------------------- 2. builds on this computer

// In a dry run the file would name the real place, not the temporary key.
const storeFile = (DRY && !reuse && !THROWAWAY ? OWN_KEY : keystore).replace(/\\/g, '/');
const properties = [
  '# Written by scripts/setup-android-signing.mjs. Git ignores this file: never commit it.',
  `storeFile=${storeFile}`,
  `storePassword=${password}`,
  `keyAlias=${ALIAS}`,
  `keyPassword=${password}`,
  '',
].join('\n');
const alreadyRight = Boolean(saved) && saved.storeFile === storeFile && saved.storePassword === password
  && saved.keyAlias === ALIAS && saved.keyPassword === password;
// The one place a password file is written. By now (step 0) the file there is
// either absent, or belongs to a throwaway key, or holds the very password
// just proved to open your key. Checked again here, so that no later change to
// this script can make it write over the only copy of a real key's password.
if (saved && !alreadyRight && !isThrowawayKeyFile(saved.storeFile) && saved.storePassword !== password) {
  fail('android/keystore.properties holds the password of another key, so it was not replaced.\n'
    + 'Move that file somewhere safe, then run this again. Nothing was changed.');
}
if (alreadyRight) {
  console.log('android/keystore.properties is already right for this key: left as it is.');
} else if (DRY) {
  console.log(`Would ${saved ? 'rewrite' : 'write'} android/keystore.properties (storeFile, storePassword, keyAlias, keyPassword).`);
} else {
  writeFileSync(PROPERTIES, properties);
  console.log('Wrote android/keystore.properties (git ignores it).');
}
if (!DRY) unsaved = null; // the key and its password are both on disk now

if (!DRY && !THROWAWAY && !reuse) {
  // Written before the question about GitHub is asked, and never rewritten:
  // so it says what GitHub holds only as "if you answered y", never as a fact.
  writeFileSync(join(dirname(OWN_KEY), 'README.txt'),
    'Marker Post: Android signing key.\r\n\r\n'
    + 'markerpost-android.p12 signs the Android app. Its password is in the repository folder,\r\n'
    + 'in android/keystore.properties (a file git ignores). If you answered y when the script\r\n'
    + 'asked, GitHub also holds an encrypted copy of both for its builds. That copy cannot be\r\n'
    + 'read back, so it is not a backup.\r\n\r\n'
    + 'Keep a copy of this folder and that file somewhere safe. Do not put either in a repository.\r\n'
    + 'If they are lost: uninstall the app from the phone once, then run\r\n'
    + 'scripts/setup-android-signing.mjs again to make a new key. (If only one of the\r\n'
    + 'two is lost, the script stops and says what to move out of the way first.)\r\n');
}

/** The end of a dry run: the temporary key, if one was made, is deleted. */
function finishDry() {
  const made = Boolean(unsaved);
  if (made) { rmSync(unsaved, { recursive: true, force: true }); unsaved = null; }
  console.log(`\nDry run finished. ${made ? 'The temporary key has been deleted. ' : ''}Nothing was changed.`);
  process.exit(0);
}

if (THROWAWAY) {
  if (DRY) finishDry();
  console.log('This build is signed with a key that exists for this build only: uninstall the app before installing a newer build.');
  process.exit(0);
}

// ----------------------------------------------------------- 3. GitHub secrets

const repoView = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: ROOT });
const repo = ok(repoView) ? repoView.stdout.trim() : null;
const secrets = {
  MP_KEYSTORE_BASE64: readFileSync(keystore).toString('base64'),
  MP_KEYSTORE_PASSWORD: password,
  MP_KEY_ALIAS: ALIAS,
  MP_KEY_PASSWORD: password,
};

if (DRY) {
  console.log(`Would ask, then store ${Object.keys(secrets).length} encrypted secrets on ${repo || 'this repository'}: ${Object.keys(secrets).join(', ')}.`);
  finishDry();
}

if (!repo) {
  console.log('\nThe GitHub command-line tool (gh) is not installed or not signed in, so the secrets were not stored.');
  console.log('Install it from https://cli.github.com, run "gh auth login", then run this script again.');
  process.exit(0);
}

const ask = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await ask.question(`\nStore the key and its password as encrypted secrets on ${repo}? Only GitHub's build machines can read them. [y/N] `)).trim().toLowerCase();
ask.close();
if (answer !== 'y' && answer !== 'yes') {
  console.log('Nothing was sent. Builds on this computer will use the key; builds on GitHub will not, until you run this again and answer y.');
  process.exit(0);
}
for (const [name, value] of Object.entries(secrets)) {
  // The value goes in on standard input, so it never appears in a command line.
  const set = run('gh', ['secret', 'set', name, '--repo', repo], { input: value });
  if (!ok(set)) fail(`Could not store ${name}:\n${set.stderr || set.error}`);
  console.log(`  stored ${name}`);
}

console.log(`
Done. From the next run, the "android" workflow signs both APKs with your key.

Now back up two things somewhere safe (not in a repository):
  ${dirname(keystore)}
  ${PROPERTIES}
`);
