"""Flag long overland stretches in interpolated sea routes.

This uses the bundled Natural Earth 110m country polygons. It is a coarse QA
aid, not a coastline or historical track validator: inspect reported legs.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STEP_KM = 5
PORT_EXCLUSION_KM = 80
SEVERE_LAND_KM = 250


def polygons():
    features = json.loads((ROOT / "data/ne_110m_admin_0_countries.geojson").read_text())["features"]
    for feature in features:
        geometry = feature["geometry"]
        for polygon in geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]:
            ring = polygon[0]
            yield (
                min(p[0] for p in ring),
                max(p[0] for p in ring),
                min(p[1] for p in ring),
                max(p[1] for p in ring),
                ring,
                feature["properties"].get("ADMIN", "land"),
            )


def in_ring(lon, lat, ring):
    contained = False
    previous = ring[-1]
    for point in ring:
        x1, y1 = previous
        x2, y2 = point
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            contained = not contained
        previous = point
    return contained


def land_at(lon, lat, land_polygons):
    for west, east, south, north, ring, country in land_polygons:
        if west <= lon <= east and south <= lat <= north and in_ring(lon, lat, ring):
            return country
    return None


def great_circle(a, b):
    def vector(anchor):
        lon = math.radians(anchor["lon"])
        lat = math.radians(anchor["lat"])
        return (math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat))

    u, v = vector(a), vector(b)
    radians = math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(u, v)))))
    distance_km = 6371.0 * radians
    count = max(3, math.ceil(distance_km / STEP_KM))
    for index in range(count + 1):
        fraction = index / count
        if radians < 1e-9:
            x, y, z = u
        else:
            denominator = math.sin(radians)
            left = math.sin((1 - fraction) * radians) / denominator
            right = math.sin(fraction * radians) / denominator
            x, y, z = (left * p + right * q for p, q in zip(u, v))
        yield index, count, distance_km, math.degrees(math.atan2(y, x)), math.degrees(math.atan2(z, math.hypot(x, y)))


def severe_land_run(a, b, land_polygons):
    longest = 0.0
    start = end = 0.0
    country = None
    run_start = None
    run_country = None
    for index, count, distance_km, lon, lat in great_circle(a, b):
        along = distance_km * index / count
        interior = PORT_EXCLUSION_KM <= along <= distance_km - PORT_EXCLUSION_KM
        hit = land_at(lon, lat, land_polygons) if interior else None
        if hit:
            if run_start is None:
                run_start, run_country = along, hit
        elif run_start is not None:
            length = along - run_start
            if length > longest:
                longest, start, end, country = length, run_start, along, run_country
            run_start = run_country = None
    return longest, start, end, country


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("domains", nargs="*", default=["sailing", "ocean-liners"])
    parser.add_argument("--fail", action="store_true", help="exit nonzero if severe crossings are found")
    parser.add_argument("--threshold-km", type=float, default=SEVERE_LAND_KM, help="minimum inland crossing length to report")
    args = parser.parse_args()
    mask = list(polygons())
    findings = []
    for domain in args.domains:
        records = json.loads((ROOT / "data/journeys" / f"{domain}.json").read_text())
        for record in records:
            for segment_index, segment in enumerate(record["segments"]):
                mode = segment["mode"].lower()
                maritime_terms = ("sail", "boat", "liner", "ocean", "clipper", "sea", "ice-drift", "ferry", "ship", "steam", "kayak", "row", "raft")
                inland_terms = ("river", "canal", "inland", "danube", "euphrates")
                inland_anchors = sum(
                    any(term in (anchor["name"] + " " + anchor.get("note", "")).lower() for term in inland_terms)
                    for anchor in segment["anchors"]
                )
                if domain not in ("sailing", "ocean-liners") and (any(term in mode for term in inland_terms + ("caravan", "road", "rail", "foot")) or inland_anchors >= 2):
                    continue  # Country polygons do not resolve inland waterways.
                if domain not in ("sailing", "ocean-liners") and not any(term in mode for term in maritime_terms):
                    continue
                anchors = segment["anchors"]
                for anchor_index, (a, b) in enumerate(zip(anchors, anchors[1:])):
                    length, start, end, country = severe_land_run(a, b, mask)
                    if length >= args.threshold_km:
                        findings.append((round(length), domain, record["id"], segment_index, anchor_index, a["name"], b["name"], country, round(start), round(end)))
    for length, domain, route, segment, anchor, first, last, country, start, end in sorted(findings, reverse=True):
        print(f"{length:5} km  {domain}/{route} segment {segment} anchors {anchor}->{anchor + 1}: {first} -> {last} ({country}, {start}-{end} km from leg start)")
    print(f"{len(findings)} sea-leg crossings (Natural Earth 110m; >= {args.threshold_km:g} km inland beyond port buffers)")
    return bool(findings) if args.fail else False


if __name__ == "__main__":
    raise SystemExit(main())
