// Shared DVMS fetch-and-distil logic, used by both the GitHub Actions poller
// (scripts/fetch-vms.mjs, offline snapshot) and the live Cloudflare Worker
// (worker-vms/worker.js). Returns the slim shape the app renders.

// Patch bounding box (posts.json extent + margin):
// lowerLeftLat,lowerLeftLng,upperRightLat,upperRightLng
const BBOX = "50.79,-1.90,51.39,-0.73";
const BASE = "https://api.data.nationalhighways.co.uk/dvms/v1.0/vms";

const DIR = {
  northBound: "NB", eastBound: "EB", southBound: "SB", westBound: "WB",
  northEastBound: "NE", northWestBound: "NW", southEastBound: "SE", southWestBound: "SW",
  clockwise: "CW", anticlockwise: "ACW",
};

async function fetchPage(url, key) {
  const res = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "X-Response-MediaType": "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { body: await res.json(), next: res.headers.get("x-next") };
}

export async function fetchSigns(key) {
  const signs = [];
  let publicationTime = null;
  let url = `${BASE}?bBox=${encodeURIComponent(BBOX)}`;
  for (let page = 0; url && page < 30; page++) {
    const { body, next } = await fetchPage(url, key);
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
    const key2 = s.id === "?" ? `?${s.lat},${s.lng}` : s.id;
    const cur = byId.get(key2);
    if (!cur ||
        (s.lines.length && !cur.lines.length) ||
        (s.lines.length === cur.lines.length && (s.setAt || "") > (cur.setAt || "")))
      byId.set(key2, s);
  }
  const unique = [...byId.values()];

  unique.sort((a, b) =>
    a.road.localeCompare(b.road, undefined, { numeric: true }) || a.id.localeCompare(b.id));

  return {
    fetched: new Date().toISOString(),
    publicationTime,
    count: unique.length,
    signs: unique,
  };
}
