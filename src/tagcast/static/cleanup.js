"use strict";

// Cleanup is an explicit server-side draft. Closing this dialog never cancels a job.
const cleanupView = {data: null, offset: 0, excluded: new Set(), request: 0, timer: null, busy: false,
  category: "", ruleLabel: "", ruleText: "", removeLabel: false, labelQuery: "", labelOffset: 0,
  labels: null, labelRequest: 0, labelsBusy: false, draftChanged: false};
const cleanupLabels = {genres: "Genres", "track-artists": "Track artists", composers: "Composers", "genre-labels": "Review genre labels"};

function resetCleanup(close = false) {
  cleanupView.request += 1;
  clearTimeout(cleanupView.timer);
  cleanupView.data = null; cleanupView.offset = 0; cleanupView.excluded.clear();
  cleanupView.busy = false;
  cleanupView.category = ""; cleanupView.ruleLabel = ""; cleanupView.ruleText = "";
  cleanupView.removeLabel = false;
  cleanupView.labels = null; cleanupView.labelQuery = ""; cleanupView.labelOffset = 0;
  cleanupView.labelRequest += 1; cleanupView.labelsBusy = false; cleanupView.draftChanged = false;
  $("#cleanup-status").textContent = "";
  $("#cleanup-content").innerHTML = '<p class="muted">Library reloaded. Reopen cleanup to see the latest report.</p>';
  if (close && $("#cleanup").open) $("#cleanup").close();
}

async function openCleanup() {
  if (!live()) { toast("Connect iBroadcast to clean up metadata."); return; }
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
    if (request === cleanupView.request) $("#cleanup-content").innerHTML = `<p class="error-text" role="status">${escapeHtml(error.message)}</p>`;
  }
}

function renderCleanup() {
  const data = cleanupView.data || {state: "empty"}, preview = data.state === "preview", running = data.state === "running";
  const scroll = $("#cleanup").scrollTop;
  const category = cleanupView.category || data.category || "genres";
  const picker = `<label class="cleanup-category">Category <select id="cleanup-category" ${running || cleanupView.busy ? "disabled" : ""}>${Object.entries(cleanupLabels).map(([key, label]) => `<option value="${key}" ${key === category ? "selected" : ""}>${label}</option>`).join("")}</select></label><button class="button" id="cleanup-preview" ${running || cleanupView.busy ? "disabled" : ""}>Prepare preview</button>`;
  const counts = data.counts || {};
  $("#cleanup-content").innerHTML = `<p class="muted">${category === "genre-labels" ? "Review an exact genre label and choose its replacements." : "Split names or genre labels containing a semicolon (;). Slashes, commas and ampersands are kept."} Album artists and other metadata stay unchanged. <strong>After you approve and start, changes are saved to iBroadcast.</strong></p><div class="cleanup-controls">${picker}</div>
    ${category === "genre-labels" ? genreLabelControls(running || cleanupView.busy) : ""}
    ${data.id ? `<div class="notice">${escapeHtml(cleanupLabels[data.category])}: ${data.albums.toLocaleString("en")} albums · ${data.tracks.toLocaleString("en")} affected tracks. Batches contain up to ${data.batch_tracks} tracks from ${data.batch_albums} albums.</div>
    ${data.mapping ? `<p class="cleanup-rule-summary"><strong>Reviewed rule:</strong> ${escapeHtml(data.mapping.label)} → ${escapeHtml(data.mapping.remove ? "Remove this label" : data.mapping.replacements.join(" · "))}</p>` : ""}
    ${preview ? '<p>Review the examples below. Export the full report to inspect every track. Uncheck an album to exclude all its discs and tracks.</p><div class="cleanup-controls"><button class="text-action" id="cleanup-select-all">Select all albums</button><button class="text-action" id="cleanup-select-none">Exclude all albums</button><span id="cleanup-selected" role="status"></span></div>' : `<p role="status"><strong>${escapeHtml(data.state)}</strong> · ${counts.confirmed || 0} confirmed · ${counts.pending || 0} pending · ${counts.sent || 0} sent / checking · ${counts.unconfirmed || 0} unconfirmed · ${counts.conflict || 0} conflicts · ${counts.excluded || 0} excluded</p>`}
    ${data.error ? `<p class="warn-box" role="status">${escapeHtml(data.error)}</p>` : ""}
    <div class="cleanup-albums">${data.groups.map(g => `<section class="cleanup-album"><h3>${preview ? `<label><input type="checkbox" data-cleanup-album="${escapeHtml(g.id)}" ${cleanupView.excluded.has(g.id) ? "" : "checked"}> ` : ""}${escapeHtml(g.album)}${preview ? "</label>" : ""}</h3><p class="muted">${escapeHtml(g.artist)} · ${g.tracks} affected tracks</p>${g.examples.map(e => `<div class="cleanup-example"><strong>${escapeHtml(e.title)}</strong><div><span>Before</span><span>${escapeHtml(e.before.join(" · "))}</span></div><div><span>After</span><span>${escapeHtml(e.after.length ? e.after.join(" · ") : "No genres")}</span></div></div>`).join("")}</section>`).join("") || '<p class="muted">No changes found for this preview.</p>'}</div>
    <div class="pagination"><button class="button small" data-cleanup-page="-25" ${cleanupView.offset <= 0 ? "disabled" : ""}>← Previous</button><span>${data.albums ? Math.floor(cleanupView.offset / 25) + 1 : 0} / ${Math.ceil(data.albums / 25)}</span><button class="button small" data-cleanup-page="25" ${cleanupView.offset + 25 >= data.albums ? "disabled" : ""}>Next →</button></div>
    <p class="muted">The latest draft and report are saved on this computer. Stop prevents further writes; saved changes remain. Resume checks outstanding writes before continuing. A new preview replaces the previous report.</p>
    ${preview && data.tracks ? '<label class="checkline"><input id="cleanup-approved" type="checkbox"> I reviewed this draft and approve changing the selected albums.</label>' : ""}
    <div class="dialog-footer"><button class="button" id="cleanup-export">Export full report ↓</button>${running ? '<button class="button danger" id="cleanup-stop">Stop after current request</button>' : data.tracks && data.state !== "done" ? `<button class="button primary" id="cleanup-start" ${preview || cleanupView.busy || cleanupView.draftChanged ? "disabled" : ""}>${preview ? "Start selected albums" : "Resume after checking"}</button>` : ""}<button class="button" id="cleanup-refresh">${running ? "Refresh progress" : "Refresh library"}</button></div>` : '<p class="muted">Choose a category and prepare a preview. Nothing is written until you review and start it.</p>'}`;
  $("#cleanup").scrollTop = scroll;
  updateCleanupSelection();
}

function updateCleanupSelection() {
  const data = cleanupView.data;
  if (!data || data.state !== "preview") return;
  const selected = (data.selection || []).filter(g => !cleanupView.excluded.has(g.id));
  $("#cleanup-selected").textContent = `${selected.length.toLocaleString("en")} albums · ${selected.reduce((n, g) => n + g.tracks, 0).toLocaleString("en")} tracks selected`;
  const start = $("#cleanup-start");
  if (start) start.disabled = cleanupView.busy || cleanupView.draftChanged || !selected.length || !$("#cleanup-approved")?.checked;
}

function genreLabelControls(disabled) {
  const labels = cleanupView.labels;
  const options = labels?.labels || [];
  const selected = cleanupView.ruleLabel;
  const fallback = selected && !options.some(i => i.label === selected)
    ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : "";
  return `<section class="genre-label-review"><h3>Choose an exact label and write its replacements</h3>
    <p class="muted">No separators are guessed. Keep Films/Games as one line if it is one genre. Uncertain text such as R stays until you explicitly change it. Only this exact label is replaced; each track keeps its other genres.</p>
    <div class="cleanup-controls"><label class="field">Search stored labels<input id="cleanup-label-search" value="${escapeHtml(cleanupView.labelQuery)}" ${disabled ? "disabled" : ""}></label><button class="button small" id="cleanup-label-find" ${disabled || cleanupView.labelsBusy ? "disabled" : ""}>${cleanupView.labelsBusy ? "Loading…" : "Find labels"}</button></div>
    <label class="field">Existing genre label<select id="cleanup-label-choice" ${disabled ? "disabled" : ""}><option value="">Choose a label…</option>${fallback}${options.map(i => `<option value="${escapeHtml(i.label)}" ${i.label === selected ? "selected" : ""}>${escapeHtml(i.label)} (${i.albums} albums · ${i.tracks} tracks)</option>`).join("")}</select></label>
    ${labels ? `<div class="cleanup-controls"><span class="muted">${labels.total} matching labels</span><button class="button small" data-cleanup-label-page="-50" ${disabled || cleanupView.labelsBusy || !labels.offset ? "disabled" : ""}>← Previous labels</button><button class="button small" data-cleanup-label-page="50" ${disabled || cleanupView.labelsBusy || labels.offset + labels.limit >= labels.total ? "disabled" : ""}>Next labels →</button></div>` : ""}
    ${selected ? `<p class="cleanup-rule-summary"><strong>Original:</strong> ${escapeHtml(selected)}</p>` : ""}
    <label class="checkline"><input id="cleanup-label-remove" type="checkbox" ${cleanupView.removeLabel ? "checked" : ""} ${disabled ? "disabled" : ""}> Remove this label from matching tracks</label>
    <p class="muted">Other genres stay. If this is the only genre, the track will have no genre.</p>
    <label class="field">Replacement genres · one label per line<textarea id="cleanup-label-replacements" rows="5" maxlength="5000" ${disabled || cleanupView.removeLabel ? "disabled" : ""}>${escapeHtml(cleanupView.ruleText)}</textarea></label>
    <p class="muted">The first label takes this label's position. Prepare a new preview after changing the rule. Nothing is saved until you review and start.</p></section>`;
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
    if (request === cleanupView.labelRequest) $("#cleanup-status").textContent = error.message;
  } finally {
    if (request === cleanupView.labelRequest && details === state.details) {
      cleanupView.labelsBusy = false; renderCleanup();
    }
  }
}

async function cleanupAction(action) {
  if (cleanupView.busy || !live()) return;
  if (action === "preview" && cleanupView.data?.id && !confirm("Replace the previous cleanup draft and report? Export it first if you want to keep a copy.")) return;
  if (action === "start" && cleanupView.data?.state === "preview" && !$("#cleanup-approved").checked) return;
  const category = cleanupView.category || $("#cleanup-category").value;
  const rule = category === "genre-labels" ? {label: cleanupView.ruleLabel,
    replacements: cleanupView.removeLabel ? [] : cleanupView.ruleText.split(/\r?\n/).map(n => n.trim()).filter(Boolean),
    ...(cleanupView.removeLabel ? {remove: true} : {})} : {};
  if (action === "preview" && category === "genre-labels" && (!rule.label || (!rule.remove && !rule.replacements.length))) {
    $("#cleanup-status").textContent = "Choose a label and enter replacements or select Remove this label."; return;
  }
  if (action === "start" && cleanupView.draftChanged) return;
  cleanupView.busy = true;
  renderCleanup();
  const details = state.details, request = ++cleanupView.request;
  $("#cleanup-status").textContent = action === "preview" ? "Preparing a read-only preview…" : action === "start" ? "Checking your library and starting…" : "Stopping after the current request…";
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
    if (request === cleanupView.request) $("#cleanup-status").textContent = error.message;
    return;
  } finally {
    if (request !== cleanupView.request || details !== state.details || !live()) return;
    cleanupView.busy = false;
    renderCleanup();
  }
  $("#cleanup-status").textContent = "";
}

async function exportCleanupReport() {
  try {
    const data = await api("/api/cleanup/report");
    const link = document.createElement("a"), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
    link.href = url; link.download = `tagcast-cleanup-${data.category}-${data.id}.json`; link.click(); URL.revokeObjectURL(url);
  } catch (error) { $("#cleanup-status").textContent = error.message; }
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
    $("#cleanup-status").textContent = "";
    cleanupView.draftChanged = true; renderCleanup(); return;
  }
  if (event.target.id === "cleanup-label-remove") {
    cleanupView.removeLabel = event.target.checked;
    cleanupView.draftChanged = true; $("#cleanup-status").textContent = "";
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
    $("#cleanup-status").textContent = "";
    const approval = $("#cleanup-approved"); if (approval) approval.checked = false;
    updateCleanupSelection();
  } else if (event.target.id === "cleanup-label-search") cleanupView.labelQuery = event.target.value;
});
$("#cleanup").addEventListener("close", () => { clearTimeout(cleanupView.timer); });
