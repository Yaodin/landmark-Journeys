/* Local Cesium experiment. The existing atlas and its geometry build pipeline are unchanged. */
const GLOBE_DOMAINS = [
  ["flights", "Flights"],
  ["sailing", "Sailing"],
  ["rail", "Rail"],
  ["road-races", "Road / Races"],
  ["overland", "Overland"],
  ["ocean-liners", "Ocean Liners"],
  ["river", "River"],
  ["human-powered", "Human Powered"],
  ["space", "Space"],
  ["all", "Show all"],
];
const GEOMETRY_VERSION = "alignment-20260924-1";
const WHOLE_EARTH_DESTINATION = [-24, 31, 19_000_000];
// A sub-pixel lift at global scale avoids ground-polyline z-fighting. With
// 0.5-degree tessellation, segment sagitta stays below this clearance.
const SURFACE_OFFSET_METERS = 150;
const FLIGHT_DISPLAY_FLOOR_METERS = 5;
const state = {
  viewer: null,
  overview: [],
  domain: "flights",
  query: "",
  selectedId: null,
  previews: [],
  selection: [],
  fullCollections: new Map(),
  selectionTicket: 0,
  images: {},
  visible: new Set(),
  spacePaths: new Map(),
  spaceDisplayPaths: new Map(),
  spaceDisplayPositions: new Map(),
  spacePreviewLoad: null,
  selectedSpacePositions: [],
  spaceMarkers: [],
};
const $ = (selector) => document.querySelector(selector);
const byId = new Map();

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function status(message) {
  $("#status").textContent = message;
}
function domainOf(feature) {
  return feature.properties.domain || "flights";
}
function isSpace(feature) {
  return domainOf(feature) === "space";
}
function domainLabel(key) {
  return GLOBE_DOMAINS.find(([id]) => id === key)?.[1] || key;
}
function linesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function filteredFeatures() {
  const text = state.query.trim().toLocaleLowerCase();
  return state.overview.filter((feature) => {
    if (state.domain !== "all" && domainOf(feature) !== state.domain)
      return false;
    if (!text) return true;
    const p = feature.properties;
    return [
      p.title,
      p.short_title,
      p.date,
      p.route_summary,
      p.vehicle,
      domainLabel(domainOf(feature)),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(text);
  });
}

function renderCategories() {
  $("#categories").innerHTML = GLOBE_DOMAINS.map(
    ([id, label]) =>
      `<button type="button" role="tab" id="tab-${id}" data-domain="${id}" aria-selected="${id === state.domain}" tabindex="${id === state.domain ? "0" : "-1"}">${label}</button>`,
  ).join("");
  $("#journey-list").setAttribute("aria-labelledby", `tab-${state.domain}`);
}

function renderList() {
  const features = filteredFeatures();
  $("#list-heading").textContent = domainLabel(state.domain);
  $("#route-count").textContent = state.query ? `${features.length} matches` : "click to inspect";
  $("#journey-list").innerHTML = features.length
    ? features.map(({ properties: p }, index) => {
      const visible = state.visible.has(p.id);
      const domain = state.domain === "all" ? `<span>${escapeHtml(domainLabel(p.domain || "flights"))}</span>` : "";
      return `<article class="route-item${state.selectedId === p.id ? " selected" : ""}${visible ? "" : " off"}" data-id="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Inspect ${escapeHtml(p.title)}">
        <span class="rank">${String(state.domain === "all" ? index + 1 : p.rank).padStart(2, "0")}</span>
        <div class="route-copy"><strong>${escapeHtml(p.short_title || p.title)}</strong><div class="route-meta"><i class="color-key" style="background:${escapeHtml(p.color)};color:${escapeHtml(p.color)}"></i>${domain}<span>${escapeHtml(p.date.slice(0, 4))}</span>${state.domain === "all" ? "" : `<span>${escapeHtml(p.era)}</span>`}</div></div>
        <input class="route-toggle" style="--route-color:${escapeHtml(p.color)}" type="checkbox" ${visible ? "checked" : ""} aria-label="Show ${escapeHtml(p.short_title || p.title)}">
      </article>`;
    }).join("")
    : `<p class="empty">No routes match that search.</p>`;
}

function cartesianLine(coordinates) {
  const positions = [];
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const [lon, lat, estimatedHeight] = coordinate;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const height = Number.isFinite(estimatedHeight)
      ? Math.max(FLIGHT_DISPLAY_FLOOR_METERS, estimatedHeight)
      : SURFACE_OFFSET_METERS;
    positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, height));
  }
  return positions;
}

function drawFeature(feature, selected = false) {
  const p = feature.properties;
  const color =
    Cesium.Color.fromCssColorString(p.color || "#f5cf76") || Cesium.Color.GOLD;
  const entities = [];
  for (const [index, coordinates] of linesOf(feature.geometry).entries()) {
    const positions = cartesianLine(coordinates);
    if (positions.length < 2) continue;
    entities.push(
      state.viewer.entities.add({
        id: `${selected ? "selected" : "preview"}:${p.id}:${index}`,
        properties: { journeyId: p.id },
        polyline: {
          positions,
          width: selected ? 7 : state.domain === "all" ? 1.7 : 2.3,
          material: selected
            ? new Cesium.PolylineOutlineMaterialProperty({ color, outlineColor: Cesium.Color.BLACK.withAlpha(0.8), outlineWidth: 1.25 })
            : color.withAlpha(state.selectedId ? (state.domain === "all" ? 0.14 : 0.22) : state.domain === "all" ? 0.66 : 0.87),
          arcType: Cesium.ArcType.GEODESIC,
          granularity: Cesium.Math.toRadians(0.5),
        },
      }),
    );
  }
  return entities;
}

function clearEntities(items) {
  for (const entity of items) state.viewer.entities.remove(entity);
  items.length = 0;
}

function drawPreviews() {
  clearEntities(state.previews);
  // Exclude the selected route before its full-resolution entity is added.
  // Keeping that entity last also makes its outline visible above previews.
  const fullRouteId = state.selectedId;
  const features = filteredFeatures().filter((feature) =>
    state.visible.has(feature.properties.id) && feature.properties.id !== fullRouteId,
  );
  for (const feature of features) {
    if (isSpace(feature)) {
      if (state.domain !== "all") continue;
      const positions = state.spaceDisplayPositions.get(feature.properties.id);
      if (positions) state.previews.push(drawSpacePreview(feature, positions));
    } else state.previews.push(...drawFeature(feature));
  }
  // Show-all space previews may arrive asynchronously after selection. Keep
  // the highlighted entity last even when this function redraws them later.
  for (const entity of state.selection) {
    state.viewer.entities.remove(entity);
    state.viewer.entities.add(entity);
  }
  state.viewer.scene.requestRender();
  const displayedRoutes = new Set(state.previews.map((entity) => entity.properties.journeyId.getValue())).size + (fullRouteId ? 1 : 0);
  const hint = state.domain === "space" ? "select a mission to show its 3D trajectory" : fullRouteId ? "selected journey highlighted" : "3D routes ready";
  status(
    state.domain === "all"
      ? `${displayedRoutes} routes · ${hint}`
      : `${displayedRoutes} ${domainLabel(state.domain).toLowerCase()} routes · ${hint}`,
  );
}

function clearSelection() {
  ++state.selectionTicket;
  state.selectedId = null;
  clearEntities(state.selection);
  clearEntities(state.spaceMarkers);
  state.selectedSpacePositions = [];
  $("#detail").className = "detail-card empty";
  $("#detail").innerHTML = `<div class="empty-state"><span class="empty-mark">↗</span><div><strong>Select a journey</strong><p>Click a route in the sidebar or a line on the globe.</p></div></div>`;
  delete document.body.dataset.sheetState;
  $("#fit-button").disabled = true;
  $("#fit-button").hidden = false;
  renderList();
  drawPreviews();
}

function formatDistance(km) {
  if (!Number.isFinite(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${Math.round(km).toLocaleString()} km`;
}

function setSheetExpanded(expanded) {
  const card = $("#detail");
  card.classList.toggle("sheet-expanded", expanded);
  const handle = card.querySelector(".sheet-handle");
  handle?.setAttribute("aria-expanded", String(expanded));
  handle?.setAttribute("aria-label", expanded ? "Collapse journey details" : "Expand journey details");
  document.body.dataset.sheetState = expanded ? "expanded" : "collapsed";
}

function bindSheetGesture() {
  const card = $("#detail");
  const handle = card.querySelector(".sheet-handle");
  if (!handle) return;
  let drag = null;
  let suppressClick = false;
  handle.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    setSheetExpanded(!card.classList.contains("sheet-expanded"));
  });
  handle.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    handle.setPointerCapture(event.pointerId);
    drag = { startY: event.clientY, startHeight: card.getBoundingClientRect().height, moved: false };
    card.classList.add("sheet-dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const delta = event.clientY - drag.startY;
    if (Math.abs(delta) > 5) drag.moved = true;
    const landscape = matchMedia("(orientation: landscape) and (max-height: 520px)").matches;
    const maximum = landscape ? window.innerHeight - 20 : Math.min(window.innerHeight * 0.72, 610);
    card.style.height = `${Math.min(maximum, Math.max(68, drag.startHeight - delta))}px`;
  });
  const finish = (event) => {
    if (!drag) return;
    const delta = event.clientY - drag.startY;
    const moved = drag.moved;
    suppressClick = moved;
    drag = null;
    card.classList.remove("sheet-dragging");
    card.style.removeProperty("height");
    if (moved && Math.abs(delta) > 18) setSheetExpanded(delta < 0);
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function renderSpaceDetail(feature) {
  const p = feature.properties;
  const sourceLinks = p.sources.map((url, index) =>
    `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Source ${index + 1} ↗</a></li>`,
  ).join("");
  const card = $("#detail");
  card.className = "detail-card";
  card.innerHTML = `
    <button class="sheet-handle" type="button" aria-expanded="false" aria-label="Expand journey details"><span></span></button>
    <div class="detail-top"><div><div class="detail-rank">Space mission ${String(p.rank).padStart(2, "0")} · ${escapeHtml(p.confidence)} confidence</div><h2>${escapeHtml(p.title)}</h2><div class="detail-date">${escapeHtml(p.date)} · ${escapeHtml(p.vehicle)}</div></div><div class="detail-top-actions"><a class="wiki-logo-link" href="${escapeHtml(p.wiki_url)}" target="_blank" rel="noopener noreferrer" aria-label="English Wikipedia: ${escapeHtml(p.title)}" title="English Wikipedia: ${escapeHtml(p.title)}"><img src="assets/wikipedia-w.svg" alt=""></a><button class="close-detail" type="button" aria-label="Close details">×</button></div></div>
    <div class="why-famous"><span>Why it was famous</span><p>${escapeHtml(p.why_famous)}</p></div>
    <p class="overview">${escapeHtml(p.description)}</p>
    <div class="metrics"><div class="metric"><strong>${Number(p.point_count).toLocaleString()}</strong><span>trajectory samples</span></div><div class="metric"><strong>${formatDistance(p.max_earth_center_distance_km)}</strong><span>max Earth distance</span></div><div class="metric"><strong>${escapeHtml(p.confidence)}</strong><span>evidence class</span></div></div>
    <div class="quality"><span>Trajectory method</span><strong>${escapeHtml(p.trajectory_method)}</strong></div>
    <p class="geometry-note">${p.confidence === "A" ? "Sampled spacecraft ephemeris, subject to the linked JPL solution's limitations." : "Educational mission-event reconstruction, not recorded flight telemetry."} The static globe fixes Earth at the mission's start epoch, with approximate sidereal orientation where precise historical transform data is unavailable. Sparse connectors are curved around Earth for display. Distances beyond 500,000 km are compressed; the downloadable data preserves original coordinates. Not for navigation.</p>
    <div class="detail-actions"><a href="${escapeHtml(p.path)}" download>Download 3D trajectory JSON</a><button type="button" class="fit-globe">Whole Earth view</button></div>
    <details class="waypoints more-sources"><summary>${p.sources.length} research sources</summary><ul>${sourceLinks}</ul></details>`;
  $("#fit-button").disabled = true;
  $("#fit-button").hidden = true;
  card.querySelector(".close-detail").addEventListener("click", clearSelection);
  card.querySelector(".fit-globe").addEventListener("click", fitSelection);
  setSheetExpanded(false);
  bindSheetGesture();
}

function renderDetail(feature) {
  if (isSpace(feature)) return renderSpaceDetail(feature);
  const p = feature.properties;
  const image = state.images[p.id];
  const imageMarkup = image
    ? `<figure class="journey-figure">
        <img src="${escapeHtml(image.path)}" alt="${escapeHtml(image.alt)}" loading="lazy" decoding="async">
        <figcaption><a class="image-credit" href="${escapeHtml(image.source_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(image.credit)} · resized and padded to WebP">${escapeHtml(image.credit)} · resized for display</a><a href="${escapeHtml(image.license_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(image.license)} ↗</a></figcaption>
      </figure>`
    : "";
  const anchors = (p.anchors || []).map((anchor) => `<li><b>${escapeHtml(anchor.name)}</b>${anchor.note ? ` — ${escapeHtml(anchor.note)}` : ""}</li>`).join("");
  const overview = p.overview && p.overview !== p.why_famous && p.overview !== p.route_summary
    ? `<p class="overview">${escapeHtml(p.overview)}</p>` : "";
  const additionalSources = Array.isArray(p.additional_sources) && p.additional_sources.length
    ? `<details class="waypoints more-sources"><summary>${p.additional_sources.length} additional source${p.additional_sources.length === 1 ? "" : "s"}</summary><ul>${p.additional_sources.map((source) => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a>${source.note ? `<span>${escapeHtml(source.note)}</span>` : ""}</li>`).join("")}</ul></details>` : "";
  const segmentDetails = p.segments?.length
    ? `<details class="waypoints"><summary>${p.segments.length} route segment${p.segments.length === 1 ? "" : "s"} and evidence</summary><ol>${p.segments.map((segment) => {
      const inferred = segment.track_type === "waypoint-interpolation" || p.geometry_confidence?.toLowerCase() === "low";
      return `<li data-line-style="${inferred ? "inferred" : "anchored"}"><b>${escapeHtml(segment.mode)}</b> · ${escapeHtml(segment.track_type.replaceAll("-", " "))} · ${inferred ? "dashed" : "solid"} · <a href="${escapeHtml(segment.source_url)}" target="_blank" rel="noopener noreferrer">source ↗</a></li>`;
    }).join("")}</ol></details>` : "";
  const wikiLabel = `${p.wiki_relation === "related" ? "Related English Wikipedia article" : "English Wikipedia"}: ${p.wiki_title || p.title}`;
  const singular = { flights: "Flight", sailing: "Sailing journey", rail: "Rail journey", "road-races": "Road journey", overland: "Overland journey", "ocean-liners": "Ocean voyage", river: "River journey", "human-powered": "Human-powered journey" }[domainOf(feature)];
  const card = $("#detail");
  card.className = "detail-card";
  card.innerHTML = `
    <button class="sheet-handle" type="button" aria-expanded="false" aria-label="Expand journey details"><span></span></button>
    <div class="detail-top">
      <div><div class="detail-rank">${singular} ${String(p.rank).padStart(2, "0")} · ${escapeHtml(p.group)}</div><h2>${escapeHtml(p.title)}</h2><div class="detail-date">${escapeHtml(p.date)} · ${escapeHtml(p.era)}</div></div>
      <div class="detail-top-actions">${p.wiki_url ? `<a class="wiki-logo-link" href="${escapeHtml(p.wiki_url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(wikiLabel)}" title="${escapeHtml(wikiLabel)}"><img src="assets/wikipedia-w.svg" alt=""></a>` : ""}<button class="close-detail" type="button" aria-label="Close details">×</button></div>
    </div>
    <div class="why-famous"><span>Why it was famous</span><p>${escapeHtml(p.why_famous || "")}</p></div>
    ${imageMarkup}
    <p class="route-summary">${escapeHtml(p.route_summary || "")}</p>
    ${overview}
    <div class="metrics"><div class="metric"><strong>${formatDistance(p.distance_km)}</strong><span>anchor path</span></div><div class="metric"><strong>${Number(p.vertex_count || 0).toLocaleString()}</strong><span>WKT vertices</span></div><div class="metric"><strong>${(p.anchors || []).length}</strong><span>research anchors</span></div></div>
    ${p.altitude_estimate ? `<div class="quality"><span>3D height estimate</span><strong>up to ${Math.round(p.altitude_estimate.max_height_m).toLocaleString()} m · ${escapeHtml(p.altitude_estimate.confidence)} confidence</strong></div><p class="geometry-note altitude-note">${escapeHtml(p.altitude_estimate.basis)} These are estimated heights, not observed telemetry. <a href="${escapeHtml(p.altitude_estimate.sources.at(-1))}" target="_blank" rel="noopener noreferrer">Altitude context ↗</a></p>` : ""}
    <div class="quality"><span>Route evidence</span><strong>${escapeHtml(p.quality_label || p.geometry_confidence || "Reconstructed")}</strong></div>
    <p class="geometry-note">${escapeHtml(p.description || p.geometry_note || "Approximate reconstruction; verify against sources.")}</p>
    <div class="detail-actions"><a href="${escapeHtml(p.wkt_file)}?v=${GEOMETRY_VERSION}" download>Download ${p.altitude_estimate ? "2D " : ""}WKT</a><button type="button" class="copy-wkt">Copy WKT</button><button type="button" class="download-geojson">Download ${p.altitude_estimate ? "3D " : ""}GeoJSON</button><a class="source" href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener noreferrer">Research source ↗</a><button type="button" class="fit-globe">Fit on globe</button></div>
    ${additionalSources}${segmentDetails}
    <details class="waypoints"><summary>${(p.anchors || []).length} researched route anchors</summary><ol>${anchors}</ol></details>`;
  $("#fit-button").disabled = false;
  $("#fit-button").hidden = false;
  $("#fit-button").textContent = "Fit route";
  $("#fit-button").title = "Fit selected route";
  card.querySelector(".close-detail").addEventListener("click", clearSelection);
  setSheetExpanded(false);
  bindSheetGesture();
  card.querySelector(".fit-globe").addEventListener("click", fitSelection);
  card.querySelector(".journey-figure img")?.addEventListener("error", (event) => {
    event.currentTarget.closest("figure").hidden = true;
  });
  card.querySelector(".copy-wkt").addEventListener("click", async (event) => {
    const response = await fetch(`${p.wkt_file}?v=${GEOMETRY_VERSION}`);
    if (!response.ok) throw new Error(`WKT HTTP ${response.status}`);
    await navigator.clipboard.writeText((await response.text()).trim());
    event.currentTarget.textContent = "Copied";
    setTimeout(() => { event.currentTarget.textContent = "Copy WKT"; }, 1300);
  });
  card.querySelector(".download-geojson").addEventListener("click", async () => {
    const collection = await fullCollection(domainOf(feature));
    const fullFeature = collection.features.find((candidate) => candidate.properties.id === p.id);
    if (!fullFeature) throw new Error(`Full geometry missing for ${p.id}`);
    const blob = new Blob([JSON.stringify(fullFeature, null, 2)], { type: "application/geo+json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${p.id}.geojson`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

async function fullCollection(domain) {
  if (state.fullCollections.has(domain))
    return state.fullCollections.get(domain);
  const file =
    domain === "flights"
      ? "data/flights-3d.geojson"
      : `data/journeys/${domain}.geojson`;
  const promise = fetch(`${file}?v=${GEOMETRY_VERSION}`).then((response) => {
    if (!response.ok)
      throw new Error(`HTTP ${response.status} loading ${domain}`);
    return response.json();
  });
  state.fullCollections.set(domain, promise);
  try {
    return await promise;
  } catch (error) {
    state.fullCollections.delete(domain);
    throw error;
  }
}

async function spacePath(feature) {
  const p = feature.properties;
  if (!state.spacePaths.has(p.id)) {
    const promise = fetch(`${p.path}?v=${GEOMETRY_VERSION}`).then((response) => {
      if (!response.ok) throw new Error(`Trajectory HTTP ${response.status}`);
      return response.json();
    });
    state.spacePaths.set(p.id, promise);
  }
  try {
    return await state.spacePaths.get(p.id);
  } catch (error) {
    state.spacePaths.delete(p.id);
    throw error;
  }
}

async function displaySpacePath(feature) {
  const id = feature.properties.id;
  if (!state.spaceDisplayPaths.has(id)) {
    const promise = spacePath(feature).then(spaceCartesians).then((positions) => {
      state.spaceDisplayPositions.set(id, positions);
      return positions;
    });
    state.spaceDisplayPaths.set(id, promise);
  }
  try {
    return await state.spaceDisplayPaths.get(id);
  } catch (error) {
    state.spaceDisplayPaths.delete(id);
    throw error;
  }
}

function ensureAllSpacePreviews() {
  if (state.spacePreviewLoad) return;
  const missions = state.overview.filter(isSpace);
  state.spacePreviewLoad = Promise.allSettled(missions.map(displaySpacePath)).then((results) => {
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) console.warn(`${failed.length} space previews failed to load`, failed);
    state.spacePreviewLoad = null;
    if (state.domain === "all") drawPreviews();
  });
}

function resetWholeEarth() {
  state.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(...WHOLE_EARTH_DESTINATION),
    duration: 0.9,
  });
}

function zoomGlobe(direction) {
  const camera = state.viewer.camera;
  const distance = Cesium.Cartesian3.magnitude(camera.positionWC);
  // Relative steps work at both Earth-orbit and compressed interplanetary scales.
  const amount = Math.max(1000, distance * 0.3);
  if (direction > 0) camera.zoomIn(amount);
  else camera.zoomOut(amount);
  state.viewer.scene.requestRender();
}

// A static inertial trajectory is rotated into the Earth-fixed scene at its
// first sample. Rotating each sample at a different epoch would falsely turn
// the historical trajectory into an Earth-rotation ground-track spiral.
function closestSegmentRadiusKm(a, b) {
  const delta = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
  const lengthSquared = Cesium.Cartesian3.magnitudeSquared(delta);
  const t = lengthSquared ? Cesium.Math.clamp(-Cesium.Cartesian3.dot(a, delta) / lengthSquared, 0, 1) : 0;
  return Cesium.Cartesian3.magnitude(Cesium.Cartesian3.add(a, Cesium.Cartesian3.multiplyByScalar(delta, t, new Cesium.Cartesian3()), new Cesium.Cartesian3()));
}

function earthClearingArc(a, b) {
  const start = Cesium.Cartesian3.normalize(a, new Cesium.Cartesian3());
  const end = Cesium.Cartesian3.normalize(b, new Cesium.Cartesian3());
  const angle = Cesium.Cartesian3.angleBetween(start, end);
  const steps = Math.max(2, Math.ceil(angle / Cesium.Math.toRadians(0.5)));
  const sinAngle = Math.sin(angle);
  const tangent = Math.abs(sinAngle) < 1e-7
    ? Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(start, Cesium.Cartesian3.mostOrthogonalAxis(start, new Cesium.Cartesian3()), new Cesium.Cartesian3()), new Cesium.Cartesian3())
    : null;
  const output = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const direction = tangent
      ? Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(start, Math.cos(angle * t), new Cesium.Cartesian3()), Cesium.Cartesian3.multiplyByScalar(tangent, Math.sin(angle * t), new Cesium.Cartesian3()), new Cesium.Cartesian3())
      : Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(start, Math.sin((1 - t) * angle) / sinAngle, new Cesium.Cartesian3()), Cesium.Cartesian3.multiplyByScalar(end, Math.sin(t * angle) / sinAngle, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const radius = Math.max(6383.137, Cesium.Math.lerp(Cesium.Cartesian3.magnitude(a), Cesium.Cartesian3.magnitude(b), t));
    output.push(Cesium.Cartesian3.multiplyByScalar(Cesium.Cartesian3.normalize(direction, direction), radius, direction));
  }
  return output;
}

async function spaceCartesians(path) {
  const first = Cesium.JulianDate.fromIso8601(path.positions[0][0]);
  const stop = Cesium.JulianDate.addSeconds(first, 1, new Cesium.JulianDate());
  try {
    await Cesium.Transforms.preloadIcrfFixed(new Cesium.TimeInterval({ start: first, stop }));
  } catch (error) {
    console.warn("Using approximate historic Earth orientation", error);
  }
  let fixed = Cesium.Transforms.computeIcrfToFixedMatrix(first);
  if (!fixed) {
    // USNO approximate GMST (UTC used for UT1, ICRF precession/nutation
    // omitted). This is a display orientation, not an astrometric transform.
    // https://aa.usno.navy.mil/faq/GAST
    const jd = Date.parse(path.positions[0][0]) / 86_400_000 + 2_440_587.5;
    const jd0 = Math.floor(jd - 0.5) + 0.5;
    const hours = (jd - jd0) * 24;
    const centuries = (jd - 2_451_545) / 36_525;
    const gmstHours = (6.697375 + 0.065709824279 * (jd0 - 2_451_545)
      + 1.0027379 * hours + 0.0000258 * centuries * centuries) % 24;
    fixed = Cesium.Matrix3.fromRotationZ(-gmstHours * Math.PI / 12);
  }
  const original = path.positions.map(([, x, y, z]) => new Cesium.Cartesian3(x, y, z));
  const interpolated = [];
  for (let index = 0; index < original.length; index++) {
    const current = original[index];
    if (index) {
      const previous = original[index - 1];
      if (closestSegmentRadiusKm(previous, current) < 6383.137)
        interpolated.push(...earthClearingArc(previous, current));
    }
    interpolated.push(current);
  }
  return interpolated.map((inertial) => {
    const radius = Cesium.Cartesian3.magnitude(inertial);
    // Keep Earth orbit and cislunar routes to scale. Compress distant paths
    // continuously, preserving direction, chronology, and the original JSON.
    const shownRadius = radius <= 500_000
      ? radius
      : 500_000 + 400_000 * Math.log1p((radius - 500_000) / 400_000);
    const shown = Cesium.Cartesian3.multiplyByScalar(inertial, Math.max(shownRadius, 6383.137) * 1000 / radius, new Cesium.Cartesian3());
    const position = Cesium.Matrix3.multiplyByVector(fixed, shown, new Cesium.Cartesian3());
    // Launch and landing samples are explicitly surface fixes in the source;
    // keep them on WGS84 instead of applying the display-only 5 km clearance.
    return radius <= 6379 ? Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(position) : position;
  });
}

function drawSpacePath(feature, positions) {
  const entity = state.viewer.entities.add({
    id: `selected:${feature.properties.id}:space`,
    properties: { journeyId: feature.properties.id },
    polyline: {
      positions,
      width: 7,
      material: new Cesium.PolylineOutlineMaterialProperty({
        color: Cesium.Color.fromCssColorString(feature.properties.color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1.25,
      }),
      arcType: Cesium.ArcType.NONE,
    },
  });
  state.selection.push(entity);
  state.selectedSpacePositions = positions;
  // The trajectory's first sample may be at an estimated launch altitude.
  // Keep the dot clamped to the ellipsoid, but anchor its text above it in
  // world space so the globe's depth test cannot bury the label in terrain.
  const launchPosition = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(positions[0]);
  const launchCartographic = Cesium.Cartographic.fromCartesian(launchPosition);
  const labelPosition = Cesium.Cartesian3.fromRadians(
    launchCartographic.longitude, launchCartographic.latitude, 30_000,
  );
  state.spaceMarkers.push(state.viewer.entities.add({
    id: `marker:${feature.properties.id}:earth`,
    position: labelPosition,
    point: {
      pixelSize: 11,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString(feature.properties.color),
      outlineWidth: 3,
      disableDepthTestDistance: 0,
    },
    label: {
      text: `Earth / ${feature.properties.launch_site || "launch site"}`,
      font: "12px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      disableDepthTestDistance: 0,
    },
  }));
}

function drawSpacePreview(feature, positions) {
  return state.viewer.entities.add({
    id: `preview:${feature.properties.id}:space`,
    properties: { journeyId: feature.properties.id },
    polyline: {
      positions,
      width: 1.3,
      material: Cesium.Color.fromCssColorString(feature.properties.color).withAlpha(state.selectedId ? 0.1 : 0.34),
      arcType: Cesium.ArcType.NONE,
    },
  });
}

function selectedFeature() {
  return state.fullCollections
    .get(domainOf(byId.get(state.selectedId)))
    ?.then((collection) =>
      collection.features.find(
        (feature) => feature.properties.id === state.selectedId,
      ),
    );
}

function fitFeature(feature) {
  const positions = [];
  for (const line of linesOf(feature.geometry)) {
    const stride = Math.max(1, Math.floor(line.length / 400));
    for (let i = 0; i < line.length; i += stride) {
      const point = line[i];
      if (Number.isFinite(point[0]) && Number.isFinite(point[1]))
        positions.push(Cesium.Cartesian3.fromDegrees(point[0], point[1], point[2] || 0));
    }
    const last = line.at(-1);
    if (last) positions.push(Cesium.Cartesian3.fromDegrees(last[0], last[1], last[2] || 0));
  }
  if (!positions.length) return;
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  if (sphere.radius > 4_400_000) {
    status(
      "This route spans more than one visible hemisphere; rotate the globe to follow it.",
    );
    state.viewer.camera.flyHome(0.9);
  } else {
    const range = Math.max(1200, sphere.radius * 3.15);
    state.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.1,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-65),
        range,
      ),
      complete: () => {
        const canvas = state.viewer.scene.canvas.getBoundingClientRect();
        const card = $("#detail").getBoundingClientRect();
        if (canvas.width < 700 || card.right <= canvas.left || card.left >= canvas.right) return;
        const visibleCenterX = (Math.max(canvas.left, card.right) + canvas.right) / 2;
        const pixelShift = visibleCenterX - (canvas.left + canvas.width / 2);
        if (pixelShift <= 0) return;
        const fovy = state.viewer.camera.frustum.fovy;
        const metresPerPixel = 2 * range * Math.tan(fovy / 2) / canvas.height;
        state.viewer.camera.moveLeft(pixelShift * metresPerPixel);
        state.viewer.scene.requestRender();
      },
    });
  }
}

async function fitSelection() {
  if (!state.selectedId) return;
  if (isSpace(byId.get(state.selectedId))) return resetWholeEarth();
  const feature = await selectedFeature();
  if (feature) fitFeature(feature);
}

async function selectJourney(id) {
  const overviewFeature = byId.get(id);
  if (!overviewFeature) return;
  const ticket = ++state.selectionTicket;
  state.visible.add(id);
  clearEntities(state.selection);
  clearEntities(state.spaceMarkers);
  state.selectedSpacePositions = [];
  state.selectedId = id;
  if (isSpace(overviewFeature)) resetWholeEarth();
  renderList();
  drawPreviews();
  renderDetail(overviewFeature);
  status(
    `Loading full geometry for ${overviewFeature.properties.short_title || overviewFeature.properties.title}…`,
  );
  try {
    if (isSpace(overviewFeature)) {
      const path = await spacePath(overviewFeature);
      const positions = await displaySpacePath(overviewFeature);
      if (ticket !== state.selectionTicket) return;
      drawSpacePath(overviewFeature, positions);
      state.viewer.scene.requestRender();
      status(`${path.positions.length.toLocaleString()} source samples · ${positions.length.toLocaleString()} display vertices · ${overviewFeature.properties.max_earth_center_distance_km > 500_000 ? "distant scale compressed" : "cislunar distances to scale"}`);
      return;
    }
    const collection = await fullCollection(domainOf(overviewFeature));
    if (ticket !== state.selectionTicket) return;
    const feature = collection.features.find(
      (candidate) => candidate.properties.id === id,
    );
    if (!feature) throw new Error(`Route ${id} missing from full collection`);
    state.selection.push(...drawFeature(feature, true));
    state.viewer.scene.requestRender();
    fitFeature(feature);
    status(
      `${feature.properties.vertex_count?.toLocaleString() || "Full"} source vertices loaded · rotate to inspect the route`,
    );
  } catch (error) {
    if (ticket !== state.selectionTicket) return;
    status(`Could not load full route: ${error.message}`);
    console.error(error);
  }
}

function setDomain(domain) {
  if (!GLOBE_DOMAINS.some(([id]) => id === domain)) return;
  state.domain = domain;
  state.query = "";
  $("#journey-search").value = "";
  $("#journey-search").placeholder = domain === "all" ? "Search all journeys or categories…" : domain === "flights" ? "Search flights, years, eras…" : `Search ${domainLabel(domain).toLowerCase()} journeys…`;
  clearSelection();
  renderCategories();
  if (domain === "all") ensureAllSpacePreviews();
}

function bindControls() {
  $("#categories").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-domain]");
    if (button) setDomain(button.dataset.domain);
  });
  $("#journey-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderList();
    drawPreviews();
  });
  $("#journey-list").addEventListener("click", (event) => {
    const item = event.target.closest(".route-item[data-id]");
    if (!item) return;
    if (event.target.classList.contains("route-toggle")) return;
    void selectJourney(item.dataset.id);
  });
  $("#journey-list").addEventListener("change", (event) => {
    if (!event.target.classList.contains("route-toggle")) return;
    const id = event.target.closest(".route-item").dataset.id;
    if (event.target.checked) state.visible.add(id);
    else state.visible.delete(id);
    if (!event.target.checked && state.selectedId === id) clearSelection();
    else {
      renderList();
      drawPreviews();
    }
  });
  $("#journey-list").addEventListener("keydown", (event) => {
    if (!event.target.classList.contains("route-item")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void selectJourney(event.target.dataset.id);
  });
  const siteInfo = $("#site-info");
  $("#site-info-open").addEventListener("click", () => siteInfo.showModal());
  $("#site-info-close").addEventListener("click", () => siteInfo.close());
  siteInfo.addEventListener("click", (event) => { if (event.target === siteInfo) siteInfo.close(); });
  $("#home-button").addEventListener("click", resetWholeEarth);
  $("#zoom-in-button").addEventListener("click", () => zoomGlobe(1));
  $("#zoom-out-button").addEventListener("click", () => zoomGlobe(-1));
  $("#fit-button").addEventListener("click", fitSelection);
  $("#open-map").addEventListener("click", (event) => {
    event.preventDefault();
    const url = new URL("index.html", window.location.href);
    if (state.domain !== "space") {
      url.searchParams.set("domain", state.domain);
      if (state.selectedId) url.searchParams.set("journey", state.selectedId);
    }
    window.location.assign(url);
  });
  const handler = new Cesium.ScreenSpaceEventHandler(state.viewer.scene.canvas);
  handler.setInputAction((event) => {
    const picked = state.viewer.scene.pick(event.position);
    const id = picked?.id?.properties?.journeyId?.getValue();
    if (id && byId.has(id)) void selectJourney(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

async function start() {
  try {
    const [provider, response, flightFullResponse, spaceResponse, wikiResponse, aircraftResponse, journeysResponse] = await Promise.all([
      Cesium.ArcGisMapServerImageryProvider.fromUrl(
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
      ),
      fetch(`data/all-overview.geojson?v=${GEOMETRY_VERSION}`),
      fetch(`data/flights-3d.geojson?v=${GEOMETRY_VERSION}`),
      fetch(`spaceflight/index.json?v=${GEOMETRY_VERSION}`),
      fetch(`spaceflight/wiki-links.json?v=${GEOMETRY_VERSION}`),
      fetch("data/aircraft-images.json"),
      fetch("data/journey-images.json"),
    ]);
    if (!response.ok) throw new Error(`Overview HTTP ${response.status}`);
    if (!flightFullResponse.ok) throw new Error(`Flight 3D HTTP ${flightFullResponse.status}`);
    if (!spaceResponse.ok) throw new Error(`Space catalog HTTP ${spaceResponse.status}`);
    if (!wikiResponse.ok) throw new Error(`Space Wikipedia links HTTP ${wikiResponse.status}`);
    if (!aircraftResponse.ok || !journeysResponse.ok)
      throw new Error("Image catalog unavailable");
    const overview = await response.json();
    const flightFull = await flightFullResponse.json();
    const spaceCatalog = await spaceResponse.json();
    const spaceWiki = await wikiResponse.json();
    if (flightFull.features?.length !== 25) throw new Error("Expected 25 full 3D flights");
    if (spaceCatalog.missions?.length !== 25) throw new Error("Expected 25 space missions");
    if (spaceCatalog.missions.some((mission) => !spaceWiki[mission.id])) throw new Error("Space Wikipedia links are incomplete");
    const flightsById = new Map(flightFull.features.map((feature) => [feature.properties.id, feature]));
    state.fullCollections.set("flights", Promise.resolve(flightFull));
    state.images = {
      ...(await aircraftResponse.json()),
      ...(await journeysResponse.json()),
    };
    if (overview.features?.length !== 200)
      throw new Error("Expected 200 overview routes");
    state.overview = overview.features.map((feature) =>
      domainOf(feature) === "flights" ? flightsById.get(feature.properties.id) : feature,
    );
    if (state.overview.some((feature) => !feature)) throw new Error("Flight 3D IDs do not match overview");
    state.overview.push(...spaceCatalog.missions.map((mission) => ({
      type: "Feature",
      geometry: null,
      properties: {
        ...mission,
        domain: "space",
        color: ["#9ed4ff", "#e6bdff", "#ffc78b", "#b4f0bd", "#ffe699"][mission.rank % 5],
        short_title: mission.title,
        era: "Space Age",
        route_summary: mission.description,
        path: `spaceflight/${mission.path}`,
        wiki_url: spaceWiki[mission.id],
      },
    })));
    for (const feature of state.overview)
      byId.set(feature.properties.id, feature);
    state.visible = new Set(state.overview.map((feature) => feature.properties.id));
    state.viewer = new Cesium.Viewer("cesium-container", {
      baseLayer: new Cesium.ImageryLayer(provider),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      scene3DOnly: true,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    });
    state.viewer.scene.globe.baseColor =
      Cesium.Color.fromCssColorString("#0c1a29");
    state.viewer.scene.globe.depthTestAgainstTerrain = true;
    state.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(...WHOLE_EARTH_DESTINATION),
    });
    renderCategories();
    renderList();
    drawPreviews();
    bindControls();
    const query = new URLSearchParams(window.location.search);
    const requestedDomain = query.get("domain");
    if (GLOBE_DOMAINS.some(([id]) => id === requestedDomain))
      setDomain(requestedDomain);
    const requestedJourney = query.get("journey");
    if (requestedJourney && byId.has(requestedJourney)) {
      const feature = byId.get(requestedJourney);
      if (state.domain !== "all" && state.domain !== domainOf(feature))
        setDomain(domainOf(feature));
      await selectJourney(requestedJourney);
    }
  } catch (error) {
    status(`Globe unavailable: ${error.message}`);
    console.error(error);
  }
}

function entityHeightRange(entities) {
  let min = Infinity;
  let max = 0;
  for (const entity of entities) {
    for (const position of entity.polyline.positions.getValue()) {
      const height = Cesium.Cartographic.fromCartesian(position).height;
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
  }
  return { min, max };
}

// Read-only diagnostics for browser regression tests.
window.__globeDebug = () => ({
  ready: Boolean(state.viewer),
  domain: state.domain,
  selectedId: state.selectedId,
  previewEntities: state.previews.length,
  selectedEntities: state.selection.length,
  spaceMarkerEntities: state.spaceMarkers.length,
  spaceLabelHeightMeters: state.spaceMarkers.length
    ? Cesium.Cartographic.fromCartesian(state.spaceMarkers[0].position.getValue()).height
    : null,
  spaceMarkerGrounded: state.spaceMarkers.length
    ? state.spaceMarkers[0].point.heightReference.getValue() === Cesium.HeightReference.CLAMP_TO_GROUND
    : null,
  spaceLabelOffsetY: state.spaceMarkers.length ? state.spaceMarkers[0].label.pixelOffset.getValue().y : null,
  spaceMarkerLabel: state.spaceMarkers.length ? state.spaceMarkers[0].label.text.getValue() : null,
  spacePreviewEntities: state.previews.filter((entity) => entity.id.endsWith(":space")).length,
  cameraPosition: state.viewer ? [state.viewer.camera.positionWC.x, state.viewer.camera.positionWC.y, state.viewer.camera.positionWC.z] : null,
  wholeEarthCameraPosition: (() => {
    const destination = Cesium.Cartesian3.fromDegrees(...WHOLE_EARTH_DESTINATION);
    return [destination.x, destination.y, destination.z];
  })(),
  cameraFarMeters: state.viewer?.camera.frustum.far,
  logDepthBuffer: state.viewer?.scene.logarithmicDepthBuffer,
  logDepthFarToNearRatio: state.viewer?.scene.logarithmicDepthFarToNearRatio,
  previewSelectedEntities: state.previews.filter(
    (entity) => entity.properties.journeyId.getValue() === state.selectedId,
  ).length,
  bellPreviewVertices: state.previews.filter(
    (entity) => entity.properties.journeyId.getValue() === "bell-x1-sound-barrier",
  ).reduce((count, entity) => count + entity.polyline.positions.getValue().length, 0),
  selectedVertices: state.selection.reduce((count, entity) => count + entity.polyline.positions.getValue().length, 0),
  selectedInvalidVertices: state.selection.reduce((count, entity) => count + entity.polyline.positions.getValue().filter((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)).length, 0),
  selectedPolyLineVisible: state.selection.every((entity) => entity.show && entity.polyline.show?.getValue() !== false),
  selectedDrawnAfterPreviews: state.selection.every((entity) =>
    state.previews.every((preview) => state.viewer.entities.values.indexOf(entity) > state.viewer.entities.values.indexOf(preview))),
  selectedWidths: state.selection.map((entity) => entity.polyline.width.getValue()),
  selectedOutlined: state.selection.every((entity) => entity.polyline.material instanceof Cesium.PolylineOutlineMaterialProperty),
  depthTestAgainstTerrain: state.viewer?.scene.globe.depthTestAgainstTerrain,
  routesUseGeodesicArcs: [...state.previews, ...state.selection].every(
    (entity) => entity.polyline.arcType.getValue() === Cesium.ArcType.GEODESIC,
  ),
  minRouteVertexHeightMeters: entityHeightRange([...state.previews, ...state.selection]).min,
  maxRouteVertexHeightMeters: entityHeightRange([...state.previews, ...state.selection]).max,
  selectedMinimumHeightMeters: entityHeightRange(state.selection).min,
  selectedMaximumHeightMeters: entityHeightRange(state.selection).max,
  fullCollectionsLoaded: [...state.fullCollections.keys()],
  imageryLayers: state.viewer?.imageryLayers.length || 0,
});
void start();
