"use strict";

// Trash reviews and the duplicate cleanup hold drafts: a language change never re-renders their
// dialogs; the next render uses the new language. The album page trash bar is rendered by
// renderAlbumView() from in-memory state. History entries and reports stay English data.
const selectedAlbumsTrash = {request: 0, details: null, groups: null, busy: false, stop: false, combine: false};

// A display error raised here: English message for logs and tests, translated when shown.
const trashFailure = key => TagcastI18n.failure(key.slice("errors.".length));

function resetSelectedAlbumTrash() {
  selectedAlbumsTrash.request += 1; selectedAlbumsTrash.stop = true;
  selectedAlbumsTrash.groups = null; selectedAlbumsTrash.details = null;
  setActionStatus("#selected-trash-status", "");
  if ($("#trash-review").open) $("#trash-review").close();
}

function selectedAlbumTrashBatches(groups) {
  const batches = []; let batch = [], tracks = 0;
  for (const group of groups) {
    const size = group.discs.reduce((n, d) => n + d.tracks.length, 0);
    if (size > 500) throw trashFailure("errors.trash.album_too_large");
    if (batch.length && (batch.length === 20 || tracks + size > 500)) { batches.push(batch); batch = []; tracks = 0; }
    batch.push(group); tracks += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function reviewSelectedAlbumTrash() {
  if (!live() || saving || checking || selectedAlbumsTrash.busy) return;
  const groups = albumShelf().filter(isSelected)
    .map(a => ({id: a.id, name: a.name, artist: a.artist, ids: itemIds(a)}));
  if (!groups.length) return;
  const view = selectedAlbumsTrash, request = ++view.request, details = state.details;
  view.details = details; view.groups = null; view.stop = false; view.combine = Boolean(state.connection.combine_sets);
  $("#trash-content").innerHTML = `<div class="dialog-heading"><h2>${TagcastI18n.html("trash.selected.heading")}</h2><button class="close" data-close="trash-review" aria-label="${TagcastI18n.html("common.close")}">×</button></div><p role="status" class="operation-status" data-working="true">${TagcastI18n.html("trash.selected.loading")}</p>`;
  $("#trash-review").showModal();
  try {
    const ids = groups.flatMap(g => g.ids);
    for (let i = 0; i < ids.length; i += 100) {
      if (request !== view.request || details !== state.details || !live()) return;
      await albumDetails(ids.slice(i, i + 100));
    }
    if (request !== view.request || details !== state.details || !live()) return;
    for (const group of groups) {
      group.discs = group.ids.map(id => state.details.get(String(id)));
      if (group.discs.some(d => !d || !d.tracks.length || d.artist !== group.artist)) throw trashFailure("errors.trash.selection_changed");
    }
    selectedAlbumTrashBatches(groups);
    view.groups = structuredClone(groups);
    const count = groups.reduce((n, g) => n + g.discs.reduce((sum, d) => sum + d.tracks.length, 0), 0);
    $("#trash-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${TagcastI18n.html("trash.selected.eyebrow")}</div><h2>${TagcastI18n.html("common.count.albums", {count: groups.length})} · ${TagcastI18n.html("trash.selected.tracks", {count})}</h2></div><button class="close" data-close="trash-review" aria-label="${TagcastI18n.html("common.close")}">×</button></div>
      <div class="warn-box">${TagcastI18n.html("trash.selected.warning")}</div>
      ${groups.map(g => `<details class="diff-group"><summary><strong>${escapeHtml(g.name)}</strong> · ${escapeHtml(g.artist)} · ${TagcastI18n.html("trash.selected.tracks", {count: g.discs.reduce((n, d) => n + d.tracks.length, 0)})}</summary>${g.discs.map(d => `<h3>${TagcastI18n.html("common.disc", {disc: d.disc || 1})}</h3>${d.tracks.map(t => `<p class="trash-row">${t.track || "–"}. ${escapeHtml(t.title)} <span class="muted">· ${escapeHtml(t.artist)} · ${trackDuration(t.length)}${t.format ? ` · ${escapeHtml(t.format)}` : ""}</span></p>`).join("")}`).join("")}</details>`).join("")}
      <p class="muted">${TagcastI18n.html("trash.selected.process")}</p>
      <p id="selected-trash-status" role="status"></p><div class="dialog-footer" id="selected-trash-footer"><button class="button" id="selected-trash-cancel" data-close="trash-review">${TagcastI18n.html("trash.selected.keep")}</button><button class="button danger primary" id="selected-trash-confirm">${TagcastI18n.html("trash.selected.move", {count: groups.length})}</button></div>`;
    $("#selected-trash-cancel").focus();
  } catch (error) {
    if (request === view.request && details === state.details) $("#trash-content").innerHTML = `<div class="dialog-heading"><h2>${TagcastI18n.html("trash.selected.failed")}</h2><button class="close" data-close="trash-review" aria-label="${TagcastI18n.html("common.close")}">×</button></div><p class="error-text" role="alert">${escapeHtml(TagcastI18n.errorText(error))}</p>`;
  }
}

async function trashSelectedAlbums() {
  const view = selectedAlbumsTrash, request = view.request;
  if (!view.groups || view.busy || saving || checking || !live() || view.details !== state.details) return;
  const batches = selectedAlbumTrashBatches(view.groups);
  const current = () => request === view.request && view.details === state.details && live();
  view.busy = true; view.stop = false; saving = true;
  $("#selected-trash-footer").innerHTML = `<button class="button" id="selected-trash-stop">${TagcastI18n.html("cleanup.action.stop")}</button>`;
  $("#selected-trash-stop").focus();
  let complete = 0, failure = "";
  try {
    for (const groups of batches) {
      if (!current() || view.stop) break;
      const albums = groups.flatMap(g => g.discs.map(d => ({id: String(d.id), name: d.name, artist: d.artist,
        tracks: d.tracks.map(t => ({id: String(t.id), title: t.title}))})));
      const rows = albums.flatMap(a => a.tracks.map(t => ({...t, albumId: a.id})));
      const entry = {scope: "albums", trash: true, selection: groups.map(g => ({id: g.id, name: g.name, artist: g.artist})),
        created: new Date().toISOString(), source: "ibroadcast", status: "sent", error: "",
        changes: rows.map(t => ({kind: "track", id: t.id, albumId: t.albumId, label: t.title, status: "sent",
          fields: {trash: {before: "In your library", after: "In the trash"}}}))};
      state.history.unshift(entry); rememberHistory();
      setActionStatus("#selected-trash-status", TagcastI18n.text("trash.selected.moving", {batch: complete + 1, batches: batches.length}), true);
      let result;
      try {
        result = await api("/api/trash/albums", {approved: true, combine_sets: view.combine, albums});
      } catch (error) {
        if (!current()) break;
        entry.status = error.status === 409 ? "blocked" : "unverified"; entry.error = error.message;
        for (const change of entry.changes) change.status = entry.status;
        rememberHistory(); throw error;
      }
      if (!current()) break;
      setActionStatus("#selected-trash-status", TagcastI18n.text("trash.selected.verifying", {batch: complete + 1, batches: batches.length}), true);
      const job = await followJob(result.job, entry, null, current);
      if (!job || request !== view.request || !live()) break;
      view.details = state.details; // this batch's checked album index replaced the cache
      if (job.state !== "done" || entry.status !== "saved") throw trashFailure("errors.trash.not_confirmed");
      for (const group of groups) for (const id of group.ids) state.selected.delete(String(id));
      complete += 1; render();
    }
  } catch (error) { failure = TagcastI18n.errorText(error); }
  finally {
    view.busy = false; saving = false; updateChrome();
    if (request === view.request) {
      setActionStatus("#selected-trash-status", failure || (complete === batches.length ? TagcastI18n.text("trash.selected.done")
        : TagcastI18n.text("trash.selected.stopped", {complete, count: batches.length})));
      $("#selected-trash-footer").innerHTML = `<button class="button" data-close="trash-review">${TagcastI18n.html("common.close")}</button><button class="button" id="selected-trash-refresh">${TagcastI18n.html("common.reloadLibrary")}</button>`;
      view.groups = null;
    }
  }
}

$("#trash-selection").addEventListener("click", reviewSelectedAlbumTrash);
$("#trash-review").addEventListener("close", () => {
  selectedAlbumsTrash.stop = true;
  if (!selectedAlbumsTrash.busy) { selectedAlbumsTrash.request += 1; selectedAlbumsTrash.groups = null; }
});
$("#trash-review").addEventListener("click", event => {
  if (event.target.closest("#selected-trash-confirm")) return trashSelectedAlbums();
  if (event.target.closest("#selected-trash-stop")) { selectedAlbumsTrash.stop = true; setActionStatus("#selected-trash-status", TagcastI18n.text("trash.selected.stopping"), true); }
  if (event.target.closest("#selected-trash-refresh")) { $("#trash-review").close(); return loadLive(); }
});

// A separate, persisted review; opening it never scans or writes to iBroadcast.
const duplicateCleanupView = {data: null, offset: 0, excluded: new Set(), request: 0,
  timer: null, busy: false, approved: false, expanded: new Set(), renderedId: null};

function resetDuplicateCleanup(close = false) {
  const view = duplicateCleanupView;
  view.request += 1; clearTimeout(view.timer);
  view.data = null; view.offset = 0; view.excluded.clear(); view.busy = false; view.approved = false;
  view.expanded.clear(); view.renderedId = null;
  setActionStatus("#duplicate-cleanup-status", "");
  if (close && $("#duplicate-cleanup").open) $("#duplicate-cleanup").close();
}

async function fetchDuplicateCleanup() {
  const view = duplicateCleanupView, request = ++view.request, details = state.details;
  clearTimeout(view.timer);
  try {
    const data = await api(`/api/duplicate-cleanup?offset=${view.offset}&limit=10`);
    if (request !== view.request || details !== state.details || !live()) return;
    if (data.id !== view.data?.id || data.state !== "preview") view.excluded = new Set(data.excluded || []);
    view.data = data; renderDuplicateCleanup();
    if (data.state === "running" && $("#duplicate-cleanup").open) view.timer = setTimeout(fetchDuplicateCleanup, 1500);
  } catch (error) {
    if (request === view.request && details === state.details) $("#duplicate-cleanup-status").textContent = TagcastI18n.errorText(error);
  }
}

function duplicateCleanupSelection() {
  return (duplicateCleanupView.data?.selection || []).filter(t => !duplicateCleanupView.excluded.has(t.id));
}

function updateDuplicateCleanupSelection() {
  const view = duplicateCleanupView, selected = duplicateCleanupSelection();
  const count = $("#duplicate-cleanup-selected");
  if (count) count.textContent = TagcastI18n.text("trash.duplicates.selected", {copies: TagcastI18n.text("trash.duplicates.copies", {count: selected.length}),
    albums: TagcastI18n.text("cleanup.count.albums", {count: new Set(selected.map(t => t.group)).size})});
  const start = $("#duplicate-cleanup-start");
  if (start) start.disabled = view.busy || !view.approved || !selected.length;
}

// Job and copy states are server codes; an unknown value is shown as sent.
const duplicateCleanupStates = {running: "cleanup.state.running", done: "cleanup.state.done", stopped: "cleanup.state.stopped", error: "cleanup.state.error"};
const duplicateTrackStates = {retained: "trash.duplicates.status.retained", pending: "trash.duplicates.status.pending", sent: "trash.duplicates.status.sent",
  confirmed: "trash.duplicates.status.confirmed", unconfirmed: "trash.duplicates.status.unconfirmed", conflict: "trash.duplicates.status.conflict",
  excluded: "trash.duplicates.status.excluded"};
const duplicateCleanupState = value => Object.hasOwn(duplicateCleanupStates, value) ? TagcastI18n.html(duplicateCleanupStates[value]) : escapeHtml(value);
const duplicateTrackStatus = value => Object.hasOwn(duplicateTrackStates, value) ? TagcastI18n.html(duplicateTrackStates[value]) : escapeHtml(value);

function renderDuplicateCleanup() {
  const view = duplicateCleanupView, data = view.data || {state: "empty"};
  const preview = data.state === "preview", running = data.state === "running", counts = data.counts || {};
  const dialog = $("#duplicate-cleanup"), scroll = dialog.scrollTop;
  const focus = dialog.contains?.(document.activeElement) ? document.activeElement : null;
  const focusId = focus?.id, copyId = focus?.dataset.duplicateCopy, groupId = focus?.dataset.duplicateAlbum;
  if (view.renderedId !== data.id) {
    view.expanded = new Set(data.groups?.slice(0, 1).map(g => g.id) || []); view.renderedId = data.id;
  } else for (const node of dialog.querySelectorAll("[data-duplicate-group]")) {
    if (node.open) view.expanded.add(node.dataset.duplicateGroup); else view.expanded.delete(node.dataset.duplicateGroup);
  }
  const disabled = view.busy ? "disabled" : "";
  const strong = key => TagcastI18n.trusted(`<strong>${TagcastI18n.html(key)}</strong>`);
  const notice = data.id ? [TagcastI18n.html("trash.duplicates.scanned", {count: data.scanned}), TagcastI18n.html("trash.duplicates.suggested", {count: data.tracks}),
    TagcastI18n.html("trash.duplicates.manual", {count: data.manual})].join(" · ") : "";
  const status = [`<strong>${duplicateCleanupState(data.state)}</strong>`, TagcastI18n.html("cleanup.status.confirmed", {count: counts.confirmed || 0}),
    TagcastI18n.html("cleanup.status.pending", {count: counts.pending || 0}), TagcastI18n.html("cleanup.status.sent", {count: counts.sent || 0}),
    TagcastI18n.html("cleanup.status.unconfirmed", {count: counts.unconfirmed || 0}), TagcastI18n.html("cleanup.status.conflicts", {count: counts.conflict || 0}),
    TagcastI18n.html("cleanup.status.excluded", {count: counts.excluded || 0})].join(" · ");
  $("#duplicate-cleanup-content").innerHTML = `<p>${TagcastI18n.html("trash.duplicates.intro", {action: strong("trash.bar.selectSuggested"), scope: strong("trash.duplicates.scope")})} ${TagcastI18n.html("trash.suggest.prefer")} ${TagcastI18n.html("trash.duplicates.uncertain")}</p>
    <p class="muted">${TagcastI18n.html("trash.suggest.metadataOnly")} ${TagcastI18n.html("trash.duplicates.compare")}</p>
    <button class="button" id="duplicate-cleanup-preview" ${running || view.busy ? "disabled" : ""}>${TagcastI18n.html("trash.duplicates.analyse")}</button>
    ${data.id ? `<div class="notice">${notice} ${TagcastI18n.html("trash.duplicates.batches", {tracks: data.batch_tracks, albums: data.batch_albums})}</div>
    ${data.error ? `<p class="warn-box" role="status">${escapeHtml(data.error)}</p>` : ""}
    ${preview ? `<p>${TagcastI18n.html("trash.duplicates.previewHelp")}</p>` : `<p role="status" class="operation-status" data-working="${running}">${status}</p>`}
    ${preview && data.tracks ? `<div class="cleanup-controls"><button class="text-action" id="duplicate-select-all" ${disabled}>${TagcastI18n.html("trash.duplicates.selectAll")}</button><button class="text-action" id="duplicate-select-none" ${disabled}>${TagcastI18n.html("trash.duplicates.keepAll")}</button><strong id="duplicate-cleanup-selected" role="status"></strong></div>` : ""}
    <div class="cleanup-albums">${data.groups.map(group => {
      const proposed = data.selection.filter(t => t.group === group.id), selected = proposed.filter(t => !view.excluded.has(t.id));
      return `<details class="cleanup-album" data-duplicate-group="${escapeHtml(group.id)}" ${view.expanded.has(group.id) ? "open" : ""}><summary><h3>${preview && proposed.length ? `<label><input type="checkbox" data-duplicate-album="${escapeHtml(group.id)}" ${selected.length ? "checked" : ""} ${disabled}> ` : ""}${escapeHtml(group.album)}${preview && proposed.length ? "</label>" : ""}</h3><p class="muted">${escapeHtml(group.artist)} · ${TagcastI18n.html("trash.duplicates.proposed", {count: proposed.length})}</p></summary>
        ${group.positions.map(position => `<div class="duplicate-position"><h4>${TagcastI18n.html("trash.duplicates.position", {disc: position.disc || 1, number: position.number})}</h4>${position.tracks.map(track => `<div class="duplicate-copy"><div>${preview && track.choice === "trash" ? `<label><input type="checkbox" data-duplicate-copy="${escapeHtml(track.id)}" ${view.excluded.has(track.id) ? "" : "checked"} ${disabled}> <strong>${escapeHtml(track.title)}</strong></label>` : `<strong>${escapeHtml(track.title)}</strong>`}<span class="pill ${track.choice === "trash" ? "missing" : ""}">${preview ? trashChoiceLabel(track.choice) : duplicateTrackStatus(track.status)}</span></div><p class="muted">${escapeHtml(track.artist)} · ${trackDuration(track.length)} · ${track.format ? escapeHtml(track.format) : TagcastI18n.html("trash.upload.unknownFormat")} · ${track.uploaded_at ? TagcastI18n.html("trash.upload.uploadedAt", {date: track.uploaded_at.replace("T", " ")}) : TagcastI18n.html("trash.upload.dateUnknown")}</p><p>${escapeHtml(track.reason)}</p></div>`).join("")}</div>`).join("")}</details>`;
    }).join("") || `<p class="muted">${TagcastI18n.html("trash.duplicates.empty")}</p>`}</div>
    <div class="pagination"><button class="button small" data-duplicate-page="-10" ${view.offset <= 0 || view.busy ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${data.albums ? Math.floor(view.offset / 10) + 1 : 0} / ${Math.ceil(data.albums / 10)}</span><button class="button small" data-duplicate-page="10" ${view.offset + 10 >= data.albums || view.busy ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>
    <p class="muted">${TagcastI18n.html("trash.duplicates.saved")}</p>
    ${!running && data.state !== "done" && data.tracks ? `<label class="checkline"><input id="duplicate-cleanup-approved" type="checkbox" ${view.approved ? "checked" : ""} ${disabled}> ${TagcastI18n.html("trash.duplicates.approve")}</label>` : ""}
    <div class="dialog-footer"><button class="button" id="duplicate-cleanup-export" ${disabled}>${TagcastI18n.html("cleanup.action.export")}</button>${running ? `<button class="button danger" id="duplicate-cleanup-stop">${TagcastI18n.html("cleanup.action.stop")}</button>` : data.state !== "done" && data.tracks ? `<button class="button danger" id="duplicate-cleanup-start" disabled>${TagcastI18n.html(preview ? "trash.duplicates.start" : "trash.duplicates.continue")}</button>` : ""}${!running ? `<button class="button" id="duplicate-cleanup-refresh" ${disabled}>${TagcastI18n.html("trash.duplicates.refresh")}</button>` : ""}</div>` : `<p class="muted">${TagcastI18n.html("trash.duplicates.none")}</p>`}`;
  dialog.scrollTop = scroll;
  updateDuplicateCleanupSelection();
  for (const box of dialog.querySelectorAll("[data-duplicate-album]")) {
    const tracks = data.selection.filter(t => t.group === box.dataset.duplicateAlbum);
    const selected = tracks.filter(t => !view.excluded.has(t.id)).length;
    box.indeterminate = selected > 0 && selected < tracks.length;
  }
  if (focusId) $(`#${focusId}`)?.focus();
  else if (copyId) dialog.querySelector(`[data-duplicate-copy="${CSS.escape(copyId)}"]`)?.focus();
  else if (groupId) dialog.querySelector(`[data-duplicate-album="${CSS.escape(groupId)}"]`)?.focus();
}

async function duplicateCleanupAction(action) {
  const view = duplicateCleanupView;
  if (view.busy || !live() || action === "start" && (!view.approved || !duplicateCleanupSelection().length)) return;
  if (action === "preview" && view.data?.id && !confirm(TagcastI18n.text("trash.duplicates.confirmReplace"))) return;
  const details = state.details, request = ++view.request;
  const body = action === "preview" ? {} : {id: view.data.id, excluded: [...view.excluded], approved: view.approved};
  view.busy = true; view.approved = false; clearTimeout(view.timer); renderDuplicateCleanup();
  setActionStatus("#duplicate-cleanup-status", TagcastI18n.text(action === "preview" ? "trash.duplicates.analysing" : action === "start" ? "trash.duplicates.starting" : "cleanup.progress.stop"), true);
  try {
    const data = await api(`/api/duplicate-cleanup/${action}`, body);
    if (request !== view.request || details !== state.details || !live()) return;
    view.data = data; view.excluded = new Set(data.excluded || []); view.offset = 0;
    setActionStatus("#duplicate-cleanup-status", "");
    if (data.state === "running" && $("#duplicate-cleanup").open) view.timer = setTimeout(fetchDuplicateCleanup, 1500);
  } catch (error) {
    if (request === view.request && details === state.details) $("#duplicate-cleanup-status").textContent = TagcastI18n.errorText(error);
  } finally {
    if (request === view.request) { view.busy = false; setActionStatus("#duplicate-cleanup-status", undefined); renderDuplicateCleanup(); }
  }
}

$("#duplicate-cleanup-open").addEventListener("click", async () => {
  if (!live()) return;
  $("#duplicate-cleanup-content").innerHTML = `<p class="muted">${TagcastI18n.html("trash.duplicates.loading")}</p>`;
  setActionStatus("#duplicate-cleanup-status", ""); $("#duplicate-cleanup").showModal();
  await fetchDuplicateCleanup();
});
$("#duplicate-cleanup").addEventListener("close", () => clearTimeout(duplicateCleanupView.timer));
$("#duplicate-cleanup").addEventListener("change", event => {
  const view = duplicateCleanupView;
  if (view.busy) return;
  if (event.target.id === "duplicate-cleanup-approved") {
    view.approved = event.target.checked; updateDuplicateCleanupSelection(); return;
  }
  const copy = event.target.dataset.duplicateCopy, group = event.target.dataset.duplicateAlbum;
  if (view.data?.state !== "preview" || !copy && !group) return;
  for (const track of view.data.selection.filter(t => copy ? t.id === copy : t.group === group)) {
    if (event.target.checked) view.excluded.delete(track.id); else view.excluded.add(track.id);
  }
  view.approved = false; renderDuplicateCleanup();
});
$("#duplicate-cleanup").addEventListener("click", async event => {
  const view = duplicateCleanupView;
  const action = event.target.closest("#duplicate-cleanup-preview, #duplicate-cleanup-start, #duplicate-cleanup-stop");
  if (action) return duplicateCleanupAction(action.id.replace("duplicate-cleanup-", ""));
  if (view.busy) return;
  if (event.target.closest("#duplicate-cleanup-refresh")) return loadLive();
  if (event.target.closest("#duplicate-cleanup-export")) {
    const details = state.details, request = view.request;
    try {
      const data = await api("/api/duplicate-cleanup/report");
      if (details !== state.details || request !== view.request || data.id !== view.data?.id || !live()) return;
      data.excluded = [...view.excluded];
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
      const link = document.createElement("a"); link.href = url; link.download = `tagcast-duplicate-cleanup-${data.id}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (error) { if (details === state.details && request === view.request) $("#duplicate-cleanup-status").textContent = TagcastI18n.errorText(error); }
    return;
  }
  const page = event.target.closest("[data-duplicate-page]");
  if (page) { view.offset = Math.max(0, view.offset + Number(page.dataset.duplicatePage)); return fetchDuplicateCleanup(); }
  const selection = event.target.closest("#duplicate-select-all, #duplicate-select-none");
  if (selection && view.data?.state === "preview") {
    view.excluded = new Set(selection.id === "duplicate-select-none" ? view.data.selection.map(t => t.id) : []);
    view.approved = false; renderDuplicateCleanup();
  }
});

// Moving tracks to iBroadcast's trash from the album page: choose tracks, review them,
// then send. iBroadcast keeps them in its trash; Tagcast can't take them back out.

const trashIcon = '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';

function albumDiscs() {
  return shelfIds(albumView.id).map(id => state.details.get(id)).filter(Boolean);
}

function trashBar(discs, years = trashYearAdvice(discs)) {
  const count = albumView.trash.size, all = discs.reduce((n, d) => n + d.tracks.length, 0);
  const suggestion = trashSuggestion(discs);
  return `<section class="trash-suggestion"><p><strong>${TagcastI18n.html("trash.suggest.heading")}</strong> · ${TagcastI18n.html("trash.suggest.prefer")} ${TagcastI18n.html("trash.suggest.manual")} ${TagcastI18n.html("trash.suggest.metadataOnly")}</p>
    <p>${suggestion.remove.length ? TagcastI18n.html("trash.suggest.count", {count: suggestion.remove.length}) : TagcastI18n.html("trash.suggest.none")} ${TagcastI18n.html("trash.suggest.howTo")}</p>
    ${years.size ? `<p><strong>${TagcastI18n.html("trash.year.heading")}</strong> · ${TagcastI18n.html("trash.year.help")}</p><p><button type="button" class="button small" data-trash-other-years>${TagcastI18n.html("trash.year.select", {count: years.size})}</button></p>` : ""}
    ${uploadGroups(discs)}</section>
    <div class="selection-bar trash-bar"><strong>${TagcastI18n.html("trash.bar.selected", {selected: count, count: all})}</strong>${suggestion.remove.length ? `<button class="button small" data-trash-suggested>${TagcastI18n.html("trash.bar.selectSuggested")}</button>` : ""}${extraCopies(discs).length ? `<button class="button small" data-trash-duplicates title="${TagcastI18n.html("trash.bar.selectExtraTitle")}">${TagcastI18n.html("trash.bar.selectExtra")}</button>` : ""}<button class="button small" data-trash-all>${TagcastI18n.html(count === all ? "trash.bar.selectNone" : "trash.bar.selectAll")}</button><button class="button small" data-trash-cancel>${TagcastI18n.html("common.cancel")}</button><button class="button small primary" data-trash-review ${count ? "" : "disabled"}>${TagcastI18n.html("trash.bar.review")}</button></div>`;
}

const trashCheck = t => `<input type="checkbox" class="trash-check" data-trash-track="${escapeHtml(t.id)}" aria-label="${TagcastI18n.html("trash.bar.selectTrack", {title: t.title})}" ${albumView.trash.has(String(t.id)) ? "checked" : ""}>`;

function trashUploadedAt(track) {
  const value = String(track.uploaded_at || track.uploaded_on || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(value)) return "";
  const date = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return "";
  if (value.length === 19 && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return value.slice(0, 10);
  return value;
}

// The English reasons in `choices` are the contract shared with duplicate_cleanup.py
// (tests/fixtures/duplicate_suggestions.json); `notes` keeps their keys for display.
const trashReasons = {artists: "trash.reason.artists", durations: "trash.reason.durations", titles: "trash.reason.incomplete",
  formats: "trash.reason.formats", tied: "trash.reason.tied", flac: "trash.reason.flac", newest: "trash.reason.newest",
  flacAvailable: "trash.reason.flacAvailable", older: "trash.reason.older", titlesDiffer: "trash.reason.titlesDiffer"};

function trashSuggestion(discs) {
  const choices = new Map(), notes = new Map(), remove = [];
  const choose = (track, choice, reasons) => {
    choices.set(String(track.id), {choice, reason: reasons.map(key => TagcastI18n.englishText(key)).join(" ")});
    notes.set(String(track.id), reasons);
  };
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      const key = duplicateTrackPosition(track);
      if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(track); }
    }
    for (const tracks of groups.values()) {
      if (tracks.length < 2) continue;
      const manual = reason => tracks.forEach(t => choose(t, "manual", [reason]));
      const artists = new Set(tracks.map(t => String(t.artist || "").trim().toLocaleLowerCase()).filter(Boolean));
      const lengths = tracks.map(t => Number(t.length)).filter(n => n > 0);
      const titles = new Set(tracks.map(t => titleKey(t.title)));
      if (artists.size > 1) { manual(trashReasons.artists); continue; }
      if (lengths.length && Math.max(...lengths) - Math.min(...lengths) > 2) {
        manual(trashReasons.durations); continue;
      }
      if (titles.size > 1 && (lengths.length !== tracks.length || artists.size !== 1)) {
        manual(trashReasons.titles); continue;
      }
      const formats = new Set(tracks.map(t => t.format || ""));
      if (formats.has("") || formats.size > 1 && [...formats].some(f => !["FLAC", "MP3"].includes(f))) {
        manual(trashReasons.formats); continue;
      }
      const flac = formats.has("FLAC") && formats.has("MP3");
      let keep = flac ? tracks.filter(t => t.format === "FLAC") : [...tracks];
      // A missing date or time cannot be treated as an older upload.
      if (keep.every(t => trashUploadedAt(t))) {
        const day = keep.map(t => trashUploadedAt(t).slice(0, 10)).sort().at(-1);
        keep = keep.filter(t => trashUploadedAt(t).slice(0, 10) === day);
        if (keep.every(t => trashUploadedAt(t).length === 19)) {
          const newest = keep.map(trashUploadedAt).sort().at(-1);
          keep = keep.filter(t => trashUploadedAt(t) === newest);
        }
      }
      const retained = new Set(keep.map(t => String(t.id)));
      for (const track of tracks) {
        const id = String(track.id), preferred = retained.has(id);
        const reasons = [preferred ? keep.length > 1 ? trashReasons.tied : flac ? trashReasons.flac : trashReasons.newest
          : flac && track.format === "MP3" ? trashReasons.flacAvailable : trashReasons.older];
        if (titles.size > 1) reasons.push(trashReasons.titlesDiffer);
        const choice = preferred ? keep.length > 1 ? "manual" : "keep" : "trash";
        choose(track, choice, reasons);
        if (!preferred) remove.push(id);
      }
    }
  }
  return {choices, notes, remove};
}

// A year difference is a comparison aid, never evidence that a recording is a duplicate.
// Count original native discs separately, including tracks whose year is unknown.
function trashYearAdvice(discs) {
  const marked = new Map();
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      const key = String(track.album_id || disc.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(track);
    }
    for (const tracks of groups.values()) {
      const counts = new Map();
      for (const track of tracks) {
        const year = trashKnownTrackYear(track);
        if (year) counts.set(year, (counts.get(year) || 0) + 1);
      }
      const majority = [...counts].find(([, count]) => count > tracks.length / 2)?.[0];
      if (!majority || counts.size < 2) continue;
      for (const track of tracks) {
        const year = trashKnownTrackYear(track);
        if (year && year !== majority) marked.set(String(track.id), majority);
      }
    }
  }
  return marked;
}

function uploadGroups(discs) {
  const open = $("#album-page .trash-upload-groups")?.open;
  const rows = [];
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      // "Unknown format" stays the grouping and sorting value; only its display is translated.
      const date = trashUploadedAt(track).slice(0, 10), format = track.format || "Unknown format";
      const key = JSON.stringify([track.album_id || disc.id, date, format]);
      if (!groups.has(key)) groups.set(key, {date, format, known: Boolean(track.format), tracks: []});
      groups.get(key).tracks.push(track);
    }
    for (const group of [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || a.format.localeCompare(b.format))) {
      const positions = [...new Set(group.tracks.map(duplicateTrackNumber).filter(Boolean))].sort((a, b) => a - b);
      rows.push(`<tr>${discs.length > 1 ? `<td>${disc.disc || "?"}</td>` : ""}<td>${group.date || TagcastI18n.html("trash.upload.unknownDate")}</td><td>${group.known ? escapeHtml(group.format) : TagcastI18n.html("trash.upload.unknownFormat")}</td><td>${group.tracks.length}</td><td>${positions.join(", ") || TagcastI18n.html("trash.upload.unknown")}</td></tr>`);
    }
  }
  return `<details class="trash-upload-groups"${open ? " open" : ""}><summary>${TagcastI18n.html("trash.upload.heading")}</summary><p class="muted">${TagcastI18n.html("trash.upload.help")}</p><table><thead><tr>${discs.length > 1 ? `<th>${TagcastI18n.html("trash.upload.disc")}</th>` : ""}<th>${TagcastI18n.html("trash.upload.uploaded")}</th><th>${TagcastI18n.html("trash.upload.format")}</th><th>${TagcastI18n.html("trash.upload.tracks")}</th><th>${TagcastI18n.html("trash.upload.trackNumbers")}</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`;
}

const trashChoices = {keep: "trash.choice.keep", trash: "trash.choice.trash", manual: "trash.choice.manual"};
const trashChoiceLabel = choice => Object.hasOwn(trashChoices, choice) ? TagcastI18n.html(trashChoices[choice]) : "";
const trashUploadLabel = stamp => stamp ? TagcastI18n.html("trash.upload.uploadedAt", {date: stamp.replace("T", " ")}) : TagcastI18n.html("trash.upload.uploadedUnknown");
const trashKnownTrackYear = track => {
  if (!["number", "string"].includes(typeof track.year)) return 0;
  const year = Number(track.year);
  return Number.isInteger(year) && year > 0 ? year : 0;
};
const trashYearLabel = track => {
  const year = trashKnownTrackYear(track);
  return year ? TagcastI18n.html("trash.track.year", {year: String(year)}) : TagcastI18n.html("trash.track.yearUnknown");
};

function trashTrackNote(track, suggestion, years) {
  const stamp = trashUploadedAt(track), result = suggestion.choices.get(String(track.id));
  const reasons = suggestion.notes?.get(String(track.id));
  const reason = reasons ? reasons.map(key => TagcastI18n.html(key)).join(" ") : escapeHtml(result?.reason);
  const majority = years?.get(String(track.id));
  const yearNote = majority ? ` · <span class="pill missing" title="${TagcastI18n.html("trash.year.reason", {year: String(majority)})}">${TagcastI18n.html("trash.year.badge")}</span>` : "";
  return `<small class="trash-track-info">${trashYearLabel(track)}${yearNote} · ${trashUploadLabel(stamp)}${result ? ` · <span class="pill${result.choice === "keep" ? "" : " missing"}">${trashChoiceLabel(result.choice)}</span> ${reason}` : ""}</small>`;
}

// Every matching numbered title after the first one on its disc; review before sending.
function extraCopies(discs) {
  const ids = [];
  for (const d of discs) {
    const seen = new Set();
    for (const t of d.tracks) {
      const key = duplicateTrackKey(t);
      if (key && seen.has(key)) ids.push(String(t.id)); else seen.add(key);
    }
  }
  return ids;
}

function chosenTracks() {
  const chosen = albumView.trash || new Set();
  return albumDiscs().flatMap(d => d.tracks.filter(t => chosen.has(String(t.id))).map(t => ({disc: d, track: t})));
}

function showTrashReview() {
  const discs = albumDiscs(), rows = chosenTracks();
  if (!rows.length) return;
  const whole = rows.length === discs.reduce((n, d) => n + d.tracks.length, 0), several = discs.length > 1;
  const album = discs[0].name, count = rows.length;
  $("#trash-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${TagcastI18n.html("trash.review.eyebrow")}</div><h2>${whole ? TagcastI18n.html("trash.review.wholeAlbum", {album}) : TagcastI18n.html("trash.review.partOf", {count, album})}</h2></div><button class="close" data-close="trash-review" aria-label="${TagcastI18n.html("common.close")}">×</button></div>
    <div class="warn-box">${TagcastI18n.html("trash.review.warning")}${whole ? ` ${TagcastI18n.html("trash.review.albumGone")}` : ""}</div>
    <section class="diff-group"><h3>${TagcastI18n.html("common.count.tracks", {count})}</h3>${rows.map(({disc, track: t}) => `<p class="trash-row">${several ? `${TagcastI18n.html("common.disc", {disc: disc.disc || "?"})} · ` : ""}${t.track || "–"}. ${escapeHtml(t.title)} <span class="muted">· ${escapeHtml(t.artist)} · ${trackDuration(t.length)}${t.format ? ` · ${escapeHtml(t.format)}` : ""} · ${trashYearLabel(t)} · ${trashUploadLabel(trashUploadedAt(t))}</span></p>`).join("")}</section>
    <div class="dialog-footer"><span class="muted" id="trash-status"></span><button class="button" data-close="trash-review">${TagcastI18n.html("trash.review.keep")}</button><button class="button danger primary" id="trash-confirm">${trashIcon}${TagcastI18n.html("trash.review.move", {count})}</button></div>`;
  $("#trash-review").showModal();
}

async function moveToTrash() {
  const rows = chosenTracks();
  if (!rows.length || saving) return;
  const tracks = rows.map(({disc, track}) => ({id: String(track.id), album_id: String(disc.id), title: track.title}));
  const album = rows[0].disc, button = $("#trash-confirm");
  saving = true;  // one write at a time, like metadata saves
  button.disabled = true; button.textContent = TagcastI18n.text("trash.review.moving");
  setActionStatus("#trash-status", TagcastI18n.text("trash.review.checking"), true);
  try {
    const result = await api("/api/trash", {tracks});
    const albumOf = new Map(tracks.map(t => [t.id, t.album_id]));
    const entry = {scope: "album", trash: true, selection: [{id: album.id, name: album.name, artist: album.artist}],
      created: new Date().toISOString(), status: "sent", source: "ibroadcast", error: "",
      changes: result.results.map(r => ({kind: "track", id: r.id, albumId: albumOf.get(String(r.id)), label: r.label, status: r.status,
        fields: {trash: {before: "In your library", after: "In the trash"}}}))};
    state.history.unshift(entry);
    pendingAlbums = null;
    dropTracks(tracks.map(t => t.id));
    albumView.trash = null;
    $("#trash-review").close(); render();
    toast(TagcastI18n.text("trash.review.moved", {count: tracks.length}));
    followJob(result.job, entry);
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    button.disabled = false; button.textContent = TagcastI18n.text("common.tryAgain");
    $("#trash-status").innerHTML = `<span class="error-text">${escapeHtml(TagcastI18n.errorText(error))}</span>`;
    if (error.status === 409) { button.textContent = TagcastI18n.text("common.reloadLibrary"); button.onclick = () => { $("#trash-review").close(); loadLive(); }; }
  } finally { saving = false; setActionStatus("#trash-status", undefined); }
}

function startAlbumTrash() {
  if (!live() || state.loading || state.screen !== "album" || albumView.loading || saving || checking || !albumDiscs().length) return;
  albumView.trash = new Set(); renderAlbumView();
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-trash-start]")) { startAlbumTrash(); return; }
  if (!albumView.trash) return;
  if (event.target.closest("[data-trash-cancel]")) { albumView.trash = null; renderAlbumView(); return; }
  if (event.target.closest("[data-trash-all]")) {
    const all = albumDiscs().flatMap(d => d.tracks.map(t => String(t.id)));
    albumView.trash = new Set(albumView.trash.size === all.length ? [] : all); renderAlbumView(); return;
  }
  if (event.target.closest("[data-trash-duplicates]")) { albumView.trash = new Set(extraCopies(albumDiscs())); renderAlbumView(); return; }
  if (event.target.closest("[data-trash-suggested]")) {
    albumView.trash = new Set(trashSuggestion(albumDiscs()).remove); renderAlbumView();
    $("[data-trash-suggested]")?.focus(); return;
  }
  if (event.target.closest("[data-trash-other-years]")) {
    albumView.trash = new Set(trashYearAdvice(albumDiscs()).keys()); renderAlbumView();
    $("[data-trash-other-years]")?.focus(); return;
  }
  if (event.target.closest("[data-trash-review]")) { showTrashReview(); return; }
  const go = event.target.closest("#trash-confirm");
  if (go && !go.onclick) moveToTrash();
});
document.addEventListener("change", event => {
  if (!albumView.trash || !event.target.matches?.("[data-trash-track]")) return;
  if (event.target.checked) albumView.trash.add(event.target.dataset.trashTrack);
  else albumView.trash.delete(event.target.dataset.trashTrack);
  renderAlbumView();
});
