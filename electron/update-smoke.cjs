"use strict";

// Explicit package-check fixture: real preload/IPC, DOM and pointer input; no
// network or installer. Transfer/checksum tests use the real updater separately.
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {packageName} = require("./updates.cjs");

async function checkUpdates({window, updates}) {
  for(const name of ["MacUpdater","NsisUpdater","DebUpdater"]) assert.equal(typeof require("electron-updater")[name],"function","The packaged updater runtime must be present");
  const realTransport = require("./native-updater.cjs").createNativeUpdater(process.platform);
  assert.equal(realTransport.autoDownload,false);assert.equal(realTransport.autoInstallOnAppQuit,false);
  assert.notEqual(realTransport.netSession,window.webContents.session,"The updater cannot share sign-in or application cookies");
  let step = "snapshot";
  const owner = window.webContents, bounds = window.getBounds();
  const run = async code => {
    try { new (require("node:vm").Script)(code); return await owner.executeJavaScript(code); }
    catch (error) { throw Error(`Native update fixture ${step} (${code}): ${error.message}`); }
  };
  const frame = () => run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const until = async code => {
    for(let i=0;i<100;i++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,10));}
    throw Error(`Native update interface did not settle (${step}; ${code}): ${JSON.stringify(await run("({state:desktopUpdate.data,clicks:globalThis.updateSmokeClicks,focused:document.hasFocus()})"))}; native ${JSON.stringify(updates.snapshot())}`);
  };
  const click = async selector => {
    await run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center',behavior:'instant'})`);await frame();
    const target = await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))};})()`);
    assert.equal(target.hit,true,"Update control must receive real pointer input");
    owner.sendInputEvent({type:"mouseMove",x:Math.round(target.x),y:Math.round(target.y)});await frame();
    owner.sendInputEvent({type:"mouseDown",x:Math.round(target.x),y:Math.round(target.y),button:"left",clickCount:1});
    owner.sendInputEvent({type:"mouseUp",x:Math.round(target.x),y:Math.round(target.y),button:"left",clickCount:1});await frame();
  };
  const saved = {supported:updates.supported,reason:updates.reason,createUpdater:updates.createUpdater,onInstall:updates.onInstall,onConfirm:updates.onConfirm,
    updater:updates.updater,state:updates.state,version:updates.version,progress:updates.progress,error:updates.error,ready:updates.ready,installing:updates.installing,approved:updates.approved,installGeneration:updates.installGeneration};
  // The theme check reloads the page. Its account-free startup check must finish
  // before synthetic release data replaces it; did-finish-load is not API readiness.
  await until("updateNotice.data!==null&&!updateNotice.busy");
  await run("window.tagcastUpdates.status().then(applyDesktopUpdate)");
  const version=updates.current.split(".").map(Number);version[2]++;const next=version.join(".");
  const results=[];let complete, downloads=0, installs=0;
  const native = new EventEmitter();native.setFeedURL=()=>{};
  native.checkForUpdates=async()=>({updateInfo:{version:next,files:[{url:packageName(next,updates.platform,updates.arch),size:20,sha512:Buffer.alloc(64,12).toString("base64")}]}});
  native.downloadUpdate=()=>{downloads++;return new Promise(resolve=>{complete=resolve;});};
  native.quitAndInstall=()=>{throw Error("Native smoke must never execute an installer");};
  await run("globalThis.updateSmokeClicks=[];globalThis.updateSmokeClick=e=>updateSmokeClicks.push({id:e.target.id,type:e.type,latest:updateNotice.data?.latest,download:e.target.hasAttribute('data-update-download')});document.addEventListener('click',updateSmokeClick,true);globalThis.updateSmokeBefore={data:updateNotice.data,explicit:desktopUpdate.explicit,audio:audio,queue:player.queue,history:history.length,theme:document.documentElement.dataset.theme};void 0;");
  try {
    updates.supported=true;updates.reason="";updates.createUpdater=()=>native;
    updates.onConfirm=async()=>true;
    updates.onInstall=()=>{installs++;updates.defer("uncertain");};
    for(const width of [420,760,768,1280])for(const theme of ["light","dark"]){
      step = `${width}/${theme}`;
      window.setContentSize(width,800);window.show();window.focus();
      updates.updater=null;updates.state="idle";updates.version="";updates.ready=false;updates.busy=null;updates.installing=false;
      await run(`document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.documentElement.dataset.theme=${JSON.stringify(theme)};
        updateNotice.data={current:${JSON.stringify(updates.current)},latest:${JSON.stringify(next)},available:true,name:'Synthetic update',notes:${JSON.stringify('<img src="https://invalid.example/never-load">\nSynthetic release notes')}};desktopUpdate.explicit=true;
        window.tagcastUpdates.offer(${JSON.stringify(next)},false).then(applyDesktopUpdate);`);
      await until("desktopUpdate.data?.state==='available'");await run("openUpdateDetails()");await frame();
      assert.equal(await run("document.querySelector('#updates-content img')===null"),true,"Provider markup is text, not a resource request");
      assert.equal(await run("document.querySelector('#desktop-update-auto').checked"),false);
      assert.equal(await run("document.querySelector('#desktop-update-install').hidden"),true,"Installation is unavailable before download, including the first dialog frame");
      await click("#desktop-update-download");await until("desktopUpdate.data?.state==='downloading'");
      native.emit("download-progress",{percent:51});await frame();
      assert.equal(await run("document.querySelector('#desktop-update-status').textContent.includes('51')"),true);
      complete();await until("desktopUpdate.data?.state==='ready'");await click("#desktop-update-install");
      await until("desktopUpdate.data?.error==='uncertain'");
      assert.equal(await run("audio===updateSmokeBefore.audio&&player.queue===updateSmokeBefore.queue&&history.length===updateSmokeBefore.history"),true);
      results.push({width,theme,pointer:true,progress:true,deferredInstall:true,unchangedPlayback:true});
      await run("document.querySelector('#updates').close()");
    }
    assert.equal(downloads,8);assert.equal(installs,8);
    return {cases:results,providerRequests:0,installerExecutions:0,realAccountWrites:0};
  } finally {
    Object.assign(updates,saved);updates.publish();window.setBounds(bounds);
    await run("document.querySelector('#updates').close();updateNotice.data=updateSmokeBefore.data;desktopUpdate.explicit=updateSmokeBefore.explicit;document.documentElement.dataset.theme=updateSmokeBefore.theme;renderUpdateNotice();document.removeEventListener('click',updateSmokeClick,true);delete globalThis.updateSmokeClicks;delete globalThis.updateSmokeClick;delete globalThis.updateSmokeBefore;");
  }
}
module.exports={checkUpdates};
