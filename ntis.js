"use strict";

// NTIS DATEX II sandbox. Fully self-contained and isolated from the main app:
// it shares only the read-only theme in styles.css. Nothing here touches the
// Marker Post data, service worker, or app.js.

// ---------- tiny DOM helpers ----------
const el = (id) => document.getElementById(id);
// Namespace-agnostic: DATEX II ships in several namespaces/versions, so match on
// local name and ignore prefixes/URIs entirely.
const kids = (node, local) => (node ? [...node.getElementsByTagNameNS("*", local)] : []);
const first = (node, local) => kids(node, local)[0] || null;
const txt = (node, local) => {
  const n = first(node, local);
  return n ? n.textContent.trim() : "";
};

// ---------- state ----------
let EVENTS = [];

// ---------- DATEX II parsing ----------
// Reads a SituationPublication and flattens each situationRecord into a plain
// event object. NTIS uses linear/TMC location referencing, so a friendly place
// name isn't always inline — we surface whatever description the record carries
// and fall back to the road number.
function parseDatex(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, "application/xml");
  if (first(doc, "parsererror") || doc.querySelector("parsererror")) {
    throw new Error("Could not parse XML — is this a DATEX II file?");
  }
  const records = kids(doc, "situationRecord");
  if (!records.length) {
    throw new Error("No situationRecord elements found (expected a DATEX II SituationPublication).");
  }
  return records.map(toEvent);
}

// The record subtype lives in xsi:type, e.g. "Accident", "Roadworks".
function recordType(rec) {
  const raw =
    rec.getAttributeNS("http://www.w3.org/2001/XMLSchema-instance", "type") ||
    rec.getAttribute("xsi:type") ||
    "";
  const name = raw.replace(/^[a-z0-9]+:/i, ""); // strip any namespace prefix
  return name ? name.replace(/([a-z])([A-Z])/g, "$1 $2") : "Event";
}

// Pull the first human comment (DATEX nests comment > values > value[lang]).
function comment(rec) {
  for (const c of kids(rec, "comment")) {
    const v = kids(c, "value").find((x) => x.textContent.trim());
    if (v) return v.textContent.trim();
    if (c.textContent.trim()) return c.textContent.trim();
  }
  return "";
}

// Location: prefer an explicit descriptor, else a road number, else TMC/linear id.
function eventLocation(rec) {
  const desc =
    txt(rec, "locationDescription") ||
    txt(rec, "tpegDescriptor") ||
    txt(rec, "descriptor") ||
    txt(rec, "roadName");
  if (desc) return desc;
  const road = roadNumber(rec);
  const point = txt(rec, "descriptionInPointFormat") || txt(rec, "tpegPointLocation");
  return [road, point].filter(Boolean).join(" · ") || road || "Location referenced by ID";
}

function roadNumber(rec) {
  return (txt(rec, "roadNumber") || txt(rec, "roadIdentifier") || "").toUpperCase();
}

function toEvent(rec) {
  const validity = first(rec, "validity");
  const status = (txt(validity, "validityStatus") || "").toLowerCase();
  return {
    id: rec.getAttribute("id") || "",
    type: recordType(rec),
    severity: (txt(rec, "severity") || "unknown").toLowerCase(),
    road: roadNumber(rec),
    location: eventLocation(rec),
    comment: comment(rec),
    start: txt(rec, "overallStartTime") || txt(rec, "startTime"),
    end: txt(rec, "overallEndTime") || txt(rec, "endTime"),
    active: status === "active" || status === "",
    status,
  };
}

// ---------- rendering ----------
const SEV_RANK = { highest: 5, high: 4, medium: 3, low: 2, lowest: 1, unknown: 0 };
const sevClass = (s) =>
  ["highest", "high", "medium", "low"].includes(s) ? `sev-${s}` : "sev-info";

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function roadClass(road) {
  return /^M/.test(road) || /\(M\)/.test(road) ? "motorway" : "aroad";
}

function eventCard(e) {
  const sc = sevClass(e.severity);
  const road = e.road ? `<span class="road-badge ${roadClass(e.road)}">${esc(e.road)}</span>` : "";
  const sev = e.severity !== "unknown"
    ? `<span class="sev-chip ${sc}">${esc(e.severity)}</span>` : "";
  const desc = e.comment ? `<div class="evt-desc">${esc(e.comment)}</div>` : "";
  const statusCls = e.active ? "active" : "inactive";
  const statusLbl = e.active ? "Active" : (e.status || "inactive");
  return `
    <article class="evt ${sc}">
      <div class="evt-top">
        ${road}
        <span class="evt-type">${esc(e.type)}</span>
        ${sev}
      </div>
      <div class="evt-loc">${esc(e.location)}</div>
      ${desc}
      <div class="evt-times">
        <span><span class="lbl">From</span> ${fmtTime(e.start)}</span>
        <span><span class="lbl">To</span> ${fmtTime(e.end)}</span>
        <span class="evt-status ${statusCls}">${esc(statusLbl)}</span>
      </div>
    </article>`;
}

function render() {
  const road = el("f-road").value;
  const sev = el("f-sev").value;
  const q = el("f-text").value.trim().toLowerCase();

  let list = EVENTS.filter((e) => {
    if (road && e.road !== road) return false;
    if (sev && e.severity !== sev) return false;
    if (q && !`${e.type} ${e.location} ${e.comment}`.toLowerCase().includes(q)) return false;
    return true;
  });
  list.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));

  el("events").innerHTML = list.map(eventCard).join("");
  el("empty").classList.toggle("hidden", list.length > 0);
  el("summary").textContent = EVENTS.length
    ? `${list.length} of ${EVENTS.length} events · updated ${new Date().toLocaleTimeString("en-GB")}`
    : "";
}

function populateRoadFilter() {
  const roads = [...new Set(EVENTS.map((e) => e.road).filter(Boolean))].sort((a, b) => {
    const ma = a[0] === "M", mb = b[0] === "M";
    if (ma !== mb) return ma ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  el("f-road").innerHTML =
    `<option value="">All roads</option>` +
    roads.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
}

// ---------- load + status ----------
function setStatus(text, cls) {
  el("feed-status").textContent = text;
  const dot = el("feed-dot");
  dot.classList.remove("live", "wait", "err");
  dot.classList.add(cls);
}

function ingest(xmlString, label) {
  try {
    EVENTS = parseDatex(xmlString);
    populateRoadFilter();
    el("filters").classList.remove("hidden");
    render();
    setStatus(`${label} · ${EVENTS.length} events`, "live");
  } catch (err) {
    setStatus(err.message, "err");
    el("summary").textContent = "";
  }
}

async function fetchFeed() {
  const url = el("src-url").value.trim();
  if (!url) { setStatus("Enter a feed URL first", "err"); return; }
  try { localStorage.setItem("ntis-feed-url", url); } catch { /* private mode */ }
  setStatus("Fetching…", "wait");
  try {
    const res = await fetch(url, { headers: { Accept: "application/xml" } });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
    ingest(await res.text(), "Live feed");
  } catch (err) {
    // Most browser-side failures here are CORS/auth, not a dead feed.
    setStatus(`Fetch failed: ${err.message}. Likely CORS/auth — use a proxy.`, "err");
  }
}

function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => ingest(String(r.result), file.name);
  r.onerror = () => setStatus("Could not read file", "err");
  r.readAsText(file);
}

// ---------- online/offline ----------
function updateOnline() {
  el("offline").classList.toggle("hidden", navigator.onLine);
}

// ---------- init ----------
function init() {
  // Restore a previously used feed/proxy URL so it only has to be pasted once.
  try {
    const saved = localStorage.getItem("ntis-feed-url");
    if (saved) el("src-url").value = saved;
  } catch { /* storage blocked */ }

  el("btn-fetch").addEventListener("click", fetchFeed);
  el("btn-sample").addEventListener("click", () => ingest(SAMPLE_DATEX, "Sample data"));
  for (const id of ["f-road", "f-sev", "f-text"]) el(id).addEventListener("input", render);

  const drop = el("drop");
  el("file-input").addEventListener("change", (e) => readFile(e.target.files[0]));
  drop.addEventListener("click", () => el("file-input").click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    readFile(e.dataTransfer.files[0]);
  });

  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();
}

// ---------- bundled sample ----------
// A small, made-up DATEX II SituationPublication covering the app's Hampshire
// roads, so the page renders end-to-end with no feed configured. Values are
// illustrative only — not real traffic data.
const SAMPLE_DATEX = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <payloadPublication xsi:type="SituationPublication">
  <situation id="S1">
   <situationRecord xsi:type="Accident" id="R1">
    <severity>high</severity>
    <validity><validityStatus>active</validityStatus>
     <validityTimeSpecification>
      <overallStartTime>2026-07-01T08:15:00Z</overallStartTime>
      <overallEndTime>2026-07-01T10:00:00Z</overallEndTime>
     </validityTimeSpecification></validity>
    <generalPublicComment><comment><values>
     <value lang="en">Multi-vehicle collision, two lanes closed. Long delays expected.</value>
    </values></comment></generalPublicComment>
    <groupOfLocations><locationDescription><values>
     <value lang="en">M27 eastbound between J11 and J12</value>
    </values></locationDescription><roadNumber>M27</roadNumber></groupOfLocations>
   </situationRecord>
  </situation>
  <situation id="S2">
   <situationRecord xsi:type="Roadworks" id="R2">
    <severity>medium</severity>
    <validity><validityStatus>active</validityStatus>
     <validityTimeSpecification>
      <overallStartTime>2026-06-28T20:00:00Z</overallStartTime>
      <overallEndTime>2026-07-05T06:00:00Z</overallEndTime>
     </validityTimeSpecification></validity>
    <generalPublicComment><comment><values>
     <value lang="en">Overnight resurfacing, narrow lanes and 50mph limit.</value>
    </values></comment></generalPublicComment>
    <groupOfLocations><locationDescription><values>
     <value lang="en">M3 southbound J9 to J11</value>
    </values></locationDescription><roadNumber>M3</roadNumber></groupOfLocations>
   </situationRecord>
  </situation>
  <situation id="S3">
   <situationRecord xsi:type="AbnormalTraffic" id="R3">
    <severity>low</severity>
    <validity><validityStatus>active</validityStatus>
     <validityTimeSpecification>
      <overallStartTime>2026-07-01T07:45:00Z</overallStartTime>
     </validityTimeSpecification></validity>
    <generalPublicComment><comment><values>
     <value lang="en">Slow traffic on the approach to the junction.</value>
    </values></comment></generalPublicComment>
    <groupOfLocations><locationDescription><values>
     <value lang="en">A3(M) northbound near J2</value>
    </values></locationDescription><roadNumber>A3(M)</roadNumber></groupOfLocations>
   </situationRecord>
  </situation>
  <situation id="S4">
   <situationRecord xsi:type="VehicleObstruction" id="R4">
    <severity>medium</severity>
    <validity><validityStatus>active</validityStatus>
     <validityTimeSpecification>
      <overallStartTime>2026-07-01T09:05:00Z</overallStartTime>
     </validityTimeSpecification></validity>
    <generalPublicComment><comment><values>
     <value lang="en">Broken-down vehicle on the hard shoulder.</value>
    </values></comment></generalPublicComment>
    <groupOfLocations><locationDescription><values>
     <value lang="en">A27 westbound near Portsbridge</value>
    </values></locationDescription><roadNumber>A27</roadNumber></groupOfLocations>
   </situationRecord>
  </situation>
  <situation id="S5">
   <situationRecord xsi:type="PoorEnvironmentConditions" id="R5">
    <severity>highest</severity>
    <validity><validityStatus>active</validityStatus>
     <validityTimeSpecification>
      <overallStartTime>2026-07-01T06:30:00Z</overallStartTime>
      <overallEndTime>2026-07-01T12:00:00Z</overallEndTime>
     </validityTimeSpecification></validity>
    <generalPublicComment><comment><values>
     <value lang="en">Dense fog, severely reduced visibility. Drive with care.</value>
    </values></comment></generalPublicComment>
    <groupOfLocations><locationDescription><values>
     <value lang="en">M271 both directions</value>
    </values></locationDescription><roadNumber>M271</roadNumber></groupOfLocations>
   </situationRecord>
  </situation>
 </payloadPublication>
</d2LogicalModel>`;

init();
