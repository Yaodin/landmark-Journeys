"""Geometry and evidence validation for the nonflight journey collections."""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import build_journeys


def record(rank: int) -> dict:
    return {
        "id": f"sample-{rank}",
        "rank": rank,
        "title": f"Sample journey {rank}",
        "short_title": f"Sample {rank}",
        "date": "1900",
        "why_famous": "A documented test journey.",
        "route_summary": "Island A → Island B",
        "source_title": "Example Archive",
        "source_url": "https://example.org/journey",
        "wiki_title": "Example journey",
        "wiki_url": "https://en.wikipedia.org/wiki/Example_journey",
        "geometry_confidence": "medium",
        "geometry_note": "A corridor between named landfalls.",
        "segments": [{
            "mode": "sailing",
            "track_type": "historical-corridor",
            "source_url": "https://example.org/journey",
            "anchors": [
                {"name": "Island A", "lat": 10.0, "lon": 179.5, "note": ""},
                {"name": "Island B", "lat": 11.0, "lon": -179.5, "note": ""},
            ],
        }],
    }


class JourneyBuildTests(unittest.TestCase):
    def test_sailing_smoothing_is_conservative_and_traceable(self) -> None:
        collection = json.loads((build_journeys.SOURCE_DIR / "sailing.geojson").read_text(encoding="utf-8"))
        stats = [feature["properties"]["smoothing_stats"] for feature in collection["features"]]
        self.assertEqual(len(stats), 25)
        self.assertGreater(sum(item["smoothed_legs"] for item in stats), 0)
        self.assertTrue(all(0 <= item["smoothed_legs"] <= item["eligible_legs"] for item in stats))
        self.assertTrue(all("offshore spherical cardinal" in feature["properties"]["interpolation_method"]
                            for feature in collection["features"]))

        anchors = [
            {"name": "A", "lat": 40, "lon": -55},
            {"name": "B", "lat": 45, "lon": -40},
            {"name": "C", "lat": 42, "lon": -25},
            {"name": "D", "lat": 50, "lon": -10},
        ]
        curved = build_journeys.draw_segment(anchors, sailing=True)[0]
        steps = math.ceil(build_journeys.haversine_km(anchors[0], anchors[1]) /
                          build_journeys.segment_step_km(anchors))
        midpoint = curved[steps // 2]
        direct = build_journeys.slerp(anchors[0], anchors[1], (steps // 2) / steps)
        self.assertGreater(build_journeys.haversine_km(
            {"lon": midpoint[0], "lat": midpoint[1]},
            {"lon": direct[0], "lat": direct[1]}), 1.0)

        with patch.object(build_journeys, "offshore_land_run_km", return_value=11.0):
            fallback = build_journeys.draw_segment(anchors, sailing=True)[0]
        self.assertAlmostEqual(fallback[steps // 2][0], direct[0], places=5)
        self.assertAlmostEqual(fallback[steps // 2][1], direct[1], places=5)

    def test_ocean_liners_use_smooth_land_checked_corridors(self) -> None:
        records = json.loads((build_journeys.SOURCE_DIR / "ocean-liners.json").read_text(encoding="utf-8"))
        collection = json.loads((build_journeys.SOURCE_DIR / "ocean-liners.geojson").read_text(encoding="utf-8"))
        self.assertEqual(len(records), 25)
        self.assertTrue(all("land-checked spherical cardinal" in feature["properties"]["interpolation_method"]
                            for feature in collection["features"]))
        for record in records:
            for segment in record["segments"]:
                with self.subTest(route=record["id"]):
                    self.assertTrue(build_journeys.draw_segment(segment["anchors"], ocean_liner=True))

        anchors = [
            {"name": "A", "lat": 40, "lon": -55},
            {"name": "B", "lat": 45, "lon": -40},
            {"name": "C", "lat": 42, "lon": -25},
            {"name": "D", "lat": 50, "lon": -10},
        ]
        line = build_journeys.draw_segment(anchors, ocean_liner=True)[0]
        first_steps = math.ceil(build_journeys.haversine_km(anchors[0], anchors[1]) / build_journeys.segment_step_km(anchors))
        second_steps = math.ceil(build_journeys.haversine_km(anchors[1], anchors[2]) / build_journeys.segment_step_km(anchors))
        midpoint = line[first_steps + second_steps // 2]
        great_circle = build_journeys.slerp(anchors[1], anchors[2], (second_steps // 2) / second_steps)
        self.assertGreater(abs(midpoint[1] - great_circle[1]), 0.01)

    def test_1897_bicycle_corps_does_not_reuse_1896_yellowstone_route(self) -> None:
        records = json.loads((build_journeys.SOURCE_DIR / "human-powered.json").read_text(encoding="utf-8"))
        route = next(route for route in records if route["id"] == "human-25th-infantry-bicycle-1897")
        names = [anchor["name"] for segment in route["segments"] for anchor in segment["anchors"]]
        self.assertIn("Fort Custer, Montana", names)
        self.assertIn("Custer National Cemetery / Little Bighorn", names)
        self.assertIn("Moorcroft, Wyoming", names)
        self.assertIn("Crawford, Nebraska", names)
        self.assertIn("Alliance, Nebraska", names)
        self.assertIn("Broken Bow, Nebraska", names)
        self.assertNotIn("Yellowstone region", names)
        self.assertNotIn("Cody", names)
        self.assertNotIn("Cheyenne", names)
        self.assertNotIn("Omaha", names)
        self.assertNotIn("Kansas City", names)
        self.assertEqual(route["wiki_relation"], "related")

    def test_oregon_trail_has_distinct_era_dependent_columbia_endings(self) -> None:
        records = json.loads((build_journeys.SOURCE_DIR / "overland.json").read_text(encoding="utf-8"))
        route = next(route for route in records if route["id"] == "oregon-trail-migrations")
        self.assertEqual(len(route["segments"]), 3)
        self.assertEqual(route["segments"][1]["mode"], "river boat / raft with portage")
        self.assertIn("Fort Vancouver", [a["name"] for a in route["segments"][1]["anchors"]])
        self.assertIn("1846 onward", route["segments"][2]["mode"])
        self.assertIn("Oregon City", [a["name"] for a in route["segments"][2]["anchors"]])

    def test_all_seven_domains_match_generated_routes(self) -> None:
        for domain in build_journeys.DOMAINS:
            with self.subTest(domain=domain):
                source_path = build_journeys.SOURCE_DIR / f"{domain}.json"
                geojson_path = build_journeys.SOURCE_DIR / f"{domain}.geojson"
                self.assertTrue(source_path.is_file(), f"{domain}: missing source records")
                self.assertTrue(geojson_path.is_file(), f"{domain}: missing generated geometry")
                records = json.loads(source_path.read_text(encoding="utf-8"))
                collection = json.loads(geojson_path.read_text(encoding="utf-8"))
                self.assertGreater(len(records), 0)
                self.assertEqual(len(collection["features"]), len(records))

    def test_crossing_keeps_segment_and_dateline_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "journeys"
            wkt = Path(directory) / "wkt"
            source.mkdir()
            records = [record(rank) for rank in range(1, 26)]
            (source / "sailing.json").write_text(json.dumps(records), encoding="utf-8")
            with patch.object(build_journeys, "SOURCE_DIR", source), patch.object(build_journeys, "WKT_DIR", wkt):
                count, vertices = build_journeys.build_domain("sailing")
            collection = json.loads((source / "sailing.geojson").read_text(encoding="utf-8"))
            self.assertEqual(count, 25)
            self.assertGreater(vertices, 50)
            self.assertEqual(len(collection["features"]), 25)
            feature = collection["features"][0]
            self.assertEqual(feature["geometry"]["type"], "MultiLineString")
            self.assertEqual(len(feature["properties"]["line_styles"]), 2)
            self.assertTrue(all(style["track_type"] == "historical-corridor" for style in feature["properties"]["line_styles"]))
            self.assertTrue((wkt / "sailing" / "sample-1.wkt").read_text().startswith("MULTILINESTRING"))

    def test_rejects_missing_segment_source(self) -> None:
        candidate = record(1)
        candidate["segments"][0]["source_url"] = ""
        with self.assertRaisesRegex(ValueError, "missing HTTPS source"):
            build_journeys.validate_record(candidate, "sailing", 1)

    def test_validates_wikipedia_relation_and_additional_sources(self) -> None:
        candidate = record(1)
        candidate["wiki_relation"] = "related"
        candidate["additional_sources"] = [{"title": "Primary log", "url": "https://archive.example/log", "note": "Route record."}]
        build_journeys.validate_record(candidate, "sailing", 1)

        candidate["additional_sources"][0]["url"] = "javascript:alert(1)"
        with self.assertRaisesRegex(ValueError, "safe HTTPS URL"):
            build_journeys.validate_record(candidate, "sailing", 1)

    def test_generated_collections_follow_all_sourced_anchors(self) -> None:
        for domain in build_journeys.DOMAINS:
            source_path = build_journeys.SOURCE_DIR / f"{domain}.json"
            geojson_path = build_journeys.SOURCE_DIR / f"{domain}.geojson"
            if not source_path.exists() or not geojson_path.exists():
                continue
            with self.subTest(domain=domain):
                records = json.loads(source_path.read_text(encoding="utf-8"))
                collection = json.loads(geojson_path.read_text(encoding="utf-8"))
                self.assertEqual(len(collection["features"]), len(records))
                for record, feature in zip(records, collection["features"]):
                    properties = feature["properties"]
                    self.assertEqual(properties["id"], record["id"])
                    lines = feature["geometry"]["coordinates"]
                    if feature["geometry"]["type"] == "LineString":
                        lines = [lines]
                    styles = properties["line_styles"]
                    self.assertEqual(len(lines), len(styles))
                    self.assertEqual(sum(map(len, lines)), properties["vertex_count"])
                    for segment_index, segment in enumerate(record["segments"]):
                        segment_lines = [line for line, style in zip(lines, styles)
                                         if style["segment_index"] == segment_index]
                        self.assertTrue(segment_lines, f"{domain}/{record['id']}: segment omitted")
                        start = segment_lines[0][0]
                        end = segment_lines[-1][-1]
                        self.assertAlmostEqual(start[0], segment["anchors"][0]["lon"], places=4)
                        self.assertAlmostEqual(start[1], segment["anchors"][0]["lat"], places=4)
                        self.assertAlmostEqual(end[0], segment["anchors"][-1]["lon"], places=4)
                        self.assertAlmostEqual(end[1], segment["anchors"][-1]["lat"], places=4)
                    self.assertTrue((build_journeys.ROOT / properties["wkt_file"]).is_file())


if __name__ == "__main__":
    unittest.main()
