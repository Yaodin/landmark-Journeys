#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = (process.argv[2] || "http://127.0.0.1:8765").replace(/\/$/, "");
const outputDir = process.argv[3] || "/tmp/vibe-flights-domain-tabs";
const requireAllMapped = process.argv.includes("--all-mapped");
const domains = ["flights", "sailing", "rail", "road-races", "overland", "ocean-liners", "river", "human-powered"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function selectedRoutePixels(page, color = [255, 159, 67]) {
  return page.evaluate((expected) => {
    const canvas = document.querySelector("#map-canvas");
    const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (Math.max(...expected.map((value, channel) => Math.abs(data[index + channel] - value))) <= 20) count++;
    }
    return count;
  }, color);
}

async function runCase(browser, name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/?basemap=atlas`);
  await page.waitForFunction(() => window.__atlasReady === true);
  const tabs = page.locator('.domain-tabs [role="tab"]');
  assert(await tabs.count() === domains.length, `${name}: expected eight domain tabs`);
  const tabLayout = await page.locator(".domain-tabs").evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    const buttons = [...container.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return {
      scrollWidth: container.scrollWidth,
      clientWidth: container.clientWidth,
      bounds: { left: bounds.left, right: bounds.right },
      buttons: buttons.map((rect) => ({ left: rect.left, right: rect.right, top: rect.top })),
    };
  });
  assert(tabLayout.scrollWidth <= tabLayout.clientWidth + 1, `${name}: domain tabs still scroll horizontally`);
  assert(tabLayout.buttons.every((button) => button.left >= tabLayout.bounds.left - 1 && button.right <= tabLayout.bounds.right + 1), `${name}: a domain tab is clipped`);
  assert(new Set(tabLayout.buttons.map((button) => Math.round(button.top))).size > 1, `${name}: domain tabs did not wrap into rows`);
  assert(await page.locator('#tab-flights').getAttribute("aria-selected") === "true", `${name}: flights should be selected by default`);
  assert(await page.locator(".route-item").count() === 25, `${name}: default flights are missing`);
  assert(await page.locator(".summary, .button-row").count() === 0, `${name}: old controls remain`);
  await page.locator('[data-id="lindbergh-spirit-of-st-louis"]').click();
  await page.waitForTimeout(250);
  assert(await selectedRoutePixels(page) > 100, `${name}: selected flight is not painted`);

  for (const domain of domains.slice(1)) {
    const tab = page.locator(`#tab-${domain}`);
    await tab.click();
    await page.waitForFunction(() => document.querySelectorAll(".route-item").length === 25 || document.querySelectorAll(".research-candidate").length === 25);
    await page.waitForTimeout(80);
    assert(await tab.getAttribute("aria-selected") === "true", `${name}: ${domain} tab is not selected`);
    if (await page.locator(".route-item").count() === 25) {
      assert(await page.locator("#collection-status").isHidden(), `${name}: ${domain} mapped routes have a research overlay`);
      const first = page.locator(".route-item").first();
      const firstId = await first.getAttribute("data-id");
      await first.click();
      await page.waitForFunction((id) => document.body.dataset.fitRoute === id, firstId);
      await page.waitForTimeout(100);
      assert(await page.locator("#detail-card").isVisible(), `${name}: ${domain} detail card did not open`);
      assert(await page.locator(".detail-actions a[download]").count() === 1, `${name}: ${domain} WKT link is missing`);
      assert(await selectedRoutePixels(page, [249, 115, 115]) > 80, `${name}: ${domain} selected route is not painted`);
      if (domain === "rail") {
        await page.locator('.route-item[data-id="rail-tokaido-1964"]').click();
        assert(await page.locator('.waypoints li[data-line-style="anchored"]').count() === 1, `${name}: source-derived rail segment should be solid`);
        await page.locator('.route-item[data-id="rail-transcontinental-1869"]').click();
        assert(await page.locator('.waypoints li[data-line-style="anchored"]').count() === 2, `${name}: medium-confidence historical rail corridor should be solid`);
        await page.locator('.route-item[data-id="rail-suffrage-special-1916"]').click();
        assert(await page.locator('.waypoints li[data-line-style="inferred"]').count() === 2, `${name}: waypoint-interpolated rail segments should be dashed`);
      }
      await page.screenshot({ path: `${outputDir}/${name}-${domain}.png` });
    } else {
      assert(!requireAllMapped, `${name}: ${domain} still has no generated geometry`);
      assert(await page.locator(".research-candidate").count() === 25, `${name}: ${domain} research list is incomplete`);
      assert(await page.locator("#collection-status").isVisible(), `${name}: ${domain} status is not visible`);
      assert(await page.locator("#detail-card").isHidden(), `${name}: empty flight card remained visible in ${domain}`);
      assert(await page.locator(".legend").isHidden(), `${name}: flight legend remained visible in ${domain}`);
      assert(await selectedRoutePixels(page) < 100, `${name}: selected flight line leaked into ${domain}`);
    }
  }

  await page.screenshot({ path: `${outputDir}/${name}-human-powered.png` });
  await page.locator("#search").fill("Jason Lewis");
  const filtered = await page.locator(".route-item:visible, .research-candidate:visible").count();
  assert(filtered === 1, `${name}: domain search did not filter candidates`);
  await page.locator("#tab-flights").click();
  assert(await page.locator(".route-item").count() === 25, `${name}: flights were not restored`);
  assert(await page.locator("#collection-status").isHidden(), `${name}: research status remained on flights`);
  await page.screenshot({ path: `${outputDir}/${name}-flights.png` });
  await page.close();
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await runCase(browser, "desktop", { width: 1440, height: 900 });
    await runCase(browser, "phone", { width: 390, height: 844 });
    const narrow = await browser.newPage({ viewport: { width: 320, height: 700 } });
    await narrow.goto(`${baseUrl}/?basemap=atlas`);
    await narrow.waitForFunction(() => window.__atlasReady === true);
    const narrowTabs = await narrow.locator(".domain-tabs").evaluate((container) => ({
      scrollWidth: container.scrollWidth,
      clientWidth: container.clientWidth,
      tabCount: container.querySelectorAll('button[role="tab"]').length,
      rows: new Set([...container.querySelectorAll('button[role="tab"]')].map((button) => Math.round(button.getBoundingClientRect().top))).size,
    }));
    assert(narrowTabs.tabCount === 8 && narrowTabs.rows > 1 && narrowTabs.scrollWidth <= narrowTabs.clientWidth + 1, `narrow phone: tabs overflow or do not wrap: ${JSON.stringify(narrowTabs)}`);
    await narrow.screenshot({ path: `${outputDir}/narrow-phone-tabs.png` });
    await narrow.close();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/?basemap=atlas&domain=rail`);
    await page.waitForFunction(() => window.__atlasReady === true);
    assert(await page.locator("#tab-rail").getAttribute("aria-selected") === "true", "deep link did not select rail");
    await page.close();
    process.stdout.write(`PASS: eight tabs, rendered map state, desktop and phone screenshots (${outputDir})\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
