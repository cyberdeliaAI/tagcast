"use strict";
const assert=require("node:assert/strict"),{writeFileSync}=require("node:fs");
// Separate bounded native check: do not enlarge the existing full-application smoke deadline.
function check({app,window,origin}){
  const report=process.env.TAGCAST_TRACK_COMPARISON_SMOKE_REPORT;
  if(!process.env.TAGCAST_HOME||!process.env.TAGCAST_ELECTRON_PROFILE)throw Error("Comparison smoke requires isolated settings/profile");
  const run=code=>window.webContents.executeJavaScript(code),samples=[],backendGuards=[];
  let done=false,phase="startup";
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);writeFileSync(report,JSON.stringify({...result,phase,samples,backendGuards},null,2));window.close();app.quit();};
  const timer=setTimeout(()=>finish({ok:false,error:"Track comparison check did not finish"}),30000);
  const frame=()=>run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const until=async(code)=>{const end=Date.now()+10000;while(!await run(code)){if(Date.now()>end)throw Error("No progress: "+code);await new Promise(r=>setTimeout(r,25));}};
  const click=async selector=>{
    const point=await run(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    window.webContents.sendInputEvent({type:"mouseMove",...point});await frame();
    const hit=await run(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),h=document.elementFromPoint(${point.x},${point.y}),r=n.getBoundingClientRect();return {ok:n.contains(h),hit:h?.id||h?.tagName,point:${JSON.stringify(point)},current:{x:r.x+r.width/2,y:r.y+r.height/2},height:innerHeight};})()`);
    assert.equal(hit.ok,true,selector+" receives pointer input: "+JSON.stringify(hit));
    for(const type of ["mouseDown","mouseUp"])window.webContents.sendInputEvent({type,...point,button:"left",clickCount:1});await frame();
  };
  window.webContents.once("did-finish-load",async()=>{
    try{
      await until("state.mode==='live'&&!state.loading&&state.albums.length>0&&lookup.sources.length>0");
      // The UI matrix below supplies provider replies, but these calls must pass through
      // the real bundled Studio and Lookup with an authenticated synthetic library.
      const account=await run("({album_id:String(state.albums[0].id),session:state.connection.playback_session})");
      assert.ok(account.session,"Synthetic account owns the loaded library");
      for(const path of ["search","release"]){
        const query=new URLSearchParams({...account,...(path==='release'?{id:'invalid'}:{artist:'',album:'Synthetic'})});
        const response=await fetch(origin+"/api/tracklist/"+path+"?"+query),body=await response.json();
        assert.equal(response.status,400,JSON.stringify(body));
        assert.equal(body.code,"track_comparison.invalid_request","Real Studio reaches input validation without provider I/O");
        backendGuards.push({path,status:response.status,code:body.code});
      }
      phase="fixture";
      await run(`document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close());globalThis.comparisonSmokeApi=api;globalThis.comparisonSmokeAudio=audio;globalThis.comparisonSmokeRequests=[];
        globalThis.comparisonSmokeWrites=[];globalThis.comparisonSmokeLyricsReads=[];
        globalThis.comparisonSmokeRelease={id:'12345678-1234-1234-1234-123456789abc',title:'Synthetic edition',artist:'Synthetic',date:'1990',country:'DE',formats:['CD'],labels:[],discs:1,track_count:2,url:'https://musicbrainz.org/release/12345678-1234-1234-1234-123456789abc'};
        api=async(path,body)=>{if(path.startsWith('/api/lyrics?'))comparisonSmokeLyricsReads.push(path);if(body){comparisonSmokeWrites.push(path);throw Error('Comparison attempted a write');}if(path.startsWith('/api/tracklist/')){comparisonSmokeRequests.push(path);return path.includes('/search?')?{releases:[comparisonSmokeRelease],total:1,offset:0,more:false,limit:200}:{release:comparisonSmokeRelease,tracks:[{disc:1,number:'1',title:'Different <title>',artist:'Synthetic',artist_credits:[{name:'Synthetic',phrase:null},{name:'Synthetic guest',phrase:'feat.'}],length:100},{disc:2,number:'1',title:'Bonus',artist:'Synthetic',artist_credits:[{name:'Synthetic',phrase:null}],length:null}],incomplete:true};}return comparisonSmokeApi(path,body);};void 0;`);
      for(const width of [420,760,768,1280])for(const theme of ["light","dark"]){
        phase=width+"/"+theme;window.setContentSize(width,800);
        await run(`(async()=>{await openAlbum(${JSON.stringify(account.album_id)});document.documentElement.dataset.theme=${JSON.stringify(theme)};
          renderAlbumView();})()`);
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
        const id=await run("trackComparison.tracks[0].id"),title=`[data-compare-track="${id}"][data-compare-field="title"]`;
        await click(title);
        assert.equal(await run("Object.keys(comparisonDraftPatches()).length"),1,"Explicit title choice stages one track");
        assert.equal(await run("JSON.stringify({queue:player.queue,index:player.index,src:audio.src,history:history.length,changes:state.history,details:[...state.details]})"),before);
        await click(title);
        assert.equal(await run("comparisonDraft.choices.size"),0,"Unchoosing clears the draft");
        assert.equal(await run("comparisonSmokeWrites.length"),0,"Choices/editor/review never attempt a mutation");
        window.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});await frame();
        assert.equal(await run("$('#track-comparison').open"),false);
        assert.equal(await run("document.activeElement.matches('[data-album-more]')"),true);
        samples.push({width,theme,pointer:true,keyboard:true,noWrites:true,noPlaybackChanges:true});
      }
      phase="editor-review";
      const initialLyricsReads=await run("comparisonSmokeLyricsReads.length");
      await click('[data-album-more]');await click('#album-action-compare');
      await click('#track-comparison-search');await until("!trackComparison.busy&&!!trackComparison.results");
      await click('[data-compare-release]');await until("!trackComparison.busy&&!!trackComparison.reference");
      const id=await run("trackComparison.tracks[0].id"),title=`[data-compare-track="${id}"][data-compare-field="title"]`;
          await click(title);await click(`[data-compare-track="${id}"][data-compare-field="artists"]`);
          await click('#comparison-draft-open');await until("$('#editor').open&&!!editing.trackPatches["+JSON.stringify(id)+"]");
          await run("repaintLyrics()");await frame();
          await click('#review-button');await until("$('#review').open&&!!pending");
          assert.equal(await run("pending.changes.every(c=>c.kind==='track'&&String(c.id)==="+JSON.stringify(id)+")"),true,"Only explicitly chosen track enters ordinary review");
          assert.equal(await run("JSON.stringify(Object.keys(pending.changes[0].fields).sort())"),JSON.stringify(['artist','credits','title']));
          assert.equal(await run("pending.changes[0].fields.credits.after.some(c=>c.name==='Synthetic guest'&&c.phrase==='feat.')"),true);
          await run("$('#review').close();$('#editor').close()");
      assert.equal(await run("comparisonSmokeWrites.length"),0,"Editor/review never attempts a write");
      assert.equal(await run("comparisonSmokeLyricsReads.length"),initialLyricsReads,"Initial correction handoff and review never start a native lyrics read");
      await run("api=comparisonSmokeApi;resetTrackComparison()");
      finish({ok:true,editorReview:true});
    }catch(error){await run("if(typeof comparisonSmokeApi==='function')api=comparisonSmokeApi;resetTrackComparison()").catch(()=>{});finish({ok:false,error:error.message});}
  });
}
module.exports={check};
