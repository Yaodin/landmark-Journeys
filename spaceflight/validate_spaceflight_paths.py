#!/usr/bin/env python3
"""Validate the generated spaceflight catalog and 3D path files."""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EQUATORIAL_RADIUS_KM = 6378.137
POLAR_RADIUS_KM = EQUATORIAL_RADIUS_KM*(1-1/298.257223563)
RECONSTRUCTED_NEAR_EARTH = {
    "vostok-1", "sputnik-1", "sts-1", "friendship-7", "vostok-6",
    "explorer-1", "apollo-soyuz", "soyuz-11", "shenzhou-5",
    "apollo-11", "apollo-8", "apollo-13", "luna-2",
}
EARTH_ORBIT = RECONSTRUCTED_NEAR_EARTH - {"apollo-11", "apollo-8", "apollo-13", "luna-2"}
EARTH_RETURN = {
    "vostok-1", "sts-1", "friendship-7", "vostok-6", "apollo-soyuz",
    "soyuz-11", "shenzhou-5", "apollo-11", "apollo-8", "apollo-13",
}


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def ellipsoid_distance_km(point):
    """Approximate signed height from WGS84 in the radial direction."""
    scaled = (point[0]/EQUATORIAL_RADIUS_KM, point[1]/EQUATORIAL_RADIUS_KM,
              point[2]/POLAR_RADIUS_KM)
    return (math.sqrt(sum(v*v for v in scaled))-1)*EQUATORIAL_RADIUS_KM


def chord_min_clearance_km(a, b):
    """Minimum ellipsoid clearance of a *straight rendered segment*."""
    p = (a[0]/EQUATORIAL_RADIUS_KM, a[1]/EQUATORIAL_RADIUS_KM, a[2]/POLAR_RADIUS_KM)
    q = (b[0]/EQUATORIAL_RADIUS_KM, b[1]/EQUATORIAL_RADIUS_KM, b[2]/POLAR_RADIUS_KM)
    delta = [q[i]-p[i] for i in range(3)]
    length_sq = sum(x*x for x in delta)
    t = max(0.0, min(1.0, -sum(p[i]*delta[i] for i in range(3))/length_sq)) if length_sq else 0.0
    return (math.sqrt(sum((p[i]+t*delta[i])**2 for i in range(3)))-1)*EQUATORIAL_RADIUS_KM


def initial_bearing(rows):
    """Inertial initial heading, expressed in the launch site's local ENU frame."""
    p = rows[0][1:4]
    norm = math.sqrt(sum(value*value for value in p))
    up = [value/norm for value in p]
    east = [-up[1], up[0], 0]
    norm_east = math.hypot(east[0], east[1])
    east = [value/norm_east for value in east]
    north = [up[1]*east[2]-up[2]*east[1],
             up[2]*east[0]-up[0]*east[2],
             up[0]*east[1]-up[1]*east[0]]
    displacement = [rows[10][i]-rows[0][i] for i in range(1, 4)]
    heading = math.degrees(math.atan2(sum(displacement[i]*east[i] for i in range(3)),
                                      sum(displacement[i]*north[i] for i in range(3))))
    return heading % 360


def main():
    catalog = json.loads((ROOT / "index.json").read_text())
    missions = catalog["missions"]
    wiki_links = json.loads((ROOT / "wiki-links.json").read_text())
    assert len(missions) == 25, f"expected 25 missions, got {len(missions)}"
    assert [m["rank"] for m in missions] == list(range(1, 26))
    assert len({m["id"] for m in missions}) == 25
    assert set(wiki_links) == {m["id"] for m in missions}, "Wikipedia links must cover exactly the 25 missions"
    assert all(url.startswith("https://en.wikipedia.org/wiki/") for url in wiki_links.values())
    horizons_count = 0
    reconstructed_count = 0
    terminal_radius = {}
    launch_bearings = {}
    for mission in missions:
        path = json.loads((ROOT / mission["path"]).read_text())
        assert path["mission_id"] == mission["id"]
        assert path["coordinate_system"]["origin"] == "Earth center of mass"
        assert path["coordinate_system"]["units"] == "km"
        assert "ICRF" in path["coordinate_system"]["axes"]
        rows = path["positions"]
        assert len(rows) >= 50, f"{mission['id']}: too few points"
        assert len(rows) == path["stats"]["point_count"]
        previous = None
        previous_row = None
        max_r = 0.0
        min_r = math.inf
        max_speed_km_s = 0.0
        max_step_km = 0.0
        for row in rows:
            assert len(row) == 4
            now = parse_time(row[0])
            assert previous is None or now > previous, f"{mission['id']}: repeated/reversed sample time"
            if previous_row:
                seconds = (now-previous).total_seconds()
                step = math.dist(row[1:4], previous_row[1:4])
                max_step_km = max(max_step_km, step)
                max_speed_km_s = max(max_speed_km_s, step/seconds)
                if mission["id"] in RECONSTRUCTED_NEAR_EARTH:
                    clearance = chord_min_clearance_km(previous_row[1:4], row[1:4])
                    assert clearance > -0.02, f"{mission['id']}: rendered segment enters WGS84 Earth by {-clearance:.2f} km"
                if mission["id"] in {"voyager-2", "chandrayaan-3"}:
                    clearance = chord_min_clearance_km(previous_row[1:4], row[1:4])
                    assert clearance > -0.02, f"{mission['id']}: early trajectory enters WGS84 Earth by {-clearance:.2f} km"
            previous = now
            previous_row = row
            assert all(math.isfinite(float(v)) for v in row[1:])
            radius = math.sqrt(sum(float(v)**2 for v in row[1:]))
            max_r = max(max_r, radius)
            min_r = min(min_r, radius)
        assert min_r >= POLAR_RADIUS_KM-0.02, f"{mission['id']}: trajectory samples enter Earth ({min_r:.1f} km)"
        assert abs(ellipsoid_distance_km(rows[0][1:4])) < 0.02, f"{mission['id']}: launch not grounded"
        if mission["id"] in EARTH_RETURN:
            assert abs(ellipsoid_distance_km(rows[-1][1:4])) < 0.02, f"{mission['id']}: landing not grounded"
        if mission["id"] in RECONSTRUCTED_NEAR_EARTH:
            assert max_speed_km_s < 12, f"{mission['id']}: reconstruction jumps at {max_speed_km_s:.1f} km/s"
        if mission["id"] in EARTH_ORBIT:
            assert max_step_km < 1600, f"{mission['id']}: undersampled orbit chord of {max_step_km:.0f} km"
        assert abs(max_r - path["stats"]["max_earth_center_distance_km"]) < 1.0
        assert mission["launch_site"], f"{mission['id']}: launch site label missing"
        launch_bearings[mission["id"]] = initial_bearing(rows)
        terminal_radius[mission["id"]] = math.sqrt(sum(float(v)**2 for v in rows[-1][1:]))
        assert path["provenance"]["sources"]
        if path["provenance"]["query_url"]:
            horizons_count += 1
            assert path["provenance"]["raw_response_sha256"]
        else:
            reconstructed_count += 1
        # A path that leaves Earth must remain visibly outside the globe. This
        # catches accidental lon/lat-as-Cartesian and metre/kilometre mixups.
        if mission["id"] in {"voyager-1", "voyager-2", "cassini-huygens", "new-horizons", "rosetta", "hayabusa2", "curiosity-msl", "artemis-1", "chandrayaan-3", "apollo-8", "apollo-11", "apollo-13", "luna-2", "viking-1", "mariner-4", "venera-7"}:
            assert max_r > 100_000, f"{mission['id']}: does not leave near-Earth space"
    assert horizons_count == 9, horizons_count
    assert reconstructed_count == 16, reconstructed_count
    # One-way deep-space missions must not be accidentally closed back to
    # Earth by generic route code. Intentional Earth-return missions are not in
    # this set (Apollo, Artemis and Hayabusa2 return by design).
    for mission_id in {"voyager-1", "voyager-2", "cassini-huygens", "new-horizons", "rosetta", "curiosity-msl", "viking-1", "mariner-4", "venera-7"}:
        assert terminal_radius[mission_id] > 1_000_000, f"{mission_id}: false Earth return"
    assert terminal_radius["luna-2"] > 300_000
    assert terminal_radius["chandrayaan-3"] > 300_000
    for mission_id in ("apollo-8", "apollo-11", "apollo-13"):
        assert 68 < launch_bearings[mission_id] < 80, f"{mission_id}: launch heading is not east-northeast"
    assert 55 < launch_bearings["sts-1"] < 67, "STS-1 launch heading is not northeast"
    assert 118 < launch_bearings["voyager-2"] < 130, "Voyager 2 launch heading is not east-southeast"
    voyager = json.loads((ROOT / "paths/voyager-2.json").read_text())
    voyager_rows = voyager["positions"]
    parking = [row for row in voyager_rows if "1977-08-20T14:45" <= row[0] <= "1977-08-20T15:20"]
    assert len(parking) > 50 and all(6540 < math.dist(row[1:4], (0, 0, 0)) < 6550 for row in parking), "Voyager 2 parking-orbit coast is missing"
    assert voyager_rows[0][0] == "1977-08-20T14:29:44Z"
    assert any(row[0] == "1977-08-20T15:32:00Z" for row in voyager_rows), "Voyager 2 launch-day Horizons states are missing"
    assert len(voyager["provenance"]["supplemental_queries"]) == 1
    chandrayaan = json.loads((ROOT / "paths/chandrayaan-3.json").read_text())
    assert len(chandrayaan["positions"]) > 10_000, "Chandrayaan-3 orbit is still undersampled"
    assert "STEP_SIZE=5m" in chandrayaan["provenance"]["query_url"], "Chandrayaan-3 ephemeris step is not five minutes"
    print(f"PASS: 25 missions; {horizons_count} JPL ephemerides, {reconstructed_count} documented reconstructions")


if __name__ == "__main__":
    main()
