"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {mediaPlan,applicationPlan,verifyResults}=require('../tools/gapless_lab/contract.cjs');
const smoke=['same-44100-16','same-44100-24','same-48000-16','same-48000-24','same-96000-24','same-192000-24','same-small-block','mono','short-delayed-third','startup-long','repeat-track','repeat-queue'];
const probes=['block-small-to-large','block-large-to-small','startup-sequential','seek-early','seek-near-end','memory-96000','memory-192000'];
const fixture=()=>({cases:[...smoke.map(id=>({id,gate:true,reference:id+'.flac',referenceSha256:'hash'})),...probes.map(id=>({id,required:true}))]});
test('all mandatory measurements and their calibrations are explicitly planned',()=>{
 assert.equal(mediaPlan(fixture(),'all',null,true).length,19);assert.equal(applicationPlan(fixture(),null,false,true).length,10);
 for(const id of [...smoke,...probes]){const m=fixture();m.cases=m.cases.filter(c=>c.id!==id);assert.throws(()=>mediaPlan(m,'all',null,true),/Missing/);}
 const m=fixture();delete m.cases[0].reference;assert.throws(()=>mediaPlan(m),/calibration/);
 assert.throws(()=>mediaPlan(fixture(),'typo'));assert.throws(()=>mediaPlan(fixture(),'all','missing'));
 assert.throws(()=>applicationPlan(fixture(),'missing'));assert.throws(()=>mediaPlan(fixture(),'all','mono,mono'));
});
test('incomplete, failed, missing or inconsistent artifacts fail the independent gate process',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tagcast-result-gate-'));
 try{
  const good={schema:2,complete:true,expected:['one'],results:[{id:'one',pass:true}]};
  fs.writeFileSync(path.join(dir,'one.json'),JSON.stringify(good.results[0]));assert.equal(verifyResults(good,dir),true);
  const variants=[{...good,complete:false},{...good,error:'calibration failed'},{...good,results:[]},{...good,expected:['one','two']},{...good,results:[{id:'one',pass:false}]},{...good,results:[{id:'one',pass:true,captureFile:'missing.f32le',pcmBytes:4}]}];
  for(const report of variants){
   fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(report));
   assert.throws(()=>verifyResults(report,dir));
   assert.equal(cp.spawnSync(process.execPath,[path.resolve(__dirname,'../tools/gapless_lab/verify.cjs'),dir]).status,1);
  }
  fs.unlinkSync(path.join(dir,'one.json'));assert.throws(()=>verifyResults(good,dir));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
