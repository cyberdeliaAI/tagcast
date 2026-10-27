"use strict";
// Real Electron subprocess exit checks; synthetic fixtures only, no production profiles.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const args=process.argv.slice(2),option=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const source=path.resolve(option('--fixtures','build/gapless-fixtures')),out=path.resolve(option('--out','build/gapless-negative'));
const executable=option('--electron',require(path.resolve(__dirname,'../../electron/node_modules/electron')));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tagcast-media-negative-')),results=[];
fs.mkdirSync(out,{recursive:true});
try{
 fs.cpSync(source,temporary,{recursive:true});
 const original=JSON.parse(fs.readFileSync(path.join(temporary,'manifest.json')));
 function check(id,program,mutate,extra=[]){
  const manifest=structuredClone(original);mutate(manifest);fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest));
  const directory=path.join(out,id),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=cp.spawnSync(executable,[path.join(__dirname,program),'--fixtures',temporary,'--out',directory,...extra],{encoding:'utf8',timeout:90000,env});
  fs.writeFileSync(path.join(out,id+'.log'),result.stdout+'\n'+result.stderr);
  const report=JSON.parse(fs.readFileSync(path.join(directory,'results.json')));
  const pass=result.status!==null&&result.status!==0&&Boolean(report.error);
  results.push({id,pass,exitCode:result.status,signal:result.signal,error:report.error});
  if(!pass)throw Error('Negative process check was accepted: '+id);
 }
 for(const program of ['electron.cjs','application.cjs']){
  check(program+'-invalid-hash',program,m=>{m.specs[0].sha256='0'.repeat(64);});
  check(program+'-missing-scenario',program,m=>{m.cases=m.cases.filter(c=>c.id!=='same-44100-16');});
 }
 check('incomplete-calibration','electron.cjs',m=>{
  const target=m.cases.find(c=>c.id==='same-44100-16'),wrong=m.cases.find(c=>c.id==='mono');
  target.reference=wrong.reference;target.referenceSha256=wrong.referenceSha256;
 },['--case','same-44100-16']);
 check('application-media-failure','application.cjs',m=>{
  const c=m.cases.find(c=>c.id==='same-44100-16'),spec=m.specs.find(s=>s.id===c.tracks[0]);
  const invalid=Buffer.from('deliberately invalid synthetic audio');fs.writeFileSync(path.join(temporary,spec.file),invalid);spec.sha256=crypto.createHash('sha256').update(invalid).digest('hex');
 },['--case','normal-disabled']);
 console.log(JSON.stringify(results,null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results},null,2));fs.rmSync(temporary,{recursive:true,force:true});}
