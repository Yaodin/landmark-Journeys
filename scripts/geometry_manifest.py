#!/usr/bin/env python3
"""Record and verify the source -> GeoJSON -> WKT geometry build chain.

Run after build_routes.py and build_journeys.py. This manifest is deterministic:
it records input/output hashes and verifies that each WKT still corresponds
exactly to the generated GeoJSON geometry. Display-only map simplification is
not part of this chain and never changes the archival outputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

try:
    from .build_routes import as_wkt
    from .build_journeys import DOMAINS
except ImportError:
    from build_routes import as_wkt
    from build_journeys import DOMAINS


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "geometry-build-manifest.json"


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_manifest() -> dict:
    collections = []
    for domain in ("flights", *DOMAINS):
        source = ROOT / ("scripts/build_routes.py" if domain == "flights" else f"data/journeys/{domain}.json")
        builder = ROOT / ("scripts/build_routes.py" if domain == "flights" else "scripts/build_journeys.py")
        geojson = ROOT / ("data/routes.geojson" if domain == "flights" else f"data/journeys/{domain}.geojson")
        data = json.loads(geojson.read_text(encoding="utf-8"))
        features = data["features"]
        if not features:
            raise ValueError(f"{domain}: no generated routes")
        if domain != "flights":
            records = json.loads(source.read_text(encoding="utf-8"))
            if [record["id"] for record in records] != [feature["properties"]["id"] for feature in features]:
                raise ValueError(f"{domain}: source record order/IDs differ from GeoJSON")
        routes = []
        for feature in features:
            properties = feature["properties"]
            geometry = feature["geometry"]
            lines = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
            vertex_count = sum(len(line) for line in lines)
            if vertex_count != properties["vertex_count"]:
                raise ValueError(f"{domain}/{properties['id']}: vertex count differs from GeoJSON")
            wkt = (ROOT / properties["wkt_file"]).resolve()
            if not wkt.is_relative_to(ROOT / "data" / "wkt"):
                raise ValueError(f"{domain}/{properties['id']}: WKT path is outside data/wkt")
            if wkt.read_text(encoding="utf-8").strip() != as_wkt(lines):
                raise ValueError(f"{domain}/{properties['id']}: WKT differs from GeoJSON geometry")
            routes.append({
                "id": properties["id"],
                "vertices": vertex_count,
                "wkt": relative(wkt),
                "wkt_sha256": digest(wkt),
            })
        expected_wkt = {route["wkt"] for route in routes}
        wkt_directory = ROOT / "data" / "wkt" / domain if domain != "flights" else ROOT / "data" / "wkt"
        actual_wkt = {relative(path) for path in wkt_directory.glob("*.wkt")}
        if actual_wkt != expected_wkt:
            raise ValueError(f"{domain}: orphan or missing WKT files: {sorted(actual_wkt ^ expected_wkt)}")
        collections.append({
            "domain": domain,
            "source": relative(source),
            "source_sha256": digest(source),
            "builder": relative(builder),
            "builder_sha256": digest(builder),
            "geometry": relative(geojson),
            "geometry_sha256": digest(geojson),
            "method": data["metadata"]["method"],
            "routes": routes,
        })
    preview = ROOT / "data/all-overview.geojson"
    preview_data = json.loads(preview.read_text(encoding="utf-8"))
    route_count = sum(len(entry["routes"]) for entry in collections)
    if (not preview_data.get("metadata", {}).get("display_only")
            or len(preview_data.get("features", [])) != route_count
            or preview_data["metadata"].get("route_count") != route_count):
        raise ValueError(f"Show all preview must contain {route_count} display-only routes")
    expected_inputs = [
        {"path": entry["geometry"], "sha256": entry["geometry_sha256"]}
        for entry in collections
    ]
    if preview_data["metadata"]["full_resolution_inputs"] != expected_inputs:
        raise ValueError("Show all preview is stale; run build_overview.py --write")
    return {
        "schema_version": 1,
        "purpose": "Reproducible source, interpolation, GeoJSON and full-resolution WKT inventory; map simplification is display-only.",
        "shared_geometry_functions": [
            "scripts/build_routes.py:haversine_km",
            "scripts/build_routes.py:slerp",
            "scripts/build_routes.py:split_dateline",
            "scripts/build_routes.py:as_wkt",
        ],
        "shared_geometry_sha256": digest(ROOT / "scripts/build_routes.py"),
        "display_preview": {
            "path": relative(preview),
            "sha256": digest(preview),
            "builder": "scripts/build_overview.py",
            "builder_sha256": digest(ROOT / "scripts/build_overview.py"),
        },
        "collections": collections,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write the deterministic manifest after regeneration")
    mode.add_argument("--check", action="store_true", help="verify the checked-in manifest and every WKT")
    args = parser.parse_args()
    actual = build_manifest()
    if args.write:
        MANIFEST.write_text(json.dumps(actual, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {relative(MANIFEST)}: {sum(len(entry['routes']) for entry in actual['collections'])} routes")
    elif not MANIFEST.exists() or json.loads(MANIFEST.read_text(encoding="utf-8")) != actual:
        raise SystemExit("Geometry manifest is stale; rebuild geometry and run geometry_manifest.py --write")
    else:
        print(f"Verified {relative(MANIFEST)}: {sum(len(entry['routes']) for entry in actual['collections'])} routes")


if __name__ == "__main__":
    main()
