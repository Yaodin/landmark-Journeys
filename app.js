const GEOMETRY_VERSION = "alignment-20260925-2";
const ROUTES_URL = `data/routes.geojson?v=${GEOMETRY_VERSION}`;
const ALL_OVERVIEW_URL = `data/all-overview.geojson?v=${GEOMETRY_VERSION}`;
const BASEMAP_URL = "data/ne_110m_admin_0_countries.geojson";
const AIRCRAFT_IMAGES_URL = "data/aircraft-images.json";
const JOURNEY_IMAGES_URL = "data/journey-images.json?v=journey-images-2";
const IMAGERY_TILE_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_SIZE = 256;
const MAX_LAT = 85.05112878;
const MAX_CENTER_LAT = 89.5;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const MAX_WHEEL_ZOOM_STEP = 0.2;
const BUTTON_ZOOM_STEP = 0.25;
const DOUBLE_CLICK_ZOOM_STEP = 0.5;
const FIT_SAMPLE_LIMIT = 700;
const FIT_ZOOM_BREATHING_ROOM = 0.18;
const FIT_EDGE_CLEARANCE = 4;
const DOMAINS = {
  flights: { label: "Flights", singular: "Flight" },
  sailing: { label: "Sailing", singular: "Sailing journey" },
  rail: { label: "Rail", singular: "Rail journey" },
  "road-races": { label: "Road / Races", singular: "Road journey" },
  overland: { label: "Overland", singular: "Overland journey" },
  "ocean-liners": { label: "Ocean Liners", singular: "Ocean voyage" },
  river: { label: "River", singular: "River journey" },
  "human-powered": { label: "Human Powered", singular: "Human-powered journey" },
  all: { label: "All journeys", singular: "Journey" },
};

function inferredLine(properties, trackType) {
  if (!trackType) return properties.quality.includes("illustrative");
  return trackType === "waypoint-interpolation"
    || properties.geometry_confidence?.toLowerCase() === "low";
}
const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };
const researchCache = new Map();

const THEMES = {
  satellite: {
    imagery: true,
    ocean: "#07101a",
    oceanDeep: "#101821",
    land: "transparent",
    coast: "rgba(255, 255, 255, .48)",
    border: "rgba(255, 255, 255, .22)",
    grid: "rgba(255, 255, 255, .11)",
    label: "rgba(255, 255, 255, .86)",
  },
  atlas: {
    ocean: "#cfe3e3",
    oceanDeep: "#b9d7da",
    land: "#f1eee4",
    coast: "#9da7a4",
    border: "#c5c4bb",
    grid: "rgba(73, 103, 108, .18)",
    label: "rgba(68, 72, 70, .70)",
  },
  night: {
    ocean: "#08151f",
    oceanDeep: "#0d2330",
    land: "#1c303a",
    coast: "#61747a",
    border: "#344c57",
    grid: "rgba(121, 157, 168, .16)",
    label: "rgba(183, 200, 204, .68)",
  },
  minimal: {
    ocean: "#e7e9e5",
    oceanDeep: "#d9dedb",
    land: "#d0d4cf",
    coast: "#8d948f",
    border: "#b1b6b1",
    grid: "rgba(80, 88, 84, .13)",
    label: "rgba(64, 69, 66, .62)",
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function normalizeLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function geometryLines(geometry) {
  return geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
}

// Map-only level of detail. The sourced GeoJSON and downloadable WKT are never
// altered; this removes vertices that change the current on-screen line by less
// than a pixel. Each dateline-split line is simplified independently.
function simplifyScreenLine(coordinates, zoom, tolerance = 1.2) {
  if (coordinates.length <= 2) return coordinates;
  const size = TILE_SIZE * 2 ** zoom;
  const xs = new Float64Array(coordinates.length);
  const ys = new Float64Array(coordinates.length);
  coordinates.forEach(([lon, lat], index) => {
    const safeLat = clamp(lat, -MAX_LAT, MAX_LAT);
    const sin = Math.sin(safeLat * Math.PI / 180);
    xs[index] = (lon + 180) / 360 * size;
    ys[index] = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  });
  const keep = new Uint8Array(coordinates.length);
  keep[0] = 1;
  keep[coordinates.length - 1] = 1;
  const ranges = [[0, coordinates.length - 1]];
  const toleranceSquared = tolerance * tolerance;
  while (ranges.length) {
    const [start, end] = ranges.pop();
    const dx = xs[end] - xs[start];
    const dy = ys[end] - ys[start];
    const lengthSquared = dx * dx + dy * dy;
    let farthest = -1;
    let farthestDistance = toleranceSquared;
    for (let index = start + 1; index < end; index += 1) {
      const fraction = lengthSquared ? clamp(((xs[index] - xs[start]) * dx + (ys[index] - ys[start]) * dy) / lengthSquared, 0, 1) : 0;
      const offsetX = xs[index] - xs[start] - fraction * dx;
      const offsetY = ys[index] - ys[start] - fraction * dy;
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      ranges.push([start, farthest], [farthest, end]);
    }
  }
  return coordinates.filter((_, index) => keep[index]);
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = (a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(x, y, polygon) {
  let closest = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared
      ? clamp(((x - a.x) * dx + (y - a.y) * dy) / lengthSquared, 0, 1)
      : 0;
    closest = Math.min(closest, Math.hypot(x - (a.x + fraction * dx), y - (a.y + fraction * dy)));
  }
  return closest;
}

function polygonCentroid(polygon) {
  let areaTwice = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    areaTwice += cross;
    weightedX += (a.x + b.x) * cross;
    weightedY += (a.y + b.y) * cross;
  }
  if (Math.abs(areaTwice) < 0.001) {
    return {
      x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
      y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length,
    };
  }
  return {
    x: weightedX / (3 * areaTwice),
    y: weightedY / (3 * areaTwice),
  };
}

class CanvasSlippyMap {
  constructor(canvas, readout, attribution) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.readout = readout;
    this.attribution = attribution;
    this.center = { lon: 5, lat: 23 };
    this.zoom = 2;
    this.minZoom = 0;
    this.maxZoom = 18;
    this.themeName = "satellite";
    this.tileCache = new Map();
    this.countries = null;
    this.routes = null;
    this.visible = new Set();
    this.selected = null;
    this.overviewMode = false;
    this.displayLineCache = new WeakMap();
    this.drag = null;
    this.renderPending = false;
    this.onRoutePick = () => {};
    this.getFitPolygon = () => [
      { x: 18, y: 72 },
      { x: this.width - 18, y: 72 },
      { x: this.width - 18, y: this.height - 28 },
      { x: 18, y: this.height - 28 },
    ];
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.bindEvents();
    this.resize();
  }

  worldSize(zoom = this.zoom) {
    return TILE_SIZE * 2 ** zoom;
  }

  project(lon, lat, zoom = this.zoom, maxLatitude = MAX_LAT) {
    const size = this.worldSize(zoom);
    const safeLat = clamp(lat, -maxLatitude, maxLatitude);
    const sin = Math.sin(safeLat * Math.PI / 180);
    return {
      x: (lon + 180) / 360 * size,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    };
  }

  unproject(x, y, zoom = this.zoom) {
    const size = this.worldSize(zoom);
    const lon = x / size * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / size;
    const lat = 180 / Math.PI * Math.atan(Math.sinh(n));
    return { lon: normalizeLon(lon), lat: clamp(lat, -MAX_CENTER_LAT, MAX_CENTER_LAT) };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const refitAfterInitialLayout = (this.width || 0) < 50 && rect.width >= 50 && this.selected;
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const pixelWidth = Math.round(this.width * dpr);
    const pixelHeight = Math.round(this.height * dpr);
    const sizeChanged = this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight;
    if (sizeChanged) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (refitAfterInitialLayout && this.routes) {
      const feature = this.routes.features.find((candidate) => candidate.properties.id === this.selected);
      if (feature) {
        this.fitFeature(feature);
        return;
      }
    }
    if (sizeChanged && this.routes) {
      this.renderPending = false;
      this.render();
    } else {
      this.requestRender();
    }
  }

  setData(countries, routes, visible, overviewMode = false) {
    this.countries = countries;
    this.routes = routes;
    this.visible = visible;
    this.overviewMode = overviewMode;
    this.requestRender();
  }

  displayLines(feature, selected = false) {
    const lines = geometryLines(feature.geometry);
    if (!this.overviewMode || selected) return lines;
    const zoomBucket = Math.max(0, Math.floor(this.zoom));
    let cache = this.displayLineCache.get(feature.geometry);
    if (!cache) {
      cache = new Map();
      this.displayLineCache.set(feature.geometry, cache);
    }
    if (!cache.has(zoomBucket)) {
      cache.set(zoomBucket, lines.map((line) => simplifyScreenLine(line, zoomBucket)));
    }
    return cache.get(zoomBucket);
  }

  setTheme(name) {
    this.themeName = THEMES[name] ? name : "atlas";
    document.body.dataset.basemap = this.themeName;
    if (this.attribution) {
      const satellite = this.themeName === "satellite";
      this.attribution.href = satellite ? "https://www.esri.com/" : "https://www.naturalearthdata.com/";
      this.attribution.textContent = satellite ? "Imagery © Esri and contributors" : "Basemap © Natural Earth";
    }
    this.requestRender();
  }

  setView(lon, lat, zoom) {
    this.center = { lon: normalizeLon(lon), lat: clamp(lat, -MAX_CENTER_LAT, MAX_CENTER_LAT) };
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.updateReadout();
    this.requestRender();
  }

  zoomBy(delta, anchorX = this.width / 2, anchorY = this.height / 2) {
    const oldZoom = this.zoom;
    const newZoom = clamp(oldZoom + delta, this.minZoom, this.maxZoom);
    if (Math.abs(newZoom - oldZoom) < 0.001) return;
    const oldCenter = this.project(this.center.lon, this.center.lat, oldZoom, MAX_CENTER_LAT);
    const anchorGeo = this.unproject(oldCenter.x + anchorX - this.width / 2, oldCenter.y + anchorY - this.height / 2, oldZoom);
    const newAnchor = this.project(anchorGeo.lon, anchorGeo.lat, newZoom, MAX_CENTER_LAT);
    const newCenter = this.unproject(newAnchor.x - anchorX + this.width / 2, newAnchor.y - anchorY + this.height / 2, newZoom);
    this.center = newCenter;
    this.zoom = newZoom;
    this.updateReadout(anchorGeo);
    this.requestRender();
  }

  fitFeature(feature) {
    const points = [];
    let previousLon = null;
    let shift = 0;
    for (const line of geometryLines(feature.geometry)) {
      for (const [rawLon, lat] of line) {
        let lon = rawLon + shift;
        if (previousLon !== null) {
          while (lon - previousLon > 180) { shift -= 360; lon -= 360; }
          while (lon - previousLon < -180) { shift += 360; lon += 360; }
        }
        previousLon = lon;
        points.push(this.project(lon, lat, 0));
      }
    }
    if (points.length < 2) return;

    const sampleEvery = Math.max(1, Math.ceil(points.length / FIT_SAMPLE_LIMIT));
    const samples = points.filter((_, index) => index % sampleEvery === 0);
    if (samples.at(-1) !== points.at(-1)) samples.push(points.at(-1));
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const extentX = Math.max(maxX - minX, 0.00001);
    const extentY = Math.max(maxY - minY, 0.00001);
    const polygon = this.getFitPolygon();
    const polygonMinX = Math.min(...polygon.map((point) => point.x));
    const polygonMaxX = Math.max(...polygon.map((point) => point.x));
    const polygonMinY = Math.min(...polygon.map((point) => point.y));
    const polygonMaxY = Math.max(...polygon.map((point) => point.y));
    const polygonCenter = polygonCentroid(polygon);
    const routeCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    const evaluate = (scale, translateX, translateY) => {
      let outside = 0;
      let outsideDistance = 0;
      let clearance = Infinity;
      for (const point of samples) {
        const x = point.x * scale + translateX;
        const y = point.y * scale + translateY;
        const distance = distanceToPolygon(x, y, polygon);
        if (pointInPolygon(x, y, polygon) && distance >= FIT_EDGE_CLEARANCE) {
          clearance = Math.min(clearance, distance);
        } else {
          outside += 1;
          outsideDistance += Math.abs(FIT_EDGE_CLEARANCE - distance);
        }
      }
      const centerDistance = Math.hypot(
        routeCenter.x * scale + translateX - polygonCenter.x,
        routeCenter.y * scale + translateY - polygonCenter.y,
      );
      return {
        feasible: outside === 0,
        score: outside === 0
          ? 1_000_000 + clearance * 100 - centerDistance
          : -(outside * 10_000 + outsideDistance + centerDistance),
        centerDistance,
        translateX,
        translateY,
      };
    };

    const findPlacement = (zoom) => {
      const scale = 2 ** zoom;
      const minTranslateX = polygonMinX - minX * scale;
      const maxTranslateX = polygonMaxX - maxX * scale;
      const minTranslateY = polygonMinY - minY * scale;
      const maxTranslateY = polygonMaxY - maxY * scale;
      if (minTranslateX > maxTranslateX || minTranslateY > maxTranslateY) return null;

      let xLow = minTranslateX;
      let xHigh = maxTranslateX;
      let yLow = minTranslateY;
      let yHigh = maxTranslateY;
      let best = null;
      const divisions = 10;
      for (let refinement = 0; refinement < 4; refinement += 1) {
        const preferredX = clamp(polygonCenter.x - routeCenter.x * scale, xLow, xHigh);
        const preferredY = clamp(polygonCenter.y - routeCenter.y * scale, yLow, yHigh);
        let roundBest = evaluate(scale, preferredX, preferredY);
        const xStep = (xHigh - xLow) / divisions;
        const yStep = (yHigh - yLow) / divisions;
        for (let xIndex = 0; xIndex <= divisions; xIndex += 1) {
          const translateX = xLow + xStep * xIndex;
          for (let yIndex = 0; yIndex <= divisions; yIndex += 1) {
            const candidate = evaluate(scale, translateX, yLow + yStep * yIndex);
            if (!roundBest || candidate.score > roundBest.score) roundBest = candidate;
          }
        }
        best = roundBest;
        if (!best) break;
        xLow = Math.max(minTranslateX, best.translateX - xStep);
        xHigh = Math.min(maxTranslateX, best.translateX + xStep);
        yLow = Math.max(minTranslateY, best.translateY - yStep);
        yHigh = Math.min(maxTranslateY, best.translateY + yStep);
      }
      return best?.feasible ? best : null;
    };

    const polygonWidth = polygonMaxX - polygonMinX;
    const polygonHeight = polygonMaxY - polygonMinY;
    let lowerZoom = this.minZoom;
    let upperZoom = clamp(
      Math.min(Math.log2(polygonWidth / extentX), Math.log2(polygonHeight / extentY)),
      this.minZoom,
      this.maxZoom,
    );
    let placement = findPlacement(lowerZoom);
    for (let iteration = 0; iteration < 16 && upperZoom - lowerZoom > 0.005; iteration += 1) {
      const candidateZoom = (lowerZoom + upperZoom) / 2;
      const candidatePlacement = findPlacement(candidateZoom);
      if (candidatePlacement) {
        lowerZoom = candidateZoom;
        placement = candidatePlacement;
      } else {
        upperZoom = candidateZoom;
      }
    }
    let zoom = Math.max(this.minZoom, lowerZoom - FIT_ZOOM_BREATHING_ROOM);
    placement = findPlacement(zoom) || placement;
    const outsideFullTrack = (candidateZoom, candidatePlacement) => {
      if (!candidatePlacement) return points;
      const scale = 2 ** candidateZoom;
      return points.filter((point) => {
        const x = point.x * scale + candidatePlacement.translateX;
        const y = point.y * scale + candidatePlacement.translateY;
        return !pointInPolygon(x, y, polygon) || distanceToPolygon(x, y, polygon) < FIT_EDGE_CLEARANCE;
      });
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const missed = outsideFullTrack(zoom, placement);
      if (!missed.length) break;
      samples.push(...missed);
      zoom = Math.max(this.minZoom, zoom - 0.04);
      placement = findPlacement(zoom) || placement;
    }
    if (!placement || outsideFullTrack(zoom, placement).length) return;
    const scale = 2 ** zoom;
    const translationFits = (translateX, translateY) => points.every((point) => {
      const x = point.x * scale + translateX;
      const y = point.y * scale + translateY;
      return pointInPolygon(x, y, polygon) && distanceToPolygon(x, y, polygon) >= FIT_EDGE_CLEARANCE;
    });
    const shiftAllowance = (translateX, translateY, directionX, directionY, fits = translationFits) => {
      let low = 0;
      let high = Math.max(this.width, this.height);
      for (let iteration = 0; iteration < 14; iteration += 1) {
        const distance = (low + high) / 2;
        if (fits(translateX + directionX * distance, translateY + directionY * distance)) low = distance;
        else high = distance;
      }
      return low;
    };
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const leftRoom = shiftAllowance(placement.translateX, placement.translateY, -1, 0);
      const rightRoom = shiftAllowance(placement.translateX, placement.translateY, 1, 0);
      placement.translateX += (rightRoom - leftRoom) / 2;
      const upRoom = shiftAllowance(placement.translateX, placement.translateY, 0, -1);
      const downRoom = shiftAllowance(placement.translateX, placement.translateY, 0, 1);
      placement.translateY += (downRoom - upRoom) / 2;
    }
    const roomAt = (translateX, translateY) => ({
      left: shiftAllowance(translateX, translateY, -1, 0),
      right: shiftAllowance(translateX, translateY, 1, 0),
      up: shiftAllowance(translateX, translateY, 0, -1),
      down: shiftAllowance(translateX, translateY, 0, 1),
    });
    const roomImbalance = (room) => Math.max(
      Math.abs(room.left - room.right),
      Math.abs(room.up - room.down),
    );
    // An L-shaped viewport can make horizontal and vertical centering coupled:
    // shifting just past the detail-card corner may open much more vertical room.
    let bestBalance = roomImbalance(roomAt(placement.translateX, placement.translateY));
    if (bestBalance > Math.max(14, Math.min(this.width, this.height) * 0.045)) {
      const originalX = placement.translateX;
      const originalY = placement.translateY;
      for (const dx of [-64, -32, -16, -8, -4, -2, 2, 4, 8, 16, 32, 64]) {
        const translateX = originalX + dx;
        if (!translationFits(translateX, originalY)) continue;
        const up = shiftAllowance(translateX, originalY, 0, -1);
        const down = shiftAllowance(translateX, originalY, 0, 1);
        const translateY = originalY + (down - up) / 2;
        if (!translationFits(translateX, translateY)) continue;
        const imbalance = roomImbalance(roomAt(translateX, translateY));
        if (imbalance < bestBalance) {
          bestBalance = imbalance;
          placement.translateX = translateX;
          placement.translateY = translateY;
        }
      }
    }
    // The safety clearance can change abruptly at a concave card corner. Use
    // the visible polygon to judge balance, but keep the clearance for every
    // candidate placement.
    const insideFits = (translateX, translateY) => points.every((point) =>
      pointInPolygon(point.x * scale + translateX, point.y * scale + translateY, polygon));
    const visualRoomAt = (translateX, translateY) => ({
      left: shiftAllowance(translateX, translateY, -1, 0, insideFits),
      right: shiftAllowance(translateX, translateY, 1, 0, insideFits),
      up: shiftAllowance(translateX, translateY, 0, -1, insideFits),
      down: shiftAllowance(translateX, translateY, 0, 1, insideFits),
    });
    const visualRoom = visualRoomAt(placement.translateX, placement.translateY);
    let visualImbalance = roomImbalance(visualRoom);
    if (visualImbalance > Math.max(14, Math.min(this.width, this.height) * 0.045)) {
      const originalX = placement.translateX;
      const originalY = placement.translateY;
      const targetY = (visualRoom.down - visualRoom.up) / 2;
      for (const dx of [0, -2, 2, -4, 4, -8, 8, -16, 16, -32, 32, -64, 64]) {
        for (const fraction of [1, 0.75, 0.5, 0.25]) {
          const translateX = originalX + dx;
          const translateY = originalY + targetY * fraction;
          if (!translationFits(translateX, translateY)) continue;
          const imbalance = roomImbalance(visualRoomAt(translateX, translateY));
          if (imbalance < visualImbalance) {
            visualImbalance = imbalance;
            placement.translateX = translateX;
            placement.translateY = translateY;
          }
        }
      }
    }
    placement = evaluate(scale, placement.translateX, placement.translateY);
    const center = this.unproject(
      this.width / 2 - placement.translateX,
      this.height / 2 - placement.translateY,
      zoom,
    );
    document.body.dataset.fitMode = "viewport-polygon";
    document.body.dataset.fitRoute = feature.properties.id;
    document.body.dataset.fitZoom = zoom.toFixed(8);
    document.body.dataset.fitCenter = `${center.lon.toFixed(10)},${center.lat.toFixed(10)}`;
    document.body.dataset.fitCenterOffset = placement.centerDistance.toFixed(2);
    document.body.dataset.fitPolygon = polygon.map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`).join(" ");
    this.setView(center.lon, center.lat, zoom);
  }

  select(id, fit = false) {
    this.selected = id;
    if (fit && this.routes) {
      const feature = this.routes.features.find((candidate) => candidate.properties.id === id);
      if (feature) this.fitFeature(feature);
    }
    this.requestRender();
  }

  requestRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.render();
    });
  }

  centerWorld() {
    return this.project(this.center.lon, this.center.lat, this.zoom, MAX_CENTER_LAT);
  }

  unwrapWorldLine(coordinates) {
    const size = this.worldSize();
    const points = [];
    let shift = 0;
    let previousX = null;
    for (const [lon, lat] of coordinates) {
      const raw = this.project(lon, lat);
      let x = raw.x + shift;
      if (previousX !== null) {
        while (x - previousX > size / 2) { shift -= size; x -= size; }
        while (x - previousX < -size / 2) { shift += size; x += size; }
      }
      previousX = x;
      points.push({ x, y: raw.y });
    }
    return points;
  }

  screenCopies(coordinates) {
    const world = this.unwrapWorldLine(coordinates);
    if (!world.length) return [];
    const center = this.centerWorld();
    const size = this.worldSize();
    const meanX = world.reduce((sum, point) => sum + point.x, 0) / world.length;
    const nearestShift = Math.round((center.x - meanX) / size) * size;
    const copies = [];
    for (const extra of [-size, 0, size]) {
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      const screen = world.map((point) => {
        const x = point.x + nearestShift + extra - center.x + this.width / 2;
        const y = point.y - center.y + this.height / 2;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        return { x, y };
      });
      if (maxX >= -40 && minX <= this.width + 40 && maxY >= -40 && minY <= this.height + 40) {
        copies.push(screen);
      }
    }
    return copies;
  }

  traceLine(points, close = false) {
    if (!points.length) return;
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) this.ctx.lineTo(points[i].x, points[i].y);
    if (close) this.ctx.closePath();
  }

  drawGraticule(theme) {
    const ctx = this.ctx;
    const step = this.zoom >= 5 ? 10 : 30;
    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 0.7;
    for (let lon = -180; lon <= 180; lon += step) {
      const coords = [];
      for (let lat = -80; lat <= 80; lat += 2) coords.push([lon, lat]);
      for (const line of this.screenCopies(coords)) {
        ctx.beginPath(); this.traceLine(line); ctx.stroke();
      }
    }
    for (let lat = -60; lat <= 60; lat += step) {
      const coords = [];
      for (let lon = -180; lon <= 180; lon += 3) coords.push([lon, lat]);
      for (const line of this.screenCopies(coords)) {
        ctx.beginPath(); this.traceLine(line); ctx.stroke();
      }
    }
    ctx.restore();
  }

  tileEntry(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let entry = this.tileCache.get(key);
    if (entry) return entry;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    entry = { image, state: "loading" };
    image.addEventListener("load", () => {
      entry.state = "ready";
      this.requestRender();
    });
    image.addEventListener("error", () => {
      entry.state = "error";
      this.requestRender();
    });
    image.src = IMAGERY_TILE_URL
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y);
    this.tileCache.set(key, entry);
    if (this.tileCache.size > 500) {
      const oldest = this.tileCache.keys().next().value;
      this.tileCache.delete(oldest);
    }
    return entry;
  }

  drawSatelliteTiles() {
    const ctx = this.ctx;
    const tileZoom = clamp(Math.round(this.zoom), 0, 18);
    const scale = 2 ** (this.zoom - tileZoom);
    const tilePixels = TILE_SIZE * scale;
    const center = this.project(this.center.lon, this.center.lat, tileZoom, MAX_CENTER_LAT);
    const left = center.x - this.width / (2 * scale);
    const top = center.y - this.height / (2 * scale);
    const right = center.x + this.width / (2 * scale);
    const bottom = center.y + this.height / (2 * scale);
    const startX = Math.floor(left / TILE_SIZE);
    const endX = Math.floor(right / TILE_SIZE);
    const startY = Math.max(0, Math.floor(top / TILE_SIZE));
    const tileCount = 2 ** tileZoom;
    const endY = Math.min(tileCount - 1, Math.floor(bottom / TILE_SIZE));
    let requested = 0;
    let ready = 0;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (let tileY = startY; tileY <= endY; tileY += 1) {
      for (let tileX = startX; tileX <= endX; tileX += 1) {
        requested += 1;
        const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
        const entry = this.tileEntry(tileZoom, wrappedX, tileY);
        if (entry.state !== "ready") continue;
        ready += 1;
        const screenX = (tileX * TILE_SIZE - center.x) * scale + this.width / 2;
        const screenY = (tileY * TILE_SIZE - center.y) * scale + this.height / 2;
        // Slight overlap prevents fractional-zoom seams between JPEG tiles.
        ctx.drawImage(entry.image, Math.floor(screenX), Math.floor(screenY), Math.ceil(tilePixels) + 1, Math.ceil(tilePixels) + 1);
      }
    }
    ctx.restore();
    document.body.dataset.satelliteTiles = `${ready}/${requested}`;
    if (requested > 0 && ready / requested >= 0.75) document.body.dataset.satelliteRendered = "true";
    else delete document.body.dataset.satelliteRendered;
  }

  countryPolygons(feature) {
    const geometry = feature.geometry;
    if (!geometry) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates];
    if (geometry.type === "MultiPolygon") return geometry.coordinates;
    return [];
  }

  drawCountries(theme, fillLand = true) {
    if (!this.countries) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = theme.land;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = this.zoom > 5 ? 0.9 : 0.55;
    for (const feature of this.countries.features) {
      for (const polygon of this.countryPolygons(feature)) {
        const outerCopies = this.screenCopies(polygon[0]);
        for (const outer of outerCopies) {
          const outerMean = outer.reduce((sum, point) => sum + point.x, 0) / outer.length;
          ctx.beginPath();
          this.traceLine(outer, true);
          for (const hole of polygon.slice(1)) {
            const candidates = this.screenCopies(hole);
            if (!candidates.length) continue;
            const match = candidates.reduce((best, line) => {
              const mean = line.reduce((sum, point) => sum + point.x, 0) / line.length;
              return Math.abs(mean - outerMean) < Math.abs(best.mean - outerMean) ? { line, mean } : best;
            }, { line: candidates[0], mean: candidates[0].reduce((sum, point) => sum + point.x, 0) / candidates[0].length });
            this.traceLine(match.line, true);
          }
          if (fillLand) ctx.fill("evenodd");
          ctx.stroke();
        }
      }
    }
    ctx.strokeStyle = theme.coast;
    ctx.lineWidth = this.zoom > 5 ? 1.2 : 0.8;
    for (const feature of this.countries.features) {
      for (const polygon of this.countryPolygons(feature)) {
        for (const outer of this.screenCopies(polygon[0])) {
          ctx.beginPath(); this.traceLine(outer, true); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  drawLabels(theme) {
    if (!this.countries || this.zoom < 1.7 || this.zoom > 6.2) return;
    const ctx = this.ctx;
    const occupied = [];
    ctx.save();
    ctx.fillStyle = theme.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontSize = clamp(7.5 + this.zoom * 0.8, 9, 12);
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    if (theme.imagery) {
      ctx.shadowColor = "rgba(0, 0, 0, .9)";
      ctx.shadowBlur = 3;
    }
    for (const feature of this.countries.features) {
      const p = feature.properties;
      if (!Number.isFinite(p.LABEL_X) || !Number.isFinite(p.LABEL_Y) || Number(p.MIN_LABEL || 0) > this.zoom + 1.4) continue;
      const copies = this.screenCopies([[p.LABEL_X, p.LABEL_Y]]);
      for (const copy of copies) {
        const point = copy[0];
        if (point.x < 12 || point.x > this.width - 12 || point.y < 12 || point.y > this.height - 12) continue;
        const name = (p.NAME_EN || p.NAME || p.ADMIN || "").toUpperCase();
        if (!name) continue;
        const width = ctx.measureText(name).width;
        const box = { x1: point.x - width / 2 - 3, x2: point.x + width / 2 + 3, y1: point.y - fontSize, y2: point.y + fontSize };
        if (occupied.some((other) => !(box.x2 < other.x1 || box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2))) continue;
        occupied.push(box);
        ctx.fillText(name, point.x, point.y);
      }
    }
    ctx.restore();
  }

  drawRoute(feature, selected = false) {
    const p = feature.properties;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = selected ? 6.5 : (p.domain ? 1.9 : 2.35);
    ctx.globalAlpha = selected ? 1 : (p.domain ? 0.42 : 0.82);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (selected) {
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
    }
    const lines = this.displayLines(feature, selected);
    for (const [index, coordinates] of lines.entries()) {
      const trackType = p.line_styles?.[index]?.track_type;
      // All journeys interpolate between anchors. The stroke distinguishes
      // comparatively well-anchored corridors from inferred/low-confidence
      // connections, not interpolated geometry from observed telemetry.
      const inferred = inferredLine(p, trackType);
      ctx.setLineDash(inferred ? (selected ? [11, 7] : [7, 7]) : []);
      for (const line of this.screenCopies(coordinates)) {
        ctx.beginPath();
        this.traceLine(line);
        if (THEMES[this.themeName].imagery) {
          ctx.save();
          ctx.strokeStyle = "rgba(0, 0, 0, .72)";
          ctx.lineWidth = selected ? 10 : 4.8;
          ctx.shadowBlur = 0;
          ctx.stroke();
          ctx.restore();
        }
        ctx.stroke();
      }
    }
    ctx.restore();
    return lines.reduce((total, line) => total + line.length, 0);
  }

  drawAnchors(feature) {
    const ctx = this.ctx;
    const p = feature.properties;
    ctx.save();
    ctx.font = "700 8px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    p.anchors.forEach((anchor, index) => {
      for (const copy of this.screenCopies([[anchor.lon, anchor.lat]])) {
        const point = copy[0];
        ctx.beginPath();
        ctx.arc(point.x, point.y, this.zoom > 5 ? 5.5 : 4.2, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        if (this.zoom > 3.4) {
          ctx.fillStyle = "#11141a";
          ctx.fillText(String(index + 1), point.x, point.y + 0.3);
        }
      }
    });
    ctx.restore();
  }

  render() {
    if (!this.width || !this.height) return;
    const startedAt = performance.now();
    const ctx = this.ctx;
    const theme = THEMES[this.themeName];
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, theme.ocean);
    gradient.addColorStop(1, theme.oceanDeep);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    if (theme.imagery) this.drawSatelliteTiles();
    this.drawGraticule(theme);
    this.drawCountries(theme, !theme.imagery);
    this.drawLabels(theme);
    if (this.routes) {
      const ordinary = this.routes.features.filter((feature) => this.visible.has(feature.properties.id) && feature.properties.id !== this.selected);
      let displayedVertices = 0;
      ordinary.forEach((feature) => { displayedVertices += this.drawRoute(feature); });
      const selected = this.routes.features.find((feature) => feature.properties.id === this.selected && this.visible.has(feature.properties.id));
      if (selected) {
        displayedVertices += this.drawRoute(selected, true);
        this.drawAnchors(selected);
      }
      document.body.dataset.mapRouteCount = String(this.routes.features.length);
      document.body.dataset.mapDisplayVertices = String(displayedVertices);
    }
    document.body.dataset.canvasRendered = "true";
    document.body.dataset.mapRenderMs = (performance.now() - startedAt).toFixed(1);
  }

  updateReadout(point = this.center) {
    this.readout.textContent = `${Math.abs(point.lat).toFixed(2)}°${point.lat >= 0 ? "N" : "S"}, ${Math.abs(point.lon).toFixed(2)}°${point.lon >= 0 ? "E" : "W"} · z${this.zoom.toFixed(2)}`;
  }

  pointSegmentDistance(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(px - a.x, py - a.y);
    const t = clamp(((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  pickRoute(x, y) {
    if (!this.routes) return null;
    let best = { id: null, distance: 9 };
    for (const feature of this.routes.features) {
      const id = feature.properties.id;
      if (!this.visible.has(id)) continue;
      for (const coordinates of this.displayLines(feature, id === this.selected)) {
        for (const line of this.screenCopies(coordinates)) {
          for (let i = 1; i < line.length; i += 1) {
            const distance = this.pointSegmentDistance(x, y, line[i - 1], line[i]);
            if (distance < best.distance) best = { id, distance };
          }
        }
      }
    }
    return best.id;
  }

  bindEvents() {
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      const center = this.centerWorld();
      this.drag = { x: event.clientX, y: event.clientY, centerX: center.x, centerY: center.y, moved: false };
      this.canvas.classList.add("dragging");
    });
    this.canvas.addEventListener("pointermove", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const center = this.centerWorld();
      const point = this.unproject(center.x + event.clientX - rect.left - this.width / 2, center.y + event.clientY - rect.top - this.height / 2);
      this.updateReadout(point);
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
      this.center = this.unproject(this.drag.centerX - dx, this.drag.centerY - dy);
      this.requestRender();
    });
    this.canvas.addEventListener("pointerup", (event) => {
      if (this.drag && !this.drag.moved) {
        const rect = this.canvas.getBoundingClientRect();
        const id = this.pickRoute(event.clientX - rect.left, event.clientY - rect.top);
        if (id) this.onRoutePick(id);
      }
      this.drag = null;
      this.canvas.classList.remove("dragging");
    });
    this.canvas.addEventListener("pointercancel", () => {
      this.drag = null;
      this.canvas.classList.remove("dragging");
    });
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * window.innerHeight
          : event.deltaY;
      const delta = clamp(-pixels * WHEEL_ZOOM_SENSITIVITY, -MAX_WHEEL_ZOOM_STEP, MAX_WHEEL_ZOOM_STEP);
      this.zoomBy(delta, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    this.canvas.addEventListener("dblclick", (event) => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.zoomBy(DOUBLE_CLICK_ZOOM_STEP, event.clientX - rect.left, event.clientY - rect.top);
    });
  }
}

const state = {
  collection: null,
  collections: new Map(),
  collectionRequests: new Map(),
  visibilityByDomain: new Map(),
  countries: null,
  activeDomain: "flights",
  domainRequest: 0,
  visible: new Set(),
  selected: null,
  aircraftImages: {},
  journeyImages: {},
};

const routeList = document.querySelector("#route-list");
const detailCard = document.querySelector("#detail-card");
const collectionStatus = document.querySelector("#collection-status");
const searchInput = document.querySelector("#search");
const mapView = new CanvasSlippyMap(
  document.querySelector("#map-canvas"),
  document.querySelector("#map-readout"),
  document.querySelector("#map-attribution"),
);
mapView.onRoutePick = (id) => selectRoute(id, false);
mapView.getFitPolygon = () => {
  const left = 18;
  const top = 72;
  const right = Math.max(left + 1, mapView.width - 18);
  const bottom = Math.max(top + 1, mapView.height - 28);
  const rectangle = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  if (detailCard.classList.contains("empty")) return rectangle;

  const canvasRect = mapView.canvas.getBoundingClientRect();
  const cardRect = detailCard.getBoundingClientRect();
  if (!cardRect.width || !cardRect.height) return rectangle;
  const cardTop = clamp(cardRect.top - canvasRect.top - 16, top, bottom);
  const cardRight = clamp(cardRect.right - canvasRect.left + 16, left, right);
  if (cardRect.width >= canvasRect.width * 0.84) {
    return [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: cardTop },
      { x: left, y: cardTop },
    ];
  }
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: cardRight, y: bottom },
    { x: cardRight, y: cardTop },
    { x: left, y: cardTop },
  ];
};

function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${Math.round(km).toLocaleString()} km`;
}

function renderList() {
  routeList.innerHTML = state.collection.features.map((feature, index) => {
    const p = feature.properties;
    const visible = state.visible.has(p.id);
    const domainLabel = state.activeDomain === "all" ? `<span>${DOMAINS[p.domain || "flights"].label}</span>` : "";
    return `
      <article class="route-item${visible ? "" : " off"}" data-id="${p.id}" tabindex="0" role="button" aria-label="Inspect ${p.title}">
        <span class="rank">${String(state.activeDomain === "all" ? index + 1 : p.rank).padStart(2, "0")}</span>
        <div class="route-copy">
          <strong>${p.short_title}</strong>
          <div class="route-meta"><i class="color-key" style="background:${p.color};color:${p.color}"></i>${domainLabel}<span>${p.date.slice(0, 4)}</span>${state.activeDomain === "all" ? "" : `<span>${p.era}</span>`}</div>
        </div>
        <input class="route-toggle" style="--route-color:${p.color}" type="checkbox" ${visible ? "checked" : ""} aria-label="Show ${p.short_title}">
      </article>`;
  }).join("");

  routeList.querySelectorAll(".route-item").forEach((item) => {
    const id = item.dataset.id;
    item.addEventListener("click", (event) => {
      if (!event.target.classList.contains("route-toggle")) selectRoute(id, true);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRoute(id, true);
      }
    });
    item.querySelector(".route-toggle").addEventListener("change", (event) => setVisibility(id, event.target.checked));
  });
}

async function renderResearchList(domain) {
  try {
    let candidates = researchCache.get(domain);
    if (!candidates) {
      const response = await fetch(`research/${domain}.md`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const markdown = await response.text();
      candidates = markdown.split("\n").filter((line) => /^\|\s*\d+\s*\|/.test(line)).map((line) => {
        const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
        const source = cells.at(-1).match(/\]\((https?:\/\/[^)]+)\)/);
        return {
          rank: Number(cells[0]),
          title: cells[1].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, ""),
          sourceUrl: source?.[1] || null,
        };
      });
      if (!candidates.length) throw new Error(`No research candidates found for ${domain}`);
      researchCache.set(domain, candidates);
    }
    if (state.activeDomain !== domain) return;
    routeList.replaceChildren();
    const note = document.createElement("p");
    note.className = "research-note";
    note.innerHTML = `<strong>${candidates.length} researched journeys</strong>Candidate routes and sources are ready for review. Map geometry is still being prepared. <a href="research/${domain}.md" target="_blank" rel="noreferrer">Read the full brief ↗</a>`;
    routeList.append(note);
    for (const candidate of candidates) {
      const item = document.createElement(candidate.sourceUrl ? "a" : "div");
      item.className = "research-candidate";
      if (candidate.sourceUrl) {
        item.href = candidate.sourceUrl;
        item.target = "_blank";
        item.rel = "noreferrer";
        item.setAttribute("aria-label", `Research source for ${candidate.title}`);
      }
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = String(candidate.rank).padStart(2, "0");
      const title = document.createElement("strong");
      title.textContent = candidate.title;
      const source = document.createElement("span");
      source.className = "research-source";
      source.textContent = candidate.sourceUrl ? "Source ↗" : "Source pending";
      item.append(rank, title, source);
      routeList.append(item);
    }
  } catch (error) {
    if (state.activeDomain === domain) {
      routeList.innerHTML = `<p class="research-note"><strong>Research list unavailable</strong>Could not load this collection's brief.</p>`;
    }
    console.error(`Could not load ${domain} research:`, error);
  }
}

function setVisibility(id, show) {
  if (show) state.visible.add(id); else state.visible.delete(id);
  if (state.activeDomain === "all") {
    const feature = state.collection.features.find((candidate) => candidate.properties.id === id);
    const domainVisible = state.visibilityByDomain.get(feature.properties.domain || "flights");
    if (show) domainVisible.add(id); else domainVisible.delete(id);
  }
  const item = routeList.querySelector(`[data-id="${id}"]`);
  item?.classList.toggle("off", !show);
  const toggle = item?.querySelector(".route-toggle");
  if (toggle) toggle.checked = show;
  if (!show && state.selected === id) clearSelection();
  mapView.visible = state.visible;
  mapView.requestRender();
}

async function selectRoute(id, fit = false) {
  const feature = state.collection.features.find((candidate) => candidate.properties.id === id);
  if (!feature) return;
  if (!state.visible.has(id)) setVisibility(id, true);
  state.selected = id;
  routeList.querySelectorAll(".route-item").forEach((item) => item.classList.toggle("selected", item.dataset.id === id));
  renderDetail(feature);
  mapView.select(id, fit);
  if (state.activeDomain === "all" && state.collection.metadata?.display_only) {
    try {
      const domain = feature.properties.domain || "flights";
      const complete = await loadDomainCollection(domain);
      if (state.activeDomain !== "all" || state.selected !== id) return;
      const fullFeature = complete.features.find((candidate) => candidate.properties.id === id);
      const index = state.collection.features.findIndex((candidate) => candidate.properties.id === id);
      if (!fullFeature || index < 0) throw new Error(`Full geometry missing for ${id}`);
      state.collection.features[index] = fullFeature;
      mapView.select(id, fit);
      document.body.dataset.fullGeometryRoute = id;
    } catch (error) {
      console.error(`Could not load full geometry for ${id}:`, error);
    }
  }
}

function clearSelection() {
  state.selected = null;
  delete document.body.dataset.fullGeometryRoute;
  mapView.select(null, false);
  routeList.querySelectorAll(".route-item").forEach((item) => item.classList.remove("selected"));
  detailCard.className = "detail-card empty";
  detailCard.innerHTML = `<div class="empty-state"><span class="empty-mark">↗</span><div><strong>Select a journey</strong><p>Click a route in the sidebar or a line on the map.</p></div></div>`;
  delete document.body.dataset.sheetState;
}

function setSheetExpanded(expanded) {
  detailCard.classList.toggle("sheet-expanded", expanded);
  const handle = detailCard.querySelector(".sheet-handle");
  handle?.setAttribute("aria-expanded", String(expanded));
  if (handle) handle.setAttribute("aria-label", expanded ? "Collapse journey details" : "Expand journey details");
  document.body.dataset.sheetState = expanded ? "expanded" : "collapsed";
}

function bindSheetGesture() {
  const handle = detailCard.querySelector(".sheet-handle");
  if (!handle) return;
  let drag = null;
  let suppressClick = false;

  handle.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setSheetExpanded(!detailCard.classList.contains("sheet-expanded"));
  });
  handle.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    handle.setPointerCapture(event.pointerId);
    drag = {
      startY: event.clientY,
      startHeight: detailCard.getBoundingClientRect().height,
      moved: false,
    };
    detailCard.classList.add("sheet-dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const delta = event.clientY - drag.startY;
    if (Math.abs(delta) > 5) drag.moved = true;
    const landscape = matchMedia("(orientation: landscape) and (max-height: 520px)").matches;
    const maximum = landscape ? window.innerHeight - 20 : Math.min(window.innerHeight * 0.72, 610);
    const nextHeight = clamp(drag.startHeight - delta, 82, maximum);
    detailCard.style.height = `${nextHeight}px`;
  });
  const finish = (event) => {
    if (!drag) return;
    const delta = event.clientY - drag.startY;
    const moved = drag.moved;
    suppressClick = moved;
    drag = null;
    detailCard.classList.remove("sheet-dragging");
    detailCard.style.removeProperty("height");
    if (moved && Math.abs(delta) > 18) setSheetExpanded(delta < 0);
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function renderDetail(feature) {
  const p = feature.properties;
  const journeyLabel = DOMAINS[p.domain || "flights"].singular;
  detailCard.className = "detail-card";
  const anchors = p.anchors.map((anchor) => `<li><b>${anchor.name}</b>${anchor.note ? ` — ${anchor.note}` : ""}</li>`).join("");
  const overview = p.overview && p.overview !== p.why_famous && p.overview !== p.route_summary
    ? `<p class="overview">${p.overview}</p>` : "";
  const segmentDetails = p.segments?.length ? `<details class="waypoints"><summary>${p.segments.length} route segment${p.segments.length === 1 ? "" : "s"} and evidence</summary><ol>${p.segments.map((segment) => {
    const lineStyle = inferredLine(p, segment.track_type) ? "inferred" : "anchored";
    return `<li data-line-style="${lineStyle}"><b>${segment.mode}</b> · ${segment.track_type.replaceAll("-", " ")} · ${lineStyle === "inferred" ? "dashed" : "solid"} · <a href="${segment.source_url}" target="_blank" rel="noreferrer">source ↗</a></li>`;
  }).join("")}</ol></details>` : "";
  const additionalSources = Array.isArray(p.additional_sources) && p.additional_sources.length ? `
    <details class="waypoints more-sources"><summary>${p.additional_sources.length} additional source${p.additional_sources.length === 1 ? "" : "s"}</summary><ul>${p.additional_sources.map((source) => `
      <li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a>${source.note ? `<span>${escapeHtml(source.note)}</span>` : ""}</li>`).join("")}</ul></details>` : "";
  const journeyImage = p.image ? `
    <figure class="journey-figure">
      <img src="${escapeHtml(p.image.path)}" alt="${escapeHtml(p.image.alt)}" decoding="async" style="object-position:${escapeHtml(p.image.position || "center")}">
      <figcaption><a class="image-credit" href="${escapeHtml(p.image.source_url)}" target="_blank" rel="noreferrer" title="${escapeHtml(p.image.credit)} · resized and padded to WebP">${escapeHtml(p.image.credit)} · resized for display</a><a href="${escapeHtml(p.image.license_url)}" target="_blank" rel="noreferrer">${escapeHtml(p.image.license)} ↗</a></figcaption>
    </figure>` : "";
  const wikiLabel = `${p.wiki_relation === "related" ? "Related English Wikipedia article" : "English Wikipedia"}: ${p.wiki_title || p.title}`;
  detailCard.innerHTML = `
    <button class="sheet-handle" type="button" aria-expanded="false" aria-label="Expand journey details"><span></span></button>
    <div class="detail-top">
      <div><div class="detail-rank">${journeyLabel} ${String(p.rank).padStart(2, "0")} · ${p.group}</div><h2>${p.title}</h2><div class="detail-date">${p.date} · ${p.era}</div></div>
      <div class="detail-top-actions">
        ${p.wiki_url ? `<a class="wiki-logo-link" href="${escapeHtml(p.wiki_url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(wikiLabel)}" title="${escapeHtml(wikiLabel)}"><img src="assets/wikipedia-w.svg" alt=""></a>` : ""}
        <button class="close-detail" type="button" aria-label="Close details">×</button>
      </div>
    </div>
    <div class="why-famous"><span>Why it was famous</span><p>${p.why_famous}</p></div>
    ${journeyImage}
    <p class="route-summary">${p.route_summary}</p>
    ${overview}
    <div class="metrics">
      <div class="metric"><strong>${formatDistance(p.distance_km)}</strong><span>anchor path</span></div>
      <div class="metric"><strong>${p.vertex_count.toLocaleString()}</strong><span>WKT vertices</span></div>
      <div class="metric"><strong>${p.anchors.length}</strong><span>research anchors</span></div>
    </div>
    <div class="quality"><span>Route evidence</span><strong>${p.quality_label}</strong></div>
    <p class="geometry-note">${p.description}</p>
    <div class="detail-actions">
      <a href="${p.wkt_file}?v=${GEOMETRY_VERSION}" download>Download WKT</a>
      <button type="button" class="copy-wkt">Copy WKT</button>
      <button type="button" class="download-geojson">Download GeoJSON</button>
      <a class="source" href="${p.source_url}" target="_blank" rel="noreferrer">Research source ↗</a>
    </div>
    ${additionalSources}
    ${segmentDetails}
    <details class="waypoints"><summary>${p.anchors.length} researched route anchors</summary><ol>${anchors}</ol></details>`;

  detailCard.querySelector(".close-detail").addEventListener("click", clearSelection);
  setSheetExpanded(false);
  bindSheetGesture();
  detailCard.querySelector(".journey-figure img")?.addEventListener("error", (event) => {
    event.currentTarget.closest("figure").hidden = true;
  });
  detailCard.querySelector(".copy-wkt").addEventListener("click", async (event) => {
    const text = await fetch(`${p.wkt_file}?v=${GEOMETRY_VERSION}`).then((response) => response.text());
    await navigator.clipboard.writeText(text.trim());
    event.currentTarget.textContent = "Copied";
    setTimeout(() => { event.currentTarget.textContent = "Copy WKT"; }, 1300);
  });
  detailCard.querySelector(".download-geojson").addEventListener("click", async () => {
    const domain = p.domain || "flights";
    const complete = await loadDomainCollection(domain);
    const fullFeature = complete.features.find((candidate) => candidate.properties.id === p.id);
    if (!fullFeature) throw new Error(`Full geometry missing for ${p.id}`);
    const blob = new Blob([JSON.stringify(fullFeature, null, 2)], { type: "application/geo+json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${p.id}.geojson`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

async function loadDomainCollection(domain) {
  if (state.collections.has(domain)) return state.collections.get(domain);
  if (state.collectionRequests.has(domain)) return state.collectionRequests.get(domain);
  const request = (async () => {
    const response = await fetch(`data/journeys/${domain}.geojson?v=${GEOMETRY_VERSION}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${domain}`);
    const collection = await response.json();
    if (!collection.features?.length || collection.features.length !== collection.metadata?.route_count) {
      throw new Error(`Invalid mapped journey count in ${domain}`);
    }
    collection.features.forEach((feature) => {
      feature.properties.image = state.journeyImages[feature.properties.id] || null;
    });
    collection.features.sort((a, b) => a.properties.rank - b.properties.rank);
    state.collections.set(domain, collection);
    if (!state.visibilityByDomain.has(domain)) {
      state.visibilityByDomain.set(domain, new Set(collection.features.map((feature) => feature.properties.id)));
    }
    return collection;
  })();
  state.collectionRequests.set(domain, request);
  try { return await request; } finally { state.collectionRequests.delete(domain); }
}

async function setDomain(domain, updateUrl = true) {
  if (!DOMAINS[domain] || !state.collections.has("flights")) return;
  const request = ++state.domainRequest;
  if (state.collection?.features.length) state.visibilityByDomain.set(state.activeDomain, state.visible);
  clearSelection();
  state.activeDomain = domain;
  document.querySelectorAll(".domain-tabs [role=tab]").forEach((tab) => {
    const active = tab.dataset.domain === domain;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  routeList.setAttribute("aria-labelledby", `tab-${domain}`);
  document.querySelector("#collection-heading").textContent = DOMAINS[domain].label;
  document.querySelector(".map-shell").classList.add("research-mode");
  document.querySelector("#collection-hint").textContent = "loading";
  searchInput.disabled = false;
  searchInput.value = "";
  searchInput.placeholder = domain === "all" ? "Search all journeys or categories…" : domain === "flights"
    ? "Search flights, years, eras…"
    : `Search ${DOMAINS[domain].label.toLowerCase()} journeys…`;
  routeList.classList.add("researching");
  routeList.innerHTML = `<p class="research-note"><strong>Loading ${DOMAINS[domain].label}…</strong></p>`;
  collectionStatus.innerHTML = `<strong>${DOMAINS[domain].label}</strong>Loading journeys…`;
  collectionStatus.hidden = false;
  mapView.setData(state.countries, EMPTY_COLLECTION, new Set());
  if (updateUrl) {
    const url = new URL(window.location.href);
    if (domain === "flights") url.searchParams.delete("domain");
    else url.searchParams.set("domain", domain);
    url.searchParams.delete("flight");
    url.searchParams.delete("journey");
    url.searchParams.delete("sheet");
    history.replaceState(null, "", url);
  }
  let collection = state.collections.get(domain);
  if (domain === "all") {
    try {
      const domains = Object.keys(DOMAINS).filter((key) => key !== "all");
      if (!collection) {
        const response = await fetch(ALL_OVERVIEW_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status} loading Show all preview`);
        collection = await response.json();
        if (!collection.features?.length || !collection.metadata?.display_only || collection.features.length !== collection.metadata?.route_count) {
          throw new Error("Invalid display-only Show all collection");
        }
        collection.features.forEach((feature) => {
          feature.properties.image = (feature.properties.domain ? state.journeyImages : state.aircraftImages)[feature.properties.id] || null;
        });
        state.collections.set("all", collection);
      }
      for (const key of domains) {
        if (!state.visibilityByDomain.has(key)) {
          state.visibilityByDomain.set(key, new Set(collection.features.filter((feature) => (feature.properties.domain || "flights") === key).map((feature) => feature.properties.id)));
        }
      }
      state.visibilityByDomain.set("all", new Set(domains.flatMap((key) => [...state.visibilityByDomain.get(key)])));
    } catch (error) {
      console.error("Could not load all journeys:", error);
    }
  } else if (!collection && domain !== "flights") {
    try {
      collection = await loadDomainCollection(domain);
    } catch (error) {
      console.error(`Could not load ${domain} route geometry:`, error);
    }
  }
  if (request !== state.domainRequest) return;
  if (collection) {
    state.collection = collection;
    state.visible = state.visibilityByDomain.get(domain) || new Set(collection.features.map((feature) => feature.properties.id));
    state.visibilityByDomain.set(domain, state.visible);
    routeList.classList.remove("researching");
    renderList();
    document.querySelector("#collection-hint").textContent = domain === "all" ? `${collection.features.length} routes · click to inspect` : "click to inspect";
    document.querySelector(".map-shell").classList.remove("research-mode");
    collectionStatus.hidden = true;
    mapView.setData(state.countries, collection, state.visible, domain === "all");
    mapView.setView(5, 23, 2);
  } else {
    state.collection = EMPTY_COLLECTION;
    state.visible = new Set();
    document.querySelector("#collection-hint").textContent = domain === "all" ? "unavailable" : "research candidates";
    routeList.innerHTML = `<p class="research-note"><strong>Loading ${DOMAINS[domain].label} research…</strong></p>`;
    collectionStatus.innerHTML = domain === "all"
      ? `<strong>All journeys unavailable</strong>One or more collections could not be loaded. Choose a category to continue.`
      : `<strong>${DOMAINS[domain].label}</strong>Journeys researched. Map routes will appear as their geometry is verified.`;
    mapView.setView(5, 23, 2);
    if (domain !== "all") void renderResearchList(domain);
  }
}

const domainTabs = [...document.querySelectorAll(".domain-tabs [role=tab]")];
domainTabs.forEach((tab, index) => {
  const activate = (domain) => {
    if (domain === "space") {
      window.location.assign(new URL("globe.html?domain=space", window.location.href));
      return;
    }
    void setDomain(domain);
  };
  tab.addEventListener("click", () => { activate(tab.dataset.domain); });
  tab.addEventListener("keydown", (event) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % domainTabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + domainTabs.length) % domainTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = domainTabs.length - 1;
    else return;
    event.preventDefault();
    domainTabs[next].focus();
    domainTabs[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    activate(domainTabs[next].dataset.domain);
  });
});

searchInput.addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  if (!state.collection.features.length) {
    routeList.querySelectorAll(".research-candidate").forEach((item) => {
      item.classList.toggle("hidden-filter", query && !item.textContent.toLowerCase().includes(query));
    });
    return;
  }
  routeList.querySelectorAll(".route-item").forEach((item) => {
    const p = state.collection.features.find((feature) => feature.properties.id === item.dataset.id).properties;
    const haystack = `${p.title} ${p.date} ${p.era} ${p.route_summary} ${DOMAINS[p.domain || "flights"].label}`.toLowerCase();
    item.classList.toggle("hidden-filter", query && !haystack.includes(query));
  });
});

document.querySelector("#basemap").addEventListener("change", (event) => mapView.setTheme(event.target.value));
document.querySelector("#zoom-in").addEventListener("click", () => mapView.zoomBy(BUTTON_ZOOM_STEP));
document.querySelector("#zoom-out").addEventListener("click", () => mapView.zoomBy(-BUTTON_ZOOM_STEP));
document.querySelector("#reset-view").addEventListener("click", () => mapView.setView(5, 23, 2));
document.querySelector("#open-globe").addEventListener("click", (event) => {
  event.preventDefault();
  const url = new URL("globe.html", window.location.href);
  url.searchParams.set("domain", state.activeDomain);
  if (state.selected) url.searchParams.set("journey", state.selected);
  window.location.assign(url);
});

const siteInfo = document.querySelector("#site-info");
document.querySelector("#site-info-open").addEventListener("click", () => siteInfo.showModal());
document.querySelector("#site-info-close").addEventListener("click", () => siteInfo.close());
siteInfo.addEventListener("click", (event) => {
  if (event.target === siteInfo) siteInfo.close();
});

async function init() {
  try {
    const [routesResponse, basemapResponse, imagesResponse, journeyImagesResponse] = await Promise.all([
      fetch(ROUTES_URL),
      fetch(BASEMAP_URL),
      fetch(AIRCRAFT_IMAGES_URL),
      fetch(JOURNEY_IMAGES_URL),
    ]);
    if (!routesResponse.ok || !basemapResponse.ok || !imagesResponse.ok || !journeyImagesResponse.ok) {
      throw new Error(`route HTTP ${routesResponse.status}; basemap HTTP ${basemapResponse.status}; aircraft images HTTP ${imagesResponse.status}; journey images HTTP ${journeyImagesResponse.status}`);
    }
    state.collection = await routesResponse.json();
    state.countries = await basemapResponse.json();
    const aircraftImages = await imagesResponse.json();
    state.aircraftImages = aircraftImages;
    state.journeyImages = await journeyImagesResponse.json();
    state.collection.features.forEach((feature) => {
      feature.properties.image = aircraftImages[feature.properties.id] || null;
    });
    state.collection.features.sort((a, b) => a.properties.rank - b.properties.rank);
    state.collection.features.forEach((feature) => state.visible.add(feature.properties.id));
    state.collections.set("flights", state.collection);
    state.visibilityByDomain.set("flights", state.visible);
    mapView.setData(state.countries, state.collection, state.visible);
    const requestedBasemap = new URLSearchParams(window.location.search).get("basemap");
    const basemapSelect = document.querySelector("#basemap");
    if (requestedBasemap && THEMES[requestedBasemap]) basemapSelect.value = requestedBasemap;
    mapView.setTheme(basemapSelect.value);
    document.querySelector("#loading").classList.add("done");
    const query = new URLSearchParams(window.location.search);
    const requestedDomain = query.get("domain");
    await setDomain(DOMAINS[requestedDomain] ? requestedDomain : "flights", false);
    const requestedJourney = query.get("journey") || query.get("flight");
    if (requestedJourney && state.collection.features.length) await selectRoute(requestedJourney, true);
    if (requestedJourney && state.collection.features.length && query.get("sheet") === "expanded") {
      setSheetExpanded(true);
    }
    // Paint once synchronously after data and query-state are installed. This
    // avoids a blank first frame in background tabs and headless browsers that
    // may throttle requestAnimationFrame before the first screenshot.
    mapView.renderPending = false;
    mapView.render();
    document.body.dataset.atlasReady = "true";
    window.__atlasReady = true;
  } catch (error) {
    const loading = document.querySelector("#loading");
    loading.innerHTML = `<strong>Could not load route data:</strong> ${error.message}`;
    console.error(error);
  }
}

await init();
