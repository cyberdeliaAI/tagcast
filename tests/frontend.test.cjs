"use strict";

// Run the actual page scripts with a small DOM stand-in; no browser or network.
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const staticDir = path.join(root, "src/tagcast/static");

function page() {
  const nodes = new Map(), requests = [];
  const documentEvents = new Map();
  let respond = null;
  function element() {
    const classes = new Set();
    const events = new Map(), attributes = new Map();
    return {value: "", checked: false, disabled: false, dataset: {}, options: [], innerHTML: "", textContent: "",
      paused: true,
      classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c)},
      addEventListener(type, handler) { const handlers = events.get(type) || []; handlers.push(handler); events.set(type, handlers); },
      emit(type, event = {}) { return Promise.all((events.get(type) || []).map(handler => handler(event))); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      elements: {namedItem() { return null; }}, reportValidity() { return true; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
      play() { this.paused = false; this.emit("play"); return Promise.resolve(); },
      pause() { this.paused = true; this.emit("pause"); }, load() {},
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return name === "src" ? this.src : attributes.get(name); },
      removeAttribute(name) { attributes.delete(name); if (name === "src") delete this.src; }};
  }
  const document = {body: element(), documentElement: element(),
    addEventListener(type, handler) { const handlers = documentEvents.get(type) || []; handlers.push(handler); documentEvents.set(type, handlers); },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    }, querySelectorAll() { return []; }};
  document.querySelector("#sort").value = "artist";
  const context = vm.createContext({document, window: {addEventListener() {}}, location: {search: ""}, navigator: {}, console,
    localStorage: {getItem() { return null; }, setItem() {}}, structuredClone, URL, URLSearchParams, Blob,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({url, options});
      if (respond && url !== "/api/status") return respond(url, options);
      assert.equal(url, "/api/status", "Only the initial status read is allowed in preview tests");
      return {ok: true, json: async () => ({connected: false, configured: false})};
    }});
  const scripts = [...readFileSync(path.join(staticDir, "index.html"), "utf8").matchAll(/<script src="([^"]+)"/g)];
  for (const [, file] of scripts) vm.runInContext(readFileSync(path.join(staticDir, file), "utf8"), context, {filename: file});
  return {run: source => vm.runInContext(source, context), nodes, requests,
    setFetch(handler) { respond = handler; },
    async click(matches) {
      const event = {target: {closest: selector => matches[selector] || null}};
      for (const handler of documentEvents.get("click") || []) await handler(event);
      await new Promise(resolve => setImmediate(resolve));
    },
    json: source => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context))};
}

const imported = JSON.parse(readFileSync(path.join(__dirname, "fixtures/library.json"), "utf8"));

for (const mode of ["demo", "imported"]) {
  for (const field of ["genres", "composers"]) {
    test(`${mode}: reviewed ${field} arrays can be applied to the local preview`, async () => {
      const p = page();
      if (mode === "imported") p.run(`useLocal(importLibrary(${JSON.stringify(imported)}), "imported")`);
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
}

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

function livePage() {
  const p = page();
  p.run(`const first = state.details.get(state.albums[0].id);
    Object.assign(first, {artist_id: 42, artist_image: "https://example.test/artist-150", artist_artwork_id: 8});
    const second = state.details.get(state.albums[2].id);
    Object.assign(second, {artist_id: 43, artist_image: "https://example.test/other-150", artist_artwork_id: 9});
    state.albums = [...state.details.values()].map(summarize); state.mode = "live"`);
  return p;
}

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

test("album details escape metadata and format durations without losing imported lengths", async () => {
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
  const data = structuredClone(imported);
  data.library.tracks.map.length = data.library.tracks["90"].length;
  data.library.tracks["90"].push(125);
  assert.equal(p.run(`importLibrary(${JSON.stringify(data)})[0].tracks[0].length`), 125);
});

test("browsing a different album preserves playback and plays the viewed album, not the editor", async () => {
  const p = page();
  await p.run('openEditor(["1"])');
  p.run('state.mode = "live"');
  await p.run('openAlbum("1")');
  await p.click({"[data-play]": {dataset: {play: "101", playAlbumId: "1"}}});
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101");
  await p.run('openAlbum("3")');
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101");
  assert.equal(p.nodes.get("#audio").paused, false);
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "3"}}});
  assert.equal(p.run("player.album.name"), "Hounds of Love");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/300");
  await p.click({"[data-album-back]": {}});
  assert.equal(p.run("state.screen"), "albums");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/300");
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
  assert.equal(p.nodes.get("#audio").src, "/api/stream/102");
  p.run("player.index = player.queue.length - 1; playCurrent()");
  const last = p.nodes.get("#audio").src;
  await p.nodes.get("#audio").emit("ended");
  assert.equal(p.nodes.get("#audio").src, last);
  p.run("stopPlayer()");
  assert.equal(p.nodes.get("#audio").src, undefined);
  assert.equal(p.run("player.album"), null);
});

test("playback remains available in the single-album editor and is blocked in previews", async () => {
  const p = page();
  await p.run('openEditor(["1"])');
  const target = {"[data-play]": {dataset: {play: "100"}}, "#editor": {}};
  await p.click(target);
  assert.equal(p.nodes.get("#audio").src, undefined);
  p.run('state.mode = "live"');
  await p.click(target);
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100");
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
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100");
  assert.equal(p.nodes.get("#audio").paused, false);
  assert.equal(p.run("player.album.name"), "Wish You Were Here", "Playback retains its independent snapshot");
});
