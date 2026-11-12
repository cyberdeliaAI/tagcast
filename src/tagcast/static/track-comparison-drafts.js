"use strict";

// Browser-memory choices only. The ordinary editor, review and save/read-back own all writes.
const comparisonDraft = {choices: new Map(), mapping: new Map(), picker: null, originals: [], snapshot: "", transferring: false};
const comparisonDraftText = key => TagcastI18n.text(`comparisonDraft.${key}`);
const comparisonDraftSnapshot = albums => JSON.stringify([...albums].sort((a, b) => String(a.id).localeCompare(String(b.id))));
function resetComparisonDraft() {
  comparisonDraft.choices.clear(); comparisonDraft.mapping.clear(); comparisonDraft.picker = null;
  comparisonDraft.originals = []; comparisonDraft.snapshot = "";
  $("#comparison-draft-footer").hidden = true;
}
function captureComparisonDraft(albums) {
  comparisonDraft.originals = structuredClone(albums);
  comparisonDraft.snapshot = comparisonDraftSnapshot(albums);
}
function comparisonDraftCurrent() {
  return trackComparisonCurrent() && !trackComparison.busy && !comparisonDraft.transferring
    && comparisonDraft.snapshot === comparisonDraftSnapshot(comparisonDraft.originals.map(a => state.details.get(String(a.id)) || {}));
}
function discardComparisonDraft() {
  if (comparisonDraft.choices.size && !confirm(comparisonDraftText("discard"))) return false;
  comparisonDraft.choices.clear(); comparisonDraft.mapping.clear(); comparisonDraft.picker = null;
  return true;
}
function requestCloseTrackComparison() {
  if (!comparisonDraft.transferring && discardComparisonDraft()) $("#track-comparison").close();
}
function comparisonReferenceIndex(id, position) { return comparisonDraft.mapping.get(id) ?? position; }
function comparisonDraftControls(left, right, index, current) {
  if (!left || !trackComparison.reference) return "";
  const id = escapeHtml(left.id), choice = comparisonDraft.choices.get(left.id), disabled = current ? "" : "disabled";
  const picker = comparisonDraft.picker === left.id ? `<label class="field"><span>${TagcastI18n.html("comparisonDraft.reference")}</span><select data-comparison-map="${id}">${trackComparison.reference.tracks.map((track, i) => `<option value="${i}" ${i === index ? "selected" : ""}>${escapeHtml(`${track.disc || "–"} · ${track.number || "–"} · ${track.title} · ${track.artist}`)}</option>`).join("")}</select></label>` : "";
  return `<div class="comparison-draft-controls"><button type="button" class="button small" data-compare-track="${id}" data-compare-field="title" aria-pressed="${Boolean(choice?.title)}" ${disabled || (!right?.title ? "disabled" : "")}>${TagcastI18n.html("comparisonDraft.title")}</button><button type="button" class="button small" data-compare-track="${id}" data-compare-field="artists" aria-pressed="${Boolean(choice?.artists)}" ${disabled || (!right?.artist_credits?.length ? "disabled" : "")}>${TagcastI18n.html("comparisonDraft.artists")}</button><button type="button" class="text-action" data-comparison-choose="${id}" ${disabled}>${TagcastI18n.html("comparisonDraft.choose")}</button>${picker}</div>`;
}
function comparisonArtistPatch(original, reference) {
  const names = reference.artist_credits;
  if (!Array.isArray(names) || !names.length || names.length > 100 || names.some(c => !c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 1000 || (c.phrase != null && (typeof c.phrase !== "string" || c.phrase.length > 1000)))) return {};
  // Reuse case-only primary names: a track correction must not globally rename an artist.
  const primary = trackComparisonTitle(names[0].name) === trackComparisonTitle(original.artist) ? original.artist : names[0].name;
  const credits = creditValues(original);
  for (const entry of names.slice(1)) {
    if (trackComparisonTitle(entry.name) === trackComparisonTitle(primary)
        || credits.some(c => (!c.type || c.type === "artist") && trackComparisonTitle(c.name) === trackComparisonTitle(entry.name))) continue;
    credits.push({artist_id: null, name: entry.name, type: "artist", phrase: entry.phrase || null});
  }
  return {...(primary !== original.artist ? {artist: primary} : {}),
    ...(!sameValue(credits, creditValues(original)) ? {credits} : {})};
}
function comparisonDraftPatches() {
  const result = {}, originals = new Map(comparisonDraft.originals.flatMap(a => a.tracks).map(t => [String(t.id), t]));
  for (const [id, choice] of comparisonDraft.choices) {
    const original = originals.get(id);
    const reference = trackComparison.reference?.tracks[choice.reference];
    if (!original || !reference) continue;
    const patch = {...(choice.title && reference.title && reference.title !== original.title ? {title: reference.title} : {}),
      ...(choice.artists ? comparisonArtistPatch(original, reference) : {})};
    if (Object.keys(patch).length) result[id] = patch;
  }
  return result;
}
function renderComparisonDraftFooter(current) {
  $("#comparison-draft-footer").hidden = !trackComparison.reference;
  const count = Object.keys(comparisonDraftPatches()).length;
  $("#comparison-draft-count").textContent = TagcastI18n.text("comparisonDraft.count", {count});
  $("#comparison-draft-open").disabled = !count || !current;
  $("#comparison-draft-clear").disabled = !comparisonDraft.choices.size && !comparisonDraft.mapping.size;
}
function stageComparisonField(id, field) {
  if (!comparisonDraftCurrent() || !["title", "artists"].includes(field)) return;
  const position = trackComparison.tracks.findIndex(t => t.id === id);
  if (position < 0) return;
  const reference = comparisonReferenceIndex(id, position), track = trackComparison.reference?.tracks[reference];
  if (!track || (field === "title" ? !track.title : !track.artist_credits?.length)) return;
  const choice = comparisonDraft.choices.get(id) || {reference, title: false, artists: false};
  choice[field] = !choice[field];
  if (choice.title || choice.artists) comparisonDraft.choices.set(id, choice); else comparisonDraft.choices.delete(id);
  renderTrackComparison();
  [...$("#track-comparison-table").querySelectorAll("[data-compare-field]")].find(b => b.dataset.compareTrack === id && b.dataset.compareField === field)?.focus();
}
async function openComparisonDraftEditor() {
  if (!comparisonDraftCurrent() || $("#editor").open || opening) return;
  const patches = comparisonDraftPatches();
  if (!Object.keys(patches).length) return;
  const originals = structuredClone(comparisonDraft.originals), snapshot = comparisonDraft.snapshot;
  const details = state.details, session = state.connection.playback_session;
  comparisonDraft.transferring = true;
  $("#track-comparison").close();
  try {
    await openEditor(originals.map(a => String(a.id)), {onlineSuggestions: false});
    if (!$("#editor").open || !editing) return;
    if (details !== state.details || session !== state.connection.playback_session
        || snapshot !== comparisonDraftSnapshot(editing.originals)
        || snapshot !== comparisonDraftSnapshot(originals.map(a => state.details.get(String(a.id)) || {}))) {
      $("#editor").close(); toast(comparisonDraftText("replaced")); return;
    }
    editing.trackPatches = patches;
    editing.dirty.add("comparison");
    // Initial draft display must not start asynchronous lyrics expansion or scroll
    // animation under the next pointer action. Normal explicit track selection does.
    editTrack(Object.keys(patches)[0], {loadLyrics: false, scrollBehavior: "instant"});
    $('#track-inline input[data-key="title"]')?.focus({preventScroll: true});
    toast(comparisonDraftText("ready"));
  } finally { comparisonDraft.transferring = false; }
}
$("#track-comparison-table").addEventListener("click", event => {
  const button = event.target.closest("[data-compare-field]"), choose = event.target.closest("[data-comparison-choose]");
  if (button && !button.disabled) stageComparisonField(button.dataset.compareTrack, button.dataset.compareField);
  if (choose && !choose.disabled && comparisonDraftCurrent()) {
    comparisonDraft.picker = comparisonDraft.picker === choose.dataset.comparisonChoose ? null : choose.dataset.comparisonChoose;
    renderTrackComparison();
    if (comparisonDraft.picker) $("#track-comparison-table").querySelector("[data-comparison-map]")?.focus();
    else [...$("#track-comparison-table").querySelectorAll("[data-comparison-choose]")].find(b => b.dataset.comparisonChoose === choose.dataset.comparisonChoose)?.focus();
  }
});
$("#track-comparison-table").addEventListener("change", event => {
  const select = event.target.closest("[data-comparison-map]");
  if (!select || !comparisonDraftCurrent()) return;
  const id = select.dataset.comparisonMap, index = Number(select.value);
  if (!trackComparison.tracks.some(t => t.id === id) || !Number.isInteger(index) || !trackComparison.reference?.tracks[index]) return;
  if (comparisonDraft.choices.has(id) && !confirm(comparisonDraftText("discardTrack"))) { renderTrackComparison(); return; }
  comparisonDraft.mapping.set(id, index); comparisonDraft.choices.delete(id); comparisonDraft.picker = null;
  renderTrackComparison();
  [...$("#track-comparison-table").querySelectorAll("[data-comparison-choose]")].find(b => b.dataset.comparisonChoose === id)?.focus();
});
$("#comparison-draft-open").addEventListener("click", openComparisonDraftEditor);
$("#comparison-draft-clear").addEventListener("click", () => { if (comparisonDraftCurrent() && discardComparisonDraft()) renderTrackComparison(); });
$("#track-comparison").addEventListener("cancel", event => { if (comparisonDraft.transferring || !discardComparisonDraft()) event.preventDefault(); });
