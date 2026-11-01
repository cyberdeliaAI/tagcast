"use strict";

// Display-only lyrics. Online consent is profile-local; text never enters the editor.
const playbackLyricsView = {mode: storedPlaybackLyricsMode(), open: false, key: "", request: 0,
  details: null, controller: null, timeout: null, cache: new Map(), data: null, active: -1,
  following: true, loading: false, frame: 0, lineNodes: [], wordNodes: [], highlighted: new Set(),
  hasWords: false, coverBackground: storedCoverLyricsBackground()};

function storedCoverLyricsBackground() {
  try { return localStorage.getItem("tagcast-now-playing-cover-background") === "true"; }
  catch { return false; }
}

function storedPlaybackLyricsMode() {
  try {
    const mode = localStorage.getItem("tagcast-now-playing-lyrics");
    return ["native", "native-first", "unison-first"].includes(mode) ? mode : "native";
  } catch { return "native"; }
}

function playbackLyricsSettings() {
  const options = [["native", "iBroadcast only · no online lookup"],
    ["native-first", "iBroadcast first · Unison → LRCLIB fallback"], ["unison-first", "Unison → LRCLIB first · iBroadcast fallback"]];
  return `<section class="player-display-settings" data-settings-category="playback"><h3>Now playing lyrics <span class="settings-mode">Immediate · this browser</span></h3>
    <label class="field"><span>Preferred lyrics source</span><select id="playback-lyrics-mode">${options.map(([key, label]) => `<option value="${key}" ${playbackLyricsView.mode === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <p class="muted">Open the large Now playing view and choose Lyrics. An online option checks Unison first, then LRCLIB only if no matching lyrics are found. The current song’s title, track artist, album and duration are sent while that view is open. No account details or audio are sent. The LRCLIB switch under Sources &amp; keys also applies here.</p>
    <p class="muted">Timed lyrics highlight the current line, with a moving underline for words or syllables when available. Ordinary text remains readable without synchronisation. Online results stay temporarily in memory; they are never saved to iBroadcast, music files or the lyrics editor. Existing iBroadcast lyrics keep their usual cache and editing behaviour.</p>
    <label class="checkline"><input type="checkbox" id="playback-lyrics-cover-background" ${playbackLyricsView.coverBackground ? "checked" : ""}> Use cover colours behind Now playing</label>
    <p class="muted">Adds a softened cover background to the large Now playing view. Off by default. Your theme stays unchanged elsewhere.</p></section>`;
}

function renderLyricsCoverBackground() {
  const stage = $("#visual-player"), art = $("#visual-player-art");
  const active = playbackLyricsView.coverBackground && visualPlayer.open && !art.hidden
    && art.complete && art.naturalWidth > 0;
  stage.classList.toggle("cover-atmosphere", Boolean(active));
  if (active) stage.style.setProperty("--lyrics-cover-image", `url(${JSON.stringify(art.currentSrc || art.src)})`);
  else stage.style.removeProperty("--lyrics-cover-image");
}

function suspendPlaybackLyrics() {
  stopPlaybackLyricsFrame();
  playbackLyricsView.request += 1;
  playbackLyricsView.controller?.abort(); playbackLyricsView.controller = null;
  clearTimeout(playbackLyricsView.timeout); playbackLyricsView.timeout = null;
  playbackLyricsView.key = ""; playbackLyricsView.loading = false;
}

function resetPlaybackLyrics() {
  suspendPlaybackLyrics();
  playbackLyricsView.cache.clear(); playbackLyricsView.data = null;
  playbackLyricsView.details = null; playbackLyricsView.active = -1;
  playbackLyricsView.lineNodes = []; playbackLyricsView.wordNodes = [];
  playbackLyricsView.highlighted.clear(); playbackLyricsView.hasWords = false;
  $("#visual-lyrics-lines").innerHTML = "";
  $("#visual-lyrics-source").textContent = "";
  $("#visual-lyrics-message").textContent = "";
}

function setPlaybackLyricsMode(mode) {
  if (!["native", "native-first", "unison-first"].includes(mode)) return;
  playbackLyricsView.mode = mode;
  try { localStorage.setItem("tagcast-now-playing-lyrics", mode); } catch { /* private window */ }
  resetPlaybackLyrics(); renderPlaybackLyrics();
}

function playbackLyricsCurrent(selection, request, details) {
  return request === playbackLyricsView.request && details === state.details
    && playbackLyricsView.open && visualPlayer.open && !document.hidden
    && lyricsKey(lyricsSelection(player.queue[player.index])) === lyricsKey(selection);
}

function playbackLyricsPublicKey(selection) {
  return lyricsKey([selection, lookup.sources.find(source => source.name === "lrclib")?.enabled !== false]);
}

async function readUnisonDisplay(selection, request, details) {
  const key = playbackLyricsPublicKey(selection), cached = playbackLyricsView.cache.get(key);
  if (cached && performance.now() < cached.until) return cached.data;
  const controller = new AbortController(); playbackLyricsView.controller = controller;
  playbackLyricsView.timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("/api/lyrics/display", {method: "POST", signal: controller.signal,
      headers: {"Content-Type": "application/json", "X-Tagcast": "1"},
      body: JSON.stringify({...selection, enabled: true,
        fallback_lrclib: lookup.sources.find(source => source.name === "lrclib")?.enabled !== false})});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Online lyrics could not be checked.");
    if (!playbackLyricsCurrent(selection, request, details)) return null;
    if (!Array.isArray(data.lines) || data.lines.length > 2000) throw Error("Invalid lyrics response.");
    playbackLyricsView.cache.set(key, {data, until: performance.now() + 300000});
    while (playbackLyricsView.cache.size > 12) playbackLyricsView.cache.delete(playbackLyricsView.cache.keys().next().value);
    return data;
  } finally {
    // A late request must never cancel the timeout/controller of its replacement.
    if (playbackLyricsView.controller === controller) {
      clearTimeout(playbackLyricsView.timeout); playbackLyricsView.timeout = null;
      playbackLyricsView.controller = null;
    }
  }
}

async function readNativeDisplay(selection, entry) {
  if (!entry.data && !entry.error) await loadTrackLyrics(selection, entry);
  if (entry.loading && entry.pending) await entry.pending;
  if (entry.error) throw Error("iBroadcast lyrics could not be checked.");
  const text = entry.data?.native_text || "";
  const lines = text.split(/\r?\n/);
  if (lines.length > 2000) throw Error("This iBroadcast text has too many lines for this view.");
  return {status: text.trim() ? "ready" : "missing", source: "ibroadcast", timed: false,
    lines: text.trim() ? lines.map(text => ({start: null, end: null, text})) : []};
}

async function loadPlaybackLyrics(selection, entry, request, details) {
  const mode = playbackLyricsView.mode, errors = [];
  const order = mode === "unison-first" ? ["unison", "ibroadcast"]
    : mode === "native-first" ? ["ibroadcast", "unison"] : ["ibroadcast"];
  let result = null, instrumental = false;
  for (const source of order) {
    if (!playbackLyricsCurrent(selection, request, details)) return;
    try {
      result = source === "unison" ? await readUnisonDisplay(selection, request, details)
        : await readNativeDisplay(selection, entry);
      if (!playbackLyricsCurrent(selection, request, details)) return;
      if (result?.status === "ready") break;
      if (result?.source === "lrclib" && result.status === "instrumental") instrumental = true;
    } catch (error) {
      if (!playbackLyricsCurrent(selection, request, details)) return;
      errors.push(source === "unison" ? error.message || "Online lyrics could not be checked." : error.message);
    }
  }
  if (!playbackLyricsCurrent(selection, request, details)) return;
  playbackLyricsView.loading = false;
  playbackLyricsView.data = result?.status === "ready" ? result : null;
  $("#visual-lyrics-message").textContent = result?.status === "ready"
    ? [result.timed ? result.lines.some(line => playbackLyricWords(line).length)
      ? "Word-timed lyrics follow the current track." : "Lyrics follow the current track."
      : "Text lyrics · no timing available.", ...errors].join(" ")
    : errors.length ? `${errors.join(" ")} You can check again.`
      : instrumental ? "LRCLIB marks this recording as instrumental."
      : mode === "native" ? "No lyrics stored in iBroadcast. Enable an online option in Settings → Playback for Unison and LRCLIB lyrics."
        : "No matching lyrics found for this recording.";
  $("#visual-lyrics-retry").hidden = !errors.length;
  paintPlaybackLyrics();
}

function renderPlaybackLyrics() {
  const view = playbackLyricsView;
  renderLyricsCoverBackground();
  $("#visual-player-lyrics-toggle").setAttribute("aria-pressed", String(view.open));
  $("#visual-player-lyrics").hidden = !view.open;
  $(".visual-player-content").classList.toggle("lyrics-visible", view.open);
  if (!view.open || !visualPlayer.open || document.hidden) return;
  const selection = lyricsSelection(player.queue[player.index]);
  if (!selection) { resetPlaybackLyrics(); return; }
  // Initialise the shared native cache before capturing this display request's revision.
  const entry = lyricsEntry(selection);
  const key = lyricsKey([selection, view.mode]);
  if (key === view.key && view.details === state.details) { syncPlaybackLyrics(); return; }
  suspendPlaybackLyrics();
  view.key = key; view.details = state.details; view.data = null;
  view.active = -1; view.following = true; view.loading = true;
  view.lineNodes = []; view.wordNodes = []; view.highlighted.clear(); view.hasWords = false;
  $("#visual-lyrics-lines").innerHTML = "";
  $("#visual-lyrics-source").textContent = "";
  $("#visual-lyrics-follow").hidden = true; $("#visual-lyrics-retry").hidden = true;
  $("#visual-lyrics-message").textContent = "Checking lyrics…";
  void loadPlaybackLyrics(selection, entry, view.request, state.details);
}

function paintPlaybackLyrics() {
  const view = playbackLyricsView, data = view.data, region = $("#visual-lyrics-lines");
  view.hasWords = false; view.highlighted.clear();
  region.innerHTML = data ? data.lines.map((line, i) => {
    const words = data.timed ? playbackLyricWords(line) : [];
    if (words.length) view.hasWords = true;
    const text = words.length ? words.map((word, j) =>
      `<span class="visual-lyric-word" data-lyric-word="${j}">${escapeHtml(word.text)}</span>`).join("")
      : escapeHtml(line.text || (data.timed ? "♪" : "\u00a0"));
    return `<p class="visual-lyric-line" data-lyric-line="${i}">${text}</p>`;
  }).join("") : "";
  view.lineNodes = Array.from(region.querySelectorAll("[data-lyric-line]"));
  view.wordNodes = view.lineNodes.map(line => Array.from(line.querySelectorAll("[data-lyric-word]")));
  const publicSources = {unison: ["Unison", "https://unison.boidu.dev/"], lrclib: ["LRCLIB", "https://lrclib.net/"]};
  const source = publicSources[data?.source];
  $("#visual-lyrics-source").innerHTML = source
    ? `<a href="${source[1]}" target="_blank" rel="noopener noreferrer">Lyrics from ${source[0]} ↗</a> · Temporary display`
    : data ? "Lyrics saved in iBroadcast" : "";
  syncPlaybackLyrics(true);
}

function playbackLyricWords(line) {
  const words = line.words;
  return Array.isArray(words) && words.length <= 1000
    && words.every(word => typeof word.text === "string" && Number.isFinite(word.start)
      && Number.isFinite(word.end) && line.start <= word.start && word.start <= word.end && word.end <= line.end)
    && words.map(word => word.text).join("") === line.text ? words : [];
}

function playbackWordProgress(word, position) {
  if (position < word.start) return 0;
  if (word.end <= word.start || position >= word.end) return 1;
  return (position - word.start) / (word.end - word.start);
}

function stopPlaybackLyricsFrame() {
  if (playbackLyricsView.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(playbackLyricsView.frame);
  playbackLyricsView.frame = 0;
}

function playbackLyricIndex(lines, position) {
  let selected = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= position && position < lines[i].end) selected = i;
  }
  return selected;
}

function syncPlaybackLyrics(force = false) {
  const view = playbackLyricsView;
  if (!view.open || !visualPlayer.open || document.hidden || !view.data?.timed) {
    stopPlaybackLyricsFrame(); return;
  }
  const position = playerTrackPosition(), lines = view.data.lines;
  const active = playbackLyricIndex(lines, position), previous = view.active;
  view.active = active;
  const region = $("#visual-lyrics-lines"), highlighted = new Set();
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  lines.forEach((line, i) => { if (line.start <= position && position < line.end) highlighted.add(i); });
  for (const i of new Set([...view.highlighted, ...highlighted])) {
    const node = view.lineNodes[i];
    if (!node) continue;
    if (highlighted.has(i)) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
    for (const [j, wordNode] of view.wordNodes[i].entries()) {
      const word = lines[i].words[j], progress = reducedMotion ? (position >= word.start ? 100 : 0)
        : Math.round(playbackWordProgress(word, position) * 100);
      wordNode.style.setProperty("--lyric-progress", `${progress}%`);
    }
  }
  view.highlighted = highlighted;
  const node = view.lineNodes[active];
  if (node && view.following && (force || active !== previous)) {
    region.scrollTop = Math.max(0, node.offsetTop - region.offsetTop - region.clientHeight / 3);
  }
  // Only the visible word-timed view animates, using the existing track clock.
  // No audio graph, second player, network polling or timer-based track clock.
  if (view.hasWords && !reducedMotion && !audio.paused && !audio.ended && typeof requestAnimationFrame === "function") {
    if (!view.frame) view.frame = requestAnimationFrame(() => { view.frame = 0; syncPlaybackLyrics(); });
  } else {
    stopPlaybackLyricsFrame();
  }
}

$("#visual-player-lyrics-toggle").addEventListener("click", () => {
  playbackLyricsView.open = !playbackLyricsView.open;
  if (!playbackLyricsView.open) suspendPlaybackLyrics();
  renderPlaybackLyrics();
});
$("#visual-lyrics-follow").addEventListener("click", () => {
  playbackLyricsView.following = true; $("#visual-lyrics-follow").hidden = true; syncPlaybackLyrics(true);
});
$("#visual-lyrics-retry").addEventListener("click", () => {
  const selection = lyricsSelection(player.queue[player.index]);
  if (selection) {
    const entry = lyricsEntry(selection);
    if (entry.error) entry.error = "";
    playbackLyricsView.cache.delete(playbackLyricsPublicKey(selection));
  }
  suspendPlaybackLyrics(); renderPlaybackLyrics();
});
function pauseLyricsFollowing() {
  if (!playbackLyricsView.data?.timed) return;
  playbackLyricsView.following = false; $("#visual-lyrics-follow").hidden = false;
}
for (const name of ["wheel", "touchstart", "pointerdown"]) $("#visual-lyrics-lines").addEventListener(name, pauseLyricsFollowing, {passive: true});
$("#visual-lyrics-lines").addEventListener("keydown", event => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
    pauseLyricsFollowing(); event.stopPropagation();
  }
});
document.addEventListener("change", event => {
  if (event.target.id === "playback-lyrics-mode") setPlaybackLyricsMode(event.target.value);
  if (event.target.id === "playback-lyrics-cover-background") {
    playbackLyricsView.coverBackground = event.target.checked;
    try { localStorage.setItem("tagcast-now-playing-cover-background", String(event.target.checked)); } catch { /* private window */ }
    renderLyricsCoverBackground();
  }
});
for (const name of ["load", "error"]) $("#visual-player-art").addEventListener(name, () => {
  // Artwork's existing fallback handler runs first; retain the theme on missing covers.
  Promise.resolve().then(renderLyricsCoverBackground);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) suspendPlaybackLyrics(); else renderPlaybackLyrics();
});
for (const name of ["timeupdate", "seeking", "seeked", "loadedmetadata", "play", "pause", "ended", "ratechange"]) $("#audio").addEventListener(name, () => {
  // Let the existing gapless boundary handler update its track-relative position first.
  Promise.resolve().then(() => syncPlaybackLyrics());
});
