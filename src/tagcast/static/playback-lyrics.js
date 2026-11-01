"use strict";

// Display-only lyrics. Online consent is profile-local; text never enters the editor.
const playbackLyricsView = {mode: storedPlaybackLyricsMode(), open: false, key: "", request: 0,
  details: null, controller: null, timeout: null, cache: new Map(), data: null, active: -1,
  following: true, loading: false, coverBackground: storedCoverLyricsBackground()};

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
    ["native-first", "iBroadcast first · Unison fallback"], ["unison-first", "Unison first · iBroadcast fallback"]];
  return `<section class="player-display-settings" data-settings-category="playback"><h3>Now playing lyrics <span class="settings-mode">Immediate · this browser</span></h3>
    <label class="field"><span>Preferred lyrics source</span><select id="playback-lyrics-mode">${options.map(([key, label]) => `<option value="${key}" ${playbackLyricsView.mode === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <p class="muted">Open the large Now playing view and choose Lyrics. Selecting a Unison option enables automatic online lookup while that lyrics view is open: the current song’s title, track artist, album and duration are sent to Unison. No account details or audio are sent.</p>
    <p class="muted">Timed lyrics highlight the current line. Ordinary text remains readable without synchronisation. Unison results stay temporarily in memory; they are never saved to iBroadcast, music files or the lyrics editor. Existing iBroadcast lyrics keep their usual cache and editing behaviour.</p>
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
  playbackLyricsView.request += 1;
  playbackLyricsView.controller?.abort(); playbackLyricsView.controller = null;
  clearTimeout(playbackLyricsView.timeout); playbackLyricsView.timeout = null;
  playbackLyricsView.key = ""; playbackLyricsView.loading = false;
}

function resetPlaybackLyrics() {
  suspendPlaybackLyrics();
  playbackLyricsView.cache.clear(); playbackLyricsView.data = null;
  playbackLyricsView.details = null; playbackLyricsView.active = -1;
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

async function readUnisonDisplay(selection, request, details) {
  const key = lyricsKey(selection), cached = playbackLyricsView.cache.get(key);
  if (cached && performance.now() < cached.until) return cached.data;
  const controller = new AbortController(); playbackLyricsView.controller = controller;
  playbackLyricsView.timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("/api/lyrics/display", {method: "POST", signal: controller.signal,
      headers: {"Content-Type": "application/json", "X-Tagcast": "1"},
      body: JSON.stringify({...selection, enabled: true})});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Unison could not be checked.");
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
  let result = null;
  for (const source of order) {
    if (!playbackLyricsCurrent(selection, request, details)) return;
    try {
      result = source === "unison" ? await readUnisonDisplay(selection, request, details)
        : await readNativeDisplay(selection, entry);
      if (!playbackLyricsCurrent(selection, request, details)) return;
      if (result?.status === "ready") break;
    } catch (error) {
      if (!playbackLyricsCurrent(selection, request, details)) return;
      errors.push(source === "unison" ? "Unison could not be checked." : error.message);
    }
  }
  if (!playbackLyricsCurrent(selection, request, details)) return;
  playbackLyricsView.loading = false;
  playbackLyricsView.data = result?.status === "ready" ? result : null;
  $("#visual-lyrics-message").textContent = result?.status === "ready"
    ? [result.timed ? "Lyrics follow the current track." : "Text lyrics · no timing available.", ...errors].join(" ")
    : errors.length ? `${errors.join(" ")} You can check again.`
      : mode === "native" ? "No lyrics stored in iBroadcast. Enable a Unison option in Settings → Playback for online lyrics."
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
  $("#visual-lyrics-lines").innerHTML = "";
  $("#visual-lyrics-source").textContent = "";
  $("#visual-lyrics-follow").hidden = true; $("#visual-lyrics-retry").hidden = true;
  $("#visual-lyrics-message").textContent = "Checking lyrics…";
  void loadPlaybackLyrics(selection, entry, view.request, state.details);
}

function paintPlaybackLyrics() {
  const data = playbackLyricsView.data;
  $("#visual-lyrics-lines").innerHTML = data ? data.lines.map((line, i) =>
    `<p class="visual-lyric-line" data-lyric-line="${i}">${escapeHtml(line.text || (data.timed ? "♪" : "\u00a0"))}</p>`).join("") : "";
  $("#visual-lyrics-source").innerHTML = data?.source === "unison"
    ? '<a href="https://unison.boidu.dev/" target="_blank" rel="noopener noreferrer">Lyrics from Unison ↗</a> · Temporary display'
    : data ? "Lyrics saved in iBroadcast" : "";
  syncPlaybackLyrics(true);
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
  if (!view.open || !visualPlayer.open || document.hidden || !view.data?.timed) return;
  const active = playbackLyricIndex(view.data.lines, playerTrackPosition());
  if (!force && active === view.active) return;
  view.active = active;
  const region = $("#visual-lyrics-lines");
  for (const line of region.querySelectorAll("[data-lyric-line]")) {
    if (Number(line.dataset.lyricLine) === active) {
      line.setAttribute("aria-current", "true");
      if (view.following) region.scrollTop = Math.max(0, line.offsetTop - region.offsetTop - region.clientHeight / 3);
    } else line.removeAttribute("aria-current");
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
    playbackLyricsView.cache.delete(lyricsKey(selection));
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
for (const name of ["timeupdate", "seeked", "loadedmetadata"]) $("#audio").addEventListener(name, () => {
  // Let the existing gapless boundary handler update its track-relative position first.
  Promise.resolve().then(() => syncPlaybackLyrics());
});
