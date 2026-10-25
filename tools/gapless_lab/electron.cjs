"use strict";
// Standalone diagnostic application. It never opens Tagcast profiles or an account server.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),crypto=require('node:crypto');
const counter=require('./counter.cjs');
const ROOT=path.resolve(__dirname,'../..'),args=process.argv.slice(2);
function option(name,otherwise){const i=args.indexOf(name);return i<0?otherwise:args[i+1];}
const directory=path.resolve(option('--fixtures','build/gapless-lab-fixtures')),out=path.resolve(option('--out','build/gapless-lab-results'));
fs.mkdirSync(out,{recursive:true});const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'tagcast-media-lab-'));app.setPath('userData',profile);app.enableSandbox();app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
let active,server,window;const results=[],memory=[];
const routes={'/':'harness.html','/environment.js':'environment.js','/run.js':'run.js','/capture.js':'capture.js'};
const production={'/gapless-media.js':'gapless-media.js','/gapless.js':'gapless.js'};
const timers=new Set();
function send(res,file,delay=0){const data=fs.readFileSync(file);res.writeHead(200,{'Content-Type':file.endsWith('.flac')?'audio/flac':file.endsWith('.html')?'text/html':'text/javascript','Content-Length':data.length,'Cache-Control':'no-store'});const t=setTimeout(()=>{timers.delete(t);if(!res.destroyed)res.end(data);},delay);timers.add(t);res.on('close',()=>{clearTimeout(t);timers.delete(t);});}
server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403).end();return;}
 if(routes[url.pathname])return send(res,path.join(__dirname,routes[url.pathname]));
 if(production[url.pathname])return send(res,path.join(ROOT,'src/tagcast/static',production[url.pathname]));
 if(url.pathname==='/reference'&&active?.config.reference)return send(res,path.join(directory,active.config.reference));
 const match=url.pathname.match(/^\/api\/stream\/(\d+)$/);
 if(match&&active){const n=Number(match[1]),spec=active.config.tracks[n];if(spec){const record={index:n,epoch:Date.now(),at:performance.now()-active.started,delay:active.config.delays?.[n]||0,bytes:spec.bytes};active.requests.push(record);res.on('finish',()=>{record.finishedAt=performance.now()-active.started;record.finishedEpoch=Date.now();});return send(res,path.join(directory,spec.file),record.delay);}}
 res.writeHead(404).end();
});
ipcMain.on('lab-config',event=>{if(event.sender!==window?.webContents){event.returnValue=null;return;}event.returnValue=active.config;});
ipcMain.on('lab-pcm',(event,buffer)=>{if(event.sender===window?.webContents&&active){if(active.bytes+buffer.byteLength>256*1024**2)throw Error('Capture exceeded diagnostic bound');fs.writeSync(active.fd,Buffer.from(buffer));active.bytes+=buffer.byteLength;}});
ipcMain.on('lab-done',(event,result)=>{if(event.sender===window?.webContents&&active)active.resolve(result);});
async function run(config,referenceMode=false,normalization){
 const name=config.id+(referenceMode?'-reference':''),file=path.join(out,name+'.f32le');
 let resolve;const completed=new Promise(r=>{resolve=r;});active={config:{...config,tracks:config.tracks.map(id=>manifest.specs.find(s=>s.id===id)),referenceMode},fd:fs.openSync(file,'w'),bytes:0,resolve,started:performance.now(),requests:[]};
 window=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];window.webContents.on('console-message',(_event,...rest)=>{const d=typeof rest[0]==='object'?rest[0]:{level:rest[0],message:rest[1]};if(d.level==='error'||d.level===3)errors.push(d.message);});
 const started=performance.now(),samples=active.config.tracks.reduce((n,s)=>n+s.samples,0),limit=(config.stress?90:config.seekProbe?20:samples/config.rate+18)*1000;active.config.timeoutMs=limit-2000;
 const timeout=setTimeout(()=>active.resolve({id:config.id,error:'Renderer harness deadline',events:[],operations:[],inputChannels:[]}),limit);
 const memoryTimer=setInterval(()=>memory.push({case:name,at:performance.now()-started,processes:app.getAppMetrics().map(p=>({type:p.type,workingSetKiB:p.memory.workingSetSize,privateKiB:p.memory.privateBytes}))}),500);
 await window.loadURL(`http://127.0.0.1:${server.address().port}/`);const result=await completed;clearTimeout(timeout);clearInterval(memoryTimer);fs.closeSync(active.fd);
 const bytes=fs.readFileSync(file),floats=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),channels=[new Float32Array(floats.length/2),new Float32Array(floats.length/2)];
 for(let i=0;i<channels[0].length;i++){channels[0][i]=floats[i*2];channels[1][i]=floats[i*2+1];}
 result.signal=counter.inspect(channels,active.config.tracks,{normalization});result.requests=active.requests;result.consoleErrors=errors;result.captureFile=path.basename(file);result.pcmBytes=bytes.length;
 const expectedChannels=active.config.tracks[0].channels;result.channelMismatch=(result.inputChannels||[]).some(x=>x.channels!==0&&x.channels!==expectedChannels);
 const ends=active.config.tracks.map((s,i,a)=>a.slice(0,i+1).reduce((n,t)=>n+t.samples/config.rate,0));
 result.boundaryWaiting=(result.events||[]).filter(e=>e.name==='waiting'&&ends.slice(0,-1).some(t=>Math.abs(e.time-t)<.025));
 result.endWaiting=(result.events||[]).filter(e=>e.name==='waiting'&&Math.abs(e.time-ends.at(-1))<1/config.rate);result.pass=!result.error&&!result.fallbacks?.length&&result.signal.exact&&!result.channelMismatch;
 result.referenceMode=referenceMode;result.gating=Boolean(config.gate);
 if(config.gate&&!referenceMode)result.pass &&= result.finalIndex===config.tracks.length-1;
 if(config.seekProbe){result.partialCapture=true;result.signal.exact=null;result.pass=!result.error&&Boolean(result.seekProbe);}results.push(result);fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({id:name,pass:result.pass,error:result.error,measurable:result.signal.measurable,mismatches:result.signal.mismatches,leadingMismatch:result.signal.leadingMismatch,boundaries:result.signal.boundaries,waiting:result.boundaryWaiting.length,fallbacks:result.fallbacks}));
 window.destroy();window=null;active=null;return result;
}
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  for(const spec of manifest.specs){const bytes=fs.readFileSync(path.join(directory,spec.file));if(crypto.createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw Error('Fixture hash mismatch: '+spec.id);}
  for(const config of manifest.cases.filter(c=>c.referenceSha256)){if(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,config.reference))).digest('hex')!==config.referenceSha256)throw Error('Reference hash mismatch: '+config.id);}
  const selected=option('--case',null),suite=option('--suite','smoke');
  for(const config of manifest.cases){if(selected?!selected.split(',').includes(config.id):suite==='smoke'?!config.gate:suite==='diagnostics'?config.gate:false)continue;
   const reference=config.reference&&config.gate?await run(config,true):null;
   if(reference&&!reference.pass)throw Error('Single-file calibration failed: '+config.id);
   await run(config,false,reference?.signal.normalization);}
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({schema:1,sourceSha256:Object.fromEntries(Object.values(production).map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'src/tagcast/static',file))).digest('hex')])),versions:process.versions,platform:process.platform,arch:process.arch,signal:'pre-output Web Audio measurement tap; same-rate, volume=1, rate=1; output silenced after capture',results,memory},null,2));
  if(results.some(r=>r.gating&&!r.pass))process.exitCode=1;
 }catch(e){console.error(e);process.exitCode=1;}
 finally{if(active?.fd!==undefined){try{fs.closeSync(active.fd);}catch{/* Already closed after capture. */}}window?.destroy();for(const t of timers)clearTimeout(t);server.close();app.quit();}
});
app.on('window-all-closed',()=>{});

app.on('quit',()=>{try{fs.rmSync(profile,{recursive:true,force:true});}catch{/* Runtime may retain a temporary profile lock until process exit. */}});
