"use strict";

// A manually analysed listening list. Opening the page only reads a saved local report.
const albumGuide = {enabled: lookup.albumGuideEnabled === true, data: null, details: null, request: 0, loading: false,
  analysing: false, error: "", query: "", filter: "found", decade: "all", sort: "list", page: 0, pageSize: 24};
const guideLink = {entry: null, request: 0, busy: false, focus: null};
const guideDisplay = {matching: readGuideMatchingDisplay(), changed: false, pending: Promise.resolve()};
const guideNotes = {data: null, pending: null, error: false, open: new Set()};

function guideNoteEntries() {
  if (!albumGuide.enabled || !live() || albumGuide.details !== state.details || albumGuide.data?.state !== "ready") return [];
  const ids = new Set(shelfIds(albumView.id).map(String));
  return albumGuide.data.entries.filter(entry => entry.status === "found" && entry.album_ids.some(id => ids.has(String(id))));
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
    if (source.protocol !== "https:" || source.host !== "en.wikipedia.org" || !source.pathname.startsWith("/wiki/")
      || source.username || source.password || source.search || source.hash) continue;
    notes.set(note.id, {...note, source_url: source.href});
  }
  return notes;
}

function renderGuideAlbumNotes() {
  const panel = $("#album-guide-notes");
  if (!panel || state.screen !== "album") return;
  const entries = guideNoteEntries();
  const rows = entries.flatMap(entry => {
    const note = guideNotes.data?.get(entry.id);
    // A reference correction cannot attach a previously captured text to a new identity.
    return note && foldText(note.album) === foldText(entry.album) && foldText(note.artist) === foldText(entry.artist)
      ? [{entry, note}] : [];
  });
  panel.innerHTML = rows.map(({entry, note}) => `<details class="album-guide-note" data-guide-note="${entry.id}" ${guideNotes.open.has(entry.id) ? "open" : ""}><summary>About this album <span>1001 Albums${rows.length > 1 ? ` · ${escapeHtml(entry.album)}` : ""}</span></summary><div class="album-guide-note-copy">${note.context ? `<p class="muted">${escapeHtml(note.context)}</p>` : ""}<p>${escapeHtml(note.text)}</p><p class="muted">Adapted excerpt · <a href="${escapeHtml(note.source_url)}" target="_blank" rel="noopener noreferrer">Wikipedia contributors ↗</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a></p></div></details>`).join("")
    || (entries.length && guideNotes.error ? '<p class="muted">Album background could not be loaded. Refresh Tagcast to try again.</p>' : "");
  panel.hidden = !panel.innerHTML;
}

function loadGuideAlbumNotes() {
  if (state.screen !== "album" || !albumGuide.enabled || !live() || state.loading || !albumView.id) return;
  if (albumGuide.details !== state.details) {
    // Read only the saved local report. Opening an album never starts analysis.
    if (!albumGuide.loading) loadAlbumGuide();
    return;
  }
  if (!guideNoteEntries().length) { renderGuideAlbumNotes(); return; }
  if (guideNotes.data || guideNotes.error) { renderGuideAlbumNotes(); return; }
  if (guideNotes.pending) return;
  guideNotes.pending = api("/1001-album-notes.json").then(data => { guideNotes.data = readGuideNotes(data); })
    .catch(() => { guideNotes.error = true; })
    .finally(() => { guideNotes.pending = null; renderGuideAlbumNotes(); });
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

function resetAlbumGuide() {
  guideLink.request += 1; guideLink.busy = false;
  guideLink.entry = null; guideLink.focus = null;
  $("#guide-link-dialog").close();
  albumGuide.request += 1;
  Object.assign(albumGuide, {data: null, details: null, loading: false, analysing: false, error: ""});
  renderGuideAlbumNotes();
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
    albumGuide.error = error.status === 404 ? "Restart Tagcast to use 1001 Albums: the running server is older than this page." : error.message;
  } finally {
    if (request === albumGuide.request) {
      albumGuide.loading = false; albumGuide.analysing = false; renderAlbumGuide();
      if (state.screen === "album") loadGuideAlbumNotes();
    }
  }
}

function guideAlbumCard(entry, shelf) {
  const albums = [...new Set(entry.album_ids.map(id => shelf.get(String(id))).filter(Boolean))];
  const a = albums[0], status = entry.manual ? entry.status === "found" ? "Linked by you" : "Linked album unavailable"
    : {found: "In your library", possible: "Possible match", missing: "Not found"}[entry.status];
  const reference = `<span class="album-name">${escapeHtml(entry.album)}</span><span class="album-artist">${escapeHtml(entry.artist)}</span>`;
  return `<article class="album-card guide-card"><span class="guide-status ${entry.status === "possible" ? "guide-possible" : ""}">${status}</span>
    ${a ? `<button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="Open ${escapeHtml(a.name)}">${cover(a)}${reference}</button>`
      : `<div class="guide-missing">${cover({name: entry.album, artist: entry.artist, color: colors[(entry.id - 1) % colors.length]})}${reference}</div>`}
    <p class="guide-edition muted">${a && (a.name !== entry.album || a.artist !== entry.artist) ? `Your edition: ${escapeHtml(a.artist)} · ${escapeHtml(a.name)}` : ""}</p>
    ${albums.length > 1 ? `<div class="guide-editions">${albums.map((album, i) => `<button class="text-action" data-album="${escapeHtml(album.id)}" title="${escapeHtml(album.artist)} · ${escapeHtml(album.name)} · ${album.year || "Unknown year"}">Edition ${i + 1}${album.year ? ` (${album.year})` : ""}</button>`).join(" · ")}</div>` : ""}
    <div class="card-meta"><span>${entry.year} · #${entry.id}</span>${a && entry.status === "found" ? queueButton(a.id, null, true) : ""}</div>
    <div class="guide-link-actions"><button class="text-action" data-guide-link="${entry.id}">${entry.manual ? "Change link…" : entry.status === "possible" ? "Confirm match…" : "Choose album…"}</button>${entry.manual ? `<button class="text-action" data-guide-unlink="${entry.id}">Undo link</button>` : ""}</div></article>`;
}

function renderAlbumGuide() {
  if (state.screen !== "album-guide") return;
  if (albumGuide.enabled && live() && !state.loading && !albumGuide.loading && albumGuide.details !== state.details) { loadAlbumGuide(); return; }
  const data = albumGuide.data, ready = data?.state === "ready";
  $("#guide-analyse").disabled = !albumGuide.enabled || !live() || state.loading || albumGuide.loading || guideLink.busy;
  $("#guide-analyse").textContent = albumGuide.analysing ? "Analysing…" : ready || data?.state === "stale" ? "Analyse again" : "Analyse my library";
  $("#guide-toolbar").hidden = !ready;
  $("#guide-decades").hidden = !ready;
  $("#guide-matching-choice").hidden = !ready;
  applyGuideMatchingDisplay();
  $("#guide-search").value = albumGuide.query;
  $("#guide-filter").value = albumGuide.filter;
  $("#guide-per-page").value = String(albumGuide.pageSize);
  $("#guide-sort").value = albumGuide.sort;
  const decades = ready ? [...new Set(data.entries.map(e => Math.floor(e.year / 10) * 10))].sort((a, b) => a - b) : [];
  $("#guide-decades").innerHTML = ["all", ...decades.map(String)].map(value => `<button class="chip" data-guide-decade="${value}" aria-pressed="${albumGuide.decade === value}">${value === "all" ? "All decades" : `${value}s`}</button>`).join("");
  $("#guide-results").textContent = ready ? `${fmt(data.counts.found)} of ${fmt(data.total)} albums found · ${fmt(data.counts.possible)} possible · ${fmt(data.counts.missing)} not found` : "";
  $("#guide-note").textContent = !albumGuide.enabled ? "Enable 1001 Albums in Settings to show this section."
    : !live() ? "Connect iBroadcast and load your library to analyse your collection."
    : state.loading ? "Waiting for your library to load…"
    : albumGuide.loading ? albumGuide.analysing ? "Comparing album titles and artists locally. Your library is unchanged." : "Reading your saved analysis…"
    : data?.state === "stale" ? "Your library or the reference list has changed. Analyse again to update the results."
    : ready ? "Analysis saved on this computer. Matches compare album metadata; they do not confirm that every track is present. Possible matches do not count as found."
    : "Analysis runs only when you press Analyse my library. No music files are scanned and nothing is sent to iBroadcast.";
  const words = foldText(albumGuide.query).split(" ").filter(Boolean);
  const rows = ready ? data.entries.filter(e => (albumGuide.filter === "all" || e.status === albumGuide.filter)
    && (albumGuide.decade === "all" || Math.floor(e.year / 10) * 10 === Number(albumGuide.decade))
    && words.every(w => foldText(`${e.album} ${e.artist} ${e.year}`).includes(w))) : [];
  rows.sort((a, b) => albumGuide.sort === "year-asc" ? a.year - b.year || a.id - b.id
    : albumGuide.sort === "year-desc" ? b.year - a.year || a.id - b.id : a.id - b.id);
  const max = Math.max(0, Math.ceil(rows.length / albumGuide.pageSize) - 1);
  albumGuide.page = Math.max(0, Math.min(albumGuide.page, max));
  const shelf = new Map(albumShelf().flatMap(a => itemIds(a).map(id => [id, a])));
  $("#guide-list").innerHTML = albumGuide.error ? `<p class="error-box" role="alert">${escapeHtml(albumGuide.error)}</p>`
    : albumGuide.loading || state.loading ? '<div class="empty" role="status"><span class="spinner"></span>Please wait…</div>'
    : ready ? rows.length ? rows.slice(albumGuide.page * albumGuide.pageSize, (albumGuide.page + 1) * albumGuide.pageSize).map(e => guideAlbumCard(e, shelf)).join("")
      : '<div class="empty">No albums match this selection.</div>'
    : `<div class="empty">${!albumGuide.enabled ? '<button class="button" data-open-settings>Open Settings</button>' : "Run an analysis to discover which albums from the list are in your collection."}</div>`;
  $("#guide-pagination").innerHTML = ready && max > 0 ? `<button class="button small" data-guide-page="-1" ${!albumGuide.page ? "disabled" : ""}>← Previous</button><span>Page ${albumGuide.page + 1} of ${max + 1}</span><button class="button small" data-guide-page="1" ${albumGuide.page === max ? "disabled" : ""}>Next →</button>` : "";
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
    if (data.guide_matching_details !== visible) throw Error("Restart Tagcast to save this preference.");
  } catch (error) {
    if (guideDisplay.matching === visible) toast(`Display changed, but could not remember it on this computer: ${error.message}`);
  }
});
document.addEventListener("click", event => {
  if (event.target.closest("[data-guide-open]")) { $("#settings").close(); showAlbumGuide(); }
  const page = event.target.closest("[data-guide-page]");
  if (page && !albumGuide.loading) { albumGuide.page += Number(page.dataset.guidePage); renderAlbumGuide(); }
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
  if (!guideLink.entry) return;
  const words = foldText($("#guide-link-search").value.slice(0, 200)).split(" ").filter(Boolean);
  const ids = new Set(guideLink.entry.album_ids);
  const rows = albumShelf().filter(a => words.length ? words.every(w => foldText(`${a.artist} ${a.name} ${a.year}`).includes(w))
    : itemIds(a).some(i => ids.has(i)));
  $("#guide-link-count").textContent = rows.length ? `${fmt(rows.length)} ${rows.length === 1 ? "album" : "albums"}${rows.length > 50 ? " · showing the first 50; refine your search" : ""}` : "";
  $("#guide-link-choices").innerHTML = rows.length ? rows.slice(0, 50).map(a => `<div class="guide-link-choice"><div><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.artist)} · ${albumCardMetadata(a)}</small></div><button class="button small" data-guide-pick="${escapeHtml(a.id)}" ${guideLink.busy ? "disabled" : ""}>Use this album</button></div>`).join("")
    : `<p class="muted">${words.length ? "No albums match. Try a shorter title or artist name." : "Search your library by album title or artist to choose a match."}</p>`;
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
    albumGuide.data = data; $("#guide-link-dialog").close();
    toast(ids.length ? "Album linked locally. Your iBroadcast library is unchanged." : "Manual link removed. Automatic analysis is unchanged.");
  } catch (error) {
    if (request !== guideLink.request || details !== state.details || session !== state.connection.playback_session
      || !albumGuide.enabled || !live()) return;
    const message = error.status === 404 ? "Restart Tagcast, then reload this page. The running server does not support manual album links yet." : error.message;
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
