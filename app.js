"use strict";

// ---------- data ----------
let POSTS = [];
let JUNCTIONS = [];
let ERAS = []; // Emergency Refuge Areas — only present on smart-motorway roads.
let VMS = null; // Live VMS sign statuses (data/vms.json, refreshed by CI).
let lastPos = null; // Latest GPS fix, for distance-to-sign sorting.
const byRoad = new Map();

async function loadData() {
  const [pRes, jRes, eRes] = await Promise.all([
    fetch("data/posts.json", { cache: "force-cache" }),
    fetch("data/junctions.json", { cache: "force-cache" }),
    fetch("data/eras.json", { cache: "force-cache" }),
  ]);
  POSTS = await pRes.json();
  JUNCTIONS = await jRes.json();
  ERAS = await eRes.json();
  for (const p of POSTS) {
    if (!byRoad.has(p.road)) byRoad.set(p.road, []);
    byRoad.get(p.road).push(p);
  }
  computeTravelBearings();
}

// ---------- geo ----------
const R = 6371000; // m
const toRad = (d) => (d * Math.PI) / 180;

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180) / Math.PI; // -180..180
}

function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180); // 0..180
}

// Give each post a travel bearing = the direction traffic flows past it, so we
// can tell the two (anti-parallel) carriageways apart even though they sit only
// metres apart. The chainage order only gives the road's geographic line; the
// flow sign comes from drive-on-the-left geometry: the opposite carriageway is
// always on your right. We vote per carriageway rather than assuming A/B, since
// some roads label carriageways differently (e.g. M271 uses L/M).
function computeTravelBearings() {
  const groups = new Map(); // "road|dir" -> posts on that carriageway
  for (const p of POSTS) {
    const k = `${p.road}|${p.direction}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.distance - b.distance);
    const [road, dir] = k.split("|");
    const opp = POSTS.filter((q) => q.road === road && q.direction !== dir);
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

// Linear scan — a few thousand points is fast enough.
function findNearest(lat, lng, heading, speed, useHeading) {
  const filter =
    useHeading && heading != null && !Number.isNaN(heading) && speed != null && speed > 2.5;
  let best = null,
    bestD = Infinity;
  if (filter) {
    for (const p of POSTS) {
      // Keep posts whose carriageway flows roughly our way; this drops the
      // opposite carriageway (~180° off) that sits just metres to the side.
      // Posts with no travel bearing (e.g. single-carriageway slips) stay in.
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

// ---------- nearest view ----------
const el = (id) => document.getElementById(id);
const fmtDist = (m) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;

// Nearest junction on the given road (motorways only); null if none.
function nearestJunction(lat, lng, road) {
  let best = null, bestD = Infinity;
  for (const j of JUNCTIONS) {
    if (j.road !== road) continue;
    const d = haversine(lat, lng, j.lat, j.lng);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best ? { jct: best, dist: bestD } : null;
}

// "J5" -> "M27 J5"; "A3093" (connecting road) -> "A3093 jct"
function junctionLabel(road, jct) {
  return /^J/.test(jct) ? `${road} ${jct}` : `${jct} jct`;
}

// Nearest ERA on the SAME carriageway as the current post. You can't reverse on
// a motorway, so when heading is reliable we only consider bays AHEAD (within a
// 90° cone of travel) — if you've passed them all, the row hides. When too slow
// for a trustworthy heading we fall back to the nearest bay on the carriageway.
// Only smart-motorway roads have ERAs, so this stays empty off them.
function nearestERA(lat, lng, road, dir, heading, speed, useHeading) {
  const onCarriageway = ERAS.filter((e) => e.road === road && e.dir === dir);
  if (!onCarriageway.length) return null;
  const canHead =
    useHeading && heading != null && !Number.isNaN(heading) && speed != null && speed > 2.5;

  let best = null, bestD = Infinity;
  if (canHead) {
    for (const e of onCarriageway) {
      if (angleDiff(bearing(lat, lng, e.lat, e.lng), heading) > 90) continue; // behind us
      const d = haversine(lat, lng, e.lat, e.lng);
      if (d < bestD) { bestD = d; best = e; }
    }
    // None ahead → we've passed the last bay; show nothing rather than mislead.
    return best ? { era: best, dist: bestD, ahead: true } : null;
  }
  for (const e of onCarriageway) {
    const d = haversine(lat, lng, e.lat, e.lng);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? { era: best, dist: bestD, ahead: false } : null;
}

// Display label (A3M is the A3(M) motorway).
const roadLabel = (road) => (road === "A3M" ? "A3(M)" : road);

// Shrink text to fit the parent's content width (keeps it as large as possible).
// The element is centred in a flex column so it's only as wide as its text and
// overflows the parent — hence we measure against the parent, not the element.
function fitText(elem, maxPx) {
  elem.style.fontSize = maxPx + "px";
  const parent = elem.parentElement;
  const cs = getComputedStyle(parent);
  const avail = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const natural = elem.getBoundingClientRect().width;
  if (avail > 0 && natural > avail) {
    elem.style.fontSize = `${Math.floor((maxPx * avail) / natural)}px`;
  }
}

// Render a post into a hero block (marker post ref + road).
function paintSign(roadId, refId, post) {
  const refEl = el(refId);
  refEl.textContent = post.ref;
  fitText(refEl, 158);
  el(roadId).textContent = roadLabel(post.road);
}

function renderNearest(lat, lng, heading, speed, accuracy) {
  const useHeading = el("heading-toggle").checked;
  const { post, dist } = findNearest(lat, lng, heading, speed, useHeading);
  if (!post) return;
  paintSign("np-road", "np-ref", post);
  el("np-dist").textContent = fmtDist(dist);

  const row = el("np-jct-row");
  const nj = nearestJunction(lat, lng, post.road);
  if (nj) {
    el("np-jct").textContent = junctionLabel(post.road, nj.jct.jct);
    el("np-jct-dist").textContent = fmtDist(nj.dist);
    row.classList.remove("hidden");
  } else {
    row.classList.add("hidden");
  }

  // ERA row: only shows on smart motorways (the only roads with ERA data),
  // and prefers the nearest bay ahead in the direction of travel.
  const eraRow = el("np-era-row");
  const ne = nearestERA(lat, lng, post.road, post.direction, heading, speed, useHeading);
  if (ne) {
    el("np-era").textContent = `≈ ${buildRef(ne.era.km, ne.era.dir)}`;
    el("np-era-dist").textContent = ne.ahead ? `${fmtDist(ne.dist)} ahead` : fmtDist(ne.dist);
    eraRow.classList.remove("hidden");
  } else {
    eraRow.classList.add("hidden");
  }
  el("np-meta").textContent = `updated ${new Date().toLocaleTimeString("en-GB")}`;
}

// GPS quality dot: green = trust it, amber = marginal, red = poor/unknown.
function setGpsQuality(accuracy) {
  const dot = el("gps-dot");
  dot.classList.remove("live", "wait", "err");
  if (accuracy == null) { dot.classList.add("wait"); return; }
  el("acc").textContent = `±${Math.round(accuracy)} m`;
  dot.classList.add(accuracy <= 10 ? "live" : accuracy <= 25 ? "wait" : "err");
}

function startGeo() {
  if (!("geolocation" in navigator)) {
    el("status").textContent = "No geolocation on this device";
    return;
  }
  el("status").textContent = "Acquiring…";
  el("gps-dot").classList.add("wait");
  navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      el("status").textContent = "Live";
      setGpsQuality(c.accuracy);
      lastPos = { lat: c.latitude, lng: c.longitude };
      renderNearest(c.latitude, c.longitude, c.heading, c.speed, c.accuracy);
    },
    (err) => {
      el("status").textContent = err.code === 1 ? "Location blocked" : "GPS error";
      el("acc").textContent = "";
      el("gps-dot").classList.remove("live", "wait");
      el("gps-dot").classList.add("err");
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
  );
}

// ---------- go-to-post view ----------
function populateRoads() {
  const sel = el("g-road");
  const roads = [...byRoad.keys()].sort((a, b) => {
    // motorways first, then A-roads, both ascending
    const ma = a[0] === "M", mb = b[0] === "M";
    if (ma !== mb) return ma ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  sel.innerHTML = roads.map((r) => `<option value="${r}">${roadLabel(r)}</option>`).join("");
  onRoadChange();
}

// Always offer the standard carriageways (mainline A/B + slip links J/K/L/M),
// plus any other letters present in the data — so a slip can always be entered.
const STD_DIRS = ["A", "B", "J", "K", "L", "M"];

function onRoadChange() {
  const road = el("g-road").value;
  const posts = byRoad.get(road) || [];
  const present = new Set(posts.map((p) => p.direction));
  const extras = [...present].filter((d) => !STD_DIRS.includes(d)).sort();
  const dirs = [...STD_DIRS, ...extras];
  el("g-dir").innerHTML = dirs.map((d) => `<option value="${d}">${d}</option>`).join("");

  // Default to a carriageway we actually have posts for (prefer A, then B).
  const counts = {};
  for (const p of posts) counts[p.direction] = (counts[p.direction] || 0) + 1;
  el("g-dir").value = present.has("A") ? "A" : present.has("B") ? "B"
    : [...present].sort((a, b) => counts[b] - counts[a])[0] || "A";

  const ds = posts.map((p) => p.distance).sort((a, b) => a - b);
  el("g-hint").textContent = ds.length
    ? `${roadLabel(road)}: ${ds[0]}–${ds[ds.length - 1]} km · posts on ${[...present].sort().join("/")}`
    : "";
}

function buildRef(distance, dir) {
  const whole = Math.floor(distance + 1e-9);
  const tenth = Math.round((distance - whole) * 10);
  return `P${whole}/${tenth}${dir}`;
}

function findPost() {
  const road = el("g-road").value;
  const dist = parseFloat(el("g-dist").value);
  const dir = el("g-dir").value;
  const result = el("g-result");
  if (!road || Number.isNaN(dist) || !dir) {
    el("g-hint").textContent = "Enter road, distance and direction.";
    result.classList.add("hidden");
    return;
  }
  const posts = byRoad.get(road) || [];
  const nearestBy = (list, d) =>
    list.reduce((b, p) => (b && Math.abs(b.distance - d) <= Math.abs(p.distance - d) ? b : p), null);

  const onDir = posts.filter((p) => p.direction === dir);
  const ref = buildRef(dist, dir);
  let match = onDir.find((p) => p.ref === ref) || null;
  let mode = match ? "exact" : "";
  if (!match && onDir.length) {
    match = nearestBy(onDir, dist);
    mode = Math.abs(match.distance - dist) <= 0.15 ? "exact" : "offdist";
  }
  if (!match) {
    // Carriageway has no posts (e.g. a slip we lack data for): fall back to the
    // nearest post at this chainage on any carriageway (the adjacent mainline).
    match = nearestBy(posts, dist);
    mode = "slip";
  }

  const hero = el("r-hero");
  result.classList.remove("hidden"); // reveal first so fitText can measure width
  if (!match) {
    hero.classList.add("hidden");
    el("r-detail").textContent = `No ${roadLabel(road)} posts in dataset.`;
    el("r-waze").classList.add("hidden");
    return;
  }
  hero.classList.remove("hidden");
  paintSign("r-road", "r-ref", match);
  const off = Math.abs(match.distance - dist);
  const detail = el("r-detail");
  detail.classList.toggle("warn", mode !== "exact");
  if (mode === "exact") {
    detail.textContent = `${roadLabel(match.road)} · carriageway ${match.direction} · ${match.distance} km`;
  } else if (mode === "offdist") {
    detail.textContent =
      `⚠ No ${roadLabel(road)}/${dir} post at ${dist} km — nearest is ${match.ref} (${match.distance} km, ${off.toFixed(1)} km away). Check the carriageway and distance.`;
  } else {
    detail.textContent =
      `⚠ No marker-post data for ${roadLabel(road)} carriageway ${dir} (slip road). Routing to the nearest mainline post, ${match.ref} at ${match.distance} km — the slip branches off here.`;
  }
  const waze = el("r-waze");
  waze.href = `https://waze.com/ul?ll=${match.lat},${match.lng}&navigate=yes`;
  waze.classList.remove("hidden");
}

// "M27 13.6 A" / "M27 13.6A" / "P13/6A M27"
function parseQuick(s) {
  s = s.trim().toUpperCase();
  if (!s) return;
  const road = (s.match(/\b(A\d+\(M\)|[AM]\d+M?)/) || [])[0];
  // Remove the road token first so its digits/letter don't get read as distance/dir.
  const rest = road ? s.replace(road, " ") : s;
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
  if (road && byRoad.has(road.replace("(M)", "M"))) {
    el("g-road").value = road.replace("(M)", "M");
    onRoadChange();
  }
  if (dist != null && !Number.isNaN(dist)) el("g-dist").value = dist;
  if (dir) {
    const opt = [...el("g-dir").options].find((o) => o.value === dir);
    if (opt) el("g-dir").value = dir;
  }
}

// ---------- VMS signs view ----------
// data/vms.json is produced by scripts/fetch-vms.mjs (GitHub Actions, every
// ~10 min). The service worker keeps the last good copy for offline use.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

let vmsChecked = null; // when the poller last successfully checked the API

async function loadVms() {
  try {
    const res = await fetch("data/vms.json", { cache: "no-cache" });
    VMS = await res.json();
  } catch {
    /* offline with nothing cached — keep whatever we had */
  }
  // vms.json only changes when signs change, so its timestamp is "last
  // change", not "last check". Ask GitHub when the poller last ran green
  // (public API, CORS-friendly); offline this just fails quietly.
  try {
    const r = await fetch(
      "https://api.github.com/repos/JET11111/marker-post/actions/workflows/vms.yml/runs?status=success&per_page=1");
    const runs = (await r.json()).workflow_runs;
    if (runs && runs.length) vmsChecked = new Date(runs[0].updated_at).getTime();
  } catch { /* keep last known */ }
  renderSigns();
}

function fmtAge(min) {
  if (min < 1.5) return "just now";
  if (min < 90) return `${Math.round(min)} min ago`;
  const h = min / 60;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// Filter state, persisted so the tab opens the way you left it.
// roads: [] = all roads; blanks: false hides signs displaying nothing.
const VMS_FILTER_KEY = "vms-filter";
let vmsFilter = { roads: [], blanks: false };
try {
  vmsFilter = { ...vmsFilter, ...JSON.parse(localStorage.getItem(VMS_FILTER_KEY) || "{}") };
} catch { /* corrupt state — fall back to defaults */ }
const saveVmsFilter = () => localStorage.setItem(VMS_FILTER_KEY, JSON.stringify(vmsFilter));

// Filter groups: each sign belongs to its road, except the M3, which splits at
// J7 into the usual patch (J7–14) and the northern end (J4–7). The boundary
// chainage comes from snapping J7 to its nearest post; each sign's chainage
// from snapping the sign the same way.
let m3SplitKm = null;
const signKm = new Map(); // sign id -> chainage on its road
function signGroup(s) {
  if (s.road !== "M3" || s.lat == null) return s.road;
  const m3 = byRoad.get("M3") || [];
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
    const j7 = JUNCTIONS.find((j) => j.road === "M3" && j.jct === "J7");
    if (!j7) return s.road;
    m3SplitKm = snap(j7.lat, j7.lng);
  }
  if (!signKm.has(s.id)) signKm.set(s.id, snap(s.lat, s.lng));
  return signKm.get(s.id) >= m3SplitKm - 0.3 ? "M3 J7-14" : "M3 J4-7";
}

function renderSigns() {
  const list = el("s-list");
  if (!VMS || !VMS.fetched || !VMS.signs) {
    el("s-meta").textContent = VMS && !VMS.fetched
      ? "No sign data yet — the update feed hasn't run."
      : "No sign data available.";
    el("s-stale").classList.add("hidden");
    el("s-filters").classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  const age = (Date.now() - new Date(VMS.fetched).getTime()) / 60000;
  // Staleness = time since the poller last checked (if known), not since the
  // signs last changed — a quiet hour on the network isn't stale data.
  const checkedAge = vmsChecked ? (Date.now() - vmsChecked) / 60000 : null;
  const effAge = checkedAge ?? age;
  const stale = el("s-stale");
  if (effAge > 30) {
    stale.textContent = `⚠ No successful update for ${fmtAge(effAge).replace(" ago", "")} — messages may have changed since.`;
    stale.classList.remove("hidden");
  } else {
    stale.classList.add("hidden");
  }

  // Filter chips: one per road (motorways first) + a blank-signs toggle.
  const counts = {};
  for (const s of VMS.signs) { const g = signGroup(s); counts[g] = (counts[g] || 0) + 1; }
  const roads = Object.keys(counts).sort((a, b) => {
    const ma = a[0] === "M", mb = b[0] === "M";
    if (ma !== mb) return ma ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  vmsFilter.roads = vmsFilter.roads.filter((r) => counts[r]); // drop stale roads
  const chips = el("s-filters");
  chips.classList.remove("hidden");
  const sel = vmsFilter.roads;
  chips.innerHTML = [
    `<button class="chip${sel.length ? "" : " on"}" data-road="*">All</button>`,
    ...roads.map((r) =>
      `<button class="chip${sel.includes(r) ? " on" : ""}" data-road="${r}">${roadLabel(r).replace("-", "–")}<small>${counts[r]}</small></button>`),
    `<button class="chip${vmsFilter.blanks ? " on" : ""}" data-road="~">blank signs</button>`,
  ].join("");
  for (const b of chips.querySelectorAll(".chip")) {
    b.addEventListener("click", () => {
      const r = b.dataset.road;
      if (r === "*") vmsFilter.roads = [];
      else if (r === "~") vmsFilter.blanks = !vmsFilter.blanks;
      else vmsFilter.roads = vmsFilter.roads.includes(r)
        ? vmsFilter.roads.filter((x) => x !== r)
        : [...vmsFilter.roads, r];
      saveVmsFilter();
      renderSigns();
    });
  }

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

  el("s-meta").textContent = `${signs.length} of ${VMS.signs.length} signs · ` +
    (checkedAge != null
      ? `checked ${fmtAge(checkedAge)} · last change ${fmtAge(age)}`
      : `updated ${fmtAge(age)}`);
  list.innerHTML = signs.length
    ? signs.map(signCard).join("")
    : `<div class="signs-empty">No signs match the filter${vmsFilter.blanks ? "" : " (blank signs are hidden)"}.</div>`;
}

function signCard(s) {
  const status = String(s.status || "").trim();
  const off = status !== "working"; // blank/covered/notWorking — flag it
  const panel = s.lines && s.lines.length
    ? s.lines.map((l) => `<div class="sign-line">${escapeHtml(l)}</div>`).join("")
    : `<div class="sign-blank">blank</div>`;

  // Locate the sign against our own dataset: the nearest marker post.
  let near = null;
  if (s.lat != null) {
    const { post, dist } = findNearest(s.lat, s.lng, null, null, false);
    if (post && dist <= 250) near = post;
  }
  const bits = [];
  if (near) bits.push(`near ${near.ref}`);
  if (s.d != null) bits.push(`${fmtDist(s.d)} from you`);
  const set = s.setAt && !Number.isNaN(Date.parse(s.setAt))
    ? new Date(s.setAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : null;
  if (set && s.lines && s.lines.length) bits.push(`set ${set}`);

  return `
  <div class="sign-card${off ? " off" : ""}">
    <div class="sign-panel">${panel}</div>
    <div class="sign-info">
      <div class="sign-road"><b>${escapeHtml(roadLabel(s.road || "?"))}</b>${s.dir ? ` ${escapeHtml(s.dir)}` : ""}${off ? ` · <span class="warn">${escapeHtml(status)}</span>` : ""}</div>
      <div class="sign-sub">${escapeHtml(s.id)}${bits.length ? " · " + bits.join(" · ") : ""}</div>
    </div>
  </div>`;
}

// ---------- tabs ----------
function switchView(view) {
  for (const t of document.querySelectorAll(".tab"))
    t.classList.toggle("active", t.dataset.view === view);
  for (const v of ["nearest", "signs", "goto"])
    el(`view-${v}`).classList.toggle("hidden", v !== view);
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  if (view === "signs") loadVms(); // refresh data + check age on every open
}

// ---------- keep screen awake ----------
let wakeLock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* denied or not allowed right now; retried on next visibility/interaction */
  }
}

// ---------- online/offline ----------
function updateOnline() {
  el("offline").classList.toggle("hidden", navigator.onLine);
}

// ---------- init ----------
async function init() {
  try {
    await loadData();
  } catch (e) {
    el("status").textContent = "Failed to load post data";
    return;
  }
  populateRoads();
  el("g-road").addEventListener("change", onRoadChange);
  el("g-find").addEventListener("click", findPost);
  el("g-quick").addEventListener("input", (e) => parseQuick(e.target.value));
  for (const t of document.querySelectorAll(".tab"))
    t.addEventListener("click", () => switchView(t.dataset.view));
  if (["#goto", "#signs"].includes(location.hash)) switchView(location.hash.slice(1));

  // VMS signs: initial load, manual refresh, and a slow background re-poll.
  loadVms();
  el("s-refresh").addEventListener("click", loadVms);
  setInterval(() => {
    if (!el("view-signs").classList.contains("hidden")) loadVms();
  }, 5 * 60 * 1000);

  // Deep link: ?q=M27 13.6 A  -> open go-to, prefill and look up.
  const q = new URLSearchParams(location.search).get("q");
  if (q) {
    switchView("goto");
    el("g-quick").value = q;
    parseQuick(q);
    findPost();
  }

  window.addEventListener("resize", () => {
    for (const id of ["np-ref", "r-ref"]) {
      const e = el(id);
      if (e && e.offsetParent !== null && e.textContent !== "—") fitText(e, 158);
    }
  });
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  // Keep the screen on while the app is open; re-acquire when tab returns to view
  // (the lock is auto-released when the page is hidden) or on first touch.
  keepAwake();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") keepAwake();
  });
  document.addEventListener("click", () => { if (!wakeLock) keepAwake(); }, { once: true });

  startGeo();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
