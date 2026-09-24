#!/usr/bin/env python3
"""Build the image catalog from reviewed route choices and Commons metadata.

Run research_journey_images.py first. Overrides in data/journey-image-overrides.json
correct false-positive article images and document each replacement's context.
"""

from __future__ import annotations

import argparse
from html import unescape
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = "LandmarkJourneys/1.0 (https://github.com/Yaodin/vibe-flights)"
PUBLIC_DOMAIN = "https://creativecommons.org/publicdomain/mark/1.0/"


def clean_html(value: str) -> str:
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", value)).split())


def imageinfo(titles: list[str]) -> dict[str, dict]:
    result = {}
    for start in range(0, len(titles), 20):
        batch = titles[start:start + 20]
        query = urlencode({
            "action": "query", "format": "json", "prop": "imageinfo",
            "iiprop": "url|extmetadata|size", "iiurlwidth": 1600,
            "titles": "|".join(batch), "redirects": 1,
        })
        request = Request(f"https://commons.wikimedia.org/w/api.php?{query}", headers={"User-Agent": USER_AGENT})
        for attempt in range(4):
            try:
                with urlopen(request, timeout=60) as response:
                    payload = json.load(response)
                break
            except HTTPError as error:
                if error.code != 429 or attempt == 3:
                    raise
                time.sleep(15 * (attempt + 1))
        for page in payload.get("query", {}).get("pages", {}).values():
            result[page["title"]] = page
        print(f"Checked Commons metadata for {min(start + 20, len(titles))}/{len(titles)} files", flush=True)
        time.sleep(1.3)
    return result


def license_info(info: dict) -> tuple[str, str]:
    metadata = info.get("extmetadata", {})
    name = clean_html(metadata.get("LicenseShortName", {}).get("value", ""))
    url = metadata.get("LicenseUrl", {}).get("value", "")
    if name == "Public domain":
        return name, (url or PUBLIC_DOMAIN).replace("http://", "https://", 1)
    if name == "CC0":
        return "CC0 1.0", (url or "https://creativecommons.org/publicdomain/zero/1.0/").replace("http://", "https://", 1)
    if re.fullmatch(r"CC BY(?:-SA)? \d\.\d(?: [a-z]{2,3})?", name):
        return name, url.replace("http://", "https://", 1)
    if name == "No restrictions":
        return "No known copyright restrictions", url or "https://www.flickr.com/commons/usage/"
    raise ValueError(f"Unsupported or missing Commons license: {name!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, default=Path("/tmp/journey-image-candidates.json"))
    args = parser.parse_args()
    current_path = ROOT / "data/journey-images.json"
    current = json.loads(current_path.read_text(encoding="utf-8"))
    overrides = json.loads((ROOT / "data/journey-image-overrides.json").read_text(encoding="utf-8"))
    captions = json.loads((ROOT / "data/journey-image-captions.json").read_text(encoding="utf-8"))
    credits = json.loads((ROOT / "data/journey-image-credits.json").read_text(encoding="utf-8"))
    candidates = json.loads(args.candidates.read_text(encoding="utf-8"))
    choices = {}
    for record in candidates:
        route_id = record["id"]
        if route_id not in overrides and route_id not in captions:
            if route_id in current:
                continue
            raise ValueError(f"No reviewed file choice for {route_id}")
        first = next((item for item in record.get("candidates", []) if item.get("file")), None)
        if route_id in overrides:
            title, context = overrides[route_id]
        elif first:
            title = first["file"]
            context = captions.get(route_id)
            if not context:
                raise ValueError(f"No reviewed image caption for {route_id}")
        else:
            raise ValueError(f"No image selected for {route_id}")
        choices[route_id] = (title, context)
    unknown_overrides = set(overrides) - set(choices)
    if unknown_overrides:
        raise ValueError(f"Overrides do not match missing routes: {sorted(unknown_overrides)}")

    pages = imageinfo(sorted({title for title, _ in choices.values()}))
    failures = []
    additions = {}
    for route_id, (title, context) in choices.items():
        page = pages.get(title)
        if not page or "missing" in page or not page.get("imageinfo"):
            failures.append(f"{route_id}: Commons file missing: {title}")
            continue
        info = page["imageinfo"][0]
        try:
            license_name, license_url = license_info(info)
        except ValueError as error:
            failures.append(f"{route_id}: {error} ({title})")
            continue
        metadata = info.get("extmetadata", {})
        artist = clean_html(metadata.get("Artist", {}).get("value", ""))
        credit = credits.get(route_id) or artist or "Wikimedia Commons"
        canonical = page["title"]
        additions[route_id] = {
            "path": f"assets/journeys/{route_id}.webp",
            "commons_file": canonical,
            "source_url": info["descriptionurl"],
            "alt": context.rstrip("."),
            "credit": credit,
            "license": license_name,
            "license_url": license_url,
        }
    if failures:
        print("\n".join(failures))
        raise SystemExit(f"Catalog not written: {len(failures)} invalid choices")
    merged = {**current, **additions}
    current_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(merged)} image entries ({len(additions)} researched choices) to {current_path}")


if __name__ == "__main__":
    main()
