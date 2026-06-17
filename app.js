"use strict";

// ---------- data ----------
let POSTS = [];
const byRoad = new Map();

async function loadData() {
  const res = await fetch("data/posts.json", { cache: "force-cache" });
  POSTS = await res.json();
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

function renderNearest(lat, lng, heading, speed, accuracy) {
  const useHeading = el("heading-toggle").checked;
  const { post, dist } = findNearest(lat, lng, heading, speed, useHeading);
  if (!post) return;
  el("np-ref").textContent = post.ref;
  el("np-road").textContent = `${post.road} · carriageway ${post.direction}`;
  el("np-dist").textContent = fmtDist(dist);
  el("np-meta").textContent =
    `GPS ±${Math.round(accuracy)} m · updated ${new Date().toLocaleTimeString("en-GB")}`;
}

function startGeo() {
  if (!("geolocation" in navigator)) {
    el("status").textContent = "No geolocation on this device";
    return;
  }
  el("status").textContent = "Acquiring GPS…";
  navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      el("status").textContent = "GPS live";
      renderNearest(c.latitude, c.longitude, c.heading, c.speed, c.accuracy);
    },
    (err) => {
      el("status").textContent = `GPS error: ${err.message}`;
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
  sel.innerHTML = roads.map((r) => `<option value="${r}">${r}</option>`).join("");
  onRoadChange();
}

function onRoadChange() {
  const road = el("g-road").value;
  const posts = byRoad.get(road) || [];
  const dirs = [...new Set(posts.map((p) => p.direction))].sort();
  el("g-dir").innerHTML = dirs.map((d) => `<option value="${d}">${d}</option>`).join("");
  const ds = posts.map((p) => p.distance).sort((a, b) => a - b);
  el("g-hint").textContent = ds.length
    ? `${road}: posts ${ds[0]}–${ds[ds.length - 1]} km, directions ${dirs.join("/")}`
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
  if (!match) {
    el("r-ref").textContent = "Not found";
    el("r-detail").textContent = `No ${road} carriageway ${dir} posts in dataset.`;
    el("r-waze").classList.add("hidden");
    result.classList.remove("hidden");
    return;
  }
  el("r-ref").textContent = match.ref;
  el("r-detail").textContent = exact
    ? `${match.road} · carriageway ${match.direction} · ${match.distance} km`
    : `Nearest match (${(Math.abs(match.distance - dist)).toFixed(1)} km off requested ${dist}) · ${match.lat.toFixed(5)}, ${match.lng.toFixed(5)}`;
  const waze = el("r-waze");
  waze.href = `https://waze.com/ul?ll=${match.lat},${match.lng}&navigate=yes`;
  waze.classList.remove("hidden");
  result.classList.remove("hidden");
}

// "M27 13.6 A" / "M27 13.6A" / "P13/6A M27"
function parseQuick(s) {
  s = s.trim().toUpperCase();
  if (!s) return;
  const road = (s.match(/\b([AM]\d+M?|A\d+\(M\))\b/) || [])[0];
  let dist, dir;
  const ref = s.match(/P(\d+)\/(\d)\s*([AB])/);
  if (ref) {
    dist = parseFloat(ref[1]) + parseFloat(ref[2]) / 10;
    dir = ref[3];
  } else {
    const dm = s.match(/(\d+(?:\.\d+)?)/);
    if (dm) dist = parseFloat(dm[1]);
    const dirm = s.match(/\b([AB])\b/) || s.match(/([AB])\s*$/);
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
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();
  startGeo();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
