"use strict";

// The optional compact-player spectrum (visualizer.js) with a small DOM and Web Audio stand-in.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "../src/tagcast/static/visualizer.js"), "utf8");

function page({storage = {}, reducedMotion = false, narrow = false, capture = true, listening = false} = {}) {
  const log = {contexts: [], captures: 0, frames: [], stopped: []};
  const listeners = new Map(), documentListeners = new Map();
  function node(extra = {}) {
    const classes = new Set(), properties = {};
    return {dataset: {}, isConnected: true, clientWidth: 34, clientHeight: 14, width: 0, height: 0, parentElement: null,
      classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c)},
      style: {properties, setProperty(k, v) { properties[k] = v; }, removeProperty(k) { delete properties[k]; }},
      setAttribute(k, v) { this[k] = v; }, ...extra};
  }
  const text = node(), cover = node(), bar = node();
  const title = node({after(child) { child.placed = "title"; child.isConnected = true; }});
  title.parentElement = text;
  cover.append = child => { child.placed = "cover"; child.isConnected = true; };
  bar.append = child => { child.placed = "edge"; child.isConnected = true; };
  const nodes = {"#player-title": title, "#player-cover-button": cover, "#player": bar};
  const track = (id) => ({id, kind: "audio", readyState: "live", stop() { this.readyState = "ended"; log.stopped.push(id); }});
  const stream = {tracks: [], listeners: [], getAudioTracks() { return this.tracks; },
    addEventListener(type, handler) { if (type === "addtrack") this.listeners.push(handler); },
    removeEventListener(type, handler) { if (type === "addtrack") this.listeners = this.listeners.filter(h => h !== handler); },
    add(t) { this.tracks.push(t); for (const handler of this.listeners) handler({track: t}); }};
  const audio = {paused: true,
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) || []), handler]); },
    emit(type) { for (const handler of listeners.get(type) || []) handler({}); }};
  if (capture) audio.captureStream = () => { log.captures += 1; return stream; };
  const g = {setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, roundRect() {}, fill() {},
    createLinearGradient() { return {addColorStop() {}}; }};
  class AudioContext {
    constructor() { this.state = "running"; this.sampleRate = 48000; this.sources = []; log.contexts.push(this); }
    createAnalyser() {
      const analyser = {fftSize: 2048, connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; },
        getFloatTimeDomainData(samples) { samples.fill(this.level || 0); },
        get frequencyBinCount() { return this.fftSize / 2; },
        getFloatFrequencyData(bins) { bins.fill(-100); bins[Math.round(1000 / (48000 / 2 / bins.length))] = -20; }};
      this.analyser = analyser; return analyser;
    }
    createChannelSplitter() { return {connections: [], connect(target, output) { this.connections.push([target, output]); }, disconnect() { this.disconnected = true; }}; }
    createMediaStreamSource(media) {
      const node = {track: media.tracks[0], connections: [], disconnected: false,
        connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; }};
      this.sources.push(node); return node;
    }
    resume() { return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  const document = {hidden: false, documentElement: {dataset: {}},
    createElement(tag) {
      assert.equal(tag, "canvas");
      return node({tagName: "CANVAS", isConnected: false, getContext: () => g, remove() { this.isConnected = false; this.placed = null; }});
    },
    querySelector(selector) { return selector === ".album-tracklist tr.playing" ? document.playingRow ?? null : null; },
    addEventListener(type, handler) { documentListeners.set(type, [...(documentListeners.get(type) || []), handler]); },
    emit(type, event) { for (const handler of documentListeners.get(type) || []) handler(event); }};
  const context = vm.createContext({document, audio, window: {devicePixelRatio: 2},
    $: selector => nodes[selector] ?? null,
    localStorage: {getItem: key => storage[key] ?? null, setItem(key, value) { storage[key] = String(value); }},
    matchMedia: query => ({matches: query.includes("reduced-motion") ? reducedMotion : narrow, addEventListener() {}}),
    requestAnimationFrame(callback) { log.frames.push(callback); return log.frames.length; }, cancelAnimationFrame() {},
    getComputedStyle: () => ({color: "rgb(1, 2, 3)"}), AudioContext,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } }, Float32Array, Math, Number});
  if (listening) vm.runInContext("const nowPlayingPreferences={meter: 'vu'};const nowPlayingPresentation={vu:[0,0]};let pageVisible=true;function listeningMeterActive(){return pageVisible;}let meterFrames=0;function drawListeningMeter(){meterFrames++;}", context);
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  // Runs the pending animation frames, advancing the clock by 16 ms each.
  let clock = 0;
  const frames = (count = 1) => { for (let i = 0; i < count; i++) { const queued = log.frames.splice(0); clock += 16; for (const f of queued) f(clock); } };
  return {run, log, audio, stream, track, storage, nodes, document, frames};
}

test("the spectrum starts next to the title, starts off with reduced motion and keeps a valid stored choice", () => {
  assert.equal(page().run("visualizer.mode"), "title");
  assert.equal(page({reducedMotion: true}).run("visualizer.mode"), "off");
  assert.equal(page({reducedMotion: true, storage: {"tagcast-player-visualizer": "cover"}}).run("visualizer.mode"), "cover");
  assert.equal(page({storage: {"tagcast-player-visualizer": "fireworks"}}).run("visualizer.mode"), "title");
});

test("a browser that cannot capture audio shows a disabled choice and never builds an audio graph", () => {
  const p = page({capture: false});
  assert.equal(p.document.documentElement.dataset.playerVisualizer, "off");
  assert.match(p.run("visualizerSettings()"), /<select id="player-visualizer-mode" disabled>/);
  assert.match(p.run("visualizerSettings()"), /cannot share the playing audio/);
  p.audio.paused = false; p.audio.emit("play");
  assert.equal(p.log.contexts.length, 0);
  assert.equal(p.nodes["#player-title"].parentElement.classList.contains("has-visualizer"), false);
});

test("bands follow the loud part of the spectrum and stay between 0 and 1", () => {
  const p = page();
  const bands = p.run(`(() => { const f = new Float32Array(2048).fill(-100); f[Math.round(1000 / (48000 / 2 / 2048))] = -20;
    return Array.from(visualizerBands(f, 48000)); })()`);
  assert.equal(bands.length, 16);
  assert.ok(bands.every(value => value >= 0 && value <= 1));
  const loudest = bands.indexOf(Math.max(...bands));
  const from = 40 * Math.pow(400, loudest / 16), to = 40 * Math.pow(400, (loudest + 1) / 16);
  assert.ok(from <= 1000 && 1000 <= to, `band ${loudest} (${Math.round(from)}–${Math.round(to)} Hz) should hold 1 kHz`);
  assert.deepEqual([...p.run("visualizerBands(new Float32Array(2048).fill(-Infinity), 48000)")], new Array(16).fill(0));
});

test("playback is tapped once without connecting to an output, and a new source replaces the old capture", () => {
  const p = page();
  p.stream.tracks.push(p.track("first"));
  p.audio.paused = false; p.audio.emit("play"); p.audio.emit("play");
  assert.equal(p.log.contexts.length, 1);
  assert.equal(p.log.captures, 1);
  const context = p.log.contexts[0];
  assert.equal(context.sources[0].track.id, "first");
  assert.deepEqual(context.sources[0].connections, [context.analyser]);
  assert.deepEqual(context.analyser.connections, [], "the analyser is never connected to an audio output");
  p.stream.add(p.stream.tracks[0]); // the same track announced again changes nothing
  assert.equal(context.sources.length, 1);
  p.stream.add(p.track("second"));
  assert.equal(context.sources[1].track.id, "second");
  assert.equal(context.sources[0].disconnected, true);
  assert.deepEqual(p.log.stopped, ["first"]);
});

test("the chosen style is remembered and placed; narrow windows show the top edge next to the title; Off removes it", () => {
  const p = page({narrow: true});
  const select = value => p.document.emit("change", {target: {id: "player-visualizer-mode", value}});
  select("cover");
  assert.equal(p.storage["tagcast-player-visualizer"], "cover");
  assert.equal(p.run("visualizer.canvas.placed"), "cover");
  assert.equal(p.nodes["#player-cover-button"].classList.contains("has-visualizer"), true);
  select("edge");
  assert.equal(p.storage["tagcast-player-visualizer"], "edge");
  assert.equal(p.document.documentElement.dataset.playerVisualizer, "title");
  assert.equal(p.run("visualizer.canvas.placed"), "title");
  assert.equal(p.nodes["#player-cover-button"].classList.contains("has-visualizer"), false);
  select("off");
  assert.equal(p.document.documentElement.dataset.playerVisualizer, "off");
  assert.equal(p.run("visualizer.canvas.isConnected"), false);
  assert.equal(p.nodes["#player-title"].parentElement.classList.contains("has-visualizer"), false);
  p.audio.paused = false; p.audio.emit("play");
  assert.equal(p.log.contexts.length, 0, "Off never creates an audio context");
  select("loud");
  assert.equal(p.storage["tagcast-player-visualizer"], "off");
});

test("the playing row receives bar levels while music plays and loses them once paused bars settle", () => {
  const p = page();
  const row = {isConnected: true, classList: {contains: c => c === "playing"},
    style: {properties: {}, setProperty(k, v) { this.properties[k] = v; }, removeProperty(k) { delete this.properties[k]; }}};
  p.document.playingRow = row;
  p.stream.tracks.push(p.track("first"));
  p.audio.paused = false; p.audio.emit("play");
  p.frames(10);
  assert.deepEqual(Object.keys(row.style.properties).sort(), ["--player-eq-0", "--player-eq-1", "--player-eq-2", "--player-eq-3"]);
  assert.ok(p.run("Math.max(...visualizer.levels)") > 0.5);
  p.audio.paused = true; p.audio.emit("pause");
  p.frames(200);
  assert.equal(p.log.frames.length, 0, "the loop stops once the bars have settled");
  assert.deepEqual(row.style.properties, {});
  assert.equal(p.run("Math.max(...visualizer.levels)") < 0.005, true);
});

test("Off releases the capture and audio context without pausing playback, and can reconnect", () => {
  const p = page();
  p.stream.tracks.push(p.track("first"));
  p.audio.paused = false; p.audio.emit("play");
  p.run('setVisualizerMode("off")');
  assert.equal(p.log.contexts[0].state, "closed");
  assert.equal(p.log.contexts[0].sources[0].disconnected, true);
  assert.deepEqual(p.log.stopped, ["first"]);
  assert.equal(p.stream.listeners.length, 0);
  assert.equal(p.run("visualizer.context"), null);
  assert.equal(p.run("visualizer.stream"), null);
  assert.equal(p.run("visualizer.frame"), 0);
  assert.equal(p.audio.paused, false, "the authoritative player is untouched");
  p.stream.tracks.push(p.track("second"));
  p.run('setVisualizerMode("title")');
  assert.equal(p.log.contexts.length, 2);
  assert.equal(p.log.contexts[1].sources[0].track.id, "second");
  assert.equal(p.log.contexts[1].analyser.connections.length, 0);
});

test("failed capture setup closes its partially created context", () => {
  const p = page();
  p.audio.captureStream = () => { throw Error("Capture unavailable"); };
  p.audio.paused = false; p.audio.emit("play");
  assert.equal(p.log.contexts.length, 1);
  assert.equal(p.log.contexts[0].state, "closed");
  assert.equal(p.run("visualizer.context"), null);
  assert.equal(p.run("visualizer.analyser"), null);
  assert.equal(p.audio.paused, false);
});


test("a listening-page VU tap uses the existing capture and separate channels without an audio output", () => {
  const p = page({storage: {'tagcast-player-visualizer':'off'}, listening: true});
  p.audio.paused = false; p.audio.emit('play'); p.stream.add(p.track('stereo')); p.frames(2);
  assert.equal(p.log.captures, 1);
  assert.equal(p.log.contexts.length, 1);
  const source = p.log.contexts[0].sources[0], stereo = p.run('visualizer.stereo');
  assert.deepEqual(source.connections, [p.run('visualizer.analyser'), stereo.splitter]);
  assert.deepEqual(stereo.splitter.connections.map(c=>c[1]), [0,1]);
  assert.ok(stereo.analysers.every(a=>a.connections.length===0), 'analysis graph never reaches a destination');
  assert.ok(p.run('meterFrames') > 0);
  p.run('pageVisible=false;applyVisualizer()');
  assert.equal(stereo.splitter.disconnected, true);
  assert.equal(p.log.contexts[0].state, 'closed');
  assert.equal(p.audio.paused, false);
});

test("leaving the VU page removes stereo analysers but retains a requested compact spectrum", () => {
  const p = page({listening: true}); p.audio.paused = false; p.audio.emit('play'); p.stream.add(p.track('first'));p.frames(2);
  const stereo = p.run('visualizer.stereo');
  p.run('pageVisible=false;applyVisualizer()');
  assert.equal(stereo.splitter.disconnected, true);
  assert.equal(p.run('visualizer.stereo'), null);
  assert.equal(p.log.contexts[0].state, 'running');
  p.stream.add(p.track('second'));p.frames(2);
  assert.equal(p.log.captures, 1);
  assert.equal(p.log.contexts[0].sources.at(-1).connections.length, 1);
});


test("the queue's active occurrence reuses the analyser levels without another capture",()=>{
  const p=page(), original=p.document.querySelector;
  const row={isConnected:true,classList:{contains:c=>c==='playing'},style:{properties:{},setProperty(k,v){this.properties[k]=v;},removeProperty(k){delete this.properties[k];}}};
  p.document.querySelector=selector=>selector==='#now-playing-list .queue-row.playing'?row:original(selector);
  p.stream.tracks.push(p.track('first'));p.audio.paused=false;p.audio.emit('play');p.frames(10);
  assert.equal(Object.keys(row.style.properties).length,4);
  assert.equal(p.log.captures,1);
  p.audio.paused=true;p.audio.emit('pause');p.frames(200);
  assert.deepEqual(row.style.properties,{});
});


test("a hidden album row releases its levels when the listening queue becomes visible",()=>{
  const p=page(),original=p.document.querySelector;
  const row=()=>({isConnected:true,classList:{contains:()=>true},style:{properties:{},setProperty(k,v){this.properties[k]=v;},removeProperty(k){delete this.properties[k];}}});
  const album=row(),queue=row();let hidden=false;
  album.closest=()=>hidden?{}:null;p.document.playingRow=album;
  p.stream.tracks.push(p.track('first'));p.audio.paused=false;p.audio.emit('play');p.frames(2);
  assert.equal(Object.keys(album.style.properties).length,4);
  hidden=true;p.document.querySelector=selector=>selector==='#now-playing-list .queue-row.playing'?queue:original(selector);
  p.frames(2);
  assert.deepEqual(album.style.properties,{});
  assert.equal(Object.keys(queue.style.properties).length,4);
  assert.equal(p.log.captures,1);
});

test("a retained hidden listening queue cannot steal the visible album spectrum",()=>{
  const p=page(),original=p.document.querySelector;
  const row=()=>({isConnected:true,classList:{contains:()=>true},style:{properties:{},setProperty(k,v){this.properties[k]=v;},removeProperty(k){delete this.properties[k];}}});
  const album=row(),queue=row();let queueHidden=false,albumHidden=true;
  album.closest=()=>albumHidden?{}:null;queue.closest=()=>queueHidden?{}:null;
  p.document.playingRow=album;
  p.document.querySelector=selector=>selector==='#now-playing-list .queue-row.playing'?queue:original(selector);
  p.stream.tracks.push(p.track('first'));p.audio.paused=false;p.audio.emit('play');p.frames(2);
  assert.equal(Object.keys(queue.style.properties).length,4);
  queueHidden=true;albumHidden=false;p.frames(2);
  assert.deepEqual(queue.style.properties,{},'Hidden queue releases its levels');
  assert.equal(Object.keys(album.style.properties).length,4,'Visible album receives live levels');
  assert.ok(Math.max(...Object.values(album.style.properties).map(Number))>0.005);
  albumHidden=true;p.frames(2);
  assert.deepEqual(album.style.properties,{});
  assert.deepEqual(queue.style.properties,{});
  assert.equal(p.run('visualizer.row'),null,'Neither hidden view retains the indicator');
  p.run('visualizer.rowSearch=0');queueHidden=false;p.frames(2);
  assert.equal(Object.keys(queue.style.properties).length,4,'Returning to Now playing recovers');
  assert.equal(p.log.captures,1,'Navigation never creates a second audio capture');
  assert.equal(p.audio.paused,false);
});
