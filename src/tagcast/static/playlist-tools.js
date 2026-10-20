// Folder members are playlist identities, never tracks. All writes need a review.
const folderDraft = {request: 0, details: null, session: "", body: null, data: null,
  action: "", query: "", offset: 0, selected: new Map(), choices: [], name: "", description: ""};

function playlistCoverImage(data, small = false) {
  return data.artwork ? `<img class="playlist-cover ${small ? "small" : ""}" src="${escapeHtml(data.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="playlist-cover playlist-placeholder ${small ? "small" : ""}" aria-hidden="true">${data.kind === "folder" || data.is_folder ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>' : "♫"}</span>`;
}

function playlistEditableCover(data) {
  return `<button type="button" class="image-edit-button playlist-cover-edit" data-playlist-cover aria-label="Change cover for ${escapeHtml(data.name)}">${playlistCoverImage(data)}<span class="image-edit-label">Change cover</span></button>`;
}

function playlistDuration(data) {
  if (!Number.isFinite(data.duration) || data.duration < 0) return "";
  const missing = data.duration_missing || 0;
  if (missing) return `${data.duration ? ` · ${trackDuration(data.duration)} known` : ""} · ${missing} ${missing === 1 ? "track" : "tracks"} without duration`;
  return ` · ${data.duration ? trackDuration(data.duration) : "0:00"}`;
}

function playlistBrowseCard(data) {
  return `<button class="button playlist-card" data-playlist-open="${escapeHtml(data.id)}" ${data.kind === "unavailable" ? "disabled" : ""}>${playlistCoverImage(data, true)}<span><strong>${escapeHtml(data.name)}</strong><small>${data.kind === "folder" ? `${data.count} playlist ${data.count === 1 ? "reference" : "references"} · Folder` : data.kind === "unavailable" ? "Unavailable reference" : `${data.count} ${data.count === 1 ? "track" : "tracks"}`}</small></span></button>`;
}

function playlistFolderPage(data) {
  return `<button class="button small page-back" data-playlist-back>← Playlists</button><div class="page-intro playlist-intro">${playlistCoverImage(data)}<div><div class="eyebrow">PLAYLIST FOLDER</div><h1>${escapeHtml(data.name)}</h1><p>${escapeHtml(data.description)}</p></div></div>
    <div class="album-detail-actions"><button class="button" data-folder-rename>Rename folder…</button><button class="button" data-folder-add>Add playlists or folders…</button><button class="button danger" data-folder-delete ${data.total || data.parent_count ? 'disabled title="Empty the folder and remove its parent references first"' : ""}>Delete empty folder…</button></div>
    ${data.parents?.length ? `<p class="muted">Also in: ${data.parents.map(p => `<button class="text-action" data-playlist-open="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join(", ")}</p>` : ""}
    <p>${data.total} playlist ${data.total === 1 ? "reference" : "references"} · removing a reference keeps the playlist and its music.</p><div class="playlist-cards">${data.playlists.map(p => `<div class="playlist-folder-item">${playlistBrowseCard(p)}<button class="text-action" data-folder-remove="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)} from folder">Remove from folder…</button></div>`).join("") || '<p class="muted">This folder is empty. Add playlists or folders when you choose.</p>'}</div>${collectionPages(data.total, 100)}`;
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
  $("#playlist-dialog-title").textContent = action === "create" ? "Create playlist folder" : "Playlist folder";
  $("#playlist-dialog-content").innerHTML = '<p role="status" class="operation-status" data-working="true">Preparing folder review…</p>';
  $("#playlist-dialog").showModal();
  try {
    const fresh = action === "create" ? null : await api(`/api/playlists?id=${encodeURIComponent(data.id)}&offset=${data.offset || 0}`);
    if (!folderDraftCurrent(request) || !$("#playlist-dialog").open) return;
    if (fresh && !fresh.is_folder) throw Error("This folder changed. Reload Playlists.");
    folderDraft.data = fresh; folderDraft.name = fresh?.name || ""; folderDraft.description = fresh?.description || "";
    if (action === "remove") {
      const member = fresh.playlists.find(p => p.id === memberId);
      if (!member) throw Error("This folder entry changed. Reload the folder.");
      folderDraft.selected.set(member.id, member);
      return reviewPlaylistFolder();
    }
    if (action === "delete") return reviewPlaylistFolder();
    renderFolderForm();
    if (action === "add") await loadFolderChoices();
  } catch (error) { if (folderDraftCurrent(request)) $("#playlist-dialog-content").innerHTML = `<p class="error-box">${escapeHtml(error.message)}</p>`; }
}

function renderFolderForm() {
  if (!folderDraftCurrent() || !$("#playlist-dialog").open) return;
  const draft = folderDraft, adding = draft.action === "add";
  $("#playlist-dialog-content").innerHTML = `<form id="playlist-folder-form">${adding ? `<p>Add references to <strong>${escapeHtml(draft.name)}</strong>. The original playlists and their music stay unchanged.</p><div class="clearable-field"><label for="playlist-folder-query">Find playlists and folders</label>${clearableSearchInput("playlist-folder-query", 'name="query" maxlength="200"', draft.query)}</div><button type="button" class="button small" data-folder-find>Find</button><p id="folder-selected-count"></p><div id="folder-choices"></div>` : `<label>Folder name <input name="name" maxlength="200" required value="${escapeHtml(draft.name)}"></label>${draft.action === "rename" ? `<label>Description <textarea name="description" maxlength="2000">${escapeHtml(draft.description)}</textarea></label>` : ""}`}
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-dialog">Cancel</button><button class="button primary">Prepare review →</button></div></form>`;
  if (adding) renderFolderChoices();
}

function renderFolderChoices() {
  const draft = folderDraft;
  if (!folderDraftCurrent() || !$("#playlist-dialog").open) return;
  $("#folder-selected-count").textContent = `${draft.selected.size} selected (up to 100 per review)`;
  $("#folder-choices").innerHTML = `<div class="playlist-review-tracks">${draft.choices.map(p => `<label class="checkline"><input type="checkbox" data-folder-choice="${escapeHtml(p.id)}" ${draft.selected.has(p.id) ? "checked" : ""} ${p.id === draft.data?.id ? "disabled" : ""}> ${escapeHtml(p.name)} · ${p.kind === "folder" ? "Folder" : `${p.count} ${p.count === 1 ? "track" : "tracks"}`}</label>`).join("") || '<p class="muted">No matching playlists.</p>'}</div><div class="pagination"><button type="button" class="button small" data-folder-page="-100" ${draft.offset ? "" : "disabled"}>← Previous</button><span>${draft.total || 0} choices</span><button type="button" class="button small" data-folder-page="100" ${draft.offset + 100 >= (draft.total || 0) ? "disabled" : ""}>Next →</button></div>`;
}

async function loadFolderChoices() {
  const request = folderDraft.request, query = folderDraft.query, offset = folderDraft.offset;
  try {
    const data = await api(`/api/playlist-folder/choices?q=${encodeURIComponent(query)}&offset=${offset}`);
    if (!folderDraftCurrent(request) || query !== folderDraft.query || offset !== folderDraft.offset || !$("#playlist-dialog").open) return;
    folderDraft.choices = data.playlists; folderDraft.total = data.total;
    renderFolderChoices();
  } catch (error) { if (folderDraftCurrent(request)) toast(error.message); }
}

function reviewPlaylistFolder(form = null) {
  const draft = folderDraft;
  if (!folderDraftCurrent() || !$("#playlist-dialog").open) return;
  if (form && draft.action !== "add") { draft.name = form.elements.name.value.trim(); draft.description = draft.action === "create" ? "" : form.elements.description.value.trim(); }
  if (["create", "rename"].includes(draft.action) && !draft.name) { toast("Enter a folder name."); return; }
  if (draft.action === "add" && !draft.selected.size) { toast("Select playlists or folders first."); return; }
  const body = {action: draft.action, session: draft.session, approved: true, name: draft.name, description: draft.description};
  if (draft.data) Object.assign(body, {playlist: draft.data.id, before_token: draft.data.before_token, before_name: draft.data.name});
  if (["add", "remove"].includes(draft.action)) body.members = [...draft.selected.values()].map(p => ({id: p.id, name: p.name, kind: p.kind, before_token: p.before_token}));
  if (draft.action === "delete") body.confirm_delete = true;
  draft.body = body;
  const actionText = {create: "Create an empty playlist folder.", rename: "Change this folder's name and description.", add: "Add the following playlist references.", remove: "Remove the following references from this folder. The playlists themselves stay available.", delete: "Delete this empty folder. No playlists or music will be deleted."}[draft.action];
  $("#playlist-dialog-content").innerHTML = `<h3>${escapeHtml(draft.name)}</h3><p>${escapeHtml(actionText)}</p>${draft.action === "rename" ? `<p>Name: ${escapeHtml(draft.data.name)} → ${escapeHtml(draft.name)}</p><p>Description: ${escapeHtml(draft.description || "(empty)")}</p>` : ""}${[...draft.selected.values()].map(p => `<p>${escapeHtml(p.name)} · ID ${escapeHtml(p.id)}</p>`).join("")}<div class="dialog-footer">${["create", "rename", "add"].includes(draft.action) ? '<button class="button" data-folder-revise>← Edit review</button>' : '<button class="button" data-close="playlist-dialog">Cancel</button>'}<button class="button ${draft.action === "delete" ? "danger" : "primary"}" data-folder-save>Confirm in iBroadcast</button></div>`;
}

async function savePlaylistFolder() {
  const draft = folderDraft, body = draft.body, request = draft.request;
  if (!body || !folderDraftCurrent(request) || collectionsView.busy || !$("#playlist-dialog").open) return;
  draft.body = null; collectionsView.busy = true;
  const button = $("[data-folder-save]");
  button.disabled = true; button.textContent = "Saving and checking…"; button.setAttribute("aria-busy", "true");
  try {
    const response = await api("/api/playlist-folder", body);
    const job = await collectionJob(response, () => folderDraftCurrent(request));
    if (job.results?.length !== 1 || job.results[0].id !== response.id || job.results[0].status !== "saved") throw Error("The folder was sent, but read-back differs. Check Playlists before retrying.");
    if (!folderDraftCurrent(request)) return;
    $("#playlist-dialog").close(); toast("Folder change confirmed in iBroadcast.");
    if (state.screen === "playlists") {
      if (body.action === "create") showCollections("playlists", response.id);
      else if (body.action === "delete") showCollections("playlists");
      else renderCollections();
    }
  } catch (error) { if (folderDraftCurrent(request)) { $("#playlist-dialog").close(); toast(`Check Playlists before retrying: ${error.message}`); } }
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
  $("#art-save").disabled = true; $("#art-save").textContent = "Saving and checking…";
  setActionStatus("#art-status", "Saving the playlist cover and checking iBroadcast…", true);
  try {
    const source = option.artwork_id ? {artwork_id: option.artwork_id} : option.data ? {data: option.data, name: option.name} : {url: option.url};
    const response = await api("/api/playlist/artwork", {playlist: target.id, before_name: target.label,
      before_token: target.before_token, session: target.session, source, approved: true});
    const job = await collectionJob(response, current);
    if (job.results?.length !== 1 || job.results[0].id !== target.id || job.results[0].status !== "saved") throw Error("The cover was sent, but read-back differs.");
    if (!current()) return;
    $("#artwork").close(); toast("Playlist cover confirmed in iBroadcast.");
    if (state.screen === "playlists") renderCollections();
  } catch (error) { if (current()) { $("#art-status").textContent = `Check the playlist before retrying: ${error.message}`; $("#art-save").textContent = "Close and review again"; } }
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
    if (folderDraft.selected.size >= 100) { event.target.checked = false; toast("Select up to 100 references per review."); return; }
    folderDraft.selected.set(id, item);
  } else folderDraft.selected.delete(id);
  $("#folder-selected-count").textContent = `${folderDraft.selected.size} selected (up to 100 per review)`;
});
document.addEventListener("click", event => {
  const target = event.target;
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
