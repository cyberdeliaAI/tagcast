"use strict";
// Optional real-browser probe: synthetic audio, intercepted APIs, production CSP.
const {chromium}=require("playwright");
const path=require("node:path"),http=require("node:http");
const fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,"..");
const output=path.resolve(process.argv[2]||"build/music-visualizations-browser");fs.mkdirSync(output,{recursive:true});
const {contentPolicy}=require(root+'/electron/security.cjs');
const wav=Buffer.alloc(44+48000*20*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
for(let i=0;i<48000*20;i++)wav.writeInt16LE(Math.round(12000*Math.sin(2*Math.PI*220*i/48000)*(0.5+0.5*Math.sin(i/48000*3))),44+i*2);
(async()=>{
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,"http://localhost").pathname;
 const file=path.resolve(root,"src/tagcast/static",name.slice(1));
 if(!file.startsWith(path.join(root,"src/tagcast/static")+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
 const mime={".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2"};
 res.setHeader("Content-Type",mime[path.extname(file)]||"application/octet-stream");res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));server.unref();
const origin=`http://127.0.0.1:${server.address().port}`;
const b=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.TAGCAST_CHROMIUM||undefined,args:['--autoplay-policy=no-user-gesture-required']});
try {
const p=await b.newPage({viewport:{width:1280,height:800}}),errors=[],network=[];
const report={browser:b.version(),platform:process.platform,architecture:process.arch,chromiumSandbox:true,syntheticAudio:true,modes:[],layouts:[]};
p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')console.log('console',m.text())});
p.on('request',r=>network.push(r.url()));
await p.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connected:false,configured:false})}));
await p.route('**/synthetic.wav',r=>r.fulfill({contentType:'audio/wav',body:wav}));
await p.route(origin+"/",r=>{const html=fs.readFileSync(root+'/src/tagcast/static/index.html','utf8');return r.fulfill({contentType:'text/html',body:html,headers:{'Content-Security-Policy':contentPolicy(html)}})});
await p.goto(origin+"/");await p.waitForTimeout(400);
await p.evaluate(async()=>{
 state.mode='live';state.connection.playback_session='synthetic';
 const album=[...state.details.values()][0];player.queue=queueTracks(album);player.index=0;player.album=player.queue[0].album;
 visualPlayerMode='window';audio.src='/synthetic.wav';audio.loop=true;await audio.play();renderCurrentPlayerTrack();openVisualPlayer();
});
await p.waitForTimeout(300);
console.log('initial',await p.evaluate(()=>({open:visualPlayer.open,paused:audio.paused,supported:visualizerSupported(),size:[innerWidth,innerHeight]})));
for(const mode of ['aurora','orbit','ribbons','led','scope','off']){
 await p.selectOption('#music-visualization-mode',mode);await p.waitForTimeout(1000);
 const result=await p.evaluate(()=>({mode:musicVisualization.mode,failed:musicVisualization.failed,pending:musicVisualization.pending,last:musicVisualization.last,renderer:!!musicVisualization.renderer,message:musicVisualization.message,canvas:musicVisualization.canvas?{w:musicVisualization.canvas.width,h:musicVisualization.canvas.height}:null,rect:document.querySelector('.visual-player-content').getBoundingClientRect().toJSON(),audio:document.querySelectorAll('audio').length,paused:audio.paused}));
 report.modes.push(result);console.log(mode,result);assert.equal(result.failed,false);assert.equal(result.audio,1);assert.equal(result.paused,false);if(mode!=='off')assert.ok(result.last>0);
 if(['aurora','led','scope'].includes(mode))await p.screenshot({path:path.join(output,mode+".png")});
}
await p.selectOption('#music-visualization-mode','scope');await p.waitForTimeout(300);
await p.evaluate(()=>audio.pause());await p.waitForTimeout(250);
const frozen=await p.evaluate(()=>musicVisualization.last);await p.waitForTimeout(250);assert.equal(await p.evaluate(()=>musicVisualization.last),frozen);
await p.evaluate(async()=>{audio.playbackRate=1.25;audio.currentTime=5;await audio.play()});await p.waitForTimeout(400);assert.ok(await p.evaluate(()=>musicVisualization.last)>frozen);
for(const width of [420,760,1280])for(const theme of ['light','dark']){
 await p.setViewportSize({width,height:800});await p.evaluate(theme=>{document.documentElement.dataset.theme=theme;TagcastThemes.apply()},theme);await p.waitForTimeout(250);
 const bounds=await p.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth,canvas:musicVisualization.canvas.getBoundingClientRect().toJSON(),audio:document.querySelectorAll('audio').length}));
 report.layouts.push({width,theme,...bounds});console.log('layout',width,theme,bounds);assert.equal(bounds.audio,1);assert.ok(bounds.canvas.width>100);assert.ok(bounds.canvas.right<=width+1);assert.ok(bounds.canvas.left>=0);
 await p.screenshot({path:path.join(output,`${width}-${theme}.png`)});
}
await p.setViewportSize({width:1280,height:800});
await p.evaluate(()=>{hideVisualPlayer()});assert.equal(await p.evaluate(()=>!!musicVisualization.canvas),false);assert.equal(await p.evaluate(()=>audio.paused),false);
await p.evaluate(()=>openVisualPlayer());await p.waitForTimeout(350);assert.ok(await p.evaluate(()=>!!musicVisualization.canvas));
await p.emulateMedia({reducedMotion:'reduce'});await p.waitForTimeout(150);assert.equal(await p.evaluate(()=>!!musicVisualization.canvas),false);assert.equal(await p.evaluate(()=>audio.paused),false);
await p.emulateMedia({reducedMotion:'no-preference'});await p.waitForTimeout(300);assert.ok(await p.evaluate(()=>!!musicVisualization.canvas));
await p.selectOption('#music-visualization-mode','aurora');await p.waitForTimeout(500);
await p.evaluate(()=>musicVisualization.renderer.renderer.gl.getExtension('WEBGL_lose_context').loseContext());await p.waitForTimeout(200);assert.equal(await p.evaluate(()=>musicVisualization.failed),true);assert.equal(await p.evaluate(()=>audio.paused),false);
await p.selectOption('#music-visualization-mode','led');await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>musicVisualization.failed),false);
await p.evaluate(()=>{
 playbackLyricsView.open=true;playbackLyricsView.loading=false;playbackLyricsView.following=true;
 playbackLyricsView.data={timed:true,source:'lrclib',lines:Array.from({length:12},(_,i)=>({start:i*2,end:i*2+2,text:'Synthetic test line '+(i+1)}))};
 placePlaybackLyrics();document.querySelector('.visual-player-content').classList.add('lyrics-visible');document.querySelector('#visual-player-lyrics').hidden=false;
 setPlaybackLyricsNotice({errors: []});paintPlaybackLyrics();
});
for(const width of [420,760,1280]){
 await p.setViewportSize({width,height:800});await p.waitForTimeout(250);
 const box=await p.locator('#visual-player-lyrics').boundingBox();report.layouts.push({width,lyrics:box});assert.ok(box.width>100);assert.ok(box.x+box.width<=width+1);
 await p.screenshot({path:path.join(output,`lyrics-${width}.png`)});
}
console.log('interaction checks passed');
console.log('errors',errors,'external',network.filter(u=>!u.startsWith(origin+"/")));assert.deepEqual(errors,[]);
assert.deepEqual(network.filter(u=>!u.startsWith(origin+"/")),[]);
report.errors=errors;report.externalRequests=0;report.complete=true;
report.interactions=['pause/resume','speed/seek','close/reopen','reduced motion','WebGL context loss/recovery'];
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
} finally {await b.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
