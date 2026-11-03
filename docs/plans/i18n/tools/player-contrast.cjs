// Browser regression for native controls/vendor logo contrast while audio keeps playing.
// Run: node player-contrast.cjs <loopback-mock-tagcast-url> <output-directory>
// Optional TAGCAST_CONTRAST_BASELINE substitutes original static files for comparison.
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {chromium} = require("playwright");

async function main() {
  const [url, output] = process.argv.slice(2), origin = new URL(url);
  assert.ok(output && origin.protocol === "http:" && origin.hostname === "127.0.0.1", "Use a loopback mock library");
  fs.mkdirSync(output, {recursive:true});
  // Silent, synthetic two-minute PCM fixture; no real music or account is accessed.
  const wav = Buffer.alloc(44 + 8000 * 2 * 120);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length-8,4); wav.write("WAVEfmt ",8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34); wav.write("data",36); wav.writeUInt32LE(wav.length-44,40);
  const browser = await chromium.launch({chromiumSandbox:true,
    ...(process.env.TAGCAST_CHROMIUM_EXECUTABLE ? {executablePath:process.env.TAGCAST_CHROMIUM_EXECUTABLE} : {})});
  const results = [], errors = [];
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const request = route.request(), target = new URL(request.url());
      if(target.origin !== origin.origin || request.method() !== "GET") return route.abort();
      if(target.pathname.startsWith("/api/stream/")) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || "");
        const start=range?Number(range[1]):0, end=range && range[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;
        return route.fulfill({status:range?206:200,contentType:"audio/wav",body:wav.subarray(start,end+1),
          headers:{"Accept-Ranges":"bytes",...(range?{"Content-Range":`bytes ${start}-${end}/${wav.length}`}:{})}});
      }
      const file = {"/":"index.html","/index.html":"index.html","/style.css":"style.css","/themes.js":"themes.js"}[target.pathname];
      if(file && process.env.TAGCAST_CONTRAST_BASELINE) return route.fulfill({status:200,
        contentType:file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html",
        body:fs.readFileSync(path.join(process.env.TAGCAST_CONTRAST_BASELINE,file))});
      return route.continue();
    });
    await page.goto(url,{waitUntil:"load"});
    await page.waitForFunction(() => state.mode === "live" && !state.loading);
    await page.evaluate(() => {location.hash="#/album/72";});
    await page.locator('[data-play-album][data-play-album-id="72"]').click();
    await page.waitForFunction(() => audio.readyState >= 3 && !audio.paused);
    await page.evaluate(() => {
      window.contrastAudio=audio; window.contrastQueue=player.queue;
      audio.volume=.34; audio.playbackRate=1.25; audio.currentTime=7;
      window.contrastSource=audio.currentSrc;
    });
    await page.waitForFunction(() => audio.currentTime >= 7 && !audio.seeking);
    await page.addStyleTag({content:"#toast{visibility:hidden}"});
    await page.evaluate(() => {
      document.getElementById("player-art").src="favicon.svg";
      window.contrastEvents=[];
      for(const event of ["pause","emptied","loadstart"]) audio.addEventListener(event,()=>contrastEvents.push(event));
    });
    const cases=[];
    for(const palette of ["forest","ocean","warm","ibroadcast","apple"]) for(const mode of ["light","dark"]) {
      const tone=palette === "apple" && mode === "light"?"light":"dark";
      cases.push({name:`${palette}-${mode}`,palette,mode,player:tone,logo:tone});
    }
    cases.push({name:"custom-light-shell-dark-controls",mode:"light",player:"dark",logo:"light",custom:true},
      {name:"custom-dark-shell-light-controls",mode:"dark",player:"light",logo:"dark",custom:true},
      {name:"auto-light",mode:"auto",system:"light",palette:"apple",player:"light",logo:"light"},
      {name:"auto-dark",mode:"auto",system:"dark",palette:"apple",player:"dark",logo:"dark"});
    for(const item of cases) {
      if(item.system) await page.emulateMedia({colorScheme:item.system});
      await page.evaluate(item => {
        if(item.mode === "auto") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme=item.mode;
        if(item.custom) TagcastThemes.save({id:"custom-contrast1",name:"Contrast fixture",base:"ocean",
          light:{sidebar:"#ffffff","shell-active":"#000000"},dark:{sidebar:"#000000","shell-active":"#ffffff"}},true);
        else TagcastThemes.builtin(item.palette);
        showTheme();
      },item);
      await page.evaluate(() => document.fonts.ready);
      const metrics=await page.evaluate(() => ({scheme:getComputedStyle(audio).colorScheme,
        logos:[...document.querySelectorAll(".ibroadcast-branding img")].filter(img=>img.getClientRects().length)
          .map(img=>({src:img.getAttribute("src"),loaded:img.complete && img.naturalWidth>0})),
        sameAudio:audio===window.contrastAudio,sameQueue:player.queue===window.contrastQueue,
        source:audio.currentSrc===window.contrastSource,paused:audio.paused,rate:audio.playbackRate,volume:audio.volume,
        position:audio.currentTime,events:[...window.contrastEvents]}));
      let failure="";
      try {
        assert.equal(metrics.scheme,item.player,"Native controls have the wrong foreground scheme");
        assert.deepEqual(metrics.logos,[{src:`ibroadcast-${item.logo}-compact-powered.svg`,loaded:true}],"Wrong official logo variant");
        assert.ok(metrics.sameAudio && metrics.sameQueue && metrics.source,"Appearance replaced playback state");
        assert.equal(metrics.paused,false); assert.equal(metrics.rate,1.25); assert.equal(metrics.volume,.34);
        assert.ok(metrics.position>=7); assert.deepEqual(metrics.events,[],"Appearance interrupted playback");
      } catch(error) {failure=error.message;}
      await page.locator("#player").screenshot({path:path.join(output,item.name+"-player.png")});
      await page.locator(".sidebar-bottom").screenshot({path:path.join(output,item.name+"-footer.png")});
      results.push({...item,...metrics,failure});
    }
    await page.evaluate(() => audio.pause());
    await page.evaluate(() => {TagcastThemes.builtin("apple");document.documentElement.dataset.theme="light";showTheme();});
    assert.equal(await page.evaluate(() => audio.paused),true,"Theme change resumed paused audio");
  } finally {
    await browser.close();fs.writeFileSync(path.join(output,"results.json"),JSON.stringify({results,errors},null,2));
  }
  assert.deepEqual(errors,[]);
  const failures=results.filter(result=>result.failure);
  console.log(`${results.length} contrast/playback cases; ${failures.length} failures`);
  assert.deepEqual(failures.map(({name,failure})=>({name,failure})),[]);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
