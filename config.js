// Runtime configuration.
//
// This checked-in copy is what the web app (GitHub Pages) and local
// development use. scripts/build-web.mjs writes a target-specific copy into
// the build output: the native apps get target "native" and their own
// feature switches. Nothing in here is a secret: the keys for the sign and
// vehicle services live in the Cloudflare Workers, never in the app.
export default {
  /** "pwa" (browser / installed web app) or "native" (iOS / Android shell). */
  target: 'pwa',
  version: '2.0.0',
  build: 'dev',

  features: {
    /** Vehicle lookup tab. Uses a personal relay and API terms: off in native builds unless enabled at build time. */
    vehicle: true,
  },

  /**
   * Where the published data files live. The native apps carry their own copy
   * of every file (so everything works with no signal) and use this address
   * only to pick up newer road and sign snapshots when online.
   */
  hostedBase: 'https://jet11111.github.io/marker-post/',

  vmsLiveUrl: 'https://vms-live.got2005lhs.workers.dev/',
  vehicleUrl: 'https://vehicle-lookup.got2005lhs.workers.dev/',
  /** Public GitHub API: when the sign poller last ran successfully. */
  vmsRunsUrl: 'https://api.github.com/repos/JET11111/marker-post/actions/workflows/vms.yml/runs?status=success&per_page=1',

  map: {
    /** Vector base map. See map-style.js for how these are used. */
    basemap: {
      provider: 'openfreemap',
      tiles: 'https://tiles.openfreemap.org/planet',
      attribution: '© OpenStreetMap contributors · OpenFreeMap © OpenMapTiles',
    },
  },
};
