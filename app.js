// Marker Post — app shell: nearest post, signs, vehicle lookup, go to post.
// The nearest-post maths lives in core/posts.js; this file is presentation
// and wiring only. The map is loaded on demand from map.js.

import config from './config.js';
import * as P from './platform.js';
import { loadBundled, loadSnapshot } from './data.js';
import { onThemeChange, setTheme, themeChoice } from './theme.js';
import { el, h, setText, show } from './dom.js';
import * as diagnostics from './diagnostics.js';
import { haversine } from './core/geo.js';
import {
  computeTravelBearings, findNearest, nearestJunction, junctionLabel, nearestERA,
  buildRef, parseRef, roadLabel, roadClass, buildJunctionChainage, junctionSection,
  fmtDist, HEADING_MIN_SPEED,
} from './core/posts.js';

// ---------- small helpers ----------
let toastTimer = null;
function toast(message, ms = 5000) {
  const t = el('toast');
  t.textContent = message;
  show(t, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), ms);
}

const WARN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4.5M12 17.5v.5"/></svg>';
/** Fill a callout with a fixed icon and a plain-text message. */
function setCallout(node, message) {
  node.innerHTML = WARN_ICON; // constant markup, no data
  node.append(h('span', { text: message }));
}

// ---------- data ----------
let POSTS = [];
let JUNCTIONS = [];
let ERAS = []; // Emergency Refuge Areas — only present on smart-motorway roads.
let junctionIndex = new Map();
const byRoad = new Map();
let lastPos = null;       // latest GPS fix
let lastFixAt = 0;        // when it arrived (ms)
let lastFoundPost = null; // go-to result
let currentView = 'nearest';

async function loadData() {
  const [posts, junctions, eras] = await Promise.all([
    loadBundled('posts.json', { cache: 'force-cache' }),
    loadBundled('junctions.json', { cache: 'force-cache' }),
    loadBundled('eras.json', { cache: 'force-cache' }),
  ]);
  POSTS = posts;
  // Retain unusual interchange road names and original link labels. They are
  // real source records, but their survey date / physical presence is unknown.
  try {
    const supplemental = await loadBundled('posts-supplemental.json', { cache: 'no-cache' });
    if (Array.isArray(supplemental.posts)) POSTS.push(...supplemental.posts);
  } catch { /* The core post tools still work if the optional supplement fails. */ }
  JUNCTIONS = junctions;
  ERAS = eras;
  for (const p of POSTS) {
    if (!byRoad.has(p.road)) byRoad.set(p.road, []);
    byRoad.get(p.road).push(p);
  }
  computeTravelBearings(POSTS);
  junctionIndex = buildJunctionChainage(POSTS, JUNCTIONS);
}

// ---------- the big post display (shared by Nearest and Go to) ----------
const landscapeQuery = window.matchMedia('(orientation: landscape) and (max-height: 540px)');
const heroMax = () => (landscapeQuery.matches ? 150 : 140);
const fitCache = new WeakMap();

/** Scale the number-and-carriageway pair so it always fits its container. */
function fitPost(elem, maxPx) {
  const parent = elem.parentElement;
  if (!parent) return;
  const cs = getComputedStyle(parent);
  const avail = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // Unmeasurable (view hidden): leave it; switchView refits when it is shown.
  if (!(avail > 0)) return;
  const key = `${elem.textContent}|${avail}|${maxPx}`;
  if (fitCache.get(elem) === key) return;
  elem.style.fontSize = '100px';
  const natural = elem.getBoundingClientRect().width;
  if (natural > 0) elem.style.fontSize = `${Math.max(40, Math.min(maxPx, Math.floor((100 * avail) / natural)))}px`;
  fitCache.set(elem, key);
}

/** Paint road badge, chainage and carriageway chip for a recorded post. */
function paintPost(ids, post, { confirmed = true, maxPx }) {
  const badge = el(ids.road);
  setText(badge, roadLabel(post.road));
  badge.dataset.class = roadClass(post.road);
  const km = el(ids.km), chip = el(ids.chip), letter = el(ids.letter);
  const parts = parseRef(post.ref);
  if (parts) {
    setText(km, parts.km);
    km.classList.remove('post-verbatim');
    setText(letter, parts.letter);
    chip.classList.remove('none');
    chip.classList.toggle('unconfirmed', !confirmed);
    chip.setAttribute('aria-label', `Carriageway ${parts.letter}${confirmed ? '' : ', not confirmed'}`);
  } else {
    // Not in the recorded P<km>/<tenth><letter> form: show it exactly as recorded.
    setText(km, post.ref);
    km.classList.add('post-verbatim');
    chip.classList.add('none');
  }
  fitPost(el(ids.fit), maxPx);
}

const NP = { road: 'np-road', km: 'np-km', chip: 'np-chip', letter: 'np-letter', fit: 'np-post' };
const RP = { road: 'r-road', km: 'r-km', chip: 'r-chip', letter: 'r-letter', fit: 'r-post' };

// ---------- nearest view ----------

// The carriageway is "confirmed" when the direction of travel chose it. After
// stopping, it stays confirmed while the nearest post is still on the same
// carriageway and the vehicle has not moved far: you cannot change
// carriageway without driving. This only changes the label, never which post
// is reported.
let lastConfirmed = null; // { road, direction, lat, lng }
function carriagewayConfirmed(post, headingUsed, pos) {
  if (headingUsed) {
    lastConfirmed = { road: post.road, direction: post.direction, lat: pos.lat, lng: pos.lng };
    return true;
  }
  return Boolean(lastConfirmed) && lastConfirmed.road === post.road &&
    lastConfirmed.direction === post.direction &&
    haversine(pos.lat, pos.lng, lastConfirmed.lat, lastConfirmed.lng) < 300;
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB');

// Hand the post on screen to the native apps' widgets: when it changes, and
// otherwise every 15 seconds so their "last updated" time stays honest.
const ROAD_CLASS_CODE = { motorway: 'M', 'a-road': 'A', other: 'O' };
let publishedKey = '', publishedAt = 0;
function publishPost(post, context, confirmed) {
  if (!P.isNative) return;
  const key = `${post.road}|${post.ref}|${context}|${confirmed}`, now = Date.now();
  if (key === publishedKey && now - publishedAt < 15000) return;
  publishedKey = key; publishedAt = now;
  const parts = parseRef(post.ref);
  P.publishPost({
    road: roadLabel(post.road), roadClass: ROAD_CLASS_CODE[roadClass(post.road)],
    km: parts ? parts.km : '', letter: parts ? parts.letter : '', ref: post.ref,
    context, confirmed, fixTime: lastFixAt,
  });
}

function renderNearest() {
  const p = lastPos;
  if (!p || !POSTS.length) return;
  const useHeading = el('heading-toggle').checked;
  const { post, dist, headingUsed } = findNearest(POSTS, p.lat, p.lng, p.heading, p.speed, useHeading);
  if (!post) return;
  const confirmed = carriagewayConfirmed(post, headingUsed, p);
  paintPost(NP, post, { confirmed, maxPx: heroMax() });

  // Third line: the junction section where the records support one; otherwise
  // the nearest junction; otherwise nothing. Never a guess.
  const section = junctionSection(post, junctionIndex);
  const nj = nearestJunction(JUNCTIONS, p.lat, p.lng, post.road);
  const sectionEl = el('np-section');
  let junctionInHero = false;
  if (post.link) {
    setText(sectionEl, `Link ${post.link}`);
    sectionEl.classList.add('fallback');
  } else if (section) {
    setText(sectionEl, section.label);
    sectionEl.classList.remove('fallback');
  } else if (nj) {
    setText(sectionEl, `${junctionLabel(post.road, nj.jct.jct)} · ${fmtDist(nj.dist)}`);
    sectionEl.classList.add('fallback');
    junctionInHero = true;
  } else {
    setText(sectionEl, '');
  }

  setText(el('np-sub'),
    `Post ${post.ref} · ${fmtDist(dist)} away, straight-line${post.link ? ' · source survey date unknown' : ''}`);
  const note = el('np-note');
  const byPositionOnly = !confirmed && Boolean(parseRef(post.ref));
  if (byPositionOnly) setText(note, 'Nearest post by position only. Check the carriageway.');
  show(note, byPositionOnly);

  const row = el('np-jct-row');
  if (nj && !junctionInHero) {
    setText(el('np-jct'), junctionLabel(post.road, nj.jct.jct));
    setText(el('np-jct-dist'), fmtDist(nj.dist));
    show(row, true);
  } else {
    show(row, false);
  }

  // ERA row: only shows on smart motorways (the only roads with ERA data),
  // and prefers the nearest bay ahead in the direction of travel.
  const eraRow = el('np-era-row');
  const ne = nearestERA(ERAS, p.lat, p.lng, post.road, post.direction, p.heading, p.speed, useHeading);
  if (ne) {
    setText(el('np-era'), `≈ ${buildRef(ne.era.km, ne.era.dir)}`);
    setText(el('np-era-dist'), ne.ahead ? `${fmtDist(ne.dist)} ahead` : fmtDist(ne.dist));
    show(eraRow, true);
  } else {
    show(eraRow, false);
  }
  setText(el('np-meta'), `Updated ${clock(lastFixAt)}`);
  publishPost(post, sectionEl.textContent, confirmed);
}

// GPS quality: green = trust it, amber = marginal, red = poor/unknown.
function setGps(state, text) {
  const dot = el('gps-dot');
  dot.classList.remove('live', 'wait', 'err');
  if (state) dot.classList.add(state);
  setText(el('gps-text'), text);
}

function onFix(fix) {
  lastPos = fix;
  lastFixAt = Date.now();
  const acc = fix.accuracy;
  if (fix.simulated) setGps('wait', 'Simulated');
  else setGps(acc == null ? 'wait' : acc <= 10 ? 'live' : acc <= 25 ? 'wait' : 'err',
    acc == null ? 'GPS' : `GPS ±${Math.round(acc)} m`);
  el('hero').dataset.state = 'live';
  show(el('np-alert'), false);
  window.dispatchEvent(new CustomEvent('markerpost:position', { detail: lastPos }));
  renderNearest();
}

function onGeoError(err) {
  const blocked = err.code === 1, none = err.code === 0;
  setGps('err', none ? 'No GPS' : blocked ? 'Location blocked' : 'GPS error');
  if (!lastPos) {
    el('hero').dataset.state = 'error';
    setText(el('np-sub'), none ? 'No geolocation on this device.'
      : blocked ? 'Location is blocked. Allow location for Marker Post in Settings.'
        : 'No GPS position yet.');
  }
}

const shortAge = (s) => (s < 60 ? `${Math.max(5, Math.floor(s / 5) * 5)} s`
  : s < 3600 ? `${Math.floor(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

// A post that is no longer being updated must not look current. Moving, a
// gap of 15 s matters (the post changes every few seconds); stationary, the
// post cannot change, so only a long silence is flagged.
function checkStale() {
  if (!lastPos) return;
  const age = (Date.now() - lastFixAt) / 1000;
  const limit = lastPos.speed == null ? 30 : lastPos.speed > HEADING_MIN_SPEED ? 15 : 120;
  const hero = el('hero');
  if (age > limit) {
    hero.dataset.state = 'stale';
    const alert = el('np-alert');
    setText(alert, `No GPS update for ${shortAge(age)} · last known post`);
    show(alert, true);
    setGps('err', 'No GPS update');
  } else if (hero.dataset.state === 'stale') {
    hero.dataset.state = 'live';
    show(el('np-alert'), false);
  }
}

function startGeo() {
  setGps('wait', 'Acquiring…');
  P.watchPosition(onFix, onGeoError);
}

// ---------- go-to-post view ----------
function populateRoads() {
  const sel = el('g-road');
  const roads = [...byRoad.keys()].sort((a, b) => {
    // motorways first, then A-roads, both ascending
    const ma = a[0] === 'M', mb = b[0] === 'M';
    if (ma !== mb) return ma ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  sel.replaceChildren(...roads.map((r) => h('option', { value: r, text: roadLabel(r) })));
  onRoadChange();
}

// Always offer the standard carriageways (mainline A/B + slip links J/K/L/M),
// plus any other letters present in the data — so a slip can always be entered.
const STD_DIRS = ['A', 'B', 'J', 'K', 'L', 'M'];

function onRoadChange() {
  const road = el('g-road').value;
  const posts = byRoad.get(road) || [];
  const present = new Set(posts.map((p) => p.direction));
  const extras = [...present].filter((d) => !STD_DIRS.includes(d)).sort();
  const dirs = [...STD_DIRS, ...extras];
  el('g-dir').replaceChildren(...dirs.map((d) => h('option', { value: d, text: d })));

  // Default to a carriageway we actually have posts for (prefer A, then B).
  const counts = {};
  for (const p of posts) counts[p.direction] = (counts[p.direction] || 0) + 1;
  el('g-dir').value = present.has('A') ? 'A' : present.has('B') ? 'B'
    : [...present].sort((a, b) => counts[b] - counts[a])[0] || 'A';

  const ds = posts.map((p) => p.distance).sort((a, b) => a - b);
  setText(el('g-hint'), ds.length
    ? `${roadLabel(road)}: ${ds[0]}–${ds[ds.length - 1]} km · posts on ${[...present].sort().join('/')}`
    : '');
}

function findPost() {
  const road = el('g-road').value;
  const dist = parseFloat(el('g-dist').value);
  const dir = el('g-dir').value;
  const result = el('g-result');
  if (!road || Number.isNaN(dist) || !dir) {
    setText(el('g-hint'), 'Enter road, distance and direction.');
    show(result, false);
    return;
  }
  const posts = byRoad.get(road) || [];
  const nearestBy = (list, d) =>
    list.reduce((b, p) => (b && Math.abs(b.distance - d) <= Math.abs(p.distance - d) ? b : p), null);

  const onDir = posts.filter((p) => p.direction === dir);
  const ref = buildRef(dist, dir);
  let match = onDir.find((p) => p.ref === ref) || null;
  if (!match) {
    const interchangeMatches = POSTS.filter((p) => p.ref === ref && p.roadAliases?.includes(road.replace('A3M', 'A3(M)')));
    if (interchangeMatches.length === 1) match = interchangeMatches[0];
  }
  let mode = match ? 'exact' : '';
  if (!match && onDir.length) {
    match = nearestBy(onDir, dist);
    mode = Math.abs(match.distance - dist) < 0.001 ? 'exact' : 'offdist';
  }
  if (!match) {
    // Carriageway has no posts (e.g. a slip we lack data for): fall back to the
    // nearest post at this chainage on any carriageway (the adjacent mainline).
    match = nearestBy(posts, dist);
    mode = 'slip';
  }

  lastFoundPost = match;
  show(result, true); // reveal first so the number can be measured and fitted
  const warn = el('r-detail-warn'), card = el('r-card'), waze = el('r-waze'), mapBtn = el('r-map');
  if (!match) {
    setCallout(warn, `No ${roadLabel(road)} posts in dataset.`);
    show(warn, true); show(card, false); show(waze, false); show(mapBtn, false);
    return;
  }
  show(card, true); show(waze, true); show(mapBtn, true);
  paintPost(RP, match, { confirmed: true, maxPx: 76 });
  const off = Math.abs(match.distance - dist);
  const sectionEl = el('r-section');
  sectionEl.classList.toggle('warn', mode !== 'exact');
  if (mode === 'exact') {
    show(warn, false);
    setText(sectionEl, junctionSection(match, junctionIndex)?.label || (match.link ? `Link ${match.link}` : ''));
    setText(el('r-detail'),
      `${roadLabel(match.road)} · carriageway ${match.direction} · ${match.distance} km · post ${match.ref}${match.link ? ' · source survey date unknown' : ''}`);
    P.haptic('success');
  } else if (mode === 'offdist') {
    setCallout(warn, `No ${roadLabel(road)}/${dir} post at ${dist} km — nearest is ${match.ref} (${match.distance} km, ${off.toFixed(1)} km away). Check the carriageway and distance.`);
    show(warn, true);
    setText(sectionEl, 'Nearest recorded post');
    setText(el('r-detail'), `${roadLabel(match.road)} · carriageway ${match.direction} · ${match.distance} km · post ${match.ref}`);
    P.haptic('warning');
  } else {
    setCallout(warn, `No recorded post for ${roadLabel(road)} carriageway ${dir}. Showing ${match.ref} on carriageway ${match.direction} as a nearby reference only. This does not locate the requested slip road.`);
    show(warn, true);
    setText(sectionEl, 'Nearby reference only');
    setText(el('r-detail'), `${roadLabel(match.road)} · carriageway ${match.direction} · ${match.distance} km · post ${match.ref}`);
    P.haptic('warning');
  }
  waze.href = `https://waze.com/ul?ll=${match.lat},${match.lng}&navigate=yes`;
}

// "M27 13.6 A" / "M27 13.6A" / "P13/6A M27"
function parseQuick(s) {
  s = s.trim().toUpperCase();
  if (!s) return;
  const road = (s.match(/\b(A\d+\(M\)|[AM]\d+M?)/) || [])[0];
  // Remove the road token first so its digits/letter don't get read as distance/dir.
  const rest = road ? s.replace(road, ' ') : s;
  let dist, dir;
  const ref = s.match(/P(\d+)\/(\d)\s*([A-Z])/);
  if (ref) {
    dist = parseFloat(ref[1]) + parseFloat(ref[2]) / 10;
    dir = ref[3];
  } else {
    const dm = rest.match(/(\d+(?:\.\d+)?)/);
    if (dm) dist = parseFloat(dm[1]);
    // carriageway letter: any standalone/trailing A–Z (M271 uses L/M, links J/K…)
    const dirm = rest.match(/\b([A-Z])\b/) || rest.match(/([A-Z])\s*$/);
    if (dirm) dir = dirm[1];
  }
  if (road && byRoad.has(road.replace('(M)', 'M'))) {
    el('g-road').value = road.replace('(M)', 'M');
    onRoadChange();
  }
  if (dist != null && !Number.isNaN(dist)) el('g-dist').value = dist;
  if (dir) {
    const opt = [...el('g-dir').options].find((o) => o.value === dir);
    if (opt) el('g-dir').value = dir;
  }
}

// ---------- VMS signs view ----------
// Live relay first (sub-minute freshness); otherwise the published snapshot
// (refreshed by the scheduled job); offline, the last saved copy. The header
// always says which of those is on screen.
let VMS = null;
let vmsOrigin = null;      // 'live' | 'network' | 'saved' | 'bundled'
let pollerLastRun = null;  // when the scheduled job last succeeded (ms)
let pollerAskedAt = 0;
let vmsLoading = false;

async function loadVms() {
  if (vmsLoading) return;
  vmsLoading = true;
  try {
    try {
      const r = await P.getJson(config.vmsLiveUrl, { timeoutMs: 8000 });
      if (!r.ok || !r.data || !Array.isArray(r.data.signs)) throw new Error('bad payload');
      VMS = r.data;
      vmsOrigin = 'live';
      renderSigns();
      return;
    } catch { /* relay unreachable: fall back to the snapshot */ }

    try {
      const snap = await loadSnapshot('vms.json', {
        stamp: (d) => d.fetched,
        validate: (d) => Boolean(d && Array.isArray(d.signs)),
        timeoutMs: 8000,
      });
      VMS = snap.data;
      vmsOrigin = snap.origin;
    } catch { /* offline with nothing saved — keep whatever we had */ }

    // The snapshot only changes when signs change, so its timestamp is "last
    // change", not "last check". When the snapshot was downloaded just now,
    // ask GitHub when the poller last ran green. Asked at most every five
    // minutes: it is a public, rate-limited API.
    if (vmsOrigin === 'network' && Date.now() - pollerAskedAt > 5 * 60 * 1000) {
      pollerAskedAt = Date.now();
      try {
        const r = await fetch(config.vmsRunsUrl);
        const runs = (await r.json()).workflow_runs;
        if (runs && runs.length) pollerLastRun = new Date(runs[0].updated_at).getTime();
      } catch { /* keep last known */ }
    }
    renderSigns();
  } finally {
    vmsLoading = false;
  }
}

function fmtAge(min) {
  if (min < 1.5) return 'just now';
  if (min < 90) return `${Math.round(min)} min ago`;
  const hours = min / 60;
  if (hours < 36) return `${hours.toFixed(hours < 10 ? 1 : 0)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// Filter state, persisted so the tab opens the way you left it.
// roads: [] = all roads; blanks: false hides signs displaying nothing.
const VMS_FILTER_KEY = 'vms-filter';
let vmsFilter = { roads: [], blanks: false };
try {
  vmsFilter = { ...vmsFilter, ...JSON.parse(localStorage.getItem(VMS_FILTER_KEY) || '{}') };
  if (!Array.isArray(vmsFilter.roads)) vmsFilter.roads = [];
} catch { /* corrupt state — fall back to defaults */ }
const saveVmsFilter = () => { try { localStorage.setItem(VMS_FILTER_KEY, JSON.stringify(vmsFilter)); } catch { /* not saved */ } };

// Filter groups: each sign belongs to its road, except the M3, which splits at
// J7 into the usual patch (J7–14) and the northern end (J4–7). The boundary
// chainage comes from snapping J7 to its nearest post; each sign's chainage
// from snapping the sign the same way.
let m3SplitKm = null;
const signKm = new Map(); // sign id -> chainage on its road
function signGroup(s) {
  if (s.road !== 'M3' || s.lat == null) return s.road;
  const m3 = byRoad.get('M3') || [];
  if (!m3.length) return s.road;
  const snap = (lat, lng) => {
    let best = null, bd = Infinity;
    for (const p of m3) {
      const d = haversine(lat, lng, p.lat, p.lng);
      if (d < bd) { bd = d; best = p; }
    }
    return best.distance;
  };
  if (m3SplitKm == null) {
    const j7 = JUNCTIONS.find((j) => j.road === 'M3' && j.jct === 'J7');
    if (!j7) return s.road;
    m3SplitKm = snap(j7.lat, j7.lng);
  }
  if (!signKm.has(s.id)) signKm.set(s.id, snap(s.lat, s.lng));
  return signKm.get(s.id) >= m3SplitKm - 0.3 ? 'M3 J7-14' : 'M3 J4-7';
}

// Each sign is located against our own dataset: the nearest marker post.
const signNear = new Map(); // sign id -> post ref or null
function nearestPostRef(s) {
  if (s.lat == null) return null;
  const key = `${s.id}|${s.lat}|${s.lng}`;
  if (!signNear.has(key)) {
    const { post, dist } = findNearest(POSTS, s.lat, s.lng, null, null, false);
    signNear.set(key, post && dist <= 250 ? post.ref : null);
  }
  return signNear.get(key);
}

function renderSigns() {
  const list = el('s-list'), meta = el('s-meta'), stale = el('s-stale'), chips = el('s-filters');
  if (!VMS || !VMS.fetched || !VMS.signs) {
    setText(meta, VMS && !VMS.fetched
      ? 'No sign data yet — the update feed hasn\'t run.'
      : 'No sign data available.');
    show(stale, false);
    show(chips, false);
    list.replaceChildren();
    return;
  }
  const age = (Date.now() - new Date(VMS.fetched).getTime()) / 60000; // since the signs last changed
  // Staleness = time since the feed was last checked (if known), not since the
  // signs last changed — a quiet hour on the network isn't stale data.
  const checkedAt = vmsOrigin === 'live' ? Date.now() : vmsOrigin === 'network' ? pollerLastRun : null;
  const checkedAge = checkedAt ? (Date.now() - checkedAt) / 60000 : null;
  if (vmsOrigin === 'saved' || vmsOrigin === 'bundled') {
    setCallout(stale, `${vmsOrigin === 'bundled' ? 'Copy shipped with the app' : 'Saved copy'}, not refreshed. Signs last changed ${fmtAge(age)} — messages may have changed since.`);
    show(stale, true);
  } else {
    const effAge = checkedAge ?? age;
    if (effAge > 30) {
      setCallout(stale, `No successful update for ${fmtAge(effAge).replace(' ago', '')} — messages may have changed since.`);
      show(stale, true);
    } else {
      show(stale, false);
    }
  }

  // Filter chips: one per road (motorways first) + a blank-signs toggle.
  const counts = {};
  for (const s of VMS.signs) { const g = signGroup(s); counts[g] = (counts[g] || 0) + 1; }
  const roads = Object.keys(counts).sort((a, b) => {
    const ma = a[0] === 'M', mb = b[0] === 'M';
    if (ma !== mb) return ma ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  vmsFilter.roads = vmsFilter.roads.filter((r) => counts[r]); // drop stale roads
  const sel = vmsFilter.roads;
  const chip = (label, pressed, onclick, count) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(pressed), onclick,
  }, label, count != null ? h('small', { text: String(count) }) : null);
  const rerender = () => { saveVmsFilter(); P.haptic('selection'); renderSigns(); };
  chips.replaceChildren(
    chip('All', !sel.length, () => { vmsFilter.roads = []; rerender(); }),
    ...roads.map((r) => chip(roadLabel(r).replace('-', '–'), sel.includes(r), () => {
      vmsFilter.roads = sel.includes(r) ? sel.filter((x) => x !== r) : [...sel, r];
      rerender();
    }, counts[r])),
    chip('Blank signs', vmsFilter.blanks, () => { vmsFilter.blanks = !vmsFilter.blanks; rerender(); }),
  );
  show(chips, true);

  // Apply filters; nearest-first when we have a fix, else the feed's road order.
  const signs = VMS.signs
    .filter((s) =>
      (!sel.length || sel.includes(signGroup(s))) &&
      (vmsFilter.blanks || (s.lines && s.lines.length)))
    .map((s) => ({
      ...s,
      d: lastPos && s.lat != null ? haversine(lastPos.lat, lastPos.lng, s.lat, s.lng) : null,
    }));
  if (lastPos) signs.sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));

  const summary = `${signs.length} of ${VMS.signs.length} signs`;
  meta.replaceChildren(
    ...(vmsOrigin === 'live' ? [h('span', { class: 'live-flag' }, h('i', { class: 'dot live' }), 'Live')] : []),
    h('span', {
      text: vmsOrigin === 'live' ? `${summary} · updated ${fmtAge(age)}`
        : vmsOrigin === 'network' && checkedAge != null ? `${summary} · checked ${fmtAge(checkedAge)} · last change ${fmtAge(age)}`
          : vmsOrigin === 'network' ? `${summary} · updated ${fmtAge(age)}`
            : `${summary} · last change ${fmtAge(age)}`,
    }),
  );
  list.replaceChildren(...(signs.length
    ? signs.map(signCard)
    : [h('div', { class: 'signs-empty', text: `No signs match the filter${vmsFilter.blanks ? '' : ' (blank signs are hidden)'}.` })]));
}

function signCard(s) {
  const status = String(s.status || '').trim();
  const off = status !== 'working'; // blank/covered/notWorking — flag it
  const hasText = s.lines && s.lines.length;
  const panel = h('div', { class: 'sign-panel' },
    hasText ? s.lines.map((l) => h('div', { class: 'sign-line', text: l }))
      : h('div', { class: 'sign-blank', text: 'blank' }));

  const bits = [String(s.id)];
  const near = nearestPostRef(s);
  if (near) bits.push(`near ${near}`);
  if (s.d != null) bits.push(`${fmtDist(s.d)} from you`);
  const set = s.setAt && !Number.isNaN(Date.parse(s.setAt))
    ? new Date(s.setAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;
  if (set && hasText) bits.push(`set ${set}`);

  return h('div', { class: `sign-card${off ? ' off' : ''}` },
    panel,
    h('div', { class: 'sign-info' },
      h('div', { class: 'sign-road' },
        h('b', { text: roadLabel(s.road || '?') }),
        s.dir ? ` ${s.dir}` : null,
        off ? [' · ', h('span', { class: 'warn', text: status })] : null),
      h('div', { class: 'sign-sub', text: bits.join(' · ') })));
}

// ---------- vehicle lookup view ----------
// Registration in -> make/model/age/colour/fuel/class + tax & MOT badges.
// All API work happens in the vehicle-lookup Worker (worker-vehicle/), which
// holds the DVLA/DVSA credentials and merges both records into one payload.
let vehBusy = false;

async function lookupVehicle() {
  if (vehBusy) return;
  const reg = el('v-reg').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = el('v-result');
  const message = (text) => out.replaceChildren(h('div', { class: 'veh-msg warn', text }));
  if (!/^[A-Z0-9]{2,7}$/.test(reg)) {
    message('Enter a registration (2–7 letters/numbers).');
    return;
  }
  vehBusy = true;
  const btn = el('v-find');
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  try {
    const res = await P.getJson(`${config.vehicleUrl}?reg=${encodeURIComponent(reg)}`, { timeoutMs: 12000 });
    const data = res.data || {};
    if (res.status === 404) message(`No record found for ${reg}.`);
    else if (!res.ok) message(`Lookup failed: ${data.error || `HTTP ${res.status}`}`);
    else out.replaceChildren(vehicleCard(data));
  } catch {
    message('Can\'t reach the lookup relay — check your connection.');
  } finally {
    vehBusy = false;
    btn.disabled = false;
    btn.textContent = 'Look up';
  }
}

function vehicleCard(v) {
  const badge = (name, b) => {
    const cls = b.ok === true ? 'ok' : b.ok === false ? 'bad' : 'na';
    const label = !b.status || b.status === 'UNKNOWN' ? '—' : b.status;
    return h('div', { class: `veh-badge ${cls}` }, h('small', { text: name }), label);
  };
  const chips = [
    v.colour, v.fuel,
    v.vclass && (v.vclass.label + (v.vclass.detail ? ` · ${v.vclass.detail}` : '')),
    v.year && `${v.year}${v.age != null ? ` · ${v.age} yr${v.age === 1 ? '' : 's'}` : ''}`,
  ].filter(Boolean);
  const title = [v.make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle';
  const notes = v.notes || [];
  return h('div', { class: 'veh-card' },
    h('div', { class: 'veh-plate', text: v.reg || '' }),
    h('div', { class: 'veh-title', text: title }),
    h('div', { class: 'veh-chips' }, chips.map((c) => h('span', { class: 'veh-chip', text: c }))),
    h('div', { class: 'veh-badges' }, badge('TAX', v.tax || {}), badge('MOT', v.mot || {})),
    notes.length ? h('div', { class: 'veh-notes', text: notes.join(' ') }) : null);
}

// ---------- tabs ----------
const ALL_VIEWS = ['nearest', 'map', 'signs', 'vehicle', 'goto'];
const viewEnabled = (v) => ALL_VIEWS.includes(v) && (v !== 'vehicle' || config.features.vehicle);

let networkMapPromise;
function openNetworkMap(post) {
  if (!networkMapPromise) {
    networkMapPromise = import('./map.js').then((m) => m.initMap({
      posts: POSTS, junctions: JUNCTIONS, position: lastPos,
    })).catch((err) => {
      networkMapPromise = null;
      el('map-app').replaceChildren(h('div', { class: 'map-loading', role: 'status',
        text: 'The map could not load. Check your connection and reopen the Map tab.' }));
      throw err;
    });
  }
  networkMapPromise.then((map) => {
    map.show();
    if (post) map.selectPost(post);
  }).catch((err) => {
    console.error('Map:', err);
    diagnostics.note('error', `Map failed to open: ${err?.message || err}`);
  });
}

function switchView(view, { announce = true } = {}) {
  if (!viewEnabled(view)) view = 'nearest';
  const changed = view !== currentView;
  currentView = view;
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.view === view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  for (const v of ALL_VIEWS) show(el(`view-${v}`), v === view);
  document.body.classList.toggle('map-active', view === 'map');
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  if (changed && announce) P.haptic('selection');
  if (view === 'signs') loadVms(); // refresh data + check age on every open
  if (view === 'map') openNetworkMap();
  if (view === 'nearest') {
    // GPS updates that arrived while this view was hidden could not be
    // measured (width read 0) — refit now that it is on screen.
    if (lastPos) renderNearest();
    fitPost(el('np-post'), heroMax());
  }
  if (view === 'goto' && !el('g-result').classList.contains('hidden')) fitPost(el('r-post'), 76);
  if (view !== 'map') el('app').scrollTop = 0;
}

// ---------- sheets ----------
function initSheets() {
  // "Done" buttons, and a tap on the dimmed area outside a sheet, close it.
  document.addEventListener('click', (e) => {
    const closer = e.target.closest?.('[data-close]');
    if (closer) { closer.closest('dialog')?.close(); return; }
    if (e.target instanceof HTMLDialogElement && e.target.classList.contains('sheet')) e.target.close();
  });
  el('open-about').addEventListener('click', () => { paintDiagnostics(); el('about-sheet').showModal(); });
  el('diag-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(diagnostics.report()); toast('Diagnostics copied.'); }
    catch { toast('Copy is unavailable here.'); }
  });
  diagnostics.onChange(() => { if (el('about-sheet').open) paintDiagnostics(); });
}

function paintDiagnostics() {
  const n = diagnostics.problemCount();
  setText(el('diag-summary'), n
    ? `${n} problem${n === 1 ? '' : 's'} recorded since the app opened. Copying includes the app version and device type, never your position.`
    : 'No problems recorded since the app opened.');
}

// ---------- appearance ----------
function initTheme() {
  const buttons = [...el('theme-control').querySelectorAll('[data-theme-choice]')];
  const paint = () => {
    const choice = themeChoice();
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  };
  for (const b of buttons) {
    b.addEventListener('click', () => { setTheme(b.dataset.themeChoice); paint(); P.haptic('selection'); });
  }
  paint();
  onThemeChange((dark) => P.setSystemBars(dark), { immediate: true });
}

// ---------- live tracking (native apps only) ----------
const LIVE_REASONS = {
  'location-denied': 'Live tracking needs location permission. Allow it for Marker Post in Settings.',
  'location-disabled': 'Location Services are switched off on this phone.',
  'location-imprecise': 'Live tracking needs Precise Location. Turn it on for Marker Post in Settings.',
  'activities-disabled': 'Live Activities are switched off for Marker Post in Settings.',
  'notifications-denied': 'Live tracking needs notification permission to show the post.',
  'no-data': 'The marker post data could not be read.',
  unsupported: 'Live tracking is not available on this version of the system.',
};
let liveActive = false;

async function initLive() {
  if (!P.live.supported) return;
  const btn = el('live-toggle'), note = el('live-note'), label = el('live-label');
  const ios = P.platform === 'ios';
  show(el('about-live'), true);
  setText(el('about-live-text'), ios
    ? 'Live tracking shows the nearest post on the Lock Screen, in the Dynamic Island and on the CarPlay Dashboard, using location in the background. iPhone ends a Live Activity after 8 hours; the app schedules a follow-on where the system allows and otherwise asks you to reopen it. The post is looked up on the phone from the bundled data, so it works with no signal.'
    : 'Live tracking shows the nearest post in a notification that stays live with the screen off, and keeps the home screen widget current. It uses location while the notification is showing and stops when you tap Stop. The post is looked up on the phone from the bundled data, so it works with no signal.');
  const paint = (s) => {
    liveActive = Boolean(s && s.active);
    btn.setAttribute('aria-pressed', String(liveActive));
    btn.classList.toggle('btn-primary', !liveActive);
    btn.classList.toggle('btn-live-on', liveActive);
    setText(label, liveActive ? 'Stop live tracking' : 'Start live tracking');
    setText(note, liveActive
      ? (ios ? 'Live on the Lock Screen, Dynamic Island and CarPlay.' : 'Live in your notifications, with the screen off too.')
      : '');
    show(note, liveActive);
  };
  show(btn, true);
  paint(await P.live.status());
  P.live.onChange(paint);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const wasActive = liveActive;
    const s = wasActive ? await P.live.stop() : await P.live.start({ useHeading: el('heading-toggle').checked });
    btn.disabled = false;
    paint(s);
    if (!wasActive && !liveActive) {
      toast(LIVE_REASONS[s?.reason] || 'Live tracking could not start.');
      P.haptic('warning');
    } else {
      P.haptic(liveActive ? 'success' : 'light');
    }
  });
}

// ---------- online/offline ----------
function updateOnline() {
  show(el('offline'), !navigator.onLine);
}

// ---------- init ----------
async function init() {
  initTheme();
  initSheets();
  show(el('tab-vehicle'), config.features.vehicle);
  setText(el('about-version'), `Version ${config.version} · ${config.target === 'native' ? `${P.platform} app` : 'web app'} · build ${config.build}`);
  if (config.map?.basemap?.attribution) {
    const basemap = el('about-basemap');
    basemap.replaceChildren('Base map: ',
      h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener', text: config.map.basemap.attribution }), '.');
  }

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => switchView(t.dataset.view));
  }
  P.onBackButton(() => {
    const open = [...document.querySelectorAll('dialog[open]')].pop();
    if (open) { open.close(); return true; }
    // The map closes its own search results or detail card first.
    if (currentView === 'map' && !window.dispatchEvent(new CustomEvent('markerpost:back', { cancelable: true }))) return true;
    if (currentView !== 'nearest') { switchView('nearest'); return true; }
    return false;
  });

  try {
    await loadData();
  } catch (e) {
    console.error('Post data:', e);
    diagnostics.note('error', `Post data failed to load: ${e?.message || e}`);
    setGps('err', 'No data');
    el('hero').dataset.state = 'error';
    setText(el('np-sub'), 'Failed to load post data.');
    return;
  }

  populateRoads();
  el('g-road').addEventListener('change', onRoadChange);
  el('g-find').addEventListener('click', findPost);
  el('g-quick').addEventListener('input', (e) => parseQuick(e.target.value));
  for (const id of ['g-quick', 'g-dist']) {
    el(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); findPost(); }
    });
  }

  const requested = location.hash.slice(1);
  if (requested && requested !== 'nearest' && viewEnabled(requested)) switchView(requested, { announce: false });
  window.addEventListener('hashchange', () => {
    const view = location.hash.slice(1) || 'nearest';
    if (view !== currentView && viewEnabled(view)) switchView(view, { announce: false });
  });

  el('np-map').addEventListener('click', () => {
    switchView('map');
    if (lastPos) {
      openNetworkMap(findNearest(POSTS, lastPos.lat, lastPos.lng,
        lastPos.heading, lastPos.speed, el('heading-toggle').checked).post);
    }
  });
  el('r-map').addEventListener('click', () => {
    const post = lastFoundPost;
    switchView('map');
    if (post) openNetworkMap(post);
  });

  // Direction-of-travel preference: remembered, and passed to live tracking.
  const headingToggle = el('heading-toggle');
  try { if (localStorage.getItem('mp-use-heading') === '0') headingToggle.checked = false; } catch { /* default on */ }
  headingToggle.addEventListener('change', () => {
    try { localStorage.setItem('mp-use-heading', headingToggle.checked ? '1' : '0'); } catch { /* not saved */ }
    if (!headingToggle.checked) lastConfirmed = null;
    P.live.update({ useHeading: headingToggle.checked });
    renderNearest();
  });

  // Vehicle lookup: uppercase as you type; Enter or the button submits.
  if (config.features.vehicle) {
    el('v-find').addEventListener('click', lookupVehicle);
    el('v-reg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); lookupVehicle(); }
    });
    el('v-reg').addEventListener('input', (e) => {
      const c = e.target.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
      if (c !== e.target.value) e.target.value = c;
    });
  }

  // VMS signs: initial load, manual refresh, and a ~30 s live re-poll while
  // the tab is open and on screen (the relay's edge cache absorbs the rest).
  loadVms();
  el('s-refresh').addEventListener('click', () => { P.haptic('light'); loadVms(); });
  setInterval(() => {
    if (currentView === 'signs' && document.visibilityState === 'visible') loadVms();
  }, 30 * 1000);

  // Deep link: ?q=M27 13.6 A  -> open go-to, prefill and look up.
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    switchView('goto', { announce: false });
    el('g-quick').value = q;
    parseQuick(q);
    findPost();
  }

  const refit = () => {
    fitPost(el('np-post'), heroMax());
    if (!el('g-result').classList.contains('hidden')) fitPost(el('r-post'), 76);
  };
  window.addEventListener('resize', refit);
  landscapeQuery.addEventListener('change', refit);

  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  // Keep the screen on while the app is open; re-acquire when it returns to
  // view (the lock is released when the page is hidden) or on first touch.
  P.keepAwake();
  P.onAppState((active) => {
    if (!active) return;
    P.keepAwake();
    checkStale(); // a post from before the phone was put away must not look current
  });
  document.addEventListener('click', () => P.keepAwake(), { once: true });
  setInterval(checkStale, 1000);

  startGeo();
  initLive();

  if (config.target === 'pwa' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
