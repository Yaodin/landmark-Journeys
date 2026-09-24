#!/usr/bin/env python3
"""Download and normalize the licensed images listed in either atlas catalog."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import io
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "VibeFlightsAtlas/1.0 (https://github.com/Yaodin/vibe-flights)"
TARGET_SIZE = (1200, 675)


def fetch_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        try:
            with urlopen(request, timeout=60) as response:
                return response.read()
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            time.sleep(5 * (attempt + 1))
    raise AssertionError("retry loop exhausted")


def commons_thumbnails(catalog: dict) -> dict[str, str]:
    result = {}
    items = [(route_id, meta) for route_id, meta in catalog.items() if meta.get("commons_file")]
    for start in range(0, len(items), 20):
        batch = items[start:start + 20]
        query = urlencode({
            "action": "query",
            "format": "json",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": 1600,
            "titles": "|".join(meta["commons_file"] for _, meta in batch),
        })
        payload = json.loads(fetch_bytes(f"https://commons.wikimedia.org/w/api.php?{query}"))
        pages = {page["title"]: page for page in payload["query"]["pages"].values()}
        for route_id, meta in batch:
            file_title = meta["commons_file"]
            page = pages.get(file_title)
            if not page or "missing" in page or not page.get("imageinfo"):
                raise RuntimeError(f"Commons file not found: {file_title}")
            info = page["imageinfo"][0]
            actual_license = info.get("extmetadata", {}).get("LicenseShortName", {}).get("value", "")
            expected = {"CC0 1.0": "CC0", "No known copyright restrictions": "No restrictions"}.get(meta["license"], meta["license"])
            if actual_license.casefold() != expected.casefold():
                raise RuntimeError(
                    f"Commons license changed for {file_title}: catalog says {meta['license']}, API says {actual_license}"
                )
            result[route_id] = info.get("thumburl") or info["url"]
        print(f"Checked source and license for {min(start + 20, len(items))}/{len(items)} images", flush=True)
        time.sleep(1.3)
    return result


def normalize_image(raw: bytes, destination: Path) -> None:
    with Image.open(io.BytesIO(raw)) as source:
        source.seek(0)
        image = ImageOps.exif_transpose(source).convert("RGB")
        framed = ImageOps.pad(
            image,
            TARGET_SIZE,
            method=Image.Resampling.LANCZOS,
            color=(9, 12, 17),
            centering=(0.5, 0.5),
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        framed.save(destination, "WEBP", quality=84, method=6)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", choices=("aircraft", "journeys"), default="aircraft")
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--ids", nargs="*", help="Download only these route IDs")
    args = parser.parse_args()
    catalog_path = ROOT / "data" / {
        "aircraft": "aircraft-images.json",
        "journeys": "journey-images.json",
    }[args.catalog]
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if not catalog:
        raise SystemExit(f"Image catalog is empty: {catalog_path}")
    if args.ids:
        unknown = set(args.ids) - set(catalog)
        if unknown:
            raise SystemExit(f"Unknown route IDs: {', '.join(sorted(unknown))}")
    pending = {
        route_id: meta for route_id, meta in catalog.items()
        if (not args.ids or route_id in args.ids)
        if not (args.skip_existing and (ROOT / meta["path"]).exists())
    }
    thumbnails = commons_thumbnails(pending)

    def download(item: tuple[str, dict]) -> tuple[str, Path]:
        route_id, metadata = item
        source_url = metadata.get("download_url") or thumbnails.get(route_id)
        if not source_url:
            raise RuntimeError(f"No downloadable source for {route_id}")
        destination = ROOT / metadata["path"]
        normalize_image(fetch_bytes(source_url), destination)
        return route_id, destination

    failures = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(download, item): item[0] for item in pending.items()}
        for index, future in enumerate(as_completed(futures), 1):
            try:
                route_id, destination = future.result()
                print(f"{index}/{len(pending)} {route_id}: {destination.stat().st_size:,} bytes", flush=True)
            except Exception as error:
                failures.append(f"{futures[future]}: {error}")
    if failures:
        raise SystemExit("Image downloads failed:\n" + "\n".join(failures))


if __name__ == "__main__":
    main()
