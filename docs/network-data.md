# Hampshire network map data

The bundled `data/network.json` is an extract of two public, official National
Highways datasets. It is **published asset information, not a verified live road
layout or an operational navigation system**. Downloading a record today does
not mean somebody surveyed it today.

## Sources and dates

* [Network Model](https://network-model-highwaysengland.hub.arcgis.com/): road
  centrelines, connections, lane records, lay-bys, emergency-area links and
  restrictions. [Technical definitions](https://network-model-technical-information-highwaysengland.hub.arcgis.com/).
* [Emergency Areas](https://www.arcgis.com/home/item.html?id=d293e5e9c6ea459896f1c3f06a470a87):
  separately published ERA geometry. Its published **data** edit date was
  1 February 2025 when this feature was built. Its later schema/service edit date
  must not be displayed as a newer asset survey. NH says shape length does not
  represent physical emergency-area length.

Both sources are published under the Open Government Licence v3.0. The UI must
attribute National Highways. The source URLs and exact `dataLastEditDate` are
stored in each snapshot. `lastCheckedAt`/`fetchedAt` mean the download completed;
`sourceEditedAt` is a publisher record timestamp, often a bulk republication;
`layoutVerifiedAt: null` explicitly means no independent layout verification.
Dates on old records are not themselves evidence the physical layout is wrong.

Network Model speed-limit and smart-motorway classifications are withheld pending
validation. The app must not infer live hard-shoulder running or current lane
closures from these records. A hard shoulder is a recorded asset, not permission
to drive on it. Individual lane records describe intervals along a road link,
not surveyed lane-boundary polygons or marker-post chainage.

## Coverage

The extraction bounds are `[-2.05, 50.65, -0.65, 51.45]` in longitude/latitude.
This intentionally generous Hampshire patrol-area rectangle includes a buffer
into neighbouring counties and full intersecting road links. It is **not** an
exact administrative county boundary, and edge routes can be unavailable.

The extract includes every road link identified by the publisher as
`ownership='NH' AND srn='Y'` in that area, without a road-name whitelist. This
includes the M3, M27, M271, NH part of M275, A3(M), A3, A27, A31, A34, A303 and
A36, and NH junction connectors carrying names such as A272, A33 and A2030.
An included road name does not mean the whole road is maintained by NH.

## Refreshing and failure behaviour

Run from the repository root with Node 22 or later:

```sh
node scripts/fetch-network.mjs
node scripts/fetch-network.mjs --validate
```

No API key is needed. `NETWORK_OUTPUT` can select an alternate output file.
The GitHub `network-data` workflow runs daily and can be dispatched manually.
It commits only the refreshed snapshot. Pages publication is controlled by the
repository's Pages workflow, separately from data acquisition.

The downloader enumerates all matching ArcGIS object IDs (not the default first
page), fetches bounded chunks, checks exact ID membership, retries transient
errors, and rejects a transfer-limit response. Lane and restriction joins are
fully retrieved; restrictions referencing the selected links are not limited
to point locations within the rectangle. Full turn sequences crossing the
extraction edge are retained. Publication metadata is checked again after the
download to reject an extract taken across a publisher refresh. Files are only
replaced by an atomic rename after validation. A failed/incomplete refresh
leaves the last good snapshot and its original timestamps intact. A disappearance
of more than 20% of links requires manual review rather than silently publishing.

The UI should visibly distinguish source age from download age, mark a source
older than 30 days for review, and expire routing from a snapshot not checked
within the configured seven days. An unavailable fresh source does not justify
silently relabelling old records as current.

## JSON contract (schema version 1)

* `sources`: URLs, licences, publisher data-edit dates and download-check dates.
* `coverage`: approximate bounds, actual road names and counts.
* `links`: directed NH graph edges. `from`/`to` are real source node IDs;
  `coordinates` are `[longitude, latitude]`; `lengthM` is geodesic polyline length.
  Directionality `0` means both directions, `1` digitised direction, `2` reverse.
  `allowedDirectionality`, where present, incorporates a consistent one-way
  restriction. Multipart geometry is retained in `paths` but blocked for routing.
* `lanes` on each link: source lane code, start/end linear positions in metres,
  travel direction, optional average/minimum widths. `reportedLaneCount` counts
  related lane records, **including hard shoulders**; do not present it as running
  lanes. `LH`/`RH` are hard shoulders; `CL1`–`CL6`/`CR1`–`CR6` are permanent lanes.
  Overlapping/repeated lane intervals need interval-aware counting. A missing lane
  record is unknown, not evidence that no shoulder exists.
* `areas`: separately identified `network` EA/lay-by links and `emergencyAreas`
  publication shapes. `coordinate` is a display point on the source path, not a
  surveyed entry point. `paths` retain geometry. `linkId` is only present when the
  source supplies a real link association. Older and newer-source records may
  overlap: preserve provenance; do not blindly add their counts or treat
  proximity as proof they are the same bay. The legacy `data/eras.json` does not
  establish current availability and is not imported here.
* `turnRestrictions`: source type `NT` (no turn), `MT` (mandatory turn), or `OW`
  (one way), with ordered `links` (`id`, zero-based `sequence`, `directionality`).
  `handledByDirectionality: true` marks a consistent OW rule already reflected
  in `allowedDirectionality`. A source OW may reference several links following
  a road split: it is accepted only where every local segment already has the
  same one-way direction as its restriction reference. Inclusions/exemptions
  are retained.
* `accessRestrictions`/`vehicleRestrictions`: source records used to exclude
  unverified access and vehicle limitations, with descriptions.
* `routing.restrictionsComplete` is only true after every required restriction
  query and join succeeded. `routeEligible` and `routeBlockReasons` on each link
  implement additional conservative exclusions.

## Routing constraints

Route on NH-owned SRN links recorded open and within their validity dates. Use
real node IDs; never join crossing lines, motorway carriageways, or broken data
by geographic proximity. Unknown directions/geometry, service/access roads,
conditional/ambiguous restrictions and vehicle-profile restrictions are blocked.
Only explicitly public, unconditional access is accepted. The app assumes no
Traffic Officer exemption and does not invent an emergency access permission.
Lay-bys and emergency areas should be route endpoints, not through shortcuts.
Do not route along hard shoulders or use a general-road fallback.

The route engine must enforce ordered NT/MT turns and the final allowed link
directions. It must fail closed if restriction completeness is absent. A start
or destination on an opposite carriageway needs explicit, direction-aware
selection; an ERA display point does not establish a reachable entrance. Some
turnarounds require local-authority roads: the honest result for those is no
on-network route. Route distance is not an ETA, and the model does not include
live incidents, temporary works, signals, red-X closures, access availability
or the occupancy of a bay.

## Verification still required

Before presenting current physical bay coverage as verified, compare newer
emergency-area construction and known changed motorway sections with current
NH operational information and the user's strip plans. Nothing in this pipeline
can certify the completeness of a publisher's source. Missing or overlapping
records and any manual corrections need evidence, provenance, and a genuine
verification date rather than an automatically generated one.

There is a concrete reason for caution: NH's [South East retrofit programme](https://nationalhighways.co.uk/roads-and-travel/road-projects/south-east/south-east-emergency-area-retrofit-programme/)
reports two additional M27 bays between J9 and J10 in use on 14 February 2025,
and completion of the regional programme in spring 2025, including ten additional
M3 bays between J2 and J4A. These reports postdate the ERA publication's data edit.
The project's illustrated location maps are schematic and must not be converted
into apparently exact bay coordinates. The initial extract has 37 source ERA
shapes across the whole rectangle (including M4 buffer roads), not a verified
total of 37 individual Hampshire emergency areas. The Network Model extract has
no EA-coded links to fill this gap. Some published ERA shapes overlap; their
raw record count is not a deduplicated inventory.

The lane audit found all 2,855 selected links have related lane records. Broad
M27 sections show four permanent lanes without a shoulder, while J7–J8 shows
four permanent lanes plus `LH`. This combination is not automatically an error:
NH's [completed M27 scheme description](https://nationalhighways.co.uk/roads-and-travel/road-projects/south-east/m27-junctions-4-to-11-smart-motorway/)
explicitly retains the hard shoulder between J7 and J8. Some short junction
sections have three lanes plus a shoulder. This cross-check supports the broad
pattern, but does not verify every interval, current roadworks or lane widths.
Widths can repeat across every lane in a link and should remain unpublished
precision claims unless independently checked.

The source also contains an ambiguous no-turn record near the A31/B3081 junction
west of Ringwood: restriction `cdefaf16` (ID prefix) references sequence positions
6 and 7 in an order that does not follow the two directed road links. Those
affected links remain blocked. Consequently some westbound A31 routes near the
buffer edge fail rather than fabricating a connection or reversing the source
restriction. Similar small ambiguous restrictions are retained as explicit
exclusions on the M3 J6 connector and A36. This is separate from live closures.
