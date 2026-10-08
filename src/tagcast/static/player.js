"use strict";

// Album playback for browsing and editing. Audio comes through the local server
// (/api/stream/<track>), so the iBroadcast token never reaches this page.

const player = {queue: [], index: -1, album: null};
const audio = $("#audio");

function playTracks(album, startId) {
  if (!live() || !album.tracks.length) return;
  player.album = structuredClone(album);
  player.queue = album.tracks.map(t => ({id: String(t.id), title: t.title, artist: t.artist}));
  player.index = Math.max(0, player.queue.findIndex(t => t.id === String(startId)));
  playCurrent();
}

function playCurrent() {
  const track = player.queue[player.index];
  if (!track) return;
  audio.src = `/api/stream/${encodeURIComponent(track.id)}`;
  audio.play().catch(() => { /* reported by the error event */ });
  $("#player").hidden = false; document.body.classList.add("has-player");
  $("#player-title").textContent = track.title;
  $("#player-artist").textContent = `${track.artist} · ${player.album.name}`;
  const art = $("#player-art");
  art.hidden = !player.album.artwork; if (player.album.artwork) art.src = player.album.artwork.replace(/-300$/, "-150");
  $("#player-prev").disabled = player.index === 0;
  $("#player-next").disabled = player.index >= player.queue.length - 1;
  markPlaying();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: track.artist, album: player.album.name,
      artwork: player.album.artwork ? [{src: player.album.artwork, sizes: "300x300"}] : []});
  }
}

function markPlaying() {
  const current = player.queue[player.index]?.id;
  for (const row of document.querySelectorAll("[data-row]")) row.classList.toggle("playing", !audio.paused && row.dataset.row === current);
}

function step(delta) {
  const next = player.index + delta;
  if (next < 0 || next >= player.queue.length) return;
  player.index = next; playCurrent();
}

function stopPlayer() {
  audio.pause(); audio.removeAttribute("src"); audio.load();
  $("#player").hidden = true; document.body.classList.remove("has-player");
  player.queue = []; player.index = -1; player.album = null; markPlaying();
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
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
}

document.addEventListener("click", event => {
  const play = event.target.closest("[data-play]");
  const all = event.target.closest("[data-play-album]");
  if (!play && !all) return;
  if (!live()) return;
  const albumId = (play || all).dataset.playAlbumId;
  const album = albumId ? state.details.get(String(albumId)) : event.target.closest("#editor") && !editing?.bulk ? editing?.originals[0] : null;
  if (!album) return;
  const id = play?.dataset.play;
  if (id && player.queue[player.index]?.id === id && player.album?.id === album.id) {
    if (audio.paused) audio.play(); else audio.pause();
    return;
  }
  playTracks(album, id || album.tracks[0]?.id);
});
