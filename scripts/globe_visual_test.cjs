#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const outputDir = process.argv[3] || "/tmp/landmark-globe-test";
const spaceOnly = process.argv.includes("--space-only");
const spaceAll = process.argv.includes("--space-all");
const spaceMobileOnly = process.argv.includes("--space-mobile");
const chandrayaanOnly = process.argv.includes("--chandrayaan-only");
const highlightOnly = process.argv.includes("--highlight-only");
const domains = [
  "flights",
  "sailing",
  "rail",
  "road-races",
  "overland",
  "ocean-liners",
  "river",
  "human-powered",
];
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function dismissSplash(page) {
  if (await page.locator("#welcome-splash").isVisible()) await page.locator("#welcome-continue").click();
}

async function assertDetailImage(page, label) {
  await page.locator("#detail .journey-figure img").waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector("#detail .journey-figure img");
    return image?.complete && image.naturalWidth > 0;
  });
  assert(
    (await page.locator("#detail .journey-figure figcaption a").count()) === 2,
    `${label}: image source or license link is missing`,
  );
}

async function countScreenshotColor(page, png, color, left) {
  return page.evaluate(async ({ encoded, color, left }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let count = 0;
    for (let y = 70; y < image.height - 30; y++) {
      for (let x = left; x < image.width - 10; x++) {
        const index = (y * image.width + x) * 4;
        if (color.every((channel, i) => Math.abs(pixels[index + i] - channel) < 25)) count++;
      }
    }
    return count;
  }, { encoded: png.toString("base64"), color, left });
}

async function runCase(browser, name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/globe.html`, { waitUntil: "domcontentloaded" });
  await dismissSplash(page);
  await page.waitForFunction(() => window.__globeDebug?.().ready === true, {
    timeout: 45000,
  });
  await page.waitForTimeout(1800);
  let state = await page.evaluate(() => window.__globeDebug());
  assert(
    state.domain === "flights",
    `${name}: default category is not flights`,
  );
  assert(
    state.previewEntities >= 25,
    `${name}: flight preview geometry is missing`,
  );
  assert(
    state.routesUseGeodesicArcs &&
      state.minRouteVertexHeightMeters >= 4.9 &&
      state.maxRouteVertexHeightMeters > 24000,
    `${name}: flight previews do not use the estimated 3D altitudes`,
  );
  assert(state.fullCollectionsLoaded.includes("flights"), `${name}: full 3D flights were not loaded for previews`);
  assert(state.bellPreviewVertices >= 175, `${name}: Bell X-1 preview is still simplified`);
  assert(state.imageryLayers >= 1, `${name}: satellite basemap is missing`);
  assert(
    (await page.locator("#categories button").count()) === 10,
    `${name}: categories are incomplete`,
  );
  assert(
    (await page.locator("#journey-list .route-item").count()) === 25,
    `${name}: flights list is incomplete`,
  );
  await page.locator("#site-info-open").click();
  assert(
    await page.locator("#site-info .site-info-warning").isVisible(),
    `${name}: shared about panel or AI-source warning is missing`,
  );
  await page.locator("#site-info-close").click();
  const firstToggle = page.locator('#journey-list .route-item[data-id="wright-first-flight"] .route-toggle');
  const originalPreviewCount = state.previewEntities;
  await firstToggle.uncheck();
  assert(
    (await page.evaluate(() => window.__globeDebug())).previewEntities < originalPreviewCount,
    `${name}: sidebar visibility toggle did not hide the track`,
  );
  await firstToggle.check();
  const canvas = await page.locator("#cesium-container canvas").boundingBox();
  assert(
    canvas && canvas.width > 280 && canvas.height > 220,
    `${name}: globe canvas is not visible`,
  );
  await page.screenshot({ path: `${outputDir}/${name}-initial.png` });

  await page
    .locator('#journey-list .route-item[data-id="lindbergh-spirit-of-st-louis"]')
    .click();
  await page.waitForFunction(() => window.__globeDebug().selectedEntities > 0, {
    timeout: 30000,
  });
  state = await page.evaluate(() => window.__globeDebug());
  assert(
    state.selectedId === "lindbergh-spirit-of-st-louis",
    `${name}: route selection failed`,
  );
  assert(
    state.routesUseGeodesicArcs &&
      state.selectedMaximumHeightMeters > 2190 &&
      state.selectedMaximumHeightMeters < 2210,
    `${name}: full-resolution flight does not use its altitude profile`,
  );
  assert(
    state.previewSelectedEntities === 0,
    `${name}: simplified and full-resolution versions of the selected route overlap`,
  );
  assert(
    state.selectedDrawnAfterPreviews && state.selectedOutlined && state.selectedWidths.every((width) => width >= 7),
    `${name}: selected route is not rendered above previews with a thick outline`,
  );
  assert(
    state.depthTestAgainstTerrain,
    `${name}: globe depth testing is off and routes can show through the surface`,
  );
  assert(
    state.fullCollectionsLoaded.includes("flights"),
    `${name}: full flight collection was not fetched on selection`,
  );
  assert(
    await page.locator("#detail:not(.empty)").isVisible(),
    `${name}: source/uncertainty card is hidden`,
  );
  assert(
    (await page.locator("#detail .geometry-note:not(.altitude-note)").count()) === 1,
    `${name}: uncertainty note is missing`,
  );
  assert(
    (await page.locator("#detail .altitude-note").count()) === 1 &&
      (await page.locator("#detail .download-geojson").innerText()).includes("3D"),
    `${name}: altitude provenance or 3D download label is missing`,
  );
  assert(
    (await page.locator("#detail .why-famous").count()) === 1 &&
      (await page.locator("#detail .metrics .metric").count()) === 3 &&
      (await page.locator("#detail .detail-actions a[download]").count()) === 1 &&
      (await page.locator("#detail .copy-wkt").count()) === 1 &&
      (await page.locator("#detail .download-geojson").count()) === 1,
    `${name}: 2D-style detail card content or actions are missing`,
  );
  assert(
    (await page
      .locator('#detail a[href^="https://en.wikipedia.org/wiki/"]')
      .count()) === 1,
    `${name}: Wikipedia link is missing`,
  );
  if (name === "desktop") await assertDetailImage(page, `${name}/flight`);
  await page.waitForTimeout(1400);
  const selectedImage = await page.screenshot({ path: `${outputDir}/${name}-selected.png` });
  if (name === "desktop") {
    const cardRight = await page.locator("#detail").evaluate((card) => Math.ceil(card.getBoundingClientRect().right));
    const selectedPixels = await countScreenshotColor(page, selectedImage, [255, 159, 67], cardRight + 5);
    assert(selectedPixels > 80, `desktop: highlighted Lindbergh path has only ${selectedPixels} visible pixels outside the card`);
  }
  await page.locator("#journey-search").fill("Lindbergh");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outputDir}/${name}-selected-isolated.png` });
  await page.locator("#journey-search").fill("");
  if (name === "mobile") {
    const peekHeight = await page
      .locator("#detail")
      .evaluate((element) => element.getBoundingClientRect().height);
    assert(
      peekHeight <= 75,
      `mobile: detail peek is too tall (${peekHeight}px)`,
    );
    await page.locator("#detail .sheet-handle").click();
    await page.waitForTimeout(250);
    assert(
      (await page.locator("#detail .sheet-handle").getAttribute("aria-expanded")) ===
        "true",
      "mobile: details did not expand",
    );
    const expandedHeight = await page
      .locator("#detail")
      .evaluate((element) => element.getBoundingClientRect().height);
    assert(
      expandedHeight > 300,
      `mobile: expanded details are too short (${expandedHeight}px)`,
    );
    await assertDetailImage(page, `${name}/flight`);
    await page.screenshot({ path: `${outputDir}/${name}-expanded.png` });
    await page.locator("#detail .sheet-handle").click();
  }

  await page.locator("#detail .close-detail").click();
  state = await page.evaluate(() => window.__globeDebug());
  assert(
    state.selectedEntities === 0 && state.previewEntities >= originalPreviewCount,
    `${name}: closing details did not restore the full-resolution preview route`,
  );

  await page.locator('#categories button[data-domain="sailing"]').click();
  state = await page.evaluate(() => window.__globeDebug());
  assert(
    state.domain === "sailing" && state.selectedId === null,
    `${name}: category change did not clear selection`,
  );
  assert(
    (await page.locator("#journey-list .route-item").count()) === 25,
    `${name}: sailing list is incomplete`,
  );
  await page.locator("#journey-search").fill("Magellan–Elcano");
  assert(
    (await page.locator("#journey-list .route-item").count()) === 1,
    `${name}: search did not filter journeys`,
  );
  await page.locator("#journey-list .route-item").first().click();
  await page.waitForFunction(() => window.__globeDebug().selectedEntities > 0, {
    timeout: 30000,
  });
  assert(
    (
      await page.evaluate(() => window.__globeDebug())
    ).fullCollectionsLoaded.includes("sailing"),
    `${name}: sailing geometry did not load lazily`,
  );
  if (name === "desktop") await assertDetailImage(page, `${name}/sailing`);

  for (const domain of domains.slice(2)) {
    await page.locator(`#categories button[data-domain="${domain}"]`).click();
    assert(
      (await page.locator("#journey-list .route-item").count()) === 25,
      `${name}: ${domain} is not populated`,
    );
  }
  await page.locator('#categories button[data-domain="all"]').click();
  await page.waitForFunction(() => window.__globeDebug().spacePreviewEntities === 25, { timeout: 45000 });
  state = await page.evaluate(() => window.__globeDebug());
  assert(
    state.previewEntities >= 225 && state.spacePreviewEntities === 25,
    `${name}: Show all did not draw the Earth and space routes`,
  );
  assert(
    (await page.locator("#journey-list .route-item").count()) === 225,
    `${name}: Show all list is incomplete`,
  );
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${outputDir}/${name}-all.png` });
  if (name === "mobile") {
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      canvas: document
        .querySelector("#cesium-container canvas")
        .getBoundingClientRect().height,
    }));
    assert(layout.width <= layout.viewport + 1, "mobile: horizontal overflow");
    assert(layout.canvas > 220, "mobile: globe has too little height");
  }
  assert(errors.length === 0, `${name}: page errors: ${errors.join("; ")}`);
  console.log(
    `${name}: globe render, categories, search, lazy full route, and Show all passed`,
  );
  await page.close();
}

async function testModeSwitch(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(
    `${baseUrl}/index.html?domain=overland&journey=donner-party-1846&basemap=atlas`,
    { waitUntil: "domcontentloaded" },
  );
  await dismissSplash(page);
  await page.locator('#detail-card h2').filter({ hasText: "Donner" }).waitFor();
  await page.locator("#open-globe").click();
  await page.waitForURL((url) =>
    url.pathname.endsWith("/globe.html") &&
    url.searchParams.get("domain") === "overland" &&
    url.searchParams.get("journey") === "donner-party-1846",
  );
  await page.waitForFunction(
    () => window.__globeDebug?.().selectedEntities > 0,
    { timeout: 45000 },
  );
  await assertDetailImage(page, "2D-to-3D switch");
  await page.locator("#open-map").click();
  await page.waitForURL((url) =>
    url.pathname.endsWith("/index.html") &&
    url.searchParams.get("domain") === "overland" &&
    url.searchParams.get("journey") === "donner-party-1846",
  );
  await page.locator('#detail-card h2').filter({ hasText: "Donner" }).waitFor();
  console.log("2D/3D switch preserves category and selected route");
  await page.close();

  const spaceEntry = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await spaceEntry.goto(`${baseUrl}/index.html?basemap=atlas`, { waitUntil: "domcontentloaded" });
  await dismissSplash(spaceEntry);
  await spaceEntry.locator("#tab-space").click();
  await spaceEntry.waitForURL((url) => url.pathname.endsWith("/globe.html") && url.searchParams.get("domain") === "space");
  await spaceEntry.waitForFunction(() => window.__globeDebug?.().ready && window.__globeDebug().domain === "space", { timeout: 45000 });
  assert((await spaceEntry.locator("#journey-list .route-item").count()) === 25, "2D Space tab did not open 25 globe missions");
  await spaceEntry.close();
}

async function testSpaceMobile(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/globe.html?domain=space&journey=apollo-11`, { waitUntil: "domcontentloaded" });
  await dismissSplash(page);
  await page.waitForFunction(() => window.__globeDebug?.().selectedEntities > 0, { timeout: 45000 });
  await page.waitForTimeout(1600);
  const card = await page.locator("#detail").boundingBox();
  assert(card && card.height <= 75, `mobile space card is too tall (${card?.height})`);
  await page.screenshot({ path: `${outputDir}/space-mobile-peek.png` });
  await page.locator("#detail .sheet-handle").click();
  assert((await page.locator("#detail .sheet-handle").getAttribute("aria-expanded")) === "true", "mobile space card did not expand");
  await page.screenshot({ path: `${outputDir}/space-mobile-expanded.png` });
  await page.close();
}

async function testAllSpaceMissions(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/globe.html?domain=space`, { waitUntil: "domcontentloaded" });
  await dismissSplash(page);
  await page.waitForFunction(() => window.__globeDebug?.().ready && window.__globeDebug().domain === "space", { timeout: 45000 });
  const missions = await page.evaluate(async () => (await (await fetch("spaceflight/index.json")).json()).missions);
  for (const mission of missions) {
    await page.locator(`#journey-list .route-item[data-id="${mission.id}"]`).click();
    await page.waitForFunction((id) => {
      const state = window.__globeDebug();
      return state.selectedId === id && (state.selectedEntities > 0 || document.querySelector("#status")?.textContent.startsWith("Could not"));
    }, mission.id, { timeout: 45000 });
    const state = await page.evaluate(() => window.__globeDebug());
    assert(state.selectedEntities > 0 && state.selectedInvalidVertices === 0 && state.selectedVertices >= mission.point_count &&
      state.spaceMarkerEntities === 1 && state.spaceMarkerGrounded &&
      state.spaceLabelHeightMeters > 29_000 && state.spaceLabelHeightMeters < 31_000 && state.spaceLabelOffsetY < 0,
      `${mission.id}: invalid 3D route: ${JSON.stringify(state)}; ${await page.locator("#status").innerText()}`);
    assert((await page.locator("#detail .wiki-logo-link").count()) === 1, `${mission.id}: missing Wikipedia link`);
  }
  assert(errors.length === 0, `space mission page errors: ${errors.join("; ")}`);
  await page.close();
  console.log("all 25 space missions load finite 3D geometry and linked cards");
}

async function testShowAllHighlight(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/globe.html?domain=all&journey=apollo-11`, { waitUntil: "domcontentloaded" });
  await dismissSplash(page);
  await page.waitForFunction(() => {
    const state = window.__globeDebug?.();
    return state?.selectedEntities > 0 && state.spacePreviewEntities >= 24;
  }, { timeout: 45000 });
  const state = await page.evaluate(() => window.__globeDebug());
  assert(state.selectedDrawnAfterPreviews && state.selectedOutlined && state.previewSelectedEntities === 0,
    "Show all: late preview loading buried or duplicated the highlighted Apollo 11 path");
  await page.waitForTimeout(1100);
  const screenshot = await page.screenshot({ path: `${outputDir}/show-all-apollo-highlight.png` });
  const pixels = await countScreenshotColor(page, screenshot, [230, 189, 255], 390);
  assert(pixels > 80, `Show all: Apollo 11 highlight is not visibly distinguishable on the map (${pixels} pixels)`);
  await page.close();
  console.log("Show all keeps the selected space route visually on top");
}

async function testAltitudeExtremes(browser) {
  const cases = [
    { id: "sr71-coast-to-coast-record", search: "SR-71", min: 24000, max: 24500, file: "high-altitude-sr71" },
    { id: "wright-first-flight", search: "Wright", min: 4.9, max: 5.1, file: "low-altitude-wright" },
  ];
  for (const flight of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`${baseUrl}/globe.html?journey=${flight.id}`, { waitUntil: "domcontentloaded" });
    await dismissSplash(page);
    await page.waitForFunction(() => window.__globeDebug?.().selectedEntities > 0, { timeout: 45000 });
    const state = await page.evaluate(() => window.__globeDebug());
    assert(
      state.selectedMaximumHeightMeters >= flight.min && state.selectedMaximumHeightMeters <= flight.max &&
      state.previewSelectedEntities === 0 && state.depthTestAgainstTerrain,
      `${flight.id}: 3D height, duplicate preview, or globe occlusion is wrong: ${JSON.stringify(state)}`,
    );
    await page.locator("#journey-search").fill(flight.search);
    await page.waitForTimeout(1500);
    const screenshot = await page.screenshot({ path: `${outputDir}/${flight.file}.png` });
    if (flight.id === "wright-first-flight") {
      const cardRight = await page.locator("#detail").evaluate((card) => Math.ceil(card.getBoundingClientRect().right));
      const paintedPixels = await countScreenshotColor(page, screenshot, [255, 93, 93], cardRight + 5);
      assert(paintedPixels > 40, `Wright Flyer: selected line is hidden behind the info card (${paintedPixels} visible pixels)`);
    }
    await page.close();
  }
  console.log("high- and low-altitude flight rendering passed");
}

async function testBellPreviewAndSpace(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/globe.html`, { waitUntil: "domcontentloaded" });
  await dismissSplash(page);
  await page.waitForFunction(() => window.__globeDebug?.().ready);
  const previewVertices = (await page.evaluate(() => window.__globeDebug())).bellPreviewVertices;
  assert(previewVertices >= 175, `Bell X-1 preview has only ${previewVertices} points`);
  await page.locator('#journey-list .route-item[data-id="bell-x1-sound-barrier"]').click();
  await page.waitForFunction(() => window.__globeDebug().selectedEntities > 0);
  const selected = await page.evaluate(() => window.__globeDebug());
  assert(selected.selectedVertices === previewVertices, "Bell X-1 preview and selected paths have different geometry");
  await page.screenshot({ path: `${outputDir}/bell-x1-full-preview-match.png` });

  await page.locator('#categories button[data-domain="space"]').click();
  assert((await page.locator("#journey-list .route-item").count()) === 25, "Space category is not populated");
  await page.locator("#home-button").click();
  await page.waitForFunction(() => {
    const state = window.__globeDebug();
    return Math.hypot(...state.cameraPosition.map((value, i) => value - state.wholeEarthCameraPosition[i])) < 100;
  }, null, { timeout: 10000 });
  const homePosition = (await page.evaluate(() => window.__globeDebug())).cameraPosition;
  await page.locator("#zoom-out-button").click();
  const zoomedPosition = (await page.evaluate(() => window.__globeDebug())).cameraPosition;
  assert(Math.hypot(...zoomedPosition) > Math.hypot(...homePosition) * 1.2, "Cesium zoom-out control did not move the camera");
  await page.locator('#journey-list .route-item[data-id="apollo-11"]').click();
  await page.waitForFunction(() => window.__globeDebug().selectedEntities > 0 || document.querySelector("#status")?.textContent.startsWith("Could not"), { timeout: 45000 });
  assert((await page.evaluate(() => window.__globeDebug())).selectedEntities > 0, `Apollo 11: ${await page.locator("#status").innerText()}`);
  let state = await page.evaluate(() => window.__globeDebug());
  assert(state.selectedVertices >= 250 && state.selectedMaximumHeightMeters > 300_000_000, `Apollo 11 3D route did not render: ${JSON.stringify(state)}`);
  assert(state.selectedDrawnAfterPreviews && state.selectedOutlined && state.selectedWidths.every((width) => width >= 7),
    "Apollo 11 is not highlighted above the background routes");
  await page.waitForFunction(() => {
    const state = window.__globeDebug();
    return Math.hypot(...state.cameraPosition.map((value, i) => value - state.wholeEarthCameraPosition[i])) < 100;
  }, null, { timeout: 10000 });
  state = await page.evaluate(() => window.__globeDebug());
  assert(Math.hypot(...state.cameraPosition.map((value, i) => value - homePosition[i])) < 100,
    `Space selection did not return to the Whole Earth view: ${JSON.stringify(state.cameraPosition)}`);
  assert(state.spaceMarkerEntities === 1 && state.spaceMarkerGrounded &&
    state.spaceLabelHeightMeters > 29_000 && state.spaceLabelHeightMeters < 31_000 && state.spaceLabelOffsetY < 0,
    `Apollo 11 has duplicate or ungrounded launch markers: ${JSON.stringify(state)}`);
  assert(state.spaceMarkerLabel === "Earth / Kennedy Space Center", `Apollo 11 launch-site marker is mislabeled: ${state.spaceMarkerLabel}`);
  assert(await page.locator("#detail .why-famous").isVisible(), "Space mission card is missing");
  assert((await page.locator('#detail .wiki-logo-link[href^="https://en.wikipedia.org/wiki/"]').count()) === 1, "Space Wikipedia link is missing");
  assert((await page.locator('#detail a[download][href$=".json"]').count()) === 1, "Space 3D JSON download is missing");
  const apolloImage = await page.screenshot({ path: `${outputDir}/apollo-11-3d.png` });
  assert((await countScreenshotColor(page, apolloImage, [230, 189, 255], 390)) > 80, "Apollo 11 trajectory is not visibly painted at Whole Earth scale");
  await page.locator('#journey-list .route-item[data-id="sts-1"]').click();
  await page.waitForFunction(() => window.__globeDebug().selectedId === "sts-1" && window.__globeDebug().selectedEntities > 0);
  state = await page.evaluate(() => window.__globeDebug());
  assert(state.spaceMarkerEntities === 1 && state.spaceMarkerGrounded &&
    state.spaceLabelHeightMeters > 29_000 && state.spaceLabelHeightMeters < 31_000 && state.spaceLabelOffsetY < 0,
    `switching space routes left duplicate launch markers: ${JSON.stringify(state)}`);
  await page.screenshot({ path: `${outputDir}/sts-1-whole-earth.png` });
  await page.locator("#detail").evaluate((card) => { card.style.display = "none"; });
  const stsImage = await page.screenshot({ path: `${outputDir}/sts-1-unobstructed.png` });
  assert((await countScreenshotColor(page, stsImage, [255, 199, 139], 390)) > 80,
    "STS-1 orbit is not visibly painted on the globe");
  await page.locator("#detail").evaluate((card) => { card.style.removeProperty("display"); });
  await page.locator('#journey-list .route-item[data-id="sts-1"] .route-toggle').uncheck();
  assert((await page.evaluate(() => window.__globeDebug())).selectedEntities === 0, "Space visibility toggle failed");
  await page.locator('#journey-list .route-item[data-id="voyager-1"]').click();
  await page.waitForFunction(() => window.__globeDebug().selectedEntities > 0, { timeout: 45000 });
  state = await page.evaluate(() => window.__globeDebug());
  assert(state.selectedVertices > 1000, "Voyager deep-space trajectory is missing");
  assert(state.logDepthBuffer && state.cameraFarMeters > state.selectedMaximumHeightMeters * 1.5,
    `Voyager display path exceeds Cesium's viewing range: ${JSON.stringify(state)}`);
  await page.waitForTimeout(1600);
  const voyagerImage = await page.screenshot({ path: `${outputDir}/voyager-1-3d.png` });
  const voyagerPixels = await countScreenshotColor(page, voyagerImage, [158, 212, 255], 390);
  assert(voyagerPixels > 80, `Voyager 1 trajectory is not visibly painted at Whole Earth scale (${voyagerPixels} pixels; ${JSON.stringify(await page.evaluate(() => window.__globeDebug()))})`);
  await page.locator('#journey-list .route-item[data-id="chandrayaan-3"]').click();
  await page.waitForFunction(() => window.__globeDebug().selectedId === "chandrayaan-3" && window.__globeDebug().selectedEntities > 0);
  await page.locator("#detail").evaluate((card) => { card.style.display = "none"; });
  await page.screenshot({ path: `${outputDir}/chandrayaan-3-unobstructed.png` });
  await page.locator("#detail").evaluate((card) => { card.style.removeProperty("display"); });
  assert(errors.length === 0, `Space page errors: ${errors.join("; ")}`);
  await page.close();
  console.log("Bell X-1 preview geometry and space trajectories passed");
}

async function testSharedStyles(browser, name, viewport) {
  const snapshot = () => {
    const pick = (selector, properties) => {
      const element = document.querySelector(selector);
      const style = getComputedStyle(element);
      return Object.fromEntries(properties.map((property) => [property, style[property]]));
    };
    return {
      sidebar: pick(".sidebar", ["backgroundColor", "backgroundImage", "borderRightColor"]),
      sidebarWidth: Math.round(document.querySelector(".sidebar").getBoundingClientRect().width),
      title: pick(".brand h1", ["fontFamily", "fontSize", "fontWeight", "color"]),
      search: pick(".searchbox", ["height", "backgroundColor", "borderRadius"]),
      tab: pick('.domain-tabs button[data-domain="flights"]', ["fontSize", "padding", "backgroundColor", "borderRadius"]),
      route: pick('.route-item[data-id="lindbergh-spirit-of-st-louis"]', ["minHeight", "padding", "borderRadius", "backgroundColor"]),
      card: pick(".detail-card", ["width", "height", "backgroundColor", "borderRadius", "padding"]),
      cardTitle: pick(".detail-card h2", ["fontFamily", "fontSize", "lineHeight"]),
    };
  };
  const mapPage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await mapPage.goto(`${baseUrl}/index.html?journey=lindbergh-spirit-of-st-louis&basemap=atlas`, { waitUntil: "domcontentloaded" });
  await dismissSplash(mapPage);
  await mapPage.locator("#detail-card:not(.empty) h2").waitFor();
  const mapStyles = await mapPage.evaluate(snapshot);
  await mapPage.close();

  const globePage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await globePage.goto(`${baseUrl}/globe.html?journey=lindbergh-spirit-of-st-louis`, { waitUntil: "domcontentloaded" });
  await dismissSplash(globePage);
  await globePage.waitForFunction(() => window.__globeDebug?.().selectedEntities > 0);
  const globeStyles = await globePage.evaluate(snapshot);
  await globePage.close();
  assert(
    JSON.stringify(mapStyles) === JSON.stringify(globeStyles),
    `${name}: 2D and 3D sidebar/card styles differ:\n2D ${JSON.stringify(mapStyles)}\n3D ${JSON.stringify(globeStyles)}`,
  );
  console.log(`${name}: sidebar and detail-card styling matches 2D`);
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-webgl",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--disable-web-security",
    ],
  });
  try {
    if (highlightOnly) {
      await testShowAllHighlight(browser);
      return;
    }
    if (chandrayaanOnly) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${baseUrl}/globe.html?domain=space&journey=chandrayaan-3`, { waitUntil: "domcontentloaded" });
      await dismissSplash(page);
      await page.waitForFunction(() => window.__globeDebug?.().selectedEntities > 0, { timeout: 45000 });
      await page.waitForTimeout(1400);
      await page.locator("#detail").evaluate((card) => { card.style.display = "none"; });
      await page.screenshot({ path: `${outputDir}/chandrayaan-3-unobstructed.png` });
      console.log(JSON.stringify(await page.evaluate(() => window.__globeDebug())));
      await page.close();
      return;
    }
    if (spaceMobileOnly) {
      await testSpaceMobile(browser);
      return;
    }
    if (spaceAll) {
      await testAllSpaceMissions(browser);
      return;
    }
    if (spaceOnly) {
      await testBellPreviewAndSpace(browser);
      return;
    }
    await runCase(browser, "desktop", { width: 1440, height: 900 });
    await runCase(browser, "mobile", { width: 390, height: 844 });
    await testAltitudeExtremes(browser);
    await testBellPreviewAndSpace(browser);
    await testShowAllHighlight(browser);
    await testSpaceMobile(browser);
    await testModeSwitch(browser);
    await testSharedStyles(browser, "desktop", { width: 1440, height: 900 });
    await testSharedStyles(browser, "mobile", { width: 390, height: 844 });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
