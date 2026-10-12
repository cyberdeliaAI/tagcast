"use strict";

// Native collections stay separate from metadata drafts and Change history.
const collectionsView = {request: 0, query: "", offset: 0, playlist: null, data: null, busy: false, rating: null};
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

function albumRatingControls(discs) {
  const update = collectionsView.rating, current = update?.details === state.details && update.session === state.connection.playback_session
    && update.ids.join(",") === discs.map(d => String(d.id)).join(",") ? update : null;
  const rating = current?.pending ? current.value : Math.min(...discs.map(d => d.rating || 0)), mixed = new Set(discs.map(d => d.rating || 0)).size > 1;
  const ids = escapeHtml(discs.map(d => d.id).join(","));
  const disabled = !live() || state.loading || collectionsView.busy || saving || checking;
  return `<div class="album-rating" role="group" aria-label="Album rating" aria-busy="${Boolean(current?.pending)}"><button class="text-action" data-album-rating="${ids}" data-value="${rating === 5 ? 0 : 5}" data-heart title="Album favourite (rating 5)" aria-label="${rating === 5 ? "Remove album favourite" : "Favourite album"}" ${disabled ? "disabled" : ""}>${rating === 5 ? "♥" : "♡"}</button>${[1, 2, 3, 4, 5].map(n => `<button class="text-action" data-album-rating="${ids}" data-value="${n}" aria-label="Rate album ${n} out of 5" ${disabled ? "disabled" : ""}>${n <= rating ? "★" : "☆"}</button>`).join("")}<button class="text-action" data-album-rating="${ids}" data-value="0" ${disabled ? "disabled" : ""}>Clear</button>${mixed && !current?.pending ? '<small class="muted">Different disc ratings</small>' : ""}${current ? `<small class="album-rating-status ${current.error ? "error-text" : "muted"}" role="status">${escapeHtml(current.message)}</small>` : ""}</div>`;
}

async function rateAlbum(ids, rating, heart) {
  if (!live() || state.loading || collectionsView.busy || saving || checking) return;
  if (document.querySelector("dialog[open]")) { toast("Close the open review first."); return; }
  const discs = ids.map(id => state.details.get(id));
  if (!discs.every(Boolean)) return;
  const before = discs.map(d => d.rating || 0), details = state.details, session = state.connection.playback_session;
  if (heart && rating === 5 && before.some(n => n > 0 && n < 5) && !confirm("Replace this album’s existing star rating with 5 to add it to favourites?")) return;
  const update = {ids, value: rating, details, session, pending: true, message: "Saving rating…", error: false};
  const current = () => details === state.details && session === state.connection.playback_session && live();
  collectionsView.rating = update;
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
    if (response.error || !ids.every(id => job.results?.some(r => String(r.id) === String(id) && r.status === "saved" && Number(r.rating) === rating))) throw Error(response.error || "One or more discs were not confirmed. Reload before trying again.");
    update.message = "Rating saved and confirmed in iBroadcast.";
    toast(rating === 5 ? "Album added to iBroadcast favourites." : "Album rating saved in iBroadcast.");
  } catch (error) { if (current()) { update.error = true; update.message = error.message; toast(error.message); } }
  finally {
    update.pending = false; collectionsView.busy = false;
    if (current()) { renderAlbumView(); if (state.screen === "album-favourites") renderCollections(); }
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
  $("#breadcrumb").textContent = state.screen === "playlists" ? "Playlists" : "Album favourites";
  if (!live() || state.loading) { page.innerHTML = '<div class="empty">Connect iBroadcast to use playlists and album favourites.</div>'; return; }
  collectionsView.details = state.details;
  if (state.screen === "album-favourites") {
    const albums = albumShelf().filter(a => a.rating >= 5), filtered = albums.filter(a => `${a.name} ${a.artist}`.toLowerCase().includes(collectionsView.query.toLowerCase()));
    replaceCollections(`<div class="page-intro"><div><h1>Album favourites<span>.</span></h1><p>Albums rated 5 in iBroadcast. Multi-disc sets appear once when every disc is a favourite.</p></div></div><input class="collection-search" id="collection-search" placeholder="Search favourite albums" value="${escapeHtml(collectionsView.query)}" aria-label="Search favourite albums"><p>${filtered.length} ${filtered.length === 1 ? "album" : "albums"}</p><div class="album-grid">${gridView(filtered.slice(collectionsView.offset, collectionsView.offset + 50))}</div>${collectionPages(filtered.length, 50)}`);
    if (typeof syncHistory === "function") syncHistory();
    return;
  }
  const request = ++collectionsView.request, details = state.details;
  if (!collectionsView.data) page.innerHTML = '<p class="muted" role="status">Loading playlists…</p>';
  try {
    const data = await api(`/api/playlists?${collectionsView.playlist ? `id=${encodeURIComponent(collectionsView.playlist)}` : `q=${encodeURIComponent(collectionsView.query)}`}&offset=${collectionsView.offset}`);
    if (request !== collectionsView.request || details !== state.details || state.screen !== "playlists") return;
    collectionsView.data = data;
    if (collectionsView.playlist) {
      page.innerHTML = `<button class="button small" data-playlist-back>← Playlists</button><div class="page-intro"><div><h1>${escapeHtml(data.name)}</h1><p>${escapeHtml(data.description)}</p></div></div><div class="album-detail-actions"><button class="button primary" data-playlist-play ${data.tracks.length ? "" : "disabled"}>▶ Play playlist</button><button class="button" data-playlist-edit>Edit playlist…</button><button class="button" data-playlist-add-queue>Add current queue…</button><button class="button danger" data-playlist-delete>Delete playlist…</button></div><p>${data.total} tracks · in playlist order</p><table class="album-tracks track-results"><thead><tr><th>#</th><th>Title / Artist</th><th>Album</th><th>Time</th><th aria-label="Queue and playlist actions"></th></tr></thead><tbody>${data.rows.map(t => `<tr><td><button class="track-play" data-playlist-position="${t.position}" aria-label="Play from ${escapeHtml(t.title)}">▶</button> ${t.position + 1}</td><td><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)}</small></td><td><button class="text-action" data-album="${t.album_id}">${escapeHtml(t.album)}</button></td><td>${trackDuration(t.length)}${trackFormatLabel(t)}</td><td>${queueButton(t.album_id, t)}</td></tr>`).join("")}</tbody></table>${collectionPages(data.total, 100)}`;
    } else replaceCollections(`<div class="page-intro"><div><h1>Playlists<span>.</span></h1><p>Your editable iBroadcast playlists. System lists are managed by iBroadcast.</p></div></div><div class="toolbar"><input class="collection-search" id="collection-search" placeholder="Search playlists" value="${escapeHtml(collectionsView.query)}" aria-label="Search playlists"><button class="button" data-playlist-create>Create playlist…</button></div><p>${data.total} playlists</p><div class="playlist-cards">${data.playlists.map(p => `<button class="button playlist-card" data-playlist-open="${p.id}"><strong>${escapeHtml(p.name)}</strong><small>${p.count} tracks</small></button>`).join("") || '<p class="muted">No matching playlists. Add an album or save the queue to create one.</p>'}</div>${collectionPages(data.total, 100)}`);
    if (typeof syncHistory === "function") syncHistory();
  } catch (error) { if (request === collectionsView.request && details === state.details) page.innerHTML = `<p class="error-box">${escapeHtml(error.message)}</p>`; }
}

function collectionPages(total, size) {
  return total > size ? `<div class="pagination"><button class="button small" data-collection-page="${-size}" ${collectionsView.offset ? "" : "disabled"}>← Previous</button><span>${Math.floor(collectionsView.offset / size) + 1} / ${Math.ceil(total / size)}</span><button class="button small" data-collection-page="${size}" ${collectionsView.offset + size >= total ? "disabled" : ""}>Next →</button></div>` : "";
}

function showCollections(screen, id = null, saved = {}) {
  collectionsView.request += 1; collectionsView.query = saved.query || ""; collectionsView.offset = saved.offset || 0; collectionsView.playlist = id;
  collectionsView.data = null;
  showScreen(screen);
}

async function openPlaylistSave(tracks = [], edit = null, destination = null) {
  if (!live() || collectionsView.busy) return;
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
  const request = ++playlistDraft.request, details = state.details, session = state.connection.playback_session;
  Object.assign(playlistDraft, {details, session, body: null, selected: null});
  $("#playlist-dialog-title").textContent = "Delete playlist";
  $("#playlist-dialog-content").innerHTML = '<p>Loading playlist review…</p>';
  $("#playlist-dialog").showModal();
  try {
    const data = await api(`/api/playlists?id=${encodeURIComponent(id)}`);
    if (request !== playlistDraft.request || details !== state.details || session !== state.connection.playback_session || !$("#playlist-dialog").open) return;
    playlistDraft.body = {action: "delete", playlist: data.id, before: data.before, before_name: data.name, confirm_delete: true};
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
    body.playlist = current.id; body.before = current.before || current.tracks; body.before_name = current.name;
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
$("#show-album-favourites").addEventListener("click", () => showCollections("album-favourites"));
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
  const rating = target.closest("[data-album-rating]");
  if (rating) return rateAlbum(rating.dataset.albumRating.split(","), Number(rating.dataset.value), rating.hasAttribute("data-heart"));
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
      player.index = Number(play.dataset.playlistPosition) || 0; playCurrent();
    } catch (error) { toast(error.message); }
  }
});
