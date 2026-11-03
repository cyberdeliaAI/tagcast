"use strict";

// Genres as separate labels. The first is the main genre; the others go to iBroadcast's
// genres_additional, as the official web editor sends them. A tag that was uploaded as
// one text ("Pop;Rock") stays one label, marked, until you split it.

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const genresText = list => (list || []).join(" · ");
const hasCombined = list => (list || []).some(g => g.includes(";"));

// A metadata editor failure: an Error with the English message (for logic, logs and tests)
// and the code of its errors.editor.* text, which TagcastI18n.errorText(error) shows in the
// interface language. Callers pass the complete catalog key, so it stays one literal.
const editorFailure = (key, params) => TagcastI18n.failure(key.replace(/^errors\./, ""), params);

function splitGenres(list) {
  const out = [];
  for (const genre of list || []) {
    for (const part of genre.split(";")) {
      const name = part.trim();
      if (name && !out.some(g => g.toLocaleLowerCase() === name.toLocaleLowerCase())) out.push(name);
    }
  }
  return out;
}

// Errors keep an English message; show them with TagcastI18n.errorText(error).
function validateGenreList(list, maximum = 200) {
  if (list.length > 20) throw editorFailure("errors.editor.label_count");
  if (list.some(value => [...value].length > maximum)) throw editorFailure("errors.editor.label_length", {maximum});
  return list;
}

function addGenres(list, text, maximum = 200) {
  const out = [...list];
  for (const part of String(text).split(";")) {  // typing ";" means "another genre"
    const name = part.trim();
    if (name && !out.some(g => g.toLocaleLowerCase() === name.toLocaleLowerCase())) out.push(name);
  }
  return validateGenreList(out, maximum);
}

function genreChips(list, ordered = true) {
  return list.map((g, i) => `<span class="genre-chip ${ordered && i === 0 ? "main" : ""} ${g.includes(";") ? "combined" : ""}"><button type="button" class="chip-name" data-genre-main="${i}" title="${TagcastI18n.html(!ordered ? "genres.chip.moveFront" : i === 0 ? "genres.chip.main" : "genres.chip.makeMain")}">${escapeHtml(g)}</button>${g.includes(";") ? `<button type="button" class="chip-split" data-genre-split="${i}" title="${TagcastI18n.html("genres.chip.splitTitle")}">${TagcastI18n.html("genres.chip.split")}</button>` : ""}<button type="button" class="chip-remove" data-genre-remove="${i}" aria-label="${TagcastI18n.html("genres.chip.remove", {name: g})}">×</button></span>`).join("");
}

// Interface text keys per kind of label list (data-noun stays the code "genre" or "composer").
const genreInputTexts = {
  genre: {add: "genres.input.addGenre", addFirst: "genres.input.addGenreFirst", addFor: "genres.input.addGenreFor", mixed: "genres.input.mixedGenres"},
  composer: {add: "genres.input.addComposer", addFirst: "genres.input.addComposerFirst", addFor: "genres.input.addComposerFor", mixed: "genres.input.mixedComposers"}};
const genreInputText = noun => genreInputTexts[noun === "composer" ? "composer" : "genre"];

// label and hint are escaped interface text (TagcastI18n.html).
function genreField(name, label, genres, {bulk = false, hint = "", mixed = false, ordered = true, noun = "genre"} = {}) {
  const texts = genreInputText(noun);
  const head = bulk ? `<label class="field-check"><input type="checkbox" aria-label="${changeFieldLabel(label)}" data-enable="${name}"> ${label}</label>` : `<span>${label}</span>`;
  const placeholder = TagcastI18n.html(mixed ? texts.mixed : genres.length ? texts.add : texts.addFirst);
  return `<div class="field wide">${head}<div class="genre-input ${bulk ? "disabled" : ""}" data-genres="${name}" data-ordered="${ordered ? 1 : 0}" data-noun="${noun}" data-value="${escapeHtml(JSON.stringify(genres))}"><span class="genre-chips">${genreChips(genres, ordered)}</span>${artistChoiceInput(`aria-label="${TagcastI18n.html(texts.addFor, {label: TagcastI18n.trusted(label)})}" placeholder="${placeholder}" ${bulk ? "disabled" : ""}`, bulk, noun)}<small class="genre-validation error-text" data-genre-error role="alert"></small></div>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

const getGenres = el => JSON.parse(el.dataset.value || "[]");

function setGenres(el, list) {
  try { validateGenreList(list, el.dataset.noun === "composer" ? 1000 : 200); }
  catch (error) { genreValidation(el, TagcastI18n.errorText(error)); throw error; }
  genreValidation(el, "");
  el.dataset.value = JSON.stringify(list);
  el.querySelector(".genre-chips").innerHTML = genreChips(list, el.dataset.ordered !== "0");
  const input = el.querySelector("input"), texts = genreInputText(el.dataset.noun || "genre");
  input.placeholder = TagcastI18n.text(list.length ? texts.add : texts.addFirst);
  if (editing) editing.dirty.add(el.dataset.genres);
  el.classList.remove("filled"); void el.offsetWidth; el.classList.add("filled");
}

function commitTyped(el) {
  const input = el.querySelector("input");
  if (!input.value.trim()) return;
  try { setGenres(el, addGenres(getGenres(el), input.value, el.dataset.noun === "composer" ? 1000 : 200)); }
  catch (error) { genreValidation(el, TagcastI18n.errorText(error)); throw error; }
  input.value = "";
}

function genreValidation(el, message) {
  const error = el.querySelector("[data-genre-error]"), input = el.querySelector("input");
  if (error) error.textContent = message;
  input?.setCustomValidity?.(message);
  input?.setAttribute?.("aria-invalid", String(Boolean(message)));
}

document.addEventListener("input", event => {
  const input = event.target.closest?.(".genre-input input");
  if (input) genreValidation(input.closest(".genre-input"), "");
});

// Split every combined genre in the open album: on the album field when all tracks share
// their genres, otherwise track by track. Shown in the review like any other change.
function splitAlbumGenres() {
  if (!editing) return;
  const field = document.querySelector('#metadata-form [data-genres="genres"]');
  const tracks = editing.originals.flatMap(a => a.tracks);
  const shared = tracks.every(t => sameValue(t.genres, tracks[0].genres));
  let count = 0;
  if (shared && field && !field.classList.contains("disabled")) {
    if (hasCombined(getGenres(field))) { setGenres(field, splitGenres(getGenres(field))); count = tracks.length; }
  } else {
    for (const t of tracks) {
      const patch = editing.trackPatches[String(t.id)] || {};
      const current = patch.genres || t.genres;
      if (!hasCombined(current)) continue;
      editing.trackPatches[String(t.id)] = {...patch, genres: splitGenres(current)};
      count += 1;
    }
  }
  showTrackGenres();
  toast(count ? TagcastI18n.text("genres.split.done", {count}) : TagcastI18n.text("genres.split.none"));
}

// The track table shows the genres a track will get, including drafted changes.
function showTrackGenres() {
  if (!editing || editing.bulk) return;
  const field = document.querySelector('#metadata-form [data-genres="genres"]');
  const albumGenres = field && editing.dirty.has("genres") ? getGenres(field) : null;
  for (const t of editing.originals.flatMap(a => a.tracks)) {
    const cell = document.querySelector(`[data-genre-cell="${CSS.escape(String(t.id))}"]`);
    if (!cell) continue;
    const genres = editing.trackPatches[String(t.id)]?.genres || albumGenres || t.genres;
    cell.textContent = genresText(genres) || TagcastI18n.text("editor.track.noGenre");
    cell.classList.toggle("combined", hasCombined(genres));
    cell.classList.toggle("drafted", !sameValue(genres, t.genres));
  }
}

document.addEventListener("keydown", event => {
  const input = event.target.closest?.(".genre-input input");
  if (!input) return;
  if (editorArtistChoiceKey(event)) return;
  const el = input.closest(".genre-input");
  if (event.key === "Enter" || event.key === ";") { event.preventDefault(); try { commitTyped(el); showTrackGenres(); closeEditorArtistChoices(); } catch (error) { toast(TagcastI18n.errorText(error)); } }
  else if (event.key === "Backspace" && !input.value) { const list = getGenres(el); if (list.length) { setGenres(el, list.slice(0, -1)); showTrackGenres(); } }
});
document.addEventListener("focusout", event => {
  const input = event.target.closest?.(".genre-input input");
  if (input) { try { commitTyped(input.closest(".genre-input")); showTrackGenres(); } catch (error) { toast(TagcastI18n.errorText(error)); } }
});
document.addEventListener("click", event => {
  const el = event.target.closest(".genre-input");
  if (event.target.closest("[data-split-album-genres]")) { try { splitAlbumGenres(); } catch (error) { toast(TagcastI18n.errorText(error)); } return; }
  if (!el || el.classList.contains("disabled")) return;
  const list = getGenres(el);
  const remove = event.target.closest("[data-genre-remove]"), main = event.target.closest("[data-genre-main]"), split = event.target.closest("[data-genre-split]");
  if (remove) list.splice(Number(remove.dataset.genreRemove), 1);
  else if (split) list.splice(Number(split.dataset.genreSplit), 1, ...splitGenres([list[Number(split.dataset.genreSplit)]]).filter(g => !list.includes(g)));
  else if (main) { const [g] = list.splice(Number(main.dataset.genreMain), 1); list.unshift(g); }
  else { el.querySelector("input").focus(); return; }
  try { setGenres(el, list); showTrackGenres(); } catch (error) { toast(TagcastI18n.errorText(error)); }
});
