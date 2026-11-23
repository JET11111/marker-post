// Marker-post lookup: the single source of truth for "which post is nearest".
// Pure functions over plain data (no DOM, no Node APIs) so the same code runs
// in the app, in the tests and in the generator that prepares data for the
// native (Swift/Kotlin) lookups.
//
// Honesty rules that live here:
//  * A post is only ever a recorded post. Nothing is interpolated.
//  * Distances are straight-line (great-circle) distances.
//  * A junction section is only stated where National Highways' own section
//    records give one for the post (see junctionSection). Otherwise it stays
//    unknown (null) and callers fall back to "nearest junction", or to nothing.

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
 * The line the phone's widgets, notification and Live Activity show under a
 * post. It describes the POST, never the vehicle, because the phone trackers
 * work it out in advance for every post: the junction section from the
 * records, else the nearest junction and how far it is from the post, else
 * nothing. Interchange link posts keep their caveat.
 */
export function postContext(post, sections, junctions) {
  if (!post) return '';
  if (post.link) return `Link ${post.link} · survey date unknown`;
  const section = junctionSection(post, sections);
  if (section) return section.label;
  const nj = nearestJunction(junctions || [], post.lat, post.lng, post.road);
  return nj ? `${junctionLabel(post.road, nj.jct.jct)} · ${fmtDist(nj.dist)} from post` : '';
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

// ---------------------------------------------------------------------------
// Rules the screens share. They live here, not in app.js, so that each one is
// a plain function the tests can run without a page.
// ---------------------------------------------------------------------------

/**
 * How near (m) a recorded post has to be before it is treated as where the
 * vehicle, or a sign, is. Recorded posts are nearly always within 150 m of
 * the next and seldom more than 300 m, so a vehicle on a stretch whose posts
 * are recorded is well inside this. Further away (off the network, or in one
 * of the few long gaps in the records) the nearest post is still shown, but
 * only as the nearest record: never as confirmed.
 */
export const NEAR_POST_M = 250;

/** The shortest of the limits above: the one for a moving vehicle. */
const STALE_MOVING_MS = staleAfterMs(HEADING_MIN_SPEED + 1);

/**
 * True when a position read at `fixAt` (ms) is no longer current at `now`,
 * by the one rule above. `unseen` is for a position from before the app was
 * put away: the vehicle may have driven off since, so its last speed no
 * longer earns the longer limits and the moving limit applies until a new fix
 * arrives.
 */
export function positionStale(fixAt, speed, now, unseen = false) {
  const limit = unseen ? Math.min(staleAfterMs(speed), STALE_MOVING_MS) : staleAfterMs(speed);
  return now - fixAt > limit;
}

/** Accuracy (m) beyond which a fix cannot tell one post from the next: about half the gap between posts. */
export const POOR_ACCURACY_M = 50;
/** With no fix for this long (ms), the first page gives the age of its reading in words, whatever the speed. */
export const QUIET_AFTER_MS = 30000;

/**
 * What the screens may say about the latest fix at `now`. `fix` is the
 * position as the platform handed it over, `fixAt` its own time (ms), and
 * `unseen` is as for positionStale.
 *   ageMs     how long ago it was read
 *   stale     no longer current: only the last known position
 *   quiet     no fix for QUIET_AFTER_MS. A standing vehicle's position stays
 *             current for longer than that, so its age is put in words first.
 *   accuracy  in metres, or null when the phone gave no figure (nought or
 *             less is no figure at all)
 *   poor      a real fix, too vague for its post to be relied on
 */
export function fixState(fix, fixAt, now, unseen = false) {
  const ageMs = now - fixAt;
  const accuracy = fix.accuracy > 0 ? fix.accuracy : null;
  return {
    ageMs,
    stale: positionStale(fixAt, fix.speed, now, unseen),
    quiet: ageMs >= QUIET_AFTER_MS,
    accuracy,
    poor: !fix.simulated && accuracy != null && accuracy > POOR_ACCURACY_M,
  };
}

/** An age (seconds) in round figures for a small label: "15 s" (in fives, never less than "5 s"), "3 min", "1.5 h". */
export const shortAge = (s) => (s < 60 ? `${Math.max(5, Math.floor(s / 5) * 5)} s`
  : s < 3600 ? `${Math.floor(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/**
 * The first page's callout about the reading itself, from what fixState
 * returned; '' when there is nothing to warn of. A last known post keeps the
 * caution its fix earned: a rough reading does not become a sound one by
 * getting older.
 */
export function fixAlert({ ageMs, stale, accuracy, poor }) {
  const rough = poor ? `±${Math.round(accuracy)} m` : '';
  if (stale) return `No GPS update for ${shortAge(ageMs / 1000)} · last known post${rough && ` · GPS was ${rough}`}`;
  return rough && `GPS accuracy ${rough} · the post may be wrong`;
}

/**
 * The line the phone's widgets and notification show under a post that is
 * further away than NEAR_POST_M, in place of the post's own (postContext):
 * "Nearest recorded post · 1.24 km away". It says how far away the post is
 * and nothing else: not that the vehicle is off the road, which is not known.
 * The phone's own trackers write the same words.
 */
export const farContext = (dist) => `Nearest recorded post · ${fmtDist(dist)} away`;

/**
 * A fix whose reported accuracy is worse than this (m) is not handed to the
 * phone's widgets at all. They cannot carry the caution the first page shows
 * beside a poor fix, and the phone's own trackers ignore such a fix too: the
 * posts are 100 m apart, so a rougher position cannot tell one from the next.
 */
export const MAX_USABLE_ACCURACY_M = 100;
/** False for a fix that rough. A fix with no accuracy figure is accepted, as the trackers accept it. */
export const accuracyUsable = (accuracy) => !(accuracy > MAX_USABLE_ACCURACY_M);

/** Fixes further apart than this (ms) are a gap, and the vehicle may have turned round in it. The moving limit again. */
export const CONFIRM_GAP_MS = STALE_MOVING_MS;
/** After stopping, the carriageway stays confirmed within this distance (m) of where the heading last chose it. */
export const CONFIRM_REACH_M = 300;

/**
 * Whether the carriageway of the nearest post is confirmed, for one reading:
 * `post`, `dist` and `headingUsed` from findNearest, the fix's `lat` and
 * `lng`, and `at`, the fix's own time (ms).
 *
 * It is confirmed when the direction of travel chose it. After stopping it
 * stays confirmed while the nearest post is still on the same carriageway and
 * the vehicle has not moved far: you cannot change carriageway without
 * driving. That only holds while fixes keep coming, so a gap of more than
 * CONFIRM_GAP_MS between two fixes forgets it. And a post further away than
 * NEAR_POST_M (`far`) is only the nearest record: never confirmed, whatever
 * the heading. All of this changes the label only, never which post is
 * reported.
 *
 * `memory` is what the last call returned as `memory`: null to start with, or
 * to forget. Returns { confirmed, far, memory }.
 */
export function confirmCarriageway(memory, { post, dist, headingUsed, lat, lng, at }) {
  let held = memory && at - memory.at <= CONFIRM_GAP_MS ? memory.held : null;
  const far = dist > NEAR_POST_M;
  let confirmed = false;
  if (!far && headingUsed) {
    held = { road: post.road, direction: post.direction, lat, lng };
    confirmed = true;
  } else if (!far && held) {
    confirmed = held.road === post.road && held.direction === post.direction &&
      haversine(lat, lng, held.lat, held.lng) < CONFIRM_REACH_M;
  }
  return { confirmed, far, memory: { held, at } };
}

/**
 * The caution under the first page's list for one reading, or '' when there
 * is none to give: `post` and `dist` from findNearest, `confirmed` and `far`
 * from confirmCarriageway.
 *
 * `byTravel` says the direction of travel was in use (headingUsable). The
 * posts of a carriageway flowing the other way were then passed over, so the
 * post shown is the nearest for that direction, and a nearer one can be
 * alongside: long stretches of the A31 and A34 have recorded posts on one
 * carriageway only. So a post is called the nearest, by position only, just
 * when the direction of travel played no part. Nothing here says the vehicle
 * is off the road: that is not known.
 */
export function postCaution({ post, dist, confirmed, far, byTravel }) {
  if (far) {
    return byTravel
      ? `Nearest recorded post for your direction of travel is ${fmtDist(dist)} away. Check the carriageway.`
      : `Nearest recorded post is ${fmtDist(dist)} away, by position only. Check the carriageway.`;
  }
  // A reference with no carriageway letter in it gives nothing to check.
  if (confirmed || !parseRef(post.ref)) return '';
  // In use, and still not confirmed: the post left has no direction of its
  // own to compare (an interchange link, for one).
  return byTravel ? 'Not confirmed by your direction of travel. Check the carriageway.'
    : 'Nearest post by position only. Check the carriageway.';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const twoDigits = (n) => String(n).padStart(2, '0');

/**
 * A time of day for a small label: "09:52". When it was not today the date
 * goes in front, "14 Nov, 09:52" (with the year when that differs too), so an
 * old time can never be read as today's. Local time, like every clock in the
 * app. Empty for something that is not a time.
 */
export function fmtClock(ms, now = Date.now()) {
  const when = new Date(ms), today = new Date(now);
  if (Number.isNaN(when.getTime())) return '';
  const time = `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`;
  if (when.toDateString() === today.toDateString()) return time;
  const year = when.getFullYear() === today.getFullYear() ? '' : ` ${when.getFullYear()}`;
  return `${when.getDate()} ${MONTHS[when.getMonth()]}${year}, ${time}`;
}

/**
 * Read a typed post into its parts. The parts can come in any order, and the
 * reference with or without its "P" and its carriageway letter:
 *   "M27 13.6 A", "M27 13.6A", "M27 P13/6A", "M27 13/6A", "13/6 A M27", "M27 20/9"
 * Returns { road, dist, dir }; each is null when it was not typed. `road` is
 * in the form the post records use ("A3M" for the A3(M)).
 */
export function parseQuickEntry(text) {
  const s = String(text == null ? '' : text).trim().toUpperCase();
  const token = (s.match(/\b(A\d+\(M\)|[AM]\d+M?)/) || [])[0] || null;
  // Take the road out first, so its digits and letter are not read as the
  // distance or the carriageway.
  const rest = token ? s.replace(token, ' ') : s;
  let dist = null, dir = null, letters = rest;
  // The reference as the posts carry it, "13/6": kilometres, then tenths.
  // Read as a plain number it would lose the tenths and find the wrong post.
  const ref = rest.match(/P?(\d+)\s*\/\s*(\d)(?:\s*([A-Z])\b)?/);
  if (ref) {
    dist = Number(`${ref[1]}.${ref[2]}`);
    dir = ref[3] || null;
    letters = rest.replace(ref[0], ' ');
  } else {
    const plain = rest.match(/(\d+(?:\.\d+)?)/);
    if (plain) dist = parseFloat(plain[1]);
  }
  if (!dir) {
    // A letter standing alone, or the last thing typed (the M271 uses L and M,
    // links use J and K, so any letter can be a carriageway).
    const alone = letters.match(/\b([A-Z])\b/) || letters.match(/([A-Z])\s*$/);
    if (alone) dir = alone[1];
  }
  return { road: token ? token.replace('(M)', 'M') : null, dist, dir };
}

// ---- sign cards ----

/** The carriageway letter in a sign's own identifier: "M27/9232B" -> "B". Null when it carries none. */
export function signLetter(id) {
  const m = /\/\d+([A-Z])\d*$/.exec(String(id == null ? '' : id).trim());
  return m ? m[1] : null;
}

/** Road names compared without their punctuation: "A3(M)" and "A3M" are one road. */
const roadKey = (road) => String(road || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The recorded post to name on a sign's card. A sign's identifier carries its
 * road and carriageway letter ("M27/9232B"), so the post is looked for among
 * the posts of that road and letter; an interchange post counts for the roads
 * it joins. The nearest post by position alone will not do: the two
 * carriageways' posts sit metres apart, and it is often the other one's.
 * Returns null when no post is within NEAR_POST_M, otherwise
 * { post, dist, matched }. `matched` false means no post of the sign's own
 * road and letter was that close, so this one is the nearest by position only.
 */
export function postForSign(sign, posts) {
  if (!sign || sign.lat == null || sign.lng == null) return null;
  const letter = signLetter(sign.id);
  if (letter) {
    const roads = new Set([roadKey(sign.road), roadKey(String(sign.id).split('/')[0])]);
    roads.delete('');
    let best = null, bestD = Infinity;
    for (const p of posts) {
      if (p.direction !== letter) continue;
      if (!roads.has(p.road) && !(p.roadAliases && p.roadAliases.some((a) => roads.has(roadKey(a))))) continue;
      const d = haversine(sign.lat, sign.lng, p.lat, p.lng);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD <= NEAR_POST_M) return { post: best, dist: bestD, matched: true };
  }
  const { post, dist } = findNearest(posts, sign.lat, sign.lng, null, null, false);
  return post && dist <= NEAR_POST_M ? { post, dist, matched: false } : null;
}

/**
 * The words a sign's card uses for that post. A post of the sign's own road
 * and carriageway is "near P23/2B"; any other is said to be the nearest by
 * position. The post's road is given when it is not the sign's, and an
 * interchange post keeps its caveat. Empty when there is no post to name.
 */
export function signPostNote(sign, found) {
  if (!found || !found.post) return '';
  const { post, matched } = found;
  const extra = [];
  if (roadKey(post.road) !== roadKey(sign && sign.road)) extra.push(roadLabel(post.road));
  if (post.link) extra.push('survey date unknown');
  const where = `${post.ref}${extra.length ? ` (${extra.join(', ')})` : ''}`;
  return matched ? `near ${where}` : `nearest post by position: ${where}`;
}

/**
 * What a sign's distance was measured from, in words. Only a current, real
 * position is "you". A last known one is said to be so, with its time
 * (`fixAt`, ms), and so is one made up for desk testing.
 */
export function measuredFrom({ stale = false, simulated = false, fixAt }, now = Date.now()) {
  if (simulated) return 'from the simulated position';
  return stale ? `from your last known position (${fmtClock(fixAt, now)})` : 'from you';
}

// ---- how fresh the sign messages are ----

/** For this long (ms) after the live relay answered, the Signs screen may say "Live". */
export const SIGNS_LIVE_MS = 90 * 1000;
/** With no successful check for this long (ms), it warns that messages may have changed. */
export const SIGNS_OLD_MS = 30 * 60 * 1000;

const dataStamp = (data) => { const t = Date.parse(data && data.fetched); return Number.isFinite(t) ? t : 0; };

/**
 * The Signs screen's record of the messages it is showing:
 *   data           the feed's payload, or null before anything has loaded
 *   origin         'live' (the relay), 'network' (the published snapshot,
 *                  downloaded), 'saved' or 'bundled' (a copy on the device)
 *   loadedAt       when a 'live' or 'network' copy was downloaded (ms); else 0
 *   refreshFailed  the latest attempt to refresh brought nothing from the network
 */
export const NO_SIGNS = Object.freeze({ data: null, origin: null, loadedAt: 0, refreshFailed: false });

/**
 * That record after one attempt to refresh. `got` is what the attempt came
 * back with, { data, origin }, or null when it came back with nothing.
 * A download always replaces what is on screen. A copy from the device does so
 * only when it is at least as new, so losing the connection cannot swap
 * minute-old messages for a copy that may be days old. Either way a failed
 * refresh is recorded, so the screen can never go on saying "Live".
 */
export function signsAfterLoad(prev, got, now) {
  if (got && (got.origin === 'live' || got.origin === 'network')) {
    return { data: got.data, origin: got.origin, loadedAt: now, refreshFailed: false };
  }
  if (got && (!prev.data || dataStamp(got.data) >= dataStamp(prev.data))) {
    return { data: got.data, origin: got.origin, loadedAt: 0, refreshFailed: true };
  }
  return { ...prev, refreshFailed: true };
}

/**
 * What the Signs screen may claim about that record at `now`.
 * `pollerLastRun` is when the scheduled job that writes the snapshot last ran
 * (ms), when that is known.
 *   live       draw the "Live" flag: the relay answered within SIGNS_LIVE_MS
 *              and no refresh has failed since
 *   caution    'saved' or 'bundled': a copy on the device, not refreshed;
 *              'kept': downloaded earlier, and the latest refresh failed;
 *              'old': no successful check for SIGNS_OLD_MS; otherwise null
 *   checkedAt  when the messages were last known to be up to date (ms), or null
 */
export function signsFreshness(record, now, pollerLastRun = null) {
  const { data, origin, loadedAt, refreshFailed } = record;
  const checkedAt = origin === 'live' ? loadedAt : origin === 'network' ? (pollerLastRun || null) : null;
  let caution = null;
  if (origin === 'saved' || origin === 'bundled') caution = origin;
  else if (refreshFailed) caution = 'kept';
  else if (now - (checkedAt ?? dataStamp(data)) > SIGNS_OLD_MS) caution = 'old';
  return {
    live: origin === 'live' && !refreshFailed && now - loadedAt < SIGNS_LIVE_MS,
    caution,
    checkedAt,
  };
}
