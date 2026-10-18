"use strict";

// CSV contents stay local. Matching and choices never write music metadata or play audio.
const csvImport = {request: 0, data: null, details: null, session: "", busy: false,
  name: "", description: "", fileData: null, mapping: null, durationUnit: "seconds", artistSeparator: "", show: "all", offset: 0, resolving: null, search: null, submitted: false};
const csvFields = {title: "Track title (required)", artist: "Performing artist (required)",
  album: "Album title", album_artist: "Album artist", duration: "Duration", year: "Release year / date", track: "Track number"};

function csvImportCurrent(request = csvImport.request) {
  return request === csvImport.request && csvImport.details === state.details
    && csvImport.session === state.connection.playback_session && live() && $("#playlist-import").open;
}

function resetPlaylistImport() {
  csvImport.request += 1; csvImport.data = null; csvImport.busy = false;
  csvImport.resolving = null; csvImport.search = null; csvImport.fileData = null; csvImport.mapping = null;
  csvImport.name = ""; csvImport.description = "";
  $("#playlist-import").close(); $("#csv-import-content").innerHTML = ""; $("#csv-import-status").textContent = "";
}

function openPlaylistImport() {
  if (!live() || state.loading || collectionsView.busy || saving || checking || document.querySelector("dialog[open]")) return;
  Object.assign(csvImport, {request: csvImport.request + 1, data: null, details: state.details,
    session: state.connection.playback_session, busy: false, name: "", description: "", show: "all", offset: 0,
    resolving: null, search: null, submitted: false, fileData: null, mapping: null});
  $("#csv-import-status").textContent = "";
  $("#csv-import-content").innerHTML = `<p>Choose a CSV and link its columns to track information. Matching uses your loaded library. You will review every selection before creating a new private playlist.</p>
    <form id="csv-file-form"><label>CSV file <input type="file" name="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label>
    <div class="csv-import-fields"><label>Separator <select name="delimiter"><option value="auto">Detect automatically</option><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value="&#9;">Tab</option><option value="|">Pipe (|)</option></select></label>
    <label>Text encoding <select name="encoding"><option value="auto">UTF-8 / Unicode BOM</option><option value="windows-1252">Windows-1252</option><option value="utf-16le">UTF-16 little endian</option><option value="utf-16be">UTF-16 big endian</option></select></label></div>
    <details><summary>Or paste CSV / tab-separated text</summary><label>CSV text <textarea name="pasted" rows="6" placeholder="Title,Artist&#10;Song,Artist"></textarea></label><p class="muted">When filled, this text is used instead of the file.</p></details><label class="checkline"><input type="checkbox" name="header" checked> First record contains column headings</label><p class="muted">Closing cancels this local draft. Drafts expire after one hour. Up to 5 MB, 10,000 data records and 100 columns. Quoted commas and multiline cells are supported. CSV cells are treated as text.</p>
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">Cancel</button><button class="button primary">Read CSV →</button></div></form>`;
  $("#playlist-import").showModal();
}

function csvImportWorking(busy, message = "") {
  csvImport.busy = busy;
  $("#csv-import-status").textContent = message;
  for (const element of $("#csv-import-content").querySelectorAll("input, select, textarea, button")) {
    if (!element.hasAttribute("data-close")) {
      if (busy) { element.dataset.csvWasDisabled = String(element.disabled); element.disabled = true; }
      else { element.disabled = element.dataset.csvWasDisabled === "true"; delete element.dataset.csvWasDisabled; }
    }
  }
}

async function csvImportCall(action, fields = {}, apply = renderCsvMatches) {
  if (!csvImportCurrent() || csvImport.busy || csvImport.submitted) return;
  const request = ++csvImport.request, data = csvImport.data;
  csvImportWorking(true, action === "match" ? "Matching against the loaded library…" : "Preparing…");
  try {
    const response = await api(`/api/playlist-import/${action}`, {session: csvImport.session,
      ...(data ? {id: data.id, revision: data.revision} : {}), ...fields});
    if (!csvImportCurrent(request)) return;
    csvImportWorking(false); apply(response);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

async function readPlaylistCsv(form) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const pasted = form.elements.pasted?.value || "", file = form.elements.file.files?.[0];
  if (pasted.trim()) {
    if (new TextEncoder().encode(pasted).length > 5 * 1024 * 1024) { $("#csv-import-status").textContent = "Use CSV text up to 5 MB."; return; }
    csvImport.name ||= "Imported playlist";
    return csvImportCall("read", {text: pasted, delimiter: form.elements.delimiter.value, header: form.elements.header.checked}, renderCsvMapping);
  }
  if (!file || file.size > 5 * 1024 * 1024) { $("#csv-import-status").textContent = "Choose a CSV file up to 5 MB."; return; }
  const request = ++csvImport.request, encoding = form.elements.encoding.value;
  const delimiter = form.elements.delimiter.value, header = form.elements.header.checked;
  csvImportWorking(true, "Reading CSV…");
  try {
    const buffer = await file.arrayBuffer();
    if (!csvImportCurrent(request)) return;
    const bytes = new Uint8Array(buffer);
    const detected = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
    let content;
    try { content = new TextDecoder(encoding === "auto" ? detected : encoding, {fatal: true}).decode(bytes); }
    catch { throw Error("The text encoding could not be read. Try Windows-1252 or the correct Unicode encoding."); }
    csvImport.name = file.name.replace(/\.(csv|tsv)$/i, "").slice(0, 200);
    csvImportWorking(false);
    await csvImportCall("read", {text: content, delimiter, header}, renderCsvMapping);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

function renderCsvMapping(data) {
  csvImport.data = data; csvImport.fileData = data;
  const options = chosen => '<option value="">Choose / do not use</option>' + data.columns.map((name, i) => `<option value="${i}" ${chosen === i ? "selected" : ""}>${i + 1}. ${escapeHtml(name || "(unnamed)")}</option>`).join("");
  const unit = data.duration_unit || (/\bms\b|milli/i.test(data.columns[data.mapping.duration] || "") ? "milliseconds" : "seconds");
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">1. Link columns</h3><p>${data.total} data records · ${data.blank_records} blank records omitted. Confirm the suggested columns using the preview.</p>
    <form id="csv-map-form"><div class="csv-import-fields">${Object.entries(csvFields).map(([key, label]) => `<label>${label}<select name="map_${key}" ${["title", "artist"].includes(key) ? "required" : ""}>${options(data.mapping[key])}</select></label>`).join("")}
    <label>Numeric duration unit <select name="duration_unit"><option value="seconds" ${unit === "seconds" ? "selected" : ""}>Seconds</option><option value="milliseconds" ${unit === "milliseconds" ? "selected" : ""}>Milliseconds</option></select></label>
    <label>Names inside an artist cell <select name="artist_separator"><option value="">Keep as one name</option><option value=";" ${data.artist_separator === ";" ? "selected" : ""}>Separate names on semicolons (;)</option></select></label></div>
    <p class="muted">Title and performing artist are required. Durations also accept mm:ss or hh:mm:ss. Optional album, album artist, duration, year and track number help distinguish copies. Version text is retained; live, remix and other title differences need a manual choice. Spotify links and ISRCs are not used.</p>
    <div class="table-scroll"><table><thead><tr>${data.columns.map((name, i) => `<th>${i + 1}. ${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${data.sample.map(row => `<tr>${row.cells.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">Cancel</button><button class="button primary">Match tracks →</button></div></form>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function csvTrackDetails(track) {
  const performers = track.performers?.map(p => p.name).join(" · ") || track.artist;
  return `<strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(performers)}</span><small>${escapeHtml(track.album)} · ${escapeHtml(track.album_artist || "")} · ${track.year || "Unknown year"} · ${trackDuration(track.length)}${track.format ? ` · ${escapeHtml(track.format)}` : ""} · Disc ${track.disc || "?"}, track ${track.track || "?"} · ID ${escapeHtml(track.id)}</small>`;
}

function csvImportSummary(summary) {
  return `<p class="csv-import-summary">${summary.automatic} automatic · ${summary.manual} manually chosen · <strong>${summary.unresolved} unresolved</strong> · ${summary.skipped} skipped</p><p class="muted">${summary.unique} distinct tracks. ${summary.duplicates} repeated selections will be kept once, in their first CSV position. ${summary.blank_records} blank CSV records omitted.</p>`;
}

function csvImportPagination(total, offset, kind) {
  return `<div class="pagination"><button type="button" class="button small" data-csv-page="${kind}" data-offset="${Math.max(0, offset - 50)}" ${offset === 0 ? "disabled" : ""}>← Previous</button><span>${total ? offset + 1 : 0}–${Math.min(offset + 50, total)} of ${total}</span><button type="button" class="button small" data-csv-page="${kind}" data-offset="${offset + 50}" ${offset + 50 >= total ? "disabled" : ""}>Next →</button></div>`;
}

function csvSource(row) {
  const source = row.source;
  return `<div class="csv-source"><strong>CSV ${row.position + 1} (line ${row.line}): ${escapeHtml(source.title || "Missing title")}</strong><span>${escapeHtml(source.artist || "Missing artist")}</span><small>${escapeHtml(source.album)}${source.duration ? ` · ${escapeHtml(source.duration)}` : ""}${source.year ? ` · ${escapeHtml(source.year)}` : ""}</small>${source.warnings.map(w => `<p class="warn-box">${escapeHtml(w)}</p>`).join("")}</div>`;
}

function renderCsvMatches(data) {
  csvImport.data = data; csvImport.resolving = null; csvImport.search = null;
  csvImport.offset = data.offset; csvImport.show = data.show;
  const labels = {automatic: "Automatic match", manual: "Manually chosen", skipped: "Skipped", ambiguous: "Choose a track", missing: "No suggested match"};
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">2. Check matches</h3>${csvImportSummary(data.summary)}
    <label>Show <select id="csv-import-filter">${["all", "unresolved", "automatic", "manual", "skipped"].map(key => `<option value="${key}" ${data.show === key ? "selected" : ""}>${{all: "All CSV records", unresolved: "Unresolved records", automatic: "Automatic matches", manual: "Manual choices", skipped: "Skipped records"}[key]}</option>`).join("")}</select></label>
    <div class="csv-import-rows">${data.rows.map(row => `<section class="csv-import-row">${csvSource(row)}<div class="csv-match"><small>${labels[row.status]}</small>${row.choice ? csvTrackDetails(row.choice) : '<p class="muted">No track selected.</p>'}<div><button type="button" class="button small" data-csv-resolve="${row.position}">${row.choice ? "Change match…" : "Find / choose a track…"}</button>${row.status !== "skipped" ? `<button type="button" class="text-action" data-csv-skip="${row.position}">Skip this CSV record</button>` : ""}</div></div></section>`).join("") || '<p class="muted">No records in this filter.</p>'}</div>${csvImportPagination(data.total, data.offset, "matches")}
    <button type="button" class="text-action" data-csv-columns>Change columns (resets matches)…</button><form id="csv-review-form"><h3 tabindex="-1">3. Prepare playlist review</h3><label>New private playlist name <input name="name" id="csv-playlist-name" maxlength="200" value="${escapeHtml(csvImport.name)}" required></label><label>Description <textarea name="description" id="csv-playlist-description" maxlength="2000">${escapeHtml(csvImport.description)}</textarea></label>
    <p>Resolve or explicitly skip every record. Chosen tracks keep their CSV order.</p><div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">Cancel</button><button class="button primary" ${data.summary.unresolved || !data.summary.unique ? "disabled" : ""}>Prepare playlist review →</button></div></form>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function renderCsvResolver(position) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const row = csvImport.data.rows.find(r => r.position === position);
  if (!row) return;
  csvImport.resolving = row; csvImport.search = null;
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">Choose a library track</h3>${csvSource(row)}<p class="muted">Compare the full title, performer, album and duration. Suggestions are alternatives, not confirmed matches. Search below for other library copies.</p>
    <h4>Suggestions (up to 10)</h4><div class="csv-candidates">${row.candidates.map(csvCandidate).join("") || '<p class="muted">No suggestions. Search your library below.</p>'}</div>
    <form id="csv-search-form"><label>Search loaded library <input name="query" maxlength="200" value="${escapeHtml(row.source.title)}" placeholder="Part of a title, artist or album"></label><button class="button">Search</button></form><div id="csv-search-results"></div>
    <div class="dialog-footer"><button type="button" class="button" data-csv-matches>← Back to matches</button><button type="button" class="button" data-csv-skip="${position}">Skip this CSV record</button></div>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function csvCandidate(track) {
  return `<div class="csv-candidate"><div>${csvTrackDetails(track)}</div><button type="button" class="button small" data-csv-choose="${escapeHtml(track.id)}">Use this track</button></div>`;
}

function renderCsvSearch(data, query) {
  csvImport.search = {...data, query};
  $("#csv-search-results").innerHTML = `<p>${data.total} library matches</p><div class="csv-candidates">${data.tracks.map(csvCandidate).join("") || '<p class="muted">No matches. Try fewer words or a different spelling.</p>'}</div>${csvImportPagination(data.total, data.offset, "search")}`;
}

function renderCsvReview(data) {
  csvImport.data = data; csvImport.resolving = null;
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">3. Review new private playlist</h3><h4>${escapeHtml(data.name)}</h4><p class="csv-description">${escapeHtml(data.description)}</p>${csvImportSummary(data.summary)}
    <p>Create a new private playlist with ${data.total} tracks in this order. Skipped records are omitted. Existing playlists and music metadata stay unchanged.</p><ol class="csv-review-list" start="${data.offset + 1}">${data.tracks.map(track => `<li>${csvTrackDetails(track)}</li>`).join("")}</ol>${csvImportPagination(data.total, data.offset, "review")}
    <div class="dialog-footer"><button type="button" class="button" data-csv-revise>← Back to matches</button><button type="button" class="button primary" data-csv-save>Create private playlist in iBroadcast</button></div>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

async function saveCsvPlaylist() {
  if (!csvImportCurrent() || csvImport.busy || csvImport.submitted || csvImport.data?.phase !== "review" || collectionsView.busy) return;
  const request = ++csvImport.request, data = csvImport.data;
  csvImport.submitted = true; collectionsView.busy = true; csvImportWorking(true, "Creating playlist and checking iBroadcast…");
  try {
    const response = await api("/api/playlist-import/save", {id: data.id, revision: data.revision,
      session: csvImport.session, review_token: data.review_token, approved: true});
    const result = await collectionJob(response, () => csvImportCurrent(request));
    if (result.results?.length !== 1 || result.results[0].id !== response.id || result.results[0].status !== "saved") throw Error("The playlist was sent, but read-back differs.");
    if (!csvImportCurrent(request)) return;
    $("#playlist-import").close(); toast("Imported playlist confirmed in iBroadcast.");
    showCollections("playlists", response.id);
  } catch (error) {
    if (csvImportCurrent(request)) {
      $("#csv-import-status").textContent = `Check Playlists before importing again: ${error.message}`;
      $("#csv-import-content").innerHTML = '<p>This import cannot be sent again. Close this window and check Playlists. If the playlist is present, use it rather than creating another copy.</p><button type="button" class="button" data-close="playlist-import">Close</button>';
    }
  } finally { collectionsView.busy = false; }
}

document.addEventListener("submit", event => {
  const form = event.target;
  if (form.id === "csv-file-form") { event.preventDefault(); return readPlaylistCsv(form); }
  if (form.id === "csv-map-form") {
    event.preventDefault();
    const mapping = Object.fromEntries(Object.keys(csvFields).map(key => [key, form.elements[`map_${key}`].value === "" ? null : Number(form.elements[`map_${key}`].value)]));
    csvImport.mapping = mapping; csvImport.durationUnit = form.elements.duration_unit.value; csvImport.artistSeparator = form.elements.artist_separator.value;
    return csvImportCall("match", {mapping, duration_unit: form.elements.duration_unit.value, artist_separator: form.elements.artist_separator.value});
  }
  if (form.id === "csv-review-form") {
    event.preventDefault(); csvImport.name = form.elements.name.value; csvImport.description = form.elements.description.value;
    return csvImportCall("review", {name: csvImport.name, description: csvImport.description}, renderCsvReview);
  }
  if (form.id === "csv-search-form") {
    event.preventDefault(); const query = form.elements.query.value.trim();
    return csvImportCall("search", {query, offset: 0}, data => renderCsvSearch(data, query));
  }
});
document.addEventListener("input", event => {
  if (event.target.id === "csv-playlist-name") csvImport.name = event.target.value;
  if (event.target.id === "csv-playlist-description") csvImport.description = event.target.value;
});
document.addEventListener("change", event => {
  if (event.target.id === "csv-import-filter") return csvImportCall("view", {show: event.target.value, offset: 0});
});
document.addEventListener("click", event => {
  const target = event.target;
  if (target.closest("[data-csv-import]")) return openPlaylistImport();
  if (target.closest("[data-csv-columns]") && csvImportCurrent() && !csvImport.busy && csvImport.fileData) {
    const data = {...csvImport.fileData, id: csvImport.data.id, revision: csvImport.data.revision, mapping: csvImport.mapping, duration_unit: csvImport.durationUnit, artist_separator: csvImport.artistSeparator};
    return renderCsvMapping(data);
  }
  const resolver = target.closest("[data-csv-resolve]");
  if (resolver) return renderCsvResolver(Number(resolver.dataset.csvResolve));
  const skip = target.closest("[data-csv-skip]");
  if (skip) return csvImportCall("choose", {position: Number(skip.dataset.csvSkip), skip: true, show: csvImport.show, offset: csvImport.offset});
  const choice = target.closest("[data-csv-choose]");
  if (choice && csvImport.resolving) return csvImportCall("choose", {position: csvImport.resolving.position, track_id: choice.dataset.csvChoose, show: csvImport.show, offset: csvImport.offset});
  if (target.closest("[data-csv-matches]")) return renderCsvMatches(csvImport.data);
  if (target.closest("[data-csv-revise]")) return csvImportCall("revise");
  if (target.closest("[data-csv-save]")) return saveCsvPlaylist();
  const page = target.closest("[data-csv-page]");
  if (page) {
    const offset = Number(page.dataset.offset), kind = page.dataset.csvPage;
    if (kind === "search") return csvImportCall("search", {offset, query: csvImport.search.query}, data => renderCsvSearch(data, csvImport.search.query));
    return csvImportCall("view", {offset, show: csvImport.show, review: kind === "review"}, kind === "review" ? renderCsvReview : renderCsvMatches);
  }
});
$("#playlist-import").addEventListener("close", () => {
  const data = csvImport.data, session = csvImport.session;
  resetPlaylistImport();
  if (data && live() && session === state.connection.playback_session) api("/api/playlist-import/discard", {id: data.id, session}).catch(() => {});
});
