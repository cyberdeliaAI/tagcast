"use strict";

// Local album favourites and native collections stay separate from metadata drafts and History.
const collectionsView = {request: 0, query: "", offset: 0, playlist: null, data: null, error: null, loading: false, busy: false, rating: null, favourite: null};
try { collectionsView.view = localStorage.getItem("tagcast-playlists-view") === "list" ? "list" : "grid"; } catch { collectionsView.view = "grid"; }
const playlistDraft = {body: null, details: null, session: "", selected: null, request: 0};

// Tagcast's own playlist failures keep an English message for logs and carry a code, so
// TagcastI18n.errorText() shows them in the interface language. Callers name the full key.
function playlistFailure(key, params) {
  return TagcastI18n.failure(key.replace(/^errors\./, ""), params);
}

async function collectionJob(response, current) {
  let job;
  do {
    if (!current()) throw playlistFailure("errors.playlists.connection_changed");
    job = await api(`/api/jobs/${encodeURIComponent(response.job)}`);
    if (!current()) throw playlistFailure("errors.playlists.connection_changed");
    if (job.state === "checking") await new Promise(resolve => setTimeout(resolve, 1000));
  } while (job.state === "checking");
  // A server message stays as reported; only Tagcast's own fallback is interface text.
  if (job.state !== "done") throw job.error ? Error(job.error) : playlistFailure("errors.playlists.readback_failed");
  if (Object.hasOwn(job, "playlists_count")) updatePlaylistCount(job.playlists_count);
  return job;
}

function albumFavouriteControls(discs, disabled) {
  const ids = discs.map(d => String(d.id)), update = collectionsView.favourite;
  const current = update?.details === state.details && update.session === state.connection.playback_session
    && update.ids.join(",") === ids.join(",") ? update : null;
  const favourite = current?.pending ? current.value : ids.every(id => state.albumFavourites.has(id));
  const status = state.albumFavouriteError || current?.status() || "";
  return {button: `<button class="album-rating-choice ${favourite ? "is-selected" : ""}" data-album-favourite="${escapeHtml(ids.join(","))}" data-heart title="${TagcastI18n.html("playlists.albumFavourite.title")}" aria-label="${TagcastI18n.html(favourite ? "playlists.albumFavourite.remove" : "playlists.albumFavourite.add")}" aria-pressed="${favourite}" aria-busy="${Boolean(current?.pending)}" ${disabled || state.albumFavouriteError ? "disabled" : ""}>${favourite ? "♥" : "♡"}</button>`, status: status ? `<small class="album-rating-status ${state.albumFavouriteError || current?.error ? "error-text" : "muted"}" role="status">${escapeHtml(status)}</small>` : ""};
}

function albumRatingControls(discs) {
  const update = collectionsView.rating, current = update?.details === state.details && update.session === state.connection.playback_session
    && update.ids.join(",") === discs.map(d => String(d.id)).join(",") ? update : null;
  const rating = current?.pending ? current.value : Math.min(...discs.map(d => d.rating || 0)), mixed = new Set(discs.map(d => d.rating || 0)).size > 1;
  const ids = escapeHtml(discs.map(d => d.id).join(","));
  const disabled = !live() || state.loading || collectionsView.busy || saving || checking;
  const hasRating = current?.pending ? current.value > 0 : discs.some(d => d.rating > 0);
  const favourite = albumFavouriteControls(discs, disabled);
  return `<div class="album-rating" role="group" aria-label="${TagcastI18n.html("playlists.albumRating.group")}" aria-busy="${Boolean(current?.pending)}">${favourite.button}${[1, 2, 3, 4, 5].map(n => `<button class="album-rating-choice ${n <= rating ? "is-selected" : ""}" data-album-rating="${ids}" data-value="${n}" aria-label="${TagcastI18n.html("playlists.albumRating.rate", {rating: n})}" aria-pressed="${n <= rating}" ${disabled ? "disabled" : ""}>${n <= rating ? "★" : "☆"}</button>`).join("")}${hasRating ? `<button class="text-action album-rating-clear" data-album-rating="${ids}" data-value="0" ${disabled ? "disabled" : ""}>${TagcastI18n.html("playlists.albumRating.clear")}</button>` : ""}${mixed && !current?.pending ? `<small class="muted">${TagcastI18n.html("playlists.albumRating.mixed")}</small>` : ""}${current ? `<small class="album-rating-status ${current.error ? "error-text" : "muted"}" role="status">${escapeHtml(current.status())}</small>` : ""}${favourite.status}</div>`;
}

async function toggleAlbumFavourite(ids) {
  if (!live() || state.loading || collectionsView.busy || saving || checking || state.albumFavouriteError) return;
  if (document.querySelector("dialog[open]")) { toast(TagcastI18n.text("playlists.album.closeReview")); return; }
  if (!ids.length || !ids.every(id => state.details.has(id))) return;
  const before = ids.map(id => state.albumFavourites.has(id)), favourite = !before.every(Boolean);
  const focused = document.activeElement?.getAttribute?.("data-album-favourite") === ids.join(",");
  const details = state.details, session = state.connection.playback_session;
  const current = () => details === state.details && session === state.connection.playback_session && live();
  // Status texts are kept as functions, so a later repaint shows them in the current language.
  const update = {ids, value: favourite, details, session, pending: true, error: false, status: () => TagcastI18n.text("playlists.albumFavourite.saving")};
  collectionsView.rating = null; collectionsView.favourite = update; collectionsView.busy = true; renderAlbumView();
  try {
    const response = await api("/api/album-favourite", {albums: ids, before, favourite, session,
      combine_sets: Boolean(state.connection.combine_sets)});
    if (!current()) return;
    if (!ids.every(id => response.results?.some(r => r.id === id && r.favourite === favourite))) throw playlistFailure("errors.playlists.favourite_unconfirmed");
    for (const id of ids) { if (favourite) state.albumFavourites.add(id); else state.albumFavourites.delete(id); }
    update.status = () => TagcastI18n.text(favourite ? "playlists.albumFavourite.saved" : "playlists.albumFavourite.removed");
    toast(update.status());
  } catch (error) { if (current()) { update.error = true; update.status = () => TagcastI18n.errorText(error); toast(update.status()); } }
  finally {
    update.pending = false; collectionsView.busy = false;
    if (current()) {
      renderAlbumView();
      if (state.screen === "album-favourites") renderCollections();
      if (focused && state.screen === "album") document.querySelector(`[data-album-favourite="${ids.join(",")}"]`)?.focus();
    }
  }
}

async function rateAlbum(ids, rating) {
  if (!live() || state.loading || collectionsView.busy || saving || checking) return;
  if (document.querySelector("dialog[open]")) { toast(TagcastI18n.text("playlists.album.closeReview")); return; }
  const discs = ids.map(id => state.details.get(id));
  if (!discs.every(Boolean)) return;
  const before = discs.map(d => d.rating || 0), details = state.details, session = state.connection.playback_session;
  const update = {ids, value: rating, details, session, pending: true, status: () => TagcastI18n.text("playlists.albumRating.saving"), error: false};
  const current = () => details === state.details && session === state.connection.playback_session && live();
  collectionsView.favourite = null; collectionsView.rating = update;
  collectionsView.busy = true;
  renderAlbumView();
  try {
    const response = await api("/api/album-rating", {albums: ids, before, rating});
    if (!current()) return;
    update.status = () => TagcastI18n.text("playlists.albumRating.sent"); renderAlbumView();
    toast(TagcastI18n.text("playlists.albumRating.sentToast"));
    const job = await collectionJob(response, current);
    for (const r of job.results || []) {
      const summary = state.albums.find(a => String(a.id) === String(r.id)), detail = state.details.get(String(r.id));
      if (summary) summary.rating = r.rating;
      if (detail) detail.rating = r.rating;
    }
    // Merged sets copy their disc ratings; refresh that derived shelf after read-back.
    shelfCache.albums = null;
    if (response.error || !ids.every(id => job.results?.some(r => String(r.id) === String(id) && r.status === "saved" && Number(r.rating) === rating))) throw response.error ? Error(response.error) : playlistFailure("errors.playlists.rating_unconfirmed");
    update.status = () => TagcastI18n.text("playlists.albumRating.saved");
    toast(TagcastI18n.text("playlists.albumRating.savedToast"));
  } catch (error) { if (current()) { update.error = true; update.status = () => TagcastI18n.errorText(error); toast(update.status()); } }
  finally {
    update.pending = false; collectionsView.busy = false;
    if (current()) {
      renderAlbumView();
      if (state.screen === "albums") render();
      if (state.screen === "album-favourites") renderCollections();
    }
  }
}

function playlistAlbumButton(id) {
  return `<button class="button small" data-playlist-album="${escapeHtml(id)}" ${!live() ? "disabled" : ""}>♫ ${TagcastI18n.html("playlists.album.addToPlaylist")}</button>`;
}

async function selectedQueueTracks(ids, current) {
  const tracks = [];
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const result = await api("/api/queue-tracks", {tracks: ids.slice(offset, offset + 1000)});
    if (!current()) throw playlistFailure("errors.playlists.queue_changed");
    tracks.push(...result.tracks);
  }
  return tracks;
}

async function openTrackPlaylist(albumId, trackId) {
  if (!live() || state.loading || collectionsView.busy || document.querySelector("dialog[open]")) return;
  const request = ++playlistDraft.request, details = state.details, session = state.connection.playback_session;
  const current = () => request === playlistDraft.request && details === state.details && session === state.connection.playback_session && live();
  try {
    const rows = await selectedQueueTracks([Number(trackId)], current);
    if (!current()) return;
    if (rows.length !== 1 || rows[0].id !== String(trackId) || !shelfIds(albumId).includes(String(rows[0].album.id))) throw playlistFailure("errors.playlists.track_moved");
    if (!document.querySelector("dialog[open]")) return openPlaylistSave(rows);
  } catch (error) { if (current()) toast(TagcastI18n.errorText(error)); }
}

function replaceCollections(html) {
  const input = document.activeElement, restore = input?.id === "collection-search";
  const start = input?.selectionStart, end = input?.selectionEnd;
  $("#collections-page").innerHTML = html;
  if (restore) { $("#collection-search").focus(); $("#collection-search").setSelectionRange?.(start, end); }
}

function collectionsUnavailable() {
  return `<div class="empty">${TagcastI18n.html(state.loading ? "playlists.page.loadingLibrary" : "playlists.page.connect")}</div>`;
}

function collectionsError(error) {
  return `<p class="error-box">${escapeHtml(TagcastI18n.errorText(error))}</p>`;
}

function playlistsLoading() {
  return `<p class="muted" role="status">${TagcastI18n.html("playlists.page.loading")}</p>`;
}

// Favourite albums come from memory. False when the page shows the local storage error instead.
function renderAlbumFavourites(page) {
  const albums = albumShelf().filter(a => itemIds(a).every(id => state.albumFavourites.has(id))), filtered = albums.filter(a => `${a.name} ${albumArtistsText(a)}`.toLowerCase().includes(collectionsView.query.toLowerCase()));
  if (state.albumFavouriteError) { page.innerHTML = `<p class="error-box">${escapeHtml(state.albumFavouriteError)}</p>`; return false; }
  collectionsView.offset = Math.min(collectionsView.offset, Math.max(0, Math.ceil(filtered.length / 50) - 1) * 50);
  const search = TagcastI18n.html("playlists.favourites.search");
  replaceCollections(`<p class="muted">${TagcastI18n.html("playlists.favourites.intro")}</p>${clearableSearchInput("collection-search", `class="collection-search" placeholder="${search}" aria-label="${search}"`, collectionsView.query)}<p>${TagcastI18n.html("common.count.albums", {count: filtered.length})}</p><div class="album-grid">${gridView(filtered.slice(collectionsView.offset, collectionsView.offset + 50)) || `<div class="empty">${TagcastI18n.html("playlists.favourites.empty")}</div>`}</div>${collectionPages(filtered.length, 50)}`);
  return true;
}

function playlistDetailPage(data) {
  const matched = data.matched_total ?? data.total;
  const reorderBlocked = data.large || (data.stored_total ?? data.before?.length ?? data.total) < 2;
  return `<button class="button small page-back" data-playlist-back>${TagcastI18n.html("playlists.page.back")}</button><div class="page-intro playlist-intro">${playlistEditableCover(data)}<div><h1>${escapeHtml(data.name)}</h1><p>${escapeHtml(data.description)}</p></div></div><div class="album-detail-actions"><button class="button primary" data-playlist-play ${data.tracks.length ? "" : "disabled"}>▶ ${TagcastI18n.html(data.large ? "playlists.detail.playPage" : "playlists.detail.play")}</button><button type="button" class="button" data-playlist-shuffle ${data.tracks.length ? "" : "disabled"}>${TagcastI18n.html(data.large ? "playlists.detail.shufflePage" : "playlists.detail.shuffle")}</button><button class="button" data-playlist-edit ${data.large ? `disabled title="${TagcastI18n.html("playlists.detail.editLimit")}"` : ""}>${TagcastI18n.html("playlists.detail.edit")}</button><button type="button" class="button" data-playlist-reorder ${reorderBlocked ? `disabled title="${TagcastI18n.html("playlists.detail.reorderLimit")}"` : ""}>${TagcastI18n.html("playlists.detail.reorder")}</button><button class="button" data-playlist-add-queue>${TagcastI18n.html("playlists.detail.addQueue")}</button><button class="button danger" data-playlist-delete>${TagcastI18n.html("playlists.detail.delete")}</button></div><p>${TagcastI18n.html("common.count.tracks", {count: data.total})}${playlistDuration(data)} · ${TagcastI18n.html("playlists.detail.inOrder")}</p>${clearableSearchInput("collection-search", `class="collection-search" maxlength="200" placeholder="${TagcastI18n.html("playlists.detail.search")}" aria-label="${TagcastI18n.html("playlists.detail.searchLabel")}"`, collectionsView.query)}${collectionsView.query ? `<p role="status">${TagcastI18n.html("playlists.detail.matching", {count: matched})}</p>` : ""}${data.large ? `<p class="muted">${TagcastI18n.html("playlists.detail.largeNote")}</p>` : ""}<table class="album-tracks album-tracklist track-results"><thead><tr><th class="track-number"><span class="track-number-label">#</span></th><th>${TagcastI18n.html("playlists.detail.titleArtist")}</th><th>${TagcastI18n.html("playlists.detail.album")}</th><th class="track-time">${TagcastI18n.html("playlists.detail.time")}</th><th aria-label="${TagcastI18n.html("playlists.detail.actions")}"></th></tr></thead><tbody>${data.rows.map(t => `<tr data-row="${escapeHtml(t.id)}"><td class="track-number">${trackNumberControl(t, t.position + 1, `data-playlist-position="${escapeHtml(t.position)}"`, true)}</td><td><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}</small></td><td><button class="text-action" data-album="${t.album_id}">${escapeHtml(t.album)}</button></td><td class="track-time">${trackDuration(t.length)}${trackFormatLabel(t)}</td><td><div class="playlist-track-actions">${queueButton(t.album_id, t)}${playlistRemoveButton(data, t)}</div></td></tr>`).join("") || `<tr><td colspan="5" class="muted">${TagcastI18n.html(collectionsView.query ? "playlists.detail.noMatches" : "playlists.detail.empty")}</td></tr>`}</tbody></table>${collectionPages(matched, 100)}`;
}

// Draws loaded playlist data (catalogue, folder or playlist) without a request.
function renderPlaylistPage(data) {
  if (data.is_folder) $("#collections-page").innerHTML = playlistFolderPage(data);
  else replaceCollections(collectionsView.playlist ? playlistDetailPage(data) : playlistCataloguePage(data));
}

async function renderCollections() {
  if (!["playlists", "album-favourites"].includes(state.screen)) return;
  const page = $("#collections-page");
  if (state.screen === "playlists") $("#breadcrumb").textContent = TagcastI18n.text("playlists.breadcrumb");
  else renderFavouriteHub();
  if (!live() || state.loading) { page.innerHTML = collectionsUnavailable(); return; }
  collectionsView.details = state.details;
  if (state.screen === "album-favourites") {
    if (renderAlbumFavourites(page) && typeof syncHistory === "function") syncHistory();
    return;
  }
  const request = ++collectionsView.request, details = state.details;
  collectionsView.loading = true;
  if (!collectionsView.data) page.innerHTML = playlistsLoading();
  try {
    const data = await api(`/api/playlists?${collectionsView.playlist ? `id=${encodeURIComponent(collectionsView.playlist)}${collectionsView.query ? `&q=${encodeURIComponent(collectionsView.query)}` : ""}` : `q=${encodeURIComponent(collectionsView.query)}&browse=1`}&offset=${collectionsView.offset}`);
    if (request !== collectionsView.request || details !== state.details || state.screen !== "playlists") return;
    collectionsView.data = data; collectionsView.error = null;
    if (Object.hasOwn(data, "playlists_count")) updatePlaylistCount(data.playlists_count);
    renderPlaylistPage(data);
    markPlaying();
    if (typeof syncHistory === "function") syncHistory();
  } catch (error) { if (request === collectionsView.request && details === state.details) { collectionsView.error = error; page.innerHTML = collectionsError(error); } }
  finally {
    if (request === collectionsView.request) {
      collectionsView.loading = false;
      if (typeof syncHistory === "function") syncHistory();
    }
  }
}

function collectionPages(total, size) {
  return total > size ? `<div class="pagination"><button class="button small" data-collection-page="${-size}" ${collectionsView.offset ? "" : "disabled"}>${TagcastI18n.html("common.pagination.previous")}</button><span>${Math.floor(collectionsView.offset / size) + 1} / ${Math.ceil(total / size)}</span><button class="button small" data-collection-page="${size}" ${collectionsView.offset + size >= total ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>` : "";
}

function showCollections(screen, id = null, saved = {}) {
  rememberFavouriteView();
  collectionsView.request += 1; collectionsView.query = saved.query || ""; collectionsView.offset = saved.offset || 0; collectionsView.playlist = id;
  collectionsView.data = null; collectionsView.error = null;
  showScreen(screen);
}

// Only the playing-row marks; markPlaying() would also republish the queue and player state.
function markCollectionRows() {
  const current = player.queue[player.index]?.id;
  for (const row of document.querySelectorAll("#collections-page [data-row]")) {
    const playing = !audio.paused && row.dataset.row === current;
    row.classList.toggle("playing", playing);
    if (playing) row.setAttribute?.("aria-current", "true"); else row.removeAttribute?.("aria-current");
  }
}

// A language change repaints the visible playlists or favourite albums page from memory: no
// request, and the page, search (with its focus), scroll position and open dialogs stay as they
// are. A request in flight paints in the new language when it arrives.
function repaintCollections() {
  if (!["playlists", "album-favourites"].includes(state.screen)) return;
  const page = $("#collections-page");
  if (state.screen === "playlists") $("#breadcrumb").textContent = TagcastI18n.text("playlists.breadcrumb");
  if (!live() || state.loading) { page.innerHTML = collectionsUnavailable(); return; }
  if (collectionsView.details !== state.details) return;
  const top = window.scrollY;
  if (state.screen === "album-favourites") renderAlbumFavourites(page);
  else if (collectionsView.loading) { if (!collectionsView.data) page.innerHTML = playlistsLoading(); }
  else if (collectionsView.error) page.innerHTML = collectionsError(collectionsView.error);
  else if (collectionsView.data) { renderPlaylistPage(collectionsView.data); markCollectionRows(); }
  if (typeof top === "number" && window.scrollY !== top) window.scrollTo?.({top});
}
TagcastI18n.subscribe(repaintCollections);

async function openPlaylistSave(tracks = [], edit = null, destination = null, revised = null) {
  if (!live() || collectionsView.busy) return;
  if (typeof invalidatePlaylistFolder === "function") invalidatePlaylistFolder();
  const request = ++playlistDraft.request, details = state.details, session = state.connection.playback_session;
  playlistDraft.details = details; playlistDraft.session = session; playlistDraft.body = null; playlistDraft.selected = edit;
  const unique = [...new Map(tracks.map(t => [String(t.id), t])).values()];
  $("#playlist-dialog-title").textContent = TagcastI18n.text(edit ? "playlists.save.titleEdit" : "playlists.save.titleAdd");
  $("#playlist-dialog-content").innerHTML = `<p>${TagcastI18n.html("playlists.save.loading")}</p>`;
  $("#playlist-dialog").showModal();
  try {
    const choices = edit ? {playlists: []} : destination ? {playlists: [await api(`/api/playlists?id=${encodeURIComponent(destination)}`)]} : await api("/api/playlists");
    if (request !== playlistDraft.request || details !== state.details || session !== state.connection.playback_session || !$("#playlist-dialog").open) return;
    playlistDraft.tracks = unique;
    playlistDraft.choices = choices.playlists;
    const repeated = unique.length !== tracks.length;
    const summary = edit ? `${TagcastI18n.html("playlists.save.positions", {count: Number(edit.stored_total ?? edit.total ?? tracks.length)})} · ${TagcastI18n.html("playlists.save.editTracks", {count: unique.length})}`
      : TagcastI18n.html(repeated ? "playlists.save.summaryRepeated" : "playlists.save.summary", {count: unique.length});
    $("#playlist-dialog-content").innerHTML = `<form id="playlist-form">${edit ? "" : `<label>${TagcastI18n.html("playlists.save.destination")} <select name="destination"><option value="new">${TagcastI18n.html("playlists.save.newPrivate")}</option>${choices.playlists.map(p => `<option value="${p.id}" ${destination === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></label><div class="clearable-field"><label for="playlist-destination-query">${TagcastI18n.html("playlists.save.findLabel")}</label>${clearableSearchInput("playlist-destination-query", 'name="playlist_query" maxlength="200"')}</div><button type="button" class="button small" data-playlist-find>${TagcastI18n.html("playlists.save.find")}</button>`}<label>${TagcastI18n.html("playlists.save.name")} <input name="name" maxlength="200" value="${escapeHtml(revised?.name ?? edit?.name ?? "")}"></label><label>${TagcastI18n.html("playlists.save.description")} <textarea name="description" maxlength="2000">${escapeHtml(revised?.description ?? edit?.description ?? "")}</textarea></label><p>${summary}</p><div class="playlist-review-tracks">${unique.map((t, i) => `<label class="checkline"><input type="checkbox" name="track" value="${t.id}" ${!revised || revised.selected.includes(String(t.id)) ? "checked" : ""}> ${i + 1}. ${escapeHtml(t.title)} · ${escapeHtml(t.artist)}</label>`).join("")}</div><div class="dialog-footer"><button type="button" class="button" data-close="playlist-dialog">${TagcastI18n.html("common.cancel")}</button><button class="button primary">${TagcastI18n.html("playlists.save.prepare")}</button></div></form>`;
  } catch (error) { if (request === playlistDraft.request && details === state.details && session === state.connection.playback_session) $("#playlist-dialog-content").innerHTML = collectionsError(error); }
}

function playlistRemoveButton(data, track) {
  if (!Number.isInteger(track.stored_position)) return "";
  return `<button type="button" class="playlist-track-remove" data-playlist-remove="${track.stored_position}" aria-label="${TagcastI18n.html("playlists.remove.label", {title: track.title, position: track.position + 1})}" title="${TagcastI18n.html(data.large ? "playlists.remove.limited" : "playlists.remove.title")}" ${data.large ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg></button>`;
}

function openPlaylistTrackRemove(position) {
  const data = collectionsView.data;
  if (!live() || state.loading || collectionsView.loading || collectionsView.busy || !data
      || data.large || data.is_folder || !data.before_token || document.querySelector("dialog[open]")) return;
  const track = data.rows.find(row => row.stored_position === position);
  if (!track || !Number.isInteger(position) || Number(data.before?.[position]) !== Number(track.id)) return;
  if (typeof invalidatePlaylistFolder === "function") invalidatePlaylistFolder();
  playlistDraft.request += 1;
  Object.assign(playlistDraft, {details: state.details, session: state.connection.playback_session, selected: null,
    body: {action: "remove-track", playlist: data.id, position, track: Number(track.id), approved: true,
      before_token: data.before_token, before_name: data.name, session: state.connection.playback_session}});
  $("#playlist-dialog-title").textContent = TagcastI18n.text("playlists.remove.title");
  const playlist = TagcastI18n.trusted(`<strong>${escapeHtml(data.name)}</strong>`);
  $("#playlist-dialog-content").innerHTML = `<h3>${escapeHtml(track.title)}</h3><p>${escapeHtml(track.artist)} · ${escapeHtml(track.album)}</p><p>${TagcastI18n.html("playlists.remove.confirm", {position: track.position + 1, playlist})}</p><div class="dialog-footer"><button type="button" class="button" data-close="playlist-dialog">${TagcastI18n.html("playlists.remove.keep")}</button><button type="button" class="button danger" data-playlist-save>${TagcastI18n.html("playlists.remove.title")}</button></div>`;
  $("#playlist-dialog").showModal();
}

async function openPlaylistDelete(id) {
  if (!live() || collectionsView.busy || document.querySelector("dialog[open]")) return;
  if (typeof invalidatePlaylistFolder === "function") invalidatePlaylistFolder();
  const request = ++playlistDraft.request, details = state.details, session = state.connection.playback_session;
  Object.assign(playlistDraft, {details, session, body: null, selected: null});
  $("#playlist-dialog-title").textContent = TagcastI18n.text("playlists.delete.title");
  $("#playlist-dialog-content").innerHTML = `<p>${TagcastI18n.html("playlists.delete.loading")}</p>`;
  $("#playlist-dialog").showModal();
  try {
    const data = await api(`/api/playlists?id=${encodeURIComponent(id)}`);
    if (request !== playlistDraft.request || details !== state.details || session !== state.connection.playback_session || !$("#playlist-dialog").open) return;
    playlistDraft.body = {action: "delete", playlist: data.id, ...(data.before_token ? {before_token: data.before_token} : {before: data.before}), before_name: data.name, confirm_delete: true};
    $("#playlist-dialog-content").innerHTML = `<h3>${escapeHtml(data.name)}</h3><p>${TagcastI18n.html("playlists.delete.count", {count: data.total})}</p><div class="warn-box">${TagcastI18n.html("playlists.delete.warning")}</div><div class="dialog-footer"><button class="button" data-close="playlist-dialog">${TagcastI18n.html("playlists.delete.keep")}</button><button class="button danger primary" data-playlist-save>${TagcastI18n.html("playlists.delete.title")}</button></div>`;
  } catch (error) { if (request === playlistDraft.request && details === state.details) $("#playlist-dialog-content").innerHTML = collectionsError(error); }
}

async function reviewPlaylist(form) {
  const request = playlistDraft.request;
  const destination = playlistDraft.selected?.id || form.elements.destination.value;
  const selected = new Set([...form.querySelectorAll('input[name="track"]')].filter(t => t.checked).map(t => t.value));
  const ids = playlistDraft.tracks.filter(t => selected.has(t.id)).map(t => Number(t.id));
  const edit = playlistDraft.selected;
  let body = {action: edit ? "replace" : destination === "new" ? "create" : "append", tracks: ids,
    name: form.elements.name.value.trim(), description: form.elements.description.value.trim()};
  if (destination !== "new") {
    const current = edit || await api(`/api/playlists?id=${encodeURIComponent(destination)}`);
    body.playlist = current.id;
    if (current.before_token) body.before_token = current.before_token; else body.before = current.before || current.tracks;
    body.before_name = current.name;
    if (!body.name || body.action === "append") body.name = current.name;
  }
  if (!body.name) { toast(TagcastI18n.text("playlists.review.enterName")); return; }
  let textReview = "";
  if (edit && ids.length === playlistDraft.tracks.length) {
    const fields = {};
    for (const key of ["name", "description"]) {
      if (form.elements[key].value !== (edit[key] || "") && body[key] !== (edit[key] || "")) fields[key] = body[key];
    }
    if (!Object.keys(fields).length) { playlistDraft.body = null; toast(TagcastI18n.text("playlists.review.noChanges")); return; }
    body = {action: "metadata", playlist: edit.id, before_token: edit.before_token, before_name: edit.name,
      session: playlistDraft.session, approved: true, fields};
    const labels = {name: "playlists.save.name", description: "playlists.save.description"}, empty = TagcastI18n.html("playlists.review.empty");
    textReview = `<h3>${escapeHtml(edit.name)}</h3><p>${TagcastI18n.html("playlists.review.details")}</p>${Object.entries(fields).map(([key, value]) => `<div class="playlist-text-change"><strong>${TagcastI18n.html(labels[key])}</strong><div class="playlist-text-before"><span class="muted">${TagcastI18n.html("playlists.review.before")}</span><p>${edit[key] ? escapeHtml(edit[key]) : empty}</p></div><div><span class="muted">${TagcastI18n.html("playlists.review.after")}</span><p>${value ? escapeHtml(value) : empty}</p></div></div>`).join("")}`;
  }
  if (request !== playlistDraft.request || playlistDraft.details !== state.details || playlistDraft.session !== state.connection.playback_session) { toast(TagcastI18n.text("playlists.review.changed")); return; }
  playlistDraft.formValues = {name: form.elements.name.value, description: form.elements.description.value,
    selected: [...selected], destination};
  playlistDraft.body = body;
  const replacing = body.action === "replace";
  const summary = {replace: "playlists.review.replace", append: "playlists.review.append"}[body.action] || "playlists.review.create";
  $("#playlist-dialog-content").innerHTML = `${textReview || `<h3>${escapeHtml(body.name)}</h3><p>${TagcastI18n.html(summary, {count: ids.length})} ${TagcastI18n.html(replacing ? "playlists.review.replaceNote" : "playlists.review.appendNote")}</p><div class="playlist-review-tracks">${playlistDraft.tracks.filter(t => selected.has(t.id)).map(t => `<p>${escapeHtml(t.title)} · ${escapeHtml(t.artist)}</p>`).join("")}</div>`}<div class="dialog-footer"><button class="button" data-playlist-revise>${TagcastI18n.html("playlists.review.revise")}</button><button class="button primary" data-playlist-save>${TagcastI18n.html("playlists.review.save")}</button></div>`;
}

async function savePlaylistDraft() {
  if (!playlistDraft.body || collectionsView.busy || !$("#playlist-dialog").open) return;
  const body = playlistDraft.body, details = playlistDraft.details, session = playlistDraft.session, request = playlistDraft.request;
  const current = () => request === playlistDraft.request && details === state.details && session === state.connection.playback_session;
  if (!current()) { toast(TagcastI18n.text("playlists.save.connectionChanged")); return; }
  const saveButton = $("[data-playlist-save]");
  collectionsView.busy = true; saveButton.disabled = true;
  const deleting = body.action === "delete";
  saveButton.textContent = TagcastI18n.text(deleting ? "playlists.save.deleting" : "playlists.save.saving");
  saveButton.setAttribute("aria-busy", "true");
  playlistDraft.body = null; // never repeat an ambiguous mutation
  try {
    const response = await api("/api/playlist", body);
    if (!current()) return;
    saveButton.textContent = TagcastI18n.text("playlists.save.checking");
    const job = await collectionJob(response, current);
    if (job.results.some(r => r.status !== "saved")) throw playlistFailure("errors.playlists.readback_differs");
    const confirmed = {delete: "playlists.save.deleted", "remove-track": "playlists.save.trackRemoved"}[body.action] || "playlists.save.saved";
    $("#playlist-dialog").close(); toast(TagcastI18n.text(confirmed));
    if (state.screen === "playlists") {
      if (body.action === "delete") showCollections("playlists");
      else if (body.action === "remove-track") {
        collectionsView.offset = Math.min(collectionsView.offset, Math.max(0,
          Math.ceil(((collectionsView.data?.matched_total ?? collectionsView.data?.total ?? 1) - 1) / 100) - 1) * 100);
        await renderCollections();
        if (current() && state.screen === "playlists" && collectionsView.playlist === body.playlist) $("#collection-search")?.focus({preventScroll: true});
      } else renderCollections();
    }
  } catch (error) { if (current()) { toast(TagcastI18n.text("playlists.save.failed", {error: TagcastI18n.errorText(error)})); $("#playlist-dialog").close(); if (body.action === "delete" && state.screen === "playlists") showCollections("playlists"); } }
  finally { collectionsView.busy = false; saveButton.setAttribute("aria-busy", "false"); }
}

$("#show-playlists").addEventListener("click", () => showCollections("playlists"));
$("#queue-save").addEventListener("click", () => openPlaylistSave(player.queue));
document.addEventListener("input", event => {
  if (event.target.id === "collection-search") {
    collectionsView.query = event.target.value; collectionsView.offset = 0; collectionsView.request += 1;
    if (typeof syncHistory === "function") syncHistory();
    clearTimeout(collectionsView.timer); collectionsView.timer = setTimeout(renderCollections, 300);
  }
});
document.addEventListener("submit", event => {
  if (event.target.id === "playlist-form") { event.preventDefault(); reviewPlaylist(event.target).catch(error => toast(TagcastI18n.errorText(error))); }
});
document.addEventListener("click", async event => {
  const target = event.target;
  const favourite = target.closest("[data-album-favourite]");
  if (favourite) return toggleAlbumFavourite(favourite.dataset.albumFavourite.split(","));
  const rating = target.closest("[data-album-rating]");
  if (rating) return rateAlbum(rating.dataset.albumRating.split(","), Number(rating.dataset.value));
  const album = target.closest("[data-playlist-album]");
  if (album) {
    const details = state.details;
    try { await albumDetails(shelfIds(album.dataset.playlistAlbum)); if (details === state.details) openPlaylistSave(queueTracks(playableAlbum(album.dataset.playlistAlbum))); } catch (error) { toast(TagcastI18n.errorText(error)); }
  }
  const track = target.closest("[data-playlist-track]");
  if (track) return openTrackPlaylist(track.dataset.playlistSource, track.dataset.playlistTrack);
  const remove = target.closest("[data-playlist-remove]");
  if (remove) return openPlaylistTrackRemove(Number(remove.dataset.playlistRemove));
  const open = target.closest("[data-playlist-open]");
  if (open) showCollections("playlists", open.dataset.playlistOpen);
  if (target.closest("[data-playlist-back]")) goBack("playlists");
  const page = target.closest("[data-collection-page]");
  if (page) { collectionsView.offset = Math.max(0, collectionsView.offset + Number(page.dataset.collectionPage)); renderCollections(); }
  if (target.closest("[data-playlist-add-queue]")) openPlaylistSave(player.queue, null, collectionsView.data.id);
  if (target.closest("[data-playlist-find]")) {
    try {
      const form = $("#playlist-form"), choices = await api(`/api/playlists?q=${encodeURIComponent(form.elements.playlist_query.value)}`);
      form.elements.destination.innerHTML = `<option value="new">${TagcastI18n.html("playlists.save.newPrivate")}</option>` + choices.playlists.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
      toast(TagcastI18n.text(choices.total > 100 ? "playlists.find.matchesMany" : "playlists.find.matches", {count: choices.total}));
    } catch (error) { toast(TagcastI18n.errorText(error)); }
  }
  if (target.closest("[data-playlist-create]")) openPlaylistSave();
  if (target.closest("[data-playlist-delete]") && collectionsView.data) return openPlaylistDelete(collectionsView.data.id);
  if (target.closest("[data-playlist-save]")) savePlaylistDraft();
  if (target.closest("[data-playlist-revise]")) openPlaylistSave(playlistDraft.tracks, playlistDraft.selected, playlistDraft.formValues?.destination === "new" ? null : playlistDraft.formValues?.destination, playlistDraft.formValues);
  const play = target.closest("[data-playlist-play], [data-playlist-shuffle], [data-playlist-position], [data-playlist-edit]");
  if (play && collectionsView.data) {
    const data = collectionsView.data, details = state.details, session = state.connection.playback_session;
    const edit = play.hasAttribute("data-playlist-edit"), shuffle = play.hasAttribute("data-playlist-shuffle");
    if (!live() || state.loading || data.is_folder) return;
    if (!edit) {
      if (!localPlaybackAllowed()) { toast(TagcastI18n.text("playlists.detail.useDevices")); return; }
      cancelRandomPlay(); player.epoch += 1;
    }
    const epoch = player.epoch;
    const current = () => details === state.details && session === state.connection.playback_session
      && epoch === player.epoch && live() && !state.loading;
    try {
      const rows = await selectedQueueTracks(data.tracks, current);
      if (!current()) return;
      if (edit) return openPlaylistSave(rows, data);
      if (!rows.length || !localPlaybackAllowed()) return;
      if (shuffle) for (let i = rows.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
      }
      player.shuffle = shuffle; player.queue = rows;
      player.index = play.hasAttribute("data-playlist-position") ? Math.max(0, (Number(play.dataset.playlistPosition) || 0) - (data.large ? data.offset : 0)) : 0;
      if (data.large && data.page_positions && play.hasAttribute("data-playlist-position")) player.index = Math.max(0, data.page_positions.indexOf(Number(play.dataset.playlistPosition)));
      playCurrent();
    } catch (error) { if (current()) toast(TagcastI18n.errorText(error)); }
  }
});
