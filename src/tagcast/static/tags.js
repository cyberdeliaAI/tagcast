"use strict";

// Native tags are independent of genres, metadata drafts and playback.
const tagDraft = {request: 0, listRequest: 0, details: null, session: "", busy: false,
  selection: null, target: null, origin: null, rows: [], changes: new Map(), body: null,
  query: "", offset: 0, total: 0, action: "change", tag: null, focus: null, scroll: 0, restore: true};
let tagSearchTimer;

function resetTags() {
  tagDraft.request += 1; tagDraft.listRequest += 1; clearTimeout(tagSearchTimer);
  tagDraft.restore = false;
  tagDraft.body = null; tagDraft.selection = null; tagDraft.changes.clear();
  if ($("#tag-dialog").open) $("#tag-dialog").close();
}

function tagCurrent(request) {
  return request === tagDraft.request && tagDraft.details === state.details
    && tagDraft.session === state.connection.playback_session && live();
}

function tagLinks(tags) {
  return (tags || []).map(t => `<button type="button" class="tag-chip" data-browse-kind="tags" data-browse-key="${escapeHtml(t.id)}" data-browse-label="${escapeHtml(t.name)}">${escapeHtml(t.name)}${t.archived ? " · archived" : ""}</button>`).join("");
}

function albumTagPanel(album) {
  if (!live()) return "";
  const tags = new Map();
  for (const track of album.tracks) for (const tag of track.tags || []) {
    const row = tags.get(tag.id) || {...tag, count: 0}; row.count += 1; tags.set(tag.id, row);
  }
  const empty = album.tags_loaded === false ? "Open Manage tags to load labels" : "No tags assigned";
  return `<section class="album-tags" aria-label="Album tags"><strong>Tags</strong><div class="tag-chips">${[...tags.values()].map(t => `<span>${tagLinks([t])}${t.count < album.tracks.length ? `<small class="muted"> ${t.count}/${album.tracks.length} tracks</small>` : ""}</span>`).join("") || `<span class="muted">${empty}</span>`}</div><button type="button" class="button small" data-album-tags="${escapeHtml(album.id)}">Manage tags…</button></section>`;
}

function trackTagControls(album, track) {
  if (!live()) return "";
  return `<small class="track-tags">${tagLinks(track.tags)}<button type="button" class="text-action" data-track-tags="${escapeHtml(track.id)}" data-tag-album="${escapeHtml(album.id)}" aria-label="Manage tags for ${escapeHtml(track.title)}">Tags…</button></small>`;
}

function beginTagDialog(action, origin = null) {
  const view = tagDraft;
  view.request += 1; view.listRequest += 1; clearTimeout(tagSearchTimer);
  Object.assign(view, {details: state.details, session: state.connection.playback_session, action,
    target: null, selection: null, origin, tag: null, body: null, rows: [], changes: new Map(), query: "", offset: 0, total: 0, restore: true});
  if (!$("#tag-dialog").open) {
    view.focus = document.activeElement; view.scroll = window.scrollY || 0;
    $("#tag-dialog").showModal();
  }
  $("#tag-dialog-content").innerHTML = '<p role="status">Loading tags…</p>';
  return view.request;
}

async function openTrackTags(albumId, trackId = null, query = "") {
  if (!live() || saving || checking || tagDraft.busy) return;
  const request = beginTagDialog("change"), target = {albums: shelfIds(albumId), track: trackId};
  tagDraft.target = target; tagDraft.query = query;
  try {
    const params = new URLSearchParams({albums: target.albums.join(",")});
    if (trackId !== null) params.set("track", trackId);
    const selection = await api(`/api/tags/selection?${params}`);
    if (!tagCurrent(request) || !$("#tag-dialog").open) return;
    tagDraft.selection = selection;
    renderTagSelection();
    await loadTagChoices();
  } catch (error) { if (tagCurrent(request)) tagError(error.message); }
}

function renderTagSelection() {
  const view = tagDraft, selection = view.selection;
  $("#tag-dialog-content").innerHTML = `<h3>${escapeHtml(selection.label)}</h3><p class="muted">${selection.tracks} ${selection.tracks === 1 ? "track" : "tracks"}. Tags are your own labels, separate from genres. Keep as is preserves partial assignments.</p>
    <div class="toolbar"><label class="search"><span>⌕</span><input id="tag-search" maxlength="200" aria-label="Search tags" placeholder="Search tags" value="${escapeHtml(view.query)}"></label><button type="button" class="button small" id="tag-new">New tag…</button></div>
    <div id="tag-choices"></div><div class="pagination" id="tag-pagination"></div><p class="muted" id="tag-change-count"></p><div class="dialog-footer"><button class="button" data-close="tag-dialog">Cancel</button><button class="button primary" id="tag-review" disabled>Review tag changes →</button></div>`;
  $("#tag-search").focus();
}

async function loadTagChoices() {
  const view = tagDraft, request = view.request, listRequest = ++view.listRequest;
  $("#tag-choices").innerHTML = '<p role="status">Loading tags…</p>';
  try {
    const data = await api(`/api/tags?${new URLSearchParams({q: view.query, offset: String(view.offset)})}`);
    if (!tagCurrent(request) || listRequest !== view.listRequest || !view.selection || !$("#tag-dialog").open) return;
    view.rows = data.tags; view.total = data.total; view.offset = data.offset;
    renderTagChoices();
  } catch (error) { if (tagCurrent(request) && listRequest === view.listRequest) tagError(error.message); }
}

function renderTagChoices() {
  const view = tagDraft, attached = new Map(view.selection.tags.map(t => [t.id, t]));
  const rows = new Map([...view.selection.tags.filter(t => foldText(t.name).includes(foldText(view.query))), ...view.rows].map(t => [t.id, t]));
  $("#tag-choices").innerHTML = [...rows.values()].map(tag => {
    const count = attached.get(tag.id)?.selected || 0, change = view.changes.get(tag.id)?.action || "";
    return `<label class="tag-choice"><span><strong>${escapeHtml(tag.name)}</strong><small>${count ? `${count} of ${view.selection.tracks} tracks` : "Not assigned"}${tag.archived ? " · Archived in iBroadcast" : ""}</small></span><select data-tag-change="${escapeHtml(tag.id)}" aria-label="Tag action for ${escapeHtml(tag.name)}"><option value="" ${!change ? "selected" : ""}>Keep as is</option>${!tag.archived ? `<option value="add" ${change === "add" ? "selected" : ""}>Add to ${view.selection.tracks === 1 ? "track" : "all tracks"}</option>` : ""}${count ? `<option value="remove" ${change === "remove" ? "selected" : ""}>Remove from ${view.selection.tracks === 1 ? "track" : "all tracks"}</option>` : ""}</select></label>`;
  }).join("") || '<p class="empty">No tags found. Use New tag to create an empty label, then assign it here.</p>';
  $("#tag-change-count").textContent = `${view.changes.size} tag changes selected across this search and all pages`;
  $("#tag-review").disabled = !view.changes.size;
  $("#tag-new").disabled = Boolean(view.changes.size);
  $("#tag-pagination").innerHTML = view.total > 50 ? `<button class="button small" data-tag-page="-50" ${view.offset ? "" : "disabled"}>← Previous</button><span>${Math.floor(view.offset / 50) + 1} / ${Math.ceil(view.total / 50)}</span><button class="button small" data-tag-page="50" ${view.offset + 50 >= view.total ? "disabled" : ""}>Next →</button>` : "";
}

async function openTagAction(action, id = null, origin = null) {
  if (!live() || saving || checking || tagDraft.busy) return;
  const request = beginTagDialog(action, origin);
  try {
    const tag = id === null ? null : await api(`/api/tags?id=${encodeURIComponent(id)}`);
    if (!tagCurrent(request) || !$("#tag-dialog").open) return;
    tagDraft.tag = tag;
    renderTagAction();
  } catch (error) { if (tagCurrent(request)) tagError(error.message); }
}

function renderTagAction(name = null) {
  const {action, tag} = tagDraft;
  const title = action === "create" ? "Create an empty tag" : action === "rename" ? "Rename tag" : "Delete tag";
  $("#tag-dialog-content").innerHTML = `<h3>${title}</h3>${tag ? `<p>${escapeHtml(tag.name)} · ${tag.total_tracks} tagged tracks${tag.archived ? " · Archived" : ""}</p>` : ""}
    ${action === "delete" ? '<div class="warn-box">Delete this label and its assignments throughout iBroadcast, including hidden or trashed tracks. Your music is kept. This cannot be undone in Tagcast.</div>' : `<label class="field wide"><span>Tag name</span><input id="tag-name" maxlength="200" value="${escapeHtml(name ?? tag?.name ?? "")}" placeholder="For example: Listen later"></label>`}
    ${action === "create" ? '<p class="muted">Creates an empty label. Assign it to an album or track afterwards.</p>' : ""}<div class="dialog-footer"><button class="button" data-close="tag-dialog">Cancel</button><button class="button primary" id="tag-review">Review →</button></div>`;
  (action === "delete" ? $("#tag-review") : $("#tag-name")).focus();
}

function reviewTags() {
  const view = tagDraft;
  if (!tagCurrent(view.request) || view.busy) return;
  let descriptions;
  if (view.action === "change") {
    if (!view.changes.size || view.changes.size > 20) { toast("Choose 1–20 tag changes at a time."); return; }
    view.body = {action: "change", target: view.target, before: view.selection.before,
      changes: [...view.changes.values()].map(c => ({id: c.tag.id, before: c.tag.before, action: c.action}))};
    const scope = view.target.track ? `track “${view.selection.label}”` : `${view.selection.tracks} tracks of “${view.selection.label}”`;
    descriptions = [...view.changes.values()].map(c => `${c.action === "add" ? "Add" : "Remove"} “${c.tag.name}” ${c.action === "add" ? "on" : "from"} ${scope}`);
  } else {
    const name = view.action === "delete" ? "" : $("#tag-name").value.trim();
    if (view.action !== "delete" && (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name))) { toast("Enter a tag name of 1–200 characters."); return; }
    view.body = {action: view.action, name, ...(view.tag ? {id: view.tag.id, before: view.tag.before} : {})};
    descriptions = [view.action === "create" ? `Create empty tag “${name}”` : view.action === "rename" ? `Rename “${view.tag.name}” to “${name}” for all ${view.tag.total_tracks} tagged tracks` : `Delete label “${view.tag.name}” and all its ${view.tag.total_tracks} assignments. The music is kept.`];
  }
  $("#tag-dialog-content").innerHTML = `<h3>Review tag changes</h3><ul>${descriptions.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>${view.action === "delete" ? '<div class="warn-box">This deletes the label and all its assignments throughout iBroadcast. Your music is kept. There is no Undo in Tagcast.</div>' : ""}<p class="muted">These changes sync to iBroadcast. Genres, audio files and playback stay unchanged.</p><div class="dialog-footer"><button class="button" data-close="tag-dialog">Cancel</button><button class="button" id="tag-back">Keep editing</button><button class="button ${view.action === "delete" ? "danger" : "primary"}" id="tag-confirm">${view.action === "delete" ? "Delete this tag" : "Save tag changes"}</button></div>`;
  $("#tag-back").focus();
}

function tagError(message) {
  tagDraft.body = null;
  $("#tag-dialog-content").innerHTML = `<p class="error-box" role="alert">${escapeHtml(message)}</p><p class="muted">No automatic retry. Close and reload Tags to check the result before preparing another review.</p><div class="dialog-footer"><button class="button" data-close="tag-dialog">Close</button></div>`;
}

async function saveTags() {
  const view = tagDraft, request = view.request;
  if (!view.body || view.busy || saving || checking || !tagCurrent(request)) return;
  const body = view.body; view.body = null; view.busy = true; saving = true;
  $("#tag-dialog-close").disabled = true;
  $("#tag-dialog-content").innerHTML = '<p role="status">Saving tags and checking iBroadcast…</p>';
  try {
    const response = await api("/api/tags/save", {...body, approved: true});
    if (!tagCurrent(request)) return;
    const job = await collectionJob(response, () => tagCurrent(request));
    if (!tagCurrent(request)) return;
    // Names and assignments can affect every loaded album. Invalidate only metadata;
    // queued tracks keep their own album information and the same audio element.
    state.details = new Map(); view.details = state.details;
    resetBrowse();
    if (body.action === "delete" && state.screen === "browse" && browseView.kind === "tags" && browseView.key === body.id) showBrowse("tags");
    else if (state.screen === "browse") renderBrowse();
    if (state.screen === "album") openAlbum(albumView.id);
    const success = !response.error && Array.isArray(job.results) && job.results.length >= response.sent
      && job.results.every(r => r.status === "saved");
    if (!success) throw Error(response.error || "Some tag changes could not be confirmed. Reload Tags before trying again.");
    $("#tag-dialog-content").innerHTML = `<p role="status">Tag changes saved and confirmed in iBroadcast.</p>${view.origin ? '<p class="muted">The new tag is empty. Return to the album or track to assign it.</p>' : ""}<div class="dialog-footer"><button class="button" id="tag-done" data-close="tag-dialog">Done</button>${view.origin ? '<button class="button primary" id="tag-return">Return to album tags</button>' : ""}</div>`;
    $("#tag-done").focus();
  } catch (error) { if (tagCurrent(request)) tagError(error.message); }
  finally { view.busy = false; saving = false; $("#tag-dialog-close").disabled = false; updateChrome(); }
}

$("#tag-dialog").addEventListener("cancel", event => { if (tagDraft.busy) event.preventDefault(); });
$("#tag-dialog").addEventListener("close", () => {
  tagDraft.request += 1; tagDraft.listRequest += 1; tagDraft.body = null; clearTimeout(tagSearchTimer);
  if (!tagDraft.restore) return;
  (tagDraft.focus?.isConnected ? tagDraft.focus : $("#help-button")).focus();
  window.scrollTo?.({top: tagDraft.scroll});
});
document.addEventListener("change", event => {
  if (!event.target.matches?.("[data-tag-change]") || tagDraft.busy) return;
  const id = event.target.dataset.tagChange, action = event.target.value;
  const tag = tagDraft.rows.find(t => t.id === id) || tagDraft.selection?.tags.find(t => t.id === id);
  if (!tag) return;
  if (action) tagDraft.changes.set(id, {tag, action}); else tagDraft.changes.delete(id);
  renderTagChoices();
});
document.addEventListener("input", event => {
  if (event.target.id !== "tag-search") return;
  clearTimeout(tagSearchTimer); tagDraft.listRequest += 1;
  tagDraft.query = event.target.value; tagDraft.offset = 0;
  tagSearchTimer = setTimeout(loadTagChoices, 250);
});
document.addEventListener("click", event => {
  const album = event.target.closest("[data-album-tags]"), track = event.target.closest("[data-track-tags]");
  if (album) return openTrackTags(album.dataset.albumTags);
  if (track) return openTrackTags(track.dataset.tagAlbum, track.dataset.trackTags);
  if (event.target.closest("#browse-tag-new")) return openTagAction("create");
  if (event.target.closest("#browse-tag-rename")) return openTagAction("rename", browseView.key);
  if (event.target.closest("#browse-tag-delete")) return openTagAction("delete", browseView.key);
  if (event.target.closest("#tag-review")) return reviewTags();
  if (event.target.closest("#tag-confirm")) return saveTags();
  if (event.target.closest("#tag-new")) return openTagAction("create", null, tagDraft.target);
  if (event.target.closest("#tag-return")) return openTrackTags(tagDraft.origin.albums[0], tagDraft.origin.track);
  if (event.target.closest("#tag-back")) {
    if (tagDraft.action === "change") { tagDraft.body = null; renderTagSelection(); renderTagChoices(); }
    else { const name = tagDraft.body?.name; tagDraft.body = null; renderTagAction(name); }
  }
  const page = event.target.closest("[data-tag-page]");
  if (page) { tagDraft.offset = Math.max(0, tagDraft.offset + Number(page.dataset.tagPage)); return loadTagChoices(); }
});
