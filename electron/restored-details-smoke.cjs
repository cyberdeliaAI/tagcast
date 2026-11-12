"use strict";
const assert = require("node:assert/strict");

// Restore through the real frontend using only synthetic in-memory HTTP replies.
async function checkRestoredDetails({window, run, click, frame}) {
  const bounds=window.getBounds(),samples=[];
  // Establish the browsing route before measuring restore/panel history invariants.
  await run("setNowPlaying(false);showScreen('albums');render()");await frame();
  await run(`globalThis.restoredDetailsSmoke={details:state.details,albums:state.albums,connection:state.connection,
    mode:state.mode,loading:state.loading,queue:player.queue,index:player.index,album:player.album,epoch:player.epoch,
    resume:player.resumePending,repeat:player.repeat,shuffle:player.shuffle,memory:{...queueMemory},fetch:globalThis.fetch,
    audio,src:audio.src,history:history.length,stored:localStorage.getItem('tagcast-queue-'+ 'a'.repeat(64))};void 0;`);
  try {
    for(const width of [420,760,768,1280])for(const appearance of ["light","dark"]){
      window.setContentSize(width,800);
      await run(`(async()=>{
        setNowPlaying(false);showScreen('albums');document.documentElement.dataset.theme=${JSON.stringify(appearance)};
        state.details=new Map();state.albums=[{id:'restored-album',name:'Restored album',artist:'Album artist',year:1972,
          disc:2,rating:4,track_count:6,genres:['Jazz'],uploaded_at:'2026-11-12T09:00:00'}];
        state.mode='live';state.loading=false;state.connection={connected:true,premium:true,playback_session:'synthetic-restore'};
        player.queue=[];player.index=-1;player.epoch++;queueMemory.attempted='';bindQueueMemory('a'.repeat(64));
        localStorage.setItem('tagcast-queue-'+'a'.repeat(64),JSON.stringify({version:1,entries:[{id:'900'},{id:'900',upNext:true}],index:1,repeat:'none',shuffle:false}));
        globalThis.restoredDetailRequests=0;globalThis.fetch=async(url,options)=>{
          if(url!=='/api/queue-tracks')throw Error('Unexpected restore request: '+url);
          restoredDetailRequests++;
          return {ok:true,json:async()=>({tracks:JSON.parse(options.body).tracks.map((id,position)=>({id,position,
            title:'Restored track',artist:'Performer',rating:0,length:60,album:{id:'restored-album',name:'Restored album',artist:'Album artist'},
            details:{track:{id,album_id:'restored-album',title:'Restored track',artist:'Performer',rating:0,track:3,length:60,format:'FLAC',
              genres:['Private restored genre'],uploaded_at:'2026-11-11T09:00:00',size:2048,plays:0,replay_gain:0},album:{credits:[]}}}))})};
        };
        await restoreQueueMemory();workspacePanel.selection=null;setWorkspaceTab('details');
      })()`);await frame();
      await click('#workspace-panel-toggle');await click('#workspace-tab-details');
      const result=await run(`(()=>{const album=$('[data-workspace-section="album"]'),track=$('[data-workspace-section="track"]');
        return {album:album.innerText,track:track.innerText,fields:[...album.querySelectorAll('dt')].map(n=>n.textContent),
          restored:player.queue.map(t=>[t.id,t.upNext]),index:player.index,requests:restoredDetailRequests,
          sameAudio:restoredDetailsSmoke.audio===audio,src:audio.src,history:history.length,overflow:document.documentElement.scrollWidth-innerWidth};})()`);
      assert.ok(result.album.includes('Tracks')&&result.album.includes('6')&&result.album.includes('4 / 5')&&result.album.includes('Last upload'));
      assert.ok(result.track.includes('Private restored genre')&&result.track.includes('Track number')&&result.track.includes('0 dB'));
      assert.ok(!result.fields.includes('Duration')&&!result.fields.includes('File size'),'A partial restored queue never establishes album totals');
      assert.deepEqual(result.restored,[['900',false],['900',true]]);assert.equal(result.index,1);assert.equal(result.requests,1);
      assert.equal(result.sameAudio,true);assert.ok(result.overflow<=1);
      await run(`state.details=new Map();syncWorkspacePanel()`);await frame();
      assert.equal(await run("$('#workspace-details').textContent.includes('Private restored genre')"),false);
      samples.push({width,appearance,restoredWithoutAlbumVisit:true,duplicatePositions:true,noAutoplay:true,staleMetadataRetired:true});
    }
    const transport=await run('({src:audio.src,history:history.length,expectedSrc:restoredDetailsSmoke.src,expectedHistory:restoredDetailsSmoke.history})');
    assert.equal(transport.src,transport.expectedSrc);assert.equal(transport.history,transport.expectedHistory);
    return samples;
  } finally {
    window.setBounds(bounds);
    await run(`(()=>{const s=restoredDetailsSmoke;globalThis.fetch=s.fetch;Object.assign(state,{details:s.details,albums:s.albums,connection:s.connection,mode:s.mode,loading:s.loading});
      Object.assign(player,{queue:s.queue,index:s.index,album:s.album,epoch:s.epoch,resumePending:s.resume,repeat:s.repeat,shuffle:s.shuffle});Object.assign(queueMemory,s.memory);
      if(s.stored===null)localStorage.removeItem('tagcast-queue-'+'a'.repeat(64));else localStorage.setItem('tagcast-queue-'+'a'.repeat(64),s.stored);
      setNowPlaying(false);workspacePanel.selection=null;syncWorkspacePanel();delete globalThis.restoredDetailsSmoke;})()`);
  }
}
module.exports={checkRestoredDetails};
