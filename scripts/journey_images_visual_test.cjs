#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const outputDir = process.argv[3] || "/tmp/vibe-flights-journey-images";
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data/journey-images.json"), "utf8"));
const domains = ["sailing", "rail", "road-races", "overland", "ocean-liners", "river", "human-powered"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function inspectImage(page, id, metadata, context) {
  await page.locator(`.route-item[data-id="${id}"]`).click();
  const figure = page.locator("#detail-card .journey-figure");
  await figure.locator("img").waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const image = document.querySelector("#detail-card .journey-figure img");
    return image?.complete && image.naturalWidth > 0;
  });
  assert(await figure.locator("img").getAttribute("src") === metadata.path, `${context}: incorrect image for ${id}`);
  assert(await figure.locator("img").getAttribute("alt") === metadata.alt, `${context}: missing image description for ${id}`);
  assert(await figure.locator(".image-credit").getAttribute("href") === metadata.source_url, `${context}: wrong Commons source for ${id}`);
  assert((await figure.locator(".image-credit").textContent()).includes("resized for display"), `${context}: image adaptation is not disclosed for ${id}`);
  assert(await figure.locator("figcaption a").last().getAttribute("href") === metadata.license_url, `${context}: wrong license link for ${id}`);
  const pixels = await figure.locator("img").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert(pixels.width >= 1000 && pixels.height >= 600, `${context}: image resolution too low for ${id}`);
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  assert(Object.keys(catalog).length === 175, "expected an image for all 175 nonflight journeys");
  const domainIds = new Map();
  for (const domain of domains) {
    const geojson = JSON.parse(fs.readFileSync(path.join(root, `data/journeys/${domain}.geojson`), "utf8"));
    domainIds.set(domain, new Set(geojson.features.map((feature) => feature.properties.id)));
  }
  for (const [id, metadata] of Object.entries(catalog)) {
    assert(domains.some((domain) => domainIds.get(domain).has(id)), `image ${id} has no mapped nonflight journey`);
    assert(fs.existsSync(path.join(root, metadata.path)), `missing local image ${metadata.path}`);
    assert(metadata.source_url.startsWith("https://commons.wikimedia.org/wiki/File:"), `missing Commons source for ${id}`);
    assert(/^https:\/\/(creativecommons\.org|www\.flickr\.com)\//.test(metadata.license_url), `missing reuse-terms link for ${id}`);
  }
  for (const [domain, ids] of domainIds) {
    for (const id of ids) assert(catalog[id], `${domain} journey ${id} has no image`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.route("https://static.cloudflareinsights.com/**", (route) => route.abort());
    await desktop.goto(`${baseUrl}/?basemap=atlas`);
    await desktop.waitForFunction(() => window.__atlasReady === true);
    for (const domain of domains) {
      await desktop.locator(`#tab-${domain}`).click();
      await desktop.waitForFunction((count) => document.querySelectorAll(".route-item").length === count, domainIds.get(domain).size);
      const entries = Object.entries(catalog).filter(([id]) => domainIds.get(domain).has(id));
      assert(entries.length === domainIds.get(domain).size, `not all ${domain} journeys have images`);
      for (const [id, metadata] of entries) await inspectImage(desktop, id, metadata, `desktop ${domain}`);
      await desktop.screenshot({ path: path.join(outputDir, `desktop-${domain}.png`) });
    }
    await desktop.close();

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await phone.route("https://static.cloudflareinsights.com/**", (route) => route.abort());
    await phone.goto(`${baseUrl}/?basemap=atlas`);
    await phone.waitForFunction(() => window.__atlasReady === true);
    for (const domain of domains) {
      await phone.locator(`#tab-${domain}`).click();
      await phone.waitForFunction((count) => document.querySelectorAll(".route-item").length === count, domainIds.get(domain).size);
      const [id, metadata] = Object.entries(catalog).find(([routeId]) => domainIds.get(domain).has(routeId));
      await inspectImage(phone, id, metadata, `phone ${domain}`);
      await phone.locator(".sheet-handle").click();
      await phone.locator(".journey-figure").scrollIntoViewIfNeeded();
      assert(await phone.locator(".journey-figure").isVisible(), `phone ${domain}: image is hidden`);
      await phone.screenshot({ path: path.join(outputDir, `phone-${domain}.png`) });
    }
    await phone.close();
    console.log(`PASS: ${Object.keys(catalog).length} sourced images render on desktop; all seven domains render on phone`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
