# Mobile map update — 24 September 2026

The Map tab now opens to an edge-to-edge map with a floating search field. The routing planner, route endpoints, saved-place dashboard, permanent marker labels and duplicate header are removed from the map. The route engine is no longer imported or precached; its earlier implementation remains in git for reference.

Tap a small gold marker dot to open its reference, or tap a highlighted road to inspect it. The dismissible bottom card shows recorded running lanes, hard shoulder status, nearest matching marker and the nearest ERA/lay-by records. Bay distances are straight-line distances to recorded points: they do not indicate driving distance, a bay ahead, access or availability. Unknown records stay unknown. Older ERA records and uncertain carriageway associations stay labelled.

Road inspection no longer depends on route eligibility. Lane data is evaluated at the selected position; shoulder lane codes are excluded from running-lane counts. Mainline marker associations match the recorded road and carriageway. Ambiguous and provisional interchange associations do not supply definitive layout values. Lay-bys can associate with their parent carriageway through real endpoint nodes; no route is calculated.

Map options contain layer switches, full-patch view and light background. Source dates and refresh remain behind the compact data button. Marker and bay layers appear from zoom 12; marker labels never appear automatically. The service worker caches the new inspection module for offline use.

`docs/mobile-preview.html` loads the real app in selectable 375/390/430-pixel phone viewports and landscape for visual review.

## Earlier implementation record

# Hampshire network map

Open the new **Map** tab (or `/#map`). The existing nearest-post, VMS, vehicle and Go to tools remain available.

## Explore

- Search exact recorded posts, including `M27 13.6 A`, `M27 P13/6A`, `M3 J14`, `Chilworth`, `M27 17.4 L` and `A31 layby`.
- 5,057 original posts plus 118 recovered interchange references. Missing references are not interpolated. Supplemental posts retain their original connection labels and unknown survey dates.
- Road chips, source-coloured road sections, zoom-sensitive post labels, ERA/lay-by/junction layers, current GPS position and accuracy circle, and street/network background toggle.
- Select a feature to inspect the source date, recorded layout, nearby posts and bays. Nearby distances are explicitly straight-line; routing is needed to establish reachability.
- Saved places and review flags stay in local storage on the current device. Flags do not update the source or notify National Highways. Flagged sections are excluded from route planning on this device.

## Routes

Select a start and destination through search or the map, or use GPS as the start. Confirm the intended source carriageway from the candidates. The planner finds the shortest distance using only open, eligible NH-owned SRN links inside the snapshot, their topology and available turn restrictions. Opposing carriageways, bridges and nearby endpoints are not joined by proximity. No off-network alternative is silently substituted. Lay-bys and emergency areas are destinations, not shortcuts.

The route displays miles, kilometres and a sequence of road sections. It is a planning tool, without spoken guidance, live closures, incident feeds, temporary traffic layouts or traffic ETAs. Restricted access/vehicle-clearance links are excluded; this is not an emergency-exemptions routing profile.

**Find reachable lay-bys** compares directed routes from the confirmed start to all eligible lay-by records in the snapshot, and offers the three nearest by route distance. Availability, occupancy, entrance details and vehicle suitability are not confirmed.

## Freshness and known gaps

The Data dates & gaps panel separates download time from source publication and physical verification. The app checks the upstream network's publication on opening (at most every five minutes), and clears/blocks routes when a newer publication is known or either the snapshot or network publication is more than seven days old. Refresh failures retain the last successful snapshot with an explicit label. Offline use displays a dated cached snapshot; street tiles are not bulk downloaded or pre-cached.

- The 24 September 2026 network snapshot includes 2,855 links and 50 lay-by records in a Hampshire-area box with a connecting buffer. Counts include nearby counties; the box is not an exact county/patrol boundary.
- The separate official ERA source is **1 February 2025**, before documented M27/M3 retrofits. Its 37 source shapes include neighbouring M4 records. They are amber, explicitly unverified records, not a complete current Hampshire inventory. No new bay coordinates are guessed.
- Recorded lane intervals are used rather than the aggregate count that includes shoulders. A missing shoulder record means not recorded, not verified absence. Width fields remain available in the data but are not presented as measured road widths.
- Some M271/M275 marker letters do not align with network carriageway codes. A marker remains visible even if there is no confirmed eligible road match.
- An inconsistent A31 no-turn source sequence near Ringwood/B3081 blocks affected routes. A source correction or verified evidence is needed before relaxing this exclusion.
- Original and supplemental marker survey dates remain unknown. Recovered references improve completeness, not freshness.

The user's current strip plans would be useful for a subsequent, separately documented verification pass, particularly missing ERA bays and interchange marker associations.

## Maintenance

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
