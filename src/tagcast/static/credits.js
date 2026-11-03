"use strict";

// Native artist identities stay separate; names are never split on punctuation here.
// Role codes stay data; getters give each role's label in the current interface language.
const creditRoleLabels = {
  get artist() { return TagcastI18n.text("credits.role.artist"); },
  get band() { return TagcastI18n.text("credits.role.band"); },
  get composer() { return TagcastI18n.text("credits.role.composer"); },
  get lyricist() { return TagcastI18n.text("credits.role.lyricist"); },
  get conductor() { return TagcastI18n.text("credits.role.conductor"); },
  get publisher() { return TagcastI18n.text("credits.role.publisher"); },
  get involved_person() { return TagcastI18n.text("credits.role.involvedPerson"); },
  get original_lyricist() { return TagcastI18n.text("credits.role.originalLyricist"); },
  get original_artist() { return TagcastI18n.text("credits.role.originalArtist"); }};

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
    const number = index + 1;
    return `<div class="credit-row" data-credit-row data-original="${escapeHtml(JSON.stringify(entry))}">
      <label>${TagcastI18n.html("credits.row.name")}${artistChoiceInput(`data-credit-name placeholder="${TagcastI18n.html("editor.choices.findArtist")}" value="${escapeHtml(entry.name || "")}" ${disabled ? "disabled" : ""} aria-label="${TagcastI18n.html("credits.row.nameAria", {number})}"`, disabled, role === "composer" ? "composer" : "artist")}</label>
      <label>${TagcastI18n.html("credits.row.role")}<select data-credit-role ${disabled ? "disabled" : ""} aria-label="${TagcastI18n.html("credits.row.roleAria", {number})}">${roles.map(r => `<option value="${escapeHtml(r)}" ${r === role ? "selected" : ""}>${escapeHtml(Object.hasOwn(creditRoleLabels, r) ? creditRoleLabels[r] : r)}</option>`).join("")}</select></label>
      <label>${TagcastI18n.html("credits.row.phrase")} <small>${TagcastI18n.html("credits.row.optional")}</small><input data-credit-phrase value="${escapeHtml(entry.phrase || "")}" ${disabled ? "disabled" : ""} aria-label="${TagcastI18n.html("credits.row.phraseAria", {number})}"></label>
      <button type="button" class="button small" data-credit-remove ${disabled ? "disabled" : ""} aria-label="${TagcastI18n.html("credits.row.removeAria", {number})}">${TagcastI18n.html("common.remove")}</button>
    </div>`;
  }).join("");
}

function creditsField(record, {album = false, bulk = false, mixed = false} = {}) {
  const entries = mixed ? [] : creditValues(record), key = album ? "album-credits" : "track-credits";
  const label = TagcastI18n.html(album ? "credits.field.album" : "credits.field.track");
  const note = [mixed ? TagcastI18n.html("credits.field.mixed") : "", TagcastI18n.html(album ? "credits.field.albumNote" : "credits.field.trackNote")].filter(Boolean).join(" ");
  return `<div class="field wide credit-editor ${bulk ? "disabled" : ""}" data-credit-editor="${key}" data-album-credits="${album}" data-dirty="false">
    ${bulk ? `<label class="field-check"><input type="checkbox" data-credit-enable> ${TagcastI18n.html(album ? "credits.field.changeAlbum" : "credits.field.changeTrack")}</label>` : `<span>${label}</span>`}
    <p class="muted">${note}</p>
    <div data-credit-rows>${creditRows(entries, album, bulk)}</div>
    <button type="button" class="button small" data-credit-add ${bulk ? "disabled" : ""}>${TagcastI18n.html(album ? "credits.field.addAlbumArtist" : "credits.field.addCredit")}</button>
    <small class="error-text" data-credit-error role="alert"></small>
    <small>${TagcastI18n.html("credits.field.limits")}</small>
  </div>`;
}

function readCredits(editor) {
  const error = editor.querySelector("[data-credit-error]");
  if (error) error.textContent = "";
  try { return [...editor.querySelectorAll("[data-credit-row]")].map(row => {
    const original = JSON.parse(row.dataset.original), name = row.querySelector("[data-credit-name]").value.trim();
    const role = row.querySelector("[data-credit-role]").value, phrase = row.querySelector("[data-credit-phrase]").value;
    if (!name || name.length > 1000 || phrase.length > 1000) throw editorFailure("errors.editor.credit_invalid");
    return {artist_id: name === original.name ? original.artist_id : null, name,
      type: role === (original.type || "artist") ? original.type : role,
      phrase: phrase === (original.phrase || "") ? original.phrase : phrase};
  }); } catch (issue) { if (error) error.textContent = TagcastI18n.errorText(issue); throw issue; }
}

function numberCreditRows(editor) {
  for (const [index, row] of [...editor.querySelectorAll("[data-credit-row]")].entries()) {
    for (const [selector, label] of [["[data-credit-name]", "credits.row.nameAria"], ["[data-credit-role]", "credits.row.roleAria"], ["[data-credit-phrase]", "credits.row.phraseAria"]]) {
      row.querySelector(selector).setAttribute("aria-label", TagcastI18n.text(label, {number: index + 1}));
    }
    row.querySelector("[data-credit-remove]").setAttribute("aria-label", TagcastI18n.text("credits.row.removeAria", {number: index + 1}));
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
  if (event.target.matches?.("[data-credit-role]")) {
    const row = event.target.closest("[data-credit-row]"), composer = event.target.value === "composer";
    row.querySelector("[data-credit-name]").dataset.editorChoiceKind = composer ? "composer" : "artist";
    row.querySelector("[data-artist-choices-toggle]").setAttribute("aria-label", TagcastI18n.text(composer ? "editor.choices.showComposers" : "editor.choices.showArtists"));
    closeEditorArtistChoices();
  }
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
    if (count >= 100) { toast(TagcastI18n.text("credits.field.tooMany")); return; }
    rows.insertAdjacentHTML("beforeend", creditRows([{artist_id: null, name: "", type: "artist", phrase: null}], editor.dataset.albumCredits === "true"));
    numberCreditRows(editor);
    rows.lastElementChild.querySelector("input").focus(); editor.dataset.dirty = "true";
  }
  const remove = event.target.closest("[data-credit-remove]");
  if (remove) { remove.closest("[data-credit-row]").remove(); numberCreditRows(editor); editor.dataset.dirty = "true"; editor.querySelector("[data-credit-add]").focus(); }
});
