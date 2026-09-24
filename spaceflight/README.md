# Spaceflight trajectory research package

This directory contains a ranked, source-backed set of 25 historically important spaceflights and machine-readable 3D overview paths for a future globe/Space category.

## Data contract

- `index.json` is the catalog and points to one file per mission under `paths/`.
- Every point is `[UTC timestamp, x_km, y_km, z_km]`.
- The canonical spatial frame is **Earth-centered ICRF/J2000 Cartesian kilometres**.
- A path is time-dependent. It must not be treated as longitude/latitude, ECEF, or WGS84 surface geometry.
- Launch and documented Earth-return endpoints are placed on the **WGS84 ellipsoid**, then approximately rotated into the inertial axes. Their locations are grounded; the intervening historical reconstruction is not flight telemetry.
- JPL Horizons states are requested with `CENTER=500@399`, `REF_PLANE=FRAME`, `REF_SYSTEM=ICRF`, `VEC_CORR=NONE`, `TIME_TYPE=UT`, and `OUT_UNITS=KM-S`.
- Deep-space paths therefore naturally continue away from Earth. They are never closed back to the launch point.

## Accuracy classes

- **A:** sampled spacecraft ephemeris from JPL Horizons. Horizons documents that spacecraft trajectories may combine navigation-team solutions, reconstructed tracking arcs, predictions, or patched-conic historical reconstructions. Read the header for the selected target before using it quantitatively.
- **B/B+:** a mission-event reconstruction constrained by published launch/landing locations, orbital elements, encounter times, and JPL body ephemerides. It is suitable for an educational atlas but not navigation or scientific analysis.
- **B-:** endpoints and mission concept are secure, while exact historical vehicle states or landing coordinates are incomplete. No unsupported precision is claimed.

The provenance block in every path records the method, limitations, institutional sources, Horizons query URL when applicable, and SHA-256 of the returned Horizons text.

## Rebuilding and validation

The builder uses only Python's standard library and NASA/JPL's public Horizons API:

```bash
python spaceflight/build_spaceflight_paths.py
python spaceflight/validate_spaceflight_paths.py
```

For a focused rebuild, use `python spaceflight/build_spaceflight_paths.py --mission voyager-2` (or another catalog ID). This updates that mission's path and catalog fields without re-querying every spacecraft. The launch-site names in `index.json` are also refreshed on a focused rebuild.

The generated paths deliberately use adaptive research-level fidelity rather than uniform claims of precision:

- Voyager 1: five-day samples through 24 September 2026. Voyager 2: a labeled modeled ascent and roughly 43-minute parking-orbit coast, followed by one-minute JPL states from 15:32 UTC on launch day and five-day samples thereafter. The early model uses NASA's reported 124.09-degree launch azimuth; it is not launch telemetry.
- Cassini: five-day samples.
- New Horizons: four-day samples.
- Rosetta: two-day samples.
- Hayabusa2: daily samples.
- Curiosity cruise: twelve-hour samples.
- Artemis I: two-hour samples.
- Chandrayaan-3: five-minute JPL propulsion-module samples, beginning at the first available 09:22 UTC state. A short modeled arc fills the roughly 17-minute gap from launch; this does not represent Vikram's lunar descent. Three-hour samples had aliased the eccentric Earth orbits into long, misleading chords.
- Early Earth-orbit missions: representative inclined orbits at published inclination/altitude, with a modeled nine-minute ascent from the launch site. Landed missions phase the final revolution toward the documented landing site and use a modeled entry arc (60 minutes for STS-1, 30 minutes by default elsewhere), rather than teleporting from an unrelated last orbital fix. These are **not** recovered launch/reentry telemetry.
- Early Earth-orbit paths retain at least 36 samples per modeled revolution, including multi-day flights. Launch/entry are additionally sampled every 30 seconds so straight rendered chords do not dive through Earth. An old global sample cap produced aliased chords through Earth.
- Apollo/Luna lunar paths: smooth mission-event reconstructions tied to an hourly **moving-Moon** JPL ephemeris, with modeled ten Apollo 8 and thirty Apollo 11 CSM lunar revolutions between published insertion/departure events. Apollo 13 uses NASA's 1,988.8-km perilune radius in an illustrative flyby plane. Luna 2 ends on the approximate lunar near-side surface rather than at the Moon's centre. These are not spacecraft tracking solutions; Apollo 11's separate LM descent is not represented.
- Reconstructed Apollo and STS-1 initial bearings are constrained eastward by NASA launch azimuths; the validator checks these headings so a mirrored orbital-plane solution cannot silently reverse launch direction.
- Mariner 4, Venera 7, and Viking 1: heliocentric transfer reconstructions constrained by JPL Earth/target-planet ephemerides.

## Rendering guidance

For a Cesium globe, do not pass these coordinates to `Cartesian3.fromDegrees`. They are inertial Cartesian positions. Render them in an inertial reference frame or transform each sample into the scene's Earth-fixed frame at its timestamp. For a static overview, choose and disclose a single display epoch before applying an ICRF-to-fixed transform.

The local globe holds Earth at the first sample's epoch; when Cesium has no historical ICRF transform it uses a disclosed approximate USNO sidereal rotation. Sparse source samples whose straight connector would cross Earth receive *display-only* radial-arc vertices. Those vertices are not added to the downloadable path and are not additional historical fixes. This safeguard is particularly important near launch, reentry, and distant Earth flybys sampled days apart. Source-sampled deep-space trajectories remain sparse near planetary assists; any further visual smoothing must be labeled as interpolation, not new historical fixes.

Use multiple scale modes. Earth orbit, cislunar space, inner-Solar-System transfers, and Voyager-scale trajectories cannot be legibly shown at one linear camera scale. Local descent paths and rover traverses should be separate target-body layers rather than falsely attached to the interplanetary overview line.

Primary technical references:

- JPL Horizons manual: https://ssd.jpl.nasa.gov/horizons/manual.html
- NASA NAIF/SPICE: https://naif.jpl.nasa.gov/
- NAIF operational kernels: https://naif.jpl.nasa.gov/naif/data_operational.html
- NASA deep-space chronology: https://science.nasa.gov/wp-content/uploads/2023/09/DSC_monograph24.pdf
- NASA STS-1 mission facts and deorbit timeline: https://www.nasa.gov/mission/sts-1/ and https://www.nasa.gov/wp-content/uploads/2023/04/sp-4407-etuv4.pdf
- NASA Apollo 8 event timeline: https://www.nasa.gov/wp-content/uploads/2023/04/sp-4029.pdf
- NASA Apollo 11 event chronology: https://www.nasa.gov/wp-content/uploads/static/history/ap11ann/ap11events.html
- NASA Apollo 11 Mission Report (flight azimuth): https://www.nasa.gov/wp-content/uploads/static/apollo50th/pdf/A11_MissionReport.pdf
- NASA STS-1 press kit (flight azimuth): https://ntrs.nasa.gov/api/citations/19810011628/downloads/19810011628.pdf
- NASA Voyager mission history (parking orbit): https://www.nasa.gov/wp-content/uploads/2023/04/sp-4230.pdf
- NASA/JPL DSN Voyager 2 launch report (flight azimuth): https://ntrs.nasa.gov/api/citations/19780016269/downloads/19780016269.pdf
- NASA SVS Apollo 13 perilune reconstruction: https://svs.gsfc.nasa.gov/4791/

## Known intentional limitations

- Historical orbit reconstructions ignore perturbations, staging, phasing burns, drag, and orbital decay.
- Apollo paths are not substitutes for restored guidance-computer or tracking-network state vectors.
- Cassini's overview does not branch Huygens to Titan; Rosetta's overview does not branch Philae's bounces; Hayabusa2 does not branch its sample capsule.
- Chandrayaan-3 uses the propulsion-module Horizons trajectory for the overview. Vikram's final local descent belongs in a Moon-fixed layer.
- Reconstructed planet transfers are visually and chronologically defensible but are not Lambert solutions or recovered navigation trajectories.
