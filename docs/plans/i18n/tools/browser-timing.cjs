// Page load, evaluation and switching timings in Chromium (Playwright).
// Usage: node browser-timing.cjs <repo-root> <i18next.min.js> <i18nextICU.min.js>
// Expects the proof of concept on http://127.0.0.1:8941 and an unchanged baseline on :8942,
// each started with a temporary TAGCAST_HOME so no real settings are touched.
const {chromium} = require("playwright");
const path = require("path");
const repo = path.resolve(process.argv[2]);
const fs = require("fs");
const i18nextSrc = fs.readFileSync(process.argv[3], "utf8");
const icuSrc = fs.readFileSync(process.argv[4], "utf8");
const oursSrc = fs.readFileSync(path.join(repo, "src/tagcast/static/i18n.js"), "utf8");
const enBundle = fs.readFileSync(path.join(repo, "src/tagcast/static/i18n-en.js"), "utf8");
// A full-size English bundle projection: the measured 2,652 unique UI texts at the PoC's average size.
const en = JSON.parse(fs.readFileSync(path.join(repo, "src/tagcast/static/i18n/en.json"), "utf8"));
const values = Object.values(en), big = {};
for (let i = 0; i < 2652; i++) big[`feature${i % 40}.item${i}`] = values[i % values.length];
const bigBundle = `globalThis.TagcastI18nEnglishBig = Object.freeze(${JSON.stringify({messages: big}, null, 1)});`;
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
(async () => {
  const browser = await chromium.launch();
  const result = {};
  for (const [name, port] of [["baseline", 8942], ["poc", 8941]]) {
    const dcl = [], load = [];
    for (let i = 0; i < 15; i++) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: "load"});
      const t = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return {dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd}; });
      dcl.push(t.dcl); load.push(t.load); await page.close();
    }
    result[name] = {domContentLoadedMs: +median(dcl).toFixed(1), loadMs: +median(load).toFixed(1)};
  }
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8941/", {waitUntil: "load"});
  result.evaluation = await page.evaluate(({i18nextSrc, icuSrc, oursSrc, enBundle, bigBundle}) => {
    const time = (fn, n = 30) => { const out = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); out.push(performance.now() - t0); } out.sort((a, b) => a - b); return +out[Math.floor(n / 2)].toFixed(3); };
    return {
      oursRuntimeEvalMs: time(() => new Function(oursSrc)()),
      englishBundleEvalMs: time(() => new Function(enBundle)()),
      projectedFullEnglishBundleEvalMs: time(() => new Function(bigBundle)(), 15),
      projectedFullEnglishBundleBytes: bigBundle.length,
      i18nextEvalMs: time(() => new Function("var module, exports, define;" + i18nextSrc)()),
      i18nextPlusIcuEvalMs: time(() => new Function("var module, exports, define;" + i18nextSrc + ";" + icuSrc)()),
    };
  }, {i18nextSrc, icuSrc, oursSrc, enBundle, bigBundle});
  result.switching = await page.evaluate(async () => {
    const t0 = performance.now(); await TagcastI18n.use("nl", {remember: false}); const t1 = performance.now();
    const t2 = performance.now(); for (let i = 0; i < 10000; i++) TagcastI18n.text("player.queue.remove", {title: "Song " + i, position: i}); const t3 = performance.now();
    const t4 = performance.now(); TagcastI18n.translate(); const t5 = performance.now();
    const lang = document.documentElement.lang, heading = document.querySelector("#audio-output-title").textContent;
    await TagcastI18n.use("en", {remember: false});
    return {firstSwitchToDutchMs: +(t1 - t0).toFixed(2), tenThousandMessagesMs: +(t3 - t2).toFixed(2), staticPassMs: +(t5 - t4).toFixed(2), lang, heading,
      backToEnglishHeading: document.querySelector("#audio-output-title").textContent, annotated: document.querySelectorAll("[data-i18n],[data-i18n-attr]").length};
  });
  // Real-browser check: Settings page language section and the static pass in Dutch.
  await page.evaluate(() => { location.hash = "#/settings/interface"; });
  await page.waitForTimeout(400);
  result.settingsSection = await page.evaluate(() => ({present: Boolean(document.querySelector("#interface-language")), options: [...document.querySelectorAll("#interface-language option")].map(o => o.textContent)}));
  await page.selectOption("#interface-language", "nl");
  await page.waitForTimeout(500);
  result.afterChoosingDutch = await page.evaluate(() => ({lang: document.documentElement.lang, queueHeading: document.querySelector("[data-i18n='player.queue.heading']").textContent,
    soundHeading: document.querySelector("#audio-output-title").textContent, languageHeading: document.querySelector("[data-language-settings] h3").textContent.trim(),
    status: document.querySelector("#interface-language-status").textContent, stored: localStorage.getItem("tagcast-language")}));
    const fresh = await browser.newPage();
  await fresh.goto("http://127.0.0.1:8941/", {waitUntil: "load"}); await fresh.waitForTimeout(300);
  result.newBrowserContextReadsServerChoice = await fresh.evaluate(() => ({lang: document.documentElement.lang, language: TagcastI18n.language, visibility: document.documentElement.style.visibility}));
  const other = await browser.newContext(); const otherPage = await other.newPage();
  await otherPage.goto("http://127.0.0.1:8941/", {waitUntil: "load"}); await otherPage.waitForTimeout(800);
  result.separateProfileFollowsServer = await otherPage.evaluate(() => ({language: TagcastI18n.language, stored: localStorage.getItem("tagcast-language")}));
  await page.selectOption("#interface-language", "en"); await page.waitForTimeout(400);
  console.log(JSON.stringify(result, null, 1));
  await browser.close();
})();
