#!/usr/bin/env node
// Which junction section is each marker post in? This takes the answer from
// National Highways' own record of each stretch of carriageway, which says
// "M27 eastbound between J4 and J5" or "M27 westbound within J4". Nothing is
// worked out from distances along the road.
//
// The table is made when the app is built (scripts/build-web.mjs writes it to
// data/post-sections.json in the build) and when the phone lookup data is made
// (scripts/build-native-data.mjs), always from the network snapshot being
// published, so it cannot fall out of step with it. It is not kept in the
// repository.
//
//   node scripts/post-sections.mjs      print a summary of the table
//
// A post gets an entry only when all of these hold. Otherwise it has none, and
// the app shows no section for it:
//   * it is a mainline post (carriageway letter A or B, not an interchange link);
//   * a main carriageway record of the same road and the same letter lies
//     within 40 m of it, and the other carriageway's record is not nearer
//     (that would mean the post's recorded position is on the wrong side);
//   * that record's description names numbered junctions: "between Jx and Jy"
//     or "within Jx". A-road records name the crossing roads instead, and are
//     left alone.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { findNearestRoadSection } from '../map-details.js';
import { junctionPair } from '../core/posts.js';

const MAX_M = 40;
const J = 'J\\d+[A-Z]?';
const BETWEEN = new RegExp(`\\bbetween (${J}) and (${J})(?![A-Za-z0-9])`);
const WITHIN = new RegExp(`\\bwithin (${J})(?![A-Za-z0-9])`);
const roadKey = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "M3 eastbound between J14 and J13" -> ["J13", "J14"]; "... within J5 ..." -> ["J5"]; anything else -> null. */
export function sectionFromDescription(description) {
  const text = String(description ?? '');
  const between = BETWEEN.exec(text);
  if (between) return between[1] === between[2] ? null : junctionPair(between[1], between[2]);
  const within = WITHIN.exec(text);
  return within ? [within[1]] : null;
}

/**
 * { schemaVersion, roads: { M27: { "P17/4A": ["J4", "J5"], "P19/2A": ["J5"] } } }
 * Two junctions: between them. One: within it. Keys are the post's road and
 * reference exactly as they are in the post records.
 */
export function buildPostSections(posts, links) {
  // The main carriageway records, by road and letter, each with a rough box
  // around it so that only nearby records are measured against a post.
  const index = new Map();
  for (const link of links || []) {
    if (!Array.isArray(link.coordinates) || link.coordinates.length < 2) continue;
    const key = `${roadKey(link.road)}|${String(link.carriageway ?? '').trim().toUpperCase()}`;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of link.coordinates) {
      if (lng < w) w = lng; if (lng > e) e = lng;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ link, w, s, e, n });
  }
  const MARGIN = 0.002; // degrees: more than 100 m anywhere in Britain
  const nearest = (road, letter, point, maxDistanceM) => {
    const near = (index.get(`${roadKey(road)}|${letter}`) || [])
      .filter((b) => point[0] >= b.w - MARGIN && point[0] <= b.e + MARGIN && point[1] >= b.s - MARGIN && point[1] <= b.n + MARGIN)
      .map((b) => b.link);
    // The same matcher the Map tab uses to say which record a post belongs to.
    return near.length ? findNearestRoadSection(near, point, { road, carriageway: letter, parentOnly: true, maxDistanceM }) : null;
  };

  const found = new Map(); // "road|ref" -> section, or null once two posts with one reference disagree
  for (const post of posts || []) {
    if (!post || post.link || (post.direction !== 'A' && post.direction !== 'B')) continue;
    const point = [post.lng, post.lat];
    const own = nearest(post.road, post.direction, point, MAX_M);
    if (!own) continue;
    const other = nearest(post.road, post.direction === 'A' ? 'B' : 'A', point, own.distanceM);
    if (other && other.distanceM < own.distanceM) continue;
    const section = sectionFromDescription(own.link.description);
    if (!section) continue;
    const key = `${post.road}|${post.ref}`;
    if (found.has(key) && JSON.stringify(found.get(key)) !== JSON.stringify(section)) found.set(key, null);
    else if (!found.has(key)) found.set(key, section);
  }

  const roads = {};
  const order = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  for (const key of [...found.keys()].sort(order)) {
    const section = found.get(key);
    if (!section) continue;
    const [road, ref] = key.split('|');
    (roads[road] ||= {})[ref] = section;
  }
  return { schemaVersion: 1, roads };
}

/** The posts as the app builds its own list, and the network records, from data/. */
export async function buildFromData(root) {
  const read = async (name) => JSON.parse(await readFile(new URL(`data/${name}`, root), 'utf8'));
  const posts = await read('posts.json');
  const extra = await read('posts-supplemental.json');
  if (Array.isArray(extra.posts)) posts.push(...extra.posts);
  return buildPostSections(posts, (await read('network.json')).links);
}

export function countSections(sections) {
  let between = 0, within = 0;
  for (const refs of Object.values(sections.roads)) for (const s of Object.values(refs)) s.length === 2 ? between++ : within++;
  return { between, within };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = Date.now();
  const sections = await buildFromData(new URL('..', import.meta.url));
  const { between, within } = countSections(sections);
  console.log(`${between + within} posts have a junction section from the records (${between} between two junctions, ${within} within one), in ${Date.now() - started} ms`);
  for (const [road, refs] of Object.entries(sections.roads)) console.log(`  ${road}: ${Object.keys(refs).length}`);
}
