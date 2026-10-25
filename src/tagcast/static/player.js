"use strict";

// Album playback for browsing and editing. Audio comes through the local server
// (/api/stream/<track>), so the iBroadcast token never reaches this page.

const player = {queue: [], index: -1, album: null, epoch: 0, pending: Promise.resolve(), randomRequest: 0, randomLoading: false, repeat: "none", shuffle: false, quality: "128", fallback: false};
const audio = $("#audio");
const playerTrackPosition = () => typeof gaplessPosition === "function" ? gaplessPosition() : Number(audio.currentTime) || 0;
const playerTrackDuration = () => typeof gaplessDuration === "function" ? gaplessDuration() : audio.duration;
const visualPlayer = {open: false, native: false, request: 0, focus: null, inert: [], artwork: null};
const playReporting = {enabled: lookup.recordPlays === true, watch: null, error: ""};
const queueActions = {trigger: null, details: null};
const nowPlayingRows = {revision: 0, entries: []};
const playerDisplay = {quality: storedPlayerDisplay("quality"), trackArtists: storedPlayerDisplay("track-artists")};
let visualPlayerMode = storedVisualPlayerMode();

function storedVisualPlayerMode() {
  try { return localStorage.getItem("tagcast-player-view") === "window" ? "window" : "fullscreen"; }
  catch { return "fullscreen"; }
}

function renderVisualPlayerButton() {
  const button = $("#player-fullscreen");
  const label = visualPlayer.open ? "Close Now playing view"
    : visualPlayerMode === "window" ? "Open Now playing in app window" : "Open fullscreen Now playing";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
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
    if (result.status === "unconfirmed") throw Error("The play could not be confirmed and will not be retried automatically.");
  }).catch(error => {
    if (!playbackWatchCurrent(watch)) return;
    if (!playReporting.error) toast(`Playback recording: ${error.message}`);
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
  $("#visual-player-artist").textContent = albumArtistsText(album);
  $("#visual-player-album").textContent = album.name;
  const performer = $("#visual-player-track-artist");
  performer.textContent = `Track artist: ${track.artist}`;
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
}

function hideVisualPlayer() {
  if (typeof closeCoverLightbox === "function") closeCoverLightbox();
  if (!visualPlayer.open) return;
  visualPlayer.open = false; visualPlayer.native = false; visualPlayer.request += 1;
  visualPlayer.artwork = null;
  $("#visual-player-art").removeAttribute("src");
  $("#visual-player").hidden = true;
  document.body.classList.remove("visual-player-open");
  $("#player-stage").removeAttribute("role");
  $("#player-stage").removeAttribute("aria-modal");
  $("#player-stage").removeAttribute("aria-label");
  for (const [node, inert] of visualPlayer.inert) node.inert = inert;
  visualPlayer.inert = [];
  $("#player-fullscreen").setAttribute("aria-expanded", "false");
  renderVisualPlayerButton();
  const target = $("#player").hidden ? $("#home") : visualPlayer.focus || $("#player-fullscreen");
  target.focus();
}

async function closeVisualPlayer() {
  if (document.fullscreenElement === $("#player-stage")) {
    try { await document.exitFullscreen(); }
    catch { $("#visual-player-status").textContent = "Use Escape to leave fullscreen."; return; }
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
  stage.setAttribute("aria-label", "Now playing");
  document.body.classList.add("visual-player-open");
  $("#visual-player").hidden = false;
  $("#visual-player-status").textContent = "";
  $("#player-fullscreen").setAttribute("aria-expanded", "true");
  renderVisualPlayerButton();
  renderVisualPlayer(); $("#visual-player-close").focus();
  // Some browsers do not support or permit native fullscreen. The window view still works.
  if (visualPlayerMode === "fullscreen" && stage.requestFullscreen && !document.fullscreenElement) {
    try {
      Promise.resolve(stage.requestFullscreen()).then(() => {
        if (!visualPlayer.open && document.fullscreenElement === stage) closeVisualPlayer();
      }).catch(() => {
        if (request === visualPlayer.request && visualPlayer.open) $("#visual-player-status").textContent = "Fullscreen view in this window. Press Escape to return.";
      });
    } catch { $("#visual-player-status").textContent = "Fullscreen view in this window. Press Escape to return."; }
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
  const controls = [...$("#player-stage").querySelectorAll('button:not([disabled]), input:not([disabled]), audio')].filter(node => node.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

function performerLinks(track, additionalOnly = false) {
  const people = track.performers?.length ? track.performers : [{id: String(track.artist_id || track.artistId || ""), name: track.artist}];
  return people.slice(additionalOnly ? 1 : 0).map((p, i) => `${i || additionalOnly ? '<span aria-hidden="true"> · </span>' : ""}${p.id ? `<button type="button" class="text-action performer-link" data-performer-id="${escapeHtml(p.id)}" title="Open albums with tracks by ${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>` : escapeHtml(p.name)}`).join("");
}

function queueTracks(album, tracks = album.tracks) {
  const source = {id: album.id, name: album.name, artist: album.artist, artist_id: album.artist_id || 0, album_artists: albumArtistEntries(album), artwork: album.artwork, color: album.color || "#839e8d"};
  return tracks.map(t => ({id: String(t.id), title: t.title, artist: t.artist, artistId: t.artist_id, performers: t.performers || [],
    format: t.format || "", rating: t.rating || 0, length: t.length || 0, album: source}));
}

function playTracks(album, startId, shuffle = false, options = {}) {
  if (!live() || !album.tracks.length) return;
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast("Use Devices to control the connected queue."); return; }
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
  browse.hidden = browseView.key === null;
  browse.disabled = unavailable || !browseAlbums().some(a => a.track_count > 0);
  for (const button of [albums, browse]) {
    button.textContent = player.randomLoading ? "Loading album…" : "▶ Play random album";
    button.setAttribute("aria-busy", String(player.randomLoading));
  }
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
    if (discs.length !== ids.length || !state.albums.some(a => String(a.id) === String(selected.id))) throw Error("This album is no longer available. Reload the library.");
    const album = joinDiscs(discs);
    if (!album.tracks.length) throw Error("This album has no playable tracks.");
    playTracks(album, undefined, false, {random: true});
    toast(`Playing ${album.name} · ${album.artist}`);
  } catch (error) {
    if (request === player.randomRequest && details === state.details) toast(`Could not play a random album: ${error.message}`);
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
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast("Use Devices to control playback on the connected device."); return; }
  const track = player.queue[player.index];
  if (!track) return;
  player.album = track.album;
  if (visualPlayer.open) $("#visual-player-status").textContent = "";
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
  artist.setAttribute("aria-label", `Open albums by ${player.album.artist}`);
  const performer = $("#player-track-artist");
  performer.textContent = track.artist; performer.title = track.artist;
  performer.setAttribute("aria-label", `Open albums with tracks by ${track.artist}`);
  $("#player-extra-artists").innerHTML = performerLinks(track, true);
  renderPlayerDisplay();
  album.textContent = player.album.name; album.title = player.album.name;
  album.setAttribute("aria-label", `Open album ${player.album.name}`);
  const art = $("#player-art");
  art.hidden = !player.album.artwork; if (player.album.artwork) art.src = player.album.artwork.replace(/-300$/, "-150");
  $("#player-prev").disabled = player.index === 0;
  $("#player-next").disabled = player.index >= player.queue.length - 1;
  markPlaying();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
}

function markPlaying() {
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
}

function setNowPlaying(open) {
  $("#now-playing-panel").hidden = !open;
  document.body.classList.toggle("now-playing-open", open);
  $("#player-queue").setAttribute("aria-expanded", String(open));
  if (open) { renderNowPlaying(); $("#now-playing-close").focus(); }
}

function renderNowPlaying() {
  if ($("#now-playing-panel").hidden) return;
  const list = $("#now-playing-list"), focused = document.activeElement;
  const focusedIndex = focused?.closest?.("#now-playing-list")
    ? Number(focused.dataset.queueRemove ?? focused.dataset.queueIndex) : -1;
  const focusedEntry = nowPlayingRows.entries[focusedIndex];
  const removeFocused = focused?.dataset.queueRemove !== undefined;
  const editable = live() && (typeof localPlaybackAllowed !== "function" || localPlaybackAllowed());
  nowPlayingRows.revision += 1;
  nowPlayingRows.entries = player.queue.slice();
  const track = player.queue[player.index], album = track?.album;
  $("#now-playing-current").innerHTML = track ? `<div class="now-playing-cover">${cover(album)}</div>
    <h3>${escapeHtml(track.title)}</h3><p class="muted">${performerLinks(track)}</p>
    <button class="text-action" data-album="${escapeHtml(album.id)}">${escapeHtml(album.name)}</button><p><button class="button small" data-playlist-track="${escapeHtml(track.id)}" data-playlist-source="${escapeHtml(album.id)}">Add this track to playlist…</button></p><section id="now-playing-lyrics" class="track-lyrics" hidden></section>` : player.queue.length ? '<p class="empty">Choose a queued track to start playing.</p>' : '<p class="empty">Play a track or add an album to your queue.</p>';
  renderLyrics("player", lyricsSelection(track));
  $("#now-playing-count").textContent = `${player.queue.length} ${player.queue.length === 1 ? "track" : "tracks"}`;
  $("#queue-clear").disabled = !player.queue.length;
  list.innerHTML = player.queue.map((t, index) => `<li class="queue-row${editable ? " queue-editable" : ""}"><button type="button" class="queue-track ${index === player.index ? "current" : ""}" data-queue-index="${index}" ${index === player.index ? 'aria-current="true"' : ""}>
    <span class="queue-number" aria-hidden="true">${index === player.index ? audio.paused ? "Ⅱ" : "▶" : index + 1}</span><span class="queue-label"><strong>${escapeHtml(t.title)}</strong><small>${t.upNext ? "Up next · " : ""}${escapeHtml(t.artist)} · ${escapeHtml(t.album.name)}</small></span><span class="queue-time">${trackDuration(t.length)}</span></button>${editable ? `<button type="button" class="queue-remove" data-queue-remove="${index}" data-queue-revision="${nowPlayingRows.revision}" aria-label="Remove ${escapeHtml(t.title)} from play queue, position ${index + 1}" title="Remove from play queue"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>` : ""}</li>`).join("");
  if (focusedEntry) {
    const index = player.queue.indexOf(focusedEntry);
    if (index >= 0) list.querySelector(`[data-queue-${removeFocused ? "remove" : "index"}="${index}"]`)?.focus({preventScroll: true});
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
    : $("#now-playing-close"))?.focus({preventScroll: true});
  toast(`Removed “${removed.title}” from the play queue.`);
}

function appendToQueue(album, trackId = null, next = false) {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast("Use Devices to control the connected queue."); return; }
  const tracks = trackId === null ? album.tracks : album.tracks.filter(t => String(t.id) === String(trackId));
  if (!tracks.length) throw Error("This track is no longer on that album. Reload the library.");
  const empty = !player.queue.length, ended = audio.ended;
  const following = Math.min(player.index + 1, player.queue.length), rows = queueTracks(album, tracks);
  if (next && !empty && !ended) {
    let insert = following;
    while (player.queue[insert]?.upNext) insert += 1;
    player.queue.splice(insert, 0, ...rows.map(t => ({...t, upNext: true})));
  } else player.queue.push(...rows);
  if (empty || ended || !player.queue[player.index]) { player.index = empty ? 0 : following; playCurrent(); }
  else markPlaying();
  toast(`${next ? "Playing next:" : "Added"} ${tracks.length === 1 ? "1 track" : `${tracks.length} tracks`} to the queue.`);
}

function addToQueue(albumId, trackId = null, next = false) {
  if (!live() || state.loading) return Promise.resolve();
  const epoch = player.epoch, details = state.details;
  // Preserve click order even when different album details finish loading out of order.
  const task = player.pending.then(async () => {
    if (epoch !== player.epoch || details !== state.details || !live()) return;
    try {
      if (!state.albums.some(a => String(a.id) === String(albumId))) throw Error("This album is no longer in your library.");
      await albumDetails(shelfIds(albumId));
      if (epoch !== player.epoch || details !== state.details || !live()) return;
      const album = playableAlbum(albumId);
      if (!album) throw Error("The album could not be loaded.");
      appendToQueue(album, trackId, next);
    } catch (error) {
      if (epoch === player.epoch && details === state.details) toast(`Could not add to queue: ${error.message}`);
    }
  });
  player.pending = task;
  return task;
}

function queueButton(albumId, track = null, compact = false, plainLabel = false) {
  const label = track ? `Queue actions for ${track.title}` : "Queue actions for this album";
  return `<button type="button" class="queue-add ${compact ? "queue-compact" : track ? "" : "button small"} queue-menu-trigger" data-queue-album="${escapeHtml(albumId)}" ${track ? `data-queue-track="${escapeHtml(track.id)}"` : ""} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-haspopup="menu" aria-expanded="false" aria-controls="queue-action-menu" ${!live() || state.loading ? "disabled" : ""}>${compact ? '<svg class="queue-plus" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9"/></svg>' : `<span aria-hidden="true">${track ? "+" : plainLabel ? "Queue" : "+ Queue"}</span>`}<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="m3 4.5 3 3 3-3"/></svg></button>`;
}

function albumCardActions(album) {
  const label = `Play album ${album.name}`;
  return `<div class="album-card-actions"><button type="button" class="album-card-play" data-card-play="${escapeHtml(album.id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${!live() || state.loading || !album.track_count ? "disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12 8l-7 4.5z"/></svg></button>${queueButton(album.id, null, true)}</div>`;
}

async function playCardAlbum(id) {
  if (!live() || state.loading || !state.albums.some(a => String(a.id) === String(id))) return;
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) { toast("Use Devices to control the connected queue."); return; }
  cancelRandomPlay();
  const details = state.details, epoch = ++player.epoch, ids = shelfIds(id);
  try {
    const discs = await albumDetails(ids);
    if (epoch !== player.epoch || details !== state.details || !live()) return;
    if (discs.length !== ids.length || !state.albums.some(a => String(a.id) === String(id))) throw Error("This album is no longer available. Reload the library.");
    const album = joinDiscs(discs);
    if (!album.tracks.length) throw Error("This album has no playable tracks.");
    playTracks(album);
  } catch (error) {
    if (epoch === player.epoch && details === state.details) toast(`Could not play album: ${error.message}`);
  }
}

function closeQueueActions(restoreFocus = false) {
  const trigger = queueActions.trigger;
  $("#queue-action-menu").hidden = true;
  queueActions.trigger = null; queueActions.details = null;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openQueueActions(trigger, last = false) {
  if (typeof closeAlbumActions === "function") closeAlbumActions();
  const same = queueActions.trigger === trigger;
  closeQueueActions();
  if (same || trigger.disabled || !live() || state.loading) return;
  const menu = $("#queue-action-menu");
  queueActions.trigger = trigger; queueActions.details = state.details;
  trigger.setAttribute("aria-expanded", "true");
  $("#queue-action-playlist").hidden = trigger.dataset.queueTrack === undefined;
  menu.hidden = false;
  // One fixed menu avoids clipping inside tables, cards and scrolling containers.
  const anchor = trigger.getBoundingClientRect(), size = menu.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  menu.style.left = `${Math.max(8, Math.min(anchor.right - size.width, width - size.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6 + size.height <= height - 8
    ? anchor.bottom + 6 : anchor.top - size.height - 6, height - size.height - 8))}px`;
  $(last ? $("#queue-action-playlist").hidden ? "#queue-action-next" : "#queue-action-playlist" : "#queue-action-append").focus();
}

function chooseQueueAction(next) {
  const trigger = queueActions.trigger, details = queueActions.details;
  closeQueueActions(true);
  if (!trigger?.isConnected || trigger.disabled || details !== state.details || !live() || state.loading) return;
  return addToQueue(trigger.dataset.queueAlbum, trigger.dataset.queueTrack ?? null, next);
}

$("#queue-action-append").addEventListener("click", () => chooseQueueAction(false));
$("#queue-action-next").addEventListener("click", () => chooseQueueAction(true));
$("#queue-action-playlist").addEventListener("click", () => {
  const trigger = queueActions.trigger, details = queueActions.details;
  closeQueueActions(true);
  if (!trigger?.isConnected || trigger.disabled || details !== state.details || !live() || state.loading) return;
  return openTrackPlaylist(trigger.dataset.queueAlbum, trigger.dataset.queueTrack);
});
$("#queue-action-menu").addEventListener("keydown", event => {
  if (event.key === "Escape" || event.key === "Tab") {
    closeQueueActions(true);
    if (event.key === "Escape") event.preventDefault();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = [$("#queue-action-append"), $("#queue-action-next"), $("#queue-action-playlist")].filter(node => !node.hidden);
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
document.addEventListener("scroll", () => closeQueueActions(), true);

function step(delta) {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) return;
  if (player.queue[player.index]?.upNext) {
    player.queue.splice(player.index, 1);
    if (delta > 0) player.index -= 1;
  }
  const next = player.index + delta;
  if (next < 0) return;
  if (next >= player.queue.length) {
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
  player.epoch += 1;
  audio.pause(); audio.removeAttribute("src"); audio.load();
  $("#player").hidden = true; document.body.classList.remove("has-player");
  closeVisualPlayer();
  player.queue = []; player.index = -1; player.album = null; markPlaying();
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
    toast("Original audio could not be played in this browser. Trying MP3 128 kbps."); return;
  }
  playReporting.watch = null;
  toast(`Could not play “${player.queue[player.index]?.title || "this track"}”. Check the connection to iBroadcast.`);
  if (visualPlayer.open) $("#visual-player-status").textContent = "Could not play this track. Check the connection to iBroadcast.";
});
$("#player-prev").addEventListener("click", () => step(-1));
$("#player-next").addEventListener("click", () => step(1));
$("#player-close").addEventListener("click", stopPlayer);
$("#queue-clear").addEventListener("click", stopPlayer);
$("#player-queue").addEventListener("click", () => setNowPlaying($("#now-playing-panel").hidden));
$("#player-cover-button").addEventListener("click", () => setNowPlaying($("#now-playing-panel").hidden));
$("#now-playing-close").addEventListener("click", () => { setNowPlaying(false); $("#player-queue").focus(); });
document.addEventListener("keydown", event => {
  if (!event.defaultPrevented && event.key === "Escape" && !$("#now-playing-panel").hidden && !document.querySelector("dialog[open]")) {
    setNowPlaying(false); $("#player-queue").focus();
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

document.addEventListener("click", event => {
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
    if (audio.paused) audio.play(); else audio.pause();
    return;
  }
  playTracks(album, id || album.tracks[0]?.id, Boolean(shuffle));
});

// File format comes from metadata; streaming quality describes this playback request.
function renderStreamQuality() {
  const track = player.queue[player.index];
  $("#player-quality").textContent = track ? `${track.format ? `File: ${track.format} · ` : ""}Stream: ${player.quality === "orig" ? `Original${track.format ? ` ${track.format}` : ""}` : `MP3 ${player.quality} kbps`}${player.fallback ? " (fallback)" : ""}` : "";
  if (track && typeof gaplessTrial !== "undefined" && gaplessTrial.active) {
    $("#player-quality").textContent += " · Gapless test";
    if (gaplessTrial.active.ready === false || gaplessTrial.active.seekIntent) $("#player-quality").textContent += " · Preparing…";
  }
  $("#visual-player-quality").textContent = $("#player-quality").textContent;
  renderPlayerDisplay();
}
$("#player-repeat").addEventListener("click", () => {
  player.repeat = {none: "queue", queue: "track", track: "none"}[player.repeat];
  $("#player-repeat").textContent = player.repeat === "none" ? "↻" : player.repeat === "queue" ? "↻ Queue" : "↻ Track";
  $("#player-repeat").setAttribute("aria-label", `Repeat: ${player.repeat}. Click to change`);
  $("#player-repeat").setAttribute("aria-pressed", String(player.repeat !== "none"));
  if (typeof gaplessQueueChanged === "function") gaplessQueueChanged();
  if (typeof publishQueueState === "function") publishQueueState();
});

audio.addEventListener("play", () => {
  if (typeof localPlaybackAllowed === "function" && !localPlaybackAllowed()) {
    audio.pause(); playReporting.watch = null;
    toast("This browser is a controller. Use Devices to resume playback here or control the remote player.");
  }
});
