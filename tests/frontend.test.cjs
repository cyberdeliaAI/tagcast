"use strict";

// Run the actual page scripts with a small DOM stand-in; no browser or network.
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const staticDir = path.join(root, "src/tagcast/static");

function page({hash = "", storage = {}} = {}) {
  const nodes = new Map(), requests = [];
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
  const window = {addEventListener(type, handler) { const handlers = windowEvents.get(type) || []; handlers.push(handler); windowEvents.set(type, handlers); }};
  const context = vm.createContext({document, window, location, history, navigator: {}, console,
    localStorage: {getItem(key) { return storage[key] ?? null; }, setItem(key, value) { storage[key] = String(value); }}, structuredClone, URL, URLSearchParams, Blob,
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({url, options});
      if (respond && url !== "/api/status") return respond(url, options);
      assert.equal(url, "/api/status", "Only the initial status read is allowed in preview tests");
      return {ok: true, json: async () => ({connected: false, configured: false})};
    }});
  const scripts = [...readFileSync(path.join(staticDir, "index.html"), "utf8").matchAll(/<script src="([^"]+)"/g)];
  for (const [, file] of scripts) vm.runInContext(readFileSync(path.join(staticDir, file), "utf8"), context, {filename: file});
  return {run: source => vm.runInContext(source, context), nodes, requests, history, location,
    setFetch(handler) { respond = handler; },
    flushTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
    async click(matches) {
      const event = {target: {closest: selector => matches[selector] || null}};
      for (const handler of documentEvents.get("click") || []) await handler(event);
      await new Promise(resolve => setImmediate(resolve));
    },
    async change(target) {
      for (const handler of documentEvents.get("change") || []) await handler({target});
    },
    json: source => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context))};
}

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
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101");
  await p.run('openAlbum("3")');
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101");
  assert.equal(p.nodes.get("#audio").paused, false);
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "3"}}});
  assert.equal(p.run("player.album.name"), "Hounds of Love");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/300");
  p.nodes.get("#editor").close();
  await p.click({"[data-album-back]": {}});
  assert.equal(p.run("state.screen"), "album");
  assert.equal(p.run("albumView.id"), "1", "Back returns to the album viewed before");
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
  assert.ok(p.requests.every(r => ["/api/status", "/api/settings"].includes(r.url)), "Overview uses summaries without downloading tracks");
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
  assert.equal(p.nodes.get("#audio").src, "/api/stream/100");
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
  assert.match(p.nodes.get("#album-page").innerHTML, /← Back to Kate Bush/);
  await p.click({"[data-album-back]": {}});
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
  assert.match(p.nodes.get("#album-page").innerHTML, /← Back to Overview/);
  await p.click({"[data-album-back]": {}});
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
  p.run(`const discs = [1, 2, 3].map(n => ({id: 70 + n, artist: "Pink Floyd", name: "The Wall", year: n === 3 ? 0 : 1979,
      disc: n, color: colors[0], tracks: [1, 2].map(t => ({id: (70 + n) * 100 + t, title: "Part " + n + "." + t,
      artist: "Pink Floyd", year: 1979, genre: "Rock", track: t, length: 60}))}));
    useLocal([...demoLibrary(), ...discs], "demo"); render()`);
  return p;
}

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
  assert.match(card, /6 tracks <span aria-hidden="true">·<\/span> <span class="disc-icons" role="img" aria-label="3 discs"/);
  assert.equal(card.match(/<svg/g).length, 3, "One CD icon per disc");
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
  assert.match(html, /data-edit-album="71,72,73">Edit album/);
  assert.match(html, /data-edit-album="73">Edit disc 3/);
  await p.click({"[data-play-album]": {dataset: {playAlbumId: "71"}}});
  assert.equal(p.run("player.queue.length"), 6);
  p.run("player.index = 1; playCurrent()");
  await p.nodes.get("#audio").emit("ended");
  assert.equal(p.nodes.get("#audio").src, "/api/stream/7201", "Playback continues on the next disc");
});

test("a set is edited as one album and saved per disc", async () => {
  const p = setPage();
  await p.click({"[data-edit-album]": {dataset: {editAlbum: "71,72,73"}}});
  assert.equal(p.run("editing.set"), true);
  assert.equal(p.run("editing.bulk"), false);
  const html = p.nodes.get("#editor-content").innerHTML;
  assert.match(html, /ONE ALBUM \/ ALL 3 DISCS/);
  assert.doesNotMatch(html, /name="disc"/, "One disc number for every disc would break the set");
  assert.match(html, /name="year"[^>]*placeholder="Mixed: the discs differ"/);
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

test("Duplicate tracks finds albums with a title twice, and the album page marks them", async () => {
  const p = page();
  p.run(`const album = state.details.get("5"); album.tracks.push({...album.tracks[2], id: 599, title: " TEARDROP "});
    state.albums = [...state.details.values()].map(summarize); render()`);
  p.nodes.get("#filter").value = "duplicates";
  assert.deepEqual(p.json("filteredAlbums().map(a => String(a.id))"), ["5"]);
  await p.run('openAlbum("5")');
  assert.equal((p.nodes.get("#album-page").innerHTML.match(/>Duplicate</g) || []).length, 2, "Both copies are marked");
  const sets = setPage();
  sets.run(`state.details.get("72").tracks[1].title = "Part 2.1"; state.albums = [...state.details.values()].map(summarize)`);
  assert.equal(sets.json('albumShelf().find(a => a.id === "71")').duplicates, 1, "A set adds up its discs");
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
  assert.match(p.nodes.get("#album-page").innerHTML, /data-trash-start/);
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
  assert.match(p.nodes.get("#album-page").innerHTML, /← Back to Tracks/);
  await p.click({"[data-album-back]": {}});
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
  assert.equal(p.nodes.get("#audio").src, "/api/stream/101");
  assert.equal(p.run("player.album.name"), "Wish You Were Here");
  assert.equal(p.run("player.queue.length"), 5, "The rest of the album follows");
  await p.click({"[data-track-play]": {dataset: {trackPlay: "101", trackAlbum: "1"}}});
  assert.equal(p.nodes.get("#audio").paused, true, "The same track pauses");
  p.setFetch(async () => ({ok: false, status: 404, json: async () => ({error: "Unknown endpoint."})}));
  p.nodes.get("#tracks-search").value = "angel";
  await p.run("runTrackSearch()");
  assert.match(p.nodes.get("#tracks-list").innerHTML, /Restart Tagcast to search tracks/, "An older running server says what to do");
});
