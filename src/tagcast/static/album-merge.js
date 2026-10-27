"use strict";

// Reviewed album membership changes; playback and ordinary metadata drafts stay separate.
const albumMergeDraft = {request: 0, details: null, session: "", busy: false,
  selection: null, review: null, focus: null, scroll: 0};

function resetAlbumMerge() {
  albumMergeDraft.request += 1;
  albumMergeDraft.selection = null; albumMergeDraft.review = null;
  if ($("#album-merge").open) $("#album-merge").close();
}

function albumMergeCurrent(request) {
  return request === albumMergeDraft.request && albumMergeDraft.details === state.details
    && albumMergeDraft.session === state.connection.playback_session && live();
}

function updateAlbumMergeControls() {
  const chosen = albumShelf().filter(isSelected);
  $("#merge-selection").hidden = !live();
  $("#merge-selection").disabled = saving || checking > 0 || chosen.length < 2 || albumMergeDraft.busy;
}

function albumMergeStatus(message, working = false) {
  setActionStatus("#album-merge-status", message, working);
}

function albumMergeError(error) {
  $("#album-merge-content").innerHTML = `<p class="error-text" role="alert">${escapeHtml(error.message)}</p><div class="dialog-footer"><button type="button" class="button" data-close="album-merge">Close</button><button type="button" class="button" id="album-merge-reload">Reload library</button></div>`;
  albumMergeStatus("");
}

async function openAlbumMerge() {
  if (!live() || saving || checking || albumMergeDraft.busy) return;
  const groups = albumShelf().filter(a => itemIds(a).some(id => state.selected.has(id)));
  if (groups.length < 2 || groups.length > 20) { toast("Select 2–20 albums for one merge."); return; }
  if (groups.some(a => !isSelected(a) || itemIds(a).length !== 1)) {
    toast("Multi-disc sets cannot be merged here. Select complete fragments of one disc only."); return;
  }
  if (new Set(groups.map(a => Number(a.disc) || 0)).size > 1) {
    toast("Choose fragments with the same disc number. Different discs must stay separate."); return;
  }
  const view = albumMergeDraft, request = ++view.request;
  Object.assign(view, {details: state.details, session: state.connection.playback_session,
    selection: null, review: null, focus: $("#merge-selection"), scroll: window.scrollY || 0});
  $("#album-merge-content").innerHTML = "";
  albumMergeStatus("Checking the selected albums…", true);
  $("#album-merge").showModal();
  try {
    const selection = await api("/api/albums/merge/selection", {session: view.session,
      albums: groups.map(a => ({id: a.id, name: a.name, artist: a.artist,
        year: Number(a.year) || 0, disc: Number(a.disc) || 0, track_count: a.track_count}))});
    if (!albumMergeCurrent(request) || !$("#album-merge").open) return;
    view.selection = selection;
    renderAlbumMergeSelection();
  } catch (error) { if (albumMergeCurrent(request)) albumMergeError(error); }
}

function renderAlbumMergeSelection(target = "") {
  const selection = albumMergeDraft.selection;
  albumMergeDraft.review = null;
  $("#album-merge-title").textContent = "Merge albums";
  albumMergeStatus("");
  $("#album-merge-content").innerHTML = `<p>Combine ${selection.albums.length} selected albums into one existing album. Choose which album to keep. Nothing is changed until you review and confirm.</p>
    <label class="field album-merge-target">Destination album<select id="album-merge-target" aria-label="Destination album"><option value="">Choose an album to keep…</option>${selection.albums.map((a, i) => `<option value="${escapeHtml(a.id)}" ${a.id === target ? "selected" : ""}>${i + 1}. ${escapeHtml(a.name)} · ${escapeHtml(a.artist)} · ${a.tracks.length} ${a.tracks.length === 1 ? "track" : "tracks"}</option>`).join("")}</select></label>
    <p class="muted">The destination supplies the album title, album artists, release year, disc number and album rating. Individual track artists and track numbers stay unchanged.</p>
    <ul class="tag-album-summary">${selection.albums.map((a, i) => `<li><strong>${i + 1}. ${escapeHtml(a.name)}</strong> · ${escapeHtml(a.artist)} · ${a.tracks.length} ${a.tracks.length === 1 ? "track" : "tracks"}${a.disc ? ` · Disc ${a.disc}` : ""}</li>`).join("")}</ul>
    <div class="dialog-footer"><button type="button" class="button" data-close="album-merge">Cancel</button><button type="button" class="button primary" id="album-merge-review" ${target ? "" : "disabled"}>Review merge →</button></div>`;
  $("#album-merge-target").focus();
  $("#album-merge").scrollTop = 0;
}

async function reviewAlbumMerge() {
  const view = albumMergeDraft, request = view.request, target = $("#album-merge-target").value;
  if (!view.selection || !target || saving || checking || !albumMergeCurrent(request)) return;
  $("#album-merge-review").disabled = true;
  albumMergeStatus("Preparing the merge review…", true);
  try {
    const review = await api("/api/albums/merge/review", {session: view.session,
      selection: view.selection.selection, target});
    if (!albumMergeCurrent(request) || !$("#album-merge").open) return;
    view.review = review;
    renderAlbumMergeReview();
  } catch (error) { if (albumMergeCurrent(request)) albumMergeError(error); }
}

function renderAlbumMergeReview() {
  const review = albumMergeDraft.review, target = review.target;
  albumMergeStatus("");
  $("#album-merge-content").innerHTML = `<div class="scope-note"><strong>Keep ${escapeHtml(target.name)}</strong><p>${escapeHtml(target.album_artists.map(a => a.name).join(" · "))}${target.year ? ` · ${target.year}` : ""}${target.disc ? ` · Disc ${target.disc}` : ""} · ${review.tracks.length} tracks after merging · ${target.rating ? `Album rating ${target.rating}/5` : "Unrated album"}</p></div>
    <p>All ${review.albums.length} selected albums are included. The other album entries will no longer have active tracks. Track IDs, titles, performers, credits, genres, artwork and numbers are preserved. This cannot be undone through Tagcast.</p><p class="muted">Source album ratings and local album favourites are not transferred. The destination keeps its own rating and favourite.</p>
    ${new Set(review.tracks.map(t => t.artwork_id || 0)).size > 1 ? '<p class="muted">These tracks have different covers. Each track keeps its artwork; the displayed album cover follows the first numbered track with artwork.</p>' : ""}
    ${review.overlapping_numbers.length ? `<div class="warn-box">Some tracks share these numbers: ${review.overlapping_numbers.join(", ")}. Every track will be kept; nothing is renumbered or deduplicated.<label class="checkline"><input type="checkbox" id="album-merge-keep-numbers"> Keep these overlapping track numbers</label></div>` : ""}
    ${review.missing_numbers ? `<p class="muted">${review.missing_numbers} tracks have no track number. They stay unnumbered.</p>` : ""}
    <details class="diff-group" open><summary><strong>Tracks after merging · ${review.tracks.length}</strong></summary><ol class="album-merge-tracks">${review.tracks.map(t => `<li><span class="muted">${t.track || "–"}</span><span><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.performers?.map(p => p.name).join(" · ") || t.artist)} · from ${escapeHtml(t.source_name)} (${escapeHtml(t.source_artist)})</small></span></li>`).join("")}</ol></details>
    <div class="dialog-footer"><button type="button" class="button" id="album-merge-back">← Change destination</button><button type="button" class="button primary" id="album-merge-save" ${review.overlapping_numbers.length ? "disabled" : ""}>Merge ${review.albums.length} albums in iBroadcast</button></div>`;
  $("#album-merge-title").textContent = "Review album merge";
  $("#album-merge-title").tabIndex = -1;
  $("#album-merge-title").focus({preventScroll: true});
  $("#album-merge").scrollTop = 0;
}

async function saveAlbumMerge() {
  const view = albumMergeDraft, request = view.request, review = view.review;
  const keepNumbers = $("#album-merge-keep-numbers")?.checked === true;
  if (!review || saving || checking || view.busy || !albumMergeCurrent(request)
    || review.overlapping_numbers.length && !keepNumbers) return;
  const entry = {albumMerge: true, created: new Date().toISOString(), source: "ibroadcast",
    status: "sent", error: "", selection: review.albums.map(a => ({id: a.id, name: a.name, artist: a.artist})),
    changes: review.tracks.map(t => ({kind: "track", id: t.id, label: t.title, status: "sent",
      fields: {album: {before: `${t.source_name} · ${t.source_artist}`, after: `${review.target.name} · ${review.target.artist}`}}}))};
  // A request or a lost reply consumes this review; never expose a retry button.
  view.review = null; view.busy = true; saving = true;
  state.history.unshift(entry); rememberHistory(); updateChrome();
  $("#album-merge-content").innerHTML = '<p>The reviewed merge is being sent once. Closing this window does not cancel an accepted request.</p>';
  albumMergeStatus("Moving the reviewed tracks…", true);
  try {
    const result = await api("/api/albums/merge/save", {approved: true, session: view.session,
      review: review.review, keep_overlapping_numbers: keepNumbers});
    if (!albumMergeCurrent(request)) return;
    albumMergeStatus("Checking the result in iBroadcast…", true);
    const job = await followJob(result.job, entry, null, () => albumMergeCurrent(request));
    if (!job || request !== view.request || view.session !== state.connection.playback_session) return;
    // The existing read-back refreshes the shared summaries; keep this dialog bound to them.
    view.details = state.details;
    if (entry.status !== "saved") throw Error("The merge was not fully confirmed. Reload the library and check iBroadcast before doing anything else. This request will not be retried.");
    for (const album of review.albums) state.selected.delete(String(album.id));
    render();
    albumMergeStatus("All tracks confirmed in the destination album.");
    $("#album-merge-content").innerHTML = `<p><strong>${escapeHtml(review.target.name)}</strong> now contains all ${review.tracks.length} reviewed tracks. Their metadata and track numbers were checked.</p><div class="dialog-footer"><button type="button" class="button" data-close="album-merge">Done</button><button type="button" class="button primary" id="album-merge-open" data-target="${escapeHtml(result.target)}">Open merged album →</button></div>`;
    $("#album-merge-open").focus();
  } catch (error) {
    entry.status = error.status === 409 ? "blocked" : "unverified"; entry.error = error.message;
    for (const row of entry.changes) if (row.status === "sent") row.status = entry.status;
    rememberHistory();
    if (request === view.request && view.session === state.connection.playback_session) {
      albumMergeError(Error(`${error.message} No automatic retry was made. Reload the library before starting a new review.`));
    }
  } finally {
    view.busy = false; saving = false; updateChrome(); updateAlbumMergeControls();
  }
}

$("#merge-selection").addEventListener("click", openAlbumMerge);
$("#album-merge").addEventListener("close", () => {
  if (!albumMergeDraft.busy) { albumMergeDraft.request += 1; albumMergeDraft.review = null; }
  const focus = albumMergeDraft.focus;
  (focus?.isConnected && !focus.hidden && !focus.disabled ? focus : $("#select-page")).focus();
  window.scrollTo({top: albumMergeDraft.scroll});
});
document.addEventListener("change", event => {
  if (event.target.id === "album-merge-target") $("#album-merge-review").disabled = !event.target.value;
  if (event.target.id === "album-merge-keep-numbers") $("#album-merge-save").disabled = !event.target.checked;
});
document.addEventListener("click", async event => {
  if (event.target.closest("#album-merge-review")) await reviewAlbumMerge();
  if (event.target.closest("#album-merge-save")) await saveAlbumMerge();
  if (event.target.closest("#album-merge-back") && albumMergeDraft.review) renderAlbumMergeSelection(albumMergeDraft.review.target.id);
  if (event.target.closest("#album-merge-reload")) { $("#album-merge").close(); await loadLive(true); }
  const open = event.target.closest("#album-merge-open");
  if (open) { $("#album-merge").close(); openAlbum(open.dataset.target); }
});
