const ROUTES_URL = "data/routes.geojson?v=smooth-routes-1";
const BASEMAP_URL = "data/ne_110m_admin_0_countries.geojson";
const AIRCRAFT_IMAGES_URL = "data/aircraft-images.json";
const IMAGERY_TILE_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_SIZE = 256;
const MAX_LAT = 85.05112878;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const MAX_WHEEL_ZOOM_STEP = 0.2;
const BUTTON_ZOOM_STEP = 0.25;
const DOUBLE_CLICK_ZOOM_STEP = 0.5;
const FIT_SAMPLE_LIMIT = 700;
const FIT_ZOOM_BREATHING_ROOM = 0.18;
const FIT_EDGE_CLEARANCE = 4;

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

function normalizeLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function geometryLines(geometry) {
  return geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
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

  project(lon, lat, zoom = this.zoom) {
    const size = this.worldSize(zoom);
    const safeLat = clamp(lat, -MAX_LAT, MAX_LAT);
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
    return { lon: normalizeLon(lon), lat: clamp(lat, -MAX_LAT, MAX_LAT) };
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

  setData(countries, routes, visible) {
    this.countries = countries;
    this.routes = routes;
    this.visible = visible;
    this.requestRender();
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
    this.center = { lon: normalizeLon(lon), lat: clamp(lat, -MAX_LAT, MAX_LAT) };
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.updateReadout();
    this.requestRender();
  }

  zoomBy(delta, anchorX = this.width / 2, anchorY = this.height / 2) {
    const oldZoom = this.zoom;
    const newZoom = clamp(oldZoom + delta, this.minZoom, this.maxZoom);
    if (Math.abs(newZoom - oldZoom) < 0.001) return;
    const oldCenter = this.project(this.center.lon, this.center.lat, oldZoom);
    const anchorGeo = this.unproject(oldCenter.x + anchorX - this.width / 2, oldCenter.y + anchorY - this.height / 2, oldZoom);
    const newAnchor = this.project(anchorGeo.lon, anchorGeo.lat, newZoom);
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
    const shiftAllowance = (translateX, translateY, directionX, directionY) => {
      let low = 0;
      let high = Math.max(this.width, this.height);
      for (let iteration = 0; iteration < 14; iteration += 1) {
        const distance = (low + high) / 2;
        if (translationFits(translateX + directionX * distance, translateY + directionY * distance)) low = distance;
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
    placement = evaluate(scale, placement.translateX, placement.translateY);
    const center = this.unproject(
      this.width / 2 - placement.translateX,
      this.height / 2 - placement.translateY,
      zoom,
    );
    document.body.dataset.fitMode = "viewport-polygon";
    document.body.dataset.fitRoute = feature.properties.id;
    document.body.dataset.fitZoom = zoom.toFixed(3);
    document.body.dataset.fitCenter = `${center.lon.toFixed(7)},${center.lat.toFixed(7)}`;
    document.body.dataset.fitCenterOffset = placement.centerDistance.toFixed(2);
    document.body.dataset.fitPolygon = polygon.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
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
    return this.project(this.center.lon, this.center.lat);
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
      const screen = world.map((point) => ({
        x: point.x + nearestShift + extra - center.x + this.width / 2,
        y: point.y - center.y + this.height / 2,
      }));
      const xs = screen.map((point) => point.x);
      const ys = screen.map((point) => point.y);
      if (Math.max(...xs) >= -40 && Math.min(...xs) <= this.width + 40 && Math.max(...ys) >= -40 && Math.min(...ys) <= this.height + 40) {
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
    const center = this.project(this.center.lon, this.center.lat, tileZoom);
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
    ctx.lineWidth = selected ? 5 : 2.35;
    ctx.globalAlpha = selected ? 1 : 0.82;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (p.quality.includes("illustrative")) ctx.setLineDash(selected ? [11, 7] : [7, 7]);
    if (selected) {
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
    }
    for (const coordinates of geometryLines(feature.geometry)) {
      for (const line of this.screenCopies(coordinates)) {
        ctx.beginPath();
        this.traceLine(line);
        if (THEMES[this.themeName].imagery) {
          ctx.save();
          ctx.strokeStyle = "rgba(0, 0, 0, .72)";
          ctx.lineWidth = selected ? 8.5 : 4.8;
          ctx.shadowBlur = 0;
          ctx.stroke();
          ctx.restore();
        }
        ctx.stroke();
      }
    }
    ctx.restore();
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
      ordinary.forEach((feature) => this.drawRoute(feature));
      const selected = this.routes.features.find((feature) => feature.properties.id === this.selected && this.visible.has(feature.properties.id));
      if (selected) {
        this.drawRoute(selected, true);
        this.drawAnchors(selected);
      }
    }
    document.body.dataset.canvasRendered = "true";
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
      for (const coordinates of geometryLines(feature.geometry)) {
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
  visible: new Set(),
  selected: null,
};

const routeList = document.querySelector("#route-list");
const detailCard = document.querySelector("#detail-card");
const visibleCount = document.querySelector("#visible-count");
const vertexCount = document.querySelector("#vertex-count");
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
  routeList.innerHTML = state.collection.features.map((feature) => {
    const p = feature.properties;
    return `
      <article class="route-item" data-id="${p.id}" tabindex="0" role="button" aria-label="Inspect ${p.title}">
        <span class="rank">${String(p.rank).padStart(2, "0")}</span>
        <div class="route-copy">
          <strong>${p.short_title}</strong>
          <div class="route-meta"><i class="color-key" style="background:${p.color};color:${p.color}"></i><span>${p.date.slice(0, 4)}</span><span>${p.era}</span></div>
        </div>
        <input class="route-toggle" style="--route-color:${p.color}" type="checkbox" checked aria-label="Show ${p.short_title}">
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

function setVisibility(id, show) {
  if (show) state.visible.add(id); else state.visible.delete(id);
  const item = routeList.querySelector(`[data-id="${id}"]`);
  item?.classList.toggle("off", !show);
  const toggle = item?.querySelector(".route-toggle");
  if (toggle) toggle.checked = show;
  if (!show && state.selected === id) clearSelection();
  visibleCount.textContent = state.visible.size;
  mapView.visible = state.visible;
  mapView.requestRender();
}

function bulkVisibility(predicate) {
  for (const feature of state.collection.features) setVisibility(feature.properties.id, predicate(feature.properties));
}

function selectRoute(id, fit = false) {
  const feature = state.collection.features.find((candidate) => candidate.properties.id === id);
  if (!feature) return;
  if (!state.visible.has(id)) setVisibility(id, true);
  state.selected = id;
  routeList.querySelectorAll(".route-item").forEach((item) => item.classList.toggle("selected", item.dataset.id === id));
  renderDetail(feature);
  mapView.select(id, fit);
}

function clearSelection() {
  state.selected = null;
  mapView.select(null, false);
  routeList.querySelectorAll(".route-item").forEach((item) => item.classList.remove("selected"));
  detailCard.className = "detail-card empty";
  detailCard.innerHTML = `<div class="empty-state"><span class="empty-mark">↗</span><div><strong>Select a flight</strong><p>Click a route in the sidebar or a line on the map.</p></div></div>`;
  delete document.body.dataset.sheetState;
}

function setSheetExpanded(expanded) {
  detailCard.classList.toggle("sheet-expanded", expanded);
  const handle = detailCard.querySelector(".sheet-handle");
  handle?.setAttribute("aria-expanded", String(expanded));
  if (handle) handle.setAttribute("aria-label", expanded ? "Collapse flight details" : "Expand flight details");
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
  detailCard.className = "detail-card";
  const anchors = p.anchors.map((anchor) => `<li><b>${anchor.name}</b>${anchor.note ? ` — ${anchor.note}` : ""}</li>`).join("");
  const aircraftImage = p.image ? `
    <figure class="aircraft-figure">
      <img src="${p.image.path}" alt="${p.image.alt}" decoding="async" style="object-position:${p.image.position || "center"}">
      <figcaption><a class="image-credit" href="${p.image.source_url}" target="_blank" rel="noreferrer">${p.image.credit}</a><a href="${p.image.license_url}" target="_blank" rel="noreferrer">${p.image.license} ↗</a></figcaption>
    </figure>` : "";
  detailCard.innerHTML = `
    <button class="sheet-handle" type="button" aria-expanded="false" aria-label="Expand flight details"><span></span></button>
    <div class="detail-top">
      <div><div class="detail-rank">Flight ${String(p.rank).padStart(2, "0")} · ${p.group}</div><h2>${p.title}</h2><div class="detail-date">${p.date} · ${p.era}</div></div>
      <button class="close-detail" type="button" aria-label="Close details">×</button>
    </div>
    <div class="why-famous"><span>Why it was famous</span><p>${p.why_famous}</p></div>
    ${aircraftImage}
    <p class="route-summary">${p.route_summary}</p>
    <p class="overview">${p.overview}</p>
    <div class="metrics">
      <div class="metric"><strong>${formatDistance(p.distance_km)}</strong><span>anchor path</span></div>
      <div class="metric"><strong>${p.vertex_count.toLocaleString()}</strong><span>WKT vertices</span></div>
      <div class="metric"><strong>${p.anchors.length}</strong><span>research anchors</span></div>
    </div>
    <div class="quality"><span>Route evidence</span><strong>${p.quality_label}</strong></div>
    <p class="geometry-note">${p.description}</p>
    <div class="detail-actions">
      <a href="${p.wkt_file}?v=smooth-routes-1" download>Download WKT</a>
      <button type="button" class="copy-wkt">Copy WKT</button>
      <button type="button" class="download-geojson">Download GeoJSON</button>
      <a class="source" href="${p.source_url}" target="_blank" rel="noreferrer">Research source ↗</a>
      <a class="wiki" href="${p.wiki_url}" target="_blank" rel="noreferrer" title="${p.wiki_title}">Wikipedia ↗</a>
    </div>
    <details class="waypoints"><summary>${p.anchors.length} researched route anchors</summary><ol>${anchors}</ol></details>`;

  detailCard.querySelector(".close-detail").addEventListener("click", clearSelection);
  setSheetExpanded(false);
  bindSheetGesture();
  detailCard.querySelector(".aircraft-figure img")?.addEventListener("error", (event) => {
    event.currentTarget.closest("figure").hidden = true;
  });
  detailCard.querySelector(".copy-wkt").addEventListener("click", async (event) => {
    const text = await fetch(`${p.wkt_file}?v=smooth-routes-1`).then((response) => response.text());
    await navigator.clipboard.writeText(text.trim());
    event.currentTarget.textContent = "Copied";
    setTimeout(() => { event.currentTarget.textContent = "Copy WKT"; }, 1300);
  });
  detailCard.querySelector(".download-geojson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(feature, null, 2)], { type: "application/geo+json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${p.id}.geojson`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action === "all") bulkVisibility(() => true);
    if (action === "top") bulkVisibility((p) => p.rank <= 10);
    if (action === "middle") bulkVisibility((p) => p.rank >= 11 && p.rank <= 20);
    if (action === "new") bulkVisibility((p) => p.rank >= 21);
  });
});

document.querySelector("#search").addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  routeList.querySelectorAll(".route-item").forEach((item) => {
    const p = state.collection.features.find((feature) => feature.properties.id === item.dataset.id).properties;
    const haystack = `${p.title} ${p.date} ${p.era} ${p.route_summary}`.toLowerCase();
    item.classList.toggle("hidden-filter", query && !haystack.includes(query));
  });
});

document.querySelector("#basemap").addEventListener("change", (event) => mapView.setTheme(event.target.value));
document.querySelector("#zoom-in").addEventListener("click", () => mapView.zoomBy(BUTTON_ZOOM_STEP));
document.querySelector("#zoom-out").addEventListener("click", () => mapView.zoomBy(-BUTTON_ZOOM_STEP));
document.querySelector("#reset-view").addEventListener("click", () => mapView.setView(5, 23, 2));

document.querySelector("#method-toggle").addEventListener("click", (event) => {
  const body = document.querySelector("#method-body");
  body.hidden = !body.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!body.hidden));
  event.currentTarget.querySelector("span").textContent = body.hidden ? "＋" : "−";
});

async function init() {
  try {
    const [routesResponse, basemapResponse, imagesResponse] = await Promise.all([
      fetch(ROUTES_URL),
      fetch(BASEMAP_URL),
      fetch(AIRCRAFT_IMAGES_URL),
    ]);
    if (!routesResponse.ok || !basemapResponse.ok || !imagesResponse.ok) {
      throw new Error(`route HTTP ${routesResponse.status}; basemap HTTP ${basemapResponse.status}; images HTTP ${imagesResponse.status}`);
    }
    state.collection = await routesResponse.json();
    const countries = await basemapResponse.json();
    const aircraftImages = await imagesResponse.json();
    state.collection.features.forEach((feature) => {
      feature.properties.image = aircraftImages[feature.properties.id] || null;
    });
    state.collection.features.sort((a, b) => a.properties.rank - b.properties.rank);
    state.collection.features.forEach((feature) => state.visible.add(feature.properties.id));
    renderList();
    vertexCount.textContent = state.collection.features.reduce((sum, feature) => sum + feature.properties.vertex_count, 0).toLocaleString();
    mapView.setData(countries, state.collection, state.visible);
    const requestedBasemap = new URLSearchParams(window.location.search).get("basemap");
    const basemapSelect = document.querySelector("#basemap");
    if (requestedBasemap && THEMES[requestedBasemap]) basemapSelect.value = requestedBasemap;
    mapView.setTheme(basemapSelect.value);
    document.querySelector("#loading").classList.add("done");
    const requestedFlight = new URLSearchParams(window.location.search).get("flight");
    if (requestedFlight) selectRoute(requestedFlight, true);
    if (requestedFlight && new URLSearchParams(window.location.search).get("sheet") === "expanded") {
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
