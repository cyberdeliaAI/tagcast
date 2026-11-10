"use strict";

// Test-only entry point, following smoke.cjs: private profile/home and a numeric
// loopback fixture are mandatory. All writes below target that disposable fixture.
const {writeFileSync} = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {dialog} = require("electron");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error("No progress: " + description);
    await wait(25);
  }
}

function check({app, window, origin, backend, shutdownView}) {
  const report=process.env.TAGCAST_SHUTDOWN_SMOKE_REPORT, scenario=process.env.TAGCAST_SHUTDOWN_SMOKE_CASE;
  const base=new URL(process.env.TAGCAST_IBROADCAST_BASE);
  if(!process.env.TAGCAST_HOME||!process.env.TAGCAST_ELECTRON_PROFILE||base.hostname!=="127.0.0.1"||base.protocol!=="http:")
    throw Error("Shutdown smoke requires isolated settings, profile and loopback fixture");
  const observations={case:scenario,origin,phases:[],feedback:false,rendererRetained:false,secondInstance:false,reopened:false};
  const record=value=>writeFileSync(report,JSON.stringify({...observations,...value},null,2));
  const control=action=>fetch(base.origin+"/_shutdown/"+action).then(r=>r.json());
  const api=async(route,body)=>{
    const response=await fetch(origin+route,body===undefined?{}:{method:"POST",headers:{"X-Tagcast":"1"},body:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw Error("Fixture API "+route+": "+JSON.stringify(data));return data;
  };
  let prepared=false,failure=null,idle=null;
  const original=backend.onShutdown;
  const originalReady=backend.onShutdownReady;
  backend.onShutdownReady=async status=>{
    const approved=await originalReady(status);
    if(scenario==="write"){
      observations.historySaved=await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('tagcast-history')||'[]')[0]?.status==='saved'");
      if(!observations.historySaved)failure="Confirmed result was not flushed to History";
    }
    return approved;
  };
  backend.onShutdown=status=>{
    original(status);
    observations.phases.push(status.phase);
    observations.lastProgress=status;
    observations.uncertain=Boolean(observations.uncertain||status.uncertain);
    const view=shutdownView.window;
    observations.feedback ||= Boolean(view&&!view.isDestroyed()&&view.isVisible());
    observations.rendererRetained ||= !window.isDestroyed()&&!window.isVisible();
    record({ok:false,pending:true});
  };
  // Automated choice only in this isolated test. Production uses the real native dialog.
  dialog.showMessageBoxSync=()=>1;
  dialog.showErrorBox=()=>{observations.errorFeedback=true;};
  app.on("second-instance",()=>{observations.secondInstance=true;});
  app.once("will-quit",()=>{
    if(!prepared&&!failure)failure="Quit before scenario completed";
    if(scenario==="backend-exit"){
      if(!observations.errorFeedback)failure||="Backend interruption had no visible error path";
    }else{
      if(!observations.feedback||!observations.rendererRetained)failure||="Closing feedback or retained renderer missing";
      if(backend.child.exitCode!==0)failure||="Backend did not exit cleanly before shell";
    }
    if(["write","readback","uncertain","cleanup"].includes(scenario)&&observations.writes!==1)failure||="Mutation was missing or repeated";
    if(scenario==="upload"&&(!observations.uncertain||observations.uploads!==1))failure||="Interrupted upload was not marked uncertain";
    if(scenario==="stalled-read"&&!observations.secondInstance)failure||="Second launch did not reach shutdown feedback";
    record({ok:!failure,error:failure,pending:false,pid:backend.child.pid});
    idle?.destroy();
  });
  record({ok:false,pending:true});
  window.webContents.once("did-finish-load",async()=>{
    try {
      await until(()=>window.webContents.executeJavaScript("state.mode==='live'&&!state.loading&&state.albums.length>0"),"loaded fixture");
      const status=await api("/api/status"),session=status.playback_session;
      if(!session)throw Error("Fixture session missing");
      if(scenario==="backend-exit"){
        if((await control("state")).writes!==0)throw Error("Crash fixture must not have mutations");
        prepared=true;
        process.kill(backend.child.pid,process.platform==="win32"?"SIGTERM":"SIGKILL");
        return;
      }
      if(scenario==="history-restart"){
        observations.historyRestored=await window.webContents.executeJavaScript("state.history[0]?.status==='saved'");
        if(!observations.historyRestored)throw Error("Confirmed History lost on full restart");
      }
      await control("arm");
      let operation;
      if(scenario==="idle-tcp"){
        idle=net.connect(new URL(origin).port,"127.0.0.1");
        await new Promise((resolve,reject)=>{idle.once("connect",resolve);idle.once("error",reject);});
      }
      if(scenario==="write"){
        operation=window.webContents.executeJavaScript(`(async()=>{
          const changes=[{kind:'album',id:'72',albumId:'72',label:'Synthetic',fields:{year:{before:0,after:1985}}}];
          const entry={source:'ibroadcast',status:'sent',selection:[],changes};
          state.history.unshift(entry);saving=true;
          try {const result=await api('/api/save',{changes});followJob(result.job,entry);return result;}
          finally {saving=false;}
        })()`);
      }else if(["readback","uncertain"].includes(scenario)){
        operation=api("/api/save",{changes:[{kind:"album",id:"72",albumId:"72",label:"Synthetic",fields:{year:{before:0,after:1985}}}]}).catch(error=>({error:error.message}));
      }else if(scenario==="cleanup"){
        const review=await api("/api/cleanup/preview",{category:"genres"});
        await api("/api/cleanup/start",{id:review.id,excluded:[]});
      }else if(["stalled-read","reopen"].includes(scenario)){
        operation=api("/api/overview").catch(error=>({error:error.message}));
      }else if(scenario==="stream"){
        await window.webContents.executeJavaScript(`(()=>{const audio=document.querySelector('audio');audio.muted=true;audio.src='/api/stream/900';audio.play().catch(()=>{});})()`,true);
      }else if(scenario==="download"){
        await api("/api/downloads/add",{session,albums:["72"]});
        await api("/api/downloads/prepare",{session,out:path.join(process.env.TAGCAST_HOME,"audio"),quality:"128"});
        let review;
        await until(async()=>{review=await api("/api/downloads?session="+session);return !review.preparing;},"download review");
        if(!review.review)throw Error("Download review missing: "+JSON.stringify(review));
        await api("/api/downloads/start",{session,id:review.review.id});
      }else if(scenario==="upload"){
        await api("/api/uploads/prepare",{session,paths:[path.join(process.env.TAGCAST_HOME,"../synthetic.flac")]});
        let review;
        await until(async()=>{review=await api("/api/uploads?session="+session);return !review.preparing;},"upload review");
        if(!review.review)throw Error("Upload review missing: "+JSON.stringify(review));
        await api("/api/uploads/start",{session,review:review.review});
      }else if(scenario==="folder"){
        let settled=false;
        operation=api("/api/downloads/folder",{session}).then(value=>{settled=true;observations.picker=value;}).catch(()=>{settled=true;});
        await wait(500);
        observations.pickerPending=!settled;
      }
      if(!["idle","idle-tcp","folder","history-restart","backend-restart"].includes(scenario))await until(async()=>(await control("state")).reached,"upstream operation");
      if(scenario==="readback")await operation;
      if(scenario==="stream"){
        await until(()=>window.webContents.executeJavaScript("!document.querySelector('audio').paused&&document.querySelector('audio').currentTime>0"),"active audio");
        observations.audioPlaying=true;
      }
      if(scenario==="upload"){
        observations.uploads=(await control("state")).uploads;
        prepared=true;
      }
      if(["write","readback","uncertain","cleanup"].includes(scenario))observations.writes=(await control("state")).writes;
      window.close();
      if(["write","readback","uncertain","cleanup","stalled-read","reopen"].includes(scenario)){
        await until(()=>observations.phases.some(p=>p!=="ready"),"protected shutdown progress");
        const identity=await api("/api/app");
        if(!identity.closing||backend.child.exitCode!==null)throw Error("Backend stopped during protected work");
        observations.portRetained=true;
        if(scenario==="stalled-read"){
          // Xvfb has no window manager to implement native minimization. Hiding
          // still requires the second process to restore the real status window.
          shutdownView.window.hide();
          await until(()=>!shutdownView.window.isVisible(),"hidden feedback");
          const env={...process.env};delete env.TAGCAST_SHUTDOWN_SMOKE_REPORT;delete env.TAGCAST_SHUTDOWN_SMOKE_CASE;
          const second=spawn(app.getPath("exe"),app.isPackaged?[]:[__dirname],{env,stdio:"ignore",windowsHide:true});
          const exit=await new Promise(resolve=>second.once("exit",resolve));
          if(exit!==0)throw Error("Second application launch failed");
          await until(()=>observations.secondInstance&&shutdownView.window.isVisible(),"second-instance feedback");
        }
        if(scenario==="reopen"){
          const pid=backend.child.pid;
          await until(()=>shutdownView.window.webContents.executeJavaScript("!document.getElementById('reopen').disabled"),"reopen control");
          await shutdownView.window.webContents.executeJavaScript("document.getElementById('reopen').click()");
          await until(()=>!backend.stopping&&window.isVisible(),"same application reopened");
          if(backend.child.pid!==pid||(await api("/api/app")).closing)throw Error("Reopen replaced backend or left admission closed");
          observations.reopened=true;
          await control("release");await operation;
          prepared=true;window.close();return;
        }
        prepared=true;
        await control("release");
        if(operation)await operation;
      }
      prepared=true;
    }catch(error){
      if(scenario==="stream")observations.audio=await window.webContents.executeJavaScript(`(()=>{const a=document.querySelector('audio');return {paused:a.paused,ready:a.readyState,network:a.networkState,time:a.currentTime,error:a.error?.code};})()`).catch(()=>null);
      failure=error.message;record({ok:false,error:failure});
      await control("release").catch(()=>{});prepared=true;app.quit();
    }
  });
}
module.exports={check};
