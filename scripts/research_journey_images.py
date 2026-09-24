#!/usr/bin/env python3
"""Collect reviewable Wikipedia lead-image candidates for nonflight journeys.

This is a research aid, not an automatic assertion that an image depicts a
particular journey. Review the article, image, and Commons file before adding
an entry to data/journey-images.json.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DOMAINS = ("sailing", "rail", "road-races", "overland", "ocean-liners", "river", "human-powered")
USER_AGENT = "LandmarkJourneysResearch/1.0 (https://github.com/Yaodin/landmark-Journeys)"
LAST_REQUEST = 0.0


def api_json(host: str, **params: str | int) -> dict:
    global LAST_REQUEST
    params = {"action": "query", "format": "json", **params}
    request = Request(f"https://{host}/w/api.php?{urlencode(params)}", headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        time.sleep(max(0, 1.25 - (time.monotonic() - LAST_REQUEST)))
        LAST_REQUEST = time.monotonic()
        try:
            with urlopen(request, timeout=35) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code != 429 or attempt == 2:
                raise
            time.sleep(20 * (attempt + 1))
    raise AssertionError("retry loop exhausted")


def wiki_candidates(record: dict) -> None:
    query = record["title"]
    payload = api_json(
        "en.wikipedia.org", generator="search", gsrsearch=query, gsrlimit=5,
        prop="pageimages", piprop="name|thumbnail", pithumbsize=420,
    )
    pages = sorted(payload.get("query", {}).get("pages", {}).values(), key=lambda page: page.get("index", 999))
    record["candidates"] = [
        {
            "page": page["title"],
            "file": f"File:{page['pageimage'].replace('_', ' ')}" if page.get("pageimage") else None,
            "thumbnail": page.get("thumbnail", {}).get("source"),
        }
        for page in pages
    ]
def commons_candidates(record: dict) -> None:
    commons = api_json(
        "commons.wikimedia.org", list="search", srnamespace=6,
        srsearch=record["short_title"], srlimit=6,
    )
    record["commons_candidates"] = [item["title"] for item in commons.get("query", {}).get("search", [])]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("/tmp/journey-image-candidates.json"))
    parser.add_argument("--wiki-only", action="store_true")
    parser.add_argument("--all", action="store_true", help="Review every journey, including those already in the catalog")
    args = parser.parse_args()
    catalog = json.loads((ROOT / "data/journey-images.json").read_text(encoding="utf-8"))
    records = []
    for domain in DOMAINS:
        collection = json.loads((ROOT / f"data/journeys/{domain}.geojson").read_text(encoding="utf-8"))
        for feature in collection["features"]:
            props = feature["properties"]
            if args.all or props["id"] not in catalog:
                records.append({"domain": domain, "id": props["id"], "title": props["title"], "short_title": props["short_title"]})

    cached = {}
    if args.output.exists():
        cached = {record["id"]: record for record in json.loads(args.output.read_text(encoding="utf-8"))}
    completed = []
    for record in records:
        record.update(cached.get(record["id"], {}))
        try:
            if "candidates" not in record:
                wiki_candidates(record)
            if not args.wiki_only and "commons_candidates" not in record:
                commons_candidates(record)
            record.pop("error", None)
        except Exception as error:
            record["error"] = str(error)
        completed.append(record)
        args.output.write_text(json.dumps(completed + [cached.get(item["id"], item) for item in records[len(completed):]], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if len(completed) % 10 == 0:
            print(f"Reviewed {len(completed)}/{len(records)} candidate records", flush=True)
    for record in completed:
        selected = next((item for item in record.get("candidates", []) if item["file"]), None)
        print(f"{record['domain']}\t{record['id']}\t{selected['page'] if selected else 'NONE'}\t{selected['file'] if selected else ''}")
    print(f"Wrote {len(completed)} candidate records to {args.output}")


if __name__ == "__main__":
    main()
