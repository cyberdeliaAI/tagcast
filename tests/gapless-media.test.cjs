'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const media=require('../src/tagcast/static/gapless-media.js');
const fixture=name=>new Uint8Array(fs.readFileSync(path.join(__dirname,'fixtures/gapless',name)));
test('FLAC remux retains every original encoded frame and the exact sample count',()=>{
 const raw=fixture('tone.flac'),info=media.parseFlac(raw),packed=media.pack(info);
 assert.equal(info.rate,44100);assert.equal(info.bits,16);assert.equal(info.channels,2);assert.equal(info.total,88200);assert.equal(packed.duration,2);
 const originalFrames=Buffer.concat(info.frames.map(x=>x.data));assert.deepEqual(Buffer.from(raw.slice(-originalFrames.length)),originalFrames);
 assert.equal(packed.parts[0].start,0);assert.equal(packed.parts.at(-1).end,2);
 for(let i=1;i<packed.parts.length;i++)assert.equal(packed.parts[i].start,packed.parts[i-1].end);
 assert.match(Buffer.from(packed.init).toString('latin1'),/fLaC/);assert.match(Buffer.from(packed.init).toString('latin1'),/dfLa/);
 for(const part of packed.parts){assert.match(Buffer.from(part.data).toString('latin1'),/moof/);assert.match(Buffer.from(part.data).toString('latin1'),/mdat/);}
});
test('corrupt, truncated and non-FLAC inputs cannot enter the continuous player',()=>{
 const raw=fixture('tone.flac'),bad=raw.slice();bad[bad.length-10]^=1;
 assert.throws(()=>media.parseFlac(bad),/checksum/);assert.throws(()=>media.parseFlac(raw.slice(0,35)),/FLAC/);
 assert.throws(()=>media.parseFlac(fixture('tone.mp3')),/FLAC/);
});
test('MP3 reads exact Xing/Lavc delay and padding instead of trimming musical silence',()=>{
 const info=media.mp3Info(fixture('tone.mp3'));assert.deepEqual(info,{rate:44100,channels:2,total:88200,delay:576,padding:1080});
 const raw=fixture('tone.mp3'),p=Buffer.from(raw).indexOf('Info');assert.ok(p>0);raw.fill(0,p,p+4);
 assert.throws(()=>media.mp3Info(raw),/gapless metadata/);
});
test('untrusted MP3 metadata is bounded before decoding or allocating PCM',()=>{
 const raw=fixture('tone.mp3'),p=Buffer.from(raw).indexOf('Info');raw.fill(255,p+8,p+12);
 assert.throws(()=>media.mp3Info(raw),/memory limit/);assert.throws(()=>media.mp3Info(new Uint8Array([73,68,51])),/ID3/);
});
test('decoded PCM is framed losslessly as 24-bit FLAC with valid frame checksums',()=>{
 const total=10001,rate=48000,channels=2,planes=Array.from({length:channels},()=>Float32Array.from({length:total},(_,i)=>Math.sin(i/25)*.125));
 const info=media.pcmFlac({sampleRate:rate,numberOfChannels:channels,length:total,getChannelData:c=>planes[c]});
 const raw=Buffer.concat([Buffer.from('fLaC'),Buffer.from([128,0,0,34]),info.streaminfo,...info.frames.map(f=>f.data)]);
 const checked=media.parseFlac(new Uint8Array(raw));assert.equal(checked.total,total);assert.equal(checked.bits,24);assert.equal(checked.rate,rate);
 const packed=media.pack(checked);assert.equal(packed.samples,total);assert.equal(packed.duration,total/rate);
});
test('PCM limits reject oversized and multichannel buffers before reading samples',()=>{
 const fail=()=>{throw Error('Samples must not be accessed');};
 assert.throws(()=>media.pcmFlac({sampleRate:44100,numberOfChannels:2,length:100000000,getChannelData:fail}),/memory/);
 assert.throws(()=>media.pcmFlac({sampleRate:44100,numberOfChannels:6,length:1,getChannelData:fail}),/limit/);
});
