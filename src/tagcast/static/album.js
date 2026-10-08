"use strict";

// Read-only album details use the same lazy library cache as the metadata editor.
const albumView = {id: null, request: 0, loading: false};

function trackDuration(seconds) {
  const value = Math.floor(Number(seconds));
  if (!Number.isFinite(value) || value <= 0) return "–";
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function resetAlbumView() {
  albumView.id = null; albumView.request += 1; albumView.loading = false;
  if (state.screen === "album") showScreen("albums");
}

async function openAlbum(id) {
  const summary = state.albums.find(a => String(a.id) === String(id));
  if (!summary) return;
  albumView.id = String(id);
  const request = ++albumView.request, details = state.details;
  albumView.loading = true;
  showScreen("album");
  window.scrollTo?.({top: 0});
  $("#album-page").innerHTML = '<button class="button small" data-album-back>← Back to albums</button><p class="empty" role="status"><span class="spinner"></span>Loading album tracks…</p>';
  try {
    const [album] = await albumDetails([albumView.id]);
    if (request !== albumView.request || details !== state.details || state.screen !== "album") return;
    if (!album) throw Error("This album is no longer in your library. Reload the library.");
    albumView.loading = false;
    renderAlbumView();
  } catch (error) {
    if (request !== albumView.request || details !== state.details || state.screen !== "album") return;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    $("#album-page").innerHTML = `<button class="button small" data-album-back>← Back to albums</button><p class="error-box" role="alert">${escapeHtml(error.message)}</p><button class="button" data-album="${escapeHtml(id)}">Try again</button>`;
  } finally {
    if (request === albumView.request) albumView.loading = false;
  }
}

function renderAlbumView() {
  if (state.screen !== "album" || albumView.loading) return;
  if (!state.albums.some(a => String(a.id) === albumView.id)) { resetAlbumView(); return; }
  const album = state.details.get(albumView.id);
  if (!album) { openAlbum(albumView.id); return; }
  const id = escapeHtml(album.id), canPlay = live() && album.tracks.length > 0;
  const total = album.tracks.length && album.tracks.every(t => Number(t.length) > 0)
    ? ` · ${trackDuration(album.tracks.reduce((sum, t) => sum + Number(t.length), 0))}` : "";
  const genres = splitGenres(album.tracks.flatMap(trackGenres));
  $("#breadcrumb").textContent = album.name;
  $("#album-page").innerHTML = `<button class="button small" data-album-back>← Back to albums</button>
    <div class="album-detail-header">${cover(album)}<div class="album-detail-info"><div class="eyebrow">YOUR ALBUM</div>
      <h1>${escapeHtml(album.name)}</h1><button class="text-action" data-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</button>
      <p class="muted">${album.year || "Year unknown"} · ${album.tracks.length} tracks${discLabel(album) ? ` · ${discLabel(album)}` : album.disc > 1 ? ` · Disc ${album.disc}` : ""}${total}</p>
      ${genres.length ? `<p class="muted">${escapeHtml(genres.join(" · "))}</p>` : ""}
      <div class="album-detail-actions"><button class="button primary" data-play-album data-play-album-id="${id}" ${canPlay ? "" : "disabled"}>▶ Play album</button>
        <button class="button" data-edit-album="${id}">Edit album →</button></div>
      ${live() ? "" : '<p class="muted">Connect iBroadcast to listen. You can edit this local preview.</p>'}</div></div>
    <div class="tracks-heading"><h2>Tracks</h2><span class="muted">${canPlay ? "Play from any track" : "Local preview"}</span></div>
    <table class="album-tracks"><thead><tr><th class="track-number">#</th><th>Title / Artist</th><th class="track-time">Time</th></tr></thead><tbody>
      ${album.tracks.map(t => `<tr data-row="${escapeHtml(t.id)}"><td class="track-number"><button class="album-track-play" data-play="${escapeHtml(t.id)}" data-play-album-id="${id}" aria-label="Play ${escapeHtml(t.title)}" ${canPlay ? "" : "disabled"}>▶</button><span>${t.track || "–"}</span></td>
        <td><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}${t.composers?.length ? ` · ${escapeHtml(t.composers.join(", "))}` : ""}</small></td><td class="track-time">${trackDuration(t.length)}</td></tr>`).join("")}
    </tbody></table>`;
  markPlaying();
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-album-back]")) { showScreen("albums"); render(); return; }
  const edit = event.target.closest("[data-edit-album]");
  if (edit) openEditor([edit.dataset.editAlbum]);
});
$("#editor").addEventListener("close", renderAlbumView);
