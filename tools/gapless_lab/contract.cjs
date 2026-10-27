"use strict";
// A failed measurement, omitted case or missing artifact must never become a green job.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const smoke=['same-44100-16','same-44100-24','same-48000-16','same-48000-24','same-96000-24','same-192000-24','same-small-block','mono','short-delayed-third','startup-long','repeat-track','repeat-queue'];
const diagnostics=['block-small-to-large','block-large-to-small','startup-sequential','seek-early','seek-near-end'];
const stress=['memory-96000','memory-192000'];
const application=[['normal-disabled','same-44100-16','ordinary'],['startup-error-fallback','same-44100-16','startup-fallback'],['mixed-block-fallback','block-small-to-large','fallback'],['stalled-playback-fallback','same-44100-16','stall'],['pause-seek-session','same-44100-16','interaction'],['repeat-queue-edit','same-44100-16','repeat'],['evicted-backward-seek','seek-early','evicted-seek'],['skip-prepared-next','same-44100-16','skip-next'],['pending-queue-replacement','startup-long','pending-replacement']];
function select(cases,selected){
 if(!selected)return cases;
 const ids=selected.split(',');
 if(ids.some(id=>!cases.some(c=>c.id===id))||new Set(ids).size!==ids.length)throw Error('Unknown or duplicate selected case');
 return cases.filter(c=>ids.includes(c.id));
}
function verifyFixtures(manifest,directory){
 if(manifest.schema!==1||!Array.isArray(manifest.specs)||!manifest.specs.length||!Array.isArray(manifest.cases))throw Error('Invalid fixture manifest');
 if(new Set(manifest.specs.map(s=>s.id)).size!==manifest.specs.length||new Set(manifest.cases.map(c=>c.id)).size!==manifest.cases.length)throw Error('Duplicate fixture identity');
 const check=(file,hash)=>{if(typeof file!=='string'||path.basename(file)!==file||typeof hash!=='string'||crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,file))).digest('hex')!==hash)throw Error('Fixture hash mismatch: '+file);};
 for(const spec of manifest.specs)check(spec.file,spec.sha256);
 for(const c of manifest.cases){
  if(!Array.isArray(c.tracks)||!c.tracks.length||[...c.tracks,...c.expectedTracks||[]].some(id=>!manifest.specs.some(s=>s.id===id)))throw Error('Incomplete fixture tracks: '+c.id);
  if(c.reference)check(c.reference,c.referenceSha256);
 }
}
function mediaPlan(manifest,suite='smoke',selected=null,requireStress=false){
 if(!['smoke','diagnostics','all'].includes(suite))throw Error('Unknown media suite');
 if(selected)suite='all'; // Named probes retain the CLI's cross-suite selection behaviour.
 const expected=[...(suite!=='diagnostics'?smoke:[]),...(suite!=='smoke'?[...diagnostics,...(requireStress||manifest.cases.some(c=>stress.includes(c.id))?stress:[])]:[])];
 for(const id of expected){const c=manifest.cases.find(c=>c.id===id);if(!c||(smoke.includes(id)?!c.gate||!c.reference||!c.referenceSha256:!c.required))throw Error('Missing required scenario/calibration: '+id);}
 const cases=select(manifest.cases.filter(c=>expected.includes(c.id)),selected);
 if(!cases.length)throw Error('No measurement cases selected');
 return cases;
}
function applicationPlan(manifest,selected=null,soak=false,requireStress=false){
 const cases=soak?[['extended-original-flac','same-44100-24','soak']]:[...application,...(requireStress||manifest.cases.some(c=>c.id==='memory-192000')?[['high-rate-start','memory-192000','high-rate']]:[])];
 for(const [,source] of cases)if(!manifest.cases.some(c=>c.id===source))throw Error('Missing application fixture: '+source);
 return select(cases.map(([id,source,mode])=>({id,source,mode})),selected);
}
function verifyResults(report,directory){
 if(report.complete!==true||report.error||!report.expected?.length||!report.results?.length||report.results.length!==report.expected.length)throw Error('Incomplete media measurement report');
 if(new Set(report.expected).size!==report.expected.length)throw Error('Duplicate expected result');
 for(const id of report.expected){
  const rows=report.results.filter(r=>r.id===id);if(rows.length!==1)throw Error('Missing/duplicate measurement: '+id);
  const row=rows[0];if(row.pass!==true)throw Error('Required measurement failed: '+id);
  if(JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory,id+'.json'))))!==JSON.stringify(row))throw Error('Missing or inconsistent result artifact: '+id);
  if(row.captureFile&&fs.statSync(path.join(directory,row.captureFile)).size!==row.pcmBytes)throw Error('Missing or truncated PCM capture: '+id);
 }
 return true;
}
module.exports={verifyFixtures,mediaPlan,applicationPlan,verifyResults};
