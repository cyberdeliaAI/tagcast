"use strict";

// Run the actual page scripts with a small DOM stand-in; no browser or network.
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const staticDir = path.join(root, "src/tagcast/static");

function page({hash = "", storage = {}, server = true, browserNavigator = {}, metadataClass, setupAudio} = {}) {
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
  let playbackClock = 0;
  function element() {
    const classes = new Set();
    const events = new Map(), attributes = new Map();
    return {value: "", checked: false, disabled: false, dataset: {}, options: [], children: [], innerHTML: "", textContent: "",
      appendChild(node) { this.children = this.children.filter(child => child !== node); this.children.push(node); return node; },
      isConnected: true, style: {}, clientWidth: 1265, clientHeight: 710,
      getBoundingClientRect() { return {left: 1000, right: 1042, top: 300, bottom: 336, width: 220, height: 130}; },
      paused: true,
      classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c)},
      addEventListener(type, handler) { const handlers = events.get(type) || []; handlers.push(handler); events.set(type, handlers); },
      emit(type, event = {}) { return Promise.all((events.get(type) || []).map(handler => handler(event))); },
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
    createElement(tag) { assert.equal(tag, "a"); return {click() { downloads.push({name: this.download, blob: blobs.get(this.href)}); }}; },
    addEventListener(type, handler) { const handlers = documentEvents.get(type) || []; handlers.push(handler); documentEvents.set(type, handlers); },
    querySelector(selector) {
      if (selector === "dialog[open]") return [...nodes.entries()].find(([name, node]) => ["#editor", "#review", "#artwork", "#history", "#connect", "#settings", "#updates", "#trash-review", "#cover-lightbox", "#help-dialog", "#tag-dialog", "#audio-output-dialog"].includes(name) && node.open)?.[1] || null;
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    }, querySelectorAll() { return []; }};
  document.querySelector("#sort").value = "artist";
  const window = {scrollY: 0, scrollTo({top}) { this.scrollY = top; }, addEventListener(type, handler) { const handlers = windowEvents.get(type) || []; handlers.push(handler); windowEvents.set(type, handlers); }};
  if (setupAudio) setupAudio(document.querySelector("#audio"));
  const context = vm.createContext({document, window, location, history, navigator: browserNavigator, MediaMetadata: metadataClass, console, confirm: () => true,
    performance: {now: () => playbackClock},
    localStorage: {getItem(key) { return storage[key] ?? null; }, setItem(key, value) { storage[key] = String(value); }}, structuredClone,
    URL: class extends URL {
      static createObjectURL(blob) { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }
      static revokeObjectURL(url) { blobs.delete(url); }
    }, URLSearchParams, Blob,
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({url, options});
      if (url === "/1001-album-notes.json") return respondNotes ? respondNotes(url, options)
        : {ok: true, json: async () => ({schema: 1, entries: []})};
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
  return {run: source => vm.runInContext(source, context), nodes, requests, downloads, history, location,
    setPlaybackClock(value) { playbackClock = value; },
    setFetch(handler) { respond = handler; },
    setStatusFetch(handler) { respondStatus = handler; },
    setUpdateFetch(handler) { respondUpdates = handler; },
    setNotesFetch(handler) { respondNotes = handler; },
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
    ['tracks', 'tracks'], ['favourites', 'favourites'], ['album-favourites', 'album-favourites'],
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
  p.run('closeHelp(); $("#editor").showModal(); openHelp()');
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

test('album background uses bundled notes for confirmed guide links only, escapes text and keeps playback', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p), ref = report.entries[0];
  p.run(`applyAlbumGuideSettings({album_guide:true}); albumGuide.data = ${JSON.stringify(report)}; albumGuide.details = state.details; playTracks(state.details.get("1"))`);
  const queue = p.json('player.queue'), source = p.nodes.get('#audio').src;
  p.setNotesFetch(() => ({ok: true, json: async () => ({schema: 1, entries: [
    {id: ref.id, album: ref.album, artist: ref.artist, text: '<script>alert(1)</script> & an album.',
      context: '<b>Reviewed title variant</b>',
      source_url: 'https://en.wikipedia.org/wiki/An_Album'},
    {id: 50, album: 'Bad link', artist: 'Other', text: 'Unsafe', source_url: 'javascript:alert(1)'}]})}));
  await p.run('openAlbum("1")'); await settle();
  const panel = p.nodes.get('#album-guide-notes');
  assert.match(panel.innerHTML, /About this album|&lt;script&gt;alert/);
  assert.match(panel.innerHTML, /Wikipedia contributors|CC BY-SA/);
  assert.doesNotMatch(panel.innerHTML, /<script>|javascript:/);
  assert.match(panel.innerHTML, /&lt;b&gt;Reviewed title variant&lt;\/b&gt;/);
  assert.equal(panel.hidden, false);
  assert.deepEqual(p.json('player.queue'), queue);
  assert.equal(p.nodes.get('#audio').src, source);
  assert.equal(p.requests.filter(r => r.url === '/1001-album-notes.json').length, 1);
  assert.ok(p.requests.every(r => !/^https?:/.test(r.url)), 'Reading notes makes no external request');
  p.run('albumGuide.data.entries[0].status = "possible"; renderGuideAlbumNotes()');
  assert.equal(panel.hidden, true, 'Unconfirmed candidates never receive album text');
  p.run('albumGuide.data.entries[0].status = "found"; renderGuideAlbumNotes()');
  assert.equal(panel.hidden, false);
  p.run('applyAlbumGuideSettings({album_guide:false})');
  assert.equal(panel.hidden, true);
});

test('late album notes never repaint another page and opening an album never analyses the guide', async () => {
  const p = livePage(); await settle();
  const report = guideReport(p), ref = report.entries[0];
  p.setFetch(url => { assert.equal(url, '/api/album-guide'); return {ok: true, json: async () => report}; });
  let release;
  p.setNotesFetch(() => new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({schema: 1,
    entries: [{...ref, text: 'Local background', source_url: 'https://en.wikipedia.org/wiki/Album'}]})}); }));
  p.run('applyAlbumGuideSettings({album_guide:true})');
  await p.run('openAlbum("1")'); await settle();
  assert.equal(p.requests.filter(r => r.url === '/api/album-guide').length, 1);
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
  assert.match(p.nodes.get("#toast").textContent, /Could not change favourite: Rating changed elsewhere/);
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
  assert.match(readFileSync(path.join(staticDir, "index.html"), "utf8"), /<option value="random">Random<\/option>/);
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
    no_genre: ["3", "6", "4", "5", "2", "71", "1"],
    fewest: ["1", "71", "6", "4", "2", "5", "3"],
    most: ["3", "5", "4", "2", "6", "71", "1"],
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
  assert.equal(p.nodes.get("#sort").value, "most");
  assert.deepEqual(p.json("filteredAlbums().map(a => a.id)"), orders.most);
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
  assert.equal(p.requests.length, count, 'Suggestions reuse the open album without requests');
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
  assert.match(p.nodes.get("#artist-panel").innerHTML, /<strong>1<\/strong><span>album<\/span><small>2 tracks<\/small>/);
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
  assert.match(html, /class="track-time">[^<]*<small class="track-format" title="File format">FLAC<\/small>/);
  assert.match(html, /class="track-format" title="File format">MP3/);
  assert.equal((html.match(/class="track-format"/g)||[]).length,2,"Missing format data stays blank");
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
  assert.match(p.run('albumRatingControls([{id:"1",rating:5}])'),/data-heart[^>]*aria-pressed="true"/);
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
