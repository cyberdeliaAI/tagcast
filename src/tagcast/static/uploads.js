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
  return musicUploadPermissionGranted() ? "Upload permission is approved for this connection."
    : "Save Enable music uploads, then reconnect once to approve the additional upload permission.";
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

function musicUploadsSettingsPanel() {
  return `<section class="playback-settings music-upload-settings" data-settings-category="data"><h3>Music uploads <span class="settings-mode">Save required</span></h3>
    <label class="checkline"><input type="checkbox" name="music_uploads" ${musicUploadsView.enabled ? "checked" : ""}> Enable music uploads</label>
    <p class="muted">Off by default. Upload selected local audio files to your own iBroadcast library. Files are read only when you prepare a selection and sent only after you review and start. No folder watching, local edits or automatic deletions.</p>
    <p class="muted" id="music-upload-permission-note">${musicUploadPermissionNote()}</p>
    <div class="downloads-buttons"><button type="button" class="button small" id="music-upload-authorize" data-music-upload-authorize ${musicUploadPermissionGranted() ? "hidden" : ""} ${musicUploadsView.enabled ? "" : "disabled"}>Approve upload permission…</button><button type="button" class="button small" id="music-upload-open" data-music-upload-open ${musicUploadsView.enabled ? "" : "disabled"}>Open Uploads →</button></div></section>`;
}

function musicUploadsActive(data = musicUploadsView.data) {
  return Boolean(data?.preparing || ["ready", "running", "paused"].includes(data?.job?.state));
}

function musicUploadsReady() {
  return musicUploadsView.enabled && musicUploadPermissionGranted() && live() && !state.loading
    && Boolean(state.connection.playback_session);
}

function musicUploadsIntro() {
  return '<section class="page-intro"><div><div class="eyebrow">YOUR MUSIC, IN YOUR LIBRARY</div><h1>Uploads<span>.</span></h1><p>Add local music to your iBroadcast library. Prepare a selection, check the files, then start when you are ready.</p></div></section>';
}

function musicUploadMarkup() {
  const native = typeof window.tagcastUploads?.choose === "function";
  return `${musicUploadsIntro()}<section class="card uploads-setup" id="music-upload-setup"><h2>Choose local music</h2>
    <p class="muted">Choose files or folders, then review before sending. Original files stay untouched.</p>
    <form id="music-upload-form"><fieldset id="music-upload-selection">
      ${native ? '<div class="downloads-buttons"><button type="button" class="button" data-music-upload-choose="files">Choose files…</button><button type="button" class="button" data-music-upload-choose="folder">Choose folder…</button><span id="music-upload-chosen" class="muted">No files or folders chosen</span></div>' : ""}
      <details id="music-upload-path-details" ${native ? "" : "open"}><summary>File and folder paths</summary>
        <label class="field">Files or folders<textarea id="music-upload-paths" rows="4" required spellcheck="false" placeholder="Enter complete file or folder paths, one per line." aria-describedby="music-upload-path-help"></textarea><small id="music-upload-path-help">Paths on the computer running Tagcast. Folders include their subfolders. Up to 100 chosen paths and 1,000 audio files per review; 1.5 GB per file. Hidden files and symbolic links are skipped.</small></label>
      </details>
      <div class="downloads-buttons"><button type="submit" class="button primary" id="music-upload-prepare">Prepare &amp; review →</button></div>
    </fieldset></form>
    <details class="uploads-guide"><summary>How uploads work &amp; privacy</summary>
      <p>Preparation checks supported formats and identical files already in your account. Nothing is uploaded until you choose Start uploads. Different tags make a different file, even when the audio sounds the same.</p>
      <p>iBroadcast reads the original embedded tags. Tagcast metadata edits are not written into these files.</p>
      <p>Only the selected audio, its filename and relative folder path are sent to iBroadcast. Absolute paths and file hashes remain on this computer in the local hash index.</p>
      <p>Pause takes effect between files. Stop interrupts the current transfer where possible. A file already sent may still arrive. Uncertain uploads are never automatically sent again. Check iBroadcast before preparing those files again.</p>
      <p>Selections and progress are not restored after closing Tagcast. Scanning does not watch folders or remove music.</p>
    </details></section>
    <p id="music-upload-error" class="error-text" role="alert" hidden></p>
    <section class="card uploads-results" id="music-upload-results" hidden>
      <div class="downloads-heading"><h2 id="music-upload-heading" tabindex="-1">Review uploads</h2><div class="downloads-buttons">
        <button type="button" class="button primary" id="music-upload-start" data-music-upload-action="start" hidden>Start uploads</button>
        <button type="button" class="button small" id="music-upload-pause" data-music-upload-action="pause" hidden>Pause after this file</button>
        <button type="button" class="button small" id="music-upload-resume" data-music-upload-action="resume" hidden>Resume</button>
        <button type="button" class="button small" id="music-upload-stop" data-music-upload-action="stop" hidden>Stop</button>
        <button type="button" class="button" id="music-upload-clear" data-music-upload-action="clear" hidden>Change selection</button>
        <button type="button" class="button" id="music-upload-reload" hidden>Reload library</button>
      </div></div>
      <p id="music-upload-phase" role="status"></p><p class="muted" id="music-upload-summary"></p>
      <progress id="music-upload-progress" hidden aria-label="Audio bytes sent to iBroadcast"></progress>
      <p class="muted uploads-current" id="music-upload-current" hidden></p>
      <p class="warning-text" id="music-upload-uncertain" hidden>Some uploads need checking. Check iBroadcast before preparing these files again; they have not been automatically resent.</p>
      <p class="muted" id="music-upload-finished-note" hidden>Uploaded means iBroadcast confirmed receipt. New music may need processing; choose Reload library to see it in Tagcast.</p>
      <ul class="uploads-files" id="music-upload-files"></ul>
      <div class="uploads-pagination" id="music-upload-pagination"><button type="button" class="button small" data-music-upload-page="-1">← Previous</button><span id="music-upload-page"></span><button type="button" class="button small" data-music-upload-page="1">Next →</button></div>
    </section>`;
}

const musicUploadLabels = {new: "Ready to upload", uploaded: "Already uploaded", duplicate: "Skipped duplicate",
  too_large: "Too large", empty: "Empty file", unreadable: "Cannot read", unsupported: "Unsupported format", not_regular: "Not a regular file",
  queued: "Queued", sending: "Uploading", sent: "Uploaded", confirmed: "Uploaded",
  failed: "Failed", uncertain: "Needs checking", stopped: "Stopped before sending", not_sent: "Not sent"};

function musicUploadComplete(data) {
  const counts = data?.job?.counts || {};
  return Boolean(data?.job?.state === "done" && !data.error && (counts.sent || counts.confirmed)
    && Object.entries(counts).every(([status, n]) => !n || ["sent", "confirmed", "uploaded", "duplicate"].includes(status)));
}

function musicUploadSummary(data) {
  const counts = {...(data.job?.counts || data.summary.counts)};
  const received = (counts.sent || 0) + (counts.confirmed || 0);
  delete counts.sent; delete counts.confirmed;
  return [`${fmt(data.summary.files)} files`, ...(received ? [`${fmt(received)} uploaded`] : []),
    ...Object.entries(counts).filter(([, n]) => n).map(([key, n]) => `${fmt(n)} ${(musicUploadLabels[key] || key).toLowerCase()}`),
    ...(data.ignored ? [`${fmt(data.ignored)} other or hidden files skipped`] : [])].join(" · ");
}

function musicUploadFileRows(items, active, expanded = new Set()) {
  const groups = [];
  for (const item of items) {
    const slash = item.label.lastIndexOf("/"), folder = item.label.slice(0, Math.max(0, slash));
    const name = item.label.slice(slash + 1), success = ["sent", "confirmed"].includes(item.status);
    const problem = ["uncertain", "failed", "too_large", "empty", "unreadable", "unsupported", "not_regular", "stopped", "not_sent"].includes(item.status);
    let note = item.note || "";
    if (success) note = item.verified ? "Receipt confirmed and found in iBroadcast’s uploaded-file list."
      : active ? "iBroadcast confirmed receipt. An additional uploaded-file list check follows after sending finishes."
      : `iBroadcast confirmed receipt. The additional uploaded-file list check ${note.startsWith("Not verified:") ? "was unavailable." : "has not confirmed this file yet."} Do not upload it again just because of this check.`;
    const row = `<li class="uploads-file"><div class="uploads-file-info"><strong>${escapeHtml(name)}</strong><small>${bytes(item.size)}</small>${note ? problem ? `<p class="uploads-file-note">${escapeHtml(note)}</p>` : `<details data-upload-file="${escapeHtml(item.label)}" ${expanded.has(item.label) ? "open" : ""}><summary>Details</summary><p>${escapeHtml(note)}</p></details>` : ""}</div><span class="uploads-file-status${success ? " is-uploaded" : problem ? " is-problem" : ""}">${escapeHtml(musicUploadLabels[item.status] || item.status)}</span></li>`;
    if (groups.at(-1)?.folder !== folder) groups.push({folder, rows: []});
    groups.at(-1).rows.push(row);
  }
  return groups.map(group => `<li class="uploads-folder">${group.folder ? `<h3>${escapeHtml(group.folder)}</h3>` : ""}<ul>${group.rows.join("")}</ul></li>`).join("");
}

function updateMusicUploadSelection() {
  const count = $("#music-upload-paths").value.split(/\r?\n/).filter(p => p.trim()).length;
  const chosen = $("#music-upload-chosen");
  if (chosen) chosen.textContent = count ? `${fmt(count)} ${count === 1 ? "file or folder" : "files or folders"} chosen` : "No files or folders chosen";
}

function focusMusicUploadPaths() {
  $("#music-upload-path-details").open = true;
  $("#music-upload-paths").focus();
}

function musicUploadPhase(data) {
  if (data.preparing) return `${data.phase}${data.total ? ` ${data.checked} of ${data.total} checked.` : ""}`;
  const job = data.job;
  if (!job) return data.phase;
  const counts = job.counts;
  const needsChecking = Object.keys(counts).some(key => counts[key] && !["sent", "confirmed", "uploaded", "duplicate"].includes(key));
  const label = job.state === "paused" ? counts.sending ? "Pausing after this file…" : "Paused."
    : job.state === "done" ? needsChecking ? "Finished with files to check." : "Upload complete."
    : job.state === "stopped" ? "Stopped." : job.state === "failed" ? "Stopped after an error." : "Uploading…";
  return `${label}${job.message ? ` ${job.message}` : ""}`;
}

function renderMusicUploads() {
  if (state.screen !== "uploads") return;
  const v = musicUploadsView, page = $("#uploads-page");
  if (state.loading) {
    v.initialized = false;
    page.innerHTML = musicUploadsIntro() + '<p role="status">Waiting for your library to finish loading…</p>';
    return;
  }
  if (!musicUploadsReady()) {
    v.initialized = false;
    page.innerHTML = musicUploadsIntro() + `<section class="card"><h2>${!v.enabled ? "Enable music uploads" : !live() ? "Connect iBroadcast" : "Approve upload permission"}</h2><p>${!v.enabled ? "Music uploads are optional and off by default. Enable them in Settings → Data & exports and save, then reconnect iBroadcast to approve uploads." : !live() ? "Connect your own iBroadcast account and load your library. The demo never uploads files." : "Reconnect once to approve the additional upload permission. Your existing preferences stay saved."}</p><button type="button" class="button" data-music-upload-settings>Open Settings →</button>${v.enabled ? '<button type="button" class="button primary" data-music-upload-authorize>Connect iBroadcast…</button>' : ""}</section>`;
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
  $("#music-upload-heading").textContent = job ? active ? "Uploading music" : "Upload results" : d.preparing ? "Preparing your files" : "Review uploads";
  const phase = musicUploadPhase(d);
  const phaseNode = $("#music-upload-phase");
  if (phaseNode.textContent !== phase) phaseNode.textContent = phase;
  setActionStatus("#music-upload-phase", undefined, active && (job?.state !== "paused" || Boolean(counts.sending)));
  $("#music-upload-summary").textContent = musicUploadSummary(d);
  const progress = $("#music-upload-progress"); progress.hidden = !job || !active;
  if (job) { progress.max = Math.max(1, job.bytes.total); progress.value = job.bytes.sent; }
  $("#music-upload-current").hidden = !active || !job?.current;
  $("#music-upload-current").textContent = job?.current || "";
  $("#music-upload-uncertain").hidden = !counts.uncertain;
  // Byte progress changes frequently; it does not change a file row or its Details.
  const list = $("#music-upload-files"), signature = JSON.stringify([d.items.map(({label, size, status, note, verified}) => ({label, size, status, note, verified})), active]);
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
  start.textContent = `Start ${fmt(counts.new || 0)} uploads · ${bytes(d.summary.bytes_to_send)}`;
  start.disabled = locked || !counts.new;
  const visibility = {pause: job?.state === "running", resume: job?.state === "paused", stop: active, clear: results && !active};
  for (const [action, visible] of Object.entries(visibility)) {
    const button = $("#music-upload-" + action);
    button.hidden = !visible; button.disabled = v.busy;
    if (!visible && document.activeElement === button) v.focus = true;
  }
  $("#music-upload-clear").textContent = job && musicUploadComplete(d) ? "New upload" : "Change selection";
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
  } catch (error) { if (request === v.request) v.error = error.message; }
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
  } catch (error) { if (request === v.request) v.error = error.message; }
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
    if (!musicUploadsView.enabled) { toast("Save Enable music uploads first."); return; }
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
    if (result.error) throw new Error(result.error);
    if (Array.isArray(result.paths) && result.paths.length) {
      const field = $("#music-upload-paths");
      field.value = [...new Set([...field.value.split(/\r?\n/).filter(Boolean), ...result.paths])].join("\n");
      if (v.data?.review) { await api("/api/uploads/clear", {session}); v.data = null; }
      updateMusicUploadSelection(); picked = true;
    }
  } catch (error) { if (session === state.connection.playback_session) v.error = error.message; }
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
window.addEventListener("beforeunload", event => {
  if (musicUploadsActive() && musicUploadsView.session === state.connection.playback_session) {
    event.preventDefault(); event.returnValue = "";
  }
});
