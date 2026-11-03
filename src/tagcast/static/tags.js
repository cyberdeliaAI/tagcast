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
  return (tags || []).map(t => `<button type="button" class="tag-chip" data-browse-kind="tags" data-browse-key="${escapeHtml(t.id)}" data-browse-label="${escapeHtml(t.name)}">${escapeHtml(t.name)}${t.archived ? ` · ${TagcastI18n.html("tags.chip.archived")}` : ""}</button>`).join("");
}

function albumTagChips(album) {
  if (!live()) return "";
  const tags = new Map();
  for (const track of album.tracks) for (const tag of track.tags || []) {
    const row = tags.get(tag.id) || {...tag, count: 0}; row.count += 1; tags.set(tag.id, row);
  }
  return [...tags.values()].map(tag => `<span class="album-tag-chip">${tagLinks([tag])}${tag.count < album.tracks.length ? `<small class="muted" title="${TagcastI18n.html("tags.album.assignedTitle", {assigned: tag.count, count: album.tracks.length})}">${TagcastI18n.html("tags.album.assigned", {assigned: tag.count, count: album.tracks.length})}</small>` : ""}</span>`).join("")
    + `<button type="button" class="album-tag-add" data-album-tags="${escapeHtml(album.id)}" aria-label="${TagcastI18n.html("tags.album.manage")}" ${album.tags_loaded === false ? `title="${TagcastI18n.html("tags.album.load")}"` : ""}>${TagcastI18n.html("tags.album.add")}</button>`;
}

function trackTagControls(album, track) {
  if (!live()) return "";
  return `<button type="button" class="track-tag-action" data-track-tags="${escapeHtml(track.id)}" data-tag-album="${escapeHtml(album.id)}" aria-label="${TagcastI18n.html("tags.track.manage", {title: track.title})}" title="${TagcastI18n.html("tags.track.manageTitle")}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m10 3-4 18M18 3l-4 18M3 9h18M2 15h18"/></svg></button>`;
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
  $("#tag-dialog-content").innerHTML = `<p role="status" class="operation-status" data-working="true">${TagcastI18n.html("tags.dialog.loading")}</p>`;
  return view.request;
}

function updateSelectedAlbumTagControls() {
  $("#tag-selection").hidden = !live();
  $("#tag-selection").disabled = saving || checking > 0 || tagDraft.busy || !state.selected.size;
}

async function openSelectedAlbumTags() {
  if (!live() || saving || checking || tagDraft.busy) return;
  const groups = albumShelf().filter(a => itemIds(a).some(id => state.selected.has(id)));
  if (!groups.length) return;
  if (groups.some(a => !isSelected(a))) { toast(TagcastI18n.text("tags.selection.incomplete")); return; }
  if (groups.length > 20 || groups.flatMap(itemIds).length > 100) { toast(TagcastI18n.text("tags.selection.tooMany")); return; }
  return openTagSelection({albums: groups.flatMap(itemIds), track: null, multiple: true});
}

async function openTrackTags(albumId, trackId = null, query = "") {
  return openTagSelection({albums: shelfIds(albumId), track: trackId}, query);
}

async function openTagSelection(target, query = "") {
  if (!live() || saving || checking || tagDraft.busy) return;
  const request = beginTagDialog("change");
  tagDraft.target = structuredClone(target); tagDraft.query = query;
  try {
    const params = new URLSearchParams({albums: target.albums.join(",")});
    if (target.track !== null) params.set("track", target.track);
    if (target.multiple) params.set("multiple", "1");
    const selection = await api(`/api/tags/selection?${params}`);
    if (!tagCurrent(request) || !$("#tag-dialog").open) return;
    tagDraft.selection = selection;
    renderTagSelection();
    await loadTagChoices();
  } catch (error) { if (tagCurrent(request)) tagError(TagcastI18n.errorText(error)); }
}

function tagAlbumSummary() {
  if (!tagDraft.target?.multiple || !tagDraft.selection?.albums) return "";
  return `<ul class="tag-album-summary">${tagDraft.selection.albums.map(album => `<li><strong>${escapeHtml(album.name)}</strong> · ${escapeHtml(album.artist)} · ${TagcastI18n.html("common.count.tracks", {count: album.tracks})}${album.ids.length > 1 ? ` · ${TagcastI18n.html("tags.selection.discs", {count: album.ids.length})}` : ""}</li>`).join("")}</ul>`;
}

// The server labels a multi-album selection in English ("2 selected albums"); show the same
// count in the interface language. Album and track names are data and stay as they are.
function tagSelectionLabel(selection = tagDraft.selection) {
  return tagDraft.target?.multiple && Array.isArray(selection?.albums)
    ? TagcastI18n.text("tags.selection.albums", {count: selection.albums.length}) : selection.label;
}

function renderTagSelection() {
  const view = tagDraft, selection = view.selection;
  $("#tag-dialog-content").innerHTML = `<h3>${escapeHtml(tagSelectionLabel(selection))}</h3>${tagAlbumSummary()}<p class="muted">${TagcastI18n.html("tags.selection.intro", {count: selection.tracks})}</p>
    <div class="toolbar"><div class="search search-with-clear"><span aria-hidden="true">⌕</span><input id="tag-search" maxlength="200" aria-label="${TagcastI18n.html("tags.selection.search")}" placeholder="${TagcastI18n.html("tags.selection.search")}" value="${escapeHtml(view.query)}">${searchClearButton("tag-search", view.query)}</div><button type="button" class="button small" id="tag-new">${TagcastI18n.html("tags.selection.new")}</button></div>
    <div id="tag-choices"></div><div class="pagination" id="tag-pagination"></div><p class="muted" id="tag-change-count"></p><div class="dialog-footer"><button class="button" data-close="tag-dialog">${TagcastI18n.html("common.cancel")}</button><button class="button primary" id="tag-review" disabled>${TagcastI18n.html("tags.selection.review")}</button></div>`;
  $("#tag-search").focus();
}

async function loadTagChoices() {
  const view = tagDraft, request = view.request, listRequest = ++view.listRequest;
  $("#tag-choices").innerHTML = `<p role="status" class="operation-status" data-working="true">${TagcastI18n.html("tags.dialog.loading")}</p>`;
  try {
    const data = await api(`/api/tags?${new URLSearchParams({q: view.query, offset: String(view.offset)})}`);
    if (!tagCurrent(request) || listRequest !== view.listRequest || !view.selection || !$("#tag-dialog").open) return;
    view.rows = data.tags; view.total = data.total; view.offset = data.offset;
    renderTagChoices();
  } catch (error) { if (tagCurrent(request) && listRequest === view.listRequest) tagError(TagcastI18n.errorText(error)); }
}

function renderTagChoices() {
  const view = tagDraft, attached = new Map(view.selection.tags.map(t => [t.id, t]));
  const rows = new Map([...view.selection.tags.filter(t => foldText(t.name).includes(foldText(view.query))), ...view.rows].map(t => [t.id, t]));
  $("#tag-choices").innerHTML = [...rows.values()].map(tag => {
    const count = attached.get(tag.id)?.selected || 0, change = view.changes.get(tag.id)?.action || "";
    return `<label class="tag-choice"><span><strong>${escapeHtml(tag.name)}</strong><small>${count ? TagcastI18n.html("tags.choice.assigned", {assigned: count, count: view.selection.tracks}) : TagcastI18n.html("tags.choice.notAssigned")}${tag.archived ? ` · ${TagcastI18n.html("tags.choice.archived")}` : ""}</small></span><select data-tag-change="${escapeHtml(tag.id)}" aria-label="${TagcastI18n.html("tags.choice.action", {tag: tag.name})}"><option value="" ${!change ? "selected" : ""}>${TagcastI18n.html("tags.choice.keep")}</option>${!tag.archived ? `<option value="add" ${change === "add" ? "selected" : ""}>${TagcastI18n.html("tags.choice.add", {count: view.selection.tracks})}</option>` : ""}${count ? `<option value="remove" ${change === "remove" ? "selected" : ""}>${TagcastI18n.html("tags.choice.remove", {count: view.selection.tracks})}</option>` : ""}</select></label>`;
  }).join("") || `<p class="empty">${TagcastI18n.html("tags.choice.empty")}</p>`;
  renderTagChangeCount();
  $("#tag-review").disabled = !view.changes.size;
  $("#tag-new").disabled = Boolean(view.changes.size);
  $("#tag-pagination").innerHTML = view.total > 50 ? `<button class="button small" data-tag-page="-50" ${view.offset ? "" : "disabled"}>${TagcastI18n.html("common.pagination.previous")}</button><span>${Math.floor(view.offset / 50) + 1} / ${Math.ceil(view.total / 50)}</span><button class="button small" data-tag-page="50" ${view.offset + 50 >= view.total ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button>` : "";
}

function renderTagChangeCount() {
  $("#tag-change-count").textContent = TagcastI18n.text("tags.choice.changes", {count: tagDraft.changes.size});
}

async function openTagAction(action, id = null, origin = null) {
  if (!live() || saving || checking || tagDraft.busy) return;
  const request = beginTagDialog(action, origin);
  try {
    const tag = id === null ? null : await api(`/api/tags?id=${encodeURIComponent(id)}`);
    if (!tagCurrent(request) || !$("#tag-dialog").open) return;
    tagDraft.tag = tag;
    renderTagAction();
  } catch (error) { if (tagCurrent(request)) tagError(TagcastI18n.errorText(error)); }
}

function renderTagAction(name = null) {
  const {action, tag} = tagDraft;
  const title = action === "create" ? "tags.action.create" : action === "rename" ? "tags.action.rename" : "tags.action.delete";
  $("#tag-dialog-content").innerHTML = `<h3>${TagcastI18n.html(title)}</h3>${tag ? `<p>${escapeHtml(tag.name)} · ${TagcastI18n.html("tags.action.tagged", {count: tag.total_tracks})}${tag.archived ? ` · ${TagcastI18n.html("tags.action.archived")}` : ""}</p>` : ""}
    ${action === "delete" ? `<div class="warn-box">${TagcastI18n.html("tags.action.deleteWarning")}</div>` : `<label class="field wide"><span>${TagcastI18n.html("tags.action.name")}</span><input id="tag-name" maxlength="200" value="${escapeHtml(name ?? tag?.name ?? "")}" placeholder="${TagcastI18n.html("tags.action.placeholder")}"></label>`}
    ${action === "create" ? `<p class="muted">${TagcastI18n.html("tags.action.createNote")}</p>` : ""}<div class="dialog-footer"><button class="button" data-close="tag-dialog">${TagcastI18n.html("common.cancel")}</button><button class="button primary" id="tag-review">${TagcastI18n.html("tags.action.review")}</button></div>`;
  (action === "delete" ? $("#tag-review") : $("#tag-name")).focus();
}

function reviewTags() {
  const view = tagDraft;
  if (!tagCurrent(view.request) || view.busy) return;
  let descriptions;
  if (view.action === "change") {
    if (!view.changes.size || view.changes.size > 20) { toast(TagcastI18n.text("tags.review.limit")); return; }
    view.body = {action: "change", target: view.target, before: view.selection.before,
      changes: [...view.changes.values()].map(c => ({id: c.tag.id, before: c.tag.before, action: c.action}))};
    const {selection, target} = view;
    descriptions = [...view.changes.values()].map(c => {
      const add = c.action === "add";
      if (target.multiple) return TagcastI18n.text(add ? "tags.review.addAlbums" : "tags.review.removeAlbums", {tag: c.tag.name, count: selection.tracks, albums: tagSelectionLabel(selection)});
      if (target.track) return TagcastI18n.text(add ? "tags.review.addTrack" : "tags.review.removeTrack", {tag: c.tag.name, title: selection.label});
      return TagcastI18n.text(add ? "tags.review.addAlbum" : "tags.review.removeAlbum", {tag: c.tag.name, count: selection.tracks, album: selection.label});
    });
  } else {
    const name = view.action === "delete" ? "" : $("#tag-name").value.trim();
    if (view.action !== "delete" && (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name))) { toast(TagcastI18n.text("tags.review.nameInvalid")); return; }
    view.body = {action: view.action, name, ...(view.tag ? {id: view.tag.id, before: view.tag.before} : {})};
    descriptions = [view.action === "create" ? TagcastI18n.text("tags.review.create", {name})
      : view.action === "rename" ? TagcastI18n.text("tags.review.rename", {tag: view.tag.name, name, count: view.tag.total_tracks})
        : TagcastI18n.text("tags.review.delete", {tag: view.tag.name, count: view.tag.total_tracks})];
  }
  const remove = view.action === "delete";
  $("#tag-dialog-content").innerHTML = `<h3>${TagcastI18n.html("tags.review.heading")}</h3>${tagAlbumSummary()}<ul>${descriptions.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>${remove ? `<div class="warn-box">${TagcastI18n.html("tags.review.deleteWarning")}</div>` : ""}<p class="muted">${TagcastI18n.html("tags.review.sync")}</p><div class="dialog-footer"><button class="button" data-close="tag-dialog">${TagcastI18n.html("common.cancel")}</button><button class="button" id="tag-back">${TagcastI18n.html("tags.review.keepEditing")}</button><button class="button ${remove ? "danger" : "primary"}" id="tag-confirm">${TagcastI18n.html(remove ? "tags.review.confirmDelete" : "tags.review.confirmSave")}</button></div>`;
  $("#tag-back").focus();
}

function tagError(message) {
  tagDraft.body = null;
  $("#tag-dialog-content").innerHTML = `<p class="error-box" role="alert">${escapeHtml(message)}</p><p class="muted">${TagcastI18n.html("tags.error.noRetry")}</p><div class="dialog-footer"><button class="button" data-close="tag-dialog">${TagcastI18n.html("common.close")}</button></div>`;
}

async function saveTags() {
  const view = tagDraft, request = view.request;
  if (!view.body || view.busy || saving || checking || !tagCurrent(request)) return;
  const body = view.body; view.body = null; view.busy = true; saving = true;
  let unconfirmed = false;
  $("#tag-dialog-close").disabled = true;
  $("#tag-dialog-content").innerHTML = `<p role="status" class="operation-status" data-working="true">${TagcastI18n.html("tags.save.saving")}</p>`;
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
    if (!success) {
      // A server error stays as sent; Tagcast's own message is shown in the interface language.
      unconfirmed = !response.error;
      throw Error(response.error || TagcastI18n.englishText("errors.tags.unconfirmed"));
    }
    if (body.action === "change" && body.target.multiple) {
      for (const id of body.target.albums) state.selected.delete(String(id));
      render();
      if (!state.selected.size) view.focus = $("#search");
    }
    if (body.action === "create") view.query = body.name;
    $("#tag-dialog-content").innerHTML = `<p role="status">${TagcastI18n.html("tags.save.done")}</p>${view.origin ? `<p class="muted">${TagcastI18n.html("tags.save.newEmpty")}</p>` : ""}<div class="dialog-footer"><button class="button" id="tag-done" data-close="tag-dialog">${TagcastI18n.html("tags.save.finish")}</button>${view.origin ? `<button class="button primary" id="tag-return">${TagcastI18n.html(view.origin.multiple ? "tags.save.returnSelected" : "tags.save.returnAlbum")}</button>` : ""}</div>`;
    $("#tag-done").focus();
  } catch (error) { if (tagCurrent(request)) tagError(unconfirmed ? TagcastI18n.text("errors.tags.unconfirmed") : TagcastI18n.errorText(error)); }
  finally { view.busy = false; saving = false; $("#tag-dialog-close").disabled = false; updateChrome(); }
}

// The tag dialog is a draft: a language change never rebuilds it, so its choices, input and
// focus stay as they are until it is reopened. Only the plain change count line follows.
TagcastI18n.subscribe(() => {
  if ($("#tag-dialog")?.open && tagDraft.selection && document.getElementById("tag-change-count")) renderTagChangeCount();
});

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
  if (event.target.closest("#tag-selection")) return openSelectedAlbumTags();
  if (album) return openTrackTags(album.dataset.albumTags);
  if (track) return openTrackTags(track.dataset.tagAlbum, track.dataset.trackTags);
  if (event.target.closest("#browse-tag-new")) return openTagAction("create");
  if (event.target.closest("#browse-tag-rename")) return openTagAction("rename", browseView.key);
  if (event.target.closest("#browse-tag-delete")) return openTagAction("delete", browseView.key);
  if (event.target.closest("#tag-review")) return reviewTags();
  if (event.target.closest("#tag-confirm")) return saveTags();
  if (event.target.closest("#tag-new")) return openTagAction("create", null, tagDraft.target);
  if (event.target.closest("#tag-return")) return openTagSelection(tagDraft.origin, tagDraft.query);
  if (event.target.closest("#tag-back")) {
    if (tagDraft.action === "change") { tagDraft.body = null; renderTagSelection(); renderTagChoices(); }
    else { const name = tagDraft.body?.name; tagDraft.body = null; renderTagAction(name); }
  }
  const page = event.target.closest("[data-tag-page]");
  if (page) { tagDraft.offset = Math.max(0, tagDraft.offset + Number(page.dataset.tagPage)); return loadTagChoices(); }
});
