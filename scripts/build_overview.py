#!/usr/bin/env python3
"""Build a lightweight Show all preview without changing full GeoJSON or WKT.

Ordinary routes in the world overview need far fewer screen-visible vertices.
Selected routes load their complete domain geometry on demand. This derivative
is never used for downloadable GeoJSON or WKT.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

try:
    from .build_journeys import DOMAINS
except ImportError:
    from build_journeys import DOMAINS


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "all-overview.geojson"
PREVIEW_ZOOM = 6
TOLERANCE_PX = 0.75
MAX_LAT = 85.05112878


def project(point: list[float]) -> tuple[float, float]:
    lon, lat = point
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    sine = math.sin(math.radians(lat))
    size = 256 * 2 ** PREVIEW_ZOOM
    return ((lon + 180) / 360 * size, (0.5 - math.log((1 + sine) / (1 - sine)) / (4 * math.pi)) * size)


def simplify_line(line: list[list[float]]) -> list[list[float]]:
    """Screen-space Ramer-Douglas-Peucker; endpoints and dateline parts stay."""
    if len(line) <= 2:
        return line
    projected = [project(point) for point in line]
    keep = {0, len(line) - 1}
    ranges = [(0, len(line) - 1)]
    threshold = TOLERANCE_PX ** 2
    while ranges:
        start, end = ranges.pop()
        ax, ay = projected[start]
        bx, by = projected[end]
        dx, dy = bx - ax, by - ay
        length_squared = dx * dx + dy * dy
        farthest = None
        farthest_distance = threshold
        for index in range(start + 1, end):
            px, py = projected[index]
            fraction = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_squared)) if length_squared else 0.0
            offset_x = px - ax - fraction * dx
            offset_y = py - ay - fraction * dy
            distance = offset_x * offset_x + offset_y * offset_y
            if distance > farthest_distance:
                farthest, farthest_distance = index, distance
        if farthest is not None:
            keep.add(farthest)
            ranges.extend(((start, farthest), (farthest, end)))
    return [line[index] for index in sorted(keep)]


def build_overview() -> dict:
    features = []
    inputs = []
    for domain in ("flights", *DOMAINS):
        path = ROOT / ("data/routes.geojson" if domain == "flights" else f"data/journeys/{domain}.geojson")
        collection = json.loads(path.read_text(encoding="utf-8"))
        if not collection["features"]:
            raise ValueError(f"{domain}: no full-resolution routes")
        inputs.append({"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        for feature in collection["features"]:
            geometry = feature["geometry"]
            lines = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
            simplified = [simplify_line(line) for line in lines]
            preview_geometry = {
                "type": geometry["type"],
                "coordinates": simplified[0] if geometry["type"] == "LineString" else simplified,
            }
            features.append({"type": "Feature", "properties": feature["properties"], "geometry": preview_geometry})
    if len({feature["properties"]["id"] for feature in features}) != len(features):
        raise ValueError("Show all preview contains duplicate route IDs")
    return {
        "type": "FeatureCollection",
        "name": "Landmark Journeys — Show all display preview",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "metadata": {
            "generated_by": "scripts/build_overview.py",
            "display_only": True,
            "route_count": len(features),
            "method": "Mercator screen-space Ramer-Douglas-Peucker per dateline-split line",
            "zoom": PREVIEW_ZOOM,
            "tolerance_px": TOLERANCE_PX,
            "full_resolution_inputs": inputs,
            "warning": "Preview vertices are for drawing only; select a route to load its complete GeoJSON and WKT.",
        },
        "features": features,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    payload = json.dumps(build_overview(), separators=(",", ":"), ensure_ascii=False) + "\n"
    if args.write:
        OUTPUT.write_text(payload, encoding="utf-8")
        print(f"Wrote {OUTPUT.relative_to(ROOT)} ({len(payload):,} bytes)")
    elif not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != payload:
        raise SystemExit("Show all preview is stale; run build_overview.py --write after rebuilding full geometry")
    else:
        print(f"Verified {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
