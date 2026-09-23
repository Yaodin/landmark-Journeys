"""Geometry and evidence validation for the nonflight journey collections."""

from __future__ import annotations

import json
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
    def test_all_seven_domains_have_25_generated_routes(self) -> None:
        for domain in build_journeys.DOMAINS:
            with self.subTest(domain=domain):
                source_path = build_journeys.SOURCE_DIR / f"{domain}.json"
                geojson_path = build_journeys.SOURCE_DIR / f"{domain}.geojson"
                self.assertTrue(source_path.is_file(), f"{domain}: missing source records")
                self.assertTrue(geojson_path.is_file(), f"{domain}: missing generated geometry")
                records = json.loads(source_path.read_text(encoding="utf-8"))
                collection = json.loads(geojson_path.read_text(encoding="utf-8"))
                self.assertEqual(len(records), 25)
                self.assertEqual(len(collection["features"]), 25)

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
