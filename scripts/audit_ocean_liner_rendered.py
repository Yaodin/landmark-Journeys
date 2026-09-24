#!/usr/bin/env python3
"""Inspect actual generated ocean-liner lines against the coarse bundled land mask.

Natural Earth 110m omits small islands and generalizes estuaries. Findings are
cartographic QA prompts, never navigational clearance claims.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from audit_journeys_land import land_at, polygons
from build_routes import haversine_km


ROOT = Path(__file__).resolve().parents[1]


def distance(a, b):
    return haversine_km({"lon": a[0], "lat": a[1]}, {"lon": b[0], "lat": b[1]})


def land_runs(line, mask):
    start = None
    length = 0.0
    country = None
    for index, point in enumerate(line):
        hit = land_at(point[0], point[1], mask)
        if hit:
            if start is None:
                start, country, length = index, hit, 0.0
            elif index:
                length += distance(line[index - 1], point)
        elif start is not None:
            yield length, country, line[start], line[index - 1]
            start = country = None
    if start is not None:
        yield length, country, line[start], line[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threshold-km", type=float, default=10.0)
    parser.add_argument("--fail", action="store_true", help="treat every mapped land run as an error, including generalized harbors")
    args = parser.parse_args()
    collection = json.loads((ROOT / "data/journeys/ocean-liners.geojson").read_text())
    mask = tuple(polygons())
    findings = []
    for feature in collection["features"]:
        geometry = feature["geometry"]
        lines = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
        for line in lines:
            for length, country, first, last in land_runs(line, mask):
                if length >= args.threshold_km:
                    findings.append((length, feature["properties"]["id"], country, first, last))
    for length, mission, country, first, last in sorted(findings, reverse=True):
        print(f"{length:6.1f} km  {mission}  {country}  {first} -> {last}")
    print(f"{len(findings)} rendered land runs >= {args.threshold_km:g} km (Natural Earth 110m)")
    return bool(findings) if args.fail else False


if __name__ == "__main__":
    raise SystemExit(main())
