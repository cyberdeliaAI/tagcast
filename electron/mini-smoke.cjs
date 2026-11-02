"use strict";
// Disposable, disconnected packaging check. Synthetic silence only; no account or music.
const assert = require("node:assert/strict");
const {once} = require("node:events");
const {writeFileSync} = require("node:fs");
const path = require("node:path");

async function waitForNativeState(predicate, description, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw Error("Native window did not settle: " + description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function closeFromRenderer(view, action) {
  // A renderer destroyed by its own command may never settle executeJavaScript.
  // Observe the native close before dispatching; still require an actual close.
  const controller = new AbortController();
  const closed = once(view, "closed", {signal: controller.signal});
  try {
    await Promise.race([closed, Promise.resolve().then(action).catch(error => {
      if (!view.isDestroyed()) throw error;
    })]);
    await closed;
  } finally { controller.abort(); }
}

async function ownerReturned(owner, now = () => performance.now()) {
  // macOS may update isVisible/isFocused before delivering the matching events.
  // Observe restoration before dispatch, then drain its native event burst before
  // another synthetic user action. Some macOS versions emit focus without show.
  const names = ["show", "hide", "focus", "blur"];
  let observed = false, last = now();
  const changed = () => { observed = true; last = now(); };
  for (const name of names) owner.on(name, changed);
  try {
    await waitForNativeState(() => observed && owner.isVisible() && owner.isFocused()
      && now() - last >= 250, "restored main window and settled native events");
  } finally { for (const name of names) owner.removeListener(name, changed); }
}

async function checkMini({window, miniPlayer, checkpoint = () => {}}) {
  const owner = window.webContents, originalBounds = window.getBounds(), nativeEvents=[];
  for(const name of ["show","hide","focus","blur"])window.on(name,()=>nativeEvents.push([name,window.isVisible(),Boolean(miniPlayer.window)]));
  checkpoint("synthetic-audio");
  await owner.executeJavaScript(`(async()=>{
    globalThis.miniTestAudio=document.querySelector('#audio');
    globalThis.miniTestQueue=player.queue;gaplessTrial.enabled=false;
    const data=new ArrayBuffer(44+44100*2*60),v=new DataView(data);const text=(p,s)=>{for(let n=0;n<s.length;n++)v.setUint8(p+n,s.charCodeAt(n));};
    text(0,'RIFF');v.setUint32(4,data.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,44100,true);v.setUint32(28,88200,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,data.byteLength-44,true);
    globalThis.miniTestUrl=URL.createObjectURL(new Blob([data],{type:'audio/wav'}));
    audio.muted=true;audio.src=miniTestUrl;await new Promise(resolve=>audio.addEventListener('loadedmetadata',resolve,{once:true}));await audio.play();
  })()`);
  let mini;
  async function openMini() {
    assert.equal(window.isVisible(), true, "Tagcast must be restored before another user opens Mini Player");
    if (!window.isFocused()) {
      const focused = once(window, "focus");
      window.focus(); await focused;
    }
    miniPlayer.open(); mini = miniPlayer.window;
    const view = mini;
    await waitForNativeState(() => {
      if (view.isDestroyed()) throw Error("Mini Player closed while opening: " + JSON.stringify(nativeEvents));
      return view.isVisible() && !view.webContents.isLoadingMainFrame()
        && view.webContents.getURL().endsWith("/mini-player/index.html");
    }, "Mini Player load and visibility");
  }
  checkpoint("open");
  await openMini();
  const errors=[];mini.webContents.on("console-message",(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  async function waitFor(expression) {
    for(let n=0;n<50;n++) { if(await miniPlayer.window.webContents.executeJavaScript(expression))return;await new Promise(resolve=>setTimeout(resolve,40)); }
    throw Error("Mini Player did not receive its current state: "+expression);
  }
  checkpoint("state");
  await waitFor('Boolean(playback?.entry && playback.seekable)');
  assert.equal(window.isVisible(),false,'Only the Mini Player is visible');
  const security=mini.webContents.getLastWebPreferences();
  // A foreign renderer cannot act as the owner even by calling a known channel.
  assert.equal(await mini.webContents.executeJavaScript('bridge.command({action:"seek",document:"foreign",entry:"",segment:"",position:1})'),false);assert.ok(security.sandbox&&security.contextIsolation&&security.webSecurity&&!security.nodeIntegration);
  assert.equal(await mini.webContents.executeJavaScript('document.querySelectorAll("audio,video").length'),0);
  assert.equal(await mini.webContents.executeJavaScript('typeof require'),"undefined");
  assert.equal(await mini.webContents.executeJavaScript('typeof window.tagcastMiniOwner'),"undefined");
  assert.equal(await mini.webContents.executeJavaScript('(async()=>{try{await fetch("/api/status");return false;}catch{return true;}})()'),true);
  // The blocked fetch above is an intentional CSP probe.
  errors.length=0;
  checkpoint("transport");
  const action=code=>mini.webContents.executeJavaScript(code);
  assert.equal(await action('bridge.command({...playback,action:"pause"})'),true);
  assert.equal(await owner.executeJavaScript('audio.paused'),true);
  assert.equal(await action('bridge.command({...playback,action:"seek",position:1})'),true);
  assert.ok(Math.abs(await owner.executeJavaScript('audio.currentTime')-1)<.05);
  assert.equal(await action('bridge.command({...playback,action:"play"})'),true);
  mini.minimize();assert.equal(await action('bridge.command({...playback,action:"pause"})'),true);
  assert.equal(await owner.executeJavaScript('audio.paused'),true);
  assert.equal(await action('bridge.command({...playback,action:"play"})'),true);
  mini.restore();assert.equal(window.isVisible(),false);
  checkpoint("return-to-main");
  const returned = ownerReturned(window);
  await closeFromRenderer(mini, () => action('bridge.openMain()'));
  await returned;
  await waitForNativeState(() => window.isVisible() && !window.isMinimized(), "return to Tagcast");
  assert.equal(miniPlayer.window,null,'Returning to Tagcast closes Mini Player');
  assert.equal(await owner.executeJavaScript('audio.paused'),false);
  checkpoint("reopen");
  await openMini();await waitFor('Boolean(playback?.entry)');
  assert.equal(window.isVisible(),false);
  assert.equal(await action('bridge.pin(true)'),true);assert.equal(mini.isAlwaysOnTop(),true);
  await action('bridge.pin(false)');
  await owner.executeJavaScript(`player.queue[0].title="A long track title · Live at the concert hall (Original album version)";player.queue[0].artist="The Tagcast Test Ensemble";renderCurrentPlayerTrack();`);
  checkpoint("presentation");
  const shots=process.env.TAGCAST_MINI_SCREENSHOTS;
  if(shots) {
    for(const [width,theme,palette] of ['forest','ocean','warm','ibroadcast','apple'].flatMap(palette=>['light','dark'].map(theme=>[theme==='light'?420:520,theme,palette]))) {
      mini.setSize(width,210);
      await owner.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.palette=${JSON.stringify(palette)};publishMiniPlayer()`);
      await waitFor(`playback.theme===${JSON.stringify(theme)}&&playback.palette===${JSON.stringify(palette)}`);
      await action('bridge.pin(true)');
      await new Promise(resolve=>setTimeout(resolve,80));
      const contrast=await action(`(()=>{const s=getComputedStyle(nodes.pin);const rgb=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});const l=c=>{const v=rgb(c);return .2126*v[0]+.7152*v[1]+.0722*v[2];};const a=l(s.color),b=l(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);})()`);
      assert.ok(contrast>=4.5,`Pin contrast ${palette}/${theme}: ${contrast}`);
      assert.equal(await action('document.documentElement.scrollWidth>innerWidth'),false);
      writeFileSync(path.join(shots,`mini-${width}-${theme}-${palette}.png`),(await mini.webContents.capturePage()).toPNG());
    }
    await action("bridge.pin(false)");mini.webContents.setZoomFactor(2);mini.setSize(520,550);await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(await action('document.documentElement.scrollWidth>innerWidth'),false);
    writeFileSync(path.join(shots,'mini-200-percent.png'),(await mini.webContents.capturePage()).toPNG());mini.webContents.setZoomFactor(1);
  }
  if(process.env.TAGCAST_MINI_VISUAL_REPORT)await require("./mini-visual.cjs").captureMini({owner,mini});
  checkpoint("close");
  const pausedBeforeClose=await owner.executeJavaScript("audio.paused");
  const preserved=await owner.executeJavaScript('miniTestAudio===audio&&miniTestQueue===player.queue');assert.equal(preserved,true);
  const restored = ownerReturned(window);
  const closed = once(mini, "closed");
  mini.close(); await closed; await restored;
  await waitForNativeState(() => window.isVisible(), "close restores Tagcast");
  assert.equal(await owner.executeJavaScript('audio.paused'),pausedBeforeClose);
  assert.equal(await owner.executeJavaScript('miniOwner.timer'),null);
  assert.equal(window.isVisible(),true,'Closing Mini Player restores Tagcast');
  checkpoint("window-menu-return");
  await openMini();await waitFor('Boolean(playback?.entry)');
  window.show();window.focus();await new Promise(resolve=>setTimeout(resolve,80));
  for(let n=0;n<50&&miniPlayer.window;n++)await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(Boolean(miniPlayer.window),false,'Window-menu return: '+JSON.stringify({events:nativeEvents,ownerVisible:window.isVisible(),ownerFocused:window.isFocused(),miniVisible:miniPlayer.window?.isVisible()}));
  assert.equal(await owner.executeJavaScript('audio.paused'),pausedBeforeClose);
  checkpoint("cleanup");
  await owner.executeJavaScript('audio.pause();audio.removeAttribute("src");audio.load();URL.revokeObjectURL(miniTestUrl);');
  window.setBounds(originalBounds);
  return {sameAudio:true,sameQueue:true,passiveWindow:true,seek:true,transport:true,hiddenOwner:true,minimizedMini:true,singleVisibleWindow:true,returnClosesMini:true,closeRestoresMain:true,closePreservesPlayback:true,reopen:true,sandbox:true,apiBlocked:true,errors};
}
module.exports={checkMini, closeFromRenderer, waitForNativeState, ownerReturned};
