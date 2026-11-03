"use strict";

// Cleanup is an explicit server-side draft. Closing this dialog never cancels a job.
// A language change never re-renders this dialog (it holds a draft); its next render uses the new language.
const cleanupView = {data: null, offset: 0, excluded: new Set(), request: 0, timer: null, busy: false,
  category: "", ruleLabel: "", ruleText: "", removeLabel: false, labelQuery: "", labelOffset: 0,
  labels: null, labelRequest: 0, labelsBusy: false, draftChanged: false};
// Category ids are sent and stored; the keys only label them.
const cleanupLabels = {genres: "cleanup.category.genres", "album-artists": "cleanup.category.albumArtists", "track-artists": "cleanup.category.trackArtists",
  composers: "cleanup.category.composers", "genre-labels": "cleanup.category.genreLabels", years: "cleanup.category.years"};
// Job states are server codes; an unknown state is shown as sent.
const cleanupStates = {running: "cleanup.state.running", done: "cleanup.state.done", stopped: "cleanup.state.stopped", error: "cleanup.state.error"};

function cleanupCategoryLabel(category) {
  return Object.hasOwn(cleanupLabels, category) ? TagcastI18n.text(cleanupLabels[category]) : "";
}

function cleanupStateLabel(state) {
  return Object.hasOwn(cleanupStates, state) ? TagcastI18n.html(cleanupStates[state]) : escapeHtml(state);
}

function resetCleanup(close = false) {
  if (typeof resetYearReview === "function") resetYearReview();
  cleanupView.request += 1;
  clearTimeout(cleanupView.timer);
  cleanupView.data = null; cleanupView.offset = 0; cleanupView.excluded.clear();
  cleanupView.busy = false;
  cleanupView.category = ""; cleanupView.ruleLabel = ""; cleanupView.ruleText = "";
  cleanupView.removeLabel = false;
  cleanupView.labels = null; cleanupView.labelQuery = ""; cleanupView.labelOffset = 0;
  cleanupView.labelRequest += 1; cleanupView.labelsBusy = false; cleanupView.draftChanged = false;
  setActionStatus("#cleanup-status", "");
  $("#cleanup-content").innerHTML = `<p class="muted">${TagcastI18n.html("cleanup.reset.reloaded")}</p>`;
  if (close && $("#cleanup").open) $("#cleanup").close();
}

async function openCleanup() {
  if (!live()) { toast(TagcastI18n.text("cleanup.open.connect")); return; }
  $("#cleanup").showModal();
  await fetchCleanup();
  if (cleanupView.category === "genre-labels" && !cleanupView.labels) await fetchGenreLabels();
}

async function fetchCleanup() {
  const request = ++cleanupView.request, details = state.details;
  clearTimeout(cleanupView.timer);
  try {
    const data = await api(`/api/cleanup?offset=${cleanupView.offset}&limit=25`);
    if (request !== cleanupView.request || details !== state.details || !live()) return;
    const changed = data.id !== cleanupView.data?.id;
    cleanupView.data = data;
    if (!cleanupView.category) cleanupView.category = data.category || "genres";
    if (changed && data.mapping) {
      cleanupView.category = data.category;
      cleanupView.ruleLabel = data.mapping.label;
      cleanupView.ruleText = data.mapping.replacements.join("\n");
      cleanupView.removeLabel = data.mapping.remove === true;
      cleanupView.draftChanged = false;
    }
    if (changed || data.state !== "preview") cleanupView.excluded = new Set(data.excluded || []);
    renderCleanup();
    if (data.state === "running" && $("#cleanup").open) cleanupView.timer = setTimeout(fetchCleanup, 1500);
  } catch (error) {
    if (request === cleanupView.request) $("#cleanup-content").innerHTML = `<p class="error-text" role="status">${escapeHtml(TagcastI18n.errorText(error))}</p>`;
  }
}

// Progress counts of a cleanup job; the duplicate cleanup in trash.js uses the same texts.
function cleanupCounts(counts) {
  return [TagcastI18n.html("cleanup.status.confirmed", {count: counts.confirmed || 0}),
    TagcastI18n.html("cleanup.status.pending", {count: counts.pending || 0}),
    TagcastI18n.html("cleanup.status.sent", {count: counts.sent || 0}),
    TagcastI18n.html("cleanup.status.unconfirmed", {count: counts.unconfirmed || 0}),
    TagcastI18n.html("cleanup.status.conflicts", {count: counts.conflict || 0}),
    TagcastI18n.html("cleanup.status.blocked", {count: counts.blocked || 0}),
    TagcastI18n.html("cleanup.status.excluded", {count: counts.excluded || 0})].join(" · ");
}

function renderCleanup() {
  if (cleanupView.category === "years") { renderYearReview(); return; }
  const data = cleanupView.data || {state: "empty"}, preview = data.state === "preview", running = data.state === "running";
  const scroll = $("#cleanup").scrollTop;
  const category = cleanupView.category || data.category || "genres";
  const picker = cleanupCategoryControl(running || cleanupView.busy) + `<button class="button" id="cleanup-preview" ${running || cleanupView.busy ? "disabled" : ""}>${TagcastI18n.html("cleanup.action.preview")}</button>`;
  const counts = data.counts || {};
  const albumArtists = data.category === "album-artists";
  const explanation = category === "album-artists"
    ? TagcastI18n.html("cleanup.intro.albumArtists")
    : `${TagcastI18n.html(category === "genre-labels" ? "cleanup.intro.genreLabels" : "cleanup.intro.split")} ${TagcastI18n.html("cleanup.intro.unchanged")}`;
  const status = [`<strong>${cleanupStateLabel(data.state)}</strong>`, ...(albumArtists ? [TagcastI18n.html("cleanup.status.discRecords")] : []), cleanupCounts(counts)].join(" · ");
  const summary = data.id ? TagcastI18n.html("cleanup.summary.affected", {category: cleanupCategoryLabel(data.category),
    albums: TagcastI18n.text("cleanup.count.albums", {count: data.albums}), tracks: TagcastI18n.text("cleanup.summary.affectedTracks", {count: data.tracks})}) : "";
  $("#cleanup-content").innerHTML = `<p class="muted">${explanation} <strong>${TagcastI18n.html("cleanup.intro.saved")}</strong></p><div class="cleanup-controls">${picker}</div>
    ${category === "genre-labels" ? genreLabelControls(running || cleanupView.busy) : ""}
    ${data.id ? `<div class="notice">${summary} ${TagcastI18n.html("cleanup.summary.batches", {tracks: data.batch_tracks, albums: data.batch_albums})}</div>
    ${data.mapping ? `<p class="cleanup-rule-summary"><strong>${TagcastI18n.html("cleanup.rule.reviewed")}</strong> ${escapeHtml(data.mapping.label)} → ${data.mapping.remove ? TagcastI18n.html("cleanup.rule.removeLabel") : escapeHtml(data.mapping.replacements.join(" · "))}</p>` : ""}
    ${preview && data.tracks ? `<p>${TagcastI18n.html(albumArtists ? "cleanup.preview.reviewDiscs" : "cleanup.preview.reviewExamples")} ${TagcastI18n.html("cleanup.preview.uncheck")}</p><div class="cleanup-controls"><button class="text-action" id="cleanup-select-all">${TagcastI18n.html("cleanup.preview.selectAll")}</button><button class="text-action" id="cleanup-select-none">${TagcastI18n.html("cleanup.preview.excludeAll")}</button><span id="cleanup-selected" role="status"></span></div>` : !preview ? `<p role="status" class="operation-status" data-working="${running}">${status}</p>` : ""}
    ${data.error ? `<p class="warn-box" role="status">${escapeHtml(data.error)}</p>` : ""}
    <div class="cleanup-albums">${data.groups.map(g => `<section class="cleanup-album"><h3>${preview ? `<label><input type="checkbox" data-cleanup-album="${escapeHtml(g.id)}" ${cleanupView.excluded.has(g.id) ? "" : "checked"}> ` : ""}${escapeHtml(g.album)}${preview ? "</label>" : ""}</h3><p class="muted">${escapeHtml(g.artist)} · ${TagcastI18n.html("cleanup.group.affectedTracks", {count: g.tracks})}</p>${g.examples.map(cleanupExample).join("")}</section>`).join("") || `<p class="muted">${TagcastI18n.html("cleanup.preview.empty")}</p>`}</div>
    ${data.albums > 25 ? `<div class="pagination"><button class="button small" data-cleanup-page="-25" ${cleanupView.offset <= 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${data.albums ? Math.floor(cleanupView.offset / 25) + 1 : 0} / ${Math.ceil(data.albums / 25)}</span><button class="button small" data-cleanup-page="25" ${cleanupView.offset + 25 >= data.albums ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>` : ""}
    <p class="muted">${TagcastI18n.html("cleanup.report.saved")}</p>
    ${preview && data.tracks ? `<label class="checkline"><input id="cleanup-approved" type="checkbox"> ${TagcastI18n.html("cleanup.approve")}</label>` : ""}
    <div class="dialog-footer"><button class="button" id="cleanup-export">${TagcastI18n.html("cleanup.action.export")}</button>${running ? `<button class="button danger" id="cleanup-stop">${TagcastI18n.html("cleanup.action.stop")}</button>` : data.tracks && data.state !== "done" ? `<button class="button primary" id="cleanup-start" ${preview || cleanupView.busy || cleanupView.draftChanged ? "disabled" : ""}>${TagcastI18n.html(preview ? "cleanup.action.start" : "cleanup.action.resume")}</button>` : ""}<button class="button" id="cleanup-refresh">${TagcastI18n.html(running ? "cleanup.action.refreshProgress" : "cleanup.action.refreshLibrary")}</button></div>` : `<p class="muted">${TagcastI18n.html("cleanup.empty")}</p>`}`;
  $("#cleanup").scrollTop = scroll;
  updateCleanupSelection();
}

function cleanupCategoryControl(disabled = false) {
  const category = cleanupView.category || cleanupView.data?.category || "genres";
  return `<label class="cleanup-category">${TagcastI18n.html("cleanup.category.label")} <select id="cleanup-category" ${disabled ? "disabled" : ""}>${Object.entries(cleanupLabels).map(([key, label]) => `<option value="${key}" ${key === category ? "selected" : ""}>${TagcastI18n.html(label)}</option>`).join("")}</select></label>`;
}

// Example titles, names and blocked reasons come from the server and stay as sent.
function cleanupExample(example) {
  return `<div class="cleanup-example${example.primary !== undefined ? " cleanup-album-artists" : ""}"><strong>${escapeHtml(example.title)}</strong><div><span>${TagcastI18n.html("cleanup.example.before")}</span><span>${escapeHtml(example.before.join(" · "))}</span></div>${example.blocked
    ? `<p class="error-text">${TagcastI18n.html("cleanup.example.blocked", {reason: example.blocked})}</p>`
    : example.primary !== undefined
      ? `<div><span>${TagcastI18n.html("cleanup.example.primary")}</span><span>${escapeHtml(example.primary)}</span></div><div><span>${TagcastI18n.html("cleanup.example.additional")}</span><span>${escapeHtml(example.additional.join(" · ")) || TagcastI18n.html("cleanup.example.none")}</span></div>`
      : `<div><span>${TagcastI18n.html("cleanup.example.after")}</span><span>${example.after.length ? escapeHtml(example.after.join(" · ")) : TagcastI18n.html("cleanup.example.noGenres")}</span></div>`}</div>`;
}

function updateCleanupSelection() {
  const data = cleanupView.data;
  if (!data || data.state !== "preview") return;
  const selected = (data.selection || []).filter(g => !cleanupView.excluded.has(g.id));
  const label = $("#cleanup-selected");
  if (label) label.textContent = TagcastI18n.text("cleanup.selection.summary", {albums: TagcastI18n.text("cleanup.count.albums", {count: selected.length}),
    tracks: TagcastI18n.text("cleanup.count.tracks", {count: selected.reduce((n, g) => n + g.tracks, 0)})});
  const start = $("#cleanup-start");
  if (start) start.disabled = cleanupView.busy || cleanupView.draftChanged || !selected.length || !$("#cleanup-approved")?.checked;
}

function genreLabelControls(disabled) {
  const labels = cleanupView.labels;
  const options = labels?.labels || [];
  const selected = cleanupView.ruleLabel;
  const fallback = selected && !options.some(i => i.label === selected)
    ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : "";
  return `<section class="genre-label-review"><h3>${TagcastI18n.html("cleanup.labels.heading")}</h3>
    <p class="muted">${TagcastI18n.html("cleanup.labels.help")}</p>
    <div class="cleanup-controls"><div class="field clearable-field"><label for="cleanup-label-search">${TagcastI18n.html("cleanup.labels.search")}</label>${clearableSearchInput("cleanup-label-search", "", cleanupView.labelQuery, disabled)}</div><button class="button small" id="cleanup-label-find" ${disabled || cleanupView.labelsBusy ? "disabled" : ""}>${TagcastI18n.html(cleanupView.labelsBusy ? "common.loading" : "cleanup.labels.find")}</button></div>
    <label class="field">${TagcastI18n.html("cleanup.labels.existing")}<select id="cleanup-label-choice" ${disabled ? "disabled" : ""}><option value="">${TagcastI18n.html("cleanup.labels.choose")}</option>${fallback}${options.map(i => `<option value="${escapeHtml(i.label)}" ${i.label === selected ? "selected" : ""}>${TagcastI18n.html("cleanup.labels.option", {label: i.label,
      albums: TagcastI18n.text("cleanup.labels.albums", {count: i.albums}), tracks: TagcastI18n.text("cleanup.labels.tracks", {count: i.tracks})})}</option>`).join("")}</select></label>
    ${labels ? `<div class="cleanup-controls"><span class="muted">${TagcastI18n.html("cleanup.labels.matching", {count: labels.total})}</span><button class="button small" data-cleanup-label-page="-50" ${disabled || cleanupView.labelsBusy || !labels.offset ? "disabled" : ""}>${TagcastI18n.html("cleanup.labels.previous")}</button><button class="button small" data-cleanup-label-page="50" ${disabled || cleanupView.labelsBusy || labels.offset + labels.limit >= labels.total ? "disabled" : ""}>${TagcastI18n.html("cleanup.labels.next")}</button></div>` : ""}
    ${selected ? `<p class="cleanup-rule-summary"><strong>${TagcastI18n.html("cleanup.labels.original")}</strong> ${escapeHtml(selected)}</p>` : ""}
    <label class="checkline"><input id="cleanup-label-remove" type="checkbox" ${cleanupView.removeLabel ? "checked" : ""} ${disabled ? "disabled" : ""}> ${TagcastI18n.html("cleanup.labels.remove")}</label>
    <p class="muted">${TagcastI18n.html("cleanup.labels.removeNote")}</p>
    <label class="field">${TagcastI18n.html("cleanup.labels.replacements")}<textarea id="cleanup-label-replacements" rows="5" maxlength="5000" ${disabled || cleanupView.removeLabel ? "disabled" : ""}>${escapeHtml(cleanupView.ruleText)}</textarea></label>
    <p class="muted">${TagcastI18n.html("cleanup.labels.note")}</p></section>`;
}

async function fetchGenreLabels() {
  if (!live() || cleanupView.category !== "genre-labels") return;
  const request = ++cleanupView.labelRequest, details = state.details;
  cleanupView.labelsBusy = true;
  renderCleanup();
  try {
    const data = await api(`/api/cleanup/labels?q=${encodeURIComponent(cleanupView.labelQuery)}&offset=${cleanupView.labelOffset}&limit=50`);
    if (request !== cleanupView.labelRequest || details !== state.details || cleanupView.category !== "genre-labels" || !live()) return;
    cleanupView.labels = data;
  } catch (error) {
    if (request === cleanupView.labelRequest) $("#cleanup-status").textContent = TagcastI18n.errorText(error);
  } finally {
    if (request === cleanupView.labelRequest && details === state.details) {
      cleanupView.labelsBusy = false; renderCleanup();
    }
  }
}

async function cleanupAction(action) {
  if (cleanupView.busy || !live()) return;
  if (action === "preview" && cleanupView.data?.id && !confirm(TagcastI18n.text("cleanup.confirm.replace"))) return;
  if (action === "start" && cleanupView.data?.state === "preview" && !$("#cleanup-approved").checked) return;
  const category = cleanupView.category || $("#cleanup-category").value;
  const rule = category === "genre-labels" ? {label: cleanupView.ruleLabel,
    replacements: cleanupView.removeLabel ? [] : cleanupView.ruleText.split(/\r?\n/).map(n => n.trim()).filter(Boolean),
    ...(cleanupView.removeLabel ? {remove: true} : {})} : {};
  if (action === "preview" && category === "genre-labels" && (!rule.label || (!rule.remove && !rule.replacements.length))) {
    $("#cleanup-status").textContent = TagcastI18n.text("cleanup.labels.missing"); return;
  }
  if (action === "start" && cleanupView.draftChanged) return;
  cleanupView.busy = true;
  renderCleanup();
  const details = state.details, request = ++cleanupView.request;
  setActionStatus("#cleanup-status", TagcastI18n.text(action === "preview" ? "cleanup.progress.preview" : action === "start" ? "cleanup.progress.start" : "cleanup.progress.stop"), true);
  clearTimeout(cleanupView.timer);
  try {
    const data = await api(`/api/cleanup/${action}`, action === "preview" ? {category, ...rule} : {id: cleanupView.data.id, excluded: [...cleanupView.excluded]});
    if (request !== cleanupView.request || details !== state.details || !live()) return;
    cleanupView.data = data;
    cleanupView.offset = 0;
    if (action === "preview") { cleanupView.excluded.clear(); cleanupView.draftChanged = false; }
    else cleanupView.excluded = new Set(data.excluded || []);
    renderCleanup();
    if (data.state === "running" && $("#cleanup").open) cleanupView.timer = setTimeout(fetchCleanup, 1500);
  } catch (error) {
    if (request === cleanupView.request) $("#cleanup-status").textContent = TagcastI18n.errorText(error);
    return;
  } finally {
    if (request !== cleanupView.request) return;
    cleanupView.busy = false;
    setActionStatus("#cleanup-status", undefined);
    renderCleanup();
  }
  setActionStatus("#cleanup-status", "");
}

// The exported report and its file name stay English data.
async function exportCleanupReport() {
  try {
    const data = await api("/api/cleanup/report");
    const link = document.createElement("a"), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
    link.href = url; link.download = `tagcast-cleanup-${data.category}-${data.id}.json`; link.click(); URL.revokeObjectURL(url);
  } catch (error) { $("#cleanup-status").textContent = TagcastI18n.errorText(error); }
}

document.addEventListener("click", async event => {
  if (event.target.closest("[data-cleanup-open]")) return openCleanup();
  if (event.target.closest("#cleanup-label-find")) {
    cleanupView.labelQuery = $("#cleanup-label-search").value; cleanupView.labelOffset = 0;
    return fetchGenreLabels();
  }
  const labelPage = event.target.closest("[data-cleanup-label-page]");
  if (labelPage) { cleanupView.labelOffset = Math.max(0, cleanupView.labelOffset + Number(labelPage.dataset.cleanupLabelPage)); return fetchGenreLabels(); }
  const action = event.target.closest("#cleanup-preview, #cleanup-start, #cleanup-stop");
  if (action) return cleanupAction(action.id.replace("cleanup-", ""));
  if (event.target.closest("#cleanup-export")) return exportCleanupReport();
  if (event.target.closest("#cleanup-refresh")) {
    if (cleanupView.data?.state === "running") return fetchCleanup();
    await loadLive(); await fetchCleanup(); return;
  }
  const page = event.target.closest("[data-cleanup-page]");
  if (page) { cleanupView.offset = Math.max(0, cleanupView.offset + Number(page.dataset.cleanupPage)); return fetchCleanup(); }
  const select = event.target.closest("#cleanup-select-all, #cleanup-select-none");
  if (select) {
    cleanupView.excluded = new Set(select.id === "cleanup-select-none" ? (cleanupView.data.selection || []).map(g => g.id) : []);
    renderCleanup();
  }
});
$("#cleanup").addEventListener("change", event => {
  if (event.target.id === "cleanup-category") {
    cleanupView.category = event.target.value; cleanupView.draftChanged = true;
    cleanupView.labelRequest += 1; cleanupView.labelsBusy = false;
    renderCleanup();
    if (cleanupView.category === "genre-labels") fetchGenreLabels();
    return;
  }
  if (event.target.id === "cleanup-label-choice") {
    cleanupView.ruleLabel = event.target.value; cleanupView.ruleText = event.target.value;
    cleanupView.removeLabel = false;
    setActionStatus("#cleanup-status", "");
    cleanupView.draftChanged = true; renderCleanup(); return;
  }
  if (event.target.id === "cleanup-label-remove") {
    cleanupView.removeLabel = event.target.checked;
    cleanupView.draftChanged = true; setActionStatus("#cleanup-status", "");
    renderCleanup(); return;
  }
  if (event.target.dataset.cleanupAlbum) {
    const id = event.target.dataset.cleanupAlbum;
    if (event.target.checked) cleanupView.excluded.delete(id); else cleanupView.excluded.add(id);
  }
  updateCleanupSelection();
});
$("#cleanup").addEventListener("input", event => {
  if (event.target.id === "cleanup-label-replacements") {
    cleanupView.ruleText = event.target.value; cleanupView.draftChanged = true;
    setActionStatus("#cleanup-status", "");
    const approval = $("#cleanup-approved"); if (approval) approval.checked = false;
    updateCleanupSelection();
  } else if (event.target.id === "cleanup-label-search") cleanupView.labelQuery = event.target.value;
});
$("#cleanup").addEventListener("close", () => { clearTimeout(cleanupView.timer); });
