"use strict";

// Native artist identities stay separate; names are never split on punctuation here.
const creditRoleLabels = {artist: "Artist", band: "Band", composer: "Composer", lyricist: "Lyricist",
  conductor: "Conductor", publisher: "Publisher", involved_person: "Involved person",
  original_lyricist: "Original lyricist", original_artist: "Original artist"};

function albumArtistEntries(album) {
  const primary = {id: String(album.artist_id || 0), name: album.artist,
    rating: album.artist_rating || 0, image: album.artist_image || "", artwork_id: album.artist_artwork_id || 0};
  const additional = album.album_artists?.length ? album.album_artists.slice(1)
    : (album.credits || []).map(e => ({id: String(e.artist_id || 0), name: e.name, rating: 0, image: "", artwork_id: 0}));
  return [primary, ...additional];
}

const albumHasArtist = (album, name) => albumArtistEntries(album).some(a => a.name === name);
const albumArtistsText = album => albumArtistEntries(album).map(a => a.name).join(" · ");
const albumArtistLinks = album => albumArtistEntries(album).map(a => `<button class="text-action" data-artist="${escapeHtml(a.name)}">${escapeHtml(a.name)}</button>`).join(' <span aria-hidden="true">·</span> ');

function creditValues(record) {
  if (Array.isArray(record.credits)) return structuredClone(record.credits);
  // Older servers/demo data have only composer names. Never guess their native IDs.
  return (record.composers || []).map(name => ({artist_id: null, name, type: "composer", phrase: null}));
}

function creditRows(entries, album = false, disabled = false) {
  return entries.map((entry, index) => {
    const role = entry.type || "artist", roles = album ? ["artist", "band"] : Object.keys(creditRoleLabels);
    if (!roles.includes(role)) roles.push(role);
    return `<div class="credit-row" data-credit-row data-original="${escapeHtml(JSON.stringify(entry))}">
      <label>Artist name${artistChoiceInput(`data-credit-name placeholder="Find an existing artist, or enter a new name" value="${escapeHtml(entry.name || "")}" ${disabled ? "disabled" : ""} aria-label="Credit ${index + 1} artist name"`, disabled)}</label>
      <label>Role<select data-credit-role ${disabled ? "disabled" : ""} aria-label="Credit ${index + 1} role">${roles.map(r => `<option value="${escapeHtml(r)}" ${r === role ? "selected" : ""}>${escapeHtml(creditRoleLabels[r] || r)}</option>`).join("")}</select></label>
      <label>Credit phrase <small>(optional)</small><input data-credit-phrase value="${escapeHtml(entry.phrase || "")}" ${disabled ? "disabled" : ""} aria-label="Credit ${index + 1} phrase"></label>
      <button type="button" class="button small" data-credit-remove ${disabled ? "disabled" : ""} aria-label="Remove credit ${index + 1}">Remove</button>
    </div>`;
  }).join("");
}

function creditsField(record, {album = false, bulk = false, mixed = false} = {}) {
  const entries = mixed ? [] : creditValues(record), key = album ? "album-credits" : "track-credits";
  const label = album ? "Additional album artists" : "Additional artists and credits";
  return `<div class="field wide credit-editor ${bulk ? "disabled" : ""}" data-credit-editor="${key}" data-album-credits="${album}" data-dirty="false">
    ${bulk ? `<label class="field-check"><input type="checkbox" data-credit-enable> Change ${label.toLowerCase()}</label>` : `<span>${label}</span>`}
    <p class="muted">${mixed ? "Different existing credits. Enabling this field replaces the additional credits on every selected disc. " : ""}${album ? "The primary album artist stays in the field above. Each additional artist also gets this album in their own artist view." : "The main track artist stays above. Keep each person and role separate; changing a name assigns another artist."}</p>
    <div data-credit-rows>${creditRows(entries, album, bulk)}</div>
    <button type="button" class="button small" data-credit-add ${bulk ? "disabled" : ""}>+ Add ${album ? "album artist" : "credit"}</button>
    <small class="error-text" data-credit-error role="alert"></small>
    <small>Up to 100 additional credits. Names and phrases: up to 1,000 characters. All changes are reviewed before saving.</small>
  </div>`;
}

function readCredits(editor) {
  const error = editor.querySelector("[data-credit-error]");
  if (error) error.textContent = "";
  try { return [...editor.querySelectorAll("[data-credit-row]")].map(row => {
    const original = JSON.parse(row.dataset.original), name = row.querySelector("[data-credit-name]").value.trim();
    const role = row.querySelector("[data-credit-role]").value, phrase = row.querySelector("[data-credit-phrase]").value;
    if (!name || name.length > 1000 || phrase.length > 1000) throw Error("Credit names are required; names and phrases can contain at most 1,000 characters.");
    return {artist_id: name === original.name ? original.artist_id : null, name,
      type: role === (original.type || "artist") ? original.type : role,
      phrase: phrase === (original.phrase || "") ? original.phrase : phrase};
  }); } catch (issue) { if (error) error.textContent = issue.message; throw issue; }
}

function numberCreditRows(editor) {
  for (const [index, row] of [...editor.querySelectorAll("[data-credit-row]")].entries()) {
    for (const [selector, label] of [["[data-credit-name]", "artist name"], ["[data-credit-role]", "role"], ["[data-credit-phrase]", "phrase"]]) {
      row.querySelector(selector).setAttribute("aria-label", `Credit ${index + 1} ${label}`);
    }
    row.querySelector("[data-credit-remove]").setAttribute("aria-label", `Remove credit ${index + 1}`);
  }
}

document.addEventListener("input", event => {
  const editor = event.target.closest?.("[data-credit-editor]");
  if (editor) { editor.dataset.dirty = "true"; editor.querySelector("[data-credit-error]").textContent = ""; }
});
document.addEventListener("change", event => {
  const editor = event.target.closest?.("[data-credit-editor]");
  if (!editor) return;
  editor.dataset.dirty = "true";
  if (event.target.matches?.("[data-credit-enable]")) {
    const enabled = event.target.checked;
    editor.classList.toggle("disabled", !enabled);
    for (const control of editor.querySelectorAll("[data-credit-rows] input, [data-credit-rows] select, [data-credit-rows] button, [data-credit-add]")) control.disabled = !enabled;
  }
});
document.addEventListener("click", event => {
  const editor = event.target.closest?.("[data-credit-editor]");
  if (!editor || editor.classList.contains("disabled")) return;
  if (event.target.closest("[data-credit-add]")) {
    const rows = editor.querySelector("[data-credit-rows]"), count = rows.querySelectorAll("[data-credit-row]").length;
    if (count >= 100) { toast("Use at most 100 additional artist credits."); return; }
    rows.insertAdjacentHTML("beforeend", creditRows([{artist_id: null, name: "", type: "artist", phrase: null}], editor.dataset.albumCredits === "true"));
    numberCreditRows(editor);
    rows.lastElementChild.querySelector("input").focus(); editor.dataset.dirty = "true";
  }
  const remove = event.target.closest("[data-credit-remove]");
  if (remove) { remove.closest("[data-credit-row]").remove(); numberCreditRows(editor); editor.dataset.dirty = "true"; editor.querySelector("[data-credit-add]").focus(); }
});
