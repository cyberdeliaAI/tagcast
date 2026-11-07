"use strict";

// Manual membership changes have their own review; no ordinary metadata draft is reused.
const albumSplitDraft = {request: 0, session: "", details: null, albumId: "", busy: false, reading: false,
  selection: null, review: null, chosen: new Set(), target: null, focus: null, scroll: 0};

function resetAlbumSplit() {
  albumSplitDraft.request += 1;
  albumSplitDraft.selection = null; albumSplitDraft.review = null;
  albumSplitDraft.chosen.clear(); albumSplitDraft.details = null; albumSplitDraft.target = null;
  if ($("#album-split").open) $("#album-split").close();
}

function albumSplitCurrent(request) {
  const view = albumSplitDraft;
  return request === view.request && view.session === state.connection.playback_session
    && view.details === state.details && live();
}

function albumSplitStatus(message, working = false) {
  setActionStatus("#album-split-status", message, working);
}

function albumSplitError(error, afterSave = false) {
  albumSplitStatus("");
  $("#album-split-content").innerHTML = `<p class="error-text" role="alert">${escapeHtml(TagcastI18n.errorText(error))}</p>
    ${afterSave ? `<p>${TagcastI18n.html("albumSplit.noRetry")}</p>` : ""}<div class="dialog-footer"><button type="button" class="button" data-close="album-split">${TagcastI18n.html("common.close")}</button><button type="button" class="button" id="album-split-reload">${TagcastI18n.html("common.reloadLibrary")}</button></div>`;
}

async function openAlbumSplit(sourceId = albumView.id) {
  if (!live() || saving || checking || albumSplitDraft.busy || !albumViewReady()) return;
  const album = state.details.get(String(sourceId));
  if (!album || !shelfIds(albumView.id).includes(String(sourceId))) return;
  const view = albumSplitDraft, request = ++view.request;
  Object.assign(view, {session: state.connection.playback_session, details: state.details,
    albumId: albumView.id, selection: null, review: null, chosen: new Set(), target: null, reading: false,
    focus: $("#album-split").open ? view.focus : document.activeElement, scroll: window.scrollY || 0});
  $("#album-split-content").innerHTML = "";
  if (!$("#album-split").open) $("#album-split").showModal();
  albumSplitStatus(TagcastI18n.text("albumSplit.checking"), true);
  try {
    const selection = await api("/api/albums/split/selection", {session: view.session,
      album: {id: album.id, name: album.name, artist: album.artist, year: album.year || 0,
        disc: album.disc || 0, tracks: album.tracks.map(t => t.id)}});
    if (!albumSplitCurrent(request) || !$("#album-split").open) return;
    view.selection = selection;
    view.target = {name: album.name, year: album.year || 0, disc: album.disc || 1};
    renderAlbumSplitSelection();
  } catch (error) { if (albumSplitCurrent(request) && $("#album-split").open) albumSplitError(error); }
}

function albumSplitRows(tracks, selectable) {
  return tracks.map(t => `<tr><td>${selectable ? `<input type="checkbox" data-split-track="${escapeHtml(t.id)}" aria-label="${TagcastI18n.html("albumSplit.selectTrack", {title: t.title})}" ${albumSplitDraft.chosen.has(t.id) ? "checked" : ""}>` : ""}</td>
    <td>${t.track || "–"}</td><td><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.performers?.map(p => p.name).join(" · ") || t.artist)}</small></td>
    <td>${t.year || "–"}</td><td>${escapeHtml((t.uploaded_at || t.uploaded_on || "–").replace("T", " "))}</td><td>${trackDuration(t.length)}</td></tr>`).join("");
}

function albumSplitTable(tracks, selectable) {
  return `<div class="album-split-tracks"><table><thead><tr><th></th><th>#</th><th>${TagcastI18n.html("album.table.title")}</th><th>${TagcastI18n.html("albumSplit.year")}</th><th>${TagcastI18n.html("albumSplit.uploaded")}</th><th>${TagcastI18n.html("tracks.table.time")}</th></tr></thead><tbody>${albumSplitRows(tracks, selectable)}</tbody></table></div>`;
}

function renderAlbumSplitSelection() {
  const view = albumSplitDraft, selection = view.selection, album = selection.album, target = view.target;
  view.review = null; albumSplitStatus("");
  const discs = shelfIds(view.albumId).map(id => state.details.get(id)).filter(Boolean);
  $("#album-split-content").innerHTML = `<p>${TagcastI18n.html("albumSplit.intro")}</p>
    ${discs.length > 1 ? `<label class="field">${TagcastI18n.html("albumSplit.sourceDisc")}<select id="album-split-source">${discs.map(d => `<option value="${escapeHtml(d.id)}" ${d.id === album.id ? "selected" : ""}>${TagcastI18n.html("common.disc", {disc: d.disc})} · ${escapeHtml(d.name)}</option>`).join("")}</select></label>` : ""}
    <h3>${escapeHtml(album.name)} · ${escapeHtml(album.artist)}</h3>
    ${selection.suggestions.length ? `<section class="scope-note"><strong>${TagcastI18n.html("albumSplit.suggestions")}</strong><p>${TagcastI18n.html("albumSplit.suggestionHint")}</p><div class="lyrics-actions">${selection.suggestions.map((g, i) => `<button type="button" class="button small" data-split-group="${i}">${TagcastI18n.html("albumSplit.group", {year: g.year, date: g.uploaded_on, tracks: g.tracks.length})}</button>`).join("")}</div></section>` : ""}
    <div class="album-split-layout"><section><p id="album-split-count" role="status"></p>${albumSplitTable(album.tracks, true)}</section>
      <div class="album-split-fields"><h3>${TagcastI18n.html("albumSplit.newAlbum")}</h3>
        <label class="field">${TagcastI18n.html("albumSplit.title")}<input id="album-split-name" maxlength="1000" required value="${escapeHtml(target.name)}"></label>
        <p>${TagcastI18n.html("albumSplit.artist", {artist: album.artist})}</p>
        <label class="field">${TagcastI18n.html("albumSplit.year")}<input id="album-split-year" type="number" min="0" max="2050" step="1" required value="${target.year}"></label>
        <label class="field">${TagcastI18n.html("albumSplit.disc")}<input id="album-split-disc" type="number" min="1" max="9999" step="1" required value="${target.disc}"></label>
        <p class="muted">${TagcastI18n.html("albumSplit.preserve")}</p>
      </div></div><div class="dialog-footer"><button type="button" class="button" data-close="album-split">${TagcastI18n.html("common.cancel")}</button><button type="button" class="button primary" id="album-split-review">${TagcastI18n.html("albumSplit.review")}</button></div>`;
  updateAlbumSplitCount();
  $("#album-split-name").focus();
}

function updateAlbumSplitCount() {
  const view = albumSplitDraft, total = view.selection.album.tracks.length, count = view.chosen.size;
  $("#album-split-count").textContent = TagcastI18n.text("albumSplit.count", {selected: count, remaining: total - count});
  $("#album-split-review").disabled = count === 0 || count === total;
}

function captureAlbumSplitTarget() {
  const name = $("#album-split-name"), year = $("#album-split-year"), disc = $("#album-split-disc");
  for (const input of [name, year, disc]) if (!input.reportValidity()) return false;
  albumSplitDraft.target = {name: name.value, year: Number(year.value), disc: Number(disc.value)};
  return true;
}

function applyAlbumSplitSuggestion(index) {
  const view = albumSplitDraft, group = view.selection?.suggestions[index];
  if (!group || view.review || view.reading || !albumSplitCurrent(view.request)) return;
  view.target = {name: $("#album-split-name").value, year: Number($("#album-split-year").value),
    disc: Number($("#album-split-disc").value)};
  view.chosen = new Set(group.tracks); view.target.year = group.year;
  renderAlbumSplitSelection();
}

async function reviewAlbumSplit() {
  const view = albumSplitDraft, request = view.request;
  if (!view.selection || saving || checking || view.reading || !albumSplitCurrent(request) || !captureAlbumSplitTarget()) return;
  view.reading = true;
  $("#album-split-content").querySelectorAll("input, select, button").forEach(input => { input.disabled = true; });
  albumSplitStatus(TagcastI18n.text("albumSplit.checking"), true);
  try {
    const review = await api("/api/albums/split/review", {session: view.session,
      selection: view.selection.selection, tracks: [...view.chosen], target: view.target});
    if (!albumSplitCurrent(request) || !$("#album-split").open) return;
    view.review = review;
    albumSplitStatus("");
    $("#album-split-content").innerHTML = `<h3>${escapeHtml(review.target.name)}</h3><p>${escapeHtml(review.target.artist)} · ${review.target.year || "–"} · ${TagcastI18n.html("common.disc", {disc: review.target.disc})}</p>
      <p>${TagcastI18n.html("albumSplit.confirm", {selected: review.tracks.length, remaining: review.remaining, album: review.source.name})}</p>
      <p>${TagcastI18n.html("albumSplit.preserve")}</p><div class="warn-box">${TagcastI18n.html("albumSplit.warning")}</div>
      ${albumSplitTable(review.tracks, false)}<div class="dialog-footer"><button type="button" class="button" id="album-split-back">${TagcastI18n.html("albumSplit.back")}</button><button type="button" class="button primary" id="album-split-save">${TagcastI18n.html("albumSplit.save")}</button></div>`;
    $("#album-split-title").focus(); $("#album-split").scrollTop = 0;
  } catch (error) {
    if (!albumSplitCurrent(request) || !$("#album-split").open) return;
    if (error.status === 409) albumSplitError(error);
    else { renderAlbumSplitSelection(); albumSplitStatus(TagcastI18n.errorText(error)); }
  } finally { if (request === view.request) view.reading = false; }
}

async function saveAlbumSplit() {
  const view = albumSplitDraft, request = view.request, review = view.review;
  if (!review || saving || checking || view.busy || !albumSplitCurrent(request)) return;
  const entry = {albumSplit: true, source: "ibroadcast", created: new Date().toISOString(), status: "sent", error: "",
    selection: [{id: review.source.id, name: review.source.name, artist: review.source.artist}],
    changes: review.tracks.map(t => ({kind: "track", id: t.id, label: t.title, status: "sent",
      fields: {album: {before: review.source.name, after: review.target.name}}}))};
  view.review = null; view.busy = true; saving = true;
  state.history.unshift(entry); rememberHistory(); updateChrome();
  $("#album-split-content").innerHTML = `<p>${TagcastI18n.html("albumSplit.sending")}</p>`;
  albumSplitStatus(TagcastI18n.text("albumSplit.saving"), true);
  try {
    const result = await api("/api/albums/split/save", {session: view.session, review: review.review, approved: true});
    if (!albumSplitCurrent(request)) return;
    entry.error = result.error || "";
    albumSplitStatus(TagcastI18n.text("albumSplit.verifying"), true);
    const job = await followJob(result.job, entry, null, () => albumSplitCurrent(request));
    if (!job || request !== view.request || view.session !== state.connection.playback_session) return;
    view.details = state.details;
    if (!$("#album-split").open) return;
    if (entry.status !== "saved") {
      albumSplitError(Error(entry.error || TagcastI18n.text("albumSplit.unconfirmed")), true); return;
    }
    albumSplitStatus(TagcastI18n.text("albumSplit.done"));
    $("#album-split-content").innerHTML = `<p>${TagcastI18n.html("albumSplit.confirmed", {album: review.target.name})}</p><div class="dialog-footer"><button type="button" class="button" data-close="album-split">${TagcastI18n.html("common.close")}</button><button type="button" class="button primary" id="album-split-open" data-target="${escapeHtml(result.target)}">${TagcastI18n.html("albumSplit.open")}</button></div>`;
    $("#album-split-open").focus();
  } catch (error) {
    entry.status = error.status === 409 ? "blocked" : "unverified"; entry.error = error.message;
    for (const row of entry.changes) if (row.status === "sent") row.status = entry.status;
    rememberHistory();
    if (request === view.request && view.session === state.connection.playback_session && $("#album-split").open) albumSplitError(error, true);
  } finally {
    // A library replacement can invalidate the UI while a request is in flight.
    if (entry.status === "sent" && state.history.includes(entry)) {
      entry.status = "unverified";
      for (const row of entry.changes) if (row.status === "sent") row.status = "unverified";
      rememberHistory();
    }
    view.busy = false; saving = false; updateChrome();
  }
}

$("#album-action-split").addEventListener("click", () => {
  const {trigger, details, id} = albumActions;
  closeAlbumActions(true);
  if (trigger?.isConnected && !trigger.disabled && details === state.details && id === albumView.id) openAlbumSplit();
});
$("#album-split").addEventListener("close", () => {
  const view = albumSplitDraft;
  if (!view.busy) { view.request += 1; view.selection = null; view.review = null; view.chosen.clear(); }
  albumSplitStatus("");
  if (view.focus?.isConnected) view.focus.focus();
  window.scrollTo({top: view.scroll});
});
$("#album-split").addEventListener("change", event => {
  if (albumSplitDraft.busy || albumSplitDraft.reading) return;
  if (event.target.dataset.splitTrack) {
    const id = event.target.dataset.splitTrack;
    if (event.target.checked) albumSplitDraft.chosen.add(id); else albumSplitDraft.chosen.delete(id);
    updateAlbumSplitCount();
  }
  if (event.target.id === "album-split-source") openAlbumSplit(event.target.value);
});
$("#album-split").addEventListener("click", event => {
  const group = event.target.closest("[data-split-group]");
  if (group) applyAlbumSplitSuggestion(Number(group.dataset.splitGroup));
  if (event.target.closest("#album-split-review")) reviewAlbumSplit();
  if (event.target.closest("#album-split-save")) saveAlbumSplit();
  if (event.target.closest("#album-split-back")) renderAlbumSplitSelection();
  if (event.target.closest("#album-split-reload")) { $("#album-split").close(); loadLive(true); }
  const open = event.target.closest("#album-split-open");
  if (open) { $("#album-split").close(); openAlbum(open.dataset.target); }
});
