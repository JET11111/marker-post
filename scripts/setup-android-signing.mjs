#!/usr/bin/env node
// One-off: make your own Android signing key and hand it to GitHub.
//
//   node scripts/setup-android-signing.mjs             do it (asks before anything leaves this computer)
//   node scripts/setup-android-signing.mjs --dry-run   show what would happen; nothing is kept or sent
//   node scripts/setup-android-signing.mjs --throwaway a key for one build only (what the GitHub workflow
//                                                      uses when the repository has no key of its own)
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

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry-run');
const THROWAWAY = process.argv.includes('--throwaway');
const ALIAS = 'markerpost';
const KEY_DIR = DRY || THROWAWAY ? mkdtempSync(join(tmpdir(), 'markerpost-key-')) : join(homedir(), 'marker-post-keys');
const KEYSTORE = join(KEY_DIR, 'markerpost-android.p12');
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

console.log(DRY ? 'Dry run: a key is made in a temporary folder and deleted again; nothing is sent.\n' : '');

// ---------------------------------------------------------------- 1. the key

let password;
if (existsSync(KEYSTORE)) {
  // Never replace an existing key: apps already installed were signed with it.
  if (!existsSync(PROPERTIES)) {
    fail(`A key already exists at ${KEYSTORE}, but android/keystore.properties (which holds its password) does not.\n`
      + 'Restore that file from your backup, or move the old key out of the way to start again with a new one.');
  }
  password = readProperties(PROPERTIES).storePassword;
  if (!password) fail('android/keystore.properties has no storePassword line.');
  console.log(`Using the key you already have: ${KEYSTORE}`);
} else {
  const openssl = findOpenssl();
  if (!openssl) fail('OpenSSL was not found. It comes with Git for Windows; install Git, or OpenSSL, and run this again.');
  mkdirSync(KEY_DIR, { recursive: true });
  password = randomBytes(24).toString('base64url');
  const work = mkdtempSync(join(tmpdir(), 'markerpost-make-'));
  try {
    // A config of our own, so this does not depend on where OpenSSL was installed.
    const config = join(work, 'openssl.cnf');
    writeFileSync(config, '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = Marker Post\n');
    const env = { ...process.env, OPENSSL_CONF: config, MP_STORE_PASSWORD: password };
    const key = join(work, 'key.pem'), cert = join(work, 'cert.pem');
    // Valid for 30 years: an Android key is meant to outlive the app.
    const made = run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '10950', '-nodes',
      '-config', config, '-keyout', key, '-out', cert], { env });
    if (!ok(made)) fail(`OpenSSL could not make the key:\n${made.stderr || made.error}`);
    // The password is passed through the environment, not the command line, so other programs cannot see it.
    const packed = run(openssl, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', ALIAS,
      '-out', KEYSTORE, '-passout', 'env:MP_STORE_PASSWORD'], { env });
    if (!ok(packed)) fail(`OpenSSL could not write the key file:\n${packed.stderr || packed.error}`);
    const check = run(openssl, ['pkcs12', '-in', KEYSTORE, '-passin', 'env:MP_STORE_PASSWORD', '-noout'], { env });
    if (!ok(check)) fail(`The new key file could not be read back:\n${check.stderr || check.error}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!DRY && !THROWAWAY) writeFileSync(join(KEY_DIR, 'README.txt'),
    'Marker Post: Android signing key.\r\n\r\n'
    + 'markerpost-android.p12 signs the Android app. Its password is in the repository folder,\r\n'
    + 'in android/keystore.properties (a file git ignores), and in the GitHub secrets.\r\n\r\n'
    + 'Keep a copy of this folder and that file somewhere safe. Do not put either in a repository.\r\n'
    + 'If they are lost: uninstall the app from the phone once, then run\r\n'
    + 'scripts/setup-android-signing.mjs again to make a new key.\r\n');
  console.log(THROWAWAY ? 'Made a signing key for this build only.' : `Made a new signing key: ${KEYSTORE}`);
}

// ------------------------------------------------- 2. builds on this computer

const properties = [
  '# Written by scripts/setup-android-signing.mjs. Git ignores this file: never commit it.',
  `storeFile=${KEYSTORE.replace(/\\/g, '/')}`,
  `storePassword=${password}`,
  `keyAlias=${ALIAS}`,
  `keyPassword=${password}`,
  '',
].join('\n');
if (DRY) {
  console.log('Would write android/keystore.properties (storeFile, storePassword, keyAlias, keyPassword).');
} else {
  const ignored = run('git', ['check-ignore', '-q', 'android/keystore.properties'], { cwd: ROOT });
  if (!ok(ignored)) fail('android/keystore.properties is not ignored by git. Refusing to write a password where it could be committed.');
  writeFileSync(PROPERTIES, properties);
  console.log('Wrote android/keystore.properties (git ignores it).');
}

if (THROWAWAY) {
  console.log('This build is signed with a key that exists for this build only: uninstall the app before installing a newer build.');
  process.exit(0);
}

// ----------------------------------------------------------- 3. GitHub secrets

const repoView = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: ROOT });
const repo = ok(repoView) ? repoView.stdout.trim() : null;
const secrets = {
  MP_KEYSTORE_BASE64: readFileSync(KEYSTORE).toString('base64'),
  MP_KEYSTORE_PASSWORD: password,
  MP_KEY_ALIAS: ALIAS,
  MP_KEY_PASSWORD: password,
};

if (DRY) {
  console.log(`Would store ${Object.keys(secrets).length} encrypted secrets on ${repo || 'this repository'}: ${Object.keys(secrets).join(', ')}.`);
  rmSync(KEY_DIR, { recursive: true, force: true });
  console.log('\nDry run finished. The temporary key has been deleted.');
  process.exit(0);
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
  ${KEY_DIR}
  ${PROPERTIES}
`);
