"use strict";
// Optional real browser / extracted Electron probe. All traffic belongs to disposable
// browser_audio_fixture.py hosts. No media events are faked and no CSP is replaced.
const {chromium, firefox, webkit} = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {spawn, execFileSync} = require("node:child_process"), {once} = require("node:events"), readline = require("node:readline");
const {createHash} = require("node:crypto");
const root = path.resolve(__dirname, ".."), output = path.resolve(process.argv[2] || "build/audio-recovery");
fs.mkdirSync(output, {recursive:true});
const hash = body => createHash("sha256").update(body).digest("hex");
const fixture = spawn(process.env.TAGCAST_PYTHON || "python3", [path.join(__dirname, "browser_audio_fixture.py")],
  {cwd:root, env:{...process.env, PYTHONPATH:path.join(root, "src")}, stdio:["pipe", "pipe", "inherit"]});

async function engineProbe(engine, host) {
  let child, profile, appData, browser;
  const report = {engine, synthetic:true, scenarios:[], errors:[], violations:[]};
  try {
    if (engine === "electron") {
      const executable = process.env.TAGCAST_AUDIO_EXECUTABLE;
      assert.ok(executable, "Supply an extracted native executable");
      profile = fs.mkdtempSync(path.join(os.tmpdir(), "tagcast-audio-electron-"));
      child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], {
        env:{...process.env, TAGCAST_HOME:host.home, TAGCAST_ELECTRON_PROFILE:profile, TAGCAST_PORT:"0",
          TAGCAST_IBROADCAST_BASE:host.upstream, IBROADCAST_CLIENT_ID:"test"}, stdio:["ignore", "ignore", "pipe"]});
      const address = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Native DevTools endpoint did not start")), 20000);
        child.once("exit", code => {clearTimeout(timer);reject(Error("Native startup exited: " + code));});
        let text = "";
        child.stderr.on("data", chunk => {
          text = (text + chunk.toString()).slice(-16384);
          const match = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
          if (match) {clearTimeout(timer);resolve(match[1]);}
        });
      });
      browser = await chromium.connectOverCDP(address);
    } else {
      appData = engine === "firefox" && process.platform === "darwin"
        ? fs.mkdtempSync(path.join(os.tmpdir(), "tagcast-audio-firefox-")) : null;
      browser = await ({chromium, firefox, webkit})[engine].launch({headless:true,
        ...(engine === "chromium" ? {args:["--autoplay-policy=no-user-gesture-required"]} : {}),
        ...(appData ? {env:{...process.env, CFFIXED_USER_HOME:appData}} : {})});
    }
    report.version = browser.version();
    const context = engine === "electron" ? browser.contexts()[0] : await browser.newContext();
    const page = engine === "electron" ? context.pages()[0] || await context.waitForEvent("page") : await context.newPage();
    if (engine !== "electron") await context.route("**/*", route => new URL(route.request().url()).origin === host.origin ? route.continue() : route.abort());
    const control = async (data) => (await (data ? page.request.post(host.origin + "/_audio/control", {data})
      : page.request.get(host.origin + "/_audio/control"))).json();
    page.on("pageerror", error => report.errors.push(error.message));
    const sourceLoads = [];
    const diagnosticReads = [];
    const playRequests = [];
    page.on("request", request => {if(request.url().includes("/api/playback/stream-status?"))diagnosticReads.push(request.url());});
    page.on("request", request => {if(new URL(request.url()).pathname === "/api/play")playRequests.push(JSON.parse(request.postData()));});
    if (engine !== "electron") await page.goto(host.origin + "/");
    await page.waitForFunction(() => typeof state !== "undefined" && state.mode === "live" && !state.loading && state.albums.length === 3);
    const served = await page.request.get(new URL("/playback-recovery.js", page.url()).href);
    assert.equal(hash(await served.body()), hash(fs.readFileSync(path.join(root, "src/tagcast/static/playback-recovery.js"))), "Actual served code equals the candidate");
    report.servedRecoverySha256 = hash(await served.body());
    await page.exposeFunction("recordAudioSource", value => sourceLoads.push(value));
    await page.evaluate(() => {
      window.testPolicyViolations = [];
      document.addEventListener("securitypolicyviolation", e => testPolicyViolations.push({directive:e.effectiveDirective, blocked:e.blockedURI}));
      audio.addEventListener("loadstart", () => recordAudioSource(audio.src));
    });
    const start = async () => {
      await control({fault:false, status:200});
      await page.evaluate(async () => {
        stopPlayer();lookup.streamQuality = "128";audio.muted = true;
        playTracks((await albumDetails(["72"]))[0]);
        window.recoveryTestEntry = player.queue[player.index];window.recoveryTestWatch = playReporting.watch;
      });
      await page.waitForFunction(() => !audio.paused && audio.currentTime > 1.5);
      // Normal source selection may emit emptied before its first playing event.
      // Capture the established listening event, not the pre-load placeholder.
      await page.evaluate(() => {window.recoveryTestWatch = playReporting.watch;});
    };
    const interrupt = async () => {
      await control({fault:true});
      await page.waitForFunction(() => audio.error?.code === 2 && !!audioRecovery.pending, null, {timeout:25000});
      return page.evaluate(() => ({position:audioRecovery.pending.position, listened:playReporting.watch.listened,
        event:playReporting.watch.eventId, quality:player.quality}));
    };
    const snapshot = () => page.evaluate(() => ({position:playerTrackPosition(), paused:audio.paused,
      sameEntry:player.queue[player.index] === recoveryTestEntry, sameWatch:playReporting.watch === recoveryTestWatch,
      listened:playReporting.watch?.listened, attempted:playReporting.watch?.attempted, quality:player.quality,
      pending:!!audioRecovery.pending, failed:!!audioRecovery.failed, index:player.index}));

    const reported = page.waitForResponse(response => new URL(response.url()).pathname === "/api/play" && response.status() === 200);
    await start();
    await page.waitForFunction(() => playReporting.watch?.attempted === true);
    await reported; // attempted is set before the existing upstream write completes.
    const plays = (await control()).plays, reads = diagnosticReads.length, loads = sourceLoads.length, reports = playRequests.length;
    const before = await interrupt(), began = performance.now();await control({fault:false});
    await page.waitForFunction(position => !audioRecovery.pending && !audio.error && !audio.paused && audio.currentTime > position + .2,
      before.position, {timeout:20000});
    const recovered = await snapshot();
    assert.equal(recovered.sameEntry, true);assert.equal(recovered.sameWatch, true);
    assert.equal(recovered.quality, before.quality);assert.equal((await control()).plays, plays);
    assert.equal(playRequests.length, reports, "Neither the UI nor upstream receives another play write");
    assert.equal(diagnosticReads.length - reads, 1);assert.equal(sourceLoads.length - loads, 1);
    assert.ok(recovered.listened - before.listened < recovered.position - before.position + 1);
    report.scenarios.push({name:"network-at-position-and-single-play", before, after:recovered, recoveryMs:performance.now() - began,
      newDiagnosticReads:1, newSourceLoads:1, playWritesBefore:plays, playWritesAfter:(await control()).plays});

    await start();let release;
    const held = new Promise(resolve => {release = resolve;});
    await page.route("**/api/playback/stream-status?*", async route => {await held;await route.continue().catch(() => {});});
    await interrupt();await control({fault:false});
    if (engine === "electron") {
      const opened = context.waitForEvent("page");
      await page.evaluate(() => window.tagcastMiniOwner.open());
      const mini = await opened;
      await mini.waitForURL("**/mini-player/index.html");
      await mini.waitForFunction(() => document.querySelector("#play").getAttribute("aria-label") === "Pause");
      await mini.click("#play");
      await page.waitForFunction(() => audioRecovery.pending && !audioRecovery.pending.wantsPlay, null, {polling:50});
      await mini.click("#open");
      await mini.close();
      await page.evaluate(() => seekSystemPlayback(37));
    } else await page.evaluate(() => {pauseSystemPlayback();seekSystemPlayback(37);});
    release();
    await page.waitForFunction(() => !audioRecovery.pending && !audio.error && audio.paused && Math.abs(audio.currentTime - 37) < .05, null, {timeout:20000});
    const paused = await snapshot();assert.equal(paused.sameWatch, true);assert.equal(paused.sameEntry, true);
    report.scenarios.push({name:"pause-and-seek-during-recovery", nativeMiniPlayer:engine === "electron", after:paused});
    await page.unroute("**/api/playback/stream-status?*");

    await start();let staleRelease;
    const stale = new Promise(resolve => {staleRelease = resolve;});
    await page.route("**/api/playback/stream-status?*", async route => {await stale;await route.continue().catch(() => {});});
    await interrupt();await control({fault:false});
    await page.evaluate(() => step(1));staleRelease();
    await page.waitForFunction(() => player.index === 1 && !audio.paused && audio.currentTime > .2);
    const changed = await snapshot();assert.equal(changed.sameEntry, false);assert.equal(changed.pending, false);
    report.scenarios.push({name:"track-change-cancels-stale-recovery", after:changed});
    await page.unroute("**/api/playback/stream-status?*");

    await start();const failReads = diagnosticReads.length;
    await interrupt();
    await page.waitForFunction(() => !!audioRecovery.failed && !audioRecovery.pending, null, {timeout:20000});
    await control({fault:false});
    const exhausted = await snapshot();assert.equal(exhausted.sameEntry, true);assert.equal(exhausted.sameWatch, true);
    assert.equal(diagnosticReads.length - failReads, 1);
    await page.waitForTimeout(800);assert.equal(diagnosticReads.length - failReads, 1);
    await page.evaluate(() => playSystemPlayback());
    await page.waitForFunction(position => !audioRecovery.pending && !audio.error && !audio.paused && audio.currentTime >= position,
      exhausted.position, {timeout:20000});
    report.scenarios.push({name:"one-failed-attempt-and-explicit-retry", exhausted, after:await snapshot()});

    await page.evaluate(() => stopPlayer());await control({status:403});
    const authLoads = sourceLoads.length;
    await page.evaluate(async () => {lookup.streamQuality = "orig";playTracks((await albumDetails(["72"]))[0]);});
    await page.waitForFunction(() => !!audioRecovery.failed && !audioRecovery.pending);
    assert.equal(await page.evaluate(() => player.quality), "orig");
    assert.equal(sourceLoads.length - authLoads, 1);
    report.scenarios.push({name:"authorization-does-not-reload-or-downgrade", sourceLoads:1, quality:"orig"});
    report.violations = await page.evaluate(() => testPolicyViolations);
    assert.deepEqual(report.violations, []);assert.deepEqual(report.errors, []);
    await page.screenshot({path:path.join(output, engine + ".png")});
    await control({fault:false, status:200});await page.evaluate(() => stopPlayer());
    // Native close/drain is asserted through BrowserWindow.close() in the
    // extracted package's shutdown-smoke.cjs stream case. DevTools target close
    // disposes the renderer and cannot stand in for that application lifecycle.
    report.ok = true;
    return report;
  } catch (error) {
    report.ok = false;report.failure = error.stack || String(error);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, engine + ".json"), JSON.stringify(report, null, 2) + "\n");
    if (browser) await browser.close();
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (profile) fs.rmSync(profile, {recursive:true, force:true, maxRetries:10, retryDelay:100});
    if (appData) {execFileSync("chmod", ["-RN", appData]);fs.rmSync(appData, {recursive:true, maxRetries:10, retryDelay:100});}
  }
}

(async () => {
  const lines = readline.createInterface({input:fixture.stdout});
  const [line] = await Promise.race([once(lines, "line"), once(fixture, "exit").then(() => {throw Error("Fixture startup failed");})]);
  lines.close();const host = JSON.parse(line);
  for (const engine of (process.env.TAGCAST_AUDIO_ENGINES || "chromium,firefox,webkit").split(",")) {
    const report = await engineProbe(engine, host);
    console.log(JSON.stringify({engine, version:report.version, ok:report.ok, scenarios:report.scenarios}));
  }
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {fixture.stdin.end();await once(fixture, "exit");});
