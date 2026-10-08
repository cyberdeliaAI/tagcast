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
  function element() {
    const classes = new Set();
    return {value: "", checked: false, disabled: false, dataset: {}, options: [], innerHTML: "", textContent: "",
      classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c)},
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      elements: {namedItem() { return null; }}, reportValidity() { return true; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
      play() { return Promise.resolve(); }, pause() {}};
  }
  const document = {body: element(), documentElement: element(), addEventListener() {},
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
      assert.equal(url, "/api/status", "Only the initial status read is allowed in preview tests");
      return {ok: true, json: async () => ({connected: false, configured: false})};
    }});
  const scripts = [...readFileSync(path.join(staticDir, "index.html"), "utf8").matchAll(/<script src="([^"]+)"/g)];
  for (const [, file] of scripts) vm.runInContext(readFileSync(path.join(staticDir, file), "utf8"), context, {filename: file});
  return {run: source => vm.runInContext(source, context), nodes, requests,
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
