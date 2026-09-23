#!/usr/bin/env python3
"""Download and normalize the licensed aircraft images listed in the catalog."""

from __future__ import annotations

import io
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "aircraft-images.json"
USER_AGENT = "VibeFlightsAtlas/1.0 (https://github.com/Yaodin/vibe-flights)"
TARGET_SIZE = (1200, 675)


def fetch_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=45) as response:
        return response.read()


def commons_thumbnail(file_title: str) -> str:
    query = urlencode(
        {
            "action": "query",
            "format": "json",
            "prop": "imageinfo",
            "iiprop": "url",
            "iiurlwidth": TARGET_SIZE[0] * 2,
            "titles": file_title,
        }
    )
    payload = json.loads(fetch_bytes(f"https://commons.wikimedia.org/w/api.php?{query}"))
    page = next(iter(payload["query"]["pages"].values()))
    if "missing" in page or not page.get("imageinfo"):
        raise RuntimeError(f"Commons file not found: {file_title}")
    info = page["imageinfo"][0]
    return info.get("thumburl") or info["url"]


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
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    if not catalog:
        raise SystemExit("Aircraft image catalog is empty")
    for route_id, metadata in catalog.items():
        source_url = metadata.get("download_url")
        if not source_url and metadata.get("commons_file"):
            source_url = commons_thumbnail(metadata["commons_file"])
        if not source_url:
            raise RuntimeError(f"No downloadable source for {route_id}")
        destination = ROOT / metadata["path"]
        normalize_image(fetch_bytes(source_url), destination)
        print(f"{route_id}: {destination.relative_to(ROOT)} ({destination.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
