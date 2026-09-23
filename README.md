# Twenty-Five Flights

A local canvas slippy-map atlas of twenty-five famous historic aviation routes. Each
flight is selectable in the sidebar and includes a short encyclopedia-style
account, why the flight became famous, downloadable WKT, research anchors,
source attribution, route length, and an evidence-quality label. Esri World
Imagery is the default high-resolution satellite layer; three bundled Natural
Earth styles remain available as fast, offline fallbacks.

Every description links separately to its primary research source and its most
specific verified English Wikipedia page.

## Run

```bash
python scripts/build_routes.py
python server.py --port 8765
```

Open <http://127.0.0.1:8765>.

The public GitHub Pages deployment is available at
<https://yaodin.github.io/vibe-flights/>. Pushes to `main` deploy through
`.github/workflows/pages.yml`.

## Render test

The render test starts an ephemeral local server, opens world, selected-flight,
satellite, phone portrait, and phone landscape views in headless Chrome, and
inspects the screenshots for basemap and route pixels as well as the rendered
DOM:

```bash
python scripts/render_test.py --output-dir /tmp/aviation-render-test
```

## Geometry method

Historic route records usually provide endpoints, named stops, landfalls, or a
small number of logged positions—not continuous GPS tracks. The builder uses
spherical great-circle interpolation between those anchors. Long routes are
densified to a maximum spacing of roughly 20–25 km; local routes use spacing as
fine as 5–250 m. Antimeridian crossings are split into valid WKT
`MULTILINESTRING` parts.

High vertex density improves rendering and interchange. It does **not** make an
interpolated segment equivalent to observed telemetry. That limitation is
carried in each GeoJSON feature and displayed in the map.

Generated outputs:

- `data/routes.geojson` — all route geometry and metadata in CRS84
- `data/wkt/*.wkt` — one WKT geometry per flight
- `data/routes-index.tsv` — route/output inventory

Aircraft photographs are stored under `assets/aircraft/`; their source, credit,
and reuse license are recorded in `data/aircraft-images.json` and shown beside
each image in the flight detail card.

Run `python scripts/build_routes.py` after editing route anchors.
