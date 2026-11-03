// Folder members are playlist identities, never tracks. All writes need a review.
const folderDraft = {request: 0, details: null, session: "", body: null, data: null,
  action: "", query: "", offset: 0, selected: new Map(), choices: [], name: "", description: ""};

function playlistCoverImage(data, small = false) {
  return data.artwork ? `<img class="playlist-cover ${small ? "small" : ""}" src="${escapeHtml(data.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="playlist-cover playlist-placeholder ${small ? "small" : ""}" aria-hidden="true">${data.kind === "folder" || data.is_folder ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>' : "♫"}</span>`;
}

function playlistEditableCover(data) {
  return `<button type="button" class="image-edit-button playlist-cover-edit" data-playlist-cover aria-label="${TagcastI18n.html("playlistTools.cover.changeFor", {name: data.name})}">${playlistCoverImage(data)}<span class="image-edit-label">${TagcastI18n.html("playlistTools.cover.change")}</span></button>`;
}

// Escaped list items, each starting with " · ", for HTML templates.
function playlistDuration(data) {
  if (!Number.isFinite(data.duration) || data.duration < 0) return "";
  const missing = data.duration_missing || 0;
  if (missing) return `${data.duration ? ` · ${TagcastI18n.html("playlistTools.duration.known", {duration: trackDuration(data.duration)})}` : ""} · ${TagcastI18n.html("playlistTools.duration.missing", {count: missing})}`;
  return ` · ${data.duration ? trackDuration(data.duration) : "0:00"}`;
}

function playlistBrowseCard(data) {
  const count = data.active_count ?? data.count;
  const unavailable = data.unavailable_count ? ` · ${TagcastI18n.html("playlistTools.card.unavailable", {count: data.unavailable_count})}` : "";
  return `<button class="button playlist-card" data-playlist-open="${escapeHtml(data.id)}" ${data.kind === "unavailable" ? "disabled" : ""}>${playlistCoverImage(data, true)}<span><strong>${escapeHtml(data.name)}</strong><small>${data.kind === "folder" ? `${TagcastI18n.html("playlistTools.count.playlistReferences", {count: data.count})} · ${TagcastI18n.html("playlistTools.kind.folder")}` : data.kind === "unavailable" ? TagcastI18n.html("playlistTools.kind.unavailable") : `${TagcastI18n.html("common.count.tracks", {count})}${playlistDuration(data).replace(/^ · /, " / ")}${unavailable}`}</small></span></button>`;
}

function playlistViewControls() {
  return `<div class="view-toggle" role="group" aria-label="${TagcastI18n.html("playlistTools.view.label")}"><button type="button" data-playlists-view="grid" aria-label="${TagcastI18n.html("playlistTools.view.cards")}" aria-pressed="${collectionsView.view !== "list"}">▦</button><button type="button" data-playlists-view="list" aria-label="${TagcastI18n.html("playlistTools.view.list")}" aria-pressed="${collectionsView.view === "list"}">☰</button></div>`;
}

function playlistBrowseItems(rows, folder = false) {
  const remove = p => `<button class="text-action" data-folder-remove="${escapeHtml(p.id)}" aria-label="${TagcastI18n.html("playlistTools.folderItem.removeLabel", {name: p.name})}">${TagcastI18n.html("playlistTools.folderItem.remove")}</button>`;
  const folderLabel = `<small>${TagcastI18n.html("playlistTools.kind.folder")}</small>`, unavailableLabel = `<small>${TagcastI18n.html("playlistTools.kind.unavailable")}</small>`;
  if (collectionsView.view !== "list") return `<div class="playlist-cards">${rows.map(p => folder ? `<div class="playlist-folder-item">${playlistBrowseCard(p)}${remove(p)}</div>` : playlistBrowseCard(p)).join("")}</div>`;
  return `<div class="playlist-list-wrap"><table class="playlist-list"><thead><tr><th>${TagcastI18n.html("playlistTools.list.playlist")}</th><th>${TagcastI18n.html("playlistTools.list.items")}</th><th>${TagcastI18n.html("playlistTools.list.totalTime")}</th>${folder ? `<th aria-label="${TagcastI18n.html("playlistTools.list.folderActions")}"></th>` : ""}</tr></thead><tbody>${rows.map(p => `<tr><td><button type="button" class="playlist-list-open" data-playlist-open="${escapeHtml(p.id)}" ${p.kind === "unavailable" ? "disabled" : ""}>${playlistCoverImage(p, true)}<span><strong>${escapeHtml(p.name)}</strong>${p.kind === "folder" ? folderLabel : p.kind === "unavailable" ? unavailableLabel : p.unavailable_count ? `<small>${TagcastI18n.html("playlistTools.list.unavailableTracks", {count: p.unavailable_count})}</small>` : ""}</span></button></td><td class="playlist-list-number">${p.kind === "folder" ? TagcastI18n.html("playlistTools.list.references", {count: p.count}) : p.kind === "unavailable" ? "–" : p.active_count ?? p.count}</td><td class="playlist-list-time">${p.kind === "folder" || p.kind === "unavailable" ? "–" : playlistDuration(p).replace(/^ · /, "") || "–"}</td>${folder ? `<td>${remove(p)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function playlistCataloguePage(data) {
  const search = TagcastI18n.html("playlistTools.catalogue.search"), folder = data.playlists[0]?.kind === "folder";
  return `<div class="page-intro"><div><h1>${TagcastI18n.html("playlistTools.catalogue.heading")}<span>.</span></h1><p>${TagcastI18n.html("playlistTools.catalogue.intro")}</p></div></div><div class="toolbar">${clearableSearchInput("collection-search", `class="collection-search" placeholder="${search}" aria-label="${search}"`, collectionsView.query)}<button class="button" data-playlist-create>${TagcastI18n.html("playlistTools.catalogue.create")}</button><button class="button" data-folder-create>${TagcastI18n.html("playlistTools.catalogue.createFolder")}</button><button class="button" data-csv-import>${TagcastI18n.html("playlistTools.catalogue.importCsv")}</button><button class="button" data-playlist-url>${TagcastI18n.html("playlistTools.catalogue.url")}</button><button class="button" data-csv-paused>${TagcastI18n.html("playlistTools.catalogue.paused")}</button>${playlistViewControls()}</div><p>${TagcastI18n.html(folder ? "playlistTools.catalogue.folders" : "playlistTools.catalogue.playlists", {count: data.total})}</p>${data.playlists.length ? playlistBrowseItems(data.playlists) : `<p class="muted">${TagcastI18n.html("playlistTools.catalogue.empty")}</p>`}${collectionPages(data.total, 100)}`;
}

function playlistFolderPage(data) {
  return `<button class="button small page-back" data-playlist-back>${TagcastI18n.html("playlists.page.back")}</button><div class="page-intro playlist-intro">${playlistCoverImage(data)}<div><div class="eyebrow">${TagcastI18n.html("playlistTools.folder.eyebrow")}</div><h1>${escapeHtml(data.name)}</h1><p>${escapeHtml(data.description)}</p></div></div>
    <div class="album-detail-actions"><button class="button" data-folder-rename>${TagcastI18n.html("playlistTools.folder.rename")}</button><button class="button" data-folder-add>${TagcastI18n.html("playlistTools.folder.add")}</button><button class="button danger" data-folder-delete ${data.total || data.parent_count ? `disabled title="${TagcastI18n.html("playlistTools.folder.deleteBlocked")}"` : ""}>${TagcastI18n.html("playlistTools.folder.delete")}</button></div>
    ${data.parents?.length ? `<p class="muted">${TagcastI18n.html("playlistTools.folder.alsoIn", {folders: TagcastI18n.trusted(data.parents.map(p => `<button class="text-action" data-playlist-open="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join(", "))})}</p>` : ""}
    <div class="playlist-folder-view"><p>${TagcastI18n.html("playlistTools.folder.summary", {count: data.total})}</p>${playlistViewControls()}</div>${data.playlists.length ? playlistBrowseItems(data.playlists, true) : `<p class="muted">${TagcastI18n.html("playlistTools.folder.empty")}</p>`}${collectionPages(data.total, 100)}`;
}

function invalidatePlaylistFolder() { folderDraft.request += 1; folderDraft.body = null; }

function folderDraftCurrent(request = folderDraft.request) {
  return request === folderDraft.request && folderDraft.details === state.details
    && folderDraft.session === state.connection.playback_session && live();
}

async function openPlaylistFolder(action, memberId = null) {
  if (!live() || collectionsView.busy || saving || checking) return;
  const request = ++folderDraft.request, data = collectionsView.data;
  playlistDraft.request += 1;
  Object.assign(folderDraft, {details: state.details, session: state.connection.playback_session,
    body: null, data: null, action, query: "", offset: 0, selected: new Map()});
  $("#playlist-dialog-title").textContent = TagcastI18n.text(action === "create" ? "playlistTools.folderDialog.createTitle" : "playlistTools.folderDialog.title");
  $("#playlist-dialog-content").innerHTML = `<p role="status" class="operation-status" data-working="true">${TagcastI18n.html("playlistTools.folderDialog.preparing")}</p>`;
  $("#playlist-dialog").showModal();
  try {
    const fresh = action === "create" ? null : await api(`/api/playlists?id=${encodeURIComponent(data.id)}&offset=${data.offset || 0}`);
    if (!folderDraftCurrent(request) || !$("#playlist-dialog").open) return;
    if (fresh && !fresh.is_folder) throw playlistFailure("errors.playlists.folder_changed");
    folderDraft.data = fresh; folderDraft.name = fresh?.name || ""; folderDraft.description = fresh?.description || "";
    if (action === "remove") {
      const member = fresh.playlists.find(p => p.id === memberId);
      if (!member) throw playlistFailure("errors.playlists.folder_entry_changed");
      folderDraft.selected.set(member.id, member);
      return reviewPlaylistFolder();
    }
    if (action === "delete") return reviewPlaylistFolder();
    renderFolderForm();
    if (action === "add") await loadFolderChoices();
  } catch (error) { if (folderDraftCurrent(request)) $("#playlist-dialog-content").innerHTML = collectionsError(error); }
}

function renderFolderForm() {
  if (!folderDraftCurrent() || !$("#playlist-dialog").open) return;
  const draft = folderDraft, adding = draft.action === "add";
  const folder = TagcastI18n.trusted(`<strong>${escapeHtml(draft.name)}</strong>`);
  $("#playlist-dialog-content").innerHTML = `<form id="playlist-folder-form">${adding ? `<p>${TagcastI18n.html("playlistTools.folderDialog.addIntro", {folder})}</p><div class="clearable-field"><label for="playlist-folder-query">${TagcastI18n.html("playlistTools.folderDialog.findLabel")}</label>${clearableSearchInput("playlist-folder-query", 'name="query" maxlength="200"', draft.query)}</div><button type="button" class="button small" data-folder-find>${TagcastI18n.html("playlistTools.folderDialog.find")}</button><p id="folder-selected-count"></p><div id="folder-choices"></div>` : `<label>${TagcastI18n.html("playlistTools.folderDialog.name")} <input name="name" maxlength="200" required value="${escapeHtml(draft.name)}"></label>${draft.action === "rename" ? `<label>${TagcastI18n.html("playlists.save.description")} <textarea name="description" maxlength="2000">${escapeHtml(draft.description)}</textarea></label>` : ""}`}
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-dialog">${TagcastI18n.html("common.cancel")}</button><button class="button primary">${TagcastI18n.html("playlists.save.prepare")}</button></div></form>`;
  if (adding) renderFolderChoices();
}

function renderFolderChoices() {
  const draft = folderDraft;
  if (!folderDraftCurrent() || !$("#playlist-dialog").open) return;
  $("#folder-selected-count").textContent = TagcastI18n.text("playlistTools.folderDialog.selected", {count: draft.selected.size});
  $("#folder-choices").innerHTML = `<div class="playlist-review-tracks">${draft.choices.map(p => `<label class="checkline"><input type="checkbox" data-folder-choice="${escapeHtml(p.id)}" ${draft.selected.has(p.id) ? "checked" : ""} ${p.id === draft.data?.id ? "disabled" : ""}> ${escapeHtml(p.name)} · ${p.kind === "folder" ? TagcastI18n.html("playlistTools.kind.folder") : TagcastI18n.html("common.count.tracks", {count: p.count})}</label>`).join("") || `<p class="muted">${TagcastI18n.html("playlistTools.folderDialog.noMatches")}</p>`}</div><div class="pagination"><button type="button" class="button small" data-folder-page="-100" ${draft.offset ? "" : "disabled"}>${TagcastI18n.html("common.pagination.previous")}</button><span>${TagcastI18n.html("playlistTools.folderDialog.choices", {count: draft.total || 0})}</span><button type="button" class="button small" data-folder-page="100" ${draft.offset + 100 >= (draft.total || 0) ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>`;
}

async function loadFolderChoices() {
  const request = folderDraft.request, query = folderDraft.query, offset = folderDraft.offset;
  try {
    const data = await api(`/api/playlist-folder/choices?q=${encodeURIComponent(query)}&offset=${offset}`);
    if (!folderDraftCurrent(request) || query !== folderDraft.query || offset !== folderDraft.offset || !$("#playlist-dialog").open) return;
    folderDraft.choices = data.playlists; folderDraft.total = data.total;
    renderFolderChoices();
  } catch (error) { if (folderDraftCurrent(request)) toast(TagcastI18n.errorText(error)); }
}

function reviewPlaylistFolder(form = null) {
  const draft = folderDraft;
  if (!folderDraftCurrent() || !$("#playlist-dialog").open) return;
  if (form && draft.action !== "add") { draft.name = form.elements.name.value.trim(); draft.description = draft.action === "create" ? "" : form.elements.description.value.trim(); }
  if (["create", "rename"].includes(draft.action) && !draft.name) { toast(TagcastI18n.text("playlistTools.folderDialog.enterName")); return; }
  if (draft.action === "add" && !draft.selected.size) { toast(TagcastI18n.text("playlistTools.folderDialog.selectFirst")); return; }
  const body = {action: draft.action, session: draft.session, approved: true, name: draft.name, description: draft.description};
  if (draft.data) Object.assign(body, {playlist: draft.data.id, before_token: draft.data.before_token, before_name: draft.data.name});
  if (["add", "remove"].includes(draft.action)) body.members = [...draft.selected.values()].map(p => ({id: p.id, name: p.name, kind: p.kind, before_token: p.before_token}));
  if (draft.action === "delete") body.confirm_delete = true;
  draft.body = body;
  const actionText = {create: "playlistTools.folderReview.create", rename: "playlistTools.folderReview.rename", add: "playlistTools.folderReview.add", remove: "playlistTools.folderReview.remove", delete: "playlistTools.folderReview.delete"}[draft.action];
  const description = draft.description || TagcastI18n.text("playlists.review.empty");
  $("#playlist-dialog-content").innerHTML = `<h3>${escapeHtml(draft.name)}</h3><p>${TagcastI18n.html(actionText)}</p>${draft.action === "rename" ? `<p>${TagcastI18n.html("playlistTools.folderReview.name", {before: draft.data.name, after: draft.name})}</p><p>${TagcastI18n.html("playlistTools.folderReview.description", {description})}</p>` : ""}${[...draft.selected.values()].map(p => `<p>${TagcastI18n.html("playlistTools.folderReview.member", {name: p.name, id: p.id})}</p>`).join("")}<div class="dialog-footer">${["create", "rename", "add"].includes(draft.action) ? `<button class="button" data-folder-revise>${TagcastI18n.html("playlists.review.revise")}</button>` : `<button class="button" data-close="playlist-dialog">${TagcastI18n.html("common.cancel")}</button>`}<button class="button ${draft.action === "delete" ? "danger" : "primary"}" data-folder-save>${TagcastI18n.html("playlistTools.folderReview.confirm")}</button></div>`;
}

async function savePlaylistFolder() {
  const draft = folderDraft, body = draft.body, request = draft.request;
  if (!body || !folderDraftCurrent(request) || collectionsView.busy || !$("#playlist-dialog").open) return;
  draft.body = null; collectionsView.busy = true;
  const button = $("[data-folder-save]");
  button.disabled = true; button.textContent = TagcastI18n.text("playlistTools.save.checking"); button.setAttribute("aria-busy", "true");
  try {
    const response = await api("/api/playlist-folder", body);
    const job = await collectionJob(response, () => folderDraftCurrent(request));
    if (job.results?.length !== 1 || job.results[0].id !== response.id || job.results[0].status !== "saved") throw playlistFailure("errors.playlists.folder_readback");
    if (!folderDraftCurrent(request)) return;
    $("#playlist-dialog").close(); toast(TagcastI18n.text("playlistTools.folderReview.done"));
    if (state.screen === "playlists") {
      if (body.action === "create") showCollections("playlists", response.id);
      else if (body.action === "delete") showCollections("playlists");
      else renderCollections();
    }
  } catch (error) { if (folderDraftCurrent(request)) { $("#playlist-dialog").close(); toast(TagcastI18n.text("playlistTools.folderReview.failed", {error: TagcastI18n.errorText(error)})); } }
  finally { collectionsView.busy = false; button.setAttribute("aria-busy", "false"); }
}

function openPlaylistCover() {
  const data = collectionsView.data;
  if (!data || data.is_folder || !live() || collectionsView.busy || document.querySelector("dialog[open]")) return;
  openArtwork({target: "playlist", id: data.id, label: data.name, current: data.artwork,
    before_token: data.before_token, details: state.details, session: state.connection.playback_session});
}

async function savePlaylistCover(target, option) {
  const current = () => target === art.target && target.details === state.details
    && target.session === state.connection.playback_session && live();
  if (!current() || collectionsView.busy || art.submitted) return;
  const status = $("#art-status");
  art.submitted = true; collectionsView.busy = true;
  $("#art-save").disabled = true; $("#art-save").textContent = TagcastI18n.text("playlistTools.save.checking");
  setActionStatus("#art-status", TagcastI18n.text("playlistTools.cover.saving"), true);
  try {
    const source = option.artwork_id ? {artwork_id: option.artwork_id} : option.data ? {data: option.data, name: option.name} : {url: option.url};
    const response = await api("/api/playlist/artwork", {playlist: target.id, before_name: target.label,
      before_token: target.before_token, session: target.session, source, approved: true});
    const job = await collectionJob(response, current);
    if (job.results?.length !== 1 || job.results[0].id !== target.id || job.results[0].status !== "saved") throw playlistFailure("errors.playlists.cover_readback");
    if (!current()) return;
    $("#artwork").close(); toast(TagcastI18n.text("playlistTools.cover.done"));
    if (state.screen === "playlists") renderCollections();
  } catch (error) { if (current()) { $("#art-status").textContent = TagcastI18n.text("playlistTools.cover.failed", {error: TagcastI18n.errorText(error)}); $("#art-save").textContent = TagcastI18n.text("playlistTools.cover.reviewAgain"); } }
  finally { collectionsView.busy = false; if ($("#art-status") === status) setActionStatus("#art-status", undefined); }
}

document.addEventListener("submit", event => {
  if (event.target.id === "playlist-folder-form") { event.preventDefault(); reviewPlaylistFolder(event.target); }
});
document.addEventListener("change", event => {
  const id = event.target.dataset?.folderChoice;
  if (!id || !folderDraftCurrent()) return;
  const item = folderDraft.choices.find(p => p.id === id);
  if (!item) return;
  if (event.target.checked) {
    if (folderDraft.selected.size >= 100) { event.target.checked = false; toast(TagcastI18n.text("playlistTools.folderDialog.limit")); return; }
    folderDraft.selected.set(id, item);
  } else folderDraft.selected.delete(id);
  $("#folder-selected-count").textContent = TagcastI18n.text("playlistTools.folderDialog.selected", {count: folderDraft.selected.size});
});
document.addEventListener("click", event => {
  const target = event.target;
  const view = target.closest("[data-playlists-view]");
  if (view && view.isConnected && state.screen === "playlists" && live() && !state.loading
      && collectionsView.details === state.details && collectionsView.data && (!collectionsView.playlist || collectionsView.data.is_folder)
      && ["grid", "list"].includes(view.dataset.playlistsView)) {
    collectionsView.view = view.dataset.playlistsView;
    try { localStorage.setItem("tagcast-playlists-view", collectionsView.view); } catch { /* private window */ }
    replaceCollections(collectionsView.data.is_folder ? playlistFolderPage(collectionsView.data) : playlistCataloguePage(collectionsView.data));
    document.querySelector(`[data-playlists-view="${collectionsView.view}"]`)?.focus({preventScroll: true});
    return;
  }
  if (target.closest("[data-playlist-cover]")) return openPlaylistCover();
  if (target.closest("[data-folder-create]")) return openPlaylistFolder("create");
  if (target.closest("[data-folder-rename]")) return openPlaylistFolder("rename");
  if (target.closest("[data-folder-add]")) return openPlaylistFolder("add");
  if (target.closest("[data-folder-delete]")) return openPlaylistFolder("delete");
  const remove = target.closest("[data-folder-remove]");
  if (remove) return openPlaylistFolder("remove", remove.dataset.folderRemove);
  if (target.closest("[data-folder-revise]")) return renderFolderForm();
  if (target.closest("[data-folder-save]")) return savePlaylistFolder();
  if (target.closest("[data-folder-find]")) { folderDraft.query = $("#playlist-folder-form").elements.query.value.trim(); folderDraft.offset = 0; return loadFolderChoices(); }
  const page = target.closest("[data-folder-page]");
  if (page) { folderDraft.offset = Math.max(0, folderDraft.offset + Number(page.dataset.folderPage)); return loadFolderChoices(); }
});

$("#playlist-dialog").addEventListener("close", invalidatePlaylistFolder);
