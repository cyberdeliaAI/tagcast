"use strict";

// A manually analysed listening list. Opening the page only reads a saved local report.
const albumGuide = {enabled: lookup.albumGuideEnabled === true, data: null, details: null, request: 0, loading: false,
  analysing: false, error: "", query: "", filter: "found", decade: "all", sort: "list", page: 0, pageSize: 24};
const guideLink = {entry: null, request: 0, busy: false, focus: null};
const guideDisplay = {matching: readGuideMatchingDisplay(), changed: false, pending: Promise.resolve()};
const guideNotes = {data: null, pending: null, error: false, open: new Set()};
const guideNoteAlbums = {details: null, revision: 0, entries: new Map()};

function guideNoteAlbumKey(selection) {
  return JSON.stringify([selection.album_id, selection.artist, selection.album, selection.session]);
}

function guideNoteAlbumEntry() {
  const selection = albumInformationSelection();
  return selection && guideNoteAlbums.details === state.details
    ? guideNoteAlbums.entries.get(guideNoteAlbumKey(selection)) : null;
}

function guideNoteEntries() {
  return guideNoteAlbumEntry()?.entries || [];
}

function resetGuideAlbumNotes() {
  guideNoteAlbums.revision += 1; guideNoteAlbums.entries.clear(); guideNoteAlbums.details = null;
  const panel = $("#album-guide-notes");
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
}

function readGuideNotes(data) {
  if (data?.schema !== 1 || !Array.isArray(data.entries) || data.entries.length > 1001) throw Error("Invalid album notes file");
  const notes = new Map();
  for (const note of data.entries) {
    if (!Number.isInteger(note.id) || note.id < 1 || note.id > 1001 || notes.has(note.id)
      || typeof note.text !== "string" || !note.text.trim() || note.text.length > 18000
      || typeof note.album !== "string" || typeof note.artist !== "string"
      || note.context !== undefined && (typeof note.context !== "string" || note.context.length > 2000)) continue;
    let source;
    try { source = new URL(note.source_url); } catch { continue; }
    if (source.protocol !== "https:" || !["en.wikipedia.org", "fr.wikipedia.org"].includes(source.host) || !source.pathname.startsWith("/wiki/")
      || source.username || source.password || source.search || source.hash) continue;
    notes.set(note.id, {...note, source_url: source.href});
  }
  return notes;
}

function guideAlbumNoteRows() {
  return guideNoteEntries().flatMap(entry => {
    const note = guideNotes.data?.get(entry.id);
    // A reference correction cannot attach a previously captured text to a new identity.
    return note && foldText(note.album) === foldText(entry.album) && foldText(note.artist) === foldText(entry.artist)
      ? [{entry, note}] : [];
  });
}

function albumBackgroundSource() {
  const entry = guideNoteAlbumEntry();
  if (!entry || entry.loading) return "pending";
  if (!entry.entries.length) return "theaudiodb";
  if (guideNotes.pending || !guideNotes.data && !guideNotes.error) return "pending";
  return guideAlbumNoteRows().length ? "guide" : "theaudiodb";
}

// quiet: a language repaint from memory (see renderAlbumInformation); focus: a control to focus again.
function renderGuideAlbumNotes({quiet = false, focus = ""} = {}) {
  const panel = $("#album-guide-notes");
  if (!panel || state.screen !== "album") return;
  const entries = guideNoteEntries(), rows = guideAlbumNoteRows();
  panel.innerHTML = rows.map(({entry, note}) => `<details class="album-guide-note" data-guide-note="${entry.id}" ${guideNotes.open.has(entry.id) ? "open" : ""}><summary>${TagcastI18n.html("albumInfo.summary")} <span>1001 Albums${rows.length > 1 ? ` · ${escapeHtml(entry.album)}` : ""}</span></summary><div class="album-guide-note-copy">${note.context ? `<p class="muted">${escapeHtml(note.context)}</p>` : ""}<p>${escapeHtml(note.text)}</p><p class="muted">${TagcastI18n.html("guide.notes.adapted")} · <a href="${escapeHtml(note.source_url)}" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("guide.notes.contributors")} ↗</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a></p></div></details>`).join("")
    || (entries.length && guideNotes.error ? `<p class="muted">${TagcastI18n.html("guide.notes.failed")}</p>` : "");
  panel.hidden = !panel.innerHTML;
  if (typeof renderAlbumInformation === "function") renderAlbumInformation(focus, quiet);
}

function loadGuideAlbumNotes() {
  const selection = albumInformationSelection();
  if (!selection) return;
  if (guideNoteAlbums.details !== state.details) {
    guideNoteAlbums.revision += 1; guideNoteAlbums.entries.clear(); guideNoteAlbums.details = state.details;
  }
  const key = guideNoteAlbumKey(selection);
  let entry = guideNoteAlbums.entries.get(key);
  if (!entry) {
    entry = {loading: true, entries: []}; guideNoteAlbums.entries.set(key, entry);
    while (guideNoteAlbums.entries.size > 100) guideNoteAlbums.entries.delete(guideNoteAlbums.entries.keys().next().value);
    loadGuideNoteAlbum(selection, key, entry);
    return;
  }
  if (entry.loading) return;
  if (!entry.entries.length || guideNotes.data || guideNotes.error) { renderGuideAlbumNotes(); return; }
  if (guideNotes.pending) return;
  guideNotes.pending = api("/1001-album-notes.json").then(data => { guideNotes.data = readGuideNotes(data); })
    .catch(() => { guideNotes.error = true; })
    .finally(() => { guideNotes.pending = null; renderGuideAlbumNotes(); });
}

async function loadGuideNoteAlbum(selection, key, entry) {
  const details = state.details, revision = guideNoteAlbums.revision;
  const current = () => live() && !state.loading && details === state.details
    && selection.session === state.connection.playback_session && revision === guideNoteAlbums.revision
    && guideNoteAlbums.entries.get(key) === entry && state.albums.some(a => String(a.id) === selection.album_id
      && a.name === selection.album && a.artist === selection.artist);
  const visible = () => current() && albumInformationSelection()
    && guideNoteAlbumKey(albumInformationSelection()) === key;
  try {
    const data = await api(`/api/album-guide/album?${new URLSearchParams(selection)}`);
    if (!current()) return;
    if (!Array.isArray(data.entries) || data.entries.length > 1001) throw Error("Invalid local album text matches");
    const ids = new Set();
    for (const row of data.entries) {
      if (!Number.isInteger(row.id) || row.id < 1 || row.id > 1001 || ids.has(row.id)
          || typeof row.album !== "string" || typeof row.artist !== "string") throw Error("Invalid local album text match");
      ids.add(row.id);
    }
    entry.entries = data.entries;
  } catch { if (current()) entry.entries = []; }
  finally {
    entry.loading = false;
    if (visible()) {
      loadGuideAlbumNotes(); renderAlbumInformation();
    } else if (!current() && guideNoteAlbums.entries.get(key) === entry) {
      guideNoteAlbums.entries.delete(key);
      const selected = albumInformationSelection();
      if (live() && !state.loading && selected && guideNoteAlbumKey(selected) === key) loadGuideAlbumNotes();
    }
  }
}

document.addEventListener("toggle", event => {
  const details = event.target;
  if (!details.isConnected || !details.matches?.("details[data-guide-note]")) return;
  const id = Number(details.dataset.guideNote);
  if (details.open) guideNotes.open.add(id); else guideNotes.open.delete(id);
}, true);

function readGuideMatchingDisplay() {
  try { return localStorage.getItem("tagcast-guide-matching-details") !== "hidden"; }
  catch { return true; }
}

function applyGuideMatchingDisplay() {
  $("#album-guide-page").classList.toggle("guide-hide-matching", !guideDisplay.matching);
  $("#guide-show-matching").checked = guideDisplay.matching;
}

function resetAlbumGuide(renderNotes = true) {
  guideLink.request += 1; guideLink.busy = false;
  guideLink.entry = null; guideLink.focus = null;
  $("#guide-link-dialog").close();
  albumGuide.request += 1;
  Object.assign(albumGuide, {data: null, details: null, loading: false, analysing: false, error: ""});
  if (renderNotes) renderGuideAlbumNotes();
}

function applyAlbumGuideSettings(data) {
  // The server preference survives a different localhost port or browser.
  // A late settings read must not undo a checkbox change in this tab.
  if (!guideDisplay.changed && typeof data.guide_matching_details === "boolean") {
    guideDisplay.matching = data.guide_matching_details;
    try { localStorage.setItem("tagcast-guide-matching-details", guideDisplay.matching ? "visible" : "hidden"); }
    catch { /* The server still remembers the preference. */ }
  }
  applyGuideMatchingDisplay();
  const enabled = data.album_guide === true;
  if (enabled !== albumGuide.enabled) resetAlbumGuide();
  albumGuide.enabled = enabled;
  updateAlbumGuideControls();
  renderGuideAlbumNotes();
  if (state.screen === "album") loadGuideAlbumNotes();
  if (!enabled && state.screen === "album-guide") { showScreen("artists"); renderArtistBrowse(); }
  else if (enabled && state.screen === "album-guide") renderAlbumGuide();
}

function updateAlbumGuideControls() {
  $("#show-album-guide").hidden = !albumGuide.enabled;
  if (typeof applySidebarLayout === "function") applySidebarLayout();
}

async function loadAlbumGuide(analyse = false) {
  if (!albumGuide.enabled || !live() || state.loading || albumGuide.loading || guideLink.busy) return;
  const request = ++albumGuide.request, details = state.details;
  const session = state.connection.playback_session;
  albumGuide.loading = true; albumGuide.analysing = analyse; albumGuide.error = "";
  albumGuide.details = details; renderAlbumGuide();
  try {
    const data = await api(analyse ? "/api/album-guide/analyse" : "/api/album-guide", analyse ? {} : undefined);
    if (request !== albumGuide.request || details !== state.details || !albumGuide.enabled
      || !live() || session !== state.connection.playback_session) return;
    albumGuide.data = data;
    if (analyse) albumGuide.page = 0;
  } catch (error) {
    if (request !== albumGuide.request || details !== state.details) return;
    albumGuide.error = error.status === 404 ? viewFailure("errors.guide.server_outdated") : error;
  } finally {
    if (request === albumGuide.request) {
      albumGuide.loading = false; albumGuide.analysing = false; renderAlbumGuide();
      if (state.screen === "album") loadGuideAlbumNotes();
      if (typeof renderAlbumInformation === "function") renderAlbumInformation();
    }
  }
}

function guideAlbumCard(entry, shelf) {
  const albums = [...new Set(entry.album_ids.map(id => shelf.get(String(id))).filter(Boolean))];
  const a = albums[0], status = entry.manual ? entry.status === "found" ? "guide.status.linked" : "guide.status.linkedUnavailable"
    : {found: "guide.status.found", possible: "guide.status.possible", missing: "guide.status.missing"}[entry.status];
  const reference = `<span class="album-name">${escapeHtml(entry.album)}</span><span class="album-artist">${escapeHtml(entry.artist)}</span>`;
  return `<article class="album-card guide-card"><span class="guide-status ${entry.status === "possible" ? "guide-possible" : ""}">${status ? TagcastI18n.html(status) : ""}</span>
    ${a ? `<button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="${TagcastI18n.html("browse.albumCard.open", {name: a.name})}">${cover(a)}${reference}</button>`
      : `<div class="guide-missing">${cover({name: entry.album, artist: entry.artist, color: colors[(entry.id - 1) % colors.length]})}${reference}</div>`}
    <p class="guide-edition muted">${a && (a.name !== entry.album || a.artist !== entry.artist) ? TagcastI18n.html("guide.card.edition", {artist: a.artist, album: a.name}) : ""}</p>
    ${albums.length > 1 ? `<div class="guide-editions">${albums.map((album, i) => `<button class="text-action" data-album="${escapeHtml(album.id)}" title="${escapeHtml(album.artist)} · ${escapeHtml(album.name)} · ${album.year || TagcastI18n.html("guide.card.unknownYear")}">${album.year ? TagcastI18n.html("guide.card.editionYear", {number: i + 1, year: album.year}) : TagcastI18n.html("guide.card.editionNumber", {number: i + 1})}</button>`).join(" · ")}</div>` : ""}
    <div class="card-meta"><span>${entry.year} · #${entry.id}</span>${a && entry.status === "found" ? albumCardActions(a) : ""}</div>
    <div class="guide-link-actions"><button class="text-action" data-guide-link="${entry.id}">${TagcastI18n.html(entry.manual ? "guide.link.change" : entry.status === "possible" ? "guide.link.confirm" : "guide.link.choose")}</button>${entry.manual ? `<button class="text-action" data-guide-unlink="${entry.id}">${TagcastI18n.html("guide.link.undo")}</button>` : ""}</div></article>`;
}

function renderAlbumGuide() {
  if (state.screen !== "album-guide") return;
  if (albumGuide.enabled && live() && !state.loading && !albumGuide.loading && albumGuide.details !== state.details) { loadAlbumGuide(); return; }
  const data = albumGuide.data, ready = data?.state === "ready";
  $("#guide-analyse").disabled = !albumGuide.enabled || !live() || state.loading || albumGuide.loading || guideLink.busy;
  $("#guide-analyse").textContent = TagcastI18n.text(albumGuide.analysing ? "guide.analyse.running" : ready || data?.state === "stale" ? "guide.analyse.again" : "guide.analyse.start");
  $("#guide-toolbar").hidden = !ready;
  $("#guide-decades").hidden = !ready;
  $("#guide-matching-choice").hidden = !ready;
  applyGuideMatchingDisplay();
  $("#guide-search").value = albumGuide.query;
  $("#guide-filter").value = albumGuide.filter;
  $("#guide-per-page").value = String(albumGuide.pageSize);
  $("#guide-sort").value = albumGuide.sort;
  const decades = ready ? [...new Set(data.entries.map(e => Math.floor(e.year / 10) * 10))].sort((a, b) => a - b) : [];
  $("#guide-decades").innerHTML = ["all", ...decades.map(String)].map(value => `<button class="chip" data-guide-decade="${value}" aria-pressed="${albumGuide.decade === value}">${value === "all" ? TagcastI18n.html("guide.decades.all") : TagcastI18n.html("guide.decades.decade", {decade: value})}</button>`).join("");
  const count = value => Number(value || 0);
  $("#guide-results").textContent = ready ? TagcastI18n.text("guide.results", {found: count(data.counts.found), total: count(data.total), possible: count(data.counts.possible), missing: count(data.counts.missing)}) : "";
  $("#guide-note").textContent = TagcastI18n.text(!albumGuide.enabled ? "guide.note.disabled"
    : !live() ? "guide.note.connect"
    : state.loading ? "guide.note.waiting"
    : albumGuide.loading ? albumGuide.analysing ? "guide.note.analysing" : "guide.note.reading"
    : data?.state === "stale" ? "guide.note.stale"
    : ready ? "guide.note.ready"
    : "guide.note.idle");
  const words = foldText(albumGuide.query).split(" ").filter(Boolean);
  const rows = ready ? data.entries.filter(e => (albumGuide.filter === "all" || e.status === albumGuide.filter)
    && (albumGuide.decade === "all" || Math.floor(e.year / 10) * 10 === Number(albumGuide.decade))
    && words.every(w => foldText(`${e.album} ${e.artist} ${e.year}`).includes(w))) : [];
  rows.sort((a, b) => albumGuide.sort === "year-asc" ? a.year - b.year || a.id - b.id
    : albumGuide.sort === "year-desc" ? b.year - a.year || a.id - b.id : a.id - b.id);
  const max = Math.max(0, Math.ceil(rows.length / albumGuide.pageSize) - 1);
  albumGuide.page = Math.max(0, Math.min(albumGuide.page, max));
  const shelf = new Map(albumShelf().flatMap(a => itemIds(a).map(id => [id, a])));
  $("#guide-list").innerHTML = albumGuide.error ? `<p class="error-box" role="alert">${escapeHtml(TagcastI18n.errorText(albumGuide.error))}</p>`
    : albumGuide.loading || state.loading ? `<div class="empty" role="status"><span class="spinner"></span>${TagcastI18n.html("guide.list.wait")}</div>`
    : ready ? rows.length ? rows.slice(albumGuide.page * albumGuide.pageSize, (albumGuide.page + 1) * albumGuide.pageSize).map(e => guideAlbumCard(e, shelf)).join("")
      : `<div class="empty">${TagcastI18n.html("guide.list.empty")}</div>`
    : `<div class="empty">${!albumGuide.enabled ? `<button class="button" data-open-settings>${TagcastI18n.html("guide.list.openSettings")}</button>` : TagcastI18n.html("guide.list.idle")}</div>`;
  $("#guide-pagination").innerHTML = ready && max > 0 ? `<button class="button small" data-guide-page="-1" ${!albumGuide.page ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${TagcastI18n.html("common.pagination.page", {page: albumGuide.page + 1, pages: max + 1})}</span><button class="button small" data-guide-page="1" ${albumGuide.page === max ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button>` : "";
  if (typeof syncHistory === "function") syncHistory();
}

function showAlbumGuide(saved = {}) {
  albumGuide.query = saved.query ?? albumGuide.query;
  albumGuide.filter = ["found", "possible", "missing", "all"].includes(saved.filter) ? saved.filter : albumGuide.filter;
  if (saved.decade === "all" || /^\d{3}0$/.test(saved.decade || "")) albumGuide.decade = saved.decade;
  if (["list", "year-asc", "year-desc"].includes(saved.sort)) albumGuide.sort = saved.sort;
  albumGuide.page = Number.isInteger(saved.page) ? saved.page : albumGuide.page;
  showScreen("album-guide"); renderAlbumGuide(); window.scrollTo?.({top: 0});
}

$("#show-album-guide").addEventListener("click", () => showAlbumGuide());
$("#guide-analyse").addEventListener("click", () => loadAlbumGuide(true));
$("#guide-search").addEventListener("input", () => {
  albumGuide.query = $("#guide-search").value.slice(0, 200); albumGuide.page = 0; renderAlbumGuide();
});
$("#guide-filter").addEventListener("change", () => {
  const filter = $("#guide-filter").value;
  if (!["found", "possible", "missing", "all"].includes(filter)) return;
  albumGuide.filter = filter; albumGuide.page = 0; renderAlbumGuide();
});
$("#guide-per-page").addEventListener("change", () => {
  const size = Number($("#guide-per-page").value);
  if (![24, 48, 96].includes(size)) return;
  albumGuide.pageSize = size; albumGuide.page = 0; renderAlbumGuide();
});
$("#guide-sort").addEventListener("change", () => {
  const sort = $("#guide-sort").value;
  if (!["list", "year-asc", "year-desc"].includes(sort)) return;
  albumGuide.sort = sort; albumGuide.page = 0; renderAlbumGuide();
});
$("#guide-show-matching").addEventListener("change", async () => {
  guideDisplay.matching = $("#guide-show-matching").checked;
  guideDisplay.changed = true;
  applyGuideMatchingDisplay();
  try { localStorage.setItem("tagcast-guide-matching-details", guideDisplay.matching ? "visible" : "hidden"); }
  catch { /* The local server also saves the preference. */ }
  const visible = guideDisplay.matching;
  // Serialize rapid changes so the final choice is also the last saved value.
  const save = guideDisplay.pending.then(() => api("/api/settings", {guide_matching_details: visible}));
  guideDisplay.pending = save.catch(() => {});
  try {
    const data = await save;
    if (data.guide_matching_details !== visible) throw viewFailure("errors.guide.preference_outdated");
  } catch (error) {
    if (guideDisplay.matching === visible) toast(TagcastI18n.text("guide.display.saveFailed", {error: TagcastI18n.errorText(error)}));
  }
});
document.addEventListener("click", event => {
  if (event.target.closest("[data-guide-open]")) { showAlbumGuide(); }
  const page = event.target.closest("[data-guide-page]");
  if (page && !albumGuide.loading) { albumGuide.page += Number(page.dataset.guidePage); renderAlbumGuide(); scrollListingStart("#album-guide-page"); }
  const decade = event.target.closest("[data-guide-decade]");
  if (decade && (decade.dataset.guideDecade === "all" || /^\d{3}0$/.test(decade.dataset.guideDecade))) {
    albumGuide.decade = decade.dataset.guideDecade; albumGuide.page = 0; renderAlbumGuide();
    $("#guide-decades").querySelector(`[data-guide-decade="${albumGuide.decade}"]`)?.focus();
  }
  const link = event.target.closest("[data-guide-link]");
  if (link) openGuideLink(Number(link.dataset.guideLink), link);
  const unlink = event.target.closest("[data-guide-unlink]");
  if (unlink) saveGuideLink(Number(unlink.dataset.guideUnlink), []);
  const pick = event.target.closest("[data-guide-pick]");
  if (pick && guideLink.entry) {
    const album = albumShelf().find(a => String(a.id) === pick.dataset.guidePick);
    if (album) saveGuideLink(guideLink.entry.id, itemIds(album));
  }
});

function openGuideLink(id, focus) {
  if (albumGuide.loading || guideLink.busy || !albumGuide.enabled || !live() || state.loading
    || albumGuide.details !== state.details || albumGuide.data?.state !== "ready") return;
  const entry = albumGuide.data.entries.find(e => e.id === id);
  if (!entry) return;
  guideLink.entry = entry; guideLink.focus = focus || $("#guide-analyse");
  $("#guide-link-reference").textContent = `${entry.artist} · ${entry.album} (${entry.year})`;
  $("#guide-link-search").value = ""; $("#guide-link-error").textContent = "";
  renderGuideLink(); $("#guide-link-dialog").showModal(); $("#guide-link-search").focus();
}

function renderGuideLink() {
  syncSearchClearButtons();
  if (!guideLink.entry) return;
  const words = foldText($("#guide-link-search").value.slice(0, 200)).split(" ").filter(Boolean);
  const ids = new Set(guideLink.entry.album_ids);
  const rows = albumShelf().filter(a => words.length ? words.every(w => foldText(`${a.artist} ${a.name} ${a.year}`).includes(w))
    : itemIds(a).some(i => ids.has(i)));
  $("#guide-link-count").textContent = rows.length ? [TagcastI18n.text("browse.count.albums", {count: rows.length}),
    ...rows.length > 50 ? [TagcastI18n.text("guide.link.limited")] : []].join(" · ") : "";
  $("#guide-link-choices").innerHTML = rows.length ? rows.slice(0, 50).map(a => `<div class="guide-link-choice"><div><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.artist)} · ${albumCardMetadata(a)}</small></div><button class="button small" data-guide-pick="${escapeHtml(a.id)}" ${guideLink.busy ? "disabled" : ""}>${TagcastI18n.html("guide.link.use")}</button></div>`).join("")
    : `<p class="muted">${TagcastI18n.html(words.length ? "guide.link.noMatch" : "guide.link.prompt")}</p>`;
}

async function saveGuideLink(id, ids) {
  if (guideLink.busy || albumGuide.loading || !albumGuide.enabled || !live() || state.loading
    || albumGuide.details !== state.details || albumGuide.data?.state !== "ready") return;
  const entry = albumGuide.data.entries.find(e => e.id === id);
  if (!entry) return;
  const details = state.details, session = state.connection.playback_session, request = ++guideLink.request;
  guideLink.busy = true; $("#guide-link-error").textContent = ""; renderGuideLink(); renderAlbumGuide();
  try {
    const data = await api("/api/album-guide/link", {entry_id: id, album_ids: ids,
      before: entry.manual_ids || [], revision: albumGuide.data.revision, lastmodified: albumGuide.data.lastmodified});
    if (request !== guideLink.request || details !== state.details || session !== state.connection.playback_session
      || !albumGuide.enabled || !live()) return;
    albumGuide.data = data; resetGuideAlbumNotes(); $("#guide-link-dialog").close();
    toast(TagcastI18n.text(ids.length ? "guide.link.linked" : "guide.link.removed"));
  } catch (error) {
    if (request !== guideLink.request || details !== state.details || session !== state.connection.playback_session
      || !albumGuide.enabled || !live()) return;
    const message = TagcastI18n.errorText(error.status === 404 ? viewFailure("errors.guide.links_outdated") : error);
    $("#guide-link-error").textContent = message; toast(message);
  } finally {
    if (request === guideLink.request) { guideLink.busy = false; renderGuideLink(); renderAlbumGuide(); }
  }
}

$("#guide-link-search").addEventListener("input", renderGuideLink);
$("#guide-link-dialog").addEventListener("close", () => {
  guideLink.entry = null;
  if (guideLink.focus?.isConnected) guideLink.focus.focus();
  else if (state.screen === "album-guide" && albumGuide.enabled) $("#guide-analyse").focus();
  guideLink.focus = null;
});
updateAlbumGuideControls();

// A language change repaints the visible 1001 Albums page and the read-only matches of an open link
// dialog from memory. The dialog's search text is never touched.
TagcastI18n.subscribe(() => {
  if (state.screen === "album-guide"
      && !(albumGuide.enabled && live() && !state.loading && !albumGuide.loading && albumGuide.details !== state.details)) keepFocusWhile($("#album-guide-page"), renderAlbumGuide);
  if ($("#guide-link-dialog").open && guideLink.entry) keepFocusWhile($("#guide-link-choices"), renderGuideLink);
});

// The source line keeps the book's own title and link; only the sentence around it is translated.
function renderGuideSource() {
  const node = $("#guide-source");
  if (node) node.innerHTML = TagcastI18n.html("guide.intro.source", {book: TagcastI18n.trusted('<cite><a href="https://en.wikipedia.org/wiki/1001_Albums_You_Must_Hear_Before_You_Die" target="_blank" rel="noopener noreferrer">1001 Albums You Must Hear Before You Die</a></cite>')});
}
renderGuideSource();
TagcastI18n.subscribe(renderGuideSource);
