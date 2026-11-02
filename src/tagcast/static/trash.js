"use strict";

const selectedAlbumsTrash = {request: 0, details: null, groups: null, busy: false, stop: false, combine: false};

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
    if (size > 500) throw Error("One selected album has more than 500 tracks. Open that album and review smaller track selections.");
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
  $("#trash-content").innerHTML = '<div class="dialog-heading"><h2>Review selected albums</h2><button class="close" data-close="trash-review" aria-label="Close">×</button></div><p role="status" class="operation-status" data-working="true">Loading tracks of the selected albums…</p>';
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
      if (group.discs.some(d => !d || !d.tracks.length || d.artist !== group.artist)) throw Error("The selected albums changed. Reload the library and review again.");
    }
    selectedAlbumTrashBatches(groups);
    view.groups = structuredClone(groups);
    const count = groups.reduce((n, g) => n + g.discs.reduce((sum, d) => sum + d.tracks.length, 0), 0);
    $("#trash-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">REVIEW COMPLETE ALBUMS</div><h2>${groups.length} ${groups.length === 1 ? "album" : "albums"} · ${count} tracks</h2></div><button class="close" data-close="trash-review" aria-label="Close">×</button></div>
      <div class="warn-box">All tracks of these albums leave your active library in every iBroadcast app. They go to iBroadcast's trash and can be restored there. Tagcast cannot restore them. Your local files stay unchanged.</div>
      ${groups.map(g => `<details class="diff-group"><summary><strong>${escapeHtml(g.name)}</strong> · ${escapeHtml(g.artist)} · ${g.discs.reduce((n, d) => n + d.tracks.length, 0)} tracks</summary>${g.discs.map(d => `<h3>Disc ${d.disc || 1}</h3>${d.tracks.map(t => `<p class="trash-row">${t.track || "–"}. ${escapeHtml(t.title)} <span class="muted">· ${escapeHtml(t.artist)} · ${trackDuration(t.length)}${t.format ? ` · ${escapeHtml(t.format)}` : ""}</span></p>`).join("")}`).join("")}</details>`).join("")}
      <p class="muted">The full album contents are checked before each batch and read back afterwards. Processing stops on changed albums or unconfirmed results. Larger selections use batches of up to 20 albums / 500 tracks.</p>
      <p id="selected-trash-status" role="status"></p><div class="dialog-footer" id="selected-trash-footer"><button class="button" id="selected-trash-cancel" data-close="trash-review">Keep these albums</button><button class="button danger primary" id="selected-trash-confirm">Move ${groups.length} ${groups.length === 1 ? "album" : "albums"} to the trash</button></div>`;
    $("#selected-trash-cancel").focus();
  } catch (error) {
    if (request === view.request && details === state.details) $("#trash-content").innerHTML = `<div class="dialog-heading"><h2>Cannot prepare this selection</h2><button class="close" data-close="trash-review" aria-label="Close">×</button></div><p class="error-text" role="alert">${escapeHtml(error.message)}</p>`;
  }
}

async function trashSelectedAlbums() {
  const view = selectedAlbumsTrash, request = view.request;
  if (!view.groups || view.busy || saving || checking || !live() || view.details !== state.details) return;
  const batches = selectedAlbumTrashBatches(view.groups);
  const current = () => request === view.request && view.details === state.details && live();
  view.busy = true; view.stop = false; saving = true;
  $("#selected-trash-footer").innerHTML = '<button class="button" id="selected-trash-stop">Stop after current request</button>';
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
      setActionStatus("#selected-trash-status", `Checking and moving batch ${complete + 1} of ${batches.length}…`, true);
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
      setActionStatus("#selected-trash-status", `Verifying batch ${complete + 1} of ${batches.length} with iBroadcast…`, true);
      const job = await followJob(result.job, entry, null, current);
      if (!job || request !== view.request || !live()) break;
      view.details = state.details; // this batch's checked album index replaced the cache
      if (job.state !== "done" || entry.status !== "saved") throw Error("The result could not be fully confirmed. Later batches were not sent. Reload the library before reviewing another selection.");
      for (const group of groups) for (const id of group.ids) state.selected.delete(String(id));
      complete += 1; render();
    }
  } catch (error) { failure = error.message; }
  finally {
    view.busy = false; saving = false; updateChrome();
    if (request === view.request) {
      setActionStatus("#selected-trash-status", failure || (complete === batches.length ? "All selected albums confirmed in iBroadcast's trash." : `Stopped after ${complete} of ${batches.length} batches. Review the remaining selection again to continue.`));
      $("#selected-trash-footer").innerHTML = '<button class="button" data-close="trash-review">Close</button><button class="button" id="selected-trash-refresh">Reload library</button>';
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
  if (event.target.closest("#selected-trash-stop")) { selectedAlbumsTrash.stop = true; setActionStatus("#selected-trash-status", "Stopping after the current request is checked…", true); }
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
    if (request === view.request && details === state.details) $("#duplicate-cleanup-status").textContent = error.message;
  }
}

function duplicateCleanupSelection() {
  return (duplicateCleanupView.data?.selection || []).filter(t => !duplicateCleanupView.excluded.has(t.id));
}

function updateDuplicateCleanupSelection() {
  const view = duplicateCleanupView, selected = duplicateCleanupSelection();
  const count = $("#duplicate-cleanup-selected");
  if (count) count.textContent = `${selected.length.toLocaleString("en")} copies from ${new Set(selected.map(t => t.group)).size.toLocaleString("en")} albums selected`;
  const start = $("#duplicate-cleanup-start");
  if (start) start.disabled = view.busy || !view.approved || !selected.length;
}

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
  $("#duplicate-cleanup-content").innerHTML = `<p>Apply <strong>Select suggested copies</strong> across <strong>all albums in your library</strong>, regardless of the current search or page. Prefer FLAC over MP3, then the newest upload in the same format. Uncertain copies stay.</p>
    <p class="muted">This compares metadata, not audio. Differing titles need your comparison. Nothing moves until you review and approve the selection.</p>
    <button class="button" id="duplicate-cleanup-preview" ${running || view.busy ? "disabled" : ""}>Analyse all albums</button>
    ${data.id ? `<div class="notice">${data.scanned.toLocaleString("en")} duplicate albums analysed · ${data.tracks.toLocaleString("en")} copies suggested for the trash · ${data.manual.toLocaleString("en")} repeated ${data.manual === 1 ? "position needs" : "positions need"} manual comparison. Batches: up to ${data.batch_tracks} tracks / ${data.batch_albums} albums.</div>
    ${data.error ? `<p class="warn-box" role="status">${escapeHtml(data.error)}</p>` : ""}
    ${preview ? '<p>Compare the proposed copies and retained tracks below. Uncheck copies or whole albums to keep them. Albums without suggestions remain available for manual cleanup.</p>' : `<p role="status" class="operation-status" data-working="${running}"><strong>${escapeHtml(data.state)}</strong> · ${counts.confirmed || 0} confirmed · ${counts.pending || 0} pending · ${counts.sent || 0} sent / checking · ${counts.unconfirmed || 0} unconfirmed · ${counts.conflict || 0} conflicts · ${counts.excluded || 0} excluded</p>`}
    ${preview && data.tracks ? `<div class="cleanup-controls"><button class="text-action" id="duplicate-select-all" ${disabled}>Select all suggested copies</button><button class="text-action" id="duplicate-select-none" ${disabled}>Keep all copies</button><strong id="duplicate-cleanup-selected" role="status"></strong></div>` : ""}
    <div class="cleanup-albums">${data.groups.map(group => {
      const proposed = data.selection.filter(t => t.group === group.id), selected = proposed.filter(t => !view.excluded.has(t.id));
      return `<details class="cleanup-album" data-duplicate-group="${escapeHtml(group.id)}" ${view.expanded.has(group.id) ? "open" : ""}><summary><h3>${preview && proposed.length ? `<label><input type="checkbox" data-duplicate-album="${escapeHtml(group.id)}" ${selected.length ? "checked" : ""} ${disabled}> ` : ""}${escapeHtml(group.album)}${preview && proposed.length ? "</label>" : ""}</h3><p class="muted">${escapeHtml(group.artist)} · ${proposed.length} proposed ${proposed.length === 1 ? "copy" : "copies"}</p></summary>
        ${group.positions.map(position => `<div class="duplicate-position"><h4>Disc ${position.disc || 1} · Track ${position.number}</h4>${position.tracks.map(track => `<div class="duplicate-copy"><div>${preview && track.choice === "trash" ? `<label><input type="checkbox" data-duplicate-copy="${escapeHtml(track.id)}" ${view.excluded.has(track.id) ? "" : "checked"} ${disabled}> <strong>${escapeHtml(track.title)}</strong></label>` : `<strong>${escapeHtml(track.title)}</strong>`}<span class="pill ${track.choice === "trash" ? "missing" : ""}">${escapeHtml(preview ? {trash: "Suggested trash", keep: "Suggested keep", manual: "Compare manually"}[track.choice] : track.status === "retained" ? "Retained" : track.status)}</span></div><p class="muted">${escapeHtml(track.artist)} · ${trackDuration(track.length)}${track.format ? ` · ${escapeHtml(track.format)}` : " · Unknown format"} · ${track.uploaded_at ? `Uploaded ${escapeHtml(track.uploaded_at.replace("T", " "))}` : "Upload date unknown"}</p><p>${escapeHtml(track.reason)}</p></div>`).join("")}</div>`).join("")}</details>`;
    }).join("") || '<p class="muted">No repeated positions found.</p>'}</div>
    <div class="pagination"><button class="button small" data-duplicate-page="-10" ${view.offset <= 0 || view.busy ? "disabled" : ""}>← Previous</button><span>${data.albums ? Math.floor(view.offset / 10) + 1 : 0} / ${Math.ceil(data.albums / 10)}</span><button class="button small" data-duplicate-page="10" ${view.offset + 10 >= data.albums || view.busy ? "disabled" : ""}>Next →</button></div>
    <p class="muted">The draft and results are saved on this computer for this account. Closing this window leaves a running job active. Stop prevents further requests; confirmed changes remain. Refresh the album list afterwards to see updated counts. New analysis replaces this report.</p>
    ${!running && data.state !== "done" && data.tracks ? `<label class="checkline"><input id="duplicate-cleanup-approved" type="checkbox" ${view.approved ? "checked" : ""} ${disabled}> I compared the copies, including differing titles, and approve moving the selected copies to iBroadcast's trash.</label>` : ""}
    <div class="dialog-footer"><button class="button" id="duplicate-cleanup-export" ${disabled}>Export full report ↓</button>${running ? '<button class="button danger" id="duplicate-cleanup-stop">Stop after current request</button>' : data.state !== "done" && data.tracks ? `<button class="button danger" id="duplicate-cleanup-start" disabled>${preview ? "Move selected copies to trash" : "Check outstanding and continue"}</button>` : ""}${!running ? `<button class="button" id="duplicate-cleanup-refresh" ${disabled}>Refresh album list</button>` : ""}</div>` : '<p class="muted">Choose Analyse all albums to prepare a read-only preview using stored library metadata. It does not download audio.</p>'}`;
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
  if (action === "preview" && view.data?.id && !confirm("Replace the previous duplicate cleanup draft and report? Export it first to keep a copy.")) return;
  const details = state.details, request = ++view.request;
  const body = action === "preview" ? {} : {id: view.data.id, excluded: [...view.excluded], approved: view.approved};
  view.busy = true; view.approved = false; clearTimeout(view.timer); renderDuplicateCleanup();
  setActionStatus("#duplicate-cleanup-status", action === "preview" ? "Analysing stored album metadata…" : action === "start" ? "Checking the selection and starting…" : "Stopping after the current request…", true);
  try {
    const data = await api(`/api/duplicate-cleanup/${action}`, body);
    if (request !== view.request || details !== state.details || !live()) return;
    view.data = data; view.excluded = new Set(data.excluded || []); view.offset = 0;
    setActionStatus("#duplicate-cleanup-status", "");
    if (data.state === "running" && $("#duplicate-cleanup").open) view.timer = setTimeout(fetchDuplicateCleanup, 1500);
  } catch (error) {
    if (request === view.request && details === state.details) $("#duplicate-cleanup-status").textContent = error.message;
  } finally {
    if (request === view.request) { view.busy = false; setActionStatus("#duplicate-cleanup-status", undefined); renderDuplicateCleanup(); }
  }
}

$("#duplicate-cleanup-open").addEventListener("click", async () => {
  if (!live()) return;
  $("#duplicate-cleanup-content").innerHTML = '<p class="muted">Loading the saved report…</p>';
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
    } catch (error) { if (details === state.details && request === view.request) $("#duplicate-cleanup-status").textContent = error.message; }
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

function trashBar(discs) {
  const count = albumView.trash.size, all = discs.reduce((n, d) => n + d.tracks.length, 0);
  const suggestion = trashSuggestion(discs);
  return `<section class="trash-suggestion"><p><strong>Suggested copies</strong> · Prefer FLAC over MP3, then the newest upload in the same format. Different artists, clearly different durations, unknown formats or tied uploads may need a manual comparison. This compares metadata, not audio.</p>
    <p>${suggestion.remove.length ? `${suggestion.remove.length} ${suggestion.remove.length === 1 ? "copy suggested" : "copies suggested"} for the trash.` : "No clear preference between the repeated tracks."} Use a selection button or tick tracks, then review your choice before confirming.</p>
    ${uploadGroups(discs)}</section>
    <div class="selection-bar trash-bar"><strong>${count} of ${all} tracks selected for the trash</strong>${suggestion.remove.length ? '<button class="button small" data-trash-suggested>Select suggested copies</button>' : ""}${extraCopies(discs).length ? '<button class="button small" data-trash-duplicates title="Same track number and title; keeps the first copy regardless of format or upload date">Select extra copies</button>' : ""}<button class="button small" data-trash-all>${count === all ? "Select none" : "Select all"}</button><button class="button small" data-trash-cancel>Cancel</button><button class="button small primary" data-trash-review ${count ? "" : "disabled"}>Review →</button></div>`;
}

const trashCheck = t => `<input type="checkbox" class="trash-check" data-trash-track="${escapeHtml(t.id)}" aria-label="Select ${escapeHtml(t.title)} for the trash" ${albumView.trash.has(String(t.id)) ? "checked" : ""}>`;

function trashUploadedAt(track) {
  const value = String(track.uploaded_at || track.uploaded_on || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(value)) return "";
  const date = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return "";
  if (value.length === 19 && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return value.slice(0, 10);
  return value;
}

function trashSuggestion(discs) {
  const choices = new Map(), remove = [];
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      const key = duplicateTrackPosition(track);
      if (key) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(track); }
    }
    for (const tracks of groups.values()) {
      if (tracks.length < 2) continue;
      const manual = reason => tracks.forEach(t => choices.set(String(t.id), {choice: "manual", reason}));
      const artists = new Set(tracks.map(t => String(t.artist || "").trim().toLocaleLowerCase()).filter(Boolean));
      const lengths = tracks.map(t => Number(t.length)).filter(n => n > 0);
      const titles = new Set(tracks.map(t => titleKey(t.title)));
      if (artists.size > 1) { manual("Different track artists; compare manually."); continue; }
      if (lengths.length && Math.max(...lengths) - Math.min(...lengths) > 2) {
        manual("Durations differ by more than two seconds; compare versions."); continue;
      }
      if (titles.size > 1 && (lengths.length !== tracks.length || artists.size !== 1)) {
        manual("Different titles and incomplete comparison metadata."); continue;
      }
      const formats = new Set(tracks.map(t => t.format || ""));
      if (formats.has("") || formats.size > 1 && [...formats].some(f => !["FLAC", "MP3"].includes(f))) {
        manual("Unknown or incomparable file formats."); continue;
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
        let reason = preferred ? keep.length > 1 ? "No unique newest copy; compare these copies." : flac ? "Preferred FLAC copy." : "Newest upload in this format."
          : flac && track.format === "MP3" ? "FLAC copy available." : "Older upload in this format.";
        if (titles.size > 1) reason += " Titles differ; compare versions before confirming.";
        const choice = preferred ? keep.length > 1 ? "manual" : "keep" : "trash";
        choices.set(id, {choice, reason});
        if (!preferred) remove.push(id);
      }
    }
  }
  return {choices, remove};
}

function uploadGroups(discs) {
  const open = $("#album-page .trash-upload-groups")?.open;
  const rows = [];
  for (const disc of discs) {
    const groups = new Map();
    for (const track of disc.tracks) {
      const date = trashUploadedAt(track).slice(0, 10), format = track.format || "Unknown format";
      const key = JSON.stringify([track.album_id || disc.id, date, format]);
      if (!groups.has(key)) groups.set(key, {date, format, tracks: []});
      groups.get(key).tracks.push(track);
    }
    for (const group of [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || a.format.localeCompare(b.format))) {
      const positions = [...new Set(group.tracks.map(duplicateTrackNumber).filter(Boolean))].sort((a, b) => a - b);
      rows.push(`<tr>${discs.length > 1 ? `<td>${disc.disc || "?"}</td>` : ""}<td>${group.date || "Unknown date"}</td><td>${escapeHtml(group.format)}</td><td>${group.tracks.length}</td><td>${positions.join(", ") || "Unknown"}</td></tr>`);
    }
  }
  return `<details class="trash-upload-groups"${open ? " open" : ""}><summary>Upload dates and formats</summary><p class="muted">Grouped by stored upload date and file format, per disc. Uploads on the same day can share a row.</p><table><thead><tr>${discs.length > 1 ? "<th>Disc</th>" : ""}<th>Uploaded</th><th>Format</th><th>Tracks</th><th>Track numbers</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`;
}

function trashTrackNote(track, suggestion) {
  const stamp = trashUploadedAt(track), result = suggestion.choices.get(String(track.id));
  const label = {keep: "Suggested keep", trash: "Suggested trash", manual: "Compare manually"};
  return `<small class="trash-track-info">Uploaded ${escapeHtml(stamp.replace("T", " ") || "date unknown")}${result ? ` · <span class="pill${result.choice === "keep" ? "" : " missing"}">${label[result.choice]}</span> ${escapeHtml(result.reason)}` : ""}</small>`;
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
  const noun = `${rows.length} ${rows.length === 1 ? "track" : "tracks"}`;
  $("#trash-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">MOVE TO THE TRASH</div><h2>${whole ? `${escapeHtml(discs[0].name)}: the whole album` : `${noun} of ${escapeHtml(discs[0].name)}`}</h2></div><button class="close" data-close="trash-review" aria-label="Close">×</button></div>
    <div class="warn-box">These tracks leave your library, in Tagcast and in every iBroadcast app. iBroadcast keeps them in its trash; Tagcast can't take them back out.${whole ? " Without tracks, the album disappears too." : ""}</div>
    <section class="diff-group"><h3>${noun}</h3>${rows.map(({disc, track: t}) => `<p class="trash-row">${several ? `Disc ${disc.disc || "?"} · ` : ""}${t.track || "–"}. ${escapeHtml(t.title)} <span class="muted">· ${escapeHtml(t.artist)} · ${trackDuration(t.length)}${t.format ? ` · ${escapeHtml(t.format)}` : ""} · Uploaded ${escapeHtml(trashUploadedAt(t).replace("T", " ") || "date unknown")}</span></p>`).join("")}</section>
    <div class="dialog-footer"><span class="muted" id="trash-status"></span><button class="button" data-close="trash-review">Keep them</button><button class="button danger primary" id="trash-confirm">${trashIcon}Move ${noun} to the trash</button></div>`;
  $("#trash-review").showModal();
}

async function moveToTrash() {
  const rows = chosenTracks();
  if (!rows.length || saving) return;
  const tracks = rows.map(({disc, track}) => ({id: String(track.id), album_id: String(disc.id), title: track.title}));
  const album = rows[0].disc, button = $("#trash-confirm");
  saving = true;  // one write at a time, like metadata saves
  button.disabled = true; button.textContent = "Moving…";
  setActionStatus("#trash-status", "Checking iBroadcast…", true);
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
    toast(`${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} moved to the trash. Checking the result with iBroadcast in the background…`);
    followJob(result.job, entry);
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    button.disabled = false; button.textContent = "Try again";
    $("#trash-status").innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
    if (error.status === 409) { button.textContent = "Reload library"; button.onclick = () => { $("#trash-review").close(); loadLive(); }; }
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
