// Library snapshots are prepared on the server; only small status responses reach JS.
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

function metadataExportPanel() {
  return `<section class="history-settings" id="metadata-export"><h3>Export library metadata</h3>
    <p class="muted">Download the loaded iBroadcast library as structured JSON or a ZIP of linked CSV tables. Includes separate album artists, track credits, roles, credit phrases, genres, ratings and upload dates. Uses the full loaded library, regardless of page filters.</p>
    <p class="muted">This snapshot contains saved metadata; open drafts and later changes are not included. Audio and image files are not included.</p>
    ${[["tags", "Include loaded tags"], ["playlists", "Include loaded playlists and folders"], ["favourites", "Include local album and artist favourites"]].map(([key, label]) => `<label class="checkline"><input type="checkbox" data-metadata-option="${key}" ${metadataExportView.options[key] ? "checked" : ""}> ${label}</label>`).join("")}
    <p class="muted">These choices apply to the next preparation. Optional data is included only when already available. The export reports anything unavailable; preparing it never fetches extra library data or changes iBroadcast.</p>
    <div id="metadata-export-actions"></div><div id="metadata-export-status" role="status" aria-live="polite"></div></section>`;
}

function renderMetadataExport() {
  if (!$("#settings").open) return;
  const view = metadataExportView;
  const available = live() && !state.loading && Boolean(state.connection.playback_session);
  $("#metadata-export-actions").innerHTML = `<button type="button" class="button small" data-metadata-prepare="json" ${!available || view.busy ? "disabled" : ""}>Prepare JSON export</button>
    <button type="button" class="button small" data-metadata-prepare="csv" ${!available || view.busy ? "disabled" : ""}>Prepare CSV ZIP</button>
    ${view.busy && view.job ? '<button type="button" class="button small" data-metadata-cancel>Cancel preparation</button>' : ""}`;
  const job = view.job;
  let status = !available ? '<p class="muted">Connect iBroadcast and load your library to export its metadata.</p>' : "";
  if (view.busy) status += '<p class="muted">Preparing the metadata file on the local server… You can close Settings and return here.</p>';
  if (view.error) status += `<p class="error-text">${escapeHtml(view.error)}</p>`;
  if (job?.state === "ready" && available) {
    const counts = job.manifest?.counts || {};
    const optional = Object.entries(job.manifest?.optional || {}).filter(([, value]) => value.requested && value.status !== "included");
    const url = `/api/metadata-export/download?id=${encodeURIComponent(job.id)}&session=${encodeURIComponent(view.session)}`;
    status += `<p>${Number(counts.albums || 0).toLocaleString("en")} native album/disc records · ${Number(counts.tracks || 0).toLocaleString("en")} tracks · ${Number(counts.credits || 0).toLocaleString("en")} credits</p>
      <p><a class="button small primary" data-metadata-download href="${escapeHtml(url)}" download="${escapeHtml(job.filename)}">Download ${job.format === "json" ? "JSON" : "CSV ZIP"} ↓</a></p>
      <p class="muted">Ready for 15 minutes after preparation started. The file includes a manifest with counts and optional-data status. ${optional.length ? `Unavailable: ${optional.map(([key]) => escapeHtml(key.replaceAll("_", " "))).join(", ")}.` : ""}</p>`;
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
    if (!/^[a-f0-9]{32}$/.test(job.id) || job.format !== format) throw Error("Could not identify the prepared export. Try again.");
    view.job = job;
    resumeMetadataExport();
  } catch (error) {
    if (!metadataExportActive(request)) return;
    view.busy = false; view.error = error.message;
    renderMetadataExport();
  }
}

async function pollMetadataExport() {
  const view = metadataExportView, request = view.request, job = view.job;
  if (!job || !$("#settings").open || !metadataExportActive(request)) return;
  const poll = ++view.poll;
  try {
    const data = await api(`/api/metadata-export/status?id=${encodeURIComponent(job.id)}&session=${encodeURIComponent(view.session)}`);
    if (!metadataExportActive(request) || poll !== view.poll || view.job?.id !== job.id) return;
    if (data.id !== job.id || data.format !== job.format || !["preparing", "ready", "error"].includes(data.state)) throw Error("Invalid export status. Prepare a new export.");
    view.job = data; view.busy = data.state === "preparing";
    view.error = data.state === "error" ? data.error || "Could not prepare this export." : "";
    renderMetadataExport();
    if (view.busy && $("#settings").open) view.timer = setTimeout(pollMetadataExport, 1000);
  } catch (error) {
    if (!metadataExportActive(request) || poll !== view.poll) return;
    view.job = null; view.busy = false; view.error = error.message;
    renderMetadataExport();
  }
}

function resumeMetadataExport() {
  syncMetadataExport();
  clearTimeout(metadataExportView.timer);
  renderMetadataExport();
  // Recheck ready files too: they may have expired while Settings was closed.
  if (metadataExportView.job && $("#settings").open) pollMetadataExport();
}

async function cancelMetadataExport() {
  const view = metadataExportView, job = view.job, session = view.session;
  if (!job || !metadataExportActive(view.request)) return;
  resetMetadataExport(); renderMetadataExport();
  try { await api("/api/metadata-export/cancel", {id: job.id, session}); }
  catch (error) { toast(error.message); }
}

$("#settings").addEventListener("close", () => clearTimeout(metadataExportView.timer));
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
