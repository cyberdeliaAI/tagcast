"use strict";

// Run the actual page scripts with a small DOM stand-in; no browser or network.
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const staticDir = path.join(root, "src/tagcast/static");

function page({hash = "", storage = {}, server = true, browserNavigator = {}, metadataClass, setupAudio, deferReady = false} = {}) {
  const nodes = new Map(), requests = [], downloads = [], blobs = new Map();
  const documentEvents = new Map();
  const timers = new Map(), windowEvents = new Map();
  // A small stand-in for the browser's history: entries with a state and a hash.
  const location = {search: "", hash, pathname: "/"};
  const entries = [{state: null, hash}];
  let current = 0;
  const history = {
    get state() { return entries[current].state; },
    get length() { return entries.length; },
    pushState(state, _, hash) { entries.splice(current + 1, Infinity, {state: structuredClone(state), hash}); current += 1; location.hash = hash; },
    replaceState(state, _, hash) { entries[current] = {state: structuredClone(state), hash: hash ?? entries[current].hash}; location.hash = entries[current].hash; },
    go(delta) {
      if (!entries[current + delta]) return;
      current += delta; location.hash = entries[current].hash;
      for (const handler of windowEvents.get("popstate") || []) handler({state: structuredClone(entries[current].state)});
    },
    back() { this.go(-1); }, forward() { this.go(1); }};
  let nextTimer = 1;
  let respond = null;
  let respondStatus = null;
  let respondUpdates = null;
  let respondNotes = null;
  let respondAlbumNotes = null;
  let respondLyricsCache = null;
  let playbackClock = 0;
  function element() {
    const classes = new Set();
    const events = new Map(), attributes = new Map();
    return {value: "", checked: false, disabled: false, readOnly: false, dataset: {}, options: [], children: [], innerHTML: "", textContent: "",
      appendChild(node) { this.children = this.children.filter(child => child !== node); this.children.push(node); return node; },
      isConnected: true, style: {}, clientWidth: 1265, clientHeight: 710,
      getBoundingClientRect() { return {left: 1000, right: 1042, top: 300, bottom: 336, width: 220, height: 130}; },
      paused: true,
      classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c)},
      addEventListener(type, handler) { const handlers = events.get(type) || []; handlers.push(handler); events.set(type, handlers); },
      emit(type, event = {}) { return Promise.all((events.get(type) || []).map(handler => handler(event))); },
      dispatchEvent(event) {
        const delivered = {type: event.type, target: this, bubbles: event.bubbles};
        for (const handler of events.get(event.type) || []) handler(delivered);
        if (event.bubbles) for (const handler of documentEvents.get(event.type) || []) handler(delivered);
        return true;
      },
      closest() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      elements: {namedItem() { return null; }}, reportValidity() { return true; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() { document.activeElement = this; },
      play() { this.paused = false; this.emit("play"); return Promise.resolve(); },
      pause() { this.paused = true; this.emit("pause"); }, load() {},
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return name === "src" ? this.src : attributes.get(name); },
      removeAttribute(name) { attributes.delete(name); if (name === "src") delete this.src; }};
  }
  const document = {body: element(), documentElement: element(),
    getElementById(id) { return this.querySelector(`#${id}`); },
    createElement(tag) { assert.equal(tag, "a"); return {click() { downloads.push({name: this.download, blob: blobs.get(this.href)}); }}; },
    addEventListener(type, handler) { const handlers = documentEvents.get(type) || []; handlers.push(handler); documentEvents.set(type, handlers); },
    querySelector(selector) {
      if (selector === "dialog[open]") return [...nodes.entries()].find(([name, node]) => ["#editor", "#review", "#artwork", "#history", "#connect", "#settings", "#updates", "#trash-review", "#cover-lightbox", "#help-dialog", "#tag-dialog", "#audio-output-dialog", "#playlist-import", "#playlist-order"].includes(name) && node.open)?.[1] || null;
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    }, querySelectorAll() { return []; }};
  document.querySelector("#sort").value = "artist";
  document.querySelector("#now-playing-panel").hidden = true;
  const window = {scrollY: 0, scrollTo({top}) { this.scrollY = top; }, addEventListener(type, handler) { const handlers = windowEvents.get(type) || []; handlers.push(handler); windowEvents.set(type, handlers); }};
  if (setupAudio) setupAudio(document.querySelector("#audio"));
  const context = vm.createContext({document, window, location, history, navigator: browserNavigator, MediaMetadata: metadataClass, console, confirm: () => true,
    Event, performance: {now: () => playbackClock},
    localStorage: {getItem(key) { return storage[key] ?? null; }, setItem(key, value) { storage[key] = String(value); }}, structuredClone,
    URL: class extends URL {
      static createObjectURL(blob) { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }
      static revokeObjectURL(url) { blobs.delete(url); }
    }, URLSearchParams, Blob, TextDecoder, TextEncoder,
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({url, options});
      if (url === "/1001-album-notes.json") return respondNotes ? respondNotes(url, options)
        : {ok: true, json: async () => ({schema: 1, entries: []})};
      if (url.startsWith("/api/album-guide/album?")) return respondAlbumNotes ? respondAlbumNotes(url, options)
        : {ok:true,json:async()=>({entries:[]})};
      if (url.startsWith("/api/lyrics/cache?")) return respondLyricsCache ? respondLyricsCache(url, options)
        : {ok:true,json:async()=>({tracks:[]})};
      if (url === "/api/status" && respondStatus) return respondStatus(url, options);
      if (url === "/api/updates" || url === "/api/updates/check") return respondUpdates ? respondUpdates(url, options)
        : {ok: true, json: async () => ({current: "0.10.1", latest: "0.10.1", available: false, state: "current", auto_updates: true})};
      if (respond && url !== "/api/status") return respond(url, options);
      assert.equal(url, "/api/status", "Only the initial status read is allowed in preview tests");
      if (!server) throw Error("No local server");
      return {ok: true, json: async () => ({connected: false, configured: false})};
    }});
  const pageHTML = readFileSync(path.join(staticDir, "index.html"), "utf8");
  for (const [, source] of pageHTML.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(source, context);
  const scripts = [...pageHTML.matchAll(/<script src="([^"]+)"/g)];
  for (const [, file] of scripts) vm.runInContext(readFileSync(path.join(staticDir, file), "utf8"), context, {filename: file});
  if (!deferReady) for (const handler of documentEvents.get("DOMContentLoaded") || []) handler();
  return {run: source => vm.runInContext(source, context), nodes, requests, downloads, history, location,
    setPlaybackClock(value) { playbackClock = value; },
    setFetch(handler) { respond = handler; },
    setStatusFetch(handler) { respondStatus = handler; },
    setUpdateFetch(handler) { respondUpdates = handler; },
    setNotesFetch(handler) { respondNotes = handler; },
    setAlbumNotesFetch(handler) { respondAlbumNotes = handler; },
    setLyricsCacheFetch(handler) { respondLyricsCache = handler; },
    flushTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
    async emitDocument(type, event = {}) {
      const dispatched = {target: {closest: () => null}, ...event};
      await Promise.all((documentEvents.get(type) || []).map(handler => handler(dispatched)));
    },
    async click(matches) {
      const event = {target: {closest: selector => matches[selector] || selector.split(',').map(s => matches[s.trim()]).find(Boolean) || null}};
      for (const handler of documentEvents.get("click") || []) await handler(event);
      await new Promise(resolve => setImmediate(resolve));
    },
    async change(target) {
      for (const handler of documentEvents.get("change") || []) await handler({target});
    },
    async keydown(key) {
      for (const handler of documentEvents.get("keydown") || []) await handler({key, target: {closest: () => null}});
    },
    json: source => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context))};
}

test('startup settings wait for all deferred feature scripts before applying preferences', async () => {
  const p=page({deferReady:true}); await settle();
  assert.equal(p.requests.length,0,'No live startup response can race later deferred scripts');
  p.setFetch(url=>{
    assert.equal(url,'/api/settings');
    return {ok:true,json:async()=>({sources:[],artist_biographies:true,album_information:true,
      album_guide:true,auto_updates:false})};
  });
  await p.emitDocument('DOMContentLoaded'); await settle();
  assert.equal(p.requests.filter(r=>r.url==='/api/settings').length,1);
  assert.equal(p.run('artistProfile.enabled'),true);
  assert.equal(p.run('albumInformation.enabled'),true);
  assert.equal(p.run('albumGuide.enabled'),true);
});

test("new installations sign in with a code without client ID setup", async () => {
  const p = page(); await settle();
  p.run('state.connection = {configured: true, connected: false, using_default_client: true}; openConnect()');
  const content = p.nodes.get('#connect-content');
  assert.match(content.innerHTML, /Tagcast is already registered/);
  assert.match(content.innerHTML, /id="device-start"/);
  assert.doesNotMatch(content.innerHTML, /id="client-id"|id="client-save"|id="client-change"|id="browser-start"|Developers|Your Apps/);
  p.setFetch(url => {
    assert.equal(url, '/api/auth/device');
    return {ok: true, json: async () => ({device: {state: 'pending', user_code: 'TEST-CODE', verification_uri: 'https://example.invalid/device'}})};
  });
  await p.click({'#device-start': {id: 'device-start'}});
  assert.match(content.innerHTML, /TEST-CODE/);
  assert.equal(p.requests.filter(r => r.url.startsWith('/api/config')).length, 0);
});

test("existing registrations stay connected and switching is explicit after disconnect", async () => {
  const p = page(); await settle();
  p.run('state.connection = {configured: true, connected: true, using_default_client: false}; openConnect()');
  assert.doesNotMatch(p.nodes.get('#connect-content').innerHTML, /id="client-default"/);
  assert.equal(p.requests.filter(r => r.options?.method === 'POST').length, 0);
  p.setFetch(url => ({ok: true, json: async () => url === '/api/config/default'
    ? {configured: true, connected: false, using_default_client: true} : {}}));
  await p.click({'#connect-logout': {id: 'connect-logout'}}); p.run('openConnect()');
  assert.match(p.nodes.get('#connect-content').innerHTML, /previously configured app registration/);
  assert.match(p.nodes.get('#connect-content').innerHTML, /id="browser-start"/);
  assert.match(p.nodes.get('#connect-content').innerHTML, /id="client-default"/);
  await p.click({'#client-default': {id: 'client-default'}});
  assert.equal(p.requests.filter(r => r.url === '/api/config/default').length, 1);
  assert.match(p.nodes.get('#connect-content').innerHTML, /Tagcast is already registered/);
  assert.doesNotMatch(p.nodes.get('#connect-content').innerHTML, /id="client-default"|id="browser-start"/);
  p.run('state.connection = {configured: true, connected: false, using_default_client: false, client_id_from_env: true}; openConnect()');
  assert.doesNotMatch(p.nodes.get('#connect-content').innerHTML, /id="client-default"/);
});

test("code reauthorization keeps waiting even while the previous session is connected", async () => {
  const p = page(); await settle();
  p.run('state.connection = {connected: true, configured: true, using_default_client: true, device: {state: "pending", user_code: "NEW-CODE", verification_uri: "https://example.invalid/device"}}; openConnect()');
  p.setStatusFetch(() => ({ok: true, json: async () => ({connected: true, using_default_client: true, device: {state: 'pending'}})}));
  p.flushTimers(2000); await settle();
  assert.equal(p.nodes.get('#connect').open, true);
  assert.match(p.nodes.get('#connect-content').innerHTML, /Waiting for you to approve/);
  assert.equal(p.requests.filter(r => r.url.startsWith('/api/library')).length, 0);
  p.setStatusFetch(() => ({ok: true, json: async () => ({connected: true, using_default_client: true, device: {state: 'error', error: 'Permission denied'}})}));
  p.flushTimers(2000); await settle();
  assert.match(p.nodes.get('#connect-content').innerHTML, /Permission denied/);
  assert.match(p.nodes.get('#connect-content').innerHTML, /id="device-start"/);
  assert.equal(p.nodes.get('#connect').open, true);
});

test("queue permissions use code sign-in for the public registration without changing playback", async () => {
  const p = livePage(); await settle();
  p.run('state.connection.using_default_client = true; lookup.queueSync = true; playTracks(state.details.get("1")); $("#settings").showModal()');
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  await p.click({'[data-queue-reconnect]': {}});
  assert.equal(p.nodes.get('#settings').open, false);
  assert.equal(p.nodes.get('#connect').open, true);
  assert.match(p.nodes.get('#connect-content').innerHTML, /id="device-start"/);
  assert.equal(p.requests.filter(r => r.url === '/api/auth/browser').length, 0);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
});

for (const field of ["genres", "composers"]) {
  test(`demo: reviewed ${field} arrays can be applied to the local preview`, async () => {
    const p = page();
    await p.run("openEditor([state.albums[0].id])");
    p.run(`editing.trackPatches[String(editing.originals[0].tracks[0].id)] = {${field}: ["New label", "Second label"]}; buildReview()`);
    assert.equal(p.run("pending.changes.length"), 1);
    p.run("applyDraft()");
    assert.deepEqual(p.json(`state.details.get(state.albums[0].id).tracks[0].${field}`), ["New label", "Second label"]);
    assert.equal(p.run("state.history[0].status"), "preview_only");
    assert.equal(p.run("pending"), null);
    assert.ok(p.requests.every(r => !r.options?.body), "Preview never sends writes");
  });
}

test("History exports the existing format and clears only after confirmation, including legacy storage", async () => {
  const entry = {created: "2026-10-10T10:00:00Z", source: "ibroadcast", status: "saved",
    selection: [{id: "1", name: "Wish You Were Here"}], changes: []};
  const storage = {"library-studio-history": JSON.stringify([entry])};
  const p = page({storage});
  await settle();
  const library = p.json("state.albums");
  await p.nodes.get("#show-history").emit("click");
  await p.nodes.get("#history-clear-confirm").emit("click");
  assert.equal(p.run("state.history.length"), 1, "Confirmation cannot be skipped");
  await p.nodes.get("#history-clear").emit("click");
  assert.equal(p.nodes.get("#history-clear-review").hidden, false);
  await p.nodes.get("#history-clear-cancel").emit("click");
  assert.equal(p.run("state.history.length"), 1);
  assert.equal(storage["tagcast-history"], undefined, "Cancel does not change persisted history");
  await p.nodes.get("#history-export").emit("click");
  const exported = JSON.parse(await p.downloads[0].blob.text());
  assert.equal(exported.format, "tagcast-history");
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.entries, [entry]);
  assert.match(p.downloads[0].name, /^tagcast-history-\d{4}-\d{2}-\d{2}\.json$/);
  await p.nodes.get("#history-clear").emit("click");
  await p.nodes.get("#history-clear-confirm").emit("click");
  assert.equal(p.run("state.history.length"), 0);
  assert.equal(p.nodes.get("#history-count").textContent, 0);
  assert.equal(p.nodes.get("#history-clear").disabled, true);
  assert.equal(p.nodes.get("#history-export").disabled, true);
  assert.equal(storage["tagcast-history"], "[]");
  assert.deepEqual(p.json("state.albums"), library, "Clearing never changes the library");
  assert.ok(p.requests.every(r => !r.options?.body), "Clearing never sends writes");
  const reloaded = page({storage});
  await settle();
  assert.equal(reloaded.run("state.history.length"), 0, "Legacy entries cannot return on reload");
});

test("History cannot be cleared during read-back, even if confirmation was already open", async () => {
  const p = page();
  await settle();
  p.run(`state.history = [{status: "sent", source: "ibroadcast", selection: [{name: "Test album"}], changes: []}]; showHistory()`);
  await p.nodes.get("#history-clear").emit("click");
  p.setFetch(async () => ({ok: true, json: async () => ({state: "done", results: [], albums: p.json("state.albums")})}));
  const job = p.run('followJob("test-job", state.history[0])');
  assert.equal(p.nodes.get("#history-clear-confirm").disabled, true);
  await p.nodes.get("#history-clear-confirm").emit("click");
  assert.equal(p.run("state.history.length"), 1);
  p.flushTimers(2000); await job;
  assert.equal(p.nodes.get("#history-clear-confirm").disabled, false);
  await p.nodes.get("#history-clear-confirm").emit("click");
  assert.equal(p.run("state.history.length"), 0);
});

test("History clearing reports a storage failure without losing the entries", async () => {
  const p = page();
  await settle();
  p.run(`state.history = [{status: "saved", source: "ibroadcast", selection: [{name: "Test album"}], changes: []}]; showHistory();
    localStorage.setItem = () => { throw Error("Storage unavailable"); }`);
  await p.nodes.get("#history-clear").emit("click");
  await p.nodes.get("#history-clear-confirm").emit("click");
  assert.equal(p.run("state.history.length"), 1);
  assert.match(p.nodes.get("#history-status").textContent, /could not be cleared from browser storage/);
  assert.equal(p.nodes.get("#history-export").disabled, false, "An export is still possible");
});

test("History clearing waits for an artwork Undo request as well as its read-back", async () => {
  const p = livePage();
  await settle();
  p.run(`state.history = [artworkEntry({target: "artist", id: "42", label: "Pink Floyd", artist: "Pink Floyd"},
    {artwork_id: 77, previous: {artwork_id: 8}, results: []}, "after", "before")]; showHistory()`);
  let rejectUndo;
  p.setFetch(() => new Promise((_, reject) => { rejectUndo = reject; }));
  const undo = p.run("undoArtwork(state.history[0])");
  assert.equal(p.nodes.get("#history-clear").disabled, true);
  await p.nodes.get("#history-clear").emit("click");
  assert.equal(p.nodes.get("#history-clear-review").hidden, true);
  rejectUndo(Error("Test request failed")); await undo;
  assert.equal(p.nodes.get("#history-clear").disabled, false);
  assert.equal(p.run("state.history.length"), 1);
});

test("a real preview conflict rejects the whole draft, including earlier changes", async () => {
  const p = page();
  await p.run("openEditor([state.albums[0].id])");
  p.run(`editing.trackPatches[String(editing.originals[0].tracks[0].id)] = {genres: ["New genre"]};
    editing.trackPatches[String(editing.originals[0].tracks[1].id)] = {composers: ["New composer"]}; buildReview();
    state.details.get(state.albums[0].id).tracks[1].composers = ["Changed elsewhere"]; applyDraft()`);
  assert.equal(p.run("state.history.length"), 0);
  assert.deepEqual(p.json("state.details.get(state.albums[0].id).tracks[0].genres"), ["Progressive Rock"]);
  assert.match(p.nodes.get("#toast").textContent, /changed since this draft/);
});

test("changing genre order still counts as a conflict", async () => {
  const p = page();
  p.run('state.details.get(state.albums[0].id).tracks[0].genres = ["First", "Second"]');
  await p.run("openEditor([state.albums[0].id])");
  p.run(`editing.trackPatches[String(editing.originals[0].tracks[0].id)] = {genres: ["Replacement"]}; buildReview();
    state.details.get(state.albums[0].id).tracks[0].genres.reverse(); applyDraft()`);
  assert.equal(p.run("state.history.length"), 0);
  assert.match(p.nodes.get("#toast").textContent, /changed since this draft/);
});

function livePage(options) {
  const p = page(options);
  p.run(`const first = state.details.get(state.albums[0].id);
    Object.assign(first, {artist_id: 42, artist_image: "https://example.test/artist-150", artist_artwork_id: 8});
    const second = state.details.get(state.albums[2].id);
    Object.assign(second, {artist_id: 43, artist_image: "https://example.test/other-150", artist_artwork_id: 9});
    state.albums = [...state.details.values()].map(summarize); state.mode = "live"`);
  return p;
}

function playbackPage({outputs = false, choose, enumerate, unsupported = [], airplay = false} = {}) {
  const actions = new Map(), positions = [], sinks = [], events = new Map();
  const session = {setActionHandler(action, handler) {
    if (unsupported.includes(action)) throw new Error("Unsupported action");
    actions.set(action, handler);
  }, setPositionState(position) { positions.push(position && structuredClone(position)); }};
  const mediaDevices = {addEventListener: (name, handler) => events.set(name, handler)};
  if (outputs) mediaDevices.enumerateDevices = enumerate || (async () => [
    {kind: "audiooutput", deviceId: "default", label: "Default"},
    {kind: "audiooutput", deviceId: "dac", label: "USB DAC"},
    {kind: "audioinput", deviceId: "microphone", label: "Microphone"},
  ]);
  if (choose) mediaDevices.selectAudioOutput = choose;
  mediaDevices.getUserMedia = () => { throw new Error("Microphone access must never be requested"); };
  const p = livePage({browserNavigator: {mediaSession: session, mediaDevices},
    metadataClass: class { constructor(data) { Object.assign(this, data); } },
    setupAudio(audio) {
      Object.assign(audio, {duration: 120, currentTime: 15, playbackRate: 1, sinkId: "", volume: 1, muted: false});
      if (outputs) audio.setSinkId = async id => { sinks.push(id); audio.sinkId = id; };
      if (airplay) audio.webkitShowPlaybackTargetPicker = () => { sinks.push("AirPlay picker"); };
    }});
  return Object.assign(p, {actions, positions, sinks, session, deviceEvents: events});
}

test("player volume and mute work independently of browser output APIs without restarting audio", async () => {
  for (const options of [{}, {outputs: true}, {airplay: true}]) {
    const p = playbackPage(options); await settle();
    p.run('playTracks(state.details.get("1")); audio.pause(); audio.volume = 0.65; openPlaybackOutput()'); await settle();
    const source = p.nodes.get("#audio").src, queue = p.json("player.queue"), history = p.history.length;
    assert.equal(p.nodes.get("#audio-volume").value, "65", "Opening reads volume without resetting it");
    await p.nodes.get("#audio-volume").emit("input", {target: {value: "35"}});
    assert.equal(p.nodes.get("#audio").volume, 0.35);
    assert.equal(p.nodes.get("#audio-volume-value").textContent, "35%");
    await p.nodes.get("#audio-mute").emit("click");
    assert.equal(p.nodes.get("#audio").muted, true);
    assert.equal(p.nodes.get("#audio").volume, 0.35, "Muting keeps the volume available for unmuting");
    assert.equal(p.nodes.get("#audio-mute").textContent, "Unmute");
    await p.nodes.get("#audio-mute").emit("click");
    assert.equal(p.nodes.get("#audio").muted, false);
    p.run('audio.muted = true');
    await p.nodes.get("#audio-volume").emit("input", {target: {value: "50"}});
    assert.equal(p.nodes.get("#audio").muted, false, "Raising volume explicitly unmutes");
    assert.equal(p.nodes.get("#audio").paused, true);
    assert.equal(p.nodes.get("#audio").currentTime, 15);
    assert.equal(p.nodes.get("#audio").src, source);
    assert.deepEqual(p.json("player.queue"), queue);
    assert.equal(p.history.length, history);
  }
});

test("volume follows native changes, stays bounded, and displays refused changes honestly", async () => {
  const p = playbackPage(); await settle();
  p.run('playTracks(state.details.get("1")); openPlaybackOutput(); audio.volume = 0.22; audio.muted = true');
  await p.nodes.get("#audio").emit("volumechange");
  assert.equal(p.nodes.get("#audio-volume").value, "22");
  assert.match(p.nodes.get("#audio-volume").getAttribute("aria-valuetext"), /22%.*muted/);
  for (const [value, expected] of [["200", 1], ["-50", 0], ["invalid", 0]]) {
    await p.nodes.get("#audio-volume").emit("input", {target: {value}});
    assert.equal(p.nodes.get("#audio").volume, expected);
  }
  p.run('Object.defineProperty(audio, "volume", {get: () => 1, set: () => {}})');
  await p.nodes.get("#audio-volume").emit("input", {target: {value: "25"}});
  assert.equal(p.nodes.get("#audio-volume").value, "100", "The slider reflects an output that ignores volume changes");
  assert.match(p.nodes.get("#audio-volume-note").textContent, /system or device/);
});

test("stale volume and mute controls cannot affect a stopped player or queue controller", async () => {
  for (const reset of ['stopPlayer()', 'queueSync.active = true; queueSync.allowed = false']) {
    const p = playbackPage(); await settle();
    p.run('playTracks(state.details.get("1")); openPlaybackOutput()');
    p.run(reset);
    await p.nodes.get("#audio-volume").emit("input", {target: {value: "25"}});
    await p.nodes.get("#audio-mute").emit("click");
    assert.equal(p.nodes.get("#audio").volume, 1);
    assert.equal(p.nodes.get("#audio").muted, false);
  }
});

test("system media controls keep track metadata, progress and local playback in sync", async () => {
  const p = playbackPage({unsupported: ["seekbackward"]}); await settle();
  p.run('const album = state.details.get("1"); album.tracks[0].artist = "Track performer"; playTracks(album)');
  assert.equal(p.session.metadata.artist, "Track performer");
  assert.equal(p.session.metadata.album, p.run("player.album.name"));
  assert.equal(p.session.playbackState, "playing");
  assert.deepEqual(p.positions.at(-1), {duration: 120, position: 15, playbackRate: 1});
  assert.equal(typeof p.actions.get("nexttrack"), "function", "One unsupported action leaves other controls working");
  p.actions.get("pause")();
  assert.equal(p.nodes.get("#audio").paused, true);
  assert.equal(p.session.playbackState, "paused");
  p.actions.get("play")(); await settle();
  assert.equal(p.nodes.get("#audio").paused, false);
  p.actions.get("nexttrack")();
  assert.equal(p.run("player.index"), 1);
  assert.equal(p.session.metadata.title, p.run("player.queue[1].title"));
  p.actions.get("previoustrack")();
  assert.equal(p.run("player.index"), 0);
  p.actions.get("seekto")({seekTime: 999});
  assert.equal(p.nodes.get("#audio").currentTime, 120);
  p.actions.get("seekto")({seekTime: -8});
  assert.equal(p.nodes.get("#audio").currentTime, 0);
  p.actions.get("seekforward")({});
  assert.equal(p.nodes.get("#audio").currentTime, 10);
  p.actions.get("seekto")({seekTime: NaN});
  assert.equal(p.nodes.get("#audio").currentTime, 10);
  p.actions.get("stop")();
  assert.equal(p.session.metadata, null);
  assert.equal(p.session.playbackState, "none");
  assert.equal(p.run("player.queue.length"), 0);
  assert.equal(p.positions.at(-1), undefined);
  assert.ok([...p.actions.values()].every(handler => handler === null));
});

test("system timeline handles fast seek, unknown duration and throttled progress updates", async () => {
  const p = playbackPage(); await settle();
  p.run('playTracks(state.details.get("1")); audio.fastSeek = target => {audio.currentTime = target};');
  p.actions.get("seekto")({seekTime: 42, fastSeek: true});
  assert.equal(p.nodes.get("#audio").currentTime, 42);
  const count = p.positions.length;
  p.setPlaybackClock(500); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(p.positions.length, count);
  p.setPlaybackClock(1100); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(p.positions.length, count + 1);
  p.run('audio.duration = NaN'); await p.nodes.get("#audio").emit("durationchange");
  assert.equal(p.positions.at(-1), undefined);
  p.actions.get("seekforward")({seekOffset: 20});
  assert.equal(p.nodes.get("#audio").currentTime, 42, "Unknown duration cannot produce an invalid seek");
});

test("system handlers cannot play after library replacement or in queue controller mode", async () => {
  const p = playbackPage(); await settle();
  p.run('playTracks(state.details.get("1"))');
  const stalePlay = p.actions.get("play"), staleNext = p.actions.get("nexttrack");
  p.run('queueSync.enabled = true; queueSync.active = true; queueSync.allowed = true; state.connection.playback_session = "test-session";');
  p.setFetch(async () => ({ok: true, json: async () => ({session: "test-session", own: true, revision: 2,
    state: {role: "controller"}})}));
  await p.run('pollQueue()');
  assert.equal(p.session.metadata, null);
  assert.equal(p.actions.get("play"), null);
  stalePlay(); staleNext();
  assert.equal(p.nodes.get("#audio").paused, true);
  assert.equal(p.run("player.index"), 0);
  p.run('useLocal(demoLibrary(), "demo")');
  stalePlay(); staleNext();
  assert.equal(p.run("player.queue.length"), 0);
  assert.equal(p.session.playbackState, "none");
});

test("partial and missing media session implementations preserve ordinary playback", async () => {
  const p = livePage({browserNavigator: {mediaSession: {setActionHandler() { throw Error("Unsupported"); },
    setPositionState() { throw Error("Unsupported"); }, set metadata(_) { throw Error("Unsupported"); }}}});
  await settle();
  p.run('playTracks(state.details.get("1")); step(1); stopPlayer()');
  assert.equal(p.run("player.queue.length"), 0);
  const absent = livePage(); await settle();
  absent.run('playTracks(state.details.get("1")); step(1)');
  assert.equal(absent.run("player.index"), 1);
});

test("output discovery is explicit and switching leaves source, position, queue and pause unchanged", async () => {
  let reads = 0;
  const p = playbackPage({outputs: true, choose: async () => ({deviceId: "dac", label: "USB DAC"}), enumerate: async () => {
    reads++; return [{kind: "audiooutput", deviceId: "dac", label: "USB DAC"},
      {kind: "audioinput", deviceId: "mic", label: "Microphone"}];
  }});
  await settle();
  assert.equal(reads, 0);
  p.run('playTracks(state.details.get("1")); audio.pause(); $("#player-output").focus()');
  const queue = p.json("player.queue"), source = p.nodes.get("#audio").src, history = p.history.length;
  await p.nodes.get("#player-output").emit("click"); await settle();
  assert.equal(p.nodes.get("#audio-output-dialog").open, true);
  assert.equal(p.nodes.get("#audio-output-choose").hidden, false);
  assert.doesNotMatch(p.nodes.get("#audio-output-select").innerHTML, /Microphone/);
  await p.nodes.get("#audio-output-choose").emit("click");
  assert.deepEqual(p.sinks, ["dac"]);
  assert.equal(p.nodes.get("#audio").src, source);
  assert.equal(p.nodes.get("#audio").currentTime, 15);
  assert.equal(p.nodes.get("#audio").paused, true);
  assert.deepEqual(p.json("player.queue"), queue);
  assert.match(p.nodes.get("#audio-output-current").textContent, /USB DAC/);
  await p.nodes.get("#audio-output-select").emit("change", {target: {value: ""}});
  assert.deepEqual(p.sinks, ["dac", ""]);
  await p.nodes.get("#audio-output-dialog").emit("cancel", {preventDefault() {}});
  assert.equal(p.nodes.get("#audio-output-dialog").open, false);
  assert.equal(p.run('document.activeElement === $("#player-output")'), true);
  assert.equal(p.history.length, history);
});

test("cancelled and unavailable outputs keep the current output and can be retried explicitly", async () => {
  let errorName = "NotAllowedError", attempts = 0;
  const p = playbackPage({outputs: true, choose: async () => { attempts++; throw {name: errorName}; }});
  await settle(); p.run('playTracks(state.details.get("1")); openPlaybackOutput()'); await settle();
  await p.nodes.get("#audio-output-choose").emit("click");
  assert.match(p.nodes.get("#audio-output-error").textContent, /cancelled/);
  assert.equal(p.nodes.get("#audio").sinkId, "");
  errorName = "NotFoundError";
  await p.nodes.get("#audio-output-choose").emit("click");
  assert.match(p.nodes.get("#audio-output-error").textContent, /no longer available/);
  assert.equal(attempts, 2);
  assert.deepEqual(p.sinks, []);
});

test("late output picker results cannot switch after closing, stopping or replacing the queue", async () => {
  for (const change of ['closePlaybackOutput()', 'stopPlayer()', 'playTracks(state.details.get("2"))', 'useLocal(demoLibrary(), "demo")']) {
    let finish, attempts = 0;
    const p = playbackPage({outputs: true, choose: () => { attempts++; return new Promise(resolve => { finish = resolve; }); }});
    await settle(); p.run('playTracks(state.details.get("1")); openPlaybackOutput()'); await settle();
    const choosing = p.nodes.get("#audio-output-choose").emit("click");
    await p.nodes.get("#audio-output-choose").emit("click");
    assert.equal(attempts, 1, "Only one picker can be outstanding");
    p.run(change); finish({deviceId: "dac", label: "USB DAC"}); await choosing;
    assert.deepEqual(p.sinks, [], change);
  }
});

test("output device changes refresh only an open dialog and ignore an older discovery result", async () => {
  const resolves = [];
  const p = playbackPage({outputs: true, enumerate: () => new Promise(resolve => resolves.push(resolve))});
  await settle(); p.run('playTracks(state.details.get("1")); openPlaybackOutput()');
  p.run('closePlaybackOutput(); openPlaybackOutput()');
  resolves[0]([{kind: "audiooutput", deviceId: "old", label: "Old output"}]); await settle();
  assert.doesNotMatch(p.nodes.get("#audio-output-select").innerHTML, /Old output/);
  resolves[1]([{kind: "audiooutput", deviceId: "new", label: "New output"}]); await settle();
  assert.match(p.nodes.get("#audio-output-select").innerHTML, /New output/);
  p.run('closePlaybackOutput()'); p.deviceEvents.get("devicechange")();
  assert.equal(resolves.length, 2);
});

test("native AirPlay and system-settings fallback work without output device APIs", async () => {
  const p = playbackPage({airplay: true}); await settle();
  p.run('playTracks(state.details.get("1")); openVisualPlayer(); openPlaybackOutput()');
  assert.equal(p.nodes.get("#audio-output-airplay").hidden, false);
  assert.equal(p.nodes.get("#audio-output-choose").hidden, true);
  assert.equal(p.nodes.get("#audio-output-devices").hidden, true);
  assert.match(p.nodes.get("#audio-output-note").textContent, /system sound settings/);
  await p.nodes.get("#audio-output-airplay").emit("click");
  assert.deepEqual(p.sinks, ["AirPlay picker"]);
  p.run('audio.webkitCurrentPlaybackTargetIsWireless = true');
  await p.nodes.get("#audio").emit("webkitcurrentplaybacktargetiswirelesschanged");
  assert.match(p.nodes.get("#audio-output-current").textContent, /AirPlay/);
  await p.nodes.get("#audio").emit("webkitplaybacktargetavailabilitychanged", {availability: "not-available"});
  assert.equal(p.nodes.get("#audio-output-airplay").hidden, true);
  p.run('closePlaybackOutput()');
  assert.equal(p.run("visualPlayer.open"), true, "Closing output selection leaves fullscreen playback intact");
});

function tagFixture() {
  const rows = [{id:"10",name:"<Listen & later>",archived:false,tracks:2,total_tracks:2,before:"tag-ten"},
    {id:"20",name:"Week;end",archived:false,tracks:0,total_tracks:0,before:"tag-twenty"},
    {id:"30",name:"Hidden",archived:true,tracks:0,total_tracks:0,before:"tag-thirty"}];
  return {rows, selection:{target:{albums:["1"],track:null},label:"Wish You Were Here",tracks:5,before:"target-before",
    tags:[{...rows[0],selected:2}]}};
}

test("native tags open read-only, preserve partial assignments and review explicit changes across searches", async () => {
  const p = livePage(); await settle(); const fixture = tagFixture();
  p.run('state.screen="albums"; playTracks(state.details.get("3"))');
  const queue = p.json("player.queue"), audio = p.nodes.get("#audio").src, history = p.history.length;
  const posts = [];
  p.setFetch((url, options) => {
    if (url.startsWith("/api/tags/selection?")) return {ok:true,json:async()=>fixture.selection};
    if (url.startsWith("/api/tags?")) return {ok:true,json:async()=>({tags:fixture.rows,total:3,offset:0})};
    if (url === "/api/tags/save") { posts.push(JSON.parse(options.body)); return {ok:true,json:async()=>({job:"tags",error:"",sent:1})}; }
    if (url === "/api/jobs/tags") return {ok:true,json:async()=>({state:"done",results:[{id:"20",status:"saved"}]})};
    throw Error(url);
  });
  await p.run('openTrackTags("1")');
  assert.equal(posts.length, 0);
  assert.match(p.nodes.get("#tag-choices").innerHTML, /&lt;Listen &amp; later&gt;.*2 of 5 tracks/);
  assert.doesNotMatch(p.nodes.get("#tag-choices").innerHTML, /<Listen & later>/);
  assert.equal(p.nodes.get("#tag-review").disabled, true);
  await p.change({matches:s=>s==="[data-tag-change]",dataset:{tagChange:"20"},value:"add"});
  p.run('tagDraft.query="other page"'); await p.run("loadTagChoices()");
  assert.equal(p.run("tagDraft.changes.size"), 1);
  p.run("reviewTags()");
  assert.equal(posts.length, 0);
  assert.match(p.nodes.get("#tag-dialog-content").innerHTML, /Week;end.*5 tracks/);
  assert.deepEqual(p.json("tagDraft.body.changes"), [{id:"20",before:"tag-twenty",action:"add"}]);
  assert.equal(p.run('document.activeElement === $("#tag-back")'), true);
  await p.run("saveTags()");
  assert.equal(posts.length, 1); assert.equal(posts[0].approved, true);
  assert.deepEqual(posts[0].target, {albums:["1"],track:null});
  assert.match(p.nodes.get("#tag-dialog-content").innerHTML, /saved and confirmed/);
  assert.equal(p.run("state.details.size"), 0, "Tag changes invalidate loaded tag metadata");
  assert.deepEqual(p.json("player.queue"), queue); assert.equal(p.nodes.get("#audio").src, audio);
  assert.equal(p.history.length, history);
  assert.equal(p.run("state.history.length"), 0, "Tags do not create metadata Undo entries");
});

test("tag names remain literal, Keep editing retains drafts and deletion reviews the global scope", async () => {
  const p = livePage(); await settle(); const fixture = tagFixture();
  p.setFetch(()=>({ok:true,json:async()=>fixture.rows[0]}));
  await p.run('openTagAction("create")');
  p.nodes.get("#tag-name").value="A; B <new>"; p.run("reviewTags()");
  assert.equal(p.run("tagDraft.body.name"), "A; B <new>");
  assert.match(p.nodes.get("#tag-dialog-content").innerHTML, /A; B &lt;new&gt;/);
  await p.click({"#tag-back":{}});
  assert.match(p.nodes.get("#tag-dialog-content").innerHTML, /value="A; B &lt;new&gt;"/);
  await p.run('openTagAction("delete", "10")');
  assert.match(p.nodes.get("#tag-dialog-content").innerHTML, /including hidden or trashed tracks.*music is kept/);
  p.run("reviewTags()");
  assert.deepEqual(p.json("tagDraft.body"), {action:"delete",name:"",id:"10",before:"tag-ten"});
  assert.equal(p.requests.filter(r=>r.options?.method==="POST").length, 0);
});

test("late tag reads cannot cross library replacement and uncertain saves cannot be retried", async () => {
  const p = livePage(); await settle(); let resolve; const fixture = tagFixture();
  p.setFetch(()=>new Promise(done=>{resolve=done;}));
  const opening = p.run('openTrackTags("1", "101")'); await settle();
  assert.match(p.requests.at(-1).url, /track=101/);
  p.run('useLocal(demoLibrary(), "demo")');
  resolve({ok:true,json:async()=>fixture.selection}); await opening;
  assert.equal(p.nodes.get("#tag-dialog").open, false);
  assert.equal(p.run("tagDraft.selection"), null);
  p.run('state.mode="live"; state.screen="albums"');
  p.setFetch((url)=>({ok:true,json:async()=>url.startsWith("/api/tags/selection") ? fixture.selection : url.startsWith("/api/tags?")
    ? {tags:fixture.rows,total:3,offset:0} : url==="/api/tags/save" ? {job:"uncertain",error:"",sent:1}
      : {state:"done",results:[{id:"20",status:"unverified"}]}}));
  await p.run('openTrackTags("1")');
  await p.change({matches:s=>s==="[data-tag-change]",dataset:{tagChange:"20"},value:"add"});
  p.run("reviewTags()"); await p.run("saveTags()");
  assert.match(p.nodes.get("#tag-dialog-content").innerHTML, /could not be confirmed/);
  await p.run("saveTags()");
  assert.equal(p.requests.filter(r=>r.url==="/api/tags/save").length, 1);
});


function selectedTagFixture() {
  const fixture=tagFixture();
  fixture.selection={...fixture.selection,target:{albums:["1","3"],track:null,multiple:true},
    label:"2 selected albums",tracks:17,albums:[
      {ids:["1"],name:"Wish You Were Here",artist:"Pink Floyd",tracks:5},
      {ids:["3"],name:"Hounds <of> Love",artist:"Kate Bush",tracks:12}]};
  return fixture;
}

test("Tag selection covers albums outside current filters and preserves playback, paging and selection", async()=>{
  const p=livePage();await settle();const fixture=selectedTagFixture(),posts=[];
  p.run('state.screen="albums";state.selected=new Set(["1","3"]);$("#search").value="Pink";playTracks(state.details.get("4"));render();$("#tag-selection").focus();window.scrollY=350');
  const queue=p.json('player.queue'),audio=p.nodes.get('#audio'),history=p.history.length;
  assert.equal(p.nodes.get('#tag-selection').hidden,false);
  assert.match(p.nodes.get('#selection-count').textContent,/outside current results/);
  p.setFetch((url,options)=>{
    if(url.startsWith('/api/tags/selection?')){assert.match(url,/albums=1%2C3.*multiple=1/);return {ok:true,json:async()=>fixture.selection};}
    if(url.startsWith('/api/tags?'))return {ok:true,json:async()=>({tags:fixture.rows,total:3,offset:0})};
    if(url==='/api/tags/save'){posts.push(JSON.parse(options.body));return {ok:true,json:async()=>({job:'selected-tags',sent:1,error:''})};}
    return {ok:true,json:async()=>({state:'done',results:[{id:'20',status:'saved'}]})};
  });
  await p.click({'#tag-selection':{}});
  assert.equal(posts.length,0);
  assert.match(p.nodes.get('#tag-dialog-content').innerHTML,/Pink Floyd.*Hounds &lt;of&gt; Love.*Kate Bush/);
  await p.change({matches:s=>s==='[data-tag-change]',dataset:{tagChange:'20'},value:'add'});
  p.run('reviewTags()');
  assert.match(p.nodes.get('#tag-dialog-content').innerHTML,/all 17 tracks of 2 selected albums/);
  assert.equal(posts.length,0);
  await p.run('saveTags()');
  assert.equal(posts.length,1);assert.deepEqual(posts[0].target,fixture.selection.target);
  assert.match(p.nodes.get('#tag-dialog-content').innerHTML,/saved and confirmed/);
  assert.deepEqual(p.json('[...state.selected]'),['1','3']);assert.deepEqual(p.json('player.queue'),queue);
  assert.equal(p.nodes.get('#audio'),audio);assert.equal(p.history.length,history);
  assert.equal(p.nodes.get('#search').value,'Pink');assert.equal(p.run('state.history.length'),0);
  await p.nodes.get('#tag-dialog').emit('close');
  assert.equal(p.run('document.activeElement === $("#tag-selection")'),true);assert.equal(p.run('window.scrollY'),350);
});

test("new tag returns to the complete multi-album target and still requires assignment review",async()=>{
  const p=livePage();await settle();const fixture=selectedTagFixture(),posts=[];
  p.run('state.screen="albums";state.selected=new Set(["1","3"]);render()');
  const newTag={id:'40',name:'New; label',archived:false,tracks:0,total_tracks:0,before:'new-before'};
  p.setFetch((url,options)=>{
    if(url.startsWith('/api/tags/selection?'))return {ok:true,json:async()=>fixture.selection};
    if(url.startsWith('/api/tags?'))return {ok:true,json:async()=>({tags:[...fixture.rows,newTag],total:4,offset:0})};
    if(url==='/api/tags/save'){posts.push(JSON.parse(options.body));return {ok:true,json:async()=>({job:'create-tag',sent:1})};}
    return {ok:true,json:async()=>({state:'done',results:[{id:'40',status:'saved'}]})};
  });
  await p.run('openSelectedAlbumTags()');await p.click({'#tag-new':{}});
  p.nodes.get('#tag-name').value='New; label';p.run('reviewTags()');assert.equal(posts.length,0);
  await p.run('saveTags()');assert.equal(posts.length,1);assert.equal(posts[0].action,'create');
  assert.match(p.nodes.get('#tag-dialog-content').innerHTML,/new tag is empty.*Return to selected album tags/);
  assert.doesNotMatch(p.nodes.get('#tag-dialog-content').innerHTML,/\$\{view\.origin/);
  await p.click({'#tag-return':{}});
  assert.deepEqual(p.json('tagDraft.target'),fixture.selection.target);
  assert.equal(p.run('tagDraft.query'),'New; label');assert.equal(posts.length,1);
  await p.change({matches:s=>s==='[data-tag-change]',dataset:{tagChange:'40'},value:'add'});
  p.run('reviewTags()');assert.equal(posts.length,1);
  assert.match(p.nodes.get('#tag-dialog-content').innerHTML,/New; label.*all 17 tracks/);
  assert.deepEqual(p.json('[...state.selected]'),['1','3']);
});

test("multi-album tags require a live idle complete bounded selection before reading",async()=>{
  const p=livePage();await settle();let reads=0;
  p.setFetch(()=>{reads++;return {ok:true,json:async()=>selectedTagFixture().selection};});
  p.run('state.selected=new Set(["1"]);state.mode="demo";render()');
  assert.equal(p.nodes.get('#tag-selection').hidden,true);await p.run('openSelectedAlbumTags()');
  p.run('state.mode="live";saving=true;updateChrome()');assert.equal(p.nodes.get('#tag-selection').disabled,true);
  await p.run('openSelectedAlbumTags()');
  p.run('saving=false;checking=1;updateChrome()');assert.equal(p.nodes.get('#tag-selection').disabled,true);
  await p.run('openSelectedAlbumTags()');
  p.run('checking=0;state.selected.clear();render()');await p.run('openSelectedAlbumTags()');assert.equal(reads,0);
  p.run('useLocal(Array.from({length:21},(_,i)=>({id:String(i+1),name:"Album "+i,artist:"A",disc:1,tracks:[{id:String(i+100),title:"Song",track:1,artist:"A",genres:[]}]})),"demo");state.mode="live";state.selected=new Set(state.albums.map(a=>a.id))');
  await p.run('openSelectedAlbumTags()');assert.equal(reads,0);assert.match(p.nodes.get('#toast').textContent,/20 complete albums/);
});

test("multi-album tags retain every disc and work on an artist page in list layout",async()=>{
  const p=livePage();await settle();let selection;
  p.run('useLocal([{id:"11",name:"Set",artist:"A",year:2000,disc:1,tracks:[{id:"110",title:"One",artist:"A",track:1}]},{id:"12",name:"Set",artist:"A",year:2000,disc:2,tracks:[{id:"120",title:"Two",artist:"A",track:1}]},{id:"13",name:"Other",artist:"A",year:2000,disc:1,tracks:[{id:"130",title:"Three",artist:"A",track:1}]}],"demo");state.mode="live";state.artist="A";state.view="list";state.selected=new Set(["11","13"]);render()');
  const fixture=selectedTagFixture();p.setFetch((url)=>{selection=url;return {ok:true,json:async()=>url.startsWith('/api/tags/selection')?fixture.selection:{tags:[],total:0,offset:0}};});
  await p.run('openSelectedAlbumTags()');assert.equal(selection,undefined);assert.match(p.nodes.get('#toast').textContent,/complete albums/);
  p.run('state.selected.add("12");render()');await p.run('openSelectedAlbumTags()');
  assert.deepEqual(p.json('tagDraft.target'),{albums:['11','12','13'],track:null,multiple:true});
  assert.equal(p.nodes.get('#tag-selection').hidden,false);assert.equal(p.nodes.get('#edit-selection').hidden,false);
});

test("late multi-album tag reads and unconfirmed saves cannot change a newer library or retry",async()=>{
  const p=livePage();await settle();const fixture=selectedTagFixture();let resolve;
  p.run('state.selected=new Set(["1","3"])');p.setFetch(()=>new Promise(done=>{resolve=done;}));
  const opening=p.run('openSelectedAlbumTags()');await settle();p.run('useLocal(demoLibrary(),"demo")');
  resolve({ok:true,json:async()=>fixture.selection});await opening;
  assert.equal(p.nodes.get('#tag-dialog').open,false);assert.equal(p.run('tagDraft.selection'),null);
  p.run('state.mode="live";state.selected=new Set(["1","3"])');
  p.setFetch((url)=>({ok:true,json:async()=>url.startsWith('/api/tags/selection')?fixture.selection:url.startsWith('/api/tags?')?{tags:fixture.rows,total:3,offset:0}:url==='/api/tags/save'?{job:'uncertain-tags',sent:1}:{state:'done',results:[{id:'20',status:'unverified'}]}}));
  await p.run('openSelectedAlbumTags()');await p.change({matches:s=>s==='[data-tag-change]',dataset:{tagChange:'20'},value:'add'});
  p.run('reviewTags()');await p.run('saveTags()');await p.run('saveTags()');
  assert.match(p.nodes.get('#tag-dialog-content').innerHTML,/could not be confirmed/);
  assert.equal(p.requests.filter(r=>r.url==='/api/tags/save').length,1);
});

test("Tags has its own route and contextual help; album tag chips never change genres", async () => {
  const p = livePage(); await settle();
  p.setFetch((url)=>({ok:true,json:async()=>url.includes("key=10") ? {group:{key:"10",label:"Listen later"},album_ids:["1"]}
    : {groups:[{key:"10",label:"Listen later",image:"",tracks:2,albums:1},{key:"20",label:"Empty",image:"",tracks:0,albums:0}],total:2,offset:0}}));
  await p.run('showBrowse("tags")'); await settle();
  assert.equal(p.location.hash, "#/tags");
  assert.match(p.nodes.get("#browse-list").innerHTML, /Listen later.*Empty/);
  assert.equal(p.nodes.get("#browse-tag-actions").hidden, false);
  await p.run('showBrowse("tags", "10", {label:"Listen later"})'); await settle();
  assert.equal(p.location.hash, "#/tags/10");
  assert.equal(p.run("browseAlbums().length"), 1);
  assert.equal(p.nodes.get("#browse-tag-delete").hidden, false);
  assert.match(p.run('JSON.stringify(helpContentFor("browse"))'), /Tags.*labels/);
  assert.match(p.run('albumTagChips({id:"1",tracks:[{tags:[{id:"10",name:"Listen later"}]},{tags:[]}]})'), /data-browse-kind="tags".*1\/2 tracks.*data-album-tags="1"/);
  assert.match(p.run('albumTagChips({id:"1",tags_loaded:false,tracks:[{tags:[]}]})'), /Load and manage.*>\+ Tag/);
  await p.run('openAlbum("1")');
  assert.match(p.nodes.get("#album-page").innerHTML, /class="album-labels".*data-album-tags="1"/);
  assert.doesNotMatch(p.nodes.get("#album-page").innerHTML, /class="album-tags"|No tags assigned|album-tags-shortcut/);
  p.run('state.details.get("1").tracks[0].tags = [{id:"10",name:"Listen later",archived:true}]; renderAlbumView()');
  assert.match(p.nodes.get("#album-page").innerHTML, /class="album-labels".*Listen later.*archived.*data-album-tags="1"/);
  assert.equal(p.run('SIDEBAR_ITEMS.some(i=>i[0]==="show-tags" && !i[2])'), true);
});

test("bulk and single-album suggestions share the same reviewed contract", async () => {
  const p = livePage(); await settle();
  const cases = JSON.parse(readFileSync(path.join(__dirname, "fixtures/duplicate_suggestions.json"), "utf8"));
  for (const example of cases) {
    const tracks = example.tracks.map((t, i) => ({id: String(i + 1), album_id: "1", track: 1,
      title: "Song", artist: "Artist", length: 180, format: "FLAC", uploaded_at: "2022-01-01", ...t}));
    const result = p.json(`(() => {const s = trashSuggestion([{tracks: ${JSON.stringify(tracks)}}]); return {remove: s.remove, choices: [...s.choices.values()], manual: [...s.choices].filter(([, t]) => t.choice === "manual").map(([id]) => id)};})()`);
    assert.deepEqual(result.remove, example.remove, example.name);
    assert.deepEqual(result.manual, example.manual, example.name);
    assert.deepEqual(result.choices, example.choices, example.name);
  }
});

function duplicatePreview() {
  const tracks = [
    {id: "100", title: '<Song "edit">', artist: "Artist", length: 180, format: "FLAC", uploaded_at: "2022-01-01", choice: "trash", status: "pending", reason: "Older upload in this format. Titles differ; compare versions before confirming."},
    {id: "101", title: "Song (Edit)", artist: "Artist", length: 180, format: "FLAC", uploaded_at: "2026-01-01", choice: "keep", status: "retained", reason: "Newest upload in this format."},
  ];
  return {id: "draft", state: "preview", error: "", excluded: [], scanned: 573, tracks: 1, manual: 3,
    albums: 1, offset: 0, counts: {pending: 1}, batch_tracks: 200, batch_albums: 20,
    groups: [{id: "1", album: "Album", artist: "Artist", positions: [{disc: 1, number: 1, tracks}]}],
    selection: [{id: "100", group: "1"}]};
}

test("cleanup filters and a manual album selection hide random playback; card play stays explicit", async () => {
  const p = livePage(); await settle();
  for (const filter of ["genre", "year", "duplicates", "small", "combined", "cover", "edition"]) {
    p.nodes.get("#filter").value = filter; p.run("render()");
    assert.equal(p.nodes.get("#albums-random").hidden, true, filter);
  }
  p.nodes.get("#filter").value = "all"; p.run("render()");
  assert.equal(p.nodes.get("#albums-random").hidden, false);
  p.run('state.selected.add("1"); render()');
  assert.equal(p.nodes.get("#albums-random").hidden, true);
  const count = p.requests.length;
  await p.nodes.get("#albums-random").emit("click");
  assert.equal(p.requests.length, count);
  p.run('state.selected.clear(); render()');
  const source = p.location.hash, entries = p.history.length;
  await p.click({"[data-card-play]": {dataset: {cardPlay: "1"}}});
  assert.equal(p.run("String(player.album.id)"), "1");
  assert.equal(p.run("player.index"), 0);
  assert.equal(p.run("player.queue.length"), 5);
  assert.equal(p.location.hash, source); assert.equal(p.history.length, entries);
  assert.match(p.run('gridView(albumShelf())'), /album-card-actions.*data-card-play=/);
  assert.match(p.run('listView(albumShelf())'), /data-card-play=/);
  assert.match(p.run('browseAlbumCard(albumShelf()[0])'), /data-card-play=/);
});

test("direct album play loads only its discs and clearing the queue cancels a late response", async () => {
  const p = livePage(); await settle();
  const album = p.json('state.details.get("1")'); p.run('state.details.delete("1")');
  let resolve;
  const reads = [];
  p.setFetch((url) => { reads.push(url); return new Promise(done => { resolve = done; }); });
  const pending = p.run('playCardAlbum("1")'); await settle();
  assert.deepEqual(reads, ["/api/albums?ids=1"]);
  p.run("stopPlayer()"); resolve({ok:true, json:async()=>({albums:[album]})}); await pending;
  assert.equal(p.run("player.queue.length"), 0);
  assert.equal(p.nodes.get("#audio").src, undefined);
});

test("filtered album overview selects across artists and pages, reviewing only explicit selections", async () => {
  const p = livePage(); await settle();
  p.run(`useLocal(Array.from({length:26},(_,i)=>({id:String(i+1),name:"Album "+i,artist:"Artist "+i,year:1985+i,disc:1,
    tracks:Array.from({length:i===25?3:2},(_,n)=>({id:String(i*10+n+100),title:"Song "+n,artist:"Artist "+i,track:n+1,genres:["Rock"]}))})),"live");
    state.artist=null; state.selected.clear(); state.screen="albums"; $("#filter").value="small"; $("#sort").value="year"; render()`);
  assert.equal(p.run("filteredAlbums().length"), 25);
  assert.match(p.nodes.get("#albums").innerHTML, /data-select="1"/);
  assert.doesNotMatch(p.nodes.get("#albums").innerHTML, /data-select="25"|data-select="26"/);
  await p.change({matches:s=>s==="[data-select]",checked:true,dataset:{select:"1"}});
  p.run('state.page=1; render()');
  assert.match(p.nodes.get("#albums").innerHTML, /data-select="25"/);
  await p.change({matches:s=>s==="[data-select]",checked:true,dataset:{select:"25"}});
  assert.deepEqual(p.json("[...state.selected]"), ["1","25"]);
  assert.equal(p.nodes.get("#selection-count").textContent, "2 albums selected");
  assert.equal(p.nodes.get("#trash-selection").disabled, false);
  assert.equal(p.nodes.get("#edit-selection").hidden, true);
  assert.match(p.run("listView(filteredAlbums())"), /col-check.*data-select="1"/);
  const reads = p.requests.length;
  await p.run('openEditor([...state.selected])');
  assert.equal(p.nodes.get("#editor").open, undefined);
  assert.equal(p.requests.length, reads, "Mixed-artist metadata editing remains blocked");
  p.nodes.get("#filter").value="genre"; p.run("render()");
  assert.match(p.nodes.get("#selection-count").textContent, /2 outside current results/);
  await p.run("reviewSelectedAlbumTrash()");
  assert.deepEqual(p.json("selectedAlbumsTrash.groups.map(g=>g.id)"), ["1","25"]);
  assert.deepEqual(p.json("selectedAlbumsTrash.groups.map(g=>g.artist)"), ["Artist 0","Artist 24"]);
  assert.match(p.nodes.get("#trash-content").innerHTML, /2 albums · 4 tracks/);
  assert.equal(p.requests.length, reads, "Only the chosen cached albums are reviewed; nothing is sent");
  await p.nodes.get("#clear-selection").emit("click");
  assert.equal(p.run("state.selected.size"), 0);
  p.run('state.mode="demo"; render()');
  assert.doesNotMatch(p.run("gridView(albumShelf())"), /data-select=/);
  assert.doesNotMatch(p.run("listView(albumShelf())"), /col-check/);
  assert.equal(p.nodes.get("#trash-selection").hidden, true);
});

test("selected album trash reviews complete tracks, checks read-back and preserves unrelated playback", async () => {
  const p = livePage(); await settle();
  p.run('state.artist="Pink Floyd"; state.selected=new Set(["1","2"]); playTracks(state.details.get("3")); render()');
  const audio = p.nodes.get("#audio").src, queue = p.json("player.queue");
  const albumsAfter = p.json('state.albums.filter(a=>!["1","2"].includes(a.id))');
  const rows = p.json('[...state.details.get("1").tracks,...state.details.get("2").tracks].map(t=>({kind:"track",id:t.id,label:t.title,status:"saved",fields:["trash"]}))');
  const calls = [];
  p.setFetch(async (url, options) => {
    calls.push({url,body:options.body ? JSON.parse(options.body) : null});
    return {ok:true,json:async()=>url === "/api/trash/albums" ? {job:"trash-albums",results:rows.map(t=>({...t,status:"sent"}))}
      : {state:"done",results:rows,albums:albumsAfter}};
  });
  await p.run("reviewSelectedAlbumTrash()");
  assert.equal(p.run('document.activeElement === $("#selected-trash-cancel")'), true);
  assert.equal(calls.length, 0);
  assert.match(p.nodes.get("#trash-content").innerHTML, /2 albums · 15 tracks/);
  assert.match(p.nodes.get("#trash-content").innerHTML, /Wish You Were Here/);
  const pending = p.run("trashSelectedAlbums()"); await settle(); p.flushTimers(2000); await pending;
  assert.deepEqual(calls.map(c=>c.url), ["/api/trash/albums","/api/jobs/trash-albums"]);
  assert.equal(calls[0].body.approved, true);
  assert.equal(calls[0].body.albums.flatMap(a=>a.tracks).length, 15);
  assert.equal(p.run("state.selected.size"), 0);
  assert.equal(p.run("state.history[0].status"), "saved");
  assert.equal(p.run("state.history[0].trash"), true);
  assert.match(p.nodes.get("#selected-trash-status").textContent, /All selected albums confirmed/);
  assert.equal(p.nodes.get("#audio").src, audio); assert.deepEqual(p.json("player.queue"), queue);
});

test("selected album batches bound complete sets without splitting a reviewed album", async () => {
  const p = livePage(); await settle();
  const sizes = p.json('selectedAlbumTrashBatches(Array.from({length:21},(_,i)=>({id:i,discs:[{tracks:Array(30).fill({id:i})}]}))).map(batch=>batch.length)');
  assert.deepEqual(sizes, [16,5]);
  const albums = p.json('selectedAlbumTrashBatches(Array.from({length:21},(_,i)=>({id:i,discs:[{tracks:[{id:i}]}]}))).map(batch=>batch.length)');
  assert.deepEqual(albums, [20,1]);
  assert.throws(()=>p.run('selectedAlbumTrashBatches([{discs:[{tracks:Array(501).fill({id:1})}]}])'), /more than 500 tracks/);
});

test("selected album trash stops after unconfirmed results and rejects late replies after library replacement", async () => {
  const p = livePage(); await settle();
  p.run('useLocal(Array.from({length:21},(_,i)=>({id:String(i+1),name:"Album "+i,artist:"A",year:1985,disc:1,tracks:[{id:String(i+100),title:"Song",artist:"A",track:1,genres:["Rock"]}]})),"demo"); state.mode="live"; state.artist="A"; state.selected=new Set(state.albums.map(a=>a.id))');
  p.run("const selectedTrashFixture = [...state.details.values()].map(d=>structuredClone(d))");
  await p.run("reviewSelectedAlbumTrash()");
  const calls = [];
  p.setFetch(async (url, options) => {
    calls.push(url);
    return {ok:true,json:async()=> options.body ? {job:"partial",results:[]}
      : {state:"done",albums:p.json("state.albums"),results:p.json('selectedAlbumsTrash.groups.slice(0,20).flatMap(g=>g.discs.flatMap(d=>d.tracks.map(t=>({kind:"track",id:t.id,label:t.title,fields:["trash"],status:"unverified"}))))')}};
  });
  const pending = p.run("trashSelectedAlbums()"); await settle(); p.flushTimers(2000); await pending;
  assert.deepEqual(calls, ["/api/trash/albums","/api/jobs/partial"]);
  assert.match(p.nodes.get("#selected-trash-status").textContent, /could not be fully confirmed/);
  assert.equal(p.run("state.selected.size"), 21);
  p.run('$("#trash-review").close(); $("#results").close(); state.details = new Map(selectedTrashFixture.map(d=>[String(d.id),d]))');
  await p.run("reviewSelectedAlbumTrash()");
  let resolve;
  p.setFetch(()=>new Promise(done=>{resolve=done;}));
  const late = p.run("trashSelectedAlbums()"); await settle();
  p.run('useLocal(demoLibrary(), "demo")');
  resolve({ok:true,json:async()=>({job:"old",results:[]})}); await late;
  assert.equal(p.run("selectedAlbumsTrash.groups"), null);
  assert.equal(p.run("saving"), false);
  assert.equal(p.nodes.get("#trash-review").open, false);
});

test("bulk duplicate cleanup opens read-only, analyses explicitly and requires adjustable review", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); $("#filter").value = "duplicates"; render()');
  assert.equal(p.nodes.get("#duplicate-cleanup-open").hidden, false);
  const source = p.nodes.get("#audio").src, queue = p.json("player.queue"), entries = p.history.length;
  const data = duplicatePreview(), calls = [];
  p.setFetch(async (url, options) => {
    calls.push({url, body: options.body ? JSON.parse(options.body) : null});
    return {ok: true, json: async () => url === "/api/duplicate-cleanup/preview" ? data
      : url === "/api/duplicate-cleanup/start" ? {...data, state: "running"} : {state: "empty"}};
  });
  await p.nodes.get("#duplicate-cleanup-open").emit("click");
  assert.deepEqual(calls.map(c => c.url), ["/api/duplicate-cleanup?offset=0&limit=10"]);
  await p.run('duplicateCleanupAction("preview")');
  assert.match(p.nodes.get("#duplicate-cleanup-content").innerHTML, /573 duplicate albums/);
  assert.match(p.nodes.get("#duplicate-cleanup-content").innerHTML, /&lt;Song &quot;edit&quot;&gt;/);
  assert.match(p.nodes.get("#duplicate-cleanup-content").innerHTML, /Titles differ/);
  assert.equal(p.nodes.get("#duplicate-cleanup-start").disabled, true);
  await p.run('duplicateCleanupAction("start")');
  assert.equal(calls.length, 2);
  await p.nodes.get("#duplicate-cleanup").emit("change", {target: {dataset: {duplicateCopy: "100"}, checked: false}});
  assert.deepEqual(p.json("[...duplicateCleanupView.excluded]"), ["100"]);
  assert.match(p.nodes.get("#duplicate-cleanup-selected").textContent, /0 copies/);
  await p.nodes.get("#duplicate-cleanup").emit("change", {target: {dataset: {duplicateAlbum: "1"}, checked: true}});
  await p.nodes.get("#duplicate-cleanup").emit("change", {target: {id: "duplicate-cleanup-approved", checked: true}});
  assert.equal(p.nodes.get("#duplicate-cleanup-start").disabled, false);
  await p.run('duplicateCleanupAction("start")');
  assert.deepEqual(calls.at(-1), {url: "/api/duplicate-cleanup/start", body: {id: "draft", excluded: [], approved: true}});
  assert.equal(p.nodes.get("#audio").src, source);
  assert.deepEqual(p.json("player.queue"), queue);
  assert.equal(p.history.length, entries);
  assert.equal(p.run('currentHelpContext()'), "duplicate-cleanup");
  p.run('$("#filter").value = "all"; render()');
  assert.equal(p.nodes.get("#duplicate-cleanup-open").hidden, true);
});

test("bulk selection changes revoke approval and late results cannot cross library replacements", async () => {
  const p = livePage(); await settle();
  const data = duplicatePreview();
  p.run(`duplicateCleanupView.data = ${JSON.stringify(data)}; duplicateCleanupView.approved = true; renderDuplicateCleanup()`);
  await p.nodes.get("#duplicate-cleanup").emit("change", {target: {dataset: {duplicateCopy: "100"}, checked: false}});
  assert.equal(p.run("duplicateCleanupView.approved"), false);
  assert.equal(p.nodes.get("#duplicate-cleanup-start").disabled, true);
  let resolve;
  p.setFetch(() => new Promise(done => { resolve = done; }));
  const pending = p.run("fetchDuplicateCleanup()"); await settle();
  p.run('useLocal(demoLibrary(), "demo")');
  resolve({ok: true, json: async () => data}); await pending;
  assert.equal(p.run("duplicateCleanupView.data"), null);
  assert.equal(p.run("duplicateCleanupView.busy"), false);
  assert.equal(p.run('$("#duplicate-cleanup").open'), undefined);
});

test('Help starts only on request; completing every topic preserves playback and history', async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"))');
  const queue = p.json('player.queue'), audio = p.nodes.get('#audio');
  const source = audio.src, hash = p.location.hash, entries = p.history.length;
  const requests = p.requests.length;
  assert.equal(!!p.nodes.get('#help-dialog')?.open, false);
  p.run('$("#help-button").focus()');
  await p.click({'#help-button': {}});
  assert.equal(p.nodes.get('#help-dialog').open, true);
  assert.equal(p.run('helpTour.topic'), 'artists');
  assert.doesNotMatch(p.json('helpTour.content').steps.flat().join(' '), /1001|playlist|Analyse/);
  await p.click({'#help-close': {}});
  for (const topic of p.json('Object.keys(HELP_TOPICS)')) {
    p.run(`openHelp(${JSON.stringify(topic)})`);
    assert.equal(p.nodes.get('#help-dialog').open, true);
    for (let i = 0; i < p.run(`HELP_TOPICS[${JSON.stringify(topic)}].steps.length`); i++) {
      assert.equal(p.run('helpTour.index'), i);
      await p.click({'#help-next': {}});
    }
    assert.equal(p.nodes.get('#help-dialog').open, false);
  }
  assert.equal(audio.src, source);
  assert.equal(audio.paused, false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.location.hash, hash);
  assert.equal(p.history.length, entries);
  assert.equal(p.requests.length, requests, 'Tours do not fetch, analyse, change settings or write');
});

test('Help above an editor preserves the draft and returns focus on Escape', async () => {
  const p = page(); await settle();
  await p.run('openEditor([state.albums[0].id])');
  p.run('editing.trackPatches[String(editing.originals[0].tracks[0].id)] = {title: "My unsaved title"}; $("#review-button").focus(); openHelp("editing")');
  const draft = p.json('editing'), requests = p.requests.length;
  await p.click({'#help-next': {}});
  assert.match(p.nodes.get('#help-hint').textContent, /album editor/);
  await p.click({'#help-prev': {}});
  assert.equal(p.run('helpTour.index'), 0);
  await p.emitDocument('keydown', {key: 'Escape', preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}});
  assert.equal(p.nodes.get('#help-dialog').open, false);
  assert.equal(p.nodes.get('#editor').open, true);
  assert.equal(p.run('document.activeElement === $("#review-button")'), true);
  assert.deepEqual(p.json('editing'), draft);
  assert.equal(p.requests.length, requests);
});

test('Help closes on navigation and library replacement without enabling optional features', async () => {
  const p = page(); await settle();
  p.run('openHelp("guide"); showScreen("albums")');
  assert.equal(p.nodes.get('#help-dialog').open, false);
  assert.equal(p.run('albumGuide.enabled'), false);
  p.run('openHelp("artists"); useLocal([...state.details.values()], "demo")');
  assert.equal(p.nodes.get('#help-dialog').open, false);
  assert.equal(p.run('albumGuide.enabled'), false);
  assert.equal(p.requests.filter(r => r.options?.method === 'POST').length, 0);
});

test('the question mark selects only the current page or dialog help', async () => {
  const p = page(); await settle();
  const requests = p.requests.length;
  for (const [screen, context] of [['artists', 'artists'], ['albums', 'albums'], ['album', 'album'],
    ['tracks', 'tracks'], ['favourites', 'favourites'], ['album-favourites', 'album-favourites'], ['artist-favourites', 'artist-favourites'],
    ['playlists', 'playlists'], ['recently-played', 'recently-played'], ['overview', 'overview'],
    ['album-guide', 'guide'], ['browse', 'browse']]) {
    p.run(`state.screen = ${JSON.stringify(screen)}`);
    await p.click({'#help-button': {}});
    assert.equal(p.run('helpTour.topic'), context);
    if (screen !== 'album-guide') assert.doesNotMatch(p.json('helpTour.content').steps.flat().join(' '), /1001/);
    await p.click({'#help-close': {}});
  }
  p.run('state.screen = "playlists"; collectionsView.playlist = "25"; openHelp()');
  assert.equal(p.run('helpTour.topic'), 'playlist');
  p.run('closeHelp(); collectionsView.data={is_folder:true}; openHelp()');
  assert.equal(p.run('helpTour.topic'), 'playlist-folder');
  p.run('closeHelp(); $("#playlist-dialog").showModal(); openHelp()');
  assert.equal(p.run('helpTour.topic'), 'playlist-review');
  p.run('closeHelp(); $("#playlist-dialog").close(); art.target={target:"playlist"}; $("#artwork").showModal(); openHelp()');
  assert.equal(p.run('helpTour.topic'), 'playlist-cover');
  p.run('closeHelp(); $("#artwork").close(); $("#editor").showModal(); openHelp()');
  assert.equal(p.run('helpTour.topic'), 'editing');
  p.run('closeHelp(); $("#review").showModal(); openHelp()');
  assert.equal(p.run('helpTour.topic'), 'review');
  p.run('closeHelp(); $("#review").close(); $("#settings").showModal(); openHelp()');
  assert.equal(p.run('helpTour.topic'), 'settings');
  p.run('closeHelp(); $("#settings").close(); $("#editor").close(); $("#guide-link-dialog").showModal(); openHelp()');
  assert.equal(p.run('helpTour.topic'), 'guide-link');
  assert.equal(p.requests.length, requests);
  const html = readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  assert.match(html, /id="help-button"[^>]*aria-label="Help for this page"[^>]*>\?<\/button>/);
  assert.doesNotMatch(html, /help-topics|help-topic-list|help-all|>\? Help</);
});

test('Help positioning keeps the card inside small and large viewports', () => {
  const p = page();
  for (const [width, height] of [[390, 700], [1265, 900]]) {
    const card = {width: Math.min(410, width - 24), height: 330};
    for (const rect of [null, {left: 10, right: width - 10, top: 10, bottom: 55},
      {left: 10, right: 220, top: height - 70, bottom: height - 10}]) {
      const pos = p.json(`helpCardPosition(${JSON.stringify(rect)}, ${JSON.stringify(card)}, ${width}, ${height})`);
      assert.ok(pos.left >= 12 && pos.top >= 12);
      assert.ok(pos.left + card.width <= width - 12);
      assert.ok(pos.top + card.height <= height - 12);
    }
  }
});

test('Help keeps forward and reverse Tab focus inside its visible controls', async () => {
  const p = page(); await settle();
  p.run(`openHelp("artists");
    const helpControls = [$("#help-close"), $("#help-next")];
    for (const node of helpControls) node.getClientRects = () => [{}];
    document.querySelectorAll = selector => selector === "#help-card button:not([disabled])" ? helpControls : [];
    $("#help-next").focus()`);
  let prevented = false;
  const event = {key: 'Tab', preventDefault() { prevented = true; }};
  await p.emitDocument('keydown', event);
  assert.equal(prevented, true);
  assert.equal(p.run('document.activeElement === $("#help-close")'), true);
  await p.emitDocument('keydown', {...event, shiftKey: true});
  assert.equal(p.run('document.activeElement === $("#help-next")'), true);
});

function guideReport(p) {
  return {enabled: true, state: 'ready', revision: 'reference-v1', lastmodified: 'library-v1',
    total: 1001, counts: {found: 1, possible: 1, missing: 999},
    entries: [
      {id: 1, album: 'Reference title', artist: 'Reference artist', year: 1980, status: 'found', album_ids: [p.run('state.albums[0].id')]},
      {id: 2, album: 'Maybe <script>', artist: 'Another artist', year: 1990, status: 'possible', album_ids: [p.run('state.albums[1].id')]},
      {id: 3, album: 'Missing album', artist: 'Absent artist', year: 2000, status: 'missing', album_ids: []},
    ]};
}

test('1001 Albums is off by default; enabling only shows navigation, analysis is explicit', async () => {
  const p = livePage(); await settle();
  assert.equal(p.nodes.get('#show-album-guide').hidden, true);
  p.run('lookup.sources = [{name:"musicbrainz",label:"MusicBrainz",enabled:true}]; openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML, /name="album_guide" > Enable 1001 Albums/);
  p.setFetch((url, options) => {
    if (url === '/api/settings') {
      assert.equal(JSON.parse(options.body).album_guide, true);
      return {ok: true, json: async () => ({sources: [], album_guide: true, auto_lookup: false})};
    }
    assert.equal(url, '/api/album-guide');
    assert.equal(options?.method || 'GET', 'GET');
    return {ok: true, json: async () => ({enabled: true, state: 'empty'})};
  });
  await p.run('saveSettings({elements:{auto_lookup:{checked:false},auto_updates:{checked:false},album_guide:{checked:true}},querySelectorAll:()=>[]})');
  assert.equal(p.nodes.get('#show-album-guide').hidden, false);
  assert.equal(p.requests.filter(r => r.url.startsWith('/api/album-guide')).length, 0);
  p.run('showAlbumGuide()'); await settle();
  assert.equal(p.location.hash, '#/album-guide');
  assert.match(p.nodes.get('#guide-note').textContent, /only when you press/);
  assert.equal(p.requests.filter(r => r.url.endsWith('/analyse')).length, 0);
  const report = guideReport(p);
  p.setFetch((url, options) => {
    assert.equal(url, '/api/album-guide/analyse');
    assert.equal(options.method, 'POST');
    return {ok: true, json: async () => report};
  });
  await p.nodes.get('#guide-analyse').emit('click'); await settle();
  assert.match(p.nodes.get('#guide-results').textContent, /1 of 1,001 albums found/);
  assert.match(p.nodes.get('#guide-list').innerHTML, /Reference title/);
  assert.doesNotMatch(p.nodes.get('#guide-list').innerHTML, /Missing album|Maybe/);
});

test('guide results filter locally, escape text and preserve search on Back without disturbing audio', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p);
  p.setFetch(url => { assert.equal(url, '/api/album-guide'); return {ok: true, json: async () => report}; });
  p.run('applyAlbumGuideSettings({album_guide:true}); playTracks(state.details.get(state.albums[0].id)); showAlbumGuide()'); await settle();
  const queue = p.json('player.queue'), src = p.nodes.get('#audio').src;
  p.nodes.get('#guide-filter').value = 'possible'; await p.nodes.get('#guide-filter').emit('change');
  assert.match(p.nodes.get('#guide-list').innerHTML, /Possible match|Maybe &lt;script&gt;/);
  assert.doesNotMatch(p.nodes.get('#guide-list').innerHTML, /<script>|data-queue-album/);
  p.nodes.get('#guide-search').value = 'Maybe'; await p.nodes.get('#guide-search').emit('input');
  const before = p.requests.length;
  p.run('showScreen("albums"); render()');
  p.history.back(); await settle();
  assert.equal(p.location.hash, '#/album-guide');
  assert.equal(p.nodes.get('#guide-search').value, 'Maybe');
  assert.equal(p.nodes.get('#guide-filter').value, 'possible');
  assert.equal(p.requests.length, before);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, src);
  p.run('applyAlbumGuideSettings({album_guide:false})');
  assert.equal(p.nodes.get('#show-album-guide').hidden, true);
  assert.equal(p.run('state.screen'), 'artists');
  assert.equal(p.run('albumGuide.data'), null);
});

test('album background uses bundled French notes for visited-album matches with discovery disabled, escapes text and keeps playback', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p), ref = report.entries[0];
  p.setAlbumNotesFetch(() => ({ok:true,json:async()=>({entries:[ref]})}));
  p.run('playTracks(state.details.get("1"))');
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  p.setNotesFetch(() => ({ok: true, json: async () => ({schema: 1, entries: [
    {id: ref.id, album: ref.album, artist: ref.artist, text: '<script>alert(1)</script> & an album.',
      context: '<b>Reviewed title variant</b>',
      source_url: 'https://fr.wikipedia.org/wiki/An_Album'},
    {id: 50, album: 'Bad link', artist: 'Other', text: 'Unsafe', source_url: 'javascript:alert(1)'}]})}));
  await p.run('openAlbum("1")'); await settle();
  const panel = p.nodes.get('#album-guide-notes');
  assert.match(panel.innerHTML, /About this album|&lt;script&gt;alert/);
  assert.match(panel.innerHTML, /Wikipedia contributors|CC BY-SA/);
  assert.match(panel.innerHTML, /https:\/\/fr\.wikipedia\.org\/wiki\/An_Album/);
  assert.doesNotMatch(panel.innerHTML, /<script>|javascript:/);
  assert.match(panel.innerHTML, /&lt;b&gt;Reviewed title variant&lt;\/b&gt;/);
  assert.equal(panel.hidden, false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.requests.filter(r => r.url === '/1001-album-notes.json').length, 1);
  assert.ok(p.requests.every(r => !/^https?:/.test(r.url)), 'Reading notes makes no external request');
  p.run('guideNoteAlbumEntry().entries = []; renderGuideAlbumNotes()');
  assert.equal(panel.hidden, true, 'Unconfirmed candidates never receive album text');
  p.run(`guideNoteAlbumEntry().entries = [${JSON.stringify(ref)}]; renderGuideAlbumNotes()`);
  assert.equal(panel.hidden, false);
  p.run('applyAlbumGuideSettings({album_guide:false})');
  assert.equal(panel.hidden, false, "Disabling discovery preserves album background text");
});

test('album note sources allow English and French Wikipedia without accepting lookalikes or credentials', async () => {
  const p = page(); await settle();
  const sources = ['https://en.wikipedia.org/wiki/Album', 'https://fr.wikipedia.org/wiki/Lam_Toro',
    'https://fr.wikipedia.org.evil.test/wiki/Album', 'https://user@fr.wikipedia.org/wiki/Album',
    'https://fr.wikipedia.org:8080/wiki/Album', 'http://fr.wikipedia.org/wiki/Album',
    'https://fr.wikipedia.org/wiki/Album#Other', 'https://fr.wikipedia.org/wiki/Album?other=1',
    'https://de.wikipedia.org/wiki/Album'];
  const data = {schema: 1, entries: sources.map((source_url, i) => ({id: i + 1, album: 'Album',
    artist: 'Artist', text: 'Reviewed adaptation.', source_url}))};
  assert.deepEqual(p.json(`Array.from(readGuideNotes(${JSON.stringify(data)}).keys())`), [1, 2]);
});

test('late album notes never repaint another page and opening an album never analyses the guide', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p), ref = report.entries[0];
  p.setAlbumNotesFetch(() => ({ok:true,json:async()=>({entries:[ref]})}));
  let release;
  p.setNotesFetch(() => new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({schema: 1,
    entries: [{...ref, text: 'Local background', source_url: 'https://en.wikipedia.org/wiki/Album'}]})}); }));
  p.run('applyAlbumGuideSettings({album_guide:true})');
  await p.run('openAlbum("1")'); await settle();
  assert.equal(p.requests.filter(r => r.url.startsWith('/api/album-guide/album?')).length, 1);
  assert.equal(p.requests.filter(r => r.url === '/api/album-guide').length, 0);
  assert.equal(typeof release, 'function');
  p.run('showScreen("albums"); $("#album-guide-notes").innerHTML = "unchanged"');
  release(); await settle();
  assert.equal(p.nodes.get('#album-guide-notes').innerHTML, 'unchanged');
  assert.equal(p.requests.filter(r => r.url.endsWith('/analyse') || r.options?.method === 'POST').length, 0);
});

test('guide matching display is remembered across browsers without changing links, filters or playback', async () => {
  const storage = {}, p = page({storage}); await settle();
  const report = guideReport(p);
  Object.assign(report.entries[0], {manual: true, manual_ids: ['1']});
  p.setFetch((url, options) => {
    if (url === '/api/settings') return {ok: true, json: async () => JSON.parse(options.body)};
    assert.equal(url, '/api/album-guide'); return {ok: true, json: async () => report};
  });
  p.run('state.mode = "live"; applyAlbumGuideSettings({album_guide:true}); playTracks(state.details.get("1")); showAlbumGuide()');
  await settle();
  const data = p.json('albumGuide.data'), queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  const count = p.requests.length;
  p.nodes.get('#guide-show-matching').checked = false;
  await p.nodes.get('#guide-show-matching').emit('change');
  assert.equal(p.nodes.get('#album-guide-page').classList.contains('guide-hide-matching'), true);
  assert.equal(storage['tagcast-guide-matching-details'], 'hidden');
  assert.deepEqual(p.json('albumGuide.data'), data);
  assert.equal(p.run('albumGuide.filter'), 'found');
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.requests.length, count + 1);
  assert.deepEqual(JSON.parse(p.requests.at(-1).options.body), {guide_matching_details: false});
  const restored = page({storage}); await settle();
  assert.equal(restored.run('guideDisplay.matching'), false);
  const newPort = page(); await settle(); // A new origin has no localStorage preference.
  newPort.run('applyAlbumGuideSettings({album_guide:true, guide_matching_details:false})');
  assert.equal(newPort.nodes.get('#guide-show-matching').checked, false);
  assert.equal(newPort.nodes.get('#album-guide-page').classList.contains('guide-hide-matching'), true);
  p.nodes.get('#guide-show-matching').checked = true;
  await p.nodes.get('#guide-show-matching').emit('change');
  assert.equal(p.nodes.get('#album-guide-page').classList.contains('guide-hide-matching'), false);
  assert.match(p.nodes.get('#guide-list').innerHTML, /Linked by you|data-guide-unlink/);
  assert.equal(p.requests.length, count + 2);
  assert.deepEqual(JSON.parse(p.requests.at(-1).options.body), {guide_matching_details: true});
  assert.equal(p.requests.filter(r => r.url.includes('/analyse') || r.url.includes('/link')).length, 0);
});

test('rapid matching-detail choices save in order and late settings cannot undo the final choice', async () => {
  const p = page(); await settle();
  const saves = []; let release;
  p.setFetch((url, options) => {
    assert.equal(url, '/api/settings');
    const value = JSON.parse(options.body).guide_matching_details;
    saves.push(value);
    return new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({guide_matching_details: value})}); });
  });
  p.nodes.get('#guide-show-matching').checked = false;
  const first = p.nodes.get('#guide-show-matching').emit('change'); await settle();
  p.nodes.get('#guide-show-matching').checked = true;
  const last = p.nodes.get('#guide-show-matching').emit('change'); await settle();
  assert.deepEqual(saves, [false]);
  p.run('applyAlbumGuideSettings({album_guide:true, guide_matching_details:false})');
  assert.equal(p.nodes.get('#guide-show-matching').checked, true);
  release(); await first; await settle();
  assert.deepEqual(saves, [false, true]);
  release(); await last;
  assert.equal(p.run('guideDisplay.matching'), true);
  p.setFetch(() => { throw Error('Server unavailable'); });
  p.nodes.get('#guide-show-matching').checked = false;
  await p.nodes.get('#guide-show-matching').emit('change');
  assert.equal(p.nodes.get('#guide-show-matching').checked, false);
  assert.match(p.nodes.get('#toast').textContent, /could not remember.*Server unavailable/);
});

test('guide suppresses disabled or replaced-library responses and explains stale results without rescanning', async () => {
  const p = livePage(); await settle();
  p.run('applyAlbumGuideSettings({album_guide:true})');
  p.setFetch(() => ({ok: true, json: async () => ({enabled: true, state: 'stale', total: 1001})}));
  p.run('showAlbumGuide()'); await settle();
  assert.match(p.nodes.get('#guide-note').textContent, /changed.*Analyse again/);
  assert.equal(p.requests.filter(r => r.url.endsWith('/analyse')).length, 0);
  let release;
  const report = guideReport(p);
  p.setFetch(() => new Promise(resolve => { release = () => resolve({ok: true, json: async () => report}); }));
  const pending = p.run('loadAlbumGuide(true)');
  p.run('applyAlbumGuideSettings({album_guide:false})'); release(); await pending;
  assert.equal(p.run('albumGuide.data'), null);
  assert.equal(p.nodes.get('#show-album-guide').hidden, true);
  p.run('applyAlbumGuideSettings({album_guide:true}); albumGuide.details = state.details');
  const next = p.run('loadAlbumGuide(true)');
  p.run('useLocal(demoLibrary(), "demo")'); release(); await next;
  assert.equal(p.run('albumGuide.data'), null);
  assert.equal(p.run('albumGuide.loading'), false);
  assert.equal(p.requests.filter(r => r.url.startsWith('/api/albums')).length, 0);
});

test('guide merges matching discs into one edition and paginates list entries rather than editions', async () => {
  const p = livePage(); await settle();
  p.run(`const one = state.albums[0]; state.albums = [
    {...one, id:"1", disc:1, year:1980, upload_dates:["2020-01-01"]},
    {...one, id:"2", disc:2, year:1980, upload_dates:["2020-01-01"]},
    {...one, id:"3", disc:1, year:2020, upload_dates:["2021-01-01"]}];
    applyAlbumGuideSettings({album_guide:true})`);
  const report = {enabled:true, state:'ready', total:25, counts:{found:25,possible:0,missing:0},
    entries: Array.from({length:25}, (_,i) => ({id:i+1, album:'Reference '+i, artist:'Artist', year:1980, status:'found', album_ids:['1','2','3']}))};
  p.setFetch(() => ({ok: true, json: async () => report}));
  p.run('showAlbumGuide()'); await settle();
  assert.equal((p.nodes.get('#guide-list').innerHTML.match(/class="album-card guide-card"/g)||[]).length,24);
  assert.match(p.nodes.get('#guide-list').innerHTML, /Edition 2 \(2020\)/);
  assert.doesNotMatch(p.nodes.get('#guide-list').innerHTML, /Edition 3/);
  assert.match(p.nodes.get('#guide-pagination').innerHTML, /Page 1 of 2/);
});

test('guide confirms candidates, searches summaries locally, and undoes links without changing playback', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p);
  p.setFetch((url, options) => {
    if (url === '/api/album-guide') return {ok: true, json: async () => report};
    assert.equal(url, '/api/album-guide/link');
    const body = JSON.parse(options.body), entry = report.entries.find(e => e.id === body.entry_id);
    assert.deepEqual(body.before, entry.manual_ids || []);
    assert.equal(body.revision, 'reference-v1'); assert.equal(body.lastmodified, 'library-v1');
    entry.manual = body.album_ids.length > 0; entry.manual_ids = body.album_ids;
    entry.album_ids = body.album_ids.length ? body.album_ids : [p.run('state.albums[1].id')];
    entry.status = body.album_ids.length ? 'found' : 'possible';
    report.counts = {found: entry.manual ? 2 : 1, possible: entry.manual ? 0 : 1, missing: 999};
    return {ok: true, json: async () => report};
  });
  p.run('applyAlbumGuideSettings({album_guide:true}); playTracks(state.details.get(state.albums[0].id)); showAlbumGuide()'); await settle();
  const queue = p.json('player.queue'), src = p.nodes.get('#audio').src, history = p.history.length;
  p.nodes.get('#guide-filter').value = 'possible'; await p.nodes.get('#guide-filter').emit('change');
  assert.match(p.nodes.get('#guide-list').innerHTML, /Confirm match…/);
  await p.click({'[data-guide-link]': {dataset: {guideLink: '2'}}});
  assert.equal(p.nodes.get('#guide-link-dialog').open, true);
  assert.equal(p.nodes.get('#guide-link-reference').textContent, 'Another artist · Maybe <script> (1990)');
  assert.match(p.nodes.get('#guide-link-choices').innerHTML, /Use this album/);
  const requests = p.requests.length;
  p.nodes.get('#guide-link-search').value = p.run('state.albums[2].name');
  await p.nodes.get('#guide-link-search').emit('input');
  assert.match(p.nodes.get('#guide-link-choices').innerHTML, /data-guide-pick/);
  assert.equal(p.requests.length, requests, 'Search only uses loaded album summaries');
  await p.click({'[data-guide-pick]': {dataset: {guidePick: p.run('String(state.albums[2].id)')}}}); await settle();
  assert.equal(p.nodes.get('#guide-link-dialog').open, false);
  assert.match(p.nodes.get('#guide-results').textContent, /2 of 1,001/);
  p.nodes.get('#guide-filter').value = 'found'; await p.nodes.get('#guide-filter').emit('change');
  assert.match(p.nodes.get('#guide-list').innerHTML, /Linked by you|Undo link/);
  await p.click({'[data-guide-unlink]': {dataset: {guideUnlink: '2'}}}); await settle();
  assert.match(p.nodes.get('#guide-results').textContent, /1 of 1,001/);
  p.run('openGuideLink(3)');
  assert.match(p.nodes.get('#guide-link-choices').innerHTML, /Search your library/);
  p.run('guideLink.focus = null');
  p.nodes.get('#guide-link-dialog').close(); await p.nodes.get('#guide-link-dialog').emit('close');
  assert.equal(p.run('guideLink.entry'), null);
  assert.equal(p.run('document.activeElement === $("#guide-analyse")'), true);
  assert.equal(p.history.length, history);
  assert.deepEqual(p.json('player.queue'), queue); assert.equal(p.nodes.get('#audio').src, src);
  assert.equal(p.requests.filter(r => r.url.startsWith('/api/albums')).length, 0);
});

test('guide ignores late manual-link results after disabling or replacing the library', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p);
  p.setFetch(() => ({ok: true, json: async () => report}));
  p.run('applyAlbumGuideSettings({album_guide:true}); showAlbumGuide()'); await settle();
  let release;
  p.setFetch(() => new Promise(resolve => { release = () => resolve({ok: true, json: async () => report}); }));
  p.run('openGuideLink(2)');
  const pending = p.run('saveGuideLink(2, [String(state.albums[1].id)])');
  assert.equal(p.nodes.get('#guide-analyse').disabled, true);
  p.run('applyAlbumGuideSettings({album_guide:false})'); release(); await pending;
  assert.equal(p.run('albumGuide.data'), null); assert.equal(p.run('guideLink.entry'), null);
  assert.equal(p.nodes.get('#guide-link-dialog').open, false);
  p.setFetch(() => ({ok: true, json: async () => report}));
  p.run('applyAlbumGuideSettings({album_guide:true}); showAlbumGuide()'); await settle();
  p.setFetch(() => new Promise(resolve => { release = () => resolve({ok: true, json: async () => report}); }));
  const second = p.run('saveGuideLink(3, [String(state.albums[0].id)])');
  p.run('useLocal(demoLibrary(), "demo")'); release(); await second;
  assert.equal(p.run('albumGuide.data'), null); assert.equal(p.run('guideLink.busy'), false);
});

test('guide combines compact decade chips with reference-year sorting before paging and restores them on Back', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p);
  report.entries = Array.from({length: 30}, (_, i) => ({...report.entries[0], id:i+1,
    album:`Book album ${i+1}`, year:1980 + i % 10}));
  report.entries.push({...report.entries[0], id:31, album:'Nineties album', year:1991});
  p.setFetch(url => { assert.equal(url, '/api/album-guide'); return {ok:true, json:async () => report}; });
  p.run('applyAlbumGuideSettings({album_guide:true}); playTracks(state.details.get(state.albums[0].id)); showAlbumGuide()'); await settle();
  const count = p.requests.length, queue = p.json('player.queue'), src = p.nodes.get('#audio').src;
  assert.match(p.nodes.get('#guide-decades').innerHTML, /All decades.*1980s.*1990s/);
  await p.click({'[data-guide-decade]': {dataset:{guideDecade:'1980'}}});
  p.nodes.get('#guide-sort').value = 'year-desc'; await p.nodes.get('#guide-sort').emit('change');
  const html = p.nodes.get('#guide-list').innerHTML;
  assert.match(html, /Book album 10/); assert.doesNotMatch(html, /Nineties album/);
  assert.ok(html.indexOf('Book album 10</span>') < html.indexOf('Book album 9</span>'));
  assert.match(p.nodes.get('#guide-pagination').innerHTML, /Page 1 of 2/);
  p.run('showScreen("albums"); render()'); p.history.back(); await settle();
  assert.equal(p.run('albumGuide.decade'), '1980'); assert.equal(p.run('albumGuide.sort'), 'year-desc');
  assert.equal(p.nodes.get('#guide-sort').value, 'year-desc');
  assert.match(p.nodes.get('#guide-decades').innerHTML, /data-guide-decade="1980" aria-pressed="true"/);
  p.nodes.get('#guide-sort').value = 'year-asc'; await p.nodes.get('#guide-sort').emit('change');
  assert.ok(p.nodes.get('#guide-list').innerHTML.indexOf('Book album 1</span>') < p.nodes.get('#guide-list').innerHTML.indexOf('Book album 2</span>'));
  await p.click({'[data-guide-decade]': {dataset:{guideDecade:'all'}}});
  p.nodes.get('#guide-sort').value = 'year-desc'; await p.nodes.get('#guide-sort').emit('change');
  assert.match(p.nodes.get('#guide-list').innerHTML, /Nineties album/);
  assert.equal(p.requests.length, count); assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, src);
});

test('an older running server explains that manual linking needs a restart and keeps the chooser open', async () => {
  const p = livePage(); await settle(); const report = guideReport(p);
  p.setFetch(() => ({ok:true, json:async () => report}));
  p.run('applyAlbumGuideSettings({album_guide:true}); showAlbumGuide()'); await settle();
  p.setFetch(() => ({ok:false,status:404,json:async () => ({error:'Unknown endpoint.'})}));
  p.run('openGuideLink(2)'); await p.run('saveGuideLink(2, [String(state.albums[0].id)])');
  assert.equal(p.nodes.get('#guide-link-dialog').open, true);
  assert.match(p.nodes.get('#guide-link-error').textContent, /Restart Tagcast.*reload this page/);
  assert.equal(p.run('albumGuide.data.entries[1].status'), 'possible');
  assert.equal(p.run('guideLink.busy'), false);
});

test("favourites are native ratings, require confirmation for existing lower ratings, and wait for read-back", async () => {
  const p = livePage(); await settle();
  p.run(`const favAlbum = state.details.get(state.albums[0].id); const favTrack = favAlbum.tracks[0];
    favTrack.rating = 3; playTracks(favAlbum, String(favTrack.id)); confirm = () => false`);
  await p.run('toggleFavourite(String(favTrack.id), 3, favTrack.title)');
  assert.ok(p.requests.every(r => !r.options?.body), "Cancel never writes a rating");
  const id = p.run("String(favTrack.id)");
  p.run("confirm = () => true");
  p.setFetch(async (url, options) => {
    if (url === "/api/favourite") {
      assert.deepEqual(JSON.parse(options.body), {track_id: id, before: 3, rating: 5});
      return {ok: true, json: async () => ({job: "like-1", status: "sent", rating: 5})};
    }
    if (url === "/api/jobs/like-1") return {ok: true, json: async () => ({state: "done", results: [{id, rating: 5, status: "saved"}]})};
    assert.match(url, /^\/api\/favourites\?/);
    return {ok: true, json: async () => ({tracks: [], count: 1, total: 0, offset: 0})};
  });
  const write = p.run('toggleFavourite(String(favTrack.id), 3, favTrack.title)');
  await settle();
  assert.equal(p.run("favTrack.rating"), 3, "An accepted write is not yet confirmed");
  assert.equal(p.nodes.get("#player-favourite").disabled, true);
  assert.equal(p.nodes.get("#player-favourite").getAttribute("aria-pressed"), "true", "The requested heart is visible while checking");
  assert.equal(p.nodes.get("#player-favourite").getAttribute("aria-busy"), "true");
  p.flushTimers(2000); await write;
  assert.equal(p.run("favTrack.rating"), 5);
  assert.equal(p.run("player.queue[0].rating"), 5);
  assert.equal(p.nodes.get("#player-favourite").getAttribute("aria-pressed"), "true");
  assert.equal(p.nodes.get("#player-favourite").getAttribute("aria-busy"), "false");
  assert.equal(p.nodes.get("#favourites-count").textContent, "1");
  assert.equal(p.run("saving"), false);
  assert.equal(p.run("favourites.busy"), false);
  assert.equal(p.nodes.get("#audio").paused, false, "Changing a favourite does not stop playback");
});

test("favourite failures do not claim a successful change, and stale writes cannot alter another library", async () => {
  const p = livePage(); await settle();
  p.run(`const oldTrack = state.details.get(state.albums[0].id).tracks[0]; oldTrack.rating = 0`);
  p.setFetch(async () => ({ok: false, status: 409, json: async () => ({error: "Rating changed elsewhere"})}));
  await p.run('toggleFavourite(String(oldTrack.id), 0, oldTrack.title)');
  assert.equal(p.run("oldTrack.rating"), 0);
  assert.match(p.nodes.get("#toast").textContent, /Could not change track rating: Rating changed elsewhere/);
  let resolve;
  p.setFetch(() => new Promise(r => { resolve = r; }));
  const write = p.run('toggleFavourite(String(oldTrack.id), 0, oldTrack.title)');
  await settle();
  p.run('useLocal(demoLibrary(), "demo")');
  resolve({ok: true, json: async () => ({track_id: p.run("String(oldTrack.id)"), rating: 5, status: "saved"})});
  await write;
  assert.equal(p.run("oldTrack.rating"), 0);
  assert.ok(p.json("[...state.details.values()].flatMap(a => a.tracks).map(t => t.rating || 0)").every(n => n === 0));
  assert.equal(p.run("saving"), false);
});

test("Favourites paginates on the server and keeps its search and page on Back without disturbing playback", async () => {
  const p = livePage(); await settle();
  p.setFetch(async url => {
    assert.match(url, /^\/api\/favourites\?/);
    return {ok: true, json: async () => ({tracks: [{id: "100", album_id: "1", title: "Liked <song>",
      artist: "Artist & friends", album: "Wish You Were Here", rating: 5, track: 1, year: 1975, length: 90}],
      count: 120, total: 120, offset: Number(new URL(url, "http://test").searchParams.get("offset"))})};
  });
  p.run('$("#favourites-search").value = "wish"; showFavourites(1)'); await settle();
  assert.equal(p.location.hash, "#/favourites");
  assert.match(p.requests.at(-1).url, /q=wish&offset=50&limit=50/);
  assert.match(p.nodes.get("#favourites-list").innerHTML, /Liked &lt;song&gt;/);
  assert.match(p.nodes.get("#favourites-list").innerHTML, /data-favourite="100"/);
  assert.match(p.nodes.get("#favourites-pagination").innerHTML, /Page 2 of 3/);
  p.run('playTracks(state.details.get("1"), "100")');
  await p.run('openFoundTrack("100", "1")');
  p.history.back(); await settle();
  assert.equal(p.location.hash, "#/favourites");
  assert.equal(p.run("favourites.page"), 1);
  assert.equal(p.nodes.get("#favourites-search").value, "wish");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.nodes.get("#player-favourite").disabled, false);
  assert.equal(p.nodes.get("#player-favourite").getAttribute("aria-pressed"), "true", "Fresh favourite ratings update cached album playback");
  p.nodes.get("#favourites-search").value = "new query";
  await p.nodes.get("#favourites-search").emit("input");
  await p.run('openFoundTrack("100", "1")');
  p.history.back(); await settle();
  assert.equal(p.nodes.get("#favourites-search").value, "new query", "Back preserves input before the search debounce runs");
});

test("preview favourites cannot write, including player hearts, and explain that a connection is needed", async () => {
  const p = page({hash: "#/favourites"}); await settle();
  assert.equal(p.location.hash, "#/favourites");
  assert.match(p.nodes.get("#favourites-list").innerHTML, /Connect iBroadcast/);
  await p.run('toggleFavourite("100", 0, "Demo track")');
  assert.ok(p.requests.every(r => !r.options?.body));
  assert.match(p.run('heartButton({id: "100", title: "Demo", rating: 0})'), /disabled/);
});

test("reloading the library refreshes the current player's rating without restarting its audio", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), "100")');
  const albums = p.json("state.albums"), details = p.json('[...state.details.values()]');
  details[0].tracks[0].rating = 5;
  const before = p.nodes.get("#audio").src;
  p.setFetch(async url => {
    const data = url.startsWith("/api/library") ? {albums, artists: [], favourites_count: 1}
      : {albums: details.filter(a => new URL(url, "http://test").searchParams.get("ids").split(",").includes(String(a.id)))};
    return {ok: true, json: async () => data};
  });
  await p.run("loadLive()"); await settle();
  assert.equal(p.run("player.queue[0].rating"), 5);
  assert.equal(p.nodes.get("#player-favourite").getAttribute("aria-pressed"), "true");
  assert.equal(p.nodes.get("#audio").src, before);
  assert.equal(p.nodes.get("#audio").paused, false);
});

test('library loading has a global indeterminate indicator independent of the dismissible notice and playback', async () => {
  const p=livePage(); await settle();
  const albums=p.json('state.albums'), details=p.json('[...state.details.values()]');
  p.run('playTracks(state.details.get("1")); setLibraryNotice(false)');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src})');
  let release;
  p.setFetch(url=>url.startsWith('/api/library')?new Promise(resolve=>{release=resolve;}):{ok:true,json:async()=>url.startsWith('/api/playlists')?{playlists:[],total:0}:{albums:details}});
  const pending=p.run('loadLive()'); await settle();
  assert.equal(p.nodes.get('#library-loading').hidden,false);
  assert.equal(p.nodes.get('#library-notice').hidden,true);
  assert.match(p.nodes.get('#library-loading-detail').textContent,/Large libraries can take a little while/);
  assert.equal(p.nodes.get('#audio').paused,false);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src})'),before);
  p.run('showScreen("albums")');
  assert.equal(p.nodes.get('#library-loading').hidden,false);
  p.run('showCollections("playlists")');
  assert.match(p.nodes.get('#collections-page').innerHTML,/Loading your iBroadcast library/);
  assert.doesNotMatch(p.nodes.get('#collections-page').innerHTML,/Connect iBroadcast/);
  release({ok:true,json:async()=>({albums,artists:[]})}); await pending; await settle();
  assert.equal(p.nodes.get('#library-loading').hidden,true);
  assert.equal(p.run('state.loading'),false);
  assert.equal(p.nodes.get('#audio').paused,false);
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/library')).length,1);
  const html=readFileSync(path.join(staticDir,'index.html'),'utf8');
  assert.match(html,/<progress aria-label="Library loading"><\/progress>/);
  assert.match(html,/<strong>Loading your iBroadcast library…<\/strong>/);
});

test('an older library reply cannot hide a newer load or replace its albums', async () => {
  const p=livePage(); await settle(); const albums=p.json('state.albums');
  let first,second;
  p.setFetch(url=>new Promise(resolve=> { if(url.endsWith('refresh=1'))second=resolve;else first=resolve; }));
  const old=p.run('loadLive()'); await settle();
  const previousMessage=p.nodes.get('#library-loading-detail').textContent;
  const newer=p.run('loadLive(true)'); await settle();
  const currentMessage=p.nodes.get('#library-loading-detail').textContent;
  assert.notEqual(currentMessage,previousMessage);
  assert.match(p.nodes.get('#library-loading-detail').textContent,/fresh copy/);
  first({ok:true,json:async()=>({albums:[{...albums[0],name:'Old response'}],artists:[]})}); await old;
  assert.equal(p.nodes.get('#library-loading').hidden,false);
  assert.equal(p.run('state.loading'),true);
  assert.equal(p.run('state.albums.length'),0);
  assert.equal(p.nodes.get('#library-loading-detail').textContent,currentMessage);
  second({ok:true,json:async()=>({albums:[{...albums[0],name:'Newest response'}],artists:[]})}); await newer; await settle();
  assert.equal(p.nodes.get('#library-loading').hidden,true);
  assert.equal(p.run('state.albums[0].name'),'Newest response');
});

test('disconnect and load errors retire the indicator and ignore old account data', async () => {
  const p=livePage(); await settle(); const albums=p.json('state.albums');
  let release; p.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  const pending=p.run('loadLive()'); await settle();
  p.run('state.connection.connected=false; useLocal(demoLibrary(),"demo"); updateChrome(); render()');
  assert.equal(p.nodes.get('#library-loading').hidden,true);
  release({ok:true,json:async()=>({albums:[{...albums[0],name:'Disconnected account'}],artists:[]})}); await pending;
  assert.equal(p.run('state.mode'),'demo');
  assert.equal(p.run('state.albums.some(a=>a.name==="Disconnected account")'),false);
  p.setFetch(()=>({ok:false,status:401,json:async()=>({error:'Sign-in expired'})}));
  await p.run('loadLive()'); await settle();
  assert.equal(p.nodes.get('#library-loading').hidden,true);
  assert.equal(p.run('state.loading'),false);
  assert.equal(p.run('state.connection.connected'),false);
});

test("optimistic metadata updates preserve artist image filters and editing", () => {
  const p = livePage();
  p.run(`applyLocally([{kind: "album", albumId: state.albums[0].id, fields: {year: {after: 2000}}}])`);
  assert.equal(p.run("state.albums[0].year"), 2000);
  assert.equal(p.run("FILTERS.artist_image[1](state.albums[0])"), false);
  assert.equal(p.run('artistPageTarget("Pink Floyd").id'), "42");
  assert.equal(p.run("state.albums[0].artist_artwork_id"), 8);
});

test("changing to a known album artist uses that artist's image and ID", () => {
  const p = livePage();
  p.run(`applyLocally([{kind: "album", albumId: state.albums[0].id, fields: {artist: {after: "Kate Bush"}}}])`);
  assert.equal(p.run("state.albums[0].artist_id"), 43);
  assert.equal(p.run("state.albums[0].artist_artwork_id"), 9);
  assert.equal(p.run('artistPageTarget("Kate Bush").id'), "43");
});

test("a new album artist does not inherit the old artist's artwork target", () => {
  const p = livePage();
  p.run(`applyLocally([{kind: "album", albumId: state.albums[0].id, fields: {artist: {after: "New artist"}}}])`);
  assert.equal(p.run("state.albums[0].artist_id"), 0);
  assert.equal(p.run("state.albums[0].artist_image"), "");
  assert.equal(p.run('artistPageTarget("New artist")'), null);
});

test("year inputs reject out-of-range edits, accept boundaries and leave other numeric fields alone", async () => {
  const p = page(); await settle();
  await p.run("openEditor([state.albums[0].id])");
  assert.match(p.nodes.get("#editor-content").innerHTML, /name="year"[^>]*max="2050"/);
  assert.match(p.nodes.get("#editor-content").innerHTML, /name="disc"[^>]*max="9999"/);
  for (const year of ["", "0", "1800", "2027", "2050"]) assert.equal(p.run(`readYear(${JSON.stringify(year)})`), Number(year));
  for (const year of ["-1", "1", "1799", "2051", "3000", "2000.5"]) {
    assert.throws(() => p.run(`readYear(${JSON.stringify(year)})`), /1800 to 2050/);
  }
  assert.equal(p.run('readNumber("9999")'), 9999);
  assert.equal(p.run('readMetadataNumber("year", "3000", 3000)'), 3000);
  const input = {value: "1799", dataset: {originalYear: "1975"}, setCustomValidity(message) { this.message = message; }};
  p.nodes.set("#year-validation-input", input);
  p.run('validateYearInput($("#year-validation-input"))');
  assert.match(input.message, /1800 to 2050/);
  input.value = "2050";
  p.run('validateYearInput($("#year-validation-input"))');
  assert.equal(input.message, "");
  input.value = "3000"; input.dataset.originalYear = "3000";
  p.run('validateYearInput($("#year-validation-input"))');
  assert.equal(input.message, "", "An existing invalid value can remain unchanged");
});

test("year suggestions and album-wide track-year changes enforce the same range", async () => {
  const p = page(); await settle();
  await p.run("openEditor([state.albums[0].id])");
  const input = {type: "number", value: "2000", disabled: false, dataset: {originalYear: "2000"},
    classList: {remove() {}, add() {}}, setCustomValidity() {}};
  p.nodes.get("#metadata-form").elements = {year: input, namedItem: name => name === "year" ? input : null};
  p.run('setFormField("year", "2051")');
  assert.equal(input.value, "2000");
  assert.equal(p.run('editing.dirty.has("year")'), false);
  p.run('setFormField("year", "2027"); buildReview()');
  assert.equal(p.run('pending.changes[0].fields.year.after'), 2027);
  p.run('pending = null; editing.dirty.clear()');
  input.value = "3000"; p.nodes.get("#track-years").checked = true;
  p.run('buildReview()');
  assert.equal(p.run("pending"), null, "An unchanged bad album year cannot be copied to tracks");
});

test("unchanged bad album and track years do not block title corrections", async () => {
  const p = page(); await settle();
  p.run('state.details.get(state.albums[0].id).year = 3000');
  await p.run("openEditor([state.albums[0].id])");
  assert.match(p.nodes.get("#editor-content").innerHTML, /name="year"[^>]*max="3000"/);
  const title = {value: "Corrected title", type: "text", disabled: false};
  const year = {value: "3000", type: "number", disabled: false};
  p.nodes.get("#metadata-form").elements = {namedItem: name => name === "year" ? year : name === "name" ? title : null};
  p.run('editing.dirty.add("name"); editing.dirty.add("year"); buildReview()');
  assert.deepEqual(p.json('Object.keys(pending.changes[0].fields)'), ["name"]);
  const pane = p.nodes.get("#track-inline");
  const trackId = p.run('String(editing.originals[0].tracks[0].id)');
  p.run('editing.originals[0].tracks[0].year = 1700');
  pane.dataset.track = trackId;
  const trackYear = {type: "number", value: "1700", dataset: {key: "year"}};
  pane.querySelectorAll = () => [{type: "text", value: "Correct track title", dataset: {key: "title"}}, trackYear];
  p.run("stashTrack()");
  assert.deepEqual(p.json(`editing.trackPatches[${JSON.stringify(trackId)}]`), {title: "Correct track title"});
  trackYear.value = "1799";
  assert.throws(() => p.run("stashTrack()"), /1800 to 2050/);
  trackYear.value = ""; trackYear.validity = {badInput: true};
  assert.throws(() => p.run("stashTrack()"), /1800 to 2050/, "Malformed numeric input must not clear the year");
});

function artistEditorForm(p, value = "Pink Floyd", enable = null) {
  const input = {type: "text", value, disabled: false, hidden: false, classList: {remove() {}, add() {}}};
  const form = p.nodes.get("#metadata-form");
  form.elements = {namedItem: name => name === "artist" ? input : null};
  form.querySelector = selector => selector === '[data-enable="artist"]' ? enable : null;
  return input;
}

async function tickVariousArtists(p, checked) {
  const box = p.nodes.get("#album-various-artists");
  box.id = "album-various-artists"; box.checked = checked;
  await p.emitDocument("input", {target: box});
}

test("Various Artists checks the native album identity, including a real artist with the same name", async () => {
  const p = livePage(); await settle();
  p.run('Object.assign(state.details.get(state.albums[0].id), {artist: "Various Artists", artist_id: 0})');
  await p.run("openEditor([state.albums[0].id])");
  assert.equal(p.nodes.get("#album-various-artists").checked, true);
  assert.match(p.nodes.get("#editor-content").innerHTML, /name="artist"[^>]*value=""[^>]*hidden/);
  p.nodes.get("#editor").close();
  p.run('state.details.get(state.albums[0].id).artist_id = 99');
  await p.run("openEditor([state.albums[0].id])");
  assert.equal(p.nodes.get("#album-various-artists").checked, false);
  const input = artistEditorForm(p, "Various Artists");
  await tickVariousArtists(p, true); p.run("buildReview()");
  assert.deepEqual(p.json('pending.changes[0].fields.artist_id'),
    {before: 99, after: 0, before_name: "Various Artists (named artist)", after_name: "Various Artists"});
  assert.equal(input.hidden, true);
});

test("Various Artists reviews only the album artist and preserves tracks, credits and playback", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get(state.albums[0].id))');
  const tracks = p.json('state.details.get(state.albums[0].id).tracks');
  await p.run("openEditor([state.albums[0].id])");
  const input = artistEditorForm(p);
  await tickVariousArtists(p, true); p.run("buildReview()");
  assert.equal(input.hidden, true); assert.equal(input.disabled, true);
  assert.equal(p.run("pending.changes.length"), 1);
  assert.equal(p.run('pending.changes[0].kind'), "album");
  assert.deepEqual(p.json('Object.keys(pending.changes[0].fields)'), ["artist_id"]);
  assert.match(p.run('reviewList(pending.changes)'), /Album artist.*Pink Floyd.*Various Artists/);
  p.run("applyLocally(pending.changes)");
  assert.equal(p.run('state.albums[0].artist'), "Various Artists");
  assert.equal(p.run('state.albums[0].artist_id'), 0);
  assert.equal(p.run('state.albums[0].artist_image'), "");
  assert.deepEqual(p.json('state.details.get(state.albums[0].id).tracks'), tracks);
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.ok(p.requests.every(r => !r.options?.body), "Checking and reviewing never writes");
  await tickVariousArtists(p, false);
  assert.equal(input.value, "Pink Floyd"); assert.equal(input.hidden, false);
});

test("unchecking an existing compilation requires a named album artist and preserves track artists", async () => {
  const p = livePage(); await settle();
  p.run('Object.assign(state.details.get(state.albums[0].id), {artist: "Various Artists", artist_id: 0})');
  await p.run("openEditor([state.albums[0].id])");
  const input = artistEditorForm(p, "");
  await tickVariousArtists(p, false); p.run("buildReview()");
  assert.equal(p.run("pending"), null, "An empty album artist is not a valid replacement");
  assert.equal(input.disabled, false); assert.equal(input.hidden, false);
  input.value = "Kate Bush"; p.run("buildReview()");
  assert.deepEqual(p.json('pending.changes.map(c => [c.kind, c.fields.artist])'),
    [["album", {before: "Various Artists", after: "Kate Bush"}]]);
});

test("album artist suggestions replace the checkbox selection and retain the named draft when toggled back", async () => {
  const p = livePage(); await settle();
  await p.run("openEditor([state.albums[0].id])");
  const input = artistEditorForm(p);
  await tickVariousArtists(p, true);
  p.run('setFormField("artist", "Kate Bush")');
  assert.equal(p.nodes.get("#album-various-artists").checked, false);
  assert.equal(input.disabled, false); assert.equal(input.hidden, false);
  p.run('setFormField("artist", "Various Artists")');
  assert.equal(p.nodes.get("#album-various-artists").checked, true);
  assert.equal(input.hidden, true);
  await tickVariousArtists(p, false);
  assert.equal(input.value, "Kate Bush");
  p.run("buildReview()");
  assert.deepEqual(p.json('Object.keys(pending.changes[0].fields)'), ["artist"]);
});

test("bulk Various Artists waits for Change Album artist and keeps every track artist", async () => {
  const p = livePage(); await settle();
  p.run(`const another = structuredClone(state.details.get(state.albums[0].id)); another.id = "88"; another.name = "Another album";
    state.details.set("88", another); state.albums.push(summarize(another)); state.artist = "Pink Floyd";`);
  await p.run('openEditor([state.albums[0].id, "88"])');
  const enable = {checked: false}; const input = artistEditorForm(p, "Pink Floyd", enable);
  assert.equal(p.nodes.get("#album-various-artists").disabled, true);
  p.run("buildReview()"); assert.equal(p.run("pending"), null);
  enable.checked = true; p.run("syncAlbumArtistControls()");
  await tickVariousArtists(p, true); p.run("buildReview()");
  assert.equal(input.disabled, true);
  assert.equal(p.run("pending.scope"), "artist");
  assert.deepEqual(p.json('pending.changes.map(c => [c.kind, c.fields.artist_id.after])'), [["album", 0], ["album", 0]]);
});

test("Various Artists works in the local demo without sending writes", async () => {
  const p = page(); await settle();
  await p.run("openEditor([state.albums[0].id])");
  artistEditorForm(p);
  const tracks = p.json('editing.originals[0].tracks');
  await tickVariousArtists(p, true); p.run("buildReview(); applyDraft()");
  assert.equal(p.run('state.albums[0].artist'), "Various Artists");
  assert.deepEqual(p.json('state.details.get(state.albums[0].id).tracks'), tracks);
  assert.ok(p.requests.every(r => !r.options?.body));
});

test("Various Artists reviews every disc of one native set without track changes", async () => {
  const p = setPage(); await settle();
  p.run('state.mode = "live"; for (const id of ["71", "72", "73"]) state.details.get(id).artist_id = 42; state.albums = [...state.details.values()].map(summarize)');
  await p.run('openEditor(["71", "72", "73"])');
  artistEditorForm(p);
  await tickVariousArtists(p, true); p.run("buildReview()");
  assert.equal(p.run("editing.set"), true);
  assert.equal(p.run("pending.scope"), "album");
  assert.deepEqual(p.json('pending.changes.map(c => [c.kind, String(c.id), c.fields.artist_id.after])'),
    [["album", "71", 0], ["album", "72", 0], ["album", "73", 0]]);
});

test("opening an album shows read-only tracks; editing remains an explicit choice", async () => {
  const p = page();
  await p.click({"[data-album]": {dataset: {album: "1"}}});
  assert.equal(p.run("state.screen"), "album");
  assert.equal(p.run("editing"), null);
  assert.match(p.nodes.get("#album-page").innerHTML, /Shine On You Crazy Diamond/);
  assert.match(p.nodes.get("#album-page").innerHTML, /data-edit-album="1"/);
  assert.match(p.nodes.get("#album-page").innerHTML, /data-play-album-id="1" disabled/);
  await p.click({"[data-edit-album]": {dataset: {editAlbum: "1"}}});
  assert.equal(p.nodes.get("#editor").open, true);
  assert.equal(p.run("editing.ids[0]"), "1");
  assert.ok(p.requests.every(r => !r.options?.body));
});

test("album details escape metadata and format durations", async () => {
  const p = page();
  p.run(`state.details.get("1").name = '<script>bad</script>'; state.details.get("1").tracks[0].title = '<img onerror="bad">';
    state.details.get("1").tracks[0].length = 125;`);
  await p.run('openAlbum("1")');
  const html = p.nodes.get("#album-page").innerHTML;
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.match(html, /2:05/);
  assert.doesNotMatch(html, /<script>|<img onerror=/);
  assert.equal(p.run("trackDuration(3605)"), "1:00:05");
  assert.equal(p.run("trackDuration(undefined)"), "–");
});

test("browsing a different album preserves playback and plays the viewed album, not the editor", async () => {
  const p = page();
  await p.run('openEditor(["1"])');
  p.run('state.mode = "live"');
  await p.run('openAlbum("1")');
  await p.click({"[data-play]": {dataset: {play: "101", playAlbumId: "1"}}});
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101?quality=128");
  await p.run('openAlbum("3")');
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "3"}}});
  assert.equal(p.run("player.album.name"), "Hounds of Love");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/300?quality=128");
  p.nodes.get("#editor").close();
  p.history.back(); await settle();
  assert.equal(p.run("state.screen"), "album");
  assert.equal(p.run("albumView.id"), "1", "Back returns to the album viewed before");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/300?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
});

test("Shuffle album replaces only the play queue and ordinary Play restores album order", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("3")); Math.random = () => 0');
  await p.run('openAlbum("1")');
  const original = p.json('state.details.get("1")'), ids = original.tracks.map(t => String(t.id));
  const history = p.history.length, audio = p.nodes.get("#audio");
  assert.match(p.nodes.get("#album-page").innerHTML, /▶ Play album<\/button><button[^>]*data-shuffle-album[^>]*>Shuffle album/);
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "1"}}});
  const shuffled = [...ids.slice(1), ids[0]];
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), shuffled);
  assert.equal(p.run('player.index'), 0);
  assert.equal(audio.src, `/api/stream/${shuffled[0]}?quality=128`);
  assert.equal(p.nodes.get("#audio"), audio);
  assert.equal(p.run('encodedLocalQueue().shuffle'), true);
  assert.deepEqual(p.json('encodedLocalQueue().tracks'), shuffled.map(Number));
  assert.deepEqual(p.json('state.details.get("1")'), original);
  const visited = [p.run('player.queue[player.index].id')];
  for (let i = 1; i < ids.length; i++) {
    await audio.emit('ended'); visited.push(p.run('player.queue[player.index].id'));
  }
  assert.deepEqual(visited, shuffled);
  await audio.emit('ended'); assert.equal(p.run('player.index'), ids.length - 1);
  assert.equal(audio.src, `/api/stream/${shuffled.at(-1)}?quality=128`);
  assert.equal(p.history.length, history); assert.equal(p.run('state.history.length'), 0);
  assert.ok(p.requests.every(r => !r.options?.body));
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "1"}}});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ids);
  assert.equal(p.run('player.shuffle'), false);
  assert.equal(audio.src, `/api/stream/${ids[0]}?quality=128`);
});

test("Shuffle album includes every disc once without mutating disc or track order", async () => {
  const p = setPage(); await settle();
  p.run('state.mode = "live"; Math.random = () => 0');
  await p.run('openAlbum("71")');
  const before = p.json('["71","72","73"].map(id => state.details.get(id))');
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "71"}}});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ['7102','7201','7202','7301','7302','7101']);
  assert.equal(p.run('player.queue.length'), 6);
  assert.equal(p.run('player.album.name'), 'The Wall');
  assert.deepEqual(p.json('["71","72","73"].map(id => state.details.get(id))'), before);
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "71"}}});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ['7101','7102','7201','7202','7301','7302']);
});

test("Shuffle album respects preview, empty albums, single tracks and queue-controller ownership", async () => {
  const p = page(); await settle(); await p.run('openAlbum("1")');
  assert.match(p.nodes.get("#album-page").innerHTML, /data-shuffle-album data-play-album-id="1" disabled/);
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "1"}}});
  assert.equal(p.run('player.queue.length'), 0);
  p.run('state.mode = "live"; playTracks(state.details.get("3")); state.details.get("1").tracks = []; renderAlbumView()');
  const kept = p.json('player.queue');
  assert.match(p.nodes.get("#album-page").innerHTML, /data-shuffle-album data-play-album-id="1" disabled/);
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "1"}}});
  assert.deepEqual(p.json('player.queue'), kept);
  p.run('state.details.get("1").tracks = [state.details.get("3").tracks[0]]; renderAlbumView()');
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "1"}}});
  assert.equal(p.run('player.queue.length'), 1); assert.equal(p.run('player.index'), 0);
  const single = p.json('player.queue'), src = p.nodes.get('#audio').src;
  p.run('audio.pause(); queueSync.active = true; queueSync.allowed = false; queueSync.view = {own:false,state:{role:"controller"}}');
  const requests = p.requests.length;
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "1"}}});
  assert.deepEqual(p.json('player.queue'), single); assert.equal(p.nodes.get('#audio').src, src);
  assert.equal(p.nodes.get('#audio').paused, true); assert.equal(p.requests.length, requests);
});

test("album shuffle keeps Repeat track and Repeat queue semantics in the mixed queue", async () => {
  const p = livePage(); await settle();
  p.run('Math.random = () => 0'); await p.run('openAlbum("1")');
  await p.click({"[data-shuffle-album]": {dataset: {playAlbumId: "1"}}});
  const mixed = p.json('player.queue.map(t => t.id)');
  p.run('player.repeat = "track"'); await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.index'), 0);
  p.run('player.repeat = "queue"; player.index = player.queue.length - 1; playCurrent()');
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.index'), 0); assert.deepEqual(p.json('player.queue.map(t => t.id)'), mixed);
  assert.equal(p.run('player.shuffle'), true);
});

test("album playback supports pause, resume and automatic next track without looping", async () => {
  const p = page();
  p.run('state.mode = "live"');
  await p.run('openAlbum("1")');
  const target = {"[data-play]": {dataset: {play: "101", playAlbumId: "1"}}};
  await p.click(target);
  await p.click(target);
  assert.equal(p.nodes.get("#audio").paused, true);
  await p.click(target);
  assert.equal(p.nodes.get("#audio").paused, false);
  await p.nodes.get("#audio").emit("ended");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/102?quality=128");
  p.run("player.index = player.queue.length - 1; playCurrent()");
  const last = p.nodes.get("#audio").src;
  await p.nodes.get("#audio").emit("ended");
  assert.equal(p.nodes.get("#audio").src, last);
  p.run("stopPlayer()");
  assert.equal(p.nodes.get("#audio").src, undefined);
  assert.equal(p.run("player.album"), null);
});

test("player artist and album navigation preserve playback and browser history", async () => {
  const p = livePage();
  p.run('playTracks(state.details.get("1"), "101"); showArtistBrowse(); $("#filter").value = "cover"; $("#search").value = "No match"');
  assert.equal(p.nodes.get("#player-artist").textContent, "Pink Floyd");
  assert.equal(p.nodes.get("#player-album").textContent, "Wish You Were Here");
  assert.equal(p.nodes.get("#player-track-line").hidden, true);
  await p.nodes.get("#player-artist").emit("click");
  assert.equal(p.location.hash, "#/artist/Pink%20Floyd");
  assert.equal(p.nodes.get("#filter").value, "all");
  assert.equal(p.nodes.get("#search").value, "");
  assert.equal(p.run("filteredAlbums().length"), 2);
  await p.nodes.get("#player-album").emit("click");
  assert.equal(p.location.hash, "#/album/1");
  assert.equal(p.run("albumView.found"), "101");
  p.history.back();
  assert.equal(p.location.hash, "#/artist/Pink%20Floyd");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.run("player.index"), 1);
  assert.ok(p.requests.every(r => !r.options?.body));
});

test("the player separates album artist from compound track artists and each link opens the right albums", async () => {
  const p = livePage();
  p.run('state.details.get("1").tracks[0].artist = "Pink Floyd; Guest Artist"; state.details.get("1").tracks[0].artist_id = 99; playTracks(state.details.get("1"), "100")');
  p.setFetch(url => {
    const params = new URL(url, "http://localhost").searchParams;
    assert.equal(params.get("kind"), "track-artists"); assert.equal(params.get("key"), "99");
    return {ok: true, json: async () => ({group: {key: "99", label: "Pink Floyd; Guest Artist"}, album_ids: ["1"]})};
  });
  assert.equal(p.nodes.get("#player-artist").getAttribute("aria-label"), "Open albums by Pink Floyd");
  assert.equal(p.nodes.get("#player-track-artist").textContent, "Pink Floyd; Guest Artist");
  assert.equal(p.nodes.get("#player-track-line").hidden, false);
  await p.nodes.get("#player-artist").emit("click");
  assert.equal(p.location.hash, "#/artist/Pink%20Floyd");
  await p.nodes.get("#player-track-artist").emit("click"); await settle();
  assert.equal(p.location.hash, "#/track-artists/99");
  assert.match(p.nodes.get("#browse-list").innerHTML, /data-album="1"/);
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.ok(p.requests.every(r => !r.options?.body));
});

test("player labels update on the next track and cannot navigate after stopping", async () => {
  const p = livePage();
  p.run('state.details.get("1").tracks[1].artist = "<img onerror=bad>"; playTracks(state.details.get("1"), "100"); step(1)');
  assert.equal(p.nodes.get("#player-artist").textContent, "Pink Floyd");
  assert.equal(p.nodes.get("#player-track-artist").textContent, "<img onerror=bad>");
  assert.equal(p.nodes.get("#player-track-artist").innerHTML, "");
  assert.equal(p.nodes.get("#player-track-artist").title, "<img onerror=bad>");
  p.run("stopPlayer()");
  const hash = p.location.hash;
  await p.nodes.get("#player-artist").emit("click");
  await p.nodes.get("#player-album").emit("click");
  await p.nodes.get("#player-track-artist").emit("click");
  assert.equal(p.location.hash, hash);
  assert.equal(p.nodes.get("#audio").src, undefined);
});

test("artist image Undo survives an older read-back waiting for the editor to close", async () => {
  const p = page();
  p.run(`state.mode = "live";
    state.albums = state.albums.map(a => a.artist === "Pink Floyd" ? {...a, artist_id: 42, artist_artwork_id: 77, artist_image: "https://example.test/artwork/77-150"} : a);
    $("#editor").open = true; pendingAlbums = structuredClone(state.albums);
    state.history = [artworkEntry({target: "artist", id: "42", label: "Pink Floyd", artist: "Pink Floyd"},
      {artwork_id: 77, image: "https://example.test/artwork/77-300", previous: {artwork_id: 500}, results: []}, "iBroadcast", "https://example.test/artwork/500-300")]`);
  p.setFetch((url, options) => {
    assert.equal(url, "/api/artwork/undo");
    assert.deepEqual(JSON.parse(options.body).previous, {artwork_id: 500});
    return {ok: true, json: async () => ({artwork_id: 500, image: "https://example.test/artwork/500-300",
      previous: {artwork_id: 77}, results: [], job: "undo-1"})};
  });
  await p.run("undoArtwork(state.history[0])");
  p.run('$("#editor").open = false; flushPendingAlbums()');
  assert.equal(p.run('state.albums.find(a => a.artist_id === 42).artist_artwork_id'), 500);
  assert.equal(p.run('state.albums.find(a => a.artist_id === 42).artist_image'), "https://example.test/artwork/500-150");
  assert.equal(p.run("state.history[1].undone"), true);
});

test("History explains unavailable image Undo and shows restore errors inside the dialog", async () => {
  const p = page();
  p.run(`state.history = [artworkEntry({target: "artist", id: "42", label: "Pink Floyd", artist: "Pink Floyd"},
    {artwork_id: 77, image: "https://example.test/artwork/77-300", previous: {artwork_id: 0}, results: []}, "iBroadcast", "")]; showHistory()`);
  assert.match(p.nodes.get("#history-content").innerHTML, /disabled[^]*No previous artist image was saved to restore/);
  await p.run("undoArtwork(state.history[0])");
  assert.equal(p.requests.filter(r => r.url === "/api/artwork/undo").length, 0);
  p.run("state.history[0].artwork.previous.artwork_id = 500; showHistory()");
  p.setFetch(() => ({ok: false, status: 409, json: async () => ({error: "The artist image changed in iBroadcast."})}));
  await p.run("undoArtwork(state.history[0])");
  assert.equal(p.nodes.get("#history-status").textContent, "The artist image changed in iBroadcast.");
  assert.equal(p.run("state.history[0].undone"), undefined);
});

test("playback remains available in the single-album editor and is blocked in previews", async () => {
  const p = page();
  await p.run('openEditor(["1"])');
  const target = {"[data-play]": {dataset: {play: "100"}}, "#editor": {}};
  await p.click(target);
  assert.equal(p.nodes.get("#audio").src, undefined);
  p.run('state.mode = "live"');
  await p.click(target);
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100?quality=128");
  p.run('useLocal(demoLibrary(), "demo")');
  assert.equal(p.nodes.get("#audio").src, undefined);
  assert.equal(p.run("player.queue.length"), 0);
});

test("leaving album details while loading cannot reopen the page or contaminate a replacement library", async () => {
  const p = page();
  let resolve;
  p.setFetch(() => new Promise(done => { resolve = done; }));
  const album = p.json('state.details.get("1")');
  p.run('state.mode = "live"; state.details = new Map()');
  const loading = p.run('openAlbum("1")');
  p.run('useLocal(demoLibrary(), "demo"); showScreen("overview")');
  resolve({ok: true, json: async () => ({albums: [{...album, name: "Stale album"}]})});
  await loading;
  assert.equal(p.run("state.screen"), "overview");
  assert.equal(p.nodes.get("#album-page").hidden, true);
  assert.equal(p.run('state.details.get("1").name'), "Wish You Were Here");
});

test("a save refreshes visible album details without restarting playback", async () => {
  const p = page();
  p.run('state.mode = "live"');
  await p.run('openAlbum("1")');
  p.run('playTracks(state.details.get("1"), "100")');
  p.run('applyLocally([{kind: "album", albumId: "1", fields: {name: {after: "Updated name"}}}]); render()');
  assert.match(p.nodes.get("#album-page").innerHTML, /Updated name/);
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.run("player.album.name"), "Wish You Were Here", "Playback retains its independent snapshot");
});

test("album artist overview includes all album artists, independently of album filters", async () => {
  const p = page();
  p.run('state.artist = "Pink Floyd"; state.artistNames = ["Track-only artist"]; $("#filter").value = "genre"');
  await p.nodes.get("#show-artists").emit("click");
  assert.equal(p.run("state.screen"), "artists");
  assert.equal(p.nodes.get("#breadcrumb").textContent, "Album artists");
  assert.equal(p.nodes.get("#show-artists").classList.contains("active"), true);
  assert.equal(p.nodes.get("#albums-page").hidden, true);
  assert.equal(p.nodes.get("#artists-results").textContent, "3 album artists");
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), ["Kate Bush", "Massive Attack", "Pink Floyd"]);
  assert.deepEqual(p.json("filteredArtistGroups().map(([, group]) => group.count)"), [2, 2, 2]);
  assert.doesNotMatch(p.nodes.get("#artists-grid").innerHTML, /Track-only artist/);
  assert.equal(p.run("editing"), null);
  assert.ok(p.requests.every(r => ["/api/status", "/api/settings", "/api/updates"].includes(r.url)), "Overview uses summaries without downloading tracks");
});

test("artist overview paginates a large collection and resets paging on search and sort", async () => {
  const p = page();
  p.run(`state.albums = Array.from({length: 202}, (_, i) => ({...state.albums[0], id: String(i), artist: "Artist " + String(i).padStart(3, "0")})); showArtistBrowse()`);
  assert.equal((p.nodes.get("#artists-grid").innerHTML.match(/data-browse-artist=/g) || []).length, 24);
  assert.equal(p.nodes.get("#artists-results").textContent, "202 album artists");
  await p.click({"[data-artist-page]": {dataset: {artistPage: "1"}}});
  assert.equal(p.run("artistBrowse.page"), 1);
  assert.match(p.nodes.get("#artists-grid").innerHTML, /Artist 024/);
  p.nodes.get("#artists-sort").value = "za";
  await p.nodes.get("#artists-sort").emit("change");
  assert.equal(p.run("artistBrowse.page"), 0);
  assert.match(p.nodes.get("#artists-grid").innerHTML, /Artist 201/);
  await p.click({"[data-artist-page]": {dataset: {artistPage: "1"}}});
  p.nodes.get("#artists-search").value = "  ARTIST 201  ";
  await p.nodes.get("#artists-search").emit("input");
  p.flushTimers(150);
  assert.equal(p.run("artistBrowse.page"), 0);
  assert.equal(p.nodes.get("#artists-results").textContent, "1 album artist");
  assert.equal((p.nodes.get("#artists-grid").innerHTML.match(/data-browse-artist=/g) || []).length, 1);
  assert.equal(p.nodes.get("#artists-pagination").innerHTML, "");
  p.nodes.get("#artists-search").value = "No matching artist";
  await p.nodes.get("#artists-search").emit("input"); p.flushTimers(150);
  assert.match(p.nodes.get("#artists-grid").innerHTML, /No album artists match/);
});

test('clearing the artist search resets only its text and page, cancels pending filtering and returns focus', async () => {
  const p = livePage(); await settle();
  p.run(`playTracks(state.details.get("1")); audio.currentTime=24;
    state.albums=Array.from({length:60},(_,i)=>({...state.albums[0],id:String(i),artist_id:i+10,
      artist:"Artist "+String(i).padStart(2,"0"),artist_image:"",album_artists:undefined}));
    showArtistBrowse(); $("#artists-filter").value="no_image"; $("#artists-sort").value="za";
    artistBrowse.page=1; renderArtistBrowse();`);
  const button = p.nodes.get('#artists-search-clear'), input = p.nodes.get('#artists-search');
  assert.equal(button.hidden, true);
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src, requests = p.requests.length;
  input.value = 'toots'; await input.emit('input');
  assert.equal(button.hidden, false, 'The clear button appears without waiting for debounce');
  button.focus();
  await button.emit('click');
  assert.equal(input.value, '');
  assert.equal(button.hidden, true);
  assert.equal(p.run('artistBrowse.page'), 0);
  assert.equal(p.nodes.get('#artists-filter').value, 'no_image');
  assert.equal(p.nodes.get('#artists-sort').value, 'za');
  assert.equal(p.nodes.get('#artists-results').textContent, '60 album artists');
  assert.equal(p.run('document.activeElement === $("#artists-search")'), true);
  const entries = p.history.length;
  p.flushTimers(150);
  assert.equal(p.history.length, entries, 'The cancelled search timer adds no later history entry');
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').currentTime, 24);
  assert.equal(p.requests.length, requests, 'Clearing a local search needs no library request');
});

test('the artist clear button follows typing, manual deletion and restored browser history', async () => {
  const p = page(); await settle();
  p.run('showArtistBrowse()');
  const input = p.nodes.get('#artists-search'), button = p.nodes.get('#artists-search-clear');
  input.value = 'Pink'; await input.emit('input'); p.flushTimers(150);
  assert.equal(button.hidden, false);
  assert.match(p.nodes.get('#artists-grid').innerHTML, /Pink Floyd/);
  await p.nodes.get('#all-albums').emit('click');
  p.history.back(); await settle();
  assert.equal(input.value, 'Pink');
  assert.equal(button.hidden, false);
  await button.emit('click');
  await p.nodes.get('#all-albums').emit('click');
  p.history.back(); await settle();
  assert.equal(input.value, '');
  assert.equal(button.hidden, true);
  p.history.forward(); await settle();
  p.history.back(); await settle();
  assert.equal(button.hidden, true);
  input.value = ' '; await input.emit('input');
  assert.equal(button.hidden, false, 'Whitespace can also be cleared');
  input.value = ''; await input.emit('input');
  assert.equal(button.hidden, true, 'Deleting the final character hides the clear button immediately');
});

test("artist cards use an available image, safe metadata and initials when an image is missing", () => {
  const p = page();
  p.run(`state.albums[0].artist_image = ""; state.albums[1].artist_image = "https://example.test/artist-150";
    state.albums[2].artist = '<img onerror="bad">'; showArtistBrowse()`);
  const html = p.nodes.get("#artists-grid").innerHTML;
  assert.match(html, /https:\/\/example.test\/artist-300/);
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.match(html, /<span>MA<\/span>/);
  assert.doesNotMatch(html, /<img onerror=/);
  assert.match(html, /loading="lazy" referrerpolicy="no-referrer"/);
});

test("live artist overview cards open albums without exposing image editing", async () => {
  const p=livePage(); await settle(); p.run('showArtistBrowse()');
  const html=p.nodes.get('#artists-grid').innerHTML;
  assert.match(html, /<button class="artist-card" data-browse-artist="Kate Bush"/);
  assert.doesNotMatch(html, /data-artist-image|image-edit-label|Change image|Add image/);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test("artist header puts its image action on the photo and demo cards keep navigation only", async () => {
  const p = livePage(); await settle();
  p.run('setArtist("Kate Bush")');
  const html = p.nodes.get('#artist-panel').innerHTML;
  assert.match(html, /<button type="button" class="artist-photo image-edit-button" id="change-artist-page-image"/);
  assert.equal((html.match(/Change image/g)||[]).length, 2, 'One accessible label and one overlay label');
  assert.doesNotMatch(html, /artist-meta|albums<|tracks</, 'The redundant header counts are removed');
  assert.match(p.nodes.get('#results-count').textContent, /2 albums by Kate Bush/);
  p.run('state.mode="demo"; showArtistBrowse()');
  assert.doesNotMatch(p.nodes.get('#artists-grid').innerHTML, /data-artist-image=/);
  assert.match(p.nodes.get('#artists-grid').innerHTML, /data-browse-artist=/);
});

test("artist page image editing uses the identity supplying the photo when native names are shared", async () => {
  const p=livePage(); await settle();
  p.run(`state.albums = [
    {...state.albums[0],id:"a",artist:"Shared name",artist_id:"10",artist_image:""},
    {...state.albums[0],id:"b",artist:"Shared name",artist_id:"11",artist_image:"https://example.test/eleven-150"}
  ]; showArtistBrowse()`);
  p.run('setArtist("Shared name")');
  assert.match(p.nodes.get('#artist-panel').innerHTML,/data-artist-page-image-id="11"/);
  p.setFetch(()=>({ok:true,json:async()=>({options:[]})}));
  await p.click({'#change-artist-page-image':{dataset:{artistPageImageId:'11'}}});
  assert.equal(p.run('art.target.id'),'11');
  assert.equal(p.run('art.target.current'),'https://example.test/eleven-300');
});

test("Random album artists keeps one complete order across pages, filters and Back without loading tracks", async () => {
  const p = livePage(); await settle();
  p.run(`playTracks(state.details.get("1"), "100");
    state.albums = Array.from({length: 75}, (_, i) => ({...state.albums[0], id: String(i),
      artist: "Artist " + String(i).padStart(3, "0"), artist_image: i % 3 ? "https://example.test/photo" : ""}));
    let shuffleCalls = 0; Math.random = () => { shuffleCalls += 1; return 0; }; showArtistBrowse()`);
  p.nodes.get("#artists-sort").value = "random";
  await p.nodes.get("#artists-sort").emit("change");
  const order = p.json("filteredArtistGroups().map(([name]) => name)");
  assert.equal(order.length, 75);
  assert.equal(new Set(order).size, 75);
  assert.notDeepEqual(order, [...order].sort());
  const requests = p.requests.length, shuffleCalls = p.run("shuffleCalls");
  const visibleNames = () => [...p.nodes.get("#artists-grid").innerHTML.matchAll(/data-browse-artist="([^"]+)"/g)].map(match => match[1]);
  const pages = visibleNames();
  for (let pageIndex = 1; pageIndex < 4; pageIndex++) {
    await p.click({"[data-artist-page]": {dataset: {artistPage: "1"}}});
    pages.push(...visibleNames());
  }
  assert.deepEqual(pages, order, "Every artist appears once across all pages");
  await p.click({"[data-browse-artist]": {dataset: {browseArtist: order[72]}}});
  await p.nodes.get("#artist-back").emit("click");
  assert.equal(p.nodes.get("#artists-sort").value, "random");
  assert.equal(p.run("artistBrowse.page"), 3);
  assert.deepEqual(visibleNames(), order.slice(72));
  p.nodes.get("#artists-search").value = "Artist 03";
  await p.nodes.get("#artists-search").emit("input"); p.flushTimers(150);
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), order.filter(name => name.includes("Artist 03")));
  p.nodes.get("#artists-search").value = "";
  await p.nodes.get("#artists-search").emit("input"); p.flushTimers(150);
  p.nodes.get("#artists-filter").value = "no_image";
  await p.nodes.get("#artists-filter").emit("change");
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), order.filter(name => Number(name.slice(-3)) % 3 === 0));
  p.nodes.get("#artists-filter").value = "all";
  await p.nodes.get("#artists-filter").emit("change");
  p.nodes.get("#artists-per-page").value = "50";
  await p.nodes.get("#artists-per-page").emit("change", {target: p.nodes.get("#artists-per-page")});
  assert.deepEqual(visibleNames(), order.slice(0, 50));
  assert.equal(p.run("shuffleCalls"), shuffleCalls);
  assert.equal(p.requests.length, requests, "Sorting uses existing album summaries only");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.run('browseChoices.views.get("artists").find(option=>option.key==="sort:random").label'), "Random");
});

test("Random artists can reshuffle, follow metadata edits and discard an old library's remembered order", async () => {
  const p = livePage(); await settle();
  p.run("Math.random = () => 0; showArtistBrowse()");
  p.nodes.get("#artists-sort").value = "random";
  await p.nodes.get("#artists-sort").emit("change");
  const original = p.json("filteredArtistGroups().map(([name]) => name)");
  await p.click({"[data-browse-artist]": {dataset: {browseArtist: original[0]}}});
  await p.nodes.get("#show-artists").emit("click");
  p.nodes.get("#artists-sort").value = "az";
  await p.nodes.get("#artists-sort").emit("change");
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), [...original].sort());
  p.run("Math.random = () => 0.999");
  p.nodes.get("#artists-sort").value = "random";
  await p.nodes.get("#artists-sort").emit("change");
  assert.notDeepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), original);
  p.history.back(); p.history.back();
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), original, "Older history restores its own shuffle");
  p.run('applyLocally([{kind: "album", albumId: "1", fields: {artist: {after: "New artist"}}}]); render()');
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), [...original, "New artist"]);
  p.run('state.albums = state.albums.filter(a => a.artist !== "New artist"); render()');
  assert.deepEqual(p.json("filteredArtistGroups().map(([name]) => name)"), original);
  const saved = p.json("history.state");
  p.run('useLocal(demoLibrary().map(a => ({...a, artist: "Replacement " + a.artist})), "demo"); render()');
  assert.equal(p.run("artistBrowse.page"), 0);
  p.run(`showRoute({screen: "artists"}, ${JSON.stringify(saved)})`);
  const replacement = p.json("filteredArtistGroups().map(([name]) => name)");
  assert.equal(replacement.length, 3);
  assert.ok(replacement.every(name => name.startsWith("Replacement ")));
  p.setFetch(async url => {
    assert.equal(url, "/api/library");
    return {ok: true, json: async () => ({albums: p.json('state.albums').map(a => ({...a, artist: "Live " + a.artist})), artists: []})};
  });
  await p.run("loadLive()"); await settle();
  assert.ok(p.json("filteredArtistGroups().map(([name]) => name)").every(name => name.startsWith("Live ")));
  assert.notEqual(p.run("artistBrowse.library"), saved.artistsLibrary);
});

test("an artist card opens all of that artist's albums and keeps music playing", async () => {
  const p = livePage();
  p.run('playTracks(state.details.get("1"), "100"); $("#filter").value = "cover"; $("#search").value = "No match"; showArtistBrowse()');
  await p.click({"[data-browse-artist]": {dataset: {browseArtist: "Kate Bush"}}});
  assert.equal(p.run("state.screen"), "albums");
  assert.equal(p.run("state.artist"), "Kate Bush");
  assert.equal(p.nodes.get("#filter").value, "all");
  assert.equal(p.nodes.get("#search").value, "");
  assert.equal(p.run("filteredAlbums().length"), 2);
  assert.equal(p.nodes.get("#show-artists").classList.contains("active"), false);
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.ok(p.requests.every(r => !r.options?.body));
});

test("artist overview updates after local edits and handles library loading and empty results", () => {
  const p = page();
  p.run('showArtistBrowse(); applyLocally([{kind: "album", albumId: "1", fields: {artist: {after: "New artist"}}}]); render()');
  assert.equal(p.nodes.get("#artists-results").textContent, "4 album artists");
  assert.match(p.nodes.get("#artists-grid").innerHTML, /New artist/);
  assert.match(p.nodes.get("#artists-grid").innerHTML, /1 album<\/span>/);
  p.run("state.albums = []; state.loading = true; artistBrowse.page = 9; render()");
  assert.equal(p.run("artistBrowse.page"), 0);
  assert.match(p.nodes.get("#artists-grid").innerHTML, /Loading album artists/);
  p.run("state.loading = false; render()");
  assert.match(p.nodes.get("#artists-grid").innerHTML, /No album artists match/);
});

test("album artist links and overview remain reachable from the artist grid", async () => {
  const p = page();
  p.run("showArtistBrowse()");
  await p.click({"[data-artist]": {dataset: {artist: "Pink Floyd"}}});
  assert.equal(p.run("state.screen"), "albums");
  assert.equal(p.run("state.artist"), "Pink Floyd");
  p.run("showArtistBrowse()");
  await p.click({"#show-overview": {}});
  assert.equal(p.run("state.screen"), "overview");
  assert.equal(p.nodes.get("#artists-page").hidden, true);
});

// ---- navigation: the start page, browser history and "Back" -------------------------

const settle = () => new Promise(resolve => setImmediate(resolve));

test("Tagcast starts on Album artists, the first page in the sidebar", async () => {
  const p = page();
  await settle();
  assert.equal(p.run("state.screen"), "artists");
  assert.equal(p.location.hash, "#/artists");
  assert.equal(p.nodes.get("#artists-page").hidden, false);
  assert.equal(p.nodes.get("#albums-page").hidden, true);
  const html = readFileSync(path.join(staticDir, "index.html"), "utf8");
  const order = ["show-artists", "all-albums", "show-tracks", "show-overview", "show-history"].map(id => html.indexOf(`id="${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(html, /import-file|Import library/);
});

test('sidebar shortcuts hide independently of feature settings, persist and preserve essential controls and playback', async () => {
  const storage = {}, p = page({storage}); await settle();
  p.run('state.mode="live"; playTracks(state.details.get(state.albums[0].id)); openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML, /Choose shortcuts and order/);
  const queue = p.json('player.queue'), src = p.nodes.get('#audio').src, count = p.requests.length, route = p.location.hash;
  const input = {checked:false,dataset:{sidebarItem:'show-genres'},matches(selector) {return selector === '[data-sidebar-item]';}};
  await p.change(input);
  assert.equal(p.nodes.get('#show-genres').hidden, true);
  input.dataset.sidebarItem = 'show-history'; await p.change(input);
  assert.equal(p.nodes.get('#show-history').hidden, false);
  assert.equal(p.nodes.get('#show-artists').hidden, false); assert.equal(p.nodes.get('#all-albums').hidden, false);
  assert.notEqual(p.run('$("#settings-button").hidden'), true);
  input.dataset.sidebarItem = 'show-recently-played'; await p.change(input);
  p.run('playReporting.enabled=true; updateRecentlyPlayedControls()');
  assert.equal(p.nodes.get('#show-recently-played').hidden, true);
  input.checked = true; await p.change(input);
  assert.equal(p.nodes.get('#show-recently-played').hidden, false);
  p.run('playReporting.enabled=false; updateRecentlyPlayedControls()');
  assert.equal(p.nodes.get('#show-recently-played').hidden, true);
  assert.equal(p.requests.length, count); assert.equal(p.location.hash, route);
  assert.deepEqual(p.json('player.queue'), queue); assert.equal(p.nodes.get('#audio').src, src);
  const reloaded = page({storage}); await settle();
  assert.equal(reloaded.nodes.get('#show-genres').hidden, true);
  assert.equal(reloaded.nodes.get('#show-album-guide').hidden, true);
  assert.equal(reloaded.nodes.get('#show-history').hidden, false);
});

test('sidebar order changes DOM and keyboard order, restores defaults, and ignores invalid saved items', async () => {
  const storage = {'tagcast-sidebar':JSON.stringify({order:['unknown','show-genres','show-genres'],hidden:['show-artists','unknown','show-composers']})};
  const p = page({storage}); await settle();
  assert.equal(p.run('sidebarLayout.order[0]'), 'show-genres');
  assert.equal(p.nodes.get('#workspace-nav').children[0], p.nodes.get('#show-genres'));
  assert.equal(p.nodes.get('#show-artists').hidden, false);
  assert.equal(p.nodes.get('#show-composers').hidden, true);
  assert.equal(new Set(p.json('sidebarLayout.order')).size, p.run('SIDEBAR_ITEMS.length'));
  await p.click({'[data-sidebar-move]': {dataset:{sidebarMove:'show-genres',direction:'1'}}});
  assert.equal(p.nodes.get('#workspace-nav').children[1], p.nodes.get('#show-genres'));
  assert.equal(JSON.parse(storage['tagcast-sidebar']).order[1], 'show-genres');
  const reloaded = page({storage}); await settle();
  assert.equal(reloaded.nodes.get('#workspace-nav').children[1], reloaded.nodes.get('#show-genres'));
  await p.click({'[data-sidebar-reset]': {}});
  assert.deepEqual(p.json('sidebarLayout.order'), p.json('SIDEBAR_ITEMS.map(i=>i[0])'));
  assert.equal(p.nodes.get('#workspace-nav').children[0], p.nodes.get('#show-artists'));
  assert.equal(p.nodes.get('#show-composers').hidden, false);
  assert.equal(p.nodes.get('#show-album-guide').hidden, true, 'Restoring shortcuts cannot enable a feature');
  p.run('localStorage.setItem = () => {throw Error("Storage unavailable")}; sidebarLayout.hidden=["show-genres"]; saveSidebarLayout()');
  assert.equal(p.nodes.get('#show-genres').hidden, true);
  assert.match(p.nodes.get('#toast').textContent, /could not save/);
  for (const saved of ['broken', 'null', '[]', '{"order":12,"hidden":false}']) {
    const fresh = page({storage:{'tagcast-sidebar':saved}}); await settle();
    assert.deepEqual(fresh.json('sidebarLayout.order'), fresh.json('SIDEBAR_ITEMS.map(i=>i[0])'));
  }
});

test("Back returns from an album to the artist and then to the artist grid as it was", async () => {
  const p = page();
  await settle();
  p.nodes.get("#artists-search").value = "a";
  p.run("artistBrowse.page = 0; renderArtistBrowse()");
  await p.click({"[data-browse-artist]": {dataset: {browseArtist: "Kate Bush"}}});
  assert.equal(p.location.hash, "#/artist/Kate%20Bush");
  assert.equal(p.nodes.get("#artist-back").hidden, false);
  assert.equal(p.nodes.get("#artist-back").textContent, "← Back to Album artists");
  await p.click({"[data-album]": {dataset: {album: "3"}}});
  assert.equal(p.location.hash, "#/album/3");
  assert.match(p.nodes.get("#breadcrumb").innerHTML, /Album artists.*Kate Bush/);
  await p.click({"[data-album-crumb]": {dataset: {albumCrumb: "1"}}});
  assert.equal(p.run("state.screen"), "albums");
  assert.equal(p.run("state.artist"), "Kate Bush");
  await p.nodes.get("#artist-back").emit("click");
  assert.equal(p.run("state.screen"), "artists");
  assert.equal(p.nodes.get("#artists-search").value, "a", "The artist search is restored");
  p.history.forward();
  assert.equal(p.run("state.artist"), "Kate Bush");
  assert.equal(p.run("state.screen"), "albums");
});

test("an album opened from the Overview goes back to the Overview", async () => {
  const p = page();
  await settle();
  await p.click({"#show-overview": {}});
  await p.click({"[data-album]": {dataset: {album: "2"}}});
  assert.match(p.nodes.get("#breadcrumb").innerHTML, /Overview/);
  await p.click({"[data-album-crumb]": {dataset: {albumCrumb: "0"}}});
  assert.equal(p.run("state.screen"), "overview");
  assert.equal(p.location.hash, "#/overview");
});

test("the browser's Back restores the album list's search, filter and page", async () => {
  const p = page();
  await settle();
  await p.nodes.get("#all-albums").emit("click");
  p.nodes.get("#filter").value = "year"; p.nodes.get("#search").value = "kate";
  p.run("state.page = 0; render()");
  await p.click({"[data-album]": {dataset: {album: "3"}}});
  p.nodes.get("#filter").value = "all"; p.nodes.get("#search").value = "";
  p.history.back();
  assert.equal(p.run("state.screen"), "albums");
  assert.equal(p.nodes.get("#filter").value, "year");
  assert.equal(p.nodes.get("#search").value, "kate");
  assert.equal(p.location.hash, "#/albums");
});

test("Back keeps an open editor and its page in place", async () => {
  const p = page();
  await settle();
  await p.click({"[data-album]": {dataset: {album: "1"}}});
  await p.click({"[data-edit-album]": {dataset: {editAlbum: "1"}}});
  p.history.back();
  assert.equal(p.run("state.screen"), "album");
  assert.equal(p.run("albumView.id"), "1");
  assert.equal(p.location.hash, "#/album/1");
  assert.equal(p.nodes.get("#editor").open, true);
  assert.match(p.nodes.get("#toast").textContent, /Close the editor first/);
});

test("an address of an album opens that album once the library is there", async () => {
  const p = page({hash: "#/album/3"});
  assert.equal(p.run("state.screen"), "artists");
  await settle();
  assert.equal(p.run("state.screen"), "album");
  assert.equal(p.run("albumView.id"), "3");
  assert.equal(p.location.hash, "#/album/3");
  const unknown = page({hash: "#/album/999"});
  await settle();
  assert.equal(unknown.run("state.screen"), "artists");
  assert.equal(unknown.location.hash, "#/artists");
});

// The demo library plus a set of three discs, as iBroadcast sends it while
// "Combine Multi-Disc Album Sets" is off: one album per disc, with the same title.
function setPage() {
  const p = page();
  p.run(`const discs = [1, 2, 3].map(n => ({id: 70 + n, artist: "Pink Floyd", name: "The Wall", year: 0,
      disc: n, color: colors[0], tracks: [1, 2].map(t => ({id: (70 + n) * 100 + t, title: "Part " + n + "." + t,
      artist: "Pink Floyd", year: 1979, genre: "Rock", track: t, length: 60}))}));
    useLocal([...demoLibrary(), ...discs], "demo"); render()`);
  return p;
}

test("album sorting keeps sets together, missing years last and restores the chosen order on Back", async () => {
  const p = setPage();
  await settle();
  await p.nodes.get("#all-albums").emit("click");
  const summaries = p.json("state.albums.map(a => a.id)");
  const orders = {
    artist: ["3", "4", "6", "5", "2", "71", "1"],
    artist_za: ["2", "71", "1", "6", "5", "3", "4"],
    title: ["6", "3", "5", "2", "4", "71", "1"],
    title_za: ["1", "71", "4", "2", "5", "3", "6"],
    year: ["1", "4", "6", "5", "2", "3", "71"],
    newest: ["2", "5", "6", "4", "1", "3", "71"],
  };
  for (const [sort, ids] of Object.entries(orders)) {
    p.nodes.get("#sort").value = sort;
    p.run("state.page = 9");
    await p.nodes.get("#sort").emit("change");
    assert.equal(p.run("state.page"), 0);
    assert.deepEqual(p.json("filteredAlbums().map(a => a.id)"), ids, sort);
  }
  assert.deepEqual(p.json("state.albums.map(a => a.id)"), summaries, "Sorting preserves the library summaries");
  await p.click({"[data-album]": {dataset: {album: "71"}}});
  p.nodes.get("#sort").value = "artist";
  p.history.back();
  assert.equal(p.nodes.get("#sort").value, "newest");
  assert.deepEqual(p.json("filteredAlbums().map(a => a.id)"), orders.newest);
});

test("the discs of a set are one album in the lists, with their numbers added up", async () => {
  const p = setPage();
  await settle();
  const ids = p.json("filteredAlbums().map(a => a.id)");
  assert.equal(ids.length, 7);
  assert.ok(ids.includes("71") && !ids.includes("72") && !ids.includes("73"));
  assert.equal(p.nodes.get("#album-count").textContent, "7");
  const set = p.json('filteredAlbums().find(a => a.id === "71")');
  assert.equal(set.track_count, 6);
  assert.equal(set.discs.length, 3);
  assert.equal(set.year, 0, "One disc without a year makes the set miss a year");
  p.nodes.get("#filter").value = "year";
  assert.ok(p.json("filteredAlbums().map(a => a.id)").includes("71"));
  p.nodes.get("#filter").value = "all";
  await p.nodes.get("#all-albums").emit("click");
  const card = p.nodes.get("#albums").innerHTML.match(/<article[^]*?<\/article>/g).find(html => html.includes('data-album="71"'));
  assert.match(card, /6 tracks · album · <span class="disc-icons" role="img" aria-label="3 discs"/);
  assert.equal(card.match(/<span class="disc-icons"[^]*?<\/span>/)[0].match(/<svg/g).length, 3, "One CD icon per disc");
  assert.match(p.run("discIcons(9)"), /<small>9<\/small>/);
  assert.equal(p.run("discIcons(9)").match(/<svg/g).length, 6);
  assert.equal(p.json("artistGroups()").find(([name]) => name === "Pink Floyd")[1].count, 3);
});

test("the album page of a set lists every disc and plays them as one album", async () => {
  const p = setPage();
  await settle();
  p.run('state.mode = "live"');
  await p.click({"[data-album]": {dataset: {album: "72"}}});
  assert.equal(p.run("albumView.id"), "71", "Any disc opens the set under its first disc");
  assert.equal(p.location.hash, "#/album/71");
  const html = p.nodes.get("#album-page").innerHTML;
  assert.match(html, /Year unknown · 6 tracks · <span class="disc-icons" role="img" aria-label="3 discs"[^]*<\/span> · 6:00/);
  assert.match(html, /Disc 1<\/span>[\s\S]*Part 1\.2[\s\S]*Disc 3<\/span>[\s\S]*Part 3\.2/);
  assert.equal((html.match(/class="disc-gap"/g) || []).length, 2, "Space between the discs, not above the first");
  assert.ok(html.indexOf('class="disc-gap"') > html.indexOf("Part 1.2"));
  assert.match(html, /data-edit-album="71,72,73">Edit</);
  assert.match(html, /data-edit-album="73">Edit disc 3/);
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "71"}}});
  assert.equal(p.run("player.queue.length"), 6);
  p.run("player.index = 1; playCurrent()");
  await p.nodes.get("#audio").emit("ended");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/7201?quality=128", "Playback continues on the next disc");
});

test("a set is edited as one album and saved per disc", async () => {
  const p = setPage();
  await p.click({"[data-edit-album]": {dataset: {editAlbum: "71,72,73"}}});
  assert.equal(p.run("editing.set"), true);
  assert.equal(p.run("editing.bulk"), false);
  const html = p.nodes.get("#editor-content").innerHTML;
  assert.match(html, /ONE ALBUM \/ ALL 3 DISCS/);
  assert.doesNotMatch(html, /name="disc"/, "One disc number for every disc would break the set");
  assert.match(html, /name="year"[^>]*value=""/);
  assert.match(html, /Disc 2<\/td>/);
  p.nodes.get("#metadata-form").elements = {namedItem: name => name === "year" ? {type: "number", value: "1980", disabled: false} : null};
  p.run('editing.dirty.add("year"); buildReview()');
  assert.equal(p.run("pending.scope"), "album");
  assert.deepEqual(p.json('pending.changes.filter(c => c.kind === "album").map(c => [String(c.id), c.label, c.fields.year.after])'),
    [["71", "The Wall · Disc 1", 1980], ["72", "The Wall · Disc 2", 1980], ["73", "The Wall · Disc 3", 1980]]);
  p.run("applyDraft()");
  assert.equal(p.json('filteredAlbums().find(a => a.id === "71")').year, 1980);
});

test("one disc can still be edited on its own, and opens the whole set from there", async () => {
  const p = setPage();
  await p.run('openEditor(["72"])');
  assert.equal(p.run("editing.set"), false);
  const html = p.nodes.get("#editor-content").innerHTML;
  assert.match(html, /name="disc"/);
  assert.match(html, /Disc 2 of 3/);
  p.nodes.get("#editor").close();
  await p.click({"[data-edit-set]": {dataset: {editSet: "72"}}});
  assert.deepEqual(p.json("editing.ids"), ["71", "72", "73"]);
  assert.equal(p.run("state.artist"), null, "Editing the set does not leave the page you are on");
});

test("selecting a set selects all its discs; a selection with two discs of a set hides the disc number", async () => {
  const p = setPage();
  p.run('setArtist("Pink Floyd")');
  await p.change({matches: s => s === "[data-select]", checked: true, dataset: {select: "71"}});
  assert.deepEqual(p.json("[...state.selected]"), ["71", "72", "73"]);
  assert.equal(p.nodes.get("#selection-count").textContent, "1 album selected · Pink Floyd");
  await p.run('openEditor([...state.selected, "1"])');
  assert.equal(p.run("editing.bulk"), true);
  assert.doesNotMatch(p.nodes.get("#editor-content").innerHTML, /name="disc"/);
  p.nodes.get("#editor").close();
  await p.change({matches: s => s === "[data-select]", checked: false, dataset: {select: "71"}});
  assert.equal(p.run("state.selected.size"), 0);
});

test("Next album goes from the album before a set to the whole set, and on past it", async () => {
  const p = setPage();
  assert.equal(p.run('nextAlbumId("2")'), "71");
  assert.equal(p.run('nextAlbumId("73")'), "1");
  await p.run('openEditor(["2"])');
  await p.click({"#next-album": {}});
  assert.deepEqual(p.json("editing.ids"), ["71", "72", "73"]);
});

test("a set gets one cover: uploaded once, then put on every disc, each with its own History entry", async () => {
  const p = setPage();
  const posts = [];
  let fail = 0;
  p.setFetch(async (url, options) => {
    if (url.startsWith("/api/artwork/related")) return {ok: true, json: async () => ({artwork: []})};
    if (url === "/api/artwork") {
      const body = JSON.parse(options.body);
      posts.push(body);
      if (fail && posts.length === fail) return {ok: false, status: 502, json: async () => ({error: "iBroadcast did not answer."})};
      const previous = {tracks: Object.fromEntries(Object.keys(body.before.tracks).map(id => [id, 0]))};
      return {ok: true, json: async () => ({artwork_id: 555, image: "https://example.test/555-300", job: `job-${body.id}`, note: "", previous,
        results: [{kind: "album", id: body.id, label: body.label, fields: ["cover"], status: "sent"}]})};
    }
    return {ok: true, json: async () => ({state: "checking"})};
  });
  p.run('state.mode = "live"');
  await p.run('openEditor(["71", "72", "73"])');
  assert.match(p.nodes.get("#editor-content").innerHTML, /id="change-cover"/);
  p.run("openArtwork(albumArtTarget()); choose(addOption({url: 'https://example.test/wall.jpg', thumb: 'x', source: 'Your address'}))");
  assert.match(p.nodes.get("#artwork-content").innerHTML, /on all 3 discs/);
  fail = 2;
  await p.run("saveArtwork()");
  assert.match(p.nodes.get("#art-status").innerHTML, /1 of 3 discs have the new cover/);
  assert.equal(p.nodes.get("#art-save").textContent, "Save the other discs");
  fail = 0;
  await p.run("saveArtwork()");
  assert.deepEqual(posts.map(b => [b.id, b.source]), [
    ["71", {url: "https://example.test/wall.jpg"}], ["72", {artwork_id: 555}], ["72", {artwork_id: 555}], ["73", {artwork_id: 555}]]);
  assert.deepEqual(p.json("state.history.map(h => h.artwork.label)"), ["The Wall · Disc 3", "The Wall · Disc 2", "The Wall · Disc 1"]);
  assert.deepEqual(p.json('["71", "72", "73"].map(id => state.details.get(id).artwork)'), Array(3).fill("https://example.test/555-300"));
  assert.match(p.nodes.get("#toast").textContent, /Cover saved on all 3 discs/);
});

test("you choose how many albums and album artists a page shows, and Tagcast remembers it", async () => {
  const storage = {};
  const p = page({storage});
  p.run(`state.albums = Array.from({length: 230}, (_, i) => ({...state.albums[0], id: String(i), artist: "Artist " + String(i).padStart(3, "0")}));
    setArtist(null)`);
  assert.equal(p.nodes.get("#per-page").value, "24", "Covers show 24 until you choose");
  assert.equal((p.nodes.get("#albums").innerHTML.match(/<article/g) || []).length, 24);
  p.run("state.page = 4; render()");
  p.nodes.get("#per-page").value = "50";
  await p.nodes.get("#per-page").emit("change", {target: p.nodes.get("#per-page")});
  assert.equal((p.nodes.get("#albums").innerHTML.match(/<article/g) || []).length, 50);
  assert.equal(p.run("state.page"), 1, "Album 97 of the old page 5 is on the new page 2");
  assert.match(p.nodes.get("#pagination").innerHTML, /Page 2 of 5/);
  await p.click({"[data-view]": {dataset: {view: "list"}}});
  assert.equal(p.nodes.get("#per-page").value, "50", "The choice holds for the list too");
  p.run("showArtistBrowse()");
  assert.equal((p.nodes.get("#artists-grid").innerHTML.match(/data-browse-artist=/g) || []).length, 24);
  p.nodes.get("#artists-per-page").value = "200";
  await p.nodes.get("#artists-per-page").emit("change", {target: p.nodes.get("#artists-per-page")});
  assert.equal((p.nodes.get("#artists-grid").innerHTML.match(/data-browse-artist=/g) || []).length, 200);
  assert.deepEqual([storage["tagcast-per-page"], storage["tagcast-artists-per-page"]], ["50", "200"]);
  const again = page({storage});
  assert.equal(again.run("pageSize()"), 50);
  assert.equal(again.run("artistBrowse.pageSize"), 200);
});

test("Duplicate badges mark repeated numbers; extra-copy selection requires matching titles per disc", async () => {
  const p = page();
  p.run(`const album = state.details.get("5"); album.tracks.push(
      {...album.tracks[2], id: 599, title: " TEARDROP "},
      {...album.tracks[2], id: 598, track: 17},
      {...album.tracks[2], id: 597, title: "Different song"},
      {id: 596, title: "Unknown", track: 0}, {id: 595, title: "Unknown"});
    state.albums = [...state.details.values()].map(summarize); render()`);
  p.nodes.get("#filter").value = "duplicates";
  assert.deepEqual(p.json("filteredAlbums().map(a => String(a.id))"), ["5"]);
  await p.run('openAlbum("5")');
  assert.equal((p.nodes.get("#album-page").innerHTML.match(/>Duplicated</g) || []).length, 3, "Every repeated position is marked, including a different title");
  assert.deepEqual(p.json('extraCopies([state.details.get("5")])'), ["599"], "Reprises and missing numbers are not selected");
  const sets = setPage();
  sets.run(`state.details.get("72").tracks.push({...state.details.get("72").tracks[0], id: 7299});
    state.details.get("73").tracks[0].title = "Part 2.1";
    state.albums = [...state.details.values()].map(summarize)`);
  assert.equal(sets.json('albumShelf().find(a => a.id === "71")').duplicates, 1, "A set adds up its discs");
  assert.deepEqual(sets.json('extraCopies([state.details.get("72"), state.details.get("73")])'), ["7299"], "Separate discs stay separate");
});

test("Quote variants agree across duplicate filters, badges and extra-copy selection", async () => {
  const p = page();
  const plain = "Red Shoes (from the Dumplin' Original Motion Picture Soundtrack)";
  const quoted = 'Red Shoes (from the "Dumplin\'" Original Motion Picture Soundtrack)';
  const curly = "Red Shoes (from the “Dumplin’” Original Motion Picture Soundtrack)";
  p.run(`useLocal([{id: 91, name: "Dumplin'", artist: "Dolly Parton", disc: 1, year: 2018,
    tracks: [
      {id: 941, title: ${JSON.stringify(plain)}, track: 4},
      {id: 942, title: ${JSON.stringify(quoted)}, track: 4},
      {id: 943, title: ${JSON.stringify(curly)}, track: 4},
      {id: 944, title: ${JSON.stringify(plain)}, track: 17},
      {id: 945, title: ${JSON.stringify(plain + " (Live)")}, track: 4}
    ]}], "demo"); render()`);
  p.nodes.get("#filter").value = "duplicates";
  assert.deepEqual(p.json("filteredAlbums().map(a => a.id)"), ["91"]);
  assert.equal(p.run('state.albums[0].duplicates'), 2);
  await p.run('openAlbum("91")');
  assert.equal((p.nodes.get("#album-page").innerHTML.match(/>Duplicated</g) || []).length, 4);
  assert.deepEqual(p.json('extraCopies([state.details.get("91")])'), ["942", "943"]);
  assert.deepEqual(p.json('state.details.get("91").tracks.slice(0, 3).map(t => t.title)'), [plain, quoted, curly]);
  for (const [first, second] of [["Song (Live)", "Song"], ["Song (Radio Edit)", "Song"],
    ["Song (Parts I–V)", "Song (Parts VI–IX)"], ["Rock & Roll", "Rock Roll"]]) {
    assert.notEqual(p.run(`titleKey(${JSON.stringify(first)})`), p.run(`titleKey(${JSON.stringify(second)})`));
  }
  assert.equal(p.run('duplicateTrackKey({track: 4, title: "\\\"\\\""})'), "", "Quote-only titles are not matched");
});

test('Repeated track numbers find soundtrack title variants, while extra-copy selection keeps different titles', async () => {
  const p = page(); await settle();
  const first = 'Sous le soleil exactement', second = "C'est la cristallisation comme dit Stendhal";
  const tracks = [
    {id: 901, title: first, artist: 'Michel Colombier', track: 1},
    {id: 902, title: first, artist: 'Anna Karina', track: 2},
    {id: 903, title: first + ' (Bande originale de la comédie musicale télévisée "Anna")', artist: 'Anna Karina', track: 2},
    {id: 904, title: second, artist: 'Serge Gainsbourg', track: 3},
    {id: 905, title: second + ' (BOF "Anna")', artist: 'Serge Gainsbourg', track: 3},
    {id: 906, title: 'Pas mal pas mal du tout', track: 4},
    {id: 907, title: 'Pas mal pas mal du tout', track: 4},
    {id: 908, title: first, track: 17},
    {id: 909, title: 'Unknown', track: 0}, {id: 910, title: 'Unknown'}];
  const album = {id: 91, name: 'Anna', artist: 'Serge Gainsbourg', disc: 1, year: 1967, tracks};
  p.run(`useLocal([${JSON.stringify(album)}], "live"); playTracks(state.details.get("91")); render()`);
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  const summary = p.json('state.albums[0]'), detail = p.json('state.details.get("91")');
  assert.deepEqual([summary.repeated_numbers, summary.duplicates], [3, 1]);
  p.run('state.details = new Map()'); // The live album list has summaries only.
  const before = p.requests.length;
  p.nodes.get('#filter').value = 'duplicates'; p.run('render()');
  assert.deepEqual(p.json('filteredAlbums().map(a => a.id)'), ['91']);
  assert.equal(p.requests.length, before, 'Finding candidates never downloads album tracks');
  assert.match(p.nodes.get('#page-subtitle').textContent, /repeated track numbers/);
  p.setFetch(url => {
    assert.equal(url, '/api/albums?ids=91');
    return {ok: true, json: async () => ({albums: [detail]})};
  });
  await p.run('openAlbum("91")');
  const html = p.nodes.get('#album-page').innerHTML;
  assert.equal((html.match(/>Duplicated</g) || []).length, 6);
  assert.equal((html.match(/title="This track number occurs more than once/g) || []).length, 4);
  assert.equal((html.match(/title="This track number and title occur more than once/g) || []).length, 2);
  assert.doesNotMatch(html.match(/<tr data-row="901"[\s\S]*?<\/tr>/)[0], /duplicate|Duplicate/,
    'The same title at another track number is not flagged');
  await p.click({'[data-trash-start]': {}});
  await p.click({'[data-trash-duplicates]': {}});
  assert.deepEqual(p.json('[...albumView.trash]'), ['907'], 'Only the matching title is preselected');
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.equal(p.requests.filter(r => r.options?.method === 'POST').length, 0);
  assert.deepEqual(p.json('state.details.get("91").tracks.map(t => t.title)'), tracks.map(t => t.title));
});

test('Repeated track-number counts stay per disc when albums are merged', () => {
  const p = setPage();
  p.run('state.albums = [...state.details.values()].map(summarize)');
  p.nodes.get('#filter').value = 'duplicates';
  assert.deepEqual(p.json('filteredAlbums().map(a => a.id)'), []);
  p.run(`state.details.get("72").tracks.push({...state.details.get("72").tracks[0], id: 7299, title: "Different title"});
    state.albums = [...state.details.values()].map(summarize)`);
  assert.deepEqual(p.json('filteredAlbums().map(a => a.id)'), ['71']);
  assert.deepEqual(p.json('[(albumShelf().find(a => a.id === "71")).repeated_numbers, (albumShelf().find(a => a.id === "71")).duplicates]'), [1, 0]);
  assert.deepEqual(p.json('extraCopies([state.details.get("72"), state.details.get("73")])'), []);
});

test('Native combined sets retain original disc boundaries for duplicate badges and selection', async () => {
  const p = page(); await settle();
  p.run(`useLocal([{id: 91, name: "Combined set", artist: "Artist", year: 1970, disc: 1,
    tracks: [{id: 1, album_id: "81", track: 1, title: "Same title"},
             {id: 2, album_id: "82", track: 1, title: "Same title"}]}], "demo"); render()`);
  p.nodes.get('#filter').value = 'duplicates';
  assert.deepEqual(p.json('filteredAlbums().map(a => a.id)'), []);
  await p.run('openAlbum("91")');
  assert.doesNotMatch(p.nodes.get('#album-page').innerHTML, />Duplicated</);
  assert.deepEqual(p.json('extraCopies([state.details.get("91")])'), []);
  p.run(`state.details.get("91").tracks.push({id: 3, album_id: "82", track: 1, title: "Different title"});
    state.albums = [...state.details.values()].map(summarize); render()`);
  assert.deepEqual(p.json('filteredAlbums().map(a => a.id)'), ['91']);
  assert.equal((p.nodes.get('#album-page').innerHTML.match(/>Duplicated</g) || []).length, 2);
  assert.deepEqual(p.json('extraCopies([state.details.get("91")])'), []);
});

test('The album overview and track rows mark repeated numbers with the same Duplicated label', async () => {
  const p = page(); await settle();
  p.run(`useLocal([{id: 91, name: "Listen", artist: "A Flock of Seagulls", year: 1983, disc: 1,
    tracks: [{id: 901, album_id: "91", track: 9, title: "The Fall", genre: "Pop"},
             {id: 902, album_id: "91", track: 10, title: "(It's Not Me) Talking", genre: "Pop"},
             {id: 903, album_id: "91", track: 10, title: "(It's Not Me) Talking (Single Edit)", genre: "Pop"}]},
    {id: 92, name: "No duplicates", artist: "Artist", year: 1980, disc: 1,
     tracks: [{id: 904, track: 1, title: "Same title"}, {id: 905, track: 2, title: "Same title"}]}], "live"); render()`);
  const detail = p.json('state.details.get("91")');
  p.run('state.details = new Map()');
  const before = p.requests.length;
  assert.equal((p.nodes.get('#albums').innerHTML.match(/>Duplicated</g) || []).length, 1,
    'The unfiltered overview marks candidates using compact summaries only');
  p.nodes.get('#filter').value = 'duplicates'; p.run('render()');
  assert.deepEqual(p.json('filteredAlbums().map(a => a.id)'), ['91']);
  assert.equal((p.nodes.get('#albums').innerHTML.match(/>Duplicated</g) || []).length, 1);
  p.run('state.view = "list"; render()');
  assert.equal((p.nodes.get('#albums').innerHTML.match(/>Duplicated</g) || []).length, 1);
  assert.equal(p.requests.length, before, 'Grid, list and filtering never download track details');
  assert.match(p.run('duplicateAlbumBadge({duplicates: 1})'), />Duplicated</,
    'Older compact summaries still mark known candidates');
  p.setFetch(url => {
    assert.equal(url, '/api/albums?ids=91');
    return {ok: true, json: async () => ({albums: [detail]})};
  });
  await p.run('openAlbum("91")');
  const html = p.nodes.get('#album-page').innerHTML;
  for (const id of [902, 903]) assert.match(html.match(new RegExp(`<tr data-row="${id}"[\\s\\S]*?<\\/tr>`))[0], />Duplicated</);
  assert.doesNotMatch(html.match(/<tr data-row="901"[\s\S]*?<\/tr>/)[0], />Duplicated</);
  assert.deepEqual(p.json('extraCopies([state.details.get("91")])'), [],
    'Marking a different version does not automatically select it for removal');
  assert.equal(p.requests.filter(r => r.options?.method === 'POST').length, 0);
});

test("Overview artist-image health opens only the missing album artists and preserves paging, history and playback", async () => {
  const p = livePage(); await settle();
  p.run(`playTracks(state.details.get("1"));
    state.albums = Array.from({length: 273}, (_, i) => ({...state.albums[0], id: String(i + 1000),
      artist: (i < 72 ? "Missing " : "With image ") + String(i).padStart(3, "0"),
      artist_image: i < 72 ? "" : "https://example.test/photo"}));
    state.albums.push({...state.albums[0], id: "2000", artist: "Various Artists", artist_image: ""});
    $("#artists-search").value = "With image"; $("#artists-filter").value = "all";
    artistBrowse.page = 8; $("#artists-sort").value = "za";
    $("#filter").value = "cover"; $("#search").value = "stale album search"; state.artist = "Stale artist"`);
  const stats = {health: {artist_image: {missing: 72, total: 273}}, formats: [], uploads: [],
    top_tracks: [], top_albums: [], top_artists: []};
  p.setFetch(url => {
    assert.equal(url, '/api/overview');
    return {ok: true, json: async () => ({account: {preferences: {}, linked: {}}, stats})};
  });
  p.run('showScreen("overview")'); await settle();
  assert.match(p.nodes.get('#overview-page').innerHTML, /72 album artists without an image/);
  assert.match(p.nodes.get('#overview-page').innerHTML, /data-health="artist_image">Show album artists →/);
  const source = p.nodes.get('#audio').src, queue = p.json('player.queue'), requests = p.requests.length;
  await p.click({'[data-health]': {dataset: {health: 'artist_image'}}});
  assert.equal(p.run('state.screen'), 'artists');
  assert.equal(p.location.hash, '#/artists');
  assert.equal(p.nodes.get('#artists-filter').value, 'no_image');
  assert.equal(p.nodes.get('#artists-search').value, '');
  assert.equal(p.run('artistBrowse.page'), 0);
  assert.equal(p.nodes.get('#artists-results').textContent, '72 album artists');
  assert.equal(p.run('filteredArtistGroups().length'), 72);
  assert.doesNotMatch(p.nodes.get('#artists-grid').innerHTML, /With image|Various Artists|<img/);
  assert.equal(p.requests.length, requests, 'Filtering uses existing summaries without fetching tracks');
  await p.click({'[data-artist-page]': {dataset: {artistPage: '1'}}});
  await p.click({'[data-browse-artist]': {dataset: {browseArtist: 'Missing 040'}}});
  assert.equal(p.run('state.artist'), 'Missing 040');
  assert.equal(p.nodes.get('#filter').value, 'all', 'Opening an artist shows all of their albums');
  assert.equal(p.nodes.get('#results-count').textContent, '1 album by Missing 040');
  p.history.back(); await settle();
  assert.equal(p.location.hash, '#/artists');
  assert.equal(p.run('artistBrowse.page'), 1);
  assert.equal(p.nodes.get('#artists-filter').value, 'no_image');
  assert.equal(p.nodes.get('#artists-results').textContent, '72 album artists');
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.requests.length, requests);
});

test("other Overview health links keep opening their matching album filters", async () => {
  const p = page(); await settle();
  p.run('state.screen = "overview"; state.artist = "Pink Floyd"; state.page = 5; $("#search").value = "stale search"; syncHistory()');
  await p.click({'[data-health]': {dataset: {health: 'genre'}}});
  assert.equal(p.run('state.screen'), 'albums');
  assert.equal(p.location.hash, '#/albums');
  assert.equal(p.run('state.artist'), null);
  assert.equal(p.nodes.get('#filter').value, 'genre');
  assert.equal(p.nodes.get('#search').value, '');
  assert.equal(p.run('state.page'), 0);
});

test("Album artists can show only the artists without an image", async () => {
  const p = livePage();
  p.run("showArtistBrowse()");
  assert.equal((p.nodes.get("#artists-grid").innerHTML.match(/data-browse-artist=/g) || []).length, 3);
  p.nodes.get("#artists-filter").value = "no_image";
  await p.nodes.get("#artists-filter").emit("change");
  assert.match(p.nodes.get("#artists-grid").innerHTML, /data-browse-artist="Massive Attack"/);
  assert.equal((p.nodes.get("#artists-grid").innerHTML.match(/data-browse-artist=/g) || []).length, 1);
  assert.equal(p.run("history.state.artistsFilter"), "no_image", "Back brings the filter back");
});

test("tracks go to the trash only after a review, and duplicates can be picked for it", async () => {
  const p = page();
  const posts = [];
  p.setFetch(async (url, options) => {
    if (url === "/api/trash") {
      const body = JSON.parse(options.body);
      posts.push(body);
      return {ok: true, json: async () => ({job: "job-1", results: body.tracks.map(t => ({kind: "track", id: t.id, label: t.title, fields: ["trash"], status: "sent"}))})};
    }
    return {ok: true, json: async () => ({state: "checking"})};
  });
  p.run(`const album = state.details.get("5"); album.tracks.push({...album.tracks[2], id: 599, title: "Teardrop"});
    state.albums = [...state.details.values()].map(summarize); state.mode = "live"`);
  await p.run('openAlbum("5")');
  assert.match(p.nodes.get("#album-page").innerHTML, /data-album-more/);
  assert.doesNotMatch(p.nodes.get("#album-page").innerHTML, /Move to trash/);
  assert.doesNotMatch(p.nodes.get("#album-page").innerHTML, /data-trash-track/, "No checkboxes until you ask for them");
  await p.click({"[data-trash-start]": {}});
  assert.match(p.nodes.get("#album-page").innerHTML, /0 of 12 tracks selected/);
  await p.click({"[data-trash-duplicates]": {}});
  assert.deepEqual(p.json("[...albumView.trash]"), ["599"], "The first copy stays");
  await p.change({matches: s => s === "[data-trash-track]", checked: true, dataset: {trashTrack: "500"}});
  assert.match(p.nodes.get("#album-page").innerHTML, /2 of 12 tracks selected/);
  assert.equal(posts.length, 0);
  await p.click({"[data-trash-review]": {}});
  assert.equal(p.nodes.get("#trash-review").open, true);
  const review = p.nodes.get("#trash-content").innerHTML;
  assert.match(review, /Angel[\s\S]*Teardrop/);
  assert.match(review, /Move 2 tracks to the trash/);
  assert.equal(posts.length, 0, "Nothing is sent before you confirm");
  await p.click({"#trash-confirm": {}});
  assert.deepEqual(posts[0].tracks.map(t => [t.id, t.album_id]), [["500", "5"], ["599", "5"]]);
  assert.equal(p.run('state.details.get("5").tracks.length'), 10);
  assert.equal(p.run('state.albums.find(a => a.id === "5").duplicates'), 0);
  assert.equal(p.run("state.history[0].trash"), true);
  assert.equal(p.run("albumView.trash"), null);
  assert.doesNotMatch(p.nodes.get("#album-page").innerHTML, /data-trash-track/);
});

test('Trash suggestions group two complete uploads and prefer older FLAC over newer MP3 without selecting or writing', async () => {
  const p = page(); await settle();
  const tracks = Array.from({length: 10}, (_, i) => [
    {id: `old-${i}`, album_id: '91', track: i + 1, title: `Song ${i + 1}`, artist: 'Artist', length: 180 + i,
      format: 'FLAC', uploaded_at: '2022-04-05T09:45:47'},
    {id: `new-${i}`, album_id: '91', track: i + 1, title: `Song ${i + 1} (Remastered Version)`, artist: 'Artist', length: 180 + i,
      format: 'MP3', uploaded_at: '2026-09-23T22:48:19'},
  ]).flat();
  p.run(`useLocal([{id: 91, name: "Two uploads", artist: "Artist", year: 1980, disc: 1,
    tracks: ${JSON.stringify(tracks)}}], "live"); playTracks(state.details.get("91")); render()`);
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src, count = p.requests.length;
  const original = p.json('state.details.get("91").tracks');
  await p.run('openAlbum("91")');
  await p.click({'[data-trash-start]': {}});
  assert.deepEqual(p.json('[...albumView.trash]'), [], 'Opening only presents the proposal');
  assert.deepEqual(p.json('trashSuggestion(albumDiscs()).remove'), tracks.filter(t => t.format === 'MP3').map(t => t.id));
  let html = p.nodes.get('#album-page').innerHTML;
  assert.match(html, /2022-04-05<\/td><td>FLAC<\/td><td>10<\/td><td>1, 2, 3, 4, 5, 6, 7, 8, 9, 10/);
  assert.match(html, /2026-09-23<\/td><td>MP3<\/td><td>10<\/td>/);
  assert.equal((html.match(/>Suggested keep</g) || []).length, 10);
  assert.equal((html.match(/>Suggested trash</g) || []).length, 10);
  assert.match(html, /Titles differ; compare versions before confirming/);
  assert.match(html, /Uploaded 2022-04-05 09:45:47/);
  p.run('$("#album-page .trash-upload-groups").open = true');
  await p.click({'[data-trash-suggested]': {}});
  assert.match(p.nodes.get('#album-page').innerHTML, /class="trash-upload-groups" open/);
  assert.equal(p.run('document.activeElement === $("[data-trash-suggested]")'), true);
  assert.deepEqual(p.json('[...albumView.trash]'), tracks.filter(t => t.format === 'MP3').map(t => t.id));
  assert.match(p.nodes.get('#album-page').innerHTML, /10 of 20 tracks selected/);
  await p.click({'[data-trash-review]': {}});
  html = p.nodes.get('#trash-content').innerHTML;
  assert.match(html, /Move 10 tracks to the trash/);
  assert.match(html, /MP3.*Uploaded 2026-09-23 22:48:19/);
  assert.doesNotMatch(html, /2022-04-05|old-0/);
  assert.ok(p.requests.slice(count).every(r=>r.url.startsWith('/api/album-guide/album?')||r.url.startsWith('/api/lyrics/cache?')), 'Only album opening checks local text; suggestions never fetch audio/details or write');
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.deepEqual(p.json('state.details.get("91").tracks'), original);
});

test('Trash suggestions use the newest upload within one format and preserve unresolved versions and disc boundaries', () => {
  const p = page();
  const base = {album_id: '91', track: 1, title: 'Song', artist: 'Artist', length: 180, format: 'FLAC', uploaded_at: '2026-10-15T10:00:00'};
  const propose = copies => p.json(`trashSuggestion([{tracks:${JSON.stringify(copies)}}]).remove`);
  assert.deepEqual(propose([{...base,id:'old'}, {...base,id:'new',uploaded_at:'2026-10-15T11:00:00'}]), ['old']);
  assert.deepEqual(propose([{...base,id:'old'}, {...base,id:'new',uploaded_at:'2026-10-16'}]), ['old']);
  assert.deepEqual(propose([{...base,id:'old',format:'MP3'}, {...base,id:'new',uploaded_at:'2026-10-16'}]), ['old']);
  assert.deepEqual(propose([{...base,id:'first'}, {...base,id:'second'}]), [], 'Equal timestamps need a manual decision');
  for (const patch of [{length:240}, {artist:'Other artist'}, {format:''}, {format:'AAC/ALAC'},
    {uploaded_at:''}, {uploaded_at:'2026-02-30'}, {uploaded_at:'2026-10-15'}, {track:2}, {track:0}, {album_id:'92'}]) {
    assert.deepEqual(propose([{...base,id:'first'}, {...base,...patch,id:'second'}]), [], JSON.stringify(patch));
  }
  assert.deepEqual(p.json(`trashSuggestion([{tracks:[${JSON.stringify({...base,id:'first'})}]},
    {tracks:[${JSON.stringify({...base,id:'second',uploaded_at:'2026-10-16'})}]}]).remove`), [], 'Separate discs stay separate');
  assert.deepEqual(propose([{...base,id:'flac-1'}, {...base,id:'flac-2'}, {...base,id:'mp3',format:'MP3'}]), ['mp3'],
    'Equivalent FLAC candidates both stay; only the lower-priority MP3 is proposed');
});

test("Tracks searches every track by title, artist, album or composer and opens its album with the track marked", async () => {
  const p = page();
  await settle();
  await p.nodes.get("#show-tracks").emit("click");
  assert.equal(p.run("state.screen"), "tracks");
  assert.equal(p.location.hash, "#/tracks");
  assert.equal(p.nodes.get("#tracks-page").hidden, false);
  assert.match(p.nodes.get("#tracks-list").innerHTML, /at least two letters/);
  const search = async query => {
    p.nodes.get("#tracks-search").value = query;
    await p.nodes.get("#tracks-search").emit("input");
    p.flushTimers(250);
    await settle();
  };
  await search("kate LOVE");  // artist and album, or artist and title
  assert.equal(p.nodes.get("#tracks-results").textContent, "13 tracks");
  const list = p.nodes.get("#tracks-list").innerHTML;
  assert.ok(list.indexOf("Running Up That Hill") < list.indexOf("All the Love"), "Album by album");
  await search("dreaming houdíni");  // accents don't count
  assert.equal(p.nodes.get("#tracks-results").textContent, "1 track");
  assert.match(p.nodes.get("#tracks-list").innerHTML, /data-track-open="408" data-track-album="4"[\s\S]*Track 9/);
  assert.match(p.nodes.get("#tracks-list").innerHTML, /data-track-play="408"[^>]*disabled/, "The demo cannot play");
  await search("nothing like this");
  assert.match(p.nodes.get("#tracks-list").innerHTML, /No tracks match “nothing like this”/);
  await search("houdini");
  await p.click({"[data-track-open]": {dataset: {trackOpen: "408", trackAlbum: "4"}}});
  assert.equal(p.run("state.screen"), "album");
  assert.match(p.nodes.get("#album-page").innerHTML, /data-row="408" class="found"/);
  assert.equal((p.nodes.get("#album-page").innerHTML.match(/class="found"/g) || []).length, 1);
  assert.match(p.nodes.get("#breadcrumb").innerHTML, /Tracks/);
  await p.click({"[data-album-crumb]": {dataset: {albumCrumb: "0"}}});
  assert.equal(p.run("state.screen"), "tracks");
  assert.equal(p.nodes.get("#tracks-search").value, "houdini", "Back brings the search back");
  assert.match(p.nodes.get("#tracks-list").innerHTML, /Houdini/);
  await p.run('openAlbum("4")');
  assert.doesNotMatch(p.nodes.get("#album-page").innerHTML, /class="found"/, "Opened another way, nothing is marked");
});

test("Tracks only adds a scroll-region Tab stop when it overflows, without moving focus", async () => {
  const p = page(); await settle();
  await p.nodes.get("#show-tracks").emit("click");
  const list = p.nodes.get("#tracks-list"), search = p.nodes.get("#tracks-search");
  search.focus();
  const requests = p.requests.length, hash = p.location.hash;
  for (const [width, content, expected] of [[365, 680, "0"], [921, 921, "-1"],
                                          [474, 680, "0"], [365, 365, "-1"],
                                          [0, 680, "-1"]]) {
    list.clientWidth = width; list.scrollWidth = content;
    p.run("renderTrackSearch()");
    assert.equal(list.getAttribute("tabindex"), expected);
    assert.equal(p.run("document.activeElement"), search);
  }
  list.focus(); list.clientWidth = list.scrollWidth = 921;
  p.run("updateTrackSearchScrollFocus()");
  assert.equal(list.getAttribute("tabindex"), "-1");
  assert.equal(p.run("document.activeElement"), list, "Resize must not steal existing focus");
  assert.equal(p.requests.length, requests, "Focus updates make no requests");
  assert.equal(p.location.hash, hash, "Focus updates do not navigate");
});

test("a connected library is searched by the server, and a found track plays its album from there", async () => {
  const storage = {};
  const p = page({storage});
  const asked = [];
  const found = Array.from({length: 120}, (_, i) => ({id: i ? String(9000 + i) : "101", album_id: "1", title: i ? `Other ${i}` : "Welcome to the Machine",
    artist: "Pink Floyd", composers: i ? [] : ["Roger Waters"], album: "Wish You Were Here", disc: 1, track: 2, year: 1975, length: 451}));
  p.setFetch(async url => {
    asked.push(url);
    return {ok: true, json: async () => url.startsWith("/api/tracks") ? {tracks: found, total: 1500} : {state: "checking"}};
  });
  p.run('state.mode = "live"');
  p.nodes.get("#tracks-search").value = "welcome machine";
  p.run("showTracks()");
  await settle();
  assert.deepEqual(asked.filter(u => u.startsWith("/api/tracks")), ["/api/tracks?q=welcome%20machine"]);
  assert.equal(p.nodes.get("#tracks-results").textContent, "1,500 tracks · showing the first 120. Add a word to narrow it down.");
  assert.equal((p.nodes.get("#tracks-list").innerHTML.match(/<tr data-row=/g) || []).length, 50);
  assert.match(p.nodes.get("#tracks-list").innerHTML, /Pink Floyd · Roger Waters[\s\S]*7:31/);
  assert.match(p.nodes.get("#tracks-pagination").innerHTML, /Page 1 of 3/);
  p.nodes.get("#tracks-per-page").value = "100";
  await p.nodes.get("#tracks-per-page").emit("change", {target: p.nodes.get("#tracks-per-page")});
  assert.equal((p.nodes.get("#tracks-list").innerHTML.match(/<tr data-row=/g) || []).length, 100);
  assert.equal(storage["tagcast-tracks-per-page"], "100");
  await p.click({"[data-track-play]": {dataset: {trackPlay: "101", trackAlbum: "1"}}});
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101?quality=128");
  assert.equal(p.run("player.album.name"), "Wish You Were Here");
  assert.equal(p.run("player.queue.length"), 5, "The rest of the album follows");
  await p.click({"[data-track-play]": {dataset: {trackPlay: "101", trackAlbum: "1"}}});
  assert.equal(p.nodes.get("#audio").paused, true, "The same track pauses");
  p.setFetch(async () => ({ok: false, status: 404, json: async () => ({error: "Unknown endpoint."})}));
  p.nodes.get("#tracks-search").value = "angel";
  await p.run("runTrackSearch()");
  assert.match(p.nodes.get("#tracks-list").innerHTML, /Restart Tagcast to search tracks/, "An older running server says what to do");
});


test("all four browse overviews open matching albums in preview without downloading tracks or writing", async () => {
  const p = page(); await settle();
  p.run('state.details.get("1").tracks[0].composers = ["Björk"]; state.details.get("1").tracks[0].composer_ids = [55]');
  for (const [kind, key, album] of [["track-artists", "name:Pink Floyd", "1"], ["composers", "55", "1"],
    ["genres", "progressive rock", "1"], ["years", "1982", "4"]]) {
    p.run(`showBrowse(${JSON.stringify(kind)})`); await settle();
    assert.ok(p.run("browseView.total") > 0);
    await p.click({"[data-browse-key]": {dataset: {browseKey: key, browseLabel: key}}}); await settle();
    assert.match(p.nodes.get("#browse-list").innerHTML, new RegExp(`data-album="${album}"`));
    assert.doesNotMatch(p.nodes.get("#browse-list").innerHTML, /data-track-play|data-select/);
    assert.equal(p.run("state.screen"), "browse");
    await p.click({"[data-album]": {dataset: {album}}});
    assert.equal(p.location.hash, `#/album/${album}`);
    p.history.back(); await settle();
    assert.equal(p.location.hash, `#/${kind}/${encodeURIComponent(key)}`);
  }
  assert.ok(p.requests.every(r => ["/api/status", "/api/settings", "/api/updates"].includes(r.url)), JSON.stringify(p.requests));
});

test("genre links preserve combined labels and Back returns from albums to the genre selection", async () => {
  const p = page(); await settle();
  p.run('state.details.get("1").tracks[0].genres = ["Pop;Rock", "<Genre>"]; state.albums = [...state.details.values()].map(summarize)');
  await p.run('openAlbum("1")');
  const html = p.nodes.get("#album-page").innerHTML;
  assert.match(html, /data-browse-key="pop;rock"/);
  assert.match(html, /data-browse-key="&lt;genre&gt;"/);
  await p.click({"[data-browse-kind]": {dataset: {browseKind: "genres", browseKey: "pop;rock", browseLabel: "Pop;Rock"}}});
  assert.equal(p.location.hash, "#/genres/pop%3Brock");
  assert.equal(p.run("browseView.total"), 1);
  assert.match(p.nodes.get("#browse-list").innerHTML, /data-album="1"/);
  p.history.back(); await settle();
  assert.equal(p.location.hash, "#/album/1");
});

test("browse groups keep multi-disc sets together even when only one disc matches", async () => {
  const p = page(); await settle();
  p.run(`const set = [{id: "201", name: "Set", artist: "Duo", disc: 1, year: 2000, tracks: [{id: "2010", title: "One", artist: "Singer A", year: 2000, genre: "Rock", track: 1}]},
    {id: "202", name: "Set", artist: "Duo", disc: 2, year: 2000, tracks: [{id: "2020", title: "Two", artist: "Singer B", year: 2000, genre: "Jazz", track: 1}]}]; useLocal(set, "demo"); showBrowse("genres", "jazz")`);
  assert.equal(p.run("browseView.total"), 1);
  assert.match(p.nodes.get("#browse-list").innerHTML, /data-album="201"/);
  await p.click({"[data-album]": {dataset: {album: "201"}}});
  assert.match(p.nodes.get("#album-page").innerHTML, /Disc 1/);
  assert.match(p.nodes.get("#album-page").innerHTML, /Disc 2/);
});

test("browse album search, sort and pagination stay local and restore on Back", async () => {
  const p = livePage(); await settle();
  p.run('state.albums = Array.from({length: 70}, (_, i) => ({...state.albums[0], id: String(i + 1), name: `Album ${String(i).padStart(2, "0")}`}))');
  p.setFetch(url => {
    const params = new URL(url, "http://localhost").searchParams;
    assert.equal(params.get("key"), "7");
    return {ok: true, json: async () => ({group: {key: "7", label: "Composer"}, album_ids: p.json('state.albums.map(a => a.id)')})};
  });
  p.run('showBrowse("composers", "7", {page: 1, sort: "title_za"})'); await settle();
  assert.equal(p.run("browseView.page"), 1, "Loading does not reset a restored album page");
  assert.match(p.nodes.get("#browse-list").innerHTML, /Album 45/);
  const before = p.requests.length;
  await p.nodes.get("#browse-sort").emit("change", {target: {value: "title"}});
  await p.click({"[data-browse-page]": {dataset: {browsePage: "1"}}});
  assert.equal(p.run("browseView.page"), 1);
  assert.equal(p.requests.length, before, "Sorting and paging loaded album summaries need no API call");
  p.run('$("#browse-search").value = "Album"'); await p.nodes.get("#browse-search").emit("input");
  // Navigate before the debounce runs: Back must still remember the typed query.
  await p.run('openAlbum("1")'); p.history.back(); await settle();
  assert.equal(p.nodes.get("#browse-search").value, "Album");
  assert.equal(p.run("browseView.sort"), "title");
  assert.equal(p.nodes.get("#browse-sort").value, "title");
  assert.equal(p.run("browseView.total"), 70);
});

test("browse overview server paging and accent search survive Back and stale responses cannot replace a new library", async () => {
  const p = livePage(); await settle();
  let finish;
  p.setFetch(url => {
    const params = new URL(url, "http://localhost").searchParams;
    if (params.get("key")) return {ok: true, json: async () => ({group: {key: "55", label: "Björk"}, album_ids: ["1"]})};
    return {ok: true, json: async () => ({groups: [{key: "55", label: "Björk", image: "", tracks: 5}], total: 80, count: 80, offset: Number(params.get("offset"))})};
  });
  p.run('showBrowse("composers")'); await settle();
  await p.click({"[data-browse-page]": {dataset: {browsePage: "1"}}});
  assert.match(p.requests.at(-1).url, /offset=24/);
  await p.click({"[data-browse-key]": {dataset: {browseKey: "55", browseLabel: "Björk"}}});
  await p.run('openAlbum("1")'); p.history.back(); await settle(); p.history.back(); await settle();
  assert.equal(p.run("browseView.page"), 1);
  p.run('$("#browse-search").value = "bjork"'); await p.nodes.get("#browse-search").emit("input"); p.flushTimers(250); await settle();
  assert.match(p.requests.at(-1).url, /q=bjork/);
  p.setFetch(() => new Promise(resolve => { finish = resolve; }));
  const pending = p.run('loadBrowse()');
  p.run('useLocal(demoLibrary(), "demo"); showBrowse("years")');
  finish({ok: true, json: async () => ({groups: [{key: "55", label: "OLD ACCOUNT", image: "", tracks: 5}], total: 1, offset: 0})});
  await pending;
  assert.equal(p.run("browseView.kind"), "years");
  assert.doesNotMatch(p.nodes.get("#browse-list").innerHTML, /OLD ACCOUNT/);
});

test("browse deep links work in previews, escape group names and handle an older server", async () => {
  const p = page({hash: "#/genres/progressive%20rock"}); await settle();
  assert.equal(p.run("state.screen"), "browse"); assert.equal(p.run("browseView.total"), 2);
  const live = livePage(); await settle();
  live.setFetch(() => ({ok: true, json: async () => ({groups: [{key: "1", label: "<script>bad</script>", image: "", tracks: 1}], total: 1, offset: 0})}));
  live.run('showBrowse("composers")'); await settle();
  assert.match(live.nodes.get("#browse-list").innerHTML, /&lt;script&gt;bad/);
  assert.doesNotMatch(live.nodes.get("#browse-list").innerHTML, /<script>/);
  live.setFetch(() => ({ok: false, status: 404, json: async () => ({error: "Old server"})}));
  live.run('showBrowse("genres")'); await settle();
  assert.match(live.nodes.get("#browse-list").innerHTML, /Restart Tagcast/);
});

test("opening a browse overview while the library loads searches the finished library", async () => {
  const p = livePage(); await settle();
  p.setFetch(() => ({ok: true, json: async () => ({groups: [{key: "1", label: "Loaded artist", image: "", tracks: 4}], total: 1, offset: 0})}));
  p.run('state.loading = true; showBrowse("track-artists")');
  const before = p.requests.length;
  assert.match(p.nodes.get("#browse-list").innerHTML, /Loading your collection/);
  p.run('state.loading = false; render()'); await settle();
  assert.equal(p.requests.length, before + 1);
  assert.match(p.nodes.get("#browse-list").innerHTML, /Loaded artist/);
});

test("browse counts include albums for all four groups and count a disc set once", async () => {
  const p = page(); await settle();
  p.run(`useLocal([{id: "201", name: "Set", artist: "Duo", disc: 1, year: 2000,
    tracks: [{id: "2010", title: "One", artist: "Singer", artist_id: 9, year: 2000, genres: ["Rock"], composers: ["Writer"], composer_ids: [55], track: 1}]},
    {id: "202", name: "Set", artist: "Duo", disc: 2, year: 2000,
    tracks: [{id: "2020", title: "Two", artist: "Singer", artist_id: 9, year: 2000, genres: ["Rock", "Jazz"], composers: ["Writer"], composer_ids: [55], track: 1}]}], "demo")`);
  // Totals use the compact summaries even when no track details are available.
  const requests = p.requests.length;
  p.run('const countDetails = state.details; state.details = new Map(); state.artist = "Duo"; state.screen = "albums"; state.mode = "live"; render()');
  assert.equal(p.nodes.get("#total-albums").textContent, "1");
  assert.equal(p.nodes.get("#total-tracks").textContent, "2 tracks");
  assert.doesNotMatch(p.nodes.get("#artist-panel").innerHTML, /artist-meta|tracks<|albums?</, "Artist header keeps only the photo; counts remain above the album list");
  assert.equal(p.requests.length, requests, "Headers never download track details to count them");
  p.run('state.details = countDetails; state.artist = null; state.mode = "demo"');
  for (const [kind, key] of [["genres", "rock"], ["track-artists", "9"], ["composers", "55"], ["years", "2000"]]) {
    p.run(`showBrowse(${JSON.stringify(kind)})`); await settle();
    assert.equal(p.run(`browseView.rows.find(g => g.key === ${JSON.stringify(key)}).albums`), 1);
    assert.match(p.nodes.get("#browse-list").innerHTML, /class="artist-card-count">1 album<\/span><small class="artist-card-tracks">2 tracks<\/small>/);
  }
  p.run('showBrowse("genres")'); await settle();
  assert.match(p.nodes.get("#browse-list").innerHTML, /class="artist-card-count">1 album<\/span><small class="artist-card-tracks">1 track<\/small>/);
  p.run('state.albums = state.albums.map(a => ({...a, disc: 1})); resetBrowse(); showBrowse("genres")'); await settle();
  assert.match(p.nodes.get("#browse-list").innerHTML, /class="artist-card-count">2 albums<\/span><small class="artist-card-tracks">2 tracks<\/small>/, "Duplicate disc numbers stay separate");
  const live = livePage(); await settle();
  live.setFetch(() => ({ok: true, json: async () => ({groups: [{key: "x", label: "Rock", tracks: 5000, albums: 1234}], total: 1, offset: 0})}));
  live.run('showBrowse("genres")'); await settle();
  assert.match(live.nodes.get("#browse-list").innerHTML, /class="artist-card-count">1,234 albums<\/span><small class="artist-card-tracks">5,000 tracks<\/small>/);
});

test("sidebar account status is compact, safe and preserves preview and snapshot explanations", async () => {
  const p = page(); await settle();
  p.run('state.connection = {connected: true, account: "<Cyberdelia>"}; state.mode = "live"; updateChrome()');
  assert.equal(p.nodes.get("#connection-title").textContent, "<Cyberdelia> · iBroadcast");
  assert.equal(p.nodes.get("#connection-text").hidden, true);
  assert.equal(p.nodes.get("#connection-text").textContent, "");
  assert.equal(p.nodes.get("#connection-title").innerHTML, "", "Account names are never parsed as markup");
  p.run('state.mode = "demo"; updateChrome()');
  assert.equal(p.nodes.get("#connection-title").textContent, "<Cyberdelia> · Snapshot");
  assert.equal(p.nodes.get("#connection-text").hidden, false);
  assert.match(p.nodes.get("#connection-text").textContent, /Reload your library/);
  p.run('state.connection.connected = false; updateChrome()');
  assert.equal(p.nodes.get("#connection-title").textContent, "Preview workspace");
  assert.match(p.nodes.get("#connection-text").textContent, /Edits stay in this browser tab/);
});

test("mobile menu toggles without history entries, closes on selection and Escape returns focus", async () => {
  const p = page(); await settle();
  const before = p.history.length;
  await p.nodes.get("#menu-toggle").emit("click");
  assert.equal(p.nodes.get("#menu-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(p.nodes.get("#sidebar").classList.contains("menu-open"), true);
  assert.equal(p.history.length, before);
  await p.keydown("Escape");
  assert.equal(p.nodes.get("#menu-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(p.run('document.activeElement === $("#menu-toggle")'), true);
  await p.nodes.get("#menu-toggle").emit("click");
  await p.click({"[data-browse-kind]": {dataset: {browseKind: "genres"}}});
  await p.nodes.get("#sidebar-menu").emit("click", {target: {closest: () => ({})}});
  assert.equal(p.location.hash, "#/genres");
  assert.equal(p.history.length, before + 1, "Only the selected page adds an entry");
  assert.equal(p.nodes.get("#menu-toggle").getAttribute("aria-expanded"), "false");
  await p.nodes.get("#menu-toggle").emit("click");
  await p.nodes.get("#show-history").emit("click");
  await p.nodes.get("#sidebar-menu").emit("click", {target: {closest: () => ({})}});
  assert.equal(p.nodes.get("#history").open, true, "History remains a dialog");
  assert.equal(p.nodes.get("#sidebar").classList.contains("menu-open"), false);
  assert.equal(p.history.length, before + 1);
});

test("update notifications use the running server's version, open only on request and keep safe release links", async () => {
  const p = page(); await settle();
  assert.equal(p.requests.filter(r => r.url === "/api/updates").length, 1, "Startup checks without an iBroadcast account");
  assert.equal(p.nodes.get("#update-button").hidden, true);
  const albums = p.json("state.albums"), before = p.history.length;
  p.setUpdateFetch(() => ({ok: true, json: async () => ({current: "0.10.2", latest: "0.11.0", available: true,
    state: "available", auto_updates: true, name: "<New release>", url: "javascript:bad"})}));
  await p.run("checkForUpdates(true)");
  assert.equal(p.nodes.get("#update-button").textContent, "Update available · 0.11.0");
  assert.equal(p.nodes.get("#update-button").hidden, false);
  assert.notEqual(p.run('$("#updates").open'), true, "A background check never opens a dialog");
  assert.equal(p.requests.at(-1).url, "/api/updates/check");
  assert.equal(p.requests.at(-1).options.headers["X-Tagcast"], "1");
  assert.equal(p.requests.at(-1).options.body, "{}", "No account or library data in the manual request");
  await p.nodes.get("#update-button").emit("click");
  assert.equal(p.nodes.get("#updates").open, true);
  assert.match(p.nodes.get("#updates-content").innerHTML, /running 0\.10\.2/);
  assert.match(p.nodes.get("#updates-content").innerHTML, /&lt;New release&gt;/);
  assert.match(p.nodes.get("#updates-content").innerHTML, /https:\/\/github.com\/cyberdeliaAI\/tagcast\/releases\/tag\/v0.11.0/);
  assert.doesNotMatch(p.nodes.get("#updates-content").innerHTML, /javascript:/);
  assert.deepEqual(p.json("state.albums"), albums);
  assert.equal(p.history.length, before, "Update details are a dialog, not a page");
});

test("update failures and an older server do not claim success or disturb playback", async () => {
  const p = page(); await settle();
  p.run('$("#audio").src = "/api/stream/1?quality=128"; $("#audio").paused = false');
  p.setUpdateFetch(() => ({ok: false, status: 404, json: async () => ({error: "Unknown endpoint"})}));
  await p.run("checkForUpdates(true)");
  assert.match(p.run("updateStatusText()"), /Restart Tagcast/);
  assert.equal(p.nodes.get("#update-button").hidden, true);
  p.setUpdateFetch(() => { throw Error("Offline"); });
  await p.run("checkForUpdates(true)");
  assert.match(p.run("updateStatusText()"), /Could not check/);
  assert.doesNotMatch(p.run("updateStatusText()"), /up to date/);
  assert.equal(p.nodes.get("#audio").src, "/api/stream/1?quality=128");
  assert.equal(p.nodes.get("#audio").paused, false);
  const filePreview = page({server: false}); await settle();
  assert.ok(filePreview.requests.every(r => r.url !== "/api/updates"), "Opening HTML without the server does not check GitHub");
});

test("update checks cannot overlap or overwrite a newer saved automatic-check preference", async () => {
  const p = page(); await settle();
  let finish;
  p.setUpdateFetch(() => new Promise(resolve => { finish = resolve; }));
  const request = p.run("checkForUpdates(true)");
  const count = p.requests.length;
  await p.run("checkForUpdates(true)");
  assert.equal(p.requests.length, count);
  assert.equal(p.nodes.get("#check-updates").disabled, true);
  p.run('applyUpdateSettings({auto_updates:false})');
  finish({ok: true, json: async () => ({current: "0.10.1", latest: "0.10.1", available: false, state: "current", auto_updates: true})});
  await request;
  assert.equal(p.run("updateNotice.automatic"), false);
  assert.equal(p.nodes.get("#check-updates").disabled, false);
});

test("update preferences share the settings save without changing source lookup options", async () => {
  const p = page(); await settle();
  p.run('lookup.sources = [{name:"musicbrainz",label:"MusicBrainz",enabled:true}]; lookup.auto = true; openSettings()');
  assert.match(p.nodes.get("#settings-content").innerHTML, /name="auto_updates" checked/);
  assert.match(p.nodes.get("#settings-content").innerHTML, /Check for updates/);
  const bodies = [];
  p.setFetch((url, options) => {
    assert.equal(url, "/api/settings");
    bodies.push(JSON.parse(options.body));
    return {ok: true, json: async () => ({sources: [{name:"musicbrainz",label:"MusicBrainz",enabled:true}], auto_lookup: true, auto_updates: false})};
  });
  await p.run('saveSettings({elements:{auto_lookup:{checked:true},auto_updates:{checked:false}},querySelectorAll:()=>[]})');
  assert.deepEqual(bodies, [{auto_lookup: true, auto_updates: false}]);
  assert.equal(p.run("lookup.auto"), true);
  assert.equal(p.run("updateNotice.automatic"), false);
  p.run("openSettings()");
  assert.doesNotMatch(p.nodes.get("#settings-content").innerHTML, /name="auto_updates" checked/);
});

test("queue appends albums and single tracks without interrupting audio, and changes album metadata at the boundary", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), "100")');
  const oldSrc = p.nodes.get("#audio").src;
  await p.run('addToQueue("2", "200")');
  assert.equal(p.nodes.get("#audio").src, oldSrc);
  assert.equal(p.run('player.queue.at(-1).id'), "200");
  assert.equal(p.run('String(player.queue.at(-1).album.id)'), "2");
  await p.run('addToQueue("2")');
  assert.equal(p.run('player.queue.length'), 16);
  p.run('player.index = 4; playCurrent(); step(1)');
  assert.equal(p.run('String(player.album.id)'), "2");
  assert.equal(p.nodes.get("#player-album").textContent, p.run('state.details.get("2").name'));
  assert.equal(p.nodes.get("#player-artist").textContent, p.run('state.details.get("2").artist'));
  assert.equal(p.requests.filter(r => r.options?.method === "POST").length, 0);
});

test("Settings opt into play recording, keep source options, and do not restart audio", async () => {
  const p = livePage(); await settle();
  p.run('lookup.sources = [{name:"musicbrainz",label:"MusicBrainz",enabled:true}]; state.connection.playback_session="session-123"; playTracks(state.details.get("1")); openSettings()');
  const source = p.nodes.get("#audio").src;
  assert.match(p.nodes.get("#settings-content").innerHTML, /name="record_plays" > Record played tracks/);
  const bodies = [];
  p.setFetch((url, options) => {
    assert.equal(url, "/api/settings"); bodies.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({sources:[{name:"musicbrainz",label:"MusicBrainz",enabled:true}],auto_lookup:true,auto_updates:true,record_plays:true})};
  });
  await p.run('saveSettings({elements:{auto_lookup:{checked:true},auto_updates:{checked:true},record_plays:{checked:true}},querySelectorAll:()=>[]})');
  assert.deepEqual(bodies, [{auto_lookup:true,auto_updates:true,record_plays:true}]);
  assert.equal(p.run("playReporting.enabled"), true);
  assert.equal(p.nodes.get("#audio").src, source);
  assert.equal(p.nodes.get("#audio").paused, false);
  p.run("openSettings()");
  assert.match(p.nodes.get("#settings-content").innerHTML, /name="record_plays" checked/);
});

test("play recording counts actual listening across pauses and seeks, once per play", async () => {
  const p = livePage(); await settle();
  const sent = [];
  p.setFetch((url, options) => {
    assert.equal(url, "/api/play"); sent.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({status:"sent"})};
  });
  p.run('state.connection.playback_session="session-123"; audio.currentTime=0; playTracks(state.details.get("1"))');
  p.setPlaybackClock(20000); p.run('audio.currentTime=20'); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(sent.length, 0, "Default remains off even after twenty seconds");
  p.run('applyPlaybackSettings({record_plays:true})');
  await p.nodes.get("#audio").emit("playing");
  p.setPlaybackClock(25000); p.run('audio.currentTime=25'); await p.nodes.get("#audio").emit("pause");
  p.setPlaybackClock(75000); await p.nodes.get("#audio").emit("playing");
  p.setPlaybackClock(76000); p.run('audio.currentTime=140; audio.seeking=true'); await p.nodes.get("#audio").emit("seeking");
  await p.nodes.get("#audio").emit("timeupdate");
  p.run('audio.seeking=false'); await p.nodes.get("#audio").emit("seeked");
  p.setPlaybackClock(81000); p.run('audio.currentTime=145'); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(sent.length, 0, "Exactly ten seconds, pauses and seek jumps are not plays");
  p.setPlaybackClock(81500); p.run('audio.currentTime=145.5'); await p.nodes.get("#audio").emit("timeupdate");
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].listened, 10.5);
  assert.equal(sent[0].session, "session-123");
  assert.equal(sent[0].track_id, "100");
  assert.ok(sent[0].event_id.length >= 16);
  p.setPlaybackClock(83000); p.run('audio.currentTime=147'); await p.nodes.get("#audio").emit("timeupdate");
  await p.nodes.get("#audio").emit("pause"); await p.nodes.get("#audio").emit("playing");
  assert.equal(sent.length, 1, "Pause/resume and more progress do not repeat a play");
  p.run('step(1); audio.currentTime=0'); await p.nodes.get("#audio").emit("playing");
  p.setPlaybackClock(94500); p.run('audio.currentTime=11.5'); await p.nodes.get("#audio").emit("timeupdate");
  await settle();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].event_id, sent[1].event_id);
  assert.equal(sent[1].track_id, "101");
});

test("stalls, session/library changes and disabling prevent unwanted play reports", async () => {
  const p = livePage(); await settle();
  p.run('state.connection.playback_session="session-123"; applyPlaybackSettings({record_plays:true}); audio.currentTime=0; playTracks(state.details.get("1"))');
  await p.nodes.get("#audio").emit("playing");
  p.setPlaybackClock(20000); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(p.run("playReporting.watch.listened"), 0, "A stalled position adds no listening time");
  p.run('state.connection.playback_session="new-session"; audio.currentTime=21');
  p.setPlaybackClock(41000); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(p.run("playReporting.watch"), null);
  p.run('playTracks(state.details.get("1")); audio.currentTime=0'); await p.nodes.get("#audio").emit("playing");
  p.run('state.details = new Map(state.details); audio.currentTime=21');
  p.setPlaybackClock(62000); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(p.run("playReporting.watch"), null);
  p.run('playTracks(state.details.get("1")); applyPlaybackSettings({record_plays:false}); audio.currentTime=100');
  await p.nodes.get("#audio").emit("timeupdate");
  p.run('stopPlayer()');
  assert.ok(!p.requests.some(r => r.url === "/api/play"));
});

test("a failed play report is never repeated and playback continues", async () => {
  const p = livePage(); await settle();
  p.setFetch(() => { throw Error("Lost reply"); });
  p.run('state.connection.playback_session="session-123"; applyPlaybackSettings({record_plays:true}); audio.currentTime=0; playTracks(state.details.get("1"))');
  const source = p.nodes.get("#audio").src;
  await p.nodes.get("#audio").emit("playing");
  p.setPlaybackClock(11000); p.run('audio.currentTime=11'); await p.nodes.get("#audio").emit("timeupdate");
  await settle();
  p.setPlaybackClock(22000); p.run('audio.currentTime=22'); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(p.requests.filter(r => r.url === "/api/play").length, 1);
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.nodes.get("#audio").src, source);
  assert.match(p.run("playReporting.error"), /Lost reply/);
});

test("playback rate uses listening time and replaying a completed track counts a new play", async () => {
  const p = livePage(); await settle();
  const sent = [];
  p.setFetch((url, options) => { sent.push(JSON.parse(options.body)); return {ok:true,json:async()=>({status:"sent"})}; });
  p.run('state.connection.playback_session="session-123"; applyPlaybackSettings({record_plays:true}); audio.currentTime=0; audio.playbackRate=2; playTracks(state.details.get("1"), "104")');
  await p.nodes.get("#audio").emit("playing");
  const source = p.nodes.get("#audio").src;
  p.setPlaybackClock(5000); p.run('audio.currentTime=10'); await p.nodes.get("#audio").emit("timeupdate");
  assert.equal(sent.length, 0, "Ten media seconds at twice the speed are only five listening seconds");
  p.setPlaybackClock(11000); p.run('audio.currentTime=22'); await p.nodes.get("#audio").emit("timeupdate");
  p.setPlaybackClock(15000); p.run('audio.currentTime=30'); await p.nodes.get("#audio").emit("ended");
  p.run('audio.currentTime=0'); await p.nodes.get("#audio").emit("playing");
  p.setPlaybackClock(26000); p.run('audio.currentTime=22'); await p.nodes.get("#audio").emit("timeupdate");
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].track_id, sent[1].track_id);
  assert.notEqual(sent[0].event_id, sent[1].event_id);
  assert.equal(p.nodes.get("#audio").src, source);
});

test("a late initial settings response cannot undo a newly saved playback preference", async () => {
  const p = livePage(); await settle();
  p.run('lookup.sources=[{name:"musicbrainz",label:"MusicBrainz",enabled:true}]');
  let finish;
  p.setFetch((url, options) => options?.body
    ? {ok:true,json:async()=>({sources:[{name:"musicbrainz",label:"MusicBrainz",enabled:true}],auto_lookup:true,auto_updates:true,record_plays:true})}
    : new Promise(resolve=>{finish=resolve;}));
  const pending = p.run("loadSettings()");
  await p.run('saveSettings({elements:{auto_lookup:{checked:true},auto_updates:{checked:true},record_plays:{checked:true}},querySelectorAll:()=>[]})');
  finish({ok:true,json:async()=>({sources:[],record_plays:false})});
  await pending;
  assert.equal(p.run("lookup.recordPlays"), true);
  assert.equal(p.run("playReporting.enabled"), true);
});

test("the library info banner can be hidden, remembered and restored without requests or stopping audio", async () => {
  const storage = {}, p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); updateChrome()');
  const source = p.nodes.get("#audio").src, requests = p.requests.length;
  await p.nodes.get("#notice-dismiss").emit("click");
  assert.equal(p.nodes.get("#library-notice").hidden, true);
  p.run('updateChrome(); openSettings()');
  assert.equal(p.nodes.get("#library-notice").hidden, true);
  assert.match(p.nodes.get("#settings-content").innerHTML, /Show library information banner/);
  await p.click({"[data-show-notice]": {}});
  assert.equal(p.nodes.get("#library-notice").hidden, false);
  assert.equal(p.nodes.get("#audio").src, source);
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.requests.length, requests);
  const saved = page({storage}); await settle();
  await saved.nodes.get("#notice-dismiss").emit("click");
  const reopened = page({storage}); await settle(); reopened.run("updateChrome()");
  assert.equal(reopened.nodes.get("#library-notice").hidden, true);
  assert.equal(reopened.run("libraryNotice.visible"), false);
  const html = readFileSync(path.join(staticDir, "index.html"), "utf8");
  assert.match(html, /id="settings-button">Settings</);
  assert.match(html, /<h2>Settings<\/h2>/);
});

test("compact player display choices act independently without changing playback, queue or full metadata views", async () => {
  const p = livePage(); await settle();
  p.run(`state.connection.premium = true; state.connection.playback_session = "display-test-session";
    const displayAlbum = state.details.get("1");
    displayAlbum.tracks[0].format = "FLAC"; displayAlbum.tracks[0].artist = "Guest Artist";
    displayAlbum.tracks[1].artist = "Second Guest";
    lookup.streamQuality = "orig"; applyPlaybackSettings({record_plays:true});
    playTracks(displayAlbum, "100"); audio.currentTime = 24; const displayWatch = playReporting.watch; openSettings()`);
  const source = p.nodes.get("#audio").src, queue = p.json("player.queue"), epoch = p.run("player.epoch"), requests = p.requests.length;
  assert.match(p.nodes.get("#settings-content").innerHTML, /data-player-display="quality" checked/);
  assert.match(p.nodes.get("#settings-content").innerHTML, /data-player-display="track-artists" checked/);
  const toggle = (key, checked) => p.change({dataset:{playerDisplay:key}, checked, matches: selector => selector === "[data-player-display]"});
  await toggle("quality", false);
  assert.equal(p.nodes.get("#player-quality").hidden, true);
  assert.equal(p.nodes.get("#player-track-line").hidden, false);
  await toggle("quality", true); await toggle("track-artists", false);
  assert.equal(p.nodes.get("#player-quality").hidden, false);
  assert.equal(p.nodes.get("#player-track-line").hidden, true);
  await toggle("quality", false);
  assert.equal(p.nodes.get("#audio").src, source);
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.nodes.get("#audio").currentTime, 24);
  assert.equal(p.run("playReporting.watch === displayWatch"), true);
  assert.equal(p.run("player.epoch"), epoch);
  assert.deepEqual(p.json("player.queue"), queue);
  assert.equal(p.requests.length, requests, "Interface choices are not sent to the server");
  assert.equal(p.nodes.get("#player-title").textContent, p.run("displayAlbum.tracks[0].title"));
  assert.equal(p.nodes.get("#player-artist").textContent, "Pink Floyd");
  assert.equal(p.nodes.get("#player-album").textContent, "Wish You Were Here");
  p.run('$("#settings").close(); openVisualPlayer()');
  assert.equal(p.nodes.get("#visual-player-quality").textContent, "File: FLAC · Stream: Original FLAC");
  assert.equal(p.nodes.get("#visual-player-track-artist").textContent, "Track artist: Guest Artist");
  assert.equal(p.nodes.get("#visual-player-track-artist").hidden, false);
  await p.run("closeVisualPlayer(); openAlbum('1')");
  assert.match(p.nodes.get("#album-page").innerHTML, /Guest Artist/);
  assert.match(p.nodes.get("#album-page").innerHTML, /FLAC/);
  await p.nodes.get("#audio").emit("error");
  assert.match(p.nodes.get("#player-quality").textContent, /fallback/);
  assert.equal(p.nodes.get("#player-quality").hidden, true, "A stream fallback keeps the display preference");
  p.run("step(1)");
  assert.equal(p.nodes.get("#player-title").textContent, p.run("displayAlbum.tracks[1].title"));
  assert.equal(p.nodes.get("#player-quality").hidden, true);
  assert.equal(p.nodes.get("#player-track-line").hidden, true, "The next track does not restore hidden info");
  await toggle("track-artists", true);
  assert.equal(p.nodes.get("#player-track-line").hidden, false);
  assert.equal(p.nodes.get("#player-track-artist").textContent, "Second Guest");
  await toggle("quality", true);
  assert.equal(p.nodes.get("#player-quality").hidden, false);
});

test("compact player choices survive reloads and work when browser storage is unavailable", async () => {
  const storage = {}, p = page({storage}); await settle();
  const toggle = (page, key, checked) => page.change({dataset:{playerDisplay:key}, checked, matches: selector => selector === "[data-player-display]"});
  await toggle(p, "quality", false);
  assert.equal(storage["tagcast-player-quality"], "hidden");
  assert.equal(storage["tagcast-player-track-artists"], undefined);
  const reopened = page({storage}); await settle();
  reopened.run(`state.mode="live"; state.details.get("1").tracks[0].artist="Guest Artist";
    playTracks(state.details.get("1"), "100"); openSettings()`);
  assert.equal(reopened.nodes.get("#player-quality").hidden, true);
  assert.equal(reopened.nodes.get("#player-track-line").hidden, false);
  assert.match(reopened.nodes.get("#settings-content").innerHTML, /data-player-display="quality" >/);
  assert.match(reopened.nodes.get("#settings-content").innerHTML, /data-player-display="track-artists" checked/);
  await toggle(reopened, "track-artists", false);
  const bothHidden = page({storage}); await settle();
  bothHidden.run("openSettings()");
  assert.match(bothHidden.nodes.get("#settings-content").innerHTML, /data-player-display="track-artists" >/);
  assert.equal(bothHidden.run("playerDisplay.quality"), false);
  assert.equal(bothHidden.run("playerDisplay.trackArtists"), false);
  bothHidden.run('localStorage.setItem = () => { throw Error("Storage unavailable"); }');
  await toggle(bothHidden, "quality", true);
  assert.equal(bothHidden.run("playerDisplay.quality"), true);
  assert.equal(bothHidden.nodes.get("#player-quality").hidden, false);
  bothHidden.run('localStorage.getItem = () => { throw Error("Storage unavailable"); }');
  assert.equal(bothHidden.run('storedPlayerDisplay("quality")'), true);
});

test("Now playing escapes metadata and has no route, queue jumping works, and Clear queue stops everything", async () => {
  const p = livePage(); await settle();
  p.run('$("#now-playing-panel").hidden = true');
  p.run('state.details.get("1").tracks[0].title = "<script>unsafe</script>"; playTracks(state.details.get("1"), "100")');
  const length = p.history.length;
  await p.nodes.get("#player-queue").emit("click");
  assert.equal(p.nodes.get("#now-playing-panel").hidden, false);
  assert.match(p.nodes.get("#now-playing-current").innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(p.nodes.get("#now-playing-list").innerHTML, /<script>/);
  assert.equal(p.history.length, length);
  await p.click({"[data-queue-index]": {dataset: {queueIndex: "1"}}});
  assert.equal(p.run("player.index"), 1);
  await p.nodes.get("#queue-clear").emit("click");
  assert.equal(p.run("player.queue.length"), 0);
  assert.equal(p.nodes.get("#audio").paused, true);
  assert.equal(p.nodes.get("#audio").src, undefined);
  assert.match(p.nodes.get("#now-playing-current").innerHTML, /add an album/);
  assert.equal(p.nodes.get("#queue-clear").disabled, true);
  await p.keydown("Escape");
  assert.equal(p.nodes.get("#now-playing-panel").hidden, true);
});

function queueRemoveControl(p, index) {
  p.run(`$("#test-queue-remove").dataset = {queueRemove: ${JSON.stringify(String(index))}, queueRevision: String(nowPlayingRows.revision)}`);
  return p.nodes.get("#test-queue-remove");
}

test("queue removal targets one occurrence and preserves the current audio, position and listening watch", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); appendToQueue(state.details.get("1")); player.index = 1; playCurrent(); setNowPlaying(true); audio.currentTime = 42; playReporting.watch = {test: "unchanged"}');
  const audio = p.nodes.get("#audio"), source = audio.src;
  const current = p.run('player.queue[player.index].id'), before = p.json('player.queue.map(t => t.id)');
  const history = p.history.length, requests = p.requests.length;
  const control = queueRemoveControl(p, 0);
  await p.click({"[data-queue-remove]": control, "[data-queue-index]": {dataset: {queueIndex: "0"}}});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), before.slice(1));
  assert.equal(p.run('player.index'), 0);
  assert.equal(p.run('player.queue[player.index].id'), current);
  assert.equal(audio.src, source);
  assert.equal(audio.currentTime, 42);
  assert.equal(audio.paused, false);
  assert.deepEqual(p.json('playReporting.watch'), {test: "unchanged"});
  const repeated = p.run('player.queue.findIndex((t, i) => i > player.index && t.id === player.queue[0].id)');
  assert.ok(repeated > 0);
  await p.click({"[data-queue-remove]": queueRemoveControl(p, repeated)});
  assert.equal(p.run('player.queue.filter(t => t.id === player.queue[0].id).length'), 1);
  assert.equal(audio.src, source);
  assert.equal(audio.currentTime, 42);
  assert.equal(p.history.length, history);
  assert.equal(p.requests.length, requests, 'Removing a loaded queue entry neither reads nor writes metadata');
});

test("removing the current queue position advances once and keeps paused playback paused", async () => {
  for (const paused of [false, true]) {
    const p = livePage(); await settle();
    p.run('playTracks(state.details.get("1")); setNowPlaying(true)');
    const next = p.run('player.queue[1].id');
    if (paused) p.nodes.get('#audio').pause();
    await p.click({"[data-queue-remove]": queueRemoveControl(p, 0)});
    assert.equal(p.run('player.index'), 0);
    assert.equal(p.run('player.queue[0].id'), next);
    assert.match(p.nodes.get('#audio').src, new RegExp(`/api/stream/${next}\\?`));
    assert.equal(p.nodes.get('#audio').paused, paused);
    assert.equal(p.nodes.get('#player-title').textContent, p.run('player.queue[0].title'));
    assert.equal(p.run('player.queue.length'), p.run('state.details.get("1").tracks.length - 1'));
  }
});

test("removing the last current entry stops audio while retaining earlier queue entries and repeat cannot revive it", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); player.index = player.queue.length - 1; playCurrent(); player.repeat = "queue"; setNowPlaying(true)');
  const original = p.json('player.queue.map(t => t.id)');
  await p.click({"[data-queue-remove]": queueRemoveControl(p, original.length - 1)});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), original.slice(0, -1));
  assert.equal(p.run('player.index'), original.length - 2);
  const source = p.nodes.get('#audio').src;
  assert.match(source, new RegExp(`/api/stream/${original.at(-2)}\\?`));
  assert.equal(p.nodes.get('#audio').paused, true);
  assert.equal(p.nodes.get('#player').hidden, false, 'The queue must remain reachable from the compact player');
  assert.equal(p.run('playReporting.watch'), null);
  assert.equal(p.run('encodedLocalQueue().current_song'), Number(original.at(-2)));
  assert.equal(p.run('encodedLocalQueue().pause'), true);
  assert.equal(p.run('encodedLocalQueue().data.play_index'), original.length - 2);
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.nodes.get('#audio').src, source, 'A late ended event must not restart the paused retained queue');
  assert.equal(p.nodes.get('#audio').paused, true);
  p.run('applyQueueSettings({queue_sync:false})');
  assert.equal(p.nodes.get('#player').hidden, false);
  p.run('setNowPlaying(false); setNowPlaying(true)');
  assert.equal(p.nodes.get('#now-playing-panel').hidden, false);
  await p.click({"[data-queue-index]": {dataset: {queueIndex: "0"}}});
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.equal(p.run('player.queue[player.index].id'), original[0]);
  p.run('player.queue = player.queue.slice(0, 1); player.index = 0; setNowPlaying(true)');
  await p.click({"[data-queue-remove]": queueRemoveControl(p, 0)});
  assert.equal(p.run('player.queue.length'), 0);
  assert.equal(p.nodes.get('#queue-clear').disabled, true);
  assert.equal(p.run('document.activeElement === $("#now-playing-close")'), true);
});

test("queue removal preserves Up next ordering and its separate native queue encoding", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); appendToQueue(state.details.get("2"), null, true); setNowPlaying(true)');
  const base = p.json('encodedLocalQueue().tracks'), next = p.json('encodedLocalQueue().play_next');
  await p.click({"[data-queue-remove]": queueRemoveControl(p, 1)});
  assert.deepEqual(p.json('encodedLocalQueue().tracks'), base);
  assert.deepEqual(p.json('encodedLocalQueue().play_next'), next.slice(1));
  p.run('step(1)');
  assert.equal(p.run('Number(player.queue[player.index].id)'), next[1]);
  assert.equal(p.run('player.queue[player.index].upNext'), true);
  await p.click({"[data-queue-remove]": queueRemoveControl(p, p.run('player.index'))});
  assert.deepEqual(p.json('encodedLocalQueue().tracks'), base);
  assert.deepEqual(p.json('encodedLocalQueue().play_next'), next.slice(2));
});

test("queue removal rejects stale, detached, closed and remote-controller actions", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); setNowPlaying(true)');
  const original = p.json('player.queue.map(t => t.id)');
  const control = queueRemoveControl(p, 1);
  p.run('renderNowPlaying()');
  await p.click({"[data-queue-remove]": control});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), original);
  queueRemoveControl(p, 1).isConnected = false;
  await p.click({"[data-queue-remove]": control});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), original);
  control.isConnected = true;
  queueRemoveControl(p, 1); p.run('player.queue.unshift({...player.queue[0]})');
  await p.click({"[data-queue-remove]": control});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), [original[0], ...original]);
  p.run('renderNowPlaying(); setNowPlaying(false)'); queueRemoveControl(p, 1);
  await p.click({"[data-queue-remove]": control});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), [original[0], ...original]);
  p.run('setNowPlaying(true); queueSync.active = true; queueSync.view = {own:false,state:{role:"controller"}}; renderNowPlaying()');
  assert.doesNotMatch(p.nodes.get('#now-playing-list').innerHTML, /data-queue-remove/);
  queueRemoveControl(p, 1);
  await p.click({"[data-queue-remove]": control});
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), [original[0], ...original]);
});

test("queue additions retain click order and clearing during a fetch cancels late additions", async () => {
  const p = livePage(); await settle();
  p.run('state.details.delete("2")');
  let finish;
  const album = p.json('demoLibrary()[1]');
  p.setFetch(() => new Promise(resolve => { finish = resolve; }));
  const first = p.run('addToQueue("2", "200")'); await settle();
  const second = p.run('addToQueue("1", "100")');
  finish({ok: true, json: async () => ({albums: [album]})});
  await first; await second;
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ["200", "100"]);
  p.run('stopPlayer(); state.details.delete("2")');
  const late = p.run('addToQueue("2")'); await settle();
  p.run('stopPlayer()');
  finish({ok: true, json: async () => ({albums: [album]})}); await late;
  assert.equal(p.run('player.queue.length'), 0);
  assert.equal(p.nodes.get("#audio").src, undefined);
  p.run('useLocal(demoLibrary(), "demo")');
  await p.run('addToQueue("1")');
  assert.equal(p.run('player.queue.length'), 0);
});

test("queue continues an ended album when music is appended, preserves pause and keeps multi-disc order", async () => {
  const p = livePage(); await settle();
  await p.run('addToQueue("1", "100")');
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100?quality=128");
  p.nodes.get("#audio").pause();
  await p.run('addToQueue("2", "200")');
  assert.equal(p.nodes.get("#audio").paused, true);
  p.nodes.get("#audio").ended = true;
  await p.run('addToQueue("2", "201")');
  assert.equal(p.nodes.get("#audio").src, "/api/stream/200?quality=128");
  p.nodes.get("#audio").ended = false;
  p.run(`stopPlayer(); const discs = [{id: "31", name: "Set", artist: "A", disc: 1, tracks: [{id: "310", title: "First", artist: "A", track: 1}]}, {id: "32", name: "Set", artist: "A", disc: 2, tracks: [{id: "320", title: "Second", artist: "A", track: 1}]}]; useLocal(discs, "demo"); state.mode = "live"; state.connection.connected = true`);
  await p.run('addToQueue("32")');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ["310", "320"]);
});

test("decades sample unique merged albums, Surprise reshuffles locally and Back preserves the selection", async () => {
  const p = page(); await settle();
  p.run(`useLocal(Array.from({length: 60}, (_, i) => ({id: String(i+1), name: "Album " + i, artist: "A", year: 1980 + i % 10, disc: 1, tracks: [{id: String(i+100), title: "Song", artist: "A", year: 0, track: 1}]})), "demo"); showBrowse("decades", "1980")`);
  const selected = p.json('browseView.randomIds');
  assert.equal(selected.length, 60);
  assert.equal(new Set(selected).size, 60);
  assert.match(p.nodes.get("#browse-results").textContent, /Showing 24 random albums of 60/);
  assert.equal(p.nodes.get("#browse-pagination").innerHTML, "");
  const introduction = p.nodes.get("#browse-decade-intro").textContent;
  assert.match(introduction, /Synth-pop/);
  assert.equal(p.nodes.get("#browse-decade-intro").hidden, false);
  assert.equal(p.nodes.get("#browse-toolbar").hidden, false);
  assert.equal(p.nodes.get("#browse-per-page").hidden, false);
  await p.run(`openAlbum("${selected[0]}")`); p.history.back(); await settle();
  assert.deepEqual(p.json('browseView.randomIds'), selected);
  assert.equal(p.nodes.get("#browse-decade-intro").textContent, introduction);
  const calls = p.requests.length;
  p.run('Math.random = () => 0');
  await p.nodes.get("#browse-surprise").emit("click");
  assert.notDeepEqual(p.json('browseView.randomIds'), selected);
  assert.equal(p.requests.length, calls);
  assert.equal(p.location.hash, "#/decades/1980");
  assert.equal(p.nodes.get("#browse-sort").hidden, true);
});

test("the decade overview has no toolbar and introductions follow the chosen decade without leaking into other browse pages", async () => {
  const p = page(); await settle();
  p.run('showBrowse("decades", null, {sort: "count"})');
  assert.equal(p.nodes.get('#browse-toolbar').hidden, true);
  assert.equal(p.nodes.get('#browse-sort').hidden, true);
  assert.equal(p.nodes.get('#browse-per-page').hidden, true);
  assert.equal(p.nodes.get('#browse-decade-intro').hidden, true);
  const keys = p.json('browseView.rows.map(g => Number(g.key))');
  assert.deepEqual(keys, [...keys].sort((a, b) => b - a));
  const calls = p.requests.length;
  await p.click({'[data-browse-key]': {dataset: {browseKey: '1980', browseLabel: '1980s'}}});
  assert.match(p.nodes.get('#browse-decade-intro').textContent, /Synth-pop/);
  assert.equal(p.nodes.get('#browse-toolbar').hidden, false);
  assert.equal(p.nodes.get('#browse-search-field').hidden, false);
  assert.equal(p.nodes.get('#browse-surprise').hidden, false);
  p.run('showBrowse("decades", "1990", {label: "1990s"})');
  assert.match(p.nodes.get('#browse-decade-intro').textContent, /Grunge/);
  assert.doesNotMatch(p.nodes.get('#browse-decade-intro').textContent, /Synth-pop/);
  p.run('showBrowse("genres")');
  assert.equal(p.nodes.get('#browse-toolbar').hidden, false);
  assert.equal(p.nodes.get('#browse-sort').hidden, false);
  assert.equal(p.nodes.get('#browse-per-page').hidden, false);
  assert.equal(p.nodes.get('#browse-decade-intro').hidden, true);
  assert.equal(p.nodes.get('#browse-decade-intro').textContent, '');
  assert.equal(p.requests.length, calls);
});

test("album grid and browse cards keep the compact queue action inside their metadata footer", async () => {
  const p = livePage(); await settle();
  const grid = p.run("gridView(albumShelf().slice(0, 1))");
  assert.match(grid, /class="card-meta"[\s\S]*class="queue-add queue-compact queue-menu-trigger"[\s\S]*<\/div><\/article>/);
  assert.doesNotMatch(grid, /\+ Add to queue/);
  assert.match(p.run("browseAlbumCard(albumShelf()[0])"), /queue-compact/);
  assert.match(p.run("queueButton(state.albums[0].id)"), /\+ Queue/); // album detail keeps the full action
});

test("queue dropdown waits for a choice, appends or plays next, and keeps focus and playback on dismissal", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), "100")');
  const original = p.json('player.queue.map(t => t.id)'), audio = p.nodes.get('#audio'), source = audio.src;
  p.run('$("#test-queue-trigger").dataset = {queueAlbum: "2", queueTrack: String(state.details.get("2").tracks[0].id)}');
  const trigger = p.nodes.get('#test-queue-trigger');
  await p.click({'[data-queue-album]': trigger});
  assert.equal(p.nodes.get('#queue-action-menu').hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), original);
  assert.equal(p.run('document.activeElement === $("#queue-action-append")'), true);
  await p.nodes.get('#queue-action-menu').emit('keydown', {key: 'ArrowDown', preventDefault() {}});
  assert.equal(p.run('document.activeElement === $("#queue-action-next")'), true);
  await p.nodes.get('#queue-action-menu').emit('keydown', {key: 'End', preventDefault() {}});
  assert.equal(p.run('document.activeElement === $("#queue-action-playlist")'), true);
  await p.nodes.get('#queue-action-menu').emit('keydown', {key: 'ArrowDown', preventDefault() {}});
  assert.equal(p.run('document.activeElement === $("#queue-action-append")'), true);
  await p.nodes.get('#queue-action-menu').emit('keydown', {key: 'Escape', preventDefault() {}});
  assert.equal(p.nodes.get('#queue-action-menu').hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(p.run('document.activeElement === $("#test-queue-trigger")'), true);
  assert.equal(audio.src, source);
  assert.equal(audio.paused, false);
  await p.click({'[data-queue-album]': trigger});
  await p.nodes.get('#queue-action-append').emit('click');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), [...original, trigger.dataset.queueTrack]);
  await p.click({'[data-queue-album]': trigger});
  await p.nodes.get('#queue-action-next').emit('click');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), [original[0], trigger.dataset.queueTrack, ...original.slice(1), trigger.dataset.queueTrack]);
  assert.equal(p.run('player.queue[1].upNext'), true);
  assert.equal(audio.src, source);
  assert.equal(p.nodes.get('#queue-action-menu').hidden, true);
  await p.click({'[data-queue-album]': trigger});
  await p.click({});
  assert.equal(p.nodes.get('#queue-action-menu').hidden, true);
  assert.ok(p.requests.every(r => !r.options?.body), 'Queue choices never write library metadata');
});

test("album queue menus keep album order and ignore choices from detached controls or a replaced library", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), "100"); $("#test-album-trigger").dataset = {queueAlbum: "2"}');
  const original = p.json('player.queue.map(t => t.id)'), trigger = p.nodes.get('#test-album-trigger');
  await p.click({'[data-queue-album]': trigger});
  trigger.isConnected = false;
  await p.nodes.get('#queue-action-next').emit('click');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), original);
  trigger.isConnected = true;
  await p.click({'[data-queue-album]': trigger});
  p.run('state.details = new Map(state.details)');
  await p.nodes.get('#queue-action-next').emit('click');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), original);
  await p.click({'[data-queue-album]': trigger});
  await p.nodes.get('#queue-action-next').emit('click');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), [original[0], ...p.json('queueTracks(state.details.get("2")).map(t => t.id)'), ...original.slice(1)]);
  await p.click({'[data-queue-album]': trigger});
  p.run('showScreen("tracks")');
  assert.equal(p.nodes.get('#queue-action-menu').hidden, true);
  await p.nodes.get('#queue-action-append').emit('click');
  assert.equal(p.run('player.queue.length'), original.length + p.run('state.details.get("2").tracks.length'));
});

test("additional performers appear as individual links and are searchable and browsable in preview", async () => {
  const p = livePage(); await settle();
  p.run('const a = state.details.get(state.albums[0].id); a.tracks[0].performers = [{id:"41", name:a.artist}, {id:"99", name:"Guest & Friend"}]; playTracks(a);');
  assert.match(p.nodes.get("#player-extra-artists").innerHTML, /data-performer-id="99"/);
  assert.match(p.nodes.get("#player-extra-artists").innerHTML, /Guest &amp; Friend/);
  p.run('state.mode = "demo"; showBrowse("track-artists", "99")');
  assert.equal(p.run("browseView.albumIds.size"), 1);
  assert.equal(p.run('localTracks("guest").total'), 1);
});

test("cleanup previews require explicit approval, preserve exclusions and reject stale responses", async () => {
  const p = livePage(); await settle();
  const preview = {id: "draft", state: "preview", category: "genres", tracks: 8, albums: 2, counts: {pending:8}, excluded:[], batch_tracks:200, batch_albums:20,
    selection:[{id:"1",tracks:3},{id:"2",tracks:5}], groups:[{id:"1",album:"A < B",artist:"Artist",tracks:3,examples:[{title:"Track",before:["Pop;Rock"],after:["Pop","Rock"]}]}]};
  p.setFetch(async (url) => ({ok:true,json:async () => preview}));
  await p.run("openCleanup()");
  assert.match(p.nodes.get("#cleanup-content").innerHTML, /A &lt; B/);
  p.run('cleanupView.excluded.add("1"); updateCleanupSelection()');
  assert.match(p.nodes.get("#cleanup-selected").textContent, /1 albums · 5 tracks/);
  const before = p.requests.length;
  await p.run('cleanupAction("start")');
  assert.equal(p.requests.length, before);
  p.run('$("#cleanup-approved").checked = true; updateCleanupSelection()');
  assert.equal(p.nodes.get("#cleanup-start").disabled, false);
  await p.run('cleanupAction("start")');
  const start = p.requests.find(r => r.url === "/api/cleanup/start");
  assert.deepEqual(JSON.parse(start.options.body), {id:"draft",excluded:["1"]});
  let finish;
  p.setFetch(() => new Promise(resolve => {finish = resolve;}));
  const pending = p.run("fetchCleanup()");
  p.run('state.details = new Map(); state.mode = "demo"');
  finish({ok:true,json:async () => ({...preview,id:"stale"})});
  await pending;
  assert.equal(p.run("cleanupView.data.id"), "draft");
});

test("album artist cleanup reviews primary/additional names, every disc and blocked entries before approval", async () => {
  const p = livePage(); await settle();
  const preview = {id:"album-draft", state:"preview", category:"album-artists", tracks:36, records:3,
    albums:1, counts:{pending:3}, excluded:[], batch_tracks:200, batch_albums:20,
    selection:[{id:"1",tracks:36}], groups:[{id:"1",album:"Joint album",artist:"A;B",tracks:36,
      examples:[1,2,3].map(disc => ({title:`Disc ${disc}`,before:["A < B;C"],after:["A < B","C"],primary:"A < B",additional:["C"]}))}]};
  p.setFetch(async url => ({ok:true,json:async () => url.endsWith("/preview") ? preview : {state:"empty"}}));
  await p.run("openCleanup()");
  await p.nodes.get("#cleanup").emit("change", {target:{id:"cleanup-category",value:"album-artists"}});
  assert.match(p.nodes.get("#cleanup-content").innerHTML, /first name becomes the primary album artist/);
  const audio = p.nodes.get("#audio");
  await p.run('cleanupAction("preview")');
  assert.deepEqual(JSON.parse(p.requests.at(-1).options.body), {category:"album-artists"});
  const html = p.nodes.get("#cleanup-content").innerHTML;
  assert.match(html, /<span>Primary<\/span><span>A &lt; B/);
  assert.match(html, /<span>Additional<\/span><span>C/);
  assert.match(html, /Disc 3/);
  assert.doesNotMatch(html, /Album artists and other metadata stay unchanged/);
  assert.equal(p.nodes.get("#cleanup-start").disabled, true);
  const count = p.requests.length;
  await p.run('cleanupAction("start")');
  assert.equal(p.requests.length, count);
  p.run('$("#cleanup-approved").checked=true; updateCleanupSelection()');
  assert.equal(p.nodes.get("#cleanup-start").disabled, false);
  p.run('cleanupView.excluded.add("1"); updateCleanupSelection()');
  assert.equal(p.nodes.get("#cleanup-start").disabled, true);
  p.run('cleanupView.data.groups[0].examples=[{title:"Disc 1",before:["Bad; name"],after:[],blocked:"Fix <name> individually"}]; renderCleanup()');
  assert.match(p.nodes.get("#cleanup-content").innerHTML, /Blocked: Fix &lt;name&gt; individually/);
  assert.doesNotMatch(p.nodes.get("#cleanup-content").innerHTML, /No genres/);
  assert.equal(p.nodes.get("#audio"), audio);
});

test("random album respects library filters across pages, plays full disc sets and avoids the current album", async () => {
  const p = livePage(); await settle();
  p.run(`useLocal([
    ...Array.from({length: 30}, (_, i) => ({id: String(i+1), name: "Album " + String(i).padStart(2,"0"), artist: "A", year:1985, disc:1, tracks:[{id:String(i+100),title:"Song",artist:"A",track:1,genres:["Rock"]}]})),
    {id:"31",name:"Z Set",artist:"A",year:1985,disc:1,tracks:[{id:"310",title:"First",artist:"A",track:1,genres:["Rock"]},{id:"311",title:"Second",artist:"A",track:2,genres:["Rock"]}]},
    {id:"32",name:"Z Set",artist:"A",year:1985,disc:2,tracks:[{id:"320",title:"Third",artist:"A",track:1,genres:["Rock"]}]},
    {id:"33",name:"Excluded",artist:"B",year:1985,disc:1,tracks:[{id:"330",title:"Jazz",artist:"B",track:1,genres:["Jazz"]}]}
  ], "demo"); state.mode="live"; state.artist="A"; state.page=0; Math.random=()=>0.999; render()`);
  const route = p.location.hash, history = p.history.length;
  await p.nodes.get("#albums-random").emit("click");
  assert.equal(p.run('player.album.id'), "31", "Selection includes albums beyond the first page; disc set has one chance");
  assert.deepEqual(p.json('player.queue.map(t=>t.id)'), ["310","311","320"]);
  assert.equal(p.run('player.index'), 0);
  assert.equal(p.location.hash, route);
  assert.equal(p.history.length, history);
  await p.nodes.get("#albums-random").emit("click");
  assert.equal(p.run('player.album.id'), "30", "The current set is excluded when alternatives exist");
  p.nodes.get("#search").value = "Z Set"; p.run("render()");
  await p.nodes.get("#albums-random").emit("click");
  assert.equal(p.run('player.album.id'), "31");
  p.nodes.get("#search").value = "no match"; p.run("render()");
  assert.equal(p.nodes.get("#albums-random").disabled, true);
  const queue = p.json('player.queue');
  await p.nodes.get("#albums-random").emit("click");
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.requests.filter(r=>r.options?.method === "POST").length,0);
});

test("random album uses exact genre, year and decade membership and search, beyond the decade sample", async () => {
  const p = page(); await settle();
  p.run(`useLocal(Array.from({length: 60}, (_, i) => ({id:String(i+1),name:"Album "+String(i).padStart(2,"0"),artist:"A",year:i<30?1985:1995,disc:1,tracks:[{id:String(i+100),title:"Song",artist:"A",track:1,genres:[i%2?"Jazz":"Rock"]}]})),"demo")`);
  for (const [kind,key,expected] of [["genres","rock","59"],["years","1985","30"],["decades","1980","29"]]) {
    p.run(`state.mode="demo"; showBrowse("${kind}","${key}"); state.mode="live"; Math.random=()=>0.999; updateRandomControls()`);
    const ids = p.json('browseView.randomIds'), history = p.history.length, route = p.location.hash;
    const requests = p.requests.length;
    await p.nodes.get("#browse-random").emit("click");
    assert.equal(p.run('player.album.id'), expected, kind);
    assert.deepEqual(p.json('browseView.randomIds'), ids, "Playback keeps the displayed random sample");
    assert.equal(p.location.hash, route);
    assert.equal(p.history.length, history);
    assert.equal(p.requests.length, requests, "Cached albums need no library download");
    assert.equal(p.nodes.get("#browse-random").hidden, false);
  }
  p.run('browseView.query="Album 00"; renderBrowse()');
  await p.nodes.get("#browse-random").emit("click");
  assert.equal(p.run('player.album.id'), "1");
  p.run('browseView.query="missing"; renderBrowse()');
  assert.equal(p.nodes.get("#browse-random").disabled, true);
  p.run('browseView.key=null; updateRandomControls()');
  assert.equal(p.nodes.get("#browse-random").hidden, true);
  p.run('state.mode="demo"; render()');
  assert.equal(p.nodes.get("#albums-random").disabled, true);
});

test("random playback lazily loads only its selected album, cancels late loads and preserves playback on failure", async () => {
  const p = livePage(); await settle();
  const album = p.json('state.details.get("2")');
  p.run('playTracks(state.details.get("1")); state.details.delete("2")');
  const original = p.nodes.get("#audio").src;
  let finish;
  p.setFetch((url) => {
    assert.equal(url,"/api/albums?ids=2");
    return new Promise(resolve=>{finish=resolve;});
  });
  let pending = p.run('playRandomAlbum(state.albums.filter(a=>a.id==="2"))'); await settle();
  assert.equal(p.nodes.get("#albums-random").disabled,true);
  assert.equal(p.nodes.get("#audio").src,original);
  await p.nodes.get("#queue-clear").emit("click");
  finish({ok:true,json:async()=>({albums:[album]})}); await pending;
  assert.equal(p.run('player.queue.length'),0);
  assert.equal(p.run('player.randomLoading'),false);
  p.run('state.details.delete("2")');
  pending = p.run('playRandomAlbum(state.albums.filter(a=>a.id==="2"))'); await settle();
  await p.click({"[data-play]":{dataset:{play:"100",playAlbumId:"1"}}});
  finish({ok:true,json:async()=>({albums:[album]})}); await pending;
  assert.equal(p.run('String(player.album.id)'),"1");
  p.run('state.details.delete("2")');
  pending = p.run('playRandomAlbum(state.albums.filter(a=>a.id==="2"))'); await settle();
  p.run('state.details=new Map()');
  finish({ok:true,json:async()=>({albums:[album]})}); await pending;
  assert.equal(p.run('String(player.album.id)'),"1", "A library switch cancels the pending selection");
  p.setFetch(async()=>{throw Error("Offline");});
  await p.run('playRandomAlbum(state.albums.filter(a=>a.id==="2"))');
  assert.equal(p.run('String(player.album.id)'),"1");
  assert.match(p.nodes.get("#toast").textContent,/Offline/);
  assert.equal(p.run('player.randomLoading'),false);
  assert.equal(p.nodes.get("#albums-random").disabled,false);
});

test("fullscreen Now playing reuses audio and queue, updates metadata safely and restores the library without requests", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); $("main").inert = false; $(".sidebar").inert = true; audio.currentTime = 43; player.queue[0].title = "<img onerror=bad>"');
  const src = p.nodes.get("#audio").src, queue = p.json('player.queue'), history = p.history.length, requests = p.requests.length;
  await p.nodes.get("#player-fullscreen").emit("click");
  assert.equal(p.run('visualPlayer.open'), true);
  assert.equal(p.nodes.get("#visual-player").hidden, false);
  assert.equal(p.nodes.get("#visual-player-title").textContent, "<img onerror=bad>");
  assert.equal(p.nodes.get("#visual-player-title").innerHTML, "");
  assert.equal(p.nodes.get("main").inert, true);
  assert.equal(p.run('audio.currentTime'), 43);
  assert.equal(p.nodes.get("#audio").src, src);
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.requests.length, requests, "The view never fetches album or track details");
  p.run('audio.pause()');
  assert.equal(p.run('visualPlayer.open'), true);
  p.run('step(1)');
  assert.equal(p.nodes.get("#visual-player-title").textContent, p.run('player.queue[1].title'));
  const nextSrc = p.nodes.get("#audio").src;
  await p.keydown("Escape"); await settle();
  assert.equal(p.run('visualPlayer.open'), false);
  assert.equal(p.nodes.get("#audio").src, nextSrc);
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.nodes.get("main").inert, false);
  assert.equal(p.nodes.get(".sidebar").inert, true, "Existing inert state is restored");
  assert.equal(p.run('document.activeElement === $("#player-fullscreen")'), true);
  assert.equal(p.history.length, history);
  await p.nodes.get("#player-fullscreen").emit("click");
  await p.nodes.get("#player-close").emit("click");
  assert.equal(p.run('visualPlayer.open'), false);
  assert.equal(p.run('player.queue.length'), 0);
  assert.equal(p.run('document.activeElement === $("#home")'), true);
  const preview = page(); await settle();
  await preview.nodes.get("#player-fullscreen").emit("click");
  assert.equal(preview.run('visualPlayer.open'), false);
});

test("Now playing can fill the app window without native fullscreen or playback changes", async () => {
  const storage = {}, p = livePage({storage}); await settle();
  p.run('playTracks(state.details.get("1")); audio.currentTime = 39; openSettings(); let fullRequests = 0; $("#player-stage").requestFullscreen = () => {fullRequests++; return Promise.resolve()}');
  const source = p.nodes.get('#audio').src, queue = p.json('player.queue'), requests = p.requests.length, history = p.history.length;
  assert.match(p.nodes.get('#settings-content').innerHTML, /value="fullscreen" selected/);
  await p.change({id: 'player-view-mode', value: 'window', matches: () => false});
  assert.equal(storage['tagcast-player-view'], 'window');
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').currentTime, 39);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.equal(p.requests.length, requests);
  p.run('$("#settings").close(); $("#player-fullscreen").focus()');
  assert.equal(p.nodes.get('#player-fullscreen').getAttribute('aria-label'), 'Open Now playing in app window');
  await p.nodes.get('#player-fullscreen').emit('click');
  assert.equal(p.run('visualPlayer.open'), true);
  assert.equal(p.run('fullRequests'), 0);
  assert.equal(p.nodes.get('#player-stage').getAttribute('aria-label'), 'Now playing');
  assert.equal(p.nodes.get('main').inert, true);
  await p.keydown('Escape'); await settle();
  assert.equal(p.run('visualPlayer.open'), false);
  assert.equal(p.run('document.activeElement === $("#player-fullscreen")'), true);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').currentTime, 39);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.history.length, history);
  assert.equal(p.requests.length, requests);
  p.run('openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML, /value="window" selected/);
  await p.change({id:'player-view-mode', value:'fullscreen', matches: () => false});
  p.run('$("#settings").close(); openVisualPlayer()');
  assert.equal(p.run('fullRequests'), 1, 'Choosing Fullscreen restores the original opening behavior');
});

test("Now playing presentation persists, validates stored values and works without local storage", async () => {
  const p = livePage({storage:{'tagcast-player-view':'window'}}); await settle();
  assert.equal(p.run('visualPlayerMode'), 'window');
  p.run('playTracks(state.details.get("1")); let fullRequests = 0; $("#player-stage").requestFullscreen = () => {fullRequests++}; openVisualPlayer()');
  assert.equal(p.run('fullRequests'), 0);
  await p.change({id:'player-view-mode',value:'fullscreen', matches: () => false});
  assert.equal(p.run('fullRequests'), 0, 'Preferences apply on next opening, never during a view');
  await p.change({id:'player-view-mode',value:'invalid', matches: () => false});
  assert.equal(p.run('visualPlayerMode'), 'fullscreen');
  p.run('localStorage.setItem = () => {throw Error("Disabled")}; setVisualPlayerMode("window")');
  assert.equal(p.run('visualPlayerMode'), 'window');
  p.run('localStorage.getItem = () => {throw Error("Disabled")}');
  assert.equal(p.run('storedVisualPlayerMode()'), 'fullscreen');
  const invalid = page({storage:{'tagcast-player-view':'invalid'}}); await settle();
  assert.equal(invalid.run('visualPlayerMode'), 'fullscreen');
  invalid.run('openSettings()');
  assert.match(invalid.nodes.get('#settings-content').innerHTML, /id="player-view-mode"/);
});

test("in-window Now playing leaves an existing browser fullscreen session untouched", async () => {
  const p = livePage({storage:{'tagcast-player-view':'window'}}); await settle();
  p.run('playTracks(state.details.get("1")); document.fullscreenElement = $("main"); let exits = 0; document.exitFullscreen = () => {exits++}; openVisualPlayer()');
  await p.nodes.get('#visual-player-close').emit('click');
  assert.equal(p.run('exits'), 0);
  assert.equal(p.run('document.fullscreenElement === $("main")'), true);
  assert.equal(p.run('visualPlayer.open'), false);
  assert.equal(p.nodes.get('#audio').paused, false);
});

test("fullscreen loads known large artwork only on opening, falls back once and preserves playback", async () => {
  const p = livePage(); await settle();
  p.run('const largeArtAlbum = state.details.get("1"); largeArtAlbum.artwork = "https://art.example/artwork/77-300?variant=1"; playTracks(largeArtAlbum)');
  const art = p.nodes.get('#visual-player-art'), writes = [];
  let imageSrc;
  Object.defineProperty(art, 'src', {configurable: true, get() { return imageSrc; }, set(value) { imageSrc = value; writes.push(value); }});
  const source = p.nodes.get('#audio').src, queue = p.json('player.queue'), requests = p.requests.length;
  assert.equal(art.src, undefined, 'Compact playback does not load fullscreen artwork');
  p.run('openVisualPlayer()');
  assert.equal(art.src, 'https://art.example/artwork/77-1000?variant=1');
  p.run('markPlaying()');
  assert.equal(writes.length, 1, 'Repeated playback rendering keeps the same image request');
  await art.emit('error');
  assert.equal(art.src, 'https://art.example/artwork/77-300?variant=1');
  p.run('markPlaying()');
  assert.equal(writes.length, 2, 'Rendering keeps the original-image fallback');
  await art.emit('error');
  p.run('markPlaying()');
  assert.equal(art.hidden, true);
  assert.equal(writes.length, 2, 'Neither failed size is retried during playback');
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.requests.length, requests, 'Artwork requires no library or track API request');
  p.run('player.queue[player.index].album.artwork = "https://art.example/artwork/88-150"; markPlaying()');
  assert.equal(art.src, 'https://art.example/artwork/88-1000');
  assert.equal(art.hidden, false, 'Changing artwork recovers from the previous failure');
  p.run('hideVisualPlayer()');
  await art.emit('error');
  assert.equal(art.src, undefined, 'Closing clears the image and ignores late errors');
  assert.equal(writes.length, 3);
  p.run('player.queue[player.index].album.artwork = "https://provider.example/image-300.jpg"; openVisualPlayer()');
  assert.equal(art.src, 'https://provider.example/image-300.jpg', 'Other providers keep their original URLs');
  p.run('player.queue[player.index].album.artwork = ""; markPlaying()');
  assert.equal(art.hidden, true);
  assert.equal(art.src, undefined);
});

test("native fullscreen handles browser Escape, rejection and a late request after closing", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1")); $("#player-stage").requestFullscreen = () => {document.fullscreenElement = $("#player-stage"); return Promise.resolve()}; document.exitFullscreen = () => {document.fullscreenElement = null; return Promise.resolve()}');
  await p.nodes.get("#player-fullscreen").emit("click");
  await p.emitDocument("fullscreenchange");
  assert.equal(p.run('visualPlayer.native'), true);
  p.run('document.fullscreenElement = null');
  await p.emitDocument("fullscreenchange");
  assert.equal(p.run('visualPlayer.open'), false);
  assert.equal(p.nodes.get("#audio").paused, false);
  p.run('$("#player-stage").requestFullscreen = () => Promise.reject(Error("Not permitted"))');
  await p.nodes.get("#player-fullscreen").emit("click"); await settle();
  assert.equal(p.run('visualPlayer.open'), true);
  assert.match(p.nodes.get("#visual-player-status").textContent, /in this window/);
  await p.nodes.get("#visual-player-close").emit("click");
  p.run('let finishFullscreen; $("#player-stage").requestFullscreen = () => new Promise(resolve => {finishFullscreen = () => {document.fullscreenElement = $("#player-stage"); resolve()}})');
  await p.nodes.get("#player-fullscreen").emit("click");
  p.run('stopPlayer(); finishFullscreen()'); await settle();
  assert.equal(p.run('visualPlayer.open'), false);
  assert.equal(p.run('document.fullscreenElement'), null, "A late native request cannot reopen a stopped player");
});

test("fullscreen keyboard focus stays on its controls and failed artwork falls back without retrying", async () => {
  const p = livePage(); await settle();
  p.run('const visualAlbum = state.details.get("1"); visualAlbum.artwork = "https://example.test/cover-300"; playTracks(visualAlbum); openVisualPlayer(); $("#player-stage").querySelectorAll = () => [$("#visual-player-close"), audio, $("#player-close")]; for (const node of $("#player-stage").querySelectorAll()) node.getClientRects = () => [1]');
  let prevented = false;
  await p.emitDocument("keydown", {key: "Tab", shiftKey: true, preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(p.run('document.activeElement === $("#player-close")'), true);
  await p.emitDocument("keydown", {key: "Tab", shiftKey: false, preventDefault() {}});
  assert.equal(p.run('document.activeElement === $("#visual-player-close")'), true);
  await p.nodes.get("#visual-player-art").emit("error");
  p.run('markPlaying()');
  assert.equal(p.nodes.get("#visual-player-art").hidden, true, "Playback events do not retry a failed cover");
  assert.equal(p.nodes.get("#visual-player-placeholder").textContent, "PF");
  p.run('setNowPlaying(false); useLocal(demoLibrary(), "demo")');
  assert.equal(p.run('visualPlayer.open'), false, "A replacement library closes the fullscreen view");
});

test("colour palettes persist independently of appearance without requests or playback changes", async () => {
  const storage = {"tagcast-palette": "ibroadcast", "tagcast-theme": "dark"};
  const p = page({storage});
  await settle();
  assert.equal(p.run('document.documentElement.dataset.palette'), "ibroadcast");
  assert.equal(p.run('document.documentElement.dataset.theme'), "dark");
  assert.equal(p.nodes.get("#palette-ibroadcast").checked, true);
  p.run(`player.queue = [{id:"900",title:"Playing",artist:"Artist"}]; player.index=0;
    $("#audio").src="/api/stream/900?quality=128"; $("#audio").currentTime=27; $("#audio").paused=false;`);
  const requests = p.requests.length, history = p.history.length, queue = p.json("player.queue");
  for (const palette of ["ocean", "warm", "ibroadcast", "forest"]) {
    await p.nodes.get("#theme-menu").emit("change", {target: {value: palette, dataset: {paletteChoice: ""}}});
    assert.equal(p.run('document.documentElement.dataset.palette'), palette === "forest" ? undefined : palette);
    assert.equal(storage["tagcast-palette"], palette);
    assert.equal(p.run('document.documentElement.dataset.theme'), "dark");
    assert.equal(p.run('$("#audio").currentTime'), 27);
    assert.equal(p.run('$("#audio").paused'), false);
    assert.equal(p.run('$("#audio").src'), "/api/stream/900?quality=128");
    assert.deepEqual(p.json("player.queue"), queue);
  }
  p.run('setColourPalette("warm")');
  await p.nodes.get("#theme-menu").emit("change", {target: {value: "auto", dataset: {appearanceChoice: ""}}});
  assert.equal(p.run('document.documentElement.dataset.theme'), undefined, "Auto follows the OS through CSS");
  assert.equal(p.run('document.documentElement.dataset.palette'), "warm");
  assert.equal(storage["tagcast-theme"], "auto");
  assert.equal(p.requests.length, requests);
  assert.equal(p.history.length, history);
  const reloaded = page({storage});
  assert.equal(reloaded.nodes.get("#palette-forest").checked, true);
  assert.equal(reloaded.run('document.documentElement.dataset.theme'), undefined);
});

test("appearance restores before scripts load and invalid or unavailable storage stays usable", async () => {
  const source = readFileSync(path.join(staticDir, "index.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const palette of ["ocean", "warm", "ibroadcast"]) {
    const document = {documentElement: {dataset: {}}};
    vm.runInNewContext(source, {document, localStorage: {getItem: key => key === "tagcast-palette" ? palette : "light"}});
    assert.deepEqual(document.documentElement.dataset, {theme:"light",palette});
    const p = page({storage:{"tagcast-palette":palette}});
    assert.equal(p.nodes.get("#palette-" + palette).checked, true);
  }
  const p = page({storage:{"tagcast-palette":"bad\" injected", "tagcast-theme":"bad"}});
  assert.equal(p.run('document.documentElement.dataset.palette'), undefined);
  assert.equal(p.run('document.documentElement.dataset.theme'), undefined);
  const document = {documentElement: {dataset: {}}};
  vm.runInNewContext(source, {document, localStorage: {getItem() {throw Error("Blocked");}}});
  assert.deepEqual(document.documentElement.dataset, {});
  p.run('localStorage.setItem = () => {throw Error("Blocked")};');
  await p.nodes.get("#theme-menu").emit("change", {target: {value: "ocean", dataset: {paletteChoice: ""}}});
  assert.equal(p.run('document.documentElement.dataset.palette'), "ocean");
  await p.nodes.get("#theme-menu").emit("change", {target: {value: "invalid", dataset: {paletteChoice: ""}}});
  assert.equal(p.nodes.get("#palette-forest").checked, true);
  assert.equal(p.run('document.documentElement.dataset.palette'), undefined);
});


test("the unified theme disclosure opens without changing choices, supports Escape and closes outside", async () => {
  const p = page({storage:{"tagcast-theme":"dark", "tagcast-palette":"ocean"}});
  await settle();
  const history = p.history.length, requests = p.requests.length;
  await p.nodes.get("#theme-button").emit("click");
  assert.equal(p.nodes.get("#theme-menu").hidden, false);
  assert.equal(p.nodes.get("#theme-button").getAttribute("aria-expanded"), "true");
  assert.equal(p.run('document.activeElement === $("#appearance-dark")'), true);
  assert.equal(p.run('document.documentElement.dataset.theme'), "dark");
  await p.nodes.get("#theme-menu").emit("change", {target: {value: "light", dataset: {appearanceChoice: ""}}});
  assert.equal(p.run('document.documentElement.dataset.palette'), "ocean");
  assert.equal(p.nodes.get("#appearance-light").checked, true);
  await p.emitDocument("keydown", {key:"Escape", preventDefault() {this.defaultPrevented = true;}});
  assert.equal(p.nodes.get("#theme-menu").hidden, true);
  assert.equal(p.run('document.activeElement === $("#theme-button")'), true);
  await p.nodes.get("#theme-button").emit("click");
  await p.click({});
  assert.equal(p.nodes.get("#theme-menu").hidden, true);
  assert.equal(p.nodes.get("#theme-button").getAttribute("aria-expanded"), "false");
  assert.equal(p.history.length, history);
  assert.equal(p.requests.length, requests);
});

test("disc sets require matching album years and active upload date sets after detail summarization", async () => {
  const p = livePage(); await settle();
  const before = p.requests.length;
  p.run(`useLocal([1,2,3,4].map(n => ({id:String(n),name:"One album",artist:"A",year:n===3?2001:2000,disc:n,
    tracks:[{id:String(n*10),title:"Song",track:1,genres:["Rock"],uploaded_on:n===4?"2026-10-03 09:00:00":"2026-10-02 " + (n===1?"09:00:00":"21:00:00")}]})), "demo")`);
  assert.deepEqual(p.json('albumShelf().map(a=>a.id)'), ["1", "3", "4"]);
  assert.deepEqual(p.json('discSet(state.albums[0]).map(a=>a.id)'), ["1", "2"]);
  assert.equal(p.run('discSet(state.albums[2])'), null);
  assert.equal(p.requests.length, before, "Grouping uses summaries without additional requests");
  await p.run('openEditor(["1"])');
  p.run('editing.trackPatches["10"]={genres:["New genre"]}; buildReview(); applyDraft()');
  assert.deepEqual(p.json('discSet(state.albums[0]).map(a=>a.id)'), ["1", "2"], "Resummarizing preserves upload dates");
});

test("manual genre review keeps slash text whole and requires a new preview after edits", async () => {
  const p = livePage(); await settle();
  const label = "Rock/Pop/R <test>";
  const inventory = {labels:[{label,tracks:3,albums:1}],total:1,offset:0,limit:50};
  const preview = {id:"rule",state:"preview",category:"genre-labels",tracks:3,albums:1,counts:{pending:3},excluded:[],batch_tracks:200,batch_albums:20,
    mapping:{label,replacements:["Rock","Pop","R"]},selection:[{id:"1",tracks:3}],groups:[{id:"1",album:"A",artist:"B",tracks:3,examples:[{title:"Song",before:[label,"Films/Games"],after:["Rock","Pop","R","Films/Games"]}]}]};
  p.setFetch(async url => ({ok:true,json:async()=>url.startsWith("/api/cleanup/labels") ? inventory : url.endsWith("/preview") ? preview : {state:"empty"}}));
  await p.run("openCleanup()");
  await p.nodes.get("#cleanup").emit("change", {target:{id:"cleanup-category",value:"genre-labels"}});
  await settle();
  assert.match(p.nodes.get("#cleanup-content").innerHTML, /Rock\/Pop\/R &lt;test&gt;/);
  await p.nodes.get("#cleanup").emit("change", {target:{id:"cleanup-label-choice",value:label}});
  assert.equal(p.run("cleanupView.ruleText"), label, "There is no automatic slash splitting or R removal");
  await p.nodes.get("#cleanup").emit("input", {target:{id:"cleanup-label-replacements",value:"Rock\nPop\nR"}});
  await p.run('cleanupAction("preview")');
  assert.deepEqual(JSON.parse(p.requests.find(r=>r.url.endsWith("/preview")).options.body), {category:"genre-labels",label,replacements:["Rock","Pop","R"]});
  const html = p.nodes.get("#cleanup-content").innerHTML;
  assert.match(html, /Films\/Games/);
  assert.doesNotMatch(html, /id="cleanup-label-replacements"[^>]*disabled/, "Fields remain editable after the preview");
  p.run('$("#cleanup-approved").checked=true; updateCleanupSelection()');
  assert.equal(p.nodes.get("#cleanup-start").disabled, false);
  await p.nodes.get("#cleanup").emit("input", {target:{id:"cleanup-label-replacements",value:"Rock\nPop"}});
  assert.equal(p.nodes.get("#cleanup-start").disabled, true);
  const count = p.requests.length;
  await p.run('cleanupAction("start")');
  assert.equal(p.requests.length,count,"An edited rule cannot execute the previous preview");
});

test("genre label search pages on the server and rejects stale results after library replacement", async () => {
  const p = livePage(); await settle();
  p.run('cleanupView.category="genre-labels"; cleanupView.labelQuery="Films/Games"; cleanupView.labelOffset=50');
  let finish;
  p.setFetch(()=>new Promise(resolve=>{finish=resolve;}));
  const pending = p.run('fetchGenreLabels()');
  assert.equal(p.requests.at(-1).url,"/api/cleanup/labels?q=Films%2FGames&offset=50&limit=50");
  p.run('resetCleanup(); state.details=new Map()');
  finish({ok:true,json:async()=>({labels:[{label:"stale",albums:1,tracks:1}],total:51,offset:50,limit:50})});
  await pending;
  assert.equal(p.run('cleanupView.labels'),null);
});

test("removing an exact genre needs explicit mode and reviewed preview, with empty genres shown clearly", async () => {
  const p = livePage(); await settle();
  const preview = {id:"remove",state:"preview",category:"genre-labels",tracks:1,albums:1,counts:{pending:1},excluded:[],batch_tracks:200,batch_albums:20,
    mapping:{label:"P",replacements:[],remove:true},selection:[{id:"1",tracks:1}],groups:[{id:"1",album:"A",artist:"B",tracks:1,examples:[{title:"Song",before:["P"],after:[]}]}]};
  p.setFetch(async () => ({ok:true,json:async()=>preview}));
  p.run('cleanupView.category="genre-labels"; cleanupView.ruleLabel="P"; cleanupView.ruleText=""');
  const count = p.requests.length;
  await p.run('cleanupAction("preview")');
  assert.equal(p.requests.length,count,"Empty replacement text alone does not remove genres");
  await p.nodes.get("#cleanup").emit("change",{target:{id:"cleanup-label-remove",checked:true}});
  assert.match(p.nodes.get("#cleanup-content").innerHTML,/id="cleanup-label-replacements"[^>]*disabled/);
  await p.run('cleanupAction("preview")');
  assert.deepEqual(JSON.parse(p.requests.at(-1).options.body),{category:"genre-labels",label:"P",replacements:[],remove:true});
  assert.match(p.nodes.get("#cleanup-content").innerHTML,/Reviewed rule:[\s\S]*Remove this label/);
  assert.match(p.nodes.get("#cleanup-content").innerHTML,/No genres/);
  assert.equal(p.nodes.get("#cleanup-start").disabled,true);
  p.run('$("#cleanup-approved").checked=true; updateCleanupSelection()');
  assert.equal(p.nodes.get("#cleanup-start").disabled,false);
  await p.nodes.get("#cleanup").emit("change",{target:{id:"cleanup-label-remove",checked:false}});
  assert.equal(p.nodes.get("#cleanup-start").disabled,true,"Changing removal mode invalidates approval");
  p.run('resetCleanup()');
  await p.run('fetchCleanup()');
  assert.equal(p.run('cleanupView.removeLabel'),true,"Persisted removal reports restore removal mode");
  await p.nodes.get("#cleanup").emit("change",{target:{id:"cleanup-label-choice",value:"Rock"}});
  assert.equal(p.run('cleanupView.removeLabel'),false,"Another label starts without removal selected");
});

test("track format labels use existing metadata in album rows and search, hide unknowns and escape text", async () => {
  const p = page(); await settle();
  p.run('state.details.get("1").tracks[0].format="FLAC"; state.details.get("1").tracks[1].format="MP3"');
  const count = p.requests.length;
  await p.run('openAlbum("1")');
  const html = p.nodes.get("#album-page").innerHTML;
  assert.match(html, /track-list-summary">5 tracks · FLAC \/ MP3 \(known files\)/);
  assert.match(html, /track-format-exception"[^>]*>MP3/);
  assert.equal((html.match(/class="pill missing track-format-exception"/g)||[]).length,2,"Tied formats are both identified; missing data stays blank");
  assert.equal(p.requests.length,count,"Format labels do not fetch more data");
  const result = p.json('localTracks("welcome").tracks[0]');
  assert.equal(result.format,"MP3");
  assert.match(p.run('foundTrackRow(localTracks("welcome").tracks[0])'),/class="track-format" title="File format">MP3/);
  assert.equal(p.run('trackFormatLabel({})'),"");
  assert.equal(p.run('trackFormatLabel({format:"<bad>"})'),'<small class="track-format" title="File format">&lt;bad&gt;</small>');
});

test("Recently played is opt-in, uses server order and paging, and preserves playback on Back and refresh", async () => {
  const p = livePage(); await settle();
  p.run('updateChrome()');
  assert.equal(p.nodes.get("#show-recently-played").hidden, true);
  await p.run('showRecentlyPlayed()');
  assert.match(p.nodes.get("#recently-played-list").innerHTML, /Enable Record played tracks/);
  assert.ok(p.requests.every(r => !r.url.startsWith("/api/recently-played")));
  p.setFetch(async url => {
    assert.match(url, /^\/api\/recently-played\?/);
    return {ok: true, json: async () => ({enabled: true, available: true, total: 120,
      offset: Number(new URL(url, "http://test").searchParams.get("offset")),
      tracks: [{id: "100", album_id: "1", title: "Recent <song>", artist: "Artist", album: "Album", track: 1, rating: 0},
        {id: "101", album_id: "1", title: "Older song", artist: "Artist", album: "Album", track: 2, rating: 0}]})};
  });
  p.run('state.connection.playback_session = "recent-session"; applyPlaybackSettings({record_plays: true})'); await settle();
  assert.equal(p.nodes.get("#show-recently-played").hidden, false);
  const html = p.nodes.get("#recently-played-list").innerHTML;
  assert.ok(html.indexOf("Recent &lt;song&gt;") < html.indexOf("Older song"));
  assert.match(html, /data-track-play="100"/);
  p.run('$("#recently-played-search").value = "wish"; showRecentlyPlayed(1)'); await settle();
  assert.equal(p.location.hash, "#/recently-played");
  assert.match(p.requests.at(-1).url, /q=wish&offset=50&limit=50/);
  assert.match(p.nodes.get("#recently-played-pagination").innerHTML, /Page 2 of 3/);
  p.run('playTracks(state.details.get("1"), "100")');
  await p.run('openFoundTrack("100", "1")');
  p.history.back(); await settle();
  assert.equal(p.location.hash, "#/recently-played");
  assert.equal(p.nodes.get("#recently-played-search").value, "wish");
  assert.equal(p.run("recentlyPlayed.page"), 1);
  const audioSource = p.nodes.get("#audio").src;
  await p.nodes.get("#recently-played-refresh").emit("click");
  assert.match(p.requests.at(-1).url, /&refresh=1$/);
  assert.equal(p.nodes.get("#audio").src, audioSource);
  assert.equal(p.nodes.get("#audio").paused, false);
  p.run('applyPlaybackSettings({record_plays: false})');
  assert.equal(p.nodes.get("#show-recently-played").hidden, true);
  assert.equal(p.run("recentlyPlayed.rows.length"), 0);
  assert.equal(p.location.hash, "#/artists");
  assert.equal(p.nodes.get("#audio").src, audioSource);
  assert.equal(p.nodes.get("#audio").paused, false);
});

test("Recently played distinguishes missing, empty and failed remote lists, and suppresses stale sessions", async () => {
  const p = livePage(); await settle();
  p.run('state.connection.playback_session = "recent-session"; applyPlaybackSettings({record_plays: true})');
  p.setFetch(async () => ({ok: true, json: async () => ({enabled: true, available: false, tracks: [], total: 0})}));
  await p.run('showRecentlyPlayed()');
  await settle();
  assert.match(p.nodes.get("#recently-played-list").innerHTML, /did not provide/);
  p.setFetch(async () => ({ok: true, json: async () => ({enabled: true, available: true, tracks: [], total: 0})}));
  await p.run('loadRecentlyPlayed()');
  assert.match(p.nodes.get("#recently-played-list").innerHTML, /No recently played tracks/);
  p.setFetch(async () => ({ok: false, status: 500, json: async () => ({error: "Remote unavailable"})}));
  await p.run('loadRecentlyPlayed()');
  assert.match(p.nodes.get("#recently-played-list").innerHTML, /Remote unavailable/);
  let finish;
  p.setFetch(() => new Promise(resolve => { finish = resolve; }));
  const loading = p.run('loadRecentlyPlayed()');
  p.run('state.connection.playback_session = "new-session"');
  finish({ok: true, json: async () => ({enabled: true, available: true, tracks: [{id: "999", title: "Wrong account"}], total: 1})});
  // A session change resets and rechecks the current page; disable before another fetch.
  p.run('applyPlaybackSettings({record_plays: false})');
  await loading;
  assert.equal(p.run("recentlyPlayed.rows.length"), 0);
  assert.doesNotMatch(p.nodes.get("#recently-played-list").innerHTML, /Wrong account/);
  const html = readFileSync(path.join(staticDir, "index.html"), "utf8");
  assert.match(html, /id="show-history"[^\n]*Change history/);
  assert.match(html, />Export changes ↓</);
});

test("cover clicks preserve title and keyboard navigation while a double-click opens a modal without requests or history", async () => {
  const p = page(); await settle();
  p.run('state.albums[0].artwork = "https://art.example/artwork/77-300"; render()');
  assert.doesNotMatch(p.nodes.get("#albums").innerHTML, /data-cover-preview|Double-click/);
  assert.match(p.run('cover(state.albums.find(a => a.id === "1"), false, true)'), /data-cover-preview/);
  const requests = p.requests.length, entries = p.history.length, route = p.location.hash;
  let actionCount = 0;
  p.run('coverTestActions = 0');
  p.run('coverClick({detail: 1}, () => coverTestActions++, {album: {artwork: "cover"}})');
  assert.equal(p.run('coverTestActions'), 0);
  p.flushTimers(400);
  assert.equal(p.run('coverTestActions'), 1);
  p.run('coverClick({detail: 0}, () => coverTestActions++, {album: {artwork: "cover"}})');
  assert.equal(p.run('coverTestActions'), 2, 'Keyboard activates immediately');
  p.run('coverClick({detail: 1}, () => coverTestActions++, null)');
  assert.equal(p.run('coverTestActions'), 3, 'Titles and placeholders activate immediately');
  p.run('coverClick({detail: 1}, () => coverTestActions++, {album: {artwork: "cover"}}); coverClick({detail: 2}, () => coverTestActions++, {album: {artwork: "cover"}})');
  const origin = p.nodes.get("#home");
  const coverNode = {dataset: {coverSrc: "https://art.example/artwork/77-300", coverName: "Cover <title>", coverArtist: "Artist & friends"}, closest: () => origin};
  await p.emitDocument('dblclick', {preventDefault() { actionCount++; },
    target: {closest: selector => selector === '#album-page [data-cover-preview]' ? coverNode : null}});
  p.flushTimers(400);
  assert.equal(p.run('coverTestActions'), 3, 'The double-click cancels the pending single action');
  assert.equal(actionCount, 1);
  assert.equal(p.run('coverLightbox.open'), true);
  assert.equal(p.nodes.get('#cover-lightbox').open, true);
  assert.equal(p.nodes.get('#cover-lightbox-title').textContent, 'Cover <title>');
  assert.equal(p.nodes.get('#cover-lightbox-image').src, 'https://art.example/artwork/77-1000');
  assert.equal(p.run('document.activeElement === $("#cover-lightbox-close")'), true);
  assert.equal(p.requests.length, requests, 'No library download or write');
  assert.equal(p.history.length, entries);
  assert.equal(p.location.hash, route);
  await p.nodes.get('#cover-lightbox-image').emit('load');
  assert.equal(p.nodes.get('#cover-lightbox-status').textContent, '');
  await p.nodes.get('#cover-lightbox-close').emit('click');
  assert.equal(p.run('coverLightbox.open'), false);
  assert.equal(p.run('document.activeElement === $("#home")'), true);
  assert.equal(p.nodes.get('#cover-lightbox-image').src, undefined);
});

test("player covers keep immediate actions without enlargement; the album viewer preserves audio", async () => {
  const p = livePage(); await settle();
  p.run('const coverAlbum = state.details.get("1"); coverAlbum.artwork = "https://art.example/artwork/9-300"; playTracks(coverAlbum, "100"); setNowPlaying(false)');
  const source = p.nodes.get('#audio').src, queue = p.json('player.queue'), route = p.location.hash;
  await p.nodes.get('#player-cover-button').emit('click', {detail: 1});
  assert.equal(p.nodes.get('#now-playing-panel').hidden, false, 'One click opens Now playing immediately');
  const origin = p.nodes.get('#player-cover-button');
  await p.emitDocument('dblclick', {preventDefault() {}, target: {closest: selector => selector === '#player-cover-button, .visual-player-cover' ? origin : null}});
  assert.equal(p.run('coverLightbox.open'), false);
  p.run('openCoverLightbox({album: player.queue[player.index].album})');
  await p.emitDocument('keydown', {key: 'Escape', preventDefault() { this.defaultPrevented = true; }});
  assert.equal(p.run('coverLightbox.open'), false);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').paused, false);
  p.run('openVisualPlayer(); openCoverLightbox({album: player.queue[player.index].album, focus: $("#visual-player-close")})');
  assert.equal(p.run('visualPlayer.open && coverLightbox.open'), true);
  await p.emitDocument('keydown', {key: 'Escape', preventDefault() { this.defaultPrevented = true; }});
  assert.equal(p.run('visualPlayer.open'), true);
  assert.equal(p.run('coverLightbox.open'), false);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.location.hash, route);
  p.run('openCoverLightbox({album: player.queue[player.index].album}); closeVisualPlayer()');
  assert.equal(p.run('coverLightbox.open'), false);
});

test("cover previews handle missing images, try the existing cover once and close on library replacement", async () => {
  const p = page(); await settle();
  p.run('openCoverLightbox({album: {name: "No image", artwork: ""}})');
  assert.equal(p.run('coverLightbox.open'), false);
  p.run('openCoverLightbox({album: {name: "Album", artwork: "https://art.example/artwork/9-300"}})');
  await p.nodes.get('#cover-lightbox-image').emit('error');
  assert.equal(p.nodes.get('#cover-lightbox-image').src, 'https://art.example/artwork/9-300');
  await p.nodes.get('#cover-lightbox-image').emit('error');
  assert.equal(p.nodes.get('#cover-lightbox-image').hidden, true);
  assert.match(p.nodes.get('#cover-lightbox-status').textContent, /could not be loaded/);
  p.run('useLocal(demoLibrary(), "demo")');
  assert.equal(p.run('coverLightbox.open'), false);
  assert.equal(p.nodes.get('#cover-lightbox-image').src, undefined);
  p.run('openCoverLightbox({album: {name: "External cover", artwork: "https://provider.example/image-300.jpg"}})');
  assert.equal(p.nodes.get('#cover-lightbox-image').src, 'https://provider.example/image-300.jpg');
  await p.nodes.get('#cover-lightbox-image').emit('error');
  assert.equal(p.nodes.get('#cover-lightbox-image').hidden, true);
  const dialog = p.nodes.get('#cover-lightbox');
  dialog.getBoundingClientRect = () => ({left: 100, right: 500, top: 100, bottom: 500});
  await dialog.emit('click', {target: dialog, clientX: 50, clientY: 50});
  assert.equal(p.run('coverLightbox.open'), false);
});

test("Play next keeps whole albums in FIFO order, consumes Up next and preserves the base queue", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), "100"); appendToQueue(state.details.get("2"), null, true); appendToQueue(state.details.get("3"), null, true)');
  const ordered = p.json('player.queue.map(t => t.id)');
  const first = p.json('queueTracks(state.details.get("1")).map(t => t.id)');
  const next = p.json('[...queueTracks(state.details.get("2")), ...queueTracks(state.details.get("3"))].map(t => t.id)');
  assert.deepEqual(ordered, [first[0], ...next, ...first.slice(1)]);
  assert.deepEqual(p.json('encodedLocalQueue().tracks'), first.map(Number));
  assert.deepEqual(p.json('encodedLocalQueue().play_next'), next.map(Number));
  p.run('step(1)');
  assert.equal(p.run('encodedLocalQueue().data.play_from'), 'play_next');
  assert.equal(p.run('encodedLocalQueue().data.play_index'), 1);
  p.run('step(1)');
  assert.equal(p.run('player.queue.some(t => t.id === ' + JSON.stringify(next[0]) + ' && t.upNext)'), false);
  p.run('stopPlayer(); playTracks(state.details.get("1"), "100"); player.repeat = "queue"; player.index = player.queue.length - 1');
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.index'), 0);
  p.run('player.repeat = "track"; player.index = 1');
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.index'), 1);
  p.run('player.repeat = "none"; player.index = player.queue.length - 1');
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.index'), first.length - 1);
});

test("Quality changes apply on the next song, label file and stream separately, and Original falls back once", async () => {
  const p = livePage(); await settle();
  p.run('state.connection.premium = true; state.details.get("1").tracks[0].format = "FLAC"; lookup.streamQuality = "320"; playTracks(state.details.get("1"), "100")');
  const audio = p.nodes.get('#audio');
  assert.match(audio.src, /quality=320/);
  assert.equal(p.nodes.get('#player-quality').textContent, 'File: FLAC · Stream: MP3 320 kbps');
  p.run('applyPlaybackSettings({record_plays: false, stream_quality: "orig"})');
  assert.match(audio.src, /quality=320/, 'Settings do not interrupt playback');
  p.run('playCurrent()');
  assert.match(audio.src, /quality=orig/);
  await audio.emit('error');
  assert.match(audio.src, /quality=128/);
  assert.match(p.nodes.get('#player-quality').textContent, /fallback/);
  await audio.emit('error');
  assert.equal(p.run('player.fallback'), true);
  p.run('state.connection.premium = false; lookup.streamQuality = "320"; playCurrent()');
  assert.match(audio.src, /quality=128/);
});

test("A queue controller cannot start audio, advance on ended or record a play", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), "100"); audio.pause(); state.connection.playback_session = "controller-test-session"; queueSync.active = true; queueSync.allowed = true; queueSync.view = {owner: queueSync.browser, own: true, state: {role: "controller"}}; applyPlaybackSettings({record_plays: true}); beginPlaybackWatch()');
  const ids = p.json('player.queue.map(t => t.id)'), index = p.run('player.index');
  p.run('playTracks(state.details.get("2"), "200")');
  assert.equal(p.nodes.get('#audio').paused, true);
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ids);
  assert.equal(p.run('playReporting.watch'), null);
  await p.nodes.get('#audio').play();
  assert.equal(p.nodes.get('#audio').paused, true, 'Native audio controls cannot start a controller');
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.index'), index);
  assert.ok(p.requests.every(r => r.url !== '/api/play'));
});

test("Playlist review keeps order, escapes labels and sends nothing before the save button", async () => {
  const p = livePage(); await settle();
  p.setFetch(url => ({ok: true, json: async () => url.startsWith('/api/playlists') ? {playlists: []} : {}}));
  await p.run('openPlaylistSave(queueTracks(state.details.get("1")))');
  await p.run(`reviewPlaylist({elements: {destination: {value: "new"}, name: {value: "<New playlist>"}, description: {value: ""}}, querySelectorAll: () => playlistDraft.tracks.map(t => ({value: t.id, checked: true}))})`);
  assert.equal(p.run('playlistDraft.body.action'), 'create');
  assert.deepEqual(p.json('playlistDraft.body.tracks'), p.json('queueTracks(state.details.get("1")).map(t => Number(t.id))'));
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML, /&lt;New playlist&gt;/);
  assert.ok(p.requests.every(r => r.url !== '/api/playlist'));
  p.setFetch(() => { throw Error('Network interrupted'); });
  await p.run('savePlaylistDraft()');
  assert.equal(p.run('playlistDraft.body'), null, 'An ambiguous creation is never retried');
  await p.run('savePlaylistDraft()');
  assert.equal(p.requests.filter(r => r.url === '/api/playlist').length, 1);
});

test("description-only playlist review sends only changed text and preserves playback and revised input", async () => {
  const p=livePage(); await settle();
  p.run('playTracks(state.details.get("1")); state.connection.playback_session="text-session"; const textEdit={id:"81",name:"My list",description:"Before",before_token:"text-snapshot"};');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  await p.run('openPlaylistSave(queueTracks(state.details.get("1")), textEdit)');
  const review=`reviewPlaylist({elements:{name:{value:"My list"},description:{value:"After <safe>"}},querySelectorAll:()=>playlistDraft.tracks.map(t=>({value:t.id,checked:true}))})`;
  await p.run(review);
  assert.deepEqual(p.json('playlistDraft.body'), {action:'metadata',playlist:'81',before_token:'text-snapshot',before_name:'My list',session:'text-session',approved:true,fields:{description:'After <safe>'}});
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/Track selection and order stay unchanged/);
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/Before.*After &lt;safe&gt;/s);
  assert.doesNotMatch(p.nodes.get('#playlist-dialog-content').innerHTML,/Replace the playlist|playlist-review-tracks/);
  await p.click({'[data-playlist-revise]':{}});
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/After &lt;safe&gt;<\/textarea>/);
  await p.run(review);
  p.setFetch((url,options)=> {
    if(url==='/api/playlist') {
      assert.deepEqual(JSON.parse(options.body).fields,{description:'After <safe>'});
      assert.equal('tracks' in JSON.parse(options.body),false);
      return {ok:true,json:async()=>({job:'text-check'})};
    }
    assert.equal(url,'/api/jobs/text-check');
    return {ok:true,json:async()=>({state:'done',results:[{id:'81',status:'saved'}]})};
  });
  await p.run('savePlaylistDraft()');
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test("playlist review avoids no-op writes and keeps explicit track removals separate from text edits", async () => {
  const p=livePage(); await settle();
  p.run('state.connection.playback_session="text-session"; const removalEdit={id:"81",name:"My list",description:"Before",before_token:"snapshot"};');
  await p.run('openPlaylistSave(queueTracks(state.details.get("1")), removalEdit)');
  await p.run(`reviewPlaylist({elements:{name:{value:"My list"},description:{value:"Before"}},querySelectorAll:()=>playlistDraft.tracks.map(t=>({value:t.id,checked:true}))})`);
  assert.equal(p.run('playlistDraft.body'),null);
  assert.match(p.nodes.get('#toast').textContent,/No playlist changes/);
  await p.run(`reviewPlaylist({elements:{name:{value:"My list"},description:{value:"After"}},querySelectorAll:()=>playlistDraft.tracks.map((t,i)=>({value:t.id,checked:i===0}))})`);
  assert.equal(p.run('playlistDraft.body.action'),'replace');
  assert.equal(p.run('playlistDraft.body.tracks.length'),1);
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/Replace the playlist with 1 track/);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist').length,0);
});

test("album ratings show the requested stars immediately, then confirm and repaint without refresh", async () => {
  const p = livePage(); await settle();
  await p.run('openAlbum("1")');
  p.run('playTracks(state.details.get("1"), "100")');
  const source = p.nodes.get('#audio').src, route = p.location.hash;
  let accept, verify;
  p.setFetch(url => new Promise(resolve => { if (url === '/api/album-rating') accept = resolve; else { assert.equal(url, '/api/jobs/rating'); verify = resolve; } }));
  const savingRating = p.run('rateAlbum(["1"], 4, false)');
  assert.match(p.nodes.get('#album-page').innerHTML, /Saving rating/);
  assert.equal((p.run('albumRatingControls([state.details.get("1")])').match(/★/g) || []).length, 4);
  assert.equal(p.run('state.details.get("1").rating || 0'), 0, 'Pending display is not a confirmed cached rating');
  accept({ok: true, json: async () => ({job: 'rating'})}); await settle();
  assert.match(p.nodes.get('#album-page').innerHTML, /checking iBroadcast/);
  verify({ok: true, json: async () => ({state: 'done', results: [{id: 1, rating: 4, status: 'saved'}]})});
  await savingRating;
  assert.equal(p.run('state.details.get("1").rating'), 4);
  assert.equal(p.run('state.albums.find(a => a.id === "1").rating'), 4);
  assert.match(p.nodes.get('#album-page').innerHTML, /saved and confirmed/);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.location.hash, route);
});

test("refused or stale album ratings do not leave a successful-looking cached rating", async () => {
  const p = livePage(); await settle(); await p.run('openAlbum("1")');
  p.setFetch(() => { throw Error('Rating refused'); });
  await p.run('rateAlbum(["1"], 5, false)');
  assert.equal(p.run('state.details.get("1").rating || 0'), 0);
  assert.equal(p.run('collectionsView.rating.pending'), false);
  assert.match(p.nodes.get('#album-page').innerHTML, /Rating refused/);
  let verify;
  p.setFetch(url => url === '/api/album-rating' ? {ok: true, json: async () => ({job: 'old'})}
    : new Promise(resolve => { verify = resolve; }));
  const rating = p.run('rateAlbum(["1"], 5, false)'); await settle();
  p.run('state.details = new Map([...state.details].map(([id, a]) => [id, structuredClone(a)]))');
  verify({ok: true, json: async () => ({state: 'done', results: [{id: '1', rating: 5, status: 'saved'}]})});
  await rating;
  assert.equal(p.run('state.details.get("1").rating || 0'), 0);
  assert.equal(p.run('collectionsView.busy'), false);
});

test("Add to playlist in the track dropdown loads and appends only the chosen track after review", async () => {
  const p = livePage(); await settle(); p.run('playTracks(state.details.get("1"), "100")');
  const row = p.json('queueTracks(state.details.get("2"))[0]'), queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  const destination = {id: '81', name: 'Singles', tracks: [100], before: [100], total: 1};
  p.setFetch((url, options) => {
    if (url === '/api/queue-tracks') { assert.deepEqual(JSON.parse(options.body).tracks, [Number(row.id)]); return {ok: true, json: async () => ({tracks: [row]})}; }
    if (url.startsWith('/api/playlists?id=')) return {ok: true, json: async () => destination};
    if (url === '/api/playlists') return {ok: true, json: async () => ({playlists: [destination]})};
    if (url === '/api/playlist') return {ok: true, json: async () => ({job: 'append'})};
    assert.equal(url, '/api/jobs/append'); return {ok: true, json: async () => ({state: 'done', results: [{id: '81', status: 'saved'}]})};
  });
  p.run(`$("#test-playlist-trigger").dataset = {queueAlbum: "2", queueTrack: ${JSON.stringify(row.id)}}`);
  await p.click({'[data-queue-album]': p.nodes.get('#test-playlist-trigger')});
  assert.equal(p.nodes.get('#queue-action-playlist').hidden, false);
  await p.nodes.get('#queue-action-playlist').emit('click');
  assert.equal(p.nodes.get('#playlist-dialog').open, true);
  assert.deepEqual(p.json('playlistDraft.tracks.map(t => t.id)'), [row.id]);
  await p.run(`reviewPlaylist({elements: {destination: {value: "81"}, name: {value: ""}, description: {value: ""}}, querySelectorAll: () => playlistDraft.tracks.map(t => ({value: t.id, checked: true}))})`);
  assert.equal(p.requests.filter(r => r.url === '/api/playlist').length, 0);
  await p.run('savePlaylistDraft()');
  const body = JSON.parse(p.requests.find(r => r.url === '/api/playlist').options.body);
  assert.equal(body.action, 'append'); assert.deepEqual(body.tracks, [Number(row.id)]);
  assert.deepEqual(body.before, [100]);
  assert.deepEqual(p.json('player.queue'), queue); assert.equal(p.nodes.get('#audio').src, source);
});

test("playlist deletion is reviewed, cancellation sends nothing, and deletion leaves playback intact", async () => {
  const p = livePage(); await settle(); p.run('playTracks(state.details.get("1"), "100")');
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  p.setFetch(url => ({ok: true, json: async () => url.startsWith('/api/playlists?id=') ? {id: '81', name: '<Old list>', before: [100], tracks: [100], total: 1}
    : url === '/api/playlist' ? {job: 'delete'} : {state: 'done', results: [{id: '81', status: 'saved'}]}}));
  await p.run('openPlaylistDelete("81")');
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML, /&lt;Old list&gt;/);
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML, /tracks stay in your music library/);
  assert.equal(p.requests.filter(r => r.url === '/api/playlist').length, 0);
  p.nodes.get('#playlist-dialog').close(); await p.run('savePlaylistDraft()');
  assert.equal(p.requests.filter(r => r.url === '/api/playlist').length, 0);
  await p.run('openPlaylistDelete("81");'); await p.run('savePlaylistDraft()');
  const body = JSON.parse(p.requests.find(r => r.url === '/api/playlist').options.body);
  assert.equal(body.action, 'delete'); assert.equal(body.confirm_delete, true);
  assert.equal(body.playlist, '81'); assert.deepEqual(body.before, [100]);
  assert.equal(p.nodes.get('#playlist-dialog').open, false);
  assert.deepEqual(p.json('player.queue'), queue); assert.equal(p.nodes.get('#audio').src, source);
});

test("Restoring a native queue stays paused and inserts Up next after the current base track", async () => {
  const p = livePage(); await settle();
  const rows = p.json('[...state.details.values()].flatMap(a => queueTracks(a))');
  p.setFetch((url, options) => {
    assert.equal(url, '/api/queue-tracks');
    const ids = JSON.parse(options.body).tracks;
    return {ok: true, json: async () => ({tracks: ids.map(id => rows.find(t => t.id === String(id)))})};
  });
  p.run(`state.connection.playback_session = "test-session"; queueSync.active = true; queueSync.allowed = false;
    queueSync.view = {owner:queueSync.browser, own:true, state:{role:"player", tracks:[100,101,102], play_next:[200], current_song:100,
    pause:true, start_position:7, start_time:Date.now()/1000, volume:0.5, data:{play_index:0,play_from:"tracks",repeat_mode:"queue"}}}`);
  await p.run('restoreQueue(queueSync.view)');
  assert.deepEqual(p.json('player.queue.map(t => t.id)'), ['100', '200', '101', '102']);
  assert.equal(p.run('player.index'), 0);
  assert.equal(p.nodes.get('#audio').paused, true, 'Restoration does not briefly play audio');
  await p.nodes.get('#audio').emit('loadedmetadata');
  assert.equal(p.nodes.get('#audio').currentTime, 7);
  assert.deepEqual(p.json('encodedLocalQueue().tracks'), [100, 101, 102]);
  assert.deepEqual(p.json('encodedLocalQueue().play_next'), [200]);
  assert.equal(p.run('player.repeat'), 'queue');
});

test("Finishing Up next at the end consumes it, retains the base queue and appending starts at the first new track", async () => {
  const p = livePage(); await settle();
  p.run('playTracks(state.details.get("1"), state.details.get("1").tracks.at(-1).id); appendToQueue(state.details.get("2"), null, true); while (player.index < player.queue.length - 1) step(1); player.repeat = "none"');
  await p.nodes.get('#audio').emit('ended');
  assert.equal(p.run('player.queue.some(t => t.upNext)'), false);
  assert.deepEqual(p.json('encodedLocalQueue().tracks'), p.json('state.details.get("1").tracks.map(t => Number(t.id))'));
  assert.equal(p.run('encodedLocalQueue().current_song'), 0);
  p.run('appendToQueue(state.details.get("3"))');
  assert.equal(p.run('player.queue[player.index].id'), p.run('String(state.details.get("3").tracks[0].id)'));
});

test("album breadcrumbs remember the actual tag source, filters, ordering and scroll", async () => {
  const p = page(); await settle();
  p.run('for (const album of state.details.values()) for (const track of album.tracks) track.tags=[{id:"10",name:"<Emusic>"}]');
  p.run('showBrowse("tags")'); await settle();
  p.run('showBrowse("tags","10",{label:"<Emusic>",sort:"name-desc"})'); await settle();
  p.run('window.scrollY=412; syncHistory()');
  const source = p.location.hash, random = p.json('browseView.randomIds');
  await p.run('openAlbum("1")');
  assert.match(p.nodes.get('#breadcrumb').innerHTML, /Tags.*&lt;Emusic&gt;.*Wish You Were Here/);
  assert.doesNotMatch(p.nodes.get('#album-page').innerHTML, /YOUR ALBUM|data-album-back/);
  assert.equal(p.history.state.albumOrigin.at(-1).saved.scrollY,412);
  await p.run('openAlbum("3")');
  assert.match(p.nodes.get('#breadcrumb').innerHTML, /Tags.*&lt;Emusic&gt;.*Hounds of Love/);
  p.nodes.get('#editor').showModal();
  await p.click({'[data-album-crumb]':{dataset:{albumCrumb:'1'}}});
  assert.equal(p.location.hash,'#/album/3','A draft stays open over its current page');
  p.nodes.get('#editor').close();
  await p.click({'[data-album-crumb]':{dataset:{albumCrumb:'1'}}}); await settle();
  p.flushTimers(0);
  assert.equal(p.location.hash,source);
  assert.equal(p.run('browseView.sort'),'name-desc');
  assert.deepEqual(p.json('browseView.randomIds'),random);
  assert.equal(p.run('window.scrollY'),412);
  p.history.forward(); await settle(); p.flushTimers(0);
  assert.equal(p.location.hash,'#/album/1');
  assert.match(p.nodes.get('#breadcrumb').innerHTML, /Tags.*&lt;Emusic&gt;/);
  p.run('state.details = new Map(state.details); renderAlbumView()');
  assert.doesNotMatch(p.nodes.get('#breadcrumb').innerHTML, /Emusic/,'A replaced library cannot reuse the old origin');
});

test("direct album breadcrumbs have a working Albums fallback and Workspace returns to artists", async () => {
  const p=page({hash:'#/album/3'}); await settle();
  assert.match(p.nodes.get('#breadcrumb').innerHTML,/Albums.*Hounds of Love/);
  await p.click({'[data-album-crumb]':{dataset:{albumCrumb:'0'}}});
  assert.equal(p.location.hash,'#/albums');
  await p.run('openAlbum("3")');
  await p.click({'[data-breadcrumb-root]':{}});
  assert.equal(p.location.hash,'#/artists');
});

test("breadcrumbs restore a decade's sampled order and reject a stale branch", async () => {
  const p=page(); await settle();
  p.run('showBrowse("decades","1980",{label:"1980s"})'); await settle();
  p.run('browseView.randomIds = browseAlbums().map(a=>String(a.id)).reverse(); renderBrowse(); window.scrollY=250');
  const sample=p.json('browseView.randomIds');
  await p.run('openAlbum("3")');
  await p.click({'[data-album-crumb]':{dataset:{albumCrumb:'1'}}}); await settle(); p.flushTimers(0);
  assert.equal(p.location.hash,'#/decades/1980');
  assert.deepEqual(p.json('browseView.randomIds'),sample);
  assert.equal(p.run('window.scrollY'),250);
  // A new branch drops remembered forward entries rather than jumping to an unrelated page.
  p.history.back(); await settle(); p.flushTimers(0);
  p.run('showScreen("albums"); render()');
  await p.run('openAlbum("1")');
  assert.match(p.nodes.get('#breadcrumb').innerHTML,/Albums.*Wish You Were Here/);
  assert.doesNotMatch(p.nodes.get('#breadcrumb').innerHTML,/1980s/);
});

test("More album actions only starts an empty reviewed trash selection after an explicit choice", async () => {
  const p=livePage(); await settle(); await p.run('openAlbum("1")');
  const trigger=p.run('document.querySelector("[data-album-more]")'); trigger.disabled=false;
  const length=p.history.length, count=p.requests.length;
  p.run('playTracks(state.details.get("1"))');
  const audio=p.nodes.get('#audio'), src=audio.src;
  await p.click({'[data-album-more]':trigger});
  assert.equal(p.nodes.get('#album-action-menu').hidden,false);
  assert.equal(trigger.getAttribute('aria-expanded'),'true');
  assert.equal(p.run('albumView.trash'),null);
  assert.equal(p.requests.length,count);
  await p.nodes.get('#album-action-menu').emit('keydown',{key:'Escape',preventDefault(){}});
  assert.equal(p.nodes.get('#album-action-menu').hidden,true);
  assert.equal(p.run('document.activeElement')===trigger,true);
  await p.click({'[data-album-more]':trigger}); await p.click({});
  assert.equal(p.nodes.get('#album-action-menu').hidden,true);
  await p.click({'[data-album-more]':trigger});
  await p.nodes.get('#album-action-trash').emit('click');
  assert.deepEqual(p.json('[...albumView.trash]'),[]);
  assert.match(p.nodes.get('#album-page').innerHTML,/0 of .* tracks selected/);
  assert.equal(p.nodes.get('#trash-review').open,undefined);
  assert.equal(p.history.length,length);
  assert.equal(audio.src,src); assert.equal(audio.paused,false);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test("More album actions rejects stale albums and library replacement", async () => {
  const p=livePage(); await settle(); await p.run('openAlbum("1")');
  const trigger=p.run('document.querySelector("[data-album-more]")'); trigger.disabled=false;
  p.run('openAlbumActions(document.querySelector("[data-album-more]")); state.details=new Map(state.details)');
  await p.nodes.get('#album-action-trash').emit('click');
  assert.equal(p.run('albumView.trash'),null);
  p.run('openAlbumActions(document.querySelector("[data-album-more]")); albumView.id="3"');
  await p.nodes.get('#album-action-trash').emit('click');
  assert.equal(p.run('albumView.trash'),null);
  p.run('albumView.id="1"; openAlbumActions(document.querySelector("[data-album-more]")); showScreen("albums")');
  assert.equal(p.nodes.get('#album-action-menu').hidden,true);
});

test("album rating choices stay neutral when empty and retain Clear for mixed disc ratings", async () => {
  const p=livePage(); await settle();
  assert.doesNotMatch(p.run('albumRatingControls([{id:"1",rating:0}])'),/is-selected|>Clear</);
  const rated=p.run('albumRatingControls([{id:"1",rating:3}])');
  assert.equal((rated.match(/is-selected/g)||[]).length,3);
  assert.match(rated,/>Clear</);
  const mixed=p.run('albumRatingControls([{id:"1",rating:0},{id:"2",rating:5}])');
  assert.match(mixed,/>Clear<.*Different disc ratings/);
  assert.doesNotMatch(mixed,/is-selected/);
  assert.match(p.run('albumRatingControls([{id:"1",rating:5}])'),/data-heart[^>]*aria-pressed="false"/);
});

test("the album release year opens the existing year browse without changing playback", async () => {
  const p = livePage(); await settle();
  p.run('state.details.get("3").year=1955; state.albums.find(a=>a.id==="3").year=1955');
  await p.run('openAlbum("3")');
  const year = p.run('albumYear(albumDiscs())');
  assert.match(p.nodes.get('#album-page').innerHTML, new RegExp(`class="album-year-link" data-browse-kind="years" data-browse-key="${year}"`));
  p.run('playTracks(state.details.get("3"))');
  const audio = p.nodes.get('#audio'), src = audio.src, queue = p.json('player.queue');
  const before = p.requests.length;
  p.setFetch(url => {
    assert.match(url, new RegExp(`/api/browse\\?.*kind=years.*key=${year}`));
    return {ok:true,json:async()=>({group:{key:String(year),label:String(year)},album_ids:['3']})};
  });
  await p.click({'[data-browse-kind]':{dataset:{browseKind:'years',browseKey:String(year),browseLabel:String(year)}}});
  assert.equal(p.location.hash,`#/years/${year}`);
  assert.equal(p.run('browseView.label'),String(year));
  assert.equal(p.run('browseAlbums()[0].id'),'3');
  assert.equal(audio.src,src); assert.equal(audio.paused,false);
  assert.deepEqual(p.json('player.queue'),queue);
  assert.equal(p.requests.slice(before).filter(r=>r.options?.method==='POST').length,0);
  p.history.back(); await settle();
  assert.equal(p.location.hash,'#/album/3');
  p.run('state.details.get("3").year=0; renderAlbumView()');
  assert.match(p.nodes.get('#album-page').innerHTML,/Year unknown/);
  assert.doesNotMatch(p.nodes.get('#album-page').innerHTML,/album-year-link/);
});

test("album hearts save locally without changing stars, playback or history", async () => {
  const p = livePage(); await settle(); await p.run('openAlbum("1")');
  p.run('state.details.get("1").rating=3; state.albums.find(a=>a.id==="1").rating=3; playTracks(state.details.get("1"),"100")');
  const source = p.nodes.get('#audio').src, queue = p.json('player.queue'), route = p.location.hash;
  const writes = [];
  p.setFetch((url, options) => {
    assert.equal(url, '/api/album-favourite');
    const body = JSON.parse(options.body); writes.push(body);
    return {ok: true, json: async () => ({results: body.albums.map(id => ({id, favourite: body.favourite}))})};
  });
  await p.run('toggleAlbumFavourite(["1"])');
  assert.equal(p.run('state.albumFavourites.has("1")'), true);
  assert.equal(p.run('state.details.get("1").rating'), 3);
  assert.equal((p.run('albumRatingControls([state.details.get("1")])').match(/★/g) || []).length, 3);
  await p.run('showCollections("album-favourites")'); await settle();
  assert.match(p.nodes.get('#collections-page').innerHTML, /Saved on this computer/);
  assert.match(p.nodes.get('#collections-page').innerHTML, /data-album="1"/);
  await p.run('toggleAlbumFavourite(["1"])');
  assert.equal(p.run('state.albumFavourites.has("1")'), false);
  assert.equal(p.run('state.details.get("1").rating'), 3);
  assert.deepEqual(writes.map(b => [b.before, b.favourite]), [[[false], true], [[true], false]]);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.run('state.history.length'), 0);
  assert.notEqual(p.location.hash, route, 'Only explicit navigation changes the route');
});

test("rating an album five stars or clearing its stars does not toggle its local heart", async () => {
  const p = livePage(); await settle(); await p.run('openAlbum("1")');
  let value;
  p.setFetch((url, options) => {
    if (url === '/api/album-rating') { value = JSON.parse(options.body).rating; return {ok: true, json: async () => ({job: 'stars'})}; }
    assert.equal(url, '/api/jobs/stars');
    return {ok: true, json: async () => ({state: 'done', results: [{id: '1', rating: value, status: 'saved'}]})};
  });
  await p.run('rateAlbum(["1"],5)');
  assert.equal(p.run('state.albumFavourites.has("1")'), false);
  assert.match(p.run('albumRatingControls([state.details.get("1")])'), /data-heart[^>]*aria-pressed="false"/);
  p.run('state.albumFavourites.add("1")');
  await p.run('rateAlbum(["1"],0)');
  assert.equal(p.run('state.albumFavourites.has("1")'), true);
  assert.equal(p.run('state.details.get("1").rating'), 0);
  assert.match(p.run('albumRatingControls([state.details.get("1")])'), /data-heart[^>]*aria-pressed="true"/);
});

test("album favourite failures and late responses cannot change another library", async () => {
  const p = livePage(); await settle(); await p.run('openAlbum("1")');
  p.setFetch(() => { throw Error('Local disk unavailable'); });
  await p.run('toggleAlbumFavourite(["1"])');
  assert.equal(p.run('state.albumFavourites.size'), 0);
  assert.match(p.nodes.get('#album-page').innerHTML, /Local disk unavailable/);
  let finish;
  p.setFetch(() => new Promise(resolve => { finish = resolve; }));
  const write = p.run('toggleAlbumFavourite(["1"])'); await settle();
  assert.equal(p.run('state.albumFavourites.size'), 0, 'Pending hearts are not confirmed local data');
  assert.match(p.nodes.get('#album-page').innerHTML, /data-heart[^>]*aria-pressed="true"/);
  p.run('useLocal(demoLibrary(),"demo")');
  finish({ok: true, json: async () => ({results: [{id: '1', favourite: true}]})});
  await write;
  assert.equal(p.run('state.albumFavourites.size'), 0);
  assert.equal(p.run('collectionsView.busy'), false);
});

test("local album favourites restore with the library and storage errors leave stars usable", async () => {
  const p = livePage(); await settle();
  const albums = p.json('state.albums');
  p.setFetch(url => {
    assert.equal(url, '/api/library');
    return {ok: true, json: async () => ({albums, artists: [], album_favourites: {albums: ['1']}})};
  });
  await p.run('loadLive()');
  assert.equal(p.run('state.albumFavourites.has("1")'), true);
  p.setFetch(() => ({ok: true, json: async () => ({albums, artists: [], album_favourites: {albums: null, error: 'Local favourites unavailable'}})}));
  await p.run('loadLive()');
  const controls = p.run('albumRatingControls([{id:"1",rating:4}])');
  assert.match(controls, /data-heart[^>]*disabled/);
  assert.doesNotMatch(controls, /data-album-rating="1"[^>]*disabled/);
  assert.match(controls, /Local favourites unavailable/);
  assert.equal(p.run('state.albumFavourites.size'), 0);
});

test("album rows omit their album artist, retain distinct credits and keep plain tracks to one line", async () => {
  const p = livePage(); await settle();
  assert.equal(p.run('albumTrackMetadata({artist:"Yma Sumac",artist_id:41},{artist:"Yma Sumac",artist_id:41,format:"FLAC"},{main:"FLAC"})'), '');
  const credits = p.run(`albumTrackMetadata({artist:"Yma Sumac",artist_id:41},
    {artist:"Yma Sumac",performers:[{id:"41",name:"Yma Sumac"},{id:"62",name:"Billy May"},{id:"63",name:"Moises Vivanco"},{id:"99",name:"  YMA  SUMAC "},{id:"62",name:"Billy May"}],composers:["Composer <name>"],format:"FLAC"}, {main:"FLAC"})`);
  assert.doesNotMatch(credits, /Sumac|SUMAC/);
  assert.equal((credits.match(/>Billy May<\/button>/g)||[]).length,1);
  assert.match(credits,/data-performer-id="62"/);
  assert.match(credits,/data-performer-id="63"/);
  assert.match(credits,/Composer: Composer &lt;name&gt;/);
  const compilation = p.run('albumTrackMetadata({artist:"Various Artists",artist_id:0},{artist:"Guest Artist",artist_id:42},{main:""})');
  assert.match(compilation,/data-performer-id="42"[^>]*>Guest Artist/);
  const count = p.requests.length;
  await p.run('openAlbum("1")');
  const row = p.nodes.get('#album-page').innerHTML.match(/<tr data-row="100">([\s\S]*?)<\/tr>/)[1];
  assert.match(row,/<td><strong>Shine On You Crazy Diamond \(Parts I–V\)<\/strong><span data-lyrics-label="100" hidden><\/span><\/td>/);
  assert.doesNotMatch(row,/album-track-meta|>Pink Floyd<|class="track-tags"/);
  assert.match(row,/data-track-tags="100"/,'Untagged tracks retain tag management in their actions');
  assert.ok(p.requests.slice(count).every(r=>r.url.startsWith('/api/album-guide/album?')||r.url.startsWith('/api/lyrics/cache?')));
});

test("album format summaries distinguish a common format, ties and missing file metadata", async () => {
  const p = livePage(); await settle();
  assert.deepEqual(p.json('albumTrackFormats([{format:"FLAC"},{format:"FLAC"}])'),{main:'FLAC',label:'FLAC'});
  assert.deepEqual(p.json('albumTrackFormats([{format:"FLAC"},{format:"MP3"},{format:"FLAC"}])'),{main:'FLAC',label:'FLAC · mixed formats'});
  assert.deepEqual(p.json('albumTrackFormats([{format:"MP3"},{format:"FLAC"}])'),{main:'',label:'FLAC / MP3'});
  assert.deepEqual(p.json('albumTrackFormats([{format:"FLAC"},{}])'),{main:'FLAC',label:'FLAC (known files)'});
  assert.deepEqual(p.json('albumTrackFormats([{},{}])'),{main:'',label:''});
  p.run('state.details.get("1").tracks.forEach((t,i)=>{t.format=i===2?"MP3":"FLAC";t.length=60})');
  const before = p.requests.length;
  await p.run('openAlbum("1")');
  const html=p.nodes.get('#album-page').innerHTML;
  assert.match(html,/track-list-summary">5 tracks · 5:00 · FLAC · mixed formats/);
  assert.equal((html.match(/track-format-exception/g)||[]).length,1);
  assert.match(html,/title="File format: MP3 · album mainly FLAC">MP3/);
  assert.doesNotMatch(html,/class="track-format"/,'Repeated file labels are absent from ordinary time cells');
  assert.ok(p.requests.slice(before).every(r=>r.url.startsWith('/api/album-guide/album?')||r.url.startsWith('/api/lyrics/cache?')));
});

test("track tags and unusual formats add metadata without a repeated album artist or an empty row", async () => {
  const p=livePage(); await settle();
  const html=p.run('albumTrackMetadata({artist:"A"},{id:"1",artist:"A",tags:[{id:"9",name:"Listen <later>"}],format:"MP3"},{main:"FLAC"})');
  assert.match(html,/data-browse-kind="tags" data-browse-key="9"/);
  assert.match(html,/Listen &lt;later&gt;/);
  assert.match(html,/track-format-exception/);
  assert.doesNotMatch(html,/>A<|Tags…|data-track-tags/);
  assert.match(p.run('trackTagControls({id:"1"},{id:"2",title:"Title <unsafe>"})'),/aria-label="Manage tags for Title &lt;unsafe&gt;"/);
  assert.equal(p.run('albumTrackMetadata({artist:"A"},{artist:"A",tags:[],format:"FLAC"},{main:"FLAC"})'),'');
});

test("compact rows keep cleanup formats, upload advice and adjustable track selection", async () => {
  const p=livePage(); await settle();
  p.run('state.details.get("1").tracks.forEach(t=>{t.format="FLAC";t.uploaded_on="2026-10-01";t.uploaded_at="2026-10-01T12:00:00"})');
  await p.run('openAlbum("1")'); p.run('startAlbumTrash()');
  const html=p.nodes.get('#album-page').innerHTML;
  assert.match(html,/album-tracklist trash-mode/);
  assert.equal((html.match(/class="track-format" title="File format">FLAC/g)||[]).length,5);
  assert.match(html,/Uploaded 2026-10-01/);
  assert.match(html,/data-trash-track="100"/);
  assert.match(html,/track-row-actions/);
  assert.equal(p.run('albumView.trash.size'),0);
});

test("artist hearts save locally for the complete native group without stars, history or audio changes", async () => {
  const p = livePage(); await settle();
  p.run('state.connection.playback_session="artist-session"; state.albums[1].artist_id=42; setArtist("Pink Floyd"); playTracks(state.details.get("1"))');
  const ratings = p.json('state.albums.map(a=>a.rating)'), history = p.history.length, src = p.nodes.get('#audio').src;
  assert.match(p.nodes.get('#page-title').innerHTML, /data-artist-favourite="Pink Floyd"/);
  let finish;
  p.setFetch((url, options) => {
    assert.equal(url, '/api/artist-favourite');
    assert.deepEqual(JSON.parse(options.body), {artists: ['42'], name: 'Pink Floyd', session: 'artist-session', before: false, favourite: true});
    return new Promise(resolve => { finish = resolve; });
  });
  const task = p.run('toggleArtistFavourite("Pink Floyd")'); await settle();
  assert.match(p.nodes.get('#page-title').innerHTML, /aria-pressed="true" aria-busy="true"/);
  assert.deepEqual(p.json('[...state.artistFavourites]'), [], 'Pending choices are not confirmed favourites');
  finish({ok: true, json: async () => ({results: [{id: '42', favourite: true}]})}); await task;
  assert.deepEqual(p.json('[...state.artistFavourites]'), ['42']);
  assert.deepEqual(p.json('state.albums.map(a=>a.rating)'), ratings);
  assert.deepEqual(p.json('[...state.albumFavourites]'), []);
  assert.equal(p.run('state.history.length'), 0);
  assert.equal(p.history.length, history);
  assert.equal(p.nodes.get('#audio').src, src); assert.equal(p.nodes.get('#audio').paused, false);
  p.run('showArtistBrowse(); $("#artists-filter").value="favourites"; renderArtistBrowse()');
  assert.equal(p.nodes.get('#artists-results').textContent, '1 album artist');
  assert.match(p.nodes.get('#artists-grid').innerHTML, /Favourite artist/);
  assert.doesNotMatch(p.nodes.get('#artists-grid').innerHTML, /data-browse-artist="Kate Bush"/);
  assert.equal(p.requests.filter(r=>r.url.includes('artist-biography')).length, 0);
});

test("artist favourites preserve filters, paging and playback on Back and restore from the local server", async () => {
  const p = livePage(); await settle();
  const albums = p.json('state.albums');
  p.setFetch(url=>({ok:true,json:async()=>url.startsWith('/api/library') ? {albums, artists: [], artist_favourites:{artists:['42']}} : {}}));
  await p.run('loadLive()');
  assert.deepEqual(p.json('[...state.artistFavourites]'), ['42']);
  p.run('state.albums=Array.from({length:60},(_,i)=>({...state.albums[0],id:String(i),artist_id:i+1,artist:"Artist "+String(i).padStart(2,"0")})); state.artistFavourites=new Set(state.albums.map(a=>String(a.artist_id))); showArtistBrowse(); $("#artists-filter").value="favourites"; artistBrowse.page=1; renderArtistBrowse()');
  const requests = p.requests.length;
  await p.click({'[data-browse-artist]': {dataset:{browseArtist:'Artist 24'}}});
  await p.nodes.get('#artist-back').emit('click');
  assert.equal(p.nodes.get('#artists-filter').value, 'favourites');
  assert.equal(p.run('artistBrowse.page'), 1);
  assert.match(p.nodes.get('#artists-grid').innerHTML, /Artist 24/);
  assert.equal(p.requests.length, requests, 'Filtering and navigation use summaries, not track details');
});

test("artist favourite failures and late replies cannot change another library", async () => {
  const p=livePage(); await settle();
  p.run('setArtist("Pink Floyd")');
  let finish;
  p.setFetch(()=>new Promise(resolve=>{finish=resolve;}));
  const task=p.run('toggleArtistFavourite("Pink Floyd")'); await settle();
  p.run('useLocal(demoLibrary(),"demo")');
  finish({ok:true,json:async()=>({results:[{id:'42',favourite:true}]})}); await task;
  assert.deepEqual(p.json('[...state.artistFavourites]'), []);
  p.run('state.mode="live"; state.albums[0].artist_id=42; setArtist("Pink Floyd")');
  p.setFetch(()=>({ok:false,status:409,json:async()=>({error:'Favourite changed. Reload the library.'})}));
  await p.run('toggleArtistFavourite("Pink Floyd")');
  assert.deepEqual(p.json('[...state.artistFavourites]'), []);
  assert.match(p.nodes.get('#artist-favourite-status').textContent,/Reload the library/);
  p.run('state.artistFavouriteError="Could not read artist-favourites.json"; renderArtistProfile()');
  assert.match(p.nodes.get('#page-title').innerHTML,/disabled/);
});

test("artist biographies are opt-in, lazy and cached, and provider text is escaped", async () => {
  const p=livePage(); await settle();
  p.run('state.connection.playback_session="bio-session"; setArtist("Pink Floyd"); playTracks(state.details.get("1"))');
  assert.equal(p.nodes.get('#artist-biography').hidden,true);
  assert.equal(p.requests.filter(r=>r.url==='/api/artist-biography').length,0);
  const src=p.nodes.get('#audio').src, history=p.history.length;
  let reads=0, lookups=0, finish;
  p.setFetch((url,options)=>{
    assert.equal(url,'/api/artist-biography'); const body=JSON.parse(options.body);
    assert.equal(body.name,'Pink Floyd');
    if(!body.lookup){reads++;return {ok:true,json:async()=>({enabled:true,status:'not_cached',needs_lookup:true})};}
    lookups++; return new Promise(resolve=>{finish=resolve;});
  });
  p.run('applyArtistSettings({artist_biographies:true})'); await settle();
  assert.equal(reads,1); assert.equal(lookups,1);
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Loading artist biography/);
  finish({ok:true,json:async()=>({enabled:true,status:'ready',biography:'A <script>bad()<\/script> & B.\n\nSecond paragraph.',url:'https://www.theaudiodb.com/artist/123',needs_lookup:false})}); await settle();
  const html=p.nodes.get('#artist-biography').innerHTML;
  assert.match(html,/About this artist/); assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; B/);
  assert.doesNotMatch(html,/<script>/); assert.match(html,/Second paragraph/); assert.match(html,/TheAudioDB ↗/);
  p.run('showArtistBrowse(); setArtist("Pink Floyd"); render()'); await settle();
  assert.equal(reads,1); assert.equal(lookups,1);
  assert.equal(p.nodes.get('#audio').src,src); assert.equal(p.nodes.get('#audio').paused,false);
  assert.equal(p.run('state.history.length'),0);
  assert.ok(p.history.length>=history,'Only normal artist navigation adds history');
});

test("stored biography displays immediately and remains available when its refresh fails", async () => {
  const p=livePage(); await settle(); p.run('setArtist("Pink Floyd")');
  let finish;
  p.setFetch((url,options)=>{
    const body=JSON.parse(options.body);
    return body.lookup ? new Promise(resolve=>{finish=resolve;})
      : {ok:true,json:async()=>({enabled:true,status:'ready',biography:'Stored biography.',url:'https://www.theaudiodb.com/artist/123',needs_lookup:true})};
  });
  p.run('applyArtistSettings({artist_biographies:true})'); await settle();
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Stored biography/);
  finish({ok:false,status:400,json:async()=>({error:'TheAudioDB is busy. Try later.'})}); await settle();
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Stored biography/);
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Try again/);
  assert.match(p.nodes.get('#artist-biography').innerHTML,/TheAudioDB is busy/);
});

test("biography reads and lookups cannot repaint after navigation, disable or library replacement", async () => {
  for(const change of ['navigate','disable','replace']){
    const p=livePage(); await settle(); p.run('setArtist("Pink Floyd")'); let finish;
    p.setFetch(()=>new Promise(resolve=>{finish=resolve;}));
    p.run('applyArtistSettings({artist_biographies:true})'); await settle();
    const first = finish;
    if(change==='navigate')p.run('setArtist("Kate Bush")');
    else if(change==='disable')p.run('applyArtistSettings({artist_biographies:false})');
    else p.run('useLocal(demoLibrary(),"demo"); render()');
    first({ok:true,json:async()=>({enabled:true,status:'ready',biography:'Wrong artist text.',needs_lookup:true})}); await settle();
    assert.doesNotMatch(p.nodes.get('#artist-biography').innerHTML,/Wrong artist text/);
    assert.equal(p.requests.filter(r=>r.url==='/api/artist-biography'&&JSON.parse(r.options.body).lookup).length,0);
  }
});

test("Settings enables biographies only on saving and missing biographies stay compact", async () => {
  const p=livePage(); await settle();
  p.run('lookup.sources=[{name:"theaudiodb",label:"TheAudioDB",enabled:true}]; openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML,/name="artist_biographies" > Show artist biographies/);
  assert.equal(p.requests.filter(r=>r.url==='/api/artist-biography').length,0);
  p.setFetch((url,options)=>({ok:true,json:async()=>url==='/api/settings' ? {sources:[],auto_lookup:false,...JSON.parse(options.body)}
    : {enabled:true,status:'ambiguous',needs_lookup:false}}));
  await p.run('saveSettings({elements:{auto_lookup:{checked:false},auto_updates:{checked:false},artist_biographies:{checked:true}},querySelectorAll:()=>[]})');
  assert.equal(p.run('artistProfile.enabled'),true);
  assert.equal(p.requests.filter(r=>r.url==='/api/artist-biography').length,0,'Enabling does not scan artists');
  p.run('setArtist("Pink Floyd")'); await settle();
  assert.match(p.nodes.get('#artist-biography').innerHTML,/More than one artist matches/);
  assert.doesNotMatch(p.nodes.get('#artist-biography').innerHTML,/<details/);
});

test('one Favourites shortcut switches three independent lists without writes, detail downloads or playback changes', async () => {
  const p = livePage(); await settle();
  p.run('state.albumFavourites.add("1"); state.artistFavourites.add("42"); playTracks(state.details.get("1"))');
  const src = p.nodes.get('#audio').src, queue = p.json('player.queue'), ratings = p.json('state.albums.map(a=>a.rating)');
  const count = p.requests.length;
  p.setFetch(url => {
    assert.match(url, /^\/api\/favourites\?/);
    return {ok:true,json:async()=>({tracks:[], total:0, count:2})};
  });
  p.run('showFavouriteView("albums")');
  assert.equal(p.location.hash, '#/album-favourites');
  assert.equal(p.nodes.get('#favourites-hub').hidden, false);
  assert.equal(p.nodes.get('#show-favourites').classList.contains('active'), true);
  assert.equal(p.nodes.get('#collections-page').getAttribute('role'), 'tabpanel');
  assert.equal(p.nodes.get('#favourites-tab-albums').getAttribute('aria-selected'), 'true');
  assert.equal(p.nodes.get('#favourites-tab-tracks').getAttribute('tabindex'), '-1');
  assert.match(p.nodes.get('#collections-page').innerHTML, /data-album="1"/);
  p.run('showFavouriteView("artists")');
  assert.equal(p.location.hash, '#/artist-favourites');
  assert.equal(p.nodes.get('#collections-page').hidden, true);
  assert.equal(p.nodes.get('#artist-favourites-page').hidden, false);
  assert.match(p.nodes.get('#favourite-artists-grid').innerHTML, /Open albums by Pink Floyd/);
  assert.equal(p.nodes.get('#favourite-artists-count').textContent, '1');
  assert.equal(p.requests.length, count, 'Album and artist tabs use only compact summaries');
  p.run('showFavouriteView("tracks")'); await settle();
  assert.equal(p.location.hash, '#/favourites');
  assert.equal(p.nodes.get('#artist-favourites-page').hidden, true);
  assert.equal(p.nodes.get('#favourites-count').textContent, '2');
  assert.equal(p.requests.length, count + 1, 'Only one server page of tracks is read');
  assert.deepEqual(p.json('state.albums.map(a=>a.rating)'), ratings);
  assert.equal(p.nodes.get('#audio').src, src);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.deepEqual(p.json('player.queue'), queue);
  const html = readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="show-album-favourites"/);
});

test('favourite tabs keep search and pagination on switching, Back and artist visits, independently of playlists', async () => {
  const p = livePage(); await settle();
  p.setFetch(url => ({ok:true,json:async()=>url.startsWith('/api/favourites')
    ? {tracks:[], total:120, count:120, offset:Number(new URL(url, 'http://test').searchParams.get('offset'))}
    : {playlists:[], total:0}}));
  p.run('$("#favourites-search").value="wish"; showFavourites(1)'); await settle();
  p.run('state.albums=Array.from({length:60},(_,i)=>({...state.albums[0],id:String(i+1),name:"Album "+i,artist_id:i+1,artist:"Artist "+String(i).padStart(2,"0")})); state.artistFavourites=new Set(state.albums.map(a=>String(a.artist_id))); state.albumFavourites=new Set(state.albums.map(a=>a.id)); showFavouriteView("albums"); collectionsView.query="Album"; collectionsView.offset=50; renderCollections()');
  p.run('showFavouriteView("artists"); $("#favourite-artists-search").value="Artist"; $("#favourite-artists-sort").value="za"; favouriteArtists.page=1; renderFavouriteArtists()');
  assert.match(p.nodes.get('#favourite-artists-pagination').innerHTML, /Page 2 of 3/);
  const requests = p.requests.length;
  await p.click({'[data-browse-artist]': {dataset:{browseArtist:'Artist 35'}}});
  p.history.back(); await settle();
  assert.equal(p.location.hash, '#/artist-favourites');
  assert.equal(p.nodes.get('#favourite-artists-search').value, 'Artist');
  assert.equal(p.nodes.get('#favourite-artists-sort').value, 'za');
  assert.equal(p.run('favouriteArtists.page'), 1);
  assert.equal(p.requests.length, requests);
  p.history.back(); await settle();
  assert.equal(p.location.hash, '#/album-favourites');
  assert.equal(p.run('collectionsView.query'), 'Album');
  assert.equal(p.run('collectionsView.offset'), 50);
  p.history.back(); await settle();
  assert.equal(p.location.hash, '#/favourites');
  assert.equal(p.nodes.get('#favourites-search').value, 'wish');
  assert.equal(p.run('favourites.page'), 1);
  p.run('showFavouriteView("albums"); showCollections("playlists")'); await settle();
  p.run('showFavouriteView("albums")');
  assert.equal(p.run('collectionsView.query'), 'Album');
  assert.equal(p.run('collectionsView.offset'), 50);
  p.run('showFavouriteView("artists"); showScreen("albums")');
  await p.nodes.get('#show-favourites').emit('click');
  assert.equal(p.location.hash, '#/artist-favourites', 'Sidebar reopens the last selected favourite type');
  assert.equal(p.nodes.get('#favourite-artists-search').value, 'Artist');
});

test('favourite tabs support keyboard selection and direct links, with safe empty and account replacement states', async () => {
  const p = page({hash:'#/artist-favourites'}); await settle();
  assert.equal(p.location.hash, '#/artist-favourites');
  assert.match(p.nodes.get('#favourite-artists-grid').innerHTML, /Connect iBroadcast/);
  p.run('state.mode="live"; state.artistFavouriteError="Cannot read <file>"; renderFavouriteArtists()');
  assert.match(p.nodes.get('#favourite-artists-grid').innerHTML, /Cannot read &lt;file&gt;/);
  p.run('state.artistFavouriteError=""; state.artistFavourites=new Set(["42"]); renderFavouriteArtists()');
  let prevented = 0;
  const target = kind => ({closest:()=>({dataset:{favouriteView:kind}})});
  await p.nodes.get('#favourites-tabs').emit('keydown', {key:'ArrowLeft',target:target('artists'),preventDefault(){prevented++;}});
  assert.equal(p.location.hash, '#/album-favourites');
  assert.equal(p.run('document.activeElement === $("#favourites-tab-albums")'), true);
  await p.nodes.get('#favourites-tabs').emit('keydown', {key:'End',target:target('albums'),preventDefault(){prevented++;}});
  assert.equal(p.location.hash, '#/artist-favourites');
  assert.equal(p.nodes.get('#favourites-tab-artists').getAttribute('tabindex'), '0');
  assert.equal(prevented, 2);
  p.run('useLocal(demoLibrary(), "demo"); showFavouriteArtists()');
  assert.match(p.nodes.get('#favourite-artists-grid').innerHTML, /Connect iBroadcast/);
  assert.doesNotMatch(p.nodes.get('#favourite-artists-grid').innerHTML, /data-browse-artist/);
  assert.ok(p.requests.every(r=>!r.options?.body), 'Navigation never changes any favourites');
});

test('legacy album-favourites shortcuts merge without losing the only visible favourite entry', async () => {
  const saved = {order:['show-album-favourites','show-favourites'],hidden:['show-favourites']};
  const p = page({storage:{'tagcast-sidebar':JSON.stringify(saved)}}); await settle();
  assert.equal(p.run('sidebarLayout.order[0]'), 'show-favourites');
  assert.equal(p.run('sidebarLayout.order.filter(id=>id==="show-favourites").length'), 1);
  assert.equal(p.run('sidebarLayout.order.includes("show-album-favourites")'), false);
  assert.equal(p.nodes.get('#show-favourites').hidden, false);
  saved.hidden.push('show-album-favourites');
  const hidden = page({storage:{'tagcast-sidebar':JSON.stringify(saved)}}); await settle();
  assert.equal(hidden.nodes.get('#show-favourites').hidden, true);
});

test('Settings exports the existing browser history without saving preferences or disturbing playback', async () => {
  const entry = {created:'2026-10-18T10:00:00Z',source:'ibroadcast',status:'saved',selection:[{id:'1',name:'Album'}],changes:[]};
  const p = page({storage:{'tagcast-history':JSON.stringify([entry])}}); await settle();
  p.run('state.mode="live"; playTracks(state.details.get("1")); openSettings()');
  const count = p.requests.length, queue = p.json('player.queue'), src = p.nodes.get('#audio').src, route = p.location.hash;
  assert.match(p.nodes.get('#settings-content').innerHTML, /<section class="history-settings">/);
  assert.match(p.nodes.get('#settings-content').innerHTML, /type="button" class="button small" id="export-button" >Export changes/);
  await p.click({'#export-button':{}});
  assert.equal(p.downloads.length, 1);
  const exported = JSON.parse(await p.downloads[0].blob.text());
  assert.equal(exported.format, 'tagcast-history');
  assert.deepEqual(exported.entries, [entry]);
  assert.equal(p.requests.length, count);
  assert.equal(p.nodes.get('#settings').open, true);
  assert.equal(p.location.hash, route);
  assert.equal(p.nodes.get('#audio').src, src);
  assert.deepEqual(p.json('player.queue'), queue);
  p.run('state.history=[]; openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML, /id="export-button" disabled/);
  const html = readFileSync(path.join(staticDir, 'index.html'),'utf8');
  assert.doesNotMatch(html.match(/<header class="topbar">.*?<\/header>/)[0], /export-button|Export changes/);
});

test('albums sort by native rating and latest upload, with unknown values last and all set discs included', async () => {
  const p=page(); await settle();
  p.run(`const sortedAlbums=[
    {id:'a',artist:'Artist',name:'Older',rating:2,uploaded_at:'2026-10-01T10:00:00'},
    {id:'b',artist:'Artist',name:'Newer',rating:5,uploaded_at:'2026-10-01T12:00:00'},
    {id:'c',artist:'Artist',name:'Unknown',rating:0,uploaded_at:''}];`);
  for (const [sort, expected] of [['rating_high',['b','a','c']],['rating_low',['a','b','c']],
    ['uploaded_newest',['b','a','c']],['uploaded_oldest',['a','b','c']]]) {
    assert.deepEqual(p.json(`[...sortedAlbums].sort(SORTS.${sort}).map(a=>a.id)`),expected);
  }
  assert.equal(p.run(`mergeDiscs([sortedAlbums[0],sortedAlbums[1]]).uploaded_at`),'2026-10-01T12:00:00');
  p.run('state.albums=sortedAlbums; $("#sort").value="uploaded_newest"; showScreen("albums"); render()');
  assert.deepEqual(p.json('filteredAlbums().map(a=>a.id)'),['b','a','c']);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('artist sorting uses native artist ratings instead of album stars and stays available in favourites and on Back', async () => {
  const p=livePage(); await settle();
  p.run(`state.albums=[
    {...state.albums[0],id:'a',artist:'Alpha',artist_id:11,artist_rating:1,rating:5},
    {...state.albums[0],id:'b',artist:'Beta',artist_id:12,artist_rating:5,rating:1},
    {...state.albums[0],id:'c',artist:'Unrated',artist_id:13,artist_rating:0,rating:3}];
    state.artistFavourites=new Set(['11','12','13']); showArtistBrowse(); $("#artists-sort").value='rating_high'; renderArtistBrowse()`);
  const requests=p.requests.length;
  assert.deepEqual(p.json('filteredArtistGroups().map(([name])=>name)'),['Beta','Alpha','Unrated']);
  await p.click({'[data-browse-artist]':{dataset:{browseArtist:'Beta'}}});
  p.history.back(); await settle();
  assert.equal(p.nodes.get('#artists-sort').value,'rating_high');
  p.run('showFavouriteArtists(); $("#favourite-artists-sort").value="rating_low"; renderFavouriteArtists()');
  const html=p.nodes.get('#favourite-artists-grid').innerHTML;
  assert.ok(html.indexOf('Open albums by Alpha')<html.indexOf('Open albums by Beta'));
  assert.ok(html.indexOf('Open albums by Beta')<html.indexOf('Open albums by Unrated'));
  p.run('showScreen("albums")'); p.history.back(); await settle();
  assert.equal(p.nodes.get('#favourite-artists-sort').value,'rating_low');
  assert.equal(p.requests.length,requests,'Rating sorts use compact summaries only');
  const pageHtml=readFileSync(path.join(staticDir,'index.html'),'utf8');
  assert.ok(p.json('Object.keys(artistSortLabels)').every(key=>!key.startsWith('uploaded')));
  assert.doesNotMatch(pageHtml.match(/<select id="favourite-artists-sort"[\s\S]*?<\/select>/)[0],/uploaded/);
});

test('artist stars save independently of local hearts, album stars, history and playback, and wait for read-back', async () => {
  const p=livePage(); await settle();
  p.run('state.connection.playback_session="rating-session"; state.albums[0].artist_rating=3; state.artistFavourites.add("42"); setArtist("Pink Floyd"); playTracks(state.details.get("1"))');
  const hearts=p.json('[...state.artistFavourites]'), albumStars=p.json('state.albums.map(a=>a.rating)'), history=p.json('state.history'), queue=p.json('player.queue'), src=p.nodes.get('#audio').src;
  let resolve;
  p.setFetch((url,options)=>{
    if(url==='/api/artist-rating') {
      assert.deepEqual(JSON.parse(options.body),{artists:['42'],name:'Pink Floyd',session:'rating-session',before:[3],rating:5});
      return new Promise(r=>{resolve=r;});
    }
    assert.equal(url,'/api/jobs/artist-rating');
    return {ok:true,json:async()=>({state:'done',results:[{id:'42',rating:5,status:'saved'}]})};
  });
  const pending=p.run('rateArtist(5)'); await settle();
  assert.equal(p.nodes.get('#artist-rating').getAttribute('aria-busy'),'true');
  assert.equal((p.nodes.get('#artist-rating').innerHTML.match(/aria-pressed="true"/g)||[]).length,5);
  assert.equal(p.run('state.albums[0].artist_rating'),3,'Pending stars are not yet confirmed');
  resolve({ok:true,json:async()=>({job:'artist-rating',error:''})}); await pending;
  assert.equal(p.run('state.albums[0].artist_rating'),5);
  assert.equal(p.run('state.details.get("1").artist_rating'),5);
  assert.equal(p.nodes.get('#artist-rating').getAttribute('aria-busy'),'false');
  assert.deepEqual(p.json('[...state.artistFavourites]'),hearts);
  assert.deepEqual(p.json('state.albums.map(a=>a.rating)'),albumStars);
  assert.deepEqual(p.json('state.history'),history);
  assert.deepEqual(p.json('player.queue'),queue);
  assert.equal(p.nodes.get('#audio').src,src);
});

test('refused and late artist ratings never leave optimistic stars in another account or library', async () => {
  const p=livePage(); await settle();
  p.run('state.connection.playback_session="rating-session"; state.albums[0].artist_rating=2; setArtist("Pink Floyd")');
  p.setFetch(()=>({ok:false,status:409,json:async()=>({error:'Artist rating changed elsewhere'})}));
  await p.run('rateArtist(5)');
  assert.equal(p.run('state.albums[0].artist_rating'),2);
  assert.equal((p.nodes.get('#artist-rating').innerHTML.match(/aria-pressed="true"/g)||[]).length,2);
  assert.match(p.nodes.get('#artist-rating').innerHTML,/changed elsewhere/);
  let resolve;
  p.setFetch(()=>new Promise(r=>{resolve=r;}));
  const pending=p.run('rateArtist(4)'); await settle();
  p.run('useLocal(demoLibrary(),"demo")');
  resolve({ok:true,json:async()=>({job:'late'})}); await pending;
  assert.equal(p.run('artistProfile.rating'),null);
  assert.equal(p.run('collectionsView.busy'),false);
  assert.equal(p.nodes.get('#artist-rating').hidden,true);
  assert.ok(p.json('state.albums.map(a=>a.artist_rating||0)').every(n=>n===0));
});

test('biographies recover from metadata and tag read-back while an old read or lookup completes', async () => {
  for (const write of ['metadata', 'tags']) for (const phase of ['read', 'lookup']) {
    const p=livePage(); await settle();
    p.run('state.connection.playback_session="review-session"; setArtist("Pink Floyd"); playTracks(state.details.get("1"))');
    const source=p.nodes.get('#audio').src, queue=p.json('player.queue');
    let finish, reads=0;
    const albums=p.json('state.albums');
    p.setFetch((url,options)=>{
      if (url==='/api/artist-biography') {
        const body=JSON.parse(options.body);
        if (!body.lookup) {
          reads++;
          if (reads>1) return {ok:true,json:async()=>({enabled:true,status:'ready',biography:'Fresh cached biography.',needs_lookup:false})};
          if (phase==='lookup') return {ok:true,json:async()=>({enabled:true,needs_lookup:true})};
        }
        return new Promise(resolve=>{finish=resolve;});
      }
      if (url==='/api/tags/save') return {ok:true,json:async()=>({job:'tags-refresh',sent:1})};
      return {ok:true,json:async()=>({state:'done',albums,results:write==='tags'?[{status:'saved'}]:[]})};
    });
    p.run('applyArtistSettings({artist_biographies:true})'); await settle();
    const old=p.run('[...artistProfile.entries.values()][0]');
    if (write==='metadata') {
      p.run('state.history=[{status:"sent",source:"ibroadcast",changes:[]}]');
      const job=p.run('followJob("metadata-refresh",state.history[0])');
      p.flushTimers(2000); await job;
    } else {
      p.run('tagDraft.details=state.details; tagDraft.session=state.connection.playback_session; tagDraft.body={action:"create",name:"Review tag"}');
      await p.run('saveTags()');
    }
    finish({ok:true,json:async()=>({enabled:true,status:'ready',biography:'Stale reply.',needs_lookup:false})});
    await settle();
    p.run('renderArtistProfile()'); await settle();
    assert.equal(old.loading,false,`${write}/${phase}: retired reads must finish`);
    assert.equal(reads,2,`${write}/${phase}: recover through a new cache read`);
    assert.match(p.nodes.get('#artist-biography').innerHTML,/Fresh cached biography/);
    assert.doesNotMatch(p.nodes.get('#artist-biography').innerHTML,/Loading artist biography|Stale reply/);
    assert.equal(p.nodes.get('#audio').src,source);
    assert.deepEqual(p.json('player.queue'),queue);
  }
});

test('a biography discarded while hidden is fetched on the next visit, never in the background', async () => {
  const p=livePage(); await settle(); p.run('setArtist("Pink Floyd")');
  let finish, reads=0;
  p.setFetch(()=>{
    reads++;
    return reads===1 ? new Promise(resolve=>{finish=resolve;})
      : {ok:true,json:async()=>({enabled:true,status:'ready',biography:'Revisited biography.',needs_lookup:false})};
  });
  p.run('applyArtistSettings({artist_biographies:true}); showArtistBrowse(); state.details=new Map(state.details)'); await settle();
  finish({ok:true,json:async()=>({enabled:true,status:'ready',biography:'Old text.'})}); await settle();
  assert.equal(reads,1);
  assert.equal(p.run('artistProfile.entries.size'),0);
  p.run('setArtist("Pink Floyd")'); await settle();
  assert.equal(reads,2);
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Revisited biography/);
});

test('confirmed multi-disc ratings refresh cached set values and the visible rating sort', async () => {
  const p=livePage(); await settle();
  p.run(`const ratedDiscOne=structuredClone(state.details.get("1"));
    Object.assign(ratedDiscOne,{id:"d1",name:"Rated set",disc:1,rating:0});
    const ratedDiscTwo={...structuredClone(ratedDiscOne),id:"d2",disc:2,rating:1};
    const ratedOther={...structuredClone(ratedDiscOne),id:"x",name:"Other album",rating:3};
    state.details=new Map([ratedDiscOne,ratedDiscTwo,ratedOther].map(a=>[a.id,a]));
    state.albums=[...state.details.values()].map(summarize);
    state.artist=null; state.screen="albums"; $("#sort").value="rating_high"; render()`);
  assert.equal(p.run('albumShelf().find(a=>a.id==="d1").ratingMixed'),true);
  let rating=5, partial=false;
  p.setFetch(url=>({ok:true,json:async()=>url==='/api/album-rating'?{job:'set-rating'}:
    {state:'done',results:['d1','d2'].map(id=>({id,rating:partial&&id==='d2'?0:rating,
      status:partial&&id==='d2'?'unverified':'saved'}))}}));
  const requests=p.requests.length;
  await p.run('rateAlbum(["d1","d2"],5)');
  assert.equal(p.run('albumShelf().find(a=>a.id==="d1").rating'),5);
  assert.equal(p.run('albumShelf().find(a=>a.id==="d1").ratingMixed'),false);
  assert.deepEqual(p.json('filteredAlbums().map(a=>a.id)'),['d1','x']);
  const html=p.nodes.get('#albums').innerHTML;
  assert.ok(html.indexOf('Rated set')<html.indexOf('Other album'),'Visible results repaint after read-back');
  p.run('$("#sort").value="rating_low"; render()');
  assert.deepEqual(p.json('filteredAlbums().map(a=>a.id)'),['x','d1']);
  rating=0;
  await p.run('rateAlbum(["d1","d2"],0)');
  assert.equal(p.run('albumShelf().find(a=>a.id==="d1").rating'),0);
  assert.deepEqual(p.json('filteredAlbums().map(a=>a.id)'),['x','d1']);
  assert.equal(p.requests.length,requests+4,'Only the two explicit writes and their read-backs are requested');
  partial=true; rating=5;
  await p.run('rateAlbum(["d1","d2"],5)');
  assert.equal(p.run('collectionsView.rating.error'),true);
  assert.equal(p.run('albumShelf().find(a=>a.id==="d1").rating'),0);
  assert.equal(p.run('albumShelf().find(a=>a.id==="d1").ratingMixed'),true,'Partial confirmation invalidates copied mixed-rating state too');
});

test('an artist heart survives a metadata read-back and uses its confirmed value on the next click', async () => {
  const p=livePage(); await settle();
  p.run('state.connection.playback_session="heart-review"; setArtist("Pink Floyd"); playTracks(state.details.get("1"))');
  const source=p.nodes.get('#audio').src, queue=p.json('player.queue'), albums=p.json('state.albums');
  let finish;
  p.setFetch(url=>url==='/api/artist-favourite' ? new Promise(resolve=>{finish=resolve;})
    : {ok:true,json:async()=>({state:'done',results:[],albums})});
  const heart=p.run('toggleArtistFavourite("Pink Floyd")'); await settle();
  p.run('state.history=[{status:"sent",source:"ibroadcast",changes:[]}]');
  const job=p.run('followJob("heart-readback",state.history[0])');
  p.flushTimers(2000); await job;
  finish({ok:true,json:async()=>({results:[{id:'42',favourite:true}]})}); await heart;
  assert.equal(p.run('artistProfile.favourite.pending'),false);
  assert.deepEqual(p.json('[...state.artistFavourites]'),['42']);
  assert.equal(p.nodes.get('#artist-favourite-status').hidden,true);
  assert.match(p.nodes.get('#page-title').innerHTML,/aria-pressed="true" aria-busy="false"/);
  p.setFetch((url,options)=>{
    assert.equal(JSON.parse(options.body).before,true);
    return {ok:true,json:async()=>({results:[{id:'42',favourite:false}]})};
  });
  await p.run('toggleArtistFavourite("Pink Floyd")');
  assert.equal(p.run('state.artistFavourites.size'),0);
  assert.equal(p.nodes.get('#audio').src,source);
  assert.deepEqual(p.json('player.queue'),queue);
  assert.equal(p.run('state.history.length'),1,'Hearts add no metadata history');
});

test('biography retries show their wait and become available without automatically contacting the provider', async () => {
  const p=livePage(); await settle();
  p.run('let biographyReviewClock=1000000; Date.now=()=>biographyReviewClock; setArtist("Pink Floyd")');
  let lookups=0, finishRetry;
  p.setFetch((url,options)=>{
    if (!JSON.parse(options.body).lookup) return {ok:true,json:async()=>({enabled:true,status:'ready',biography:'Stored text.',needs_lookup:true})};
    lookups++;
    return lookups===1 ? {ok:false,status:429,json:async()=>({error:'TheAudioDB is busy.',retry_after:60})}
      : new Promise(resolve=>{finishRetry=resolve;});
  });
  p.run('applyArtistSettings({artist_biographies:true})'); await settle();
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Stored text/);
  const retryTime=p.run('new Date(biographyReviewClock+60000).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit"})');
  assert.ok(p.nodes.get('#artist-biography').innerHTML.includes(`data-artist-biography-retry disabled>Try again at ${retryTime}`));
  const requests=p.requests.length;
  await p.click({'[data-artist-biography-retry]':{}});
  assert.equal(p.requests.length,requests,'Even a synthetic click cannot bypass the wait');
  p.run('biographyReviewClock+=60000'); p.flushTimers(60000); await settle();
  assert.equal(p.requests.length,requests,'Expiry only enables the retry button');
  assert.match(p.nodes.get('#artist-biography').innerHTML,/data-artist-biography-retry>Try again/);
  await p.click({'[data-artist-biography-retry]':{}}); await settle();
  assert.equal(lookups,2);
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Stored text/,'Retry keeps cached text visible while loading');
  finishRetry({ok:true,json:async()=>({enabled:true,status:'ready',biography:'Updated text.',needs_lookup:false})}); await settle();
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Updated text/);
  assert.doesNotMatch(p.nodes.get('#artist-biography').innerHTML,/Try again|is busy/);
});

test('a missing stored artist name explains why no biography lookup is offered', async () => {
  const p=livePage(); await settle(); p.run('setArtist("Pink Floyd")');
  let reads=0;
  p.setFetch((url,options)=>{
    assert.equal(JSON.parse(options.body).lookup,undefined); reads++;
    return {ok:true,json:async()=>({enabled:true,status:'unavailable',reason:'missing_name',needs_lookup:false})};
  });
  p.run('applyArtistSettings({artist_biographies:true})'); await settle();
  assert.equal(reads,1);
  assert.match(p.nodes.get('#artist-biography').innerHTML,/Add an artist name/);
  assert.doesNotMatch(p.nodes.get('#artist-biography').innerHTML,/Try again|Loading/);
});

test('an old artist heart reply cannot finish a newer account request', async () => {
  const p=livePage(); await settle();
  p.run('state.connection.playback_session="old-heart-session"; setArtist("Pink Floyd")');
  let oldReply, newReply;
  p.setFetch(()=>new Promise(resolve=>{oldReply=resolve;}));
  const oldTask=p.run('toggleArtistFavourite("Pink Floyd")'); await settle();
  p.run('useLocal([...state.details.values()],"live"); state.connection.playback_session="new-heart-session"; setArtist("Pink Floyd")');
  p.setFetch(()=>new Promise(resolve=>{newReply=resolve;}));
  const newTask=p.run('toggleArtistFavourite("Pink Floyd")'); await settle();
  oldReply({ok:true,json:async()=>({results:[{id:'42',favourite:true}]})}); await oldTask;
  assert.equal(p.run('artistProfile.favourite.pending'),true);
  assert.equal(p.run('state.artistFavourites.size'),0);
  newReply({ok:true,json:async()=>({results:[{id:'42',favourite:true}]})}); await newTask;
  assert.equal(p.run('artistProfile.favourite.pending'),false);
  assert.deepEqual(p.json('[...state.artistFavourites]'),['42']);
});

test('biography retry timers cannot repaint after disabling or replacing the library', async () => {
  for (const change of ['disable','replace']) {
    const p=livePage(); await settle(); p.run('setArtist("Pink Floyd")');
    p.setFetch((url,options)=>JSON.parse(options.body).lookup
      ? {ok:false,status:429,json:async()=>({error:'Temporary provider failure.',retry_after:60})}
      : {ok:true,json:async()=>({enabled:true,needs_lookup:true})});
    p.run('applyArtistSettings({artist_biographies:true})'); await settle();
    if (change==='disable') p.run('applyArtistSettings({artist_biographies:false})');
    else p.run('useLocal(demoLibrary(),"demo")');
    const requests=p.requests.length, html=p.nodes.get('#artist-biography').innerHTML;
    p.flushTimers(60000); await settle();
    assert.equal(p.requests.length,requests);
    assert.equal(p.nodes.get('#artist-biography').innerHTML,html);
    assert.equal(p.nodes.get('#artist-biography').hidden,true);
  }
});

test('changing biography preferences cannot discard a confirmed local artist heart', async () => {
  const p=livePage(); await settle(); p.run('setArtist("Pink Floyd")');
  let finish;
  p.setFetch(()=>new Promise(resolve=>{finish=resolve;}));
  const task=p.run('toggleArtistFavourite("Pink Floyd")'); await settle();
  p.run('applyArtistSettings({artist_biographies:false,artist_biographies_revision:42})');
  finish({ok:true,json:async()=>({results:[{id:'42',favourite:true}]})}); await task;
  assert.equal(p.run('artistProfile.favourite.pending'),false);
  assert.deepEqual(p.json('[...state.artistFavourites]'),['42']);
  assert.match(p.nodes.get('#page-title').innerHTML,/aria-pressed="true" aria-busy="false"/);
});

test('additional album artists have their own cards, profile, image, search and album links without detail reads', async () => {
  const p = livePage(); await settle();
  const count = p.requests.length;
  p.run(`const sharedAlbum = state.albums[0];
    sharedAlbum.album_artists = [albumArtistEntries(sharedAlbum)[0], {id:'77',name:'Shared Guest',rating:4,image:'https://example.test/guest-150',artwork_id:22}];
    state.albums = [...state.albums]; renderArtistBrowse(); setArtist('Shared Guest');`);
  assert.equal(p.run('filteredAlbums().length'), 1);
  assert.deepEqual(p.json('artistProfileSelection("Shared Guest").artists'), ['77']);
  assert.equal(p.run('nativeArtistRatings(artistProfileSelection("Shared Guest"))[0]'), 4);
  assert.match(p.nodes.get('#artist-panel').innerHTML, /guest-300/);
  assert.equal(p.run('artistPageTarget("Shared Guest").id'), '77');
  assert.match(p.run('albumArtistLinks(state.albums[0])'), /data-artist="Shared Guest"/);
  p.run('state.artist=null; $("#search").value="Shared Guest"');
  assert.equal(p.run('filteredAlbums().length'), 1);
  assert.equal(p.requests.length, count);
});

test('credit editing preserves native identities, unknown roles and phrases until explicitly changed', async () => {
  const p = page(); await settle();
  p.run(`const originalCredit = {artist_id:77,name:'Guest',type:'guitar',phrase:null};
    const creditName = {value:'Guest'}, creditRole = {value:'guitar'}, creditPhrase = {value:''};
    const creditRow = {dataset:{original:JSON.stringify(originalCredit)},querySelector:selector => ({'[data-credit-name]':creditName,'[data-credit-role]':creditRole,'[data-credit-phrase]':creditPhrase})[selector]};
    const creditError={textContent:''}; const creditEditor = {querySelectorAll:()=>[creditRow],querySelector:()=>creditError};`);
  assert.deepEqual(p.json('readCredits(creditEditor)'), [{artist_id:77,name:'Guest',type:'guitar',phrase:null}]);
  p.run('creditName.value="Another Guest"; creditRole.value="lyricist"; creditPhrase.value="Words by"');
  assert.deepEqual(p.json('readCredits(creditEditor)'), [{artist_id:null,name:'Another Guest',type:'lyricist',phrase:'Words by'}]);
  assert.match(p.run('creditRows([originalCredit])'), /value="guitar" selected/);
  assert.match(p.run('creditRows([{...originalCredit,name:"<img src=x>"}])'), /&lt;img src=x&gt;/);
  p.run('creditName.value=""');
  assert.throws(() => p.run('readCredits(creditEditor)'), /names are required/);
  assert.match(p.run('creditError.textContent'), /names are required/);
});

test('genre input accepts 200 characters and keeps oversized input instead of truncating or committing it', async () => {
  const p = page(); await settle();
  assert.equal(p.run('addGenres([], "x".repeat(200))[0].length'), 200);
  assert.equal(p.run('addGenres([], "🎵".repeat(200)).length'), 1);
  assert.throws(() => p.run('addGenres([], "x".repeat(201))'), /200 characters/);
  assert.throws(() => p.run('addGenres(Array.from({length:20},(_,i)=>String(i)), "one more")'), /20 labels/);
  p.run(`const longGenreInput={value:'x'.repeat(201)};
    const longGenreField={dataset:{value:'[]'},querySelector:()=>longGenreInput};`);
  assert.throws(() => p.run('commitTyped(longGenreField)'), /input has been kept/);
  assert.equal(p.run('longGenreInput.value.length'), 201);
  assert.equal(p.run('longGenreField.dataset.value'), '[]');
  assert.doesNotMatch(p.run('genreField("genres", "Genres", [])'), /maxlength=/);
});

test('track thumbs-down waits for read-back, clears a heart and can be removed without touching playback', async () => {
  const p = livePage(); await settle();
  p.run('const dislikedTrack=state.details.get(state.albums[0].id).tracks[0]; dislikedTrack.rating=5; playTracks(state.details.get(state.albums[0].id))');
  const id = p.run('String(dislikedTrack.id)'), source = p.nodes.get('#audio').src, entries = p.history.length;
  const writes = [];
  p.setFetch((url, options) => {
    if (url === '/api/favourite') {
      const body = JSON.parse(options.body); writes.push(body);
      return {ok:true,json:async()=>({job:'dislike'})};
    }
    if (url === '/api/jobs/dislike') return {ok:true,json:async()=>({state:'done',results:[{id,rating:writes.at(-1).rating,status:'saved'}]})};
    return {ok:true,json:async()=>({tracks:[],count:0,total:0,offset:0})};
  });
  const pending = p.run('toggleFavourite(String(dislikedTrack.id), 5, dislikedTrack.title, 1)'); await settle();
  assert.equal(p.run('dislikedTrack.rating'), 5);
  assert.equal(p.nodes.get('#player-dislike').getAttribute('aria-pressed'), 'true');
  assert.equal(p.nodes.get('#player-favourite').getAttribute('aria-pressed'), 'false');
  p.flushTimers(2000); await pending;
  assert.equal(p.run('dislikedTrack.rating'), 1);
  const clear = p.run('toggleFavourite(String(dislikedTrack.id), 1, dislikedTrack.title, 0)'); await settle(); p.flushTimers(2000); await clear;
  assert.deepEqual(writes.map(w=>w.rating), [1,0]);
  assert.equal(p.run('dislikedTrack.rating'), 0);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').paused, false);
  assert.equal(p.history.length, entries);
  assert.equal(p.run('state.history.length'), 0);
});

test('old track-rating replies cannot release a newer account rating lock', async () => {
  const p = livePage(); await settle(); let firstReply, secondReply;
  p.setFetch((url) => {
    if (url === '/api/favourite') return new Promise(resolve => { if (!firstReply) firstReply=resolve; else secondReply=resolve; });
    return {ok:true,json:async()=>({tracks:[],count:0,total:0,offset:0})};
  });
  const first = p.run('toggleFavourite("101", 0, "Old account track", 1)'); await settle();
  p.run('resetFavourites()');
  const second = p.run('toggleFavourite("102", 0, "New account track", 1)'); await settle();
  firstReply({ok:true,json:async()=>({rating:1})}); await first;
  assert.equal(p.run('favourites.busy'), true);
  assert.equal(p.run('favourites.pending.id'), '102');
  secondReply({ok:true,json:async()=>({rating:1})}); await second;
  assert.equal(p.run('favourites.busy'), false);
});

test('large playlists render a bounded page and use a compact deletion snapshot without fetching every track', async () => {
  const p=livePage(); await settle();
  p.run('playTracks(state.details.get(state.albums[0].id))');
  const source=p.nodes.get('#audio').src, queue=p.json('player.queue');
  p.setFetch(url=>{
    assert.match(url,/^\/api\/playlists/);
    return {ok:true,json:async()=>({id:'88',name:'Large playlist',description:'',large:true,total:20002,stored_total:20002,offset:10000,
      before:[],before_token:'snapshot-token',tracks:[101],rows:[]})};
  });
  p.run('showCollections("playlists","88",{offset:10000})'); await settle();
  assert.match(p.nodes.get('#collections-page').innerHTML,/20002 tracks/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/Play this page/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/data-playlist-edit disabled/);
  await p.run('openPlaylistDelete("88")');
  assert.deepEqual(p.json('playlistDraft.body'),{action:'delete',playlist:'88',before_token:'snapshot-token',before_name:'Large playlist',confirm_delete:true});
  assert.ok(p.requests.every(r=>r.options?.method!=='POST'));
  assert.equal(p.nodes.get('#audio').src,source); assert.deepEqual(p.json('player.queue'),queue);
});

test('reviewed individual credits override bulk composers and read-back supplies IDs for Undo', async () => {
  const p=livePage(); await settle();
  await p.run('openEditor([state.albums[0].id])');
  p.run(`const reviewedTrack=editing.originals[0].tracks[0];
    editing.trackPatches[String(reviewedTrack.id)]={credits:[{artist_id:null,name:'New Writer',type:'lyricist',phrase:'Words by'}]};
    editing.dirty.add('composers');`);
  const composerField={dataset:{value:'["Bulk Composer"]'},classList:{contains:()=>false},querySelector:()=>({value:''})};
  p.nodes.get('#metadata-form').querySelector=selector=>selector==='[data-genres="composers"]'?composerField:null;
  p.run('buildReview()');
  const selected=p.json('pending.changes.find(c=>String(c.id)===String(reviewedTrack.id))');
  assert.equal(selected.fields.credits.after[0].name,'New Writer');
  assert.equal(selected.fields.composers,undefined);
  p.run('state.history=[{status:"sent",source:"ibroadcast",changes:structuredClone(pending.changes)}]');
  const changes=p.json('pending.changes'), albums=p.json('state.albums');
  p.setFetch(()=>({ok:true,json:async()=>({state:'done',albums,results:changes.map(c=>({kind:c.kind,id:c.id,status:'saved',
    ...(c.fields.credits?{credits:[{artist_id:88,name:'New Writer',type:'lyricist',phrase:'Words by'}]}:{})}))})}));
  const checked=p.run('followJob("credit-check",state.history[0])'); p.flushTimers(2000); await checked;
  assert.equal(p.run('state.history[0].changes.find(c=>c.fields.credits).fields.credits.after[0].artist_id'),88);
  assert.deepEqual(p.json('state.history[0].changes.find(c=>c.fields.credits).fields.credits.before'),selected.fields.credits.before);
});

test('an additional album artist is linked in the player without repeating it as a track artist', async () => {
  const p=livePage(); await settle();
  p.run(`const multiArtistAlbum=state.details.get(state.albums[0].id);
    multiArtistAlbum.album_artists=[albumArtistEntries(multiArtistAlbum)[0],{id:'77',name:'Shared Guest'}];
    multiArtistAlbum.tracks[0].artist='Shared Guest'; multiArtistAlbum.tracks[0].artist_id=77;
    multiArtistAlbum.tracks[0].performers=[{id:77,name:'Shared Guest'}]; playTracks(multiArtistAlbum);`);
  assert.match(p.nodes.get('#player-additional-album-artists').innerHTML,/data-artist="Shared Guest"/);
  assert.equal(p.nodes.get('#player-track-line').hidden,true);
  assert.deepEqual(p.json('player.queue[0].album.album_artists.map(a=>a.name)'),[p.run('multiArtistAlbum.artist'),'Shared Guest']);
});

test('large playlist playback uses the selected row within the current page', async () => {
  const p=livePage(); await settle();
  p.run(`collectionsView.data={large:true,offset:10000,tracks:[101,102]};`);
  p.setFetch((url,options)=>{
    assert.equal(url,'/api/queue-tracks'); assert.deepEqual(JSON.parse(options.body).tracks,[101,102]);
    return {ok:true,json:async()=>({tracks:[101,102].map(id=>({id:String(id),title:'Track '+id,artist:'Artist',album:{id:'1',name:'Album',artist:'Artist'}}))})};
  });
  await p.click({'[data-playlist-position]':{dataset:{playlistPosition:'10001'},hasAttribute:key=>key==='data-playlist-position'}});
  assert.equal(p.run('player.queue[player.index].id'),'102');
  assert.equal(p.run('player.index'),1);
  assert.equal(p.nodes.get('#audio').src,'/api/stream/102?quality=128');
});

test('playlist shuffle mixes only the playback queue and ordinary Play restores the saved order', async () => {
  const p = livePage(); await settle();
  p.run('collectionsView.data = {id:"88", tracks:[101,102,103,104]}; Math.random = () => 0');
  p.setFetch((url, options) => {
    assert.equal(url, '/api/queue-tracks');
    const ids = JSON.parse(options.body).tracks;
    assert.deepEqual(ids, [101,102,103,104]);
    return {ok:true,json:async()=>({tracks:ids.map(id=>({id:String(id),title:'Track '+id,artist:'Artist',album:{id:'1',name:'Album',artist:'Artist'}}))})};
  });
  const history = p.history.length;
  await p.click({'[data-playlist-shuffle]':{hasAttribute:key=>key==='data-playlist-shuffle'}});
  assert.deepEqual(p.json('player.queue.map(t=>t.id)'), ['102','103','104','101']);
  assert.deepEqual(p.json('collectionsView.data.tracks'), [101,102,103,104]);
  assert.equal(p.run('player.index'), 0);
  assert.equal(p.nodes.get('#audio').src, '/api/stream/102?quality=128');
  assert.equal(p.run('encodedLocalQueue().shuffle'), true);
  const visited = [p.run('player.queue[player.index].id')];
  for (let i=1; i<4; i++) {
    await p.nodes.get('#audio').emit('ended');
    visited.push(p.run('player.queue[player.index].id'));
  }
  assert.deepEqual(visited, ['102','103','104','101']);
  assert.equal(p.history.length, history);
  assert.equal(p.run('state.history.length'), 0);
  await p.click({'[data-playlist-play]':{hasAttribute:()=>false}});
  assert.deepEqual(p.json('player.queue.map(t=>t.id)'), ['101','102','103','104']);
  assert.equal(p.run('player.shuffle'), false);
  assert.equal(p.nodes.get('#audio').src, '/api/stream/101?quality=128');
});

test('shuffle includes all positions of an ordinary playlist using bounded metadata reads', async () => {
  const p = livePage(); await settle();
  p.run('collectionsView.data = {id:"88",offset:100,tracks:Array.from({length:2100},(_,i)=>i+100)}; $("#now-playing-panel").hidden=true; Math.random=()=>0');
  const batches = [];
  p.setFetch((url, options) => {
    assert.equal(url, '/api/queue-tracks');
    const ids = JSON.parse(options.body).tracks; batches.push(ids);
    return {ok:true,json:async()=>({tracks:ids.map(id=>({id:String(id),title:'Track '+id,artist:'Artist',album:{id:'1',name:'Album',artist:'Artist'}}))})};
  });
  await p.click({'[data-playlist-shuffle]':{hasAttribute:key=>key==='data-playlist-shuffle'}});
  assert.deepEqual(batches.map(ids=>ids.length), [1000,1000,100]);
  assert.equal(p.run('player.queue.length'), 2100);
  assert.equal(p.run('new Set(player.queue.map(t=>t.id)).size'), 2100);
  assert.deepEqual(p.json('player.queue.map(t=>Number(t.id)).sort((a,b)=>a-b)'), batches.flat());
  assert.deepEqual(p.json('collectionsView.data.tracks'), batches.flat());
});

test('large playlist shuffle is explicitly limited to the current page and empty playlists disable it', async () => {
  const p = livePage(); await settle();
  p.run('state.screen="playlists"; collectionsView.playlist="88"; collectionsView.offset=10000; Math.random=()=>0');
  p.setFetch((url, options) => {
    if (url.startsWith('/api/playlists?')) return {ok:true,json:async()=>({id:'88',name:'Large',description:'',
      large:true,total:20002,offset:10000,tracks:[101,102],rows:[]})};
    assert.equal(url, '/api/queue-tracks');
    assert.deepEqual(JSON.parse(options.body).tracks, [101,102]);
    return {ok:true,json:async()=>({tracks:[101,102].map(id=>({id:String(id),title:'Track '+id,artist:'Artist',album:{id:'1',name:'Album',artist:'Artist'}}))})};
  });
  await p.run('renderCollections()');
  assert.match(p.nodes.get('#collections-page').innerHTML, /data-playlist-shuffle[^>]*>Shuffle this page/);
  assert.match(p.nodes.get('#collections-page').innerHTML, /Playback and shuffle use only this page/);
  await p.click({'[data-playlist-shuffle]':{hasAttribute:key=>key==='data-playlist-shuffle'}});
  assert.deepEqual(p.json('player.queue.map(t=>t.id)'), ['102','101']);
  p.setFetch(()=>({ok:true,json:async()=>({id:'88',name:'Empty',description:'',tracks:[],rows:[],total:0})}));
  await p.run('renderCollections()');
  assert.match(p.nodes.get('#collections-page').innerHTML, /data-playlist-shuffle disabled>Shuffle playlist/);
});

test('pending playlist shuffle cannot undo stopping, another Play, or a library or session replacement', async () => {
  for (const change of ['stopPlayer()', 'playTracks(state.details.get("2"))',
    'state.details=new Map(state.details)', 'state.connection.playback_session="another-session"']) {
    const p = livePage(); await settle();
    p.run('playTracks(state.details.get("1")); collectionsView.data={id:"88",tracks:[101,102]}');
    let finish;
    p.setFetch(url=>{
      assert.equal(url, '/api/queue-tracks');
      return new Promise(resolve=>{finish=resolve;});
    });
    const pending = p.click({'[data-playlist-shuffle]':{hasAttribute:key=>key==='data-playlist-shuffle'}});
    await settle(); p.run(change);
    const queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
    finish({ok:true,json:async()=>({tracks:[101,102].map(id=>({id:String(id),title:'Track '+id,artist:'A',album:{id:'1',name:'Album',artist:'A'}}))})});
    await pending;
    assert.deepEqual(p.json('player.queue'), queue, change);
    assert.equal(p.nodes.get('#audio').src, source, change);
  }
});

test('the most recent playlist Play wins over delayed shuffle and remote controllers cannot start it', async () => {
  const p = livePage(); await settle();
  p.run('collectionsView.data={id:"88",tracks:[101,102]}; Math.random=()=>0');
  const response = {ok:true,json:async()=>({tracks:[101,102].map(id=>({id:String(id),title:'Track '+id,artist:'A',album:{id:'1',name:'Album',artist:'A'}}))})};
  let finish, calls=0;
  p.setFetch(url=>{
    assert.equal(url, '/api/queue-tracks');
    if (++calls===1) return new Promise(resolve=>{finish=resolve;});
    return response;
  });
  const pending = p.click({'[data-playlist-shuffle]':{hasAttribute:key=>key==='data-playlist-shuffle'}});
  await settle();
  await p.click({'[data-playlist-play]':{hasAttribute:()=>false}});
  finish(response); await pending;
  assert.deepEqual(p.json('player.queue.map(t=>t.id)'), ['101','102']);
  assert.equal(p.run('player.shuffle'), false);
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src, before = p.requests.length;
  p.run('queueSync.active=true; queueSync.allowed=false; queueSync.view={own:false,state:{role:"controller"}}');
  await p.click({'[data-playlist-shuffle]':{hasAttribute:key=>key==='data-playlist-shuffle'}});
  assert.equal(p.requests.length, before);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
});

test('playlist rows follow playback when opened, paused, advanced and stopped without replacing the queue', async () => {
  const p = livePage(); await settle();
  p.run(`playTracks(state.details.get("1"));
    const playlistMarkerRows = [$("#playlist-marker-first"), $("#playlist-marker-second")];
    playlistMarkerRows.forEach((row, i) => row.dataset.row = player.queue[i].id);
    document.querySelectorAll = selector => selector === "[data-row]" ? playlistMarkerRows : [];
    state.screen = "playlists"; collectionsView.playlist = "88"; audio.currentTime = 37;`);
  const tracks = p.json('player.queue.slice(0, 2)');
  p.setFetch(url => {
    assert.match(url, /^\/api\/playlists\?id=88&offset=0$/);
    return {ok: true, json: async () => ({id: '88', name: 'Playlist', description: '',
      tracks: tracks.map(t => Number(t.id)), total: 2,
      rows: tracks.map((t, position) => ({...t, position, album_id: t.album.id, album: t.album.name}))})};
  });
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src, requests = p.requests.length;
  await p.run('renderCollections()');
  const history = p.history.length;
  const first = p.nodes.get('#playlist-marker-first'), second = p.nodes.get('#playlist-marker-second');
  const html = p.nodes.get('#collections-page').innerHTML;
  assert.match(html, /class="album-tracks album-tracklist track-results"/);
  assert.match(html, new RegExp(`<tr data-row="${tracks[0].id}">`));
  assert.match(html, /data-playlist-position="0"[^>]*>[\s\S]*?class="track-playing-icon"/);
  assert.equal(first.classList.contains('playing'), true);
  assert.equal(first.getAttribute('aria-current'), 'true');
  assert.equal(second.classList.contains('playing'), false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.nodes.get('#audio').currentTime, 37);
  p.nodes.get('#audio').pause();
  assert.equal(first.classList.contains('playing'), false);
  assert.equal(first.getAttribute('aria-current'), undefined);
  await p.nodes.get('#audio').play();
  assert.equal(first.classList.contains('playing'), true);
  await p.nodes.get('#audio').emit('ended');
  assert.equal(first.classList.contains('playing'), false);
  assert.equal(second.classList.contains('playing'), true);
  assert.equal(second.getAttribute('aria-current'), 'true');
  p.run('stopPlayer()');
  assert.equal(second.classList.contains('playing'), false);
  assert.equal(second.getAttribute('aria-current'), undefined);
  assert.equal(p.history.length, history);
  assert.equal(p.requests.length - requests, 1,
    'Displaying and updating playback markers needs only the normal playlist read');
});

test('a large playlist page shows its playlist positions and applies the latest playback state after loading', async () => {
  const p = livePage(); await settle();
  p.run(`playTracks(state.details.get("1"));
    const pagedPlaylistRows = [$("#playlist-page-first"), $("#playlist-page-second")];
    pagedPlaylistRows.forEach((row, i) => row.dataset.row = player.queue[i].id);
    document.querySelectorAll = selector => selector === "[data-row]" ? pagedPlaylistRows : [];
    state.screen = "playlists"; collectionsView.playlist = "99"; collectionsView.offset = 10000;`);
  const tracks = p.json('player.queue.slice(0, 2)');
  let finish;
  p.setFetch(url => {
    assert.equal(url, '/api/playlists?id=99&offset=10000');
    return new Promise(resolve => { finish = resolve; });
  });
  const read = p.run('renderCollections()'); await settle();
  p.run('step(1)');
  p.nodes.get('#playlist-page-second').classList.remove('playing');
  finish({ok: true, json: async () => ({id: '99', name: 'Large', description: '', large: true,
    offset: 10000, total: 10002, tracks: tracks.map(t => Number(t.id)),
    rows: tracks.map((t, i) => ({...t, track: 9 - i, position: 10000 + i,
      album_id: t.album.id, album: t.album.name}))})});
  await read;
  const html = p.nodes.get('#collections-page').innerHTML;
  assert.match(html, /data-playlist-position="10000"[^>]*><span class="track-position" aria-hidden="true">10001<\/span>/);
  assert.match(html, /data-playlist-position="10001"[^>]*><span class="track-position" aria-hidden="true">10002<\/span>/);
  assert.equal(p.nodes.get('#playlist-page-first').classList.contains('playing'), false);
  assert.equal(p.nodes.get('#playlist-page-second').classList.contains('playing'), true);
  assert.equal(p.run('player.index'), 1);
  p.nodes.get('#audio').pause();
  p.setFetch(() => ({ok: true, json: async () => ({id: '99', name: 'Other page', description: '',
    large: true, offset: 0, total: 10002, tracks: [], rows: []})}));
  await p.run('renderCollections()');
  assert.equal(p.nodes.get('#playlist-page-second').classList.contains('playing'), false);
  assert.equal(p.nodes.get('#audio').paused, true);
});

test('bulk editing accepts albums sharing an additional album artist and keeps mixed credits opt-in', async () => {
  const p=livePage(); await settle();
  p.run(`const sharedIds=[state.albums[0].id,state.albums[2].id];
    for(const id of sharedIds) { const album=state.details.get(id);
      album.credits=[{artist_id:77,name:'Shared Guest',type:'artist',phrase:null}];
      album.album_artists=[albumArtistEntries(album)[0],{id:'77',name:'Shared Guest',rating:0}]; }
    state.albums=[...state.details.values()].map(summarize); state.artist='Shared Guest';`);
  await p.run('openEditor(sharedIds)');
  assert.equal(p.run('editing.bulk'),true);
  assert.equal(p.run('editing.originals.length'),2);
  assert.match(p.nodes.get('#editor-content').innerHTML,/Change additional album artists/);
  assert.match(p.nodes.get('#editor-content').innerHTML,/credit-editor disabled/);
});

test('the artist menu combines independent filter and sort choices and omits empty filters without library reads', async () => {
  const p=livePage(); await settle();
  p.run(`state.albums=[
    {...state.albums[0],id:'a',artist:'Alpha',artist_id:11,artist_image:'https://example.test/a'},
    {...state.albums[0],id:'b',artist:'Beta',artist_id:12,artist_image:''}];
    state.artistFavourites=new Set(); showArtistBrowse();
    $('#artists-browse-options').dataset.browseOptions='artists';`);
  const requests=p.requests.length, entries=p.history.length;
  p.run('openBrowseOptions($("#artists-browse-options"))');
  let html=p.nodes.get('#browse-options-menu').innerHTML;
  assert.match(html,/role="group" aria-label="Sort"/);
  assert.match(html,/role="group" aria-label="Show"/);
  assert.match(html,/data-browse-choice="filter:no_image"[^>]*>[\s\S]*?Without image · 1/);
  assert.doesNotMatch(html,/filter:favourites/);
  assert.equal(p.history.length,entries,'Opening does not add a history entry');
  p.run('chooseBrowseOption("filter:no_image")');
  assert.equal(p.nodes.get('#artists-filter').value,'no_image');
  p.run('openBrowseOptions($("#artists-browse-options")); chooseBrowseOption("sort:za")');
  assert.equal(p.nodes.get('#artists-sort').value,'za');
  assert.equal(p.nodes.get('#artists-filter').value,'no_image');
  assert.deepEqual(p.json('filteredArtistGroups().map(([name])=>name)'),['Beta']);
  p.run('openBrowseOptions($("#artists-browse-options"))');
  html=p.nodes.get('#browse-options-menu').innerHTML;
  assert.match(html,/aria-checked="true" data-browse-choice="sort:za"/);
  assert.match(html,/aria-checked="true" data-browse-choice="filter:no_image"/);
  assert.equal(p.requests.length,requests);
});

test('album menu counts merged albums in the current artist scope and keeps search separate from zero filters', async () => {
  const p=setPage(); await settle();
  p.run(`setArtist('Pink Floyd'); $('#search').value='no matches'; render();
    $('#albums-browse-options').dataset.browseOptions='albums'; openBrowseOptions($('#albums-browse-options'));`);
  const count=p.run('albumShelf().filter(a=>albumHasArtist(a,"Pink Floyd")).length');
  assert.match(p.nodes.get('#browse-options-menu').innerHTML,new RegExp(`All albums · ${count}`));
  assert.deepEqual(p.json('browseChoices.views.get("albums").filter(o=>o.key.startsWith("sort:")).map(o=>o.key)'),
    ['sort:artist','sort:artist_za','sort:title','sort:title_za','sort:year','sort:newest','sort:rating_high','sort:rating_low','sort:uploaded_newest','sort:uploaded_oldest']);
  p.run(`chooseBrowseOption('sort:title_za'); $('#filter').value='cover';
    state.albums=state.albums.map(a=>({...a,no_cover:0})); render(); openBrowseOptions($('#albums-browse-options'));`);
  assert.doesNotMatch(p.nodes.get('#browse-options-menu').innerHTML,/filter:cover/);
  assert.equal(p.nodes.get('#filter').value,'cover','A selected filter survives results disappearing');
  assert.equal(p.nodes.get('#search').value,'no matches');
  p.run('chooseBrowseOption("filter:all")');
  assert.equal(p.nodes.get('#sort').value,'title_za');
  assert.equal(p.nodes.get('#filter').value,'all');
});

test('browse menus support keyboard focus, dismissal, navigation and stale-library guards without changing playback', async () => {
  const p=livePage(); await settle();
  p.run(`playTracks(state.details.get('1')); showArtistBrowse();
    const menuTrigger=$('#artists-browse-options'); menuTrigger.dataset.browseOptions='artists';
    const keyboardOptions=['sort:az','sort:za','filter:all'].map(key=>({dataset:{browseChoice:key},focus(){document.activeElement=this;},getAttribute:name=>name==='data-browse-choice'?key:null}));
    $('#browse-options-menu').querySelectorAll=()=>keyboardOptions;
    $('#browse-options-menu').querySelector=()=>keyboardOptions[0]; openBrowseOptions(menuTrigger);`);
  const source=p.nodes.get('#audio').src, queue=p.json('player.queue'), entries=p.history.length;
  let prevented=false;
  const keyEvent=key=>({key,target:{closest:selector=>selector==='#browse-options-menu'?{}:null},preventDefault(){prevented=true;this.defaultPrevented=true;}});
  await p.emitDocument('keydown',keyEvent('End'));
  assert.equal(p.run('document.activeElement.dataset.browseChoice'),'filter:all');
  await p.emitDocument('keydown',keyEvent('ArrowDown'));
  assert.equal(p.run('document.activeElement.dataset.browseChoice'),'sort:az');
  await p.emitDocument('keydown',keyEvent('Escape'));
  assert.equal(prevented,true); assert.equal(p.nodes.get('#browse-options-menu').hidden,true);
  assert.equal(p.run('document.activeElement===menuTrigger'),true);
  p.run('openBrowseOptions(menuTrigger)'); await p.click({});
  assert.equal(p.nodes.get('#browse-options-menu').hidden,true);
  assert.equal(p.history.length,entries);
  p.run('openBrowseOptions(menuTrigger); showScreen("albums")');
  assert.equal(p.nodes.get('#browse-options-menu').hidden,true);
  p.run('showArtistBrowse(); openBrowseOptions(menuTrigger); state.details=new Map(state.details); chooseBrowseOption("sort:za")');
  assert.equal(p.nodes.get('#artists-sort').value,'az');
  assert.equal(p.nodes.get('#audio').src,source); assert.deepEqual(p.json('player.queue'),queue);
});

test('removed metadata sorting falls back on history restore while combined artist choices survive Back', async () => {
  const p=livePage(); await settle();
  p.run(`showScreen('albums'); showRoute({screen:'albums'},{sort:'fewest'});`);
  assert.equal(p.nodes.get('#sort').value,'artist');
  p.run(`showArtistBrowse(); $('#artists-browse-options').dataset.browseOptions='artists';
    openBrowseOptions($('#artists-browse-options')); chooseBrowseOption('sort:rating_high');
    openBrowseOptions($('#artists-browse-options')); chooseBrowseOption('filter:no_image');`);
  const filter=p.nodes.get('#artists-filter').value;
  p.run('showScreen("albums")'); p.history.back(); await settle();
  assert.equal(p.nodes.get('#artists-filter').value,filter);
  assert.equal(p.nodes.get('#artists-sort').value,'rating_high');
  assert.match(p.nodes.get('#artists-browse-options').innerHTML,/Without image/);
});

function albumInformationReply(overrides = {}) {
  return {enabled:true, status:'ready', artist:'Pink Floyd', album:'Wish You Were Here',
    description:'Album background.', url:'https://www.theaudiodb.com/album/123',
    needs_lookup:false, ...overrides};
}

test('album information is off by default, lazy, escaped and cached without changing playback or history', async () => {
  const p = livePage(); await settle();
  p.run('state.connection.playback_session="album-info-session"');
  await p.run('openAlbum("1")');
  assert.equal(p.nodes.get('#album-information').hidden, true);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length, 0);
  p.run('playTracks(state.details.get("1"))');
  const src=p.nodes.get('#audio').src, queue=p.json('player.queue'), history=p.history.length;
  let reads=0, lookups=0, finish;
  p.setFetch((url,options)=>{
    assert.equal(url,'/api/album-information');
    const body=JSON.parse(options.body);
    assert.equal(body.album_id,'1'); assert.equal(body.artist,'Pink Floyd');
    assert.equal(body.album,p.run('state.albums[0].name'));
    assert.equal(body.session,'album-info-session');
    if(!body.lookup){reads++;return {ok:true,json:async()=>({enabled:true,status:'not_cached',needs_lookup:true})};}
    lookups++; return new Promise(resolve=>{finish=resolve;});
  });
  p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
  assert.equal(reads,1); assert.equal(lookups,1);
  assert.match(p.nodes.get('#album-information').innerHTML,/Loading album information/);
  finish({ok:true,json:async()=>albumInformationReply({description:'A <script>bad()<\/script> & B.\n\nSecond paragraph.'})}); await settle();
  const html=p.nodes.get('#album-information').innerHTML;
  assert.match(html,/About this album/); assert.match(html,/TheAudioDB/);
  assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; B/);
  assert.doesNotMatch(html,/<script>/); assert.match(html,/Second paragraph/); assert.match(html,/Saved on this computer/);
  p.run('render(); renderAlbumInformation()'); await settle();
  assert.equal(reads,1); assert.equal(lookups,1);
  assert.equal(p.nodes.get('#audio').src,src); assert.equal(p.nodes.get('#audio').paused,false);
  assert.deepEqual(p.json('player.queue'),queue);
  assert.equal(p.history.length,history); assert.equal(p.run('state.history.length'),0);
});

test('album text keeps its disclosure and source through refresh failures and explicit retries', async () => {
  const p=livePage(); await settle(); await p.run('openAlbum("1")');
  let finish, lookups=0;
  p.setFetch((url,options)=>{
    const body=JSON.parse(options.body);
    if (!body.lookup) return {ok:true,json:async()=>albumInformationReply({description:'Stored album text.',needs_lookup:true})};
    lookups++; return new Promise(resolve=>{finish=resolve;});
  });
  p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
  const panel=p.nodes.get('#album-information');
  assert.match(panel.innerHTML,/Stored album text/);
  await p.emitDocument('toggle',{target:{isConnected:true,open:true,matches:s=>s==='#album-information details'}});
  finish({ok:false,status:429,json:async()=>({error:'TheAudioDB is busy.',retry_after:60})}); await settle();
  assert.match(panel.innerHTML,/<details open/);
  assert.match(panel.innerHTML,/Stored album text/);
  assert.match(panel.innerHTML,/data-album-information-retry disabled/);
  const requests=p.requests.length;
  await p.click({'[data-album-information-retry]':{}});
  assert.equal(p.requests.length,requests);
  p.run('albumInformation.entries.values().next().value.retryAt=Date.now()-1; renderAlbumInformation()');
  assert.match(panel.innerHTML,/data-album-information-retry>Try again/);
  await p.click({'[data-album-information-retry]':{}}); await settle();
  assert.equal(lookups,2); assert.match(panel.innerHTML,/Stored album text/);
  finish({ok:true,json:async()=>albumInformationReply({description:'Updated album text.'})}); await settle();
  assert.match(panel.innerHTML,/<details open/); assert.match(panel.innerHTML,/Updated album text/);
  assert.doesNotMatch(panel.innerHTML,/Try again|is busy/);
});

test('album information never starts provider lookups after leaving, disabling or replacing its session', async () => {
  for(const change of ['navigate','disable','replace','session','identity']) {
    const p=livePage(); await settle(); await p.run('openAlbum("1")'); let finish;
    p.setFetch(()=>new Promise(resolve=>{finish=resolve;}));
    p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
    if(change==='navigate') p.run('showScreen("albums")');
    else if(change==='disable') p.run('applyAlbumInformationSettings({album_information:false})');
    else if(change==='replace') p.run('useLocal(demoLibrary(),"demo"); render()');
    else if(change==='session') p.run('state.connection.playback_session="changed"');
    else p.run('state.albums[0].name="Renamed album"');
    finish({ok:true,json:async()=>albumInformationReply({description:'Wrong album text.',needs_lookup:true})}); await settle();
    assert.doesNotMatch(p.nodes.get('#album-information').innerHTML,/Wrong album text/);
    assert.equal(p.requests.filter(r=>r.url==='/api/album-information'&&JSON.parse(r.options.body).lookup).length,0);
  }
});

test('a late provider response cannot repaint a different album and Back reuses valid stored text', async () => {
  const p=livePage(); await settle(); await p.run('openAlbum("1")');
  let finish;
  p.setFetch((url,options)=>{
    const body=JSON.parse(options.body);
    if(body.album_id!=='1') return {ok:true,json:async()=>albumInformationReply({status:'missing',description:''})};
    if(!body.lookup) return {ok:true,json:async()=>({enabled:true,needs_lookup:true})};
    return new Promise(resolve=>{finish=resolve;});
  });
  p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
  await p.run('openAlbum(state.albums[2].id)'); await settle();
  finish({ok:true,json:async()=>albumInformationReply({description:'First album text.'})}); await settle();
  assert.doesNotMatch(p.nodes.get('#album-information').innerHTML,/First album text/);
  const remoteReads=()=>p.requests.filter(r=>!r.url.startsWith('/api/lyrics/cache?')).length;
  const requests=remoteReads();
  p.history.back(); await settle();
  assert.match(p.nodes.get('#album-information').innerHTML,/First album text/);
  assert.equal(remoteReads(),requests,'Back may restore the local lyrics cache without repeating provider reads');
});

test('album information recovers only the visible same album after a metadata cache replacement', async () => {
  for (const visible of [true,false]) {
    const p=livePage(); await settle(); await p.run('openAlbum("1")');
    let finish, reads=0;
    p.setFetch(()=>{
      reads++;
      if(reads===1) return new Promise(resolve=>{finish=resolve;});
      return {ok:true,json:async()=>albumInformationReply({description:'Fresh cached text.'})};
    });
    p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
    p.run('state.details=new Map(state.details)');
    if (!visible) p.run('showScreen("albums")');
    finish({ok:true,json:async()=>albumInformationReply({description:'Stale reply.'})}); await settle();
    assert.equal(reads,visible?2:1);
    assert.doesNotMatch(p.nodes.get('#album-information').innerHTML,/Stale reply/);
    if(visible) assert.match(p.nodes.get('#album-information').innerHTML,/Fresh cached text/);
  }
});

test('Settings saves album information independently without scanning or enabling biographies or 1001 Albums', async () => {
  const p=livePage(); await settle();
  p.run('lookup.sources=[{name:"theaudiodb",label:"TheAudioDB",enabled:true}]; openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML,/name="album_information" > Show album information/);
  p.setFetch((url,options)=>({ok:true,json:async()=>({sources:[],auto_lookup:false,...JSON.parse(options.body)})}));
  await p.run('saveSettings({elements:{auto_lookup:{checked:false},auto_updates:{checked:false},album_information:{checked:true}},querySelectorAll:()=>[]})');
  assert.equal(p.run('albumInformation.enabled'),true);
  assert.equal(p.run('artistProfile.enabled'),false);
  assert.equal(p.run('albumGuide.enabled'),false);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,0);
});

test('missing album text stays compact, uncertain matches stay unresolved and unsafe links are excluded', async () => {
  for (const status of ['missing','unavailable','ambiguous','ready']) {
    const p=livePage(); await settle(); await p.run('openAlbum("1")');
    p.setFetch(()=>({ok:true,json:async()=>albumInformationReply({status,url:'javascript:bad()'})}));
    p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
    const html=p.nodes.get('#album-information').innerHTML;
    assert.doesNotMatch(html,/javascript:/);
    if(status==='ready') assert.match(html,/href="https:\/\/www.theaudiodb.com\/"/);
    else {assert.doesNotMatch(html,/<details/);assert.match(html,/No matching album|Album found on TheAudioDB|More than one album/);}
  }
});


const localAlbumReference = {id:1,album:'Reference album',artist:'Reference artist'};
const localAlbumNote = {...localAlbumReference,text:'Preferred 1001 text.',source_url:'https://en.wikipedia.org/wiki/Example'};
function setLocalAlbumText(p) {
  p.run(`guideNoteAlbums.details=state.details;
    guideNoteAlbums.entries.set(guideNoteAlbumKey(albumInformationSelection()),{loading:false,entries:[${JSON.stringify(localAlbumReference)}]});
    guideNotes.data=new Map([[1,${JSON.stringify(localAlbumNote)}]]);`);
}

test('1001 album text is available with both discovery and AudioDB disabled without any analysis or external lookup', async () => {
  const p=livePage(); await settle();
  p.setAlbumNotesFetch(()=>({ok:true,json:async()=>({entries:[localAlbumReference]})}));
  p.setNotesFetch(()=>({ok:true,json:async()=>({schema:1,entries:[localAlbumNote]})}));
  p.run('playTracks(state.details.get("1"))');
  const src=p.nodes.get('#audio').src, queue=p.json('player.queue');
  await p.run('openAlbum("1")'); await settle();
  assert.equal(p.run('albumGuide.enabled'),false);
  assert.equal(p.run('albumInformation.enabled'),false);
  assert.equal(p.run('albumGuide.data'),null);
  assert.equal(p.nodes.get('#show-album-guide').hidden,true);
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/Preferred 1001 text/);
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/Wikipedia contributors/);
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/CC BY-SA 4.0/);
  assert.equal(p.nodes.get('#album-information').hidden,true);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-guide'||r.url.includes('/analyse')||r.url==='/api/album-information').length,0);
  assert.deepEqual(p.json('player.queue'),queue); assert.equal(p.nodes.get('#audio').src,src);
  assert.equal(p.run('state.history.length'),0);
  const count=p.requests.length, history=p.history.length;
  p.run('renderAlbumView(); renderGuideAlbumNotes()'); await settle();
  assert.equal(p.requests.length,count); assert.equal(p.history.length,history);
});

test('optional AudioDB waits for the visited-album match and bundled text even with discovery off', async () => {
  const p=livePage(); await settle();
  let matchReady, notesReady;
  p.setAlbumNotesFetch(()=>new Promise(resolve=>{matchReady=resolve;}));
  p.setNotesFetch(()=>new Promise(resolve=>{notesReady=resolve;}));
  p.run('applyAlbumInformationSettings({album_information:true})'); await p.run('openAlbum("1")'); await settle();
  assert.equal(p.nodes.get('#album-information').hidden,true);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,0);
  p.run('applyAlbumGuideSettings({album_guide:false})');
  matchReady({ok:true,json:async()=>({entries:[localAlbumReference]})}); await settle();
  assert.equal(typeof notesReady,'function');
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,0);
  notesReady({ok:true,json:async()=>({schema:1,entries:[localAlbumNote]})}); await settle();
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/Preferred 1001 text/);
  assert.equal(p.nodes.get('#album-information').hidden,true);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,0);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-guide'||r.url.includes('/analyse')).length,0);
});

test('albums without a valid local text still use optional AudioDB and only send the chosen identity', async () => {
  for(const fixture of ['unmatched','missing-note','wrong-title','wrong-artist']) {
    const p=livePage(); await settle();
    p.setAlbumNotesFetch(url=>{
      assert.equal(new URL('http://localhost'+url).searchParams.get('album_id'),'1');
      return {ok:true,json:async()=>({entries:fixture==='unmatched'?[]:[localAlbumReference]})};
    });
    const note={...localAlbumNote};
    if(fixture==='wrong-title')note.album='Another title';
    if(fixture==='wrong-artist')note.artist='Another artist';
    p.setNotesFetch(()=>({ok:true,json:async()=>({schema:1,entries:fixture==='missing-note'?[]:[note]})}));
    p.setFetch(url=>{assert.equal(url,'/api/album-information');return {ok:true,json:async()=>albumInformationReply()};});
    p.run('applyAlbumInformationSettings({album_information:true})'); await p.run('openAlbum("1")'); await settle();
    assert.equal(p.nodes.get('#album-guide-notes').hidden,true);
    assert.equal(p.nodes.get('#album-information').hidden,false);
    assert.match(p.nodes.get('#album-information').innerHTML,/Album background/);
    assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,1);
  }
});

test('local identity or text read errors permit optional AudioDB without starting a guide analysis', async () => {
  for(const fail of ['match','notes']) {
    const p=livePage(); await settle();
    p.setAlbumNotesFetch(()=>fail==='match'
      ? {ok:false,status:500,json:async()=>({error:'Local identity unavailable.'})}
      : {ok:true,json:async()=>({entries:[localAlbumReference]})});
    p.setFetch(url=>{assert.equal(url,'/api/album-information');return {ok:true,json:async()=>albumInformationReply()};});
    p.setNotesFetch(()=>({ok:false,status:500,json:async()=>({error:'Bundled notes unavailable.'})}));
    p.run('applyAlbumInformationSettings({album_information:true})'); await p.run('openAlbum("1")'); await settle();
    assert.equal(p.nodes.get('#album-information').hidden,false);
    assert.match(p.nodes.get('#album-information').innerHTML,/Album background/);
    assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,1);
    assert.equal(p.requests.filter(r=>r.url==='/api/album-guide'||r.url.includes('/analyse')).length,0);
  }
});

test('local text arriving during an AudioDB read or lookup hides late text, retry and further lookups', async () => {
  for(const stage of ['cache','lookup']) {
    const p=livePage(); await settle(); await p.run('openAlbum("1")');
    let finish;
    p.setFetch((url,options)=>{
      assert.equal(url,'/api/album-information');
      if(stage==='lookup'&&!JSON.parse(options.body).lookup)return {ok:true,json:async()=>({enabled:true,needs_lookup:true})};
      return new Promise(resolve=>{finish=resolve;});
    });
    p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
    const count=p.requests.length;
    setLocalAlbumText(p); p.run('renderGuideAlbumNotes()');
    assert.equal(p.nodes.get('#album-information').hidden,true);
    finish({ok:true,json:async()=>albumInformationReply({description:'Late AudioDB text.',needs_lookup:stage==='cache'})}); await settle();
    p.run('renderAlbumView()'); await p.click({'[data-album-information-retry]':{}}); await settle();
    assert.equal(p.requests.length,count);
    assert.equal(p.nodes.get('#album-information').hidden,true);
    assert.equal(p.nodes.get('#album-information').innerHTML,'');
    assert.match(p.nodes.get('#album-guide-notes').innerHTML,/Preferred 1001 text/);
  }
});

test('local text priority survives Back and discovery setting changes without fetching or losing expansion', async () => {
  const p=livePage(); await settle();
  p.setAlbumNotesFetch(()=>({ok:true,json:async()=>({entries:[localAlbumReference]})}));
  p.setNotesFetch(()=>({ok:true,json:async()=>({schema:1,entries:[localAlbumNote]})}));
  await p.run('openAlbum("1")'); await settle();
  p.run('guideNotes.open.add(1); guideDisplay.matching=false; applyAlbumInformationSettings({album_information:true}); applyAlbumGuideSettings({album_guide:true}); showScreen("albums")');
  const remoteReads=()=>p.requests.filter(r=>!r.url.startsWith('/api/lyrics/cache?')).length;
  const count=remoteReads();
  p.history.back(); await settle();
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/<details[^>]* open>/);
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/Preferred 1001 text/);
  p.run('applyAlbumGuideSettings({album_guide:false})'); await settle();
  assert.equal(remoteReads(),count,'Local lyrics-cache restoration does not fetch album background text');
  assert.equal(p.nodes.get('#album-guide-notes').hidden,false);
  assert.equal(p.nodes.get('#album-information').hidden,true);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information').length,0);
});

test('source priority rechecks only the visited album after a metadata-only cache replacement', async () => {
  const p=livePage(); await settle(); await p.run('openAlbum("1")');
  setLocalAlbumText(p); p.run('applyAlbumInformationSettings({album_information:true}); renderGuideAlbumNotes()');
  let release;
  p.setAlbumNotesFetch(url=>{
    assert.ok(url.startsWith('/api/album-guide/album?'));
    return new Promise(resolve=>{release=resolve;});
  });
  p.run('state.details=new Map(state.details); renderAlbumInformation()'); await settle();
  assert.equal(typeof release,'function'); assert.equal(p.nodes.get('#album-information').hidden,true);
  release({ok:true,json:async()=>({entries:[localAlbumReference]})}); await settle();
  assert.match(p.nodes.get('#album-guide-notes').innerHTML,/Preferred 1001 text/);
  assert.equal(p.nodes.get('#album-information').hidden,true);
  assert.equal(p.requests.filter(r=>r.url==='/api/album-information'||r.url==='/api/album-guide').length,0);
});

test('late per-album background matches cannot load text or repaint after navigation, replacement or a new session', async () => {
  for(const change of ['navigate','replace','session','rename']) {
    const p=livePage(); await settle(); let finish;
    p.setAlbumNotesFetch(()=>new Promise(resolve=>{finish=resolve;}));
    await p.run('openAlbum("1")'); await settle();
    if(change==='navigate')p.run('showScreen("albums")');
    else if(change==='replace')p.run('useLocal(demoLibrary(),"demo"); render()');
    else if(change==='session')p.run('state.connection.playback_session="other"');
    else p.run('state.albums[0].name="Different album"');
    const count=p.requests.length;
    finish({ok:true,json:async()=>({entries:[localAlbumReference]})}); await settle();
    assert.equal(p.requests.length,count);
    assert.doesNotMatch(p.nodes.get('#album-guide-notes')?.innerHTML || '',/Preferred 1001 text/);
  }
});

test('Mambo! is found with its punctuation but missing English text is distinguished from a missing album', async () => {
  const p=livePage(); await settle();
  p.run('Object.assign(state.albums[0],{name:"Mambo!",artist:"Yma Sumac"}); Object.assign(state.details.get("1"),{name:"Mambo!",artist:"Yma Sumac"})');
  await p.run('openAlbum("1")');
  p.setFetch((url,options)=>{
    assert.equal(JSON.parse(options.body).album,'Mambo!');
    assert.equal(JSON.parse(options.body).artist,'Yma Sumac');
    return {ok:true,json:async()=>albumInformationReply({status:'unavailable',artist:'Yma Sumac',album:'Mambo!',description:'',url:'https://www.theaudiodb.com/album/2309687'})};
  });
  p.run('applyAlbumInformationSettings({album_information:true})'); await settle();
  const html=p.nodes.get('#album-information').innerHTML;
  assert.match(html,/Album found on TheAudioDB, but no English background text is available/);
  assert.match(html,/href="https:\/\/www.theaudiodb.com\/album\/2309687"/);
  assert.doesNotMatch(html,/No matching album|<details/);
});

function editorArtistInput(p, value = "") {
  const input = artistEditorForm(p, value), attributes = new Map();
  Object.assign(input, {name: "artist", dataset: {}, isConnected: true,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name), getAttribute: name => attributes.get(name),
    getBoundingClientRect: () => ({left: 100, right: 400, top: 150, bottom: 190, width: 300}),
    focus() { p.nodes.get("#metadata-form").focused = input; },
    dispatchEvent: event => p.emitDocument(event.type, {target: input}),
    matches: selector => selector === "[data-artist-suggestions]",
    closest: selector => selector === "#metadata-form" ? p.nodes.get("#metadata-form") : null});
  return input;
}

test("artist choices reuse loaded names, bound the visible list and preserve exact punctuation", async () => {
  const p = livePage(); await settle();
  p.run(`state.artistNames = [...Array.from({length: 10000}, (_, i) => 'Artist ' + i),
    'Kate Bush', 'Kate Bush', 'Earth; Wind & Fire', '<Guest "Artist">', 'Last-only Performer'];
    playTracks(state.details.get(state.albums[0].id))`);
  await p.run("openEditor([state.albums[0].id])");
  const input = editorArtistInput(p), list = p.nodes.get("#editor-artist-names");
  const count = p.requests.length, source = p.nodes.get("#audio").src, queue = p.json("player.queue");
  await p.emitDocument("focusin", {target: input});
  assert.equal([...list.innerHTML.matchAll(/role="option"/g)].length, 40);
  assert.deepEqual(p.json("[...editing.dirty]"), [], "Opening suggestions cannot alter the draft");
  input.value = "last-only";
  await p.emitDocument("focusin", {target: input});
  assert.match(list.innerHTML, />Last-only Performer<\/button>/);
  input.value = "EARTH;";
  await p.emitDocument("focusin", {target: input});
  assert.match(list.innerHTML, />Earth; Wind &amp; Fire<\/button>/);
  input.value = "guest";
  await p.emitDocument("focusin", {target: input});
  assert.match(list.innerHTML, />&lt;Guest &quot;Artist&quot;&gt;<\/button>/);
  input.value = "kate bush";
  await p.emitDocument("focusin", {target: input});
  assert.equal([...list.innerHTML.matchAll(/role="option"/g)].length, 1);
  assert.match(list.innerHTML, />Kate Bush<\/button>/);
  assert.equal(p.requests.length, count, "Typing/focusing makes no library or provider request");
  assert.deepEqual(p.json("player.queue"), queue); assert.equal(p.nodes.get("#audio").src, source);
  assert.equal(p.nodes.get("#audio").paused, false); assert.equal(p.run("state.history.length"), 0);
});

test("existing artist selection and new names remain reviewed drafts, with disabled fields untouched", async () => {
  const p = livePage(); await settle();
  p.run('state.artistNames = ["Kate Bush"]');
  await p.run("openEditor([state.albums[0].id])");
  await settle();
  const input = editorArtistInput(p, "Kate Bush"), count = p.requests.length;
  await p.emitDocument("input", {target: input});
  assert.equal(p.requests.length, count);
  p.run("buildReview()");
  assert.deepEqual(p.json("pending.changes.map(c => [c.kind, c.fields.artist?.after])"), [["album", "Kate Bush"]]);
  assert.doesNotMatch(p.nodes.get("#review-warnings").innerHTML, /New artist in iBroadcast/);
  assert.ok(p.requests.slice(count).every(r => r.url === "/api/account-settings" && !r.options?.method));
  input.value = "A new handwritten artist";
  await p.emitDocument("input", {target: input});
  assert.equal(input.value, "A new handwritten artist");
  assert.match(p.nodes.get("#editor-artist-names").innerHTML, /No existing artist matches/);
  p.run("buildReview()");
  assert.match(p.nodes.get("#review-warnings").innerHTML, /New artist in iBroadcast/);
  assert.ok(p.requests.slice(count).every(r => r.url === "/api/account-settings" && !r.options?.method), "Only the normal review's account settings read is allowed");
  p.run("resetEditorArtistChoices(); editing.dirty.clear()");
  input.disabled = true;
  await p.emitDocument("focusin", {target: input});
  assert.equal(p.nodes.get("#editor-artist-names").innerHTML, "");
  assert.deepEqual(p.json("[...editing.dirty]"), []);
});

test("artist choice names are discarded on close and library replacement", async () => {
  const p = livePage(); await settle();
  p.run('state.artistNames = ["Old account only"]');
  await p.run("openEditor([state.albums[0].id])");
  const input = editorArtistInput(p, "account");
  await p.emitDocument("focusin", {target: input});
  assert.match(p.nodes.get("#editor-artist-names").innerHTML, /Old account only/);
  p.run('state.artistNames = ["New account only"]');
  await p.emitDocument("focusin", {target: input});
  assert.doesNotMatch(p.nodes.get("#editor-artist-names").innerHTML, /Old account/);
  assert.match(p.nodes.get("#editor-artist-names").innerHTML, /New account only/);
  await p.nodes.get("#editor").emit("close");
  assert.equal(p.nodes.get("#editor-artist-names").innerHTML, "");
  assert.equal(p.run("editorArtistChoices.values.length"), 0);
  p.run('useLocal(demoLibrary(), "demo")');
  assert.equal(p.nodes.get("#editor-artist-names").innerHTML, "");
  assert.equal(p.run("editorArtistChoices.values.length"), 0);
});

test("album, additional-credit and track-artist fields share suggestions without changing credit IDs", async () => {
  const p = livePage(); await settle();
  await p.run("openEditor([state.albums[0].id])");
  assert.match(p.nodes.get("#editor-content").innerHTML, /name="artist"[^>]*aria-controls="editor-artist-names"[^>]*data-artist-suggestions/);
  assert.match(p.run('creditRows([{artist_id:77,name:"Guest",type:"artist",phrase:null}], true)'),
    /data-credit-name[^>]*aria-controls="editor-artist-names"[^>]*data-artist-suggestions/);
  p.run('const CSS = {escape: value => String(value)}; $("#track-inline").scrollIntoView = () => {}');
  p.run("editTrack(String(editing.originals[0].tracks[0].id))");
  assert.match(p.nodes.get("#track-inline").innerHTML, /data-key="artist"[^>]*aria-controls="editor-artist-names"[^>]*data-artist-suggestions/);
  assert.doesNotMatch(p.nodes.get("#track-inline").innerHTML, /data-key="title"[^>]*data-artist-suggestions/);
  p.run(`const untouchedCredit = {artist_id:77,name:'Guest',type:'artist',phrase:null};
    const unchangedRow = {dataset:{original:JSON.stringify(untouchedCredit)}, querySelector: selector =>
      ({value:selector === '[data-credit-name]' ? 'Guest' : selector === '[data-credit-role]' ? 'artist' : ''})};
    const unchangedCreditEditor = {querySelector:()=>null,querySelectorAll:()=>[unchangedRow]};`);
  assert.deepEqual(p.json("readCredits(unchangedCreditEditor)"), [{artist_id:77,name:"Guest",type:"artist",phrase:null}]);
});

test("artist choices support keyboard selection and dismissal, rejecting stale draft results", async () => {
  const p = livePage(); await settle();
  p.run('state.artistNames = ["Unique existing artist"]');
  await p.run("openEditor([state.albums[0].id])");
  const input = editorArtistInput(p, "Unique"), menu = p.nodes.get("#editor-artist-names");
  await p.emitDocument("focusin", {target: input});
  p.run('$("#editor-artist-choice-0").scrollIntoView = () => {}');
  const keys = [];
  const key = async value => p.emitDocument("keydown", {target: input, key: value,
    preventDefault() { keys.push(value); }, stopPropagation() { keys.push("stopped"); }});
  await key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), "editor-artist-choice-0");
  assert.equal(input.value, "Unique", "Highlighting must not replace the text");
  await key("Enter");
  assert.equal(input.value, "Unique existing artist");
  assert.equal(menu.hidden, true); assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(p.run('editing.dirty.has("artist")'), true);
  await p.emitDocument("focusin", {target: input});
  await key("Escape");
  assert.ok(keys.includes("stopped")); assert.equal(p.nodes.get("#editor").open, true);
  assert.equal(menu.hidden, true);
  await p.emitDocument("focusin", {target: input});
  await key("Tab"); assert.ok(!keys.includes("Tab"), "Tab must keep normal focus navigation");
  input.value = "Unique";
  await p.emitDocument("focusin", {target: input});
  p.run("state.details = new Map(state.details)");
  p.run("chooseEditorArtist(0)");
  assert.equal(input.value, "Unique", "A replaced library invalidates the shown choices");
  assert.equal(menu.hidden, true);
});

function editorLabelInput(p, kind, values = [], value = "") {
  const input = editorArtistInput(p, value), chips = {innerHTML: ""}, error = {textContent: ""};
  input.name = ""; input.dataset.editorChoiceKind = kind;
  const key = kind === "composer" ? "composers" : "genres";
  const field = {dataset: {genres: key, noun: kind, value: JSON.stringify(values), ordered: kind === "composer" ? "0" : "1"},
    classList: {contains: () => input.disabled, add() {}, remove() {}},
    querySelector: selector => selector === ".genre-chips" ? chips : selector === "[data-genre-error]" ? error : input};
  input.closest = selector => selector === ".genre-input input" ? input : selector === ".genre-input" ? field
    : selector === "#metadata-form" ? p.nodes.get("#metadata-form") : null;
  const form = p.nodes.get("#metadata-form");
  form.querySelector = selector => selector === `[data-genres="${key}"]` ? field : null;
  p.run('const CSS = {escape: value => String(value)}; $("#editor-artist-choice-0").scrollIntoView = () => {}');
  return {input, field, error, chips};
}

function labelChoiceKey(p, input, key) {
  return p.emitDocument("keydown", {target: input, key, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}});
}

test("genre and composer choices use separate exact catalogues with bounded lists and no extra requests", async () => {
  const p = livePage(); await settle();
  p.run(`state.editorNames = {genres:[...Array.from({length:10000},(_,i)=>'Style '+i), 'Pop;Rock', 'Jazz / Blues'],
    composers:['Bach; Handel','Existing composer']}; state.artistNames=['Not a composer'];`);
  await p.run("openEditor([state.albums[0].id])");
  const {input, field} = editorLabelInput(p, "genre"), menu = p.nodes.get("#editor-artist-names");
  const count = p.requests.length;
  await p.emitDocument("focusin", {target: input});
  assert.equal([...menu.innerHTML.matchAll(/role="option"/g)].length, 40);
  assert.doesNotMatch(menu.innerHTML, /Existing composer|Not a composer/);
  input.value = "pop;";
  await p.emitDocument("focusin", {target: input});
  assert.deepEqual(p.json("editorArtistChoices.results"), ["Pop;Rock"]);
  p.run("chooseEditorArtist(0)");
  assert.deepEqual(JSON.parse(field.dataset.value), ["Pop;Rock"], "Selecting a stored label must not split its semicolon");
  assert.equal(input.value, "");
  input.dataset.editorChoiceKind = "composer"; field.dataset.noun = "composer";
  input.value = "Existing composer";
  await p.emitDocument("focusin", {target: input});
  assert.deepEqual(p.json("editorArtistChoices.results"), ["Existing composer"]);
  assert.equal(menu.getAttribute("aria-label"), "Existing composers");
  assert.equal(p.requests.length, count);
});

test("Enter selects the highlighted full genre once, and the result still needs review", async () => {
  const p = livePage(); await settle();
  p.run('state.editorNames = {genres:["Progressive Rock"],composers:[]}');
  await p.run("openEditor([state.albums[0].id])");
  const {input, field} = editorLabelInput(p, "genre", ["Rock"], "Pro");
  const count = p.requests.length;
  await p.emitDocument("focusin", {target: input});
  await labelChoiceKey(p, input, "ArrowDown");
  await labelChoiceKey(p, input, "Enter");
  assert.deepEqual(JSON.parse(field.dataset.value), ["Rock", "Progressive Rock"]);
  assert.equal(input.value, ""); assert.equal(p.nodes.get("#editor-artist-names").hidden, true);
  assert.equal(p.run('editing.dirty.has("genres")'), true);
  assert.equal(p.requests.length, count);
  p.run("buildReview()");
  assert.ok(p.json("pending.changes").every(c => c.kind === "track" && JSON.stringify(c.fields.genres.after) === '["Rock","Progressive Rock"]'));
  assert.equal(p.requests.length, count, "Reviewing genres must not write or reload tracks");
});

test("new genre typing keeps Enter, semicolon, validation and explicit split behavior", async () => {
  const p = livePage(); await settle();
  await p.run("openEditor([state.albums[0].id])");
  const {input, field, error} = editorLabelInput(p, "genre", [], "My new genre");
  await labelChoiceKey(p, input, "Enter");
  input.value = "Another new genre";
  await labelChoiceKey(p, input, ";");
  assert.deepEqual(JSON.parse(field.dataset.value), ["My new genre", "Another new genre"]);
  input.value = "x".repeat(201);
  await labelChoiceKey(p, input, "Enter");
  assert.equal(input.value.length, 201); assert.match(error.textContent, /200 characters/);
  field.dataset.value = JSON.stringify(Array.from({length:20},(_,i)=>`Genre ${i}`));
  input.value = "One more";
  await labelChoiceKey(p, input, ";");
  assert.equal(input.value, "One more"); assert.equal(JSON.parse(field.dataset.value).length, 20);
  assert.match(error.textContent, /20 labels/);
  assert.deepEqual(p.json('splitGenres(["Pop;Rock"])'), ["Pop", "Rock"]);
  input.disabled = true;
  p.run("resetEditorArtistChoices()");
  await p.emitDocument("focusin", {target: input});
  assert.equal(p.nodes.get("#editor-artist-names").hidden, true);
});

test("composer selection preserves a compound name and new composer names remain editable", async () => {
  const p = livePage(); await settle();
  p.run('state.editorNames = {genres:[],composers:["Bach; Handel"]}');
  await p.run("openEditor([state.albums[0].id])");
  const {input, field, error} = editorLabelInput(p, "composer", [], "Bach");
  await p.emitDocument("focusin", {target: input});
  await labelChoiceKey(p, input, "ArrowDown");
  await labelChoiceKey(p, input, "Enter");
  assert.deepEqual(JSON.parse(field.dataset.value), ["Bach; Handel"]);
  input.value = "New Composer";
  await labelChoiceKey(p, input, ";");
  assert.deepEqual(JSON.parse(field.dataset.value), ["Bach; Handel", "New Composer"]);
  input.value = "x".repeat(1001);
  await labelChoiceKey(p, input, "Enter");
  assert.equal(input.value.length, 1001); assert.match(error.textContent, /1000 characters/);
  input.value = "";
  p.run("buildReview()");
  assert.ok(p.json("pending.changes").every(c => c.kind === "track" && JSON.stringify(c.fields.composers.after) === '["Bach; Handel","New Composer"]'));
  assert.match(p.nodes.get("#review-warnings").innerHTML, /New Composer/);
  assert.ok(p.requests.every(r => r.options?.method !== "POST"));
});

test("a refreshed name catalogue replaces old genre/composer choices and rejects old selections", async () => {
  const p = livePage(); await settle();
  p.run('state.editorNames = {genres:["Old label"],composers:[]}');
  await p.run("openEditor([state.albums[0].id])");
  const {input, field} = editorLabelInput(p, "genre", [], "Old label");
  await p.emitDocument("focusin", {target: input});
  p.run('applyEditorNames({genres:["New label"],composers:["New Composer"]}); chooseEditorArtist(0)');
  assert.deepEqual(JSON.parse(field.dataset.value), []);
  input.value = "New label";
  await p.emitDocument("focusin", {target: input});
  assert.deepEqual(p.json("editorArtistChoices.results"), ["New label"]);
  assert.deepEqual(p.json("state.editorNames.composers"), ["New Composer"]);
});

test("individual composer credits switch between composer and artist choices without replacing names or IDs", async () => {
  const p = livePage(); await settle();
  assert.match(p.run('creditRows([{artist_id:77,name:"Bach",type:"composer",phrase:null}])'), /data-editor-choice-kind="composer"/);
  assert.match(p.run('creditRows([{artist_id:77,name:"Bach",type:"composer",phrase:null}])'), /Show existing composers/);
  const name = {value:"Bach",dataset:{}}, labels = [];
  const row = {querySelector: selector => selector === "[data-credit-name]" ? name : {setAttribute: (_, value) => labels.push(value)}};
  const editor = {dataset:{dirty:"false"}};
  const role = {value:"composer", matches: selector => selector === "[data-credit-role]",
    closest: selector => selector === "[data-credit-editor]" ? editor : selector === "[data-credit-row]" ? row : null};
  await p.emitDocument("change", {target:role});
  assert.equal(name.dataset.editorChoiceKind, "composer"); assert.equal(name.value, "Bach");
  role.value = "artist";
  await p.emitDocument("change", {target:role});
  assert.equal(name.dataset.editorChoiceKind, "artist"); assert.equal(name.value, "Bach");
  assert.deepEqual(labels, ["Show existing composers","Show existing artists"]);
});

test("metadata export in Settings prepares linked tables and offers an explicit native download", async () => {
  const p = page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="export-session"; playTracks(state.details.get("1")); openSettings()');
  const before = p.run('JSON.stringify({queue:player.queue,history:state.history,src:audio.src,page:state.screen})');
  const settings = p.nodes.get('#settings-content').innerHTML;
  assert.match(settings, /Export library metadata/);
  assert.match(settings, /data-metadata-option="tags"/);
  assert.ok(settings.indexOf('id="metadata-export"') < settings.indexOf('id="settings-form"') || !settings.includes('id="settings-form"'));
  const id = 'a'.repeat(32);
  p.setFetch((url, options) => {
    if (url === '/api/metadata-export') {
      assert.equal(options.headers['X-Tagcast'], '1');
      assert.deepEqual(JSON.parse(options.body), {format:'json', session:'export-session', include_tags:false, include_playlists:true, include_favourites:true});
      return {ok:true,json:async()=>({id,state:'preparing',format:'json'})};
    }
    assert.equal(url, `/api/metadata-export/status?id=${id}&session=export-session`);
    return {ok:true,json:async()=>({id,state:'ready',format:'json',filename:'tagcast-metadata-test.json',
      manifest:{counts:{albums:2,tracks:20,credits:35},optional:{tags:{requested:false,status:'not_requested'},playlists:{requested:true,status:'not_loaded'}}}})};
  });
  await p.change({dataset:{metadataOption:'tags'},checked:false,matches:()=>false,closest:()=>null});
  await p.run('prepareMetadataExport("json")'); await settle();
  const status = p.nodes.get('#metadata-export-status').innerHTML;
  assert.match(status, /2 native album\/disc records · 20 tracks · 35 credits/);
  assert.match(status, /Download JSON/);
  assert.match(status, /Unavailable: playlists/);
  assert.match(status, /href="\/api\/metadata-export\/download\?id=a{32}&amp;session=export-session" download="tagcast-metadata-test.json"/);
  assert.equal(p.downloads.length, 0, 'Preparation never downloads a blob or changes the page');
  assert.equal(p.run('JSON.stringify({queue:player.queue,history:state.history,src:audio.src,page:state.screen})'), before);
  assert.equal(p.requests.filter(r=>r.url==='/api/settings' && r.options?.method==='POST').length,0);
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/albums')).length,0);
});

test("metadata export is disabled in preview and polling pauses when Settings closes", async () => {
  const p = page(); await settle(); p.run('openSettings()');
  assert.match(p.nodes.get('#metadata-export-actions').innerHTML, /data-metadata-prepare="json" disabled/);
  await p.run('prepareMetadataExport("json")');
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/metadata-export')).length,0);
  const id='b'.repeat(32); let ready=false;
  p.setFetch(url=>({ok:true,json:async()=>url==='/api/metadata-export' ? {id,state:'preparing',format:'csv'}
    : ready ? {id,state:'ready',format:'csv',filename:'metadata.zip',manifest:{counts:{}}} : {id,state:'preparing',format:'csv'}}));
  p.run('state.mode="live"; state.connection.playback_session="export-session"; openSettings()');
  await p.run('prepareMetadataExport("csv")'); await settle();
  assert.match(p.nodes.get('#metadata-export-actions').innerHTML,/Cancel preparation/);
  p.nodes.get('#settings').close(); await p.nodes.get('#settings').emit('close');
  const count = p.requests.length;
  p.flushTimers(1000); await settle();
  assert.equal(p.requests.length,count);
  ready=true; p.run('openSettings()'); await settle();
  assert.match(p.nodes.get('#metadata-export-status').innerHTML,/Download CSV ZIP/);
  assert.equal(p.downloads.length,0);
});

test("late metadata preparations and status replies cannot expose a replaced library's download", async () => {
  const p = page(); await settle(); const id='c'.repeat(32);
  p.run('state.mode="live"; state.connection.playback_session="first"; openSettings()');
  let release;
  p.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  const pending=p.run('prepareMetadataExport("json")');
  p.run('state.details=new Map(); state.connection.playback_session="second"; render()');
  release({ok:true,json:async()=>({id,state:'preparing',format:'json'})}); await pending; await settle();
  assert.equal(p.run('metadataExportView.job'),null);
  assert.doesNotMatch(p.nodes.get('#metadata-export-status').innerHTML,/Download/);
  let delayed;
  p.setFetch(url=>url==='/api/metadata-export' ? {ok:true,json:async()=>({id,state:'preparing',format:'json'})}
    : new Promise(resolve=>{delayed=resolve;}));
  await p.run('prepareMetadataExport("json")'); await settle();
  p.run('useLocal(demoLibrary(),"demo"); updateChrome()');
  delayed({ok:true,json:async()=>({id,state:'ready',format:'json',filename:'old.json',manifest:{counts:{}}})}); await settle();
  assert.equal(p.run('metadataExportView.job'),null);
  assert.doesNotMatch(p.nodes.get('#metadata-export-status').innerHTML,/old.json|Download/);
});

test("metadata cancellation and expiry allow a fresh preparation without saving settings", async () => {
  const p=page(); await settle(); const id='d'.repeat(32);
  p.run('state.mode="live"; state.connection.playback_session="export-session"; openSettings()');
  let expired=false;
  p.setFetch((url,options)=> {
    if(url==='/api/metadata-export/cancel') {
      assert.deepEqual(JSON.parse(options.body),{id,session:'export-session'});
      return {ok:true,json:async()=>({state:'cancelled'})};
    }
    return expired ? {ok:false,status:400,json:async()=>({error:'This metadata export expired.'})}
      : {ok:true,json:async()=>({id,state:'preparing',format:'json'})};
  });
  await p.run('prepareMetadataExport("json")'); await settle();
  await p.run('cancelMetadataExport()'); await settle();
  assert.equal(p.run('metadataExportView.job'),null);
  assert.equal(p.run('metadataExportView.busy'),false);
  await p.run('prepareMetadataExport("json")'); await settle();
  expired=true; p.flushTimers(1000); await settle();
  assert.match(p.nodes.get('#metadata-export-status').innerHTML,/expired/);
  assert.doesNotMatch(p.nodes.get('#metadata-export-actions').innerHTML,/data-metadata-prepare="json" disabled/);
  assert.equal(p.requests.filter(r=>r.url==='/api/settings' && r.options?.method==='POST').length,0);
});

test("reopening Settings ignores an older in-flight export status reply", async () => {
  const p=page(); await settle(); const id='e'.repeat(32); let release, reads=0;
  p.run('state.mode="live"; state.connection.playback_session="export-session"; openSettings()');
  p.setFetch(url=> {
    if(url==='/api/metadata-export') return {ok:true,json:async()=>({id,state:'preparing',format:'json'})};
    reads++;
    if(reads===1) return new Promise(resolve=>{release=resolve;});
    return {ok:true,json:async()=>({id,state:'ready',format:'json',filename:'new.json',manifest:{counts:{}}})};
  });
  await p.run('prepareMetadataExport("json")'); await settle();
  p.nodes.get('#settings').close(); await p.nodes.get('#settings').emit('close');
  p.run('openSettings()'); await settle();
  assert.match(p.nodes.get('#metadata-export-status').innerHTML,/Download JSON/);
  release({ok:true,json:async()=>({id,state:'preparing',format:'json'})}); await settle();
  assert.equal(p.run('metadataExportView.busy'),false);
  assert.match(p.nodes.get('#metadata-export-status').innerHTML,/Download JSON/);
});

test('playlist detail shows whole-list duration and an accessible cover action, including missing images and durations', async () => {
  const p=page(); await settle(); p.run('state.mode="live"');
  const data={id:'81',name:'Long <list>',description:'',tracks:['100'],rows:[],total:750,offset:100,duration:187200,duration_missing:0};
  p.setFetch(()=>({ok:true,json:async()=>data}));
  p.run('showCollections("playlists","81")'); await settle();
  let html=p.nodes.get('#collections-page').innerHTML;
  assert.match(html,/750 tracks · 52:00:00 · in playlist order/);
  assert.match(html,/class="image-edit-button playlist-cover-edit" data-playlist-cover aria-label="Change cover for Long &lt;list&gt;"/);
  assert.match(html,/playlist-placeholder/);
  assert.equal((html.match(/data-playlist-cover/g)||[]).length,1);
  assert.doesNotMatch(html,/Change cover…/);
  Object.assign(data,{duration:180,duration_missing:2,artwork:'https://example.invalid/cover.jpg'});
  await p.run('renderCollections()'); html=p.nodes.get('#collections-page').innerHTML;
  assert.match(html,/3:00 known · 2 tracks without duration/);
  assert.match(html,/src="https:\/\/example.invalid\/cover.jpg"/);
  assert.equal(p.run('playlistDuration({duration:0,duration_missing:1})'),' · 1 track without duration');
  assert.equal(p.run('playlistDuration({duration:0,duration_missing:0})'),' · 0:00');
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('playlist list view is remembered locally and switches without requests, metadata writes or playback changes', async () => {
  const storage={}, p=page({storage}); await settle();
  p.run('state.mode="live"; playTracks(state.details.get("1"));');
  const data={total:2,offset:0,playlists:[
    {id:'81',kind:'playlist',name:'A <list>',count:4,active_count:3,unavailable_count:1,duration:7260,duration_missing:0},
    {id:'82',kind:'folder',name:'Folder',count:2}
  ]};
  p.setFetch(()=>({ok:true,json:async()=>data}));
  p.run('showCollections("playlists")'); await settle();
  const requests=p.requests.length, before=p.run('JSON.stringify({queue:player.queue,src:audio.src,albumView:state.view,query:collectionsView.query,offset:collectionsView.offset})');
  await p.click({'[data-playlists-view]':{isConnected:true,dataset:{playlistsView:'list'}}});
  const html=p.nodes.get('#collections-page').innerHTML;
  assert.match(html,/class="playlist-list"/); assert.match(html,/A &lt;list&gt;/);
  assert.match(html,/2:01:00/); assert.match(html,/1 unavailable track/);
  assert.match(html,/2 references/); assert.match(html,/data-playlists-view="list"[^>]+aria-pressed="true"/);
  assert.equal(storage['tagcast-playlists-view'],'list');
  assert.equal(p.requests.length,requests);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,albumView:state.view,query:collectionsView.query,offset:collectionsView.offset})'),before);
  const restored=page({storage}); assert.equal(restored.run('collectionsView.view'),'list');
  await p.click({'[data-playlists-view]':{isConnected:true,dataset:{playlistsView:'grid'}}});
  assert.match(p.nodes.get('#collections-page').innerHTML,/class="playlist-cards"/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/3 tracks \/ 2:01:00 · 1 unavailable/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/2 playlist references · Folder/);
  assert.match(p.run('playlistBrowseCard({id:"83",kind:"playlist",name:"Partial",count:3,duration:180,duration_missing:2})'),/3 tracks \/ 3:00 known · 2 tracks without duration/);
  assert.match(p.run('playlistBrowseCard({id:"84",kind:"playlist",name:"Missing",count:1,active_count:0,unavailable_count:1,duration:0})'),/0 tracks \/ 0:00 · 1 unavailable/);
  assert.equal(p.requests.length,requests);
});

test('playlist browsing shows native covers and folders without treating folder references as tracks', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="session-folders"; playTracks(state.details.get("1"))');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  p.setFetch(url=>({ok:true,json:async()=>url.includes('id=40') ? {id:'40',name:'Decades',description:'',is_folder:true,total:2,offset:0,before_token:'folder-before',parents:[],parent_count:0,
    playlists:[{id:'81',name:'Eighties',kind:'playlist',count:5,artwork:'https://example.invalid/cover.jpg'}, {id:'999',name:'Unavailable playlist',kind:'unavailable',count:0}]}
    : {playlists:[{id:'40',name:'Decades',kind:'folder',count:2},{id:'82',name:'Covered',kind:'playlist',count:2,artwork:'https://example.invalid/list.jpg'}],total:2,offset:0}}));
  p.run('showCollections("playlists")'); await settle();
  assert.match(p.requests.at(-1).url,/browse=1/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/Create folder/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/list.jpg/);
  p.run('showCollections("playlists","40")'); await settle();
  const html=p.nodes.get('#collections-page').innerHTML;
  assert.match(html,/PLAYLIST FOLDER/); assert.match(html,/Add playlists or folders/);
  assert.match(html,/data-folder-remove="999"/);
  assert.doesNotMatch(html,/data-playlist-play|data-playlist-edit|data-playlist-position/);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('folder creation is reviewed and confirmed independently of metadata and playback', async () => {
  const p=page(); await settle(); p.run('state.mode="live"; state.connection.playback_session="folder-session"; playTracks(state.details.get("1"))');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  p.setFetch((url,options)=> {
    if(url==='/api/playlist-folder') {
      const body=JSON.parse(options.body); assert.equal(body.action,'create'); assert.equal(body.approved,true);
      assert.equal(body.session,'folder-session'); assert.equal(body.name,'<Decades>'); assert.equal(body.tracks,undefined);
      return {ok:true,json:async()=>({id:'40',job:'folder-save'})};
    }
    return {ok:true,json:async()=>({state:'done',results:[{id:'40',status:'saved'}]})};
  });
  await p.run('openPlaylistFolder("create")');
  p.run('reviewPlaylistFolder({elements:{name:{value:"<Decades>"},description:{value:"Notes"}}})');
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/&lt;Decades&gt;/);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-folder').length,0);
  await p.run('savePlaylistFolder()');
  assert.equal(p.nodes.get('#playlist-dialog').open,false);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-folder').length,1);
});

test('folder additions retain selections across bounded pages and submit playlist identities after review', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="folder-session"; collectionsView.data={id:"40",offset:0}');
  const folder={id:'40',name:'Decades',description:'',is_folder:true,playlists:[],total:0,offset:0,before_token:'folder-token'};
  p.setFetch(url=>({ok:true,json:async()=>url.startsWith('/api/playlists?id=') ? folder : {playlists:url.includes('offset=100') ? [{id:'82',name:'Nineties',kind:'folder',before_token:'child-82'}] : [{id:'81',name:'Eighties',kind:'playlist',count:50,before_token:'child-81'}],total:101,offset:url.includes('offset=100')?100:0}}));
  await p.run('openPlaylistFolder("add")');
  await p.change({dataset:{folderChoice:'81'},checked:true,matches:()=>false,closest:()=>null});
  p.run('folderDraft.offset=100'); await p.run('loadFolderChoices()');
  await p.change({dataset:{folderChoice:'82'},checked:true,matches:()=>false,closest:()=>null});
  p.run('reviewPlaylistFolder()');
  const body=p.json('folderDraft.body');
  assert.equal(body.action,'add'); assert.equal(body.before_token,'folder-token');
  assert.deepEqual(body.members.map(m=>m.id),['81','82']);
  assert.equal(body.tracks,undefined); assert.equal(body.members[0].before_token,'child-81');
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  p.nodes.get('#playlist-dialog').close(); await p.nodes.get('#playlist-dialog').emit('close');
  await p.run('savePlaylistFolder()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-folder').length,0);
});

test('folder unlink review identifies the reference and never queues or deletes the child playlist', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="folder-session"; collectionsView.data={id:"40",offset:100}');
  p.setFetch(url=> { assert.match(url,/id=40&offset=100/); return {ok:true,json:async()=>({id:'40',name:'Decades',is_folder:true,offset:100,before_token:'before',playlists:[{id:'81',name:'Eighties',kind:'playlist',before_token:'child'}]})}; });
  await p.run('openPlaylistFolder("remove","81")');
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/playlists themselves stay available/);
  const body=p.json('folderDraft.body'); assert.equal(body.action,'remove'); assert.equal(body.members[0].id,'81');
  assert.equal(body.confirm_delete,undefined); assert.equal(body.tracks,undefined);
});

test('stale folder reads and writes are rejected after library or dialog replacement', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="folder-session"; collectionsView.data={id:"40"}');
  let release;
  p.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  const pending=p.run('openPlaylistFolder("rename")');
  p.run('state.details=new Map(); state.connection.playback_session="new-account"');
  release({ok:true,json:async()=>({id:'40',name:'OLD PRIVATE FOLDER',is_folder:true,playlists:[]})}); await pending;
  assert.doesNotMatch(p.nodes.get('#playlist-dialog-content').innerHTML,/OLD PRIVATE FOLDER/);
  await p.run('savePlaylistFolder()'); assert.equal(p.requests.filter(r=>r.url==='/api/playlist-folder').length,0);
  p.setFetch(()=>({ok:true,json:async()=>({playlists:[]})}));
  await p.run('openPlaylistSave()');
  assert.equal(p.run('folderDraft.body'),null);
});

test('playlist covers use the existing comparison and a separate checked save without changing tracks or History', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="cover-session"; playTracks(state.details.get("1")); collectionsView.data={id:"81",name:"My list",before_token:"cover-before",artwork:"https://example.invalid/old.jpg"}');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  const requests=p.requests.length;
  p.run('openPlaylistCover()');
  assert.match(p.nodes.get('#artwork-content').innerHTML,/PLAYLIST COVER/);
  assert.match(p.nodes.get('#artwork-content').innerHTML,/Track and album artwork stays unchanged/);
  assert.equal(p.requests.length,requests,'Opening never searches online sources or fetches related track artwork');
  p.setFetch((url,options)=> {
    if(url==='/api/playlist/artwork') {
      const body=JSON.parse(options.body); assert.deepEqual(body.source,{artwork_id:99});
      assert.equal(body.before_token,'cover-before'); assert.equal(body.approved,true);
      return {ok:true,json:async()=>({job:'cover-job',artwork_id:99,image:'https://example.invalid/new.jpg'})};
    }
    return {ok:true,json:async()=>({state:'done',results:[{id:'81',status:'saved'}]})};
  });
  p.run('art.options=[{artwork_id:99}]; art.choice=0'); await p.run('saveArtwork()');
  assert.equal(p.nodes.get('#artwork').open,false);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('an ambiguous playlist cover save cannot repeat and stale account targets cannot send', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="cover-session"; collectionsView.data={id:"81",name:"List",before_token:"before"}; openPlaylistCover(); art.options=[{artwork_id:99}]; art.choice=0');
  p.setFetch(()=>({ok:false,status:503,json:async()=>({error:'Uncertain request'})}));
  await p.run('saveArtwork()'); await p.run('saveArtwork()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist/artwork').length,1);
  assert.match(p.nodes.get('#art-status').textContent,/Check the playlist before retrying/);
  p.run('state.connection.playback_session="other-account"; art.submitted=false'); await p.run('saveArtwork()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist/artwork').length,1);
});


test('folder rename review shows the exact new name and escaped description', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="folder-session"; collectionsView.data={id:"40"}');
  p.setFetch(()=>({ok:true,json:async()=>({id:'40',name:'Before',description:'Old',is_folder:true,playlists:[],before_token:'token'})}));
  await p.run('openPlaylistFolder("rename")');
  p.run('reviewPlaylistFolder({elements:{name:{value:"After"},description:{value:"<New notes>"}}})');
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/Name: Before → After/);
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/Description: &lt;New notes&gt;/);
  assert.equal(p.json('folderDraft.body').description,'<New notes>');
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

async function csvImportPage() {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="csv-session"; playTracks(state.details.get("1")); openPlaylistImport()');
  return p;
}
function csvMatched(overrides={}) {
  const track={id:'101',album_id:'1',title:'Song',artist:'Artist',performers:[{name:'Artist'}],album:'Album',album_artist:'Artist',disc:1,track:1,year:1985,length:180,format:'FLAC'};
  return {id:'a'.repeat(32),revision:2,phase:'matched',summary:{total:2,resolved:1,unresolved:1,skipped:0,duplicates:0,unique:1,automatic:1,manual:0,blank_records:0},
    rows:[{position:0,line:2,status:'automatic',eligible:1,source:{title:'Song',artist:'Artist',album:'Album',duration:'3:00',year:1985,warnings:[]},choice:track,candidates:[track]},
      {position:1,line:3,status:'missing',eligible:0,source:{title:'<Unknown>',artist:'Artist',album:'',duration:'',year:0,warnings:[]},choice:null,candidates:[]}],
    offset:0,total:2,show:'all',...overrides};
}

test('CSV import opens only for a connected loaded library and starts no lookup or playback changes', async () => {
  const p=page(); await settle();
  p.run('openPlaylistImport()'); assert.equal(Boolean(p.nodes.get('#playlist-import').open),false);
  p.run('state.mode="live"; state.connection.playback_session="csv-session"; playTracks(state.details.get("1"))');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'), requests=p.requests.length;
  p.run('openPlaylistImport()');
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/First record contains column headings/);
  assert.equal(p.requests.length,requests);
  p.run('openHelp()'); assert.equal(p.run('helpTour.topic'),'playlist-import'); p.run('closeHelp()');
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

function urlImportMapping() {
  return {id:'a'.repeat(32),revision:1,phase:'mapping',columns:['Track title','Artist','Album','Duration'],
    mapping:{title:0,artist:1,album:null,album_artist:null,duration:3,year:null,track:null},
    total:2,blank_records:0,name:'<Public playlist>',duration_unit:'seconds',artist_separator:'',
    origin:{provider:'deezer',id:'123'},source_url:'https://www.deezer.com/playlist/123',
    sample:[{line:2,cells:['Song','Artist','Other album','180']}]};
}

test('Playlist URL opens without fetching and explicit Fetch uses shared mapping without touching audio or review', async () => {
  const p=await csvImportPage(); p.nodes.get('#playlist-import').close(); await settle();
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'), count=p.requests.length;
  await p.click({'[data-playlist-url]':{}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/id="playlist-url-form"/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/ListenBrainz is experimental/);
  assert.equal(p.requests.length,count);
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/url');
    assert.deepEqual(JSON.parse(options.body),{url:'https://deezer.com/playlist/123',session:'csv-session'});
    return {ok:true,json:async()=>urlImportMapping()};
  });
  await p.emitDocument('submit',{preventDefault(){},target:{id:'playlist-url-form',elements:{url:{value:' https://deezer.com/playlist/123 '}}}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/1. Link columns/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Public playlist from/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/href="https:\/\/www.deezer.com\/playlist\/123"/);
  assert.equal(p.run('csvImport.name'),'<Public playlist>');
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())})`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Playlist track 1:/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="&lt;Public playlist&gt;"/);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/save')||r.url.endsWith('/match')||r.url.endsWith('/review')).length,0);
});

test('URL fetch failures keep input and late replies discard only their local draft without reopening', async () => {
  const p=await csvImportPage(); p.nodes.get('#playlist-import').close(); await settle();
  p.run('openPlaylistUrlImport(); $("#playlist-url-input").value="https://listenbrainz.org/playlist/example"');
  p.setFetch(()=>({ok:false,status:400,json:async()=>({error:'The source returned a browser check. Use CSV.'})}));
  await p.run('fetchPlaylistUrl({elements:{url:{value:$("#playlist-url-input").value}}})');
  assert.match(p.nodes.get('#csv-import-status').textContent,/browser check/);
  assert.equal(p.nodes.get('#playlist-url-input').value,'https://listenbrainz.org/playlist/example');
  assert.equal(p.run('csvImport.busy'),false);
  p.run('requestClosePlaylistImport()');
  assert.equal(p.nodes.get('#csv-import-discard').open,true);
  p.nodes.get('#csv-import-discard').close();
  let finish;
  p.setFetch((url)=>url.endsWith('/url')?new Promise(resolve=>{finish=resolve;}):{ok:true,json:async()=>({discarded:true})});
  const pending=p.run('fetchPlaylistUrl({elements:{url:{value:"https://deezer.com/playlist/123"}}})');
  const requests=p.requests.filter(r=>r.url.endsWith('/url')).length;
  await p.run('fetchPlaylistUrl({elements:{url:{value:"https://deezer.com/playlist/123"}}})');
  assert.equal(p.requests.filter(r=>r.url.endsWith('/url')).length,requests,'One in-flight fetch');
  p.nodes.get('#playlist-import').close();
  finish({ok:true,json:async()=>urlImportMapping()}); await pending; await settle();
  assert.equal(p.nodes.get('#playlist-import').open,false);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/discard')).length,1);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/save')).length,0);
});

test('URL replies after an account change cannot restore data or discard another account draft', async () => {
  const p=await csvImportPage(); p.nodes.get('#playlist-import').close(); await settle();
  p.run('openPlaylistUrlImport()');
  let finish;
  p.setFetch(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=p.run('fetchPlaylistUrl({elements:{url:{value:"https://deezer.com/playlist/123"}}})');
  p.run('state.connection.playback_session="other-account"');
  finish({ok:true,json:async()=>urlImportMapping()}); await pending;
  assert.equal(p.run('csvImport.data'),null);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/discard')||r.url.endsWith('/save')).length,0);
});

test('CSV reader handles Unicode BOM, explicit Windows encoding and CSV column preview without following URLs', async () => {
  const p=await csvImportPage(); await settle();
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/read'); const body=JSON.parse(options.body);
    assert.match(body.text,/Björk/); assert.equal(body.delimiter,';'); assert.equal(body.header,true);
    return {ok:true,json:async()=>({id:'a'.repeat(32),revision:1,phase:'mapping',columns:['Title','Artist','Duration (ms)','Cover URL'],mapping:{title:0,artist:1,duration:2},total:1,blank_records:0,
      sample:[{line:2,cells:['<Title>','Björk','180000','https://example.invalid/do-not-fetch']} ]})};
  });
  await p.run(`readPlaylistCsv({elements:{file:{files:[{name:'My list.csv',size:60,arrayBuffer:async()=>new TextEncoder().encode('Title;Artist\\nSong;Björk').buffer}]},encoding:{value:'auto'},delimiter:{value:';'},header:{checked:true}}})`);
  assert.equal(p.run('csvImport.name'),'My list');
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/&lt;Title&gt;/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="milliseconds" selected/);
  assert.equal(p.requests.filter(r=>r.url.startsWith('https:')).length,0);
  p.run('csvImport.data=null');
  await p.run(`readPlaylistCsv({elements:{file:{files:[{name:'Windows.csv',size:3,arrayBuffer:async()=>new Uint8Array([66,106,246,114,107]).buffer}]},encoding:{value:'windows-1252'},delimiter:{value:';'},header:{checked:true}}})`);
  assert.equal(p.run('csvImport.name'),'Windows');
});

test('CSV file errors retain the file step and do not send truncated or undecodable contents', async () => {
  const p=await csvImportPage(); await settle(); const requests=p.requests.length;
  await p.run(`readPlaylistCsv({elements:{file:{files:[{name:'Too big.csv',size:6*1024*1024}]}}})`);
  assert.match(p.nodes.get('#csv-import-status').textContent,/5 MB/);
  await p.run(`readPlaylistCsv({elements:{file:{files:[{name:'Bad.csv',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer}]},encoding:{value:'auto'},delimiter:{value:'auto'},header:{checked:true}}})`);
  assert.match(p.nodes.get('#csv-import-status').textContent,/Windows-1252/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/csv-file-form/);
  assert.equal(p.requests.length,requests);
});

test('CSV mapping explains album strictness and keeps explicit copy preference when revisiting columns', async () => {
  const p=await csvImportPage(); await settle();
  const before=p.requests.length;
  p.run(`csvImport.mapping={title:0,artist:1}; csvImport.copyPreference="flac_oldest";
    renderCsvMapping({id:"draft",revision:1,columns:["Title","Artist","Album"],sample:[],total:2,blank_records:0,mapping:{title:0,artist:1,album:2}});`);
  let html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/Mapping Album title makes matching stricter/);
  assert.match(html,/copies from other albums or compilations/);
  assert.match(html,/value="flac_oldest" selected/);
  assert.match(html,/apply only when all mapped fields match/);
  assert.match(html,/unknown years last/);
  assert.match(html,/lowest track ID/);
  assert.equal((html.match(/<option value="(?:manual|flac|oldest|first|flac_oldest)"/g)||[]).length,5);
  await p.click({'[data-csv-columns]':{}});
  html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/value="flac_oldest" selected/);
  assert.equal(p.requests.length,before,'Choosing or viewing options never writes or fetches');
});

test('CSV mapping submits zero-based column choices and units only after the match button', async () => {
  const p=await csvImportPage(); await settle();
  p.run('csvImport.data={id:"'+'a'.repeat(32)+'",revision:1}');
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/match'); const body=JSON.parse(options.body);
    assert.deepEqual(body.mapping,{title:0,artist:1,album:null,album_artist:null,duration:2,year:null,track:null});
    assert.equal(body.duration_unit,'milliseconds'); assert.equal(body.artist_separator,';'); assert.equal(body.copy_preference,'flac_oldest');
    assert.equal(body.show,'unresolved'); assert.equal(body.offset,0);
    return {ok:true,json:async()=>csvMatched({show:'unresolved'})};
  });
  await p.emitDocument('submit',{preventDefault(){},target:{id:'csv-map-form',elements:{map_title:{value:'0'},map_artist:{value:'1'},map_album:{value:''},map_album_artist:{value:''},map_duration:{value:'2'},map_year:{value:''},map_track:{value:''},duration_unit:{value:'milliseconds'},artist_separator:{value:';'},copy_preference:{value:'flac_oldest'}}}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/1 unresolved/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/&lt;Unknown&gt;/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="unresolved" selected/);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
});

test('CSV import can review only selected matches and clearly omit unresolved records without skipping them', async () => {
  const p=await csvImportPage(); await settle();
  const data=csvMatched({show:'unresolved',total:900});
  data.summary={total:1000,resolved:100,unresolved:900,skipped:0,duplicates:0,unique:100,automatic:100,manual:0,blank_records:0};
  data.rows=[{...data.rows[1],position:100}];
  p.run(`renderCsvMatches(${JSON.stringify(data)})`);
  let html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/class="button primary" >Review 100 matched tracks →/);
  assert.match(html,/900 unresolved CSV records will be left out/);
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  const review={...data,revision:3,phase:'review',name:'Found tracks',description:'',total:100,offset:0,omitted_unresolved:900,review_token:'partial-review',tracks:[csvMatched().rows[0].choice]};
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/review');
    assert.deepEqual(JSON.parse(options.body),{id:data.id,revision:2,session:'csv-session',name:'Found tracks',description:'',omit_unresolved:true});
    return {ok:true,json:async()=>review};
  });
  await p.emitDocument('submit',{preventDefault(){},target:{id:'csv-review-form',elements:{name:{value:'Found tracks'},description:{value:''}}}});
  html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/900 unresolved \(left out\)/);
  assert.match(html,/900 unresolved CSV records will be left out/);
  assert.match(html,/Create a new private playlist with 100 tracks/);
  assert.match(html,/Create private playlist in iBroadcast/);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/revise');
    assert.deepEqual(JSON.parse(options.body),{id:data.id,revision:3,session:'csv-session',show:'unresolved',offset:0});
    return {ok:true,json:async()=>({...data,revision:4})};
  });
  await p.click({'[data-csv-revise]':{}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="unresolved" selected/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/900 unresolved/);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('CSV review remains disabled when no track is selected', async () => {
  const p=await csvImportPage(); await settle();
  const data=csvMatched(); Object.assign(data.summary,{unique:0,resolved:0,automatic:0,unresolved:2});
  p.run(`renderCsvMatches(${JSON.stringify(data)})`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/class="button primary" disabled>Review 0 matched tracks/);
});

test('CSV unresolved export downloads original file text without changing choices, playback or history', async () => {
  const p=await csvImportPage(); await settle();
  const data=csvMatched(); p.run(`renderCsvMatches(${JSON.stringify(data)})`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/data-csv-export/);
  const before=p.run('JSON.stringify({data:csvImport.data,queue:player.queue,src:audio.src,history:state.history})');
  const content='\ufeff# Tagcast playlist CSV 1: escaped text\r\nTitle,Artist\r\nMissing,Unknown\r\n';
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/export');
    assert.deepEqual(JSON.parse(options.body),{id:data.id,revision:2,session:'csv-session'});
    return {ok:true,json:async()=>({text:content,count:1,filename:'tagcast-unresolved-1.csv'})};
  });
  await p.click({'[data-csv-export]':{}});
  assert.equal(p.downloads.length,1);
  assert.equal(p.downloads[0].name,'tagcast-unresolved-1.csv');
  assert.equal(p.downloads[0].blob.type,'text/csv;charset=utf-8');
  assert.equal(await p.downloads[0].blob.text(),content.slice(1));
  assert.equal(p.run('JSON.stringify({data:csvImport.data,queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
});

test('CSV export errors preserve the draft and late replies after close never download', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())})`);
  p.setFetch(()=>({ok:false,status:409,json:async()=>({error:'The import changed'})}));
  await p.run('exportUnresolvedCsv()');
  assert.equal(p.downloads.length,0);
  assert.match(p.nodes.get('#csv-import-status').textContent,/import changed/);
  assert.equal(p.run('csvImport.data.revision'),2);
  let release;
  p.setFetch(url=>url.endsWith('/discard')?{ok:true,json:async()=>({})}:new Promise(resolve=>{release=resolve;}));
  const pending=p.run('exportUnresolvedCsv()'); await settle();
  p.nodes.get('#playlist-import').close(); await p.nodes.get('#playlist-import').emit('close');
  release({ok:true,json:async()=>({text:'private CSV',count:1,filename:'unresolved.csv'})}); await pending;
  assert.equal(p.downloads.length,0);
  assert.equal(p.run('csvImport.data'),null);
});

test('a partial import offers unresolved CSV after confirmed creation and opens the playlist on close', async () => {
  const p=await csvImportPage(); await settle();
  const data=csvMatched({phase:'review',review_token:'one-use',total:1,tracks:[csvMatched().rows[0].choice],name:'Partial',description:''});
  p.run(`renderCsvReview(${JSON.stringify(data)})`);
  p.setFetch(url=>({ok:true,json:async()=>url.endsWith('/save')?{id:'88',job:'check'}:url.startsWith('/api/jobs/')?{state:'done',results:[{id:'88',status:'saved'}]}:url.endsWith('/export')?{text:'Title,Artist\r\nMissing,Unknown\r\n',count:1,filename:'tagcast-unresolved-1.csv'}:{id:'88',name:'Partial',tracks:[101],rows:[],total:1}}));
  await p.run('saveCsvPlaylist()'); await settle();
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Playlist created/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/data-csv-export/);
  assert.doesNotMatch(p.nodes.get('#csv-import-content').innerHTML,/data-csv-save/);
  await p.run('saveCsvPlaylist()');
  assert.equal(p.requests.filter(r=>r.url.endsWith('/save')).length,1);
  await p.run('exportUnresolvedCsv()');
  assert.equal(p.downloads.length,1);
  p.nodes.get('#playlist-import').close(); await p.nodes.get('#playlist-import').emit('close'); await settle();
  assert.equal(p.run('collectionsView.playlist'),'88');
  assert.equal(p.run('csvImport.createdPlaylist'),null);
});

test('Tagcast unresolved CSV files can be re-imported above the normal file limit', async () => {
  const p=await csvImportPage(); await settle();
  const content='\ufeff# Tagcast playlist CSV 1: escaped text\r\nTitle,Artist\r\nMissing,Unknown\r\n';
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/read'); assert.match(JSON.parse(options.body).text,/# Tagcast playlist CSV 1/);
    return {ok:true,json:async()=>({id:'a'.repeat(32),revision:1,columns:['Title','Artist'],mapping:{title:0,artist:1},sample:[],total:1,blank_records:0})};
  });
  await p.run(`readPlaylistCsv({elements:{file:{files:[{name:'tagcast-unresolved.csv',size:6*1024*1024,arrayBuffer:async()=>new TextEncoder().encode(${JSON.stringify(content)}).buffer}]},encoding:{value:'auto'},delimiter:{value:'auto'},header:{checked:true}}})`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Link columns/);
});

test('CSV manual resolver shows version, album, format and duration and searches a bounded page', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); renderCsvResolver(0)`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Suggestions are alternatives/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/FLAC/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Disc 1, track 1/);
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/search');
    assert.deepEqual(JSON.parse(options.body),{id:'a'.repeat(32),revision:2,session:'csv-session',query:'song',offset:0});
    return {ok:true,json:async()=>({tracks:[csvMatched().rows[0].choice],total:80,offset:0})};
  });
  await p.emitDocument('submit',{preventDefault(){},target:{id:'csv-search-form',elements:{query:{value:'song'}}}});
  assert.match(p.nodes.get('#csv-search-results').innerHTML,/80 library matches/);
  assert.match(p.nodes.get('#csv-search-results').innerHTML,/data-csv-choose="101"/);
  assert.match(p.nodes.get('#csv-search-results').innerHTML,/data-offset="50"/);
});

test('CSV unexplained rows show escaped reasons in the overview and differences for each suggestion', async () => {
  const p=await csvImportPage(); await settle();
  const data=csvMatched(), row=data.rows[1];
  row.status='ambiguous';
  row.reasons=['Compared with the first suggestion: Performing artist name differs.','<script>untrusted</script>'];
  row.candidates=[{...data.rows[0].choice,differences:['Performing artist name differs','<img src=x>']}];
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'), requests=p.requests.length;
  p.run(`renderCsvMatches(${JSON.stringify(data)})`);
  let html=p.nodes.get('#csv-import-content').innerHTML;
  assert.equal((html.match(/Match explanation/g)||[]).length,1);
  assert.match(html,/Compared with the first suggestion: Performing artist name differs/);
  assert.match(html,/&lt;script&gt;untrusted&lt;\/script&gt;/);
  p.run('renderCsvResolver(1)');
  html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/Match explanation/);
  assert.match(html,/Differs from CSV:<\/strong> Performing artist name differs; &lt;img src=x&gt;/);
  assert.doesNotMatch(html,/<script>|<img src=x>/);
  assert.match(html,/data-csv-choose="101"/);
  assert.equal(p.requests.length,requests);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('CSV multiple-copy reasons distinguish agreeing suggestions from invalid CSV fields', async () => {
  const p=await csvImportPage(); await settle();
  const data=csvMatched(), row=data.rows[0];
  Object.assign(row,{status:'ambiguous',eligible:2,choice:null,reasons:['2 library tracks match all mapped fields. Choose a copy.']});
  row.candidates[0].differences=[];
  p.run(`renderCsvMatches(${JSON.stringify(data)}); renderCsvResolver(0)`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/2 library tracks match all mapped fields/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Matches all mapped fields\./);
  row.source.warnings=['Invalid duration; check the column and units'];
  row.reasons=['CSV fields need attention; check the warnings.'];
  p.run(`renderCsvMatches(${JSON.stringify(data)}); renderCsvResolver(0)`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/No differences in the valid CSV fields; check the warnings/);
  assert.doesNotMatch(p.nodes.get('#csv-import-content').innerHTML,/Matches all mapped fields\./);
});

test('CSV choice and explicit skip retain row identity, filter and input-order review counts', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); renderCsvResolver(1)`);
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/choose'); const body=JSON.parse(options.body);
    assert.equal(body.position,1); assert.equal(body.track_id,'101'); assert.equal(body.skip,undefined);
    return {ok:true,json:async()=>csvMatched({revision:3,summary:{total:2,resolved:2,unresolved:0,skipped:0,duplicates:1,unique:1,automatic:1,manual:1,blank_records:0}})};
  });
  await p.click({'[data-csv-choose]':{dataset:{csvChoose:'101'}}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/1 repeated selections/);
  p.setFetch((url,options)=> {
    const body=JSON.parse(options.body); assert.equal(body.skip,true); assert.equal(body.position,1); assert.equal(body.revision,3);
    return {ok:true,json:async()=>csvMatched({revision:4})};
  });
  await p.click({'[data-csv-skip]':{dataset:{csvSkip:'1'}}});
  assert.equal(p.run('csvImport.data.revision'),4);
});

test('CSV match pages and filters retain the playlist name and never touch playback or browser history', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())})`);
  await p.emitDocument('input',{target:{id:'csv-playlist-name',value:'My import'}});
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'); const entries=p.history.length;
  p.setFetch((url,options)=> {
    const body=JSON.parse(options.body); assert.equal(url,'/api/playlist-import/view'); assert.equal(body.show,'unresolved');
    return {ok:true,json:async()=>csvMatched({show:'unresolved',offset:0,total:1})};
  });
  await p.change({id:'csv-import-filter',value:'unresolved',matches:()=>false,closest:()=>null});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="My import"/);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.history.length,entries);
});

test('CSV final review has a separate save and uses only its server token to create the playlist', async () => {
  const p=await csvImportPage(); await settle(); const track=csvMatched().rows[0].choice;
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())})`);
  const summary={total:2,resolved:1,unresolved:0,skipped:1,duplicates:0,unique:1,automatic:1,manual:0,blank_records:0};
  const review={id:'a'.repeat(32),revision:3,phase:'review',review_token:'review-token',name:'Chosen',description:'Notes',summary,total:1,offset:0,tracks:[track]};
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  p.setFetch((url,options)=> {
    if(url==='/api/playlist-import/review') return {ok:true,json:async()=>review};
    if(url==='/api/playlist-import/save') {
      assert.deepEqual(JSON.parse(options.body),{id:review.id,revision:3,session:'csv-session',review_token:'review-token',approved:true});
      return {ok:true,json:async()=>({id:'88',job:'csv-check'})};
    }
    if(url==='/api/jobs/csv-check') return {ok:true,json:async()=>({state:'done',results:[{id:'88',status:'saved'}]})};
    return {ok:true,json:async()=>({id:'88',name:'Chosen',tracks:[101],rows:[],total:1,offset:0})};
  });
  await p.emitDocument('submit',{preventDefault(){},target:{id:'csv-review-form',elements:{name:{value:'Chosen'},description:{value:'Notes'}}}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/1 skipped/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Create private playlist in iBroadcast/);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
  await p.run('saveCsvPlaylist()'); await settle();
  assert.equal(p.nodes.get('#playlist-import').open,false);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,1);
});

function pausedCsvRow(overrides={}) {
  return {id:'b'.repeat(32),token:'c'.repeat(32),name:'My paused import',description:'Notes',
    saved_at:1792486800,state:'paused',phase:'matched',total:2,manual:1,unresolved:1,playlist:'',...overrides};
}

test('Pause import explicitly saves local progress and closes only after success without affecting playback', async () => {
  for (const success of [true,false]) {
    const p=await csvImportPage(); await settle();
    p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); csvImport.mapping={title:0,artist:1}; csvImport.copyPreference="flac_oldest";
      $("#csv-playlist-name").value="My paused import"; $("#csv-playlist-description").value="Notes";
      { const query=document.querySelector.bind(document); document.querySelector=s=>s==="#csv-map-form"?null:query(s); }`);
    assert.equal(p.nodes.get('#csv-import-pause').hidden,false);
    const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
    p.setFetch((url,options)=> {
      assert.equal(url,'/api/playlist-import/pause');
      const body=JSON.parse(options.body);
      assert.deepEqual(body.mapping,{title:0,artist:1});
      assert.equal(body.name,'My paused import'); assert.equal(body.description,'Notes'); assert.equal(body.copy_preference,'flac_oldest');
      assert.equal(body.revision,2); assert.equal(body.session,'csv-session');
      return {ok:success,status:503,json:async()=>success?{saved:pausedCsvRow()}:{error:'Local disk full'}};
    });
    await p.run('pausePlaylistImport()');
    assert.equal(p.nodes.get('#playlist-import').open,!success);
    if (!success) { assert.match(p.nodes.get('#csv-import-status').textContent,/disk full/); assert.equal(p.run('csvImport.data.revision'),2); }
    assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
    assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
  }
});

test('Paused imports lists compact local checkpoints and requires an explicit removal review', async () => {
  const p=await csvImportPage(); p.nodes.get('#playlist-import').close();
  p.setFetch((url,options)=> {
    if (url.endsWith('/paused')) return {ok:true,json:async()=>({imports:[pausedCsvRow({name:'<Saved CSV>'})],limit:10})};
    assert.equal(url,'/api/playlist-import/remove-paused');
    assert.deepEqual(JSON.parse(options.body),{saved_id:'b'.repeat(32),saved_token:'c'.repeat(32),session:'csv-session'});
    return {ok:true,json:async()=>({removed:true})};
  });
  await p.run('openPausedImports()');
  let html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/&lt;Saved CSV&gt;/); assert.match(html,/Refresh library & resume/);
  assert.equal(p.nodes.get('#csv-import-pause').hidden,true);
  await p.click({'[data-csv-remove-paused]':{dataset:{csvRemovePaused:'b'.repeat(32)}}});
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Keep saved import/);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/remove-paused')).length,0);
  await p.click({'[data-csv-remove-cancel]':{}});
  assert.equal(p.requests.filter(r=>r.url.endsWith('/remove-paused')).length,0);
  await p.click({'[data-csv-remove-paused]':{dataset:{csvRemovePaused:'b'.repeat(32)}}});
  await p.click({'[data-csv-remove-confirm]':{dataset:{csvRemoveConfirm:'b'.repeat(32)}}});
  html=p.nodes.get('#csv-import-content').innerHTML;
  assert.match(html,/No paused imports/);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/remove-paused')).length,1);
});

test('Resuming refreshes the library before restoring matches and never reuses a playlist approval', async () => {
  const p=await csvImportPage(); await settle();
  const row=pausedCsvRow();
  p.run(`csvPausedView.rows=[${JSON.stringify(row)}]; globalThis.refreshFinished=false;
    loadLive=async()=>{libraryLoadRequest++; state.details=new Map(state.details);refreshFinished=true;};`);
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  p.setFetch((url,options)=> {
    assert.equal(p.run('refreshFinished'),true); assert.equal(url,'/api/playlist-import/resume');
    assert.deepEqual(JSON.parse(options.body),{saved_id:row.id,saved_token:row.token,session:'csv-session'});
    return {ok:true,json:async()=>({name:row.name,description:row.description,
      mapping:{title:0,artist:1},duration_unit:'seconds',artist_separator:'',copy_preference:'flac_oldest',file:{mapping:{title:0,artist:1},columns:['Title','Artist'],sample:[]},
      view:csvMatched({show:'manual'})})};
  });
  await p.run(`resumePausedImport(${JSON.stringify(row)})`);
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="My paused import"/);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/value="manual" selected/);
  assert.match(p.nodes.get('#csv-import-status').textContent,/Resumed/);
  assert.equal(p.run('csvImport.submitted'),false);
  assert.equal(p.run('csvImport.copyPreference'),'flac_oldest');
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.url.endsWith('/save')||r.url.endsWith('/review')).length,0);
});

test('An account change during resume refresh cannot reopen another account import', async () => {
  const p=await csvImportPage(); await settle();
  p.run('loadLive=()=>{libraryLoadRequest++; return new Promise(resolve=>{globalThis.finishResumeRefresh=resolve;});};');
  const pending=p.run(`resumePausedImport(${JSON.stringify(pausedCsvRow())})`);
  p.run('state.connection.playback_session="another-account"; finishResumeRefresh()');
  await pending;
  assert.equal(p.nodes.get('#playlist-import').open,false);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/resume').length,0);
});

test('CSV close buttons and Escape preserve the complete draft when discard is declined', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); csvImport.name="Keep my work";
    csvImport.description="Notes"; csvImport.offset=50; csvImport.show="manual";
    csvImport.mapping={title:0,artist:1}; csvImport.resolving=csvImport.data.rows[1];
    csvImport.search={query:"Find a copy",offset:50};
    $("#playlist-import").scrollTop=240; $("#csv-playlist-name").focus();`);
  const before=p.run('JSON.stringify({draft:csvImport,html:$("#csv-import-content").innerHTML,queue:player.queue,src:audio.src,history:state.history})');
  for (const label of ['cross','Cancel']) {
    await p.click({'[data-close]':{dataset:{close:'playlist-import'},label}});
    assert.equal(p.nodes.get('#playlist-import').open,true);
    assert.equal(p.nodes.get('#csv-import-discard').open,true);
    assert.match(p.nodes.get('#csv-discard-message').textContent,/manual choices will be lost/);
    assert.equal(p.run('document.activeElement === $("#csv-discard-keep")'),true);
    await p.click({'[data-close]':{dataset:{close:'csv-import-discard'}}});
    await p.nodes.get('#csv-import-discard').emit('close');
    assert.equal(p.run('document.activeElement === $("#csv-playlist-name")'),true);
  }
  let prevented=false;
  await p.nodes.get('#playlist-import').emit('cancel',{preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(p.nodes.get('#csv-import-discard').open,true);
  p.nodes.get('#csv-import-discard').close(); // Native Escape closes only the top dialog.
  await p.nodes.get('#csv-import-discard').emit('close');
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.equal(p.nodes.get('#playlist-import').scrollTop,240);
  assert.equal(p.run('JSON.stringify({draft:csvImport,html:$("#csv-import-content").innerHTML,queue:player.queue,src:audio.src,history:state.history})'),before);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/discard').length,0);
});

test('a mixed frontend update reports how to reload instead of silently losing the CSV draft', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); requestClosePlaylistImport=undefined`);
  const before=p.run('JSON.stringify(csvImport)');
  await p.click({'[data-close]':{dataset:{close:'playlist-import'}}});
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.equal(p.run('JSON.stringify(csvImport)'),before);
  assert.match(p.nodes.get('#toast').textContent,/Reload this tab/);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/discard').length,0);
});

test('confirmed CSV discard clears once and ignores a late match response', async () => {
  const p=await csvImportPage(); await settle(); let release;
  p.run('csvImport.data={id:"'+'a'.repeat(32)+'",revision:1}');
  p.setFetch(url=>url.endsWith('/discard') ? {ok:true,json:async()=>({discarded:true})} : new Promise(resolve=>{release=resolve;}));
  const pending=p.run('csvImportCall("match",{mapping:{title:0,artist:1}})');
  await p.click({'[data-close]':{dataset:{close:'playlist-import'}}});
  assert.equal(p.nodes.get('#playlist-import').open,true);
  await p.click({'#csv-discard-confirm':{}});
  assert.equal(p.nodes.get('#playlist-import').open,false);
  await p.nodes.get('#playlist-import').emit('close');
  release({ok:true,json:async()=>csvMatched()}); await pending;
  assert.equal(p.run('csvImport.data'),null);
  assert.equal(p.nodes.get('#csv-import-content').innerHTML,'');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/discard').length,1);
});

test('CSV close protection covers selected input and running creation but leaves empty and finished dialogs alone', async () => {
  const p=await csvImportPage(); await settle();
  p.run('requestClosePlaylistImport()');
  assert.equal(p.nodes.get('#playlist-import').open,false);
  assert.equal(Boolean(p.nodes.get('#csv-import-discard').open),false);
  p.run('openPlaylistImport(); $("#csv-file-form").elements={file:{files:[{name:"list.csv"}]}}; requestClosePlaylistImport()');
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.equal(p.nodes.get('#csv-import-discard').open,true);
  p.nodes.get('#csv-import-discard').close(); await p.nodes.get('#csv-import-discard').emit('close');
  p.run('$("#csv-file-form").elements={pasted:{value:"Title,Artist"}}; requestClosePlaylistImport()');
  assert.equal(p.nodes.get('#playlist-import').open,true);
  assert.equal(p.nodes.get('#csv-import-discard').open,true);
  p.nodes.get('#csv-import-discard').close(); await p.nodes.get('#csv-import-discard').emit('close');
  p.run('csvImport.submitted=true; csvImport.busy=true; requestClosePlaylistImport()');
  assert.match(p.nodes.get('#csv-discard-message').textContent,/does not cancel it/);
  assert.equal(p.nodes.get('#csv-discard-confirm').textContent,'Close import');
  p.nodes.get('#csv-import-discard').close(); await p.nodes.get('#csv-import-discard').emit('close');
  p.run('csvImport.busy=false; requestClosePlaylistImport()');
  assert.equal(p.nodes.get('#playlist-import').open,false);
  assert.equal(p.nodes.get('#csv-import-discard').open,false);
  p.run('$("#editor").showModal()');
  await p.click({'[data-close]':{dataset:{close:'editor'}}});
  assert.equal(p.nodes.get('#editor').open,false);
  assert.equal(p.nodes.get('#csv-import-discard').open,false);
});

test('CSV close and account replacement ignore late match results and prevent saved choices crossing sessions', async () => {
  const p=await csvImportPage(); await settle(); let release;
  p.run('csvImport.data={id:"'+'a'.repeat(32)+'",revision:1}');
  p.setFetch(url=>url.endsWith("/discard") ? {ok:true,json:async()=>({discarded:true})} : new Promise(resolve=>{release=resolve;}));
  const pending=p.run('csvImportCall("match",{mapping:{title:0,artist:1}})');
  p.nodes.get('#playlist-import').close(); await p.nodes.get('#playlist-import').emit('close');
  release({ok:true,json:async()=>csvMatched()}); await pending;
  assert.equal(p.run('csvImport.data'),null);
  assert.doesNotMatch(p.nodes.get('#csv-import-content').innerHTML,/Cloudbusting|Check matches/);
  p.run('openPlaylistImport(); state.connection.playback_session="new-account"');
  await p.run('saveCsvPlaylist()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
});

test('an uncertain CSV playlist creation can never be sent again from the same review', async () => {
  const p=await csvImportPage(); await settle();
  p.run('csvImport.data={id:"'+'a'.repeat(32)+'",revision:3,phase:"review",review_token:"one-use"}');
  p.setFetch(()=>({ok:false,status:503,json:async()=>({error:'Connection lost'})}));
  await p.run('saveCsvPlaylist()'); await p.run('saveCsvPlaylist()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,1);
  assert.match(p.nodes.get('#csv-import-status').textContent,/Check Playlists before importing again/);
  assert.doesNotMatch(p.nodes.get('#csv-import-content').innerHTML,/data-csv-save/);
});

test('pasted CSV bypasses file decoding and remains plain text in a separate mapping draft', async () => {
  const p=await csvImportPage();
  p.setFetch((url,options)=> {
    assert.equal(url,'/api/playlist-import/read'); const body=JSON.parse(options.body);
    assert.equal(body.text,'Title;Artist\nSong;Björk'); assert.equal(body.header,true); assert.equal(body.delimiter,';');
    return {ok:true,json:async()=>({id:'b'.repeat(32),revision:1,columns:['Title','Artist'],mapping:{title:0,artist:1},sample:[],total:1,blank_records:0})};
  });
  await p.run(`readPlaylistCsv({elements:{pasted:{value:'Title;Artist\\nSong;Björk'},file:{files:[]},delimiter:{value:';'},header:{checked:true}}})`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/Link columns/);
  assert.equal(p.run('csvImport.name'),'Imported playlist');
});

test('a CSV draft closes and clears its displayed data when the active session changes', async () => {
  const p=await csvImportPage();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); requestClosePlaylistImport(); state.connection.playback_session='another-session'; updateChrome()`);
  assert.equal(p.nodes.get('#playlist-import').open,false);
  assert.equal(p.nodes.get('#csv-import-discard').open,false);
  assert.equal(p.nodes.get('#csv-import-content').innerHTML,'');
  assert.equal(p.run('csvImport.data'),null);
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist-import/save').length,0);
});

function searchClearFixture(p, id, value) {
  p.run(`{
    const input=document.getElementById(${JSON.stringify(id)});
    input.id=${JSON.stringify(id)}; input.value=${JSON.stringify(value)};
    const button=document.getElementById(${JSON.stringify(id+'-test-clear')});
    button.dataset.searchClear=${JSON.stringify(id)};
    document.querySelectorAll=selector=>selector==='[data-search-clear]'?[button]:[];
    syncSearchClearButtons();
  }`);
  return {input:p.nodes.get('#'+id),button:p.nodes.get('#'+id+'-test-clear'),
    clear:()=>p.click({'[data-search-clear]':p.nodes.get('#'+id+'-test-clear')})};
}

test('every static search has an accessible non-submit clear button', () => {
  const html=readFileSync(path.join(staticDir,'index.html'),'utf8');
  const ids=['favourite-artists-search','guide-search','artists-search','browse-search','tracks-search','favourites-search','recently-played-search','search','guide-link-search'];
  for (const id of ids) {
    const button=html.match(new RegExp(`<button[^>]*data-search-clear="${id}"[^>]*>`))?.[0];
    assert.ok(button,id); assert.match(button,/type="button"/);
    assert.match(button,new RegExp(`aria-controls="${id}"`));
    assert.match(button,/aria-label="Clear [^"]+"/); assert.match(button,/ hidden>/);
  }
});

test('shared album search clear preserves filters, order, selection, playback and restored history', async () => {
  const p=page(); await settle();
  await p.nodes.get('#all-albums').emit('click');
  p.run('playTracks(state.details.get("1")); state.selected.add("1"); $("#filter").value="all"; $("#sort").value="title_za"; state.page=4');
  const {input,button,clear}=searchClearFixture(p,'search','Pink');
  input.dispatchEvent(new Event('input',{bubbles:true})); p.flushTimers(150);
  assert.equal(button.hidden,false);
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,selected:[...state.selected],changes:state.history})');
  const requests=p.requests.length;
  await clear(); p.flushTimers(150);
  assert.equal(input.value,''); assert.equal(button.hidden,true); assert.equal(p.run('state.page'),0);
  assert.equal(p.nodes.get('#sort').value,'title_za'); assert.equal(p.nodes.get('#filter').value,'all');
  assert.equal(p.run('document.activeElement === $("#search")'),true);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,selected:[...state.selected],changes:state.history})'),before);
  assert.equal(p.requests.length,requests);
  input.value='Pink'; input.dispatchEvent(new Event('input',{bubbles:true})); p.flushTimers(150);
  await p.nodes.get('#show-artists').emit('click');
  p.history.back(); await settle();
  assert.equal(input.value,'Pink'); assert.equal(button.hidden,false);
  await clear(); p.flushTimers(150);
  await p.nodes.get('#show-artists').emit('click'); p.history.back(); await settle();
  assert.equal(input.value,''); assert.equal(button.hidden,true);
});

test('dynamic collection search clears the query and paging without modifying native collections', async () => {
  const p=page(); await settle();
  p.run('collectionsView.query="Test"; collectionsView.offset=100');
  const {input,button,clear}=searchClearFixture(p,'collection-search','Test');
  const requests=p.requests.length;
  await clear();
  assert.equal(input.value,''); assert.equal(button.hidden,true);
  assert.equal(p.run('collectionsView.query'),''); assert.equal(p.run('collectionsView.offset'),0);
  assert.equal(p.requests.length,requests,'Clearing uses the normal debounce, without a write');
  input.value=' '; input.dispatchEvent(new Event('input',{bubbles:true})); assert.equal(button.hidden,false);
  input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); assert.equal(button.hidden,true);
});

test('clearing explicit dialog searches does not submit, fetch, clear metadata or discard CSV choices', async () => {
  const p=await csvImportPage(); await settle();
  p.run(`renderCsvMatches(${JSON.stringify(csvMatched())}); renderCsvResolver(0); cleanupView.ruleLabel="Rock"; cleanupView.ruleText="Rock music"`);
  assert.match(p.nodes.get('#csv-import-content').innerHTML,/data-search-clear="csv-library-query"/);
  assert.match(p.run('lookupPanel({artist:"<Artist>",name:"Album"})'),/value="&lt;Artist&gt;"/);
  const before=p.run('JSON.stringify({csv:csvImport.data,selected:csvImport.resolving,queue:player.queue,src:audio.src,changes:state.history})');
  const requests=p.requests.length;
  for(const id of ['csv-library-query','playlist-destination-query','playlist-folder-query','lookup-artist-search','lookup-album-search','cleanup-label-search']) {
    const {input,button,clear}=searchClearFixture(p,id,'Some query');
    await clear(); assert.equal(input.value,'',id); assert.equal(button.hidden,true,id);
    assert.equal(p.run(`document.activeElement === document.getElementById(${JSON.stringify(id)})`),true,id);
  }
  assert.equal(p.run('cleanupView.labelQuery'),'');
  assert.equal(p.run('cleanupView.ruleLabel'),'Rock'); assert.equal(p.run('cleanupView.ruleText'),'Rock music');
  assert.equal(p.run('JSON.stringify({csv:csvImport.data,selected:csvImport.resolving,queue:player.queue,src:audio.src,changes:state.history})'),before);
  assert.equal(p.requests.length,requests,'Only an explicit Search/Find can start these lookups');
});

test('disabled and readonly searches cannot be cleared and newly rendered queries are escaped', async () => {
  const p=page(); await settle();
  const {input,button,clear}=searchClearFixture(p,'cleanup-label-search','Keep');
  for(const property of ['disabled','readOnly']) {
    input[property]=true; p.run('syncSearchClearButtons()'); assert.equal(button.hidden,true);
    await clear(); assert.equal(input.value,'Keep'); input[property]=false;
  }
  const html=p.run(`clearableSearchInput('safe-query','name="query"','"/><img onerror="bad">')`);
  assert.doesNotMatch(html,/<img/); assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;/);
  p.run('cleanupView.labelQuery="Keep"');
  assert.match(p.run('genreLabelControls(true)'),/data-search-clear="cleanup-label-search"[^>]* hidden/);
});

function selectableSources() {
  return [
    {name:'musicbrainz',label:'MusicBrainz',albums:true,artists:false,key:'',available:true,selected:true,enabled:true},
    {name:'deezer',label:'Deezer',albums:true,artists:true,key:'',available:true,selected:true,enabled:true},
    {name:'itunes',label:'Apple Music / iTunes',albums:true,artists:false,key:'',available:true,selected:true,enabled:true},
    {name:'discogs',label:'Discogs',albums:true,artists:true,key:'discogs_token',key_help:'Token help',available:true,selected:true,enabled:true},
    {name:'lastfm',label:'Last.fm',albums:true,artists:false,key:'lastfm_api_key',key_help:'Key help',available:false,selected:true,enabled:false},
  ];
}

test('Settings offers selected source switches even without keys and keeps saved-key controls when disabled', async () => {
  const p=page(); await settle();
  const sources=selectableSources(); sources[1].selected=false; sources[1].enabled=false;
  sources[3].selected=false; sources[3].enabled=false;
  p.run(`lookup.sources=${JSON.stringify(sources)}; openSettings()`);
  const html=p.nodes.get('#settings-content').innerHTML;
  assert.match(html,/data-source-toggle="itunes" checked/);
  assert.match(html,/data-source-toggle="lastfm" checked/,'No key does not change the source preference');
  assert.doesNotMatch(html,/data-source-toggle="deezer" checked/);
  assert.doesNotMatch(html,/data-source-toggle="discogs" checked/);
  assert.match(html,/data-clear-key="discogs_token"/,'Disabling preserves the saved key and its Remove control');
  assert.match(html,/Saved · type to replace/);
  assert.match(html,/separate switches above/);
  const before=p.requests.length;
  await p.emitDocument('change',{target:{dataset:{sourceToggle:'itunes'},checked:false,closest:()=>null,matches:()=>false}});
  assert.equal(p.requests.length,before,'Changing a checkbox is a draft until Save');
});

test('saving and reenabling sources uses the settings POST, preserving playback and editor draft', async () => {
  const p=page(); await settle();
  p.run(`lookup.sources=${JSON.stringify(selectableSources())}; lookup.auto=false; playTracks(state.details.get("1"));`);
  await p.run('openEditor(["1"])');
  p.run('editing.dirty.add("name")');
  const before=p.run('JSON.stringify({editing,queue:player.queue,src:audio.src,history:state.history})');
  const bodies=[];
  p.setFetch((url,options)=>{
    assert.equal(url,'/api/settings'); const body=JSON.parse(options.body); bodies.push(body);
    return {ok:true,json:async()=>({sources:selectableSources().map(s=>({...s,selected:!body.disabled_sources.includes(s.name),enabled:s.available&&!body.disabled_sources.includes(s.name)})),auto_lookup:false,auto_updates:false})};
  });
  for (const disabled of [['deezer','itunes','discogs'],[]]) {
    await p.run(`saveSettings({elements:{auto_lookup:{checked:false},auto_updates:{checked:false}},querySelectorAll:selector=>selector==='[data-source-toggle]'?lookup.sources.map(s=>({dataset:{sourceToggle:s.name},checked:!${JSON.stringify(disabled)}.includes(s.name)})):[]})`);
    assert.deepEqual(bodies.at(-1).disabled_sources,disabled);
    assert.equal(p.run('lookup.sources.find(s=>s.name==="deezer").selected'),!disabled.length);
  }
  assert.equal(p.run('JSON.stringify({editing,queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('automatic and manual suggestions skip disabled sources, distinguish missing keys and handle all-off', async () => {
  const p=page(); await settle();
  const sources=selectableSources().map(s=>({...s,selected:!['deezer','itunes'].includes(s.name),enabled:s.enabled&&!['deezer','itunes'].includes(s.name)}));
  p.run(`lookup.sources=${JSON.stringify(sources)}; lookup.auto=true; renderSource=()=>{}`);
  p.setFetch(()=>({ok:true,json:async()=>({candidates:[]})}));
  const first=p.requests.length;
  p.run('startLookups({artist:"Artist",name:"Album"})'); await settle();
  const names=()=>p.requests.slice(first).map(r=>new URL(r.url,'http://localhost').searchParams.get('source'));
  assert.deepEqual(names().sort(),['discogs','musicbrainz']);
  let html=p.nodes.get('#lookup-results').innerHTML;
  assert.match(html,/Last\.fm needs a key/); assert.doesNotMatch(html,/Deezer|iTunes/);
  p.run('runLookups("Artist","Album")'); await settle();
  assert.deepEqual(names().sort(),['discogs','discogs','musicbrainz','musicbrainz']);
  const count=p.requests.length;
  p.run('applyLookupSources(lookup.sources.map(s=>({...s,enabled:false,selected:false}))); runLookups("Artist","Album")');
  assert.equal(p.requests.length,count);
  html=p.nodes.get('#lookup-results').innerHTML;
  assert.match(html,/switched off/); assert.doesNotMatch(html,/needs? a key/);
});

test('source preference changes reject late album and artwork suggestions and reenabling allows fresh lookups', async () => {
  const p=page(); await settle();
  const sources=selectableSources().filter(s=>s.name==='deezer');
  p.run(`lookup.sources=${JSON.stringify(sources)}; let received=[]`);
  const pending=[];
  p.setFetch(()=>new Promise(resolve=>pending.push(resolve)));
  p.run('fetchSuggestions("album",{artist:"Artist",album:"Album"},s=>received.push(s.name),"album"); fetchSuggestions("artist",{name:"Artist"},s=>received.push(s.name),"artwork")');
  assert.equal(pending.length,2);
  p.run('lookup.results.set("deezer",[{cover:"https://example.test/old",score:1}]); applyLookupSources(lookup.sources.map(s=>({...s,selected:false,enabled:false})))');
  for(const resolve of pending) resolve({ok:true,json:async()=>({candidates:[{title:'Late'}]})});
  await settle(); assert.deepEqual(p.json('received'),[]); assert.equal(p.run('coverChoices().length'),0);
  const count=p.requests.length;
  p.run('fetchSuggestions("artist",{name:"Artist"},s=>received.push(s.name),"artwork")');
  assert.equal(p.requests.length,count);
  p.setFetch(()=>({ok:true,json:async()=>({candidates:[]})}));
  p.run('applyLookupSources(lookup.sources.map(s=>({...s,selected:true,enabled:true}))); fetchSuggestions("artist",{name:"Artist"},s=>received.push(s.name),"artwork")');
  await settle(); assert.deepEqual(p.json('received'),['deezer']);
});

test('selected album trash shows activity through its POST, stop request and read-back, then clears it', async () => {
  const p=livePage(); await settle();
  p.run('state.connection.connected=true; playTracks(state.details.get("1")); state.selected=new Set(["1"])');
  await p.run('reviewSelectedAlbumTrash()');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src})');
  const albums=p.json('state.albums'), rows=p.json('selectedAlbumsTrash.groups.flatMap(g=>g.discs.flatMap(d=>d.tracks.map(t=>({kind:"track",id:t.id,status:"saved"}))))');
  let send,read; const calls=[];
  p.setFetch((url,options)=>{
    calls.push(url); return new Promise(resolve=>{if(options?.body) send=resolve; else read=resolve;});
  });
  const work=p.run('trashSelectedAlbums()'); await settle();
  const status=p.nodes.get('#selected-trash-status');
  assert.equal(status.getAttribute('data-working'),'true');
  assert.equal(status.getAttribute('role'),'status');
  assert.match(status.textContent,/Checking and moving batch 1 of 1/);
  await p.nodes.get('#trash-review').emit('click',{target:{closest:s=>s==='#selected-trash-stop'?{}:null}});
  assert.match(status.textContent,/Stopping/); assert.equal(status.getAttribute('data-working'),'true');
  send({ok:true,json:async()=>({job:'visible-trash',results:rows})}); await settle();
  assert.match(status.textContent,/Verifying batch 1 of 1/);
  assert.equal(p.nodes.get('#mode-badge').getAttribute('data-working'),'true');
  p.flushTimers(2000); await settle();
  assert.equal(status.getAttribute('data-working'),'true','Polling is still part of the operation');
  read({ok:true,json:async()=>({state:'done',results:rows,albums})}); await work;
  assert.equal(status.getAttribute('data-working'),'false');
  assert.equal(p.nodes.get('#mode-badge').getAttribute('data-working'),'false');
  assert.match(status.textContent,/confirmed/);
  assert.deepEqual(calls,['/api/trash/albums','/api/jobs/visible-trash']);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src})'),before);
});

test('operation status stops on failed trash and resets with library replacement without extra writes', async () => {
  const p=livePage(); await settle();
  p.run('state.selected=new Set(["1"])'); await p.run('reviewSelectedAlbumTrash()');
  let reject; p.setFetch(()=>new Promise((_,fail)=>{reject=fail;}));
  const work=p.run('trashSelectedAlbums()'); await settle();
  const status=p.nodes.get('#selected-trash-status');
  assert.equal(status.getAttribute('data-working'),'true');
  reject(Error('Connection unavailable')); await work;
  assert.equal(status.getAttribute('data-working'),'false'); assert.match(status.textContent,/Connection unavailable/);
  p.run('setActionStatus("#selected-trash-status","Old request",true); resetSelectedAlbumTrash()');
  assert.equal(status.getAttribute('data-working'),'false'); assert.equal(status.textContent,'');
  assert.equal(p.requests.filter(r=>r.url==='/api/trash/albums').length,1);
});

test('Cleanup running reports animate while completed reports and CSV errors remain still', async () => {
  const p=page(); await settle();
  p.run(`cleanupView.data={id:"draft",state:"running",category:"genres",albums:0,tracks:0,groups:[],counts:{confirmed:3,pending:4}}; renderCleanup()`);
  assert.match(p.nodes.get('#cleanup-content').innerHTML,/class="operation-status" data-working="true"/);
  p.run('cleanupView.data.state="done"; renderCleanup()');
  assert.doesNotMatch(p.nodes.get('#cleanup-content').innerHTML,/data-working="true"/);
  p.run('csvImportWorking(true,"Matching against the loaded library…")');
  const status=p.nodes.get('#csv-import-status'); assert.equal(status.getAttribute('data-working'),'true');
  p.run('csvImportWorking(false,"Unable to match")');
  assert.equal(status.getAttribute('data-working'),'false'); assert.equal(status.textContent,'Unable to match');
  p.run('setActionStatus("#cleanup-status","Still checking",true); resetCleanup()');
  assert.equal(p.nodes.get('#cleanup-status').getAttribute('data-working'),'false');
});

test('compact progress respects reduced motion and remains separate from full library loading', async () => {
  const p=livePage(); await settle();
  p.run('state.connection.connected=true; checking=1; updateChrome()');
  assert.equal(p.nodes.get('#mode-badge').getAttribute('data-working'),'true');
  assert.equal(p.nodes.get('#library-loading').hidden,true);
  p.run('state.loading=true; updateChrome()');
  assert.equal(p.nodes.get('#mode-badge').getAttribute('data-working'),'false');
  assert.equal(p.nodes.get('#library-loading').hidden,false);
  p.run('state.loading=false; state.connection.connected=false; updateChrome()');
  assert.equal(p.nodes.get('#mode-badge').getAttribute('data-working'),'false');
  p.run('state.mode="demo"; updateChrome()');
  assert.equal(p.nodes.get('#mode-badge').getAttribute('data-working'),'false');
  const css=readFileSync(path.join(staticDir,'style.css'),'utf8');
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.operation-status\[data-working="true"\]::before,[\s\S]*?animation:none/);
});

test('opening an album restores only saved lyrics locally, without track requests or playback', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="restored-session";');
  p.setLyricsCacheFetch(()=>({ok:true,json:async()=>({tracks:[{
    selection:p.json('lyricsSelection(state.details.get("1").tracks[0])'),
    data:{status:'ready',source:'ibroadcast',text:'Saved preview verse',native_text:'Saved preview verse',can_save:true,persisted:true}
  }]})}));
  await p.run('openAlbum("1")'); await settle();
  p.run('renderAlbumView()');
  assert.match(p.nodes.get('#album-page').innerHTML,/data-lyrics-view="100"/);
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/lyrics/cache?')).length,1);
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/lyrics?')).length,0);
  assert.equal(p.run('player.queue.length'),0);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('late disk-cache results cannot replace newer native text or a different library', async () => {
  for (const replace of [false,true]) {
    const p=page(); await settle();
    p.run('state.mode="live"; state.connection.playback_session="restored-session";');
    let release;
    p.setLyricsCacheFetch(()=>new Promise(resolve=>{release=resolve;}));
    await p.run('openAlbum("1")');
    const selection=p.json('lyricsSelection(state.details.get("1").tracks[0])');
    if (replace) p.run('state.details=new Map(state.details); resetTrackLyrics()');
    else p.run('lyricsEntry(lyricsSelection(state.details.get("1").tracks[0])).data={status:"ready",source:"ibroadcast",text:"Fresh text"}');
    release({ok:true,json:async()=>({tracks:[{selection,data:{status:'ready',source:'ibroadcast',text:'Old text',persisted:true}}]})});
    await settle();
    assert.equal(p.run('trackLyrics.entries.size'),replace?0:1);
    if (!replace) assert.equal(p.run('[...trackLyrics.entries.values()][0].data.text'),'Fresh text');
  }
});

test('revisiting an album restores saved labels after the bounded memory cache evicts them', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="restored-session";');
  const selection=p.json('lyricsSelection(state.details.get("1").tracks[0])');
  p.setLyricsCacheFetch(()=>({ok:true,json:async()=>({tracks:[{selection,
    data:{status:'ready',source:'ibroadcast',text:'Saved preview verse',persisted:true}
  }]})}));
  await p.run('openAlbum("1")'); await settle();
  p.run('for(let i=0;i<100;i++) lyricsEntry({track_id:String(1000+i),title:"Other",artist:"Artist",session:"restored-session"}); showScreen("albums")');
  assert.equal(p.run('knownTrackLyrics(state.details.get("1").tracks[0])'),null);
  await p.run('openAlbum("1")'); await settle();
  assert.equal(p.run('knownTrackLyrics(state.details.get("1").tracks[0]).text'),'Saved preview verse');
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/lyrics/cache?')).length,2);
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/lyrics?')).length,0);
});

test('changing lyrics sources during a read starts a fresh read and keeps late completion separate', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session"; playTracks(state.details.get("1"));');
  const pending=[];
  p.setFetch(()=>new Promise(resolve=>pending.push(resolve)));
  p.run('setNowPlaying(true); lyricsEntry(visibleLyricsSelection("player")).draft="Keep my draft"; invalidateLyricsSource()');
  assert.equal(pending.length,2);
  const reply=text=>({ok:true,json:async()=>({status:'ready',source:'ibroadcast',text,native_text:text,can_save:true,can_lookup:false})});
  pending[0](reply('Old source result')); await settle();
  assert.equal(p.run('lyricsEntry(visibleLyricsSelection("player")).loading'),true);
  p.run('loadTrackLyrics(visibleLyricsSelection("player"),lyricsEntry(visibleLyricsSelection("player")))');
  assert.equal(pending.length,2,'The current request remains coalesced after an old request finishes');
  pending[1](reply('Current result')); await settle();
  assert.equal(p.run('lyricsEntry(visibleLyricsSelection("player")).data.text'),'Current result');
  assert.equal(p.run('lyricsEntry(visibleLyricsSelection("player")).draft'),'Keep my draft');
});

test('reviewing disk-cached lyrics first checks current native text and preserves a changed draft', async () => {
  for (const changed of [false,true]) {
    const p=page(); await settle();
    p.run('state.mode="live"; state.connection.premium=true; state.connection.playback_session="restored-session"; editing={originals:[state.details.get("1")],trackPatches:{},dirty:new Set()}; const CSS={escape:value=>String(value)}; $("#track-inline").scrollIntoView=()=>{}; $("#editor").showModal(); const restoredSelection=lyricsSelection(editing.originals[0].tracks[0]); const restoredEntry=lyricsEntry(restoredSelection); restoredEntry.data={status:"ready",source:"ibroadcast",text:"Saved verse",native_text:"Saved verse",persisted:true,can_save:true}; restoredEntry.draft="My edited verse"; editTrack(String(editing.originals[0].tracks[0].id))');
    p.setFetch((url,options)=>{
      if (url.startsWith('/api/lyrics?')) {
        assert.match(url,/refresh=1/);
        return {ok:true,json:async()=>({status:'ready',source:'ibroadcast',native_text:changed?'Changed elsewhere':'Saved verse',text:'Current verse',can_save:true,before_token:'fresh-token'})};
      }
      assert.equal(url,'/api/lyrics/review');
      assert.equal(JSON.parse(options.body).before_token,'fresh-token');
      assert.equal(JSON.parse(options.body).lyrics,'My edited verse');
      return {ok:true,json:async()=>({id:'new-review',title:'Preview',before:'Saved verse',after:'My edited verse'})};
    });
    await p.run('reviewTrackLyrics(restoredSelection,restoredEntry)');
    assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/review').length,changed?0:1);
    assert.equal(p.run('restoredEntry.draft'),'My edited verse');
    if (changed) assert.match(p.nodes.get('#track-lyrics').innerHTML,/changed since the saved cache/);
    assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,0);
  }
});

test('album lyrics check starts explicitly, runs serially and keeps results until invalidation or explicit refresh', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="album-lyrics-session"; playTracks(state.details.get("1"));');
  await p.run('openAlbum("1")'); await settle();
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,index:player.index,history:history.length})');
  const total=p.run('state.details.get("1").tracks.length');
  const trigger=p.run('document.querySelector("[data-album-more]")');
  await p.click({'[data-album-more]':trigger});
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,0);
  assert.equal(p.run('document.activeElement')===p.nodes.get('#album-action-lyrics'),true);
  await p.nodes.get('#album-action-menu').emit('keydown',{key:'ArrowDown',preventDefault(){}});
  assert.equal(p.run('document.activeElement')===p.nodes.get('#album-action-lyrics-import'),true);
  await p.nodes.get('#album-action-menu').emit('keydown',{key:'ArrowDown',preventDefault(){}});
  assert.equal(p.run('document.activeElement')===p.nodes.get('#album-action-trash'),true);
  await p.nodes.get('#album-action-menu').emit('keydown',{key:'Home',preventDefault(){}});
  assert.equal(p.run('document.activeElement')===p.nodes.get('#album-action-lyrics'),true);
  let active=0,maxActive=0;
  p.setFetch(async url=>{
    assert.match(url,/^\/api\/lyrics\?/); assert.match(url,/refresh=[01]/);
    maxActive=Math.max(maxActive,++active);
    await new Promise(resolve=>setImmediate(resolve)); active--;
    const ready=new URL('http://test'+url).searchParams.get('track_id')==='100';
    return {ok:true,json:async()=>({status:ready?'ready':'not_cached',source:'ibroadcast',text:ready?'Album preview verse':'',can_lookup:!ready,can_save:false})};
  });
  await p.nodes.get('#album-action-lyrics').emit('click');
  for (let i=0;i<=total;i++) await settle();
  assert.equal(maxActive,1);
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,total);
  assert.equal(p.run('albumLyricsCheck.found'),1);
  assert.match(p.nodes.get('#album-lyrics-status').textContent,/Lyrics available for 1/);
  assert.equal(p.nodes.get('#album-lyrics-stop').hidden,true);
  const count=p.requests.length;
  await p.run('checkAlbumLyrics()');
  assert.equal(p.requests.length,count);
  p.setPlaybackClock(30*86400000);
  await p.run('checkAlbumLyrics()');
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,total,'Positive and empty results do not expire on a timer');
  await p.run('loadTrackLyrics(lyricsSelection(state.details.get("1").tracks[0]),lyricsEntry(lyricsSelection(state.details.get("1").tracks[0])),false,true)');
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,total+1,'Explicit per-track refresh still fetches fresh native text');
  await p.run('checkAlbumLyrics()');
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,total+1);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,index:player.index,history:history.length})'),before);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  p.run('showScreen("playlists")');
  await p.run('checkAlbumLyrics()');
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,total+1,'There is no playlist check');
});

test('album lyrics checking stops on navigation, explicit Stop, errors and replacement without continuing requests', async () => {
  for (const action of ['navigation','stop','replacement','error']) {
    const p=page(); await settle();
    p.run('state.mode="live"; state.connection.playback_session="album-lyrics-session";');
    await p.run('openAlbum("1")'); await settle();
    let release;
    p.setFetch(url=>url.startsWith('/api/lyrics')?new Promise(resolve=>{release=resolve;})
      :{ok:true,json:async()=>({playlists:[],count:0})});
    const work=p.run('checkAlbumLyrics()');
    assert.equal(p.run('albumLyricsCheck.running'),true);
    assert.match(p.nodes.get('#album-lyrics-status').textContent,/0 of/);
    if (action==='navigation') p.run('showScreen("playlists")');
    if (action==='stop') await p.click({'#album-lyrics-stop':{}});
    if (action==='replacement') p.run('state.details=new Map(state.details); resetTrackLyrics()');
    release(action==='error'?{ok:false,status:503,json:async()=>({error:'Temporary error'})}
      :{ok:true,json:async()=>({status:'ready',source:'ibroadcast',text:'Preview verse'})});
    await work; await settle();
    assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,1,action);
    if (action==='error') assert.match(p.nodes.get('#album-lyrics-status').textContent,/stopped.*Temporary error/i);
    if (action==='stop') assert.match(p.nodes.get('#album-lyrics-status').textContent,/Stopped after/);
    if (action==='replacement') assert.equal(p.run('trackLyrics.entries.size'),0);
  }
});

test('album checking coalesces an open track read and never exceeds the existing 100-track cache bound', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="album-lyrics-session"; playTracks(state.details.get("1"));');
  await p.run('openAlbum("1")'); await settle();
  let release;
  p.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  const work=p.run('checkAlbumLyrics()');
  p.run('setNowPlaying(true)'); await settle();
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,1);
  p.run('stopAlbumLyricsCheck()');
  release({ok:true,json:async()=>({status:'ready',source:'ibroadcast',text:'Preview verse'})});
  await work; await settle();
  assert.match(p.nodes.get('#now-playing-lyrics').innerHTML,/Preview verse/);
  p.run('setNowPlaying(false); state.details.get("1").tracks=Array.from({length:101},(_,i)=>({id:String(1000+i),title:"Preview "+i,artist:"Preview"}));');
  await p.run('checkAlbumLyrics()');
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,1);
  assert.match(p.nodes.get('#toast').textContent,/up to 100 tracks/);
});

test('album Lyrics labels reuse known text and open a read-only dialog without requests or playback', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session"; playTracks(state.details.get("1"));');
  await p.run('openAlbum("1")'); await settle();
  assert.doesNotMatch(p.nodes.get('#album-page').innerHTML,/data-lyrics-view=/);
  assert.equal(p.run('trackLyrics.entries.size'),0);
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,0);
  p.setFetch(()=>({ok:true,json:async()=>({status:'ready',source:'ibroadcast',text:'<b>Preview verse</b>\nNext line',native_text:'Preview verse',can_save:true,can_lookup:false})}));
  p.run('setNowPlaying(true)'); await settle();
  p.run('setNowPlaying(false); renderAlbumView()');
  assert.match(p.nodes.get('#album-page').innerHTML,/data-lyrics-view="100"[^>]*title="Lyrics saved in iBroadcast"/);
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,index:player.index,paused:audio.paused,time:audio.currentTime,history:history.length})');
  const reads=p.requests.length;
  const trigger={dataset:{lyricsView:'100'},isConnected:true,focus(){this.focused=true;}};
  await p.click({'[data-lyrics-view]':trigger});
  assert.equal(p.nodes.get('#lyrics-viewer').open,true);
  assert.match(p.nodes.get('#lyrics-viewer-content').innerHTML,/&lt;b&gt;Preview verse&lt;\/b&gt;\nNext line/);
  assert.doesNotMatch(p.nodes.get('#lyrics-viewer-content').innerHTML,/<b>|textarea|data-play|data-lyrics-action/);
  assert.equal(p.run('currentHelpContext()'),'lyrics-viewer');
  await p.nodes.get('#lyrics-viewer').emit('cancel',{preventDefault(){}});
  assert.equal(p.nodes.get('#lyrics-viewer').open,false);
  assert.equal(trigger.focused,true);
  assert.equal(p.requests.length,reads);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,index:player.index,paused:audio.paused,time:audio.currentTime,history:history.length})'),before);
});

test('Lyrics labels update in place and reject missing, stale, disabled-source or replaced-library text', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session";');
  await p.run('openAlbum("1")'); await settle();
  const slot={dataset:{lyricsLabel:'100'},innerHTML:'',hidden:true};
  p.nodes.get('#album-page').querySelectorAll=selector=>selector==='[data-lyrics-label]'?[slot]:[];
  const albumHTML=p.nodes.get('#album-page').innerHTML;
  p.run('const badgeSelection=lyricsSelection(state.details.get("1").tracks[0]); const badgeEntry=lyricsEntry(badgeSelection); badgeEntry.data={status:"ready",source:"lrclib",text:"Public preview"}; refreshAlbumLyricsLabels()');
  assert.equal(slot.hidden,false);
  assert.match(slot.innerHTML,/Lyrics available from LRCLIB/);
  assert.equal(p.nodes.get('#album-page').innerHTML,albumHTML,'Only the label changes, not album controls or focus');
  await p.click({'[data-lyrics-view]':{dataset:{lyricsView:'100'}}});
  assert.match(p.nodes.get('#lyrics-viewer-content').innerHTML,/https:\/\/lrclib.net\/|Public preview/);
  p.run('showScreen("albums")');
  assert.equal(p.nodes.get('#lyrics-viewer').open,false);
  await p.run('openAlbum("1")');
  for (const status of ['missing','instrumental','not_cached']) {
    p.run(`badgeEntry.data.status=${JSON.stringify(status)}; refreshAlbumLyricsLabels()`);
    assert.equal(slot.hidden,true);
  }
  p.run('badgeEntry.data.status="ready"; state.connection.playback_session="other-session"; refreshAlbumLyricsLabels()');
  assert.equal(slot.hidden,true);
  await p.click({'[data-lyrics-view]':{dataset:{lyricsView:'100'}}});
  assert.equal(p.nodes.get('#lyrics-viewer').open,false);
  p.run('state.connection.playback_session="lyrics-session"; refreshAlbumLyricsLabels()');
  assert.equal(slot.hidden,false);
  p.run('invalidateLyricsSource()');
  assert.equal(slot.hidden,true);
  p.run('badgeEntry.data={status:"ready",source:"ibroadcast",text:"Old library"}; state.details=new Map(state.details); refreshAlbumLyricsLabels()');
  assert.equal(slot.hidden,true);
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,0);
});

test('free accounts can read native and public lyrics but have no lyrics editing or Premium quality controls', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.premium=false; state.connection.playback_session="lyrics-session"; editing={originals:[state.details.get("1")],trackPatches:{},dirty:new Set()}; const CSS={escape:value=>String(value)}; $("#track-inline").scrollIntoView=()=>{}; $("#editor").showModal();');
  let response={status:'ready',source:'ibroadcast',text:'Stored preview',native_text:'Stored preview',can_save:false,can_lookup:false};
  p.setFetch(()=>({ok:true,json:async()=>response}));
  p.run('editTrack(String(editing.originals[0].tracks[0].id))'); await settle();
  assert.match(p.nodes.get('#track-lyrics').innerHTML,/Stored preview/);
  assert.doesNotMatch(p.nodes.get('#track-lyrics').innerHTML,/textarea|Review lyrics|Use these lyrics|Save lyrics|Premium/);
  response={status:'not_cached',source:'ibroadcast',text:'',native_text:'',can_save:false,can_lookup:true};
  await p.run('loadTrackLyrics(visibleLyricsSelection("track"),lyricsEntry(visibleLyricsSelection("track")))');
  assert.match(p.nodes.get('#track-lyrics').innerHTML,/Find lyrics on LRCLIB/);
  response={status:'ready',source:'lrclib',text:'Public preview',native_text:'',can_save:false,can_lookup:false};
  await p.run('loadTrackLyrics(visibleLyricsSelection("track"),lyricsEntry(visibleLyricsSelection("track")),true)');
  assert.match(p.nodes.get('#track-lyrics').innerHTML,/Public preview|LRCLIB/);
  assert.doesNotMatch(p.nodes.get('#track-lyrics').innerHTML,/textarea|Review lyrics|Use these lyrics/);
  p.run('lyricsEntry(visibleLyricsSelection("track")).data.can_save=true; renderLyrics("track")');
  await p.run('reviewTrackLyrics(visibleLyricsSelection("track"),lyricsEntry(visibleLyricsSelection("track")))');
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/review').length,0,'Known free account overrides old cached capability');
  p.run('lookup.sources=[{name:"lrclib",enabled:true,selected:true}]; lookup.streamQuality="orig"; openSettings()');
  assert.match(p.nodes.get('#settings-content').innerHTML,/MP3 128 kbps/);
  assert.doesNotMatch(p.nodes.get('#settings-content').innerHTML,/name="stream_quality"|Original file \(Premium\)|MP3 320/);
  assert.equal(p.run('lookup.streamQuality'),'orig','Opening settings does not rewrite a saved preference');
  p.run('state.connection.premium=true; openSettings(); renderLyrics("track")');
  assert.match(p.nodes.get('#settings-content').innerHTML,/name="stream_quality"|Original file \(Premium\)/);
  assert.match(p.nodes.get('#track-lyrics').innerHTML,/textarea|Review lyrics/);
});

test('Now playing reads native lyrics lazily, escapes text and leaves audio and queue intact', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session"; playTracks(state.details.get("1"));');
  assert.equal(p.requests.filter(r=>(r.url.startsWith('/api/lyrics?')||r.url==='/api/lyrics')).length,0);
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,index:player.index})');
  p.setFetch(()=>({ok:true,json:async()=>({status:'ready',source:'ibroadcast',text:'<script>Verse</script>\nNext',native_text:'Verse',can_save:true,can_lookup:false,before_token:'before'})}));
  p.run('setNowPlaying(true)'); await settle();
  const html=p.nodes.get('#now-playing-lyrics').innerHTML;
  assert.match(html,/&lt;script&gt;Verse&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>|Find lyrics/);
  assert.match(html,/<summary>iBroadcast<\/summary>/);
  p.run('renderNowPlaying()'); await settle();
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/lyrics?')).length,1);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,index:player.index})'),before);
});

test('LRCLIB lookup is explicit and a late reply cannot fill a replacement library', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session"; playTracks(state.details.get("1"));');
  p.setFetch(()=>({ok:true,json:async()=>({status:'not_cached',source:'ibroadcast',native_text:'',text:'',can_save:true,can_lookup:true,before_token:'before'})}));
  p.run('setNowPlaying(true)'); await settle();
  assert.match(p.nodes.get('#now-playing-lyrics').innerHTML,/Find lyrics on LRCLIB/);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  p.setFetch(()=>({ok:true,json:async()=>({status:'ready',source:'lrclib',text:'Public verse',native_text:'',can_save:true,can_lookup:false,before_token:'before'})}));
  await p.run('loadTrackLyrics(visibleLyricsSelection("player"), lyricsEntry(visibleLyricsSelection("player")), true)');
  assert.match(p.nodes.get('#now-playing-lyrics').innerHTML,/Public verse|LRCLIB/);
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics').length,1);
  let release;
  p.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  p.run('loadTrackLyrics(visibleLyricsSelection("player"), lyricsEntry(visibleLyricsSelection("player")), true)');
  const html=p.nodes.get('#now-playing-lyrics').innerHTML;
  p.run('state.details=new Map(); resetTrackLyrics()');
  release({ok:true,json:async()=>({status:'ready',source:'lrclib',text:'Stale verse'})}); await settle();
  assert.equal(p.nodes.get('#now-playing-lyrics').innerHTML,html);
  assert.equal(p.run('trackLyrics.entries.size'),0);
});

test('track lyrics use a separate editable field and explicit review, without normal metadata patches', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session"; editing={originals:[state.details.get("1")],trackPatches:{},dirty:new Set()}; const CSS={escape:value=>String(value)}; $("#track-inline").scrollIntoView=()=>{}; $("#editor").showModal();');
  p.setFetch((url)=>({ok:true,json:async()=>url==='/api/lyrics/review'
    ? {id:'lyrics-review-id',title:'Track',before:'Old verse',after:'New verse'}
    : {status:'ready',source:'ibroadcast',text:'Old verse',native_text:'Old verse',can_save:true,can_lookup:false,before_token:'before'}}));
  p.run('editTrack(String(editing.originals[0].tracks[0].id))'); await settle();
  const html=p.nodes.get('#track-lyrics').innerHTML;
  assert.match(html,/textarea id="track-lyrics-text"/);
  assert.match(html,/Old verse/);
  assert.doesNotMatch(html,/data-key="lyrics"/);
  p.run('lyricsEntry(visibleLyricsSelection("track")).draft="New verse"');
  const beforeClick=p.nodes.get('#track-inline').innerHTML;
  p.run('let lyricsReopened=0; const lyricsOriginalEdit=editTrack; editTrack=()=>{lyricsReopened+=1;}');
  await p.click({'[data-track]':p.nodes.get('#track-inline')});
  assert.equal(p.run('lyricsReopened'),0);
  p.run('editTrack=lyricsOriginalEdit');
  assert.equal(p.nodes.get('#track-inline').innerHTML,beforeClick,'Clicks inside the track pane must not reopen the editor');
  await p.run('reviewTrackLyrics(visibleLyricsSelection("track"), lyricsEntry(visibleLyricsSelection("track")))');
  assert.equal(p.nodes.get('#lyrics-review').open,true);
  assert.match(p.nodes.get('#lyrics-review-content').innerHTML,/Old verse|New verse/);
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,0);
  p.setFetch(()=>({ok:true,json:async()=>({status:'saved'})}));
  await p.run('saveTrackLyrics()'); await settle();
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,1);
  assert.deepEqual(p.json('editing.trackPatches'),{});
  assert.equal(p.run('trackLyrics.busy'),false);
});

test('changing the lyrics source invalidates public results while preserving a typed native draft', async () => {
  const p=page(); await settle();
  p.run('state.mode="live"; state.connection.playback_session="lyrics-session"; playTracks(state.details.get("1"));');
  p.setFetch(()=>({ok:true,json:async()=>({status:'not_cached',source:'ibroadcast',native_text:'',text:'',can_save:true,can_lookup:false,before_token:'before'})}));
  p.run('setNowPlaying(true)'); await settle();
  p.run('lyricsEntry(visibleLyricsSelection("player")).draft="Keep typed lyrics"; lookup.sources=[{name:"lrclib",enabled:true,selected:true}]; applyLookupSources([{name:"lrclib",enabled:false,selected:false}]);');
  await settle();
  assert.equal(p.run('lyricsEntry(visibleLyricsSelection("player")).draft'),'Keep typed lyrics');
  assert.doesNotMatch(p.nodes.get('#now-playing-lyrics').innerHTML,/Find lyrics on LRCLIB/);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('editor tabs keep both drafts in one review without requests, playback or history changes', async () => {
  const p=page(); await settle();
  await p.run('openEditor([state.albums[0].id])');
  const html=p.nodes.get('#editor-content').innerHTML;
  assert.match(html,/id="editor-tabs"[^>]*role="tablist"/);
  assert.match(html,/id="editor-tracks-panel"[^>]*hidden/);
  assert.equal(p.nodes.get('#editor-album-panel').hidden,false);
  assert.equal(p.nodes.get('#editor-tracks-panel').hidden,true);
  const input={value:'Changed album title',type:'text',disabled:false};
  p.nodes.get('#metadata-form').elements={namedItem:key=>key==='name'?input:null};
  p.run('$("#track-inline")');
  const pane=p.nodes.get('#track-inline');
  pane.dataset.track=p.run('String(editing.originals[0].tracks[0].id)');
  const trackInput={value:'Changed track title',type:'text',dataset:{key:'title'}};
  pane.querySelectorAll=selector=>selector==='input[data-key]'?[trackInput]:[];
  pane.innerHTML='Keep the existing track form';
  p.run('editing.dirty.add("name")');
  const requests=p.requests.length, history=p.history.length;
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src})');
  await p.click({'[data-editor-tab]':{dataset:{editorTab:'tracks'}}});
  assert.equal(p.run('editing.tab'),'tracks');
  assert.equal(p.nodes.get('#editor-album-panel').hidden,true);
  assert.equal(p.nodes.get('#editor-tracks-panel').hidden,false);
  assert.equal(p.nodes.get('#editor-layout').classList.contains('editing-tracks'),true);
  await p.click({'[data-editor-tab]':{dataset:{editorTab:'album'}}});
  assert.equal(pane.innerHTML,'Keep the existing track form');
  assert.equal(trackInput.value,'Changed track title');
  assert.equal(input.value,'Changed album title');
  assert.equal(p.requests.length,requests);
  assert.equal(p.history.length,history);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src})'),before);
  p.run('buildReview()');
  assert.equal(p.run('pending.changes.length'),2);
  assert.equal(p.run('pending.changes.find(c=>c.kind==="album").fields.name.after'),'Changed album title');
  assert.equal(p.run('pending.changes.find(c=>c.kind==="track").fields.title.after'),'Changed track title');
});

test('editor tabs support keyboard focus and reveal the correct panel for invalid fields', async () => {
  const p=page(); await settle(); await p.run('openEditor([state.albums[0].id])');
  const key=async(key,tab)=>p.emitDocument('keydown',{key,target:{closest:selector=>selector==='#editor-tabs [data-editor-tab]'?{dataset:{editorTab:tab}}:null},preventDefault(){}});
  await key('ArrowRight','album');
  assert.equal(p.run('editing.tab'),'tracks');
  assert.equal(p.nodes.get('#editor-tab-tracks').getAttribute('aria-selected'),'true');
  assert.equal(p.nodes.get('#editor-tab-tracks').getAttribute('tabindex'),'0');
  assert.equal(p.nodes.get('#editor-tab-album').getAttribute('tabindex'),'-1');
  assert.equal(p.run('document.activeElement === $("#editor-tab-tracks")'),true);
  assert.equal(p.run('currentHelpContext()'),'editing-tracks');
  await key('Home','tracks'); assert.equal(p.run('editing.tab'),'album');
  await key('End','album'); assert.equal(p.run('editing.tab'),'tracks');
  const form=p.nodes.get('#metadata-form');
  form.checkValidity=()=>false; form.reportValidity=()=>false;
  form.querySelector=selector=>selector===':invalid'?{closest:()=>null}:null;
  p.run('buildReview()'); assert.equal(p.run('editing.tab'),'album');
  const pane=p.nodes.get('#track-inline');
  pane.dataset.track=p.run('String(editing.originals[0].tracks[0].id)');
  pane.querySelectorAll=()=>[{value:'',type:'text',dataset:{key:'title'}}];
  p.run('buildReview()'); assert.equal(p.run('editing.tab'),'tracks');
  assert.equal(p.run('pending'),null);
});

test('bulk artist editing keeps its existing shared fields without individual track tabs', async () => {
  const p=page(); await settle();
  p.run('setArtist(state.albums[0].artist)');
  const ids=p.json('state.albums.filter(a=>a.artist===state.artist).map(a=>a.id)');
  assert.ok(ids.length>1);
  await p.run(`openEditor(${JSON.stringify(ids)})`);
  assert.equal(p.run('editing.bulk'),true);
  assert.doesNotMatch(p.nodes.get('#editor-content').innerHTML,/id="editor-tabs"|id="editor-tracks-panel"/);
  assert.match(p.nodes.get('#editor-content').innerHTML,/Edit selected albums/);
});

async function playlistOrderPage({size=4,offset=0}={}) {
  const p=page(); await settle();
  const before=size===4?[100,101,100,99999]:Array.from({length:size},(_,i)=>100+i);
  const data={id:'81',name:'Order <example>',before_token:'review-token',before,
    tracks:before,rows:[],total:size,stored_total:size,offset,description:'Keep',duration:180};
  p.run(`state.mode="live"; state.connection.playback_session="order-session"; playTracks(state.details.get("1")); state.screen="playlists"; collectionsView.playlist="81"; collectionsView.data=${JSON.stringify(data)}; collectionsView.offset=${offset}`);
  p.setFetch((url)=>{
    if(url.startsWith('/api/playlist/order?')) {
      const positions=new URL(url,'http://localhost').searchParams.get('positions').split(',').map(Number);
      return {ok:true,json:async()=>({rows:positions.map(source=>({id:String(before[source]),source_position:source,
        available:source!==3,title:source===3?'Unavailable track':`Track <${source}>`,artist:'Preview artist'}))})};
    }
    if(url.startsWith('/api/playlists?')) return {ok:true,json:async()=>data};
    throw Error('Unexpected request '+url);
  });
  return {p,data};
}

test('playlist order is a separate local draft, preserving repeats, unavailable positions and playback on cancel', async()=>{
  const {p}=await playlistOrderPage();
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,before:collectionsView.data.before,history:state.history})');
  p.run('openPlaylistOrder()'); await settle();
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/Track &lt;0&gt;/);
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/Unavailable track/);
  assert.equal(p.nodes.get('#playlist-order-save').disabled,true);
  assert.equal(p.run('currentHelpContext()'),'playlist-order');
  p.run('movePlaylistOrder(0,2)'); await settle();
  assert.deepEqual(p.json('playlistOrder.draft.order'),[1,2,0,3]);
  assert.equal(p.nodes.get('#playlist-order-save').disabled,false);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  p.run('closePlaylistOrder()');
  assert.equal(p.nodes.get('#playlist-order').open,false);
  assert.equal(p.run('playlistOrder.draft'),null);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,before:collectionsView.data.before,history:state.history})'),before);
});

test('Move to position crosses bounded pages and keeps every original position exactly once', async()=>{
  const {p}=await playlistOrderPage({size:1200,offset:800});
  p.run('openPlaylistOrder()'); await settle();
  await p.click({'[data-order-move]':{dataset:{orderMove:'850'}}});
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/id="playlist-order-move"/);
  await p.emitDocument('submit',{target:{id:'playlist-order-move',elements:{position:{value:'10'}}},preventDefault(){}});
  await settle();
  assert.equal(p.run('playlistOrder.draft.order[9]'),850);
  assert.equal(p.run('playlistOrder.draft.offset'),0);
  assert.equal(p.run('new Set(playlistOrder.draft.order).size'),1200);
  assert.equal(p.run('playlistOrder.draft.rows.size'),100);
  assert.equal(p.run('collectionsView.data.before[850]'),950);
  const reads=p.requests.filter(r=>r.url.startsWith('/api/playlist/order?'));
  assert.equal(reads.length,2);
  for(const read of reads) assert.equal(new URL(read.url,'http://localhost').searchParams.get('positions').split(',').length,100);
  assert.match(p.nodes.get('#playlist-order-status').textContent,/position 10/);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  const order=p.run('JSON.stringify(playlistOrder.draft.order)');
  for(const position of [-1,0,1201,1.5]) {
    p.run('playlistOrder.draft.move=850');
    await p.emitDocument('submit',{target:{id:'playlist-order-move',elements:{position:{value:String(position)}}},preventDefault(){}});
    assert.equal(p.run('JSON.stringify(playlistOrder.draft.order)'),order);
  }
});

test('playlist handles support keyboard and drag insertion without accepting external drops', async()=>{
  const {p}=await playlistOrderPage(); p.run('openPlaylistOrder()'); await settle();
  const handle={dataset:{orderHandle:'0'}};
  const target={closest:selector=>selector==='[data-order-handle]'?handle:null};
  await p.emitDocument('keydown',{key:'ArrowDown',target,preventDefault(){}}); await settle();
  assert.deepEqual(p.json('playlistOrder.draft.order'),[1,0,2,3]);
  const row={dataset:{orderRow:'3'},getBoundingClientRect:()=>({top:100,height:40}),classList:{add(){},remove(){}}};
  const drop={target:{closest:selector=>selector==='[data-order-row]'?row:null},clientY:139,preventDefault(){},dataTransfer:{}};
  await p.emitDocument('drop',drop); assert.deepEqual(p.json('playlistOrder.draft.order'),[1,0,2,3]);
  await p.emitDocument('dragstart',{target,dataTransfer:{setData(){}}});
  await p.emitDocument('dragover',drop); await p.emitDocument('drop',drop); await settle();
  assert.deepEqual(p.json('playlistOrder.draft.order'),[1,2,3,0]);
  assert.equal(p.run('playlistOrder.drag'),null);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('playlist order saves once with positions only and waits for full confirmation without touching playback', async()=>{
  const {p,data}=await playlistOrderPage(); p.run('openPlaylistOrder()'); await settle();
  p.run('movePlaylistOrder(3,0)'); await settle();
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  let send,read; const bodies=[];
  p.setFetch((url,options)=>{
    if(url==='/api/playlist') { bodies.push(JSON.parse(options.body)); return new Promise(resolve=>send=resolve); }
    if(url==='/api/jobs/order-job') return new Promise(resolve=>read=resolve);
    if(url.startsWith('/api/playlists?')) return {ok:true,json:async()=>data};
    throw Error('Unexpected request '+url);
  });
  const saving=p.run('savePlaylistOrder()');
  p.run('savePlaylistOrder(); closePlaylistOrder()');
  assert.equal(bodies.length,1); assert.equal(p.nodes.get('#playlist-order').open,true);
  assert.deepEqual(bodies[0],{action:'reorder',playlist:'81',before_token:'review-token',before_name:'Order <example>',session:'order-session',positions:[3,0,1,2],approved:true});
  send({ok:true,json:async()=>({job:'order-job'})}); await settle();
  assert.match(p.nodes.get('#playlist-order-status').textContent,/Checking playlist order/);
  read({ok:true,json:async()=>({state:'done',results:[{id:'81',status:'saved'}]})}); await saving; await settle();
  assert.equal(p.nodes.get('#playlist-order').open,false);
  assert.equal(p.run('collectionsView.busy'),false);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('uncertain order saves cannot repeat and stale or cancelled page replies cannot restore drafts', async()=>{
  for(const kind of ['network','unverified']) {
    const {p}=await playlistOrderPage(); p.run('openPlaylistOrder()'); await settle(); p.run('movePlaylistOrder(3,0)');
    let posts=0;
    p.setFetch(url=>{
      if(url==='/api/playlist') { posts++; if(kind==='network') throw Error('Connection lost'); return {ok:true,json:async()=>({job:'order-job'})}; }
      return {ok:true,json:async()=>({state:'done',results:[{id:'81',status:'unverified'}]})};
    });
    await p.run('savePlaylistOrder()'); await p.run('savePlaylistOrder()');
    assert.equal(posts,1);
    assert.match(p.nodes.get('#playlist-order-status').textContent,/will not be sent again/);
    assert.equal(p.nodes.get('#playlist-order-save').disabled,true);
  }
  for(const change of ['cancel','navigation','library','session']) {
    const {p}=await playlistOrderPage(); let release;
    p.setFetch(()=>new Promise(resolve=>release=resolve)); p.run('openPlaylistOrder()');
    if(change==='cancel') p.run('closePlaylistOrder()');
    if(change==='navigation') p.run('showScreen("albums")');
    if(change==='library') p.run('useLocal(demoLibrary(),"demo")');
    if(change==='session') p.run('state.connection.playback_session="other-session"');
    release({ok:true,json:async()=>({rows:[]})}); await settle();
    assert.equal(p.run('Boolean(playlistOrderCurrent())'),false);
    assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  }
});

test('playlist search is paginated across the loaded playlist, clearable and keeps full playback and history state', async () => {
  const p=livePage(); await settle();
  p.run('playTracks(state.details.get("1")); state.screen="playlists"; collectionsView.playlist="88"; collectionsView.offset=200');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src})');
  p.setFetch(url=>({ok:true,json:async()=>({id:'88',name:'Search playlist',description:'',total:500,matched_total:105,offset:0,
    tracks:[101,102,101],before:[101,102,101],rows:[{id:'101',title:'Needle',artist:'Artist',album:'Album',album_id:'1',position:432,length:180}]})}));
  const {input,clear}=searchClearFixture(p,'collection-search','Needle');
  input.focus(); input.dispatchEvent(new Event('input',{bubbles:true})); p.flushTimers(300); await settle();
  assert.equal(p.requests.at(-1).url,'/api/playlists?id=88&q=Needle&offset=0');
  const html=p.nodes.get('#collections-page').innerHTML;
  assert.match(html,/105 matching tracks/); assert.match(html,/data-playlist-position="432"/);
  assert.match(html,/1 \/ 2/); assert.match(html,/Search this playlist/);
  assert.equal(p.run('document.activeElement.id'),'collection-search');
  assert.equal(p.json('viewState(0).collections').query,'Needle');
  assert.deepEqual(p.json('collectionsView.data.tracks'),[101,102,101]);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src})'),before);
  await clear(); p.flushTimers(300); await settle();
  assert.equal(p.requests.at(-1).url,'/api/playlists?id=88&offset=0');
  assert.equal(p.run('collectionsView.query'),'');
});

test('filtered large-playlist row playback uses its original-position mapping and late search results are ignored', async () => {
  const p=livePage(); await settle();
  p.run('state.screen="playlists"; collectionsView.playlist="88"; collectionsView.query="new"');
  let oldReply;
  p.setFetch(url=>{
    if(url.includes('q=old')) return new Promise(resolve=>{oldReply=resolve;});
    if(url==='/api/queue-tracks') return {ok:true,json:async()=>({tracks:[101,102].map(id=>({id:String(id),title:'Track '+id,artist:'Artist',album:{id:'1',name:'Album'}}))})};
    return {ok:true,json:async()=>({id:'88',name:'New results',description:'',total:20000,matched_total:2,large:true,tracks:[101,102],rows:[],page_positions:[12000,19000],offset:0})};
  });
  p.run('collectionsView.query="old"'); const old=p.run('renderCollections()'); await settle();
  p.run('collectionsView.query="new"'); await p.run('renderCollections()');
  oldReply({ok:true,json:async()=>({id:'88',name:'Old results',tracks:[],rows:[],total:0})}); await old;
  assert.equal(p.run('collectionsView.data.name'),'New results');
  await p.click({'[data-playlist-play], [data-playlist-shuffle], [data-playlist-position], [data-playlist-edit]':{dataset:{playlistPosition:'19000'},hasAttribute:key=>key==='data-playlist-position'}});
  assert.equal(p.run('player.index'),1);
  assert.deepEqual(p.json('player.queue.map(t=>t.id)'),['101','102']);
});

async function playlistRemovePage() {
  const p=livePage(); await settle();
  const data={id:'88',name:'My <playlist>',description:'',total:101,matched_total:101,offset:100,
    before:[999999,101,102,101],before_token:'snapshot',tracks:[101,102,101],
    rows:[{id:'101',title:'Repeated <track>',artist:'Artist',album:'Album',album_id:'1',position:2,stored_position:3,length:180}]};
  p.run(`state.screen="playlists"; state.connection.playback_session="remove-session"; collectionsView.playlist="88"; collectionsView.query="Repeated"; collectionsView.offset=100; playTracks(state.details.get("1")); collectionsView.data=${JSON.stringify(data)}`);
  return {p,data};
}

test('playlist row cross reviews exactly the selected occurrence without requests or playback changes', async () => {
  const {p,data}=await playlistRemovePage();
  p.setFetch(()=>({ok:true,json:async()=>data})); await p.run('renderCollections()');
  assert.match(p.nodes.get('#collections-page').innerHTML,/data-playlist-remove="3"/);
  assert.match(p.nodes.get('#collections-page').innerHTML,/Remove Repeated &lt;track&gt; from playlist, position 3/);
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'), requests=p.requests.length;
  await p.click({'[data-playlist-remove]':{dataset:{playlistRemove:'3'}}});
  assert.equal(p.requests.length,requests);
  assert.deepEqual(p.json('playlistDraft.body'),{action:'remove-track',playlist:'88',position:3,track:101,approved:true,before_token:'snapshot',before_name:'My <playlist>',session:'remove-session'});
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/Only this occurrence is removed/);
  assert.match(p.nodes.get('#playlist-dialog-content').innerHTML,/&lt;track&gt;/);
  p.run('$("#playlist-dialog").close()'); await p.run('savePlaylistDraft()');
  assert.equal(p.requests.length,requests);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('confirmed playlist row removal sends once, retains search and playback and clamps the last result page', async () => {
  const {p,data}=await playlistRemovePage();
  p.run('openPlaylistTrackRemove(3)');
  const before=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  let finish;
  p.setFetch((url,options)=>{
    if(url==='/api/playlist') {
      assert.equal(JSON.parse(options.body).position,3);
      assert.equal(JSON.parse(options.body).action,'remove-track');
      return new Promise(resolve=>{finish=resolve;});
    }
    if(url.startsWith('/api/jobs/')) return {ok:true,json:async()=>({state:'done',results:[{id:'88',status:'saved'}]})};
    assert.equal(url,'/api/playlists?id=88&q=Repeated&offset=0');
    return {ok:true,json:async()=>({...data,matched_total:100,total:100,offset:0,rows:[]})};
  });
  const save=p.run('savePlaylistDraft()'); await settle(); await p.run('savePlaylistDraft()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist').length,1);
  finish({ok:true,json:async()=>({id:'88',job:'remove-job'})}); await save;
  assert.equal(p.run('collectionsView.query'),'Repeated'); assert.equal(p.run('collectionsView.offset'),0);
  assert.equal(p.nodes.get('#playlist-dialog').open,false);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),before);
});

test('playlist row removal blocks stale sessions and consumes uncertain sends without retry', async () => {
  const {p}=await playlistRemovePage(); p.run('openPlaylistTrackRemove(3); state.connection.playback_session="other"');
  const count=p.requests.length; await p.run('savePlaylistDraft()'); assert.equal(p.requests.length,count);
  p.run('$("#playlist-dialog").close(); state.connection.playback_session="remove-session"; openPlaylistTrackRemove(3)');
  p.setFetch(()=>{throw Error('Connection lost after send');});
  await p.run('savePlaylistDraft()'); await p.run('savePlaylistDraft()');
  assert.equal(p.requests.filter(r=>r.url==='/api/playlist').length,1);
  assert.equal(p.run('playlistDraft.body'),null);
  assert.equal(p.nodes.get('#playlist-dialog').open,false);
  p.run('collectionsView.data.large=true; openPlaylistTrackRemove(3)');
  assert.equal(p.nodes.get('#playlist-dialog').open,false);
});

async function playlistOrderSearchPage() {
  const {p,data}=await playlistOrderPage({size:205});
  const respond=(url,options)=>{
    if(url.startsWith('/api/playlist/order?')) {
      const params=new URL(url,'http://localhost').searchParams;
      if(params.has('q')) return {ok:true,json:async()=>({positions:params.get('q')==='empty'?[]:[1,150,204]})};
      const positions=params.get('positions').split(',').map(Number);
      return {ok:true,json:async()=>({rows:positions.map(source=>({id:String(data.before[source]),source_position:source,available:true,title:`Found ${source}`,artist:'Preview'}))})};
    }
    if(url==='/api/playlist') return {ok:true,json:async()=>({id:'81',job:'saved-order'})};
    if(url.startsWith('/api/jobs/')) return {ok:true,json:async()=>({state:'done',results:[{id:'81',status:'saved'}]})};
    if(url.startsWith('/api/playlists?')) return {ok:true,json:async()=>data};
    throw Error('Unexpected request '+url);
  };
  p.setFetch(respond); p.run('openPlaylistOrder()'); await settle();
  return {p,data,respond};
}

async function typePlaylistOrderSearch(p,query) {
  const input=p.nodes.get('#playlist-order-search'); input.id='playlist-order-search'; input.value=query;
  input.focus(); input.dispatchEvent(new Event('input',{bubbles:true})); p.flushTimers(300); await settle();
}

test('playlist order search preserves local moves, full position numbers and playback across pages and clearing', async()=>{
  const {p}=await playlistOrderSearchPage();
  p.run('movePlaylistOrder(0,10)'); await settle();
  const order=p.run('JSON.stringify(playlistOrder.draft.order)');
  const playback=p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})');
  await typePlaylistOrderSearch(p,'Found');
  assert.equal(p.run('JSON.stringify(playlistOrder.draft.order)'),order);
  assert.deepEqual(p.json('playlistOrderSources(playlistOrder.draft)'),[1,150,204]);
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/3 matching positions/);
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/position 151 of 205/);
  assert.equal(p.run('document.activeElement.id'),'playlist-order-search');
  await p.click({'[data-order-move]':{dataset:{orderMove:'204'}}});
  await p.emitDocument('submit',{target:{id:'playlist-order-move',elements:{position:{value:'45'}}},preventDefault(){}}); await settle();
  assert.equal(p.run('playlistOrder.draft.order[44]'),204);
  assert.deepEqual(p.json('playlistOrderSources(playlistOrder.draft)'),[1,204,150]);
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/position 45 of 205/);
  const moved=p.run('JSON.stringify(playlistOrder.draft.order)');
  await typePlaylistOrderSearch(p,'');
  assert.equal(p.run('JSON.stringify(playlistOrder.draft.order)'),moved);
  assert.equal(p.run('playlistOrderSources(playlistOrder.draft).length'),205);
  assert.equal(p.run('playlistOrder.draft.rows.size'),100);
  assert.equal(p.run('JSON.stringify({queue:player.queue,src:audio.src,history:state.history})'),playback);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  p.run('closePlaylistOrder()'); assert.equal(p.run('playlistOrder.draft'),null);
});

test('saving from playlist order search still sends the full permutation and retains hidden positions', async()=>{
  const {p}=await playlistOrderSearchPage(); await typePlaylistOrderSearch(p,'Found');
  p.run('movePlaylistOrder(204,44)'); await settle();
  const order=p.json('playlistOrder.draft.order');
  await p.run('savePlaylistOrder()');
  const saves=p.requests.filter(r=>r.url==='/api/playlist'); assert.equal(saves.length,1);
  const body=JSON.parse(saves[0].options.body);
  assert.deepEqual(body.positions,order); assert.equal(body.positions.length,205);
  assert.equal(new Set(body.positions).size,205); assert.equal(body.positions[44],204);
  assert.equal(p.nodes.get('#playlist-order').open,false);
});

test('late or cancelled order searches cannot restore results and zero matches stay bounded', async()=>{
  const {p,respond}=await playlistOrderSearchPage(); let old;
  p.setFetch((url,options)=>url.includes('q=old')?new Promise(resolve=>{old=resolve;}):respond(url,options));
  await typePlaylistOrderSearch(p,'old');
  await typePlaylistOrderSearch(p,'empty');
  assert.equal(p.run('playlistOrder.draft.loading'),false);
  assert.equal(p.run('playlistOrder.draft.rows.size'),0);
  assert.match(p.nodes.get('#playlist-order-content').innerHTML,/No playlist positions match/);
  old({ok:true,json:async()=>({positions:[204]})}); await settle();
  assert.equal(p.run('playlistOrder.draft.matches.size'),0);
  await typePlaylistOrderSearch(p,'old'); p.run('closePlaylistOrder()');
  old({ok:true,json:async()=>({positions:[204]})}); await settle();
  assert.equal(p.run('playlistOrder.draft'),null); assert.equal(p.nodes.get('#playlist-order').open,false);
});

async function albumLyricsImportPage() {
  const p=page(); await settle();
  p.run(`state.mode="live"; state.connection.premium=true; state.connection.playback_session="import-session";
    state.screen="album"; albumView.id="1"; albumView.request=17;
    state.details.get("1").tracks=[{id:"100",title:"Song One",artist:"Artist A",track:1},
      {id:"101",title:"Song Two",artist:"Artist A",track:2}];
    function sidecar(name,text){const bytes=new TextEncoder().encode(text);return {name,size:bytes.length,arrayBuffer:async()=>bytes.buffer};}
    openAlbumLyricsImport();`);
  return p;
}

function lyricsImportResponses(p, {before={}, save}={}) {
  p.setFetch(async (url, options) => {
    if(url.startsWith('/api/lyrics?')) {
      const id=new URL('http://test'+url).searchParams.get('track_id');
      return {ok:true,json:async()=>({native_text:before[id]||'',before_token:'token-'+id,can_save:true})};
    }
    const body=JSON.parse(options.body);
    if(url==='/api/lyrics/review') return {ok:true,json:async()=>({id:'review-'+body.track_id,
      before:before[body.track_id]||'',after:body.lyrics})};
    assert.equal(url,'/api/lyrics/save');
    if(save) return save(body);
    return {ok:true,json:async()=>({status:'saved'})};
  });
}

test('lyrics sidecar matching keeps version identity and uses both number and title', async () => {
  const p=await albumLyricsImportPage();
  assert.deepEqual(p.json('lyricsImportFilename("01 - SONG_One.lrc")'),{disc:null,track:1,title:'song one'});
  assert.deepEqual(p.json('lyricsImportFilename("CD2 - 03 - Track Title.txt")'),{disc:2,track:3,title:'track title'});
  assert.deepEqual(p.json('lyricsImportFilename("2-03 - Track Title.txt")'),{disc:2,track:3,title:'track title'});
  await p.run('addAlbumLyricsFiles([sidecar("01 - SONG_One.lrc","[00:01.00]First line"),sidecar("02 - Song Two (Live).txt","Other version"),sidecar("Song Two.txt","No number")])');
  assert.deepEqual(p.json('[...albumLyricsImport.pairs]'),[['100','0']]);
  assert.equal(p.requests.filter(r=>r.url.startsWith('/api/lyrics')).length,0);
});

test('lyrics import shows two columns, escapes local text and removes timing without playback', async () => {
  const p=await albumLyricsImportPage();
  const before=p.json('({queue:player.queue,src:audio.src,history:history.length})');
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.lrc","[ar:Example]\\r\\n[00:01.00][00:02.00]<00:01.500><script>Example</script>\\r\\n[00:03.00]Next")])');
  assert.equal(p.run('albumLyricsImport.files[0].text'),'<script>Example</script>\nNext');
  await p.click({'[data-lyrics-import-file]':{dataset:{lyricsImportFile:'0'}}});
  const html=p.nodes.get('#lyrics-import-content').innerHTML;
  assert.match(html,/Album tracks|LRC \/ TXT files/);
  assert.match(html,/&lt;script&gt;Example&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>Example/);
  assert.deepEqual(p.json('({queue:player.queue,src:audio.src,history:history.length})'),before);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('duplicate filenames and multi-disc duplicate positions stay manual', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First"),sidecar("01 - Song One.lrc","[00:01.0]Second")])');
  assert.equal(p.run('albumLyricsImport.pairs.size'),0);
  p.run('albumLyricsImport.files=[]; albumLyricsImport.nextFile=0; albumLyricsImport.tracks[1]={...albumLyricsImport.tracks[0],id:"101",disc:2}; albumLyricsImport.tracks[0].disc=1;');
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","Ambiguous")])');
  assert.equal(p.run('albumLyricsImport.pairs.size'),0);
  await p.run('addAlbumLyricsFiles([sidecar("CD2 - 01 - Song One.txt","Disc two")])');
  assert.equal(p.run('albumLyricsImport.pairs.size'),0,'The extra undistinguished candidate prevents an automatic choice');
  p.run('albumLyricsImport.files=albumLyricsImport.files.slice(1); autoMatchAlbumLyrics(albumLyricsImport)');
  assert.deepEqual(p.json('[...albumLyricsImport.pairs]'),[['101','1']]);
});

test('manual links can override suggestions, use each file once and explicitly unlink', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("Different name.txt","Manual text")])');
  await p.click({'[data-lyrics-import-file]':{dataset:{lyricsImportFile:'0'}}});
  await p.click({'#lyrics-import-link':{}});
  assert.deepEqual(p.json('[...albumLyricsImport.pairs]'),[['100','0']]);
  await p.click({'[data-lyrics-import-track]':{dataset:{lyricsImportTrack:'101'}}});
  await p.click({'#lyrics-import-link':{}});
  assert.deepEqual(p.json('[...albumLyricsImport.pairs]'),[['101','0']]);
  await p.click({'[data-lyrics-import-unlink]':{dataset:{lyricsImportUnlink:'101'}}});
  assert.equal(p.run('albumLyricsImport.pairs.size'),0);
});

test('invalid, empty, oversized and incorrectly encoded lyrics do not become writable imports', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("bad.mp3","Audio"),sidecar("empty.lrc","[ar:Artist]"),sidecar("large.txt","x".repeat(50001)),{name:"bad.txt",size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer}])');
  assert.equal(p.run('albumLyricsImport.files.filter(f=>f.error).length'),4);
  assert.equal(p.run('albumLyricsImport.pairs.size'),0);
  assert.equal(p.nodes.get('#lyrics-import-review').disabled,true);
  assert.equal(p.run('lyricsImportDecode(new Uint8Array([255,254,65,0]).buffer)'),'A');
  assert.equal(p.run('lyricsImportDecode(new Uint8Array([254,255,0,65]).buffer)'),'A');
  await p.run('addAlbumLyricsFiles(Array.from({length:101},()=>sidecar("01 - Song One.txt","Too many")))');
  assert.equal(p.run('albumLyricsImport.files.length'),4);
});

test('review reads only linked native lyrics freshly and defaults to preserving existing text', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","Imported first"),sidecar("02 - Song Two.txt","Imported second")])');
  lyricsImportResponses(p,{before:{100:'Existing lyrics'}});
  await p.run('reviewAlbumLyricsImport()');
  assert.deepEqual(p.json('albumLyricsImport.rows.map(r=>r.status)'),['Keep existing lyrics','Ready']);
  assert.match(p.nodes.get('#lyrics-import-content').innerHTML,/Existing lyrics|Imported first|Replace existing lyrics/);
  const reads=p.requests.filter(r=>r.url.startsWith('/api/lyrics?'));
  assert.equal(reads.length,2);
  assert.ok(reads.every(r=>r.url.includes('refresh=1')));
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
  assert.equal(p.run('currentHelpContext()'),'lyrics-import');
});

test('explicit save serializes native single-track reviews, preserves scope and skips kept tracks', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","Imported first"),sidecar("02 - Song Two.txt","Imported second")])');
  lyricsImportResponses(p,{before:{100:'Keep this'}});
  await p.run('reviewAlbumLyricsImport()');
  await p.run('saveAlbumLyricsImport()');
  const prepares=p.requests.filter(r=>r.url==='/api/lyrics/review');
  assert.equal(prepares.length,1);
  const body=JSON.parse(prepares[0].options.body);
  assert.equal(body.track_id,'101'); assert.equal(body.before_token,'token-101');
  assert.equal(body.replace_existing,false); assert.equal(body.album_scope.albums[0].tracks.length,2);
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,1);
  assert.deepEqual(p.json('albumLyricsImport.rows.map(r=>r.status)'),['Keep existing lyrics','Saved and confirmed']);
  assert.equal(p.run('trackLyrics.busy'),false);
  assert.equal(p.run('knownTrackLyrics(albumLyricsImport.tracks[1]).text'),'Imported second');
});

test('replacement is per track and included in the guarded native review', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","Replacement")])');
  lyricsImportResponses(p,{before:{100:'Original'}}); await p.run('reviewAlbumLyricsImport()');
  p.nodes.get('#lyrics-import-content').querySelector=()=>({textContent:''});
  await p.change({dataset:{lyricsImportReplace:'0'},checked:true,matches:()=>false,closest:()=>null});
  assert.equal(p.run('albumLyricsImport.rows[0].status'),'Replace existing lyrics');
  await p.run('saveAlbumLyricsImport()');
  const request=p.requests.find(r=>r.url==='/api/lyrics/review');
  assert.equal(JSON.parse(request.options.body).replace_existing,true);
});

test('an unconfirmed import stops remaining saves and cannot replay the review', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First"),sidecar("02 - Song Two.txt","Second")])');
  lyricsImportResponses(p,{save:()=>({ok:true,json:async()=>({status:'unverified'})})});
  await p.run('reviewAlbumLyricsImport()'); await p.run('saveAlbumLyricsImport()');
  assert.deepEqual(p.json('albumLyricsImport.rows.map(r=>r.status)'),['Unconfirmed · check iBroadcast','Not sent']);
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,1);
  await p.run('saveAlbumLyricsImport()');
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,1);
});

test('stopping import finishes the current save/read-back and leaves subsequent tracks unsent', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First"),sidecar("02 - Song Two.txt","Second")])');
  lyricsImportResponses(p,{save:()=>{p.run('albumLyricsImport.stop=true');return {ok:true,json:async()=>({status:'saved'})};}});
  await p.run('reviewAlbumLyricsImport()'); await p.run('saveAlbumLyricsImport()');
  assert.deepEqual(p.json('albumLyricsImport.rows.map(r=>r.status)'),['Saved and confirmed','Not sent']);
  assert.equal(p.requests.filter(r=>r.url==='/api/lyrics/save').length,1);
});

test('replaced library invalidates import and rejects late native reads', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First")])');
  let release;
  p.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  const pending=p.run('reviewAlbumLyricsImport()'); await settle();
  p.run('state.details=new Map(state.details); resetTrackLyrics()');
  release({ok:true,json:async()=>({native_text:'',can_save:true,before_token:'late'})}); await pending;
  assert.equal(p.run('albumLyricsImport'),null);
  assert.equal(p.nodes.get('#lyrics-import').open,false);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('free accounts cannot open a lyrics import and navigation discards its local files', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First")])');
  p.run('showScreen("artists")');
  assert.equal(p.run('albumLyricsImport'),null);
  p.run('state.screen="album"; state.connection.premium=false; openAlbumLyricsImport()');
  assert.equal(p.run('albumLyricsImport'),null);
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});

test('removing an imported file frees its link without reusing file identities', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First"),sidecar("02 - Song Two.txt","Second")])');
  await p.click({'[data-lyrics-import-remove]':{dataset:{lyricsImportRemove:'0'}}});
  assert.deepEqual(p.json('[...albumLyricsImport.pairs]'),[['101','1']]);
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","New first")])');
  assert.deepEqual(p.json('albumLyricsImport.files.map(f=>f.id)'),['1','2']);
  assert.equal(p.run('albumLyricsImport.pairs.get("100")'),'2');
});

test('discard confirmation preserves the import when declined and closes it on explicit acceptance', async () => {
  const p=await albumLyricsImportPage();
  await p.run('addAlbumLyricsFiles([sidecar("01 - Song One.txt","First")])');
  p.run('confirm=()=>false; closeAlbumLyricsImport()');
  assert.equal(p.run('albumLyricsImport.files.length'),1);
  assert.equal(p.nodes.get('#lyrics-import').open,true);
  p.run('confirm=()=>true; closeAlbumLyricsImport()');
  assert.equal(p.run('albumLyricsImport'),null);
  assert.equal(p.nodes.get('#lyrics-import').open,false);
});

test("import duration presentation follows mapped units without changing source records", () => {
  const p = page();
  p.run('csvImport.durationUnit="seconds"');
  assert.equal(p.run('csvSourceDuration("203.0")'), "3:23");
  assert.equal(p.run('csvSourceDuration("203,5")'), "3:23");
  assert.equal(p.run('csvSourceDuration("3:23")'), "3:23");
  assert.equal(p.run('csvSourceDuration("not a duration")'), "not a duration");
  assert.equal(p.run('csvSourceDuration("0")'), "0");
  assert.equal(p.run('csvSourceDuration("86401")'), "86401");
  p.run('csvImport.durationUnit="milliseconds"');
  assert.equal(p.run('csvSourceDuration("203000")'), "3:23");
  assert.equal(p.run('csvSourceDuration("3:23")'), "3:23");
  p.run('globalThis.durationRow={position:0,line:2,source:{title:"Song",artist:"Artist",album:"",duration:"203000",year:0,warnings:[]}}');
  assert.match(p.run('csvSource(durationRow)'), / · 3:23/);
  assert.equal(p.run('durationRow.source.duration'), "203000");
});

test("empty cleanup previews omit selection and paging while preserving report actions", async () => {
  const p = livePage(); await settle();
  p.nodes.set("#cleanup-selected", null);
  p.run('cleanupView.data={id:"empty",state:"preview",category:"genres",albums:0,tracks:0,groups:[],counts:{},batch_tracks:200,batch_albums:20}; renderCleanup()');
  let html = p.nodes.get('#cleanup-content').innerHTML;
  assert.match(html, /No changes found for this preview/);
  assert.match(html, /id="cleanup-export"/);
  assert.doesNotMatch(html, /data-cleanup-page|id="cleanup-select-all"|id="cleanup-approved"|id="cleanup-start"/);
  p.run('cleanupView.data.albums=1; cleanupView.data.tracks=1; renderCleanup()');
  html = p.nodes.get('#cleanup-content').innerHTML;
  assert.match(html, /id="cleanup-approved"/);
  assert.doesNotMatch(html, /data-cleanup-page/);
  p.run('cleanupView.data.albums=26; renderCleanup()');
  assert.match(p.nodes.get('#cleanup-content').innerHTML, /data-cleanup-page="25"/);
  assert.match(p.nodes.get('#cleanup-content').innerHTML, /1 \/ 2/);
});

test("a direct Overview address refreshes its initial disconnected placeholder after library loading", async () => {
  const p = page({hash:"#/overview",deferReady:true}); await settle();
  assert.match(p.nodes.get('#overview-page').innerHTML, /Connect your iBroadcast account/);
  const stats = {albums:2, tracks:3, health:{}, formats:[], uploads:[], top_tracks:[], top_albums:[], top_artists:[]};
  p.setStatusFetch(() => ({ok:true,json:async()=>({connected:true,playback_session:"overview-fixture"})}));
  p.setFetch(url => ({ok:true,json:async()=>url.startsWith('/api/library')
    ? {albums:[],artists:[],source:"cache"}
    : url === '/api/overview' ? {account:{username:"Overview fixture",preferences:{},linked:{}},stats} : {sources:[]}}));
  await p.emitDocument('DOMContentLoaded'); await settle();
  assert.equal(p.location.hash, '#/overview');
  assert.match(p.nodes.get('#overview-page').innerHTML, /Overview fixture/);
  assert.doesNotMatch(p.nodes.get('#overview-page').innerHTML, /Connect your iBroadcast account/);
  assert.equal(p.requests.filter(r=>r.url==='/api/overview').length,1);
  p.run('render(); render()'); await settle();
  assert.equal(p.requests.filter(r=>r.url==='/api/overview').length,1, 'Ordinary renders do not poll Overview');
  assert.equal(p.requests.filter(r=>r.options?.method==='POST').length,0);
});
