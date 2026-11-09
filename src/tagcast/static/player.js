"use strict";

// Album playback for browsing and editing. Audio comes through the local server
// (/api/stream/<track>), so the iBroadcast token never reaches this page.

const player = {queue: [], index: -1, album: null, epoch: 0, pending: Promise.resolve(), randomRequest: 0, randomLoading: false, repeat: "none", shuffle: false, quality: "128", fallback: false};
const audio = $("#audio");
const playerTrackPosition = () => typeof gaplessPosition === "function" ? gaplessPosition() : Number(audio.currentTime) || 0;
const playerTrackDuration = () => typeof gaplessDuration === "function" ? gaplessDuration() : audio.duration;
const visualPlayer = {open: false, native: false, request: 0, focus: null, inert: [], artwork: null, status: null};
const playReporting = {enabled: lookup.recordPlays === true, watch: null, error: ""};
const queueActions = {trigger: null, details: null, row: null};
const nowPlayingRows = {revision: 0, entries: []};
const playerDisplay = {quality: storedPlayerDisplay("quality"), trackArtists: storedPlayerDisplay("track-artists")};
let visualPlayerMode = storedVisualPlayerMode();

// A coded browser-side error (TagcastI18n.failure) named by its full catalog key, because the
// catalog checker reads a bare code in the player, lyrics or gapless namespace as a text key.
// The message stays English for logs and tests; errorText() shows the translation.
function playbackFailure(key, params = {}) {
  return TagcastI18n.failure(key.slice("errors.".length), params);
}

function storedVisualPlayerMode() {
  try { return localStorage.getItem("tagcast-player-view") === "window" ? "window" : "fullscreen"; }
  catch { return "fullscreen"; }
}

function renderVisualPlayerButton() {
  const button = $("#player-fullscreen");
  const label = TagcastI18n.text(visualPlayer.open ? "player.visual.close"
    : visualPlayerMode === "window" ? "player.visual.openWindow" : "player.visual.openFullscreen");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-pressed", String(visualPlayer.open));
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${visualPlayer.open
    ? 'M8 3v5H3M16 3v5h5M3 16h5v5M21 16h-5v5'
    : 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'}"/></svg>`;
}

// The status line of the large view keeps how to render its text, so a language change
// rewrites it without repeating whatever set it. Null clears the line.
function setVisualPlayerStatus(render = null) {
  visualPlayer.status = render;
  $("#visual-player-status").textContent = render ? render() : "";
}

function setVisualPlayerMode(mode) {
  if (!["window", "fullscreen"].includes(mode)) return;
  visualPlayerMode = mode;
  try { localStorage.setItem("tagcast-player-view", mode); } catch { /* private window */ }
  renderVisualPlayerButton();
}

function storedPlayerDisplay(key) {
  try { return localStorage.getItem(`tagcast-player-${key}`) !== "hidden"; }
  catch { return true; }
}

function setPlayerDisplay(key, visible) {
  if (key === "quality") playerDisplay.quality = visible;
  else if (key === "track-artists") playerDisplay.trackArtists = visible;
  else return;
  try { localStorage.setItem(`tagcast-player-${key}`, visible ? "shown" : "hidden"); } catch { /* private window */ }
  renderPlayerDisplay();
}

// These browser-local preferences affect only the compact player, without touching audio.
function renderPlayerDisplay() {
  const track = player.queue[player.index];
  $("#player-quality").hidden = !playerDisplay.quality;
  $("#player-track-line").hidden = !playerDisplay.trackArtists || !track
    || ((!track.artist || albumHasArtist(track.album, track.artist)) && !(track.performers?.length > 1));
}

document.addEventListener("change", event => {
  if (event.target.matches?.("[data-player-display]")) setPlayerDisplay(event.target.dataset.playerDisplay, event.target.checked);
  if (event.target.id === "player-view-mode") setVisualPlayerMode(event.target.value);
});
renderVisualPlayerButton();

function applyPlaybackSettings(data) {
  if (data.stream_quality) lookup.streamQuality = data.stream_quality;
  if (typeof applyQueueSettings === "function" && Object.hasOwn(data, "queue_sync")) applyQueueSettings(data);
  const enabled = data.record_plays === true;
  if (enabled === playReporting.enabled) return;
  playReporting.enabled = enabled;
  playReporting.watch = null; playReporting.error = "";
  if (typeof resetRecentlyPlayed === "function") {
    resetRecentlyPlayed(); updateRecentlyPlayedControls();
    if (!enabled && state.screen === "recently-played") { showScreen("artists"); renderArtistBrowse(); }
    else renderRecentlyPlayed();
  }
  // Enabling midway through a song starts a fresh listening interval, without restarting audio.
  if (enabled && !audio.paused && !audio.seeking) beginPlaybackWatch(true);
}

function beginPlaybackWatch(active = false) {
  const track = player.queue[player.index];
  playReporting.watch = null;
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) return;
  if (!playReporting.enabled || !live() || state.loading || !track || !state.connection.playback_session) return;
  playReporting.watch = {browser: typeof queueSync !== "undefined" ? queueSync.browser : "", trackId: track.id, session: state.connection.playback_session,
    details: state.details, eventId: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`,
    startedAt: new Date().toISOString(), listened: 0, attempted: false, completed: false, active,
    clock: performance.now(), position: playerTrackPosition(), rate: audio.playbackRate || 1};
}

function playbackWatchCurrent(watch) {
  return watch && playReporting.enabled && live() && !state.loading && watch.details === state.details
    && watch.session === state.connection.playback_session;
}

function samplePlayback() {
  const watch = playReporting.watch;
  if (!playbackWatchCurrent(watch)) { playReporting.watch = null; return; }
  const clock = performance.now(), position = playerTrackPosition();
  // Count actual progress, bounded by elapsed listening time. Seek jumps and pauses
  // never turn currentTime into listening time, and a stalled stream adds nothing.
  if (watch.active && !audio.seeking) {
    watch.listened += Math.max(0, Math.min((clock - watch.clock) / 1000,
      (position - watch.position) / watch.rate));
  }
  watch.clock = clock; watch.position = position; watch.rate = audio.playbackRate || 1;
  if (watch.listened <= 10 || watch.attempted) return;
  watch.attempted = true; // never repeat an uncertain request or a later timeupdate
  api("/api/play", {track_id: watch.trackId, event_id: watch.eventId, session: watch.session,
    played_at: watch.startedAt, listened: watch.listened, browser: watch.browser}).then(result => {
    if (result.status === "disabled" && playbackWatchCurrent(watch)) {
      lookup.recordPlays = false; applyPlaybackSettings({record_plays: false});
    }
    if (result.status === "unconfirmed") throw playbackFailure("errors.player.play_unconfirmed");
  }).catch(error => {
    if (!playbackWatchCurrent(watch)) return;
    if (!playReporting.error) toast(TagcastI18n.text("player.recording.failed", {error: TagcastI18n.errorText(error)}));
    playReporting.error = error.message;
  });
}

audio.addEventListener("playing", () => {
  if (!playReporting.watch || playReporting.watch.completed) beginPlaybackWatch();
  const watch = playReporting.watch;
  if (watch) { watch.clock = performance.now(); watch.position = playerTrackPosition(); watch.active = true; }
});
audio.addEventListener("timeupdate", () => { if (typeof gaplessAdvance === "function") gaplessAdvance(); samplePlayback(); });
audio.addEventListener("ratechange", samplePlayback);
for (const name of ["pause", "waiting"]) audio.addEventListener(name, () => {
  samplePlayback(); if (playReporting.watch) playReporting.watch.active = false;
});
audio.addEventListener("stalled", samplePlayback); // network stalls can occur while buffered audio still plays
audio.addEventListener("seeking", () => { if (playReporting.watch) playReporting.watch.active = false; });
audio.addEventListener("seeked", () => {
  const watch = playReporting.watch;
  if (watch) { watch.clock = performance.now(); watch.position = playerTrackPosition(); watch.active = !audio.paused; }
});
audio.addEventListener("emptied", () => { if (!player.fallback) playReporting.watch = null; });

// The existing audio element stays in place; fullscreen changes only the presentation.
function renderVisualPlayer() {
  if (!visualPlayer.open) return;
  const track = player.queue[player.index], album = track?.album;
  if (!track) return;
  $("#visual-player-title").textContent = track.title;
  $("#visual-player-artist").innerHTML = albumArtistEntries(album).map(a => `<button type="button" class="text-action" data-visual-artist="${escapeHtml(a.name)}">${escapeHtml(a.name)}</button>`).join(' <span aria-hidden="true">·</span> ');
  $("#visual-player-album").innerHTML = `<button type="button" class="text-action" data-visual-album="${escapeHtml(album.id)}">${escapeHtml(album.name)}</button>`;
  const performer = $("#visual-player-track-artist");
  renderVisualPlayerLabels();
  performer.hidden = !track.artist || albumHasArtist(album, track.artist);
  $("#visual-player-placeholder").textContent = initials(album.artist);
  const art = $("#visual-player-art");
  // Load large artwork only in this explicit view, once per cover. Playback events
  // must not retry a failed large image or undo its fallback to the original URL.
  const artwork = album.artwork || "";
  if (visualPlayer.artwork !== artwork) {
    visualPlayer.artwork = artwork;
    art.hidden = !artwork;
    if (artwork) art.src = largeArtworkUrl(artwork); else art.removeAttribute("src");
  }
  if (typeof renderPlaybackLyrics === "function") renderPlaybackLyrics();
  if (typeof renderVisualDisc === "function") renderVisualDisc();
  if (typeof syncMusicVisualization === "function") syncMusicVisualization();
}

// Interface text of the open large view only: artwork, lyrics and playback stay untouched.
function renderVisualPlayerLabels() {
  const track = player.queue[player.index];
  if (!visualPlayer.open || !track) return;
  $("#player-stage").setAttribute("aria-label", TagcastI18n.text("player.nowPlaying.heading"));
  $("#visual-player-track-artist").textContent = TagcastI18n.text("player.visual.trackArtist", {artist: track.artist});
  const next = player.repeat === "track" ? track : player.queue[player.index + 1]
    || (player.repeat === "queue" ? player.queue.find(entry => !entry.upNext) : null);
  $("#visual-player-context").textContent = TagcastI18n.text(next ? "player.visual.contextNext" : "player.visual.context",
    {position: player.index + 1, count: player.queue.length, title: next?.title || ""});
}

function hideVisualPlayer() {
  if (typeof closeCoverLightbox === "function") closeCoverLightbox();
  if (!visualPlayer.open) return;
  visualPlayer.open = false; visualPlayer.native = false; visualPlayer.request += 1;
  if (typeof syncMusicVisualization === "function") syncMusicVisualization();
  if (typeof renderVisualDisc === "function") renderVisualDisc();
  if (typeof suspendPlaybackLyrics === "function") suspendPlaybackLyrics();
  visualPlayer.artwork = null;
  $("#visual-player-art").removeAttribute("src");
  if (typeof renderLyricsCoverBackground === "function") renderLyricsCoverBackground();
  $("#visual-player").hidden = true;
  document.body.classList.remove("visual-player-open");
  $("#player-stage").removeAttribute("role");
  $("#player-stage").removeAttribute("aria-modal");
  $("#player-stage").removeAttribute("aria-label");
  for (const [node, inert] of visualPlayer.inert) node.inert = inert;
  visualPlayer.inert = [];
  $("#player-fullscreen").setAttribute("aria-expanded", "false");
  renderVisualPlayerButton();
  if (typeof syncNowPlayingPage === "function") syncNowPlayingPage();
  if (typeof placePlayerExtras === "function") placePlayerExtras();
  const target = $("#player").hidden ? $("#home") : visualPlayer.focus || $("#player-fullscreen");
  target.focus();
}

async function closeVisualPlayer() {
  if (document.fullscreenElement === $("#player-stage")) {
    try { await document.exitFullscreen(); }
    catch { setVisualPlayerStatus(() => TagcastI18n.text("player.visual.escapeFullscreen")); return; }
  }
  hideVisualPlayer();
}

function openVisualPlayer() {
  if (visualPlayer.open || !live() || !player.queue[player.index] || document.querySelector("dialog[open]")) return;
  const stage = $("#player-stage"), request = ++visualPlayer.request;
  visualPlayer.open = true;
  visualPlayer.focus = document.activeElement;
  setNowPlaying(false);
  if (typeof setSidebarMenu === "function") setSidebarMenu(false);
  visualPlayer.inert = [$("main"), $(".sidebar"), $("#now-playing-panel")].map(node => [node, node.inert]);
  for (const [node] of visualPlayer.inert) node.inert = true;
  stage.setAttribute("role", "dialog"); stage.setAttribute("aria-modal", "true");
  stage.setAttribute("aria-label", TagcastI18n.text("player.nowPlaying.heading"));
  document.body.classList.add("visual-player-open");
  $("#visual-player").hidden = false;
  setVisualPlayerStatus(null);
  $("#player-fullscreen").setAttribute("aria-expanded", "true");
  renderVisualPlayerButton();
  renderVisualPlayer();
  if (typeof placePlayerExtras === "function") placePlayerExtras();
  if (typeof applyVisualizer === "function") applyVisualizer();
  $("#visual-player-close").focus();
  // Some browsers do not support or permit native fullscreen. The window view still works.
  if (visualPlayerMode === "fullscreen" && stage.requestFullscreen && !document.fullscreenElement) {
    try {
      Promise.resolve(stage.requestFullscreen()).then(() => {
        if (!visualPlayer.open && document.fullscreenElement === stage) closeVisualPlayer();
      }).catch(() => {
        if (request === visualPlayer.request && visualPlayer.open) setVisualPlayerStatus(() => TagcastI18n.text("player.visual.windowFallback"));
      });
    } catch { setVisualPlayerStatus(() => TagcastI18n.text("player.visual.windowFallback")); }
  }
}

$("#player-fullscreen").addEventListener("click", () => visualPlayer.open ? closeVisualPlayer() : openVisualPlayer());
$("#visual-player-close").addEventListener("click", closeVisualPlayer);
$("#visual-player-art").addEventListener("error", () => {
  if (!visualPlayer.open || !visualPlayer.artwork) return;
  const art = $("#visual-player-art");
  if (art.getAttribute("src") !== visualPlayer.artwork) {
    art.src = visualPlayer.artwork; return;
  }
  art.hidden = true;
});
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === $("#player-stage")) {
    visualPlayer.native = true;
    if (!visualPlayer.open) closeVisualPlayer();
  } else if (visualPlayer.native) { visualPlayer.native = false; hideVisualPlayer(); }
});
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || !visualPlayer.open || document.querySelector("dialog[open]")) return;
  if (event.key === "Escape") { closeVisualPlayer(); return; }
  if (event.key !== "Tab") return;
  const controls = [...$("#player-stage").querySelectorAll('button:not([disabled]), input:not([disabled]), audio, a[href], [tabindex="0"]')].filter(node => node.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

function performerLinks(track, additionalOnly = false) {
  const people = track.performers?.length ? track.performers : [{id: String(track.artist_id || track.artistId || ""), name: track.artist}];
  return people.slice(additionalOnly ? 1 : 0).map((p, i) => `${i || additionalOnly ? '<span aria-hidden="true"> · </span>' : ""}${p.id ? `<button type="button" class="text-action performer-link" data-performer-id="${escapeHtml(p.id)}" title="${TagcastI18n.html("player.artist.openTracks", {artist: p.name})}">${escapeHtml(p.name)}</button>` : escapeHtml(p.name)}`).join("");
}

function queueTracks(album, tracks = album.tracks) {
  const source = {id: album.id, name: album.name, artist: album.artist, artist_id: album.artist_id || 0, year: album.year || 0, album_artists: albumArtistEntries(album), artwork: album.artwork, color: album.color || "#839e8d"};
  return tracks.map(t => ({id: String(t.id), title: t.title, artist: t.artist, artistId: t.artist_id, performers: t.performers || [],
    composers: [...(t.composers || [])], year: t.year || 0, format: t.format || "", rating: t.rating || 0, length: t.length || 0, album: source}));
}

function playTracks(album, startId, shuffle = false, options = {}) {
  if (!live() || !album.tracks.length) return;
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast(TagcastI18n.text("player.queue.useDevices")); return; }
  cancelRandomPlay();
  player.epoch += 1;
  player.shuffle = shuffle;
  player.queue = queueTracks(album);
  if (typeof gaplessAlbumQueue === "function") gaplessAlbumQueue(player.queue, !shuffle && !options.random);
  if (shuffle) for (let i = player.queue.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [player.queue[i], player.queue[j]] = [player.queue[j], player.queue[i]];
  }
  player.index = shuffle ? 0 : Math.max(0, player.queue.findIndex(t => t.id === String(startId)));
  playCurrent();
}

function updateRandomControls() {
  const albums = $("#albums-random"), browse = $("#browse-random");
  const unavailable = !live() || state.loading || player.randomLoading;
  albums.hidden = !["", "all"].includes($("#filter").value) || state.selected.size > 0;
  albums.disabled = unavailable || !filteredAlbums().some(a => a.track_count > 0);
  browse.hidden = browseView.key === null || ["upload-folders", "uploaded"].includes(browseView.kind);
  browse.disabled = unavailable || !browseAlbums().some(a => a.track_count > 0);
  for (const button of [albums, browse]) button.setAttribute("aria-busy", String(player.randomLoading));
  renderRandomLabels();
}

function renderRandomLabels() {
  const label = TagcastI18n.text(player.randomLoading ? "player.random.loading" : "player.random.play");
  for (const button of [$("#albums-random"), $("#browse-random")]) button.textContent = label;
}

function cancelRandomPlay() {
  player.randomRequest += 1;
  player.randomLoading = false;
  updateRandomControls();
}

async function playRandomAlbum(albums) {
  if (!live() || state.loading || player.randomLoading) return;
  const eligible = albums.filter(a => a.track_count > 0);
  // Avoid the current album when there is another choice; count disc sets once.
  const alternatives = eligible.filter(a => !itemIds(a).includes(String(player.album?.id)));
  const choices = alternatives.length ? alternatives : eligible;
  if (!choices.length) return;
  const selected = choices[Math.floor(Math.random() * choices.length)];
  const ids = shelfIds(selected.id), details = state.details;
  const request = ++player.randomRequest, epoch = ++player.epoch;
  player.randomLoading = true; updateRandomControls();
  try {
    const discs = await albumDetails(ids);
    if (request !== player.randomRequest || epoch !== player.epoch || details !== state.details || !live()) return;
    if (discs.length !== ids.length || !state.albums.some(a => String(a.id) === String(selected.id))) throw playbackFailure("errors.player.album_unavailable");
    const album = joinDiscs(discs);
    if (!album.tracks.length) throw playbackFailure("errors.player.album_empty");
    playTracks(album, undefined, false, {random: true});
    toast(TagcastI18n.text("player.random.playing", {album: album.name, artist: album.artist}));
  } catch (error) {
    if (request === player.randomRequest && details === state.details) toast(TagcastI18n.text("player.random.failed", {error: TagcastI18n.errorText(error)}));
  } finally {
    if (request === player.randomRequest) { player.randomLoading = false; updateRandomControls(); }
  }
}

$("#albums-random").addEventListener("click", () => {
  if (!$("#albums-random").hidden) return playRandomAlbum(filteredAlbums());
});
$("#browse-random").addEventListener("click", () => playRandomAlbum(browseAlbums()));

// An album of several discs plays as one album, disc after disc.
function playableAlbum(id) {
  const discs = shelfIds(id).map(i => state.details.get(i));
  return discs.every(Boolean) ? joinDiscs(discs) : state.details.get(String(id));
}

function playCurrent(autoPlay = true) {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast(TagcastI18n.text("player.devices.playback")); return; }
  const track = player.queue[player.index];
  if (!track) return;
  player.resumePending = false;
  player.album = track.album;
  if (visualPlayer.open) setVisualPlayerStatus(null);
  player.quality = lookup.streamQuality || "128";
  if (!state.connection.premium && player.quality !== "128") player.quality = "128";
  player.fallback = false;
  const prepared = typeof gaplessBegin === "function" && gaplessBegin(track, autoPlay);
  if (!prepared) {
    audio.src = `/api/stream/${encodeURIComponent(track.id)}?quality=${player.quality}`;
    const offset = typeof gaplessTrial !== "undefined" ? gaplessTrial.offset : 0;
    if (typeof gaplessTrial !== "undefined") gaplessTrial.offset = 0;
    if (offset) audio.addEventListener("loadedmetadata", () => { if (player.queue[player.index] === track) audio.currentTime = Math.min(offset, audio.duration || offset); }, {once: true});
    if (autoPlay) { beginPlaybackWatch(); audio.play().catch(() => { /* reported by the error event */ }); }
    else playReporting.watch = null;
  }
  renderCurrentPlayerTrack();
}

function renderCurrentPlayerTrack() {
  const track = player.queue[player.index]; if (!track) return;
  player.album = track.album; renderStreamQuality();
  $("#player").hidden = false; document.body.classList.add("has-player");
  $("#player-title").textContent = track.title;
  const artist = $("#player-artist"), album = $("#player-album");
  artist.textContent = player.album.artist; artist.title = player.album.artist;
  $("#player-additional-album-artists").innerHTML = albumArtistEntries(player.album).slice(1).map(a => ` · <button type="button" data-artist="${escapeHtml(a.name)}">${escapeHtml(a.name)}</button>`).join("");
  const performer = $("#player-track-artist");
  performer.textContent = track.artist; performer.title = track.artist;
  renderPlayerDisplay();
  album.textContent = player.album.name; album.title = player.album.name;
  renderPlayerTrackLabels();
  const art = $("#player-art");
  art.hidden = !player.album.artwork; if (player.album.artwork) art.src = player.album.artwork.replace(/-300$/, "-150");
  $("#player-prev").disabled = player.index === 0;
  $("#player-next").disabled = player.index >= player.queue.length - 1;
  markPlaying();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
}

// Interface text around the current track's metadata. Names stay exactly as stored.
function renderPlayerTrackLabels() {
  const track = player.queue[player.index];
  if (!track || !player.album) return;
  $("#player-artist").setAttribute("aria-label", TagcastI18n.text("player.artist.openAlbums", {artist: player.album.artist}));
  $("#player-track-artist").setAttribute("aria-label", TagcastI18n.text("player.artist.openTracks", {artist: track.artist}));
  $("#player-album").setAttribute("aria-label", TagcastI18n.text("player.album.open", {album: player.album.name}));
  const extra = $("#player-extra-artists"), focused = document.activeElement?.closest?.("#player-extra-artists [data-performer-id]")?.dataset.performerId;
  extra.innerHTML = performerLinks(track, true);
  if (focused !== undefined) [...extra.querySelectorAll("[data-performer-id]")].find(node => node.dataset.performerId === focused)?.focus({preventScroll: true});
}

function markPlaying() {
  if (typeof saveQueueMemory === "function") saveQueueMemory();
  if (typeof gaplessQueueChanged === "function") gaplessQueueChanged();
  if (typeof syncSystemPlayback === "function") syncSystemPlayback();
  if (typeof scheduleQueuePublish === "function") scheduleQueuePublish();
  const current = player.queue[player.index]?.id;
  for (const row of document.querySelectorAll("[data-row]")) {
    const playing = !audio.paused && row.dataset.row === current;
    row.classList.toggle("playing", playing);
    if (playing) row.setAttribute?.("aria-current", "true"); else row.removeAttribute?.("aria-current");
  }
  $("#player-prev").disabled = player.index <= 0;
  $("#player-next").disabled = player.index >= player.queue.length - 1;
  $("#player-queue-count").textContent = String(Math.max(0, player.queue.length - player.index - 1));
  renderNowPlaying();
  renderVisualPlayer();
  if (typeof placePlayerExtras === "function") placePlayerExtras();
  if (typeof publishMiniPlayer === "function") publishMiniPlayer();
}

// A language change re-renders the open panel the same way a play/pause update does:
// no queue, index, audio or focus change. The other player labels are rewritten from
// memory; nothing reloads artwork, prepares audio or publishes the queue.
TagcastI18n.subscribe(() => {
  renderVisualPlayerButton(); renderRepeatButton();
  if (typeof browseView !== "undefined") renderRandomLabels();
  if (player.queue[player.index]) { renderPlayerTrackLabels(); renderStreamQuality(); }
  renderVisualPlayerLabels();
  if (visualPlayer.open && visualPlayer.status) setVisualPlayerStatus(visualPlayer.status);
  if (typeof repaintWithoutLyricsRequests === "function") repaintWithoutLyricsRequests(renderNowPlaying);
  else renderNowPlaying();
});

function nowPlayingFocusTarget() {
  return state.screen === "now-playing" ? $("#now-playing-heading") : $("#now-playing-close");
}

function setNowPlaying(open) {
  if (!open && queueActions.row) closeQueueActions();
  $("#now-playing-panel").hidden = !open;
  document.body.classList.toggle("now-playing-open", open && state.screen !== "now-playing");
  $("#player-queue").setAttribute("aria-expanded", String(open));
  if (open) { renderNowPlaying(); nowPlayingFocusTarget().focus(); }
  if (typeof placePlayerExtras === "function") placePlayerExtras();
}

function renderNowPlaying() {
  if ($("#now-playing-panel").hidden) return;
  const list = $("#now-playing-list"), active = document.activeElement;
  const focused = queueActions.row && $("#queue-action-menu").contains?.(active) ? queueActions.trigger : active;
  if (queueActions.row) closeQueueActions();
  const focusedRow = focused?.closest?.("[data-queue-position]");
  const focusedIndex = focusedRow ? Number(focusedRow.dataset.queuePosition)
    : focused?.closest?.("#now-playing-list") ? Number(focused.dataset.queueRemove ?? focused.dataset.queueIndex) : -1;
  const focusedEntry = nowPlayingRows.entries[focusedIndex];
  const focusedAction = focused?.dataset.queueRow !== undefined ? "queueRow" : null;
  const lyricsOpen = $("#now-playing-current").querySelector(".listening-lyrics")?.open;
  const removeFocused = focused?.dataset.queueRemove !== undefined;
  const editable = live() && (typeof localPlaybackAllowed !== "function" || localPlaybackAllowed());
  nowPlayingRows.revision += 1;
  nowPlayingRows.entries = player.queue.slice();
  const track = player.queue[player.index], album = track?.album;
  $("#now-playing-close").hidden = state.screen === "now-playing";
  const page = state.screen === "now-playing", title = listeningTitleParts(track?.title || "");
  const emptyPage = page && !player.queue.length;
  $("#now-playing-panel").classList.toggle("listening-empty", emptyPage);
  $("#listening-lyrics-slot").hidden = page && !track;
  $(".queue-heading").hidden = emptyPage;
  $(".now-playing-footer").hidden = emptyPage;
  list.hidden = emptyPage;
  $("#now-playing-heading-title").textContent = page ? track ? title.title : TagcastI18n.text("player.nowPlaying.heading") : "";
  $("#now-playing-edition").textContent = page && track ? title.edition : "";
  $("#now-playing-edition").hidden = !page || !title.edition;
  $("#now-playing-current").innerHTML = track ? `<div class="now-playing-cover">${cover(album)}</div>
    <div class="now-playing-info">${page ? "" : `<h3>${escapeHtml(track.title)}</h3>`}<p class="now-playing-artist">${page && track.artist !== album.artist ? performerLinks(track) : albumArtistLinks(album)}</p>
    <p class="listening-album"><button class="text-action" data-album="${escapeHtml(album.id)}">${escapeHtml(album.name)}</button>${page && album.artist !== track.artist ? ` <span aria-hidden="true"> · </span><span class="listening-album-artist">${albumArtistLinks(album)}</span>` : ""}</p>
    ${page ? listeningTrackMetadata(track) : ""}<div id="listening-meter" class="listening-meter" hidden role="img" aria-label="${TagcastI18n.html("listening.meter.label")}"></div>
    <div class="now-playing-track-actions">${page ? `<button class="button small" data-listening-edit="${escapeHtml(track.id)}" data-listening-album="${escapeHtml(album.id)}" ${!live() || state.loading ? "disabled" : ""}>${TagcastI18n.html("listening.track.edit")}</button>` : ""}<button class="button small" data-playlist-track="${escapeHtml(track.id)}" data-playlist-source="${escapeHtml(album.id)}">${TagcastI18n.html(page ? "listening.track.playlist" : "player.nowPlaying.addToPlaylist")}</button></div></div><details class="listening-lyrics" ${!page ? "open" : ""}><summary>${TagcastI18n.html("page.visualPlayer.lyrics")}</summary><section id="now-playing-lyrics" class="track-lyrics" hidden></section></details>` : emptyPage ? listeningEmptyState() : `<p class="empty">${TagcastI18n.html(player.queue.length ? "player.nowPlaying.chooseQueued" : "player.nowPlaying.empty")}</p>`;
  if (lyricsOpen) { const details = $("#now-playing-current").querySelector(".listening-lyrics"); if (details) details.open = true; }
  if (typeof renderListeningExtras === "function") renderListeningExtras(track, focused);
  if (state.screen !== "now-playing") renderLyrics("player", lyricsSelection(track));
  $("#now-playing-count").textContent = page && track ? TagcastI18n.text("listening.queue.position", {position: player.index + 1, count: player.queue.length}) : TagcastI18n.text("player.queue.count", {count: player.queue.length});
  $("#queue-clear").disabled = !player.queue.length;
  list.innerHTML = player.queue.map((t, index) => `<li class="queue-row${editable ? " queue-editable" : ""}${index === player.index && !audio.paused ? " playing" : ""}${index === player.index ? " queue-current" : ""}" data-queue-position="${index}"><button type="button" class="queue-track ${index === player.index ? "current" : ""}" data-queue-index="${index}" ${index === player.index ? 'aria-current="true"' : ""}>
    <span class="queue-number" aria-hidden="true">${index === player.index ? audio.paused ? "Ⅱ" : '<span class="queue-playing-icon">▶</span><span class="queue-playing-bars"></span>' : index + 1}</span><span class="queue-art" aria-hidden="true">${cover(t.album, true)}</span><span class="queue-label"><strong>${escapeHtml(t.title)}</strong><small>${TagcastI18n.html(t.upNext ? "player.queue.rowDetailsUpNext" : "player.queue.rowDetails", {artist: t.artist, album: t.album.name})}</small></span><span class="queue-time">${trackDuration(t.length)}</span></button><button type="button" class="queue-row-more" data-queue-album="${escapeHtml(t.album.id)}" data-queue-track="${escapeHtml(t.id)}" data-queue-row="${index}" data-queue-revision="${nowPlayingRows.revision}" aria-haspopup="menu" aria-controls="queue-action-menu" aria-expanded="false" aria-label="${TagcastI18n.html("player.queueMenu.moreLabel", {title: t.title})}" ${!live() || state.loading ? "disabled" : ""}>⋯</button></li>`).join("");
  if (focusedEntry) {
    const index = player.queue.indexOf(focusedEntry);
    const attribute = focusedAction?.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
    if (index >= 0) (attribute ? list.querySelector(`[data-queue-position="${index}"] [data-${attribute}]`)
      : list.querySelector(`[data-queue-${removeFocused ? "remove" : "index"}="${index}"]`))?.focus({preventScroll: true});
  }
}

function removeQueueEntry(index, revision) {
  if (!live() || $("#now-playing-panel").hidden || revision !== nowPlayingRows.revision
      || !Number.isInteger(index) || index < 0 || index >= player.queue.length
      || player.queue[index] !== nowPlayingRows.entries[index]) return;
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) return;
  const current = index === player.index, wasPlaying = !audio.paused && !audio.ended;
  const removed = player.queue.splice(index, 1)[0];
  if (index < player.index) player.index -= 1;
  if (current) {
    audio.pause();
    if (player.queue[index]) playCurrent(wasPlaying);
    else if (player.queue.length) { player.index = player.queue.length - 1; playCurrent(false); }
    else stopPlayer();
  } else markPlaying();
  const next = Math.min(index, player.queue.length - 1);
  (next >= 0 ? $("#now-playing-list").querySelector(`[data-queue-remove="${next}"]`)
    : nowPlayingFocusTarget())?.focus({preventScroll: true});
  toast(TagcastI18n.text("player.queue.removed", {title: removed.title}));
}

function appendToQueue(album, trackId = null, next = false) {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast(TagcastI18n.text("player.queue.useDevices")); return; }
  const tracks = trackId === null ? album.tracks : album.tracks.filter(t => String(t.id) === String(trackId));
  if (!tracks.length) throw TagcastI18n.failure("queue.track_missing");
  const empty = !player.queue.length, ended = audio.ended, idle = !player.queue[player.index];
  const following = Math.min(player.index + 1, player.queue.length), rows = queueTracks(album, tracks);
  if (next && !empty && !ended && !idle) {
    let insert = following;
    while (player.queue[insert]?.upNext) insert += 1;
    player.queue.splice(insert, 0, ...rows.map(t => ({...t, upNext: true})));
  } else player.queue.push(...rows);
  if (empty || ended || idle) { player.index = empty ? 0 : following; playCurrent(); }
  else markPlaying();
  toast(TagcastI18n.text(next ? "player.queue.playingNext" : "player.queue.added", {count: tracks.length}));
}

function addToQueue(albumId, trackId = null, next = false) {
  if (!live() || state.loading) return Promise.resolve();
  const epoch = player.epoch, details = state.details;
  // Preserve click order even when different album details finish loading out of order.
  const task = player.pending.then(async () => {
    if (epoch !== player.epoch || details !== state.details || !live()) return;
    try {
      if (!state.albums.some(a => String(a.id) === String(albumId))) throw TagcastI18n.failure("queue.album_missing");
      await albumDetails(shelfIds(albumId));
      if (epoch !== player.epoch || details !== state.details || !live()) return;
      const album = playableAlbum(albumId);
      if (!album) throw TagcastI18n.failure("queue.album_unloaded");
      appendToQueue(album, trackId, next);
    } catch (error) {
      if (epoch === player.epoch && details === state.details) toast(TagcastI18n.text("player.queue.addFailed", {error: TagcastI18n.errorText(error)}));
    }
  });
  player.pending = task;
  return task;
}

function queueButton(albumId, track = null, compact = false, plainLabel = false) {
  const label = track ? TagcastI18n.html("player.queueMenu.trackLabel", {title: track.title}) : TagcastI18n.html("player.queueMenu.albumLabel");
  return `<button type="button" class="queue-add ${compact ? "queue-compact" : track ? "" : "button small"} queue-menu-trigger" data-queue-album="${escapeHtml(albumId)}" ${track ? `data-queue-track="${escapeHtml(track.id)}"` : ""} aria-label="${label}" title="${label}" aria-haspopup="menu" aria-expanded="false" aria-controls="queue-action-menu" ${!live() || state.loading ? "disabled" : ""}>${compact ? '<svg class="queue-plus" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9"/></svg>' : `<span aria-hidden="true">${track ? "+" : TagcastI18n.html(plainLabel ? "player.queueMenu.button" : "player.queueMenu.buttonAdd")}</span>`}<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="m3 4.5 3 3 3-3"/></svg></button>`;
}

function albumCardActions(album) {
  const label = TagcastI18n.html("player.album.play", {album: album.name});
  return `<div class="album-card-actions"><button type="button" class="album-card-play" data-card-play="${escapeHtml(album.id)}" aria-label="${label}" title="${label}" ${!live() || state.loading || !album.track_count ? "disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12 8l-7 4.5z"/></svg></button>${queueButton(album.id, null, true)}</div>`;
}

async function playCardAlbum(id) {
  if (!live() || state.loading || !state.albums.some(a => String(a.id) === String(id))) return;
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast(TagcastI18n.text("player.queue.useDevices")); return; }
  cancelRandomPlay();
  const details = state.details, epoch = ++player.epoch, ids = shelfIds(id);
  try {
    const discs = await albumDetails(ids);
    if (epoch !== player.epoch || details !== state.details || !live()) return;
    if (discs.length !== ids.length || !state.albums.some(a => String(a.id) === String(id))) throw playbackFailure("errors.player.album_unavailable");
    const album = joinDiscs(discs);
    if (!album.tracks.length) throw playbackFailure("errors.player.album_empty");
    playTracks(album);
  } catch (error) {
    if (epoch === player.epoch && details === state.details) toast(TagcastI18n.text("player.album.playFailed", {error: TagcastI18n.errorText(error)}));
  }
}

function closeQueueActions(restoreFocus = false) {
  const trigger = queueActions.trigger;
  $("#queue-action-menu").hidden = true;
  queueActions.trigger = null; queueActions.details = null; queueActions.row = null;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openQueueActions(trigger, last = false) {
  if (typeof closeAlbumActions === "function") closeAlbumActions();
  const same = queueActions.trigger === trigger;
  closeQueueActions();
  if (same || trigger.disabled || !live() || state.loading) return;
  const menu = $("#queue-action-menu");
  let row = null;
  if (trigger.dataset.queueRow !== undefined) {
    const index = Number(trigger.dataset.queueRow), revision = Number(trigger.dataset.queueRevision);
    if (!Number.isInteger(index) || index < 0 || revision !== nowPlayingRows.revision
        || !player.queue[index] || player.queue[index] !== nowPlayingRows.entries[index]) return;
    row = {index, revision, entry: player.queue[index]};
  }
  queueActions.trigger = trigger; queueActions.details = state.details;
  queueActions.row = row;
  trigger.setAttribute("aria-expanded", "true");
  $("#queue-action-playlist").hidden = trigger.dataset.queueTrack === undefined;
  for (const id of ["tags", "like", "dislike", "remove"]) $("#queue-action-" + id).hidden = !row;
  if (row) {
    const rating = Number(row.entry.rating) || 0;
    $("#queue-action-remove").textContent = TagcastI18n.text("player.queue.removeTitle");
    $("#queue-action-remove").setAttribute("aria-label", TagcastI18n.text("player.queue.remove", {title: row.entry.title, position: row.index + 1}));
    $("#queue-action-remove").disabled = typeof localPlaybackAllowed === "function" && !localPlaybackAllowed();
    $("#queue-action-tags").textContent = TagcastI18n.text("tags.track.manageTitle");
    $("#queue-action-like").textContent = TagcastI18n.text(rating >= 5 ? "player.queueMenu.unlike" : "player.queueMenu.like");
    $("#queue-action-dislike").textContent = TagcastI18n.text(rating === 1 ? "player.queueMenu.clearDislike" : "player.queueMenu.dislike");
    for (const id of ["like", "dislike"]) $("#queue-action-" + id).disabled = Boolean(favourites.busy || saving || checking);
  }
  menu.hidden = false;
  // One fixed menu avoids clipping inside tables, cards and scrolling containers.
  const anchor = trigger.getBoundingClientRect(), size = menu.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  menu.style.left = `${Math.max(8, Math.min(anchor.right - size.width, width - size.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6 + size.height <= height - 8
    ? anchor.bottom + 6 : anchor.top - size.height - 6, height - size.height - 8))}px`;
  const items = queueActionItems();
  items[last ? items.length - 1 : 0]?.focus();
}

function queueActionItems() {
  return ["append", "next", "playlist", "tags", "like", "dislike", "remove"]
    .map(id => $("#queue-action-" + id)).filter(node => !node.hidden && !node.disabled);
}

function queueActionCurrent(trigger, details, row) {
  return trigger?.isConnected && !trigger.disabled && details === state.details && live() && !state.loading
    && (!row || row.revision === nowPlayingRows.revision && player.queue[row.index] === row.entry);
}

function chooseQueueAction(next) {
  const {trigger, details, row} = queueActions;
  closeQueueActions(true);
  if (!queueActionCurrent(trigger, details, row)) return;
  return addToQueue(trigger.dataset.queueAlbum, trigger.dataset.queueTrack ?? null, next);
}

$("#queue-action-append").addEventListener("click", () => chooseQueueAction(false));
$("#queue-action-next").addEventListener("click", () => chooseQueueAction(true));
$("#queue-action-playlist").addEventListener("click", () => {
  const {trigger, details, row} = queueActions;
  closeQueueActions(true);
  if (!queueActionCurrent(trigger, details, row)) return;
  return openTrackPlaylist(trigger.dataset.queueAlbum, trigger.dataset.queueTrack);
});
function chooseQueuedTrackAction(action) {
  const {trigger, details, row} = queueActions;
  closeQueueActions(true);
  if (!row || !queueActionCurrent(trigger, details, row)) return;
  const track = row.entry;
  if (action === "remove") return removeQueueEntry(row.index, row.revision);
  if (action === "tags") return openTrackTags(track.album.id, track.id);
  const rating = Number(track.rating) || 0;
  return toggleFavourite(String(track.id), rating, track.title, action === "dislike" ? rating === 1 ? 0 : 1 : null);
}
for (const action of ["tags", "like", "dislike", "remove"]) {
  $("#queue-action-" + action).addEventListener("click", () => chooseQueuedTrackAction(action));
}
$("#queue-action-menu").addEventListener("keydown", event => {
  if (event.key === "Escape" || event.key === "Tab") {
    closeQueueActions(true);
    if (event.key === "Escape") event.preventDefault();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = queueActionItems();
  if (!items.length) return;
  const index = items.indexOf(document.activeElement), delta = event.key === "ArrowUp" ? -1 : 1;
  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + delta + items.length) % items.length].focus();
});
document.addEventListener("keydown", event => {
  const trigger = event.target.closest("[data-queue-album]");
  if (trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault(); openQueueActions(trigger, event.key === "ArrowUp");
  }
});
window.addEventListener("resize", () => closeQueueActions());
document.addEventListener("scroll", event => {
  // Timed lyrics can scroll independently; only movement of the anchor invalidates this menu.
  const trigger = queueActions.trigger;
  if (trigger && (event.target === document || event.target?.contains?.(trigger))) closeQueueActions();
}, true);

function step(delta) {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) return;
  if (player.queue[player.index]?.upNext) {
    player.queue.splice(player.index, 1);
    if (delta > 0) player.index -= 1;
  }
  const next = player.index + delta;
  if (next < 0) return;
  if (next >= player.queue.length) {
    if (delta > 0 && player.repeat === "queue" && player.queue.some(t => !t.upNext)) {
      player.queue = player.queue.filter(t => !t.upNext); player.index = 0; playCurrent(); return;
    }
    player.index = player.queue.length;
    if (typeof gaplessCancel === "function") gaplessCancel();
    audio.pause(); audio.removeAttribute("src"); audio.load();
    markPlaying(); renderStreamQuality(); return;
  }
  player.index = next; playCurrent();
}

function stopPlayer() {
  if (typeof gaplessCancel === "function") gaplessCancel();
  if (typeof closePlaybackOutput === "function") closePlaybackOutput(false);
  closeQueueActions();
  playReporting.watch = null;
  cancelRandomPlay();
  player.epoch += 1; player.resumePending = false;
  audio.pause(); audio.removeAttribute("src"); audio.load();
  $("#player").hidden = true; document.body.classList.remove("has-player");
  closeVisualPlayer();
  player.queue = []; player.index = -1; player.album = null; markPlaying();
  if (typeof saveQueueMemory === "function") saveQueueMemory(true);
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
}

audio.addEventListener("ended", () => {
  if (typeof gaplessAdvance === "function") gaplessAdvance();
  samplePlayback();
  if (playReporting.watch) { playReporting.watch.active = false; playReporting.watch.completed = true; }
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) return;
  if (!player.queue[player.index] || audio.paused && !audio.ended) return;
  if (player.repeat === "track") { playCurrent(); return; }
  if (player.repeat === "queue" && player.index >= player.queue.length - 1 && player.queue.length) {
    player.queue = player.queue.filter(t => !t.upNext); player.index = 0; playCurrent();
  } else if (player.index < player.queue.length - 1 || player.queue[player.index]?.upNext) step(1);
  else markPlaying();
});
audio.addEventListener("play", markPlaying);
audio.addEventListener("pause", markPlaying);
audio.addEventListener("error", () => {
  if (typeof gaplessAudioError === "function" && gaplessAudioError()) return;
  if (!audio.getAttribute("src")) return;
  if (player.quality === "orig" && !player.fallback) {
    player.fallback = true; player.quality = "128";
    audio.src = `/api/stream/${encodeURIComponent(player.queue[player.index].id)}?quality=128`;
    renderStreamQuality(); audio.play().catch(() => {});
    toast(TagcastI18n.text("player.error.originalFallback")); return;
  }
  playReporting.watch = null;
  const title = player.queue[player.index]?.title;
  toast(title ? TagcastI18n.text("player.error.track", {title}) : TagcastI18n.text("player.error.trackUnknown"));
  if (visualPlayer.open) setVisualPlayerStatus(() => TagcastI18n.text("player.error.trackStatus"));
});
$("#player-prev").addEventListener("click", () => step(-1));
$("#player-next").addEventListener("click", () => step(1));
$("#player-close").addEventListener("click", stopPlayer);
$("#queue-clear").addEventListener("click", stopPlayer);
$("#player-queue").addEventListener("click", () => showScreen("now-playing"));
$("#player-cover-button").addEventListener("click", () => {
  if (typeof nowPlayingPreferences !== "undefined" && nowPlayingPreferences.open === "page") showScreen("now-playing");
  else setNowPlaying($("#now-playing-panel").hidden);
});
$("#now-playing-close").addEventListener("click", () => { closeNowPlayingView(); });
document.addEventListener("keydown", event => {
  if (!event.defaultPrevented && event.key === "Escape" && !$("#now-playing-panel").hidden && !document.querySelector("dialog[open]")) {
    closeNowPlayingView();
  }
});
$("#player-artist").addEventListener("click", () => {
  const artist = player.album?.artist;
  if (!artist) return;
  $("#filter").value = "all";
  setArtist(artist);
  window.scrollTo?.({top: 0});
});
$("#player-track-artist").addEventListener("click", () => {
  const track = player.queue[player.index];
  if (track) showBrowse("track-artists", String(track.artistId ?? `name:${track.artist}`));
});
$("#player-album").addEventListener("click", () => {
  if (player.album) return openAlbum(player.album.id, player.queue[player.index]?.id);
});

document.addEventListener("click", async event => {
  const artistLink = event.target.closest("[data-visual-artist]"), albumLink = event.target.closest("[data-visual-album]");
  if (artistLink || albumLink) {
    const artist = artistLink?.dataset.visualArtist, album = albumLink?.dataset.visualAlbum;
    await closeVisualPlayer();
    if (visualPlayer.open) return;
    if (artist !== undefined) setArtist(artist);
    else openAlbum(album);
    return;
  }
  const cardPlay = event.target.closest("[data-card-play]");
  if (cardPlay) return playCardAlbum(cardPlay.dataset.cardPlay);
  const queued = event.target.closest("[data-queue-album]");
  if (queued) { openQueueActions(queued); return; }
  if (!event.target.closest("#queue-action-menu")) closeQueueActions();
  const performerLink = event.target.closest("[data-performer-id]");
  if (performerLink) return showBrowse("track-artists", performerLink.dataset.performerId);
  const remove = event.target.closest("[data-queue-remove]");
  if (remove) {
    if (!remove.disabled && remove.isConnected) removeQueueEntry(Number(remove.dataset.queueRemove), Number(remove.dataset.queueRevision));
    return;
  }
  const jump = event.target.closest("[data-queue-index]");
  if (jump) {
    const index = Number(jump.dataset.queueIndex);
    if (Number.isInteger(index) && index >= 0 && index < player.queue.length && live()) {
      const removed = player.queue.slice(0, index).filter(t => t.upNext).length;
      player.queue = player.queue.filter((t, i) => !t.upNext || i >= index);
      player.index = index - removed; playCurrent();
    }
    return;
  }
  const play = event.target.closest("[data-play]");
  const shuffle = event.target.closest("[data-shuffle-album]");
  const all = event.target.closest("[data-play-album]") || shuffle;
  if (!play && !all) return;
  if (!live()) return;
  const albumId = (play || all).dataset.playAlbumId;
  const album = albumId ? playableAlbum(albumId) : event.target.closest("#editor") && editing && !editing.bulk ? joinDiscs(editing.originals) : null;
  if (!album) return;
  cancelRandomPlay();
  const id = play?.dataset.play;
  if (id && player.queue[player.index]?.id === id && player.album?.id === album.id) {
    if (audio.paused) playSystemPlayback(); else audio.pause();
    return;
  }
  playTracks(album, id || album.tracks[0]?.id, Boolean(shuffle));
});

// File format comes from metadata; streaming quality describes this playback request.
function renderStreamQuality() {
  $("#player-quality").textContent = streamQualityText(player.queue[player.index]);
  $("#visual-player-quality").textContent = $("#player-quality").textContent;
  renderPlayerDisplay();
  if (typeof updateListeningFacts === "function") updateListeningFacts();
}

function streamQualityText(track) {
  if (!track) return "";
  const stream = player.quality !== "orig" ? TagcastI18n.text("player.quality.mp3", {bitrate: player.quality})
    : track.format ? TagcastI18n.text("player.quality.originalFormat", {format: track.format}) : TagcastI18n.text("player.quality.original");
  const parts = track.format ? [TagcastI18n.text("player.quality.file", {format: track.format})] : [];
  parts.push(TagcastI18n.text(player.fallback ? "player.quality.streamFallback" : "player.quality.stream", {stream}));
  if (typeof gaplessTrial !== "undefined" && gaplessTrial.active) {
    parts.push(TagcastI18n.text("player.quality.gapless"));
    if (gaplessTrial.active.ready === false || gaplessTrial.active.seekIntent) parts.push(TagcastI18n.text("player.quality.preparing"));
  }
  return parts.join(" · ");
}

// Repeat modes are fixed codes (also set by queue sync); only their labels are translated.
const REPEAT_LABELS = {none: ["", "player.repeat.none"], queue: ["player.repeat.queueButton", "player.repeat.queue"],
  track: ["player.repeat.trackButton", "player.repeat.track"]};
function renderRepeatButton() {
  const button = $("#player-repeat"), labels = REPEAT_LABELS[player.repeat];
  if (!labels) return;
  button.textContent = labels[0] ? TagcastI18n.text(labels[0]) : "↻";
  button.setAttribute("aria-label", TagcastI18n.text(labels[1]));
  button.setAttribute("aria-pressed", String(player.repeat !== "none"));
  button.title = TagcastI18n.text("player.repeat.title");
  renderVisualPlayerLabels();
}
renderRepeatButton();
$("#player-repeat").addEventListener("click", () => {
  player.repeat = {none: "queue", queue: "track", track: "none"}[player.repeat];
  renderRepeatButton();
  if (typeof gaplessQueueChanged === "function") gaplessQueueChanged();
  if (typeof publishQueueState === "function") publishQueueState();
  if (typeof saveQueueMemory === "function") saveQueueMemory();
});

audio.addEventListener("play", () => {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) {
    audio.pause(); playReporting.watch = null;
    toast(TagcastI18n.text("player.devices.controller"));
  }
});
