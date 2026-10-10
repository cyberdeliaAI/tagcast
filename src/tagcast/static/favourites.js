"use strict";

// Native iBroadcast likes: rating 5 adds a favourite, 0 clears the rating.
// Only one server page is downloaded; no browser copy of the entire track library.
const storedFavouritesSize = storedPageSize("tagcast-favourites-per-page");
const favourites = {rows: [], total: 0, count: null, query: "", page: 0,
  pageSize: [50, 100, 200].includes(storedFavouritesSize) ? storedFavouritesSize : 50, request: 0,
  epoch: 0, details: null, loading: false, busy: false, error: ""};
let favouritesTimer;
const heartIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';

function heartButton(track) {
  const rating = Number(track.rating) || 0, liked = rating >= 5;
  const label = liked ? `Remove ${track.title} from favourites (clear track rating)` : `Add ${track.title} to favourites (set track rating to 5)`;
  return `<button class="favourite-button" data-favourite="${escapeHtml(track.id)}" data-rating="${rating}" data-favourite-title="${escapeHtml(track.title)}" aria-pressed="${liked}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${!live() || state.loading || favourites.busy || saving || checking ? "disabled" : ""}>${heartIcon}</button>`;
}

function resetFavourites() {
  favourites.epoch += 1; favourites.request += 1;
  Object.assign(favourites, {rows: [], total: 0, count: null, details: null, loading: false, error: ""});
}

function updateFavouriteControls() {
  $("#favourites-count").textContent = live() && favourites.count !== null ? favourites.count.toLocaleString("en") : "";
  const track = player.queue[player.index];
  const button = $("#player-favourite");
  button.innerHTML = heartIcon;
  button.disabled = Boolean(!track || !live() || state.loading || favourites.busy || saving || checking);
  const liked = Number(track?.rating) >= 5;
  button.setAttribute("aria-pressed", String(liked));
  button.setAttribute("aria-label", liked ? "Remove current track from favourites (clear track rating)" : "Add current track to favourites (set track rating to 5)");
  button.title = button.getAttribute("aria-label");
  for (const node of document.querySelectorAll("[data-favourite]")) node.disabled = Boolean(!live() || state.loading || favourites.busy || saving || checking);
}

function setTrackRating(id, rating) {
  syncTrackRatings([{id, rating}]);
}

function syncTrackRatings(tracks) {
  const ratings = new Map(tracks.map(t => [String(t.id), Number(t.rating) || 0]));
  const update = t => { if (ratings.has(String(t.id))) t.rating = ratings.get(String(t.id)); };
  for (const album of state.details.values()) for (const track of album.tracks) update(track);
  for (const track of [...trackSearch.results, ...favourites.rows, ...player.queue]) update(track);
}

async function refreshPlayerRatings() {
  if (!live() || !player.album) return;
  const details = state.details, epoch = favourites.epoch;
  try {
    const albums = await albumDetails(shelfIds(player.album.id));
    if (epoch !== favourites.epoch || details !== state.details) return;
    syncTrackRatings(albums.flatMap(a => a.tracks));
    updateFavouriteControls();
  } catch { /* existing playback continues; a write still checks the current rating */ }
}

async function toggleFavourite(id, before, title = "this track") {
  if (!live() || state.loading || favourites.busy || saving || checking) return;
  if (DIALOGS_WITH_DRAFTS.some(selector => $(selector).open)) { toast("Close the editor or review first, then change favourites."); return; }
  const rating = before >= 5 ? 0 : 5;
  if (before > 0 && before < 5 && !confirm(`“${title}” has track rating ${before}. Add to favourites and replace it with rating 5 in iBroadcast?`)) return;
  const epoch = favourites.epoch;
  favourites.busy = true; saving = true; updateChrome();
  let accepted = false;
  try {
    const response = await api("/api/favourite", {track_id: String(id), before, rating});
    accepted = true;
    if (epoch !== favourites.epoch) return;
    if (response.job) {
      toast("Favourite sent. Checking it against iBroadcast…");
      let job;
      do {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (epoch !== favourites.epoch) return;
        job = await api(`/api/jobs/${encodeURIComponent(response.job)}`);
      } while (job.state === "checking");
      if (epoch !== favourites.epoch) return;
      if (job.state !== "done") throw Error(job.error || "The rating could not be read back. Reload the library.");
      const result = job.results?.find(t => String(t.id) === String(id));
      if (!result) throw Error("The rating could not be read back. Reload the library.");
      setTrackRating(String(id), result.rating);
      if (result.status !== "saved") throw Error("iBroadcast did not confirm this favourite. Reload the library before trying again.");
    } else setTrackRating(String(id), response.rating);
    favourites.details = null;
    // Fetch just one page to update the count and remove/add the changed row.
    await loadFavourites();
    if (epoch !== favourites.epoch) return;
    toast(rating === 5 ? "Added to iBroadcast favourites (track rating 5)." : "Removed from iBroadcast favourites (track rating cleared).");
  } catch (error) {
    if (epoch !== favourites.epoch) return;
    if (error.status === 401) state.connection.connected = false;
    if (accepted) favourites.details = null;
    toast(`${accepted ? "Favourite sent, but not confirmed" : "Could not change favourite"}: ${error.message}`);
  } finally {
    favourites.busy = false; saving = false;
    updateChrome(); renderAlbumView(); renderTrackSearch(); renderFavourites();
    if (typeof renderBrowse === "function") renderBrowse();
  }
}

async function loadFavourites() {
  const request = ++favourites.request, epoch = favourites.epoch;
  favourites.query = $("#favourites-search").value.trim();
  favourites.details = state.details; favourites.error = "";
  if (!live() || state.loading) { favourites.rows = []; favourites.total = 0; renderFavourites(); return; }
  favourites.loading = true; renderFavourites();
  try {
    const data = await api(`/api/favourites?q=${encodeURIComponent(favourites.query)}&offset=${favourites.page * favourites.pageSize}&limit=${favourites.pageSize}`);
    if (request !== favourites.request || epoch !== favourites.epoch || !live()) return;
    Object.assign(favourites, {rows: data.tracks || [], total: data.total || 0, count: data.count || 0,
      page: Math.floor((data.offset || 0) / favourites.pageSize)});
    syncTrackRatings(favourites.rows);
  } catch (error) {
    if (request !== favourites.request || epoch !== favourites.epoch) return;
    favourites.error = error.status === 404 ? "Restart Tagcast to use favourites: the running server is older than this page." : error.message;
    favourites.rows = []; favourites.total = 0;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
  } finally {
    if (request === favourites.request && epoch === favourites.epoch) {
      favourites.loading = false; renderFavourites(); updateFavouriteControls();
    }
  }
}

function renderFavourites() {
  if (state.screen !== "favourites") return;
  if (live() && !state.loading && !favourites.loading && favourites.details !== state.details) { loadFavourites(); return; }
  $("#favourites-per-page").value = String(favourites.pageSize);
  $("#favourites-results").textContent = !live() || state.loading ? "" : favourites.loading ? "Loading favourites…" : `${favourites.total.toLocaleString("en")} ${favourites.total === 1 ? "track" : "tracks"}`;
  $("#favourites-list").innerHTML = !live() ? '<div class="empty">Connect iBroadcast to see and change your favourites.</div>'
    : state.loading || favourites.loading ? '<div class="empty" role="status"><span class="spinner"></span>Loading favourites…</div>'
    : favourites.error ? `<p class="error-box" role="alert">${escapeHtml(favourites.error)}</p>`
    : favourites.rows.length ? `<table class="album-tracks track-results"><thead><tr><th class="track-number"></th><th>Title / Artist</th><th>Album</th><th class="track-year">Year</th><th class="track-time">Time</th><th class="track-heart" aria-label="Favourite"></th></tr></thead><tbody>${favourites.rows.map(foundTrackRow).join("")}</tbody></table>`
    : `<div class="empty">${favourites.query ? "No favourites match your search." : "No favourites yet. Use a heart on an album, a track search result or the player."}</div>`;
  const max = Math.max(0, Math.ceil(favourites.total / favourites.pageSize) - 1);
  $("#favourites-pagination").innerHTML = live() && !favourites.loading && max > 0 ? `<button class="button small" data-favourite-page="-1" ${favourites.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${favourites.page + 1} of ${(max + 1).toLocaleString("en")}</span><button class="button small" data-favourite-page="1" ${favourites.page === max ? "disabled" : ""}>Next →</button>` : "";
  markPlaying();
  if (typeof syncHistory === "function") syncHistory();
}

function showFavourites(page = favourites.page) {
  clearTimeout(favouritesTimer);
  favourites.page = page; showScreen("favourites"); loadFavourites(); window.scrollTo?.({top: 0});
}

$("#show-favourites").addEventListener("click", () => { showFavourites(); $("#favourites-search").focus(); });
$("#favourites-search").addEventListener("input", () => {
  clearTimeout(favouritesTimer);
  favourites.page = 0; favourites.request += 1;
  // Remember the typed text even when an album is opened before the debounce expires.
  if (typeof syncHistory === "function") syncHistory();
  favouritesTimer = setTimeout(loadFavourites, 250);
});
$("#favourites-per-page").addEventListener("change", () => {
  const size = Number($("#favourites-per-page").value);
  if (![50, 100, 200].includes(size)) return;
  favourites.pageSize = size; favourites.page = 0;
  rememberPageSize("tagcast-favourites-per-page", size); loadFavourites();
});
$("#player-favourite").addEventListener("click", () => {
  const track = player.queue[player.index];
  if (track) return toggleFavourite(String(track.id), Number(track.rating) || 0, track.title);
});
document.addEventListener("click", event => {
  const heart = event.target.closest("[data-favourite]");
  if (heart) return toggleFavourite(heart.dataset.favourite, Number(heart.dataset.rating), heart.dataset.favouriteTitle);
  const page = event.target.closest("[data-favourite-page]");
  if (page && !favourites.loading) { favourites.page = Math.max(0, favourites.page + Number(page.dataset.favouritePage)); loadFavourites(); }
});
