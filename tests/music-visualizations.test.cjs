"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const dir = path.join(__dirname, "../src/tagcast/static");
const source = fs.readFileSync(path.join(dir, "music-visualizations.js"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

function page({stored = null, reduced = false, supported = true, paused = false, fail = false, library = true} = {}) {
  const log = {scripts: [], renderers: [], calls: [], timers: new Map(), graph: 0, lost: 0};
  let serial = 0;
  function node() {
    const handlers = {}, classes = new Set();
    return {hidden: false, clientWidth: 3000, clientHeight: 2000, children: [], handlers,
      classList: {toggle(k, v) { if (v) classes.add(k); else classes.delete(k); }, contains:k=>classes.has(k)},
      append(n) { this.children.push(n); }, remove() { this.removed = true; }, setAttribute() {},
      addEventListener(k, f) { handlers[k] = f; },
      getContext() { return new Proxy({}, {get: (_, k) => typeof k === "string" ? (...args) => log.calls.push([k, ...args]) : undefined, set: () => true}); }};
  }
  const nodes = Object.fromEntries(["#music-visualization-mode", "#music-visualization-setting", "#music-visualization-status", "#visual-player", "#music-visualization-surface", "#visual-player-cover-toggle", "#visual-player-disc-toggle"].map(k=>[k,node()]));
  const document = node(); document.hidden = false;
  document.createElement = tag => { const n=node();n.tagName=tag;return n; };
  document.head = {append(n) { log.scripts.push(n); }};
  const audio = node(); Object.assign(audio,{paused,seeking:false,readyState:4});
  const renderer = {renderer: {gl: {getExtension() { return {loseContext() { log.lost++; }}; }}},
    loadPreset(p) { this.preset=p; }, setRendererSize(w,h) { this.size=[w,h]; }, render(data) { this.frames=(this.frames||0)+1;this.data=data; }};
  const butterchurn = {default: {createVisualizer(context, canvas, options) {
    assert.equal(context,null,"never allocates a second audio graph");
    if(fail)throw Error("WebGL unavailable");
    const r={...renderer,options};log.renderers.push(r);return r;
  }}};
  const storage = {};
  const context = vm.createContext({document,audio,$:s=>nodes[s],
    localStorage:{getItem:()=>stored,setItem:(k,v)=>storage[k]=v},
    TagcastI18n:{html:k=>k,text:k=>k,subscribe() {}},
    visualPlayer:{open:true},visualizerReducedMotion:()=>reduced,visualizerSupported:()=>supported,
    visualizer:{analyser:{getByteTimeDomainData(a){a.fill(140);},getFloatTimeDomainData(a){for(let i=0;i<a.length;i++)a[i]=Math.sin(i*.1);}}},
    visualizerLevelAt:()=>.5,applyVisualizer:()=>log.graph++,
    setTimeout(f){const id=++serial;log.timers.set(id,f);return id;},clearTimeout(id){log.timers.delete(id);},
    matchMedia:()=>({addEventListener(){}})});
  if(library)context.butterchurn=butterchurn;
  vm.runInContext(source,context);
  const run=s=>vm.runInContext(s,context);
  return {run,log,nodes,audio,document,context,butterchurn,storage};
}

test("new effects default off and settings never load a library or alter audio",()=>{
  const p=page({library:false});
  assert.equal(p.run("musicVisualization.mode"),"off");
  assert.match(p.run("musicVisualizationSettings()"),/music-visualization-setting/);
  p.run("syncMusicVisualization()");
  assert.equal(p.log.scripts.length,0);assert.equal(p.log.renderers.length,0);
  assert.equal(page({stored:"bad"}).run("musicVisualization.mode"),"off");
});

test("precompiled local presets consume samples, cap GPU size and share the existing clock",async()=>{
  const p=page();p.run('setMusicVisualization("aurora")');await settle();
  assert.equal(p.log.renderers.length,1);const r=p.log.renderers[0];
  assert.ok(r.options.width<=1280&&r.options.height<=720);
  assert.equal(typeof r.preset.frame_eqs,"function");
  p.run("drawMusicVisualization(100,true);drawMusicVisualization(110,true);drawMusicVisualization(140,true)");
  assert.equal(r.frames,2);assert.equal(r.data.audioLevels.timeByteArray.length,1024);
  assert.equal(r.data.audioLevels.timeByteArray[0],140);
  p.run("drawMusicVisualization(200,false);audio.seeking=true;drawMusicVisualization(240,true)");
  assert.equal(r.frames,2);
  p.nodes["#visual-player-cover-toggle"].handlers.click();
  assert.equal(p.run("musicVisualization.mode"),"off");assert.equal(p.log.lost,1);
  assert.equal(p.storage["tagcast-fullscreen-visualization"],"off");
});

test("LED and scope work without Butterchurn, and never load it",async()=>{
  const p=page({library:false});
  for(const mode of ["led","scope"]){p.run(`setMusicVisualization("${mode}")`);await settle();p.run("drawMusicVisualization(100,true)");}
  assert.equal(p.log.scripts.length,0);assert.equal(p.log.renderers.length,0);
  assert.ok(p.log.calls.some(c=>c[0]==="fillRect"));assert.ok(p.log.calls.some(c=>c[0]==="lineTo"));
});

test("reduced motion, unsupported capture and paused opening allocate no effect resources",()=>{
  for(const options of [{reduced:true},{supported:false},{paused:true}]){
    const p=page({...options,library:false});p.run('setMusicVisualization("aurora")');
    assert.equal(p.log.scripts.length,0);assert.equal(p.run("musicVisualization.canvas"),null);
  }
});

test("late library responses cannot recreate closed or superseded effects",async()=>{
  const p=page({library:false});p.run('setMusicVisualization("aurora");setMusicVisualization("orbit")');
  assert.equal(p.log.scripts.length,1);
  p.run("visualPlayer.open=false;syncMusicVisualization()");
  p.context.butterchurn=p.butterchurn;p.log.scripts[0].onload();await settle();
  assert.equal(p.log.renderers.length,0);assert.equal(p.run("musicVisualization.pending"),false);
  assert.equal(p.run("musicVisualization.canvas"),null);
});

test("load timeout and WebGL failure leave playback alone and allow a different effect",async()=>{
  const p=page({library:false});p.run('setMusicVisualization("aurora")');
  for(const timer of [...p.log.timers.values()])timer();await settle();
  assert.equal(p.run("musicVisualization.failed"),true);assert.equal(p.audio.paused,false);
  assert.equal(p.run("musicVisualization.loader"),null);
  p.run('setMusicVisualization("led")');await settle();assert.equal(p.run("musicVisualization.failed"),false);
  const failed=page({fail:true});failed.run('setMusicVisualization("orbit")');await settle();
  assert.equal(failed.run("musicVisualization.failed"),true);assert.equal(failed.run("musicVisualization.canvas"),null);
  assert.equal(failed.nodes["#visual-player"].classList.contains("music-visualization-active"),false);
  assert.equal(failed.audio.paused,false);
});

test("hiding the page or losing WebGL releases resources; resuming creates only one renderer",async()=>{
  const p=page();p.run('setMusicVisualization("aurora")');await settle();
  p.document.hidden=true;p.document.handlers.visibilitychange();
  assert.equal(p.log.lost,1);assert.equal(p.run("musicVisualization.canvas"),null);
  p.document.hidden=false;p.document.handlers.visibilitychange();await settle();
  assert.equal(p.log.renderers.length,2);
  p.run('musicVisualization.canvas.handlers.webglcontextlost({preventDefault(){}})');
  assert.equal(p.run("musicVisualization.failed"),true);assert.equal(p.run("musicVisualization.canvas"),null);
});

test("vendored renderer has no dynamic script compilation and is packaged with its license",()=>{
  const vendor=fs.readFileSync(path.join(dir,"vendor/butterchurn/butterchurn.js"),"utf8");
  assert.doesNotMatch(vendor,/new Function\s*\(|\beval\s*\(/);
  assert.match(vendor,/Only precompiled presets are supported/);
  assert.match(fs.readFileSync(path.join(dir,"vendor/butterchurn/LICENSE"),"utf8"),/MIT License/);
});
