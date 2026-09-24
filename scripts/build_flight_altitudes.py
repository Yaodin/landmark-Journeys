#!/usr/bin/env python3
"""Build reproducible, explicitly estimated 3D flight tracks.

The 2D source GeoJSON and WKT remain unchanged. Heights are illustrative,
piecewise profiles between the existing researched geographic anchors, not
observed telemetry. See data/flight-altitude-profiles.json for every estimate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/routes.geojson"
OVERVIEW = ROOT / "data/all-overview.geojson"
PROFILES = ROOT / "data/flight-altitude-profiles.json"
FULL_OUTPUT = ROOT / "data/flights-3d.geojson"
OVERVIEW_OUTPUT = ROOT / "data/flights-3d-overview.geojson"
EARTH_RADIUS_KM = 6371.0088


def lines_of(geometry: dict) -> list[list[list[float]]]:
    if geometry["type"] == "LineString":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiLineString":
        return geometry["coordinates"]
    raise ValueError(f"Unsupported flight geometry: {geometry['type']}")


def haversine_km(a: list[float], b: list[float]) -> float:
    lon1, lat1 = map(math.radians, a[:2])
    lon2, lat2 = map(math.radians, b[:2])
    dlon = (lon2 - lon1 + math.pi) % (2 * math.pi) - math.pi
    dlat = lat2 - lat1
    half = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1, math.sqrt(half)))


def smoothstep(value: float) -> float:
    t = min(1.0, max(0.0, value))
    return t * t * (3 - 2 * t)


def anchor_vertex_indices(vertices: list[list[float]], anchors: list[dict], route_id: str) -> list[int]:
    indices = [0]
    for anchor in anchors[1:-1]:
        target = [anchor["lon"], anchor["lat"]]
        start = indices[-1] + 1
        if start >= len(vertices) - 1:
            raise ValueError(f"{route_id}: anchor order exceeds vertices")
        exact = next((i for i in range(start, len(vertices) - 1)
                      if haversine_km(vertices[i], target) < 0.05), None)
        index = exact if exact is not None else min(
            range(start, len(vertices) - 1), key=lambda i: haversine_km(vertices[i], target)
        )
        error_km = haversine_km(vertices[index], target)
        if error_km > 25:
            raise ValueError(f"{route_id}: anchor {anchor['name']} is {error_km:.1f} km from route")
        indices.append(index)
    indices.append(len(vertices) - 1)
    return indices


def estimated_heights(feature: dict, profile: dict) -> tuple[list[list[float]], list[int]]:
    route_id = feature["properties"]["id"]
    source_lines = lines_of(feature["geometry"])
    vertices = [vertex for line in source_lines for vertex in line]
    if not vertices or any(len(vertex) != 2 for vertex in vertices):
        raise ValueError(f"{route_id}: expected nonempty 2D source coordinates")
    distances = [0.0]
    for before, after in zip(vertices, vertices[1:]):
        distances.append(distances[-1] + haversine_km(before, after))

    anchors = feature["properties"]["anchors"]
    indices = anchor_vertex_indices(vertices, anchors, route_id)
    stops = set(range(len(anchors))) if profile.get("stops") == "all" else set(profile.get("stops", []))
    stops.update((0, len(anchors) - 1))
    controls = [0.0 if i in stops else float(profile["cruise_m"]) for i in range(len(anchors))]
    for index, altitude in profile.get("controls_m", {}).items():
        controls[int(index)] = float(altitude)
    if any(not math.isfinite(value) or value < 0 for value in controls):
        raise ValueError(f"{route_id}: invalid anchor altitude")

    heights = [0.0] * len(vertices)
    for anchor_index, (first, last) in enumerate(zip(indices, indices[1:])):
        start_distance, end_distance = distances[first], distances[last]
        segment_km = end_distance - start_distance
        start_height, end_height = controls[anchor_index:anchor_index + 2]
        peak = float(profile.get("segment_peaks_m", {}).get(str(anchor_index), profile["cruise_m"]))
        climb_km = min(float(profile["climb_km"]), segment_km * 0.45)
        descent_km = min(float(profile["descent_km"]), segment_km * 0.45)
        for index in range(first, last + 1):
            travelled = distances[index] - start_distance
            remaining = end_distance - distances[index]
            if segment_km <= 0:
                altitude = start_height
            elif start_height == 0 and end_height == 0:
                altitude = peak * min(smoothstep(travelled / climb_km), smoothstep(remaining / descent_km))
            elif start_height == 0:
                altitude = end_height * smoothstep(travelled / climb_km)
            elif end_height == 0:
                altitude = start_height * smoothstep(remaining / descent_km)
            else:
                altitude = start_height + (end_height - start_height) * smoothstep(travelled / segment_km)
            if profile.get("pattern") == "illustrative-day-night" and altitude > 0:
                # Approximate day/night cycling from distance, not mission timestamps.
                # 1,600 km approximates a solar day at Solar Impulse's long-leg pace.
                daylight = (1 - math.cos(2 * math.pi * travelled / 1600)) / 2
                altitude *= 0.22 + 0.78 * daylight
            heights[index] = round(altitude, 1)
    if len(heights) != feature["properties"]["vertex_count"]:
        raise ValueError(f"{route_id}: altitude count does not match source vertex count")
    if any(not math.isfinite(value) or value < 0 or value > 30000 for value in heights):
        raise ValueError(f"{route_id}: altitude outside plausible aircraft range")
    return [[point[0], point[1], height] for point, height in zip(vertices, heights)], indices


def build() -> tuple[dict, dict]:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    overview = json.loads(OVERVIEW.read_text(encoding="utf-8"))
    profiles_data = json.loads(PROFILES.read_text(encoding="utf-8"))
    profiles = profiles_data["profiles"]
    source_by_id = {feature["properties"]["id"]: feature for feature in source["features"]}
    preview_by_id = {feature["properties"]["id"]: feature for feature in overview["features"]}
    if len(source_by_id) != 25 or set(profiles) != set(source_by_id):
        raise ValueError("Altitude profiles must cover exactly the 25 source flights")

    full_features = []
    preview_features = []
    for route_id, feature in source_by_id.items():
        profile = profiles[route_id]
        points, anchor_indices = estimated_heights(feature, profile)
        source_lines = lines_of(feature["geometry"])
        full_lines = []
        offset = 0
        for line in source_lines:
            full_lines.append(points[offset:offset + len(line)])
            offset += len(line)
        geometry = {
            "type": feature["geometry"]["type"],
            "coordinates": full_lines[0] if len(full_lines) == 1 and feature["geometry"]["type"] == "LineString" else full_lines,
        }
        heights = [point[2] for point in points]
        estimate = {
            "method": "anchor-constrained smooth climb/cruise/descent interpolation",
            "confidence": profile["confidence"],
            "basis": profile["basis"],
            "sources": list(dict.fromkeys([feature["properties"]["source_url"], profile["altitude_source_url"]])),
            "max_height_m": max(heights),
            "min_height_m": min(heights),
            "anchor_vertex_indices": anchor_indices,
            "is_observed_trace": False,
        }
        properties = {**feature["properties"], "altitude_estimate": estimate}
        full_features.append({"type": "Feature", "properties": properties, "geometry": geometry})

        preview_feature = preview_by_id[route_id]
        preview_lines = lines_of(preview_feature["geometry"])
        if len(preview_lines) != len(full_lines):
            raise ValueError(f"{route_id}: preview/source part counts differ")
        lifted_preview_lines = []
        for full_line, preview_line in zip(full_lines, preview_lines):
            cursor = 0
            lifted = []
            for preview_point in preview_line:
                while cursor < len(full_line) and full_line[cursor][:2] != preview_point:
                    cursor += 1
                if cursor == len(full_line):
                    raise ValueError(f"{route_id}: overview vertex is not a source vertex")
                lifted.append(full_line[cursor])
                cursor += 1
            lifted_preview_lines.append(lifted)
        preview_geometry = {
            "type": preview_feature["geometry"]["type"],
            "coordinates": lifted_preview_lines[0] if preview_feature["geometry"]["type"] == "LineString" else lifted_preview_lines,
        }
        preview_features.append({"type": "Feature", "properties": properties, "geometry": preview_geometry})

    metadata = {
        "generated_by": "scripts/build_flight_altitudes.py",
        "source_2d_geojson_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "profile_sha256": hashlib.sha256(PROFILES.read_bytes()).hexdigest(),
        "vertical_interpretation": profiles_data["vertical_interpretation"],
        "warning": profiles_data["warning"],
        "units": "lon degrees, lat degrees, estimated height metres",
        "route_count": len(full_features),
    }
    full = {"type": "FeatureCollection", "name": "Landmark Journeys — estimated 3D flights", "metadata": metadata, "features": full_features}
    preview = {"type": "FeatureCollection", "name": "Landmark Journeys — estimated 3D flight previews", "metadata": {**metadata, "display_only": True}, "features": preview_features}
    return full, preview


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if generated GeoJSON differs from checked-in files")
    args = parser.parse_args()
    full, preview = build()
    for path, collection in ((FULL_OUTPUT, full), (OVERVIEW_OUTPUT, preview)):
        serialized = json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != serialized:
                raise SystemExit(f"Stale generated file: {path}; run scripts/build_flight_altitudes.py")
        else:
            path.write_text(serialized, encoding="utf-8")
            print(f"Wrote {path.relative_to(ROOT)}: {len(collection['features'])} flights")


if __name__ == "__main__":
    main()
