"use strict";

// Album playback for browsing and editing. Audio comes through the local server
// (/api/stream/<track>), so the iBroadcast token never reaches this page.

const player = {queue: [], index: -1, album: null, epoch: 0, pending: Promise.resolve(), randomRequest: 0, randomLoading: false};
const audio = $("#audio");
const visualPlayer = {open: false, native: false, request: 0, focus: null, inert: []};

// The existing audio element stays in place; fullscreen changes only the presentation.
function renderVisualPlayer() {
  if (!visualPlayer.open) return;
  const track = player.queue[player.index], album = track?.album;
  if (!track) return;
  $("#visual-player-title").textContent = track.title;
  $("#visual-player-artist").textContent = album.artist;
  $("#visual-player-album").textContent = album.name;
  const performer = $("#visual-player-track-artist");
  performer.textContent = `Track artist: ${track.artist}`;
  performer.hidden = !track.artist || track.artist === album.artist;
  $("#visual-player-placeholder").textContent = initials(album.artist);
  const art = $("#visual-player-art");
  // Reuse the cover URL as provided, without fetching speculative larger sizes.
  if (art.getAttribute("src") !== (album.artwork || null)) {
    art.hidden = !album.artwork;
    if (album.artwork) art.src = album.artwork; else art.removeAttribute("src");
  }
}

function hideVisualPlayer() {
  if (!visualPlayer.open) return;
  visualPlayer.open = false; visualPlayer.native = false; visualPlayer.request += 1;
  $("#visual-player").hidden = true;
  document.body.classList.remove("visual-player-open");
  $("#player-stage").removeAttribute("role");
  $("#player-stage").removeAttribute("aria-modal");
  $("#player-stage").removeAttribute("aria-label");
  for (const [node, inert] of visualPlayer.inert) node.inert = inert;
  visualPlayer.inert = [];
  $("#player-fullscreen").setAttribute("aria-expanded", "false");
  $("#player-fullscreen").setAttribute("aria-label", "Open fullscreen Now playing");
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
  stage.setAttribute("aria-label", "Now playing fullscreen");
  document.body.classList.add("visual-player-open");
  $("#visual-player").hidden = false;
  $("#visual-player-status").textContent = "";
  $("#player-fullscreen").setAttribute("aria-expanded", "true");
  $("#player-fullscreen").setAttribute("aria-label", "Close fullscreen view");
  renderVisualPlayer(); $("#visual-player-close").focus();
  // Some browsers do not support or permit native fullscreen. The window view still works.
  if (stage.requestFullscreen && !document.fullscreenElement) {
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
$("#visual-player-art").addEventListener("error", () => { $("#visual-player-art").hidden = true; });
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === $("#player-stage")) {
    visualPlayer.native = true;
    if (!visualPlayer.open) closeVisualPlayer();
  } else if (visualPlayer.native) { visualPlayer.native = false; hideVisualPlayer(); }
});
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || !visualPlayer.open) return;
  if (event.key === "Escape") { closeVisualPlayer(); return; }
  if (event.key !== "Tab") return;
  const controls = [...$("#player-stage").querySelectorAll('button:not([disabled]), audio')].filter(node => node.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

function performerLinks(track, additionalOnly = false) {
  const people = track.performers?.length ? track.performers : [{id: String(track.artist_id || track.artistId || ""), name: track.artist}];
  return people.slice(additionalOnly ? 1 : 0).map((p, i) => `${i || additionalOnly ? '<span aria-hidden="true"> · </span>' : ""}${p.id ? `<button type="button" class="text-action performer-link" data-performer-id="${escapeHtml(p.id)}" title="Open albums with tracks by ${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>` : escapeHtml(p.name)}`).join("");
}

function queueTracks(album, tracks = album.tracks) {
  const source = {id: album.id, name: album.name, artist: album.artist, artwork: album.artwork, color: album.color || "#839e8d"};
  return tracks.map(t => ({id: String(t.id), title: t.title, artist: t.artist, artistId: t.artist_id, performers: t.performers || [],
    rating: t.rating || 0, length: t.length || 0, album: source}));
}

function playTracks(album, startId) {
  if (!live() || !album.tracks.length) return;
  cancelRandomPlay();
  player.epoch += 1;
  player.queue = queueTracks(album);
  player.index = Math.max(0, player.queue.findIndex(t => t.id === String(startId)));
  playCurrent();
}

function updateRandomControls() {
  const albums = $("#albums-random"), browse = $("#browse-random");
  const unavailable = !live() || state.loading || player.randomLoading;
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
    playTracks(album);
    toast(`Playing ${album.name} · ${album.artist}`);
  } catch (error) {
    if (request === player.randomRequest && details === state.details) toast(`Could not play a random album: ${error.message}`);
  } finally {
    if (request === player.randomRequest) { player.randomLoading = false; updateRandomControls(); }
  }
}

$("#albums-random").addEventListener("click", () => playRandomAlbum(filteredAlbums()));
$("#browse-random").addEventListener("click", () => playRandomAlbum(browseAlbums()));

// An album of several discs plays as one album, disc after disc.
function playableAlbum(id) {
  const discs = shelfIds(id).map(i => state.details.get(i));
  return discs.every(Boolean) ? joinDiscs(discs) : state.details.get(String(id));
}

function playCurrent() {
  const track = player.queue[player.index];
  if (!track) return;
  player.album = track.album;
  if (visualPlayer.open) $("#visual-player-status").textContent = "";
  audio.src = `/api/stream/${encodeURIComponent(track.id)}`;
  audio.play().catch(() => { /* reported by the error event */ });
  $("#player").hidden = false; document.body.classList.add("has-player");
  $("#player-title").textContent = track.title;
  const artist = $("#player-artist"), album = $("#player-album");
  artist.textContent = player.album.artist; artist.title = player.album.artist;
  artist.setAttribute("aria-label", `Open albums by ${player.album.artist}`);
  const performer = $("#player-track-artist");
  performer.textContent = track.artist; performer.title = track.artist;
  performer.setAttribute("aria-label", `Open albums with tracks by ${track.artist}`);
  $("#player-extra-artists").innerHTML = performerLinks(track, true);
  $("#player-track-line").hidden = (!track.artist || track.artist === player.album.artist) && !(track.performers?.length > 1);
  album.textContent = player.album.name; album.title = player.album.name;
  album.setAttribute("aria-label", `Open album ${player.album.name}`);
  const art = $("#player-art");
  art.hidden = !player.album.artwork; if (player.album.artwork) art.src = player.album.artwork.replace(/-300$/, "-150");
  $("#player-prev").disabled = player.index === 0;
  $("#player-next").disabled = player.index >= player.queue.length - 1;
  markPlaying();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: track.artist, album: player.album.name,
      artwork: player.album.artwork ? [{src: player.album.artwork, sizes: "300x300"}] : []});
  }
}

function markPlaying() {
  const current = player.queue[player.index]?.id;
  for (const row of document.querySelectorAll("[data-row]")) row.classList.toggle("playing", !audio.paused && row.dataset.row === current);
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
  const track = player.queue[player.index], album = track?.album;
  $("#now-playing-current").innerHTML = track ? `<div class="now-playing-cover">${cover(album, true)}</div>
    <h3>${escapeHtml(track.title)}</h3><p class="muted">${performerLinks(track)}</p>
    <button class="text-action" data-album="${escapeHtml(album.id)}">${escapeHtml(album.name)}</button>` : '<p class="empty">Play a track or add an album to your queue.</p>';
  $("#now-playing-count").textContent = `${player.queue.length} ${player.queue.length === 1 ? "track" : "tracks"}`;
  $("#queue-clear").disabled = !player.queue.length;
  $("#now-playing-list").innerHTML = player.queue.map((t, index) => `<li><button class="queue-track ${index === player.index ? "current" : ""}" data-queue-index="${index}" ${index === player.index ? 'aria-current="true"' : ""}>
    <span class="queue-number">${index === player.index ? audio.paused ? "Ⅱ" : "▶" : index + 1}</span><span class="queue-label"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)} · ${escapeHtml(t.album.name)}</small></span><span class="queue-time">${trackDuration(t.length)}</span></button></li>`).join("");
}

function appendToQueue(album, trackId = null) {
  const tracks = trackId === null ? album.tracks : album.tracks.filter(t => String(t.id) === String(trackId));
  if (!tracks.length) throw Error("This track is no longer on that album. Reload the library.");
  const empty = !player.queue.length, ended = audio.ended;
  const next = player.index + 1;
  player.queue.push(...queueTracks(album, tracks));
  if (empty || ended) { player.index = empty ? 0 : next; playCurrent(); }
  else markPlaying();
  toast(`Added ${tracks.length === 1 ? "1 track" : `${tracks.length} tracks`} to the queue.`);
}

function addToQueue(albumId, trackId = null) {
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
      appendToQueue(album, trackId);
    } catch (error) {
      if (epoch === player.epoch && details === state.details) toast(`Could not add to queue: ${error.message}`);
    }
  });
  player.pending = task;
  return task;
}

function queueButton(albumId, track = null, compact = false) {
  const label = track ? `Add ${track.title} to queue` : "Add album to queue";
  return `<button type="button" class="queue-add ${compact ? "queue-compact" : track ? "" : "button small"}" data-queue-album="${escapeHtml(albumId)}" ${track ? `data-queue-track="${escapeHtml(track.id)}"` : ""} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${!live() || state.loading ? "disabled" : ""}>${track || compact ? "+" : "+ Add to queue"}</button>`;
}

function step(delta) {
  const next = player.index + delta;
  if (next < 0 || next >= player.queue.length) return;
  player.index = next; playCurrent();
}

function stopPlayer() {
  cancelRandomPlay();
  player.epoch += 1;
  audio.pause(); audio.removeAttribute("src"); audio.load();
  $("#player").hidden = true; document.body.classList.remove("has-player");
  closeVisualPlayer();
  player.queue = []; player.index = -1; player.album = null; markPlaying();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
}

audio.addEventListener("ended", () => (player.index < player.queue.length - 1 ? step(1) : markPlaying()));
audio.addEventListener("play", markPlaying);
audio.addEventListener("pause", markPlaying);
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return;
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
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
}

document.addEventListener("click", event => {
  const queued = event.target.closest("[data-queue-album]");
  if (queued) {
    const before = player.queue.length, epoch = player.epoch, details = state.details;
    return addToQueue(queued.dataset.queueAlbum, queued.dataset.queueTrack ?? null).then(() => {
      if (player.queue.length <= before || epoch !== player.epoch || details !== state.details) return;
      const original = queued.textContent;
      queued.textContent = "✓";
      setTimeout(() => { queued.textContent = original; }, 1200);
    });
  }
  const performerLink = event.target.closest("[data-performer-id]");
  if (performerLink) return showBrowse("track-artists", performerLink.dataset.performerId);
  const jump = event.target.closest("[data-queue-index]");
  if (jump) {
    const index = Number(jump.dataset.queueIndex);
    if (Number.isInteger(index) && index >= 0 && index < player.queue.length && live()) { player.index = index; playCurrent(); }
    return;
  }
  const play = event.target.closest("[data-play]");
  const all = event.target.closest("[data-play-album]");
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
  playTracks(album, id || album.tracks[0]?.id);
});
