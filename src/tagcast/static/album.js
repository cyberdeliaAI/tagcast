"use strict";

// Read-only album details use the same lazy library cache as the metadata editor.
const albumView = {id: null, request: 0, loading: false, trash: null, found: ""};  // trash: track IDs chosen for the trash; found: a track opened from Tracks

function trackDuration(seconds) {
  const value = Math.floor(Number(seconds));
  if (!Number.isFinite(value) || value <= 0) return "–";
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function resetAlbumView() {
  albumView.id = null; albumView.request += 1; albumView.loading = false; albumView.trash = null;
  if (state.screen === "album") showScreen("albums");
}

// A set's year, as the album lists show it: missing when one of the discs has none.
function albumYear(discs) {
  const years = discs.map(d => d.year || 0);
  return years.includes(0) ? 0 : Math.min(...years);
}

// Titles that appear more than once on one disc.
function twice(album) {
  const seen = new Set(), doubled = new Set();
  for (const key of album.tracks.map(t => titleKey(t.title)).filter(Boolean)) (seen.has(key) ? doubled : seen).add(key);
  return doubled;
}

function backButton() {
  return `<button class="button small" data-album-back>← Back to ${escapeHtml(backLabel(state.artist || "Albums"))}</button>`;
}

// The discs of a set open as one album page, under the address of the first disc.
async function openAlbum(id, found = "") {
  const summary = state.albums.find(a => String(a.id) === String(id));
  if (!summary) return;
  const ids = shelfIds(id);
  if (albumView.id !== ids[0]) albumView.trash = null;
  albumView.id = ids[0]; albumView.found = String(found);
  const request = ++albumView.request, details = state.details;
  albumView.loading = true;
  showScreen("album");
  window.scrollTo?.({top: 0});
  $("#album-page").innerHTML = `${backButton()}<p class="empty" role="status"><span class="spinner"></span>Loading album tracks…</p>`;
  try {
    const albums = await albumDetails(ids);
    if (request !== albumView.request || details !== state.details || state.screen !== "album") return;
    if (albums.length !== ids.length) throw Error("This album is no longer in your library. Reload the library.");
    albumView.loading = false;
    renderAlbumView();
  } catch (error) {
    if (request !== albumView.request || details !== state.details || state.screen !== "album") return;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    $("#album-page").innerHTML = `${backButton()}<p class="error-box" role="alert">${escapeHtml(error.message)}</p><button class="button" data-album="${escapeHtml(id)}">Try again</button>`;
  } finally {
    if (request === albumView.request) albumView.loading = false;
  }
}

function renderAlbumView() {
  if (state.screen !== "album" || albumView.loading) return;
  if (!state.albums.some(a => String(a.id) === albumView.id)) { resetAlbumView(); return; }
  const ids = shelfIds(albumView.id), discs = ids.map(i => state.details.get(i));
  if (ids[0] !== albumView.id || !discs.every(Boolean)) { openAlbum(albumView.id); return; }
  const album = joinDiscs(discs), several = discs.length > 1;
  const id = escapeHtml(album.id), canPlay = live() && album.tracks.length > 0;
  const total = album.tracks.length && album.tracks.every(t => Number(t.length) > 0)
    ? ` · ${trackDuration(album.tracks.reduce((sum, t) => sum + Number(t.length), 0))}` : "";
  const genres = [...new Map(album.tracks.flatMap(trackGenres).map(g => [g.toLocaleLowerCase(), g])).values()];
  const doubled = new Map(discs.map(d => [d, twice(d)]));
  $("#breadcrumb").textContent = album.name;
  $("#album-page").innerHTML = `${backButton()}
    <div class="album-detail-header">${cover(album)}<div class="album-detail-info"><div class="eyebrow">YOUR ALBUM</div>
      <h1>${escapeHtml(album.name)}</h1><button class="text-action" data-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</button>
      <p class="muted">${albumYear(discs) || "Year unknown"} · ${album.tracks.length} tracks${several ? ` · ${discIcons(discs.length)}` : album.disc > 1 ? ` · Disc ${album.disc}` : ""}${total}</p>
      ${genres.length ? `<p class="muted album-genre-links">${genres.map(g => `<button class="text-action" data-browse-kind="genres" data-browse-key="${escapeHtml(g.toLocaleLowerCase())}" data-browse-label="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join(' <span aria-hidden="true">·</span> ')}</p>` : ""}
      <div class="album-detail-actions"><button class="button primary" data-play-album data-play-album-id="${id}" ${canPlay ? "" : "disabled"}>▶ Play album</button>
        ${queueButton(album.id)}<button class="button" data-edit-album="${escapeHtml(ids.join(","))}">Edit album →</button>${live() ? `<button class="button danger" data-trash-start ${albumView.trash ? "disabled" : ""}>${trashIcon}Move to trash…</button>` : ""}</div>
      ${live() ? "" : '<p class="muted">Connect iBroadcast to listen. You can edit this local preview.</p>'}</div></div>
    <div class="tracks-heading"><h2>Tracks</h2><span class="muted">${canPlay ? "Play from any track" : "Local preview"}</span></div>
    ${albumView.trash ? trashBar(discs) : ""}<table class="album-tracks ${albumView.trash ? "trash-mode" : ""}"><thead><tr><th class="track-number">#</th><th>Title / Artist</th><th class="track-time">Time</th><th class="track-heart" aria-label="Favourite"></th></tr></thead><tbody>
      ${discs.map((d, i) => (several ? `${i ? '<tr class="disc-gap" aria-hidden="true"><td colspan="4"></td></tr>' : ""}<tr class="disc-row"><td colspan="4"><span>Disc ${d.disc || "?"}</span><button class="text-action" data-edit-album="${escapeHtml(d.id)}">Edit disc ${d.disc || "?"}</button></td></tr>` : "") + d.tracks.map(t => `<tr data-row="${escapeHtml(t.id)}"${String(t.id) === albumView.found ? ' class="found"' : ""}><td class="track-number">${albumView.trash ? trashCheck(t) : ""}<button class="album-track-play" data-play="${escapeHtml(t.id)}" data-play-album-id="${id}" aria-label="Play ${escapeHtml(t.title)}" ${canPlay ? "" : "disabled"}>▶</button><span>${t.track || "–"}</span></td>
        <td><strong>${escapeHtml(t.title)}${doubled.get(d).has(titleKey(t.title)) ? ' <span class="pill missing">Duplicate</span>' : ""}</strong><small>${escapeHtml(t.artist)}${t.composers?.length ? ` · ${escapeHtml(t.composers.join(", "))}` : ""}</small></td><td class="track-time">${trackDuration(t.length)}</td><td class="track-heart">${queueButton(album.id, t)}${heartButton(t)}</td></tr>`).join("")).join("")}
    </tbody></table>`;
  markPlaying();
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-album-back]")) { goBack("albums"); return; }
  const edit = event.target.closest("[data-edit-album]");
  if (edit) openEditor(edit.dataset.editAlbum.split(","));
});
$("#editor").addEventListener("close", renderAlbumView);
