#!/usr/bin/env python3
"""Recover named interchange marker posts from the existing public My Maps source.

Uses only Python's standard library. This refreshes source retrieval, not the date
on which a marker's position or reference was surveyed.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.request
import xml.etree.ElementTree as ET


SOURCE_URL = "https://www.google.com/maps/d/viewer?mid=1Pi_3GZSLypASYCfiVbP1a-kxWJiII1I"
DOWNLOAD_URL = "https://www.google.com/maps/d/kml?mid=1Pi_3GZSLypASYCfiVbP1a-kxWJiII1I&forcekml=1"
NS = {"k": "http://www.opengis.net/kml/2.2"}
TARGETS = {
    "CHILWORTH": ("Chilworth · M3 / M27", {"M3", "M27"}),
    "PITSEA": ("M27 / M275 interchange", {"M27", "M275"}),
}
MAX_BYTES = 50 * 1024 * 1024


def extract(raw):
    root = ET.fromstring(raw)
    by_source_id = {}
    duplicate_count = 0
    for placemark in root.findall(".//k:Placemark", NS):
        values = [
            item.findtext("k:value", default="", namespaces=NS).strip()
            for item in placemark.findall("k:ExtendedData/k:Data", NS)
        ]
        # Each source folder has its first data row used as column headings.
        # Read positional values, then validate against the full source label.
        if len(values) < 4 or values[3] not in TARGETS:
            continue
        if len(values) != 12:
            raise ValueError("Interchange source schema changed; review before import")
        ref = placemark.findtext("k:name", default="", namespaces=NS).strip()
        match = re.fullmatch(r"P(\d+)/(\d)([A-Z]+)", ref)
        if not match:
            raise ValueError(f"Unrecognised source marker reference: {ref!r}")
        road, link, source_id = values[3], values[1], values[11]
        if values[0].split(", ") != [ref, link, values[2], road, values[4]]:
            raise ValueError(f"Source label and columns disagree for {ref}")
        if values[9] not in ("LINKMP", "INSERTMP") or values[10] != "SLIP" or not source_id:
            raise ValueError(f"Unexpected interchange asset type or missing ID: {ref}")
        endpoints = link.split("/")
        endpoint_matches = [re.fullmatch(r"(M\d+|A\d+(?:M)?)([A-Z])", value) for value in endpoints]
        if len(endpoints) != 2 or not all(endpoint_matches):
            raise ValueError(f"Unrecognised source connection label: {link!r}")
        aliases = list(dict.fromkeys(item.group(1) for item in endpoint_matches))
        label, expected_roads = TARGETS[road]
        if set(aliases) != expected_roads:
            raise ValueError(f"Unexpected roads for {road}: {link}")
        coordinate_text = placemark.findtext("k:Point/k:coordinates", default="", namespaces=NS).strip()
        coordinates = coordinate_text.split(",")
        if len(coordinates) not in (2, 3):
            raise ValueError(f"Expected a single point coordinate for {ref}")
        lng, lat = map(float, coordinates[:2])
        if not all(math.isfinite(value) for value in (lng, lat)):
            raise ValueError(f"Non-finite coordinates for {ref}")
        # These two named interchanges are within this small Hampshire extent.
        if not (-1.5 < lng < -1.0 and 50.8 < lat < 51.0):
            raise ValueError(f"Coordinates outside the expected interchange area: {ref}")
        if abs(float(values[6]) - lat) > 0.000001 or abs(float(values[7]) - lng) > 0.000001:
            raise ValueError(f"Source position columns and point disagree for {ref}")
        post = {
            "ref": ref,
            "road": road,
            "distance": round(int(match.group(1)) + int(match.group(2)) / 10, 1),
            "direction": match.group(3),
            "lat": lat,
            "lng": lng,
            "link": link,
            "roadAliases": aliases,
            "locationLabel": label,
            "sourceId": source_id,
            "sourceRoad": road,
            "sourceLabel": values[0],
            "sourceAssetType": values[9],
            "source": "user-mymaps",
            "surveyedAt": None,
            "verificationStatus": "source-date-unknown",
        }
        previous = by_source_id.get(source_id)
        if previous is not None:
            if previous != post:
                raise ValueError(f"Conflicting records share source ID {source_id}; manual review required")
            duplicate_count += 1
        else:
            by_source_id[source_id] = post
    posts = sorted(by_source_id.values(), key=lambda post: (post["road"], post["link"], post["distance"], post["direction"]))
    if {post["road"] for post in posts} != set(TARGETS):
        raise ValueError("One or both interchange groups are missing; existing data has not been replaced")
    return posts, duplicate_count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Use an already downloaded KML instead of fetching it")
    parser.add_argument("--fetched-at", help="Actual UTC retrieval time for --input, in ISO 8601 format")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data/posts-supplemental.json")
    args = parser.parse_args()
    if args.input and not args.fetched_at:
        parser.error("--input requires --fetched-at so an old download is not presented as newly retrieved")
    if args.fetched_at:
        try:
            fetched_at = datetime.fromisoformat(args.fetched_at.replace("Z", "+00:00"))
            if fetched_at.tzinfo is None:
                raise ValueError("timezone required")
        except ValueError as exc:
            parser.error(f"--fetched-at must include a timezone: {exc}")
    else:
        fetched_at = datetime.now(timezone.utc)
    if args.input:
        if args.input.stat().st_size > MAX_BYTES:
            raise ValueError("Source KML exceeds the 50 MiB import limit")
        raw = args.input.read_bytes()
    else:
        with urllib.request.urlopen(DOWNLOAD_URL, timeout=60) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Source KML exceeds the 50 MiB import limit")
    posts, duplicate_count = extract(raw)
    result = {
        "fetchedAt": fetched_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {
            "name": "South East Region — existing user-supplied Google My Maps",
            "url": SOURCE_URL,
            "downloadUrl": DOWNLOAD_URL,
            "surveyedAt": None,
            "publishedAt": None,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "verificationStatus": "source-date-unknown",
            "note": "Recovered original marker references and coordinates omitted by road-name filtering. The source does not supply a survey date and cautions that marker posts may not be aligned. Retrieval is not field verification.",
        },
        "import": {
            "version": 1,
            "count": len(posts),
            "bySourceRoad": dict(sorted(Counter(post["road"] for post in posts).items())),
            "duplicateRecordsRemoved": duplicate_count,
            "roadAliasesMethod": "Road names parsed from the explicit source connection label; no road-graph association or marker interpolation.",
        },
        "posts": posts,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"Wrote {len(posts)} source markers; removed {duplicate_count} duplicate records; survey date remains unknown.")


if __name__ == "__main__":
    main()
