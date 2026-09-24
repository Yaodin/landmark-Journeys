#!/usr/bin/env python3
"""Build domain GeoJSON and WKT from sourced journey anchor records.

The anchors describe documented places or explicitly labelled corridors. Dense
vertices are only rendering samples between those anchors, never observations.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

try:
    from .build_routes import as_wkt, haversine_km, slerp, spherical_cardinal, split_dateline
    from .audit_journeys_land import land_at, polygons
except ImportError:  # Direct execution: python scripts/build_journeys.py
    from build_routes import as_wkt, haversine_km, slerp, spherical_cardinal, split_dateline
    from audit_journeys_land import land_at, polygons


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "journeys"
WKT_DIR = ROOT / "data" / "wkt"
DOMAINS = (
    "sailing",
    "rail",
    "road-races",
    "overland",
    "ocean-liners",
    "river",
    "human-powered",
)
TRACK_TYPES = {
    "documented-track",
    "source-derived",
    "waypoint-interpolation",
    "historical-corridor",
}
COLORS = (
    "#f97373", "#f59e58", "#eac95e", "#94d68b", "#55c9ac",
    "#59c8e7", "#74a5ff", "#a98bfa", "#df85e6", "#f586b2",
)
DOMAIN_LABELS = {
    "sailing": "Sailing",
    "rail": "Rail",
    "road-races": "Road / Races",
    "overland": "Overland",
    "ocean-liners": "Ocean Liners",
    "river": "River",
    "human-powered": "Human Powered",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def segment_step_km(anchors: list[dict]) -> float:
    total = sum(haversine_km(a, b) for a, b in zip(anchors, anchors[1:]))
    # A 5 km upper bound keeps zoomed-out curves smooth. Short local routes
    # receive finer samples without making worldwide voyages enormous.
    return min(5.0, max(0.1, total / 3500.0))


@lru_cache(maxsize=1)
def ocean_land_mask():
    return tuple(polygons())


def offshore_land_run_km(points: list[tuple[float, float]], leg_km: float) -> float:
    # The 110m mask generalizes harbors and narrow estuaries as land. Ignore
    # the first/last 80 km of each anchored leg, then inspect every vertex.
    mask = ocean_land_mask()
    last = len(points) - 1
    current = longest = 0
    for index, (lon, lat) in enumerate(points):
        interior = index * leg_km / last >= 80 and (last - index) * leg_km / last >= 80
        current = current + 1 if interior and land_at(lon, lat, mask) else 0
        longest = max(longest, current)
    return longest * leg_km / last


def spline_stays_near_corridor(
    curved: list[tuple[float, float]], a: dict, b: dict, distance_km: float
) -> bool:
    """Reject sailing splines that wander far from a sparsely anchored leg.

    This is a display safeguard, not a claim that the great circle was sailed.
    The cap prevents a neighboring cape/port from bending a long ocean leg
    hundreds of kilometres away from its stated endpoints.
    """
    allowance_km = min(250.0, distance_km * 0.2)
    last = len(curved) - 1
    for index, (lon, lat) in enumerate(curved):
        reference = slerp(a, b, index / last)
        if haversine_km({"lon": lon, "lat": lat}, {"lon": reference[0], "lat": reference[1]}) > allowance_km:
            return False
    return True


def draw_segment(
    anchors: list[dict], ocean_liner: bool = False, sailing: bool = False,
    smoothing_stats: dict[str, int] | None = None,
) -> list[list[list[float]]]:
    step = segment_step_km(anchors)
    points: list[tuple[float, float]] = []
    for index, (a, b) in enumerate(zip(anchors, anchors[1:])):
        distance = haversine_km(a, b)
        steps = max(1, math.ceil(distance / step))
        if (ocean_liner or sailing) and len(anchors) > 2:
            previous = anchors[index - 1] if index else a
            following = anchors[index + 2] if index + 2 < len(anchors) else b
            leg = [spherical_cardinal(previous, a, b, following, n / steps) for n in range(steps + 1)]
            safe = offshore_land_run_km(leg, distance) < 10
            if sailing:
                safe = safe and spline_stays_near_corridor(leg, a, b, distance)
            if not safe:
                leg = [slerp(a, b, n / steps) for n in range(steps + 1)]
            elif smoothing_stats is not None:
                smoothing_stats["smoothed_legs"] = smoothing_stats.get("smoothed_legs", 0) + 1
            if ocean_liner and offshore_land_run_km(leg, distance) >= 10:
                raise ValueError(f"Ocean liner leg crosses mapped land: {a['name']} → {b['name']}")
        else:
            leg = [slerp(a, b, n / steps) for n in range(steps + 1)]
        points.extend(leg if index == 0 else leg[1:])
    return split_dateline(points)


def validate_record(record: dict, domain: str, rank: int) -> None:
    required = (
        "id", "rank", "title", "short_title", "date", "why_famous",
        "route_summary", "source_title", "source_url", "geometry_confidence",
        "geometry_note", "segments",
    )
    require(isinstance(record, dict), f"{domain} rank {rank}: record must be an object")
    for field in required:
        require(field in record, f"{domain} rank {rank}: missing {field}")
    require(record["rank"] == rank, f"{domain}: expected rank {rank}, got {record['rank']}")
    require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", record["id"]) is not None,
            f"{domain} rank {rank}: invalid id")
    for field in ("title", "short_title", "date", "why_famous", "route_summary", "source_title", "geometry_note"):
        require(isinstance(record[field], str) and record[field].strip(),
                f"{domain} rank {rank}: empty {field}")
    require(str(record["source_url"]).startswith("https://"), f"{domain} rank {rank}: source URL must be HTTPS")
    wiki_url = record.get("wiki_url")
    wiki = urlparse(str(wiki_url or ""))
    require(wiki.scheme == "https" and wiki.hostname == "en.wikipedia.org"
            and wiki.path.startswith("/wiki/") and len(wiki.path) > len("/wiki/"),
            f"{domain} rank {rank}: wiki_url must target an English Wikipedia article")
    require(isinstance(record.get("wiki_title"), str) and record["wiki_title"].strip(),
            f"{domain} rank {rank}: missing wiki_title")
    require(record.get("wiki_relation", "exact") in {"exact", "related"},
            f"{domain} rank {rank}: wiki_relation must be exact or related")
    additional_sources = record.get("additional_sources", [])
    require(isinstance(additional_sources, list),
            f"{domain} rank {rank}: additional_sources must be a list")
    for source_index, source in enumerate(additional_sources, 1):
        source_prefix = f"{domain} rank {rank} additional source {source_index}"
        require(isinstance(source, dict), f"{source_prefix}: must be an object")
        require(isinstance(source.get("title"), str) and source["title"].strip(),
                f"{source_prefix}: title is required")
        parsed = urlparse(str(source.get("url", "")))
        require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password,
                f"{source_prefix}: URL must be a safe HTTPS URL")
        require("note" not in source or isinstance(source["note"], str),
                f"{source_prefix}: note must be a string when present")
    require(record["geometry_confidence"].lower() in {"high", "medium", "low", "h", "m", "l"},
            f"{domain} rank {rank}: invalid confidence")
    require(isinstance(record["segments"], list) and record["segments"],
            f"{domain} rank {rank}: no segments")
    for number, segment in enumerate(record["segments"], 1):
        prefix = f"{domain} rank {rank} segment {number}"
        require(segment.get("track_type") in TRACK_TYPES, f"{prefix}: invalid track_type")
        require(isinstance(segment.get("mode"), str) and segment["mode"].strip(), f"{prefix}: missing mode")
        require(str(segment.get("source_url", "")).startswith("https://"), f"{prefix}: missing HTTPS source")
        anchors = segment.get("anchors")
        require(isinstance(anchors, list) and len(anchors) >= 2, f"{prefix}: at least two anchors required")
        for point in anchors:
            require(isinstance(point, dict) and point.get("name"), f"{prefix}: named anchors required")
            lat, lon = point.get("lat"), point.get("lon")
            require(isinstance(lat, (int, float)) and isinstance(lon, (int, float))
                    and math.isfinite(lat) and math.isfinite(lon)
                    and -90 <= lat <= 90 and -180 <= lon <= 180,
                    f"{prefix}: invalid coordinate at {point.get('name')}")


def build_domain(domain: str) -> tuple[int, int]:
    source_path = SOURCE_DIR / f"{domain}.json"
    records = json.loads(source_path.read_text(encoding="utf-8"))
    require(isinstance(records, list) and records,
            f"{domain}: expected a nonempty list of records")
    ids: set[str] = set()
    for rank, record in enumerate(records, 1):
        validate_record(record, domain, rank)
        require(record["id"] not in ids, f"{domain}: duplicate id {record['id']}")
        ids.add(record["id"])
    features = []
    wkt_dir = WKT_DIR / domain
    wkt_dir.mkdir(parents=True, exist_ok=True)
    for rank, record in enumerate(records, 1):
        lines: list[list[list[float]]] = []
        line_styles = []
        anchors = []
        distance = 0.0
        smoothing_stats: dict[str, int] = {"smoothed_legs": 0, "eligible_legs": 0}
        for segment_index, segment in enumerate(record["segments"]):
            segment_anchors = segment["anchors"]
            if domain == "sailing" and len(segment_anchors) > 2:
                smoothing_stats["eligible_legs"] += len(segment_anchors) - 1
            drawn = draw_segment(
                segment_anchors,
                ocean_liner=domain == "ocean-liners",
                sailing=domain == "sailing",
                smoothing_stats=smoothing_stats if domain == "sailing" else None,
            )
            lines.extend(drawn)
            line_styles.extend({
                "segment_index": segment_index,
                "mode": segment["mode"],
                "track_type": segment["track_type"],
                "source_url": segment["source_url"],
            } for _ in drawn)
            anchors.extend(segment_anchors)
            distance += sum(haversine_km(a, b) for a, b in zip(segment_anchors, segment_anchors[1:]))
        require(lines, f"{domain} rank {rank}: no drawable geometry")
        properties = {key: value for key, value in record.items() if key != "segments"}
        confidence = record["geometry_confidence"].lower()
        confidence = {"h": "high", "m": "medium", "l": "low"}.get(confidence, confidence)
        properties.update({
            "domain": domain,
            "era": record.get("era", DOMAIN_LABELS[domain]),
            "group": f"{(rank - 1) // 10 * 10 + 1}–{min((rank - 1) // 10 * 10 + 10, len(records))}",
            "color": COLORS[(rank - 1) % len(COLORS)],
            "quality": "illustrative_corridor" if any(
                segment["track_type"] in {"waypoint-interpolation", "historical-corridor"}
                for segment in record["segments"]
            ) else "source_derived",
            "quality_label": f"{confidence.capitalize()} anchor confidence · {len(record['segments'])} segment{'s' if len(record['segments']) != 1 else ''}",
            "description": record["geometry_note"],
            "overview": record.get("overview", record["why_famous"]),
            "anchors": anchors,
            "segments": record["segments"],
            "line_styles": line_styles,
            "distance_km": round(distance, 1),
            "vertex_count": sum(len(line) for line in lines),
            "geometry_type": "MultiLineString" if len(lines) > 1 else "LineString",
            "interpolation_method": (
                "land-checked spherical cardinal through historical shipping corridors" if domain == "ocean-liners"
                else "conservative offshore spherical cardinal where safe; great-circle fallback between anchors" if domain == "sailing"
                else "great-circle between anchors"
            ),
            "wkt_file": f"data/wkt/{domain}/{record['id']}.wkt",
        })
        if domain == "sailing":
            properties["smoothing_stats"] = smoothing_stats
        geometry = {
            "type": properties["geometry_type"],
            "coordinates": lines if len(lines) > 1 else lines[0],
        }
        features.append({"type": "Feature", "properties": properties, "geometry": geometry})
        (wkt_dir / f"{record['id']}.wkt").write_text(as_wkt(lines) + "\n", encoding="utf-8")
    collection = {
        "type": "FeatureCollection",
        "name": f"Landmark Journeys — {DOMAIN_LABELS[domain]}",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "metadata": {
            "generated_by": "scripts/build_journeys.py",
            "source_file": f"data/journeys/{domain}.json",
            "method": (
                "Land-checked spherical cardinal interpolation through sourced ports and illustrative shipping corridors; independent route segments remain separate" if domain == "ocean-liners"
                else "Conservative offshore spherical-cardinal smoothing between sailing anchors where safe, otherwise great-circle samples; independent route segments remain separate" if domain == "sailing"
                else "Great-circle rendering samples between sourced place anchors; independent route segments remain separate"
            ),
            "warning": "Dense interpolated vertices are not observed historic positions. Read feature and segment evidence labels.",
            "route_count": len(features),
        },
        "features": features,
    }
    (SOURCE_DIR / f"{domain}.geojson").write_text(json.dumps(collection, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    vertices = sum(feature["properties"]["vertex_count"] for feature in features)
    return len(features), vertices


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("domains", nargs="*", choices=DOMAINS, help="Domains to build (default: all available sources)")
    args = parser.parse_args()
    domains = args.domains or [domain for domain in DOMAINS if (SOURCE_DIR / f"{domain}.json").exists()]
    require(domains, "No journey source JSON files found")
    for domain in domains:
        routes, vertices = build_domain(domain)
        print(f"{domain}: built {routes} routes with {vertices:,} vertices")


if __name__ == "__main__":
    main()
