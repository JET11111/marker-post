// Marker-post lookup: the single source of truth for "which post is nearest".
// Pure functions over plain data (no DOM, no Node APIs) so the same code runs
// in the app, in the tests and in the generator that prepares data for the
// native (Swift/Kotlin) lookups.
//
// Honesty rules that live here:
//  * A post is only ever a recorded post. Nothing is interpolated.
//  * Distances are straight-line (great-circle) distances.
//  * A junction section is only stated where the app's junction records
//    bracket the post on a numbered-junction road. Otherwise it stays unknown
//    (null) and callers fall back to "nearest junction", or to nothing.

import { haversine, bearing, angleDiff } from './geo.js';

/** Speed (m/s) above which a GPS heading is trusted for carriageway choice. */
export const HEADING_MIN_SPEED = 2.5;

/** Display label for a source road name (A3M is the A3(M) motorway). */
export const roadLabel = (road) =>
  ({ A3M: 'A3(M)', CHILWORTH: 'Chilworth · M3 / M27', PITSEA: 'M27 / M275 interchange' }[road] || road);

/** Road classification used for badge colour only. */
export function roadClass(road) {
  const r = String(road || '').toUpperCase();
  if (/^M\d/.test(r) || r === 'A3M' || /\(M\)$/.test(r)) return 'motorway';
  if (/^A\d/.test(r)) return 'a-road';
  return 'other';
}

/** "P13/6A" from a chainage and carriageway letter. */
export function buildRef(distance, dir) {
  const whole = Math.floor(distance + 1e-9);
  const tenth = Math.round((distance - whole) * 10);
  return `P${whole}/${tenth}${dir}`;
}

/**
 * Split a recorded reference into the parts shown large on screen.
 * "P117/8B" -> { km: "117.8", letter: "B" }. Returns null for anything that
 * is not in that recorded form, so callers show the reference verbatim.
 */
export function parseRef(ref) {
  const m = /^P(\d+)\/(\d)([A-Z])$/.exec(String(ref || ''));
  return m ? { km: `${m[1]}.${m[2]}`, letter: m[3] } : null;
}

/**
 * Give each post a travel bearing = the direction traffic flows past it, so
 * the two (anti-parallel) carriageways can be told apart even though they sit
 * only metres apart. The chainage order only gives the road's geographic
 * line; the flow sign comes from drive-on-the-left geometry: the opposite
 * carriageway is always on your right. Votes per carriageway rather than
 * assuming A/B, since some roads label carriageways differently (M271: L/M).
 * Mutates the posts (adds `bearing`), exactly as the app always has.
 */
export function computeTravelBearings(posts) {
  const groups = new Map(); // "road|dir" -> posts on that carriageway
  for (const p of posts) {
    const k = `${p.road}|${p.direction}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const [k, list] of groups) {
    // Interchange links share source road names but are not one continuous
    // carriageway. Do not infer travel bearings by sorting their chainages.
    if (list.some((p) => p.link)) continue;
    if (list.length < 2) continue;
    list.sort((a, b) => a.distance - b.distance);
    const [road, dir] = k.split('|');
    const opp = posts.filter((q) => q.road === road && q.direction !== dir);
    if (!opp.length) continue;

    // Does travel run with increasing chainage? Sample a few posts and check
    // which side the nearest opposite-carriageway post falls on.
    let plus = 0, minus = 0;
    const step = Math.max(1, Math.floor(list.length / 40));
    for (let i = 1; i < list.length - 1; i += step) {
      const inc = bearing(list[i - 1].lat, list[i - 1].lng, list[i + 1].lat, list[i + 1].lng);
      let o = null, od = Infinity;
      for (const q of opp) {
        const d = haversine(list[i].lat, list[i].lng, q.lat, q.lng);
        if (d < od) { od = d; o = q; }
      }
      if (!o || od > 60 || od < 3) continue; // need a clean carriageway pair
      const toOpp = bearing(list[i].lat, list[i].lng, o.lat, o.lng);
      if (angleDiff(toOpp, inc + 90) < angleDiff(toOpp, inc - 90)) plus++; else minus++;
    }
    const flip = minus > plus ? 180 : 0; // travel is against increasing chainage

    for (let i = 0; i < list.length; i++) {
      const prev = list[Math.max(0, i - 1)];
      const next = list[Math.min(list.length - 1, i + 1)];
      if (prev === next) continue;
      list[i].bearing = (bearing(prev.lat, prev.lng, next.lat, next.lng) + flip + 360) % 360;
    }
  }
}

/** True when a GPS heading is reliable enough to choose a carriageway with. */
export function headingUsable(heading, speed, useHeading) {
  return Boolean(useHeading) && heading != null && !Number.isNaN(heading) &&
    speed != null && speed > HEADING_MIN_SPEED;
}

/**
 * Nearest recorded post to a position. Linear scan: a few thousand points is
 * fast enough. With a usable heading, posts whose carriageway flows the other
 * way (more than 90 degrees off) are skipped, which drops the opposite
 * carriageway sitting just metres to the side. Posts with no travel bearing
 * stay in. `headingUsed` says whether the heading actually decided the
 * carriageway, so the UI can label a position-only match honestly.
 */
export function findNearest(posts, lat, lng, heading, speed, useHeading) {
  const filter = headingUsable(heading, speed, useHeading);
  let best = null, bestD = Infinity, headingUsed = false;
  if (filter) {
    for (const p of posts) {
      if (p.bearing != null && angleDiff(p.bearing, heading) > 90) continue;
      const d = haversine(lat, lng, p.lat, p.lng);
      if (d < bestD) { bestD = d; best = p; }
    }
    headingUsed = Boolean(best) && best.bearing != null;
  }
  if (!best) {
    for (const p of posts) {
      const d = haversine(lat, lng, p.lat, p.lng);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return { post: best, dist: bestD, headingUsed };
}

/** Nearest junction record on the given road; null if the road has none. */
export function nearestJunction(junctions, lat, lng, road) {
  let best = null, bestD = Infinity;
  for (const j of junctions) {
    if (j.road !== road) continue;
    const d = haversine(lat, lng, j.lat, j.lng);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best ? { jct: best, dist: bestD } : null;
}

/** "J5" -> "M27 J5"; "A3093" (a connecting road) -> "A3093 jct". */
export function junctionLabel(road, jct) {
  return /^J/.test(jct) ? `${roadLabel(road)} ${jct}` : `${jct} jct`;
}

/**
 * Nearest ERA on the SAME carriageway as the current post. You cannot reverse
 * on a motorway, so with a usable heading only bays AHEAD (within a 90 degree
 * cone of travel) count: if you have passed them all, there is no result.
 * Without a usable heading it falls back to the nearest bay on the
 * carriageway. Only smart-motorway roads have ERA records.
 */
export function nearestERA(eras, lat, lng, road, dir, heading, speed, useHeading) {
  const onCarriageway = eras.filter((e) => e.road === road && e.dir === dir);
  if (!onCarriageway.length) return null;
  const canHead = headingUsable(heading, speed, useHeading);

  let best = null, bestD = Infinity;
  if (canHead) {
    for (const e of onCarriageway) {
      if (angleDiff(bearing(lat, lng, e.lat, e.lng), heading) > 90) continue; // behind us
      const d = haversine(lat, lng, e.lat, e.lng);
      if (d < bestD) { bestD = d; best = e; }
    }
    // None ahead: the last bay has been passed. Show nothing rather than mislead.
    return best ? { era: best, dist: bestD, ahead: true } : null;
  }
  for (const e of onCarriageway) {
    const d = haversine(lat, lng, e.lat, e.lng);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? { era: best, dist: bestD, ahead: false } : null;
}

const MAINLINE = new Set(['A', 'B']);

/** "J4A" -> [4, "A"] for ordering junction names the way they are numbered. */
function junctionOrder(name) {
  const m = /^J(\d+)([A-Z]?)$/.exec(name);
  return m ? [Number(m[1]), m[2]] : [Infinity, name];
}

/** Two junction names in numbered order, low to high: ("J14", "J13") -> ["J13", "J14"]. */
export function junctionPair(a, b) {
  return [a, b].sort((x, y) => {
    const [nx, sx] = junctionOrder(x), [ny, sy] = junctionOrder(y);
    return nx - ny || (sx < sy ? -1 : sx > sy ? 1 : 0);
  });
}

const JUNCTION_NAME = /^J\d+[A-Z]?$/;

/**
 * The junction section a mainline post sits in, as National Highways' own
 * record of that stretch of carriageway describes it. "between J4 and J5"
 * gives { kind: 'between', label: 'J4 – J5' }; "within J5" gives
 * { kind: 'within', label: 'Within J5' }.
 *
 * `sections` is the table made by scripts/post-sections.mjs from the network
 * snapshot (data/post-sections.json in a build). A post that is not in it gets
 * null and the screen shows no section: slip and link letters, interchange
 * posts, A-roads (their records name the crossing roads, not numbered
 * junctions), and any post the records could not be matched to with
 * confidence. Nothing here is worked out from distances, and the two
 * carriageways can differ at the same reference, because their slip roads are
 * not opposite each other.
 */
export function junctionSection(post, sections) {
  if (!post || post.link || !MAINLINE.has(post.direction)) return null;
  const entry = sections?.roads?.[post.road]?.[post.ref];
  if (!Array.isArray(entry) || !entry.every((name) => JUNCTION_NAME.test(name))) return null;
  if (entry.length === 1) return { kind: 'within', label: `Within ${entry[0]}`, at: entry[0] };
  if (entry.length !== 2 || entry[0] === entry[1]) return null;
  const [from, to] = junctionPair(entry[0], entry[1]);
  return { kind: 'between', label: `${from} – ${to}`, from, to };
}

/**
 * How long (ms) a position stays current without a new fix. After this it is
 * the "last known" position and every screen must say so: 15 s when moving,
 * 30 s when the speed is not known, 2 minutes when standing still.
 */
export const staleAfterMs = (speed) =>
  (speed == null || Number.isNaN(speed) ? 30000 : speed > HEADING_MIN_SPEED ? 15000 : 120000);

/** "38 m", "1.24 km", "12.4 km". */
export const fmtDist = (m) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
