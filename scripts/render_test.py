#!/usr/bin/env python3
"""Render-test the atlas in headless Chrome and inspect the actual pixels."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode

from PIL import Image, ImageFilter, ImageStat


ROOT = Path(__file__).resolve().parents[1]
VIEWPORT = (1440, 900)
MAP_CROP = (390, 0, *VIEWPORT)


def chrome_binary() -> str:
    for candidate in ("google-chrome-stable", "google-chrome", "chromium"):
        found = shutil.which(candidate)
        if found:
            return found
    raise RuntimeError("No Chrome/Chromium executable found")


def near_count(image: Image.Image, colors: list[tuple[int, int, int]], tolerance: int = 10) -> int:
    count = 0
    for pixel in image.get_flattened_data():
        if any(max(abs(pixel[channel] - color[channel]) for channel in range(3)) <= tolerance for color in colors):
            count += 1
    return count


def render(chrome: str, url: str, screenshot: Path, profile: Path) -> str:
    render_profile = profile / screenshot.stem
    render_profile.mkdir(parents=True, exist_ok=True)
    common = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--no-first-run",
        f"--user-data-dir={render_profile}",
        f"--window-size={VIEWPORT[0]},{VIEWPORT[1]}",
        "--virtual-time-budget=12000",
    ]
    # Dumping the DOM first also warms uncached remote imagery. A second Chrome
    # process using the same profile then captures a deterministic full frame.
    dom_run = subprocess.run(
        [*common, "--dump-dom", url],
        check=True,
        capture_output=True,
        text=True,
    )
    screenshot_run = subprocess.run(
        [*common, f"--screenshot={screenshot}", url],
        check=True,
        capture_output=True,
        text=True,
    )
    if not screenshot.exists() or screenshot.stat().st_size < 50_000:
        raise AssertionError(f"Chrome did not produce a substantial screenshot: {screenshot}")

    combined_errors = screenshot_run.stderr + dom_run.stderr
    fatal_markers = ("Uncaught ", "SyntaxError", "ERR_FILE_NOT_FOUND", "ERR_CONNECTION_REFUSED")
    if any(marker in combined_errors for marker in fatal_markers):
        raise AssertionError(f"Browser reported a fatal error:\n{combined_errors}")
    return dom_run.stdout


def assert_world_render(path: Path, dom: str, route_colors: list[tuple[int, int, int]]) -> None:
    image = Image.open(path).convert("RGB")
    assert image.size == VIEWPORT, f"unexpected screenshot size: {image.size}"
    map_image = image.crop(MAP_CROP)
    pixels = map_image.width * map_image.height
    ocean = near_count(map_image, [(207, 227, 227), (185, 215, 218)])
    land = near_count(map_image, [(241, 238, 228)])
    # Ordinary routes are intentionally alpha-blended into the basemap, so a
    # wider tolerance catches their rasterized center lines and antialiasing.
    routes = near_count(map_image, route_colors, tolerance=30)
    assert ocean > pixels * 0.12, f"ocean coverage too low: {ocean}/{pixels}"
    assert land > pixels * 0.12, f"land coverage too low: {land}/{pixels}"
    assert routes > 4_000, f"too few route pixels: {routes}"
    assert 'data-atlas-ready="true"' in dom
    assert 'data-canvas-rendered="true"' in dom
    assert dom.count('class="route-item') == 20, "sidebar should contain all 20 flights"


def assert_selected_render(path: Path, dom: str) -> None:
    image = Image.open(path).convert("RGB").crop(MAP_CROP)
    selected = near_count(image, [(255, 159, 67)], tolerance=12)
    assert selected > 500, f"selected route is not visibly highlighted: {selected} pixels"
    assert "Spirit of St. Louis — solo Atlantic crossing" in dom
    assert "Why it was famous" in dom
    assert 'data-id="lindbergh-spirit-of-st-louis"' in dom


def assert_satellite_render(path: Path, dom: str) -> None:
    image = Image.open(path).convert("RGB")
    # Avoid the sidebar and floating detail card; this window is pure imagery.
    imagery = image.crop((950, 100, 1400, 800))
    deviation = ImageStat.Stat(imagery).stddev
    edge_mean = ImageStat.Stat(imagery.convert("L").filter(ImageFilter.FIND_EDGES)).mean[0]
    assert min(deviation) > 30, f"satellite image has insufficient color variation: {deviation}"
    assert edge_mean > 18, f"satellite image lacks expected ground detail: {edge_mean:.1f}"
    assert 'data-basemap="satellite"' in dom
    assert 'data-satellite-rendered="true"' in dom
    match = re.search(r'data-satellite-tiles="(\d+)/(\d+)"', dom)
    assert match and int(match.group(1)) >= int(match.group(2)) * 0.75, "satellite tiles did not finish loading"
    assert dom.count('class="route-item') == 20


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", help="Test an already running atlas instead of starting one")
    parser.add_argument("--output-dir", type=Path, help="Keep screenshots in this directory")
    args = parser.parse_args()

    chrome = chrome_binary()
    server: subprocess.Popen[str] | None = None
    if args.base_url:
        base_url = args.base_url.rstrip("/") + "/"
    else:
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--port", "0"],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert server.stdout is not None
        line = server.stdout.readline().strip()
        match = re.search(r"(http://127\.0\.0\.1:\d+)", line)
        if not match:
            raise RuntimeError(f"Unable to read local server address: {line!r}")
        base_url = match.group(1) + "/"

    temp = None
    if args.output_dir:
        output_dir = args.output_dir.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
    else:
        temp = tempfile.TemporaryDirectory(prefix="aviation-render-test-")
        output_dir = Path(temp.name)

    profile_temp = tempfile.TemporaryDirectory(prefix="aviation-chrome-profile-")
    profile = Path(profile_temp.name)
    try:
        world_path = output_dir / "world.png"
        selected_path = output_dir / "selected-lindbergh.png"
        satellite_path = output_dir / "satellite-world.png"
        world_url = base_url + "?" + urlencode({"basemap": "atlas"})
        world_dom = render(chrome, world_url, world_path, profile)
        selected_url = base_url + "?" + urlencode({"basemap": "atlas", "flight": "lindbergh-spirit-of-st-louis"})
        selected_dom = render(chrome, selected_url, selected_path, profile)
        satellite_url = base_url + "?" + urlencode({"basemap": "satellite"})
        satellite_dom = render(chrome, satellite_url, satellite_path, profile)

        collection = json.loads((ROOT / "data/routes.geojson").read_text())
        route_colors = [
            tuple(bytes.fromhex(feature["properties"]["color"].removeprefix("#")))
            for feature in collection["features"]
        ]
        assert_world_render(world_path, world_dom, route_colors)
        assert_selected_render(selected_path, selected_dom)
        assert_satellite_render(satellite_path, satellite_dom)
        print(f"PASS: atlas, selected-flight, and high-resolution satellite renders at {VIEWPORT[0]}x{VIEWPORT[1]}")
        if args.output_dir:
            print(f"Screenshots: {output_dir}")
        return 0
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        if temp is not None:
            temp.cleanup()
        profile_temp.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
