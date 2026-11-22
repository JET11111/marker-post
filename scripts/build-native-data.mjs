#!/usr/bin/env node
// Prepare the marker-post data for the native (Swift and Kotlin) lookups, and
// the fixtures that prove those lookups give the same answers as the app.
//
// The native code runs while the phone is locked (Live Activity, ongoing
// notification), where the web view is suspended, so it needs its own copy of
// the data. To keep the three implementations identical, everything that
// takes judgement is computed HERE, once, by the JavaScript the app uses:
// travel bearings, display text, junction sections. The native side only has
// to measure distances and compare bearings.
//
// Output (all generated, none committed):
//   native/marker-post-plugin/ios/Sources/MarkerPostCore/Resources/posts.tsv
//   native/marker-post-plugin/android/src/main/assets/markerpost/posts.tsv
//   native/marker-post-plugin/ios/Tests/MarkerPostCoreTests/Resources/nearest-fixtures.tsv
//   native/marker-post-plugin/android/src/test/resources/nearest-fixtures.tsv
//
// posts.tsv — one post per line, tab separated, in the app's own order:
//   lat  lng  bearing  roadClass  road  km  letter  ref  context
//     bearing    direction traffic flows past the post, degrees; empty if unknown
//     roadClass  M (motorway), A (A-road) or O (other): badge colour only
//     road       display name, e.g. "M27", "A3(M)", "Chilworth · M3 / M27"
//     km/letter  the reference split for display ("17.4", "A"); empty if the
//                recorded reference is not in the usual form (show ref instead)
//     context    the line under the post (postContext in core/posts.js): the
//                junction section from the records ("J4 – J5", "Within J5"),
//                else the nearest junction and its distance from the post
//                ("A303 jct · 349 m from post"), else empty; interchange posts
//                give "Link M27B/M3B · survey date unknown"
//
// nearest-fixtures.tsv — sampled positions with the app's answer:
//   lat  lng  heading  speed  useHeading  index  distM  headingUsed  marginM
//     heading/speed  a number, or the word null (and NaN for heading)
//     index          line number of the expected post in posts.tsv (0-based)
//     marginM        how much further the runner-up was; fixtures with a
//                    margin under a millionth of a metre are ties that
//                    floating-point libraries may break differently

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine, angleDiff } from '../core/geo.js';
import {
  computeTravelBearings, findNearest, nearestJunction, junctionLabel, parseRef, roadLabel, roadClass,
  postContext, fmtDist, headingUsable,
} from '../core/posts.js';
import { buildPostSections } from './post-sections.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = join(ROOT, 'native', 'marker-post-plugin');
const json = async (name) => JSON.parse(await readFile(join(ROOT, 'data', name), 'utf8'));

// The app's post list, built exactly as app.js builds it.
const posts = await json('posts.json');
const supplemental = await json('posts-supplemental.json');
if (Array.isArray(supplemental.posts)) posts.push(...supplemental.posts);
const junctions = await json('junctions.json');
computeTravelBearings(posts);
// Junction sections from National Highways' own section records, as in the web build.
const sections = buildPostSections(posts, (await json('network.json')).links);

const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const CLASS = { motorway: 'M', 'a-road': 'A', other: 'O' };

// The same function the web app uses when it hands a post to the phone.
const contextFor = (p) => postContext(p, sections, junctions);

const rows = posts.map((p) => {
  const parts = parseRef(p.ref);
  return [
    String(p.lat), String(p.lng), p.bearing == null ? '' : String(p.bearing),
    CLASS[roadClass(p.road)], clean(roadLabel(p.road)),
    parts ? parts.km : '', parts ? parts.letter : '', clean(p.ref), clean(contextFor(p)),
  ].join('\t');
});
const body = rows.join('\n');
const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
const postsTsv = `# markerpost-posts\tv1\t${posts.length}\t${digest}\n# lat\tlng\tbearing\troadClass\troad\tkm\tletter\tref\tcontext\n${body}\n`;

// ---- fixtures: a fixed, seeded sample plus hand-picked hard cases ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const rnd = lcg(20261122);
const cases = [];
const add = (lat, lng, heading, speed, useHeading) => cases.push({ lat, lng, heading, speed, useHeading });
const find = (road, ref) => posts.find((p) => p.road === road && p.ref === ref);

// Hand-picked: on a post, the opposite carriageway, an interchange, the ends, far away.
for (const [road, ref] of [['M27', 'P20/9A'], ['M27', 'P20/9B'], ['M27', 'P17/4A'], ['M3', 'P116/4B'], ['A34', 'P13/2A'], ['A3M', 'P3/0A'], ['M271', 'P11/0L'], ['M27', 'P1/7A'], ['M27', 'P46/6A']]) {
  const p = find(road, ref);
  if (!p) throw new Error(`Fixture post ${road} ${ref} is missing from the data`);
  add(p.lat, p.lng, null, null, true);                                   // no heading at all
  add(p.lat, p.lng, p.bearing ?? 90, 30, true);                          // travelling with the carriageway
  add(p.lat, p.lng, ((p.bearing ?? 90) + 180) % 360, 30, true);          // travelling against it
  add(p.lat, p.lng, p.bearing ?? 90, 2.5, true);                         // exactly at the speed threshold: not used
  add(p.lat, p.lng, p.bearing ?? 90, 30, false);                         // preference off
  add(p.lat, p.lng, NaN, 30, true);                                      // receiver reports no heading
}
add(51.5074, -0.1278, 270, 20, true);   // central London: far outside the data
add(50.0, -5.0, null, 0, true);         // Cornwall
// Seeded sample around the network.
for (let i = 0; i < 2000; i++) {
  const base = posts[Math.floor(rnd() * posts.length)];
  add(base.lat + (rnd() - 0.5) * 0.0016, base.lng + (rnd() - 0.5) * 0.0024,
    rnd() < 0.12 ? null : rnd() < 0.04 ? NaN : rnd() * 360,
    rnd() < 0.08 ? null : rnd() * 38,
    rnd() < 0.88);
}

const index = new Map(posts.map((p, i) => [p, i]));
function margin(c, best) {
  // Distance to the runner-up in the pass that produced the answer.
  const filtered = headingUsable(c.heading, c.speed, c.useHeading);
  const pass = (useFilter) => {
    let second = Infinity;
    for (const p of posts) {
      if (p === best) continue;
      if (useFilter && p.bearing != null && angleDiff(p.bearing, c.heading) > 90) continue;
      const d = haversine(c.lat, c.lng, p.lat, p.lng);
      if (d < second) second = d;
    }
    return second;
  };
  // The filtered pass decided unless it found nothing (which cannot happen here: posts without a bearing always pass).
  return pass(filtered) - haversine(c.lat, c.lng, best.lat, best.lng);
}
const word = (v) => (v == null ? 'null' : Number.isNaN(v) ? 'NaN' : String(v));
const fixtureRows = cases.map((c) => {
  const r = findNearest(posts, c.lat, c.lng, c.heading, c.speed, c.useHeading);
  return [String(c.lat), String(c.lng), word(c.heading), word(c.speed), c.useHeading ? '1' : '0',
    String(index.get(r.post)), String(r.dist), r.headingUsed ? '1' : '0', String(margin(c, r.post))].join('\t');
});
const fixturesTsv = `# markerpost-nearest-fixtures\tv1\t${cases.length}\t${digest}\n# lat\tlng\theading\tspeed\tuseHeading\tindex\tdistM\theadingUsed\tmarginM\n${fixtureRows.join('\n')}\n`;

const outputs = [
  ['ios/Sources/MarkerPostCore/Resources/posts.tsv', postsTsv],
  ['android/src/main/assets/markerpost/posts.tsv', postsTsv],
  ['ios/Tests/MarkerPostCoreTests/Resources/nearest-fixtures.tsv', fixturesTsv],
  ['android/src/test/resources/nearest-fixtures.tsv', fixturesTsv],
  // The Kotlin unit tests run on the JVM without the Android asset manager.
  ['android/src/test/resources/posts.tsv', postsTsv],
  ['ios/Tests/MarkerPostCoreTests/Resources/posts.tsv', postsTsv],
];
for (const [rel, text] of outputs) {
  const file = join(PLUGIN, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}
const ties = fixtureRows.filter((r) => Number(r.split('\t')[8]) < 1e-6).length;
console.log(`Native data: ${posts.length} posts (${(postsTsv.length / 1024).toFixed(0)} KB, digest ${digest}), ${cases.length} fixtures (${ties} near-ties)`);
