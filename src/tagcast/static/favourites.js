"use strict";

// Native iBroadcast track ratings: 5 likes, 1 dislikes, 0 clears the rating.
// Only one server page is downloaded; no browser copy of the entire track library.
const storedFavouritesSize = storedPageSize("tagcast-favourites-per-page");
const favourites = {rows: [], total: 0, count: null, query: "", page: 0,
  pageSize: [50, 100, 200].includes(storedFavouritesSize) ? storedFavouritesSize : 50, request: 0,
  epoch: 0, details: null, loading: false, busy: false, error: "", pending: null};
let favouritesTimer;
const dislikeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 14V3h4v11h-4ZM17 4H7a2 2 0 0 0-2 1.6l-2 7A2 2 0 0 0 5 15h5l-1 4a2 2 0 0 0 2 2l6-7"/></svg>';
const heartIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
const favouriteViews = {tracks: "favourites", albums: "album-favourites", artists: "artist-favourites"};
const favouriteHub = {kind: "tracks", albums: {query: "", offset: 0}};

function rememberFavouriteView() {
  if (state.screen === "album-favourites") favouriteHub.albums = {query: collectionsView.query, offset: collectionsView.offset};
}

function renderFavouriteHub() {
  const kind = Object.keys(favouriteViews).find(key => favouriteViews[key] === state.screen);
  $("#favourites-hub").hidden = !kind;
  if (!kind) return;
  favouriteHub.kind = kind;
  for (const key of Object.keys(favouriteViews)) {
    const tab = $(`#favourites-tab-${key}`);
    tab.setAttribute("aria-selected", String(key === kind));
    tab.setAttribute("tabindex", key === kind ? "0" : "-1");
  }
  $("#favourite-albums-count").textContent = live() && !state.loading && !state.albumFavouriteError
    ? albumShelf().filter(a => itemIds(a).every(id => state.albumFavourites.has(id))).length.toLocaleString("en") : "";
  $("#favourite-artists-count").textContent = live() && !state.loading && !state.artistFavouriteError
    ? artistGroups().filter(([, group]) => favouriteArtistGroup(group)).length.toLocaleString("en") : "";
  $("#breadcrumb").innerHTML = `Favourites<span class="slash" aria-hidden="true">/</span><span aria-current="page">${{tracks: "Tracks", albums: "Albums", artists: "Album artists"}[kind]}</span>`;
}

function showFavouriteView(kind = favouriteHub.kind) {
  if (kind === "tracks") showFavourites();
  else if (kind === "albums") showCollections("album-favourites", null, favouriteHub.albums);
  else if (kind === "artists") showFavouriteArtists();
}

$("#favourites-tabs").addEventListener("click", event => {
  const tab = event.target.closest("[data-favourite-view]");
  if (tab && tab.getAttribute("aria-selected") !== "true") showFavouriteView(tab.dataset.favouriteView);
});
$("#favourites-tabs").addEventListener("keydown", event => {
  const tab = event.target.closest("[data-favourite-view]"), keys = Object.keys(favouriteViews);
  const index = keys.indexOf(tab?.dataset.favouriteView);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1
    : (index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
  if (keys[next] !== favouriteHub.kind) showFavouriteView(keys[next]);
  $(`#favourites-tab-${keys[next]}`).focus();
});

function heartButton(track) {
  const pending = favourites.pending?.id === String(track.id) ? favourites.pending : null;
  const rating = Number(track.rating) || 0, liked = (pending?.rating ?? rating) >= 5;
  const label = liked ? `Remove ${track.title} from favourites (clear track rating)` : `Add ${track.title} to favourites (set track rating to 5)`;
  return `<button class="favourite-button ${pending ? "is-pending" : ""}" data-favourite="${escapeHtml(track.id)}" data-rating="${rating}" data-favourite-title="${escapeHtml(track.title)}" aria-pressed="${liked}" aria-busy="${Boolean(pending)}" aria-label="${escapeHtml(pending?.message || label)}" title="${escapeHtml(pending?.message || label)}" ${!live() || state.loading || favourites.busy || saving || checking ? "disabled" : ""}>${heartIcon}</button>${trackDislikeButton(track)}`;
}

function trackDislikeButton(track) {
  const pending = favourites.pending?.id === String(track.id) ? favourites.pending : null;
  const rating = Number(track.rating) || 0, disliked = (pending?.rating ?? rating) === 1;
  const label = disliked ? `Clear dislike of ${track.title}` : `Dislike ${track.title} (track rating 1)`;
  return `<button type="button" class="favourite-button dislike-button ${pending ? "is-pending" : ""}" data-dislike="${escapeHtml(track.id)}" data-rating="${rating}" data-favourite-title="${escapeHtml(track.title)}" aria-pressed="${disliked}" aria-busy="${Boolean(pending)}" aria-label="${escapeHtml(pending?.message || label)}" title="${escapeHtml(pending?.message || label)}" ${!live() || state.loading || favourites.busy || saving || checking ? "disabled" : ""}>${dislikeIcon}</button>`;
}

function resetFavourites() {
  if (favourites.busy) saving = false;
  favourites.epoch += 1; favourites.request += 1;
  Object.assign(favourites, {rows: [], total: 0, count: null, details: null, loading: false, error: "", pending: null, busy: false});
}

function updateFavouriteControls() {
  $("#favourites-count").textContent = live() && favourites.count !== null ? favourites.count.toLocaleString("en") : "";
  renderFavouriteHub();
  const track = player.queue[player.index];
  const button = $("#player-favourite");
  button.innerHTML = heartIcon;
  button.disabled = Boolean(!track || !live() || state.loading || favourites.busy || saving || checking);
  const pending = favourites.pending?.id === String(track?.id) ? favourites.pending : null;
  const liked = Number(pending?.rating ?? track?.rating) >= 5;
  button.classList.toggle("is-pending", Boolean(pending));
  button.setAttribute("aria-busy", String(Boolean(pending)));
  button.setAttribute("aria-pressed", String(liked));
  button.setAttribute("aria-label", pending?.message || (liked ? "Remove current track from favourites (clear track rating)" : "Add current track to favourites (set track rating to 5)"));
  button.title = button.getAttribute("aria-label");
  const dislike = $("#player-dislike");
  dislike.innerHTML = dislikeIcon; dislike.disabled = button.disabled;
  const disliked = Number(pending?.rating ?? track?.rating) === 1;
  dislike.setAttribute("aria-pressed", String(disliked));
  dislike.setAttribute("aria-busy", String(Boolean(pending)));
  dislike.classList.toggle("is-pending", Boolean(pending));
  dislike.title = pending?.message || (disliked ? "Clear current track dislike" : "Dislike current track (rating 1)");
  dislike.setAttribute("aria-label", dislike.title);
  for (const node of document.querySelectorAll("[data-favourite], [data-dislike]")) {
    const update = favourites.pending?.id === (node.dataset.favourite ?? node.dataset.dislike) ? favourites.pending : null;
    node.disabled = Boolean(!live() || state.loading || favourites.busy || saving || checking);
    node.classList.toggle("is-pending", Boolean(update));
    node.setAttribute("aria-busy", String(Boolean(update)));
    node.setAttribute("aria-pressed", String(node.dataset.dislike !== undefined ? (update?.rating ?? Number(node.dataset.rating)) === 1 : (update?.rating ?? Number(node.dataset.rating)) >= 5));
    if (update) { node.title = update.message; node.setAttribute("aria-label", update.message); }
  }
}

function setTrackRating(id, rating) {
  syncTrackRatings([{id, rating}]);
}

function syncTrackRatings(tracks) {
  const ratings = new Map(tracks.map(t => [String(t.id), Number(t.rating) || 0]));
  const update = t => { if (ratings.has(String(t.id))) t.rating = ratings.get(String(t.id)); };
  for (const album of state.details.values()) for (const track of album.tracks) update(track);
  for (const track of [...trackSearch.results, ...favourites.rows, ...recentlyPlayed.rows, ...player.queue]) update(track);
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

async function toggleFavourite(id, before, title = "this track", requestedRating = null) {
  if (!live() || state.loading || favourites.busy || saving || checking) return;
  if (DIALOGS_WITH_DRAFTS.some(selector => $(selector).open)) { toast("Close the editor or review first, then change favourites."); return; }
  const rating = requestedRating ?? (before >= 5 ? 0 : 5);
  if (![0, 1, 5].includes(rating)) return;
  if (rating === 5 && before > 0 && before < 5 && !confirm(`“${title}” has track rating ${before}. Add to favourites and replace it with rating 5 in iBroadcast?`)) return;
  if (rating === 1 && before > 1 && !confirm(`Dislike “${title}” and replace its current track rating ${before} with 1 in iBroadcast?`)) return;
  const epoch = favourites.epoch;
  const update = {id: String(id), rating, message: "Saving track rating…"};
  favourites.pending = update;
  favourites.busy = true; saving = true; updateChrome();
  let accepted = false;
  try {
    const response = await api("/api/favourite", {track_id: String(id), before, rating});
    accepted = true;
    if (epoch !== favourites.epoch) return;
    if (response.job) {
      update.message = "Track rating sent · checking iBroadcast…"; updateFavouriteControls();
      toast("Track rating sent. Checking it against iBroadcast…");
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
      if (result.status !== "saved") throw Error("iBroadcast did not confirm this track rating. Reload the library before trying again.");
    } else setTrackRating(String(id), response.rating);
    if (favourites.pending === update) favourites.pending = null;
    updateFavouriteControls(); renderAlbumView(); renderTrackSearch();
    favourites.details = null;
    // Fetch just one page to update the count and remove/add the changed row.
    await loadFavourites();
    if (epoch !== favourites.epoch) return;
    toast(rating === 5 ? "Added to iBroadcast favourites (track rating 5)." : rating === 1 ? "Track disliked in iBroadcast (track rating 1)." : "Track rating cleared in iBroadcast.");
  } catch (error) {
    if (epoch !== favourites.epoch) return;
    if (error.status === 401) state.connection.connected = false;
    if (accepted) favourites.details = null;
    toast(`${accepted ? "Track rating sent, but not confirmed" : "Could not change track rating"}: ${error.message}`);
  } finally {
    if (epoch !== favourites.epoch) return;
    if (favourites.pending === update) favourites.pending = null;
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

$("#show-favourites").addEventListener("click", () => showFavouriteView());
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
$("#player-dislike").addEventListener("click", () => {
  const track = player.queue[player.index];
  if (track) return toggleFavourite(String(track.id), Number(track.rating) || 0, track.title, Number(track.rating) === 1 ? 0 : 1);
});
$("#player-favourite").addEventListener("click", () => {
  const track = player.queue[player.index];
  if (track) return toggleFavourite(String(track.id), Number(track.rating) || 0, track.title);
});
document.addEventListener("click", event => {
  const dislike = event.target.closest("[data-dislike]");
  if (dislike) return toggleFavourite(dislike.dataset.dislike, Number(dislike.dataset.rating), dislike.dataset.favouriteTitle, Number(dislike.dataset.rating) === 1 ? 0 : 1);
  const heart = event.target.closest("[data-favourite]");
  if (heart) return toggleFavourite(heart.dataset.favourite, Number(heart.dataset.rating), heart.dataset.favouriteTitle);
  const page = event.target.closest("[data-favourite-page]");
  if (page && !favourites.loading) { favourites.page = Math.max(0, favourites.page + Number(page.dataset.favouritePage)); loadFavourites(); }
});

// Read the native iBroadcast playlist only when this page is opened or refreshed.
// It is an ordered list of recent tracks, not a timestamped log of every play.
const recentlyPlayed = {rows: [], total: 0, available: false, page: 0, pageSize: 50,
  request: 0, details: null, loading: false, error: ""};
let recentlyPlayedTimer;

function resetRecentlyPlayed() {
  clearTimeout(recentlyPlayedTimer);
  recentlyPlayed.request += 1;
  Object.assign(recentlyPlayed, {rows: [], total: 0, available: false, details: null, loading: false, error: ""});
}

function updateRecentlyPlayedControls() {
  $("#show-recently-played").hidden = !live() || !playReporting.enabled;
  if (typeof applySidebarLayout === "function") applySidebarLayout();
}

async function loadRecentlyPlayed(refresh = false) {
  const request = ++recentlyPlayed.request, details = state.details, session = state.connection.playback_session;
  recentlyPlayed.details = details; recentlyPlayed.error = "";
  if (!live() || !playReporting.enabled || state.loading) {
    recentlyPlayed.rows = []; recentlyPlayed.total = 0; renderRecentlyPlayed(); return;
  }
  recentlyPlayed.loading = true; renderRecentlyPlayed();
  const current = () => request === recentlyPlayed.request && details === state.details
    && session === state.connection.playback_session && live() && playReporting.enabled;
  try {
    const data = await api(`/api/recently-played?q=${encodeURIComponent($("#recently-played-search").value.trim())}&offset=${recentlyPlayed.page * recentlyPlayed.pageSize}&limit=${recentlyPlayed.pageSize}${refresh ? "&refresh=1" : ""}`);
    if (!current()) return;
    Object.assign(recentlyPlayed, {rows: data.enabled ? data.tracks || [] : [], total: data.total || 0,
      available: data.enabled && data.available, page: Math.floor((data.offset || 0) / recentlyPlayed.pageSize)});
    syncTrackRatings(recentlyPlayed.rows);
  } catch (error) {
    if (!current()) return;
    recentlyPlayed.error = error.status === 404 ? "Restart Tagcast to use Recently played: the running server is older than this page." : error.message;
    recentlyPlayed.rows = []; recentlyPlayed.total = 0;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
  } finally {
    if (current()) {
      recentlyPlayed.loading = false; renderRecentlyPlayed(); updateFavouriteControls();
    } else if (request === recentlyPlayed.request) {
      resetRecentlyPlayed(); renderRecentlyPlayed(); updateRecentlyPlayedControls();
    }
  }
}

function renderRecentlyPlayed() {
  if (state.screen !== "recently-played") return;
  if (live() && playReporting.enabled && !state.loading && !recentlyPlayed.loading
      && recentlyPlayed.details !== state.details) { loadRecentlyPlayed(); return; }
  $("#recently-played-per-page").value = String(recentlyPlayed.pageSize);
  $("#recently-played-refresh").disabled = !live() || !playReporting.enabled || state.loading || recentlyPlayed.loading;
  $("#recently-played-results").textContent = recentlyPlayed.loading ? "Checking iBroadcast’s recent tracks…"
    : recentlyPlayed.available ? `${recentlyPlayed.total.toLocaleString("en")} ${recentlyPlayed.total === 1 ? "track" : "tracks"} · most recent first` : "";
  $("#recently-played-list").innerHTML = !live() ? '<div class="empty">Connect iBroadcast to see recently played tracks.</div>'
    : !playReporting.enabled ? '<div class="empty">Enable Record played tracks in iBroadcast in Settings to show this list.</div>'
    : state.loading || recentlyPlayed.loading ? '<div class="empty" role="status"><span class="spinner"></span>Checking iBroadcast’s recent tracks…</div>'
    : recentlyPlayed.error ? `<p class="error-box" role="alert">${escapeHtml(recentlyPlayed.error)}</p>`
    : !recentlyPlayed.available ? '<div class="empty">iBroadcast did not provide a Recently played playlist for this account.</div>'
    : recentlyPlayed.rows.length ? `<table class="album-tracks track-results"><thead><tr><th class="track-number"></th><th>Title / Artist</th><th>Album</th><th class="track-year">Year</th><th class="track-time">Time</th><th class="track-heart" aria-label="Favourite"></th></tr></thead><tbody>${recentlyPlayed.rows.map(foundTrackRow).join("")}</tbody></table>`
    : `<div class="empty">${$("#recently-played-search").value.trim() ? "No recent tracks match your search." : "No recently played tracks in iBroadcast yet."}</div>`;
  const max = Math.max(0, Math.ceil(recentlyPlayed.total / recentlyPlayed.pageSize) - 1);
  $("#recently-played-pagination").innerHTML = live() && playReporting.enabled && !recentlyPlayed.loading && max > 0 ? `<button class="button small" data-recent-page="-1" ${recentlyPlayed.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${recentlyPlayed.page + 1} of ${max + 1}</span><button class="button small" data-recent-page="1" ${recentlyPlayed.page === max ? "disabled" : ""}>Next →</button>` : "";
  markPlaying();
  if (typeof syncHistory === "function") syncHistory();
}

function showRecentlyPlayed(page = recentlyPlayed.page) {
  clearTimeout(recentlyPlayedTimer);
  recentlyPlayed.page = page; showScreen("recently-played"); loadRecentlyPlayed(); window.scrollTo?.({top: 0});
}

$("#show-recently-played").addEventListener("click", () => showRecentlyPlayed());
$("#recently-played-refresh").addEventListener("click", () => loadRecentlyPlayed(true));
$("#recently-played-search").addEventListener("input", () => {
  clearTimeout(recentlyPlayedTimer);
  recentlyPlayed.page = 0; recentlyPlayed.request += 1; recentlyPlayed.loading = false;
  if (typeof syncHistory === "function") syncHistory();
  recentlyPlayedTimer = setTimeout(loadRecentlyPlayed, 250);
});
$("#recently-played-per-page").addEventListener("change", () => {
  const size = Number($("#recently-played-per-page").value);
  if (![50, 100, 200].includes(size)) return;
  recentlyPlayed.pageSize = size; recentlyPlayed.page = 0; loadRecentlyPlayed();
});
document.addEventListener("click", event => {
  const page = event.target.closest("[data-recent-page]");
  if (page && !recentlyPlayed.loading) { recentlyPlayed.page = Math.max(0, recentlyPlayed.page + Number(page.dataset.recentPage)); loadRecentlyPlayed(); }
});
