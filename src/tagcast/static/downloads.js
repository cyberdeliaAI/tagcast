"use strict";

// Local file tasks share the existing login and library, never the playback queue.
const audioDownloadsView = {session: "", data: null, busy: false, request: 0, timer: null,
  initialized: false, phase: "", error: "", expectReview: false, expectProgress: false};

function audioDownloadActive(data = audioDownloadsView.data) {
  return Boolean(data?.preparing || ["ready", "planning", "running"].includes(data?.transfer?.state));
}

function audioDownloadsAvailable() {
  return live() && !state.loading && Boolean(state.connection.playback_session);
}

function audioDownloadsMarkup(data) {
  const o = data.options;
  return `<section class="page-intro"><div><div class="eyebrow">YOUR MUSIC, A LOCAL COPY</div><h1>Downloads<span>.</span></h1><p>Save selected albums to this computer. Your iBroadcast library and playback queue stay unchanged.</p></div></section>
    <div class="downloads-grid"><section class="card downloads-selection"><div class="downloads-heading"><h2>Selected albums</h2><button type="button" class="text-action" data-audio-download-clear>Clear</button></div>
      <p id="audio-download-count" class="muted"></p><ul id="audio-download-albums" class="downloads-albums"></ul>
      <p class="muted">Add albums from their ⋯ menu, or select several albums and choose Download. Multi-disc selections include every disc.</p></section>
    <section class="card"><h2>Save to your computer</h2><form id="audio-download-form">
      <fieldset id="audio-download-options"><label class="field">Download folder<div class="downloads-folder"><input name="out" id="audio-download-out" required value="${escapeHtml(o.out)}" spellcheck="false"><button type="button" class="button small" data-audio-download-folder>Choose…</button></div><small>A local folder or mounted drive on the computer running Tagcast.</small></label>
      <div class="downloads-options"><label class="field">Quality<select name="quality" id="audio-download-quality">${[["orig", "Original format"], ["320", "MP3 · 320 kbps"], ["256", "MP3 · 256 kbps"], ["192", "MP3 · 192 kbps"], ["128", "MP3 · 128 kbps"], ["96", "MP3 · 96 kbps"]].filter(([v]) => data.premium || v === "128").map(([v,l]) => `<option value="${v}" ${v === o.quality ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field" id="audio-download-source-field">Original file source<select name="source" id="audio-download-source"><option value="download" ${o.source === "download" ? "selected" : ""}>iBroadcast download service</option><option value="stream" ${o.source === "stream" ? "selected" : ""}>Original upload · streaming server</option></select></label></div>
      <p class="muted" id="audio-download-source-note"></p>${!data.premium ? '<p class="muted">Free accounts can download 128 kbps MP3. Other qualities require iBroadcast Premium.</p>' : ""}
      <details class="downloads-advanced"><summary>Folder layout and download options</summary>
      <label class="field">Files at a time<select name="workers" id="audio-download-workers">${[1,2,3,4].map(n => `<option value="${n}" ${n === o.workers ? "selected" : ""}>${n}${n === 1 ? " · recommended while listening" : ""}</option>`).join("")}</select></label>
      <label class="field">Folder and filename layout<input name="layout" id="audio-download-layout" value="${escapeHtml(o.layout)}" required spellcheck="false"><small>Fields: {albumartist}, {album}, {year}, {disc}, {track}, {disctrack}, {title}, {artist}, {genre}, {format}.</small></label>
      <label class="field">Optional local work folder<input name="work" id="audio-download-work" value="${escapeHtml(o.work)}" spellcheck="false"><small>Downloads finish here before moving to the destination. Keep this outside the download folder. Leave empty to save directly.</small></label>
      <label class="checkline"><input type="checkbox" name="verify" id="audio-download-verify" ${o.verify ? "checked" : ""}> Recheck checksums of previously downloaded files</label></details></fieldset>
      <p class="muted">Existing files are never overwritten. Recognized completed downloads are kept; incomplete streaming downloads can resume. A small hidden integrity manifest is saved beside the music.</p>
      <button type="submit" class="button primary" id="audio-download-prepare">Review download →</button></form></section></div>
    <p id="audio-download-error" class="error-text" role="alert" hidden></p>
    <section id="audio-download-review" class="card downloads-review" hidden></section>
    <section class="card downloads-progress" id="audio-download-progress" hidden><div class="downloads-heading"><h2 tabindex="-1" id="audio-download-progress-heading">Download progress</h2><button type="button" class="button small" data-audio-download-stop>Stop</button></div><p id="audio-download-phase" role="status"></p><div id="audio-download-results"></div></section>`;
}

function audioDownloadSourceNote() {
  const quality = $("#audio-download-quality").value, source = $("#audio-download-source").value;
  $("#audio-download-source-field").hidden = quality !== "orig";
  $("#audio-download-source-note").textContent = quality !== "orig"
    ? "Converted MP3 files come from the streaming server."
    : source === "download" ? "For current embedded tags, enable Download Updated Metadata in iBroadcast. If that service cannot deliver a file, Tagcast saves the original upload instead and shows a Fallback note."
    : "Saves the file as originally uploaded, including its original tags. Later metadata changes in iBroadcast are not embedded.";
}

function renderAudioDownloads() {
  if (state.screen !== "downloads") return;
  const v = audioDownloadsView, page = $("#downloads-page");
  if (!audioDownloadsAvailable()) {
    page.innerHTML = '<section class="page-intro"><div><div class="eyebrow">YOUR MUSIC, A LOCAL COPY</div><h1>Downloads<span>.</span></h1><p>Connect iBroadcast and load your library to download audio. The demo does not download music.</p></div></section>';
    v.initialized = false; return;
  }
  const d = v.data;
  if (!d) {
    page.innerHTML = `<p role="status">${v.error ? escapeHtml(v.error) : "Loading Downloads…"}</p>`; return;
  }
  if (!v.initialized) { page.innerHTML = audioDownloadsMarkup(d); v.initialized = true; audioDownloadSourceNote(); }
  const active = audioDownloadActive(d), locked = active || v.busy;
  $("#audio-download-options").disabled = locked;
  $("#audio-download-prepare").disabled = locked || !d.albums.length;
  page.querySelector("[data-audio-download-clear]").disabled = locked || !d.albums.length;
  $("#audio-download-count").textContent = `${fmt(d.albums.length)} album discs · ${fmt(d.tracks)} tracks`;
  const list = $("#audio-download-albums");
  // Preserve focused controls and scrolling during status polling.
  const signature = JSON.stringify([d.albums, locked]);
  if (list.dataset.selection !== signature) {
    list.innerHTML = d.albums.length ? d.albums.map(a => `<li><div><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.artist)} · Disc ${a.disc} · ${fmt(a.tracks)} ${a.tracks === 1 ? "track" : "tracks"}</small></div><button type="button" class="text-action" data-audio-download-remove="${escapeHtml(a.id)}" aria-label="Remove ${escapeHtml(a.title)} from Downloads" ${locked ? "disabled" : ""}>Remove</button></li>`).join("") : '<li class="muted">No albums selected yet.</li>';
    list.dataset.selection = signature;
  }
  const error = v.error || d.error;
  $("#audio-download-error").hidden = !error; $("#audio-download-error").textContent = error || "";
  const review = $("#audio-download-review"); review.hidden = !d.review;
  if (d.review && review.dataset.review !== d.review.id) {
    const r = d.review, o = r.options;
    review.innerHTML = `<h2 tabindex="-1" id="audio-download-review-heading">Review download</h2><p><strong>${fmt(r.tracks)} tracks</strong> from ${fmt(r.discs)} album discs · ${o.quality === "orig" ? "Original format" : `MP3 ${escapeHtml(o.quality)} kbps`} · ${o.workers} at a time</p><p class="downloads-path">${escapeHtml(o.out)}</p><p class="muted">Nothing has been downloaded yet. This creates local copies only; it does not change iBroadcast. Existing completed files keep their tags.</p><details><summary>Example filenames</summary><ul class="downloads-examples">${r.examples.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul></details><div class="downloads-buttons"><button type="button" class="button primary" data-audio-download-start="${escapeHtml(r.id)}">Start ${fmt(r.tracks)} downloads</button><button type="button" class="button" data-audio-download-edit>Change options</button></div>`;
    review.dataset.review = r.id;
    if (v.expectReview) { v.expectReview = false; $("#audio-download-review-heading").focus(); }
  }
  for (const button of review.querySelectorAll("button")) button.disabled = locked;
  const progress = $("#audio-download-progress"), t = d.transfer;
  progress.hidden = !active && !t;
  if (active || t) {
    const stopButton = progress.querySelector("[data-audio-download-stop]");
    const returnFocus = !active && document.activeElement === stopButton;
    stopButton.hidden = !active;
    if (v.expectProgress || returnFocus) { v.expectProgress = false; $("#audio-download-progress-heading").focus(); }
    const phase = d.preparing ? "Preparing filenames and checking the selection…"
      : t.state === "stopped" ? "Stopped. Completed files are kept. Review again to resume the selection."
      : t.state === "done" ? `Finished · ${t.ok} saved · ${t.skip} kept · ${t.fail} failed`
      : `Downloading · ${t.done} of ${t.total} finished · ${t.ok} saved · ${t.skip} kept · ${t.fail} failed`;
    if (v.phase !== phase) { $("#audio-download-phase").textContent = phase; v.phase = phase; }
    setActionStatus("#audio-download-phase", undefined, active);
    $("#audio-download-results").innerHTML = !t ? "" : `${t.state === "running" ? `<progress max="${Math.max(1,t.total)}" value="${t.done}" aria-label="Completed download tasks"></progress>` : ""}<p class="muted">${bytes(t.bytes)}${t.speed > 0 ? ` · ${bytes(t.speed)}/s` : ""}</p>${t.active.length ? `<ul class="downloads-examples">${t.active.map(a => `<li>${escapeHtml(a.name)} · ${a.expected ? `${bytes(a.received)} / ${bytes(a.expected)}` : "Preparing / receiving"}</li>`).join("")}</ul>` : ""}${[["Failures",t.failures],["Files kept",t.existing],["Download notes (including fallbacks)",t.notes]].filter(([,items]) => items.length).map(([label,items]) => `<details ${label === "Failures" ? "open" : ""}><summary>${label} · ${items.length}</summary><ul class="downloads-examples">${items.map(a => `<li><strong>${escapeHtml(a.name)}</strong><br>${escapeHtml(a.note)}</li>`).join("")}</ul></details>`).join("")}`;
  }
}

function syncAudioDownloadsPage() {
  const v = audioDownloadsView, session = state.connection.playback_session || "";
  clearTimeout(v.timer); v.timer = null;
  if (v.session !== session || !live()) {
    Object.assign(v, {session, data: null, initialized: false, error: "", busy: false, phase: "", request: v.request + 1});
  }
  if (state.screen === "downloads") {
    renderAudioDownloads();
    if (audioDownloadsAvailable() && !v.busy) loadAudioDownloads();
  }
}

async function loadAudioDownloads() {
  const v = audioDownloadsView, request = ++v.request, session = v.session;
  clearTimeout(v.timer);
  try {
    const d = await api(`/api/downloads?session=${encodeURIComponent(session)}`);
    if (request !== v.request || session !== state.connection.playback_session || !live()) return;
    v.data = d; v.error = ""; renderAudioDownloads();
  } catch (e) {
    if (request !== v.request || session !== state.connection.playback_session) return;
    v.error = e.message; renderAudioDownloads();
  }
  if (request === v.request && state.screen === "downloads" && audioDownloadActive()) v.timer = setTimeout(loadAudioDownloads, 2000);
}

async function audioDownloadAction(action, body = {}) {
  const v = audioDownloadsView;
  if (!audioDownloadsAvailable() || v.busy) return;
  const session = state.connection.playback_session, request = ++v.request;
  let reconcile = false;
  clearTimeout(v.timer); v.busy = true; v.error = ""; if (action === "prepare") v.expectReview = true; if (action === "start") v.expectProgress = true; renderAudioDownloads();
  try {
    const data = await api(`/api/downloads/${action}`, {...body, session});
    if (request !== v.request || session !== state.connection.playback_session || !live()) return;
    v.session = session; v.data = data;
    return data;
  } catch (e) {
    if (request === v.request && session === state.connection.playback_session) {
      v.error = e.message;
      if (action === "start") { if (v.data) v.data.review = null; reconcile = true; }
    }
  } finally {
    if (request === v.request && session === state.connection.playback_session) {
      v.busy = false; renderAudioDownloads();
      if (reconcile) loadAudioDownloads();
      else if (state.screen === "downloads" && audioDownloadActive()) v.timer = setTimeout(loadAudioDownloads, 750);
    }
  }
}

async function addAudioDownloadAlbums(ids) {
  if (!audioDownloadsAvailable() || saving || checking) return;
  const added = await audioDownloadAction("add", {albums: [...new Set(ids.map(String))]});
  if (added) showScreen("downloads");
  else if (audioDownloadsView.error) toast(audioDownloadsView.error);
}

$("#show-downloads").addEventListener("click", () => showScreen("downloads"));
$("#download-selection").addEventListener("click", () => addAudioDownloadAlbums([...state.selected]));
$("#album-action-download").addEventListener("click", () => {
  const {trigger, details, id} = albumActions;
  closeAlbumActions(true);
  if (trigger?.isConnected && !trigger.disabled && details === state.details && id === albumView.id) addAudioDownloadAlbums(shelfIds(id));
});
$("#downloads-page").addEventListener("change", event => {
  if (event.target.closest("#audio-download-form")) {
    if (audioDownloadsView.data) audioDownloadsView.data.review = null;
    $("#audio-download-review").hidden = true;
    audioDownloadSourceNote();
  }
});
$("#downloads-page").addEventListener("submit", event => {
  if (!event.target.matches("#audio-download-form")) return;
  event.preventDefault();
  audioDownloadAction("prepare", {out: $("#audio-download-out").value,
    quality: $("#audio-download-quality").value, source: $("#audio-download-source").value,
    workers: Number($("#audio-download-workers").value), layout: $("#audio-download-layout").value,
    work: $("#audio-download-work").value, verify: $("#audio-download-verify").checked});
});
$("#downloads-page").addEventListener("click", async event => {
  const button = event.target.closest("button"); if (!button) return;
  if (button.hasAttribute("data-audio-download-clear")) return audioDownloadAction("remove", {clear: true});
  if (button.hasAttribute("data-audio-download-remove")) return audioDownloadAction("remove", {album: button.dataset.audioDownloadRemove});
  if (button.hasAttribute("data-audio-download-start")) return audioDownloadAction("start", {id: button.dataset.audioDownloadStart});
  if (button.hasAttribute("data-audio-download-stop")) return audioDownloadAction("stop");
  if (button.hasAttribute("data-audio-download-edit")) {
    audioDownloadsView.data.review = null; renderAudioDownloads(); $("#audio-download-out").focus();
  }
  if (button.hasAttribute("data-audio-download-folder")) {
    const session = state.connection.playback_session; button.disabled = true;
    try {
      const result = await api("/api/downloads/folder", {session});
      if (session !== state.connection.playback_session || !live()) return;
      if (result.folder) { $("#audio-download-out").value = result.folder; audioDownloadsView.data.review = null; renderAudioDownloads(); }
      if (result.unavailable) toast("Folder chooser unavailable. Enter the folder path instead.");
    } catch (e) { toast(e.message); }
    finally { button.disabled = false; }
  }
});
window.addEventListener("beforeunload", event => {
  if (audioDownloadActive() && audioDownloadsView.session === state.connection.playback_session) {
    event.preventDefault(); event.returnValue = "";
  }
});
