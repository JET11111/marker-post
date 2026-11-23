// The rules the screens share (the last part of core/posts.js): what counts
// as a current position and a good one, when a carriageway counts as
// confirmed, the words of the first page's cautions, how a typed post is read,
// which post a sign card names, and what the Signs screen may say about how
// fresh its messages are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  computeTravelBearings, findNearest, headingUsable, buildRef, staleAfterMs, positionStale, NEAR_POST_M, fmtDist, fmtClock,
  fixState, fixAlert, shortAge, POOR_ACCURACY_M, QUIET_AFTER_MS, confirmCarriageway, CONFIRM_GAP_MS, CONFIRM_REACH_M,
  postCaution, parseQuickEntry, signLetter, postForSign, signPostNote, measuredFrom,
  NO_SIGNS, signsAfterLoad, signsFreshness, SIGNS_LIVE_MS, SIGNS_OLD_MS,
} from '../core/posts.js';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8'));

/** The app's combined post list, built the way app.js builds it. */
async function loadPosts() {
  const posts = await json('posts.json');
  const supplemental = await json('posts-supplemental.json');
  return [...posts, ...supplemental.posts];
}

// ---------------------------------------------------------------- position

test('a position stops being current by the one rule, and sooner once the app has been away', () => {
  const at = 1795000000000;
  // Moving, unknown speed, standing still: current up to the limit, last known after it.
  for (const speed of [31, null, 0]) {
    const limit = staleAfterMs(speed);
    assert.equal(positionStale(at, speed, at), false);
    assert.equal(positionStale(at, speed, at + limit), false, 'exactly at the limit is still current');
    assert.equal(positionStale(at, speed, at + limit + 1), true);
  }
  // Back from the background the vehicle may have driven off: its last speed
  // no longer earns the longer limits, until a new fix arrives.
  assert.equal(positionStale(at, 0, at + 90000), false, 'standing still, 90 s is current while the app is watching');
  assert.equal(positionStale(at, 0, at + 90000, true), true, 'but not for a position from before the app was away');
  assert.equal(positionStale(at, null, at + 20000, true), true);
  assert.equal(positionStale(at, 0, at + 15000, true), false, 'a fix read a few seconds ago is still current');
  assert.equal(positionStale(at, 31, at + 15001, true), true, 'never longer than the ordinary limit');
  assert.equal(positionStale(at, 31, at + 10000, true), false);
});

test('what a fix may claim: its age in words after half a minute, and no trust in a vague one', () => {
  const at = 1795000000000;
  const good = { speed: 0, accuracy: 5 };
  assert.deepEqual(fixState(good, at, at + 1000), { ageMs: 1000, stale: false, quiet: false, accuracy: 5, poor: false });
  // Standing still the position stays current for two minutes, but its age is put in words from half a minute.
  assert.equal(fixState(good, at, at + QUIET_AFTER_MS - 1).quiet, false);
  assert.deepEqual(fixState(good, at, at + QUIET_AFTER_MS), { ageMs: QUIET_AFTER_MS, stale: false, quiet: true, accuracy: 5, poor: false });
  assert.equal(fixState(good, at, at + 120001).stale, true);
  // Moving: last known after 15 s, by the one rule. Back from the background that applies whatever the speed was.
  assert.equal(fixState({ speed: 31, accuracy: 5 }, at, at + 15001).stale, true);
  assert.equal(fixState(good, at, at + 20000).stale, false);
  assert.equal(fixState(good, at, at + 20000, true).stale, true);
  // Beyond about half the gap between posts the reading is poor.
  assert.equal(fixState({ speed: 31, accuracy: POOR_ACCURACY_M }, at, at).poor, false);
  assert.equal(fixState({ speed: 31, accuracy: POOR_ACCURACY_M + 1 }, at, at).poor, true);
  assert.equal(fixState({ speed: null, accuracy: 2500 }, at, at).poor, true, 'an iPhone with Precise Location off');
  // No figure is not a good figure: nought, less than nought, or nothing at all.
  for (const accuracy of [0, -1, null, undefined, NaN]) {
    const state = fixState({ speed: 31, accuracy }, at, at);
    assert.equal(state.accuracy, null, String(accuracy));
    assert.equal(state.poor, false, String(accuracy));
  }
  // A made-up position has a made-up accuracy. It is labelled as simulated instead.
  assert.equal(fixState({ speed: 31, accuracy: 500, simulated: true }, at, at).poor, false);
});

test('a last known post keeps the caution its fix earned', () => {
  const at = 1795000000000;
  const alertAfter = (fix, ms, unseen = false) => fixAlert(fixState(fix, at, at + ms, unseen));
  const good = { speed: 31, accuracy: 5 }, rough = { speed: 31, accuracy: 300 };
  // A good, current fix: nothing to warn of.
  assert.equal(alertAfter(good, 1000), '');
  // A rough one says so while it is current...
  assert.equal(alertAfter(rough, 1000), 'GPS accuracy ±300 m · the post may be wrong');
  // ...and goes on saying so as the last known position. Getting older did not make it a sound reading.
  assert.equal(alertAfter(rough, 16000), 'No GPS update for 15 s · last known post · GPS was ±300 m');
  assert.equal(alertAfter(rough, 200000), 'No GPS update for 3 min · last known post · GPS was ±300 m');
  // A good fix that has gone out of date has no such caution to keep.
  assert.equal(alertAfter(good, 16000), 'No GPS update for 15 s · last known post');
  // Standing still: current for two minutes, and the same after that.
  assert.equal(alertAfter({ speed: 0, accuracy: 80.4 }, 90000), 'GPS accuracy ±80 m · the post may be wrong');
  assert.equal(alertAfter({ speed: 0, accuracy: 80.4 }, 121000), 'No GPS update for 2 min · last known post · GPS was ±80 m');
  // An iPhone with Precise Location off, read before the app was put away.
  assert.equal(alertAfter({ speed: null, accuracy: 2500 }, 20000, true), 'No GPS update for 20 s · last known post · GPS was ±2500 m');
  // No accuracy figure, or a made-up position: there is no figure to quote.
  assert.equal(alertAfter({ speed: 31, accuracy: null }, 16000), 'No GPS update for 15 s · last known post');
  assert.equal(alertAfter({ speed: 31, accuracy: 500, simulated: true }, 16000), 'No GPS update for 15 s · last known post');
  assert.equal(alertAfter({ speed: 31, accuracy: 500, simulated: true }, 1000), '');

  // Ages are in round figures, and never "0 s".
  assert.deepEqual([0, 4.9, 15.001, 19.9, 59.9].map(shortAge), ['5 s', '5 s', '15 s', '15 s', '55 s']);
  assert.deepEqual([60, 119, 3599].map(shortAge), ['1 min', '1 min', '59 min']);
  assert.deepEqual([3600, 5400].map(shortAge), ['1.0 h', '1.5 h']);
});

test('the carriageway is confirmed by the direction of travel, and stays so only while that still holds', async () => {
  const posts = await loadPosts();
  const a = posts.find((p) => p.road === 'M27' && p.ref === 'P20/9A');
  const b = posts.find((p) => p.road === 'M27' && p.ref === 'P20/9B');
  const t0 = 1795000000000;
  const reading = (post, at, extra = {}) => ({ post, dist: 10, headingUsed: false, lat: a.lat, lng: a.lng, at, ...extra });

  // Nothing remembered and standing still: by position only.
  let r = confirmCarriageway(null, reading(a, t0));
  assert.deepEqual([r.confirmed, r.far], [false, false]);
  // The heading chooses the carriageway.
  r = confirmCarriageway(r.memory, reading(a, t0 + 1000, { headingUsed: true }));
  assert.equal(r.confirmed, true);
  // Stopped a second later at the same post: still confirmed. You cannot change carriageway without driving.
  r = confirmCarriageway(r.memory, reading(a, t0 + 2000));
  assert.equal(r.confirmed, true);
  // It stays so however long the vehicle stands there, while the fixes keep coming.
  let memory = r.memory;
  for (let t = t0 + 3000; t <= t0 + 600000; t += 1000) memory = confirmCarriageway(memory, reading(a, t)).memory;
  const next = t0 + 601000;
  assert.equal(confirmCarriageway(memory, reading(a, next)).confirmed, true);
  // Asking twice about the same fix changes nothing (the page is drawn again when its tab is reopened).
  assert.deepEqual(confirmCarriageway(confirmCarriageway(memory, reading(a, next)).memory, reading(a, next)),
    confirmCarriageway(memory, reading(a, next)));
  // The position alone picks the other carriageway's post: not confirmed.
  assert.equal(confirmCarriageway(memory, reading(b, next)).confirmed, false);
  // The vehicle has crept on, further than CONFIRM_REACH_M from where the heading last chose: not confirmed.
  const metres = (m) => ({ lat: a.lat + m / 111195, lng: a.lng });
  assert.equal(confirmCarriageway(memory, reading(a, next, metres(CONFIRM_REACH_M - 20))).confirmed, true);
  assert.equal(confirmCarriageway(memory, reading(a, next, metres(CONFIRM_REACH_M + 20))).confirmed, false);

  // A gap in the fixes (the phone was put away). The vehicle may have gone
  // round to the other carriageway meanwhile, so what was confirmed is forgotten...
  assert.equal(confirmCarriageway(memory, reading(a, memory.at + CONFIRM_GAP_MS)).confirmed, true, 'exactly the limit is not yet a gap');
  r = confirmCarriageway(memory, reading(a, memory.at + CONFIRM_GAP_MS + 1));
  assert.equal(r.confirmed, false);
  // ...and does not come back by itself,
  assert.equal(confirmCarriageway(r.memory, reading(a, r.memory.at + 1000)).confirmed, false);
  // only when the heading chooses again.
  assert.equal(confirmCarriageway(r.memory, reading(a, r.memory.at + 1000, { headingUsed: true })).confirmed, true);
  // A fix the system kept from before the gap cannot carry the old carriageway across it:
  // it confirms for its own moment, and the first fresh fix is a gap after it.
  const kept = confirmCarriageway(memory, reading(a, memory.at, { headingUsed: true }));
  assert.equal(confirmCarriageway(kept.memory, reading(a, memory.at + 300000)).confirmed, false);
  assert.equal(CONFIRM_GAP_MS, staleAfterMs(31), 'the same limit as a moving position');
});

test('away from the network the nearest post is far off and never confirmed, even when the heading picked it', async () => {
  const posts = await loadPosts();
  computeTravelBearings(posts);
  const t0 = 1795000000000;
  // Central Winchester, driving north-east at 10 m/s: nowhere near a carriageway.
  const town = { lat: 51.0632, lng: -1.3160 };
  const found = findNearest(posts, town.lat, town.lng, 45, 10, true);
  assert.equal(found.headingUsed, true, 'the heading filter still "chooses" a post');
  assert.ok(found.dist > NEAR_POST_M, `${Math.round(found.dist)} m away`);
  let r = confirmCarriageway(null, { ...found, ...town, at: t0 });
  assert.deepEqual([r.confirmed, r.far], [false, true]);
  // Nor is it remembered: stopping there does not confirm it either.
  r = confirmCarriageway(r.memory, { ...found, headingUsed: false, ...town, at: t0 + 1000 });
  assert.deepEqual([r.confirmed, r.far], [false, true]);

  // On the carriageway the post is always well inside the limit.
  const a = posts.find((p) => p.road === 'M27' && p.ref === 'P20/9A');
  const on = findNearest(posts, a.lat + 0.0004, a.lng, a.bearing, 30, true);
  assert.ok(on.dist < NEAR_POST_M);
  const here = { lat: a.lat + 0.0004, lng: a.lng };
  r = confirmCarriageway(null, { ...on, ...here, at: t0 });
  assert.deepEqual([r.confirmed, r.far], [true, false]);
  // The limit itself is still near; a metre more is far, with or without the heading.
  assert.equal(confirmCarriageway(null, { ...on, ...here, dist: NEAR_POST_M, at: t0 }).confirmed, true);
  assert.deepEqual(confirmCarriageway(null, { ...on, ...here, dist: NEAR_POST_M + 1, at: t0 }).far, true);
  // A short stretch with no recorded post nearby does not wipe out what was confirmed just before it.
  const gap = confirmCarriageway(r.memory, { ...on, ...here, dist: NEAR_POST_M + 50, at: t0 + 1000 });
  assert.equal(gap.confirmed, false);
  assert.equal(confirmCarriageway(gap.memory, { ...on, headingUsed: false, ...here, at: t0 + 2000 }).confirmed, true);
});

test('the caution under the list calls a post the nearest, by position only, just when the direction of travel played no part', async () => {
  const posts = await loadPosts();
  computeTravelBearings(posts);
  /** What the first page works out from one fix, with the caution it shows. */
  const read = (lat, lng, heading, speed, useHeading = true) => {
    const found = findNearest(posts, lat, lng, heading, speed, useHeading);
    const { confirmed, far } = confirmCarriageway(null, { ...found, lat, lng, at: 1795000000000 });
    const byTravel = headingUsable(heading, speed, useHeading);
    return { ...found, far, text: postCaution({ ...found, confirmed, far, byTravel }) };
  };
  const BY_POSITION = 'Nearest post by position only. Check the carriageway.';

  // The A31 here has recorded posts on carriageway A only. Beside P24/3A and
  // travelling the other way, the posts of A are passed over and the nearest
  // one left is 3 km off. It is not "the nearest recorded post", and position
  // alone did not choose it.
  const a31 = posts.find((p) => p.road === 'A31' && p.ref === 'P24/3A');
  const against = (a31.bearing + 180) % 360;
  let r = read(a31.lat, a31.lng, against, 25);
  assert.equal(r.post.ref, 'P21/2B');
  assert.equal(r.text, 'Nearest recorded post for your direction of travel is 3.07 km away. Check the carriageway.');
  // Stopped at the same place, or with the preference switched off: the post alongside, by position.
  r = read(a31.lat, a31.lng, against, 0);
  assert.deepEqual([r.post.ref, r.dist, r.text], ['P24/3A', 0, BY_POSITION]);
  r = read(a31.lat, a31.lng, against, 25, false);
  assert.deepEqual([r.post.ref, r.dist, r.text], ['P24/3A', 0, BY_POSITION]);

  // Away from the network altogether (central Winchester): by position only when stopped or crawling, and never when moving.
  const town = { lat: 51.0632, lng: -1.3160 };
  r = read(town.lat, town.lng, 45, 10);
  assert.equal(r.text, `Nearest recorded post for your direction of travel is ${fmtDist(r.dist)} away. Check the carriageway.`);
  for (const speed of [0, 2, null]) {
    r = read(town.lat, town.lng, 45, speed);
    assert.equal(r.text, `Nearest recorded post is ${fmtDist(r.dist)} away, by position only. Check the carriageway.`, String(speed));
    assert.ok(r.dist > NEAR_POST_M);
  }

  // At an interchange the direction of travel can leave a post that has no
  // direction of its own to compare. It is not confirmed, but nor was it
  // chosen by position only: the nearer post of the other carriageway was passed over.
  const m27 = posts.find((p) => p.road === 'M27' && p.ref === 'P46/0B');
  r = read(m27.lat, m27.lng, (m27.bearing + 180) % 360, 30);
  assert.deepEqual([r.post.road, r.post.ref, r.headingUsed, r.far], ['M275', 'P46/0L', false, false]);
  assert.ok(r.dist > 0, 'the post alongside, at 0 m, was passed over');
  assert.equal(r.text, 'Not confirmed by your direction of travel. Check the carriageway.');
  assert.equal(read(m27.lat, m27.lng, null, 0).text, BY_POSITION);

  // Confirmed by the direction of travel: nothing to say.
  const plain = posts.find((p) => p.road === 'M27' && p.ref === 'P20/9A');
  assert.equal(read(plain.lat, plain.lng, plain.bearing, 30).text, '');
  // A reference with no carriageway letter gives nothing to check; far away it is still said to be far.
  const odd = { post: { ref: 'MP 12' }, dist: 40, confirmed: false, byTravel: false };
  assert.equal(postCaution({ ...odd, far: false }), '');
  assert.equal(postCaution({ ...odd, dist: 400, far: true }), 'Nearest recorded post is 400 m away, by position only. Check the carriageway.');

  // The whole of the A31 and A34, where long stretches have posts on one
  // carriageway only: at every post, travelling against it. Whatever is
  // shown, "by position only" is never said of a post the direction chose,
  // and when it is said the post is the nearest of all.
  let farBeside = 0;
  for (const p of posts) {
    if ((p.road !== 'A31' && p.road !== 'A34') || p.bearing == null) continue;
    const moving = read(p.lat, p.lng, (p.bearing + 180) % 360, 25);
    assert.doesNotMatch(moving.text, /by position only|^Nearest recorded post is /, `${p.road} ${p.ref}`);
    if (moving.far) {
      farBeside++;
      assert.match(moving.text, /^Nearest recorded post for your direction of travel is [\d.]+ k?m away\. /, `${p.road} ${p.ref}`);
    }
    const stopped = read(p.lat, p.lng, null, 0);
    assert.deepEqual([stopped.dist, stopped.text], [0, BY_POSITION], `${p.road} ${p.ref}`);
  }
  assert.ok(farBeside > 0, 'no stretch with posts on one carriageway only was found');
});

test('a small clock label gives the date when the time was not today', () => {
  const now = new Date(2026, 10, 22, 11, 50).getTime();
  assert.equal(fmtClock(new Date(2026, 10, 22, 9, 5).getTime(), now), '09:05');
  assert.equal(fmtClock(new Date(2026, 10, 22, 0, 0).getTime(), now), '00:00');
  assert.equal(fmtClock(new Date(2026, 10, 14, 9, 52).getTime(), now), '14 Nov, 09:52', 'a message set last week must not read as today');
  assert.equal(fmtClock(new Date(2026, 10, 21, 23, 59).getTime(), now), '21 Nov, 23:59');
  assert.equal(fmtClock(new Date(2025, 11, 31, 23, 59).getTime(), now), '31 Dec 2025, 23:59');
  assert.equal(fmtClock(NaN, now), '');
  assert.equal(fmtClock(Date.parse('not a date'), now), '');
});

// ------------------------------------------------------------- quick entry

test('quick entry reads a post typed with or without its P and its carriageway letter', () => {
  const read = (text) => parseQuickEntry(text);
  // The short form the first page shows. Read as a plain number it would lose
  // the tenths and find P13/0A, 600 m away, as an exact match.
  assert.deepEqual(read('M27 13/6A'), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('M27 13/6 A'), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('M27 20/9A'), { road: 'M27', dist: 20.9, dir: 'A' });
  assert.deepEqual(read('13/6A'), { road: null, dist: 13.6, dir: 'A' });
  assert.deepEqual(read('20/9 A M27'), { road: 'M27', dist: 20.9, dir: 'A' });
  assert.deepEqual(read('M271 2/3L'), { road: 'M271', dist: 2.3, dir: 'L' });
  assert.deepEqual(read('A3(M) 3/6B'), { road: 'A3M', dist: 3.6, dir: 'B' });
  assert.deepEqual(read('A3M 3/6B'), { road: 'A3M', dist: 3.6, dir: 'B' });
  assert.deepEqual(read('  m27 13/6a '), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('M27 13 / 6 A'), { road: 'M27', dist: 13.6, dir: 'A' }, 'spaces round the slash lose nothing');
  // No letter typed: none is made up (the M of M27 used to be taken for one).
  assert.deepEqual(read('M27 P13/6'), { road: 'M27', dist: 13.6, dir: null });
  assert.deepEqual(read('P13/6 M27'), { road: 'M27', dist: 13.6, dir: null });
  // The forms that already worked.
  assert.deepEqual(read('M27 13.6 A'), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('M27 13.6A'), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('P13/6A M27'), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('M3 P117/6B'), { road: 'M3', dist: 117.6, dir: 'B' });
  assert.deepEqual(read('M27 A 13.6'), { road: 'M27', dist: 13.6, dir: 'A' });
  assert.deepEqual(read('M27 13'), { road: 'M27', dist: 13, dir: null });
  assert.deepEqual(read(''), { road: null, dist: null, dir: null });
  assert.deepEqual(read(undefined), { road: null, dist: null, dir: null });
});

test('every recorded post is read back exactly, however it is typed', async () => {
  const posts = await json('posts.json');
  for (const p of posts) {
    const short = p.ref.replace(/^P/, ''); // "20/9A", as the first page shows it
    for (const typed of [`${p.road} ${short}`, `${short} ${p.road}`, `${p.road} ${p.ref}`, `${p.road} ${p.distance} ${p.direction}`]) {
      const got = parseQuickEntry(typed);
      assert.equal(got.road, p.road, typed);
      assert.equal(got.dir, p.direction, typed);
      assert.equal(buildRef(got.dist, got.dir), p.ref, typed);
    }
  }
});

// -------------------------------------------------------------- sign cards

// Signs as the feed gives them (identifier, the feed's road and compass word,
// position), taken from the snapshot of 22 November 2026.
const SIGN = {
  a3m: { id: 'A3M/5036B', road: 'A3M', dir: 'NB', lat: 50.874309, lng: -1.014148 },
  m3: { id: 'M3/1555B', road: 'M3', dir: 'EB', lat: 51.302684, lng: -0.794727 },
  m27: { id: 'M27/9232B', road: 'M27', dir: 'WB', lat: 50.93164, lng: -1.321933 },
  m27b: { id: 'M27/9251B', road: 'M27', dir: 'WB', lat: 50.915992, lng: -1.318417 },
  link: { id: 'M3/2176K', road: 'M27', dir: 'EB', lat: 50.958967, lng: -1.395674 },
  plain: { id: 'M27/9203A', road: 'M27', dir: 'EB', lat: 50.940443, lng: -1.359469 },
  lonely: { id: 'M3/1501A', road: 'M3', dir: 'WB', lat: 51.328796, lng: -0.730851 },
};

test("a sign's carriageway is the letter in its own identifier", () => {
  assert.equal(signLetter('M27/9232B'), 'B');
  assert.equal(signLetter('A3M/5011A'), 'A');
  assert.equal(signLetter('M3/2176K'), 'K');
  assert.equal(signLetter(' M27/9203A '), 'A');
  assert.equal(signLetter('M27/9203'), null);
  assert.equal(signLetter('?'), null);
  assert.equal(signLetter('M27'), null, 'the road is not a carriageway');
  assert.equal(signLetter(undefined), null);
});

test("a sign card names a post on the sign's own road and carriageway", async () => {
  const posts = await loadPosts();
  const note = (sign) => signPostNote(sign, postForSign(sign, posts));
  // These five were given the other carriageway's post when it was chosen by position alone.
  assert.equal(note(SIGN.a3m), 'near P3/6B');
  assert.equal(note(SIGN.m3), 'near P55/5B');
  assert.equal(note(SIGN.m27), 'near P23/2B');
  assert.equal(note(SIGN.m27b), 'near P25/1B');
  // A slip-road sign sits at an interchange post, which is named with its road and its caveat.
  assert.equal(note(SIGN.link), 'near P117/5K (Chilworth · M3 / M27, survey date unknown)');
  assert.equal(note(SIGN.plain), 'near P20/3A');
  // No post within reach: nothing is named.
  assert.equal(postForSign(SIGN.lonely, posts), null);
  assert.equal(note(SIGN.lonely), '');
  assert.equal(postForSign({ id: 'M27/1A', road: 'M27', lat: null, lng: null }, posts), null);
  assert.equal(postForSign(null, posts), null);
});

test('a post that is not on the sign\'s own road and carriageway is said to be by position', async () => {
  const posts = await loadPosts();
  const at = { lat: SIGN.m27.lat, lng: SIGN.m27.lng };
  // No post with this letter is near: the nearest of any letter, labelled.
  const otherLetter = { id: 'M27/9232K', road: 'M27', ...at };
  assert.equal(postForSign(otherLetter, posts).matched, false);
  assert.match(signPostNote(otherLetter, postForSign(otherLetter, posts)), /^nearest post by position: P23\/2[AB]$/);
  // No letter in the identifier at all.
  const noLetter = { id: '?', road: 'M27', ...at };
  assert.match(signPostNote(noLetter, postForSign(noLetter, posts)), /^nearest post by position: P23\/2[AB]$/);
  // A road with no posts of ours: the post's own road is given.
  const otherRoad = { id: 'A99/1234B', road: 'A99', ...at };
  assert.match(signPostNote(otherRoad, postForSign(otherRoad, posts)), /^nearest post by position: P23\/2[AB] \(M27\)$/);
  assert.equal(signPostNote(SIGN.m27, null), '');
});

test('no card in the current snapshot names another carriageway, or uses a compass word', async () => {
  const posts = await loadPosts(), vms = await json('vms.json');
  let named = 0;
  for (const sign of vms.signs || []) {
    const found = postForSign(sign, posts);
    const note = signPostNote(sign, found);
    assert.doesNotMatch(note, /\b(NB|SB|EB|WB|north|south|east|west)/i, sign.id);
    if (!found) { assert.equal(note, ''); continue; }
    named++;
    assert.ok(found.dist <= NEAR_POST_M, sign.id);
    if (found.matched) {
      assert.equal(found.post.direction, signLetter(sign.id), `${sign.id} is given ${found.post.ref}`);
      assert.match(note, /^near P/, sign.id);
    } else {
      assert.match(note, /^nearest post by position: /, sign.id);
    }
  }
  if ((vms.signs || []).length > 50) assert.ok(named > 0, 'no sign was matched to a post at all');
});

test('a sign distance says what it was measured from', () => {
  const now = new Date(2026, 10, 22, 14, 6).getTime();
  const fixAt = new Date(2026, 10, 22, 14, 5, 52).getTime();
  assert.equal(measuredFrom({ fixAt }, now), 'from you');
  // A last known position is not "you": it says so, with its time.
  assert.equal(measuredFrom({ stale: true, fixAt }, now), 'from your last known position (14:05)');
  assert.equal(measuredFrom({ stale: true, fixAt: new Date(2026, 10, 21, 23, 59).getTime() }, now),
    'from your last known position (21 Nov, 23:59)');
  // Nor is a position made up for desk testing.
  assert.equal(measuredFrom({ simulated: true, fixAt }, now), 'from the simulated position');
  assert.equal(measuredFrom({ simulated: true, stale: true, fixAt }, now), 'from the simulated position');
});

// ------------------------------------------------------- sign freshness

const feed = (fetched) => ({ fetched, signs: [] });

test('a failed refresh can never leave the Signs screen saying Live', () => {
  const t0 = Date.parse('2026-11-22T12:00:00Z');
  let record = signsAfterLoad(NO_SIGNS, { data: feed('2026-11-22T11:59:50Z'), origin: 'live' }, t0);
  assert.deepEqual(record, { data: feed('2026-11-22T11:59:50Z'), origin: 'live', loadedAt: t0, refreshFailed: false });
  assert.deepEqual(signsFreshness(record, t0 + 1000), { live: true, caution: null, checkedAt: t0 });

  // Half a minute later the relay and the snapshot both fail (a weak signal).
  // The messages stay on screen; the flag goes at once and the screen says why.
  record = signsAfterLoad(record, null, t0 + 30000);
  assert.equal(record.data.fetched, '2026-11-22T11:59:50Z');
  assert.equal(record.loadedAt, t0, 'still timed from the moment it was loaded');
  assert.deepEqual(signsFreshness(record, t0 + 30000), { live: false, caution: 'kept', checkedAt: t0 });
  // However long that goes on, it is never "Live" again by itself.
  record = signsAfterLoad(record, null, t0 + 3600000);
  assert.deepEqual(signsFreshness(record, t0 + 3600000), { live: false, caution: 'kept', checkedAt: t0 });

  // The relay answers again.
  record = signsAfterLoad(record, { data: feed('2026-11-22T13:00:05Z'), origin: 'live' }, t0 + 3630000);
  assert.deepEqual(signsFreshness(record, t0 + 3630000), { live: true, caution: null, checkedAt: t0 + 3630000 });
});

test('"Live" lapses by itself when nothing has been loaded for a while', () => {
  const t0 = Date.parse('2026-11-22T12:00:00Z');
  const record = signsAfterLoad(NO_SIGNS, { data: feed('2026-11-22T12:00:00Z'), origin: 'live' }, t0);
  assert.equal(signsFreshness(record, t0 + SIGNS_LIVE_MS - 1).live, true);
  // The page was asleep: no attempt failed, but the relay has not answered lately either.
  assert.equal(signsFreshness(record, t0 + SIGNS_LIVE_MS).live, false);
  assert.equal(signsFreshness(record, t0 + SIGNS_OLD_MS).caution, null);
  assert.equal(signsFreshness(record, t0 + SIGNS_OLD_MS + 1).caution, 'old');
});

test('a copy from the device replaces what is on screen only when it is at least as new', () => {
  const t0 = Date.parse('2026-11-22T12:00:00Z');
  const live = signsAfterLoad(NO_SIGNS, { data: feed('2026-11-22T11:59:50Z'), origin: 'live' }, t0);

  // Offline: the saved copy is days old. The minute-old messages stay, labelled as not refreshed.
  let record = signsAfterLoad(live, { data: feed('2026-11-19T08:00:00Z'), origin: 'saved' }, t0 + 30000);
  assert.equal(record.data.fetched, '2026-11-22T11:59:50Z');
  assert.equal(signsFreshness(record, t0 + 30000).caution, 'kept');

  // With nothing on screen, the saved copy is shown, and said to be one.
  record = signsAfterLoad(NO_SIGNS, { data: feed('2026-11-19T08:00:00Z'), origin: 'saved' }, t0);
  assert.deepEqual(record, { data: feed('2026-11-19T08:00:00Z'), origin: 'saved', loadedAt: 0, refreshFailed: true });
  assert.deepEqual(signsFreshness(record, t0), { live: false, caution: 'saved', checkedAt: null });
  // The copy shipped inside a phone app, likewise.
  record = signsAfterLoad(NO_SIGNS, { data: feed('2026-11-01T08:00:00Z'), origin: 'bundled' }, t0);
  assert.equal(signsFreshness(record, t0).caution, 'bundled');
  // A newer copy from the device does replace an older one.
  record = signsAfterLoad(record, { data: feed('2026-11-19T08:00:00Z'), origin: 'saved' }, t0 + 30000);
  assert.equal(record.data.fetched, '2026-11-19T08:00:00Z');
  assert.equal(record.origin, 'saved');
  // Nothing at all, with nothing on screen: still nothing, and no error.
  assert.deepEqual(signsAfterLoad(NO_SIGNS, null, t0), { data: null, origin: null, loadedAt: 0, refreshFailed: true });
});

test('a downloaded snapshot is as fresh as the last check of the feed, when that is known', () => {
  const t0 = Date.parse('2026-11-22T12:00:00Z');
  // The relay is down but the published snapshot downloads. Its own date is when the signs last changed.
  const live = signsAfterLoad(NO_SIGNS, { data: feed('2026-11-22T11:59:50Z'), origin: 'live' }, t0 - 30000);
  const record = signsAfterLoad(live, { data: feed('2026-11-22T09:00:00Z'), origin: 'network' }, t0);
  assert.equal(record.origin, 'network', 'a download always replaces what is on screen');
  assert.equal(record.refreshFailed, false);
  assert.equal(signsFreshness(record, t0).live, false, 'only the relay is "Live"');
  // The scheduled job ran four minutes ago: no caution, although the signs last changed three hours ago.
  assert.deepEqual(signsFreshness(record, t0, t0 - 240000), { live: false, caution: null, checkedAt: t0 - 240000 });
  // It last ran 40 minutes ago, or it is not known when: the caution is shown.
  assert.equal(signsFreshness(record, t0, t0 - 2400000).caution, 'old');
  assert.equal(signsFreshness(record, t0).caution, 'old');
  assert.equal(signsFreshness(record, t0, NaN).caution, 'old', 'an unreadable time is not a check');
  // Then the connection goes: said at once, with the copy that was downloaded.
  const kept = signsAfterLoad(record, null, t0 + 30000);
  assert.equal(signsFreshness(kept, t0 + 30000, t0 - 240000).caution, 'kept');
});
