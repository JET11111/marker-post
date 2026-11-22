#!/usr/bin/env node
// One-off: give GitHub what it needs to sign the iPhone app and upload it to
// TestFlight. Run it after steps 1 to 5 of docs/ios-testflight.md.
//
//   node scripts/setup-ios-signing.mjs             do it
//   node scripts/setup-ios-signing.mjs --dry-run   ask the same questions, but only print what would be done
//
// It asks for six things you copy from Apple's website, one access token you
// create on GitHub, and then:
//   1. creates a PRIVATE repository to hold the signing certificate (encrypted);
//   2. creates a "testflight" environment on this repository, with you as the
//      person who must approve each upload;
//   3. stores the values as encrypted secrets in that environment;
//   4. records the address of the private repository as a repository variable,
//      which is what switches the ios-testflight workflow on.
//
// Nothing is written to this computer and nothing secret is printed. The
// values go straight to GitHub over the GitHub command-line tool (gh).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry-run');
const ENVIRONMENT = 'testflight';

const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...options });
const ok = (r) => !r.error && r.status === 0;
const fail = (message) => { console.error(`\n${message}`); process.exit(1); };

/** A command that changes something on GitHub: printed instead of run when --dry-run. */
function change(description, args, input) {
  if (DRY) { console.log(`  would: ${description}`); return; }
  const r = run('gh', args, input == null ? {} : { input });
  if (!ok(r)) fail(`Could not ${description}:\n${(r.stderr || String(r.error || '')).trim()}`);
  console.log(`  done: ${description}`);
}

// One line-reader for the whole script. `hidden` stops typed or pasted
// characters being shown, for the two values that are secrets in themselves.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let hidden = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => { if (!hidden || /[\r\n]/.test(text)) write(text); };
const lines = [];
const waiting = [];
rl.on('line', (line) => { const next = waiting.shift(); if (next) next(line); else lines.push(line); });
rl.on('close', () => { for (const next of waiting.splice(0)) next(null); });
function ask(question, { secret = false, fallback = '' } = {}) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    hidden = secret;
    const done = (line) => {
      hidden = false;
      if (secret) process.stdout.write('\n');
      if (line == null) fail('Input ended before the questions did.');
      resolve(line.trim() || fallback);
    };
    if (lines.length) done(lines.shift()); else waiting.push(done);
  });
}
const yes = async (question, byDefault = false) => {
  const answer = await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `);
  return answer ? /^y(es)?$/i.test(answer) : byDefault;
};

console.log(`Marker Post: setting up TestFlight uploads${DRY ? ' (dry run: nothing will be changed)' : ''}\n`);

// ------------------------------------------------------------ where are we

const who = run('gh', ['api', 'user', '--jq', '[.login, (.id|tostring)] | join(" ")']);
if (!ok(who)) fail('The GitHub command-line tool (gh) is not installed or not signed in.\nInstall it from https://cli.github.com, run "gh auth login", then run this again.');
const [login, userId] = who.stdout.trim().split(' ');
const repoView = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
if (!ok(repoView)) fail('Could not work out which GitHub repository this folder belongs to.');
const repo = repoView.stdout.trim();
const owner = repo.split('/')[0];
console.log(`Signed in to GitHub as ${login}. App repository: ${repo}\n`);

// ---------------------------------------------------------- Apple's values

console.log('From App Store Connect > Users and Access > Integrations > App Store Connect API (docs/ios-testflight.md, step 5):');
const keyId = await ask('  Key ID (10 characters, shown beside the key): ');
if (!/^[A-Z0-9]{10}$/.test(keyId)) fail('A Key ID is 10 capital letters and digits, for example 2X9R4HXF34.');
const issuerId = await ask('  Issuer ID (shown above the list of keys): ');
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issuerId)) fail('An Issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a.');
const keyPath = (await ask('  Path to the key file you downloaded (AuthKey_….p8). Tip: drag the file into this window: ')).replace(/^["']|["']$/g, '');
if (!existsSync(keyPath)) fail(`No file at ${keyPath}`);
const keyText = readFileSync(keyPath, 'utf8');
if (!keyText.includes('BEGIN PRIVATE KEY')) fail('That file is not an App Store Connect API key (.p8).');

console.log('\nFrom developer.apple.com > Account > Membership details:');
const teamId = await ask('  Team ID (10 characters): ');
if (!/^[A-Z0-9]{10}$/.test(teamId)) fail('A Team ID is 10 capital letters and digits.');
const teamName = await ask('  Team name, exactly as shown there (for a personal membership this is your own name).\n  It is only used so that GitHub can blank it out of the public build logs: ');
if (!teamName) fail('The team name is needed so it can be hidden in the logs.');

// ------------------------------------------- the private certificates repo

const signingRepo = `${owner}/${repo.split('/')[1]}-signing`;
const signingUrl = `https://github.com/${signingRepo}.git`;
console.log(`\nThe signing certificate is kept, encrypted, in a private repository: ${signingRepo}`);
const visibility = run('gh', ['repo', 'view', signingRepo, '--json', 'visibility', '--jq', '.visibility']);
if (ok(visibility)) {
  if (visibility.stdout.trim() !== 'PRIVATE') fail(`${signingRepo} exists but is not private. Make it private (or delete it) and run this again.`);
  console.log('  it already exists and is private.');
} else if (await yes(`  It does not exist yet. Create it now, as a private repository?`)) {
  change(`create the private repository ${signingRepo}`, ['repo', 'create', signingRepo, '--private', '--add-readme',
    '--description', 'Encrypted iOS signing files for Marker Post (written by fastlane match). Keep private.']);
} else {
  fail('Stopped: the certificate needs somewhere private to live.');
}

console.log(`
The build machine needs a token that can read and write that one repository and nothing else.
Create it in your browser:
  1. Open https://github.com/settings/personal-access-tokens/new?name=Marker+Post+signing&expires_in=365&contents=write
     The name, a one-year expiry and the Contents permission are filled in for you.
     (If GitHub says the name is already in use, add the year to it. GitHub emails you before the token runs out.)
  2. Repository access: "Only select repositories", and pick ${signingRepo}.
  3. Check that Permissions > Repository permissions > Contents says "Read and write". Leave everything else alone.
  4. Press "Generate token" and copy it (it starts with github_pat_).`);
const token = await ask('  Paste the token here (it will not be shown): ', { secret: true });
if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) fail('That does not look like a GitHub token.');

// ------------------------------------------------------ the match password

// The certificate in the signing repository can only be read with the password
// it was stored with. So a password is made once, and never replaced: running
// this script again (for a new key or token) must leave it alone.
const exists = (apiPath) => ok(run('gh', ['api', apiPath, '--silent']));
const passwordStored = exists(`repos/${repo}/environments/${ENVIRONMENT}/secrets/MATCH_PASSWORD`);
const certificateStored = exists(`repos/${signingRepo}/contents/certs?ref=main`);
let matchPassword = null; // null: leave the stored secret as it is
if (passwordStored) {
  console.log('\nThe certificate password is already stored on GitHub. It is kept: the certificate can only be read with it.');
} else if (certificateStored) {
  matchPassword = await ask('\nThe signing repository already holds a certificate, but its password is not on GitHub.\n  Paste the password you saved as "Marker Post match password" (it will not be shown): ', { secret: true });
  if (!matchPassword) fail('Without that password the stored certificate cannot be read.');
} else {
  matchPassword = randomBytes(24).toString('base64url');
}
const newPassword = !passwordStored && !certificateStored;

// ------------------------------------------------------------------ GitHub

console.log(`\nSetting up ${repo}:`);
const reviewer = await yes(`  Require your approval (${login}) before each upload? Recommended: nothing is signed or sent until you press Approve.`, true);
change(`create the "${ENVIRONMENT}" environment${reviewer ? ' with you as required reviewer' : ''}`,
  ['api', '--method', 'PUT', `repos/${repo}/environments/${ENVIRONMENT}`, '--input', '-'],
  JSON.stringify(reviewer ? { reviewers: [{ type: 'User', id: Number(userId) }] } : {}));

const secrets = {
  ASC_KEY_ID: keyId,
  ASC_ISSUER_ID: issuerId,
  ASC_KEY_P8_BASE64: Buffer.from(keyText, 'utf8').toString('base64'),
  ...(matchPassword ? { MATCH_PASSWORD: matchPassword } : {}),
  MATCH_GIT_TOKEN: token,
  APPLE_TEAM_ID: teamId,
  APPLE_TEAM_NAME: teamName,
};
for (const [name, value] of Object.entries(secrets)) {
  // The value goes in on standard input, so it never appears in a command line.
  change(`store the secret ${name}`, ['secret', 'set', name, '--env', ENVIRONMENT, '--repo', repo], value);
}
change('record where the certificates live (variable MATCH_GIT_URL)', ['variable', 'set', 'MATCH_GIT_URL', '--repo', repo, '--body', signingUrl]);
rl.close();

const branch = run('git', ['branch', '--show-current']).stdout.trim() || 'master';
console.log(`\n${DRY ? 'Dry run finished: nothing was changed.' : 'All set.'}`);
if (newPassword) {
  console.log(`
One more thing to keep. The certificate will be encrypted with this password, which now exists
only in the GitHub secret MATCH_PASSWORD and on the next line. Save it in your password
manager as "Marker Post match password". You need it again only if the secret is ever lost.

  ${DRY ? '(a new random password would be shown here)' : matchPassword}`);
}
console.log(`
Next (docs/ios-testflight.md, step 8): make the certificate and upload the first build.
  gh workflow run ios-testflight.yml --ref ${branch} -f bootstrap_signing=true
${reviewer
    ? `Then open the Actions page of ${repo}, open the run, and press "Review deployments" > "Approve and deploy".`
    : 'Uploads will start without asking you, because you chose not to require approval.'}
`);
