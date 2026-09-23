#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const outputDir = process.argv[3] || "/tmp/vibe-flights-viewport-fit";

const cases = [
  { name: "desktop-lindbergh", viewport: { width: 1440, height: 900 }, route: "lindbergh-spirit-of-st-louis", polygonPoints: 6 },
  { name: "phone-lindbergh", viewport: { width: 390, height: 844 }, route: "lindbergh-spirit-of-st-louis", polygonPoints: 4 },
  { name: "phone-global", viewport: { width: 390, height: 844 }, route: "graf-zeppelin-world-flight", polygonPoints: 4 },
  { name: "landscape-global", viewport: { width: 844, height: 390 }, route: "graf-zeppelin-world-flight", polygonPoints: 6 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function inspectRoute(page, routeId, domain = "flights") {
  return page.evaluate(async ({ selectedId, domainName }) => {
    const canvas = document.querySelector("#map-canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const routeFile = domainName === "flights" ? "data/routes.geojson?v=smooth-routes-1" : `data/journeys/${domainName}.geojson?v=journey-1`;
    window.__viewportCollections ||= {};
    const collection = window.__viewportCollections[routeFile] ||= await fetch(routeFile).then((response) => response.json());
    const feature = collection.features.find((candidate) => candidate.properties.id === selectedId);
    const zoom = Number(document.body.dataset.fitZoom);
    const [centerLon, centerLat] = document.body.dataset.fitCenter.split(",").map(Number);
    const polygon = document.body.dataset.fitPolygon.split(" ").map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
    const dpr = window.devicePixelRatio || 1;
    const size = 256 * 2 ** zoom;
    const maxLat = 85.05112878;

    function project(lon, lat, maxLatitude = maxLat) {
      const safeLat = Math.max(-maxLatitude, Math.min(maxLatitude, lat));
      const sin = Math.sin(safeLat * Math.PI / 180);
      return {
        x: (lon + 180) / 360 * size,
        y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
      };
    }

    function inside(x, y) {
      let result = false;
      for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const a = polygon[index];
        const b = polygon[previous];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result;
      }
      return result;
    }

    const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const world = [];
    let shift = 0;
    let previousLon = null;
    for (const line of lines) {
      for (const [rawLon, lat] of line) {
        let lon = rawLon + shift;
        if (previousLon !== null) {
          while (lon - previousLon > 180) { shift -= 360; lon -= 360; }
          while (lon - previousLon < -180) { shift += 360; lon += 360; }
        }
        previousLon = lon;
        world.push(project(lon, lat));
      }
    }
    const center = project(centerLon, centerLat, 89.5);
    const meanX = world.reduce((sum, point) => sum + point.x, 0) / world.length;
    const copyShift = Math.round((center.x - meanX) / size) * size;
    const screen = world.map((point) => ({
      x: point.x + copyShift - center.x + canvas.clientWidth / 2,
      y: point.y - center.y + canvas.clientHeight / 2,
    }));
    const outside = screen.filter((point) => !inside(point.x, point.y));
    function canShift(dx, dy) {
      return screen.every((point) => inside(point.x + dx, point.y + dy));
    }

    function shiftAllowance(dx, dy) {
      let low = 0;
      let high = Math.max(canvas.clientWidth, canvas.clientHeight);
      for (let iteration = 0; iteration < 14; iteration += 1) {
        const distance = (low + high) / 2;
        if (canShift(dx * distance, dy * distance)) low = distance;
        else high = distance;
      }
      return low;
    }

    const shiftRoom = {
      left: shiftAllowance(-1, 0),
      right: shiftAllowance(1, 0),
      up: shiftAllowance(0, -1),
      down: shiftAllowance(0, 1),
    };
    const centerImbalance = Math.max(
      Math.abs(shiftRoom.left - shiftRoom.right),
      Math.abs(shiftRoom.up - shiftRoom.down),
    );

    const expected = feature.properties.color.match(/[a-f0-9]{2}/gi).map((part) => parseInt(part, 16));
    const inspectEvery = Math.max(1, Math.floor(screen.length / 180));
    const inspected = screen.filter((_, index) => index % inspectEvery === 0);
    let visualHits = 0;
    for (const point of inspected) {
      const radius = Math.ceil(6 * dpr);
      const centerX = Math.round(point.x * dpr);
      const centerY = Math.round(point.y * dpr);
      const x = Math.max(0, centerX - radius);
      const y = Math.max(0, centerY - radius);
      const width = Math.min(canvas.width - x, radius * 2 + 1);
      const height = Math.min(canvas.height - y, radius * 2 + 1);
      if (width <= 0 || height <= 0) continue;
      const pixels = context.getImageData(x, y, width, height).data;
      let found = false;
      for (let index = 0; index < pixels.length; index += 4) {
        if (Math.max(
          Math.abs(pixels[index] - expected[0]),
          Math.abs(pixels[index + 1] - expected[1]),
          Math.abs(pixels[index + 2] - expected[2]),
        ) <= 45) {
          found = true;
          break;
        }
      }
      if (found) visualHits += 1;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const cardRect = document.querySelector("#detail-card").getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      polygon,
      outside: outside.length,
      outsideSample: outside.slice(0, 3),
      totalPoints: screen.length,
      visualHits,
      inspected: inspected.length,
      fitMode: document.body.dataset.fitMode,
      fitRoute: document.body.dataset.fitRoute,
      fitZoom: zoom,
      fitCenter: [centerLon, centerLat],
      copyShift,
      fitCenterOffset: document.body.dataset.fitCenterOffset,
      centerImbalance,
      centerTolerance: Math.max(14, Math.min(canvas.clientWidth, canvas.clientHeight) * 0.045),
      shiftRoom,
      cardOverlap: {
        left: cardRect.left - canvasRect.left,
        top: cardRect.top - canvasRect.top,
        right: cardRect.right - canvasRect.left,
        bottom: cardRect.bottom - canvasRect.top,
      },
    };
  }, { selectedId: routeId, domainName: domain });
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const inspectOnly = process.argv.find((argument) => argument.startsWith("--inspect="))?.split("=", 2)[1];
    if (inspectOnly) {
      const domain = process.argv.find((argument) => argument.startsWith("--domain="))?.split("=", 2)[1] || "flights";
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.goto(`${baseUrl}/?basemap=atlas`, { waitUntil: "networkidle" });
      if (domain !== "flights") await page.locator(`[role="tab"][data-domain="${domain}"]`).click();
      await page.locator(`.route-item[data-id="${inspectOnly}"]`).click();
      await page.waitForFunction((route) => document.body.dataset.fitRoute === route, inspectOnly);
      await page.waitForTimeout(100);
      const result = await inspectRoute(page, inspectOnly, domain);
      console.log(JSON.stringify(result, null, 2));
      await page.screenshot({ path: path.join(outputDir, `inspect-${inspectOnly}.png`) });
      return;
    }
    for (const infoCase of [
      { name: "desktop-site-info", viewport: { width: 1440, height: 900 } },
      { name: "phone-site-info", viewport: { width: 390, height: 844 } },
    ]) {
      const context = await browser.newContext({ viewport: infoCase.viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/?basemap=atlas`, { waitUntil: "networkidle" });
      await page.locator("#site-info-open").click();
      await page.locator("#site-info[open]").waitFor();
      const info = await page.locator("#site-info").evaluate((dialog) => {
        const rect = dialog.getBoundingClientRect();
        return {
          open: dialog.open,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          sectionCount: dialog.querySelectorAll("section").length,
          text: dialog.textContent,
          github: dialog.querySelector('.site-info-footer a')?.href,
        };
      });
      assert(info.open, `${infoCase.name}: information dialog did not open`);
      assert(info.rect.left >= 8 && info.rect.top >= 8 && info.rect.right <= infoCase.viewport.width - 8 && info.rect.bottom <= infoCase.viewport.height - 8, `${infoCase.name}: dialog escapes viewport: ${JSON.stringify(info.rect)}`);
      assert(info.sectionCount === 4, `${infoCase.name}: expected four information sections`);
      for (const phrase of ["Route geometry and uncertainty", "Research sources", "Maps and photographs", "Data and access", "CC BY-SA 3.0"]) {
        assert(info.text.includes(phrase), `${infoCase.name}: missing information: ${phrase}`);
      }
      assert(info.github === "https://github.com/Yaodin/vibe-flights", `${infoCase.name}: repository link is missing or wrong`);
      await page.screenshot({ path: path.join(outputDir, `${infoCase.name}.png`) });
      await page.locator("#site-info-close").click();
      assert(await page.locator("#site-info").evaluate((dialog) => !dialog.open), `${infoCase.name}: close button did not close dialog`);
      console.log(`PASS ${infoCase.name}: info control opens four-section source and license panel inside viewport`);
      await context.close();
    }

    for (const testCase of cases) {
      const context = await browser.newContext({ viewport: testCase.viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/?basemap=atlas`, { waitUntil: "networkidle" });
      await page.locator(`.route-item[data-id="${testCase.route}"]`).click();
      await page.waitForFunction((route) => document.body.dataset.fitRoute === route, testCase.route);
      await page.waitForTimeout(150);
      const result = await inspectRoute(page, testCase.route);
      await page.screenshot({ path: path.join(outputDir, `${testCase.name}.png`) });

      assert(result.innerWidth === testCase.viewport.width, `${testCase.name}: viewport width is ${result.innerWidth}, expected ${testCase.viewport.width}`);
      assert(result.innerHeight === testCase.viewport.height, `${testCase.name}: viewport height is ${result.innerHeight}, expected ${testCase.viewport.height}`);
      assert(result.fitMode === "viewport-polygon", `${testCase.name}: polygon fitter did not run`);
      assert(result.fitRoute === testCase.route, `${testCase.name}: wrong route was fitted`);
      assert(result.polygon.length === testCase.polygonPoints, `${testCase.name}: expected ${testCase.polygonPoints}-point viewport polygon, got ${result.polygon.length}`);
      assert(result.outside === 0, `${testCase.name}: ${result.outside}/${result.totalPoints} track points fall outside the viewport polygon: ${JSON.stringify(result.outsideSample)}`);
      assert(result.centerImbalance <= result.centerTolerance, `${testCase.name}: opposing free-space imbalance is ${result.centerImbalance.toFixed(1)}px (limit ${result.centerTolerance.toFixed(1)}px): ${JSON.stringify(result.shiftRoom)}`);
      assert(result.visualHits >= result.inspected * 0.9, `${testCase.name}: only ${result.visualHits}/${result.inspected} sampled track locations contain route-colored pixels`);
      console.log(`PASS ${testCase.name}: ${result.totalPoints} points inside ${result.polygon.length}-point polygon; center imbalance ${result.centerImbalance.toFixed(1)}px; ${result.visualHits}/${result.inspected} visual pixel hits`);
      await context.close();
    }

    for (const layout of [
      { name: "desktop-all-routes", viewport: { width: 1440, height: 900 }, polygonPoints: 6 },
      { name: "phone-all-routes", viewport: { width: 390, height: 844 }, polygonPoints: 4 },
    ]) {
      const context = await browser.newContext({ viewport: layout.viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/?basemap=atlas`, { waitUntil: "networkidle" });
      const routeIds = await page.locator(".route-item").evaluateAll((items) => items.map((item) => item.dataset.id));
      for (const routeId of routeIds) {
        await page.locator(`.route-item[data-id="${routeId}"]`).click();
        await page.waitForFunction((route) => document.body.dataset.fitRoute === route, routeId);
        await page.waitForTimeout(40);
        const result = await inspectRoute(page, routeId);
        assert(result.fitMode === "viewport-polygon", `${layout.name}/${routeId}: polygon fitter did not run`);
        assert(result.polygon.length === layout.polygonPoints, `${layout.name}/${routeId}: wrong viewport polygon`);
        assert(result.outside === 0, `${layout.name}/${routeId}: ${result.outside}/${result.totalPoints} track points fall outside the viewport polygon`);
        assert(result.centerImbalance <= result.centerTolerance, `${layout.name}/${routeId}: opposing free-space imbalance is ${result.centerImbalance.toFixed(1)}px: ${JSON.stringify(result.shiftRoom)}`);
        assert(result.visualHits >= result.inspected * 0.75, `${layout.name}/${routeId}: only ${result.visualHits}/${result.inspected} sampled locations contain route-colored pixels`);
      }
      console.log(`PASS ${layout.name}: all ${routeIds.length} sidebar items fit geometrically and visually`);
      await context.close();
    }

    if (process.argv.includes("--journeys")) {
      const requestedDomain = process.argv.find((argument) => argument.startsWith("--domain="))?.split("=", 2)[1];
      const journeyDomains = ["sailing", "rail", "road-races", "overland", "ocean-liners", "river", "human-powered"];
      for (const domain of requestedDomain ? journeyDomains.filter((name) => name === requestedDomain) : journeyDomains) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.goto(`${baseUrl}/?basemap=atlas`, { waitUntil: "networkidle" });
        const mapped = await page.evaluate(async (name) => (await fetch(`data/journeys/${name}.geojson?v=journey-1`)).ok, domain);
        if (!mapped && !process.argv.includes("--all-mapped")) {
          console.log(`SKIP ${domain}: geometry not generated yet`);
          await context.close();
          continue;
        }
        assert(mapped, `${domain}: geometry not generated`);
        await page.locator(`[role="tab"][data-domain="${domain}"]`).click();
        await page.locator(".route-item").first().waitFor();
        const routeIds = await page.locator(".route-item").evaluateAll((items) => items.map((item) => item.dataset.id));
        assert(routeIds.length === 25, `${domain}: expected 25 mapped journeys, got ${routeIds.length}`);
        for (const routeId of routeIds) {
          await page.locator(`.route-item[data-id="${routeId}"]`).click();
          await page.waitForFunction((route) => document.body.dataset.fitRoute === route, routeId);
          await page.waitForTimeout(40);
          const result = await inspectRoute(page, routeId, domain);
          assert(result.fitMode === "viewport-polygon", `${domain}/${routeId}: polygon fitter did not run`);
          assert(result.polygon.length === 6, `${domain}/${routeId}: wrong viewport polygon`);
          assert(result.outside === 0, `${domain}/${routeId}: ${result.outside}/${result.totalPoints} points outside viewport polygon: ${JSON.stringify(result.outsideSample)}`);
          assert(result.centerImbalance <= result.centerTolerance, `${domain}/${routeId}: center imbalance ${result.centerImbalance.toFixed(1)}px`);
          assert(result.visualHits >= result.inspected * 0.55, `${domain}/${routeId}: only ${result.visualHits}/${result.inspected} route-colored pixel hits`);
        }
        await page.screenshot({ path: path.join(outputDir, `${domain}-all-routes.png`) });
        console.log(`PASS ${domain}: all ${routeIds.length} journeys fit and render visually`);
        await context.close();

        const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
        const phonePage = await phoneContext.newPage();
        await phonePage.goto(`${baseUrl}/?basemap=atlas&domain=${domain}`, { waitUntil: "networkidle" });
        const phoneRoute = routeIds.at(-1);
        await phonePage.locator(`.route-item[data-id="${phoneRoute}"]`).click();
        await phonePage.waitForFunction((route) => document.body.dataset.fitRoute === route, phoneRoute);
        await phonePage.waitForTimeout(100);
        const phoneResult = await inspectRoute(phonePage, phoneRoute, domain);
        assert(phoneResult.polygon.length === 4, `${domain}/phone: wrong viewport polygon`);
        assert(phoneResult.outside === 0, `${domain}/phone: ${phoneResult.outside}/${phoneResult.totalPoints} points outside viewport polygon`);
        assert(phoneResult.visualHits >= phoneResult.inspected * 0.55, `${domain}/phone: only ${phoneResult.visualHits}/${phoneResult.inspected} route-colored pixel hits`);
        await phonePage.screenshot({ path: path.join(outputDir, `${domain}-phone-route.png`) });
        console.log(`PASS ${domain}/phone: route ${phoneRoute} fits and renders above the card`);
        await phoneContext.close();
      }
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
