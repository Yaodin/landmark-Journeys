#!/usr/bin/env python3
"""Build smooth, densified GeoJSON and WKT for the historic-flight map.

The source records usually preserve endpoints, stops, or selected waypoints—not
continuous telemetry. Two-point routes use spherical great-circle interpolation;
multi-point routes use a spherical cardinal spline that passes through every
documented anchor while rounding visual joins. The output metadata keeps the
distinction between generated geometry and observed positions visible.
"""

from __future__ import annotations

import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
WKT_DIR = DATA_DIR / "wkt"
MAX_INTERPOLATION_STEP_KM = 5.0
CARDINAL_TANGENT_SCALE = 0.85


def p(name: str, lat: float, lon: float, note: str = "") -> dict:
    return {"name": name, "lat": lat, "lon": lon, "note": note}


ROUTES = [
    {
        "rank": 1,
        "id": "wright-first-flight",
        "title": "Wright Flyer — first powered flight",
        "short_title": "Wright Flyer",
        "date": "1903-12-17",
        "era": "Pioneer",
        "group": "1–10",
        "color": "#ff5d5d",
        "quality": "documented_endpoints",
        "quality_label": "Documented endpoints",
        "step_km": 0.005,
        "route_summary": "First Flight Boulder → first landing marker, Kill Devil Hills",
        "overview": "On 17 December 1903, Orville Wright piloted the Wright Flyer from level ground at Kill Devil Hills while Wilbur ran alongside. The aircraft remained airborne for 12 seconds and traveled 120 feet; the brothers completed three additional flights later that day.",
        "why_famous": "It is widely recognized as the first controlled, sustained flight of a powered, heavier-than-air aircraft.",
        "description": "The 120-foot, 12-second first flight. The line connects the preserved launch and landing markers; it is not a telemetry trace.",
        "source_title": "National Park Service — First Flight Landing",
        "source_url": "https://www.nps.gov/places/000/first-flight-landing.htm",
        "anchors": [
            p("First Flight Boulder / launch rail", 36.01400, -75.66772),
            p("First-flight landing marker", 36.01433, -75.66772, "Approximately 120 ft from launch"),
        ],
    },
    {
        "rank": 2,
        "id": "lindbergh-spirit-of-st-louis",
        "title": "Spirit of St. Louis — solo Atlantic crossing",
        "short_title": "Lindbergh",
        "date": "1927-05-20/21",
        "era": "Pioneer",
        "group": "1–10",
        "color": "#ff9f43",
        "quality": "documented_corridor",
        "quality_label": "Documented landfalls + reconstructed ocean track",
        "step_km": 20,
        "route_summary": "Roosevelt Field, New York → Ireland → southwest Britain → Le Bourget, Paris",
        "overview": "Charles Lindbergh flew the single-engine Spirit of St. Louis alone from Long Island to Paris in 33½ hours. He crossed the Atlantic without radio navigation, relying on dead reckoning and visual landmarks.",
        "why_famous": "The first solo nonstop transatlantic flight made Lindbergh an international celebrity and helped accelerate public acceptance of long-distance aviation.",
        "description": "Intermediate landfall areas follow the Smithsonian account. The connecting curves are illustrative reconstructions, not a recorded flight track.",
        "source_title": "Smithsonian National Air and Space Museum — Spirit of St. Louis",
        "source_url": "https://airandspace.si.edu/collection-objects/barograph-spirit-st-louis-charles-lindbergh-ny-paris-flight-may-1927/nasm_A19310028000",
        "anchors": [
            p("Roosevelt Field, Long Island", 40.74083, -73.60750),
            p("Nova Scotia coast", 45.03, -61.52, "Generalized outbound land segment"),
            p("Newfoundland coast", 47.15, -52.89, "Generalized last North American landfall"),
            p("Southwest Ireland", 51.93, -10.24, "First European landfall area"),
            p("Southwest Britain", 50.37, -4.14),
            p("Northwest France", 49.64, -1.62),
            p("Le Bourget Field, Paris", 48.96944, 2.44139),
        ],
    },
    {
        "rank": 3,
        "id": "enola-gay-hiroshima",
        "title": "Enola Gay — Hiroshima mission",
        "short_title": "Enola Gay",
        "date": "1945-08-06",
        "era": "War",
        "group": "1–10",
        "color": "#ffd166",
        "quality": "documented_log",
        "quality_label": "Navigator-log waypoints",
        "step_km": 15,
        "route_summary": "Tinian → Iwo Jima rendezvous → Hiroshima → return via Iwo Jima → Tinian",
        "overview": "Enola Gay was a U.S. Army Air Forces B-29 commanded by Paul Tibbets. On 6 August 1945 it flew from Tinian to Hiroshima and released the uranium bomb Little Boy, destroying much of the city and killing tens of thousands of people before returning to Tinian.",
        "why_famous": "It carried out the first atomic bombing in warfare, an event that transformed military history and began the nuclear age.",
        "description": "The navigator's surviving log supplies the rendezvous, target, return positions, and times. Lines between logged positions are reconstructed.",
        "source_title": "National Museum of Nuclear Science & History — Hiroshima Log",
        "source_url": "https://ahf.nuclearmuseum.org/ahf/key-documents/hiroshima-log-enola-gay/",
        "anchors": [
            p("North Field, Tinian", 15.0750, 145.6340),
            p("North tip of Saipan", 15.291, 145.817, "Log: 02:55"),
            p("Logged position", 18.7167, 144.3500, "Log: 04:00"),
            p("Iwo Jima rendezvous", 24.7840, 141.3220, "Log: 05:55–06:02"),
            p("Hiroshima", 34.3947, 132.4547, "Bomb away: 09:15 Tinian time"),
            p("Return logged position", 29.7167, 137.0500, "Log: 10:41"),
            p("10 miles right of Iwo Jima", 24.7840, 141.5000, "Log: 12:19"),
            p("North Field, Tinian", 15.0750, 145.6340, "Landing: 14:58"),
        ],
    },
    {
        "rank": 4,
        "id": "earhart-solo-atlantic",
        "title": "Amelia Earhart — solo Atlantic crossing",
        "short_title": "Earhart",
        "date": "1932-05-20/21",
        "era": "Pioneer",
        "group": "1–10",
        "color": "#8bd450",
        "quality": "documented_endpoints",
        "quality_label": "Documented endpoints + geodesic reconstruction",
        "step_km": 20,
        "route_summary": "Harbour Grace, Newfoundland → Culmore near Derry, Northern Ireland",
        "overview": "Amelia Earhart departed Newfoundland in a Lockheed Vega intending to reach Paris. Ice, poor weather, an exhaust fire, and instrument problems forced her to land in a field near Derry after almost fifteen hours in the air.",
        "why_famous": "Earhart became the first woman to fly solo nonstop across the Atlantic and only the second person to do so after Lindbergh.",
        "description": "Earhart intended to reach Paris but landed near Derry. No continuous position record is asserted here.",
        "source_title": "NASA — Realizing the Dream of Flight",
        "source_url": "https://www.nasa.gov/wp-content/uploads/2023/04/sp-4112.pdf",
        "anchors": [
            p("Harbour Grace airfield", 47.5600, -53.2780),
            p("Culmore landing field near Derry", 55.0540, -7.2570),
        ],
    },
    {
        "rank": 5,
        "id": "bell-x1-sound-barrier",
        "title": "Bell X-1 — first supersonic flight",
        "short_title": "Bell X-1",
        "date": "1947-10-14",
        "era": "Experimental",
        "group": "1–10",
        "color": "#2ec4b6",
        "quality": "illustrative_local",
        "quality_label": "Documented local profile; illustrative plan-view path",
        "step_km": 0.2,
        "route_summary": "Muroc Army Air Field → B-29 air launch over Muroc Dry Lake → Rogers Dry Lake landing",
        "overview": "A Boeing B-29 carried the rocket-powered Bell X-1 to launch altitude over California's Mojave Desert. Chuck Yeager then accelerated the aircraft to Mach 1.06 before gliding back to the dry lakebed.",
        "why_famous": "It was the first piloted aircraft flight conclusively measured above the speed of sound in level flight.",
        "description": "NASA documents the carrier takeoff, air launch, speed run, and glide landing area. The exact plan-view curve is illustrative.",
        "source_title": "NASA — Research in Supersonic Flight",
        "source_url": "https://www.nasa.gov/history/SP-4219/Chapter3.html",
        "anchors": [
            p("Muroc Army Air Field", 34.9054, -117.8837, "B-29 carrier departure"),
            p("X-1 air-launch area", 35.012, -117.920, "Approximate drop area over the dry lake"),
            p("Supersonic speed-run area", 35.035, -117.800, "Illustrative local position"),
            p("Rogers Dry Lake landing area", 34.956, -117.872),
        ],
    },
    {
        "rank": 6,
        "id": "us-airways-1549",
        "title": "US Airways 1549 — Hudson River ditching",
        "short_title": "Flight 1549",
        "date": "2009-01-15",
        "era": "Modern",
        "group": "1–10",
        "color": "#00a8e8",
        "quality": "recorded_reconstruction",
        "quality_label": "NTSB secondary-radar positions",
        "step_km": 0.1,
        "route_summary": "LaGuardia Runway 4 → bird encounter north of the Bronx → Hudson River ditching",
        "overview": "Shortly after takeoff, the Airbus A320 struck a flock of Canada geese and lost effective thrust from both engines. Captain Chesley Sullenberger and First Officer Jeffrey Skiles ditched the aircraft in the Hudson River, where nearby vessels assisted the evacuation.",
        "why_famous": "All 155 occupants survived a dual-engine failure and water landing in the center of New York City, leading the event to be called the “Miracle on the Hudson.”",
        "description": "Runway points lead into 19 sampled NTSB secondary-radar returns (15:25:59–15:30:27 EST). The last two positions are NTSB estimates of touchdown and where the aircraft stopped. Curves between these positions are interpolated, not raw flight-data-recorder telemetry; radar range accuracy is about ±380 ft.",
        "source_title": "NTSB — US1549 Aircraft Performance Factual Report, Table 1a",
        "source_url": "https://data.ntsb.gov/Docket/Document/docBLOB?FileExtension=.PDF&FileName=Aircraft+Performance+13+-+Factual+Report+of+Group+Chairman-Master.PDF&ID=40322563",
        "anchors": [
            p("LaGuardia Runway 4 threshold", 40.7689, -73.8738, "Approximate runway geometry, before the first radar return"),
            p("Runway 4 departure end", 40.7832, -73.8626, "Approximate runway geometry, before the first radar return"),
            p("Radar 15:25:59.69", 40.7925750, -73.8651861, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:26:17.87", 40.8053861, -73.8662639, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:26:36.35", 40.8183833, -73.8692306, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:26:54.95", 40.8331722, -73.8727889, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:27:08.78", 40.8447556, -73.8754194, "NTSB Table 1a secondary-radar return; shortly before bird strike"),
            p("Radar 15:27:22.64", 40.8575333, -73.8788083, "NTSB Table 1a secondary-radar return; after bird strike"),
            p("Radar 15:27:40.82", 40.8720000, -73.8833750, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:27:54.83", 40.8799194, -73.8946972, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:27:59.30", 40.8801222, -73.8997500, "NTSB Table 1a secondary-radar return; near northern apex"),
            p("Radar 15:28:08.51", 40.8776472, -73.9109111, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:28:17.75", 40.8721028, -73.9200417, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:28:31.61", 40.8612083, -73.9299778, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:28:45.59", 40.8508750, -73.9403472, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:29:04.04", 40.8382750, -73.9542806, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:29:22.37", 40.8261944, -73.9679500, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:29:40.85", 40.8121028, -73.9787000, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:29:54.83", 40.8006806, -73.9854667, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:30:13.31", 40.7880194, -73.9937222, "NTSB Table 1a secondary-radar return"),
            p("Radar 15:30:27.17", 40.7807028, -73.9996000, "Last sampled NTSB Table 1a secondary-radar return"),
            p("Hudson River touchdown", 40.7713278, -74.0056944, "NTSB report satellite-image estimate, not a secondary-radar return"),
            p("Aircraft stopped", 40.7696417, -74.0068167, "NTSB report satellite-image estimate, not a secondary-radar return"),
        ],
    },
    {
        "rank": 7,
        "id": "concorde-ba300",
        "title": "Concorde BA300 — inaugural commercial service",
        "short_title": "Concorde BA300",
        "date": "1976-01-21",
        "era": "Jet age",
        "group": "1–10",
        "color": "#4d7cff",
        "quality": "documented_endpoints",
        "quality_label": "Documented endpoints + geodesic reconstruction",
        "step_km": 20,
        "route_summary": "London Heathrow → Bahrain International Airport",
        "overview": "British Airways flight BA300 carried fare-paying passengers from London to Bahrain on Concorde's first day of scheduled operation. An Air France Concorde simultaneously began service from Paris toward Rio de Janeiro via Dakar.",
        "why_famous": "The paired inaugural services opened the era of scheduled supersonic passenger travel.",
        "description": "The commercial endpoints are documented by British Airways. The line is a geodesic reconstruction, not an operational flight plan.",
        "source_title": "British Airways — Celebrating Concorde",
        "source_url": "https://www.britishairways.com/content/information/about-ba/history-and-heritage/celebrating-concorde",
        "anchors": [
            p("London Heathrow", 51.4700, -0.4543),
            p("Bahrain International Airport", 26.2708, 50.6336),
        ],
    },
    {
        "rank": 8,
        "id": "rutan-voyager",
        "title": "Rutan Voyager — nonstop unrefueled circumnavigation",
        "short_title": "Rutan Voyager",
        "date": "1986-12-14/23",
        "era": "Experimental",
        "group": "1–10",
        "color": "#8b5cf6",
        "quality": "illustrative_corridor",
        "quality_label": "1987 flight-data map corridor approximation",
        "step_km": 25,
        "route_summary": "Edwards AFB → westbound Pacific, Asia, Indian Ocean, Africa, Atlantic and Caribbean → Edwards AFB",
        "overview": "Dick Rutan and Jeana Yeager flew the lightweight composite Voyager westward around the globe, remaining airborne for just over nine days. They endured storms, equipment problems, extreme fatigue, and dwindling fuel reserves before returning to Edwards Air Force Base.",
        "why_famous": "Voyager completed the first nonstop, unrefueled circumnavigation of Earth by an aircraft.",
        "description": "The broad corridor follows a 1987 map credited to the Voyager project's meteorologists, with named places represented by approximate map positions. It is not a sequence of recorded GPS fixes or a navigation-quality track.",
        "source_title": "DiBiase and Krygier — 1987 Voyager flight-data map",
        "source_url": "https://makingmaps.net/wp-content/uploads/2011/10/makingmapsannotatedvoyagermaps.pdf",
        "anchors": [
            p("Edwards Air Force Base", 34.9054, -117.8837),
            p("Eastern Pacific", 25.0, -132.0),
            p("Central Pacific south of Hawaiʻi", 14.0, -157.0),
            p("Western Pacific", 10.0, 154.0),
            p("Philippines vicinity", 10.5, 126.0),
            p("South China Sea / Vietnam avoidance", 7.0, 108.0),
            p("Indian Ocean south of Sri Lanka", 2.0, 80.0),
            p("Western Indian Ocean", -4.0, 55.0),
            p("East African coast", -2.0, 40.0, "Approximate position from 1987 flight-data map"),
            p("Lake Victoria / Entebbe vicinity", 0.064, 32.44, "Named overflight on 1987 flight-data map; Entebbe is a geographic proxy"),
            p("West Africa", 5.0, 5.0),
            p("South Atlantic", -2.0, -25.0),
            p("Near Brazil", 0.0, -45.0),
            p("Caribbean", 15.0, -67.0),
            p("Central America", 14.0, -88.0),
            p("Northern Mexico", 27.0, -108.0),
            p("Edwards Air Force Base", 34.9054, -117.8837),
        ],
    },
    {
        "rank": 9,
        "id": "alcock-brown-atlantic",
        "title": "Alcock and Brown — first nonstop Atlantic crossing",
        "short_title": "Alcock & Brown",
        "date": "1919-06-14/15",
        "era": "Pioneer",
        "group": "1–10",
        "color": "#d946ef",
        "quality": "documented_endpoints",
        "quality_label": "Documented endpoints + geodesic reconstruction",
        "step_km": 20,
        "route_summary": "St. John's, Newfoundland → Derrigimlagh Bog near Clifden, Ireland",
        "overview": "John Alcock and Arthur Whitten Brown crossed the North Atlantic in a modified Vickers Vimy bomber. After more than sixteen hours in fog, icing, and equipment failures, they crash-landed in an Irish bog without serious injury.",
        "why_famous": "Their journey was the first nonstop transatlantic flight, eight years before Lindbergh's better-known solo crossing.",
        "description": "The endpoints are authoritative; the ocean segment is a great-circle reconstruction rather than a recorded track.",
        "source_title": "Royal Air Force — First Non-stop Flight",
        "source_url": "https://www.raf.mod.uk/what-we-do/our-history/first-non-stop-flight/",
        "anchors": [
            p("Lester's Field, St. John's", 47.591, -52.748),
            p("Derrigimlagh Bog, Clifden", 53.463, -10.019),
        ],
    },
    {
        "rank": 10,
        "id": "bleriot-channel",
        "title": "Blériot XI — first airplane crossing of the Channel",
        "short_title": "Blériot XI",
        "date": "1909-07-25",
        "era": "Pioneer",
        "group": "1–10",
        "color": "#f43f8c",
        "quality": "documented_landfalls",
        "quality_label": "Documented takeoff, landfall and landing",
        "step_km": 0.5,
        "route_summary": "Les Baraques near Calais → St. Margaret's Bay → Northfall Meadow, Dover",
        "overview": "Louis Blériot flew his small Blériot XI monoplane from the French coast to England in roughly 37 minutes. Without a compass, he followed ships across the Channel and the English coastline to a landing near Dover Castle.",
        "why_famous": "It was the first airplane crossing of the English Channel and demonstrated aviation's ability to connect countries across open water.",
        "description": "Dover Museum records Blériot's wind-driven landfall at St. Margaret's Bay before he followed the coast to Dover.",
        "source_title": "Dover Museum — Louis Blériot Landing in Dover",
        "source_url": "https://www.dovermuseum.co.uk/Information-Resources/The-Collection/Louis-Bleriot-Landing.aspx",
        "anchors": [
            p("Les Baraques takeoff field", 50.950, 1.826),
            p("St. Margaret's Bay landfall", 51.150, 1.386),
            p("Northfall Meadow, Dover", 51.132, 1.322),
        ],
    },
    {
        "rank": 11,
        "id": "vin-fiz-transcontinental",
        "title": "Vin Fiz — first U.S. transcontinental flight",
        "short_title": "Vin Fiz",
        "date": "1911-09-17/11-05",
        "era": "Pioneer",
        "group": "11–20",
        "color": "#ef4444",
        "quality": "documented_major_stops",
        "quality_label": "Documented corridor + major-stop reconstruction",
        "step_km": 10,
        "route_summary": "Sheepshead Bay → Midwest → Kansas City → Texas → southern border corridor → Pasadena → Long Beach",
        "overview": "Calbraith Perry Rodgers crossed the United States in the Wright EX Vin Fiz with support from a special train carrying mechanics and spare parts. The trip took 49 days and involved numerous crashes, forced landings, and repairs.",
        "why_famous": "It was the first transcontinental flight across the United States, showing both the promise and fragility of early long-distance aviation.",
        "description": "Smithsonian documents the broad route and finish. Selected major stops define this generalized reconstruction; the actual journey involved many more forced landings.",
        "source_title": "Smithsonian National Air and Space Museum — Wright EX Vin Fiz",
        "source_url": "https://airandspace.si.edu/collection-objects/wright-ex-vin-fiz/nasm_A19340060000",
        "anchors": [
            p("Sheepshead Bay, New York", 40.586, -73.944),
            p("Middletown, New York", 41.445, -74.422),
            p("Buffalo, New York", 42.886, -78.878),
            p("Chicago, Illinois", 41.878, -87.630),
            p("Springfield, Illinois", 39.799, -89.644),
            p("Kansas City, Missouri", 39.100, -94.579),
            p("Vinita, Oklahoma", 36.638, -95.154),
            p("McAlester, Oklahoma", 34.933, -95.769),
            p("Fort Worth, Texas", 32.755, -97.331),
            p("Waco, Texas", 31.549, -97.147),
            p("San Antonio, Texas", 29.425, -98.494),
            p("Del Rio, Texas", 29.370, -100.895),
            p("El Paso, Texas", 31.762, -106.486),
            p("Deming, New Mexico", 32.268, -107.759),
            p("Tucson, Arizona", 32.222, -110.974),
            p("Phoenix, Arizona", 33.448, -112.074),
            p("Pasadena, California", 34.148, -118.144, "Official transcontinental finish"),
            p("Long Beach, California", 33.754, -118.216, "Pacific ceremonial endpoint"),
        ],
    },
    {
        "rank": 12,
        "id": "jannus-first-airline",
        "title": "St. Petersburg–Tampa Airboat Line — inaugural flight",
        "short_title": "First airline flight",
        "date": "1914-01-01",
        "era": "Commercial",
        "group": "11–20",
        "color": "#f97316",
        "quality": "documented_endpoints",
        "quality_label": "Documented city endpoints + bay crossing",
        "step_km": 0.25,
        "route_summary": "St. Petersburg waterfront → Tampa waterfront across Tampa Bay",
        "overview": "Tony Jannus piloted a Benoist XIV flying boat across Tampa Bay with former St. Petersburg mayor Abram Pheil as its first paying passenger. The regularly scheduled service reduced a lengthy surface journey to about 23 minutes.",
        "why_famous": "The flight inaugurated the world's first scheduled passenger airline using a fixed-wing aircraft.",
        "description": "The 18-mile scheduled route is documented by the Smithsonian. The exact water track is reconstructed.",
        "source_title": "Smithsonian National Air and Space Museum — Early Airlines",
        "source_url": "https://airandspace.si.edu/stories/editorial/early-airlines-you-might-not-have-heard",
        "anchors": [
            p("St. Petersburg Central Yacht Basin", 27.771, -82.632),
            p("Tampa waterfront", 27.947, -82.459),
        ],
    },
    {
        "rank": 13,
        "id": "douglas-world-cruisers",
        "title": "Douglas World Cruisers — first aerial circumnavigation",
        "short_title": "World Cruisers",
        "date": "1924-04-06/09-28",
        "era": "Pioneer",
        "group": "11–20",
        "color": "#eab308",
        "quality": "documented_major_stops",
        "quality_label": "Documented major stops",
        "step_km": 20,
        "route_summary": "Seattle → Aleutians → Japan → South Asia → Europe → North Atlantic → North America → Seattle",
        "overview": "Four U.S. Army Air Service Douglas World Cruisers left Seattle on a westbound global expedition supported by ships, fuel caches, and maintenance depots. Two original aircraft, Chicago and New Orleans, completed the 175-day journey.",
        "why_famous": "It was the first successful aerial circumnavigation of the world and a landmark demonstration of global flight logistics.",
        "description": "Major landing and support points follow National Archives and U.S. Navy expedition accounts. The Nikolski Bay weather diversion and two intervening Japanese landfalls are included; many minor stops and local repositioning flights are omitted. Coordinates are named-place proxies, not flight fixes.",
        "source_title": "National Archives — Magellans of the Sky",
        "source_url": "https://www.archives.gov/publications/prologue/2010/summer/magellans.html",
        "anchors": [
            p("Sand Point, Seattle", 47.682, -122.255),
            p("Prince Rupert", 54.315, -130.320),
            p("Sitka", 57.053, -135.330),
            p("Seward", 60.104, -149.442),
            p("Chignik", 56.296, -158.402),
            p("Dutch Harbor", 53.890, -166.540),
            p("Atka", 52.196, -174.200),
            p("Attu", 52.850, 173.180),
            p("Nikolski Bay, Commander Islands", 55.2135, 165.9270, "Unplanned May 15–16 weather-diversion landing; harbor location approximate"),
            p("Paramushir, Kuril Islands", 50.350, 155.600),
            p("Hitokappu Bay, Iturup", 44.9667, 147.6667, "May 19 landing; bay-center geographic proxy"),
            p("Ōminato, Honshū", 41.2328, 141.1322, "May 22 landing; modern port-area geographic proxy, not a 1924 mooring position"),
            p("Kasumigaura, Japan", 36.033, 140.350),
            p("Kagoshima", 31.596, 130.557),
            p("Shanghai", 31.230, 121.474),
            p("Hong Kong", 22.319, 114.169),
            p("Hanoi / Haiphong region", 20.844, 106.689),
            p("Da Nang", 16.054, 108.202),
            p("Saigon", 10.823, 106.630),
            p("Bangkok", 13.756, 100.502),
            p("Rangoon", 16.840, 96.173),
            p("Chittagong", 22.356, 91.783),
            p("Calcutta", 22.573, 88.364),
            p("Allahabad", 25.435, 81.846),
            p("Multan", 30.157, 71.525),
            p("Karachi", 24.861, 67.010),
            p("Chabahar", 25.292, 60.643),
            p("Bandar Abbas", 27.184, 56.267),
            p("Baghdad", 33.315, 44.366),
            p("Aleppo", 36.202, 37.134),
            p("Istanbul", 41.008, 28.978),
            p("Bucharest", 44.426, 26.102),
            p("Budapest", 47.498, 19.040),
            p("Vienna", 48.208, 16.374),
            p("Strasbourg", 48.573, 7.752),
            p("Paris", 48.857, 2.352),
            p("London", 51.507, -0.128),
            p("Brough", 53.728, -0.574),
            p("Kirkwall", 58.984, -2.960),
            p("Reykjavík", 64.147, -21.943),
            p("Frederiksdal, Greenland", 60.000, -44.650),
            p("Ivittuut, Greenland", 61.200, -48.170),
            p("Icy Tickle, Labrador", 53.510, -55.760),
            p("Pictou, Nova Scotia", 45.676, -62.709),
            p("Boston", 42.360, -71.059),
            p("New York", 40.713, -74.006),
            p("Washington, D.C.", 38.907, -77.037),
            p("Dayton", 39.759, -84.192),
            p("Chicago", 41.878, -87.630),
            p("Omaha", 41.257, -95.935),
            p("Dallas", 32.777, -96.797),
            p("El Paso", 31.762, -106.486),
            p("Tucson", 32.222, -110.974),
            p("San Diego", 32.716, -117.161),
            p("Santa Monica", 34.016, -118.451),
            p("Sacramento", 38.582, -121.494),
            p("Eugene", 44.052, -123.087),
            p("Pearson Field, Vancouver", 45.621, -122.656),
            p("Sand Point, Seattle", 47.682, -122.255),
        ],
    },
    {
        "rank": 14,
        "id": "southern-cross-transpacific",
        "title": "Southern Cross — first U.S.–Australia trans-Pacific flight",
        "short_title": "Southern Cross",
        "date": "1928-05-31/06-09",
        "era": "Pioneer",
        "group": "11–20",
        "color": "#84cc16",
        "quality": "documented_stops",
        "quality_label": "Documented stops",
        "step_km": 20,
        "route_summary": "Oakland → Wheeler Field → Barking Sands → Suva → Naselai Beach → Brisbane",
        "overview": "Charles Kingsford Smith, Charles Ulm, Harry Lyon, and James Warner flew the Fokker trimotor Southern Cross from California to Australia in three principal oceanic stages. The Hawaii-to-Fiji leg was then the longest flight made over water.",
        "why_famous": "The expedition completed the first trans-Pacific flight from the continental United States to Australia.",
        "description": "All principal stops and the Fiji repositioning are represented; connecting curves are illustrative reconstructions, not observed tracks.",
        "source_title": "National Museum of Australia — Charles Ulm Collection",
        "source_url": "https://www.nma.gov.au/explore/collection/highlights/charles-ulm",
        "anchors": [
            p("Oakland Airport", 37.7213, -122.2208),
            p("Wheeler Field, Oʻahu", 21.4816, -158.0388),
            p("Barking Sands, Kauaʻi", 22.0228, -159.7850),
            p("Albert Park, Suva", -18.144, 178.425),
            p("Naselai Beach, Fiji", -18.087, 178.575, "Final-leg takeoff area"),
            p("Eagle Farm, Brisbane", -27.425, 153.088),
        ],
    },
    {
        "rank": 15,
        "id": "wiley-post-solo-world",
        "title": "Wiley Post — first solo circumnavigation",
        "short_title": "Wiley Post",
        "date": "1933-07-15/22",
        "era": "Pioneer",
        "group": "11–20",
        "color": "#10b981",
        "quality": "documented_stops",
        "quality_label": "Documented stops",
        "step_km": 20,
        "route_summary": "Floyd Bennett Field → Berlin → Königsberg → Moscow → Novosibirsk → Irkutsk → Rukhlovo → Khabarovsk → Flat → Fairbanks → Edmonton → Floyd Bennett Field",
        "overview": "Wiley Post flew the Lockheed Vega Winnie Mae alone around the Northern Hemisphere, aided by an early autopilot and radio direction finder. Repairs and an emergency landing in Alaska interrupted the journey, which still took less than eight days.",
        "why_famous": "Post became the first person to fly solo around the world and demonstrated the value of emerging navigation and automatic-control technology.",
        "description": "Stops follow the Smithsonian's comparison of Post's 1931 and 1933 itineraries and its 1933 account. It reports two unlocated poor-visibility landings between Moscow and Novosibirsk; no positions are inferred for them. Coordinates mark named places, and connecting curves are illustrative reconstructions. The Winnie Mae landed at Flat, was repaired there, then followed Joe Crosson to Fairbanks for fuel; the replacement propeller was flown separately from Fairbanks to Flat.",
        "source_title": "Smithsonian National Air and Space Museum — Mohler & Johnson, Wiley Post (1971)",
        "source_url": "https://repository.si.edu/server/api/core/bitstreams/ad1b4ecf-0b1a-400a-8c72-b87d4634560d/content",
        "anchors": [
            p("Floyd Bennett Field, New York", 40.5910, -73.8900),
            p("Berlin Tempelhof", 52.4730, 13.4030, "Reached nonstop from Floyd Bennett on July 16, 1933."),
            p("Königsberg", 54.6833, 20.5167, "Unscheduled landing after Post turned back for missing maps; grounded overnight by weather."),
            p("Moscow", 55.7560, 37.6170, "Unscheduled landing for Sperry autopilot repair."),
            p("Novosibirsk", 55.0080, 82.9350, "The Smithsonian account reports two additional poor-visibility landings between Moscow and here, but gives no locations."),
            p("Irkutsk", 52.2860, 104.3050, "Unscheduled landing for further autopilot repairs."),
            p("Rukhlovo (now Skovorodino)", 54.0000, 123.2500, "Named stop; coordinates printed in the Smithsonian itinerary."),
            p("Khabarovsk", 48.4800, 135.0710),
            p("Flat, Alaska", 62.4667, -158.0167, "Emergency landing and repairs after a nose-over; replacement propeller was flown here from Fairbanks."),
            p("Fairbanks, Alaska", 64.8380, -147.7160, "The repaired Winnie Mae followed Joe Crosson here and refueled; the replacement propeller had been flown separately from Fairbanks to Flat."),
            p("Edmonton", 53.5460, -113.4940),
            p("Floyd Bennett Field, New York", 40.5910, -73.8900),
        ],
    },
    {
        "rank": 16,
        "id": "china-clipper-airmail",
        "title": "China Clipper — inaugural trans-Pacific airmail flight",
        "short_title": "China Clipper",
        "date": "1935-11-22/29",
        "era": "Commercial",
        "group": "11–20",
        "color": "#14b8a6",
        "quality": "documented_stops",
        "quality_label": "Documented stops",
        "step_km": 20,
        "route_summary": "Alameda → Hawaiʻi → Midway → Wake → Guam → Manila",
        "overview": "Pan American Airways' Martin M-130 China Clipper carried mail from San Francisco Bay to Manila by island-hopping through newly developed Pacific bases. The journey took approximately one week and crossed the ocean in five long stages.",
        "why_famous": "It inaugurated regular trans-Pacific airmail service and established the route later used by Pan Am's celebrated passenger Clippers.",
        "description": "The National Park Service documents the island refueling chain and Alameda-to-Manila inaugural service.",
        "source_title": "National Park Service — Pan American Airways in the Pacific",
        "source_url": "https://www.nps.gov/articles/000/pan-american-airways-on-the-wwii-home-front-in-the-pacific.htm",
        "anchors": [
            p("Alameda, California", 37.7860, -122.3090),
            p("Pearl City Peninsula, Hawaiʻi", 21.3890, -157.9680),
            p("Midway Atoll", 28.2070, -177.3760),
            p("Wake Island", 19.2820, 166.6360),
            p("Sumay, Guam", 13.4580, 144.6510),
            p("Manila Bay", 14.5830, 120.9690),
        ],
    },
    {
        "rank": 17,
        "id": "spruce-goose",
        "title": "Hughes H-4 Hercules — the Spruce Goose's only flight",
        "short_title": "Spruce Goose",
        "date": "1947-11-02",
        "era": "Experimental",
        "group": "11–20",
        "color": "#06b6d4",
        "quality": "documented_local",
        "quality_label": "Documented harbor flight; approximate endpoints",
        "step_km": 0.01,
        "route_summary": "Short takeoff and landing run within Long Beach Harbor",
        "overview": "During a taxi test in Long Beach Harbor, Howard Hughes lifted the enormous wooden H-4 Hercules flying boat from the water for about 30 seconds. The prototype landed safely and was maintained for decades but never flew again.",
        "why_famous": "The brief hop was the only flight of the “Spruce Goose,” one of the largest aircraft ever built and an enduring symbol of Howard Hughes' ambition.",
        "description": "The museum documents a roughly 30-second flight just under half a mile. Exact liftoff and touchdown coordinates are approximate.",
        "source_title": "Evergreen Aviation & Space Museum — The Spruce Goose",
        "source_url": "https://www.evergreenmuseum.org/exhibit/the-spruce-goose/",
        "anchors": [
            p("Long Beach Harbor liftoff area", 33.7430, -118.2100),
            p("Long Beach Harbor touchdown area", 33.7455, -118.2025),
        ],
    },
    {
        "rank": 18,
        "id": "first-commercial-747",
        "title": "Pan Am — first commercial Boeing 747 flight",
        "short_title": "First 747 service",
        "date": "1970-01-22",
        "era": "Jet age",
        "group": "11–20",
        "color": "#3b82f6",
        "quality": "documented_endpoints",
        "quality_label": "Documented endpoints + geodesic reconstruction",
        "step_km": 20,
        "route_summary": "New York–JFK → London Heathrow",
        "overview": "Pan American World Airways introduced the Boeing 747 into revenue service on an overnight flight from New York to London. The inaugural departure was delayed by mechanical trouble and ultimately operated by a substitute 747.",
        "why_famous": "The flight opened the jumbo-jet era, greatly increasing long-haul passenger capacity and helping make intercontinental travel more accessible.",
        "description": "Boeing documents the city-pair. The displayed line is a great-circle reconstruction rather than the historical clearance route.",
        "source_title": "Boeing — 747 history",
        "source_url": "https://www.boeing.com/commercial/747-8",
        "anchors": [
            p("New York–JFK", 40.6413, -73.7781),
            p("London Heathrow", 51.4700, -0.4543),
        ],
    },
    {
        "rank": 19,
        "id": "gossamer-albatross",
        "title": "Gossamer Albatross — human-powered Channel crossing",
        "short_title": "Gossamer Albatross",
        "date": "1979-06-12",
        "era": "Experimental",
        "group": "11–20",
        "color": "#6366f1",
        "quality": "documented_endpoints",
        "quality_label": "Documented endpoints + geodesic reconstruction",
        "step_km": 0.25,
        "route_summary": "Folkestone, England → Cap Gris-Nez, France",
        "overview": "Cyclist and pilot Bryan Allen powered Paul MacCready's ultralight Gossamer Albatross across the English Channel by pedaling for nearly three hours. The aircraft landed on a beach at Cap Gris-Nez after covering 36.2 kilometers.",
        "why_famous": "It was the first successful English Channel crossing by a human-powered aircraft and won the second Kremer Prize.",
        "description": "The Smithsonian documents both endpoints and the 36.2 km distance. The intermediate line is reconstructed.",
        "source_title": "Smithsonian — MacCready Gossamer Albatross",
        "source_url": "https://www.si.edu/object/nasm_A19810428000",
        "anchors": [
            p("Folkestone takeoff area", 51.0670, 1.1900),
            p("Cap Gris-Nez landing beach", 50.8710, 1.5850),
        ],
    },
    {
        "rank": 20,
        "id": "solar-impulse-2",
        "title": "Solar Impulse 2 — first solar-powered circumnavigation",
        "short_title": "Solar Impulse 2",
        "date": "2015-03-09/2016-07-26",
        "era": "Modern",
        "group": "11–20",
        "color": "#a855f7",
        "quality": "documented_stops",
        "quality_label": "Official 17-leg itinerary",
        "step_km": 20,
        "route_summary": "Abu Dhabi → Asia → Hawaiʻi → continental U.S. → Europe → Cairo → Abu Dhabi",
        "overview": "Bertrand Piccard and André Borschberg alternated as pilots of Solar Impulse 2 during a 17-leg journey around the Northern Hemisphere. The aircraft used solar cells to power electric motors and recharge its batteries for overnight flight.",
        "why_famous": "It completed the first circumnavigation by a piloted solar-powered fixed-wing aircraft without consuming aviation fuel.",
        "description": "All 17 legs come from the mission's official route record. Connecting curves between airports are illustrative interpolations, not recorded flight tracks. Abu Dhabi endpoints use the official Al Bateen airport reference point.",
        "source_title": "Solar Impulse — Around the World Adventure; UAE GCAA AIP OMAD",
        "source_url": "https://aroundtheworld.solarimpulse.com/adventure",
        "source_urls": ["https://aroundtheworld.solarimpulse.com/adventure", "https://www.gcaa.gov.ae/en/ais/AIPHtmlFiles/AIP/Current/AIRACs/2025-P20/html/eAIP/AD-2.OMAD-en-GB.html"],
        "anchors": [
            p("Al Bateen Executive Airport, Abu Dhabi", 24.428333, 54.458056, "GCAA AIP OMAD airport reference point."),
            p("Muscat", 23.5933, 58.2844),
            p("Ahmedabad", 23.0734, 72.6266),
            p("Varanasi", 25.4524, 82.8593),
            p("Mandalay", 21.7022, 95.9781),
            p("Chongqing", 29.7192, 106.6417),
            p("Nanjing", 31.7420, 118.8620),
            p("Nagoya", 34.8584, 136.8054),
            p("Kalaeloa, Hawaiʻi", 21.3074, -158.0703),
            p("Moffett Field, California", 37.4140, -122.0500),
            p("Phoenix Goodyear", 33.4237, -112.3745),
            p("Tulsa", 36.1984, -95.8881),
            p("Dayton", 39.9024, -84.2194),
            p("Lehigh Valley", 40.6521, -75.4408),
            p("New York–JFK", 40.6413, -73.7781),
            p("Seville", 37.4180, -5.8931),
            p("Cairo", 30.1219, 31.4056),
            p("Al Bateen Executive Airport, Abu Dhabi", 24.428333, 54.458056, "GCAA AIP OMAD airport reference point."),
        ],
    },
    {
        "rank": 21,
        "id": "nc4-first-atlantic-crossing",
        "title": "NC-4 — first aircraft across the Atlantic",
        "short_title": "NC-4 Atlantic",
        "date": "1919-05-08/31",
        "era": "Pioneer",
        "group": "21–25",
        "color": "#fb7185",
        "quality": "documented_stops",
        "quality_label": "Documented stop sequence",
        "step_km": 25,
        "route_summary": "Rockaway → New England and Newfoundland → Azores → Lisbon → Ferrol → Plymouth",
        "overview": "Between 8 and 31 May 1919, the U.S. Navy flying boat NC-4 made the first successful Atlantic crossing by aircraft. Commanded by Albert C. Read, it departed New York with NC-1 and NC-3, but mechanical trouble delayed it and the other aircraft were lost after forced landings. Guided across the ocean by a chain of Navy ships, NC-4 reached the Azores, landed at Lisbon on 27 May, and continued to Plymouth.",
        "why_famous": "It was the first aircraft to cross the Atlantic and the first to fly from the United States to England, two weeks before the first nonstop crossing.",
        "description": "The Navy documents the stop sequence and dates. Coordinates represent historic stations, harbors, or river mouths rather than exact takeoff and alighting positions.",
        "source_title": "U.S. Naval History and Heritage Command — H-Gram 030: NC-4",
        "source_url": "https://www.history.navy.mil/about-us/leadership/director/directors-corner/h-grams/h-gram-030.html",
        "anchors": [
            p("Naval Air Station Rockaway", 40.5683, -73.8725, "Departure: 8 May"),
            p("Chatham, Massachusetts", 41.6714, -69.9499, "Repair stop"),
            p("Halifax Harbour", 44.6488, -63.5739),
            p("Trepassey Bay, Newfoundland", 46.7357, -53.3657, "Ocean-crossing departure"),
            p("Horta Harbour, Azores", 38.5358, -28.6260),
            p("Ponta Delgada Harbour", 37.7397, -25.6640),
            p("Tagus River, Lisbon", 38.6990, -9.1770, "Atlantic crossing completed: 27 May"),
            p("Mondego River mouth", 40.1450, -8.8660, "Forced down for radiator repair"),
            p("Ferrol Harbour", 43.4720, -8.2440, "Overnight stop"),
            p("Brest", 48.3904, -4.4861, "Documented circle and flyover"),
            p("Plymouth Sound", 50.3570, -4.1420, "Final arrival: 31 May"),
        ],
    },
    {
        "rank": 22,
        "id": "graf-zeppelin-world-flight",
        "title": "Graf Zeppelin — first airship circumnavigation",
        "short_title": "Graf Zeppelin",
        "date": "1929-08-07/29",
        "era": "Pioneer",
        "group": "21–25",
        "color": "#f472b6",
        "quality": "documented_corridor",
        "quality_label": "Documented stops + named corridor anchors",
        "step_km": 25,
        "route_summary": "Lakehurst → Friedrichshafen → Siberia → Tokyo → Los Angeles → U.S. cities → Lakehurst",
        "overview": "Under Hugo Eckener, the rigid airship LZ 127 Graf Zeppelin circled the Northern Hemisphere with passengers, crew, journalists, mail, and scientific observers aboard. The Lakehurst circuit stopped only at Friedrichshafen, Kasumigaura near Tokyo, and Mines Field in Los Angeles. Weather repeatedly altered the intended track over Siberia and the North Pacific. The voyage finished in about three weeks, with roughly twelve days airborne.",
        "why_famous": "It was the first passenger-carrying flight around the world, set a new circumnavigation speed record, and made the first nonstop Pacific crossing by an aircraft.",
        "description": "Landing stations and many named overflights are documented. Siberian, mountain, ocean-approach, and city-center anchors shape a weather-altered corridor rather than reproduce a position log.",
        "source_title": "Smithsonian — Graf Zeppelin 1929 World Flight",
        "source_url": "https://airandspace.si.edu/collection-archive/graf-zeppelin-1929-world-flight-photographs/sova-nasm-2014-0023",
        "anchors": [
            p("NAS Lakehurst", 40.0333, -74.3536, "Sponsored circuit start"),
            p("Statue of Liberty", 40.6893, -74.0445, "Documented departure circuit"),
            p("Friedrichshafen airfield", 47.6714, 9.5115, "First landing stop"),
            p("Verkhneimbatsk, Siberia", 63.1550, 87.9733, "Approximate match for Imbatsk radio station"),
            p("Yakutsk", 62.0274, 129.7320),
            p("Stanovoy Range", 55.6024, 130.1419, "Representative mountain-range anchor"),
            p("Ayan, Sea of Okhotsk", 56.4609, 138.1817),
            p("Gulf of Tartary", 50.5000, 141.5000, "Approximate documented southward-turn corridor"),
            p("Kasumigaura Naval Air Station", 36.0344, 140.1931, "Tokyo-area landing"),
            p("Oregon coast approach", 44.6500, -124.1500, "Approximate weather-diversion corridor"),
            p("Golden Gate", 37.8270, -122.4795, "Documented sunset passage"),
            p("Mines Field, Los Angeles", 33.9422, -118.4214, "Second landing stop"),
            p("El Paso", 31.7619, -106.4850),
            p("Kansas City", 39.1001, -94.5781),
            p("Chicago", 41.8756, -87.6244),
            p("Detroit", 42.3316, -83.0466),
            p("Cleveland", 41.4997, -81.6937),
            p("NAS Lakehurst", 40.0333, -74.3536, "Circumnavigation completed: 29 August"),
        ],
    },
    {
        "rank": 23,
        "id": "lucky-lady-ii-world-flight",
        "title": "Lucky Lady II — first nonstop flight around the world",
        "short_title": "Lucky Lady II",
        "date": "1949-02-26/03-02",
        "era": "Cold War",
        "group": "21–25",
        "color": "#c084fc",
        "quality": "documented_corridor",
        "quality_label": "Documented refueling regions + reconstructed track",
        "step_km": 25,
        "route_summary": "Carswell AFB → Azores → Arabia → Philippines → Hawaiʻi → Carswell AFB without landing",
        "overview": "Lucky Lady II was a U.S. Air Force B-50A commanded by James Gallagher. Departing Carswell Air Force Base on 26 February 1949, its fourteen-person crew flew eastward around the globe and returned after 94 hours and 1 minute aloft. Four aerial-refueling rendezvous—over the Azores, Saudi Arabia, the Philippines, and Hawaiʻi—made the 23,452-mile flight possible without landing.",
        "why_famous": "It completed the first nonstop aircraft circumnavigation and demonstrated that aerial refueling could give strategic aircraft global reach.",
        "description": "Official histories identify broad refueling regions, not exact tanker rendezvous coordinates. Intermediate airfields are geographic proxies and were not landing stops.",
        "source_title": "U.S. Air Force Historical Support Division — Lucky Ladies I, II and III",
        "source_url": "https://www.afhistory.af.mil/FAQs/Fact-Sheets/Article/458978/lucky-ladies-i-ii-and-iii/",
        "anchors": [
            p("Carswell Air Force Base", 32.76917, -97.44153, "Departure"),
            p("Azores refueling region", 38.76184, -27.09080, "Lajes-centered geographic proxy; no landing"),
            p("Arabia refueling region", 26.26542, 50.15203, "Dhahran-centered geographic proxy"),
            p("Philippines refueling region", 15.18599, 120.56032, "Clark-centered geographic proxy"),
            p("Hawaiʻi refueling region", 21.31868, -157.92243, "Hickam-centered geographic proxy"),
            p("Carswell Air Force Base", 32.76917, -97.44153, "Landing after 94 hours, 1 minute"),
        ],
    },
    {
        "rank": 24,
        "id": "sr71-coast-to-coast-record",
        "title": "SR-71 Blackbird — coast-to-coast retirement record",
        "short_title": "SR-71 Record Run",
        "date": "1990-03-06",
        "era": "Jet age",
        "group": "21–25",
        "color": "#818cf8",
        "quality": "illustrative_corridor",
        "quality_label": "Named record gates; illustrative corridor",
        "step_km": 20,
        "route_summary": "Palmdale → offshore running start → Los Angeles → Kansas City → St. Louis → Cincinnati → Dulles",
        "overview": "On 6 March 1990, U.S. Air Force SR-71A 61-7972 left Plant 42 at Palmdale for delivery to the Smithsonian. Raymond Yeilding and Joseph Vida refueled over the Pacific, made a 200-mile running start, crossed the coast above Mach 2.5, and reached Mach 3.3 and 83,000 feet. The flight established four recognized-course records before landing at Washington Dulles and entering the national collection.",
        "why_famous": "Its 67-minute 54-second coast-to-coast flight and 64-minute 20-second Los Angeles-to-Washington run remain spectacular demonstrations of Blackbird performance.",
        "description": "Origin, destination, performance, and named record segments are documented. City coordinates represent course benchmarks, not a published radar track; the offshore refueling loop is omitted.",
        "source_title": "Beale Air Force Base — SR-71 sets records",
        "source_url": "https://www.beale.af.mil/News/Article-Display/Article/667234/this-week-in-beale-history-sr-71-sets-records/",
        "anchors": [
            p("Air Force Plant 42, Palmdale", 34.6294, -118.0846, "Documented takeoff"),
            p("Oxnard coast benchmark", 34.1975, -119.1770, "Representative coast point after offshore running start"),
            p("Los Angeles benchmark", 34.0522, -118.2437, "Named recognized-course gate"),
            p("Kansas City benchmark", 39.0997, -94.5786),
            p("St. Louis benchmark", 38.6270, -90.1994),
            p("Cincinnati benchmark", 39.1031, -84.5120),
            p("Washington Dulles", 38.9531, -77.4565, "Documented landing and Smithsonian handover"),
        ],
    },
    {
        "rank": 25,
        "id": "air-canada-143-gimli-glider",
        "title": "Air Canada 143 — the Gimli Glider",
        "short_title": "Gimli Glider",
        "date": "1983-07-23",
        "era": "Jet age",
        "group": "21–25",
        "color": "#22d3ee",
        "quality": "illustrative_event_corridor",
        "quality_label": "Official sequence + approximate event areas",
        "step_km": 10,
        "route_summary": "Montréal → Ottawa → Red Lake area → Winnipeg diversion → powerless landing at Gimli",
        "overview": "Air Canada Flight 143 was a Boeing 767 scheduled from Montréal to Edmonton via Ottawa. An incorrect fuel-unit conversion left it with roughly half the fuel believed to be aboard. Both engines stopped after warnings near Red Lake during a diversion toward Winnipeg. Captain Robert Pearson and First Officer Maurice Quintal redirected to the former RCAF station at Gimli and glided the powerless jet onto a decommissioned runway used as a motorsport track.",
        "why_famous": "All 69 occupants survived the fuel-starved wide-body’s powerless landing, earning the aircraft its enduring nickname, the “Gimli Glider.”",
        "description": "The official inquiry documents the airport sequence, Red Lake region, diversion, distances, and landing. Intermediate event points are approximate geometric proxies, not recorder coordinates.",
        "source_title": "Government of Canada Board of Inquiry — Air Canada Flight 143",
        "source_url": "https://www.faa.gov/sites/faa.gov/files/2024-12/AirCanada143_C-GAUN.pdf",
        "anchors": [
            p("Montréal–Dorval Airport", 45.47056, -73.74083, "Confirmed origin"),
            p("Ottawa International Airport", 45.32250, -75.66917, "Confirmed intermediate stop"),
            p("Red Lake area", 51.06694, -93.79306, "Locale proxy for reported fuel-exhaustion region"),
            p("Dual-engine flameout area", 50.46757, -96.05699, "Approximate distance-intersection proxy: inquiry says 65 mi from Winnipeg and 45 mi from Gimli at 35,000 ft"),
            p("Gimli redirect area", 50.62806, -96.77000, "Approximate proxy for inquiry's 12 mi to Gimli at 20:32 CDT; not a recorded position"),
            p("Gimli Industrial Park Airport", 50.62806, -97.04333, "Confirmed emergency landing"),
        ],
    },
]


WIKI_PAGES = {
    "wright-first-flight": ("Wright Flyer", "https://en.wikipedia.org/wiki/Wright_Flyer"),
    "lindbergh-spirit-of-st-louis": ("Spirit of St. Louis", "https://en.wikipedia.org/wiki/Spirit_of_St._Louis"),
    "enola-gay-hiroshima": ("Enola Gay", "https://en.wikipedia.org/wiki/Enola_Gay"),
    "earhart-solo-atlantic": ("Amelia Earhart", "https://en.wikipedia.org/wiki/Amelia_Earhart"),
    "bell-x1-sound-barrier": ("Bell X-1", "https://en.wikipedia.org/wiki/Bell_X-1"),
    "us-airways-1549": ("US Airways Flight 1549", "https://en.wikipedia.org/wiki/US_Airways_Flight_1549"),
    "concorde-ba300": ("Concorde", "https://en.wikipedia.org/wiki/Concorde"),
    "rutan-voyager": ("Rutan Voyager", "https://en.wikipedia.org/wiki/Rutan_Voyager"),
    "alcock-brown-atlantic": ("Transatlantic flight of Alcock and Brown", "https://en.wikipedia.org/wiki/Transatlantic_flight_of_Alcock_and_Brown"),
    "bleriot-channel": ("Blériot XI", "https://en.wikipedia.org/wiki/Bl%C3%A9riot_XI"),
    "vin-fiz-transcontinental": ("Wright Model EX", "https://en.wikipedia.org/wiki/Wright_Model_EX"),
    "jannus-first-airline": ("St. Petersburg–Tampa Airboat Line", "https://en.wikipedia.org/wiki/St._Petersburg%E2%80%93Tampa_Airboat_Line"),
    "douglas-world-cruisers": ("First aerial circumnavigation", "https://en.wikipedia.org/wiki/First_aerial_circumnavigation"),
    "southern-cross-transpacific": ("Southern Cross (aircraft)", "https://en.wikipedia.org/wiki/Southern_Cross_(aircraft)"),
    "wiley-post-solo-world": ("Wiley Post", "https://en.wikipedia.org/wiki/Wiley_Post"),
    "china-clipper-airmail": ("China Clipper", "https://en.wikipedia.org/wiki/China_Clipper"),
    "spruce-goose": ("Hughes H-4 Hercules", "https://en.wikipedia.org/wiki/Hughes_H-4_Hercules"),
    "first-commercial-747": ("Boeing 747", "https://en.wikipedia.org/wiki/Boeing_747"),
    "gossamer-albatross": ("MacCready Gossamer Albatross", "https://en.wikipedia.org/wiki/MacCready_Gossamer_Albatross"),
    "solar-impulse-2": ("Solar Impulse", "https://en.wikipedia.org/wiki/Solar_Impulse"),
    "nc4-first-atlantic-crossing": ("Curtiss NC-4", "https://en.wikipedia.org/wiki/Curtiss_NC-4"),
    "graf-zeppelin-world-flight": ("LZ 127 Graf Zeppelin", "https://en.wikipedia.org/wiki/LZ_127_Graf_Zeppelin"),
    "lucky-lady-ii-world-flight": ("Lucky Lady II", "https://en.wikipedia.org/wiki/Lucky_Lady_II"),
    "sr71-coast-to-coast-record": ("Lockheed SR-71 Blackbird", "https://en.wikipedia.org/wiki/Lockheed_SR-71_Blackbird"),
    "air-canada-143-gimli-glider": ("Gimli Glider", "https://en.wikipedia.org/wiki/Gimli_Glider"),
}


def haversine_km(a: dict, b: dict) -> float:
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(h)))


def slerp(a: dict, b: dict, fraction: float) -> tuple[float, float]:
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    v1 = (math.cos(lat1) * math.cos(lon1), math.cos(lat1) * math.sin(lon1), math.sin(lat1))
    v2 = (math.cos(lat2) * math.cos(lon2), math.cos(lat2) * math.sin(lon2), math.sin(lat2))
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(v1, v2))))
    angle = math.acos(dot)
    if angle < 1e-12:
        return a["lon"], a["lat"]
    sin_angle = math.sin(angle)
    w1 = math.sin((1.0 - fraction) * angle) / sin_angle
    w2 = math.sin(fraction * angle) / sin_angle
    x = w1 * v1[0] + w2 * v2[0]
    y = w1 * v1[1] + w2 * v2[1]
    z = w1 * v1[2] + w2 * v2[2]
    lat = math.degrees(math.atan2(z, math.hypot(x, y)))
    lon = math.degrees(math.atan2(y, x))
    return lon, lat


def unit_vector(point: dict) -> tuple[float, float, float]:
    lat, lon = math.radians(point["lat"]), math.radians(point["lon"])
    return math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)


def spherical_cardinal(
    p0: dict,
    p1: dict,
    p2: dict,
    p3: dict,
    fraction: float,
) -> tuple[float, float]:
    """Interpolate p1→p2 with a normalized 3D cardinal spline.

    Interpolating unit vectors avoids longitude discontinuities at the
    antimeridian. Normalizing each result places the curve back on the globe.
    A restrained tangent scale rounds waypoint joins without large overshoots.
    """
    v0, v1, v2, v3 = (unit_vector(point) for point in (p0, p1, p2, p3))
    t = fraction
    t2, t3 = t * t, t * t * t
    h00 = 2 * t3 - 3 * t2 + 1
    h10 = t3 - 2 * t2 + t
    h01 = -2 * t3 + 3 * t2
    h11 = t3 - t2
    chord = [v2[axis] - v1[axis] for axis in range(3)]
    chord_length = math.sqrt(sum(value * value for value in chord))

    def limited_tangent(start: tuple[float, float, float], end: tuple[float, float, float]) -> list[float]:
        direction = [end[axis] - start[axis] for axis in range(3)]
        direction_length = math.sqrt(sum(value * value for value in direction))
        if direction_length < 1e-12:
            direction = chord
            direction_length = chord_length
        if direction_length < 1e-12:
            return [0.0, 0.0, 0.0]
        magnitude = CARDINAL_TANGENT_SCALE * chord_length
        return [value / direction_length * magnitude for value in direction]

    tangent1 = limited_tangent(v0, v2)
    tangent2 = limited_tangent(v1, v3)
    values = []
    for axis in range(3):
        values.append(h00 * v1[axis] + h10 * tangent1[axis] + h01 * v2[axis] + h11 * tangent2[axis])
    length = math.sqrt(sum(value * value for value in values))
    if length < 1e-12:
        return slerp(p1, p2, fraction)
    x, y, z = (value / length for value in values)
    return math.degrees(math.atan2(y, x)), math.degrees(math.atan2(z, math.hypot(x, y)))


def densify(anchors: list[dict], step_km: float) -> list[tuple[float, float]]:
    step_km = min(step_km, MAX_INTERPOLATION_STEP_KM)
    closed = (
        len(anchors) > 2
        and anchors[0]["lat"] == anchors[-1]["lat"]
        and anchors[0]["lon"] == anchors[-1]["lon"]
    )
    points: list[tuple[float, float]] = []
    for index, (a, b) in enumerate(zip(anchors, anchors[1:])):
        distance = haversine_km(a, b)
        segments = max(1, math.ceil(distance / step_km))
        if len(anchors) == 2:
            interpolate = lambda fraction: slerp(a, b, fraction)
        else:
            previous = anchors[index - 1] if index > 0 else (anchors[-2] if closed else a)
            following = anchors[index + 2] if index + 2 < len(anchors) else (anchors[1] if closed else b)
            interpolate = lambda fraction: spherical_cardinal(previous, a, b, following, fraction)
        start = 0 if index == 0 else 1
        for n in range(start, segments + 1):
            points.append(interpolate(n / segments))
    return points


def split_dateline(points: list[tuple[float, float]]) -> list[list[list[float]]]:
    if not points:
        return []
    lines: list[list[list[float]]] = [[[round(points[0][0], 6), round(points[0][1], 6)]]]
    for lon, lat in points[1:]:
        prev_lon, prev_lat = lines[-1][-1]
        delta = lon - prev_lon
        if delta > 180:
            adjusted = lon - 360
            t = (-180 - prev_lon) / (adjusted - prev_lon)
            cross_lat = prev_lat + t * (lat - prev_lat)
            lines[-1].append([-180.0, round(cross_lat, 6)])
            lines.append([[180.0, round(cross_lat, 6)], [round(lon, 6), round(lat, 6)]])
        elif delta < -180:
            adjusted = lon + 360
            t = (180 - prev_lon) / (adjusted - prev_lon)
            cross_lat = prev_lat + t * (lat - prev_lat)
            lines[-1].append([180.0, round(cross_lat, 6)])
            lines.append([[-180.0, round(cross_lat, 6)], [round(lon, 6), round(lat, 6)]])
        else:
            lines[-1].append([round(lon, 6), round(lat, 6)])
    return [line for line in lines if len(line) >= 2]


def as_wkt(lines: list[list[list[float]]]) -> str:
    def coords(line: list[list[float]]) -> str:
        return ", ".join(f"{lon:.6f} {lat:.6f}" for lon, lat in line)

    if len(lines) == 1:
        return f"LINESTRING ({coords(lines[0])})"
    return "MULTILINESTRING (" + ", ".join(f"({coords(line)})" for line in lines) + ")"


def build() -> None:
    WKT_DIR.mkdir(parents=True, exist_ok=True)
    features = []
    index_rows = ["rank\tid\ttitle\tdate\tdistance_km\tvertices\tgeometry\tquality\twkt_file"]

    for route in ROUTES:
        points = densify(route["anchors"], route["step_km"])
        lines = split_dateline(points)
        wkt = as_wkt(lines)
        distance = sum(haversine_km(a, b) for a, b in zip(route["anchors"], route["anchors"][1:]))
        geometry = {
            "type": "LineString" if len(lines) == 1 else "MultiLineString",
            "coordinates": lines[0] if len(lines) == 1 else lines,
        }
        properties = {k: v for k, v in route.items() if k != "anchors"}
        wiki_title, wiki_url = WIKI_PAGES[route["id"]]
        rounded_distance = round(distance, 3) if distance < 10 else round(distance, 1)
        properties.update(
            {
                "distance_km": rounded_distance,
                "vertex_count": sum(len(line) for line in lines),
                "geometry_type": geometry["type"],
                "wkt_file": f"data/wkt/{route['id']}.wkt",
                "wiki_title": wiki_title,
                "wiki_url": wiki_url,
                "anchors": route["anchors"],
            }
        )
        features.append({"type": "Feature", "properties": properties, "geometry": geometry})
        (WKT_DIR / f"{route['id']}.wkt").write_text(wkt + "\n", encoding="utf-8")
        index_rows.append(
            "\t".join(
                [
                    str(route["rank"]),
                    route["id"],
                    route["title"],
                    route["date"],
                    f"{rounded_distance:g}",
                    str(properties["vertex_count"]),
                    geometry["type"],
                    route["quality_label"],
                    properties["wkt_file"],
                ]
            )
        )

    collection = {
        "type": "FeatureCollection",
        "name": "Reconstructed Historic Aviation Routes",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "metadata": {
            "generated_by": "scripts/build_routes.py",
            "method": "Great-circle interpolation for two-point routes; spherical cardinal interpolation through multi-point route anchors",
            "target_interpolation_step_km": MAX_INTERPOLATION_STEP_KM,
            "warning": "Interpolated vertices are visualization geometry, not observed aircraft positions.",
            "route_count": len(features),
        },
        "features": features,
    }
    (DATA_DIR / "routes.geojson").write_text(json.dumps(collection, indent=2) + "\n", encoding="utf-8")
    (DATA_DIR / "routes-index.tsv").write_text("\n".join(index_rows) + "\n", encoding="utf-8")
    print(f"built {len(features)} routes with {sum(f['properties']['vertex_count'] for f in features):,} vertices")


if __name__ == "__main__":
    build()
