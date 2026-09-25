"""Offline regression checks for source-constrained reconstructed orbit shapes."""

import math
import unittest
from datetime import timedelta
from unittest.mock import patch

from spaceflight import build_spaceflight_paths as paths


def mission(mission_id):
    return next(item for item in paths.MISSIONS if item["id"] == mission_id)


def at_time(rows, target):
    return min(rows, key=lambda row: abs(paths.dt(row[0]) - target))


class OrbitModelTests(unittest.TestCase):
    def test_achieved_earth_orbit_dimensions_are_encoded(self):
        expected = {
            "vostok-1": (181, 327),
            "friendship-7": (161, 261),
            "sts-1": (238, 250),
        }
        for mission_id, dimensions in expected.items():
            with self.subTest(mission=mission_id):
                item = mission(mission_id)
                self.assertEqual((item["perigee"], item["apogee"]), dimensions)
                rows = paths.earth_orbit(item)
                start = paths.dt(item["launch_time"])
                # Avoid the explicitly modeled ascent and landing/entry arcs.
                orbital = [math.dist(row[1:4], (0, 0, 0)) - paths.EARTH_RADIUS_KM
                           for row in rows if start + timedelta(minutes=12) < paths.dt(row[0])
                           < start + timedelta(minutes=item["duration_min"]-item.get("descent_min", 30)-5)]
                self.assertLess(abs(min(orbital)-dimensions[0]), 5)
                self.assertLess(abs(max(orbital)-dimensions[1]), 5)

    def test_apollo_8_initial_lunar_ellipse_becomes_circular(self):
        item = mission("apollo-8")
        moon_center = (384400.0, 0.0, 0.0)
        with patch.object(paths, "moon_ephemeris", return_value=(lambda _: moon_center, "mock://moon", "test-sha")):
            rows, query, digest = paths.lunar_path(item)
        self.assertEqual((query, digest), ("mock://moon", "test-sha"))
        insertion = paths.dt(item["moon_time"])
        circularized = paths.dt(item["lunar_circularization_time"])
        first_apolune = at_time(rows, insertion + (circularized-insertion)/4)
        post_circularization = at_time(rows, circularized + timedelta(hours=1))
        apolune_km = math.dist(first_apolune[1:4], moon_center) - 1737.4
        circular_km = math.dist(post_circularization[1:4], moon_center) - 1737.4
        self.assertAlmostEqual(apolune_km, 168.5*1.852, delta=3)
        self.assertAlmostEqual(circular_km, 60*1.852, delta=0.1)

    def test_modeled_planet_transfer_retains_body_ephemeris_provenance(self):
        item = mission("mariner-4")
        start = paths.dt(item["launch_time"])
        samples = [paths.iso(start + timedelta(days=day)) for day in (0, 1, 2)]
        earth = [[stamp, 149_000_000.0, day*2_000_000.0, 0.0]
                 for day, stamp in enumerate(samples)]
        mars = [[stamp, 230_000_000.0, 40_000_000.0+day*2_000_000.0, 0.0]
                for day, stamp in enumerate(samples)]
        with patch.object(paths, "body_heliocentric", side_effect=[
            (earth, "mock://earth", "earth-sha"),
            (mars, "mock://mars", "mars-sha"),
        ]):
            rows, sources = paths.planet_transfer(item)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0][1:4], [round(value, 6) for value in
                                            paths.surface_eci(*item["launch"], start)])
        self.assertEqual([source["raw_response_sha256"] for source in sources],
                         ["earth-sha", "mars-sha"])
        self.assertIn("Mars", sources[1]["role"])

    def test_sample_origins_split_modeled_launch_from_horizons_vectors(self):
        item = mission("chandrayaan-3")
        rows = [
            [item["launch_time"], 1.0, 2.0, 3.0],
            ["2023-07-14T09:15:00Z", 4.0, 5.0, 6.0],
            ["2023-07-14T09:22:00Z", 7.0, 8.0, 9.0],
            ["2023-07-14T09:27:00Z", 10.0, 11.0, 12.0],
        ]
        self.assertEqual(paths.sample_origin_ranges(item, rows), [
            {"first_index": 0, "last_index": 1, "origin": "modeled_launch_or_gap"},
            {"first_index": 2, "last_index": 3, "origin": "jpl_horizons_vectors"},
        ])
        self.assertEqual(paths.sample_origin_ranges(mission("viking-1"), rows), [
            {"first_index": 0, "last_index": 3, "origin": "modeled_reconstruction"},
        ])

    def test_shenzhou_5_fifth_circuit_circularization(self):
        item = mission("shenzhou-5")
        rows = paths.earth_orbit(item)
        start = paths.dt(item["launch_time"])
        burn = paths.dt(item["circularization_time"])
        initial_perigee = at_time(rows, start+timedelta(minutes=9))
        before_burn = max((row for row in rows if paths.dt(row[0]) < burn),
                          key=lambda row: paths.dt(row[0]))
        at_burn = at_time(rows, burn)
        radius = lambda row: math.dist(row[1:4], (0, 0, 0)) - paths.EARTH_RADIUS_KM
        self.assertAlmostEqual(radius(initial_perigee), 199.14, delta=1)
        self.assertAlmostEqual(radius(before_burn), 347.8, delta=1)
        self.assertAlmostEqual(radius(at_burn), 343, delta=0.1)
        self.assertEqual(at_burn[0], item["circularization_time"])


if __name__ == "__main__":
    unittest.main()
