"use strict";

// This comparison only prepares the existing single-album metadata review.
const yearReviewView = {data: null, details: null, request: 0, busy: false, query: "", category: "differences", offset: 0, returnTo: null};
const yearReviewLabels = {differences: "All differences", different: "One different track year", mixed: "Mixed track years",
  "missing-tracks": "Missing track years", "missing-album": "Missing album year", unknown: "All years missing", invalid: "Invalid years"};
const yearReviewKnown = year => Number.isInteger(year) && year >= 1800 && year <= 2050;
const yearReviewShown = year => year === 0 ? "Unknown" : String(year);

function resetYearReview() {
  yearReviewView.request += 1; yearReviewView.data = null; yearReviewView.details = null; yearReviewView.busy = false;
  yearReviewView.query = ""; yearReviewView.category = "differences"; yearReviewView.offset = 0;
  yearReviewView.returnTo = null;
}

function renderYearReview() {
  if (yearReviewView.details !== state.details) yearReviewView.data = null;
  const data = yearReviewView.data, busy = yearReviewView.busy, stats = data?.stats;
  const scroll = $("#cleanup").scrollTop;
  const focus = document.activeElement?.id;
  $("#cleanup-content").innerHTML = `<p class="muted">Compare album release years with the years stored on their tracks. A difference can be intentional, for example on compilations or reissues. Tagcast never chooses the correct year for you.</p>
    <div class="cleanup-controls">${cleanupCategoryControl(busy)}<button type="button" class="button" id="year-review-analyse" ${busy ? "disabled" : ""}>${data ? "Analyse again" : "Analyse years"}</button></div>
    <p class="muted">Analysis uses your loaded library only. It does not fetch audio, look up dates or save changes. Your other cleanup draft and report stay separate.</p>
    ${stats ? `<p class="year-review-summary"><strong>${fmt(stats.albums)} albums</strong> · ${fmt(stats.discs)} native disc records · ${fmt(stats.different_tracks)} tracks with a different known year · ${fmt(stats.missing_track_years)} ${stats.missing_track_years === 1 ? "track" : "tracks"} without a year (known album year)</p>
    <div class="year-review-filters"><div class="field clearable-field"><label for="year-review-search">Search albums, artists or years</label>${clearableSearchInput("year-review-search", "", yearReviewView.query, busy)}</div><label class="field">Show<select id="year-review-category" ${busy ? "disabled" : ""}>${Object.entries(yearReviewLabels).map(([key, label]) => `<option value="${key}" ${key === yearReviewView.category ? "selected" : ""}>${label}</option>`).join("")}</select></label><button type="button" class="button small" id="year-review-find" ${busy ? "disabled" : ""}>Search</button></div>
    <p class="muted">${fmt(data.total)} matching ${data.total === 1 ? "album" : "albums"}. Complete disc sets stay together. Missing years are separate from conflicting known years; All differences omits albums where every year is missing.</p>
    ${data.combine_sets ? '<p class="warn-box">Combine Multi-Disc Album Sets is on in iBroadcast. Track-year changes remain available; album-year changes are blocked.</p>' : ""}
    <div class="cleanup-albums">${data.rows.map(row => yearReviewRow(row, data.combine_sets, busy)).join("") || '<p class="empty">No albums in this category. Choose another category or change the search.</p>'}</div>
    ${data.total > data.limit ? `<div class="pagination"><button type="button" class="button small" data-year-review-page="-25" ${busy || data.offset <= 0 ? "disabled" : ""}>← Previous</button><span>${Math.floor(data.offset / data.limit) + 1} / ${Math.ceil(data.total / data.limit)}</span><button type="button" class="button small" data-year-review-page="25" ${busy || data.offset + data.limit >= data.total ? "disabled" : ""}>Next →</button></div>` : ""}
    <p class="muted">Choose one action for one album at a time. The normal before/after review shows every affected record; nothing is saved until you confirm there. After a confirmed save, this overview updates with your search and filter preserved.</p>`
    : yearReviewView.returnTo?.saving ? '<p class="empty">Checking the saved years. This overview will update when iBroadcast confirms the result.</p>'
      : '<p class="empty">Choose Analyse years to find differences and missing years. Opening this category does not scan or change the library.</p>'}`;
  $("#cleanup").scrollTop = scroll;
  if (["year-review-search", "year-review-category", "year-review-find", "year-review-analyse"].includes(focus)) document.getElementById(focus)?.focus({preventScroll: true});
}

function yearReviewRow(row, combined, busy) {
  const valid = row.track_years.filter(item => yearReviewKnown(item.year));
  const blocked = busy || !row.bounded || row.category === "invalid";
  const selected = valid.length === 1 ? valid[0].year : "";
  return `<section class="cleanup-album year-review-album"><h3>${escapeHtml(row.album)}</h3><p class="muted">${escapeHtml(row.artist)} · ${fmt(row.tracks)} tracks · ${row.discs > 1 ? `${row.discs} discs` : `Disc ${row.disc || "?"}`} · ${escapeHtml(yearReviewLabels[row.category])}</p>
    <dl class="year-review-values"><div><dt>Album year</dt><dd>${escapeHtml(yearReviewShown(row.album_year))}</dd></div><div><dt>Track years</dt><dd>${row.track_years.map(item => `${escapeHtml(yearReviewShown(item.year))} <span class="muted">(${fmt(item.count)} ${item.count === 1 ? "track" : "tracks"})</span>`).join(" · ")}</dd></div></dl>
    ${!row.bounded ? '<p class="muted">This selection exceeds 20 discs / 500 tracks. Open the album to edit a smaller selection manually.</p>' : row.category === "invalid" ? '<p class="muted">Invalid stored years need individual inspection in the album editor.</p>' : ""}
    <div class="year-review-directions"><div><button type="button" class="button small" data-year-review-album="${escapeHtml(row.id)}" data-year-direction="album-to-tracks" ${blocked || !yearReviewKnown(row.album_year) ? "disabled" : ""}>Album year → track years…</button><small class="muted">Apply ${yearReviewKnown(row.album_year) ? row.album_year : "a known album year"} to all tracks; leave the album unchanged.</small></div>
    <div><label class="field">Choose a track year<select data-year-review-choice="${escapeHtml(row.id)}" ${blocked || combined || !valid.length ? "disabled" : ""}><option value="" ${selected === "" ? "selected" : ""}>Choose a track year…</option>${valid.map(item => `<option value="${item.year}" ${selected === item.year ? "selected" : ""}>${item.year} (${item.count} ${item.count === 1 ? "track" : "tracks"})</option>`).join("")}</select></label><button type="button" class="button small" data-year-review-album="${escapeHtml(row.id)}" data-year-direction="tracks-to-album" ${blocked || combined || !selected || selected === row.album_year ? "disabled" : ""}>Track year → album year…</button><small class="muted">Change the album year only; track years stay unchanged.</small><button type="button" class="button small" data-year-review-album="${escapeHtml(row.id)}" data-year-direction="tracks-to-album-and-tracks" ${blocked || combined || !selected ? "disabled" : ""}>Track year → album + all tracks…</button><small class="muted">Apply the selected year to the album and all tracks. Tracks already at that year stay unchanged. Mixed years require your choice.</small></div></div></section>`;
}

async function fetchYearReview(analyse = false, preserveView = false) {
  if (yearReviewView.busy || !live() || cleanupView.category !== "years") return;
  const request = ++yearReviewView.request, details = state.details, focus = document.activeElement?.id;
  yearReviewView.busy = true; renderYearReview();
  setActionStatus("#cleanup-status", analyse ? "Comparing the loaded album and track years…" : "Reading year comparisons…", true);
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
    setActionStatus("#cleanup-status", error.message);
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
  if (!yearReviewKnown(year)) { setActionStatus("#cleanup-status", "Choose a known year first."); return; }
  const request = ++yearReviewView.request, details = state.details, report = yearReviewView.data;
  yearReviewView.busy = true; renderYearReview();
  setActionStatus("#cleanup-status", "Preparing the existing album review. Nothing is saved…", true);
  try {
    const choice = await api("/api/year-review/choice", {id: yearReviewView.data.id, album: id, direction, year});
    if (request !== yearReviewView.request || details !== state.details || !live() || !$("#cleanup").open) return;
    const scope = typeof nav !== "undefined" ? nav.scope : 0;
    await openEditor(row.ids);
    if (details !== state.details || report !== yearReviewView.data || !live() || (typeof nav !== "undefined" && scope !== nav.scope)) return;
    if (!editing || !sameValue(editing.originals.map(yearReviewIdentity), choice.albums.map(yearReviewIdentity))) {
      toast("The album changed since analysis. Analyse again or inspect this album manually."); return;
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
      if ($("#cleanup").open) setActionStatus("#cleanup-status", error.message);
      else toast(error.message);
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
  setActionStatus("#cleanup-status", "Checking saved years with iBroadcast…", true);
}

async function finishedYearReviewSave(context, job, entry) {
  if (context !== yearReviewView.returnTo) return;
  context.saving = false; yearReviewView.busy = false;
  if (!currentYearReviewReturn(context)) {
    yearReviewView.returnTo = null;
    if ($("#cleanup").open && cleanupView.category === "years") {
      renderYearReview(); setActionStatus("#cleanup-status", "The view or session changed. Analyse years again for current results.");
    }
    return;
  }
  if (job?.state === "done" && entry.status === "saved" && !pendingAlbums) {
    await fetchYearReview(true, true);
    restoreYearReviewPosition(context);
  } else {
    renderYearReview();
    setActionStatus("#cleanup-status", "The save was not fully confirmed here. Check the result or History, then analyse again. Nothing is retried automatically.");
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
