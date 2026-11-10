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
      const text = foldText([t.title, t.artist, ...(t.performers || []).map(p => p.name), album.name, album.artist, ...(t.composers || [])].join(" "));
      if (words.every(word => text.includes(word))) found.push({id: String(t.id), album_id: String(album.id), title: t.title,
        artist: t.artist, performers: t.performers || [], composers: t.composers || [], album: album.name, disc: album.disc, track: t.track,
        year: t.year || album.year, length: t.length || 0, format: t.format || "", rating: t.rating || 0});
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
      trackSearch.error = error.status === 404 ? viewFailure("errors.nav.tracks_outdated") : error;
    }
    trackSearch.loading = false;
  }
  renderTrackSearch();
}

function foundTrackRow(t, options = {}) {
  const id = escapeHtml(t.id), album = escapeHtml(t.album_id), canPlay = live();
  const where = [shelfIds(t.album_id).length > 1 || t.disc > 1 ? TagcastI18n.html("common.disc", {disc: t.disc || "?"}) : "",
    t.track ? TagcastI18n.html("tracks.row.track", {track: t.track}) : ""].filter(Boolean).join(" · ");
  return `<tr data-row="${id}"><td class="track-number"><button class="album-track-play" data-track-play="${id}" data-track-album="${album}" aria-label="${TagcastI18n.html("tracks.row.play", {title: t.title})}" ${canPlay ? "" : "disabled"}>▶</button></td>
    <td><button class="track-open" data-track-open="${id}" data-track-album="${album}"><strong>${escapeHtml(t.title)}</strong></button><small>${performerLinks(t)}${t.composers?.length ? ` · ${escapeHtml(t.composers.join(", "))}` : ""}</small></td>
    <td><button class="track-open" data-track-open="${id}" data-track-album="${album}">${escapeHtml(t.album)}</button>${where ? `<small>${where}</small>` : ""}${options.uploadDate ? `<small class="upload-track-date">${t.uploaded_at ? TagcastI18n.html("tracks.row.uploaded", {date: t.uploaded_at.replace("T", " · ")}) : TagcastI18n.html("tracks.row.uploadedUnknown")}</small>` : ""}</td>
    <td class="track-year">${t.year || "–"}</td><td class="track-time">${trackDuration(t.length)}${trackFormatLabel(t)}</td><td class="track-heart">${queueButton(t.album_id, t)}${heartButton(t)}</td></tr>`;
}

// The result table shared by Tracks, Favourites and Recently played.
function trackResultsTable(rows) {
  return `<table class="album-tracks track-results"><thead><tr><th class="track-number"></th><th>${TagcastI18n.html("tracks.table.titleArtist")}</th><th>${TagcastI18n.html("tracks.table.album")}</th><th class="track-year">${TagcastI18n.html("tracks.table.year")}</th><th class="track-time">${TagcastI18n.html("tracks.table.time")}</th><th class="track-heart" aria-label="${TagcastI18n.html("tracks.table.favourite")}"></th></tr></thead><tbody>${rows.map(foundTrackRow).join("")}</tbody></table>`;
}

function updateTrackSearchScrollFocus() {
  const list = $("#tracks-list");
  // Keep existing focus during resize, but only join the Tab order when scrolling is needed.
  list.setAttribute("tabindex", list.clientWidth > 0 && list.scrollWidth > list.clientWidth ? "0" : "-1");
}

function renderTrackSearch() {
  if (state.screen !== "tracks") return;
  // A library that loaded or changed since the last search is searched again.
  if ($("#tracks-search").value.trim().length >= 2 && !state.loading && !trackSearch.loading
      && (trackSearch.waiting || trackSearch.details !== state.details)) { runTrackSearch(); return; }
  const query = trackSearch.query, rows = trackSearch.results, size = trackSearch.pageSize, maxPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  trackSearch.page = Math.max(0, Math.min(trackSearch.page, maxPage));
  $("#tracks-per-page").value = String(size);
  $("#tracks-results").textContent = query.length < 2 || trackSearch.error ? "" : trackSearch.loading ? TagcastI18n.text("tracks.search.searching")
    : trackSearch.total > rows.length ? TagcastI18n.text("tracks.search.limited", {count: trackSearch.total, shown: rows.length})
    : TagcastI18n.text("browse.count.tracks", {count: trackSearch.total});
  const page = rows.slice(trackSearch.page * size, (trackSearch.page + 1) * size);
  $("#tracks-list").innerHTML = state.loading ? `<div class="empty" role="status"><span class="spinner"></span>${TagcastI18n.html("tracks.list.loadingLibrary")}</div>`
    : query.length < 2 ? `<div class="empty">${TagcastI18n.html("tracks.list.prompt")}</div>`
    : trackSearch.error ? `<p class="error-box" role="alert">${escapeHtml(TagcastI18n.errorText(trackSearch.error))}</p>`
    : page.length ? trackResultsTable(page)
    : trackSearch.loading ? `<div class="empty" role="status"><span class="spinner"></span>${TagcastI18n.html("tracks.list.searching")}</div>`
    : `<div class="empty">${TagcastI18n.html("tracks.list.empty", {query})}</div>`;
  $("#tracks-pagination").innerHTML = maxPage > 0 && !state.loading && query.length >= 2 ? `<button class="button small" data-track-page="-1" ${trackSearch.page === 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${TagcastI18n.html("common.pagination.pageCounted", {page: trackSearch.page + 1, pages: maxPage + 1})}</span><button class="button small" data-track-page="1" ${trackSearch.page === maxPage ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button>` : "";
  updateTrackSearchScrollFocus();
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
  if (player.queue[player.index]?.id === trackId) { if (audioRecoveryPaused()) playSystemPlayback(); else pauseSystemPlayback(); return; }
  const details = state.details, epoch = player.epoch;
  try {
    await albumDetails(shelfIds(albumId));
    if (details !== state.details || epoch !== player.epoch || !live()) return;
    const album = playableAlbum(albumId);
    if (!album?.tracks.some(t => String(t.id) === trackId)) throw viewFailure("errors.album.track_moved");
    playTracks(album, trackId);
  } catch (error) {
    toast(TagcastI18n.text("tracks.play.failed", {error: TagcastI18n.errorText(error)}));
  }
}

async function openFoundTrack(trackId, albumId) {
  if (!state.albums.some(a => String(a.id) === albumId)) { toast(TagcastI18n.text("tracks.open.albumGone")); return; }
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
$("#tracks-list").addEventListener("focusin", event => {
  const list = event.currentTarget, control = event.target.closest("button");
  if (control && list.scrollWidth > list.clientWidth) {
    control.scrollIntoView({block: "nearest", inline: "nearest"});
  }
});
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(updateTrackSearchScrollFocus).observe($("#tracks-list"));
} else window.addEventListener("resize", updateTrackSearchScrollFocus);
document.addEventListener("click", event => {
  const play = event.target.closest("[data-track-play]");
  if (play) { playFoundTrack(play.dataset.trackPlay, play.dataset.trackAlbum); return; }
  const open = event.target.closest("[data-track-open]");
  if (open) { openFoundTrack(open.dataset.trackOpen, open.dataset.trackAlbum); return; }
  const page = event.target.closest("[data-track-page]");
  if (page) {
    trackSearch.page += Number(page.dataset.trackPage);
    renderTrackSearch();
    scrollListingStart("#tracks-page");
  }
});

// A language change repaints the visible results from memory. A search that is waiting for a
// newer library is left to run on its own.
TagcastI18n.subscribe(() => {
  if (state.screen !== "tracks") return;
  const stale = $("#tracks-search").value.trim().length >= 2 && !state.loading && !trackSearch.loading
    && (trackSearch.waiting || trackSearch.details !== state.details);
  if (!stale) keepFocusWhile($("#tracks-page"), renderTrackSearch);
});
