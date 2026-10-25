"use strict";
// Generate independently encoded FLACs; no local music or account data is used.
const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),crypto=require("node:crypto");
const counter=require("./counter.cjs");
function generate(directory,stress=false) {
  fs.mkdirSync(directory,{recursive:true}); const specs=[],cases=[];
  function add(rate,bits,channels,block,track,samples,id) {
    id ||= `r${rate}-b${bits}-c${channels}-k${block}-t${track}-n${samples}`;
    if(specs.some(s=>s.id===id))return specs.find(s=>s.id===id);
    const raw=Buffer.alloc(samples*channels*bits/8);
    for(let i=0,p=0;i<samples;i++)for(let c=0;c<channels;c++,p+=bits/8)raw.writeIntLE(counter.word(i,track,c,bits),p,bits/8);
    const input=path.join(directory,id+".pcm"),file=id+".flac";fs.writeFileSync(input,raw);
    const args=["-v","error","-y","-f",bits===16?"s16le":"s24le","-ar",String(rate),"-ac",String(channels),"-i",input,"-c:a","flac","-frame_size",String(block),"-compression_level","0",path.join(directory,file)];
    const encode=cp.spawnSync(process.env.FFMPEG||"ffmpeg",args,{encoding:"utf8"});if(encode.status!==0)throw Error(encode.stderr||encode.error?.message);
    const decoded=cp.spawnSync(process.env.FFMPEG||"ffmpeg",["-v","error","-i",path.join(directory,file),"-f",bits===16?"s16le":"s24le","-"],{maxBuffer:raw.length+1024*1024});
    if(decoded.status!==0||!decoded.stdout.equals(raw))throw Error("Independent fixture round-trip failed: "+id);
    fs.unlinkSync(input);const data=fs.readFileSync(path.join(directory,file));
    if(data.toString("ascii",0,4)!=="fLaC"||data.readUInt16BE(10)!==block)throw Error("Unexpected independent encoder block bound: "+id);
    const spec={id,file,rate,bits,channels,block,track,samples,bytes:data.length,sha256:crypto.createHash("sha256").update(data).digest("hex")};specs.push(spec);return spec;
  }
  for(const [rate,bits] of [[44100,16],[44100,24],[48000,16],[48000,24],[96000,24],[192000,24]]){
    const list=[1,2,3].map((track,i)=>add(rate,bits,2,4096,track,Math.floor(rate*[.73,.59,.81][i])+[17,31,53][i]));
    cases.push({id:`same-${rate}-${bits}`,tracks:list.map(s=>s.id),rate,mode:"engine",gate:true});
  }
  const small=[1,2,3].map((t,i)=>add(44100,16,2,1152,t,[32210,26050,35774][i]));
  const large=small.map(s=>add(s.rate,s.bits,s.channels,4096,s.track,s.samples));
  cases.push({id:"same-small-block",tracks:small.map(s=>s.id),rate:44100,mode:"engine",gate:true},
    {id:"block-small-to-large",tracks:[small[0].id,large[1].id,small[2].id],rate:44100,mode:"engine",gate:false},
    {id:"block-large-to-small",tracks:[large[0].id,small[1].id,large[2].id],rate:44100,mode:"engine",gate:false});
  const mono=[1,2].map((t,i)=>add(44100,16,1,4096,t,33000+i*5003));
  cases.push({id:"mono",tracks:mono.map(s=>s.id),rate:44100,mode:"engine",gate:true});
  const intro=[add(44100,16,2,4096,1,44117),add(44100,16,2,4096,2,22061),add(44100,16,2,4096,3,44153)];
  cases.push({id:"short-delayed-third",tracks:intro.map(s=>s.id),rate:44100,mode:"engine",delays:{2:1800},gate:false},
    {id:"startup-sequential",tracks:large.slice(0,2).map(s=>s.id),rate:44100,mode:"engine",delays:{0:300,1:700},gate:false},
    {id:"seek-early",tracks:[large[0].id,add(44100,16,2,4096,2,44100*40+17).id,large[2].id],rate:44100,mode:"engine",gate:false,seekProbe:true,delays:{2:1800}});
  if(stress)for(const rate of [96000,192000]){
    const list=[1,2].map(t=>add(rate,24,2,4096,t,rate*32+17+t*3));
    cases.push({id:`memory-${rate}`,tracks:list.map(s=>s.id),rate,mode:"engine",gate:false,stress:true});
  }
  for(const c of cases.filter(c=>c.gate)) {
    const list=c.tracks.map(id=>specs.find(s=>s.id===id)), first=list[0];
    const raw=Buffer.concat(list.map(s=>{const a=Buffer.alloc(s.samples*s.channels*s.bits/8);for(let i=0,p=0;i<s.samples;i++)for(let ch=0;ch<s.channels;ch++,p+=s.bits/8)a.writeIntLE(counter.word(i,s.track,ch,s.bits),p,s.bits/8);return a;}));
    const input=path.join(directory,c.id+"-reference.pcm");fs.writeFileSync(input,raw);c.reference=c.id+"-reference.flac";
    const r=cp.spawnSync(process.env.FFMPEG||"ffmpeg",["-v","error","-y","-f",first.bits===16?"s16le":"s24le","-ar",String(first.rate),"-ac",String(first.channels),"-i",input,"-c:a","flac","-frame_size","4096","-compression_level","0",path.join(directory,c.reference)],{encoding:"utf8"});if(r.status!==0)throw Error(r.stderr);fs.unlinkSync(input);
    const encoded=fs.readFileSync(path.join(directory,c.reference));c.referenceSha256=crypto.createHash("sha256").update(encoded).digest("hex");
  }
  const manifest={schema:1,signal:"reversible permuted sample counter, independent channel/track salts",encoder:cp.spawnSync(process.env.FFMPEG||"ffmpeg",["-version"],{encoding:"utf8"}).stdout.split("\n")[0],specs,cases};
  fs.writeFileSync(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2));return manifest;
}
if(require.main===module){const dir=process.argv[2];if(!dir)throw Error("Usage: node tools/gapless_lab/fixtures.cjs OUTPUT [--stress]");const m=generate(path.resolve(dir),process.argv.includes("--stress"));console.log(`Verified ${m.specs.length} deterministic FLAC fixtures for ${m.cases.length} cases.`);}
module.exports={generate};
