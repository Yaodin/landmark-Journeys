"""Regression checks for reproducible, source-aligned flight heights."""

from __future__ import annotations

import json
import unittest

try:
    from . import build_flight_altitudes as altitude
except ImportError:
    import build_flight_altitudes as altitude


class FlightAltitudeBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.full, cls.preview = altitude.build()
        cls.source = json.loads(altitude.SOURCE.read_text(encoding="utf-8"))

    def test_every_flight_has_one_height_per_original_vertex(self) -> None:
        self.assertEqual(len(self.full["features"]), 25)
        self.assertEqual(len(self.preview["features"]), 25)
        for source, lifted, preview in zip(
            self.source["features"], self.full["features"], self.preview["features"]
        ):
            self.assertEqual(source["properties"]["id"], lifted["properties"]["id"])
            self.assertEqual(source["properties"]["id"], preview["properties"]["id"])
            source_lines = altitude.lines_of(source["geometry"])
            lifted_lines = altitude.lines_of(lifted["geometry"])
            preview_lines = altitude.lines_of(preview["geometry"])
            self.assertEqual(len(source_lines), len(lifted_lines))
            self.assertEqual(len(source_lines), len(preview_lines))
            for source_line, lifted_line, preview_line in zip(source_lines, lifted_lines, preview_lines):
                self.assertEqual([point[:2] for point in lifted_line], source_line)
                self.assertTrue(all(len(point) == 3 and point[2] >= 0 for point in lifted_line))
                self.assertTrue(all(point in lifted_line for point in preview_line))
            estimate = lifted["properties"]["altitude_estimate"]
            self.assertFalse(estimate["is_observed_trace"])
            self.assertTrue(estimate["sources"])

    def test_documented_event_heights_are_at_anchor_vertices(self) -> None:
        by_id = {feature["properties"]["id"]: feature for feature in self.full["features"]}
        documented = {
            "bell-x1-sound-barrier": (2, 13106),
            "us-airways-1549": (4, 859),
            "enola-gay-hiroshima": (4, 9468),
            "rutan-voyager": (9, 6248),
            "air-canada-143-gimli-glider": (3, 10668),
        }
        for route_id, (anchor, expected_m) in documented.items():
            feature = by_id[route_id]
            vertex_index = feature["properties"]["altitude_estimate"]["anchor_vertex_indices"][anchor]
            vertices = [point for line in altitude.lines_of(feature["geometry"]) for point in line]
            self.assertAlmostEqual(vertices[vertex_index][2], expected_m, delta=1, msg=route_id)

    def test_generated_files_are_current(self) -> None:
        for path, collection in ((altitude.FULL_OUTPUT, self.full), (altitude.OVERVIEW_OUTPUT, self.preview)):
            expected = json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n"
            self.assertEqual(path.read_text(encoding="utf-8"), expected)


if __name__ == "__main__":
    unittest.main()
