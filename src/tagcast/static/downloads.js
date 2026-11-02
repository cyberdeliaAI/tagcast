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

function audioDownloadsCompanionText() {
  const link = TagcastI18n.trusted('<a href="https://github.com/cyberdeliaAI/ibfetch" target="_blank" rel="noopener noreferrer">ibfetch ↗</a>');
  return TagcastI18n.html("downloads.page.companion", {link});
}

function audioDownloadsCompanion() {
  return `<p class="muted" id="audio-download-companion">${audioDownloadsCompanionText()}</p>`;
}

function audioDownloadsIntro(text) {
  return `<section class="page-intro"><div><div class="eyebrow" data-i18n="downloads.page.eyebrow">${TagcastI18n.html("downloads.page.eyebrow")}</div><h1 data-i18n="downloads.page.heading">${TagcastI18n.html("downloads.page.heading")}<span>.</span></h1><p data-i18n="${text}">${TagcastI18n.html(text)}</p></div></section>`;
}

// Option and field names in the form are interface text; their values (folders, layout
// fields, quality codes) are sent as entered and never translated.
const AUDIO_DOWNLOAD_LAYOUT_FIELDS = "{albumartist}, {album}, {year}, {disc}, {track}, {disctrack}, {title}, {artist}, {genre}, {format}";

function audioDownloadWorkersLabel(n) {
  return n === 1 ? TagcastI18n.text("downloads.form.workersRecommended", {workers: n}) : String(n);
}

// The form keeps the user's entries: static labels carry data-i18n so they follow a
// language change on their own; labels with values are updated in place below.
function audioDownloadsMarkup(data) {
  const o = data.options;
  return `${audioDownloadsIntro("downloads.page.intro")}
    <div class="downloads-grid"><section class="card downloads-selection"><div class="downloads-heading"><h2 data-i18n="downloads.selection.heading">${TagcastI18n.html("downloads.selection.heading")}</h2><button type="button" class="text-action" data-audio-download-clear data-i18n="downloads.selection.clear">${TagcastI18n.html("downloads.selection.clear")}</button></div>
      <p id="audio-download-count" class="muted"></p><ul id="audio-download-albums" class="downloads-albums"></ul>
      <p class="muted" data-i18n="downloads.selection.help">${TagcastI18n.html("downloads.selection.help")}</p></section>
    <section class="card"><h2 data-i18n="downloads.form.heading">${TagcastI18n.html("downloads.form.heading")}</h2><form id="audio-download-form">
      <fieldset id="audio-download-options"><label class="field" data-i18n="downloads.form.folder">${TagcastI18n.html("downloads.form.folder")}<div class="downloads-folder"><input name="out" id="audio-download-out" required value="${escapeHtml(o.out)}" spellcheck="false"><button type="button" class="button small" data-audio-download-folder data-i18n="downloads.form.choose">${TagcastI18n.html("downloads.form.choose")}</button></div><small data-i18n="downloads.form.folderHelp">${TagcastI18n.html("downloads.form.folderHelp")}</small></label>
      <div class="downloads-options"><label class="field" data-i18n="downloads.form.quality">${TagcastI18n.html("downloads.form.quality")}<select name="quality" id="audio-download-quality">${[["orig", "downloads.quality.original"], ["320", "MP3 · 320 kbps"], ["256", "MP3 · 256 kbps"], ["192", "MP3 · 192 kbps"], ["128", "MP3 · 128 kbps"], ["96", "MP3 · 96 kbps"]].filter(([v]) => data.premium || v === "128").map(([v,l]) => v === "orig" ? `<option value="${v}" data-i18n="${l}" ${v === o.quality ? "selected" : ""}>${TagcastI18n.html(l)}</option>` : `<option value="${v}" ${v === o.quality ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field" id="audio-download-source-field" data-i18n="downloads.form.source">${TagcastI18n.html("downloads.form.source")}<select name="source" id="audio-download-source"><option value="download" data-i18n="downloads.form.sourceService" ${o.source === "download" ? "selected" : ""}>${TagcastI18n.html("downloads.form.sourceService")}</option><option value="stream" data-i18n="downloads.form.sourceUpload" ${o.source === "stream" ? "selected" : ""}>${TagcastI18n.html("downloads.form.sourceUpload")}</option></select></label></div>
      <p class="muted" id="audio-download-source-note"></p>${!data.premium ? `<p class="muted" data-i18n="downloads.form.freeNote">${TagcastI18n.html("downloads.form.freeNote")}</p>` : ""}
      <details class="downloads-advanced"><summary data-i18n="downloads.form.advanced">${TagcastI18n.html("downloads.form.advanced")}</summary>
      <label class="field" data-i18n="downloads.form.workers">${TagcastI18n.html("downloads.form.workers")}<select name="workers" id="audio-download-workers">${[1,2,3,4].map(n => `<option value="${n}" ${n === o.workers ? "selected" : ""}>${escapeHtml(audioDownloadWorkersLabel(n))}</option>`).join("")}</select></label>
      <label class="field" data-i18n="downloads.form.layout">${TagcastI18n.html("downloads.form.layout")}<input name="layout" id="audio-download-layout" value="${escapeHtml(o.layout)}" required spellcheck="false"><small id="audio-download-layout-help">${TagcastI18n.html("downloads.form.layoutFields", {fields: AUDIO_DOWNLOAD_LAYOUT_FIELDS})}</small></label>
      <label class="field" data-i18n="downloads.form.work">${TagcastI18n.html("downloads.form.work")}<input name="work" id="audio-download-work" value="${escapeHtml(o.work)}" spellcheck="false"><small data-i18n="downloads.form.workHelp">${TagcastI18n.html("downloads.form.workHelp")}</small></label>
      <label class="checkline" data-i18n="downloads.form.verify"><input type="checkbox" name="verify" id="audio-download-verify" ${o.verify ? "checked" : ""}> ${TagcastI18n.html("downloads.form.verify")}</label></details></fieldset>
      <p class="muted" data-i18n="downloads.form.existing">${TagcastI18n.html("downloads.form.existing")}</p>
      <button type="submit" class="button primary" id="audio-download-prepare" data-i18n="downloads.form.review">${TagcastI18n.html("downloads.form.review")}</button></form></section></div>
    ${audioDownloadsCompanion()}
    <p id="audio-download-error" class="error-text" role="alert" hidden></p>
    <section id="audio-download-review" class="card downloads-review" hidden></section>
    <section class="card downloads-progress" id="audio-download-progress" hidden><div class="downloads-heading"><h2 tabindex="-1" id="audio-download-progress-heading" data-i18n="downloads.progress.heading">${TagcastI18n.html("downloads.progress.heading")}</h2><button type="button" class="button small" data-audio-download-stop data-i18n="downloads.progress.stop">${TagcastI18n.html("downloads.progress.stop")}</button></div><p id="audio-download-phase" role="status"></p><div id="audio-download-results"></div></section>`;
}

// Labels in the open form that contain values; the form itself and its entries stay.
function audioDownloadFormLabels() {
  $("#audio-download-companion").innerHTML = audioDownloadsCompanionText();
  $("#audio-download-layout-help").textContent = TagcastI18n.text("downloads.form.layoutFields", {fields: AUDIO_DOWNLOAD_LAYOUT_FIELDS});
  for (const option of $("#audio-download-workers").options || []) option.textContent = audioDownloadWorkersLabel(Number(option.value));
}

function audioDownloadSourceNote() {
  const quality = $("#audio-download-quality").value, source = $("#audio-download-source").value;
  $("#audio-download-source-field").hidden = quality !== "orig";
  $("#audio-download-source-note").textContent = TagcastI18n.text(quality !== "orig" ? "downloads.form.noteConverted"
    : source === "download" ? "downloads.form.noteService" : "downloads.form.noteUpload");
}

function renderAudioDownloads() {
  if (state.screen !== "downloads") return;
  const v = audioDownloadsView, page = $("#downloads-page");
  if (!audioDownloadsAvailable()) {
    page.innerHTML = audioDownloadsIntro("downloads.page.unavailable") + audioDownloadsCompanion();
    v.initialized = false; return;
  }
  const d = v.data;
  if (!d) {
    page.innerHTML = `<p role="status">${v.error ? escapeHtml(v.error) : TagcastI18n.html("downloads.page.loading")}</p>`; return;
  }
  if (!v.initialized) { page.innerHTML = audioDownloadsMarkup(d); v.initialized = true; audioDownloadSourceNote(); }
  const active = audioDownloadActive(d), locked = active || v.busy;
  $("#audio-download-options").disabled = locked;
  $("#audio-download-prepare").disabled = locked || !d.albums.length;
  page.querySelector("[data-audio-download-clear]").disabled = locked || !d.albums.length;
  $("#audio-download-count").textContent = [TagcastI18n.text("downloads.selection.discs", {count: d.albums.length}),
    TagcastI18n.text("downloads.selection.tracks", {count: Number(d.tracks || 0)})].join(" · ");
  const list = $("#audio-download-albums");
  // Preserve focused controls and scrolling during status polling; a language change redraws.
  const signature = JSON.stringify([d.albums, locked, TagcastI18n.language]);
  if (list.dataset.selection !== signature) {
    list.innerHTML = d.albums.length ? d.albums.map(a => `<li><div><strong>${escapeHtml(a.title)}</strong><small>${TagcastI18n.html("downloads.selection.album", {artist: a.artist, disc: a.disc, count: Number(a.tracks || 0)})}</small></div><button type="button" class="text-action" data-audio-download-remove="${escapeHtml(a.id)}" aria-label="${TagcastI18n.html("downloads.selection.remove", {title: a.title})}" ${locked ? "disabled" : ""}>${TagcastI18n.html("common.remove")}</button></li>`).join("") : `<li class="muted">${TagcastI18n.html("downloads.selection.empty")}</li>`;
    list.dataset.selection = signature;
  }
  const error = v.error || d.error;
  $("#audio-download-error").hidden = !error; $("#audio-download-error").textContent = error || "";
  const review = $("#audio-download-review"); review.hidden = !d.review;
  if (d.review && (review.dataset.review !== d.review.id || review.dataset.language !== TagcastI18n.language)) {
    const r = d.review, o = r.options, examples = review.querySelector?.("details")?.open;
    const tracks = TagcastI18n.trusted(`<strong>${TagcastI18n.html("downloads.review.tracks", {count: Number(r.tracks || 0)})}</strong>`);
    // Example filenames are shown exactly as they will be saved.
    review.innerHTML = `<h2 tabindex="-1" id="audio-download-review-heading">${TagcastI18n.html("downloads.review.heading")}</h2><p>${[TagcastI18n.html("downloads.review.summary", {tracks, count: Number(r.discs || 0)}), o.quality === "orig" ? TagcastI18n.html("downloads.quality.original") : `MP3 ${escapeHtml(o.quality)} kbps`, TagcastI18n.html("downloads.review.workers", {workers: o.workers})].join(" · ")}</p><p class="downloads-path">${escapeHtml(o.out)}</p><p class="muted">${TagcastI18n.html("downloads.review.note")}</p><details${examples && review.dataset.review === r.id ? " open" : ""}><summary>${TagcastI18n.html("downloads.review.examples")}</summary><ul class="downloads-examples">${r.examples.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul></details><div class="downloads-buttons"><button type="button" class="button primary" data-audio-download-start="${escapeHtml(r.id)}">${TagcastI18n.html("downloads.review.start", {count: Number(r.tracks || 0)})}</button><button type="button" class="button" data-audio-download-edit>${TagcastI18n.html("downloads.review.edit")}</button></div>`;
    review.dataset.review = r.id; review.dataset.language = TagcastI18n.language;
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
    // The phase text is compared as shown, so a language change rewrites it once.
    const counts = {ok: t?.ok, skip: t?.skip, fail: t?.fail};
    const phase = d.preparing ? TagcastI18n.text("downloads.progress.preparing")
      : t.state === "stopped" ? TagcastI18n.text("downloads.progress.stopped")
      : t.state === "done" ? TagcastI18n.text("downloads.progress.finished", counts)
      : TagcastI18n.text("downloads.progress.running", {...counts, done: t.done, total: t.total});
    if (v.phase !== phase) { $("#audio-download-phase").textContent = phase; v.phase = phase; }
    setActionStatus("#audio-download-phase", undefined, active);
    // File and folder names and the server's notes are shown exactly as they are saved.
    $("#audio-download-results").innerHTML = !t ? "" : `${t.state === "running" ? `<progress max="${Math.max(1,t.total)}" value="${t.done}" aria-label="${TagcastI18n.html("downloads.progress.tasks")}"></progress>` : ""}<p class="muted">${bytes(t.bytes)}${t.speed > 0 ? ` · ${bytes(t.speed)}/s` : ""}</p>${t.active.length ? `<ul class="downloads-examples">${t.active.map(a => `<li>${escapeHtml(a.name)} · ${a.expected ? `${bytes(a.received)} / ${bytes(a.expected)}` : TagcastI18n.html("downloads.progress.receiving")}</li>`).join("")}</ul>` : ""}${[["downloads.results.failures",t.failures,true],["downloads.results.kept",t.existing,false],["downloads.results.notes",t.notes,false]].filter(([,items]) => items.length).map(([label,items,open]) => `<details ${open ? "open" : ""}><summary>${TagcastI18n.html(label)} · ${items.length}</summary><ul class="downloads-examples">${items.map(a => `<li><strong>${escapeHtml(a.name)}</strong><br>${escapeHtml(a.note)}</li>`).join("")}</ul></details>`).join("")}`;
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
    v.error = TagcastI18n.errorText(e); renderAudioDownloads();
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
      v.error = TagcastI18n.errorText(e);
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
      if (result.unavailable) toast(TagcastI18n.text("downloads.form.chooserUnavailable"));
    } catch (e) { toast(TagcastI18n.errorText(e)); }
    finally { button.disabled = false; }
  }
});
// A language change redraws the visible page from memory: no request, no change to a
// running transfer or its poll, and the form keeps every entry (see audioDownloadsMarkup).
TagcastI18n.subscribe(() => {
  if (state.screen !== "downloads") return;
  if (audioDownloadsView.initialized && audioDownloadsAvailable() && audioDownloadsView.data) { audioDownloadFormLabels(); audioDownloadSourceNote(); }
  renderAudioDownloads();
});
window.addEventListener("beforeunload", event => {
  if (audioDownloadActive() && audioDownloadsView.session === state.connection.playback_session) {
    event.preventDefault(); event.returnValue = "";
  }
});
