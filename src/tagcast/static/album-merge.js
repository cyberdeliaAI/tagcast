"use strict";

// Reviewed album membership changes; playback and ordinary metadata drafts stay separate.
// A language change never re-renders this dialog (it holds a review); only its heading follows.
const albumMergeDraft = {request: 0, details: null, session: "", busy: false,
  selection: null, review: null, focus: null, scroll: 0, title: "albumMerge.title.merge"};

function albumMergeTitle(key) {
  albumMergeDraft.title = key;
  $("#album-merge-title").textContent = TagcastI18n.text(key);
}

TagcastI18n.subscribe(() => {
  const title = $("#album-merge-title");
  if (title) title.textContent = TagcastI18n.text(albumMergeDraft.title);
});

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

// `message` is display text (a translated or server message); `note` adds a sentence.
function albumMergeError(message, note = "") {
  $("#album-merge-content").innerHTML = `<p class="error-text" role="alert">${escapeHtml(message)}${note ? ` ${escapeHtml(note)}` : ""}</p><div class="dialog-footer"><button type="button" class="button" data-close="album-merge">${TagcastI18n.html("common.close")}</button><button type="button" class="button" id="album-merge-reload">${TagcastI18n.html("common.reloadLibrary")}</button></div>`;
  albumMergeStatus("");
}

async function openAlbumMerge() {
  if (!live() || saving || checking || albumMergeDraft.busy) return;
  const groups = albumShelf().filter(a => itemIds(a).some(id => state.selected.has(id)));
  if (groups.length < 2 || groups.length > 20) { toast(TagcastI18n.text("albumMerge.open.count")); return; }
  if (groups.some(a => !isSelected(a) || itemIds(a).length !== 1)) {
    toast(TagcastI18n.text("albumMerge.open.multiDisc")); return;
  }
  if (new Set(groups.map(a => Number(a.disc) || 0)).size > 1) {
    toast(TagcastI18n.text("albumMerge.open.sameDisc")); return;
  }
  const view = albumMergeDraft, request = ++view.request;
  Object.assign(view, {details: state.details, session: state.connection.playback_session,
    selection: null, review: null, focus: $("#merge-selection"), scroll: window.scrollY || 0});
  $("#album-merge-content").innerHTML = "";
  albumMergeStatus(TagcastI18n.text("albumMerge.open.checking"), true);
  $("#album-merge").showModal();
  try {
    const selection = await api("/api/albums/merge/selection", {session: view.session,
      albums: groups.map(a => ({id: a.id, name: a.name, artist: a.artist,
        year: Number(a.year) || 0, disc: Number(a.disc) || 0, track_count: a.track_count}))});
    if (!albumMergeCurrent(request) || !$("#album-merge").open) return;
    view.selection = selection;
    renderAlbumMergeSelection();
  } catch (error) { if (albumMergeCurrent(request)) albumMergeError(TagcastI18n.errorText(error)); }
}

function renderAlbumMergeSelection(target = "") {
  const selection = albumMergeDraft.selection;
  albumMergeDraft.review = null;
  albumMergeTitle("albumMerge.title.merge");
  albumMergeStatus("");
  $("#album-merge-content").innerHTML = `<p>${TagcastI18n.html("albumMerge.selection.intro", {count: selection.albums.length})} ${TagcastI18n.html("albumMerge.selection.next")}</p>
    <label class="field album-merge-target">${TagcastI18n.html("albumMerge.selection.destination")}<select id="album-merge-target" aria-label="${TagcastI18n.html("albumMerge.selection.destination")}"><option value="">${TagcastI18n.html("albumMerge.selection.choose")}</option>${selection.albums.map((a, i) => `<option value="${escapeHtml(a.id)}" ${a.id === target ? "selected" : ""}>${i + 1}. ${escapeHtml(a.name)} · ${escapeHtml(a.artist)} · ${TagcastI18n.html("common.count.tracks", {count: a.tracks.length})}</option>`).join("")}</select></label>
    <p class="muted">${TagcastI18n.html("albumMerge.selection.note")}</p>
    <ul class="tag-album-summary">${selection.albums.map((a, i) => `<li><strong>${i + 1}. ${escapeHtml(a.name)}</strong> · ${escapeHtml(a.artist)} · ${TagcastI18n.html("common.count.tracks", {count: a.tracks.length})}${a.disc ? ` · ${TagcastI18n.html("common.disc", {disc: a.disc})}` : ""}</li>`).join("")}</ul>
    <div class="dialog-footer"><button type="button" class="button" data-close="album-merge">${TagcastI18n.html("common.cancel")}</button><button type="button" class="button primary" id="album-merge-review" ${target ? "" : "disabled"}>${TagcastI18n.html("albumMerge.selection.review")}</button></div>`;
  $("#album-merge-target").focus();
  $("#album-merge").scrollTop = 0;
}

async function reviewAlbumMerge() {
  const view = albumMergeDraft, request = view.request, target = $("#album-merge-target").value;
  if (!view.selection || !target || saving || checking || !albumMergeCurrent(request)) return;
  $("#album-merge-review").disabled = true;
  albumMergeStatus(TagcastI18n.text("albumMerge.review.preparing"), true);
  try {
    const review = await api("/api/albums/merge/review", {session: view.session,
      selection: view.selection.selection, target});
    if (!albumMergeCurrent(request) || !$("#album-merge").open) return;
    view.review = review;
    renderAlbumMergeReview();
  } catch (error) { if (albumMergeCurrent(request)) albumMergeError(TagcastI18n.errorText(error)); }
}

function renderAlbumMergeReview() {
  const review = albumMergeDraft.review, target = review.target;
  albumMergeStatus("");
  const summary = [escapeHtml(target.album_artists.map(a => a.name).join(" · ")), ...(target.year ? [escapeHtml(target.year)] : []),
    ...(target.disc ? [TagcastI18n.html("common.disc", {disc: target.disc})] : []), TagcastI18n.html("albumMerge.review.trackCount", {count: review.tracks.length}),
    target.rating ? TagcastI18n.html("albumMerge.review.rating", {rating: target.rating}) : TagcastI18n.html("albumMerge.review.unrated")];
  $("#album-merge-content").innerHTML = `<div class="scope-note"><strong>${TagcastI18n.html("albumMerge.review.keep", {name: target.name})}</strong><p>${summary.join(" · ")}</p></div>
    <p>${TagcastI18n.html("albumMerge.review.included", {count: review.albums.length})} ${TagcastI18n.html("albumMerge.review.effects")}</p><p class="muted">${TagcastI18n.html("albumMerge.review.notTransferred")}</p>
    ${new Set(review.tracks.map(t => t.artwork_id || 0)).size > 1 ? `<p class="muted">${TagcastI18n.html("albumMerge.review.covers")}</p>` : ""}
    ${review.overlapping_numbers.length ? `<div class="warn-box">${TagcastI18n.html("albumMerge.review.overlap", {numbers: review.overlapping_numbers.join(", ")})}<label class="checkline"><input type="checkbox" id="album-merge-keep-numbers"> ${TagcastI18n.html("albumMerge.review.keepNumbers")}</label></div>` : ""}
    ${review.missing_numbers ? `<p class="muted">${TagcastI18n.html("albumMerge.review.missingNumbers", {count: review.missing_numbers})}</p>` : ""}
    <details class="diff-group" open><summary><strong>${TagcastI18n.html("albumMerge.review.tracksHeading", {tracks: review.tracks.length})}</strong></summary><ol class="album-merge-tracks">${review.tracks.map(t => `<li><span class="muted">${t.track || "–"}</span><span><strong>${escapeHtml(t.title)}</strong><small>${TagcastI18n.html("albumMerge.review.trackSource", {artist: t.performers?.map(p => p.name).join(" · ") || t.artist, album: t.source_name, albumArtist: t.source_artist})}</small></span></li>`).join("")}</ol></details>
    <div class="dialog-footer"><button type="button" class="button" id="album-merge-back">${TagcastI18n.html("albumMerge.review.back")}</button><button type="button" class="button primary" id="album-merge-save" ${review.overlapping_numbers.length ? "disabled" : ""}>${TagcastI18n.html("albumMerge.review.save", {count: review.albums.length})}</button></div>`;
  albumMergeTitle("albumMerge.title.review");
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
  $("#album-merge-content").innerHTML = `<p>${TagcastI18n.html("albumMerge.save.sending")}</p>`;
  albumMergeStatus(TagcastI18n.text("albumMerge.save.moving"), true);
  let unconfirmed = false;
  try {
    const result = await api("/api/albums/merge/save", {approved: true, session: view.session,
      review: review.review, keep_overlapping_numbers: keepNumbers});
    if (!albumMergeCurrent(request)) return;
    albumMergeStatus(TagcastI18n.text("albumMerge.save.checking"), true);
    const job = await followJob(result.job, entry, null, () => albumMergeCurrent(request));
    if (!job || request !== view.request || view.session !== state.connection.playback_session) return;
    // The existing read-back refreshes the shared summaries; keep this dialog bound to them.
    view.details = state.details;
    // History keeps the English message; the dialog shows it in the interface language.
    if (entry.status !== "saved") { unconfirmed = true; throw Error(TagcastI18n.englishText("errors.albumMerge.not_confirmed")); }
    for (const album of review.albums) state.selected.delete(String(album.id));
    render();
    albumMergeStatus(TagcastI18n.text("albumMerge.save.confirmed"));
    const name = TagcastI18n.trusted(`<strong>${escapeHtml(review.target.name)}</strong>`);
    $("#album-merge-content").innerHTML = `<p>${TagcastI18n.html("albumMerge.done.contains", {album: name, count: review.tracks.length})} ${TagcastI18n.html("albumMerge.done.checked")}</p><div class="dialog-footer"><button type="button" class="button" data-close="album-merge">${TagcastI18n.html("albumMerge.done.close")}</button><button type="button" class="button primary" id="album-merge-open" data-target="${escapeHtml(result.target)}">${TagcastI18n.html("albumMerge.done.open")}</button></div>`;
    $("#album-merge-open").focus();
  } catch (error) {
    entry.status = error.status === 409 ? "blocked" : "unverified"; entry.error = error.message;
    for (const row of entry.changes) if (row.status === "sent") row.status = entry.status;
    rememberHistory();
    if (request === view.request && view.session === state.connection.playback_session) {
      albumMergeError(unconfirmed ? TagcastI18n.text("errors.albumMerge.not_confirmed") : TagcastI18n.errorText(error), TagcastI18n.text("albumMerge.save.noRetry"));
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
