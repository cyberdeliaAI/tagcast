"use strict";
// Optional real-browser probe. Requires external Playwright; no runtime dependency.
// TAGCAST_PYTHON=... NODE_PATH=... node tools/check_browser_csp.cjs [output]
const {chromium, firefox, webkit} = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {spawn, execFileSync} = require("node:child_process"), {once} = require("node:events"), readline = require("node:readline");
const os = require("node:os");
const root = path.resolve(__dirname, ".."), output = path.resolve(process.argv[2] || "build/browser-csp");
fs.mkdirSync(output, {recursive:true});
const fixture = spawn(process.env.TAGCAST_PYTHON || "python3", [path.join(__dirname, "browser_csp_fixture.py")], {
  cwd:root, env:{...process.env, PYTHONPATH:path.join(root, "src")}, stdio:["pipe", "pipe", "inherit"]});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

async function probe(engine, origin) {
  // macOS 27 protects Firefox's default app-data directory, even with a test profile.
  // Keep the test entirely separate from personal browser data; no permissions change.
  const appData = engine === "firefox" && process.platform === "darwin"
    ? fs.mkdtempSync(path.join(os.tmpdir(), "tagcast-csp-firefox-")) : null;
  const browser = await ({chromium, firefox, webkit})[engine].launch({headless:true,
    ...(appData ? {env:{...process.env, CFFIXED_USER_HOME:appData}} : {}),
    ...(engine === "chromium" ? {args:["--autoplay-policy=no-user-gesture-required"]} : {})});
  const report = {engine, version:browser.version(), checks:[], violations:[], errors:[], consoleErrors:[]};
  try {
    const context = await browser.newContext({viewport:{width:1280, height:800}});
    // Test storage preferences are installed before navigation, without changing HTML or CSP.
    await context.addInitScript(() => {
      localStorage.setItem("tagcast-theme", "dark");
      localStorage.setItem("tagcast-palette", "ocean");
      localStorage.setItem("tagcast-library-notice", "hidden");
      window.cspViolations = [];
      document.addEventListener("securitypolicyviolation", event => window.cspViolations.push({
        directive:event.effectiveDirective, blocked:event.blockedURI}));
    });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname === "artwork.example.test") return route.fulfill({contentType:"image/png", body:png});
      if ([origin.live, origin.disconnected].includes(url.origin)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => {if(message.type() === "error")report.consoleErrors.push(message.text());});
    await page.goto(origin.disconnected + "/");
    await page.waitForFunction(() => typeof state !== "undefined" && !state.loading && state.mode === "demo");
    await page.click("#connect-button");
    await page.waitForFunction(() => document.querySelector("#connect").open && !!document.querySelector("#device-start"));
    report.checks.push("disconnected startup and sign-in dialog");
    assert.deepEqual(await page.evaluate(() => cspViolations), []);
    const response = await page.goto(origin.live + "/");
    const header = response.headers()["content-security-policy"];
    assert.match(header, /script-src 'self' 'sha256-/);
    assert.doesNotMatch(header, /unsafe-eval/);
    await page.waitForFunction(() => state.mode === "live" && !state.loading && state.albums.length === 3);
    assert.deepEqual(await page.evaluate(() => ({theme:document.documentElement.dataset.theme,
      palette:localStorage.getItem("tagcast-palette"), notice:document.documentElement.dataset.libraryNotice})),
      {theme:"dark", palette:"ocean", notice:"hidden"});
    report.checks.push("live startup, hashed early notice and synchronous theme restoration");
    await page.evaluate(() => showBrowse("genres"));
    await page.waitForFunction(() => browseView.loaded && !browseView.loading && browseView.kind === "genres");
    await page.evaluate(() => showFavourites());
    await page.waitForFunction(() => !favourites.loading);
    const tags = await page.evaluate(() => api("/api/tags"));
    assert.equal(tags.total, 0);
    await page.evaluate(() => openEditor(["72"]));
    await page.waitForFunction(() => document.querySelector("#editor").open);
    await page.evaluate(() => document.querySelector("#editor").close());
    await page.evaluate(() => chooseInterfaceLanguage("nl"));
    await page.waitForFunction(() => document.documentElement.lang === "nl");
    await page.evaluate(() => chooseInterfaceLanguage("en"));
    report.checks.push("browsing, favourites, tags, metadata dialog and lazy translation catalogue");
    for (const width of [420, 760, 1280]) {
      await page.setViewportSize({width, height:800});
      await page.evaluate(() => {document.documentElement.dataset.theme = "light";TagcastThemes.apply();showTheme();window.scrollTo(0, 0);});
      await page.click("#theme-button");
      await page.click("#appearance-dark");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
      await page.keyboard.press("Escape");
    }
    report.checks.push("pointer theme-menu interactions at 420, 760 and 1280px");
    await page.setViewportSize({width:1280, height:800});
    const artwork = await page.evaluate(async () => {
      const blob = URL.createObjectURL(new Blob([new Uint8Array([137,80,78,71])], {type:"image/png"}));
      URL.revokeObjectURL(blob);
      const image = new Image();
      image.src = "https://artwork.example.test/probe.png";
      await image.decode();
      return image.naturalWidth;
    });
    assert.equal(artwork, 1);
    // Real audio proxy, real decoder and seeking; synthetic bundled MP3 only.
    await page.evaluate(async () => {audio.loop = true;audio.src = "/api/stream/900";await audio.play();});
    await page.waitForFunction(() => !audio.paused && audio.currentTime > .1);
    await page.evaluate(() => {audio.currentTime = .6;});
    await page.waitForFunction(() => !audio.seeking && audio.currentTime >= .6);
    await page.evaluate(() => audio.pause());
    report.checks.push("HTTPS artwork, same-origin streaming and seeking");
    report.capabilities = await page.evaluate(() => ({gapless:gaplessSupported(), visualizer:visualizerSupported()}));
    if (report.capabilities.gapless) {
      await page.evaluate(async () => {gaplessTrial.enabled = true;player.quality = "orig";playTracks((await albumDetails(["72"]))[0], "900");});
      await page.waitForFunction(() => gaplessTrial.active?.ready && audio.src.startsWith("blob:") && audio.currentTime > .1);
      await page.waitForFunction(() => player.index === 1);
      report.checks.push("FLAC gapless MSE/blob playback and real track boundary");
      await page.evaluate(() => {audio.pause();gaplessCancel();gaplessTrial.enabled = false;});
    } else report.checks.push("gapless unsupported by this browser; ordinary streaming verified");
    await page.evaluate(async () => {
      player.queue = queueTracks((await albumDetails(["72"]))[0]);player.index = 0;player.album = player.queue[0].album;
      visualPlayerMode = "window";audio.src = "/_csp/tone.wav";audio.loop = true;await audio.play();
      renderCurrentPlayerTrack();openVisualPlayer();
    });
    if (report.capabilities.visualizer) {
      for (const mode of ["aurora", "orbit", "ribbons", "led", "scope", "radial", "stars", "waterfall"]) {
        await page.selectOption("#music-visualization-mode", mode);
        await page.waitForFunction(() => musicVisualization.last > 0 && !musicVisualization.failed);
      }
      report.checks.push("all eight visualizations including dynamic local Butterchurn");
    } else {
      await page.evaluate(() => setMusicVisualization("aurora"));
      assert.equal(await page.evaluate(() => !!musicVisualization.canvas), false);
      // Dynamic library remains testable even when captureStream is unavailable.
      await page.evaluate(() => loadMusicVisualizationLibrary());
      report.checks.push("unsupported captureStream artwork fallback; local Butterchurn loaded");
    }
    await page.screenshot({path:path.join(output, engine + ".png")});
    report.violations = await page.evaluate(() => cspViolations);
    assert.deepEqual(report.violations, [], "No unexpected CSP violations");
    assert.deepEqual(report.errors, []);
    // Isolate intentional negative probes from the application run above.
    const consoleStart = report.consoleErrors.length;
    await page.evaluate(() => {const script = document.createElement("script");script.src = "/_csp/probes.js";document.head.append(script);});
    await page.waitForFunction(() => !!window.cspProbeDone);
    const blocked = await page.evaluate(() => cspProbeDone);
    assert.equal(blocked.evalBlocked, true);assert.equal(blocked.ran, false);
    for (const directive of ["script-src", "script-src-elem", "script-src-attr", "connect-src"]) {
      assert.ok(blocked.violations.some(v => v.directive === directive ||
        (directive.startsWith("script-src") && v.directive === "script-src")), directive + " is enforced");
    }
    report.negativeProbes = blocked;
    report.negativeConsoleErrors = report.consoleErrors.splice(consoleStart);
    report.ok = true;
    return report;
  } finally {
    fs.writeFileSync(path.join(output, engine + ".json"), JSON.stringify(report, null, 2) + "\n");
    await browser.close();
    if (appData) {
      // macOS creates deny-delete ACLs on Library/Downloads in this fake home.
      // Remove those only inside the fresh mkdtemp folder before disposing it.
      execFileSync("chmod", ["-RN", appData]);
      fs.rmSync(appData, {recursive:true, maxRetries:10, retryDelay:100});
    }
  }
}

(async () => {
  const lines = readline.createInterface({input:fixture.stdout});
  const [line] = await Promise.race([once(lines, "line"), once(fixture, "exit").then(() => {throw Error("Fixture failed to start");})]);
  lines.close();
  const origin = JSON.parse(line);
  fs.writeFileSync(path.join(output, "origins.json"), JSON.stringify(origin) + "\n");
  for (const engine of (process.env.TAGCAST_CSP_ENGINES || "chromium,firefox,webkit").split(",")) {
    const report = await probe(engine, origin);
    console.log(JSON.stringify({engine, ok:report.ok, checks:report.checks, capabilities:report.capabilities}));
  }
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  fixture.stdin.end();
  await once(fixture, "exit");
});
