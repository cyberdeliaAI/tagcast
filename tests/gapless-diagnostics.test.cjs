"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
function fixture() {
  class Target extends EventTarget { buffered = {length: 1, start: () => 0, end: () => 2}; appendBuffer() {} remove() {} }
  class Source extends Target { addSourceBuffer() { return new Target(); } }
  const audio = new Target(); Object.assign(audio, {currentTime: 0, duration: 12, paused: false, playbackRate: 1});
  const context = vm.createContext({performance, Date, Event, EventTarget, navigator: {userAgent: "PrivateMachine Secret Chrome/152.1 Electron/44.9"}, MediaSource: Source, audio, document: new Target(), $: () => ({}), setTimeout, URL, Blob});
  vm.runInContext(`const entry={id:'PRIVATE-ID',title:'PRIVATE-TITLE'}; const player={queue:[entry],index:0}; const gaplessTrial={active:null}; let nextResult=Promise.resolve({rate:44100,channels:2,bits:16,bytes:1000,duration:12,maxBlock:4096}); function gaplessPrepare(){return nextResult;} function gaplessAdvance(){ if(gaplessTrial.active) gaplessTrial.active.current={entry}; } function gaplessFallback(){gaplessCancel();} function gaplessCancel(){gaplessTrial.active=null;} const originals=[gaplessPrepare,gaplessAdvance,gaplessFallback,gaplessCancel,MediaSource.prototype.addSourceBuffer];`, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/tagcast/static/gapless-diagnostics.js"), "utf8"), context);
  return {run: code => vm.runInContext(code, context), context};
}
test("diagnostics are off by default and restore the exact playback bindings", async () => {
  const p = fixture(); assert.equal(p.run("gaplessDiagnostics.enabled"), false);
  p.run("gaplessDiagnosticEvent('prepare-start',{slot:1});"); assert.equal(p.run("gaplessDiagnostics.events.length"), 0);
  p.run("gaplessDiagnosticsSet(true);const source=new MediaSource();const buffer=source.addSourceBuffer('anything');buffer.appendBuffer(new Uint8Array(5));buffer.dispatchEvent(new Event('updateend'));");
  await p.run("gaplessPrepare({},entry)");
  p.run("gaplessTrial.active={current:{entry}};gaplessAdvance();gaplessFallback({},'PRIVATE-TITLE secret URL decoder error');gaplessDiagnosticsSet(false)");
  assert.equal(p.run("[gaplessPrepare,gaplessAdvance,gaplessFallback,gaplessCancel,MediaSource.prototype.addSourceBuffer].every((fn,i)=>fn===originals[i])"), true);
  assert.equal(p.run("gaplessDiagnostics.detach"), null);
  assert.match(p.run("JSON.stringify(gaplessDiagnosticsReport())"), /track-boundary/);
  assert.match(p.run("JSON.stringify(gaplessDiagnosticsReport())"), /44100/);
});
test("bounded reports exclude arbitrary fields, raw failures, metadata and user-agent details", () => {
  const p = fixture();
  p.run("gaplessDiagnosticsSet(true);for(let i=0;i<5000;i++)gaplessDiagnosticEvent('prepare-start',{slot:1,title:'PRIVATE-TITLE',id:'PRIVATE-ID',url:'TOKEN-SECRET',bytes:NaN,cause:'TOKEN-SECRET'});gaplessDiagnosticEvent('TOKEN-SECRET');gaplessDiagnosticsSet(false)");
  const report = JSON.parse(p.run("JSON.stringify(gaplessDiagnosticsReport())"));
  assert.ok(report.events.length <= 2000); assert.ok(report.dropped > 3000);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|TOKEN|Secret|PrivateMachine/);
  assert.equal(report.versions.electron, "44.9");
});
test("errors keep their identity and stopping rejects late log completions", async () => {
  const p = fixture(); p.run("const error=new Error('TOKEN-SECRET');nextResult=Promise.reject(error);gaplessDiagnosticsSet(true)");
  await assert.rejects(p.run("gaplessPrepare({},entry)"), error => error === p.run("error"));
  p.run("let finish;nextResult=new Promise(resolve=>finish=resolve);const pending=gaplessPrepare({},entry);gaplessDiagnosticsSet(false);gaplessDiagnosticsSet(true);finish({duration:1})");
  await p.run("pending"); assert.equal(p.run("gaplessDiagnostics.events.some(e=>e.event==='prepare-ready')"), false);
  p.run("gaplessDiagnosticsSet(false)");
});
test("replaced/cancelled buffers release instrumentation and quota exceptions are unchanged", () => {
  const p = fixture();
  p.run("gaplessDiagnosticsSet(true);const a=new MediaSource().addSourceBuffer('flac');const original=a.appendBuffer;const b=new MediaSource().addSourceBuffer('flac');");
  assert.equal(p.run("Object.hasOwn(a,'appendBuffer')"),false);
  p.run("gaplessCancel()"); assert.equal(p.run("Object.hasOwn(b,'appendBuffer')"),false);
  p.run("gaplessDiagnosticsSet(false);const quota=new Error('PRIVATE');quota.name='QuotaExceededError';MediaSource.prototype.addSourceBuffer=function(){const sb=new EventTarget();sb.appendBuffer=()=>{throw quota};sb.remove=()=>{};sb.buffered={length:0};return sb;};gaplessDiagnosticsSet(true);const failing=new MediaSource().addSourceBuffer('flac');");
  assert.throws(()=>p.run("failing.appendBuffer(new Uint8Array(10))"),error=>error===p.run("quota"));
  assert.equal(p.run("gaplessDiagnostics.events.some(e=>e.event==='buffer-exception'&&e.cause==='quota')"),true);
  p.run("gaplessDiagnosticsSet(false)");
});
