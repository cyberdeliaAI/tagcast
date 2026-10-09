"use strict";

// Tracks: search every track by title, artist, album or composer. A connected library is
// searched by the server, which already holds all of it; the demo searches its own albums.
// A result plays its album from that track, or opens the album with the track marked.

const trackSearch = {query: "", results: [], total: 0, page: 0, request: 0, loading: false, waiting: false,
  error: "", details: null, pageSize: storedPageSize("tagcast-tracks-per-page") || 50};
let trackSearchTimer;

// As on the server: case, accents and spacing don't count ("bjork" finds "Björk").
const foldText = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().split(/\s+/).filter(Boolean).join(" ");

// The demo's search, in the server's order: album artist, album, disc, track number.
function localTracks(query) {
  const words = foldText(query).split(" "), found = [];
  const albums = [...state.details.values()].sort((a, b) => foldText(a.artist).localeCompare(foldText(b.artist))
    || foldText(a.name).localeCompare(foldText(b.name)) || (a.disc || 0) - (b.disc || 0));
  for (const album of albums) {
    for (const t of [...album.tracks].sort((a, b) => (a.track || 9999) - (b.track || 9999))) {
      const text = foldText([t.title, t.artist, album.name, album.artist, ...(t.composers || [])].join(" "));
      if (words.every(word => text.includes(word))) found.push({id: String(t.id), album_id: String(album.id), title: t.title,
        artist: t.artist, composers: t.composers || [], album: album.name, disc: album.disc, track: t.track,
        year: t.year || album.year, length: t.length || 0});
    }
  }
  return {tracks: found, total: found.length};
}

async function runTrackSearch() {
  const query = $("#tracks-search").value.trim(), request = ++trackSearch.request;
  if (query !== trackSearch.query) trackSearch.page = 0;
  Object.assign(trackSearch, {query, details: state.details, error: "", waiting: state.loading, loading: false});
  if (query.length < 2 || state.loading) {
    trackSearch.results = []; trackSearch.total = 0;
  } else if (!live()) {
    const found = localTracks(query);
    trackSearch.results = found.tracks; trackSearch.total = found.total;
  } else {
    trackSearch.loading = true;
    renderTrackSearch();
    try {
      const data = await api(`/api/tracks?q=${encodeURIComponent(query)}`);
      if (request !== trackSearch.request) return;
      trackSearch.results = data.tracks || []; trackSearch.total = data.total || 0;
    } catch (error) {
      if (request !== trackSearch.request) return;
      if (error.status === 401) { state.connection.connected = false; updateChrome(); }
      trackSearch.results = []; trackSearch.total = 0;
      // A page newer than the running server: the server only learns /api/tracks after a restart.
      trackSearch.error = error.status === 404 ? "Restart Tagcast to search tracks: the Tagcast that is running is older than this page." : error.message;
    }
    trackSearch.loading = false;
  }
  renderTrackSearch();
}

function foundTrackRow(t) {
  const id = escapeHtml(t.id), album = escapeHtml(t.album_id), canPlay = live();
  const where = [shelfIds(t.album_id).length > 1 || t.disc > 1 ? `Disc ${t.disc || "?"}` : "", t.track ? `Track ${t.track}` : ""].filter(Boolean).join(" · ");
  return `<tr data-row="${id}"><td class="track-number"><button class="album-track-play" data-track-play="${id}" data-track-album="${album}" aria-label="Play ${escapeHtml(t.title)}" ${canPlay ? "" : "disabled"}>▶</button></td>
    <td><button class="track-open" data-track-open="${id}" data-track-album="${album}"><strong>${escapeHtml(t.title)}</strong></button><small>${escapeHtml(t.artist)}${t.composers?.length ? ` · ${escapeHtml(t.composers.join(", "))}` : ""}</small></td>
    <td><button class="track-open" data-track-open="${id}" data-track-album="${album}">${escapeHtml(t.album)}</button>${where ? `<small>${where}</small>` : ""}</td>
    <td class="track-year">${t.year || "–"}</td><td class="track-time">${trackDuration(t.length)}</td></tr>`;
}

function renderTrackSearch() {
  if (state.screen !== "tracks") return;
  // A library that loaded or changed since the last search is searched again.
  if ($("#tracks-search").value.trim().length >= 2 && !state.loading && !trackSearch.loading
      && (trackSearch.waiting || trackSearch.details !== state.details)) { runTrackSearch(); return; }
  const query = trackSearch.query, rows = trackSearch.results, size = trackSearch.pageSize, maxPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  trackSearch.page = Math.max(0, Math.min(trackSearch.page, maxPage));
  $("#tracks-per-page").value = String(size);
  const count = `${trackSearch.total.toLocaleString("en")} ${trackSearch.total === 1 ? "track" : "tracks"}`;
  $("#tracks-results").textContent = query.length < 2 || trackSearch.error ? "" : trackSearch.loading ? "Searching…"
    : trackSearch.total > rows.length ? `${count} · showing the first ${rows.length.toLocaleString("en")}. Add a word to narrow it down.` : count;
  const page = rows.slice(trackSearch.page * size, (trackSearch.page + 1) * size);
  $("#tracks-list").innerHTML = state.loading ? '<div class="empty" role="status"><span class="spinner"></span>Loading your library…</div>'
    : query.length < 2 ? '<div class="empty">Type at least two letters to search your tracks by title, artist, album or composer.</div>'
    : trackSearch.error ? `<p class="error-box" role="alert">${escapeHtml(trackSearch.error)}</p>`
    : page.length ? `<table class="album-tracks track-results"><thead><tr><th class="track-number"></th><th>Title / Artist</th><th>Album</th><th class="track-year">Year</th><th class="track-time">Time</th></tr></thead><tbody>${page.map(foundTrackRow).join("")}</tbody></table>`
    : trackSearch.loading ? '<div class="empty" role="status"><span class="spinner"></span>Searching your tracks…</div>'
    : `<div class="empty">No tracks match “${escapeHtml(query)}”.</div>`;
  $("#tracks-pagination").innerHTML = maxPage > 0 && !state.loading && query.length >= 2 ? `<button class="button small" data-track-page="-1" ${trackSearch.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${trackSearch.page + 1} of ${(maxPage + 1).toLocaleString("en")}</span><button class="button small" data-track-page="1" ${trackSearch.page === maxPage ? "disabled" : ""}>Next →</button>` : "";
  markPlaying();
  if (typeof syncHistory === "function") syncHistory();
}

// Opening the page searches again: the library may have changed since the last visit.
function showTracks(page = trackSearch.page) {
  showScreen("tracks");
  trackSearch.query = $("#tracks-search").value.trim(); trackSearch.page = page;
  runTrackSearch();
  window.scrollTo?.({top: 0});
}

// A track plays with the rest of its album after it, as on the album page.
async function playFoundTrack(trackId, albumId) {
  if (!live()) return;
  if (player.queue[player.index]?.id === trackId) { if (audio.paused) audio.play(); else audio.pause(); return; }
  try {
    await albumDetails(shelfIds(albumId));
    const album = playableAlbum(albumId);
    if (!album?.tracks.some(t => String(t.id) === trackId)) throw Error("This track is no longer on that album. Search again.");
    playTracks(album, trackId);
  } catch (error) {
    toast(`Could not play this track: ${error.message}`);
  }
}

async function openFoundTrack(trackId, albumId) {
  if (!state.albums.some(a => String(a.id) === albumId)) { toast("This album is no longer in your library. Search again."); return; }
  await openAlbum(albumId, trackId);
  $("#album-page").querySelector("tr.found")?.scrollIntoView?.({block: "center"});
}

$("#show-tracks").addEventListener("click", () => { showTracks(); $("#tracks-search").focus(); });
$("#tracks-search").addEventListener("input", () => {
  clearTimeout(trackSearchTimer);
  trackSearchTimer = setTimeout(runTrackSearch, 250);
});
$("#tracks-per-page").addEventListener("change", event => {
  const size = Number(event.target.value);
  trackSearch.page = Math.floor(trackSearch.page * trackSearch.pageSize / size); trackSearch.pageSize = size;
  rememberPageSize("tagcast-tracks-per-page", size); renderTrackSearch();
});
document.addEventListener("click", event => {
  const play = event.target.closest("[data-track-play]");
  if (play) { playFoundTrack(play.dataset.trackPlay, play.dataset.trackAlbum); return; }
  const open = event.target.closest("[data-track-open]");
  if (open) { openFoundTrack(open.dataset.trackOpen, open.dataset.trackAlbum); return; }
  const page = event.target.closest("[data-track-page]");
  if (page) {
    trackSearch.page += Number(page.dataset.trackPage);
    renderTrackSearch();
    window.scrollTo?.({top: 0});
  }
});
