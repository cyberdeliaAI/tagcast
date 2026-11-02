"use strict";

// CSV contents stay local. Matching and choices never write music metadata or play audio.
const csvImport = {request: 0, data: null, details: null, session: "", busy: false,
  name: "", description: "", fileData: null, mapping: null, durationUnit: "seconds", artistSeparator: "", copyPreference: "manual", show: "unresolved", offset: 0, resolving: null, search: null, submitted: false, createdPlaylist: null};
// Field names are the server's; the values are interface text keys for their labels.
const csvFields = {title: "playlistImport.field.title", artist: "playlistImport.field.artist",
  album: "playlistImport.field.album", album_artist: "playlistImport.field.albumArtist", duration: "playlistImport.field.duration", year: "playlistImport.field.year", track: "playlistImport.field.track"};
const csvCloseReview = {request: null, focus: null, submitted: false};
const csvPausedView = {rows: [], removing: null, open: false};
// The status line remembers how its text is made, so it can follow a language change.
let csvStatusText = () => "";

function syncCsvPauseButton() {
  $("#csv-import-pause").hidden = !csvImport.data || csvImport.submitted;
  $("#csv-import-pause").disabled = csvImport.busy;
}

function csvImportStatus(message = "", working = false) {
  csvStatusText = typeof message === "function" ? message : () => message;
  setActionStatus("#csv-import-status", csvStatusText(), working);
}

function renderCsvImportTitle() {
  $("#csv-import-title").textContent = TagcastI18n.text(csvPausedView.open ? "playlistImport.paused.title" : "playlistImport.title");
}

async function pausePlaylistImport() {
  if (!csvImportCurrent() || !csvImport.data || csvImport.busy || csvImport.submitted) return;
  const request = ++csvImport.request, data = csvImport.data, form = $("#csv-map-form");
  const mapping = form ? Object.fromEntries(Object.keys(csvFields).map(key => [key, form.elements[`map_${key}`].value === "" ? null : Number(form.elements[`map_${key}`].value)])) : csvImport.mapping || csvImport.fileData.mapping;
  // The default playlist name is data sent to iBroadcast, so it stays English.
  const fields = {name: $("#csv-playlist-name")?.value ?? (csvImport.name || "Imported playlist"),
    description: $("#csv-playlist-description")?.value ?? csvImport.description, mapping, mapping_step: Boolean(form),
    duration_unit: form?.elements.duration_unit.value || csvImport.durationUnit,
    artist_separator: form?.elements.artist_separator.value ?? csvImport.artistSeparator,
    show: csvImport.show, offset: csvImport.offset,
    copy_preference: form?.elements.copy_preference.value ?? csvImport.copyPreference};
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.pausing"));
  try {
    await api("/api/playlist-import/pause", {id: data.id, revision: data.revision, session: csvImport.session, ...fields});
    if (!csvImportCurrent(request)) return;
    csvImport.data = null; $("#playlist-import").close();
    toast(TagcastI18n.text("playlistImport.paused.toast"));
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
}

function renderPausedImports() {
  const rows = csvPausedView.rows;
  $("#csv-import-content").innerHTML = `<p data-csv-paused-list>${TagcastI18n.html("playlistImport.paused.intro", {saved: rows.length})}</p>${rows.map(row => `<section class="history-item"><h3>${escapeHtml(row.name)}</h3><p>${[
    TagcastI18n.html(row.origin ? "playlistImport.paused.recordsPlaylist" : "playlistImport.paused.recordsCsv", {count: row.total}),
    TagcastI18n.html("playlistImport.paused.manual", {count: row.manual}),
    row.phase === "mapping" ? TagcastI18n.html("playlistImport.paused.notMapped") : TagcastI18n.html("playlistImport.summary.unresolved", {unresolved: row.unresolved}),
    TagcastI18n.html("playlistImport.paused.savedAt", {date: TagcastI18n.dateTime(row.saved_at * 1000)})].join(" · ")}</p>${row.state === "submitted" ? `<p class="warn-box">${TagcastI18n.html("playlistImport.paused.submitted")}</p>` : ""}${csvPausedView.removing === row.id ? `<p class="warn-box">${TagcastI18n.html("playlistImport.paused.removeConfirm")}</p><div class="dialog-footer"><button type="button" class="button primary" data-csv-remove-cancel>${TagcastI18n.html("playlistImport.paused.keep")}</button><button type="button" class="button danger" data-csv-remove-confirm="${escapeHtml(row.id)}">${TagcastI18n.html("playlistImport.paused.removeSaved")}</button></div>` : `<div class="dialog-footer">${row.state === "paused" ? `<button type="button" class="button primary" data-csv-resume="${escapeHtml(row.id)}">${TagcastI18n.html("playlistImport.paused.resume")}</button>` : row.playlist ? `<button type="button" class="button" data-csv-open-created="${escapeHtml(row.playlist)}">${TagcastI18n.html("playlistImport.paused.openPlaylist")}</button>` : ""}<button type="button" class="button danger" data-csv-remove-paused="${escapeHtml(row.id)}">${TagcastI18n.html("playlistImport.paused.remove")}</button></div>`}</section>`).join("") || `<p class="muted">${TagcastI18n.html("playlistImport.paused.empty")}</p>`}`;
}

async function openPausedImports() {
  if (!live() || state.loading || document.querySelector("dialog[open]")) return;
  openPlaylistImport();
  if (!csvImportCurrent()) return;
  const request = ++csvImport.request;
  csvPausedView.open = true; renderCsvImportTitle();
  $("#csv-import-content").innerHTML = "";
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.readingSaved"));
  try {
    const result = await api("/api/playlist-import/paused", {session: csvImport.session});
    if (!csvImportCurrent(request)) return;
    csvPausedView.rows = result.imports; csvPausedView.removing = null;
    csvImportWorking(false); renderPausedImports();
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
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
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.rechecking"));
  try {
    const result = await api("/api/playlist-import/resume", {saved_id: saved.id, saved_token: saved.token, session});
    if (!csvImportCurrent(request)) return;
    Object.assign(csvImport, {name: result.name, description: result.description, fileData: result.file,
      mapping: result.mapping, durationUnit: result.duration_unit, artistSeparator: result.artist_separator, copyPreference: result.copy_preference || "manual"});
    csvImportWorking(false);
    if (result.view.phase === "mapping") renderCsvMapping(result.view); else renderCsvMatches(result.view);
    csvImportStatus(() => TagcastI18n.text("playlistImport.status.resumed"));
  } catch (error) {
    if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.text("playlistImport.status.resumeFailed", {error: TagcastI18n.errorText(error)}));
  }
}

async function removePausedImport(saved) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const request = ++csvImport.request;
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.removing"));
  try {
    await api("/api/playlist-import/remove-paused", {saved_id: saved.id, saved_token: saved.token, session: csvImport.session});
    if (!csvImportCurrent(request)) return;
    csvPausedView.rows = csvPausedView.rows.filter(row => row.id !== saved.id); csvPausedView.removing = null;
    csvImportWorking(false); renderPausedImports();
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
}

function csvImportCurrent(request = csvImport.request) {
  return request === csvImport.request && csvImport.details === state.details
    && csvImport.session === state.connection.playback_session && live() && $("#playlist-import").open;
}

function renderCsvDiscard() {
  const running = csvCloseReview.submitted;
  $("#csv-discard-title").textContent = TagcastI18n.text(running ? "playlistImport.discard.titleClose" : "playlistImport.discard.titleDiscard");
  $("#csv-discard-message").textContent = TagcastI18n.text(running ? "playlistImport.discard.messageRunning" : "playlistImport.discard.messageDiscard");
  $("#csv-discard-confirm").textContent = TagcastI18n.text(running ? "playlistImport.discard.confirmClose" : "playlistImport.discard.confirmDiscard");
}

function requestClosePlaylistImport() {
  if (!$("#playlist-import").open || $("#csv-import-discard").open) return;
  const form = $("#csv-file-form");
  const progress = csvImport.data || csvImport.busy || form?.elements.file?.files?.length
    || form?.elements.pasted?.value?.trim() || $("#playlist-url-input")?.value?.trim();
  if (csvImportCurrent() && progress && (!csvImport.submitted || csvImport.busy)) {
    csvCloseReview.request = csvImport.request; csvCloseReview.focus = document.activeElement;
    csvCloseReview.submitted = csvImport.submitted; renderCsvDiscard();
    $("#csv-import-discard").showModal(); $("#csv-discard-keep").focus();
    return;
  }
  $("#playlist-import").close();
}

function resetPlaylistImport() {
  $("#csv-import-discard").close();
  csvImport.request += 1; csvImport.data = null; csvImport.busy = false;
  csvImport.resolving = null; csvImport.search = null; csvImport.fileData = null; csvImport.mapping = null;
  csvImport.name = ""; csvImport.description = ""; csvImport.copyPreference = "manual";
  csvImport.createdPlaylist = null;
  csvPausedView.rows = []; csvPausedView.removing = null; csvPausedView.open = false; syncCsvPauseButton();
  $("#playlist-import").close(); $("#csv-import-content").innerHTML = ""; csvImportStatus("");
}

function openPlaylistImport() {
  if (!live() || state.loading || collectionsView.busy || saving || checking || document.querySelector("dialog[open]")) return;
  Object.assign(csvImport, {request: csvImport.request + 1, data: null, details: state.details,
    session: state.connection.playback_session, busy: false, name: "", description: "", show: "unresolved", offset: 0,
    resolving: null, search: null, submitted: false, fileData: null, mapping: null, copyPreference: "manual", createdPlaylist: null});
  csvImportStatus("");
  csvPausedView.open = false; renderCsvImportTitle(); syncCsvPauseButton();
  $("#csv-import-content").innerHTML = `<p>${TagcastI18n.html("playlistImport.file.intro")}</p>
    <form id="csv-file-form"><label>${TagcastI18n.html("playlistImport.file.file")} <input type="file" name="file" accept=".csv,.tsv,text/csv,text/tab-separated-values"></label>
    <div class="csv-import-fields"><label>${TagcastI18n.html("playlistImport.file.separator")} <select name="delimiter"><option value="auto">${TagcastI18n.html("playlistImport.file.separatorAuto")}</option><option value=",">${TagcastI18n.html("playlistImport.file.separatorComma")}</option><option value=";">${TagcastI18n.html("playlistImport.file.separatorSemicolon")}</option><option value="&#9;">${TagcastI18n.html("playlistImport.file.separatorTab")}</option><option value="|">${TagcastI18n.html("playlistImport.file.separatorPipe")}</option></select></label>
    <label>${TagcastI18n.html("playlistImport.file.encoding")} <select name="encoding"><option value="auto">UTF-8 / Unicode BOM</option><option value="windows-1252">Windows-1252</option><option value="utf-16le">UTF-16 little endian</option><option value="utf-16be">UTF-16 big endian</option></select></label></div>
    <details><summary>${TagcastI18n.html("playlistImport.file.paste")}</summary><label>${TagcastI18n.html("playlistImport.file.pasted")} <textarea name="pasted" rows="6" placeholder="${TagcastI18n.html("playlistImport.file.exampleHeader")}&#10;${TagcastI18n.html("playlistImport.file.exampleRow")}"></textarea></label><p class="muted">${TagcastI18n.html("playlistImport.file.pastedNote")}</p></details><label class="checkline"><input type="checkbox" name="header" checked> ${TagcastI18n.html("playlistImport.file.header")}</label><p class="muted">${TagcastI18n.html("playlistImport.file.limits")}</p>
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">${TagcastI18n.html("common.cancel")}</button><button class="button primary">${TagcastI18n.html("playlistImport.file.read")}</button></div></form>`;
  $("#playlist-import").showModal();
}

function openPlaylistUrlImport() {
  openPlaylistImport();
  if (!csvImportCurrent() || csvImport.data || csvImport.busy) return;
  $("#csv-import-content").innerHTML = `<p>${TagcastI18n.html("playlistImport.url.intro")}</p>
    <form id="playlist-url-form"><label>${TagcastI18n.html("playlistImport.url.label")} <input type="url" name="url" id="playlist-url-input" maxlength="2048" placeholder="https://www.deezer.com/playlist/…" required></label>
    <p class="muted">${TagcastI18n.html("playlistImport.url.note")}</p>
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">${TagcastI18n.html("common.cancel")}</button><button class="button primary">${TagcastI18n.html("playlistImport.url.fetch")}</button></div></form>`;
  $("#playlist-url-input").focus();
}

async function fetchPlaylistUrl(form) {
  if (!csvImportCurrent() || csvImport.busy || csvImport.data) return;
  const request = ++csvImport.request, session = csvImport.session;
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.fetching"));
  try {
    const response = await api("/api/playlist-import/url", {url: form.elements.url.value.trim(), session});
    if (!csvImportCurrent(request)) {
      if (live() && session === state.connection.playback_session) api("/api/playlist-import/discard", {id: response.id, session}).catch(() => {});
      return;
    }
    csvImport.name = response.name; csvImport.durationUnit = "seconds"; csvImport.artistSeparator = "";
    csvImportWorking(false); renderCsvMapping(response);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
}

// Records come from a fetched service playlist rather than a CSV file.
function csvFromPlaylist() { return Boolean(csvImport.fileData?.origin); }

function csvPlaylistOrigin(data) {
  const file = data.origin ? data : csvImport.fileData;
  if (!file?.origin) return "";
  const origin = file.origin, deezer = origin.provider === "deezer";
  const provider = deezer ? "Deezer" : TagcastI18n.html("playlistImport.origin.listenBrainz");
  const host = deezer ? "www.deezer.com" : "listenbrainz.org";
  const link = TagcastI18n.trusted(`<a href="https://${host}/playlist/${escapeHtml(origin.id)}" target="_blank" rel="noopener noreferrer">${provider}</a>`);
  return `<p class="muted">${TagcastI18n.html("playlistImport.origin.note", {source: link})}</p>`;
}

function csvImportWorking(busy, message = "") {
  csvImport.busy = busy;
  syncCsvPauseButton();
  csvImportStatus(message, busy);
  for (const element of $("#csv-import-content").querySelectorAll("input, select, textarea, button")) {
    if (!element.hasAttribute("data-close")) {
      if (busy) { element.dataset.csvWasDisabled = String(element.disabled); element.disabled = true; }
      else { element.disabled = element.dataset.csvWasDisabled === "true"; delete element.dataset.csvWasDisabled; }
    }
  }
}

async function csvImportCall(action, fields = {}, apply = renderCsvMatches) {
  if (!csvImportCurrent() || csvImport.busy || csvImport.submitted) return;
  const request = ++csvImport.request, data = csvImport.data, matching = action === "match";
  csvImportWorking(true, () => TagcastI18n.text(matching ? "playlistImport.status.matching" : "playlistImport.status.preparing"));
  try {
    const response = await api(`/api/playlist-import/${action}`, {session: csvImport.session,
      ...(data ? {id: data.id, revision: data.revision} : {}), ...fields});
    if (!csvImportCurrent(request)) return;
    csvImportWorking(false); apply(response);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
}

async function readPlaylistCsv(form) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const pasted = form.elements.pasted?.value || "", file = form.elements.file.files?.[0];
  if (pasted.trim()) {
    if (new TextEncoder().encode(pasted).length > (csvIsExport(pasted) ? 12 : 5) * 1024 * 1024) { csvImportStatus(() => TagcastI18n.text("playlistImport.file.textTooLarge")); return; }
    csvImport.name ||= "Imported playlist";
    return csvImportCall("read", {text: pasted, delimiter: form.elements.delimiter.value, header: form.elements.header.checked}, renderCsvMapping);
  }
  if (!file || file.size > 12 * 1024 * 1024 || typeof file.arrayBuffer !== "function") { csvImportStatus(() => TagcastI18n.text("playlistImport.file.tooLarge")); return; }
  const request = ++csvImport.request, encoding = form.elements.encoding.value;
  const delimiter = form.elements.delimiter.value, header = form.elements.header.checked;
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.reading"));
  try {
    const buffer = await file.arrayBuffer();
    if (!csvImportCurrent(request)) return;
    const bytes = new Uint8Array(buffer);
    const detected = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
    let content;
    try { content = new TextDecoder(encoding === "auto" ? detected : encoding, {fatal: true}).decode(bytes); }
    catch { csvImportWorking(false, () => TagcastI18n.text("playlistImport.file.encodingFailed")); return; }
    if (file.size > 5 * 1024 * 1024 && !csvIsExport(content)) { csvImportWorking(false, () => TagcastI18n.text("playlistImport.file.tooLarge")); return; }
    csvImport.name = file.name.replace(/\.(csv|tsv)$/i, "").slice(0, 200);
    csvImportWorking(false);
    await csvImportCall("read", {text: content, delimiter, header}, renderCsvMapping);
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
}

function csvIsExport(content) {
  return content.replace(/^\ufeff/, "").split(/\r?\n/, 1)[0].replace(/[,;\t|]+$/, "") === "# Tagcast playlist CSV 1: escaped text";
}

function csvUnresolvedExport(data = csvImport.data) {
  const count = data?.summary?.unresolved || 0;
  return count ? `<p><button type="button" class="button small" data-csv-export>${TagcastI18n.html("playlistImport.export.button", {count})}</button></p>` : "";
}

async function exportUnresolvedCsv() {
  if (!csvImportCurrent() || csvImport.busy || !csvImport.data?.summary?.unresolved) return;
  const request = ++csvImport.request, data = csvImport.data;
  csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.exporting"));
  try {
    const result = await api("/api/playlist-import/export", {id: data.id, revision: data.revision, session: csvImport.session});
    if (!csvImportCurrent(request)) return;
    const url = URL.createObjectURL(new Blob([result.text], {type: "text/csv;charset=utf-8"})), link = document.createElement("a");
    link.href = url; link.download = result.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const fromPlaylist = csvFromPlaylist();
    csvImportWorking(false, () => TagcastI18n.text(fromPlaylist ? "playlistImport.export.donePlaylist" : "playlistImport.export.doneCsv", {count: result.count}));
  } catch (error) { if (csvImportCurrent(request)) csvImportWorking(false, () => TagcastI18n.errorText(error)); }
}

function renderCsvMapping(data) {
  csvImport.data = data; csvImport.fileData = data;
  syncCsvPauseButton();
  const options = chosen => `<option value="">${TagcastI18n.html("playlistImport.mapping.unused")}</option>` + data.columns.map((name, i) => `<option value="${i}" ${chosen === i ? "selected" : ""}>${i + 1}. ${name ? escapeHtml(name) : TagcastI18n.html("playlistImport.mapping.unnamed")}</option>`).join("");
  const unit = data.duration_unit || (/\bms\b|milli/i.test(data.columns[data.mapping.duration] || "") ? "milliseconds" : "seconds");
  const preferences = {manual: "playlistImport.copy.manual", flac: "playlistImport.copy.flac", oldest: "playlistImport.copy.oldest", first: "playlistImport.copy.first", flac_oldest: "playlistImport.copy.flacOldest"};
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">${TagcastI18n.html("playlistImport.mapping.heading")}</h3>${csvPlaylistOrigin(data)}<p>${TagcastI18n.html("playlistImport.mapping.records", {count: data.total})} · ${TagcastI18n.html("playlistImport.mapping.blank", {count: data.blank_records})} ${TagcastI18n.html("playlistImport.mapping.confirm")}</p>
    <form id="csv-map-form"><div class="csv-import-fields">${Object.entries(csvFields).map(([key, label]) => `<label>${TagcastI18n.html(label)}<select name="map_${key}" ${key === "album" ? `aria-label="${TagcastI18n.html("playlistImport.field.album")}" aria-describedby="csv-album-hint"` : ""} ${["title", "artist"].includes(key) ? "required" : ""}>${options(data.mapping[key])}</select>${key === "album" ? `<small id="csv-album-hint" class="muted">${TagcastI18n.html("playlistImport.mapping.albumHint")}</small>` : ""}</label>`).join("")}
    <label>${TagcastI18n.html("playlistImport.mapping.durationUnit")} <select name="duration_unit"><option value="seconds" ${unit === "seconds" ? "selected" : ""}>${TagcastI18n.html("playlistImport.mapping.seconds")}</option><option value="milliseconds" ${unit === "milliseconds" ? "selected" : ""}>${TagcastI18n.html("playlistImport.mapping.milliseconds")}</option></select></label>
    <label>${TagcastI18n.html("playlistImport.mapping.artistNames")} <select name="artist_separator"><option value="">${TagcastI18n.html("playlistImport.mapping.artistKeep")}</option><option value=";" ${data.artist_separator === ";" ? "selected" : ""}>${TagcastI18n.html("playlistImport.mapping.artistSplit")}</option></select></label>
    <label>${TagcastI18n.html("playlistImport.mapping.copies")} <select name="copy_preference">${Object.entries(preferences).map(([value, label]) => `<option value="${value}" ${(data.copy_preference || csvImport.copyPreference) === value ? "selected" : ""}>${TagcastI18n.html(label)}</option>`).join("")}</select></label></div>
    <p class="muted">${TagcastI18n.html("playlistImport.mapping.copiesNote")}</p>
    <p class="muted">${TagcastI18n.html("playlistImport.mapping.fieldsNote")}</p>
    <div class="table-scroll"><table><thead><tr>${data.columns.map((name, i) => `<th>${i + 1}. ${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${data.sample.map(row => `<tr>${row.cells.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">${TagcastI18n.html("common.cancel")}</button><button class="button primary">${TagcastI18n.html("playlistImport.mapping.submit")}</button></div></form>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function csvTrackDetails(track) {
  const performers = track.performers?.map(p => p.name).join(" · ") || track.artist;
  return `<strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(performers)}</span><small>${escapeHtml(track.album)} · ${escapeHtml(track.album_artist || "")} · ${track.year || TagcastI18n.html("playlistImport.track.unknownYear")} · ${trackDuration(track.length)}${track.format ? ` · ${escapeHtml(track.format)}` : ""} · ${TagcastI18n.html("playlistImport.track.position", {disc: track.disc || "?", track: track.track || "?"})} · ${TagcastI18n.html("playlistImport.track.id", {id: track.id})}</small>`;
}

function csvImportSummary(summary, omittedUnresolved = 0) {
  const fromPlaylist = csvFromPlaylist();
  const unresolved = TagcastI18n.html(omittedUnresolved ? "playlistImport.summary.unresolvedOmitted" : "playlistImport.summary.unresolved", {unresolved: summary.unresolved});
  return `<p class="csv-import-summary">${TagcastI18n.html("playlistImport.summary.automatic", {automatic: summary.automatic})} · ${TagcastI18n.html("playlistImport.summary.manual", {manual: summary.manual})} · <strong>${unresolved}</strong> · ${TagcastI18n.html("playlistImport.summary.skipped", {skipped: summary.skipped})}</p><p class="muted">${TagcastI18n.html("playlistImport.summary.distinct", {count: summary.unique})} ${TagcastI18n.html(fromPlaylist ? "playlistImport.summary.repeatedPlaylist" : "playlistImport.summary.repeatedCsv", {count: summary.duplicates})} ${TagcastI18n.html(fromPlaylist ? "playlistImport.summary.blankPlaylist" : "playlistImport.summary.blankCsv", {count: summary.blank_records})}</p>`;
}

function csvImportPagination(total, offset, kind) {
  return `<div class="pagination"><button type="button" class="button small" data-csv-page="${kind}" data-offset="${Math.max(0, offset - 50)}" ${offset === 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${TagcastI18n.html("playlistImport.pagination.range", {start: total ? offset + 1 : 0, end: Math.min(offset + 50, total), total})}</span><button type="button" class="button small" data-csv-page="${kind}" data-offset="${offset + 50}" ${offset + 50 >= total ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>`;
}

// Presentation only: keep the original mapped value and matching decisions untouched.
function csvSourceDuration(value) {
  const raw = String(value || ""), numeric = /^\d+(?:[.,]\d+)?$/.test(raw.trim());
  const seconds = numeric ? Number(raw.replace(",", ".")) / (csvImport.durationUnit === "milliseconds" ? 1000 : 1) : 0;
  return seconds > 0 && seconds <= 86400 ? trackDuration(seconds) : raw;
}

function csvSource(row) {
  const source = row.source, title = source.title || TagcastI18n.text("playlistImport.source.missingTitle");
  const heading = csvFromPlaylist() ? TagcastI18n.html("playlistImport.source.playlistTrack", {position: row.position + 1, title})
    : TagcastI18n.html("playlistImport.source.csvRecord", {position: row.position + 1, line: row.line, title});
  return `<div class="csv-source"><strong>${heading}</strong><span>${source.artist ? escapeHtml(source.artist) : TagcastI18n.html("playlistImport.source.missingArtist")}</span><small>${escapeHtml(source.album)}${source.duration ? ` · ${escapeHtml(csvSourceDuration(source.duration))}` : ""}${source.year ? ` · ${escapeHtml(source.year)}` : ""}</small>${source.warnings.map(w => `<p class="warn-box">${escapeHtml(w)}</p>`).join("")}</div>`;
}

function csvMatchReasons(row) {
  return row.reasons?.length ? `<aside class="csv-match-reasons"><strong>${TagcastI18n.html("playlistImport.matches.explanation")}</strong><ul>${row.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></aside>` : "";
}

function renderCsvMatches(data) {
  csvImport.data = data; csvImport.resolving = null; csvImport.search = null;
  syncCsvPauseButton();
  csvImport.offset = data.offset; csvImport.show = data.show;
  const labels = {automatic: "playlistImport.row.automatic", manual: "playlistImport.row.manual", skipped: "playlistImport.row.skipped", ambiguous: "playlistImport.row.ambiguous", missing: "playlistImport.row.missing"};
  const fromPlaylist = csvFromPlaylist(), partial = data.summary.unresolved > 0;
  const filters = {all: fromPlaylist ? "playlistImport.filter.allPlaylist" : "playlistImport.filter.allCsv", unresolved: "playlistImport.filter.unresolved",
    automatic: "playlistImport.filter.automatic", manual: "playlistImport.filter.manual", skipped: "playlistImport.filter.skipped"};
  const skip = fromPlaylist ? "playlistImport.row.skipPlaylist" : "playlistImport.row.skipCsv";
  const next = !data.summary.unique ? TagcastI18n.html("playlistImport.prepare.chooseOne")
    : partial ? `${TagcastI18n.html("playlistImport.prepare.partial", {count: data.summary.unique})} ${TagcastI18n.html(fromPlaylist ? "playlistImport.prepare.leftOutPlaylist" : "playlistImport.prepare.leftOutCsv", {count: data.summary.unresolved})}`
      : TagcastI18n.html(fromPlaylist ? "playlistImport.prepare.keepOrderPlaylist" : "playlistImport.prepare.keepOrderCsv");
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">${TagcastI18n.html("playlistImport.matches.heading")}</h3>${csvPlaylistOrigin(data)}${csvImportSummary(data.summary)}${csvUnresolvedExport(data)}
    <label>${TagcastI18n.html("playlistImport.matches.show")} <select id="csv-import-filter">${["all", "unresolved", "automatic", "manual", "skipped"].map(key => `<option value="${key}" ${data.show === key ? "selected" : ""}>${TagcastI18n.html(filters[key])}</option>`).join("")}</select></label>
    <div class="csv-import-rows">${data.rows.map(row => `<section class="csv-import-row">${csvSource(row)}<div class="csv-match"><small>${labels[row.status] ? TagcastI18n.html(labels[row.status]) : ""}</small>${row.choice ? csvTrackDetails(row.choice) : `<p class="muted">${TagcastI18n.html("playlistImport.row.noChoice")}</p>`}${csvMatchReasons(row)}<div><button type="button" class="button small" data-csv-resolve="${row.position}">${TagcastI18n.html(row.choice ? "playlistImport.row.change" : "playlistImport.row.find")}</button>${row.status !== "skipped" ? `<button type="button" class="text-action" data-csv-skip="${row.position}">${TagcastI18n.html(skip)}</button>` : ""}</div></div></section>`).join("") || (data.show === "unresolved" && !data.summary.unresolved ? `<p class="muted">${TagcastI18n.html("playlistImport.matches.noneUnresolved")}</p>` : `<p class="muted">${TagcastI18n.html("playlistImport.matches.emptyFilter")}</p>`)}</div>${csvImportPagination(data.total, data.offset, "matches")}
    <button type="button" class="text-action" data-csv-columns>${TagcastI18n.html("playlistImport.matches.changeColumns")}</button><form id="csv-review-form"><h3 tabindex="-1">${TagcastI18n.html("playlistImport.prepare.heading")}</h3><label>${TagcastI18n.html("playlistImport.prepare.name")} <input name="name" id="csv-playlist-name" maxlength="200" value="${escapeHtml(csvImport.name)}" required></label><label>${TagcastI18n.html("playlistImport.prepare.description")} <textarea name="description" id="csv-playlist-description" maxlength="2000">${escapeHtml(csvImport.description)}</textarea></label>
    <p>${next}</p><div class="dialog-footer"><button type="button" class="button" data-close="playlist-import">${TagcastI18n.html("common.cancel")}</button><button class="button primary" ${!data.summary.unique ? "disabled" : ""}>${partial ? TagcastI18n.html("playlistImport.prepare.review", {count: data.summary.unique}) : TagcastI18n.html("playlistImport.prepare.submit")}</button></div></form>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function renderCsvResolver(position) {
  if (!csvImportCurrent() || csvImport.busy) return;
  const row = csvImport.data.rows.find(r => r.position === position);
  if (!row) return;
  csvImport.resolving = row; csvImport.search = null;
  const skip = csvFromPlaylist() ? "playlistImport.row.skipPlaylist" : "playlistImport.row.skipCsv";
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">${TagcastI18n.html("playlistImport.resolver.heading")}</h3>${csvSource(row)}${csvMatchReasons(row)}<p class="muted">${TagcastI18n.html("playlistImport.resolver.intro")}</p>
    <h4>${TagcastI18n.html("playlistImport.resolver.suggestions")}</h4><div class="csv-candidates">${row.candidates.map(csvCandidate).join("") || `<p class="muted">${TagcastI18n.html("playlistImport.resolver.noSuggestions")}</p>`}</div>
    <form id="csv-search-form"><div class="clearable-field"><label for="csv-library-query">${TagcastI18n.html("playlistImport.resolver.search")}</label>${clearableSearchInput("csv-library-query", `name="query" maxlength="200" placeholder="${TagcastI18n.html("playlistImport.resolver.placeholder")}"`, row.source.title)}</div><button class="button">${TagcastI18n.html("playlistImport.resolver.searchButton")}</button></form><div id="csv-search-results"></div>
    <div class="dialog-footer"><button type="button" class="button" data-csv-matches>${TagcastI18n.html("playlistImport.matches.back")}</button><button type="button" class="button" data-csv-skip="${position}">${TagcastI18n.html(skip)}</button></div>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

function csvCandidate(track) {
  const agrees = TagcastI18n.html(csvImport.resolving?.source.warnings?.length ? "playlistImport.candidate.agreesWarnings" : "playlistImport.candidate.agrees");
  const label = TagcastI18n.trusted(`<strong>${TagcastI18n.html("playlistImport.candidate.differsLabel")}</strong>`);
  const comparison = Array.isArray(track.differences) ? `<p class="csv-candidate-reason">${track.differences.length ? TagcastI18n.html("playlistImport.candidate.differs", {label, differences: track.differences.join("; ")}) : agrees}</p>` : "";
  return `<div class="csv-candidate"><div>${csvTrackDetails(track)}${comparison}</div><button type="button" class="button small" data-csv-choose="${escapeHtml(track.id)}">${TagcastI18n.html("playlistImport.candidate.use")}</button></div>`;
}

function renderCsvSearch(data, query) {
  csvImport.search = {...data, query};
  $("#csv-search-results").innerHTML = `<p>${TagcastI18n.html("playlistImport.search.count", {count: data.total})}</p><div class="csv-candidates">${data.tracks.map(csvCandidate).join("") || `<p class="muted">${TagcastI18n.html("playlistImport.search.empty")}</p>`}</div>${csvImportPagination(data.total, data.offset, "search")}`;
}

function renderCsvReview(data) {
  csvImport.data = data; csvImport.resolving = null;
  syncCsvPauseButton();
  const fromPlaylist = csvFromPlaylist();
  $("#csv-import-content").innerHTML = `<h3 tabindex="-1">${TagcastI18n.html("playlistImport.review.heading")}</h3><h4>${escapeHtml(data.name)}</h4><p class="csv-description">${escapeHtml(data.description)}</p>${csvImportSummary(data.summary, data.omitted_unresolved)}
    ${data.omitted_unresolved ? `<p class="warn-box">${TagcastI18n.html(fromPlaylist ? "playlistImport.review.leftOutPlaylist" : "playlistImport.review.leftOutCsv", {count: data.omitted_unresolved})}</p>` : ""}${csvUnresolvedExport(data)}
    <p>${TagcastI18n.html("playlistImport.review.create", {count: data.total})}</p><ol class="csv-review-list" start="${data.offset + 1}">${data.tracks.map(track => `<li>${csvTrackDetails(track)}</li>`).join("")}</ol>${csvImportPagination(data.total, data.offset, "review")}
    <div class="dialog-footer"><button type="button" class="button" data-csv-revise>${TagcastI18n.html("playlistImport.matches.back")}</button><button type="button" class="button primary" data-csv-save>${TagcastI18n.html("playlistImport.review.save")}</button></div>`;
  $("#playlist-import").scrollTop = 0;
  document.querySelector("#csv-import-content h3")?.focus?.();
}

async function saveCsvPlaylist() {
  if (!csvImportCurrent() || csvImport.busy || csvImport.submitted || csvImport.data?.phase !== "review" || collectionsView.busy) return;
  const request = ++csvImport.request, data = csvImport.data;
  let readBackDiffers = false;
  csvImport.submitted = true; collectionsView.busy = true; csvImportWorking(true, () => TagcastI18n.text("playlistImport.status.creating"));
  try {
    const response = await api("/api/playlist-import/save", {id: data.id, revision: data.revision,
      session: csvImport.session, review_token: data.review_token, approved: true});
    const result = await collectionJob(response, () => csvImportCurrent(request));
    if (result.results?.length !== 1 || result.results[0].id !== response.id || result.results[0].status !== "saved") {
      readBackDiffers = true;
      throw Error(TagcastI18n.englishText("errors.playlistImport.readBackDiffers"));
    }
    if (!csvImportCurrent(request)) return;
    if (data.summary?.unresolved) {
      csvImport.createdPlaylist = response.id; csvImport.data = {...data, phase: "sent"};
      csvImportWorking(false);
      const fromPlaylist = csvFromPlaylist();
      $("#csv-import-content").innerHTML = `<h3 tabindex="-1">${TagcastI18n.html("playlistImport.created.heading")}</h3><p>${TagcastI18n.html("playlistImport.created.confirmed", {count: data.total})}</p><p>${TagcastI18n.html(fromPlaylist ? "playlistImport.created.savePlaylist" : "playlistImport.created.saveCsv", {count: data.summary.unresolved})}</p>${csvUnresolvedExport(data)}<div class="dialog-footer"><button type="button" class="button primary" data-close="playlist-import">${TagcastI18n.html("playlistImport.created.open")}</button></div>`;
      $("#playlist-import").scrollTop = 0; document.querySelector("#csv-import-content h3")?.focus?.();
      return;
    }
    $("#playlist-import").close(); toast(TagcastI18n.text("playlistImport.created.toast"));
    showCollections("playlists", response.id);
  } catch (error) {
    if (csvImportCurrent(request)) {
      const reason = () => readBackDiffers ? TagcastI18n.text("errors.playlistImport.readBackDiffers") : TagcastI18n.errorText(error);
      csvImportStatus(() => TagcastI18n.text("playlistImport.save.checkPlaylists", {error: reason()}));
      csvImport.busy = false;
      $("#csv-import-content").innerHTML = `<p>${TagcastI18n.html("playlistImport.save.uncertain")}</p>${csvUnresolvedExport(data)}<button type="button" class="button" data-close="playlist-import">${TagcastI18n.html("common.close")}</button>`;
    }
  } finally { collectionsView.busy = false; }
}

// A language change never rebuilds the wizard: it is a draft with inputs, choices and focus,
// and its steps keep their text until reopened. The dialog title, the status line, the
// discard question and the read-only saved-imports list follow the new language.
TagcastI18n.subscribe(() => {
  if (!$("#playlist-import")?.open) return;
  renderCsvImportTitle();
  $("#csv-import-status").textContent = csvStatusText();
  if ($("#csv-import-discard")?.open) renderCsvDiscard();
  const content = $("#csv-import-content");
  if (csvImport.busy || !content?.querySelector?.("[data-csv-paused-list]")) return;
  const active = document.activeElement, scroll = $("#playlist-import").scrollTop;
  const focus = active && content.contains?.(active) ? active.getAttributeNames?.().find(name => name.startsWith("data-csv-")) : null;
  const value = focus ? active.getAttribute(focus) : null;
  renderPausedImports();
  if (focus) [...content.querySelectorAll(`[${focus}]`)].find(node => node.getAttribute(focus) === value)?.focus({preventScroll: true});
  $("#playlist-import").scrollTop = scroll;
});

document.addEventListener("submit", event => {
  const form = event.target;
  if (form.id === "playlist-url-form") { event.preventDefault(); return fetchPlaylistUrl(form); }
  if (form.id === "csv-file-form") { event.preventDefault(); return readPlaylistCsv(form); }
  if (form.id === "csv-map-form") {
    event.preventDefault();
    const mapping = Object.fromEntries(Object.keys(csvFields).map(key => [key, form.elements[`map_${key}`].value === "" ? null : Number(form.elements[`map_${key}`].value)]));
    csvImport.mapping = mapping; csvImport.durationUnit = form.elements.duration_unit.value; csvImport.artistSeparator = form.elements.artist_separator.value; csvImport.copyPreference = form.elements.copy_preference.value;
    return csvImportCall("match", {mapping, duration_unit: form.elements.duration_unit.value, artist_separator: form.elements.artist_separator.value, copy_preference: csvImport.copyPreference, show: "unresolved", offset: 0});
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
  if (target.closest("[data-playlist-url]")) return openPlaylistUrlImport();
  if (target.closest("[data-csv-import]")) return openPlaylistImport();
  if (target.closest("[data-csv-columns]") && csvImportCurrent() && !csvImport.busy && csvImport.fileData) {
    const data = {...csvImport.fileData, id: csvImport.data.id, revision: csvImport.data.revision, mapping: csvImport.mapping, duration_unit: csvImport.durationUnit, artist_separator: csvImport.artistSeparator, copy_preference: csvImport.copyPreference};
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
