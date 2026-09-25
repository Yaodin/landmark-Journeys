#!/usr/bin/env python3
"""Build source-attributed 3D trajectories for the spaceflight research set.

The canonical coordinates in each generated path are Earth-centred ICRF/J2000
Cartesian kilometres.  JPL Horizons paths are sampled from navigation-derived
ephemerides.  Older flights without public ephemerides are explicitly marked
as reconstructions and use documented orbital elements or mission events.

This is a research data builder, not a flight-dynamics program.  It deliberately
does not invent burn-level precision where the historical record does not make
that precision readily available.
"""

from __future__ import annotations

import csv
import argparse
import bisect
import hashlib
import io
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PATH_DIR = ROOT / "paths"
EARTH_RADIUS_KM = 6378.137
EARTH_FLATTENING = 1 / 298.257223563
MU_EARTH = 398600.4418
HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_DOCS = "https://ssd.jpl.nasa.gov/horizons/manual.html"


MISSIONS = [
    {
        "rank": 1, "id": "apollo-11", "title": "Apollo 11", "date": "1969-07-16/1969-07-24",
        "vehicle": "Saturn V; CSM Columbia; LM Eagle", "kind": "lunar_return",
        "description": "First human landing on the Moon; Armstrong and Aldrin landed in Mare Tranquillitatis while Collins remained in lunar orbit.",
        "why_famous": "The first humans to land and walk on another world.",
        "confidence": "B", "approximation": "Mission-event reconstruction with Moon motion sampled from JPL, 30 representative CSM lunar orbits between NASA's insertion and departure times; not onboard telemetry or the LM descent.",
        "sources": ["https://www.nasa.gov/history/apollo-11-mission-overview/", "https://www.nasa.gov/wp-content/uploads/static/apollo50th/pdf/A11_MissionReport.pdf"],
        "launch": [28.5729, -80.6490], "launch_time": "1969-07-16T13:32:00Z", "moon_time": "1969-07-19T17:27:52Z", "moon_departure_time": "1969-07-22T04:55:42Z", "return_time": "1969-07-24T16:50:35Z", "landing": [13.3167, -169.1500], "lunar_orbits": 30,
    },
    {
        "rank": 2, "id": "vostok-1", "title": "Vostok 1", "date": "1961-04-12",
        "vehicle": "Vostok 3KA", "kind": "earth_orbit",
        "description": "Yuri Gagarin completed one Earth orbit and landed by parachute near Engels.",
        "why_famous": "First human in space and first human to orbit Earth.",
        "confidence": "B", "approximation": "Representative inclined orbit through the launch site using the published 181 km perigee, 327 km apogee and 65-degree inclination; plane phase, ascent and reentry remain modeled and the landing is constrained to the published region.",
        "sources": ["https://www.esa.int/About_Us/50_years_of_ESA/50_years_of_humans_in_space/The_flight_of_Vostok_1", "https://ntrs.nasa.gov/api/citations/19900009927/downloads/19900009927.pdf", "https://www.fai.org/sites/default/files/documents/record_file_gagarin_1.pdf"],
        "launch": [45.9200, 63.3420], "launch_time": "1961-04-12T06:07:00Z", "duration_min": 108, "orbits": 1.0, "inclination": 65.0, "perigee": 181, "apogee": 327, "landing": [51.0, 45.0],
    },
    {
        "rank": 3, "id": "sputnik-1", "title": "Sputnik 1", "date": "1957-10-04/1958-01-04",
        "vehicle": "PS-1", "kind": "earth_orbit",
        "description": "The first artificial satellite orbited Earth every roughly 96 minutes.",
        "why_famous": "Its launch began the Space Age.",
        "confidence": "B", "approximation": "Three representative initial revolutions from published perigee, apogee and inclination; orbital decay is not modeled.",
        "sources": ["https://www.nasa.gov/history/dawn-of-the-space-age/", "https://www.nasa.gov/history/sputnik/sputorig.html"],
        "launch": [45.9200, 63.3420], "launch_time": "1957-10-04T19:28:34Z", "duration_min": 96.2 * 3, "orbits": 3.0, "inclination": 65.1, "perigee": 215, "apogee": 939,
    },
    {
        "rank": 4, "id": "apollo-8", "title": "Apollo 8", "date": "1968-12-21/1968-12-27",
        "vehicle": "Saturn V; CSM-103", "kind": "lunar_return",
        "description": "The first crewed flight to the Moon and first human lunar orbit.",
        "why_famous": "Its crew saw the lunar farside and made the iconic Earthrise photograph.",
        "confidence": "B", "approximation": "Mission-event reconstruction with moving-Moon JPL ephemeris. NASA's initial 60.0 by 168.5 nmi lunar ellipse and 73:35:07 MET circularization replace two formerly circular representative revolutions; the remaining eight are approximately 60 nmi circular. Orbit plane orientation and full sample positions are modeled, not tracking telemetry.",
        "sources": ["https://www.nasa.gov/mission/apollo-8/", "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a410/A08_MissionReport.pdf"],
        "launch": [28.5729, -80.6490], "launch_time": "1968-12-21T12:51:00Z", "moon_time": "1968-12-24T09:59:00Z", "lunar_circularization_time": "1968-12-24T14:26:07Z", "initial_lunar_orbits": 2, "initial_lunar_perilune_nmi": 60.0, "initial_lunar_apolune_nmi": 168.5, "moon_departure_time": "1968-12-25T06:13:40Z", "return_time": "1968-12-27T15:51:42Z", "landing": [8.10, -165.00], "lunar_orbits": 10,
    },
    {
        "rank": 5, "id": "apollo-13", "title": "Apollo 13", "date": "1970-04-11/1970-04-17",
        "vehicle": "Saturn V; CSM Odyssey; LM Aquarius", "kind": "lunar_return",
        "description": "An oxygen-tank explosion forced an aborted landing and a life-saving loop around the Moon.",
        "why_famous": "A defining spacecraft emergency and rescue, remembered as a successful failure.",
        "confidence": "B+", "approximation": "Free-return style event reconstruction tied to moving Moon ephemeris, NASA's 1,988.8 km perilune radius and documented launch/splashdown times; flyby orientation is illustrative.",
        "sources": ["https://www.nasa.gov/missions/apollo/apollo-13-mission-details/", "https://www.nasa.gov/history/houston-weve-had-a-problem/", "https://svs.gsfc.nasa.gov/4791/"],
        "launch": [28.5729, -80.6490], "launch_time": "1970-04-11T19:13:00Z", "moon_time": "1970-04-15T00:33:57Z", "return_time": "1970-04-17T18:07:41Z", "landing": [-21.64, -165.36], "lunar_orbits": 0,
    },
    {
        "rank": 6, "id": "voyager-2", "title": "Voyager 2", "date": "1977-08-20/open",
        "vehicle": "Voyager 2", "kind": "horizons", "command": "-32", "start": "'1977-08-21 00:00'", "stop": "2026-09-24", "step": "5d", "launch": [28.5833, -80.5833], "launch_time": "1977-08-20T14:29:44Z",
        "description": "Gravity assists carried Voyager 2 past Jupiter, Saturn, Uranus and Neptune and onward into interstellar space.",
        "why_famous": "The only spacecraft to visit Uranus and Neptune, and all four giant planets.",
        "confidence": "A", "approximation": "Modeled east-southeast ascent and roughly 43-minute parking-orbit coast from NASA launch records; JPL Horizons spacecraft ephemeris sampled every minute from 15:32 UTC on launch day, then every five days. The pre-ephemeris arc is illustrative, not telemetry.",
        "sources": ["https://science.nasa.gov/mission/voyager/voyager-2/", "https://www.nasa.gov/wp-content/uploads/2023/04/sp-4230.pdf", "https://ntrs.nasa.gov/api/citations/19780016269/downloads/19780016269.pdf", HORIZONS_DOCS],
    },
    {
        "rank": 7, "id": "sts-1", "title": "STS-1 Columbia", "date": "1981-04-12/1981-04-14",
        "vehicle": "Space Shuttle Columbia", "kind": "earth_orbit",
        "description": "The first orbital test of the reusable Space Transportation System completed 37 revolutions.",
        "why_famous": "First Space Shuttle mission and first crewed maiden flight of a U.S. spacecraft system.",
        "confidence": "B+", "approximation": "Representative inclined orbit using NASA's achieved 238 km perigee, 250 km apogee and 40.3-degree inclination; estimated ascent and final 60-minute deorbit/entry arc are constrained to Edwards AFB. Orbital plane phase and sample states are modeled, not Shuttle telemetry.",
        "sources": ["https://www.nasa.gov/mission/sts-1/", "https://ntrs.nasa.gov/api/citations/19920074895/downloads/19920074895.pdf", "https://www.nasa.gov/wp-content/uploads/2023/04/sp-4407-etuv4.pdf"],
        "launch": [28.6084, -80.6043], "launch_time": "1981-04-12T12:00:03Z", "duration_min": 3260.9, "orbits": 37, "inclination": 40.3, "perigee": 238, "apogee": 250, "landing": [34.9054, -117.8837], "descent_min": 60,
    },
    {
        "rank": 8, "id": "friendship-7", "title": "Friendship 7", "date": "1962-02-20",
        "vehicle": "Mercury-Atlas 6", "kind": "earth_orbit",
        "description": "John Glenn became the first American to orbit Earth, completing three revolutions.",
        "why_famous": "A central early U.S. Space Race achievement.",
        "confidence": "B+", "approximation": "Representative inclined orbit using NASA's achieved 100 by 162.2 statute-mile orbit (rounded to 161 by 261 km) and 32.54-degree inclination; orbital plane phase and estimated ascent/reentry remain modeled, with the endpoint constrained to the documented splashdown region.",
        "sources": ["https://www.nasa.gov/mission/mercury-atlas-6-friendship-7/", "https://ntrs.nasa.gov/api/citations/20160000809/downloads/20160000809.pdf"],
        "launch": [28.4910, -80.5380], "launch_time": "1962-02-20T14:47:39Z", "duration_min": 295.38, "orbits": 3, "inclination": 32.54, "perigee": 161, "apogee": 261, "landing": [21.35, -68.68],
    },
    {
        "rank": 9, "id": "vostok-6", "title": "Vostok 6", "date": "1963-06-16/1963-06-19",
        "vehicle": "Vostok 3KA", "kind": "earth_orbit",
        "description": "Valentina Tereshkova completed 48 Earth orbits over almost three days.",
        "why_famous": "First spaceflight by a woman.",
        "confidence": "B", "approximation": "Representative inclined orbit from published dimensions and duration, with estimated ascent/reentry ending at the landing region.",
        "sources": ["https://www.nasa.gov/history/sally-ride-and-valentina-tereshkova-changing-the-course-of-human-space-exploration/", "https://www.nasa.gov/wp-content/uploads/2023/04/sp-4004-1963.pdf"],
        "launch": [45.9200, 63.3420], "launch_time": "1963-06-16T09:29:52Z", "duration_min": 4250, "orbits": 48, "inclination": 64.9, "perigee": 180, "apogee": 231, "landing": [53.21, 80.80],
    },
    {
        "rank": 10, "id": "voyager-1", "title": "Voyager 1", "date": "1977-09-05/open",
        "vehicle": "Voyager 1", "kind": "horizons", "command": "-31", "start": "'1977-09-06 00:00'", "stop": "2026-09-24", "step": "5d", "launch": [28.5833, -80.5833], "launch_time": "1977-09-05T12:56:00Z",
        "description": "Voyager 1 flew past Jupiter and Saturn/Titan before leaving the ecliptic and crossing the heliopause.",
        "why_famous": "The most distant human-made object and first spacecraft in interstellar space.",
        "confidence": "A", "approximation": "JPL Horizons trajectory; early segment is documented by Horizons as a patched-conic reconstruction and later segment is tracking-data fitted.",
        "sources": ["https://science.nasa.gov/mission/voyager/voyager-1/", HORIZONS_DOCS],
    },
    {
        "rank": 11, "id": "cassini-huygens", "title": "Cassini-Huygens", "date": "1997-10-15/2017-09-15",
        "vehicle": "Cassini orbiter; Huygens probe", "kind": "horizons", "command": "-82", "start": "'1997-10-15 10:00'", "stop": "'2017-09-15 10:00'", "step": "5d", "launch": [28.5619, -80.5774], "launch_time": "1997-10-15T08:43:00Z",
        "description": "Cassini used four planetary gravity assists to reach Saturn, while Huygens landed on Titan.",
        "why_famous": "The definitive Saturn mission and first landing in the outer Solar System.",
        "confidence": "A", "approximation": "JPL Horizons Cassini ephemeris sampled every five days; separate Huygens descent is not represented in this overview path.",
        "sources": ["https://science.nasa.gov/resource/cassini-trajectory/", "https://science.nasa.gov/mission/cassini-huygens/", HORIZONS_DOCS],
    },
    {
        "rank": 12, "id": "new-horizons", "title": "New Horizons", "date": "2006-01-19/open",
        "vehicle": "New Horizons", "kind": "horizons", "command": "-98", "start": "'2006-01-20 00:00'", "stop": "2026-09-24", "step": "4d", "launch": [28.5833, -80.5833], "launch_time": "2006-01-19T19:00:00Z",
        "description": "New Horizons used Jupiter to reach Pluto, then continued to Kuiper Belt object Arrokoth.",
        "why_famous": "First close exploration of Pluto and the most distant close flyby ever conducted.",
        "confidence": "A", "approximation": "JPL Horizons mission ephemeris sampled every four days.",
        "sources": ["https://science.nasa.gov/mission/new-horizons/", HORIZONS_DOCS],
    },
    {
        "rank": 13, "id": "explorer-1", "title": "Explorer 1", "date": "1958-01-31/1970-03-31",
        "vehicle": "Juno I; Explorer 1", "kind": "earth_orbit",
        "description": "The first U.S. satellite carried the instrument that discovered the Van Allen radiation belts.",
        "why_famous": "It brought the United States into orbital spaceflight and made a foundational discovery.",
        "confidence": "B", "approximation": "Three representative initial revolutions from published perigee, apogee and inclination; long-term perturbation and decay are omitted.",
        "sources": ["https://science.nasa.gov/mission/explorer-1/", "https://www.nasa.gov/missions/explorer/explorer-1-fast-facts/"],
        "launch": [28.4433, -80.5712], "launch_time": "1958-02-01T03:48:00Z", "duration_min": 114.8 * 3, "orbits": 3, "inclination": 33.24, "perigee": 354, "apogee": 2515,
    },
    {
        "rank": 14, "id": "viking-1", "title": "Viking 1", "date": "1975-08-20/1976-07-20",
        "vehicle": "Viking 1 orbiter and lander", "kind": "planet_transfer", "target": "499",
        "description": "Viking 1 entered Mars orbit and delivered the first fully successful long-lived Mars lander.",
        "why_famous": "It returned the first enduring surface investigation and images from Mars.",
        "confidence": "B", "approximation": "Heliocentric transfer reconstruction between JPL Earth and Mars ephemerides; the curve is not the spacecraft's navigation solution.",
        "sources": ["https://science.nasa.gov/mission/viking-1/", "https://science.nasa.gov/wp-content/uploads/2023/09/viking-encounter-press-kit.pdf"],
        "launch": [28.5833, -80.5833], "launch_time": "1975-08-20T21:22:00Z", "arrival_time": "1976-06-19T22:00:00Z", "landing_time": "1976-07-20T11:53:06Z", "target_name": "Mars",
    },
    {
        "rank": 15, "id": "mariner-4", "title": "Mariner 4", "date": "1964-11-28/1965-07-15",
        "vehicle": "Mariner 4", "kind": "planet_transfer", "target": "499",
        "description": "Mariner 4 performed the first successful Mars flyby and returned the first close images of another planet.",
        "why_famous": "It replaced speculation about Mars with direct close-range observations.",
        "confidence": "B", "approximation": "Heliocentric transfer reconstruction between JPL Earth and Mars ephemerides; encounter position is planet-centred and not offset by the 9,846 km flyby distance.",
        "sources": ["https://science.nasa.gov/mission/mariner-4/", "https://science.nasa.gov/resource/mariner-4s-image-locations-on-mars/"],
        "launch": [28.4667, -80.5333], "launch_time": "1964-11-28T14:22:01Z", "arrival_time": "1965-07-15T01:00:57Z", "target_name": "Mars",
    },
    {
        "rank": 16, "id": "luna-2", "title": "Luna 2", "date": "1959-09-12/1959-09-14",
        "vehicle": "Luna 2", "kind": "lunar_impact",
        "description": "The Soviet probe followed a direct translunar path and impacted the Moon.",
        "why_famous": "First human-made object to reach another celestial body.",
        "confidence": "B-", "approximation": "One-way mission-event reconstruction terminating on the approximate lunar near-side surface at the Moon's JPL ephemeris position; exact impact coordinates are not resolved.",
        "sources": ["https://science.nasa.gov/deep-space-exploration/", "https://science.nasa.gov/wp-content/uploads/2023/09/DSC_monograph24.pdf"],
        "launch": [45.9200, 63.3420], "launch_time": "1959-09-12T06:39:42Z", "moon_time": "1959-09-14T21:02:24Z",
    },
    {
        "rank": 17, "id": "venera-7", "title": "Venera 7", "date": "1970-08-17/1970-12-15",
        "vehicle": "Venera 7 bus and lander", "kind": "planet_transfer", "target": "299",
        "description": "Venera 7 survived its descent through Venus's atmosphere and returned surface data.",
        "why_famous": "First successful transmission from the surface of another planet.",
        "confidence": "B-", "approximation": "Heliocentric transfer reconstruction between JPL Earth and Venus ephemerides; exact landing coordinates are unknown and not invented.",
        "sources": ["https://science.nasa.gov/venus/exploration/", "https://science.nasa.gov/wp-content/uploads/2023/09/DSC_monograph24.pdf"],
        "launch": [45.9960, 63.5640], "launch_time": "1970-08-17T05:38:22Z", "arrival_time": "1970-12-15T05:34:00Z", "target_name": "Venus",
    },
    {
        "rank": 18, "id": "apollo-soyuz", "title": "Apollo-Soyuz Test Project", "date": "1975-07-15/1975-07-24",
        "vehicle": "Apollo CSM; Soyuz 19", "kind": "earth_orbit",
        "description": "American and Soviet spacecraft launched separately, rendezvoused and docked in Earth orbit.",
        "why_famous": "The first international crewed spaceflight and an enduring symbol of Cold War cooperation.",
        "confidence": "B+", "approximation": "Representative Apollo docking orbit from published altitude and inclination with estimated ascent/reentry; Soyuz phasing is not separately resolved.",
        "sources": ["https://www.nasa.gov/apollo-soyuz-test-project/", "https://www.nasa.gov/missions/apollo-soyuz/the-apollo-soyuz-mission/"],
        "launch": [28.6084, -80.6043], "launch_time": "1975-07-15T19:50:00Z", "duration_min": 13050, "orbits": 138, "inclination": 51.8, "altitude": 229, "landing": [22.0, -164.0], "max_samples": 1400,
    },
    {
        "rank": 19, "id": "soyuz-11", "title": "Soyuz 11 and Salyut 1", "date": "1971-06-06/1971-06-30",
        "vehicle": "Soyuz 11; Salyut 1", "kind": "earth_orbit",
        "description": "Soyuz 11 carried the first crew to live aboard a space station; all three cosmonauts died during return depressurization.",
        "why_famous": "It established the crewed-space-station model and remains a defining spaceflight tragedy.",
        "confidence": "B", "approximation": "Representative Salyut-class orbit and mission duration with estimated ascent/reentry; rendezvous and station-keeping burns are not reconstructed.",
        "sources": ["https://www.nasa.gov/missions/station/50-years-ago-launch-of-salyut-the-worlds-first-space-station/", "https://historycollection.jsc.nasa.gov/history/shuttle-mir/references/documents/mirhh-part1.pdf"],
        "launch": [45.9200, 63.3420], "launch_time": "1971-06-06T04:55:09Z", "duration_min": 34320, "orbits": 383, "inclination": 51.6, "altitude": 220, "landing": [47.36, 70.35], "max_samples": 1600,
    },
    {
        "rank": 20, "id": "rosetta", "title": "Rosetta and Philae", "date": "2004-03-02/2016-09-30",
        "vehicle": "Rosetta orbiter; Philae lander", "kind": "horizons", "command": "-226", "start": "'2004-03-02 10:00'", "stop": "'2016-09-30 10:00'", "step": "2d", "launch": [5.2390, -52.7690], "launch_time": "2004-03-02T07:17:00Z",
        "description": "Rosetta used repeated Earth and Mars assists to rendezvous with comet 67P; Philae landed on its nucleus.",
        "why_famous": "First spacecraft to rendezvous with and escort a comet, and first comet landing.",
        "confidence": "A", "approximation": "JPL Horizons/ESA mission ephemeris sampled every two days; Philae's local descent and bounces are not represented.",
        "sources": ["https://www.esa.int/Education/Teach_with_Rosetta/Rosetta_timeline", "https://www.cosmos.esa.int/web/psa/rosetta", HORIZONS_DOCS],
    },
    {
        "rank": 21, "id": "curiosity-msl", "title": "Mars Science Laboratory / Curiosity", "date": "2011-11-26/2012-08-06",
        "vehicle": "MSL cruise stage; Curiosity rover", "kind": "horizons", "command": "-76", "start": "'2011-11-27 00:00'", "stop": "'2012-08-06 05:00'", "step": "12h", "launch": [28.5833, -80.5833], "launch_time": "2011-11-26T15:02:00Z",
        "description": "The Mars Science Laboratory carried Curiosity to Gale Crater and delivered it with the sky-crane system.",
        "why_famous": "The seven-minutes-of-terror landing became a modern spaceflight landmark.",
        "confidence": "A", "approximation": "JPL Horizons spacecraft ephemeris sampled every twelve hours; atmospheric descent and surface traverse are separate local datasets not included here.",
        "sources": ["https://science.nasa.gov/mission/msl-curiosity/", "https://science.nasa.gov/planetary-science/programs/mars-exploration/mission-timeline/how-we-land-on-mars/", HORIZONS_DOCS],
    },
    {
        "rank": 22, "id": "hayabusa2", "title": "Hayabusa2", "date": "2014-12-03/2020-12-06",
        "vehicle": "Hayabusa2; sample-return capsule", "kind": "horizons", "command": "-37", "start": "'2014-12-04 00:00'", "stop": "'2020-12-06 00:00'", "step": "1d", "launch": [30.4000, 130.9700], "launch_time": "2014-12-03T04:22:00Z",
        "description": "Hayabusa2 rendezvoused with asteroid Ryugu, sampled it, and returned a capsule to Australia.",
        "why_famous": "First return of subsurface asteroid material.",
        "confidence": "A", "approximation": "JPL Horizons mission ephemeris sampled daily; the final sample-capsule atmospheric branch is not separately resolved.",
        "sources": ["https://www.hayabusa2.jaxa.jp/en/topics/20201026_orbit/", "https://global.jaxa.jp/projects/sas/hayabusa2/pdf/sat33_fs_23_en.pdf", HORIZONS_DOCS],
    },
    {
        "rank": 23, "id": "shenzhou-5", "title": "Shenzhou 5", "date": "2003-10-15/2003-10-16",
        "vehicle": "Long March 2F; Shenzhou 5", "kind": "earth_orbit",
        "description": "Yang Liwei completed 14 Earth orbits and landed in Inner Mongolia.",
        "why_famous": "Made China the third nation to independently launch and return a human from orbit.",
        "confidence": "B+", "approximation": "Representative inclined orbit using CMSA's achieved 199.14 by 347.8 km insertion ellipse and fifth-circuit transition to a 343 km circular orbit; the burn is placed at 07:54 UTC from the contemporary 15:54 Beijing-time report. Orbital plane phase and ascent/reentry states remain modeled.",
        "sources": ["https://en.cmse.gov.cn/missions/shenzhouv/", "https://cn.govopendata.com/renminribao/2003/10/16/2/", "https://www.cnsa.gov.cn/english/n6465652/n6465653/c6799621/content.html"],
        "launch": [40.9580, 100.2910], "launch_time": "2003-10-15T01:00:00Z", "duration_min": 1283, "orbits": 14, "inclination": 42.4, "altitude": 343, "initial_perigee": 199.14, "initial_apogee": 347.8, "circularization_time": "2003-10-15T07:54:00Z", "circularization_revolutions": 4.5, "landing": [42.37, 111.43],
    },
    {
        "rank": 24, "id": "artemis-1", "title": "Artemis I", "date": "2022-11-16/2022-12-11",
        "vehicle": "SLS; Orion", "kind": "horizons", "command": "-1023", "start": "'2022-11-16 09:00'", "stop": "'2022-12-11 17:00'", "step": "2h", "launch": [28.6270, -80.6210], "launch_time": "2022-11-16T06:47:44Z",
        "description": "The first integrated SLS-Orion flight completed lunar flybys and a distant retrograde lunar orbit.",
        "why_famous": "Opened NASA's Artemis lunar campaign and tested the human-rated lunar-return system.",
        "confidence": "A", "approximation": "JPL Horizons Orion ephemeris sampled every two hours.",
        "sources": ["https://www.nasa.gov/mission/artemis-i/", "https://www.nasa.gov/reference/artemis-i-mission-timeline/", HORIZONS_DOCS],
    },
    {
        "rank": 25, "id": "chandrayaan-3", "title": "Chandrayaan-3", "date": "2023-07-14/2023-08-23",
        "vehicle": "LVM3; propulsion module; Vikram; Pragyan", "kind": "horizons", "command": "-169", "start": "'2023-07-14 09:22'", "stop": "'2023-08-23 12:00'", "step": "5m", "launch": [13.7199, 80.2304], "launch_time": "2023-07-14T09:05:17Z",
        "description": "Chandrayaan-3 raised its Earth orbit, transferred to lunar polar orbit, and landed Vikram in the Moon's southern high latitudes.",
        "why_famous": "Made India the fourth nation to soft-land on the Moon and first in the lunar south-polar region.",
        "confidence": "A", "approximation": "JPL Horizons Chandrayaan-3 propulsion-module ephemeris sampled every five minutes to resolve its eccentric Earth orbits. The first 17 minutes of ascent are modeled between the launch site and first available state; the lander descent is not part of this path.",
        "sources": ["https://www.isro.gov.in/Chandrayaan3_Details.html", "https://www.isro.gov.in/NSPD2025/assets/pdf/CH3_Landing_Brochure.pdf", HORIZONS_DOCS],
    },
]

LAUNCH_SITES = {
    "apollo-11": "Kennedy Space Center", "apollo-8": "Kennedy Space Center",
    "apollo-13": "Kennedy Space Center", "sts-1": "Kennedy Space Center",
    "apollo-soyuz": "Kennedy Space Center", "artemis-1": "Kennedy Space Center",
    "voyager-2": "Cape Canaveral", "voyager-1": "Cape Canaveral",
    "friendship-7": "Cape Canaveral", "explorer-1": "Cape Canaveral",
    "cassini-huygens": "Cape Canaveral", "new-horizons": "Cape Canaveral",
    "viking-1": "Cape Canaveral", "mariner-4": "Cape Canaveral",
    "curiosity-msl": "Cape Canaveral",
    "vostok-1": "Baikonur Cosmodrome", "vostok-6": "Baikonur Cosmodrome",
    "sputnik-1": "Baikonur Cosmodrome", "luna-2": "Baikonur Cosmodrome",
    "venera-7": "Baikonur Cosmodrome", "soyuz-11": "Baikonur Cosmodrome",
    "rosetta": "Guiana Space Centre", "hayabusa2": "Tanegashima Space Center",
    "shenzhou-5": "Jiuquan Satellite Launch Center",
    "chandrayaan-3": "Satish Dhawan Space Centre",
}


def dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def vadd(a, b): return [a[i] + b[i] for i in range(3)]
def vsub(a, b): return [a[i] - b[i] for i in range(3)]
def vmul(a, s): return [x * s for x in a]
def vdot(a, b): return sum(a[i] * b[i] for i in range(3))
def vcross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def vnorm(a): return math.sqrt(vdot(a, a))
def vunit(a):
    n = vnorm(a)
    return [x / n for x in a]


def smoothstep(x: float) -> float:
    return x * x * (3 - 2 * x)


def unit_arc(a, b, fraction):
    """Interpolate directions on the sphere, including a stable near-parallel case."""
    a, b = vunit(a), vunit(b)
    angle = math.acos(max(-1.0, min(1.0, vdot(a, b))))
    if angle < 1e-8:
        return vunit(vadd(vmul(a, 1-fraction), vmul(b, fraction)))
    scale = math.sin(angle)
    return vunit(vadd(vmul(a, math.sin((1-fraction)*angle)/scale),
                      vmul(b, math.sin(fraction*angle)/scale)))


def radial_arc(a, b, fraction):
    """Interpolate direction and radius separately, never cutting through Earth.

    This is an educational event-to-event path, not an orbit solution.
    """
    av, bv = vunit(a), vunit(b)
    dot = max(-1.0, min(1.0, vdot(av, bv)))
    angle = math.acos(dot)
    if angle < 1e-8:
        direction = av
    else:
        denominator = math.sin(angle)
        direction = vadd(vmul(av, math.sin((1-fraction)*angle)/denominator),
                         vmul(bv, math.sin(fraction*angle)/denominator))
    radius = vnorm(a)*(1-fraction) + vnorm(b)*fraction
    return vmul(vunit(direction), radius)


def gmst_radians(value: datetime) -> float:
    unix_days = value.timestamp() / 86400.0
    jd = 2440587.5 + unix_days
    t = (jd - 2451545.0) / 36525.0
    deg = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933*t*t - t*t*t/38710000.0
    return math.radians(deg % 360.0)


def surface_eci(lat_deg: float, lon_deg: float, value: datetime, altitude_km=0.0):
    """Approximate Earth-fixed WGS84 geodetic fix rotated to the inertial axes."""
    lat = math.radians(lat_deg)
    theta = math.radians(lon_deg) + gmst_radians(value)
    eccentricity_sq = EARTH_FLATTENING*(2-EARTH_FLATTENING)
    prime_vertical = EARTH_RADIUS_KM/math.sqrt(1-eccentricity_sq*math.sin(lat)**2)
    xy = (prime_vertical+altitude_km)*math.cos(lat)
    return [xy*math.cos(theta), xy*math.sin(theta),
            (prime_vertical*(1-eccentricity_sq)+altitude_km)*math.sin(lat)]


def orbit_plane_basis(lat_deg: float, lon_deg: float, value: datetime, inclination_deg: float):
    """Launch tangent for the eastbound, ascending branch of an inclined orbit.

    The two solutions for a launch latitude and inclination are mirror images.
    Selecting the opposite node and then forcing a northward tangent used to
    send every modeled ascent westward, including Apollo and STS-1.
    """
    p = vunit(surface_eci(lat_deg, lon_deg, value))
    inc = math.radians(inclination_deg)
    phi = math.atan2(p[1], p[0])
    lat = math.asin(p[2])
    denom = max(1e-12, math.sin(inc) * math.cos(lat))
    c = max(-1.0, min(1.0, -math.cos(inc) * math.sin(lat) / denom))
    node_phi = phi - math.acos(c)
    n = vunit([math.sin(inc)*math.cos(node_phi), math.sin(inc)*math.sin(node_phi), math.cos(inc)])
    q = vunit(vcross(n, p))
    return p, q


def earth_orbit(m):
    start = dt(m["launch_time"])
    duration = float(m["duration_min"]) * 60.0
    # A single Cartesian polyline needs enough points *per revolution*;
    # capping multi-day flights at 1,600 samples aliases hundreds of orbits
    # into Earth-cutting chords.
    samples = max(160, math.ceil(m["orbits"] * 36) + 1)
    p, q = orbit_plane_basis(m["launch"][0], m["launch"][1], start, m["inclination"])
    rp = EARTH_RADIUS_KM + float(m.get("perigee", m.get("altitude", 250)))
    ra = EARTH_RADIUS_KM + float(m.get("apogee", m.get("altitude", 250)))
    a = (rp + ra) / 2
    e = (ra - rp) / (ra + rp)
    landing = m.get("landing")
    # A revolution count is rounded in public mission summaries. Choose the
    # nearest terminal phase that approaches the documented Earth-fixed landing
    # site after Earth rotation, instead of appending a teleporting point.
    turns = float(m["orbits"])
    end = start + timedelta(seconds=duration)
    landing_vec = surface_eci(landing[0], landing[1], end) if landing else None
    launch_vec = surface_eci(m["launch"][0], m["launch"][1], start)
    if landing_vec:
        projected_angle = math.atan2(vdot(landing_vec, q), vdot(landing_vec, p))
        turns += math.atan2(math.sin(projected_angle), math.cos(projected_angle)) / (2*math.pi)
    ascent_seconds = min(9 * 60.0, duration * 0.15)
    circularization_seconds = (dt(m["circularization_time"])-start).total_seconds() if m.get("circularization_time") else None
    descent_seconds = min(float(m.get("descent_min", 30)) * 60.0, duration * 0.35) if landing else 0.0
    terminal_orbit_direction = vadd(vmul(p, math.cos(2*math.pi*turns)), vmul(q, math.sin(2*math.pi*turns)))
    landing_direction = vunit(landing_vec) if landing_vec else None
    # Densify only launch and entry. At orbital resolution the final 10-degree
    # chord of a landed mission otherwise clips below the surface even when
    # both endpoints themselves are above it.
    sample_seconds = {round(duration*i/(samples-1)) for i in range(samples)}
    sample_seconds.add(round(ascent_seconds))
    if circularization_seconds is not None:
        sample_seconds.add(round(circularization_seconds))
    sample_seconds.update(range(0, math.ceil(ascent_seconds), 30))
    if landing:
        sample_seconds.update(range(math.floor(duration-descent_seconds), math.ceil(duration), 30))
    sample_seconds.add(round(duration))
    positions = []
    for seconds in sorted(sample_seconds):
        u = seconds/duration
        # A ~30-degree downrange ascent is distinct from the representative
        # parking-orbit phase. This avoids unrealistically forcing a full
        # orbital angular rate from the pad during the first minutes.
        ascent_angle = math.radians(30)
        total_angle = 2*math.pi*turns
        if seconds < ascent_seconds:
            ascent_u = seconds/ascent_seconds
            theta = ascent_angle * ascent_u**2 * (2-ascent_u)
        elif circularization_seconds is not None and seconds < circularization_seconds:
            # Fifth-circuit circularization occurs close to an apogee. The
            # modeled phase reaches 4.5 revolutions there, keeping the burn
            # a small radial adjustment instead of a spurious large jump.
            theta = ascent_angle + 2*math.pi*float(m["circularization_revolutions"])*(seconds-ascent_seconds)/(circularization_seconds-ascent_seconds)
        elif circularization_seconds is not None:
            angle_at_burn = ascent_angle + 2*math.pi*float(m["circularization_revolutions"])
            theta = angle_at_burn + (total_angle-angle_at_burn)*(seconds-circularization_seconds)/(duration-circularization_seconds)
        else:
            theta = ascent_angle + (total_angle-ascent_angle)*(seconds-ascent_seconds)/(duration-ascent_seconds)
        # Put the representative perigee at orbital insertion, not at the
        # launch-pad phase. The historical argument of perigee is not known
        # for most of these missions and remains an explicit model choice.
        if circularization_seconds is not None and seconds < circularization_seconds:
            initial_rp = EARTH_RADIUS_KM + float(m["initial_perigee"])
            initial_ra = EARTH_RADIUS_KM + float(m["initial_apogee"])
            initial_a = (initial_rp + initial_ra)/2
            initial_e = (initial_ra - initial_rp)/(initial_ra + initial_rp)
            radius = initial_a * (1-initial_e*initial_e)/(1+initial_e*math.cos(theta-ascent_angle))
        else:
            radius = a * (1 - e*e) / (1 + e * math.cos(theta-ascent_angle))
        if seconds < ascent_seconds:
            launch_radius = vnorm(launch_vec)
            radius = launch_radius + (radius-launch_radius)*smoothstep(seconds/ascent_seconds)
        if landing and seconds > duration-descent_seconds:
            descent_u = (seconds-(duration-descent_seconds))/descent_seconds
            blend = descent_u**2
            landing_radius = vnorm(landing_vec)
            radius = landing_radius + (radius-landing_radius)*(1-blend)
        direction = vadd(vmul(p, math.cos(theta)), vmul(q, math.sin(theta)))
        if landing and seconds > duration-descent_seconds:
            # Small plane/endpoint mismatch is distributed through the entry
            # phase. The correction vanishes at deorbit and is exact at landing.
            direction = vunit(vadd(direction, vmul(vsub(landing_direction, terminal_orbit_direction), blend)))
        pos = vmul(direction, radius)
        if seconds == 0:
            pos = launch_vec
        if landing and seconds == round(duration):
            pos = landing_vec
        positions.append([iso(start + timedelta(seconds=seconds)), *[round(x, 6) for x in pos]])
    return positions


def horizons_result(command: str, start: str, stop: str, step: str, center="500@399"):
    params = {
        "format": "json", "COMMAND": command, "EPHEM_TYPE": "VECTORS", "CENTER": center,
        "START_TIME": start, "STOP_TIME": stop, "STEP_SIZE": step, "OUT_UNITS": "KM-S",
        "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF", "VEC_TABLE": "2", "VEC_CORR": "NONE",
        "TIME_TYPE": "UT", "CSV_FORMAT": "YES",
    }
    url = HORIZONS_API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = json.load(response)
    if payload.get("error"):
        raise RuntimeError(f"Horizons {command}: {payload['error']}")
    result = payload["result"]
    if "$$SOE" not in result or "$$EOE" not in result:
        raise RuntimeError(f"Horizons {command}: no vector table returned\n{result[-1000:]}")
    block = result.split("$$SOE", 1)[1].split("$$EOE", 1)[0].strip()
    positions = []
    for row in csv.reader(io.StringIO(block)):
        if len(row) < 5:
            continue
        stamp = row[1].strip().replace("A.D. ", "")
        stamp_dt = datetime.strptime(stamp, "%Y-%b-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
        positions.append([iso(stamp_dt), round(float(row[2]), 6), round(float(row[3]), 6), round(float(row[4]), 6)])
    digest = hashlib.sha256(result.encode()).hexdigest()
    return positions, url, digest


def modeled_launch_to_first_state(m, first_state):
    """Short display reconstruction where a Horizons record starts after launch."""
    start = dt(m["launch_time"])
    first = dt(first_state[0])
    duration = (first-start).total_seconds()
    launch = surface_eci(m["launch"][0], m["launch"][1], start)
    launch_radius = vnorm(launch)
    target = first_state[1:4]
    target_radius = vnorm(target)
    rows = []
    if m["id"] == "voyager-2":
        # NASA's launch history gives a 43-minute parking-orbit coast, and the
        # DSN launch report gives the 124.09-degree launch azimuth. Horizons
        # begins after Centaur escape injection, at 15:31:44 UTC.
        p = vunit(launch)
        east = vunit(vcross([0, 0, 1], p))
        north = vunit(vcross(p, east))
        bearing = math.radians(124.09)
        q = vunit(vadd(vmul(north, math.cos(bearing)), vmul(east, math.sin(bearing))))
        parking_radius = EARTH_RADIUS_KM + 90*1.852
        ascent_end = 9.5*60
        coast_end = ascent_end + 43*60
        ascent_angle = math.radians(30)
        coast_angle = ascent_angle + 2*math.pi*43/89
        departure = vunit(vadd(vmul(p, math.cos(coast_angle)), vmul(q, math.sin(coast_angle))))
        for seconds in range(0, math.ceil(duration), 30):
            if seconds < ascent_end:
                u = seconds/ascent_end
                angle = ascent_angle * u*u*(2-u)
                direction = vunit(vadd(vmul(p, math.cos(angle)), vmul(q, math.sin(angle))))
                radius = launch_radius + (parking_radius-launch_radius)*smoothstep(u)
            elif seconds < coast_end:
                u = (seconds-ascent_end)/(coast_end-ascent_end)
                angle = ascent_angle + (coast_angle-ascent_angle)*u
                direction = vunit(vadd(vmul(p, math.cos(angle)), vmul(q, math.sin(angle))))
                radius = parking_radius
            else:
                u = (seconds-coast_end)/(duration-coast_end)
                direction = unit_arc(departure, target, u)
                radius = parking_radius + (target_radius-parking_radius)*smoothstep(u)
            point = vmul(direction, radius)
            if seconds == 0:
                point = launch
            rows.append([iso(start+timedelta(seconds=seconds)), *[round(x, 6) for x in point]])
    else:
        # The Chandrayaan-3 propulsion-module ephemeris begins about 17 min
        # after liftoff. Resolve the gap without connecting the pad directly
        # to a distant orbital state as one straight line.
        for seconds in range(0, math.ceil(duration), 30):
            u = seconds/duration
            direction = unit_arc(launch, target, u)
            radius = launch_radius + (target_radius-launch_radius)*u**1.3
            point = launch if seconds == 0 else vmul(direction, radius)
            rows.append([iso(start+timedelta(seconds=seconds)), *[round(x, 6) for x in point]])
    return rows


def horizons_mission(m):
    positions, query, digest = horizons_result(m["command"], m["start"], m["stop"], m["step"])
    supplemental = []
    if m["id"] == "voyager-2":
        early, url, early_digest = horizons_result("-32", "'1977-08-20 15:32'", "'1977-08-21 00:00'", "1m")
        assert early[-1][0] == positions[0][0]
        positions = early[:-1] + positions
        supplemental.append({"query_url": url, "raw_response_sha256": early_digest})
    if m["id"] in ("voyager-2", "chandrayaan-3"):
        positions = modeled_launch_to_first_state(m, positions[0]) + positions
    elif m.get("launch"):
        launch_time = dt(m["launch_time"])
        launch = surface_eci(m["launch"][0], m["launch"][1], launch_time)
        positions.insert(0, [iso(launch_time), *[round(x, 6) for x in launch]])
    return positions, query, digest, supplemental


def moon_ephemeris(start: datetime, end: datetime):
    """One hourly Horizons query per mission; interpolate moving Moon at path times."""
    query_start = "'" + (start - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M") + "'"
    query_end = "'" + (end + timedelta(hours=2)).strftime("%Y-%m-%d %H:%M") + "'"
    rows, query_url, response_sha256 = horizons_result("301", query_start, query_end, "1h")
    times = [dt(row[0]).timestamp() for row in rows]

    def at(value: datetime):
        stamp = value.timestamp()
        upper = bisect.bisect_right(times, stamp)
        if upper == 0 or upper >= len(rows):
            raise ValueError("Moon ephemeris does not cover mission event")
        lower = upper - 1
        fraction = (stamp-times[lower])/(times[upper]-times[lower])
        return vadd(vmul(rows[lower][1:4], 1-fraction), vmul(rows[upper][1:4], fraction))

    return at, query_url, response_sha256


def lunar_path(m):
    start = dt(m["launch_time"])
    encounter = dt(m["moon_time"])
    end = dt(m["return_time"]) if m.get("return_time") else encounter
    moon_at, moon_query_url, moon_response_sha256 = moon_ephemeris(start, end)
    launch = m["launch"]
    launch_vec = surface_eci(launch[0], launch[1], start)
    launch_radius = vnorm(launch_vec)
    ascent_end = start + timedelta(minutes=10)
    ascent_p, ascent_q = orbit_plane_basis(launch[0], launch[1], start, 65 if m["id"] == "luna-2" else 32.5)
    ascent_rows = []
    for i in range(25):
        u = i/24
        theta = math.radians(30)*u**2*(2-u)
        direction = vadd(vmul(ascent_p, math.cos(theta)), vmul(ascent_q, math.sin(theta)))
        radius = launch_radius + 185*u**1.5
        pos = vmul(direction, radius)
        positions_row = [iso(start + timedelta(minutes=10*u)), *[round(x, 6) for x in pos]]
        # The first coordinate is the physical launch site on the surface.
        if i == 0:
            positions_row = [iso(start), *[round(x, 6) for x in launch_vec]]
        ascent_rows.append(positions_row)
    start_pos = ascent_rows[-1][1:4]
    moon_at_encounter = moon_at(encounter)
    positions = ascent_rows

    def transfer_segment(first_time, last_time, first_pos, last_pos, bow_km, include_first):
        count = max(80, int((last_time-first_time).total_seconds()/3600) + 1)
        normal = vunit(vcross(first_pos, last_pos))
        for i in range(0 if include_first else 1, count):
            u = i/(count-1)
            when = first_time + (last_time-first_time)*u
            pos = vadd(radial_arc(first_pos, last_pos, smoothstep(u)),
                       vmul(normal, math.sin(math.pi*u)*bow_km))
            positions.append([iso(when), *[round(x, 6) for x in pos]])

    if m["kind"] == "lunar_impact":
        # A body-centre endpoint was 1,737 km below the lunar surface.
        impact = vsub(moon_at_encounter, vmul(vunit(moon_at_encounter), 1737.4))
        transfer_segment(ascent_end, encounter, start_pos, impact, 12000.0, False)
        return positions, moon_query_url, moon_response_sha256

    if m["id"] == "apollo-13":
        # NASA SVS gives a 1,988.8 km pericynthion and a five-hour flyby
        # window. The hyperbolic radius law is physical, while this displayed
        # plane orientation is illustrative, not a recovered guidance vector.
        far = vunit(moon_at_encounter)
        tangent = vunit(vcross(far, [0, 0, 1]))
        shoulder = timedelta(hours=2.5)
        approach, departure = encounter-shoulder, encounter+shoulder
        eccentricity, perilune_radius = 1.4462, 1988.8

        def flyby(when, angle):
            radius = perilune_radius*(1+eccentricity)/(1+eccentricity*math.cos(angle))
            direction = vadd(vmul(far, math.cos(angle)), vmul(tangent, math.sin(angle)))
            return vadd(moon_at(when), vmul(direction, radius))

        # The plotted five-hour window is the near-perilune arc. At 120 deg
        # this hyperbola would already be ~18,000 km out and demand an
        # implausible ~15 km/s jump in the short window; 95 deg stays near
        # ~5,600 km and preserves realistic few-km/s local speeds.
        angle_limit = math.radians(95)
        approach_pos = flyby(approach, -angle_limit)
        transfer_segment(ascent_end, approach, start_pos, approach_pos, 12000.0, False)
        flyby_samples = 81
        for i in range(1, flyby_samples):
            u = i/(flyby_samples-1)
            when = approach + (departure-approach)*u
            pos = flyby(when, -angle_limit+2*angle_limit*u)
            positions.append([iso(when), *[round(x, 6) for x in pos]])
        departure_pos = positions[-1][1:4]
    else:
        orbit_radius = 1737.4 + float(m.get("initial_lunar_perilune_nmi", 100/1.852))*1.852
        # Start exactly on the first lunar-orbit sample, rather than at the
        # Moon's centre and then leaping 1,837 km at the same timestamp.
        normal = vunit(moon_at_encounter)
        uvec = vunit(vcross(normal, [0, 0, 1] if abs(normal[2]) < .9 else [0, 1, 0]))
        vvec = vunit(vcross(normal, uvec))
        arrival_pos = vadd(moon_at_encounter, vmul(uvec, orbit_radius))
        transfer_segment(ascent_end, encounter, start_pos, arrival_pos, 12000.0, False)
        orbit_count = int(m.get("lunar_orbits", 0))
        departure = dt(m["moon_departure_time"])
        orbit_samples = max(60, orbit_count*36 + 1)
        for i in range(1, orbit_samples):
            u = i/(orbit_samples-1)
            when = encounter + (departure-encounter)*u
            if m.get("lunar_circularization_time"):
                circularized = dt(m["lunar_circularization_time"])
                initial_orbits = int(m["initial_lunar_orbits"])
                if when <= circularized:
                    fraction = (when-encounter)/(circularized-encounter)
                    angle = 2*math.pi*initial_orbits*fraction
                    rp = 1737.4 + float(m["initial_lunar_perilune_nmi"])*1.852
                    ra = 1737.4 + float(m["initial_lunar_apolune_nmi"])*1.852
                    semimajor = (rp+ra)/2
                    eccentricity = (ra-rp)/(ra+rp)
                    local_radius = semimajor*(1-eccentricity*eccentricity)/(1+eccentricity*math.cos(angle))
                else:
                    fraction = (when-circularized)/(departure-circularized)
                    angle = 2*math.pi*(initial_orbits+(orbit_count-initial_orbits)*fraction)
                    local_radius = orbit_radius
            else:
                angle = 2*math.pi*orbit_count*u
                local_radius = orbit_radius
            local = vadd(vmul(uvec, local_radius*math.cos(angle)), vmul(vvec, local_radius*math.sin(angle)))
            pos = vadd(moon_at(when), local)
            positions.append([iso(when), *[round(x, 6) for x in pos]])
        departure_pos = positions[-1][1:4]
    landing = surface_eci(m["landing"][0], m["landing"][1], end)
    transfer_segment(departure, end, departure_pos, landing, 9000.0, False)
    return positions, moon_query_url, moon_response_sha256


def body_heliocentric(body: str, start: datetime, stop: datetime, step="1d"):
    return horizons_result(body, "'"+start.strftime("%Y-%m-%d %H:%M")+"'", "'"+stop.strftime("%Y-%m-%d %H:%M")+"'", step, center="500@10")


def planet_transfer(m):
    start = dt(m["launch_time"])
    end = dt(m["arrival_time"])
    earth, earth_query, earth_digest = body_heliocentric("399", start, end)
    target, target_query, target_digest = body_heliocentric(m["target"], start, end)
    n = min(len(earth), len(target))
    earth0 = earth[0][1:4]
    target1 = target[n-1][1:4]
    chord = vsub(target1, earth0)
    normal = vunit(vcross(earth0, target1))
    positions = []
    for i in range(n):
        u = i/(n-1)
        s = smoothstep(u)
        # Heliocentric reconstruction: endpoint constrained by JPL body ephemerides,
        # with a modest out-of-chord bow to distinguish it from linear interpolation.
        heliocentric = vadd(vadd(vmul(earth0, 1-s), vmul(target1, s)), vmul(normal, math.sin(math.pi*u)*0.025*vnorm(chord)))
        geocentric = vsub(heliocentric, earth[i][1:4])
        positions.append([earth[i][0], *[round(x, 6) for x in geocentric]])
    # The transfer interpolation is body-centre constrained, but a launch begins
    # at the surface, not at Earth's centre. Preserve that truthful endpoint.
    launch = surface_eci(m["launch"][0], m["launch"][1], start)
    positions[0] = [iso(start), *[round(x, 6) for x in launch]]
    supplemental = [
        {"role": "JPL Earth body ephemeris used for reconstructed transfer", "query_url": earth_query, "raw_response_sha256": earth_digest},
        {"role": f"JPL {m['target_name']} body ephemeris used for reconstructed transfer", "query_url": target_query, "raw_response_sha256": target_digest},
    ]
    return positions, supplemental


def sample_origin_ranges(m, positions):
    """Label modeled and Horizons-derived samples without implying telemetry precision."""
    if m["kind"] != "horizons":
        return [{"first_index": 0, "last_index": len(positions)-1, "origin": "modeled_reconstruction"}]
    first_query = "1977-08-20 15:32" if m["id"] == "voyager-2" else m["start"].strip("'")
    first_jpl_time = dt(first_query.replace(" ", "T") + "Z")
    first_jpl_index = next(i for i, row in enumerate(positions) if dt(row[0]) >= first_jpl_time)
    result = []
    if first_jpl_index:
        result.append({"first_index": 0, "last_index": first_jpl_index-1, "origin": "modeled_launch_or_gap"})
    result.append({"first_index": first_jpl_index, "last_index": len(positions)-1, "origin": "jpl_horizons_vectors"})
    return result


def write_path(m, positions, source_query=None, source_sha256=None, supplemental_queries=None):
    max_radius = max(vnorm(row[1:4]) for row in positions)
    payload = {
        "schema_version": 1,
        "mission_id": m["id"],
        "title": m["title"],
        "coordinate_system": {
            "type": "cartesian",
            "origin": "Earth center of mass",
            "axes": "ICRF/J2000 mean equator and equinox",
            "units": "km",
            "time_scale": "UTC labels; Horizons states requested in ICRF with Horizons' internal TDB integration",
            "position_order": ["timestamp", "x_km", "y_km", "z_km"],
        },
        "provenance": {
            "confidence": m["confidence"],
            "method": "JPL Horizons vectors" if m["kind"] == "horizons" else m["approximation"],
            "approximation_notes": m["approximation"],
            "sources": m["sources"],
            "query_url": source_query,
            "raw_response_sha256": source_sha256,
            "supplemental_queries": supplemental_queries or [],
            "sample_origin_ranges": sample_origin_ranges(m, positions),
            "retrieved_utc_date": "2026-09-24",
        },
        "stats": {"point_count": len(positions), "max_earth_center_distance_km": round(max_radius, 3)},
        "positions": positions,
    }
    (PATH_DIR / f"{m['id']}.json").write_text(json.dumps(payload, indent=2) + "\n")
    return payload["stats"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--lunar-only", action="store_true", help="rebuild the four lunar reconstructions without resampling other missions")
    scope.add_argument("--earth-orbit-only", action="store_true", help="rebuild representative Earth-orbit paths without resampling other missions")
    scope.add_argument("--surface-endpoints-only", action="store_true", help="correct existing Horizons/transfer launch fixes to WGS84 without resampling JPL states")
    scope.add_argument("--annotate-sample-origins-only", action="store_true", help="label existing samples without resampling JPL states")
    scope.add_argument("--mission", metavar="ID", help="rebuild one mission and update the catalog without resampling the others")
    args = parser.parse_args()
    PATH_DIR.mkdir(parents=True, exist_ok=True)
    if args.lunar_only or args.earth_orbit_only or args.surface_endpoints_only or args.annotate_sample_origins_only or args.mission:
        catalog_path = ROOT / "index.json"
        catalog = json.loads(catalog_path.read_text())
        by_id = {mission["id"]: mission for mission in catalog["missions"]}
        if args.mission and args.mission not in by_id:
            parser.error(f"unknown mission ID: {args.mission}")
        for m in MISSIONS:
            by_id[m["id"]]["launch_site"] = LAUNCH_SITES[m["id"]]
        for m in MISSIONS:
            if args.annotate_sample_origins_only:
                path_file = PATH_DIR / f"{m['id']}.json"
                payload = json.loads(path_file.read_text())
                payload["provenance"]["sample_origin_ranges"] = sample_origin_ranges(m, payload["positions"])
                path_file.write_text(json.dumps(payload, indent=2) + "\n")
                print(f"{m['id']}: sample origins labeled; positions preserved")
                continue
            if args.surface_endpoints_only:
                if m["kind"] not in ("horizons", "planet_transfer"):
                    continue
                path_file = PATH_DIR / f"{m['id']}.json"
                payload = json.loads(path_file.read_text())
                launch_time = dt(m["launch_time"])
                assert payload["positions"][0][0] == iso(launch_time), m["id"]
                launch = surface_eci(m["launch"][0], m["launch"][1], launch_time)
                payload["positions"][0] = [iso(launch_time), *[round(x, 6) for x in launch]]
                path_file.write_text(json.dumps(payload, indent=2) + "\n")
                print(f"{m['id']}: launch reanchored to WGS84; sampled states preserved")
                continue
            if args.lunar_only and m["kind"] not in ("lunar_return", "lunar_impact"):
                continue
            if args.earth_orbit_only and m["kind"] != "earth_orbit":
                continue
            if args.mission and m["id"] != args.mission:
                continue
            if m["kind"] == "horizons":
                positions, query, digest, supplemental = horizons_mission(m)
            elif m["kind"] == "earth_orbit":
                positions, query, digest, supplemental = earth_orbit(m), None, None, []
            elif m["kind"] in ("lunar_return", "lunar_impact"):
                positions, moon_query, moon_digest = lunar_path(m)
                query, digest = None, None
                supplemental = [{"role": "JPL Moon body ephemeris used for reconstructed path", "query_url": moon_query, "raw_response_sha256": moon_digest}]
            elif m["kind"] == "planet_transfer":
                positions, supplemental = planet_transfer(m)
                query, digest = None, None
            else:
                raise ValueError(m["kind"])
            stats = write_path(m, positions, query, digest, supplemental)
            by_id[m["id"]].update({"trajectory_method": m["approximation"], "sources": m["sources"], **stats})
            print(f"{m['id']}: {stats['point_count']} points, max {stats['max_earth_center_distance_km']:.0f} km")
        catalog_path.write_text(json.dumps(catalog, indent=2) + "\n")
        return
    index = []
    for m in MISSIONS:
        query = digest = None
        supplemental = []
        if m["kind"] == "horizons":
            positions, query, digest, supplemental = horizons_mission(m)
        elif m["kind"] == "earth_orbit":
            positions = earth_orbit(m)
        elif m["kind"] in ("lunar_return", "lunar_impact"):
            positions, moon_query, moon_digest = lunar_path(m)
            supplemental = [{"role": "JPL Moon body ephemeris used for reconstructed path", "query_url": moon_query, "raw_response_sha256": moon_digest}]
        elif m["kind"] == "planet_transfer":
            positions, supplemental = planet_transfer(m)
        else:
            raise ValueError(m["kind"])
        stats = write_path(m, positions, query, digest, supplemental)
        index.append({
            "rank": m["rank"], "id": m["id"], "title": m["title"], "date": m["date"],
            "vehicle": m["vehicle"], "description": m["description"], "why_famous": m["why_famous"],
            "confidence": m["confidence"], "trajectory_method": m["approximation"], "sources": m["sources"],
            "launch_site": LAUNCH_SITES[m["id"]],
            "path": f"paths/{m['id']}.json", **stats,
        })
        print(f"{m['rank']:02d} {m['id']}: {stats['point_count']} points, max {stats['max_earth_center_distance_km']:.0f} km")
    catalog = {
        "schema_version": 1,
        "title": "Historically important spaceflight trajectories",
        "canonical_frame": "Earth-centered ICRF/J2000 Cartesian kilometres",
        "important_limit": "Paths with confidence B or lower are educational reconstructions, not navigation products.",
        "missions": index,
    }
    (ROOT / "index.json").write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    main()
