"""Checks for reproducible full-resolution GeoJSON and WKT outputs."""

from __future__ import annotations

import json
import unittest

from scripts import geometry_manifest


class GeometryManifestTests(unittest.TestCase):
    def test_manifest_matches_all_generated_routes(self) -> None:
        actual = geometry_manifest.build_manifest()
        self.assertEqual(len(actual["collections"]), 8)
        self.assertEqual(sum(len(entry["routes"]) for entry in actual["collections"]), 200)
        self.assertEqual(
            json.loads(geometry_manifest.MANIFEST.read_text(encoding="utf-8")),
            actual,
            "Run geometry_manifest.py --write after rebuilding routes",
        )

    def test_manifest_records_each_domain_and_shared_functions(self) -> None:
        manifest = geometry_manifest.build_manifest()
        self.assertEqual(
            [entry["domain"] for entry in manifest["collections"]],
            ["flights", *geometry_manifest.DOMAINS],
        )
        self.assertIn("scripts/build_routes.py:as_wkt", manifest["shared_geometry_functions"])
        self.assertTrue(all(entry["source_sha256"] and entry["geometry_sha256"] for entry in manifest["collections"]))


if __name__ == "__main__":
    unittest.main()
