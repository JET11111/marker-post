// Fetch National Highways Digital VMS (DATEX II) sign statuses for the
// Hampshire patch and distil them into data/vms.json for the Signs tab.
// Runs in GitHub Actions (.github/workflows/vms.yml); needs the DVMS_KEY
// secret — a developer.data.nationalhighways.co.uk subscription key.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.DVMS_KEY;
if (!KEY) {
  console.error("DVMS_KEY not set");
  process.exit(1);
}

// Patch bounding box (posts.json extent + margin):
// lowerLeftLat,lowerLeftLng,upperRightLat,upperRightLng
const BBOX = "50.79,-1.90,51.39,-0.73";
const BASE = "https://api.data.nationalhighways.co.uk/dvms/v1.0/vms";

const DIR = {
  northBound: "NB", eastBound: "EB", southBound: "SB", westBound: "WB",
  northEastBound: "NE", northWestBound: "NW", southEastBound: "SE", southWestBound: "SW",
  clockwise: "CW", anticlockwise: "ACW",
};

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "X-Response-MediaType": "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { body: await res.json(), next: res.headers.get("x-next") };
}

const signs = [];
let publicationTime = null;
let url = `${BASE}?bBox=${encodeURIComponent(BBOX)}`;
for (let page = 0; url && page < 30; page++) {
  const { body, next } = await fetchPage(url);
  const pub = body && body.D2Payload;
  publicationTime = (pub && pub.publicationTime) || publicationTime;
  for (const ctrl of (pub && pub.vmsControllerStatus) || []) {
    for (const unit of ctrl.vmsStatus || []) {
      const st = unit.vmsStatus || {};
      const ext = st.vmsStatusExtensionG || {};
      const pt = ext.vmsLocation && ext.vmsLocation.locPointLocation;
      const co = pt && pt.pointByCoordinates && pt.pointByCoordinates.pointCoordinates;
      const sup = pt && pt.supplementaryPositionalDescription;
      const supExt = sup && sup.supplementaryPositionalDescriptionExtensionG;

      // Flatten the displayed text: all pages/areas, lines in display order.
      const lines = [];
      let setAt = null;
      for (const m of st.vmsMessage || []) {
        const msg = m.vmsMessage || {};
        setAt = msg.timeLastSet || setAt;
        for (const a of msg.displayAreaSettings || []) {
          const tl = (a.displayAreaSettings &&
            a.displayAreaSettings.vmsTextDisplay &&
            a.displayAreaSettings.vmsTextDisplay.textLine) || [];
          for (const l of [...tl].sort((x, y) => x.lineIndex - y.lineIndex)) {
            const s = l.textLine && l.textLine.textLine && l.textLine.textLine.trim();
            if (s) lines.push(s);
          }
        }
      }

      // The feed pads some values (e.g. workingStatus "working ") — trim all.
      const t = (v) => String(v == null ? "" : v).trim();
      signs.push({
        id: t(ext.externalIdentifier ||
          (ctrl.vmsControllerReference && ctrl.vmsControllerReference.idG)) || "?",
        road: t((sup && sup.roadInformation && sup.roadInformation[0] &&
          sup.roadInformation[0].roadName) || (sup && sup.locationDescription)),
        dir: t(supExt && (DIR[t(supExt.direction)] || supExt.direction)),
        lat: co ? co.latitude : null,
        lng: co ? co.longitude : null,
        size: t(ext.description),
        status: t(st.workingStatus) || "unknown",
        lines,
        setAt,
      });
    }
  }
  url = next;
}

// The feed repeats some controllers verbatim — keep one record per sign,
// preferring the one with a message, then the most recently set.
const byId = new Map();
for (const s of signs) {
  const key = s.id === "?" ? `?${s.lat},${s.lng}` : s.id;
  const cur = byId.get(key);
  if (!cur ||
      (s.lines.length && !cur.lines.length) ||
      (s.lines.length === cur.lines.length && (s.setAt || "") > (cur.setAt || "")))
    byId.set(key, s);
}
const unique = [...byId.values()];

unique.sort((a, b) =>
  a.road.localeCompare(b.road, undefined, { numeric: true }) || a.id.localeCompare(b.id));

const out = { fetched: new Date().toISOString(), publicationTime, count: unique.length, signs: unique };

// Skip the write (=> no commit, no Pages rebuild) when only timestamps moved.
let prev = null;
try { prev = JSON.parse(await readFile("data/vms.json", "utf8")); } catch { /* first run */ }
if (prev && JSON.stringify(prev.signs) === JSON.stringify(out.signs)) {
  console.log(`No change (${signs.length} signs)`);
} else {
  await writeFile("data/vms.json", JSON.stringify(out));
  console.log(`Wrote ${signs.length} signs`);
}
