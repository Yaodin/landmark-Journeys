"""Tests for the display-only Show all geometry derivative."""

from __future__ import annotations

import json
import unittest

from scripts import build_overview
from scripts.build_journeys import DOMAINS


class OverviewBuildTests(unittest.TestCase):
    def test_simplification_preserves_endpoints_and_turns(self) -> None:
        straight = [[index / 100, 0.0] for index in range(101)]
        self.assertEqual(build_overview.simplify_line(straight), [straight[0], straight[-1]])
        bend = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]
        self.assertEqual(build_overview.simplify_line(bend), bend)

    def test_preview_has_all_routes_and_matches_full_inputs(self) -> None:
        preview = build_overview.build_overview()
        self.assertEqual(len(preview["features"]), 200)
        self.assertEqual(preview["metadata"]["route_count"], 200)
        self.assertTrue(preview["metadata"]["display_only"])
        display_vertices = 0
        source_vertices = 0
        for feature in preview["features"]:
            geometry = feature["geometry"]
            lines = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
            display_vertices += sum(len(line) for line in lines)
            source_vertices += feature["properties"]["vertex_count"]
            self.assertTrue(all(len(line) >= 2 for line in lines))
        self.assertLess(display_vertices, source_vertices / 10)
        self.assertEqual(json.loads(build_overview.OUTPUT.read_text(encoding="utf-8")), preview)
        offset = 0
        for domain in ("flights", *DOMAINS):
            source = build_overview.ROOT / ("data/routes.geojson" if domain == "flights" else f"data/journeys/{domain}.geojson")
            complete = json.loads(source.read_text(encoding="utf-8"))["features"]
            for full, display in zip(complete, preview["features"][offset:offset + len(complete)]):
                full_geometry = full["geometry"]
                display_geometry = display["geometry"]
                full_lines = [full_geometry["coordinates"]] if full_geometry["type"] == "LineString" else full_geometry["coordinates"]
                display_lines = [display_geometry["coordinates"]] if display_geometry["type"] == "LineString" else display_geometry["coordinates"]
                self.assertEqual(full["properties"]["id"], display["properties"]["id"])
                self.assertEqual(len(full_lines), len(display_lines))
                for full_line, display_line in zip(full_lines, display_lines):
                    self.assertEqual(full_line[0], display_line[0])
                    self.assertEqual(full_line[-1], display_line[-1])
            offset += len(complete)


if __name__ == "__main__":
    unittest.main()
