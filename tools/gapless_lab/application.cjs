"use strict";
// Real Tagcast document and page scripts, private fixture streams, no account or host adapters.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const ROOT = path.resolve(__dirname, '../..'), args = process.argv.slice(2);
const option = (key, value) => args.includes(key) ? args[args.indexOf(key) + 1] : value;
const directory = path.resolve(option('--fixtures', 'build/gapless-fixtures'));
const output = path.resolve(option('--out', 'build/gapless-application'));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tagcast-application-lab-'));
app.setPath('userData', profile); app.enableSandbox();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
fs.mkdirSync(output, {recursive:true});
let active, win;
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.png':'image/png', '.woff2':'font/woff2'};
const server = http.createServer((req, res) => {
 const url = new URL(req.url, 'http://localhost');
 if (req.headers.host !== `127.0.0.1:${server.address().port}`) return res.writeHead(403).end();
 const match = url.pathname.match(/^\/api\/stream\/(\d+)$/);
 if (match && active) {
  const spec = active.tracks[Number(match[1])-1]; if (!spec) return res.writeHead(404).end();
  const data = fs.readFileSync(path.join(directory, spec.file));
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]),data.length-1) : data.length-1;
  if (start > end || start >= data.length) return res.writeHead(416).end();
  active.requests.push({id:Number(match[1]),range:req.headers.range||'',at:Date.now(),bytes:end-start+1});
  const headers = {'Content-Type':'audio/flac','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
  res.writeHead(range ? 206 : 200, headers); const timer=setTimeout(()=>{if(!res.destroyed)res.end(data.subarray(start,end+1));},active.delays[Number(match[1])-1]||0);res.on('close',()=>clearTimeout(timer));return;
 }
 if (url.pathname.startsWith('/api/')) {
  const response = url.pathname === '/api/status' ? {connected:false,configured:false}
   : url.pathname === '/api/settings' ? {auto_updates:false,auto_lookup:false,record_plays:false,queue_sync:false,stream_quality:'orig',artist_biographies:false,album_information:false,album_guide:false,sources:[]}
   : url.pathname.includes('lyrics') ? {lyrics:[],results:[]} : {};
  res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(response));
 }
 const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
 const file = path.resolve(ROOT,'src/tagcast/static',name), base = path.join(ROOT,'src/tagcast/static') + path.sep;
 if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(fs.readFileSync(file));
});
async function run(id, sourceCase, mode) {
 const scenario = manifest.cases.find(c=>c.id===sourceCase);if (!scenario) throw Error('Missing fixture case '+sourceCase);
 active = {tracks:scenario.tracks.map(key=>manifest.specs.find(s=>s.id===key)),delays:scenario.delays||{},requests:[]};
 win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.setAudioMuted(true); // Synthetic counter audio must never reach the user's speakers.
 const origin = `http://127.0.0.1:${server.address().port}`;
 win.webContents.session.webRequest.onBeforeRequest((details, callback)=>callback({cancel:!details.url.startsWith(origin+'/')&&!/^(blob:|data:)/.test(details.url)}));
 const errors=[];win.webContents.on('console-message',(_e,...a)=>{const d=typeof a[0]==='object'?a[0]:{level:a[0],message:a[1]};if(d.level==='error'||d.level===3)errors.push(d.message);});
 await win.loadURL(origin+'/');
 const album={id:'700',name:'Deterministic playback verification',artist:'Sample Counter',artist_id:'701',year:2026,genres:[],tracks:active.tracks.map((s,i)=>({id:String(i+1),title:`Counter track ${i+1}`,artist:'Sample Counter',artist_id:'701',track:i+1,length:s.samples/s.rate,format:'FLAC',genres:[],composers:[]}))};
 const result = await win.webContents.executeJavaScript(`(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(test,ms=20000)=>{const start=performance.now();while(!test()){if(performance.now()-start>ms)throw Error('Condition deadline');await wait(20);}};
  await wait(150);const events=[],observations=[],identity=audio;let result;
  for(const name of ['playing','waiting','seeking','seeked','pause','ended','error']) audio.addEventListener(name,()=>events.push({name,at:performance.now(),index:player.index,time:audio.currentTime,src:audio.currentSrc,active:Boolean(gaplessTrial.active),nativeVisible:!audio.hidden}));
  const album=${JSON.stringify(album)},mode=${JSON.stringify(mode)};
  if(${args.includes('--diagnostics')})gaplessDiagnosticsSet(true);
  try{
   useLocal([album],'live');state.connection={connected:true,premium:true,playback_session:'isolated-app-test'};lookup.streamQuality='orig';gaplessTrial.enabled=true;updateChrome();showScreen('albums');render();
   if(mode==='startup-fallback'){
    const append=SourceBuffer.prototype.appendBuffer;let injected=false;
    SourceBuffer.prototype.appendBuffer=function(data){if(!injected&&gaplessTrial.active?.started&&!gaplessTrial.active.ready){injected=true;throw new DOMException('Injected test quota failure','QuotaExceededError');}return append.call(this,data);};
   }
   playTracks(album,mode==='evicted-seek'?'2':undefined);await until(()=>!audio.paused&&audio.currentTime>.03);
   if(mode==='startup-fallback'){
    observations.push({startupRecovered:!gaplessTrial.active&&audio.currentSrc.includes('/api/stream/1')&&!audio.paused,nativeVisible:!audio.hidden});
   }else if(mode==='fallback'){
    await until(()=>!gaplessTrial.active&&audio.currentSrc.includes('/api/stream/2')&&!audio.paused&&audio.currentTime>.03);
    observations.push({normalTrack:player.queue[player.index].id,position:audio.currentTime,nativeVisible:!audio.hidden,gaplessHidden:document.querySelector('#gapless-transport').hidden});
   }else if(mode==='stall'){
    await until(()=>gaplessTrial.active?.buffer&&!gaplessTrial.active.buffer.updating);
    const g=gaplessTrial.active;g.buffer.remove(audio.currentTime+.15,g.media.duration);
    await until(()=>!gaplessTrial.active&&audio.currentSrc.includes('/api/stream/')&&!audio.paused&&audio.currentTime>.25,15000);
    observations.push({normalTrack:player.queue[player.index].id,position:audio.currentTime,message:gaplessTrial.message,nativeVisible:!audio.hidden});
   }else if(mode==='skip-next'){
    step(1);await until(()=>player.index===1&&!audio.paused&&audio.currentTime>.03);observations.push({skippedToPrepared:gaplessTrial.active!==null});
   }else if(mode==='pending-replacement'){
    const replacement={...album,name:'Replacement queue',tracks:[album.tracks[2]]};playTracks(replacement);
    await until(()=>player.queue[0]?.id==='3'&&!audio.paused&&audio.currentTime>.03);await wait(2300);
    observations.push({lateReplyIgnored:player.queue.length===1&&player.queue[0].id==='3'&&gaplessTrial.active?.current.entry===player.queue[0]});
   }else if(mode==='interaction'){
    const position=audio.currentTime;audio.pause();await wait(200);observations.push({paused:audio.paused,stable:Math.abs(audio.currentTime-position)<.04});
    audio.playbackRate=1.25;await audio.play();await until(()=>audio.currentTime>position+.1);observations.push({resumed:!audio.paused,rate:audio.playbackRate});
    audio.playbackRate=1;gaplessSeek(.05);await until(()=>audio.currentTime<.3);observations.push({seeked:audio.currentTime});
    state.connection.playback_session='replaced-test-session';await wait(250);observations.push({cancelled:!gaplessTrial.active,sourceCleared:!audio.getAttribute('src')});
   }else if(mode==='evicted-seek'){
    await until(()=>audio.currentTime>11,16000);const src=audio.currentSrc;
    observations.push({evicted:gaplessTrial.active.buffer.buffered.start(0)>0});
    gaplessSeek(1);await until(()=>!audio.seeking&&audio.currentTime>=1&&audio.currentTime<2);
    observations.push({backwardSeek:gaplessTrial.active!==null&&audio.currentSrc===src,index:player.index,position:audio.currentTime});
   }else if(mode==='high-rate'){
    await until(()=>audio.currentTime>1,10000);observations.push({mseActive:Boolean(gaplessTrial.active),position:audio.currentTime});
   }else if(mode==='repeat'){
    player.repeat='track';gaplessQueueChanged();await until(()=>gaplessTrial.active?.current.start>0);observations.push({repeatTrack:player.index===0,relative:gaplessPosition()});
    player.repeat='queue';gaplessQueueChanged();await until(()=>player.index===1);observations.push({advanced:true});
    const queued=player.queue[2];setNowPlaying(true);renderNowPlaying();removeQueueEntry(2,nowPlayingRows.revision);await wait(100);observations.push({removedNotWanted:gaplessTrial.active?.wanted!==queued});
   }
   if(observations.some(o=>Object.entries(o).some(([k,v])=>['paused','stable','resumed','cancelled','sourceCleared','repeatTrack','advanced','removedNotWanted','nativeVisible','gaplessHidden','evicted','backwardSeek','mseActive','skippedToPrepared','lateReplyIgnored','startupRecovered'].includes(k)&&v!==true)))throw Error('Application state assertion failed');
   result={id,pass:true,diagnostics:gaplessDiagnosticsReport(),observations,events,sameElement:identity===audio,queueIds:player.queue.map(t=>t.id),index:player.index,message:gaplessTrial.message};
  }catch(error){result={id,pass:false,error:error.message,observations,events,index:player.index,message:gaplessTrial.message};}
  return result;
 })()` .replace('result={id,','result={id:'+JSON.stringify(id)+',').replace('result={id,','result={id:'+JSON.stringify(id)+','));
 result.requests=active.requests;result.consoleErrors=errors;
 if(mode==='skip-next'){result.reusedPrepared=active.requests.filter(r=>r.id===2).length===1&&active.requests.filter(r=>r.id===3).length===1;result.pass &&= result.reusedPrepared;}
 fs.writeFileSync(path.join(output,id+'.json'),JSON.stringify(result,null,2));
 fs.writeFileSync(path.join(output,id+'.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript('stopPlayer()');win.destroy();win=null;console.log(JSON.stringify({id,pass:result.pass,error:result.error,observations:result.observations}));return result;
}
app.whenReady().then(async()=>{
 const results=[];
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  for(const [id,c,mode] of [['startup-error-fallback','same-44100-16','startup-fallback'],['mixed-block-fallback','block-small-to-large','fallback'],['stalled-playback-fallback','same-44100-16','stall'],['pause-seek-session','same-44100-16','interaction'],['repeat-queue-edit','same-44100-16','repeat'],['evicted-backward-seek','seek-early','evicted-seek'],...(manifest.cases.some(c=>c.id==='startup-long')?[['skip-prepared-next','same-44100-16','skip-next'],['pending-queue-replacement','startup-long','pending-replacement']]:[]),...(manifest.cases.some(c=>c.id==='memory-192000')?[['high-rate-start','memory-192000','high-rate']]:[])]){
   if(option('--case','').split(',').filter(Boolean).length&&!option('--case','').split(',').includes(id))continue;
   results.push(await run(id,c,mode));
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({versions:process.versions,results},null,2));
  if(results.some(r=>!r.pass))process.exitCode=1;
 }catch(e){console.error(e);process.exitCode=1;}
 finally{win?.destroy();server.close();app.quit();}
});
app.on('window-all-closed',()=>{});
app.on('quit',()=>{try{fs.rmSync(profile,{recursive:true,force:true});}catch{/* OS lock may persist briefly. */}});
