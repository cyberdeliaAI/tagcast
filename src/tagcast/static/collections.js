"use strict";

// Local album favourites and native collections stay separate from metadata drafts and History.
const collectionsView = {request: 0, query: "", offset: 0, playlist: null, data: null, loading: false, busy: false, rating: null, favourite: null};
const playlistDraft = {body: null, details: null, session: "", selected: null, request: 0};

async function collectionJob(response, current) {
  let job;
  do {
    if (!current()) throw Error("The library or connection changed. Reload to check the saved result.");
    job = await api(`/api/jobs/${encodeURIComponent(response.job)}`);
    if (!current()) throw Error("The library or connection changed. Reload to check the saved result.");
    if (job.state === "checking") await new Promise(resolve => setTimeout(resolve, 1000));
  } while (job.state === "checking");
  if (job.state !== "done") throw Error(job.error || "Read-back failed. Reload to check the result.");
  return job;
}

function albumFavouriteControls(discs, disabled) {
  const ids = discs.map(d => String(d.id)), update = collectionsView.favourite;
  const current = update?.details === state.details && update.session === state.connection.playback_session
    && update.ids.join(",") === ids.join(",") ? update : null;
  const favourite = current?.pending ? current.value : ids.every(id => state.albumFavourites.has(id));
  const status = state.albumFavouriteError || current?.message || "";
  return {button: `<button class="album-rating-choice ${favourite ? "is-selected" : ""}" data-album-favourite="${escapeHtml(ids.join(","))}" data-heart title="Album favourite · saved locally, independent of stars" aria-label="${favourite ? "Remove album favourite" : "Favourite album"}" aria-pressed="${favourite}" aria-busy="${Boolean(current?.pending)}" ${disabled || state.albumFavouriteError ? "disabled" : ""}>${favourite ? "♥" : "♡"}</button>`, status: status ? `<small class="album-rating-status ${state.albumFavouriteError || current?.error ? "error-text" : "muted"}" role="status">${escapeHtml(status)}</small>` : ""};
}

function albumRatingControls(discs) {
  const update = collectionsView.rating, current = update?.details === state.details && update.session === state.connection.playback_session
    && update.ids.join(",") === discs.map(d => String(d.id)).join(",") ? update : null;
  const rating = current?.pending ? current.value : Math.min(...discs.map(d => d.rating || 0)), mixed = new Set(discs.map(d => d.rating || 0)).size > 1;
  const ids = escapeHtml(discs.map(d => d.id).join(","));
  const disabled = !live() || state.loading || collectionsView.busy || saving || checking;
  const hasRating = current?.pending ? current.value > 0 : discs.some(d => d.rating > 0);
  const favourite = albumFavouriteControls(discs, disabled);
  return `<div class="album-rating" role="group" aria-label="Album favourite and rating" aria-busy="${Boolean(current?.pending)}">${favourite.button}${[1, 2, 3, 4, 5].map(n => `<button class="album-rating-choice ${n <= rating ? "is-selected" : ""}" data-album-rating="${ids}" data-value="${n}" aria-label="Rate album ${n} out of 5" aria-pressed="${n <= rating}" ${disabled ? "disabled" : ""}>${n <= rating ? "★" : "☆"}</button>`).join("")}${hasRating ? `<button class="text-action album-rating-clear" data-album-rating="${ids}" data-value="0" ${disabled ? "disabled" : ""}>Clear</button>` : ""}${mixed && !current?.pending ? '<small class="muted">Different disc ratings</small>' : ""}${current ? `<small class="album-rating-status ${current.error ? "error-text" : "muted"}" role="status">${escapeHtml(current.message)}</small>` : ""}${favourite.status}</div>`;
}

async function toggleAlbumFavourite(ids) {
  if (!live() || state.loading || collectionsView.busy || saving || checking || state.albumFavouriteError) return;
  if (document.querySelector("dialog[open]")) { toast("Close the open review first."); return; }
  if (!ids.length || !ids.every(id => state.details.has(id))) return;
  const before = ids.map(id => state.albumFavourites.has(id)), favourite = !before.every(Boolean);
  const focused = document.activeElement?.getAttribute?.("data-album-favourite") === ids.join(",");
  const details = state.details, session = state.connection.playback_session;
  const current = () => details === state.details && session === state.connection.playback_session && live();
  const update = {ids, value: favourite, details, session, pending: true, error: false, message: "Saving favourite locally…"};
  collectionsView.rating = null; collectionsView.favourite = update; collectionsView.busy = true; renderAlbumView();
  try {
    const response = await api("/api/album-favourite", {albums: ids, before, favourite, session,
      combine_sets: Boolean(state.connection.combine_sets)});
    if (!current()) return;
    if (!ids.every(id => response.results?.some(r => r.id === id && r.favourite === favourite))) throw Error("The local favourite was not confirmed. Reload before trying again.");
    for (const id of ids) { if (favourite) state.albumFavourites.add(id); else state.albumFavourites.delete(id); }
    update.message = favourite ? "Album favourite saved locally." : "Album favourite removed locally.";
    toast(update.message);
  } catch (error) { if (current()) { update.error = true; update.message = error.message; toast(error.message); } }
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
  if (document.querySelector("dialog[open]")) { toast("Close the open review first."); return; }
  const discs = ids.map(id => state.details.get(id));
  if (!discs.every(Boolean)) return;
  const before = discs.map(d => d.rating || 0), details = state.details, session = state.connection.playback_session;
  const update = {ids, value: rating, details, session, pending: true, message: "Saving rating…", error: false};
  const current = () => details === state.details && session === state.connection.playback_session && live();
  collectionsView.favourite = null; collectionsView.rating = update;
  collectionsView.busy = true;
  renderAlbumView();
  try {
    const response = await api("/api/album-rating", {albums: ids, before, rating});
    if (!current()) return;
    update.message = "Rating sent · checking iBroadcast…"; renderAlbumView();
    toast("Album rating sent. Checking iBroadcast…");
    const job = await collectionJob(response, current);
    for (const r of job.results || []) {
      const summary = state.albums.find(a => String(a.id) === String(r.id)), detail = state.details.get(String(r.id));
      if (summary) summary.rating = r.rating;
      if (detail) detail.rating = r.rating;
    }
    // Merged sets copy their disc ratings; refresh that derived shelf after read-back.
    shelfCache.albums = null;
    if (response.error || !ids.every(id => job.results?.some(r => String(r.id) === String(id) && r.status === "saved" && Number(r.rating) === rating))) throw Error(response.error || "One or more discs were not confirmed. Reload before trying again.");
    update.message = "Rating saved and confirmed in iBroadcast.";
    toast("Album rating saved in iBroadcast.");
  } catch (error) { if (current()) { update.error = true; update.message = error.message; toast(error.message); } }
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
  return `<button class="button small" data-playlist-album="${escapeHtml(id)}" ${!live() ? "disabled" : ""}>♫ Add to playlist…</button>`;
}

async function selectedQueueTracks(ids, current) {
  const tracks = [];
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const result = await api("/api/queue-tracks", {tracks: ids.slice(offset, offset + 1000)});
    if (!current()) throw Error("The library changed while loading this queue.");
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
    if (rows.length !== 1 || rows[0].id !== String(trackId) || !shelfIds(albumId).includes(String(rows[0].album.id))) throw Error("This track moved or is no longer available. Reload the library.");
    if (!document.querySelector("dialog[open]")) return openPlaylistSave(rows);
  } catch (error) { if (current()) toast(error.message); }
}

function replaceCollections(html) {
  const input = document.activeElement, restore = input?.id === "collection-search";
  const start = input?.selectionStart, end = input?.selectionEnd;
  $("#collections-page").innerHTML = html;
  if (restore) { $("#collection-search").focus(); $("#collection-search").setSelectionRange?.(start, end); }
}

async function renderCollections() {
  if (!["playlists", "album-favourites"].includes(state.screen)) return;
  const page = $("#collections-page");
  if (state.screen === "playlists") $("#breadcrumb").textContent = "Playlists";
  else renderFavouriteHub();
  if (!live() || state.loading) { page.innerHTML = state.loading ? '<div class="empty">Loading your iBroadcast library…</div>' : '<div class="empty">Connect iBroadcast to use playlists and album favourites.</div>'; return; }
  collectionsView.details = state.details;
  if (state.screen === "album-favourites") {
    const albums = albumShelf().filter(a => itemIds(a).every(id => state.albumFavourites.has(id))), filtered = albums.filter(a => `${a.name} ${albumArtistsText(a)}`.toLowerCase().includes(collectionsView.query.toLowerCase()));
    if (state.albumFavouriteError) { page.innerHTML = `<p class="error-box">${escapeHtml(state.albumFavouriteError)}</p>`; return; }
    collectionsView.offset = Math.min(collectionsView.offset, Math.max(0, Math.ceil(filtered.length / 50) - 1) * 50);
    replaceCollections(`<p class="muted">Albums marked with a heart in Tagcast. Saved on this computer for your account, independently of star ratings. Multi-disc sets appear once when every disc is a favourite.</p><input class="collection-search" id="collection-search" placeholder="Search favourite albums" value="${escapeHtml(collectionsView.query)}" aria-label="Search favourite albums"><p>${filtered.length} ${filtered.length === 1 ? "album" : "albums"}</p><div class="album-grid">${gridView(filtered.slice(collectionsView.offset, collectionsView.offset + 50)) || '<div class="empty">No favourite albums match. Use the heart on an album page to add one.</div>'}</div>${collectionPages(filtered.length, 50)}`);
    if (typeof syncHistory === "function") syncHistory();
    return;
  }
  const request = ++collectionsView.request, details = state.details;
  collectionsView.loading = true;
  if (!collectionsView.data) page.innerHTML = '<p class="muted" role="status">Loading playlists…</p>';
  try {
    const data = await api(`/api/playlists?${collectionsView.playlist ? `id=${encodeURIComponent(collectionsView.playlist)}` : `q=${encodeURIComponent(collectionsView.query)}&browse=1`}&offset=${collectionsView.offset}`);
    if (request !== collectionsView.request || details !== state.details || state.screen !== "playlists") return;
    collectionsView.data = data;
    if (data.is_folder) {
      page.innerHTML = playlistFolderPage(data);
    } else if (collectionsView.playlist) {
      page.innerHTML = `<button class="button small page-back" data-playlist-back>← Playlists</button><div class="page-intro playlist-intro">${playlistCoverImage(data)}<div><h1>${escapeHtml(data.name)}</h1><p>${escapeHtml(data.description)}</p></div></div><div class="album-detail-actions"><button class="button primary" data-playlist-play ${data.tracks.length ? "" : "disabled"}>▶ ${data.large ? "Play this page" : "Play playlist"}</button><button class="button" data-playlist-cover>Change cover…</button><button class="button" data-playlist-edit ${data.large ? 'disabled title="Full replacement is limited to 10,000 tracks"' : ""}>Edit playlist…</button><button class="button" data-playlist-add-queue>Add current queue…</button><button class="button danger" data-playlist-delete>Delete playlist…</button></div><p>${data.total} tracks · in playlist order</p>${data.large ? '<p class="muted">Large playlist: browse 100 tracks per page. Playback starts from this page. Full-content editing is limited to 10,000 tracks; adding tracks and reviewed deletion remain available.</p>' : ""}<table class="album-tracks track-results"><thead><tr><th>#</th><th>Title / Artist</th><th>Album</th><th>Time</th><th aria-label="Queue and playlist actions"></th></tr></thead><tbody>${data.rows.map(t => `<tr><td class="track-number"><button class="album-track-play" data-playlist-position="${t.position}" aria-label="Play from ${escapeHtml(t.title)}">▶</button> ${t.position + 1}</td><td><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}</small></td><td><button class="text-action" data-album="${t.album_id}">${escapeHtml(t.album)}</button></td><td>${trackDuration(t.length)}${trackFormatLabel(t)}</td><td>${queueButton(t.album_id, t)}</td></tr>`).join("")}</tbody></table>${collectionPages(data.total, 100)}`;
    } else replaceCollections(`<div class="page-intro"><div><h1>Playlists<span>.</span></h1><p>Your iBroadcast playlists and folders. Search also finds playlists inside folders. System lists are managed by iBroadcast.</p></div></div><div class="toolbar"><input class="collection-search" id="collection-search" placeholder="Search playlists" value="${escapeHtml(collectionsView.query)}" aria-label="Search playlists"><button class="button" data-playlist-create>Create playlist…</button><button class="button" data-folder-create>Create folder…</button><button class="button" data-csv-import>Import CSV…</button></div><p>${data.total} playlists and folders</p><div class="playlist-cards">${data.playlists.map(playlistBrowseCard).join("") || '<p class="muted">No matching playlists. Add an album or save the queue to create one.</p>'}</div>${collectionPages(data.total, 100)}`);
    if (typeof syncHistory === "function") syncHistory();
  } catch (error) { if (request === collectionsView.request && details === state.details) page.innerHTML = `<p class="error-box">${escapeHtml(error.message)}</p>`; }
  finally {
    if (request === collectionsView.request) {
      collectionsView.loading = false;
      if (typeof syncHistory === "function") syncHistory();
    }
  }
}

function collectionPages(total, size) {
  return total > size ? `<div class="pagination"><button class="button small" data-collection-page="${-size}" ${collectionsView.offset ? "" : "disabled"}>← Previous</button><span>${Math.floor(collectionsView.offset / size) + 1} / ${Math.ceil(total / size)}</span><button class="button small" data-collection-page="${size}" ${collectionsView.offset + size >= total ? "disabled" : ""}>Next →</button></div>` : "";
}

function showCollections(screen, id = null, saved = {}) {
  rememberFavouriteView();
  collectionsView.request += 1; collectionsView.query = saved.query || ""; collectionsView.offset = saved.offset || 0; collectionsView.playlist = id;
  collectionsView.data = null;
  showScreen(screen);
}

async function openPlaylistSave(tracks = [], edit = null, destination = null) {
  if (!live() || collectionsView.busy) return;
  if (typeof invalidatePlaylistFolder === "function") invalidatePlaylistFolder();
  const request = ++playlistDraft.request, details = state.details, session = state.connection.playback_session;
  playlistDraft.details = details; playlistDraft.session = session; playlistDraft.body = null; playlistDraft.selected = edit;
  const unique = [...new Map(tracks.map(t => [String(t.id), t])).values()];
  $("#playlist-dialog-title").textContent = edit ? "Edit playlist" : "Add to playlist";
  $("#playlist-dialog-content").innerHTML = '<p>Loading playlist choices…</p>';
  $("#playlist-dialog").showModal();
  try {
    const choices = edit ? {playlists: []} : destination ? {playlists: [await api(`/api/playlists?id=${encodeURIComponent(destination)}`)]} : await api("/api/playlists");
    if (request !== playlistDraft.request || details !== state.details || session !== state.connection.playback_session || !$("#playlist-dialog").open) return;
    playlistDraft.tracks = unique;
    playlistDraft.choices = choices.playlists;
    $("#playlist-dialog-content").innerHTML = `<form id="playlist-form">${edit ? "" : `<label>Destination <select name="destination"><option value="new">New private playlist</option>${choices.playlists.map(p => `<option value="${p.id}" ${destination === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></label><label>Find playlist by name <input name="playlist_query" maxlength="200"></label><button type="button" class="button small" data-playlist-find>Find playlists</button>`}<label>Name <input name="name" maxlength="200" value="${escapeHtml(edit?.name || "")}"></label><label>Description <textarea name="description" maxlength="2000">${escapeHtml(edit?.description || "")}</textarea></label><p>${unique.length} ${unique.length === 1 ? "track" : "tracks"}${unique.length !== tracks.length ? ' · repeated queue entries kept once, in their first position' : ''}. Albums keep their track order.</p><div class="playlist-review-tracks">${unique.map((t, i) => `<label class="checkline"><input type="checkbox" name="track" value="${t.id}" checked> ${i + 1}. ${escapeHtml(t.title)} · ${escapeHtml(t.artist)}</label>`).join("")}</div><div class="dialog-footer"><button type="button" class="button" data-close="playlist-dialog">Cancel</button><button class="button primary">Prepare review →</button></div></form>`;
  } catch (error) { if (request === playlistDraft.request && details === state.details && session === state.connection.playback_session) $("#playlist-dialog-content").innerHTML = `<p class="error-box">${escapeHtml(error.message)}</p>`; }
}

async function openPlaylistDelete(id) {
  if (!live() || collectionsView.busy || document.querySelector("dialog[open]")) return;
  if (typeof invalidatePlaylistFolder === "function") invalidatePlaylistFolder();
  const request = ++playlistDraft.request, details = state.details, session = state.connection.playback_session;
  Object.assign(playlistDraft, {details, session, body: null, selected: null});
  $("#playlist-dialog-title").textContent = "Delete playlist";
  $("#playlist-dialog-content").innerHTML = '<p>Loading playlist review…</p>';
  $("#playlist-dialog").showModal();
  try {
    const data = await api(`/api/playlists?id=${encodeURIComponent(id)}`);
    if (request !== playlistDraft.request || details !== state.details || session !== state.connection.playback_session || !$("#playlist-dialog").open) return;
    playlistDraft.body = {action: "delete", playlist: data.id, ...(data.before_token ? {before_token: data.before_token} : {before: data.before}), before_name: data.name, confirm_delete: true};
    $("#playlist-dialog-content").innerHTML = `<h3>${escapeHtml(data.name)}</h3><p>${data.total} ${data.total === 1 ? "track" : "tracks"} in this playlist.</p><div class="warn-box">Delete this playlist from iBroadcast? The tracks stay in your music library. Tagcast cannot undo playlist deletion.</div><div class="dialog-footer"><button class="button" data-close="playlist-dialog">Keep playlist</button><button class="button danger primary" data-playlist-save>Delete playlist</button></div>`;
  } catch (error) { if (request === playlistDraft.request && details === state.details) $("#playlist-dialog-content").innerHTML = `<p class="error-box">${escapeHtml(error.message)}</p>`; }
}

async function reviewPlaylist(form) {
  const request = playlistDraft.request;
  const destination = playlistDraft.selected?.id || form.elements.destination.value;
  const selected = new Set([...form.querySelectorAll('input[name="track"]')].filter(t => t.checked).map(t => t.value));
  const ids = playlistDraft.tracks.filter(t => selected.has(t.id)).map(t => Number(t.id));
  const edit = playlistDraft.selected;
  const body = {action: edit ? "replace" : destination === "new" ? "create" : "append", tracks: ids,
    name: form.elements.name.value.trim(), description: form.elements.description.value.trim()};
  if (destination !== "new") {
    const current = edit || await api(`/api/playlists?id=${encodeURIComponent(destination)}`);
    body.playlist = current.id;
    if (current.before_token) body.before_token = current.before_token; else body.before = current.before || current.tracks;
    body.before_name = current.name;
    if (!body.name || body.action === "append") body.name = current.name;
  }
  if (!body.name) { toast("Enter a playlist name."); return; }
  if (request !== playlistDraft.request || playlistDraft.details !== state.details || playlistDraft.session !== state.connection.playback_session) { toast("The connection or review changed. Open a new review."); return; }
  playlistDraft.body = body;
  $("#playlist-dialog-content").innerHTML = `<h3>${escapeHtml(body.name)}</h3><p>${body.action === "replace" ? "Replace the playlist with" : body.action === "append" ? "Append to this playlist:" : "Create a private playlist with"} ${ids.length} ${ids.length === 1 ? "track" : "tracks"}. ${body.action === "replace" ? "Unchecked tracks are removed from this playlist; they stay in your library." : "Existing tracks are kept once by iBroadcast."}</p><div class="playlist-review-tracks">${playlistDraft.tracks.filter(t => selected.has(t.id)).map(t => `<p>${escapeHtml(t.title)} · ${escapeHtml(t.artist)}</p>`).join("")}</div><div class="dialog-footer"><button class="button" data-playlist-revise>← Edit review</button><button class="button primary" data-playlist-save>Save to iBroadcast</button></div>`;
}

async function savePlaylistDraft() {
  if (!playlistDraft.body || collectionsView.busy || !$("#playlist-dialog").open) return;
  const body = playlistDraft.body, details = playlistDraft.details, session = playlistDraft.session, request = playlistDraft.request;
  const current = () => request === playlistDraft.request && details === state.details && session === state.connection.playback_session;
  if (!current()) { toast("The connection changed. Prepare a new review."); return; }
  const saveButton = $("[data-playlist-save]");
  collectionsView.busy = true; saveButton.disabled = true;
  saveButton.textContent = body.action === "delete" ? "Deleting playlist…" : "Saving playlist…";
  saveButton.setAttribute("aria-busy", "true");
  playlistDraft.body = null; // never repeat an ambiguous mutation
  try {
    const response = await api("/api/playlist", body);
    if (!current()) return;
    saveButton.textContent = "Checking iBroadcast…";
    const job = await collectionJob(response, current);
    if (job.results.some(r => r.status !== "saved")) throw Error("Playlist sent, but read-back differs. Check Playlists before trying again.");
    $("#playlist-dialog").close(); toast(body.action === "delete" ? "Playlist deleted and confirmed in iBroadcast." : "Playlist saved and confirmed in iBroadcast.");
    if (state.screen === "playlists") {
      if (body.action === "delete") showCollections("playlists"); else renderCollections();
    }
  } catch (error) { if (current()) { toast(`Check the playlist before trying again: ${error.message}`); $("#playlist-dialog").close(); if (body.action === "delete" && state.screen === "playlists") showCollections("playlists"); } }
  finally { collectionsView.busy = false; }
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
  if (event.target.id === "playlist-form") { event.preventDefault(); reviewPlaylist(event.target).catch(error => toast(error.message)); }
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
    try { await albumDetails(shelfIds(album.dataset.playlistAlbum)); if (details === state.details) openPlaylistSave(queueTracks(playableAlbum(album.dataset.playlistAlbum))); } catch (error) { toast(error.message); }
  }
  const track = target.closest("[data-playlist-track]");
  if (track) return openTrackPlaylist(track.dataset.playlistSource, track.dataset.playlistTrack);
  const open = target.closest("[data-playlist-open]");
  if (open) showCollections("playlists", open.dataset.playlistOpen);
  if (target.closest("[data-playlist-back]")) goBack("playlists");
  const page = target.closest("[data-collection-page]");
  if (page) { collectionsView.offset = Math.max(0, collectionsView.offset + Number(page.dataset.collectionPage)); renderCollections(); }
  if (target.closest("[data-playlist-add-queue]")) openPlaylistSave(player.queue, null, collectionsView.data.id);
  if (target.closest("[data-playlist-find]")) {
    try {
      const form = $("#playlist-form"), choices = await api(`/api/playlists?q=${encodeURIComponent(form.elements.playlist_query.value)}`);
      form.elements.destination.innerHTML = '<option value="new">New private playlist</option>' + choices.playlists.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
      toast(`${choices.total} matching playlists${choices.total > 100 ? "; refine the name to see fewer results" : ""}.`);
    } catch (error) { toast(error.message); }
  }
  if (target.closest("[data-playlist-create]")) openPlaylistSave();
  if (target.closest("[data-playlist-delete]") && collectionsView.data) return openPlaylistDelete(collectionsView.data.id);
  if (target.closest("[data-playlist-save]")) savePlaylistDraft();
  if (target.closest("[data-playlist-revise]")) openPlaylistSave(playlistDraft.tracks, playlistDraft.selected);
  const play = target.closest("[data-playlist-play], [data-playlist-position], [data-playlist-edit]");
  if (play && collectionsView.data) {
    const data = collectionsView.data, details = state.details, epoch = player.epoch;
    try {
      const rows = await selectedQueueTracks(data.tracks, () => details === state.details && epoch === player.epoch && live());
      if (play.hasAttribute("data-playlist-edit")) return openPlaylistSave(rows, data);
      if (!rows.length || !localPlaybackAllowed()) return;
      cancelRandomPlay(); player.epoch += 1; player.shuffle = false; player.queue = rows;
      player.index = play.hasAttribute("data-playlist-position") ? Math.max(0, (Number(play.dataset.playlistPosition) || 0) - (data.large ? data.offset : 0)) : 0; playCurrent();
    } catch (error) { toast(error.message); }
  }
});
