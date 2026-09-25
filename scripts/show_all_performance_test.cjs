#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const outputDir = process.argv[3] || "/tmp/vibe-flights-show-all-performance";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.route("https://static.cloudflareinsights.com/**", (route) => route.abort());
    const requestedDomains = [];
    page.on("request", (request) => {
      if (request.url().includes("/data/journeys/") && request.url().includes(".geojson")) requestedDomains.push(request.url());
    });
    await page.goto(`${baseUrl}/?basemap=atlas`);
    if (await page.locator("#welcome-splash").isVisible()) await page.locator("#welcome-continue").click();
    await page.waitForFunction(() => window.__atlasReady === true);
    const started = Date.now();
    await page.locator("#tab-all").click();
    await page.waitForFunction(() => Number(document.body.dataset.mapRouteCount) === 200);
    const overviewLoadMs = Date.now() - started;
    assert(requestedDomains.length === 0, `Show all eagerly loaded ${requestedDomains.length} full domain collections`);
    const sourceVertices = await page.evaluate(async () => {
      const preview = await fetch("data/all-overview.geojson").then((response) => response.json());
      return preview.features.reduce((total, feature) => total + feature.properties.vertex_count, 0);
    });
    const overviewVertices = Number(await page.locator("body").getAttribute("data-map-display-vertices"));
    assert(overviewVertices > 0 && overviewVertices < sourceVertices / 10, `Show all used too many display vertices: ${overviewVertices}/${sourceVertices}`);
    const before = await page.screenshot({ path: `${outputDir}/overview.png` });
    const canvas = page.locator("#map-canvas");
    const box = await canvas.boundingBox();
    const startX = box.x + box.width * 0.6;
    const startY = box.y + box.height * 0.55;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 160, startY + 70, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = await page.screenshot({ path: `${outputDir}/after-pan.png` });
    assert(!before.equals(after), "Panning did not visibly change the map");
    const panRenderMs = Number(await page.locator("body").getAttribute("data-map-render-ms"));
    assert(Number.isFinite(panRenderMs), "No map render timing was recorded");
    await page.locator('.route-item[data-id="rail-tokaido-1964"]').click();
    await page.waitForFunction(() => document.body.dataset.fullGeometryRoute === "rail-tokaido-1964");
    assert(requestedDomains.length === 1 && requestedDomains[0].includes("/rail.geojson"), "Selecting a preview did not load only its complete domain");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator(".download-geojson").click(),
    ]);
    const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    const lines = exported.geometry.type === "LineString" ? [exported.geometry.coordinates] : exported.geometry.coordinates;
    assert(lines.reduce((total, line) => total + line.length, 0) === exported.properties.vertex_count, "Show all exported simplified geometry instead of the complete route");
    process.stdout.write(`PASS: Show all loaded in ${overviewLoadMs} ms without full domains, drew ${overviewVertices.toLocaleString()} of ${sourceVertices.toLocaleString()} source vertices; pan ${panRenderMs.toFixed(1)} ms; full route loaded on selection; screenshots ${outputDir}\n`);
    await page.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
