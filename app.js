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
  computeTravelBearings, findNearest, headingUsable, nearestJunction, junctionLabel, nearestERA,
  buildRef, parseRef, roadLabel, roadClass, junctionSection, postContext, farContext, accuracyUsable,
  fmtDist, fmtClock, shortAge, positionStale, fixState, fixAlert, confirmCarriageway, postCaution, parseQuickEntry,
  signLetter, postForSign, signPostNote, measuredFrom, NO_SIGNS, signsAfterLoad, signsFreshness,
} from './core/posts.js';

// ---------- small helpers ----------
let toastTimer = null;
function toast(message, ms = 5000) {
  const t = el('toast');
  // An open sheet is drawn above everything else on the page, so the toast
  // goes inside it; otherwise it would appear underneath and never be seen.
  const home = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (t.parentElement !== home) home.append(t);
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
let SECTIONS = null;    // junction sections from National Highways' records (data/post-sections.json)
const byRoad = new Map();
let lastPos = null;       // latest GPS fix, exactly as the platform handed it over
let lastFixAt = 0;        // that fix's own time (ms), never later than now
let awaitingFix = false;  // back from the background, and no fresh fix has arrived yet
let geoProblem = '';      // what the last location error said; the next fix clears it
let lastFoundPost = null; // go-to result
let currentView = 'nearest';

async function loadData() {
  // The app works without these two, so neither may hold up the first post for long.
  const optional = (name) => loadBundled(name, { cache: 'no-cache', timeoutMs: 8000 }).catch(() => null);
  const [posts, junctions, eras, sections, supplemental] = await Promise.all([
    loadBundled('posts.json', { cache: 'force-cache' }),
    loadBundled('junctions.json', { cache: 'force-cache' }),
    loadBundled('eras.json', { cache: 'force-cache' }),
    // Made when the app is built, from National Highways' own section records.
    // Without it the junction-section row is simply not shown.
    optional('post-sections.json'),
    // Unusual interchange road names and original link labels. They are real
    // source records, but their survey date / physical presence is unknown.
    // The core post tools still work if this supplement fails.
    optional('posts-supplemental.json'),
  ]);
  SECTIONS = sections;
  // A new list, never the loaded one added to: a second try must not double it.
  POSTS = Array.isArray(supplemental?.posts) ? [...posts, ...supplemental.posts] : posts;
  JUNCTIONS = junctions;
  ERAS = eras;
  byRoad.clear();
  for (const p of POSTS) {
    if (!byRoad.has(p.road)) byRoad.set(p.road, []);
    byRoad.get(p.road).push(p);
  }
  computeTravelBearings(POSTS);
}

// ---------- the big post display (shared by Nearest and Go to) ----------
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

const RP = { road: 'r-road', km: 'r-km', chip: 'r-chip', letter: 'r-letter', fit: 'r-post' };

// ---------- nearest view ----------
// This page keeps the layout the app has always had (the owner prefers it):
// the post's reference as large as the screen allows, with the road beneath
// it and a short list. NP_MAX is the largest the reference is ever drawn, in
// pixels.
const NP_MAX = 158;

// The records put a "P" in front of every reference ("P20/9A"). The big text
// leaves it out, as the owner asked: "20/9A". A reference that is not in that
// form is shown exactly as recorded.
const bigRef = (ref) => String(ref).replace(/^P(?=\d)/, '');

// The carriageway is "confirmed" when the direction of travel chose it, or the
// vehicle has since stopped close by on the same carriageway. The rule is
// confirmCarriageway in core/posts.js; this is what it remembers from one fix
// to the next. It only changes the label, never which post is reported.
let confirmMemory = null;

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB');

// Hand the post on screen to the native apps' widgets: when it changes, and
// otherwise every 15 seconds so their "last updated" time stays honest. A
// long way from the post (`far`) the line under it gives a distance, which
// changes with every fix: that alone is handed over every 5 seconds, the
// pace the phone's own trackers keep.
const ROAD_CLASS_CODE = { motorway: 'M', 'a-road': 'A', other: 'O' };
let publishedKey = '', publishedAt = 0;
function publishPost(post, context, confirmed, far) {
  if (!P.isNative) return;
  const key = `${post.road}|${post.ref}|${far ? 'far' : context}|${confirmed}`, now = Date.now();
  if (key === publishedKey && now - publishedAt < (far ? 5000 : 15000)) return;
  publishedKey = key; publishedAt = now;
  const parts = parseRef(post.ref);
  P.publishPost({
    road: roadLabel(post.road), roadClass: ROAD_CLASS_CODE[roadClass(post.road)],
    km: parts ? parts.km : '', letter: parts ? parts.letter : '', ref: post.ref,
    context, confirmed, fixTime: lastFixAt,
  });
}

// What the first page is showing, kept for the lines that change with the clock.
let shown = null; // { post, far }

function renderNearest() {
  const p = lastPos;
  if (!p || !POSTS.length) return;
  const useHeading = el('heading-toggle').checked;
  const { post, dist, headingUsed } = findNearest(POSTS, p.lat, p.lng, p.heading, p.speed, useHeading);
  if (!post) return;
  // The post found can be a long way off (`far`): away from the network, or
  // on a stretch with no recorded posts for this direction of travel. It is
  // still shown, but never as confirmed, and nothing is said about the
  // junction section or the emergency areas of a carriageway the vehicle may
  // not be on.
  const { confirmed, far, memory } = confirmCarriageway(confirmMemory,
    { post, dist, headingUsed, lat: p.lat, lng: p.lng, at: lastFixAt });
  confirmMemory = memory;
  shown = { post, far };

  const ref = el('np-ref');
  setText(ref, bigRef(post.ref));
  ref.dataset.confirmed = String(confirmed);
  fitPost(ref, NP_MAX);
  setText(el('np-road'), roadLabel(post.road));
  setText(el('np-dist'), fmtDist(dist));

  // The junction section, as National Highways' record of this stretch of
  // carriageway describes it. No record, no row: never a guess.
  const section = post.link || far ? null : junctionSection(post, SECTIONS);
  setText(el('np-section-lbl'), section?.kind === 'within' ? 'Within junction' : 'Between junctions');
  setText(el('np-section'), section ? (section.kind === 'within' ? section.at : section.label) : '');
  show(el('np-section-row'), Boolean(section));

  const row = el('np-jct-row');
  const nj = nearestJunction(JUNCTIONS, p.lat, p.lng, post.road);
  if (nj) {
    setText(el('np-jct'), junctionLabel(post.road, nj.jct.jct));
    setText(el('np-jct-dist'), fmtDist(nj.dist));
    show(row, true);
  } else {
    show(row, false);
  }

  // ERA row: only shows on smart motorways (the only roads with ERA data),
  // and prefers the nearest bay ahead in the direction of travel.
  // Not offered a long way from the post: the bay is on that post's carriageway.
  const eraRow = el('np-era-row');
  const ne = far ? null : nearestERA(ERAS, p.lat, p.lng, post.road, post.direction, p.heading, p.speed, useHeading);
  if (ne) {
    setText(el('np-era'), `≈ ${buildRef(ne.era.km, ne.era.dir)}`);
    setText(el('np-era-dist'), ne.ahead ? `${fmtDist(ne.dist)} ahead` : fmtDist(ne.dist));
    show(eraRow, true);
  } else {
    show(eraRow, false);
  }

  // The caution under the list. A carriageway that is not confirmed is said
  // to be so, and so is a post that is a long way off. The words (postCaution
  // in core/posts.js) go by whether the direction of travel was in use for
  // this reading: it passes over the posts of a carriageway flowing the other
  // way, so the post it leaves is not always the nearest of all. (The line
  // above it, with the time of the reading, is written by showFixState.)
  const note = el('np-note');
  const caution = postCaution({ post, dist, confirmed, far, byTravel: headingUsable(p.heading, p.speed, useHeading) });
  if (caution) setText(note, caution);
  show(note, Boolean(caution));

  // What the phone's widgets and notification show under the post: the same
  // line the phone's own trackers use. It describes the post, not the
  // vehicle; a long way from the post it says only how far away the post is.
  // A fix too rough for those surfaces is not handed over at all: they
  // cannot carry the caution this page shows beside it.
  if (accuracyUsable(p.accuracy)) {
    publishPost(post, far ? farContext(dist) : postContext(post, SECTIONS, JUNCTIONS), confirmed, far);
  }
}

// GPS quality: green = trust it, amber = marginal, red = poor/unknown. The
// first page always shows the words. The other tabs show them (`flag`) only
// when the position is not a current, good, real one.
const DOT_STATES = ['live', 'wait', 'err'];
function setGps(state, text, { accuracy = '', flag = false } = {}) {
  const paint = (dot, label) => {
    // This runs every second, so only a dot that has changed is touched.
    for (const s of DOT_STATES) dot.classList.toggle(s, s === state);
    setText(label, text);
  };
  paint(el('gps-dot'), el('gps-text'));
  setText(el('gps-acc'), accuracy);
  for (const pill of document.querySelectorAll('.gps-flag')) {
    paint(pill.firstElementChild, pill.lastElementChild);
    show(pill, flag);
  }
}

// The one word for the state of the position that every screen and both
// stylesheets go by, as body[data-gps]: 'wait' until there is a fix, 'live',
// 'stale' for a last known position, and 'off' when none can come until
// something is put right (location blocked or switched off, no geolocation,
// or the post data did not load).
let gpsState = '';
function setGpsState(state) {
  if (state === gpsState) return;
  gpsState = state;
  document.body.dataset.gps = state;
  // Signs sorts by the position and quotes distances from it: draw it again,
  // so that a last known position is labelled as one.
  if (currentView === 'signs' && vms.data) renderSigns();
}

function onFix(fix) {
  const now = Date.now();
  // The fix's own time, not the moment it reached the page: a position the
  // system kept from earlier must not pass as new.
  const at = Math.min(now, fix.timestamp || now);
  lastPos = fix;
  lastFixAt = at;
  geoProblem = '';
  // Only a fix read in the last few seconds ends the wait after a return.
  if (!positionStale(at, fix.speed, now, true)) awaitingFix = false;
  // The map takes the fix as it is: its own time, its speed and, for a
  // made-up position, its `simulated` mark.
  window.dispatchEvent(new CustomEvent('markerpost:position', { detail: fix }));
  renderNearest();
  showFixState();
  // Signs quotes each distance from the position and puts the nearest first:
  // draw it again once the vehicle is 100 m from where the list was drawn
  // (about every 3 s at motorway speed, never while standing).
  if (currentView === 'signs' && vms.data && gpsState === 'live'
    && (!signsDrawnFrom || haversine(fix.lat, fix.lng, signsDrawnFrom.lat, signsDrawnFrom.lng) > 100)) renderSigns();
}

function onGeoError(err) {
  // The phone apps: location has been allowed, or switched on, again and the
  // watch is looking for a position. Nothing is wrong any more, so nothing
  // may go on saying it is.
  if (err.reason === 'looking') {
    geoProblem = '';
    if (lastPos) { showFixState(); return; }
    setGps('wait', 'Acquiring…');
    setGpsState('wait');
    el('hero').dataset.state = 'waiting';
    setText(el('np-meta'), 'Waiting for GPS…');
    return;
  }
  const none = err.code === 0, blocked = err.code === 1;
  // The phone apps also say when location is switched off for the whole phone.
  const off = err.reason === 'location-off';
  geoProblem = none ? 'No GPS' : blocked ? 'Location blocked' : off ? 'Location off' : 'GPS error';
  setGps('err', geoProblem, { flag: true });
  if (!lastPos) {
    // A passing problem is still a wait: the watch goes on trying.
    setGpsState(none || blocked || off ? 'off' : 'wait');
    el('hero').dataset.state = 'error';
    setText(el('np-meta'), none ? 'No geolocation on this device.'
      : blocked ? 'Location is blocked. Allow location for Marker Post in Settings.'
        : off ? 'Location Services are switched off on this phone.'
          : 'No GPS position yet.');
  }
}

// Everything the screens say about the position itself, worked out from the
// last fix and the clock: on every fix, and once a second. A post that is no
// longer being updated must not look current, and a post read from a poor
// fix, or a long way from the vehicle, must not look like a sure one. The
// rules are fixState, fixAlert and staleAfterMs in core/posts.js, the same
// for every screen.
function showFixState() {
  if (!lastPos) return;
  const state = fixState(lastPos, lastFixAt, Date.now(), awaitingFix);
  const { ageMs, stale, quiet, accuracy, poor } = state;

  if (stale) setGps('err', 'No GPS update', { flag: true });
  else if (geoProblem) setGps('err', geoProblem, { flag: true });
  // A made-up position must never be mistaken for a real one.
  else if (lastPos.simulated) setGps('wait', 'Simulated', { flag: true });
  else {
    setGps(accuracy == null ? 'wait' : accuracy <= 10 ? 'live' : accuracy <= 25 ? 'wait' : 'err', poor ? 'Poor GPS' : 'Live',
      { accuracy: accuracy == null ? '' : `±${Math.round(accuracy)} m`, flag: poor });
  }
  setGpsState(stale ? 'stale' : 'live');
  if (!shown) return;

  // The big reference dims whenever it is not a current, sure reading.
  const hero = el('hero'), look = stale ? 'stale' : poor ? 'poor' : shown.far ? 'far' : 'live';
  if (hero.dataset.state !== look) hero.dataset.state = look;
  // The callout: no update, or a rough fix. A last known post that was read
  // from a rough fix says both: its caution does not lapse with age.
  const alert = el('np-alert'), warning = fixAlert(state);
  if (warning) setText(alert, warning);
  show(alert, Boolean(warning));

  // The line under the list: when the post was read, and what the reader
  // should know about it. After half a minute with no fix the age is put in
  // words whatever the speed, well before a standing vehicle's post dims.
  const ago = quiet ? `${shortAge(ageMs / 1000)} ago` : '';
  const { link } = shown.post;
  const meta = el('np-meta');
  setText(meta, [
    link ? `${link} · source survey date unknown` : `updated ${clock(lastFixAt)}`,
    ago && (link ? `updated ${ago}` : ago),
    'distances are straight-line',
  ].filter(Boolean).join(' · '));
  meta.classList.toggle('np-late', quiet);
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
    setText(sectionEl, junctionSection(match, SECTIONS)?.label || (match.link ? `Link ${match.link}` : ''));
    setText(el('r-detail'),
      `${roadLabel(match.road)} · carriageway ${match.direction} · ${match.distance} km · post ${match.ref}${match.link ? ' · source survey date unknown' : ''}`);
    P.haptic('success');
  } else if (mode === 'offdist') {
    // Both figures are marker distances from the records, not measured from the vehicle.
    setCallout(warn, `No ${roadLabel(road)}/${dir} post at ${dist} km — nearest is ${match.ref} (${match.distance} km, ${off.toFixed(1)} km from the distance entered). Check the carriageway and distance.`);
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

// Quick entry: fill the three fields from what was typed. parseQuickEntry in
// core/posts.js reads "M27 13.6 A", "M27 13.6A", "P13/6A M27" and the short
// form the first page shows, "M27 13/6A".
function parseQuick(text) {
  const { road, dist, dir } = parseQuickEntry(text);
  if (road && byRoad.has(road)) {
    el('g-road').value = road;
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
// always says which of those is on screen. A refresh that fails is recorded,
// so the screen can never go on saying "Live": the rules are signsAfterLoad
// and signsFreshness in core/posts.js.
let vms = NO_SIGNS;        // { data, origin, loadedAt, refreshFailed }
let pollerLastRun = null;  // when the scheduled job last succeeded (ms)
let pollerAskedAt = 0;
let vmsLoading = false;

async function loadVms() {
  // Work out the ages and the Live flag afresh straight away, whatever a
  // request is doing: nothing is left on screen as it was when last drawn.
  if (vms.data) renderSigns();
  if (vmsLoading) return;
  vmsLoading = true;
  try {
    try {
      const r = await P.getJson(config.vmsLiveUrl, { timeoutMs: 8000 });
      if (!r.ok || !r.data || !Array.isArray(r.data.signs)) throw new Error('bad payload');
      vms = signsAfterLoad(vms, { data: r.data, origin: 'live' }, Date.now());
      renderSigns();
      return;
    } catch { /* relay unreachable: fall back to the snapshot */ }

    let snap = null;
    try {
      snap = await loadSnapshot('vms.json', {
        stamp: (d) => d.fetched,
        validate: (d) => Boolean(d && Array.isArray(d.signs)),
        timeoutMs: 8000,
      });
    } catch { /* offline with nothing saved: keep whatever is on screen */ }
    vms = signsAfterLoad(vms, snap, Date.now());
    // Draw now: the signs must not wait on the question that follows.
    renderSigns();

    // The snapshot only changes when signs change, so its timestamp is "last
    // change", not "last check". When the snapshot was downloaded just now,
    // ask GitHub when the poller last ran green. Asked at most every five
    // minutes: it is a public, rate-limited API.
    if (snap && snap.origin === 'network' && Date.now() - pollerAskedAt > 5 * 60 * 1000) {
      pollerAskedAt = Date.now();
      try {
        const r = await P.getJson(config.vmsRunsUrl, { timeoutMs: 8000 });
        const runs = r.data?.workflow_runs;
        if (runs && runs.length) {
          pollerLastRun = new Date(runs[0].updated_at).getTime();
          renderSigns();
        }
      } catch { /* keep last known */ }
    }
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

// Each sign is located against our own dataset: a post on the sign's own road
// and carriageway or, failing that, the nearest by position, said to be so.
let signsDrawnFrom = null; // the position the Signs list was last drawn from
const signNear = new Map(); // sign id and position -> { post, dist, matched } or null
function signPost(s) {
  // Signs can open before the post data has loaded. "No post" must not be
  // remembered for a sign then, or it would stay that way all session.
  if (!POSTS.length) return null;
  const key = `${s.id}|${s.lat}|${s.lng}`;
  if (!signNear.has(key)) signNear.set(key, postForSign(s, POSTS));
  return signNear.get(key);
}

function renderSigns() {
  const list = el('s-list'), meta = el('s-meta'), stale = el('s-stale'), chips = el('s-filters');
  const feed = vms.data;
  if (!feed || !feed.fetched || !feed.signs) {
    setText(meta, feed && !feed.fetched
      ? 'No sign data yet — the update feed hasn\'t run.'
      : 'No sign data available.');
    show(stale, false);
    show(chips, false);
    list.replaceChildren();
    return;
  }
  const now = Date.now();
  const age = (now - new Date(feed.fetched).getTime()) / 60000; // since the signs last changed
  // Staleness = time since the feed was last checked (if known), not since the
  // signs last changed — a quiet hour on the network isn't stale data. A copy
  // that a refresh has just failed to replace is said to be so at once.
  const fresh = signsFreshness(vms, now, pollerLastRun);
  const checkedAge = fresh.checkedAt ? (now - fresh.checkedAt) / 60000 : null;
  if (fresh.caution === 'saved' || fresh.caution === 'bundled') {
    setCallout(stale, `${fresh.caution === 'bundled' ? 'Copy shipped with the app' : 'Saved copy'}, not refreshed. Signs last changed ${fmtAge(age)} — messages may have changed since.`);
  } else if (fresh.caution === 'kept') {
    setCallout(stale, `Could not refresh. Showing the copy loaded at ${fmtClock(vms.loadedAt, now)} — messages may have changed since.`);
  } else if (fresh.caution === 'old') {
    setCallout(stale, `No successful update for ${fmtAge(checkedAge ?? age).replace(' ago', '')} — messages may have changed since.`);
  }
  show(stale, Boolean(fresh.caution));

  // Filter chips: one per road (motorways first) + a blank-signs toggle.
  const counts = {};
  for (const s of feed.signs) { const g = signGroup(s); counts[g] = (counts[g] || 0) + 1; }
  const roads = Object.keys(counts).sort((a, b) => {
    const ma = a[0] === 'M', mb = b[0] === 'M';
    if (ma !== mb) return ma ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  // Drop roads no longer in the feed. Not before the post data is in: until
  // then the M3 cannot be split at J7, and a saved M3 group would be lost.
  if (POSTS.length) vmsFilter.roads = vmsFilter.roads.filter((r) => counts[r]);
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

  // Apply filters. Nearest first only from a current position: from a last
  // known one the list keeps the feed's road order, and each distance says
  // what it was measured from.
  const lastKnown = gpsState === 'stale';
  const signs = feed.signs
    .filter((s) =>
      (!sel.length || sel.includes(signGroup(s))) &&
      (vmsFilter.blanks || (s.lines && s.lines.length)))
    .map((s) => ({
      ...s,
      d: lastPos && s.lat != null ? haversine(lastPos.lat, lastPos.lng, s.lat, s.lng) : null,
    }));
  if (lastPos && !lastKnown) signs.sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));
  signsDrawnFrom = lastPos;
  const from = lastPos ? measuredFrom({ stale: lastKnown, simulated: lastPos.simulated, fixAt: lastFixAt }, now) : '';

  const summary = `${signs.length} of ${feed.signs.length} signs`;
  const loaded = `loaded ${fmtAge((now - vms.loadedAt) / 60000)}`;
  const lastChange = `last change ${fmtAge(age)}`;
  meta.replaceChildren(
    ...(fresh.live ? [h('span', { class: 'live-flag' }, h('i', { class: 'dot live' }), 'Live')] : []),
    h('span', {
      text: fresh.caution === 'kept' ? `${summary} · ${loaded}${vms.origin === 'network' ? ` · ${lastChange}` : ''}`
        : vms.origin === 'live' ? `${summary} · updated ${fmtAge(age)}`
          : vms.origin === 'network' && checkedAge != null ? `${summary} · checked ${fmtAge(checkedAge)} · ${lastChange}`
            : vms.origin === 'network' ? `${summary} · updated ${fmtAge(age)}`
              : `${summary} · ${lastChange}`,
    }),
  );
  list.replaceChildren(...(signs.length
    ? signs.map((s) => signCard(s, from))
    : [h('div', { class: 'signs-empty', text: `No signs match the filter${vmsFilter.blanks ? '' : ' (blank signs are hidden)'}.` })]));
}

/** One sign. `from` says what its distance was measured from. */
function signCard(s, from) {
  const status = String(s.status || '').trim();
  const off = status !== 'working'; // blank/covered/notWorking — flag it
  const hasText = s.lines && s.lines.length;
  const panel = h('div', { class: 'sign-panel' },
    hasText ? s.lines.map((l) => h('div', { class: 'sign-line', text: l }))
      : h('div', { class: 'sign-blank', text: 'blank' }));

  const bits = [String(s.id)];
  const post = signPostNote(s, signPost(s));
  if (post) bits.push(post);
  if (s.d != null) bits.push(`${fmtDist(s.d)} ${from}, straight-line`);
  // With the date when it was not set today, so an old message never reads as today's.
  const set = s.setAt ? fmtClock(Date.parse(s.setAt)) : '';
  if (set && hasText) bits.push(`set ${set}`);

  // The carriageway is the letter in the sign's own identifier. The feed's
  // compass word (s.dir) is never shown.
  const letter = signLetter(s.id);
  return h('div', { class: `sign-card${off ? ' off' : ''}` },
    panel,
    h('div', { class: 'sign-info' },
      h('div', { class: 'sign-road' },
        h('b', { text: roadLabel(s.road || '?') }),
        letter ? ` · carriageway ${letter}` : null,
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
      // Back from the background with no fix since: the map holds that
      // position to the same limit as the first page.
      positionUnseen: awaitingFix,
    })).catch((err) => {
      networkMapPromise = null;
      // When the map has already said why it cannot start (a device that
      // cannot draw it, for one), its own words stay: a connection is not the cure.
      if (!err?.messageShown) {
        el('map-app').replaceChildren(h('div', { class: 'map-loading', role: 'status',
          text: 'The map could not load. Check your connection and reopen the Map tab.' }));
      }
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
    fitPost(el('np-ref'), NP_MAX);
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
    const report = diagnostics.report();
    try {
      await navigator.clipboard.writeText(report);
      // A report left on screen by an earlier refusal is out of date now.
      el('diag-text')?.remove();
      toast('Diagnostics copied.');
    } catch {
      // The clipboard was refused: put the text on screen, where it can be
      // selected by hand. It is the only way to get it off the phone.
      let box = el('diag-text');
      if (!box) {
        box = h('pre', { id: 'diag-text', class: 'licence-text' });
        el('diag-copy').after(box);
      }
      box.textContent = report;
      // It goes in below the button, usually off the bottom of the sheet: bring it up.
      box.scrollIntoView(false);
      toast('Copy is unavailable here. The text is below: press and hold to select it.');
    }
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
    b.addEventListener('click', () => { setTheme(b.dataset.themeChoice); P.haptic('selection'); });
  }
  // After every change, wherever it was made (the map's layers sheet has its
  // own control), so the buttons here always show the choice in force.
  onThemeChange((dark) => { paint(); P.setSystemBars(dark); }, { immediate: true });
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
    ? 'Live tracking shows the nearest post on the Lock Screen, in the Dynamic Island on phones that have one, and on the CarPlay Dashboard (CarPlay needs iOS 26 or later), using location in the background. iPhone ends a Live Activity after 8 hours; the app schedules a follow-on where the system allows and otherwise asks you to reopen it. The post is looked up on the phone from the bundled data, so it works with no signal.'
    : 'Live tracking shows the nearest post in a notification that stays live with the screen off, and keeps the home screen widget current. It uses location while the notification is showing and stops when you tap Stop. The post is looked up on the phone from the bundled data, so it works with no signal.');
  const paint = (s) => {
    liveActive = Boolean(s && s.active);
    btn.setAttribute('aria-pressed', String(liveActive));
    btn.classList.toggle('btn-primary', !liveActive);
    btn.classList.toggle('btn-live-on', liveActive);
    setText(label, liveActive ? 'Stop live tracking' : 'Start live tracking');
    setText(note, liveActive
      ? (ios ? 'Live on the Lock Screen, and in the Dynamic Island and on the CarPlay Dashboard where the phone has them.' : 'Live in your notifications, with the screen off too.')
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
    } else if (!wasActive && s?.reason === 'notifications-denied') {
      // Android: tracking runs without the permission, but there is nothing to see. Say so.
      toast('Tracking is on, but notifications are switched off for Marker Post, so the post cannot be shown. Allow them in Settings.');
      P.haptic('warning');
    } else if (wasActive && liveActive) {
      // The request to stop did not get through, so tracking may still be running. Say so.
      toast('Live tracking could not be stopped. Try again.');
      P.haptic('warning');
    } else {
      P.haptic(liveActive ? 'success' : 'light');
    }
  });
}

// ---------- open-source software ----------
// Third-party code in the app and the licence each is used under. The licence
// files ship with the app (vendor/), so they can be read with no signal.
const SOFTWARE = [
  ['MapLibre GL JS (map engine)', 'vendor/maplibre-gl/LICENSE.txt'],
  ['PMTiles (map file reader)', 'vendor/pmtiles/LICENSE'],
  ['Protomaps basemaps (map style)', 'vendor/protomaps-basemaps/LICENSE'],
  ['Noto Sans (lettering on the map)', 'vendor/basemaps-assets/fonts/OFL.txt'],
  ['Map symbols', 'vendor/basemaps-assets/sprites/LICENSE.md'],
];
function initSoftware() {
  const items = config.target === 'native'
    ? [...SOFTWARE, ['Capacitor (phone app shell)', 'vendor/capacitor/LICENSE']]
    : SOFTWARE;
  el('about-software-list').replaceChildren(...items.map(([name, file]) => {
    const text = h('pre', { class: 'licence-text', text: 'Loading…' });
    const item = h('details', { class: 'disclosure-item' }, h('summary', { text: name }), text);
    item.addEventListener('toggle', async () => {
      if (!item.open || item.dataset.loaded) return;
      item.dataset.loaded = '1';
      try {
        const res = await fetch(file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text.textContent = (await res.text()).trim();
      } catch {
        text.textContent = 'The licence text could not be loaded just now.';
        delete item.dataset.loaded;
      }
    });
    return item;
  }));
}

// ---------- online/offline ----------
// Said on every tab but the map, which has its own words for it.
function updateOnline() {
  for (const pill of document.querySelectorAll('#offline, .offline-flag')) show(pill, !navigator.onLine);
}

// ---------- init ----------
async function init() {
  setGpsState('wait');
  initTheme();
  initSheets();
  show(el('tab-vehicle'), config.features.vehicle);
  initSoftware();
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

  // Set up before the post data is asked for, because the app stops here if
  // that fails. Being offline is the likeliest reason, so the Offline pills
  // must still work. And Signs still opens, so it must go on checking its
  // messages (the Refresh button, and a ~30 s re-poll while the tab is open
  // and on screen; the relay's edge cache absorbs the rest): otherwise it
  // would go on saying "Live" for as long as it stayed open.
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();
  el('s-refresh').addEventListener('click', () => { P.haptic('light'); loadVms(); });
  setInterval(() => {
    if (currentView === 'signs' && document.visibilityState === 'visible') loadVms();
  }, 30 * 1000);

  // Vehicle lookup does not need the post data, so it works while that loads.
  // Uppercase as you type; Enter or the button submits.
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

  // The service worker keeps the app and its data for use without signal. It
  // is registered once the first try at the post data is over, so that on a
  // first visit the two downloads do not compete; but also when that try
  // failed, or the next visit would start from nothing as well.
  let workerAsked = false;
  const registerWorker = () => {
    if (workerAsked || config.target !== 'pwa' || !('serviceWorker' in navigator)) return;
    workerAsked = true;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  };

  // The post data. A first visit on a weak signal may not get it at the first
  // try: try again, every few seconds, for as long as the page is open. (A
  // second try joins a download that is still running.)
  for (let failures = 0; ; failures++) {
    try {
      await loadData();
      break;
    } catch (e) {
      registerWorker();
      if (!failures) {
        console.error('Post data:', e);
        diagnostics.note('error', `Post data failed to load: ${e?.message || e}`);
      }
      // "Post" data: this word is also shown on Signs, whose own data may be fine.
      setGps('err', 'No post data', { flag: true });
      setGpsState('off');
      el('hero').dataset.state = 'error';
      setText(el('np-meta'), 'Could not load the post data. Trying again…');
      await new Promise((resolve) => { setTimeout(resolve, 5000); });
    }
  }
  registerWorker();
  if (el('hero').dataset.state === 'error') {
    // A failed try said so on the first page: back to waiting for a position.
    setGps('wait', 'Acquiring…');
    setGpsState('wait');
    el('hero').dataset.state = 'waiting';
    setText(el('np-meta'), 'Waiting for GPS…');
  }
  // Signs may have been drawn before the posts were in: now each sign can name one.
  if (currentView === 'signs' && vms.data) renderSigns();

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
    if (!headingToggle.checked) confirmMemory = null;
    P.live.update({ useHeading: headingToggle.checked });
    renderNearest();
    showFixState(); // a different post may be nearer or further than the last
  });

  // VMS signs: the first load. (Refresh and the re-poll are set up above.)
  loadVms();

  // Deep link: ?q=M27 13.6 A  -> open go-to, prefill and look up.
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    switchView('goto', { announce: false });
    el('g-quick').value = q;
    parseQuick(q);
    findPost();
  }

  const refit = () => {
    fitPost(el('np-ref'), NP_MAX);
    if (!el('g-result').classList.contains('hidden')) fitPost(el('r-post'), 76);
  };
  window.addEventListener('resize', refit);
  window.matchMedia('(orientation: landscape)').addEventListener('change', refit);

  // Keep the screen on while the app is open; re-acquire when it returns to
  // view (the lock is released when the page is hidden) or on first touch.
  P.keepAwake();
  P.onAppState((active) => {
    if (!active) return;
    P.keepAwake();
    // A post from before the phone was put away must not look current: until
    // a fresh fix arrives it is held to the moving limit, whatever its speed was.
    awaitingFix = true;
    showFixState();
    // Nor may the Signs screen keep the ages it showed before.
    if (currentView === 'signs') loadVms();
  });
  document.addEventListener('click', () => P.keepAwake(), { once: true });
  setInterval(showFixState, 1000);

  startGeo();
  const liveReady = initLive().catch((e) => diagnostics.note('error', `Live tracking set-up failed: ${e?.message || e}`));
  // Links such as markerpost://map or markerpost://live/start (a Shortcuts automation
  // can use the last one to start tracking when the phone connects to the car).
  P.onAppLink(async (link) => {
    if (['nearest', 'map', 'signs', 'goto'].includes(link)) { switchView(link); return; }
    // A link can arrive before the tracking button knows whether a session is running.
    await liveReady;
    if (link === 'live/start') { switchView('nearest'); if (!liveActive) el('live-toggle').click(); }
    else if (link === 'live/stop') { if (liveActive) el('live-toggle').click(); }
  });
}

init();
