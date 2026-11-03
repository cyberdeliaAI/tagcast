// Browser regression for translated album actions. Run against the local mock library:
//   node selection-layout.cjs <mock-tagcast-url> <output-directory>
// Uses the same Playwright setup as text-scan.cjs; no production dependency is added.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");

async function main() {
  const [url, output] = process.argv.slice(2);
  assert.ok(url && output, "Provide the mock Tagcast URL and an output directory");
  const origin = new URL(url);
  assert.ok(origin.protocol === "http:" && origin.hostname === "127.0.0.1", "Use a loopback mock server");
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({chromiumSandbox: true,
    ...(process.env.TAGCAST_CHROMIUM_EXECUTABLE ? {executablePath: process.env.TAGCAST_CHROMIUM_EXECUTABLE} : {})});
  const results = [], errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.on("pageerror", error => errors.push(error.message));
    // This test only reads fixtures and changes browser-local presentation.
    await page.route("**/*", route => {
      const request = route.request(), target = new URL(request.url());
      return target.origin === origin.origin && request.method() === "GET" ? route.continue() : route.abort();
    });
    await page.goto(url, {waitUntil: "load"});
    await page.waitForFunction(() => typeof state !== "undefined" && state.mode === "live" && !state.loading);
    await page.evaluate(() => { location.hash = "#/albums"; });
    await page.waitForFunction(() => state.screen === "albums");
    await page.evaluate(() => {
      if (!state.albums.some(album => album.id === "72") || !state.albums.some(album => album.id === "73")) {
        throw new Error("Use tests/mock_ibroadcast.py with albums 72 and 73");
      }
      state.selected = new Set(["72", "73"]);
    });
    for (const language of ["en", "nl", "de", "fr", "es", "ja"]) {
      await page.evaluate(language => TagcastI18n.use(language), language);
      for (const width of [420, 760, 761, 1280]) for (const mode of ["light", "dark"]) {
        await page.setViewportSize({width, height: 900});
        await page.evaluate(mode => { localStorage.setItem("tagcast-theme", mode); document.documentElement.dataset.theme = mode; }, mode);
        for (const filtered of [false, true]) {
          const name = `${language}-${width}-${mode}${filtered ? "-outside-results" : ""}`;
          await page.evaluate(filtered => { $("#search").value = filtered ? "Hounds" : ""; render(); }, filtered);
          await page.evaluate(() => document.fonts.ready);
          const metrics = await page.evaluate(() => {
            const bar = document.querySelector("#selection-bar"), count = document.querySelector("#selection-count");
            const bounds = element => { const r = element.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; };
            const countStyle = getComputedStyle(count);
            return {bar: bounds(bar), count: {...bounds(count), lineHeight: parseFloat(countStyle.lineHeight) || parseFloat(countStyle.fontSize) * 1.2},
              actions: [...bar.querySelectorAll("button:not([hidden])")].map(button => ({id: button.id, ...bounds(button),
                clipped: button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1}))};
          });
          let failure = "";
          try {
            assert.ok(metrics.actions.some(action => action.id === "download-selection"), "Download action must be present");
            assert.ok(metrics.actions.some(action => action.id === "trash-selection"), "Trash action must be present");
            for (const action of metrics.actions) {
              assert.ok(action.left >= metrics.bar.left && action.right <= Math.min(width, metrics.bar.right) + 1, `${action.id} extends outside the bar`);
              assert.ok(action.top >= metrics.bar.top && action.bottom <= metrics.bar.bottom + 1, `${action.id} extends vertically outside the bar`);
              assert.equal(action.clipped, false, `${action.id} clips its label`);
            }
            assert.ok(metrics.count.bottom - metrics.count.top <= metrics.count.lineHeight * 4, "Selection count is squeezed into too many lines");
            await page.locator("#clear-selection").focus();
            for (const action of metrics.actions.slice(1)) {
              await page.keyboard.press("Tab");
              assert.equal(await page.evaluate(() => document.activeElement.id), action.id, "Action tab order changed");
            }
          } catch (error) { failure = error.message; }
          await page.screenshot({path: path.join(output, name + ".png")});
          results.push({name, language, width, mode, filtered, ...metrics, failure});
        }
      }
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({results, errors}, null, 2));
  }
  assert.deepEqual(errors, [], "Unexpected browser errors");
  const failures = results.filter(result => result.failure);
  console.log(`${results.length} layout cases; ${failures.length} failures`);
  assert.deepEqual(failures.map(result => ({name: result.name, failure: result.failure})), []);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
