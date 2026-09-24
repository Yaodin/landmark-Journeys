"""Local schema checks for the verified English Wikipedia links."""

from __future__ import annotations

import json
import unittest
from urllib.parse import urlparse

from scripts.build_journeys import DOMAINS, ROOT


class WikipediaLinkTests(unittest.TestCase):
    def test_all_generated_routes_have_english_wikipedia_target(self) -> None:
        ids = set()
        for domain in ("flights", *DOMAINS):
            path = ROOT / ("data/routes.geojson" if domain == "flights" else f"data/journeys/{domain}.geojson")
            features = json.loads(path.read_text(encoding="utf-8"))["features"]
            expected = 25
            self.assertEqual(len(features), expected)
            source_records = None if domain == "flights" else json.loads((ROOT / f"data/journeys/{domain}.json").read_text(encoding="utf-8"))
            for rank, feature in enumerate(features):
                properties = feature["properties"]
                route_id = properties["id"]
                self.assertNotIn(route_id, ids)
                ids.add(route_id)
                with self.subTest(route=route_id):
                    url = urlparse(properties.get("wiki_url", ""))
                    self.assertEqual((url.scheme, url.netloc), ("https", "en.wikipedia.org"))
                    self.assertTrue(url.path.startswith("/wiki/") and len(url.path) > len("/wiki/"))
                    self.assertTrue(properties.get("wiki_title", "").strip())
                    self.assertIn(properties.get("wiki_relation", "exact"), {"exact", "related"})
                    if source_records:
                        self.assertEqual(properties["wiki_url"], source_records[rank]["wiki_url"])
                        self.assertEqual(properties["wiki_title"], source_records[rank]["wiki_title"])
        self.assertEqual(len(ids), 200)
        self.assertTrue({"monte-carlo-rally-1911", "coronation-safari-1953", "de-soto-expedition", "cabeza-de-vaca-traverse", "coronado-expedition", "queen-elizabeth-1940"}.isdisjoint(ids))


if __name__ == "__main__":
    unittest.main()
