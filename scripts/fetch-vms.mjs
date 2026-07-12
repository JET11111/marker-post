// Fetch National Highways Digital VMS (DATEX II) sign statuses for the
// Hampshire patch and distil them into data/vms.json for the Signs tab.
// Runs in GitHub Actions (.github/workflows/vms.yml); needs the DVMS_KEY
// secret — a developer.data.nationalhighways.co.uk subscription key.
// The fetch/mapping logic lives in vms-shared.mjs (shared with the live
// Cloudflare Worker in worker-vms/).
import { readFile, writeFile } from "node:fs/promises";
import { fetchSigns } from "./vms-shared.mjs";

const KEY = process.env.DVMS_KEY;
if (!KEY) {
  console.error("DVMS_KEY not set");
  process.exit(1);
}

const out = await fetchSigns(KEY);

// Skip the write (=> no commit, no Pages rebuild) when only timestamps moved.
let prev = null;
try { prev = JSON.parse(await readFile("data/vms.json", "utf8")); } catch { /* first run */ }
if (prev && JSON.stringify(prev.signs) === JSON.stringify(out.signs)) {
  console.log(`No change (${out.count} signs)`);
} else {
  await writeFile("data/vms.json", JSON.stringify(out));
  console.log(`Wrote ${out.count} signs`);
}
