# Marker-post source audit

Checked 24 September 2026. This audit found a completeness improvement, not a newly surveyed public marker-post dataset.

## Recovered interchange records

The app's existing [South East Region Google My Maps source](https://www.google.com/maps/d/viewer?mid=1Pi_3GZSLypASYCfiVbP1a-kxWJiII1I) contains marker posts under named interchanges rather than ordinary road names. These were absent from `data/posts.json`.

`data/posts-supplemental.json` preserves the source's references and coordinates, with source ID, full label, connection label and explicit road aliases. It supplements the original data without changing it.

| Source road | Display location | Unique records | Source connection labels |
| --- | --- | ---: | --- |
| CHILWORTH | Chilworth, M3 / M27 | 94 | M3A/M27B, M27A/M3B, M27B/M3B, M3A/M27A |
| PITSEA | M27 / M275 interchange | 24 | M275J/M27B, M27B/M275J, M27A/M275M, M275M/M27A |

The exact source name `PITSEA` is retained even though its connection labels and coordinates place this group at M27/M275. No historical or authoritative place-name claim is made. Carriageway letters are retained verbatim, including G and H. They are not generated from assumed J/K/L/M conventions.

The source types are also preserved: 117 records are `LINKMP`, and `P44/8G` is `INSERTMP`. Those source classifications do not establish that a physical post is currently present. The app has not interpolated or manufactured these references.

Examples directly present in the source:

- `P17/4L`, connection `M27B/M3B`, at 50.948122, -1.3929704.
- `P118/7K`, connection `M3A/M27A`, at 50.950123, -1.3972293.
- `P119/1M`, connection `M3A/M27B`, at 50.957531, -1.4164828.

The source contains duplicate copies of all 94 Chilworth records. The importer removes identical source-ID duplicates and rejects conflicting records. The current 118 retained records have unique source IDs and unique source-road/reference pairs. Consumers should use source IDs, or source-road/reference/connection together, rather than assuming a displayed reference alone is globally unique.

## Freshness and attribution

The source map does not provide a survey date and explicitly cautions that marker posts may not be aligned. Both the dataset and individual recovered records therefore have `surveyedAt: null` and `verificationStatus: "source-date-unknown"`. `fetchedAt` only records retrieval. It must not be described as a survey or accuracy-verification date.

The source is the same user-supplied map already used by this application. This import does not claim National Highways' endorsement, a newer survey, complete slip-road coverage, or an independently established licence for the My Maps compilation. Keep its source link visible in attribution. The separate Data Mill North licence does not establish the provenance or licence of every record in this compilation.

Aliases such as M3 and M27 are parsed only from each record's explicit connection label. They support search; they do not establish which graph edge is a correct routing match. Do not convert the `road` field to an assumed parent motorway or infer a carriageway from nearby mainline posts.

## Other public sources checked

| Source | Finding | Import decision |
| --- | --- | --- |
| [Data Mill North, Strategic Road Network Marker Posts](https://datamillnorth.org/dataset/strategic-road-network-marker-posts-2gpjw) | The original publisher page says last updated over nine years ago and provides an Open Government Licence attribution. Recent data.gov catalogue dates do not establish a recent underlying survey. | No freshness upgrade claimed. |
| [National Highways FOI release, 2 September 2021](https://www.gov.uk/government/publications/marker-posts-on-the-strategic-road-network) | The downloadable CSV has 82,693 asset records. All 10,062 Area 3 records have blank section fields and zero easting/northing coordinates. Its fields contain asset IDs, not the displayed marker references required here. | Not imported. |
| [National Highways GDMS mapping catalogue](https://help.gdms.assetia.cloud/050_Mapping/Mapping_Catalogue.htm) | A marker-post layer was uploaded on 16 July 2025, but the catalogue supplies no underlying dataset update date or public licensed download. | No import or freshness assumption. |
| [National Highways public Network Model](https://www.arcgis.com/home/item.html?id=4b64217e40dc48ebb38315a9a95c96e5) | Provides road links and topology; those link references are not surveyed marker-post references. | Used separately for network mapping, never to manufacture marker references. |

A newer authoritative export or dated strip plans remain necessary to verify these marker locations and fill remaining slip-road gaps.

## Repeat the import

Python 3 is sufficient; there are no third-party dependencies:

```sh
python3 scripts/fetch-supplemental-posts.py
```

To reproduce from an already downloaded KML, supply its actual retrieval time:

```sh
python3 scripts/fetch-supplemental-posts.py --input /path/to/source.kml --fetched-at 2026-09-24T12:00:00Z
```

The importer records the SHA-256 hash of the raw KML, validates references, connection labels, coordinate columns and expected interchange bounds, rejects zero or non-finite coordinates, and replaces the output only after validation succeeds. Review changes in counts or positions before release. The output is an audited source snapshot, not live operational ground truth.
