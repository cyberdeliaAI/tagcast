"use strict";

// Explicit edition comparison; chosen corrections enter the separate editor/review only.
const trackComparison = {request: 0, details: null, session: "", albumId: "", tracks: [], total: 0,
  results: null, reference: null, busy: false, error: null, query: null, focus: null, scroll: 0};
const trackComparisonEnabled = () => lookup.sources.find(s => s.name === "musicbrainz")?.enabled !== false;
function trackComparisonCurrent(request = trackComparison.request) {
  return request === trackComparison.request && $("#track-comparison").open && live()
    && trackComparison.details === state.details && trackComparison.session === state.connection.playback_session
    && state.screen === "album" && trackComparison.albumId === albumView.id && trackComparisonEnabled();
}
function resetTrackComparison() {
  const view = trackComparison; view.request += 1; view.busy = false;
  resetComparisonDraft();
  view.tracks = []; view.results = null; view.reference = null; view.details = null; view.query = null; view.error = null;
  if ($("#track-comparison").open) $("#track-comparison").close();
  $("#track-comparison-reference").innerHTML = "";
  $("#track-comparison-results").innerHTML = ""; $("#track-comparison-table").innerHTML = "";
  setActionStatus("#track-comparison-status", "");
}
function openTrackComparison() {
  if (!live() || !albumViewReady() || document.querySelector("dialog[open]")) return;
  resetTrackComparison();
  const discs = shelfIds(albumView.id).map(id => state.details.get(id)), album = joinDiscs(discs), view = trackComparison;
  Object.assign(view, {details: state.details, session: state.connection.playback_session, albumId: albumView.id,
    focus: document.activeElement, scroll: window.scrollY || 0,
    total: album.tracks.length,
    tracks: album.tracks.length > 1000 ? [] : discs.flatMap(d => d.tracks.map(t => ({id: String(t.id), title: t.title || "", artist: t.artist || d.artist || "",
      disc: Number(t.disc || d.disc) || 0, position: Number(t.track) || 0, number: String(t.track || ""), length: t.length}))) });
  $("#track-comparison-artist").value = album.artist || "";
  $("#track-comparison-album").value = album.name || "";
  $("#track-comparison-only").checked = false;
  captureComparisonDraft(discs);
  $("#track-comparison").showModal();
  renderTrackComparison(); $("#track-comparison-artist").focus();
}
function trackComparisonLabel(key) { return TagcastI18n.text(`trackComparison.${key}`); }
function trackComparisonEdition(row) {
  const label = [row.date, row.country, ...(row.formats || []), ...(row.labels || []).map(l => [l.name, l.catalogue].filter(Boolean).join(" · ")), row.status, row.note].filter(Boolean).join(" · ");
  return `<strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.artist)}</span><small>${escapeHtml(label)}</small><small>${TagcastI18n.html("trackComparison.editionCount", {discs: row.discs, tracks: row.track_count})}</small>`;
}
const trackComparisonTitle = value => String(value || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
function trackComparisonDifferences(left, right) {
  if (!left || !right) return ["unpaired"];
  const differences = [];
  // Full title/version text is retained. These are positional observations, not matches.
  if (left.title && right.title && trackComparisonTitle(left.title) !== trackComparisonTitle(right.title)) differences.push("titleDiff");
  if (left.disc && right.disc && left.disc !== right.disc || left.number && right.number && left.number !== right.number) differences.push("positionDiff");
  if (Number(left.length) > 0 && Number(right.length) > 0 && Math.abs(left.length - right.length) > 2) differences.push("durationDiff");
  if (!left.title || !right.title || !left.disc || !right.disc || !left.number || !right.number || !(left.length > 0) || !(right.length > 0)) differences.push("unknown");
  return differences;
}
function trackComparisonCell(track) {
  if (!track) return `<span class="muted">${TagcastI18n.html("trackComparison.noPosition")}</span>`;
  return `<small>${TagcastI18n.html("trackComparison.position", {disc: track.disc || "–", track: track.number || "–"})} · ${trackDuration(track.length)}</small><strong>${escapeHtml(track.title || "–")}</strong><span>${escapeHtml(track.artist)}</span>`;
}
function renderTrackComparison() {
  const view = trackComparison;
  if (!$("#track-comparison").open) return;
  const focused = document.activeElement, choice = focused?.dataset?.compareRelease, page = focused?.dataset?.comparePage;
  const enabled = trackComparisonEnabled(), oversized = view.total > 1000, canStage = comparisonDraftCurrent();
  $("#track-comparison-search").disabled = view.busy || !enabled || oversized;
  $("#track-comparison-artist").disabled = view.busy; $("#track-comparison-album").disabled = view.busy;
  const message = !enabled ? trackComparisonLabel("disabled") : oversized ? trackComparisonLabel("tooLarge")
    : view.busy ? trackComparisonLabel("loading") : view.error ? TagcastI18n.errorText(view.error) : "";
  setActionStatus("#track-comparison-status", message, view.busy);
  const results = view.results;
  $("#track-comparison-results").innerHTML = results ? `<h3>${TagcastI18n.html("trackComparison.editions")}</h3>
    <p class="muted">${TagcastI18n.html("trackComparison.searchCount", {count: results.total, limit: results.limit})}</p>
    <div class="track-comparison-choices">${results.releases.map(row => `<button type="button" class="button track-comparison-edition" data-compare-release="${escapeHtml(row.id)}" aria-pressed="${view.reference?.release.id === row.id}" ${view.busy ? "disabled" : ""}>${trackComparisonEdition(row)}</button>`).join("") || `<p>${TagcastI18n.html("trackComparison.empty")}</p>`}</div>
    <div class="track-comparison-pages"><button type="button" class="button small" data-compare-page="${results.offset - 20}" ${view.busy || !results.offset ? "disabled" : ""}>${TagcastI18n.html("trackComparison.previous")}</button><button type="button" class="button small" data-compare-page="${results.offset + 20}" ${view.busy || !results.more ? "disabled" : ""}>${TagcastI18n.html("trackComparison.next")}</button></div>` : `<p class="muted">${TagcastI18n.html("trackComparison.start")}</p>`;
  const reference = view.reference;
  $("#track-comparison-reference").innerHTML = reference ? `<a href="${escapeHtml(reference.release.url)}" target="_blank" rel="noopener noreferrer">${trackComparisonEdition(reference.release)}<span>${TagcastI18n.html("trackComparison.openRelease")} ↗</span></a>${reference.incomplete ? `<p class="warn-box">${TagcastI18n.html("trackComparison.incomplete")}</p>` : ""}` : "";
  const rows = [], titles = new Set((reference?.tracks || []).map(t => trackComparisonTitle(t.title)).filter(Boolean));
  if (!oversized) for (let i = 0; i < Math.max(view.tracks.length, reference?.tracks.length || 0); i++) {
    const left = view.tracks[i], selected = comparisonReferenceIndex(left?.id, i), right = reference?.tracks[selected], differences = reference ? trackComparisonDifferences(left, right) : [];
    if (reference && $("#track-comparison-only").checked && !differences.length) continue;
    const elsewhere = left && right && differences.includes("titleDiff") && titles.has(trackComparisonTitle(left.title));
    rows.push(`<tr class="${differences.length ? "track-comparison-different" : ""}"><td>${trackComparisonCell(left)}</td><td>${reference ? trackComparisonCell(right) : "–"}${comparisonDraftControls(left, right, selected, canStage)}</td><td>${differences.map(key => `<span>${escapeHtml(trackComparisonLabel(key))}</span>`).join("")}${elsewhere ? `<span>${TagcastI18n.html("trackComparison.elsewhere")}</span>` : ""}</td></tr>`);
  }
  $("#track-comparison-table").innerHTML = `<table><thead><tr><th>${TagcastI18n.html("trackComparison.current", {count: view.total})}</th><th>${TagcastI18n.html("trackComparison.reference", {count: reference?.tracks.length || 0})}</th><th>${TagcastI18n.html("trackComparison.observations")}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  renderComparisonDraftFooter(canStage);
  if (!view.busy && (choice || page !== undefined)) {
    const button = [...$("#track-comparison-results").querySelectorAll("button")].find(node => choice
      ? node.dataset.compareRelease === choice : node.dataset.comparePage === page);
    if (button && !button.disabled) button.focus();
  }
}
async function requestTrackComparison(releaseId = null, offset = null) {
  const view = trackComparison;
  if (!trackComparisonCurrent() || view.busy || view.total > 1000) return;
  if (releaseId && !view.results?.releases.some(r => r.id === releaseId)) return;
  if (releaseId && !discardComparisonDraft()) return;
  if (!releaseId && offset === null) {
    const artist = $("#track-comparison-artist"), album = $("#track-comparison-album");
    if (!artist.reportValidity() || !album.reportValidity()) return;
    if (!discardComparisonDraft()) return;
    view.query = {artist: artist.value.trim(), album: album.value.trim()};
    view.reference = null; view.results = null;
  }
  if (releaseId && !view.results?.releases.some(r => r.id === releaseId) || !releaseId && !view.query) return;
  const request = ++view.request;
  const params = new URLSearchParams({album_id: view.albumId, session: view.session,
    ...(releaseId ? {id: releaseId} : {...view.query, offset: String(offset ?? 0)})});
  view.busy = true; view.error = null; renderTrackComparison();
  try {
    const data = await api(`/api/tracklist/${releaseId ? "release" : "search"}?${params}`);
    if (!trackComparisonCurrent(request)) return;
    if (releaseId) view.reference = data; else view.results = data;
  } catch (error) { if (trackComparisonCurrent(request)) view.error = error; }
  finally {
    if (trackComparisonCurrent(request)) { view.busy = false; renderTrackComparison(); }
    else if (request === view.request && $("#track-comparison").open) resetTrackComparison();
  }
}
$("#album-action-compare").addEventListener("click", () => {
  const {trigger, details, id, session} = albumActions;
  closeAlbumActions(true);
  if (trigger?.isConnected && !trigger.disabled && details === state.details && id === albumView.id
      && session === state.connection.playback_session) openTrackComparison();
});
$("#track-comparison-form").addEventListener("submit", event => { event.preventDefault(); requestTrackComparison(); });
$("#track-comparison-results").addEventListener("click", event => {
  const release = event.target.closest("[data-compare-release]"), page = event.target.closest("[data-compare-page]");
  if (release && !release.disabled) requestTrackComparison(release.dataset.compareRelease);
  if (page && !page.disabled) requestTrackComparison(null, Number(page.dataset.comparePage));
});
$("#track-comparison-only").addEventListener("change", renderTrackComparison);
$("#track-comparison").addEventListener("close", () => {
  const {focus, scroll} = trackComparison;
  const restore = trackComparison.details === state.details && trackComparison.session === state.connection.playback_session
    && state.screen === "album" && trackComparison.albumId === albumView.id;
  trackComparison.request += 1; trackComparison.tracks = []; trackComparison.reference = null; trackComparison.results = null;
  trackComparison.details = null; trackComparison.query = null; trackComparison.busy = false;
  resetComparisonDraft();
  $("#track-comparison-reference").innerHTML = ""; $("#track-comparison-table").innerHTML = ""; $("#track-comparison-results").innerHTML = "";
  setActionStatus("#track-comparison-status", "");
  if (restore) { if (focus?.isConnected) focus.focus(); window.scrollTo({top: scroll}); }
});
TagcastI18n.subscribe(renderTrackComparison);
