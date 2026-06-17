"use strict";

// ---------- data ----------
let POSTS = [];
let JUNCTIONS = [];
const byRoad = new Map();

async function loadData() {
  const [pRes, jRes] = await Promise.all([
    fetch("data/posts.json", { cache: "force-cache" }),
    fetch("data/junctions.json", { cache: "force-cache" }),
  ]);
  POSTS = await pRes.json();
  JUNCTIONS = await jRes.json();
  for (const p of POSTS) {
    if (!byRoad.has(p.road)) byRoad.set(p.road, []);
    byRoad.get(p.road).push(p);
  }
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

// Linear scan — a few thousand points is fast enough.
function findNearest(lat, lng, heading, speed, useHeading) {
  const filter =
    useHeading && heading != null && !Number.isNaN(heading) && speed != null && speed > 2.5;
  let best = null,
    bestD = Infinity;
  if (filter) {
    for (const p of POSTS) {
      if (angleDiff(bearing(lat, lng, p.lat, p.lng), heading) > 120) continue;
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

function onRoadChange() {
  const road = el("g-road").value;
  const posts = byRoad.get(road) || [];
  // Order carriageways A,B first, then by how many posts they have (mainline
  // before sparse slip links), so the default isn't a stray slip carriageway.
  const counts = {};
  for (const p of posts) counts[p.direction] = (counts[p.direction] || 0) + 1;
  const dirs = [...new Set(posts.map((p) => p.direction))].sort((a, b) => {
    const pa = a === "A" ? 0 : a === "B" ? 1 : 2;
    const pb = b === "A" ? 0 : b === "B" ? 1 : 2;
    if (pa !== pb) return pa - pb;
    if (counts[b] !== counts[a]) return counts[b] - counts[a];
    return a.localeCompare(b);
  });
  el("g-dir").innerHTML = dirs.map((d) => `<option value="${d}">${d}</option>`).join("");
  const ds = posts.map((p) => p.distance).sort((a, b) => a - b);
  el("g-hint").textContent = ds.length
    ? `${roadLabel(road)}: posts ${ds[0]}–${ds[ds.length - 1]} km, directions ${dirs.join("/")}`
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
  const ref = buildRef(dist, dir);
  let match = posts.find((p) => p.ref === ref && p.direction === dir);
  const exact = !!match;
  if (!match) {
    // nearest by distance on the same carriageway
    let bestD = Infinity;
    for (const p of posts) {
      if (p.direction !== dir) continue;
      const d = Math.abs(p.distance - dist);
      if (d < bestD) { bestD = d; match = p; }
    }
  }
  const hero = el("r-hero");
  result.classList.remove("hidden"); // reveal first so fitText can measure width
  if (!match) {
    hero.classList.add("hidden");
    el("r-detail").textContent = `No ${roadLabel(road)} carriageway ${dir} posts in dataset.`;
    el("r-waze").classList.add("hidden");
    return;
  }
  hero.classList.remove("hidden");
  paintSign("r-road", "r-ref", match);
  const off = Math.abs(match.distance - dist);
  const detail = el("r-detail");
  if (exact || off <= 0.15) {
    detail.classList.remove("warn");
    detail.textContent = `${roadLabel(match.road)} · carriageway ${match.direction} · ${match.distance} km`;
  } else {
    detail.classList.add("warn");
    detail.textContent =
      `⚠ No ${roadLabel(road)}/${dir} post at ${dist} km — nearest is ${match.ref} (${match.distance} km, ${off.toFixed(1)} km away). Check the carriageway letter and distance.`;
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

// ---------- tabs ----------
function switchView(view) {
  for (const t of document.querySelectorAll(".tab"))
    t.classList.toggle("active", t.dataset.view === view);
  el("view-nearest").classList.toggle("hidden", view !== "nearest");
  el("view-goto").classList.toggle("hidden", view !== "goto");
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
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
  if (location.hash === "#goto") switchView("goto");

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
