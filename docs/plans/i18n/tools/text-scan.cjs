// Interface text scan in Chromium (Playwright): opens Tagcast's screens and dialogs, connected to
// tests/mock_ibroadcast.py, and records every text node and translatable attribute per scenario.
//
//   node text-scan.cjs <url> <en|nl|pseudo> <out.json> [--shots <dir>] [--width <px>] [--dark]
//
// Uses only global functions and routes that exist both before and after translations, so the
// English output of two builds can be compared scenario by scenario (text-compare.py).
const {chromium} = require("playwright");
const fs = require("fs");
const path = require("path");

const [url, mode, out] = process.argv.slice(2);
const option = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = option("--shots"), width = Number(option("--width") || 1420), dark = process.argv.includes("--dark");

const routes = ["albums", "artists", "tracks", "favourites", "album-favourites", "artist-favourites", "recently-played", "playlists",
  "downloads", "overview", "album-guide", "decades", "track-artists", "composers", "genres", "tags", "years", "upload-folders", "uploaded",
  "album/72", "album/73", "artist/Kate%20Bush", "genres/Rock"];
const settings = ["interface", "appearance", "playback", "discovery", "sources", "data", "about"];
const helpTopics = ["uploads", "downloads", "playlist-order", "lyrics-viewer", "lyrics-import", "lyrics-review", "audio-output", "album-merge",
  "tags", "duplicate-cleanup", "artists", "albums", "album", "editing", "editing-tracks", "review", "settings", "tracks", "favourites",
  "album-favourites", "artist-favourites", "playlists", "playlist", "playlist-folder", "playlist-review", "playlist-import", "playlist-cover",
  "recently-played", "overview", "guide", "guide-link"];
const scenarios = [
  ...routes.map(route => ({name: `route ${route}`, run: `location.hash = "#/${route}"`})),
  ...settings.map(category => ({name: `settings ${category}`, run: `location.hash = "#/settings/${category}"`})),
  ...helpTopics.map(topic => ({name: `help ${topic}`, run: `location.hash = "#/albums"; openHelp(${JSON.stringify(topic)})`})),
  {name: "history", run: `location.hash = "#/albums"; showHistory()`},
  {name: "connect", run: `openConnect()`},
  {name: "editor album 72", run: `location.hash = "#/album/72"; openEditor(["72"])`},
  {name: "editor tracks tab", run: `location.hash = "#/album/72"; openEditor(["72"]).then(() => setEditorTab("tracks"))`},
  {name: "cleanup", run: `location.hash = "#/albums"; openCleanup()`},
  {name: "album merge", run: `location.hash = "#/albums"; state.selected = new Set(["72", "73"]); openAlbumMerge()`},
  {name: "artwork", run: `location.hash = "#/album/72"; openArtwork({target: "album", id: "72", label: "Hounds of Love", artist: "Kate Bush"})`},
  {name: "trash review", run: `location.hash = "#/albums"; showTrashReview()`},
  {name: "playlist import", run: `location.hash = "#/playlists"; openPlaylistImport()`},
  {name: "updates", run: `openUpdateDetails()`},
  {name: "now playing", run: `location.hash = "#/album/72"; playTracks(state.details.get("72")); audio.pause(); setNowPlaying(true)`},
  {name: "sound", run: `openPlaybackOutput()`},
  {name: "visual player", run: `openVisualPlayer()`},
  {name: "lyrics viewer", run: `openLyricsViewer()`},
  {name: "selection bar", run: `location.hash = "#/albums"; state.selected = new Set(["72"]); render()`},
  {name: "playlist save", run: `location.hash = "#/album/72"; openPlaylistSave([])`},
  {name: "track to playlist", run: `location.hash = "#/album/72"; openTrackPlaylist("72", state.details.get("72").tracks[0].id)`},
  {name: "playlist folder", run: `location.hash = "#/playlists"; openPlaylistFolder("create")`},
  {name: "album tags", run: `location.hash = "#/album/72"; state.selected = new Set(["72"]); openSelectedAlbumTags()`},
  {name: "lyrics import", run: `location.hash = "#/album/72"; openAlbumLyricsImport()`},
  {name: "paused imports", run: `location.hash = "#/playlists"; openPausedImports()`},
  {name: "playlist url import", run: `location.hash = "#/playlists"; openPlaylistUrlImport()`},
  {name: "devices", run: `renderDevices(); document.querySelector("#devices-content").closest("dialog").showModal()`},
];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width, height: 900}, colorScheme: dark ? "dark" : "light"});
  await context.addInitScript(({mode}) => {
    let seed = 42; Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    try { localStorage.setItem("tagcast-language", mode === "nl" ? "nl" : "en"); } catch {}
  }, {mode});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error.message)));
  page.on("dialog", dialog => dialog.dismiss());
  await page.goto(url, {waitUntil: "load"});
  await page.waitForFunction(() => typeof state !== "undefined" && state.mode === "live" && state.albums.length > 0, null, {timeout: 20000});
  if (mode === "nl") await page.evaluate(() => fetch("/api/settings/interface", {method: "POST", headers: {"X-Tagcast": "1", "Content-Type": "application/json"}, body: JSON.stringify({language: "nl"})}));
  if (mode === "pseudo") await page.evaluate(() => TagcastI18n.usePseudo());
  await page.waitForTimeout(400);
  const result = {url, mode, width, dark, errors, scenarios: {}};
  for (const scenario of scenarios) {
    const failed = [];
    try { await page.evaluate(code => Promise.resolve(eval(code)), scenario.run); }
    catch (error) { failed.push(String(error.message).split("\n")[0]); }
    await page.waitForTimeout(350);
    const dump = await page.evaluate(() => {
      const visible = node => { const el = node.nodeType === 1 ? node : node.parentElement; if (!el) return false;
        const box = el.getBoundingClientRect(); return el.checkVisibility?.({visibilityProperty: true}) !== false && box.width > 0 && box.height > 0; };
      const where = el => { const owner = el.closest("[id]"); return owner ? `#${owner.id}` : el.tagName.toLowerCase(); };
      const texts = [], attrs = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue.replace(/\s+/g, " ").trim();
        if (!text || ["SCRIPT", "STYLE", "TEMPLATE"].includes(node.parentElement?.tagName)) continue;
        texts.push({text, at: where(node.parentElement), visible: visible(node)});
      }
      for (const el of document.body.querySelectorAll("*")) {
        for (const name of ["aria-label", "title", "placeholder", "alt", "aria-description", "aria-valuetext"]) {
          const value = el.getAttribute(name);
          if (value && value.trim()) attrs.push({name, text: value.replace(/\s+/g, " ").trim(), at: where(el), visible: visible(el)});
        }
      }
      const overflow = [...document.querySelectorAll("button, .button, label, th, h1, h2, h3, summary, .pill, .badge, [role=tab]")]
        .filter(el => visible(el) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2) && getComputedStyle(el).overflow !== "visible")
        .map(el => ({text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 80), at: where(el)}));
      return {texts, attrs, overflow, lang: document.documentElement.lang, title: document.title};
    });
    result.scenarios[scenario.name] = {...dump, failed};
    if (shots) {
      fs.mkdirSync(shots, {recursive: true});
      await page.screenshot({path: path.join(shots, `${scenario.name.replace(/[^a-z0-9]+/gi, "-")}.png`), fullPage: false});
    }
    await page.evaluate(() => { for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close(); try { setNowPlaying(false); } catch {} });
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`${Object.keys(result.scenarios).length} scenarios, ${errors.length} page errors`);
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
