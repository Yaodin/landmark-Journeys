#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const outputDir = process.argv[3] || "/tmp/landmark-splash-test";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkSplash(page, name, viewport) {
  const dialog = page.locator("#welcome-splash");
  await dialog.waitFor({ state: "visible" });
  const content = await dialog.innerText();
  for (const phrase of ["generative AI", "researched", "sources", "interpolate", "may or may not be accurate", "entertainment only"]) {
    assert(content.includes(phrase), `${name}: notice is missing “${phrase}”`);
  }
  const bounds = await dialog.boundingBox();
  assert(bounds && bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= viewport.width - 8 && bounds.y + bounds.height <= viewport.height - 8,
    `${name}: splash is outside the viewport: ${JSON.stringify(bounds)}`);
  assert(await page.locator("#welcome-continue").evaluate((button) => document.activeElement === button),
    `${name}: continue button is not focused`);
  if (name === "small-phone") {
    const emblem = await page.locator(".welcome-emblem").boundingBox();
    const action = await page.locator("#welcome-continue").boundingBox();
    assert(emblem.y >= 0 && action.y + action.height <= viewport.height,
      `${name}: first screen must show both the heading and continue button`);
  }
  await page.screenshot({ path: `${outputDir}/${name}.png` });
  await page.locator("#welcome-continue").click();
  assert(await dialog.isHidden(), `${name}: splash did not close`);
  assert(await page.evaluate(() => sessionStorage.getItem("landmark-journeys-ai-notice-v1")) === "seen",
    `${name}: session dismissal was not saved`);
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }],
      ["small-phone", { width: 320, height: 568 }],
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      await context.route("https://static.cloudflareinsights.com/**", (route) => route.abort());
      const page = await context.newPage();
      await page.goto(`${baseUrl}/index.html?basemap=atlas`, { waitUntil: "domcontentloaded" });
      await checkSplash(page, name, viewport);
      await page.reload({ waitUntil: "domcontentloaded" });
      assert(await page.locator("#welcome-splash").isHidden(), `${name}: splash returned after reload in the same session`);
      await page.goto(`${baseUrl}/globe.html`, { waitUntil: "domcontentloaded" });
      assert(await page.locator("#welcome-splash").isHidden(), `${name}: switching to 3D repeated the splash`);
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("https://static.cloudflareinsights.com/**", (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`${baseUrl}/globe.html`, { waitUntil: "domcontentloaded" });
    await checkSplash(page, "fresh-session-globe", { width: 390, height: 844 });
    await context.close();
    console.log(`PASS: sourced AI notice opens in both views, fits desktop and phone, and dismisses for one browser session (${outputDir})`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
