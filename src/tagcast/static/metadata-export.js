// Library snapshots are prepared on the server; only small status responses reach JS.
// `error` keeps the error itself (or a server message) so it is translated when shown.
const metadataExportView = {
  options: {tags: true, playlists: true, favourites: true}, job: null,
  details: null, session: "", request: 0, poll: 0, timer: null, busy: false, error: "",
};

function resetMetadataExport() {
  clearTimeout(metadataExportView.timer);
  Object.assign(metadataExportView, {job: null, details: null, session: "", timer: null,
    busy: false, error: "", request: metadataExportView.request + 1});
}

function syncMetadataExport() {
  if (metadataExportView.details && (metadataExportView.details !== state.details
      || metadataExportView.session !== state.connection.playback_session || !live())) {
    resetMetadataExport();
    renderMetadataExport();
  }
}

// Static labels carry data-i18n, so they follow a language change without rebuilding
// the Settings form; actions and status are redrawn by renderMetadataExport().
function metadataExportPanel() {
  return `<section class="history-settings" id="metadata-export" data-settings-category="data"><h3 data-i18n="export.panel.heading">${TagcastI18n.html("export.panel.heading")}</h3>
    <p class="muted" data-i18n="export.panel.intro">${TagcastI18n.html("export.panel.intro")}</p>
    <p class="muted" data-i18n="export.panel.snapshot">${TagcastI18n.html("export.panel.snapshot")}</p>
    ${[["tags", "export.options.tags"], ["playlists", "export.options.playlists"], ["favourites", "export.options.favourites"]].map(([key, label]) => `<label class="checkline" data-i18n="${label}"><input type="checkbox" data-metadata-option="${key}" ${metadataExportView.options[key] ? "checked" : ""}> ${TagcastI18n.html(label)}</label>`).join("")}
    <p class="muted" data-i18n="export.panel.choices">${TagcastI18n.html("export.panel.choices")}</p>
    <div id="metadata-export-actions"></div><div id="metadata-export-status" role="status" aria-live="polite"></div></section>`;
}

// Browser-side failures keep an English message for logs and show their interface text key.
function metadataExportFailure(key, message) {
  return Object.assign(Error(message), {key});
}

function metadataExportErrorText(error) {
  return typeof error?.key === "string" ? TagcastI18n.text(error.key) : TagcastI18n.errorText(error);
}

// Names of optional manifest sections for display; the manifest keys themselves never change.
const METADATA_EXPORT_OPTIONAL = {tags: "export.optional.tags", playlists: "export.optional.playlists",
  album_favourites: "export.optional.albumFavourites", artist_favourites: "export.optional.artistFavourites"};

function renderMetadataExport() {
  if (!(state.screen === "settings")) return;
  const view = metadataExportView;
  const available = live() && !state.loading && Boolean(state.connection.playback_session);
  $("#metadata-export-actions").innerHTML = `<button type="button" class="button small" data-metadata-prepare="json" ${!available || view.busy ? "disabled" : ""}>${TagcastI18n.html("export.actions.json")}</button>
    <button type="button" class="button small" data-metadata-prepare="csv" ${!available || view.busy ? "disabled" : ""}>${TagcastI18n.html("export.actions.csv")}</button>
    ${view.busy && view.job ? `<button type="button" class="button small" data-metadata-cancel>${TagcastI18n.html("export.actions.cancel")}</button>` : ""}`;
  const job = view.job;
  let status = !available ? `<p class="muted">${TagcastI18n.html("export.status.unavailable")}</p>` : "";
  if (view.busy) status += `<p class="muted">${TagcastI18n.html("export.status.preparing")}</p>`;
  if (view.error) status += `<p class="error-text">${escapeHtml(metadataExportErrorText(view.error))}</p>`;
  if (job?.state === "ready" && available) {
    const counts = job.manifest?.counts || {};
    const optional = Object.entries(job.manifest?.optional || {}).filter(([, value]) => value.requested && value.status !== "included")
      .map(([key]) => Object.hasOwn(METADATA_EXPORT_OPTIONAL, key) ? TagcastI18n.text(METADATA_EXPORT_OPTIONAL[key]) : key.replaceAll("_", " "));
    const url = `/api/metadata-export/download?id=${encodeURIComponent(job.id)}&session=${encodeURIComponent(view.session)}`;
    status += `<p>${[TagcastI18n.html("export.ready.albums", {count: Number(counts.albums || 0)}), TagcastI18n.html("export.ready.tracks", {count: Number(counts.tracks || 0)}), TagcastI18n.html("export.ready.credits", {count: Number(counts.credits || 0)})].join(" · ")}</p>
      <p><a class="button small primary" data-metadata-download href="${escapeHtml(url)}" download="${escapeHtml(job.filename)}">${TagcastI18n.html(job.format === "json" ? "export.ready.downloadJson" : "export.ready.downloadCsv")}</a></p>
      <p class="muted">${TagcastI18n.html("export.ready.note")} ${optional.length ? TagcastI18n.html("export.ready.missing", {items: optional.join(", ")}) : ""}</p>`;
  }
  $("#metadata-export-status").innerHTML = status;
}

function metadataExportActive(request) {
  const view = metadataExportView;
  return request === view.request && view.details === state.details && live()
    && view.session === state.connection.playback_session;
}

async function prepareMetadataExport(format) {
  syncMetadataExport();
  const view = metadataExportView;
  if (!live() || state.loading || !state.connection.playback_session || view.busy || !["json", "csv"].includes(format)) return;
  clearTimeout(view.timer);
  Object.assign(view, {details: state.details, session: state.connection.playback_session,
    job: null, error: "", busy: true, request: view.request + 1});
  const request = view.request;
  renderMetadataExport();
  try {
    const job = await api("/api/metadata-export", {format, session: view.session,
      ...Object.fromEntries(Object.entries(view.options).map(([key, value]) => [`include_${key}`, value]))});
    if (!metadataExportActive(request)) return;
    if (!/^[a-f0-9]{32}$/.test(job.id) || job.format !== format) throw metadataExportFailure("export.error.unidentified", "Could not identify the prepared export. Try again.");
    view.job = job;
    resumeMetadataExport();
  } catch (error) {
    if (!metadataExportActive(request)) return;
    view.busy = false; view.error = error;
    renderMetadataExport();
  }
}

async function pollMetadataExport() {
  const view = metadataExportView, request = view.request, job = view.job;
  if (!job || !(state.screen === "settings") || !metadataExportActive(request)) return;
  const poll = ++view.poll;
  try {
    const data = await api(`/api/metadata-export/status?id=${encodeURIComponent(job.id)}&session=${encodeURIComponent(view.session)}`);
    if (!metadataExportActive(request) || poll !== view.poll || view.job?.id !== job.id) return;
    if (data.id !== job.id || data.format !== job.format || !["preparing", "ready", "error"].includes(data.state)) throw metadataExportFailure("export.error.invalidStatus", "Invalid export status. Prepare a new export.");
    view.job = data; view.busy = data.state === "preparing";
    view.error = data.state === "error" ? data.error || metadataExportFailure("export.error.failed", "Could not prepare this export.") : "";
    renderMetadataExport();
    if (view.busy && (state.screen === "settings")) view.timer = setTimeout(pollMetadataExport, 1000);
  } catch (error) {
    if (!metadataExportActive(request) || poll !== view.poll) return;
    view.job = null; view.busy = false; view.error = error;
    renderMetadataExport();
  }
}

function resumeMetadataExport() {
  syncMetadataExport();
  clearTimeout(metadataExportView.timer);
  renderMetadataExport();
  // Recheck ready files too: they may have expired while Settings was closed.
  if (metadataExportView.job && (state.screen === "settings")) pollMetadataExport();
}

async function cancelMetadataExport() {
  const view = metadataExportView, job = view.job, session = view.session;
  if (!job || !metadataExportActive(view.request)) return;
  resetMetadataExport(); renderMetadataExport();
  try { await api("/api/metadata-export/cancel", {id: job.id, session}); }
  catch (error) { toast(metadataExportErrorText(error)); }
}


document.addEventListener("click", event => {
  const prepare = event.target.closest("[data-metadata-prepare]");
  if (prepare) { prepareMetadataExport(prepare.dataset.metadataPrepare); return; }
  if (event.target.closest("[data-metadata-cancel]")) { cancelMetadataExport(); return; }
  if (event.target.closest("[data-metadata-download]")) {
    syncMetadataExport();
    if (!metadataExportView.job || metadataExportView.job.state !== "ready") event.preventDefault();
  }
});
document.addEventListener("change", event => {
  const key = event.target.dataset?.metadataOption;
  if (Object.hasOwn(metadataExportView.options, key)) metadataExportView.options[key] = event.target.checked;
});

// Actions and status follow a language change from memory; polling and jobs are untouched.
TagcastI18n.subscribe(() => {
  if (state.screen === "settings" && document.querySelector("#metadata-export-actions")) renderMetadataExport();
});
