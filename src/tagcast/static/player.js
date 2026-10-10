"use strict";

// Album playback for browsing and editing. Audio comes through the local server
// (/api/stream/<track>), so the iBroadcast token never reaches this page.

const player = {queue: [], index: -1, album: null, epoch: 0, pending: Promise.resolve()};
const audio = $("#audio");

function queueTracks(album, tracks = album.tracks) {
  const source = {id: album.id, name: album.name, artist: album.artist, artwork: album.artwork, color: album.color || "#839e8d"};
  return tracks.map(t => ({id: String(t.id), title: t.title, artist: t.artist, artistId: t.artist_id,
    rating: t.rating || 0, length: t.length || 0, album: source}));
}

function playTracks(album, startId) {
  if (!live() || !album.tracks.length) return;
  player.epoch += 1;
  player.queue = queueTracks(album);
  player.index = Math.max(0, player.queue.findIndex(t => t.id === String(startId)));
  playCurrent();
}

// An album of several discs plays as one album, disc after disc.
function playableAlbum(id) {
  const discs = shelfIds(id).map(i => state.details.get(i));
  return discs.every(Boolean) ? joinDiscs(discs) : state.details.get(String(id));
}

function playCurrent() {
  const track = player.queue[player.index];
  if (!track) return;
  player.album = track.album;
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
  $("#player-track-line").hidden = !track.artist || track.artist === player.album.artist;
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
    <h3>${escapeHtml(track.title)}</h3><p class="muted">${escapeHtml(track.artist)}</p>
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

function queueButton(albumId, track = null) {
  const label = track ? `Add ${track.title} to queue` : "Add album to queue";
  return `<button type="button" class="queue-add ${track ? "" : "button small"}" data-queue-album="${escapeHtml(albumId)}" ${track ? `data-queue-track="${escapeHtml(track.id)}"` : ""} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${!live() || state.loading ? "disabled" : ""}>${track ? "+" : "+ Add to queue"}</button>`;
}

function step(delta) {
  const next = player.index + delta;
  if (next < 0 || next >= player.queue.length) return;
  player.index = next; playCurrent();
}

function stopPlayer() {
  player.epoch += 1;
  audio.pause(); audio.removeAttribute("src"); audio.load();
  $("#player").hidden = true; document.body.classList.remove("has-player");
  player.queue = []; player.index = -1; player.album = null; markPlaying();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
}

audio.addEventListener("ended", () => (player.index < player.queue.length - 1 ? step(1) : markPlaying()));
audio.addEventListener("play", markPlaying);
audio.addEventListener("pause", markPlaying);
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return;
  toast(`Could not play “${player.queue[player.index]?.title || "this track"}”. Check the connection to iBroadcast.`);
});
$("#player-prev").addEventListener("click", () => step(-1));
$("#player-next").addEventListener("click", () => step(1));
$("#player-close").addEventListener("click", stopPlayer);
$("#queue-clear").addEventListener("click", stopPlayer);
$("#player-queue").addEventListener("click", () => setNowPlaying($("#now-playing-panel").hidden));
$("#player-cover-button").addEventListener("click", () => setNowPlaying($("#now-playing-panel").hidden));
$("#now-playing-close").addEventListener("click", () => { setNowPlaying(false); $("#player-queue").focus(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#now-playing-panel").hidden && !document.querySelector("dialog[open]")) {
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
  if (queued) return addToQueue(queued.dataset.queueAlbum, queued.dataset.queueTrack ?? null);
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
  const id = play?.dataset.play;
  if (id && player.queue[player.index]?.id === id && player.album?.id === album.id) {
    if (audio.paused) audio.play(); else audio.pause();
    return;
  }
  playTracks(album, id || album.tracks[0]?.id);
});
