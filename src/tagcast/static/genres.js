"use strict";

// Genres as separate labels. The first is the main genre; the others go to iBroadcast's
// genres_additional, as the official web editor sends them. A tag that was uploaded as
// one text ("Pop;Rock") stays one label, marked, until you split it.

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const genresText = list => (list || []).join(" · ");
const hasCombined = list => (list || []).some(g => g.includes(";"));

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

function addGenres(list, text) {
  const out = [...list];
  for (const part of String(text).split(";")) {  // typing ";" means "another genre"
    const name = part.trim().slice(0, 100);
    if (name && !out.some(g => g.toLocaleLowerCase() === name.toLocaleLowerCase())) out.push(name);
  }
  return out;
}

function genreChips(list) {
  return list.map((g, i) => `<span class="genre-chip ${i === 0 ? "main" : ""} ${g.includes(";") ? "combined" : ""}"><button type="button" class="chip-name" data-genre-main="${i}" title="${i === 0 ? "Main genre" : "Make this the main genre"}">${escapeHtml(g)}</button>${g.includes(";") ? `<button type="button" class="chip-split" data-genre-split="${i}" title="One text with several genres. Split it into separate genres.">split</button>` : ""}<button type="button" class="chip-remove" data-genre-remove="${i}" aria-label="Remove ${escapeHtml(g)}">×</button></span>`).join("");
}

function genreField(name, label, genres, {bulk = false, hint = "", mixed = false} = {}) {
  const head = bulk ? `<label class="field-check"><input type="checkbox" aria-label="Change ${label}" data-enable="${name}"> ${label}</label>` : `<span>${label}</span>`;
  return `<div class="field wide">${head}<div class="genre-input ${bulk ? "disabled" : ""}" data-genres="${name}" data-value="${escapeHtml(JSON.stringify(genres))}"><span class="genre-chips">${genreChips(genres)}</span><input aria-label="Add a genre: ${escapeHtml(label)}" placeholder="${mixed ? "Mixed: the tracks have different genres" : genres.length ? "Add a genre" : "Add a genre, Enter or ; for the next"}" maxlength="400" ${bulk ? "disabled" : ""}></div>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

const getGenres = el => JSON.parse(el.dataset.value || "[]");

function setGenres(el, list) {
  el.dataset.value = JSON.stringify(list);
  el.querySelector(".genre-chips").innerHTML = genreChips(list);
  const input = el.querySelector("input");
  input.placeholder = list.length ? "Add a genre" : "Add a genre, Enter or ; for the next";
  if (editing) editing.dirty.add(el.dataset.genres);
  el.classList.remove("filled"); void el.offsetWidth; el.classList.add("filled");
}

function commitTyped(el) {
  const input = el.querySelector("input");
  if (!input.value.trim()) return;
  setGenres(el, addGenres(getGenres(el), input.value));
  input.value = "";
}

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
  toast(count ? `Combined genres split on ${count} ${count === 1 ? "track" : "tracks"}. Review the draft to see them.` : "No combined genres left to split.");
}

// The track table shows the genres a track will get, including drafted changes.
function showTrackGenres() {
  if (!editing || editing.bulk) return;
  const field = document.querySelector('#metadata-form [data-genres="genres"]');
  const albumGenres = field && editing.dirty.has("genres") ? getGenres(field) : null;
  for (const t of editing.originals[0].tracks) {
    const cell = document.querySelector(`[data-genre-cell="${CSS.escape(String(t.id))}"]`);
    if (!cell) continue;
    const genres = editing.trackPatches[String(t.id)]?.genres || albumGenres || t.genres;
    cell.textContent = genresText(genres) || "No genre";
    cell.classList.toggle("combined", hasCombined(genres));
    cell.classList.toggle("drafted", !sameValue(genres, t.genres));
  }
}

document.addEventListener("keydown", event => {
  const input = event.target.closest?.(".genre-input input");
  if (!input) return;
  const el = input.closest(".genre-input");
  if (event.key === "Enter" || event.key === ";") { event.preventDefault(); commitTyped(el); showTrackGenres(); }
  else if (event.key === "Backspace" && !input.value) { const list = getGenres(el); if (list.length) { setGenres(el, list.slice(0, -1)); showTrackGenres(); } }
});
document.addEventListener("focusout", event => {
  const input = event.target.closest?.(".genre-input input");
  if (input) { commitTyped(input.closest(".genre-input")); showTrackGenres(); }
});
document.addEventListener("click", event => {
  const el = event.target.closest(".genre-input");
  if (event.target.closest("[data-split-album-genres]")) { splitAlbumGenres(); return; }
  if (!el || el.classList.contains("disabled")) return;
  const list = getGenres(el);
  const remove = event.target.closest("[data-genre-remove]"), main = event.target.closest("[data-genre-main]"), split = event.target.closest("[data-genre-split]");
  if (remove) list.splice(Number(remove.dataset.genreRemove), 1);
  else if (split) list.splice(Number(split.dataset.genreSplit), 1, ...splitGenres([list[Number(split.dataset.genreSplit)]]).filter(g => !list.includes(g)));
  else if (main) { const [g] = list.splice(Number(main.dataset.genreMain), 1); list.unshift(g); }
  else { el.querySelector("input").focus(); return; }
  setGenres(el, list); showTrackGenres();
});
