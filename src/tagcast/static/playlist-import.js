"use strict";

// CSV contents stay local. Matching and choices never write music metadata or play audio.
const csvImport = {request: 0, data: null, details: null, session: "", busy: false,
  name: "", description: "", fileData: null, mapping: null, durationUnit: "seconds", artistSeparator: "", show: "unresolved", offset: 0, resolving: null, search: null, submitted: false, createdPlaylist: null};
const csvFields = {title: "Track title (required)", artist: "Performing artist (required)",
  album: "Album title", album_artist: "Album artist", duration: "Duration", year: "Release year / date", track: "Track number"};
const csvCloseReview = {request: null, focus: null};
const csvPausedView = {rows: [], removing: null};

function syncCsvPauseButton() {
  $("#csv-import-pause").hidden = !csvImport.data || csvImport.submitted;
  $("#csv-import-pause").disabled = csvImport.busy;
}

async function pausePlaylistImport() {
  if (!csvImportCurrent() || !csvImport.data || csvImport.busy || csvImport.submitted) return;
  const request = ++csvImport.request, data = csvImport.data, form = $("#csv-map-form");
  const mapping = form ? Object.fromEntries(Object.keys(csvFields).map(key => [key, form.elements[`map_${key}`].value === "" ? null : Number(form.elements[`map_${key}`].value)])) : csvImport.mapping || csvImport.fileData.mapping;
  const fields = {name: $("#csv-playlist-name")?.value ?? (csvImport.name || "Imported playlist"),
    description: $("#csv-playlist-description")?.value ?? csvImport.description, mapping, mapping_step: Boolean(form),
    duration_unit: form?.elements.duration_unit.value || csvImport.durationUnit,
    artist_separator: form?.elements.artist_separator.value ?? csvImport.artistSeparator,
    show: csvImport.show, offset: csvImport.offset};
  csvImportWorking(true, "Saving this import locally…");
  try {
    await api("/api/playlist-import/pause", {id: data.id, revision: data.revision, session: csvImport.session, ...fields});
    if (!csvImportCurrent(request)) return;
    csvImport.data = null; $("#playlist-import").close();
    toast("Import paused and saved locally. Continue from Playlists → Paused imports.");
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

function renderPausedImports() {
  const rows = csvPausedView.rows;
  $("#csv-import-content").innerHTML = `<p>${rows.length} / 10 saved imports for this account. These local copies survive restarting Tagcast (64 MB total per account). Resuming refreshes the library and checks matches again; it does not create a playlist.</p>${rows.map(row => `<section class="history-item"><h3>${escapeHtml(row.name)}</h3><p>${row.total} CSV records · ${row.manual} manual ${row.manual === 1 ? "choice" : "choices"} · ${row.phase === "mapping" ? "Columns not matched yet" : `${row.unresolved} unresolved`} · Saved ${escapeHtml(new Date(row.saved_at * 1000).toLocaleString())}</p>${row.state === "submitted" ? '<p class="warn-box">Creation may already have been sent. Check Playlists before importing again; this saved copy cannot be sent again.</p>' : ""}${csvPausedView.removing === row.id ? `<p class="warn-box">Remove this saved import? Its local CSV and choices will be discarded. Existing playlists and music stay unchanged.</p><div class="dialog-footer"><button type="button" class="button primary" data-csv-remove-cancel>Keep saved import</button><button type="button" class="button danger" data-csv-remove-confirm="${escapeHtml(row.id)}">Remove saved import</button></div>` : `<div class="dialog-footer">${row.state === "paused" ? `<button type="button" class="button primary" data-csv-resume="${escapeHtml(row.id)}">Refresh library & resume</button>` : row.playlist ? `<button type="button" class="button" data-csv-open-created="${escapeHtml(row.playlist)}">Open playlist</button>` : ""}<button type="button" class="button danger" data-csv-remove-paused="${escapeHtml(row.id)}">Remove…</button></div>`}</section>`).join("") || '<p class="muted">No paused imports. Read a CSV, then choose Pause import to save your progress.</p>'}`;
}

async function openPausedImports() {
  if (!live() || state.loading || document.querySelector("dialog[open]")) return;
  openPlaylistImport();
  if (!csvImportCurrent()) return;
  const request = ++csvImport.request;
  $("#csv-import-title").textContent = "Paused imports";
  $("#csv-import-content").innerHTML = "";
  csvImportWorking(true, "Reading saved imports…");
  try {
    const result = await api("/api/playlist-import/paused", {session: csvImport.session});
    if (!csvImportCurrent(request)) return;
    csvPausedView.rows = result.imports; csvPausedView.removing = null;
    csvImportWorking(false); renderPausedImports();
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

async function resumePausedImport(saved) {
  if (!csvImportCurrent() || csvImport.busy || saved.state !== "paused") return;
  const session = csvImport.session;
  $("#playlist-import").close();
  const loading = loadLive(), generation = libraryLoadRequest;
  await loading;
  if (generation !== libraryLoadRequest || session !== state.connection.playback_session || !live() || state.loading || document.querySelector("dialog[open]")) return;
  openPlaylistImport();
  const request = ++csvImport.request;
  csvImportWorking(true, "Rechecking the saved import against your refreshed library…");
  try {
    const result = await api("/api/playlist-import/resume", {saved_id: saved.id, saved_token: saved.token, session});
    if (!csvImportCurrent(request)) return;
    Object.assign(csvImport, {name: result.name, description: result.description, fileData: result.file,
      mapping: result.mapping, durationUnit: result.duration_unit, artistSeparator: result.artist_separator});
    csvImportWorking(false);
    if (result.view.phase === "mapping") renderCsvMapping(result.view); else renderCsvMatches(result.view);
    setActionStatus("#csv-import-status", "Resumed. Matches were checked again; unchanged manual choices and skipped records were kept.");
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, `The saved copy is still available: ${error.message}`); }
}

async function removePausedImport(saved) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const request = ++csvImport.request;
  csvImportWorking(true, "Removing the local saved import…");
  try {
    await api("/api/playlist-import/remove-paused", {saved_id: saved.id, saved_token: saved.token, session: csvImport.session});
    if (!csvImportCurrent(request)) return;
    csvPausedView.rows = csvPausedView.rows.filter(row => row.id !== saved.id); csvPausedView.removing = null;
    csvImportWorking(false); renderPausedImports();
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

function csvImportCurrent(request = csvImport.request) {
  return request === csvImport.request && csvImport.details === state.details
    && csvImport.session === state.connection.playback_session && live() && $("#playlist-import").open;
}

function requestClosePlaylistImport() {
  if (!$("#playlist-import").open || $("#csv-import-discard").open) return;
  const form = $("#csv-file-form");
  const progress = csvImport.data || csvImport.busy || form?.elements.file?.files?.length
    || form?.elements.pasted?.value?.trim();
  if (csvImportCurrent() && progress && (!csvImport.submitted || csvImport.busy)) {
    csvCloseReview.request = csvImport.request; csvCloseReview.focus = document.activeElement;
    $("#csv-discard-title").textContent = csvImport.submitted ? "Close this import?" : "Discard this import?";
    $("#csv-discard-message").textContent = csvImport.submitted
      ? "Playlist creation is still running. Closing this window does not cancel it. Wait here for the result, or check Playlists before importing again."
      : "Your unsaved column mapping, matches and manual choices will be lost. Choose Keep importing to pause and save them first.";
    $("#csv-discard-confirm").textContent = csvImport.submitted ? "Close import" : "Discard import";
    $("#csv-import-discard").showModal(); $("#csv-discard-keep").focus();
    return;
  }
  $("#playlist-import").close();
}

function resetPlaylistImport() {
  $("#csv-import-discard").close();
  csvImport.request += 1; csvImport.data = null; csvImport.busy = false;
  csvImport.resolving = null; csvImport.search = null; csvImport.fileData = null; csvImport.mapping = null;
  csvImport.name = ""; csvImport.description = "";
  csvImport.createdPlaylist = null;
  csvPausedView.rows = []; csvPausedView.removing = null; syncCsvPauseButton();
  $("#playlist-import").close(); $("#csv-import-content").innerHTML = ""; setActionStatus("#csv-import-status", "");
}

function openPlaylistImport() {
  if (!live() || state.loading || collectionsView.busy || saving || checking || document.querySelector("dialog[open]")) return;
  Object.assign(csvImport, {request: csvImport.request + 1, data: null, details: state.details,
    session: state.connection.playback_session, busy: false, name: "", description: "", show: "unresolved", offset: 0,
    resolving: null, search: null, submitted: false, fileData: null, mapping: null, createdPlaylist: null});
  setActionStatus("#csv-import-status", "");
  $("#csv-import-title").textContent = "Import a playlist"; syncCsvPauseButton();
  $("#csv-import-content").innerHTML = `<p>Choose a CSV and link its columns to track information. Matching uses your loaded library. You will review every selection before creating a new private playlist.</p>
    <form id="csv-file-form"><label>CSV file <input type="file" name="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label>
    <div class="csv-import-fields"><label>Separator <select name="delimiter"><option value="auto">Detect automatically</option><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value="&#9;">Tab</option><option value="|">Pipe (|)</option></select></label>
    <label>Text encoding <select name="encoding"><option value="auto">UTF-8 / Unicode BOM</option><option value="windows-1252">Windows-1252</option><option value="utf-16le">UTF-16 little endian</option><option value="utf-16be">UTF-16 big endian</option></select></label></div>
    <details><summary>Or paste CSV / tab-separated text</summary><label>CSV text <textarea name="pasted" rows="6" placeholder="Title,Artist&#10;Song,Artist"></textarea></label><p class="muted">When filled, this text is used instead of the file.</p></details><label class="checkline"><input type="checkbox" name="header" checked> First record contains column headings</label><p class="muted">Closing discards unsaved progress. After reading, Pause import saves a local copy for later. Unsaved drafts expire after one hour. Up to 5 MB, 10,000 data records and 100 columns. Tagcast unresolved CSV exports can be re-imported up to 12 MB. Quoted commas and multiline cells are supported. CSV cells are treated as text.</p>
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">Cancel</button><button class="button primary">Read CSV →</button></div></form>`;
  $("#playlist-import").showModal();
}

function csvImportWorking(busy, message = "") {
  csvImport.busy = busy;
  syncCsvPauseButton();
  setActionStatus("#csv-import-status", message, busy);
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
    if (new TextEncoder().encode(pasted).length > (csvIsExport(pasted) ? 12 : 5) * 1024 * 1024) { $("#csv-import-status").textContent = "Use CSV text up to 5 MB, or a Tagcast unresolved export up to 12 MB."; return; }
    csvImport.name ||= "Imported playlist";
    return csvImportCall("read", {text: pasted, delimiter: form.elements.delimiter.value, header: form.elements.header.checked}, renderCsvMapping);
  }
  if (!file || file.size > 12 * 1024 * 1024 || typeof file.arrayBuffer !== "function") { $("#csv-import-status").textContent = "Choose a CSV file up to 5 MB, or a Tagcast unresolved export up to 12 MB."; return; }
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
    if (file.size > 5 * 1024 * 1024 && !csvIsExport(content)) throw Error("Choose a CSV file up to 5 MB, or a Tagcast unresolved export up to 12 MB.");
    csvImport.name = file.name.replace(/\.(csv|tsv)$/i, "").slice(0, 200);
    csvImportWorking(false);
    await csvImportCall("read", {text: content, delimiter, header}, renderCsvMapping);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

function csvIsExport(content) {
  return content.replace(/^\ufeff/, "").split(/\r?\n/, 1)[0].replace(/[,;\t|]+$/, "") === "# Tagcast playlist CSV 1: escaped text";
}

function csvUnresolvedExport(data = csvImport.data) {
  const count = data?.summary?.unresolved || 0;
  return count ? `<p><button type="button" class="button small" data-csv-export>Export ${count} unresolved ${count === 1 ? "record" : "records"} as CSV ↓</button></p>` : "";
}

async function exportUnresolvedCsv() {
  if (!csvImportCurrent() || csvImport.busy || !csvImport.data?.summary?.unresolved) return;
  const request = ++csvImport.request, data = csvImport.data;
  csvImportWorking(true, "Preparing unresolved CSV records…");
  try {
    const result = await api("/api/playlist-import/export", {id: data.id, revision: data.revision, session: csvImport.session});
    if (!csvImportCurrent(request)) return;
    const url = URL.createObjectURL(new Blob([result.text], {type: "text/csv;charset=utf-8"})), link = document.createElement("a");
    link.href = url; link.download = result.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    csvImportWorking(false, `Downloaded ${result.count} unresolved CSV ${result.count === 1 ? "record" : "records"}. You can import this file again later.`);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, error.message); }
}

function renderCsvMapping(data) {
  csvImport.data = data; csvImport.fileData = data;
  syncCsvPauseButton();
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

function csvImportSummary(summary, omittedUnresolved = 0) {
  return `<p class="csv-import-summary">${summary.automatic} automatic · ${summary.manual} manually chosen · <strong>${summary.unresolved} unresolved${omittedUnresolved ? " (left out)" : ""}</strong> · ${summary.skipped} skipped</p><p class="muted">${summary.unique} distinct tracks. ${summary.duplicates} repeated selections will be kept once, in their first CSV position. ${summary.blank_records} blank CSV records omitted.</p>`;
}

function csvImportPagination(total, offset, kind) {
  return `<div class="pagination"><button type="button" class="button small" data-csv-page="${kind}" data-offset="${Math.max(0, offset - 50)}" ${offset === 0 ? "disabled" : ""}>← Previous</button><span>${total ? offset + 1 : 0}–${Math.min(offset + 50, total)} of ${total}</span><button type="button" class="button small" data-csv-page="${kind}" data-offset="${offset + 50}" ${offset + 50 >= total ? "disabled" : ""}>Next →</button></div>`;
}

function csvSource(row) {
  const source = row.source;
  return `<div class="csv-source"><strong>CSV ${row.position + 1} (line ${row.line}): ${escapeHtml(source.title || "Missing title")}</strong><span>${escapeHtml(source.artist || "Missing artist")}</span><small>${escapeHtml(source.album)}${source.duration ? ` · ${escapeHtml(source.duration)}` : ""}${source.year ? ` · ${escapeHtml(source.year)}` : ""}</small>${source.warnings.map(w => `<p class="warn-box">${escapeHtml(w)}</p>`).join("")}</div>`;
}

function csvMatchReasons(row) {
  return row.reasons?.length ? `<aside class="csv-match-reasons"><strong>Match explanation</strong><ul>${row.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></aside>` : "";
}

function renderCsvMatches(data) {
  csvImport.data = data; csvImport.resolving = null; csvImport.search = null;
  syncCsvPauseButton();
  csvImport.offset = data.offset; csvImport.show = data.show;
  const labels = {automatic: "Automatic match", manual: "Manually chosen", skipped: "Skipped", ambiguous: "Choose a track", missing: "No suggested match"};
  const partial = data.summary.unresolved > 0, selected = `${data.summary.unique} matched ${data.summary.unique === 1 ? "track" : "tracks"}`;
  const unresolved = `${data.summary.unresolved} unresolved CSV ${data.summary.unresolved === 1 ? "record" : "records"}`;
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">2. Check matches</h3>${csvImportSummary(data.summary)}${csvUnresolvedExport(data)}
    <label>Show <select id="csv-import-filter">${["all", "unresolved", "automatic", "manual", "skipped"].map(key => `<option value="${key}" ${data.show === key ? "selected" : ""}>${{all: "All CSV records", unresolved: "Unresolved records", automatic: "Automatic matches", manual: "Manual choices", skipped: "Skipped records"}[key]}</option>`).join("")}</select></label>
    <div class="csv-import-rows">${data.rows.map(row => `<section class="csv-import-row">${csvSource(row)}<div class="csv-match"><small>${labels[row.status]}</small>${row.choice ? csvTrackDetails(row.choice) : '<p class="muted">No track selected.</p>'}${csvMatchReasons(row)}<div><button type="button" class="button small" data-csv-resolve="${row.position}">${row.choice ? "Change match…" : "Find / choose a track…"}</button>${row.status !== "skipped" ? `<button type="button" class="text-action" data-csv-skip="${row.position}">Skip this CSV record</button>` : ""}</div></div></section>`).join("") || (data.show === "unresolved" && !data.summary.unresolved ? '<p class="muted">No unresolved records. Your matches are ready to review.</p>' : '<p class="muted">No records in this filter.</p>')}</div>${csvImportPagination(data.total, data.offset, "matches")}
    <button type="button" class="text-action" data-csv-columns>Change columns (resets matches)…</button><form id="csv-review-form"><h3 tabindex="-1">3. Prepare playlist review</h3><label>New private playlist name <input name="name" id="csv-playlist-name" maxlength="200" value="${escapeHtml(csvImport.name)}" required></label><label>Description <textarea name="description" id="csv-playlist-description" maxlength="2000">${escapeHtml(csvImport.description)}</textarea></label>
    <p>${!data.summary.unique ? "Choose at least one track before continuing. Unresolved records can be left out." : partial ? `You can choose more matches, or continue with only the ${selected}. ${unresolved} will be left out of this playlist.` : "Chosen tracks keep their CSV order."}</p><div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">Cancel</button><button class="button primary" ${!data.summary.unique ? "disabled" : ""}>${partial ? `Review ${selected}` : "Prepare playlist review"} →</button></div></form>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function renderCsvResolver(position) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const row = csvImport.data.rows.find(r => r.position === position);
  if (!row) return;
  csvImport.resolving = row; csvImport.search = null;
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">Choose a library track</h3>${csvSource(row)}${csvMatchReasons(row)}<p class="muted">Compare the full title, performer, album and duration. Suggestions are alternatives, not confirmed matches. Search below for other library copies.</p>
    <h4>Suggestions (up to 10)</h4><div class="csv-candidates">${row.candidates.map(csvCandidate).join("") || '<p class="muted">No suggestions. Search your library below.</p>'}</div>
    <form id="csv-search-form"><div class="clearable-field"><label for="csv-library-query">Search loaded library</label>${clearableSearchInput("csv-library-query", 'name="query" maxlength="200" placeholder="Part of a title, artist or album"', row.source.title)}</div><button class="button">Search</button></form><div id="csv-search-results"></div>
    <div class="dialog-footer"><button type="button" class="button" data-csv-matches>← Back to matches</button><button type="button" class="button" data-csv-skip="${position}">Skip this CSV record</button></div>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function csvCandidate(track) {
  const agrees = csvImport.resolving?.source.warnings?.length ? "No differences in the valid CSV fields; check the warnings." : "Matches all mapped fields.";
  const comparison = Array.isArray(track.differences) ? `<p class="csv-candidate-reason">${track.differences.length ? `<strong>Differs from CSV:</strong> ${track.differences.map(escapeHtml).join("; ")}.` : agrees}</p>` : "";
  return `<div class="csv-candidate"><div>${csvTrackDetails(track)}${comparison}</div><button type="button" class="button small" data-csv-choose="${escapeHtml(track.id)}">Use this track</button></div>`;
}

function renderCsvSearch(data, query) {
  csvImport.search = {...data, query};
  $("#csv-search-results").innerHTML = `<p>${data.total} library matches</p><div class="csv-candidates">${data.tracks.map(csvCandidate).join("") || '<p class="muted">No matches. Try fewer words or a different spelling.</p>'}</div>${csvImportPagination(data.total, data.offset, "search")}`;
}

function renderCsvReview(data) {
  csvImport.data = data; csvImport.resolving = null;
  syncCsvPauseButton();
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">3. Review new private playlist</h3><h4>${escapeHtml(data.name)}</h4><p class="csv-description">${escapeHtml(data.description)}</p>${csvImportSummary(data.summary, data.omitted_unresolved)}
    ${data.omitted_unresolved ? `<p class="warn-box">${data.omitted_unresolved} unresolved CSV ${data.omitted_unresolved === 1 ? "record" : "records"} will be left out. Only the selected matches below will be added to the playlist.</p>` : ""}${csvUnresolvedExport(data)}
    <p>Create a new private playlist with ${data.total} ${data.total === 1 ? "track" : "tracks"} in this order. Skipped records are omitted. Existing playlists and music metadata stay unchanged.</p><ol class="csv-review-list" start="${data.offset + 1}">${data.tracks.map(track => `<li>${csvTrackDetails(track)}</li>`).join("")}</ol>${csvImportPagination(data.total, data.offset, "review")}
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
    if (data.summary?.unresolved) {
      csvImport.createdPlaylist = response.id; csvImport.data = {...data, phase: "sent"};
      csvImportWorking(false);
      $("#csv-import-content").innerHTML = `<h3 tabindex="-1">Playlist created</h3><p>${data.total} ${data.total === 1 ? "track was" : "tracks were"} confirmed in iBroadcast.</p><p>Save the ${data.summary.unresolved} unresolved CSV ${data.summary.unresolved === 1 ? "record" : "records"} if you want to review or import them later. The file keeps the original columns and row order. Explicitly skipped records are not included.</p>${csvUnresolvedExport(data)}<div class="dialog-footer"><button type="button" class="button primary" data-close="playlist-import">Open imported playlist →</button></div>`;
      $("#playlist-import").scrollTop = 0; document.querySelector("#csv-import-content h3")?.focus?.();
      return;
    }
    $("#playlist-import").close(); toast("Imported playlist confirmed in iBroadcast.");
    showCollections("playlists", response.id);
  } catch (error) {
    if (csvImportCurrent(request)) {
      setActionStatus("#csv-import-status", `Check Playlists before importing again: ${error.message}`);
      csvImport.busy = false;
      $("#csv-import-content").innerHTML = `<p>This import cannot be sent again. Close this window and check Playlists. If the playlist is present, use it rather than creating another copy.</p>${csvUnresolvedExport(data)}<button type="button" class="button" data-close="playlist-import">Close</button>`;
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
    return csvImportCall("match", {mapping, duration_unit: form.elements.duration_unit.value, artist_separator: form.elements.artist_separator.value, show: "unresolved", offset: 0});
  }
  if (form.id === "csv-review-form") {
    event.preventDefault(); csvImport.name = form.elements.name.value; csvImport.description = form.elements.description.value;
    return csvImportCall("review", {name: csvImport.name, description: csvImport.description, omit_unresolved: csvImport.data.summary.unresolved > 0}, renderCsvReview);
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
  if (target.closest("[data-csv-pause]")) return pausePlaylistImport();
  if (target.closest("[data-csv-paused]")) return openPausedImports();
  const resume = target.closest("[data-csv-resume]"), remove = target.closest("[data-csv-remove-paused]"), removeConfirm = target.closest("[data-csv-remove-confirm]");
  if (resume || remove || removeConfirm) {
    const id = resume?.dataset.csvResume || remove?.dataset.csvRemovePaused || removeConfirm?.dataset.csvRemoveConfirm;
    const saved = csvPausedView.rows.find(row => row.id === id);
    if (!saved || !csvImportCurrent() || csvImport.busy) return;
    if (resume) return resumePausedImport(saved);
    if (removeConfirm) return removePausedImport(saved);
    csvPausedView.removing = id; renderPausedImports();
    document.querySelector("[data-csv-remove-cancel]")?.focus(); return;
  }
  if (target.closest("[data-csv-remove-cancel]")) { csvPausedView.removing = null; renderPausedImports(); return; }
  const created = target.closest("[data-csv-open-created]");
  if (created && csvImportCurrent() && !csvImport.busy) { $("#playlist-import").close(); showCollections("playlists", created.dataset.csvOpenCreated); return; }
  if (target.closest("#csv-discard-confirm")) {
    const current = csvCloseReview.request !== null && csvImportCurrent(csvCloseReview.request);
    $("#csv-import-discard").close();
    if (current) $("#playlist-import").close();
    return;
  }
  if (target.closest("[data-csv-export]")) return exportUnresolvedCsv();
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
  if (target.closest("[data-csv-revise]")) return csvImportCall("revise", {show: csvImport.show, offset: csvImport.offset});
  if (target.closest("[data-csv-save]")) return saveCsvPlaylist();
  const page = target.closest("[data-csv-page]");
  if (page) {
    const offset = Number(page.dataset.offset), kind = page.dataset.csvPage;
    if (kind === "search") return csvImportCall("search", {offset, query: csvImport.search.query}, data => renderCsvSearch(data, csvImport.search.query));
    return csvImportCall("view", {offset, show: csvImport.show, review: kind === "review"}, kind === "review" ? renderCsvReview : renderCsvMatches);
  }
});
$("#csv-import-discard").addEventListener("close", () => {
  const focus = csvCloseReview.focus;
  csvCloseReview.request = null; csvCloseReview.focus = null;
  if ($("#playlist-import").open) {
    (focus?.isConnected && !focus.disabled ? focus : document.querySelector('[data-close="playlist-import"]'))?.focus({preventScroll: true});
  }
});
$("#playlist-import").addEventListener("cancel", event => {
  event.preventDefault(); requestClosePlaylistImport();
});
$("#playlist-import").addEventListener("close", () => {
  const data = csvImport.data, session = csvImport.session, created = csvImport.createdPlaylist;
  resetPlaylistImport();
  if (data && live() && session === state.connection.playback_session) api("/api/playlist-import/discard", {id: data.id, session}).catch(() => {});
  if (created && live() && session === state.connection.playback_session) showCollections("playlists", created);
});
