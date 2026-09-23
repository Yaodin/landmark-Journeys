#!/usr/bin/env python3
"""Serve the static route atlas on localhost with no-cache headers."""

from __future__ import annotations

import argparse
import http.server
from pathlib import Path


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".geojson": "application/geo+json",
        ".wkt": "text/plain; charset=utf-8",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    handler = lambda *a, **kw: Handler(*a, directory=root, **kw)  # noqa: E731
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    bound_port = server.server_address[1]
    print(f"Serving Twenty-Five Flights at http://127.0.0.1:{bound_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
