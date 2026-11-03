// Browser regression for the shared header/Settings language preference.
// Run: node header-language.cjs <connected-loopback-mock-url> <output-directory> [baseline-url]
// Use only an isolated mock profile: these tests save its language preference.
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {chromium} = require("playwright");

async function main() {
  const [url, output, baseline] = process.argv.slice(2), origin = new URL(url);
  assert.ok(output && origin.protocol === "http:" && origin.hostname === "127.0.0.1");
  fs.mkdirSync(output, {recursive: true});
  const wav = Buffer.alloc(44 + 8000 * 2 * 120);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length-8,4); wav.write("WAVEfmt ",8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34); wav.write("data",36); wav.writeUInt32LE(wav.length-44,40);
  const browser = await chromium.launch({chromiumSandbox:true,
    ...(process.env.TAGCAST_CHROMIUM_EXECUTABLE ? {executablePath:process.env.TAGCAST_CHROMIUM_EXECUTABLE} : {})});
  const results=[], errors=[], writes=[];
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900},locale:"nl-NL"});
    const page=await context.newPage();
    page.on("pageerror", error=>errors.push(error.message));
    await page.route("**/*", route=>{
      const request=route.request(), target=new URL(request.url());
      if(target.origin!==origin.origin) return route.abort();
      if(request.method()!=="GET") {
        assert.equal(target.pathname,"/api/settings/interface","Language changes must not write other data");
        writes.push(request.postDataJSON()); return route.continue();
      }
      if(target.pathname.startsWith("/api/stream/")) {
        const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers().range||"");
        const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;
        return route.fulfill({status:range?206:200,contentType:"audio/wav",body:wav.subarray(start,end+1),
          headers:{"Accept-Ranges":"bytes",...(range?{"Content-Range":`bytes ${start}-${end}/${wav.length}`}:{})}});
      }
      return route.continue();
    });
    await page.goto(url,{waitUntil:"load"});
    await page.waitForFunction(()=>state.mode==="live"&&!state.loading);
    await page.evaluate(()=>{location.hash="#/album/72";});
    await page.locator('[data-play-album][data-play-album-id="72"]').click();
    await page.waitForFunction(()=>audio.readyState>=3&&!audio.paused);
    await page.evaluate(()=>{
      window.headerAudio=audio; window.headerQueue=player.queue; window.headerSource=audio.currentSrc;
      audio.volume=.34;audio.playbackRate=1.25;window.headerEvents=[];
      for(const event of ["pause","emptied","loadstart"]) audio.addEventListener(event,()=>headerEvents.push(event));
    });
    const choices=["en","nl","de","fr","es","ja"];
    for(const language of choices) {
      await page.locator("#language-button").click();
      await page.locator(`[data-interface-language="${language}"]`).click();
      await page.waitForFunction(language=>TagcastI18n.language===language&&!interfaceLanguage.saving,language);
      assert.equal(await page.locator(`[data-interface-language="${language}"]`).getAttribute("aria-checked"),"true");
      for(const width of [420,760,761,1280]) for(const mode of ["light","dark"]) for(const palette of ["forest","ocean","warm","ibroadcast","apple"]) {
        await page.setViewportSize({width,height:900});
        await page.evaluate(({mode,palette})=>{document.documentElement.dataset.theme=mode;setColourPalette(palette);},{mode,palette});
        await page.evaluate(()=>document.fonts.ready);
        assert.equal(await page.locator("#language-panel").isVisible(),true,"Language menu must remain open for status and keyboard navigation");
        const metrics=await page.evaluate(()=>{
          const panel=document.querySelector("#language-panel"),button=document.querySelector("#language-button");
          const bounds=panel.getBoundingClientRect(),trigger=button.getBoundingClientRect();
          return {left:bounds.left,right:bounds.right,bottom:bounds.bottom,width:innerWidth,height:innerHeight,
            bodyOverflow:document.documentElement.scrollWidth-innerWidth,
            codeVisible:getComputedStyle(document.querySelector("#language-code")).display!=="none",
            triggerWidth:trigger.width,items:[...document.querySelectorAll("#language-menu button")].map(b=>({overflow:b.scrollWidth-b.clientWidth,text:b.textContent})),
            sameAudio:audio===headerAudio,sameQueue:player.queue===headerQueue,sameSource:audio.currentSrc===headerSource,
            paused:audio.paused,rate:audio.playbackRate,volume:audio.volume,events:[...headerEvents]};
        });
        assert.ok(metrics.left>=0&&metrics.right<=width&&metrics.bottom<=900,`Clipped menu: ${language}/${width}/${mode}/${palette}`);
        assert.ok(metrics.bodyOverflow<=1);assert.equal(metrics.codeVisible,width>520);
        assert.ok(metrics.triggerWidth>=40&&metrics.items.length===7&&metrics.items.every(item=>item.overflow<=1));
        assert.ok(metrics.sameAudio&&metrics.sameQueue&&metrics.sameSource);assert.equal(metrics.paused,false);
        assert.equal(metrics.rate,1.25);assert.equal(metrics.volume,.34);assert.deepEqual(metrics.events,[]);
        results.push({language,width,mode,palette,...metrics});
        if(language==="nl"&&palette==="ocean"&&[420,1280].includes(width)) await page.screenshot({path:path.join(output,`after-${width}-${mode}.png`)});
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#language-panel").isVisible(),false);
      assert.equal(await page.evaluate(()=>document.activeElement.id),"language-button");
      if(language==="nl") {
        await page.evaluate(()=>setColourPalette("ocean"));
        await page.locator(".topbar").screenshot({path:path.join(output,"after-header.png")});
        await page.locator("#language-button").click();
        await page.locator("#language-panel").screenshot({path:path.join(output,"language-menu.png")});
        await page.keyboard.press("Escape");
      }
    }
    await page.setViewportSize({width:1280,height:900});
    await page.locator("#language-button").click();
    const saved=writes.length;
    await page.keyboard.press("Home");assert.equal(await page.evaluate(()=>document.activeElement.dataset.interfaceLanguage),"auto");
    await page.keyboard.press("ArrowDown");assert.equal(await page.evaluate(()=>document.activeElement.dataset.interfaceLanguage),"en");
    await page.keyboard.press("End");assert.equal(await page.evaluate(()=>document.activeElement.dataset.interfaceLanguage),"ja");
    assert.equal(writes.length,saved,"Arrow keys must not save a language");
    await page.keyboard.press("Home");await page.keyboard.press("Enter");
    await page.waitForFunction(()=>TagcastI18n.choice==="auto"&&TagcastI18n.language==="nl"&&!interfaceLanguage.saving);
    await page.keyboard.press("Tab");assert.equal(await page.locator("#language-panel").isVisible(),false);
    await page.locator("#language-button").click();await page.locator("#theme-button").click();
    assert.equal(await page.locator("#language-panel").isVisible(),false);
    await page.keyboard.press("Escape");
    await page.evaluate(()=>showSettings("interface"));
    await page.locator("#interface-language").selectOption("fr");
    await page.waitForFunction(()=>TagcastI18n.language==="fr"&&!interfaceLanguage.saving);
    assert.equal(await page.locator("#language-code").textContent(),"FR");
    await page.locator("#language-button").click();await page.locator('[data-interface-language="nl"]').click();
    await page.waitForFunction(()=>TagcastI18n.language==="nl"&&!interfaceLanguage.saving);
    assert.equal(await page.locator("#interface-language").inputValue(),"nl");
    await page.keyboard.press("Escape");
    const tab=await context.newPage();await tab.goto(url);await tab.waitForFunction(()=>TagcastI18n.language==="nl");
    await page.locator("#interface-language").selectOption("de");
    await tab.waitForFunction(()=>TagcastI18n.language==="de");
    assert.equal(await tab.locator("#language-code").textContent(),"DE");await tab.close();
    await page.reload();await page.waitForFunction(()=>TagcastI18n.language==="de");
    assert.equal(await page.locator("#language-code").textContent(),"DE");
    await page.route("**/i18n/ja.json",route=>route.fulfill({status:404,body:"Missing fixture"}));
    await page.locator("#language-button").click();await page.locator('[data-interface-language="ja"]').click();
    await page.waitForFunction(()=>TagcastI18n.choice==="ja"&&TagcastI18n.language==="en"&&!interfaceLanguage.saving);
    assert.match(await page.locator("#header-language-status").textContent(),/translation could not be loaded/);
    assert.equal(await page.locator("#language-code").textContent(),"EN");
    await page.unroute("**/i18n/ja.json");await page.locator('[data-interface-language="ja"]').click();
    await page.waitForFunction(()=>TagcastI18n.language==="ja"&&!interfaceLanguage.saving);
    await page.route("**/api/settings/interface",route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Fixture save failure"})}));
    await page.locator('[data-interface-language="nl"]').click();
    await page.waitForFunction(()=>interfaceLanguage.statusKey==="settings.language.saveFailed"&&!interfaceLanguage.saving);
    assert.match(await page.locator("#header-language-status").textContent(),/Fixture save failure/);
    await page.unroute("**/api/settings/interface");await page.locator('[data-interface-language="nl"]').click();
    await page.waitForFunction(()=>interfaceLanguage.statusKey==="settings.language.saved"&&!interfaceLanguage.saving);
    assert.equal(await page.locator("#header-language-status").isVisible(),false);
    if(baseline) {
      const before=await browser.newPage({viewport:{width:1280,height:900}});
      await before.goto(baseline,{waitUntil:"load"});
      await before.waitForFunction(()=>state.mode==="live"&&!state.loading);
      await before.evaluate(async()=>{await TagcastI18n.use("nl");document.documentElement.dataset.theme="dark";setColourPalette("ocean");location.hash="#/album/72";});
      await before.waitForSelector(".album-detail-header");
      await before.locator(".topbar").screenshot({path:path.join(output,"before-header.png")});
      await before.screenshot({path:path.join(output,"before-1280-dark.png")});
      await before.close();
    }
  } finally {
    await browser.close();fs.writeFileSync(path.join(output,"results.json"),JSON.stringify({results,errors,writes},null,2));
  }
  assert.deepEqual(errors,[]);console.log(`${results.length} layout/playback cases and keyboard, Settings, cross-tab, reload and failure/retry checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
