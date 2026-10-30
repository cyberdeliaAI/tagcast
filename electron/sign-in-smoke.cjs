"use strict";
// Explicit native checks with disposable profiles. Never approves a real account.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {session} = require("electron");
const {SIGN_IN_PARTITION} = require("./sign-in.cjs");
function check({app, window, origin, signIn}) {
  if (!process.env.TAGCAST_HOME || !process.env.TAGCAST_ELECTRON_PROFILE) throw Error("Sign-in checks require disposable settings and profiles.");
  const report=process.env.TAGCAST_SIGN_IN_SMOKE_REPORT, shots=process.env.TAGCAST_SIGN_IN_SCREENSHOTS;
  const live=process.env.TAGCAST_SIGN_IN_LIVE_PAGE==='1', restart=process.env.TAGCAST_SIGN_IN_PHASE==='restart';
  const mock=process.env.TAGCAST_IBROADCAST_BASE;
  if(!live&&(!mock||new URL(mock).hostname!=='127.0.0.1'))throw Error('A loopback mock provider is required');
  const run=code=>window.webContents.executeJavaScript(code), sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await sleep(100);}throw Error('Sign-in condition did not complete');};
  const frame=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const capture=async(name,contents=window.webContents)=>{if(shots){await sleep(100);fs.writeFileSync(path.join(shots,name+'.png'),(await contents.capturePage()).toPNG());}};
  let finished=false, stage="boot";
  const done=result=>{if(finished)return;finished=true;clearTimeout(timer);fs.writeFileSync(report,JSON.stringify(result,null,2));window.close();app.quit();};
  const timer=setTimeout(()=>done({ok:false,error:'Sign-in check timed out'}),90000);
  window.webContents.once('did-finish-load',async()=>{
    let intercepted=false;
    try {
      await until(()=>run('typeof signInFlow!=="undefined"&&Boolean(state.connection.configured)'));
      if(!live){
        await session.fromPartition(SIGN_IN_PARTITION).protocol.handle('https',request=>{
          assert.equal(new URL(request.url).origin,'https://oauth.ibroadcast.com');
          return new Response('<!doctype html><meta charset="utf-8"><title>Controlled iBroadcast sign-in test</title><style>body{font:18px system-ui;background:white;color:#222;margin:60px 36px}h1{font-size:42px}button{font:inherit;background:#2587ed;color:white;padding:16px 40px;border:0;border-radius:8px}small{color:#555}</style><h1>iBroadcast</h1><p>Approve the connection to Tagcast.</p><p><button id="approve">Continue</button></p><small>Controlled test page · no real account</small>',{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'"}});
        });intercepted=true;
      }
      if(restart){
        stage="restart-bounds";
        const b=window.getBounds();assert.equal(b.width,1100);assert.equal(b.height,760);
        stage="restart-start";
        await run(`(async()=>{await api('/api/auth/logout',{});state.connection=await api('/api/status');openConnect();await beginSignIn(document.querySelector('#device-start'));})()`);
        await until(()=>Boolean(signIn.window));
        assert.equal(signIn.window.getBounds().width,502);assert.equal(signIn.window.getBounds().height,650);
        await until(()=>!signIn.window.webContents.isLoading()&&signIn.window.isVisible());stage="restart-close";signIn.window.close();await until(()=>run('!state.connection.device'));
        done({ok:true,phase:'restart',mainSizeRestored:true,signInSizeRestored:true});return;
      }
      stage="ready";await run('openConnect();globalThis.signInOriginalAudio=audio;');await capture('ready');
      await run('beginSignIn(document.querySelector("#device-start"))');await until(()=>Boolean(signIn.window));
      let view=signIn.window;
      await until(()=>!view.webContents.isLoading());
      const prefs=view.webContents.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.preload,undefined);
      assert.equal(new URL(view.webContents.getURL()).origin,'https://oauth.ibroadcast.com');
      await capture(live?'official-ibroadcast-page':'mock-approval-page',view.webContents);
      await capture('pending');
      if(live){
        const fields=await view.webContents.executeJavaScript('({email:Boolean(document.querySelector("input[type=email]")),password:Boolean(document.querySelector("input[type=password]")),bridge:typeof window.tagcastSignIn})');
        assert.equal(fields.email,true);assert.equal(fields.password,true);assert.equal(fields.bridge,'undefined');
        view.close();await until(()=>run('!state.connection.device'));
        assert.equal(await run('state.connection.connected'),false);
        done({ok:true,livePublicPageLoaded:true,approvedRealAccount:false,closedAndCancelled:true,noPreload:true,sandbox:true});return;
      }
      stage="cancel";view.setSize(502,650);await sleep(300);view.close();
      await until(()=>run('!state.connection.device'));
      stage="layouts";const layouts=[];
      for(const width of [420,760,761,768,1280]){
        window.setSize(width,800);await frame();
        const result=await run('({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,dialog:document.querySelector("#connect").getBoundingClientRect().width})');
        assert.equal(result.overflow,false);layouts.push(result);await capture('ready-'+width);
      }
      window.setSize(1280,800);
      for(const palette of ['forest','ocean','warm','ibroadcast'])for(const theme of ['light','dark']){
        await run(`setColourPalette('${palette}');document.documentElement.dataset.theme='${theme}';showTheme();`);await capture('ready-'+palette+'-'+theme);
      }
      window.webContents.setZoomFactor(2);await frame();assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false);await capture('ready-zoom200');window.webContents.setZoomFactor(1);
      await run('beginSignIn(document.querySelector("#device-start"))');await until(()=>Boolean(signIn.window));
      assert.equal(signIn.window.getBounds().width,502);assert.equal(signIn.window.getBounds().height,650);
      stage="denial";await fetch(mock+'/_signin/outcome',{method:'POST',body:JSON.stringify('deny')});
      await until(()=>run('document.querySelector("#connect-content").textContent.includes("denied")'));
      assert.equal(signIn.window,null);assert.equal(await run('state.connection.connected'),false);await capture('denied');
      await run('beginSignIn(document.querySelector("#device-start"))');await until(()=>Boolean(signIn.window));view=signIn.window;
      await until(()=>!view.webContents.isLoading());
      stage="browser-fallback";
      await view.webContents.executeJavaScript("location.href='https://example.invalid/';").catch(()=>{});
      await until(()=>!signIn.window&&run('document.querySelector("#connect-content").textContent.includes("needs your browser")'));
      await capture('browser-fallback');
      await run('reopenSignIn()');await until(()=>Boolean(signIn.window));view=signIn.window;
      await until(()=>!view.webContents.isLoading());
      await view.webContents.executeJavaScript('document.querySelector("#approve").focus()');
      view.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});view.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
      stage="approval";await fetch(mock+'/_signin/outcome',{method:'POST',body:JSON.stringify('approve')});
      await until(()=>run('state.connection.connected&&state.mode==="live"&&!state.loading'));
      assert.equal(signIn.window,null);assert.equal(await run('signInOriginalAudio===audio'),true);
      assert.equal(await run('document.querySelector("#connect").open'),false);
      assert.equal(await run('document.querySelector("#playlist-count").textContent'),"2");
      assert.equal(await run('document.querySelector("#playlist-count").hidden'),false);
      await capture('connected');
      const provider=await(await fetch(mock+'/_signin/check')).json();assert.equal(provider.writes,0);
      window.setSize(1100,760);await sleep(300);
      done({ok:true,phase:'initial',openedOfficialOrigin:true,noPreload:true,sandbox:true,closedAndCancelled:true,deniedAndRetried:true,browserFallback:true,connectedAndReturned:true,sameAudio:true,playlistCount:2,layouts,windowSizeRemembered:true,provider});
    }catch(error){done({ok:false,error:error.message,stage,childOpen:Boolean(signIn.window),ui:await run('({pending:state.connection.device?.state,connected:state.connection.connected,opening:signInFlow.opening,modal:document.querySelector("#connect").open,polling:devicePoll!==null})').catch(()=>null)});}
    finally{if(intercepted)session.fromPartition(SIGN_IN_PARTITION).protocol.unhandle('https');}
  });
}
module.exports={check};
