"use strict";
const assert = require("node:assert/strict");

// Only local preferences in the isolated disconnected demo; never begin OAuth or media requests.
async function checkSetup(window) {
  const owner = window.webContents, bounds = window.getBounds(), run = code => owner.executeJavaScript(code);
  const frame = () => run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const click = async selector => {
    const point = await run(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const hit = await run(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`);
    assert.equal(hit, true, selector + " receives pointer input");
    owner.sendInputEvent({type:"mouseDown",...point,button:"left",clickCount:1});
    owner.sendInputEvent({type:"mouseUp",...point,button:"left",clickCount:1}); await frame();
  };
  const before = await run(`(()=>{globalThis.setupSmokeAudio=audio;globalThis.setupSmokeFetch=fetch;globalThis.setupSmokeWrites=0;
    globalThis.fetch=(url,options)=>{if(options?.method==='POST')setupSmokeWrites++;return setupSmokeFetch(url,options)};
    return {stored:localStorage.getItem(FIRST_SETUP_KEY),appearance:document.documentElement.dataset.theme,
      preferences:JSON.stringify([lookup.streamQuality,lookup.recordPlays,lookup.queueSync,gaplessTrial.enabled,playbackLyricsView.mode,visualPlayerMode]),
      queue:JSON.stringify(player.queue),src:audio.src,history:history.length,progress:firstSetup.progress,step:firstSetup.step};})()`);
  const samples = [];
  try {
    assert.equal(await run('state.connection.connected'), false);
    for (const width of [420,760,768,1280]) for (const appearance of ["light","dark"]) {
      window.setContentSize(width,800);
      await run(`document.documentElement.dataset.theme=${JSON.stringify(appearance)};firstSetup.progress=null;firstSetup.drafts.clear();firstSetup.baselines.clear();openFirstSetup()`); await frame();
      assert.equal(await run("$('#first-setup').open"),true);
      await click('[data-setup-demo]');
      for (let step=1;step<5;step++) {
        assert.equal(await run('firstSetup.step'),step);
        assert.ok(await run('document.documentElement.scrollWidth-innerWidth<=1'));
        await click('[data-setup-skip]');
      }
      await click('[data-setup-next]');
      assert.equal(await run("$('#first-setup').open"),false);
      assert.equal(await run("readFirstSetup().status"),'done');
      await run('openFirstSetup()');await frame();
      owner.sendInputEvent({type:'keyDown',keyCode:'Escape'});owner.sendInputEvent({type:'keyUp',keyCode:'Escape'});await frame();
      assert.equal(await run("$('#first-setup').open"),false);
      assert.equal(await run('setupSmokeAudio===audio'),true);
      samples.push({width,appearance,pointer:true,keyboard:true,skipWithoutWrites:true});
    }
    const after=await run('({preferences:JSON.stringify([lookup.streamQuality,lookup.recordPlays,lookup.queueSync,gaplessTrial.enabled,playbackLyricsView.mode,visualPlayerMode]),queue:JSON.stringify(player.queue),src:audio.src,history:history.length,writes:setupSmokeWrites})');
    for(const key of ['preferences','queue','src','history'])assert.equal(after[key],before[key],key+' unchanged');
    assert.equal(after.writes,0,'Skipped setup never writes settings or starts a remote operation');
    return samples;
  } finally {
    window.setBounds(bounds);
    await run(`globalThis.fetch=setupSmokeFetch;if($('#first-setup').open)pauseFirstSetup();firstSetup.progress=${JSON.stringify(before.progress)};firstSetup.step=${before.step};firstSetup.drafts.clear();firstSetup.baselines.clear();
      ${before.stored===null?'localStorage.removeItem(FIRST_SETUP_KEY)':`localStorage.setItem(FIRST_SETUP_KEY,${JSON.stringify(before.stored)})`};
      ${before.appearance?`document.documentElement.dataset.theme=${JSON.stringify(before.appearance)}`:'delete document.documentElement.dataset.theme'};`);
  }
}
module.exports = {checkSetup};
