// Real-browser regression for translated sidebar labels and large-library counts.
// Run: node sidebar-layout.cjs <loopback-mock-tagcast-url> <output-directory>
// Uses the existing Playwright setup; never connect this test to a real account.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");

async function main() {
  const [url, output] = process.argv.slice(2);
  assert.ok(url && output, "Provide a mock Tagcast URL and output directory");
  const origin = new URL(url);
  assert.ok(origin.protocol === "http:" && origin.hostname === "127.0.0.1", "Use a loopback mock server");
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({chromiumSandbox: true,
    ...(process.env.TAGCAST_CHROMIUM_EXECUTABLE ? {executablePath: process.env.TAGCAST_CHROMIUM_EXECUTABLE} : {})});
  const results = [], errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const request = route.request(), target = new URL(request.url());
      return target.origin === origin.origin && request.method() === "GET" ? route.continue() : route.abort();
    });
    await page.goto(url, {waitUntil: "load"});
    await page.waitForFunction(() => typeof state !== "undefined" && state.mode === "live" && !state.loading);
    const audio = await page.locator("#audio").elementHandle();
    for (const language of ["en", "nl", "de", "fr", "es", "ja"]) {
      await page.evaluate(language => TagcastI18n.use(language), language);
      for (const width of [420, 760, 761, 1280]) for (const mode of ["light", "dark"]) {
        await page.setViewportSize({width, height: 900});
        await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, mode);
        if (width <= 760 && await page.locator("#menu-toggle").getAttribute("aria-expanded") !== "true") {
          await page.locator("#menu-toggle").click();
        }
        for (const gutter of [false, true]) {
          const name = `${language}-${width}-${mode}${gutter ? "-reserved-scrollbar" : ""}`;
          // Exercise all shortcuts and realistic counts without changing saved preferences.
          await page.evaluate(gutter => {
            document.querySelectorAll("#workspace-nav .nav").forEach(button => { button.hidden = false; });
            for (const [id, value] of Object.entries({"browse-artist-count": 2631, "album-count": 18787,
              "track-count": 291068, "playlist-count": 10, "history-count": 247})) {
              const count = document.getElementById(id);
              count.hidden = false; count.textContent = TagcastI18n.number(value);
            }
            // Models platforms/preferences where the vertical scrollbar takes layout space.
            document.getElementById("workspace-nav").style.scrollbarGutter = gutter ? "stable" : "auto";
          }, gutter);
          await page.evaluate(() => document.fonts.ready);
          const metrics = await page.evaluate(() => {
            const nav = document.getElementById("workspace-nav");
            const bounds = element => { const r = element.getBoundingClientRect(); return {left: r.left, right: r.right, width: r.width, height: r.height}; };
            const textRects = element => {
              const range = document.createRange(); range.selectNodeContents(element);
              return [...range.getClientRects()].map(r => ({left: r.left, right: r.right}));
            };
            return {overflow: nav.scrollWidth - nav.clientWidth, scrollable: nav.scrollHeight > nav.clientHeight,
              buttons: [...nav.querySelectorAll(".nav")].map(button => ({id: button.id, ...bounds(button),
                label: button.querySelector("span") ? textRects(button.querySelector("span")) : [],
                count: button.querySelector("b:not([hidden])") ? {...bounds(button.querySelector("b")),
                  rects: textRects(button.querySelector("b"))} : null}))};
          });
          let failure = "";
          try {
            assert.ok(metrics.overflow <= 1, `Sidebar overflows horizontally by ${metrics.overflow}px`);
            if (width > 760) assert.equal(metrics.scrollable, true, "Vertical navigation scrolling must remain available");
            for (const button of metrics.buttons) {
              if (language === "de" && button.id === "show-artists") {
                assert.equal(button.label.length, 1, "German artist shortcut must not leave a word fragment on another line");
              }
              for (const rect of [...button.label, ...(button.count?.rects || [])]) {
                assert.ok(rect.left >= button.left && rect.right <= button.right + 1, `${button.id} clips text`);
              }
              if (button.count) {
                assert.equal(button.count.rects.length, 1, `${button.id} wraps its count`);
                assert.ok(button.label.every(rect => rect.right <= button.count.left), `${button.id} overlaps its count`);
              }
            }
            await page.locator("#show-overview").focus();
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), "show-history", "Keyboard order changed");
            assert.equal(await audio.evaluate(element => element === document.getElementById("audio")), true, "Audio element replaced");
          } catch (error) { failure = error.message; }
          await page.locator("#workspace-nav").evaluate(element => { element.scrollTop = 0; });
          if (!gutter && mode === "dark" && [761, 1280].includes(width)) {
            await page.locator("#sidebar").screenshot({path: path.join(output, name + ".png")});
            await page.locator("#workspace-nav").evaluate(element => { element.scrollTop = element.scrollHeight; });
            await page.locator("#sidebar").screenshot({path: path.join(output, name + "-bottom.png")});
          }
          results.push({name, language, width, mode, gutter, ...metrics, failure});
        }
      }
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({results, errors}, null, 2));
  }
  assert.deepEqual(errors, [], "Unexpected browser errors");
  const failures = results.filter(result => result.failure);
  console.log(`${results.length} sidebar cases; ${failures.length} failures`);
  assert.deepEqual(failures.map(({name, failure}) => ({name, failure})), []);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
