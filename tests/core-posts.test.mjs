import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { haversine, bearing, angleDiff } from '../core/geo.js';
import {
  computeTravelBearings, findNearest, nearestJunction, junctionLabel, nearestERA,
  buildRef, parseRef, roadLabel, roadClass, buildJunctionChainage, junctionSection,
  headingUsable, fmtDist,
} from '../core/posts.js';

const json = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8'));

/** The app's combined post list, built the way app.js builds it. */
async function loadPosts() {
  const posts = await json('posts.json');
  const supplemental = await json('posts-supplemental.json');
  return [...posts, ...supplemental.posts];
}

// ---- The implementation the app shipped before core/ existed, frozen here so
// ---- a refactor can never silently change which post is reported.
const legacy = (() => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  function haversine(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearing(lat1, lng1, lat2, lng2) {
    const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
    return (Math.atan2(y, x) * 180) / Math.PI;
  }
  function angleDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
  function computeTravelBearings(POSTS) {
    const groups = new Map();
    for (const p of POSTS) {
      const k = `${p.road}|${p.direction}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const [k, list] of groups) {
      if (list.some((p) => p.link)) continue;
      if (list.length < 2) continue;
      list.sort((a, b) => a.distance - b.distance);
      const [road, dir] = k.split('|');
      const opp = POSTS.filter((q) => q.road === road && q.direction !== dir);
      if (!opp.length) continue;
      let plus = 0, minus = 0;
      const step = Math.max(1, Math.floor(list.length / 40));
      for (let i = 1; i < list.length - 1; i += step) {
        const inc = bearing(list[i - 1].lat, list[i - 1].lng, list[i + 1].lat, list[i + 1].lng);
        let o = null, od = Infinity;
        for (const q of opp) {
          const d = haversine(list[i].lat, list[i].lng, q.lat, q.lng);
          if (d < od) { od = d; o = q; }
        }
        if (!o || od > 60 || od < 3) continue;
        const toOpp = bearing(list[i].lat, list[i].lng, o.lat, o.lng);
        if (angleDiff(toOpp, inc + 90) < angleDiff(toOpp, inc - 90)) plus++; else minus++;
      }
      const flip = minus > plus ? 180 : 0;
      for (let i = 0; i < list.length; i++) {
        const prev = list[Math.max(0, i - 1)];
        const next = list[Math.min(list.length - 1, i + 1)];
        if (prev === next) continue;
        list[i].bearing = (bearing(prev.lat, prev.lng, next.lat, next.lng) + flip + 360) % 360;
      }
    }
  }
  function findNearest(POSTS, lat, lng, heading, speed, useHeading) {
    const filter = useHeading && heading != null && !Number.isNaN(heading) && speed != null && speed > 2.5;
    let best = null, bestD = Infinity;
    if (filter) {
      for (const p of POSTS) {
        if (p.bearing != null && angleDiff(p.bearing, heading) > 90) continue;
        const d = haversine(lat, lng, p.lat, p.lng);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    if (!best) {
      for (const p of POSTS) {
        const d = haversine(lat, lng, p.lat, p.lng);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    return { post: best, dist: bestD };
  }
  return { haversine, bearing, angleDiff, computeTravelBearings, findNearest };
})();

/** Small deterministic generator so the sampled cases never change. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('geodesy helpers match the shipped maths', () => {
  assert.ok(Math.abs(haversine(50, -1, 51, -1) - 111194.9266) < 0.001);
  assert.equal(haversine(50.9, -1.4, 50.9, -1.4), 0);
  assert.ok(Math.abs(bearing(50, -1, 51, -1)) < 1e-9, 'due north is 0');
  assert.ok(Math.abs(bearing(50, -1, 50, 0) - 89.617) < 0.01, 'east along a parallel');
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(0, 180), 180);
  for (const [a, b, c, d] of [[50.9483, -1.3925, 50.9379, -1.3525], [51.2, -0.9, 50.8, -1.8]]) {
    assert.equal(haversine(a, b, c, d), legacy.haversine(a, b, c, d));
    assert.equal(bearing(a, b, c, d), legacy.bearing(a, b, c, d));
  }
});

test('every recorded reference splits into a chainage and a letter, and rebuilds exactly', async () => {
  const posts = await loadPosts();
  assert.equal(posts.length, 5175);
  for (const p of posts) {
    const parts = parseRef(p.ref);
    assert.ok(parts, `unparsed reference ${p.ref}`);
    assert.equal(parts.letter, p.direction, p.ref);
    assert.equal(Number(parts.km), p.distance, p.ref);
    assert.equal(buildRef(p.distance, p.direction), p.ref);
  }
  assert.deepEqual(parseRef('P117/8B'), { km: '117.8', letter: 'B' });
  assert.deepEqual(parseRef('P48/0B'), { km: '48.0', letter: 'B' });
  assert.equal(parseRef('not a ref'), null);
  assert.equal(parseRef(undefined), null);
});

test('travel bearings are identical to the shipped implementation', async () => {
  const mine = await loadPosts(), theirs = await loadPosts();
  computeTravelBearings(mine);
  legacy.computeTravelBearings(theirs);
  const key = (p) => `${p.sourceId || ''}|${p.road}|${p.ref}`;
  const expected = new Map(theirs.map((p) => [key(p), p.bearing]));
  let withBearing = 0;
  for (const p of mine) {
    assert.equal(p.bearing, expected.get(key(p)), key(p));
    if (p.bearing != null) withBearing++;
  }
  assert.ok(withBearing > 4800, `only ${withBearing} posts received a travel bearing`);
  // Interchange link posts never get an inferred bearing.
  assert.ok(mine.filter((p) => p.link).every((p) => p.bearing == null));
});

test('nearest post is identical to the shipped implementation across 4,000 sampled fixes', async () => {
  const mine = await loadPosts(), theirs = await loadPosts();
  computeTravelBearings(mine);
  legacy.computeTravelBearings(theirs);
  const rnd = lcg(20261122);
  for (let i = 0; i < 4000; i++) {
    const base = mine[Math.floor(rnd() * mine.length)];
    const lat = base.lat + (rnd() - 0.5) * 0.0012;   // about ±65 m
    const lng = base.lng + (rnd() - 0.5) * 0.0018;
    const heading = rnd() < 0.15 ? null : rnd() < 0.05 ? NaN : rnd() * 360;
    const speed = rnd() < 0.1 ? null : rnd() * 35;
    const useHeading = rnd() < 0.85;
    const a = findNearest(mine, lat, lng, heading, speed, useHeading);
    const b = legacy.findNearest(theirs, lat, lng, heading, speed, useHeading);
    assert.equal(a.post.ref, b.post.ref, `case ${i}`);
    assert.equal(a.post.road, b.post.road, `case ${i}`);
    assert.equal(a.dist, b.dist, `case ${i}`);
  }
});

test('a usable heading keeps the travelled carriageway; without one the match is by position only', async () => {
  const posts = await loadPosts();
  computeTravelBearings(posts);
  // A plain stretch between J5 and J7, clear of the interchange link posts.
  const a = posts.find((p) => p.road === 'M27' && p.ref === 'P20/9A');
  const b = posts.find((p) => p.road === 'M27' && p.ref === 'P20/9B');
  assert.ok(angleDiff(a.bearing, b.bearing) > 150, 'the two carriageways flow in opposite directions');

  // Standing on the B post, but travelling the way carriageway A flows.
  const moving = findNearest(posts, b.lat, b.lng, a.bearing, 30, true);
  assert.equal(moving.post.direction, 'A');
  assert.equal(moving.post.road, 'M27');
  assert.equal(moving.headingUsed, true);

  // Same position, stationary: nearest by position, and it says so.
  const stopped = findNearest(posts, b.lat, b.lng, a.bearing, 0.4, true);
  assert.equal(stopped.post.ref, 'P20/9B');
  assert.equal(stopped.dist, 0);
  assert.equal(stopped.headingUsed, false);

  // Preference switched off, or no heading from the receiver.
  assert.equal(findNearest(posts, b.lat, b.lng, a.bearing, 30, false).headingUsed, false);
  assert.equal(findNearest(posts, b.lat, b.lng, null, 30, true).headingUsed, false);
  assert.equal(findNearest(posts, b.lat, b.lng, NaN, 30, true).headingUsed, false);

  assert.equal(headingUsable(90, 2.5, true), false, 'exactly 2.5 m/s is not enough');
  assert.equal(headingUsable(90, 2.6, true), true);
  assert.equal(headingUsable(0, 30, true), true, 'a heading of 0 degrees is a real heading');
});

test('a post with no travel bearing can be returned without claiming the heading chose it', async () => {
  const posts = await loadPosts();
  computeTravelBearings(posts);
  const link = posts.find((p) => p.link && p.ref === 'P17/4L');
  const result = findNearest(posts, link.lat, link.lng, 45, 30, true);
  assert.equal(result.post.sourceId, link.sourceId);
  assert.equal(result.headingUsed, false);
});

test('junction chainages come from snapping each junction record to a mainline post', async () => {
  const posts = await loadPosts(), junctions = await json('junctions.json');
  const index = buildJunctionChainage(posts, junctions);
  const m27 = index.get('M27').map((j) => j.jct);
  assert.deepEqual(m27, ['J1', 'J2', 'J3', 'J4', 'J5', 'J7', 'J8', 'J9', 'J10', 'J11', 'J12']);
  assert.deepEqual(index.get('M3').map((j) => j.jct),
    ['J4', 'J4A', 'J5', 'J6', 'J7', 'J8', 'J9', 'J10', 'J11', 'J12', 'J13', 'J14']);
  for (const list of index.values()) for (const j of list) {
    assert.ok(j.snapM < 400, `${j.jct} snapped ${Math.round(j.snapM)} m away`);
  }
  assert.equal(index.has('M271'), false, 'no junction records for the M271');
  assert.equal(index.has('CHILWORTH'), false);
});

test('junction sections are stated only where recorded junctions bracket the post', async () => {
  const posts = await loadPosts(), junctions = await json('junctions.json');
  const index = buildJunctionChainage(posts, junctions);
  const at = (road, ref) => junctionSection(posts.find((p) => p.road === road && p.ref === ref), index);

  assert.deepEqual(at('M27', 'P17/4A'), { kind: 'between', label: 'J4 – J5', from: 'J4', to: 'J5' });
  assert.equal(at('M27', 'P17/4B').label, 'J4 – J5', 'the label does not depend on the carriageway');
  assert.equal(at('M27', 'P20/9A').label, 'J5 – J7', 'the M27 has no J6');
  assert.equal(at('M3', 'P116/4B').label, 'J13 – J14');
  assert.equal(at('M3', 'P56/5A').label, 'J4A – J5');
  assert.equal(at('M3', 'P54/0A').label, 'J4 – J4A');
  // A3(M) junction numbers fall as chainage rises: the label still reads low to high.
  assert.equal(at('A3M', 'P3/0A').label, 'J3 – J4');

  // Close to a junction the section is ambiguous, so it says where you are instead.
  assert.deepEqual(at('M27', 'P19/2A'), { kind: 'at', label: 'At J5', at: 'J5' });
  assert.equal(at('M27', 'P19/4A').label, 'At J5');
  assert.equal(at('M27', 'P19/6A').label, 'J5 – J7');

  // Unknown stays unknown.
  assert.equal(at('M27', 'P1/7A'), null, 'before the first recorded junction');
  assert.equal(at('M27', 'P46/6A'), null, 'beyond the last recorded junction');
  assert.equal(at('A3M', 'P9/0A'), null, 'A3(M) J1 is not in the junction records');
  assert.equal(at('A34', 'P13/2A'), null, 'A-road junction records are named roads, not a numbered sequence');
  assert.equal(at('M27', 'P33/0L'), null, 'slip and link letters are not placed on the mainline');
  assert.equal(at('M271', 'P11/0L'), null, 'no junction records for this road');
  assert.equal(junctionSection(posts.find((p) => p.link), index), null, 'interchange link posts');
  assert.equal(junctionSection(null, index), null);
});

test('every mainline motorway post gets a section, an "at" label, or nothing — never a guess', async () => {
  const posts = await loadPosts(), junctions = await json('junctions.json');
  const index = buildJunctionChainage(posts, junctions);
  const counts = { between: 0, at: 0, none: 0 };
  for (const p of posts) {
    const s = junctionSection(p, index);
    counts[s ? s.kind : 'none']++;
    if (!s) continue;
    assert.ok(['M27', 'M3', 'A3M'].includes(p.road), `${p.road} ${p.ref} unexpectedly has a section`);
    assert.ok(['A', 'B'].includes(p.direction));
    if (s.kind === 'between') assert.match(s.label, /^J\d+[A-Z]? – J\d+[A-Z]?$/);
    else assert.match(s.label, /^At J\d+[A-Z]?$/);
  }
  assert.ok(counts.between > 1800 && counts.at > 150 && counts.none > 2500, JSON.stringify(counts));
});

test('nearest junction, ERA and labels behave as before', async () => {
  const posts = await loadPosts(), junctions = await json('junctions.json'), eras = await json('eras.json');
  computeTravelBearings(posts);
  const a = posts.find((p) => p.road === 'M27' && p.ref === 'P17/4A');

  const nj = nearestJunction(junctions, a.lat, a.lng, 'M27');
  assert.equal(nj.jct.jct, 'J4');
  assert.ok(Math.abs(nj.dist - 1220) < 30);
  assert.equal(nearestJunction(junctions, a.lat, a.lng, 'M271'), null);
  assert.equal(junctionLabel('M27', 'J5'), 'M27 J5');
  assert.equal(junctionLabel('A3M', 'J3'), 'A3(M) J3');
  assert.equal(junctionLabel('A303', 'A3093'), 'A3093 jct');

  // Travelling the way carriageway A flows: the next bay ahead.
  const ahead = nearestERA(eras, a.lat, a.lng, 'M27', 'A', a.bearing, 30, true);
  assert.equal(ahead.era.km, 20.8);
  assert.equal(ahead.ahead, true);
  // Facing the other way every A-carriageway bay is behind: nothing is shown.
  assert.equal(nearestERA(eras, a.lat, a.lng, 'M27', 'A', (a.bearing + 180) % 360, 30, true), null);
  // Stationary: nearest bay on the carriageway, not labelled as ahead.
  const still = nearestERA(eras, a.lat, a.lng, 'M27', 'A', a.bearing, 0, true);
  assert.equal(still.era.km, 20.8);
  assert.equal(still.ahead, false);
  assert.equal(nearestERA(eras, a.lat, a.lng, 'M3', 'A', 0, 30, true), null, 'no ERA records for the M3');

  assert.equal(roadLabel('A3M'), 'A3(M)');
  assert.equal(roadLabel('CHILWORTH'), 'Chilworth · M3 / M27');
  assert.equal(roadLabel('M27'), 'M27');
  assert.equal(roadClass('M27'), 'motorway');
  assert.equal(roadClass('A3M'), 'motorway');
  assert.equal(roadClass('A3(M)'), 'motorway');
  assert.equal(roadClass('A34'), 'a-road');
  assert.equal(roadClass('CHILWORTH'), 'other');
  assert.equal(fmtDist(38.4), '38 m');
  assert.equal(fmtDist(1240), '1.24 km');
  assert.equal(fmtDist(12400), '12.4 km');
});
