"use strict";
// Optional browser counterpart of the extracted-app regression. Only local mock data.
const {chromium, firefox, webkit} = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {spawn, execFileSync} = require("node:child_process"), {once} = require("node:events"), readline = require("node:readline");
const {inspectToastTarget} = require("../electron/browse-smoke.cjs");
const root = path.resolve(__dirname, ".."), output = path.resolve(process.argv[2] || "build/toast-pointer");
fs.mkdirSync(output, {recursive:true});
const fixture = spawn(process.env.TAGCAST_PYTHON || "python3", [path.join(__dirname, "browser_csp_fixture.py")],
  {cwd:root, env:{...process.env, PYTHONPATH:path.join(root, "src")}, stdio:["pipe", "pipe", "inherit"]});
(async () => {
  const lines = readline.createInterface({input:fixture.stdout});const [line] = await once(lines, "line");lines.close();
  const origin = JSON.parse(line).disconnected;
  const failures = [];
  for (const engine of (process.env.TAGCAST_TOAST_ENGINES || "chromium,firefox,webkit").split(",")) {
    const appData = engine === "firefox" && process.platform === "darwin" ? fs.mkdtempSync(path.join(os.tmpdir(), "tagcast-toast-firefox-")) : null;
    const browser = await ({chromium, firefox, webkit})[engine].launch({...(appData ? {env:{...process.env,CFFIXED_USER_HOME:appData}} : {})});
    const samples = [];
    try {
      for (const width of [420,760,768,1280]) for (const height of [656,800]) for (const appearance of ["light","dark"]) {
        const page = await browser.newPage({viewport:{width,height}});
        await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(origin + "/");await page.waitForFunction(() => typeof state !== "undefined" && !state.loading);
        await page.evaluate(appearance => {document.documentElement.dataset.theme=appearance;showBrowse("years");window.scrollTo(0,0);
          setThemeMenu(true);toast("Synthetic notification: upstream service unavailable");}, appearance);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const hit = await page.evaluate(`(${inspectToastTarget.toString()})()`);
        assert.equal(hit.visible,true);assert.equal(hit.role,"status");assert.equal(hit.children,0);
        await page.mouse.click(hit.point.x,hit.point.y);
        const opened = await page.evaluate(() => state.screen === "settings" && settingsView.category === "appearance" && !!document.querySelector("#theme-editor"));
        const sample = {width,height,appearance,...hit,opened,stillVisible:await page.evaluate(() => !document.querySelector("#toast").hidden)};
        samples.push(sample);
        if (!hit.receivesPointer || !opened || !sample.stillVisible) failures.push({engine,...sample});
        if (width===420 && height===656) await page.screenshot({path:path.join(output,`${engine}-${appearance}.png`)});
        await page.close();
      }
      fs.writeFileSync(path.join(output,engine+".json"),JSON.stringify({version:browser.version(),samples},null,2)+"\n");
    } finally {
      await browser.close();
      if(appData){execFileSync("chmod",["-RN",appData]);fs.rmSync(appData,{recursive:true,maxRetries:10,retryDelay:100});}
    }
  }
  console.log(JSON.stringify({failures}));
  assert.deepEqual(failures,[],"Visible notifications must never intercept the real theme-menu click");
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{fixture.stdin.end();if(fixture.exitCode===null)await once(fixture,"exit");});
