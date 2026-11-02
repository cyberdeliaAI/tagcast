"use strict";

// This comparison only prepares the existing single-album metadata review.
// It lives in the cleanup dialog: a language change never re-renders it (search text and year
// choices would be lost); its next render uses the new language.
const yearReviewView = {data: null, details: null, request: 0, busy: false, query: "", category: "differences", offset: 0, returnTo: null};
// Category ids are sent to the server; the keys only label them.
const yearReviewLabels = {differences: "yearReview.category.differences", different: "yearReview.category.different", mixed: "yearReview.category.mixed",
  "missing-tracks": "yearReview.category.missingTracks", "missing-album": "yearReview.category.missingAlbum", unknown: "yearReview.category.unknown", invalid: "yearReview.category.invalid"};
const yearReviewKnown = year => Number.isInteger(year) && year >= 1800 && year <= 2050;
const yearReviewShown = year => year === 0 ? TagcastI18n.text("yearReview.year.unknown") : String(year);
const yearReviewLabel = category => Object.hasOwn(yearReviewLabels, category) ? TagcastI18n.html(yearReviewLabels[category]) : "";

function resetYearReview() {
  yearReviewView.request += 1; yearReviewView.data = null; yearReviewView.details = null; yearReviewView.busy = false;
  yearReviewView.query = ""; yearReviewView.category = "differences"; yearReviewView.offset = 0;
  yearReviewView.returnTo = null;
}

function yearReviewSummary(stats) {
  return [`<strong>${TagcastI18n.html("cleanup.count.albums", {count: Number(stats.albums) || 0})}</strong>`,
    TagcastI18n.html("yearReview.summary.discs", {count: Number(stats.discs) || 0}),
    TagcastI18n.html("yearReview.summary.differentTracks", {count: Number(stats.different_tracks) || 0}),
    TagcastI18n.html("yearReview.summary.missingTrackYears", {count: Number(stats.missing_track_years) || 0})].join(" · ");
}

function renderYearReview() {
  if (yearReviewView.details !== state.details) yearReviewView.data = null;
  const data = yearReviewView.data, busy = yearReviewView.busy, stats = data?.stats;
  const scroll = $("#cleanup").scrollTop;
  const focus = document.activeElement?.id;
  $("#cleanup-content").innerHTML = `<p class="muted">${TagcastI18n.html("yearReview.intro")}</p>
    <div class="cleanup-controls">${cleanupCategoryControl(busy)}<button type="button" class="button" id="year-review-analyse" ${busy ? "disabled" : ""}>${TagcastI18n.html(data ? "yearReview.action.analyseAgain" : "yearReview.action.analyse")}</button></div>
    <p class="muted">${TagcastI18n.html("yearReview.scope")}</p>
    ${stats ? `<p class="year-review-summary">${yearReviewSummary(stats)}</p>
    <div class="year-review-filters"><div class="field clearable-field"><label for="year-review-search">${TagcastI18n.html("yearReview.search.label")}</label>${clearableSearchInput("year-review-search", "", yearReviewView.query, busy)}</div><label class="field">${TagcastI18n.html("yearReview.filter.label")}<select id="year-review-category" ${busy ? "disabled" : ""}>${Object.entries(yearReviewLabels).map(([key, label]) => `<option value="${key}" ${key === yearReviewView.category ? "selected" : ""}>${TagcastI18n.html(label)}</option>`).join("")}</select></label><button type="button" class="button small" id="year-review-find" ${busy ? "disabled" : ""}>${TagcastI18n.html("yearReview.search.button")}</button></div>
    <p class="muted">${TagcastI18n.html("yearReview.results.matching", {count: Number(data.total) || 0})} ${TagcastI18n.html("yearReview.results.note")}</p>
    ${data.combine_sets ? `<p class="warn-box">${TagcastI18n.html("yearReview.combineSets")}</p>` : ""}
    <div class="cleanup-albums">${data.rows.map(row => yearReviewRow(row, data.combine_sets, busy)).join("") || `<p class="empty">${TagcastI18n.html("yearReview.empty")}</p>`}</div>
    ${data.total > data.limit ? `<div class="pagination"><button type="button" class="button small" data-year-review-page="-25" ${busy || data.offset <= 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${Math.floor(data.offset / data.limit) + 1} / ${Math.ceil(data.total / data.limit)}</span><button type="button" class="button small" data-year-review-page="25" ${busy || data.offset + data.limit >= data.total ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button></div>` : ""}
    <p class="muted">${TagcastI18n.html("yearReview.howTo")}</p>`
    : yearReviewView.returnTo?.saving ? `<p class="empty">${TagcastI18n.html("yearReview.checkingSaved")}</p>`
      : `<p class="empty">${TagcastI18n.html("yearReview.start")}</p>`}`;
  $("#cleanup").scrollTop = scroll;
  if (["year-review-search", "year-review-category", "year-review-find", "year-review-analyse"].includes(focus)) document.getElementById(focus)?.focus({preventScroll: true});
}

function yearReviewRow(row, combined, busy) {
  const valid = row.track_years.filter(item => yearReviewKnown(item.year));
  const blocked = busy || !row.bounded || row.category === "invalid";
  const selected = valid.length === 1 ? valid[0].year : "";
  const details = [escapeHtml(row.artist), TagcastI18n.html("cleanup.count.tracks", {count: Number(row.tracks) || 0}),
    row.discs > 1 ? TagcastI18n.html("yearReview.row.discs", {count: row.discs}) : TagcastI18n.html("common.disc", {disc: row.disc || "?"}), yearReviewLabel(row.category)];
  return `<section class="cleanup-album year-review-album"><h3>${escapeHtml(row.album)}</h3><p class="muted">${details.join(" · ")}</p>
    <dl class="year-review-values"><div><dt>${TagcastI18n.html("yearReview.row.albumYear")}</dt><dd>${escapeHtml(yearReviewShown(row.album_year))}</dd></div><div><dt>${TagcastI18n.html("yearReview.row.trackYears")}</dt><dd>${row.track_years.map(item => `${escapeHtml(yearReviewShown(item.year))} <span class="muted">(${TagcastI18n.html("yearReview.row.trackCount", {count: Number(item.count) || 0})})</span>`).join(" · ")}</dd></div></dl>
    ${!row.bounded ? `<p class="muted">${TagcastI18n.html("yearReview.row.tooLarge")}</p>` : row.category === "invalid" ? `<p class="muted">${TagcastI18n.html("yearReview.row.invalid")}</p>` : ""}
    <div class="year-review-directions"><div><button type="button" class="button small" data-year-review-album="${escapeHtml(row.id)}" data-year-direction="album-to-tracks" ${blocked || !yearReviewKnown(row.album_year) ? "disabled" : ""}>${TagcastI18n.html("yearReview.action.albumToTracks")}</button><small class="muted">${yearReviewKnown(row.album_year) ? TagcastI18n.html("yearReview.action.albumToTracksNote", {year: row.album_year}) : TagcastI18n.html("yearReview.action.albumToTracksNoteUnknown")}</small></div>
    <div><label class="field">${TagcastI18n.html("yearReview.choice.label")}<select data-year-review-choice="${escapeHtml(row.id)}" ${blocked || combined || !valid.length ? "disabled" : ""}><option value="" ${selected === "" ? "selected" : ""}>${TagcastI18n.html("yearReview.choice.placeholder")}</option>${valid.map(item => `<option value="${item.year}" ${selected === item.year ? "selected" : ""}>${item.year} (${TagcastI18n.html("common.count.tracks", {count: item.count})})</option>`).join("")}</select></label><button type="button" class="button small" data-year-review-album="${escapeHtml(row.id)}" data-year-direction="tracks-to-album" ${blocked || combined || !selected || selected === row.album_year ? "disabled" : ""}>${TagcastI18n.html("yearReview.action.tracksToAlbum")}</button><small class="muted">${TagcastI18n.html("yearReview.action.tracksToAlbumNote")}</small><button type="button" class="button small" data-year-review-album="${escapeHtml(row.id)}" data-year-direction="tracks-to-album-and-tracks" ${blocked || combined || !selected ? "disabled" : ""}>${TagcastI18n.html("yearReview.action.tracksToAll")}</button><small class="muted">${TagcastI18n.html("yearReview.action.tracksToAllNote")}</small></div></div></section>`;
}

async function fetchYearReview(analyse = false, preserveView = false) {
  if (yearReviewView.busy || !live() || cleanupView.category !== "years") return;
  const request = ++yearReviewView.request, details = state.details, focus = document.activeElement?.id;
  yearReviewView.busy = true; renderYearReview();
  setActionStatus("#cleanup-status", TagcastI18n.text(analyse ? "yearReview.progress.analyse" : "yearReview.progress.read"), true);
  try {
    const query = new URLSearchParams({id: yearReviewView.data?.id || "", q: yearReviewView.query,
      category: yearReviewView.category, offset: yearReviewView.offset});
    let data = await api(analyse ? "/api/year-review/analyse" : `/api/year-review?${query}`, analyse ? {} : undefined);
    if (request !== yearReviewView.request || details !== state.details || !live()) return;
    if (analyse && preserveView && (yearReviewView.query || yearReviewView.category !== "differences" || yearReviewView.offset)) {
      query.set("id", data.id);
      data = await api(`/api/year-review?${query}`);
    }
    if (request !== yearReviewView.request || details !== state.details || !live()) return;
    yearReviewView.data = data; yearReviewView.details = details; yearReviewView.offset = data.offset;
    if (analyse && !preserveView) { yearReviewView.query = ""; yearReviewView.category = "differences"; }
    setActionStatus("#cleanup-status", "");
  } catch (error) {
    if (request !== yearReviewView.request || details !== state.details) return;
    if (error.status === 409) yearReviewView.data = null;
    setActionStatus("#cleanup-status", TagcastI18n.errorText(error));
  } finally {
    if (request === yearReviewView.request && details === state.details) {
      yearReviewView.busy = false;
      if (cleanupView.category === "years") {
        renderYearReview();
        if ($("#cleanup").open && document.activeElement === document.body
          && ["year-review-search", "year-review-category", "year-review-find", "year-review-analyse"].includes(focus)) {
          document.getElementById(focus)?.focus({preventScroll: true});
        }
      }
    }
  }
}

function yearReviewIdentity(album) {
  return [String(album.id), album.name, album.artist, album.artist_id, album.year, album.disc,
    album.credits || [], album.tracks.map(t => [String(t.id), t.title, t.artist, t.year, t.track])
      .sort((a, b) => a[0].localeCompare(b[0]))];
}

async function chooseYearReview(id, direction) {
  if (yearReviewView.busy || !yearReviewView.data || yearReviewView.details !== state.details || !live()) return;
  const row = yearReviewView.data.rows.find(item => item.id === id);
  if (!row) return;
  const year = direction === "album-to-tracks" ? row.album_year : Number(document.querySelector(`[data-year-review-choice="${id}"]`)?.value);
  if (!yearReviewKnown(year)) { setActionStatus("#cleanup-status", TagcastI18n.text("yearReview.chooseKnown")); return; }
  const request = ++yearReviewView.request, details = state.details, report = yearReviewView.data;
  yearReviewView.busy = true; renderYearReview();
  setActionStatus("#cleanup-status", TagcastI18n.text("yearReview.progress.prepare"), true);
  try {
    const choice = await api("/api/year-review/choice", {id: yearReviewView.data.id, album: id, direction, year});
    if (request !== yearReviewView.request || details !== state.details || !live() || !$("#cleanup").open) return;
    const scope = typeof nav !== "undefined" ? nav.scope : 0;
    await openEditor(row.ids);
    if (details !== state.details || report !== yearReviewView.data || !live() || (typeof nav !== "undefined" && scope !== nav.scope)) return;
    if (!editing || !sameValue(editing.originals.map(yearReviewIdentity), choice.albums.map(yearReviewIdentity))) {
      toast(TagcastI18n.text("yearReview.changed")); return;
    }
    const yearInput = $("#metadata-form").elements.year;
    yearInput.value = String(choice.year);
    if (direction !== "album-to-tracks") editing.dirty.add("year");
    // Explicit direction overrides the general default, never the stored preference.
    $("#track-years").checked = direction !== "tracks-to-album";
    $("#then-next").checked = false;
    editing.yearReviewReturn = yearReviewView.returnTo = {hash: location.hash, session: state.connection.playback_session,
      libraryRequest: libraryLoadRequest, scroll: $("#cleanup").scrollTop, index: report.rows.indexOf(row), saving: false};
    buildReview();
    setActionStatus("#cleanup-status", "");
  } catch (error) {
    if (details === state.details && live()) {
      if ($("#cleanup").open) setActionStatus("#cleanup-status", TagcastI18n.errorText(error));
      else toast(TagcastI18n.errorText(error));
      if (error.status === 409) yearReviewView.data = null;
    }
  } finally {
    if (request === yearReviewView.request) {
      yearReviewView.busy = false;
      setActionStatus("#cleanup-status", undefined);
      if ($("#cleanup").open && cleanupView.category === "years") renderYearReview();
    }
  }
}

function currentYearReviewReturn(context) {
  return context && context === yearReviewView.returnTo && live() && $("#cleanup").open
    && cleanupView.category === "years" && context.libraryRequest === libraryLoadRequest
    && context.session === state.connection.playback_session && context.hash === location.hash;
}

function restoreYearReviewPosition(context) {
  if (!currentYearReviewReturn(context) || $("#editor").open || $("#review").open || $("#results").open) return;
  $("#cleanup").scrollTop = context.scroll;
  const rows = yearReviewView.data?.rows || [], row = rows[Math.min(context.index, rows.length - 1)];
  const control = row && document.querySelector(`[data-year-review-album="${row.id}"]:not(:disabled)`);
  (control || $("#year-review-search") || $("#year-review-analyse"))?.focus({preventScroll: true});
}

function beginYearReviewSave(editor) {
  const context = editor?.yearReviewReturn;
  if (!currentYearReviewReturn(context)) return null;
  context.saving = true;
  return context;
}

function acceptedYearReviewSave(context) {
  if (!currentYearReviewReturn(context)) return;
  yearReviewView.request += 1; yearReviewView.data = null; yearReviewView.details = state.details;
  yearReviewView.busy = true; renderYearReview();
  setActionStatus("#cleanup-status", TagcastI18n.text("yearReview.progress.checkSaved"), true);
}

async function finishedYearReviewSave(context, job, entry) {
  if (context !== yearReviewView.returnTo) return;
  context.saving = false; yearReviewView.busy = false;
  if (!currentYearReviewReturn(context)) {
    yearReviewView.returnTo = null;
    if ($("#cleanup").open && cleanupView.category === "years") {
      renderYearReview(); setActionStatus("#cleanup-status", TagcastI18n.text("yearReview.viewChanged"));
    }
    return;
  }
  if (job?.state === "done" && entry.status === "saved" && !pendingAlbums) {
    await fetchYearReview(true, true);
    restoreYearReviewPosition(context);
  } else {
    renderYearReview();
    setActionStatus("#cleanup-status", TagcastI18n.text("yearReview.notConfirmed"));
  }
  if (context === yearReviewView.returnTo) yearReviewView.returnTo = null;
}

$("#editor").addEventListener("close", () => {
  const context = yearReviewView.returnTo;
  if (!context?.saving && currentYearReviewReturn(context)) {
    restoreYearReviewPosition(context); yearReviewView.returnTo = null;
  }
});

document.addEventListener("click", event => {
  if (event.target.closest("#year-review-analyse")) return fetchYearReview(true);
  if (event.target.closest("#year-review-find")) {
    yearReviewView.query = $("#year-review-search").value; yearReviewView.offset = 0; return fetchYearReview();
  }
  const page = event.target.closest("[data-year-review-page]");
  if (page) { yearReviewView.offset = Math.max(0, yearReviewView.offset + Number(page.dataset.yearReviewPage)); return fetchYearReview(); }
  const choice = event.target.closest("[data-year-review-album]");
  if (choice) return chooseYearReview(choice.dataset.yearReviewAlbum, choice.dataset.yearDirection);
});
$("#cleanup").addEventListener("change", event => {
  if (event.target.id === "year-review-category") {
    yearReviewView.query = $("#year-review-search").value; yearReviewView.category = event.target.value; yearReviewView.offset = 0; fetchYearReview();
  }
  if (event.target.dataset?.yearReviewChoice) {
    const row = yearReviewView.data?.rows.find(item => item.id === event.target.dataset.yearReviewChoice);
    for (const direction of ["tracks-to-album", "tracks-to-album-and-tracks"]) {
      const button = document.querySelector(`[data-year-review-album="${event.target.dataset.yearReviewChoice}"][data-year-direction="${direction}"]`);
      if (button) button.disabled = !row || yearReviewView.busy || !row.bounded || yearReviewView.data.combine_sets || row.category === "invalid"
        || !yearReviewKnown(Number(event.target.value)) || (direction === "tracks-to-album" && Number(event.target.value) === row.album_year);
    }
  }
});
$("#cleanup").addEventListener("keydown", event => {
  if (event.target.id === "year-review-search" && event.key === "Enter") {
    event.preventDefault(); yearReviewView.query = event.target.value; yearReviewView.offset = 0; fetchYearReview();
  }
});
$("#cleanup").addEventListener("close", () => {
  yearReviewView.request += 1; yearReviewView.busy = false; yearReviewView.returnTo = null; setActionStatus("#cleanup-status", "");
});
