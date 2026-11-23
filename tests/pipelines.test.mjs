// The release rules that live outside JavaScript: the TestFlight workflow and
// the fastlane lane it runs. Neither can be run here, so these tests read the
// files and hold them to the rules that matter:
//   * nothing with secrets runs for a pull request, and secrets are named in
//     the signing step only;
//   * the lookup tests run before anything is signed;
//   * a push to a working branch (which builds nothing) can never wait behind,
//     or take the place of, a real build;
//   * the iPhone version is the one in package.json, and a version tag that
//     disagrees stops the build before anything is signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
/** A workflow without its comments, so that a comment can never satisfy or break a rule. */
const workflowCode = async (name) => (await read(`.github/workflows/${name}`))
  .split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');

/** The steps of a workflow's job (the TestFlight workflow has one job): [{ name, text }], in order. */
function stepsOf(code) {
  const all = code.split('\n');
  const start = all.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  assert.ok(start >= 0, 'the job has steps');
  const steps = [];
  for (const line of all.slice(start + 1)) {
    const first = /^ {6}- (?:name|uses): (.*)$/.exec(line);
    if (first) steps.push({ name: first[1], text: '' });
    else assert.ok(!/^ {6}- /.test(line), `a step starts with its name or its action: ${line.trim()}`);
    if (steps.length) steps[steps.length - 1].text += `${line}\n`;
  }
  return steps;
}

test('the TestFlight workflow never runs for a pull request, and names its secrets in the signing step only', async () => {
  const code = await workflowCode('ios-testflight.yml');
  assert.doesNotMatch(code, /^\s*pull_request(_target)?:/m, 'no pull request trigger');
  const withSecrets = stepsOf(code).filter((step) => step.text.includes('secrets.')).map((step) => step.name);
  assert.deepEqual(withSecrets, ['Sign, build and upload']);
  assert.ok(!code.slice(0, code.indexOf('    steps:')).includes('secrets.'), 'no secret is set for the whole job');
});

test('the lookup tests run after the data is built and before anything is signed', async () => {
  const steps = stepsOf(await workflowCode('ios-testflight.yml'));
  const at = (name) => {
    const i = steps.findIndex((step) => step.name === name);
    assert.ok(i >= 0, `the step "${name}" exists`);
    return i;
  };
  const tests = at('Lookup tests (same answers as the web app)');
  assert.ok(at('Build the web app and the lookup data for the phone') < tests);
  assert.ok(tests < at('Sign, build and upload'));
  assert.match(steps[tests].text, /^\s+swift test$/m);
  assert.match(steps[tests].text, /working-directory: native\/marker-post-plugin/);
  // The switch that leaves the plugin out belongs to this step alone: set for
  // the whole job it would leave the plugin out of the app as well.
  assert.match(steps[tests].text, /MARKERPOST_CORE_ONLY: "1"/);
  assert.equal((await workflowCode('ios-testflight.yml')).split('MARKERPOST_CORE_ONLY').length - 1, 1);
});

test('a push to a working branch has a concurrency group of its own, and every real build shares one', async () => {
  const code = await workflowCode('ios-testflight.yml');
  const group = /^ {2}group: \$\{\{ (.*) \}\}$/m.exec(code);
  const condition = /^ {4}if: (.*)$/m.exec(code);
  assert.ok(group && condition, 'the group and the job condition are where they were');
  assert.match(code, /^ {2}cancel-in-progress: false$/m);
  // GitHub's == != && || give the same answers as JavaScript's for the plain text values used here.
  const format = (text, ...args) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)]));
  const value = (expression, github, vars) => new Function('github', 'vars', 'format', `return (${expression});`)(github, vars, format);
  const setUp = { MATCH_GIT_URL: 'https://example.invalid/signing.git' };
  const starts = [
    ['Run workflow', { event_name: 'workflow_dispatch', ref_type: 'branch' }, true],
    ['Run workflow on a tag', { event_name: 'workflow_dispatch', ref_type: 'tag' }, true],
    ['the monthly build', { event_name: 'schedule', ref_type: 'branch' }, true],
    ['a version tag', { event_name: 'push', ref_type: 'tag' }, true],
    ['a push to a working branch', { event_name: 'push', ref_type: 'branch' }, false],
  ];
  for (const [label, github, real] of starts) {
    assert.equal(Boolean(value(condition[1], github, setUp)), real, `${label}: builds`);
    assert.equal(Boolean(value(condition[1], github, { MATCH_GIT_URL: '' })), false, `${label}: nothing builds before the setup is done`);
    const first = value(group[1], { ...github, run_id: 7 }, setUp);
    const second = value(group[1], { ...github, run_id: 8 }, setUp);
    if (real) assert.deepEqual([first, second], ['ios-testflight', 'ios-testflight'], `${label}: real builds share one group`);
    else assert.ok(first !== 'ios-testflight' && second !== 'ios-testflight' && first !== second, `${label}: a group of its own every time`);
  }
});

test('the phone workflows start when the records behind the lookup change', async () => {
  for (const name of ['android.yml', 'ios.yml']) {
    const code = await workflowCode(name);
    for (const file of ['data/posts.json', 'data/posts-supplemental.json', 'data/junctions.json']) {
      assert.equal(code.split(`- '${file}'`).length - 1, 2, `${name}: ${file} is listed for pushes and for pull requests`);
    }
  }
});

test('the iPhone version is the one in package.json, and a tag that disagrees stops the build before anything is signed', async () => {
  const fastfile = await read('ios/App/fastlane/Fastfile');
  const lane = fastfile.slice(fastfile.indexOf('lane :beta do'));
  const at = (text) => {
    const i = lane.indexOf(text);
    assert.ok(i >= 0, `the lane has: ${text}`);
    return i;
  };
  assert.equal((lane.match(/^\s*version\s*=/gm) || []).length, 1, 'the version is set once');
  assert.ok(at('version = JSON.parse(File.read(File.join(repo_root, "package.json"))).fetch("version")') < at('setup_ci'));
  assert.ok(at('UI.user_error!("Tag ') < at('setup_ci'), 'the tag is checked before the keychain, the key and the certificate');
  assert.ok(at('setup_ci') < at('app_store_connect_api_key(') && at('app_store_connect_api_key(') < at('match(match_options'));
  at('xcargs: "MARKETING_VERSION=#{version} CURRENT_PROJECT_VERSION=#{build_number}"');

  // The rule itself. Ruby's \A is the start of the text, as ^ is here without the m flag.
  const rule = /ENV\["GITHUB_REF_TYPE"\] == "tag" && ENV\["GITHUB_REF_NAME"\]\.to_s =~ \/(.+?)\/ && Regexp\.last_match\(1\) != version/.exec(lane);
  assert.ok(rule, 'the tag rule is written as expected');
  const tag = new RegExp(rule[1].replace('\\A', '^'));
  const stops = (refType, refName, version) => {
    const m = tag.exec(String(refName ?? ''));
    return refType === 'tag' && Boolean(m) && m[1] !== version;
  };
  assert.equal(stops('tag', 'v2.0.1', '2.0.1'), false);
  assert.equal(stops('tag', 'v2.0.1', '2.0.0'), true, 'tagged without changing package.json');
  assert.equal(stops('tag', 'v2.0.10', '2.0.1'), true, 'not a match on the first characters only');
  assert.equal(stops('tag', 'v2.0.1', '2.0.10'), true);
  assert.equal(stops('tag', 'v2.1.0-rc.1', '2.1.0'), false, 'text after the three numbers is allowed');
  assert.equal(stops('branch', 'v2.0.1', '2.0.0'), false, 'a branch is never held to this');
  assert.equal(stops('branch', 'feature/native-app', '2.0.0'), false);
  assert.equal(stops(undefined, undefined, '2.0.0'), false, 'run by hand outside GitHub');

  // Apple accepts three numbers and nothing else, and the Xcode project must agree.
  const { version } = JSON.parse(await read('package.json'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const project = await read('ios/App/App.xcodeproj/project.pbxproj');
  const listed = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(listed.length > 0 && listed.every((v) => v === version), 'run node scripts/ios-project.mjs after changing the version');
});
