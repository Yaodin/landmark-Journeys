# Landmark Journeys

A local canvas slippy-map atlas of 200 landmark journeys: 25 in each of eight
domains—flights, sailing, rail, road and races, overland, ocean liners, river,
and human-powered travel. Every route is selectable in the sidebar and has a
short account, why it became famous, downloadable WKT, researched anchors,
source attribution, and a geometry-confidence note. Solid strokes show
better-anchored courses; dashes identify inferred or low-confidence legs.
All routes are reconstructed between anchors, not observed GPS tracks. Esri World
Imagery is the default high-resolution satellite layer; three bundled Natural
Earth styles remain available as fast, offline fallbacks.

Flight descriptions link separately to a principal research source and their
most specific verified English Wikipedia page. Other journeys link to route
and segment sources.

## Run

```bash
python scripts/build_routes.py
python scripts/build_journeys.py
python server.py --port 8765
```

Open <http://127.0.0.1:8765>.

The public GitHub Pages deployment is available at
<https://yaodin.github.io/landmark-Journeys/>. Pushes to `main` deploy through
`.github/workflows/pages.yml`.

## Render test

The render test starts an ephemeral local server, opens world, selected-flight,
satellite, phone portrait, and phone landscape views in headless Chrome, and
inspects the screenshots for basemap and route pixels as well as the rendered
DOM:

```bash
python scripts/render_test.py --output-dir /tmp/aviation-render-test
```

The overlay-aware route fitter also has a true-device-viewport visual test. It
clicks sidebar items in desktop, phone, and phone-landscape layouts, verifies
every generated track point is inside the measured viewport polygon, and reads
the canvas pixels to confirm the route was actually painted at those positions:

```bash
docker run --rm --network host \
  -e NODE_PATH=/tmp/pw/node_modules \
  -v "$PWD:/work:ro" \
  -v /tmp:/host-tmp \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  sh -lc 'mkdir -p /tmp/pw && cd /tmp/pw && npm install --silent playwright@1.63.0 && node /work/scripts/viewport_fit_visual_test.cjs http://127.0.0.1:8765 /host-tmp/vibe-flights-viewport-fit --journeys --all-mapped'
```

The domain-tab visual test checks desktop and phone rendering, all seven
mapped domains, tab switching, search, deep links, and that flight tracks do not
appear in other domains:

```bash
docker run --rm --network host \
  -e NODE_PATH=/tmp/pw/node_modules \
  -v "$PWD:/work:ro" \
  -v /tmp:/host-tmp \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  sh -lc 'mkdir -p /tmp/pw && cd /tmp/pw && npm install --silent playwright@1.63.0 && node /work/scripts/domain_tabs_visual_test.cjs http://127.0.0.1:8765 /host-tmp/vibe-flights-domain-tabs --all-mapped'
```

`scripts/show_all_performance_test.cjs` uses the same Playwright container to
check the lightweight 200-route preview, pan rendering, lazy full-route loading,
and full-resolution GeoJSON export. It writes before/after screenshots and
reports load, vertex, and render-time measurements. The Pages workflow checks
the preview, full-resolution WKT/GeoJSON manifest, and Python unit tests before
deployment.

The viewport test checks the geometric fit and actual canvas pixels for every
mapped route in all eight domains, plus a phone layout for one route per
nonflight domain.

For a coarse maritime sanity check, run
`python scripts/audit_journeys_land.py sailing ocean-liners --fail`.
It flags long inland runs in interpolated sea legs against the bundled Natural
Earth 110m country mask. It cannot validate narrow channels, precise coastlines,
or inland waterways; reported legs require manual review.

## Research and route sources

The seven nonflight domains have 175 ranked journeys with route anchors,
historical significance, source links, and geometry confidence:

- [Sailing](research/sailing.md)
- [Rail](research/rail.md)
- [Road and races](research/road-races.md)
- [Overland](research/overland.md)
- [Ocean liners](research/ocean-liners.md)
- [River](research/river.md)
- [Human-powered](research/human-powered.md)

These briefs explain the selections; the corresponding sourced anchor records
are in `data/journeys/*.json`. Historic alignments, mixed-mode segments, and
disputed legs remain illustrative rather than precise tracks.
Six candidates were removed because a defensible route could not be
established, then replaced with six independently researched journeys; see
[the geometry audit](research/geometry-audit.md).

## Geometry method

Historic route records usually provide endpoints, named stops, landfalls, or a
small number of logged positions—not continuous GPS tracks. Flight routes use
great-circle arcs or a normalized 3D cardinal spline through their anchors.
The seven other domains join sourced anchors with great-circle rendering
samples at no more than 5 km spacing; independent segments stay separate.
Antimeridian crossings are split into valid WKT `MULTILINESTRING` parts.

High vertex density improves rendering and interchange. It does **not** make an
interpolated segment equivalent to observed telemetry. That limitation is
carried in each GeoJSON feature and displayed in the map.

Generated outputs:

- `data/routes.geojson` — all route geometry and metadata in CRS84
- `data/wkt/*.wkt` — one WKT geometry per flight
- `data/routes-index.tsv` — route/output inventory
- `data/journeys/*.geojson` — sourced features per nonflight domain in CRS84
- `data/wkt/<domain>/*.wkt` — one WKT geometry per nonflight journey

Sourced images are stored under `assets/aircraft/` and `assets/journeys/`.
Their source, credit, and reuse terms are recorded in
`data/aircraft-images.json` and `data/journey-images.json` and linked beside
each image in the detail card. All 175 nonflight journeys have an image.
Images of replicas, museum displays, route settings, and later depictions are
labeled as such; they are not presented as photographs of the historical
journey.

To refresh the nonflight images, run
`python scripts/fetch_aircraft_images.py --catalog journeys --skip-existing`;
the downloader
checks each Commons file's reported license against the catalog before
creating a 1200 × 675 WebP. `scripts/journey_images_visual_test.cjs` checks
that all 175 images load in headless Chrome and each of the seven nonflight
domains has a working image on a phone. Reviewed choices and captions live in
`data/journey-image-overrides.json`, `data/journey-image-captions.json`, and
`data/journey-image-credits.json`. To research replacements for a complete
catalog, run `python scripts/research_journey_images.py --all`, review its
candidate file and the three reviewed data files, then run
`python scripts/build_journey_image_catalog.py`. The checked-in catalog is
authoritative; search results may change.

Run `python scripts/build_routes.py` after editing flight anchors, or
`python scripts/build_journeys.py` after editing nonflight anchors.

### Reusing and auditing the WKT pipeline

The authoritative inputs are the flight records in `scripts/build_routes.py`
and the seven `data/journeys/<domain>.json` files. The builders validate named
anchors and source links, interpolate each segment, split antimeridian
crossings, then pass the same coordinate lines to GeoJSON and the shared
`as_wkt()` serializer. Coordinates are CRS84 longitude, latitude; the extra
interpolated vertices are not additional historical observations. For a new
journey, add its researched anchors and segment evidence to the source record,
then run its domain builder. Do not hand-edit generated `.geojson` or `.wkt`.

After rebuilding, run `python scripts/build_overview.py --write`,
`python scripts/geometry_manifest.py --write`, then their respective `--check`
commands. The deterministic manifest
records source, builder, GeoJSON, and per-route WKT hashes and verifies that
every WKT matches its GeoJSON geometry and vertex count. It also checks that
the roughly 1 MB Show all preview was derived from the current full-resolution
collections. This makes later source or processing changes visible. The preview
and a cached, zoom-dependent screen-space simplification are solely for map
drawing and picking; selection loads the complete route on demand, and
downloads retain full geometry.
