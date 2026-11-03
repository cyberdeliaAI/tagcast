"use strict";

// Explicit local file uploads; independent of playback and metadata save drafts.
const musicUploadsView = {enabled: false, authorized: false, session: "", data: null,
  request: 0, page: 0, timer: null, busy: false, initialized: false, error: "", focus: false, selectionCleared: false};

function applyMusicUploadSettings(data) {
  const v = musicUploadsView;
  v.enabled = data.music_uploads === true;
  v.authorized = data.music_uploads_authorized === true;
  updateMusicUploadPermission();
  if (typeof applySidebarLayout === "function") applySidebarLayout();
  if (state.screen === "uploads") syncMusicUploadsPage();
}

function musicUploadPermissionGranted() {
  return state.connection.music_uploads_authorized ?? musicUploadsView.authorized;
}

function musicUploadPermissionNote() {
  return TagcastI18n.text(musicUploadPermissionGranted() ? "uploads.permission.approved" : "uploads.permission.needed");
}

function updateMusicUploadPermission() {
  const button = $("#music-upload-authorize"), note = $("#music-upload-permission-note");
  if (button) {
    button.hidden = musicUploadPermissionGranted();
    button.disabled = !musicUploadsView.enabled;
    if (button.hidden && document.activeElement === button) $("#music-upload-open")?.focus();
  }
  if (note) note.textContent = musicUploadPermissionNote();
}

// Static labels carry data-i18n, so they follow a language change without rebuilding
// the Settings form; the permission note is updated by updateMusicUploadPermission().
function musicUploadsSettingsPanel() {
  return `<section class="playback-settings music-upload-settings" data-settings-category="data"><h3 data-i18n="uploads.settings.heading">${TagcastI18n.html("uploads.settings.heading")} <span class="settings-mode" data-i18n="uploads.settings.mode">${TagcastI18n.html("uploads.settings.mode")}</span></h3>
    <label class="checkline" data-i18n="uploads.settings.enable"><input type="checkbox" name="music_uploads" ${musicUploadsView.enabled ? "checked" : ""}> ${TagcastI18n.html("uploads.settings.enable")}</label>
    <p class="muted" data-i18n="uploads.settings.note">${TagcastI18n.html("uploads.settings.note")}</p>
    <p class="muted" id="music-upload-permission-note">${escapeHtml(musicUploadPermissionNote())}</p>
    <div class="downloads-buttons"><button type="button" class="button small" id="music-upload-authorize" data-music-upload-authorize data-i18n="uploads.settings.approve" ${musicUploadPermissionGranted() ? "hidden" : ""} ${musicUploadsView.enabled ? "" : "disabled"}>${TagcastI18n.html("uploads.settings.approve")}</button><button type="button" class="button small" id="music-upload-open" data-music-upload-open data-i18n="uploads.settings.open" ${musicUploadsView.enabled ? "" : "disabled"}>${TagcastI18n.html("uploads.settings.open")}</button></div></section>`;
}

function musicUploadsActive(data = musicUploadsView.data) {
  return Boolean(data?.preparing || ["ready", "running", "paused"].includes(data?.job?.state));
}

function musicUploadsReady() {
  return musicUploadsView.enabled && musicUploadPermissionGranted() && live() && !state.loading
    && Boolean(state.connection.playback_session);
}

function musicUploadsIntro() {
  return `<section class="page-intro"><div><div class="eyebrow" data-i18n="uploads.page.eyebrow">${TagcastI18n.html("uploads.page.eyebrow")}</div><h1 data-i18n="uploads.page.heading">${TagcastI18n.html("uploads.page.heading")}<span>.</span></h1><p data-i18n="uploads.page.intro">${TagcastI18n.html("uploads.page.intro")}</p></div></section>`;
}

// Built once per session and kept while it holds the chosen paths: static labels carry
// data-i18n so a language change rewrites them in place; the rest is set by renderMusicUploads().
function musicUploadMarkup() {
  const native = typeof window.tagcastUploads?.choose === "function";
  // Closes an opening tag with its data-i18n key and text: `<p ${label(key)}</p>`.
  const label = key => `data-i18n="${key}">${TagcastI18n.html(key)}`;
  return `${musicUploadsIntro()}<section class="card uploads-setup" id="music-upload-setup"><h2 ${label("uploads.form.heading")}</h2>
    <p class="muted" ${label("uploads.form.intro")}</p>
    <form id="music-upload-form"><fieldset id="music-upload-selection">
      ${native ? `<div class="downloads-buttons"><button type="button" class="button" data-music-upload-choose="files" ${label("uploads.form.chooseFiles")}</button><button type="button" class="button" data-music-upload-choose="folder" ${label("uploads.form.chooseFolder")}</button><span id="music-upload-chosen" class="muted">${TagcastI18n.html("uploads.selection.none")}</span></div>` : ""}
      <details id="music-upload-path-details" ${native ? "" : "open"}><summary ${label("uploads.form.paths")}</summary>
        <label class="field" ${label("uploads.form.pathsLabel")}<textarea id="music-upload-paths" rows="4" required spellcheck="false" placeholder="${TagcastI18n.html("uploads.form.pathsPlaceholder")}" data-i18n-attr="placeholder=uploads.form.pathsPlaceholder" aria-describedby="music-upload-path-help"></textarea><small id="music-upload-path-help" ${label("uploads.form.pathsHelp")}</small></label>
      </details>
      <div class="downloads-buttons"><button type="submit" class="button primary" id="music-upload-prepare" ${label("uploads.form.prepare")}</button></div>
    </fieldset></form>
    <details class="uploads-guide"><summary ${label("uploads.guide.heading")}</summary>
      <p ${label("uploads.guide.preparation")}</p>
      <p ${label("uploads.guide.tags")}</p>
      <p ${label("uploads.guide.privacy")}</p>
      <p ${label("uploads.guide.pause")}</p>
      <p ${label("uploads.guide.session")}</p>
    </details></section>
    <p id="music-upload-error" class="error-text" role="alert" hidden></p>
    <section class="card uploads-results" id="music-upload-results" hidden>
      <div class="downloads-heading"><h2 id="music-upload-heading" tabindex="-1">${TagcastI18n.html("uploads.results.review")}</h2><div class="downloads-buttons">
        <button type="button" class="button primary" id="music-upload-start" data-music-upload-action="start" hidden>${TagcastI18n.html("uploads.results.startPlain")}</button>
        <button type="button" class="button small" id="music-upload-pause" data-music-upload-action="pause" hidden ${label("uploads.results.pause")}</button>
        <button type="button" class="button small" id="music-upload-resume" data-music-upload-action="resume" hidden ${label("uploads.results.resume")}</button>
        <button type="button" class="button small" id="music-upload-stop" data-music-upload-action="stop" hidden ${label("uploads.results.stop")}</button>
        <button type="button" class="button" id="music-upload-clear" data-music-upload-action="clear" hidden>${TagcastI18n.html("uploads.results.change")}</button>
        <button type="button" class="button" id="music-upload-reload" hidden ${label("common.reloadLibrary")}</button>
      </div></div>
      <p id="music-upload-phase" role="status"></p><p class="muted" id="music-upload-summary"></p>
      <progress id="music-upload-progress" hidden aria-label="${TagcastI18n.html("uploads.results.progress")}" data-i18n-attr="aria-label=uploads.results.progress"></progress>
      <p class="muted uploads-current" id="music-upload-current" hidden></p>
      <p class="warning-text" id="music-upload-uncertain" hidden ${label("uploads.results.uncertain")}</p>
      <p class="muted" id="music-upload-finished-note" hidden ${label("uploads.results.finished")}</p>
      <ul class="uploads-files" id="music-upload-files"></ul>
      <div class="uploads-pagination" id="music-upload-pagination"><button type="button" class="button small" data-music-upload-page="-1" ${label("common.pagination.previous")}</button><span id="music-upload-page"></span><button type="button" class="button small" data-music-upload-page="1" ${label("common.pagination.next")}</button></div>
    </section>`;
}

// Status codes from the server and the interface text keys shown for them.
const musicUploadLabels = {new: "uploads.status.new", uploaded: "uploads.status.alreadyUploaded", duplicate: "uploads.status.duplicate",
  too_large: "uploads.status.tooLarge", empty: "uploads.status.empty", unreadable: "uploads.status.unreadable", unsupported: "uploads.status.unsupported", not_regular: "uploads.status.notRegular",
  queued: "uploads.status.queued", sending: "uploads.status.sending", sent: "uploads.status.uploaded", confirmed: "uploads.status.uploaded",
  failed: "uploads.status.failed", uncertain: "uploads.status.uncertain", stopped: "uploads.status.stopped", not_sent: "uploads.status.notSent"};
// The same statuses counted in the summary line ("3 too large").
const musicUploadCountLabels = {new: "uploads.summary.new", uploaded: "uploads.summary.alreadyUploaded", duplicate: "uploads.summary.duplicate",
  too_large: "uploads.summary.tooLarge", empty: "uploads.summary.empty", unreadable: "uploads.summary.unreadable", unsupported: "uploads.summary.unsupported", not_regular: "uploads.summary.notRegular",
  queued: "uploads.summary.queued", sending: "uploads.summary.sending",
  failed: "uploads.summary.failed", uncertain: "uploads.summary.uncertain", stopped: "uploads.summary.stopped", not_sent: "uploads.summary.notSent"};

function musicUploadStatusLabel(status) {
  return Object.hasOwn(musicUploadLabels, status) ? TagcastI18n.html(musicUploadLabels[status]) : escapeHtml(status);
}

function musicUploadComplete(data) {
  const counts = data?.job?.counts || {};
  return Boolean(data?.job?.state === "done" && !data.error && (counts.sent || counts.confirmed)
    && Object.entries(counts).every(([status, n]) => !n || ["sent", "confirmed", "uploaded", "duplicate"].includes(status)));
}

function musicUploadSummary(data) {
  const counts = {...(data.job?.counts || data.summary.counts)};
  const received = (counts.sent || 0) + (counts.confirmed || 0);
  delete counts.sent; delete counts.confirmed;
  return [TagcastI18n.text("uploads.summary.files", {count: Number(data.summary.files || 0)}),
    ...(received ? [TagcastI18n.text("uploads.summary.received", {count: received})] : []),
    ...Object.entries(counts).filter(([, n]) => n).map(([key, n]) => Object.hasOwn(musicUploadCountLabels, key)
      ? TagcastI18n.text(musicUploadCountLabels[key], {count: Number(n)}) : TagcastI18n.text("uploads.summary.other", {count: Number(n), status: key.toLowerCase()})),
    ...(data.ignored ? [TagcastI18n.text("uploads.summary.ignored", {count: Number(data.ignored)})] : [])].join(" · ");
}

function musicUploadFileRows(items, active, expanded = new Set()) {
  const groups = [];
  for (const item of items) {
    const slash = item.label.lastIndexOf("/"), folder = item.label.slice(0, Math.max(0, slash));
    const name = item.label.slice(slash + 1), success = ["sent", "confirmed"].includes(item.status);
    const problem = ["uncertain", "failed", "too_large", "empty", "unreadable", "unsupported", "not_regular", "stopped", "not_sent"].includes(item.status);
    // Server notes are shown as sent; "Not verified:" is the server's own marker.
    let note = item.note || "";
    if (success) note = TagcastI18n.text(item.verified ? "uploads.file.verified" : active ? "uploads.file.checkFollows"
      : note.startsWith("Not verified:") ? "uploads.file.checkUnavailable" : "uploads.file.checkPending");
    const row = `<li class="uploads-file"><div class="uploads-file-info"><strong>${escapeHtml(name)}</strong><small>${bytes(item.size)}</small>${note ? problem ? `<p class="uploads-file-note">${escapeHtml(note)}</p>` : `<details data-upload-file="${escapeHtml(item.label)}" ${expanded.has(item.label) ? "open" : ""}><summary>${TagcastI18n.html("uploads.file.details")}</summary><p>${escapeHtml(note)}</p></details>` : ""}</div><span class="uploads-file-status${success ? " is-uploaded" : problem ? " is-problem" : ""}">${musicUploadStatusLabel(item.status)}</span></li>`;
    if (groups.at(-1)?.folder !== folder) groups.push({folder, rows: []});
    groups.at(-1).rows.push(row);
  }
  return groups.map(group => `<li class="uploads-folder">${group.folder ? `<h3>${escapeHtml(group.folder)}</h3>` : ""}<ul>${group.rows.join("")}</ul></li>`).join("");
}

function updateMusicUploadSelection() {
  const count = $("#music-upload-paths").value.split(/\r?\n/).filter(p => p.trim()).length;
  const chosen = $("#music-upload-chosen");
  if (chosen) chosen.textContent = count ? TagcastI18n.text("uploads.selection.chosen", {count}) : TagcastI18n.text("uploads.selection.none");
}

function focusMusicUploadPaths() {
  $("#music-upload-path-details").open = true;
  $("#music-upload-paths").focus();
}

// The server's own phase and job messages are shown as sent, after Tagcast's sentence.
function musicUploadPhase(data) {
  if (data.preparing) return data.total ? `${data.phase} ${TagcastI18n.text("uploads.phase.checked", {checked: data.checked, total: data.total})}` : `${data.phase}`;
  const job = data.job;
  if (!job) return data.phase;
  const counts = job.counts;
  const needsChecking = Object.keys(counts).some(key => counts[key] && !["sent", "confirmed", "uploaded", "duplicate"].includes(key));
  const label = TagcastI18n.text(job.state === "paused" ? counts.sending ? "uploads.phase.pausing" : "uploads.phase.paused"
    : job.state === "done" ? needsChecking ? "uploads.phase.toCheck" : "uploads.phase.complete"
    : job.state === "stopped" ? "uploads.phase.stopped" : job.state === "failed" ? "uploads.phase.failed" : "uploads.phase.uploading");
  return `${label}${job.message ? ` ${job.message}` : ""}`;
}

function renderMusicUploads() {
  if (state.screen !== "uploads") return;
  const v = musicUploadsView, page = $("#uploads-page");
  if (state.loading) {
    v.initialized = false;
    page.innerHTML = musicUploadsIntro() + `<p role="status">${TagcastI18n.html("uploads.page.waiting")}</p>`;
    return;
  }
  if (!musicUploadsReady()) {
    v.initialized = false;
    const [heading, text] = !v.enabled ? ["uploads.setup.enableHeading", "uploads.setup.enableText"]
      : !live() ? ["uploads.setup.connectHeading", "uploads.setup.connectText"] : ["uploads.setup.approveHeading", "uploads.setup.approveText"];
    page.innerHTML = musicUploadsIntro() + `<section class="card"><h2>${TagcastI18n.html(heading)}</h2><p>${TagcastI18n.html(text)}</p><button type="button" class="button" data-music-upload-settings>${TagcastI18n.html("uploads.setup.openSettings")}</button>${v.enabled ? `<button type="button" class="button primary" data-music-upload-authorize>${TagcastI18n.html("uploads.setup.connect")}</button>` : ""}</section>`;
    return;
  }
  if (!v.initialized) { page.innerHTML = musicUploadMarkup(); v.initialized = true; }
  const d = v.data, active = musicUploadsActive(d), locked = active || v.busy;
  $("#music-upload-selection").disabled = locked || Boolean(d?.review);
  const error = v.error || d?.error;
  $("#music-upload-error").hidden = !error; $("#music-upload-error").textContent = error || "";
  const results = Boolean(d && (active || d.review || d.job || d.summary.files));
  // Keep the form DOM/draft, but let the review or results take the main place.
  $("#music-upload-setup").hidden = results;
  $("#music-upload-results").hidden = !results;
  updateMusicUploadSelection();
  if (!d) return;
  const job = d.job, counts = job?.counts || d.summary.counts;
  if (musicUploadComplete(d) && !v.selectionCleared) {
    $("#music-upload-paths").value = ""; v.selectionCleared = true; updateMusicUploadSelection();
  }
  $("#music-upload-heading").textContent = TagcastI18n.text(job ? active ? "uploads.results.uploading" : "uploads.results.done" : d.preparing ? "uploads.results.preparing" : "uploads.results.review");
  const phase = musicUploadPhase(d);
  const phaseNode = $("#music-upload-phase");
  // Compared with the translated text, so a language change rewrites it once and polling never does.
  if (phaseNode.textContent !== phase) phaseNode.textContent = phase;
  setActionStatus("#music-upload-phase", undefined, active && (job?.state !== "paused" || Boolean(counts.sending)));
  $("#music-upload-summary").textContent = musicUploadSummary(d);
  const progress = $("#music-upload-progress"); progress.hidden = !job || !active;
  if (job) { progress.max = Math.max(1, job.bytes.total); progress.value = job.bytes.sent; }
  $("#music-upload-current").hidden = !active || !job?.current;
  $("#music-upload-current").textContent = job?.current || "";
  $("#music-upload-uncertain").hidden = !counts.uncertain;
  // Byte progress changes frequently; it does not change a file row or its Details.
  const list = $("#music-upload-files"), signature = JSON.stringify([d.items.map(({label, size, status, note, verified}) => ({label, size, status, note, verified})), active, TagcastI18n.language]);
  if (list.dataset.items !== signature) {
    const expanded = new Set([...list.querySelectorAll("details[open]")].map(node => node.dataset.uploadFile));
    const focused = document.activeElement?.closest?.("#music-upload-files details")?.dataset.uploadFile;
    list.innerHTML = musicUploadFileRows(d.items, active, expanded);
    list.dataset.items = signature;
    if (focused) {
      const detail = [...list.querySelectorAll("details")].find(node => node.dataset.uploadFile === focused);
      if (detail) detail.querySelector("summary").focus({preventScroll: true}); else v.focus = true;
    }
  }
  v.page = d.page;
  $("#music-upload-page").textContent = `${d.page + 1} / ${d.pages}`;
  $("#music-upload-pagination").hidden = d.pages <= 1;
  for (const button of page.querySelectorAll("[data-music-upload-page]")) button.disabled = v.busy || (Number(button.dataset.musicUploadPage) < 0 ? !d.page : d.page + 1 >= d.pages);
  const start = $("#music-upload-start"); start.hidden = !d.review;
  start.textContent = TagcastI18n.text("uploads.results.start", {count: Number(counts.new || 0), size: bytes(d.summary.bytes_to_send)});
  start.disabled = locked || !counts.new;
  const visibility = {pause: job?.state === "running", resume: job?.state === "paused", stop: active, clear: results && !active};
  for (const [action, visible] of Object.entries(visibility)) {
    const button = $("#music-upload-" + action);
    button.hidden = !visible; button.disabled = v.busy;
    if (!visible && document.activeElement === button) v.focus = true;
  }
  $("#music-upload-clear").textContent = TagcastI18n.text(job && musicUploadComplete(d) ? "uploads.results.new" : "uploads.results.change");
  $("#music-upload-reload").hidden = !job || active;
  $("#music-upload-finished-note").hidden = !job || active;
  if ($("#music-upload-setup").hidden && document.activeElement?.closest?.("#music-upload-setup")) v.focus = true;
  if (v.focus) { v.focus = false; if (results) $("#music-upload-heading").focus(); else focusMusicUploadPaths(); }
}

function syncMusicUploadsPage() {
  const v = musicUploadsView;
  clearTimeout(v.timer); v.timer = null;
  if (v.session !== state.connection.playback_session) {
    v.session = state.connection.playback_session || ""; v.request++; v.data = null;
    v.initialized = false; v.busy = false; v.error = ""; v.page = 0; v.selectionCleared = false;
  }
  updateMusicUploadPermission();
  if (state.screen !== "uploads") return;
  renderMusicUploads();
  if (musicUploadsReady() && !v.busy) loadMusicUploads();
}

function scheduleMusicUploads() {
  const v = musicUploadsView;
  clearTimeout(v.timer); v.timer = null;
  if (state.screen === "uploads" && musicUploadsActive() && !document.hidden && musicUploadsReady()) {
    v.timer = setTimeout(loadMusicUploads, 1500);
  }
}

async function loadMusicUploads() {
  const v = musicUploadsView;
  if (!musicUploadsReady() || v.busy || state.screen !== "uploads") return;
  const request = ++v.request, session = state.connection.playback_session;
  try {
    const data = await api(`/api/uploads?session=${encodeURIComponent(session)}&page=${v.page}`);
    if (request !== v.request || session !== state.connection.playback_session || !musicUploadsReady()) return;
    v.data = data; v.error = "";
  } catch (error) { if (request === v.request) v.error = TagcastI18n.errorText(error); }
  if (request === v.request) { renderMusicUploads(); scheduleMusicUploads(); }
}

async function musicUploadAction(action, body = {}) {
  const v = musicUploadsView;
  if (!musicUploadsReady() || v.busy) return;
  const session = state.connection.playback_session, request = ++v.request;
  v.busy = true; v.error = ""; clearTimeout(v.timer); renderMusicUploads();
  try {
    const data = await api(`/api/uploads/${action}`, {...body, session});
    if (request !== v.request || session !== state.connection.playback_session || !musicUploadsReady()) return;
    v.data = data;
    if (["prepare", "clear"].includes(action)) v.selectionCleared = false;
    if (["prepare", "start"].includes(action)) v.focus = true;
  } catch (error) { if (request === v.request) v.error = TagcastI18n.errorText(error); }
  finally {
    if (request === v.request) {
      v.busy = false; renderMusicUploads(); scheduleMusicUploads();
      if (action === "clear" && !v.error && state.screen === "uploads") focusMusicUploadPaths();
    }
  }
}

document.addEventListener("input", event => {
  if (event.target.id === "music-upload-paths") updateMusicUploadSelection();
});
document.addEventListener("invalid", event => {
  if (event.target.id === "music-upload-paths") focusMusicUploadPaths();
}, true);

$("#show-uploads").addEventListener("click", () => showScreen("uploads"));
$("#uploads-page").addEventListener("submit", event => {
  if (event.target.id !== "music-upload-form") return;
  event.preventDefault();
  const paths = $("#music-upload-paths").value.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  musicUploadsView.page = 0;
  musicUploadAction("prepare", {paths});
});
document.addEventListener("click", async event => {
  const target = event.target;
  if (target.closest("[data-music-upload-settings]")) return openSettings("data");
  if (target.closest("[data-music-upload-open]")) return showScreen("uploads");
  if (target.closest("[data-music-upload-authorize]")) {
    if (!musicUploadsView.enabled) { toast(TagcastI18n.text("uploads.permission.saveFirst")); return; }
    connectView("ready"); $("#connect").showModal(); return;
  }
  const action = target.closest("[data-music-upload-action]");
  if (action) return musicUploadAction(action.dataset.musicUploadAction, {review: musicUploadsView.data?.review});
  const paging = target.closest("[data-music-upload-page]");
  if (paging) { musicUploadsView.page += Number(paging.dataset.musicUploadPage); return loadMusicUploads(); }
  if (target.id === "music-upload-reload") { loadLive(); return; }
  const choose = target.closest("[data-music-upload-choose]");
  if (!choose || !musicUploadsReady() || musicUploadsActive() || musicUploadsView.busy) return;
  const session = state.connection.playback_session, v = musicUploadsView;
  let picked = false;
  v.busy = true; renderMusicUploads();
  try {
    const result = await window.tagcastUploads.choose(choose.dataset.musicUploadChoose);
    if (session !== state.connection.playback_session || !musicUploadsReady() || state.screen !== "uploads") return;
    // The desktop picker reports a code beside its English message, so the error is shown translated.
    if (result.error) throw Object.assign(new Error(result.error), typeof result.code === "string" ? {code: result.code} : {});
    if (Array.isArray(result.paths) && result.paths.length) {
      const field = $("#music-upload-paths");
      field.value = [...new Set([...field.value.split(/\r?\n/).filter(Boolean), ...result.paths])].join("\n");
      if (v.data?.review) { await api("/api/uploads/clear", {session}); v.data = null; }
      updateMusicUploadSelection(); picked = true;
    }
  } catch (error) { if (session === state.connection.playback_session) v.error = TagcastI18n.errorText(error); }
  finally {
    if (session === state.connection.playback_session) {
      v.busy = false; renderMusicUploads();
      if (state.screen === "uploads") {
        if (picked) $("#music-upload-prepare").focus(); else choose.focus();
      }
    }
  }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncMusicUploadsPage(); else clearTimeout(musicUploadsView.timer); });
// A language change redraws from memory: no request, no change to a running job, its
// poll or the chosen paths. The open form keeps its DOM (labels switch via data-i18n).
TagcastI18n.subscribe(() => {
  updateMusicUploadPermission();
  if (state.screen === "uploads") renderMusicUploads();
});
window.addEventListener("beforeunload", event => {
  if (musicUploadsActive() && musicUploadsView.session === state.connection.playback_session) {
    event.preventDefault(); event.returnValue = "";
  }
});
