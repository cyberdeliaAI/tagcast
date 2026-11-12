"use strict";
const assert=require("node:assert/strict"),{writeFileSync}=require("node:fs");
// Separate bounded native check: do not enlarge the existing full-application smoke deadline.
function check({app,window,origin}){
  const report=process.env.TAGCAST_TRACK_COMPARISON_SMOKE_REPORT;
  if(!process.env.TAGCAST_HOME||!process.env.TAGCAST_ELECTRON_PROFILE)throw Error("Comparison smoke requires isolated settings/profile");
  const run=code=>window.webContents.executeJavaScript(code),samples=[];
  let done=false,phase="startup";
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);writeFileSync(report,JSON.stringify({...result,phase,samples},null,2));window.close();app.quit();};
  const timer=setTimeout(()=>finish({ok:false,error:"Track comparison check did not finish"}),30000);
  const frame=()=>run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const until=async(code)=>{const end=Date.now()+10000;while(!await run(code)){if(Date.now()>end)throw Error("No progress: "+code);await new Promise(r=>setTimeout(r,25));}};
  const click=async selector=>{
    const point=await run(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    window.webContents.sendInputEvent({type:"mouseMove",...point});await frame();
    assert.equal(await run(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`),true,selector+" receives pointer input");
    for(const type of ["mouseDown","mouseUp"])window.webContents.sendInputEvent({type,...point,button:"left",clickCount:1});await frame();
  };
  window.webContents.once("did-finish-load",async()=>{
    try{
      await until("state.mode==='demo'&&lookup.sources.length>0");
      for(const path of ["search","release"]){
        const response=await fetch(origin+"/api/tracklist/"+path+"?album_id=1&session=synthetic");
        assert.equal(response.status,401,"Packaged backend requires an account before provider I/O");
      }
      phase="fixture";
      await run(`document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close());globalThis.comparisonSmokeApi=api;globalThis.comparisonSmokeAudio=audio;globalThis.comparisonSmokeRequests=[];
        globalThis.comparisonSmokeRelease={id:'12345678-1234-1234-1234-123456789abc',title:'Synthetic edition',artist:'Synthetic',date:'1990',country:'DE',formats:['CD'],labels:[],discs:1,track_count:2,url:'https://musicbrainz.org/release/12345678-1234-1234-1234-123456789abc'};
        api=async(path,body)=>{if(path.startsWith('/api/tracklist/')){if(body)throw Error('Comparison attempted a write');comparisonSmokeRequests.push(path);return path.includes('/search?')?{releases:[comparisonSmokeRelease],total:1,offset:0,more:false,limit:200}:{release:comparisonSmokeRelease,tracks:[{disc:1,number:'1',title:'Different <title>',artist:'Synthetic',length:100},{disc:2,number:'1',title:'Bonus',artist:'Synthetic',length:null}],incomplete:true};}return comparisonSmokeApi(path,body);};void 0;`);
      for(const width of [420,760,768,1280])for(const theme of ["light","dark"]){
        phase=width+"/"+theme;window.setContentSize(width,800);
        await run(`(async()=>{state.mode='demo';await openAlbum('1');document.documentElement.dataset.theme=${JSON.stringify(theme)};
          state.mode='live';state.connection.playback_session='synthetic-comparison';renderAlbumView();})()`);
        await frame();
        const before=await run("JSON.stringify({queue:player.queue,index:player.index,src:audio.src,history:history.length,changes:state.history,details:[...state.details]})");
        const count=await run("comparisonSmokeRequests.length");
        await click('[data-album-more]');await click('#album-action-compare');
        assert.equal(await run("$('#track-comparison').open"),true);
        assert.equal(await run("comparisonSmokeRequests.length"),count,"Opening is local only");
        await click('#track-comparison-search');await until("!trackComparison.busy&&!!trackComparison.results");
        await click('[data-compare-release]');await until("!trackComparison.busy&&!!trackComparison.reference");
        assert.equal(await run("$('#track-comparison-table').innerHTML.includes('Different &lt;title&gt;')"),true);
        assert.equal(await run("comparisonSmokeRequests.length"),count+2,"One search and one explicit edition read");
        assert.equal(await run("document.documentElement.scrollWidth<=innerWidth&&$('#track-comparison').scrollWidth<=$('#track-comparison').clientWidth"),true,"No horizontal overflow");
        assert.equal(await run("JSON.stringify({queue:player.queue,index:player.index,src:audio.src,history:history.length,changes:state.history,details:[...state.details]})"),before);
        assert.equal(await run("audio===comparisonSmokeAudio"),true);
        window.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});await frame();
        assert.equal(await run("$('#track-comparison').open"),false);
        assert.equal(await run("document.activeElement.matches('[data-album-more]')"),true);
        samples.push({width,theme,pointer:true,keyboard:true,noWrites:true,noPlaybackChanges:true});
      }
      await run("api=comparisonSmokeApi;state.mode='demo';resetTrackComparison()");
      finish({ok:true});
    }catch(error){await run("if(typeof comparisonSmokeApi==='function')api=comparisonSmokeApi;state.mode='demo';resetTrackComparison()").catch(()=>{});finish({ok:false,error:error.message});}
  });
}
module.exports={check};
