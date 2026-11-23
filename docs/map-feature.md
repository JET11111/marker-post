# The map

## Vector map: 22 November 2026

The map was rebuilt on a different engine. What it shows is unchanged, and no caveat about the data has been dropped; how it is drawn, and where the street background comes from, are new. The last four items in the list below are things the map now says, or says more plainly than it did.

### What changed

- **Engine**: MapLibre GL JS with vector tiles, in place of Leaflet with picture tiles. The map now zooms and rotates smoothly, keeps its labels upright, and has a real dark style.
- **Street background**: one file, `tiles/basemap.pmtiles`, holding OpenStreetMap vector tiles for the patch. It replaces tiles fetched one by one from tile.openstreetmap.org, whose usage policy does not allow app-style or offline use.
- **The network, marker dots, emergency areas, lay-bys and junctions** are drawn by the map engine itself from the same data files as before, in the same colours as the rest of the app.
- **Look**: muted greys and greens with thin roads, so the network is what stands out. Motorways are blue and A roads green, as on road signs. Road numbers on the network are small sign-coloured shields drawn above the marker dots.
- **Light and dark** follow the app's appearance setting. Nothing flashes white when the map opens at night.
- **Your position**: the dot is blue, with its accuracy circle, only while the position is current. The rule is the first page's: 15 seconds without a new position when moving, 30 when the speed is not known, 2 minutes standing still, and 15 seconds for a position from before the app was put away. After that the dot turns grey, loses the circle and is labelled "Last known" with the time. A position made up for desk testing is labelled "Simulated position". "My location" quotes an accuracy only when the phone supplied one.
- **Emergency area cards**: the records for emergency areas name no road or carriageway, so the card takes both from the nearest road. Its heading now ends "unverified match" and its own row says "carriageway unverified". Lay-bys are tied to their road by the records themselves and are not labelled this way.
- **The street map has a date**: it is a copy of OpenStreetMap, not a live map. "Data dates and coverage" gives the date of the copy on screen, and the "Street map without signal" card gives it for a copy saved on the phone.
- **Road data on a slow connection**: the map waits a few seconds for today's road data, then draws the copy kept from last time if there is one. The pill at the top left then reads "Earlier copy · not refreshed".

### What did not change

- Tapping a marker dot or a road opens the same card. Every caveat is still there: straight-line distances are labelled, unknown stays unknown, older emergency-area records and uncertain carriageway associations stay labelled. `map-details.js` is the old `map-details.mjs` with two additions: the emergency-area label above, and the wording for your position.
- Search, the layer switches and the whole-patch view.
- Marker posts are never interpolated and labels never appear by themselves.
- Marker dots, emergency areas and lay-bys appear at the same scale as before. The new engine numbers its zoom levels one lower, so the old 12 is now 11.
- The credit "© OpenStreetMap · National Highways (OGL)" stays readable on the map: above an open card on a phone held upright, beside the card in landscape and on wide screens. The OpenStreetMap half is shown whenever the street map is drawn, and left out when that layer is switched off or the street map could not be loaded.

One small behaviour change: a tap chooses a marker or bay only if it is within 12 pixels, otherwise the nearest road. That makes the road between two markers easy to tap.

### The street map file

`scripts/fetch-basemap.mjs` cuts the file from a daily Protomaps build of OpenStreetMap. It takes:

- every tile in the network's bounding box up to zoom 12;
- above that, up to zoom 14, only tiles within 3 km of a National Highways road in `data/network.json`.

That gives full street detail along the patrol corridors and an overview everywhere else, in about 41 MB (2,355 tiles in the November build). Away from the corridors the map shows the overview magnified rather than going blank.

The file is never committed. GitHub cuts it once a month, keeps it in the Actions cache, and puts it:

- **on the website**, where the web app reads only the parts on screen. "Save street map" in the layers sheet stores the whole file on the phone for use without signal. It is never downloaded without being asked for.
- **inside the Android and iPhone apps**, so their map works with no signal from the first launch.

If the file cannot be read, the map still works: it shows the network and marker posts on a plain background and says so. The network and the marker posts are drawn without waiting for the street map. A file that would not open is tried again every half minute while the app is in view, each time the Map tab is opened, and when the phone reports that the connection is back.

The website is published again many times a day, whenever the sign data changes. Each time, GitHub gives the file a new version label (its ETag), although the file itself changes only once a month, so the web app cannot tell the two cases apart. A web app that is open at the time notices at the next piece of map it asks for, and reads the file's index again (about 16 kB) before it goes on. If that read fails for want of signal, it keeps the index it had and tries again with the next piece of map. A piece that arrives under a different label from the index in use is never drawn, so a new file is never cut up with the old file's index.

### Why this source

The repository is public, so any service that needs a key is out: the key would be readable by anyone, and a free allowance could be used up (or a bill run up) by someone else.

| Source | Cost and risk | Key | Works offline | Verdict |
|---|---|---|---|---|
| tile.openstreetmap.org (what the old map used) | Free, but the policy forbids offline use and heavy app use, and blocks without notice | None | No | Not allowed for this |
| OpenFreeMap | Free, no limits stated, no guarantee of service | None | Small downloads only | A good online-only fallback |
| MapTiler | Free plan is non-commercial and stops when the allowance is used; paid from US$30 a month | Required, would be public | Phone cache only | No |
| Stadia Maps | Free plan is non-commercial; paid from US$20 a month | Required for apps, would be public | Limited cache only | No |
| Our own file on Cloudflare R2 | Free inside the allowance; needs a small Worker to cap it | None | Yes | Works, but one more thing to run |
| **Our own file, published with the site and bundled in the apps** | Free. There is no account, so there cannot be a bill | None | Yes | **Chosen** |

Cloudflare R2 remains the next step if the file ever outgrows GitHub Pages (1 GB site limit) or the patch grows a lot. Nothing in the app would change except the file's address.

### Code and licences

- `map.js` (the map and its interface), `map-style.js` (colours and base layers), `basemap.js` (finding and reading the street map file), `map-details.js` (what a selected road or marker says, and what the map may say about your position).
- Vendored, with licences and checksums in `vendor/`: MapLibre GL JS 6.19.0, PMTiles 4.5.0, Protomaps basemaps 5.7.2 and its Noto Sans fonts and icons. `npm run vendor` refreshes them. The three libraries come from the versions pinned in `package.json`. The fonts, the icons and four licence texts are downloaded as their publishers have them on the day, so read the diff after a refresh.
- The map engine needs WebGL2: iOS 16.4 or later, and any current Android or desktop browser.

## Earlier record: mobile map update, 24 September 2026

This section and the one after it describe the map as it was before November 2026 (Leaflet, picture tiles, and before that the route planner). They are kept as a record. Where they disagree with the section above, the section above is current.


The Map tab now opens to an edge-to-edge map with a floating search field. The routing planner, route endpoints, saved-place dashboard, permanent marker labels and duplicate header are removed from the map. The route engine is no longer imported or precached; its earlier implementation remains in git for reference.

Tap a small gold marker dot to open its reference, or tap a highlighted road to inspect it. The dismissible bottom card shows recorded running lanes, hard shoulder status, nearest matching marker and the nearest ERA/lay-by records. Bay distances are straight-line distances to recorded points: they do not indicate driving distance, a bay ahead, access or availability. Unknown records stay unknown. Older ERA records and uncertain carriageway associations stay labelled.

Road inspection no longer depends on route eligibility. Lane data is evaluated at the selected position; shoulder lane codes are excluded from running-lane counts. Mainline marker associations match the recorded road and carriageway. Ambiguous and provisional interchange associations do not supply definitive layout values. Lay-bys can associate with their parent carriageway through real endpoint nodes; no route is calculated.

Map options contain layer switches, full-patch view and light background. Source dates and refresh remain behind the compact data button. Marker and bay layers appear from zoom 12; marker labels never appear automatically. The service worker caches the new inspection module for offline use.

`docs/mobile-preview.html` loads the real app in selectable 375/390/430-pixel phone viewports and landscape for visual review.

## Earlier record: the first network map

Open the new **Map** tab (or `/#map`). The existing nearest-post, VMS, vehicle and Go to tools remain available.

### Explore

- Search exact recorded posts, including `M27 13.6 A`, `M27 P13/6A`, `M3 J14`, `Chilworth`, `M27 17.4 L` and `A31 layby`.
- 5,057 original posts plus 118 recovered interchange references. Missing references are not interpolated. Supplemental posts retain their original connection labels and unknown survey dates.
- Road chips, source-coloured road sections, zoom-sensitive post labels, ERA/lay-by/junction layers, current GPS position and accuracy circle, and street/network background toggle.
- Select a feature to inspect the source date, recorded layout, nearby posts and bays. Nearby distances are explicitly straight-line; routing is needed to establish reachability.
- Saved places and review flags stay in local storage on the current device. Flags do not update the source or notify National Highways. Flagged sections are excluded from route planning on this device.

### Routes

Select a start and destination through search or the map, or use GPS as the start. Confirm the intended source carriageway from the candidates. The planner finds the shortest distance using only open, eligible NH-owned SRN links inside the snapshot, their topology and available turn restrictions. Opposing carriageways, bridges and nearby endpoints are not joined by proximity. No off-network alternative is silently substituted. Lay-bys and emergency areas are destinations, not shortcuts.

The route displays miles, kilometres and a sequence of road sections. It is a planning tool, without spoken guidance, live closures, incident feeds, temporary traffic layouts or traffic ETAs. Restricted access/vehicle-clearance links are excluded; this is not an emergency-exemptions routing profile.

**Find reachable lay-bys** compares directed routes from the confirmed start to all eligible lay-by records in the snapshot, and offers the three nearest by route distance. Availability, occupancy, entrance details and vehicle suitability are not confirmed.

### Freshness and known gaps

The Data dates & gaps panel separates download time from source publication and physical verification. The app checks the upstream network's publication on opening (at most every five minutes), and clears/blocks routes when a newer publication is known or either the snapshot or network publication is more than seven days old. Refresh failures retain the last successful snapshot with an explicit label. Offline use displays a dated cached snapshot; street tiles are not bulk downloaded or pre-cached.

- The 24 September 2026 network snapshot includes 2,855 links and 50 lay-by records in a Hampshire-area box with a connecting buffer. Counts include nearby counties; the box is not an exact county/patrol boundary.
- The separate official ERA source is **1 February 2025**, before documented M27/M3 retrofits. Its 37 source shapes include neighbouring M4 records. They are amber, explicitly unverified records, not a complete current Hampshire inventory. No new bay coordinates are guessed.
- Recorded lane intervals are used rather than the aggregate count that includes shoulders. A missing shoulder record means not recorded, not verified absence. Width fields remain available in the data but are not presented as measured road widths.
- Some M271/M275 marker letters do not align with network carriageway codes. A marker remains visible even if there is no confirmed eligible road match.
- An inconsistent A31 no-turn source sequence near Ringwood/B3081 blocks affected routes. A source correction or verified evidence is needed before relaxing this exclusion.
- Original and supplemental marker survey dates remain unknown. Recovered references improve completeness, not freshness.

The user's current strip plans would be useful for a subsequent, separately documented verification pass, particularly missing ERA bays and interchange marker associations.

### Maintenance

```sh
python3 -m http.server 8000
node --test tests/*.test.mjs
node scripts/fetch-network.mjs --validate
node scripts/fetch-network.mjs
python3 scripts/fetch-supplemental-posts.py
```

The network importer uses Node 22+ built-ins. It checks complete pagination, source consistency, geometry and restriction joins before atomically replacing the snapshot. `network-data` runs daily and can be dispatched manually. Its successful completion triggers the existing Pages workflow; normal GitHub token commits alone would not trigger an on-push deployment. `map-checks` tests pull requests. GitHub schedules may run late or be disabled; the UI uses actual dates.

Leaflet 1.9.4 is vendored with its license and verified upstream integrity hashes. Map street tiles come directly from OpenStreetMap using normal browser caching and visible attribution. Disable the Street map layer to view just the network. No API key, external routing service or build step is required.

See [network-data.md](network-data.md) and [marker-post-sources.md](marker-post-sources.md) for provenance and source limitations.
