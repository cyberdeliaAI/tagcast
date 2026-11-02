"use strict";

// Native lyrics are lazy and account/session-bound. Public lookup is always explicit.
const trackLyrics = {details: null, entries: new Map(), cacheRead: null, review: null, viewer: null, busy: false, revision: 0};
let albumLyricsCheck = null;
// Errors are kept as Error objects (or server text) and shown through TagcastI18n.errorText(),
// so a coded error follows the interface language whenever its panel is drawn again.
let lyricsRepaintOnly = false;

function resetTrackLyrics() {
  if (typeof resetPlaybackLyrics === "function") resetPlaybackLyrics();
  cancelAlbumLyricsCheck();
  if (typeof resetAlbumLyricsImport === "function") resetAlbumLyricsImport();
  trackLyrics.revision += 1; trackLyrics.entries.clear(); trackLyrics.review = null;
  trackLyrics.cacheRead = null;
  $("#lyrics-review").close();
  closeLyricsViewer(false); refreshAlbumLyricsLabels();
}

function invalidateLyricsSource() {
  cancelAlbumLyricsCheck();
  if (typeof resetAlbumLyricsImport === "function") resetAlbumLyricsImport();
  trackLyrics.revision += 1; trackLyrics.review = null;
  trackLyrics.cacheRead = null;
  $("#lyrics-review").close();
  for (const entry of trackLyrics.entries.values()) {
    entry.data = null; entry.loading = false; entry.pending = null; entry.error = "";
  }
  repaintLyrics();
  if (typeof resetPlaybackLyrics === "function") {
    resetPlaybackLyrics(); renderPlaybackLyrics();
  }
}

// Badge/viewer reads must never create an entry or start a request.
function knownTrackLyrics(track) {
  const selection = lyricsSelection(track);
  if (!selection || trackLyrics.details !== state.details) return null;
  const entry = trackLyrics.entries.get(lyricsKey(selection));
  return !entry?.error && entry?.data?.status === "ready" && entry.data.text?.trim()
    ? entry.data : null;
}

function lyricsLabelButton(track) {
  const data = knownTrackLyrics(track);
  if (!data) return "";
  const hint = TagcastI18n.html(data.source === "lrclib" ? "lyrics.label.lrclib" : "lyrics.source.ibroadcast");
  return `<button type="button" class="lyrics-label" data-lyrics-view="${escapeHtml(track.id)}" title="${hint}" aria-label="${TagcastI18n.html("lyrics.label.view", {title: track.title})}" aria-haspopup="dialog">${TagcastI18n.html("lyrics.label.button")}</button>`;
}

function albumLyricsLabel(track) {
  const button = lyricsLabelButton(track);
  return `<span data-lyrics-label="${escapeHtml(track.id)}" ${button ? "" : "hidden"}>${button}</span>`;
}

function albumLyricsTrack(id) {
  return albumLyricsTracks().find(track => String(track.id) === String(id));
}

function albumLyricsTracks() {
  if (state.screen !== "album" || albumView.loading || state.loading) return [];
  return shelfIds(albumView.id).flatMap(disc => state.details.get(disc)?.tracks || []);
}

async function restoreAlbumLyrics() {
  const tracks = albumLyricsTracks();
  if (!live() || !tracks.length || tracks.length > 100) return;
  const details = state.details, id = albumView.id, session = state.connection.playback_session;
  if (trackLyrics.details !== details) { resetTrackLyrics(); trackLyrics.details = details; }
  // Restore once per visit, including after other albums evict these memory entries.
  const ids = shelfIds(id), revision = trackLyrics.revision, request = albumView.request;
  const key = JSON.stringify([session, ids, request, revision]);
  if (ids.length > 20 || trackLyrics.cacheRead === key) return;
  trackLyrics.cacheRead = key;
  const current = () => live() && details === state.details && revision === trackLyrics.revision
    && session === state.connection.playback_session && id === albumView.id && request === albumView.request
    && state.screen === "album";
  const forgetRead = () => { if (trackLyrics.cacheRead === key) trackLyrics.cacheRead = null; };
  try {
    const response = await api(`/api/lyrics/cache?${new URLSearchParams({album_ids: ids.join(","), session})}`);
    if (!current()) { forgetRead(); return; }
    const selections = new Map(tracks.map(track => { const s = lyricsSelection(track); return [lyricsKey(s), s]; }));
    for (const item of (response.tracks || []).slice(0, 100)) {
      const selection = selections.get(lyricsKey(item.selection));
      if (!selection) continue;
      const entry = lyricsEntry(selection);
      if (!entry.data && !entry.loading && !entry.error) entry.data = item.data;
    }
    repaintLyrics();
  } catch (error) {
    forgetRead();
    if (current()) toast(TagcastI18n.text("lyrics.cache.readFailed", {error: TagcastI18n.errorText(error)}));
  }
}

function cancelAlbumLyricsCheck() {
  if (albumLyricsCheck) albumLyricsCheck.running = false;
  albumLyricsCheck = null;
}

function stopAlbumLyricsCheck() {
  if (!albumLyricsCheck?.running) return;
  albumLyricsCheck.running = false;
  const {checked, total} = albumLyricsCheck;
  albumLyricsCheck.summary = () => TagcastI18n.text("lyrics.check.stopped", {checked, count: total});
  renderAlbumLyricsCheck();
}

function renderAlbumLyricsCheck() {
  const box = $("#album-lyrics-check"), job = albumLyricsCheck;
  if (!box) return;
  box.hidden = !job || state.screen !== "album" || job.id !== albumView.id || job.details !== state.details;
  if (box.hidden) return;
  const status = $("#album-lyrics-status");
  status.textContent = job.running ? TagcastI18n.text("lyrics.check.progress", {checked: job.checked, count: job.total}) : job.summary?.() ?? "";
  status.classList.toggle("operation-status", job.running); status.dataset.working = String(job.running);
  $("#album-lyrics-stop").hidden = !job.running;
}

async function checkAlbumLyrics() {
  if (!live() || state.loading || state.screen !== "album" || albumView.loading || albumView.trash) return;
  if (albumLyricsCheck?.running) { stopAlbumLyricsCheck(); return; }
  const tracks = [...new Map(albumLyricsTracks().map(track => [String(track.id), track])).values()];
  if (!tracks.length) return;
  // Keep the complete checked album within the existing bounded in-memory cache.
  if (tracks.length > 100) { toast(TagcastI18n.text("lyrics.check.tooMany")); return; }
  lyricsEntry(lyricsSelection(tracks[0]));
  const job = {id: albumView.id, details: state.details, session: state.connection.playback_session,
    revision: trackLyrics.revision, request: albumView.request, total: tracks.length, checked: 0, found: 0, running: true, summary: null};
  albumLyricsCheck = job; renderAlbumLyricsCheck();
  const current = () => {
    const valid = albumLyricsCheck === job && job.running && live() && !state.loading
      && job.details === state.details && job.session === state.connection.playback_session
      && job.revision === trackLyrics.revision && state.screen === "album"
      && job.id === albumView.id && job.request === albumView.request;
    if (!valid && albumLyricsCheck === job && job.running) { cancelAlbumLyricsCheck(); renderAlbumLyricsCheck(); }
    return valid;
  };
  for (const track of tracks) {
    if (!current()) return;
    const selection = lyricsSelection(track), entry = lyricsEntry(selection);
    if (!entry.data || entry.error) {
      await loadTrackLyrics(selection, entry, false, false);
    }
    if (!current()) return;
    if (entry.error) {
      const error = entry.error;
      job.running = false; job.summary = () => TagcastI18n.text("lyrics.check.failed", {error: TagcastI18n.errorText(error)});
      renderAlbumLyricsCheck(); return;
    }
    job.checked += 1;
    if (entry.data?.status === "ready" && entry.data.text?.trim()) job.found += 1;
    refreshAlbumLyricsLabels(); renderAlbumLyricsCheck();
  }
  if (!current()) return;
  const {checked, found} = job;
  job.running = false; job.summary = () => TagcastI18n.text("lyrics.check.done", {count: checked, found});
  renderAlbumLyricsCheck();
}

function refreshAlbumLyricsLabels() {
  if (state.screen !== "album") return;
  const tracks = new Map(albumLyricsTracks().map(track => [String(track.id), track]));
  for (const slot of $("#album-page").querySelectorAll("[data-lyrics-label]")) {
    const button = lyricsLabelButton(tracks.get(slot.dataset.lyricsLabel));
    if (slot.innerHTML !== button) slot.innerHTML = button;
    slot.hidden = !button;
  }
  if (trackLyrics.viewer && !knownTrackLyrics(albumLyricsTrack(trackLyrics.viewer.id))) closeLyricsViewer();
}

function closeLyricsViewer(restoreFocus = true) {
  const viewer = trackLyrics.viewer;
  trackLyrics.viewer = null;
  $("#lyrics-viewer").close(); $("#lyrics-viewer-content").innerHTML = "";
  if (restoreFocus && viewer?.focus?.isConnected) viewer.focus.focus({preventScroll: true});
}

function openLyricsViewer(button) {
  if (document.querySelector("dialog[open]")) return;
  const track = albumLyricsTrack(button.dataset.lyricsView), data = knownTrackLyrics(track);
  if (!data) return;
  trackLyrics.viewer = {id: String(track.id), focus: button};
  $("#lyrics-viewer-title").textContent = track.title;
  $("#lyrics-viewer-content").innerHTML = `<p class="muted">${escapeHtml(track.artist)}</p><div class="lyrics-text" tabindex="0" role="region" aria-label="${TagcastI18n.html("lyrics.viewer.region")}">${escapeHtml(data.text)}</div><p class="muted lyrics-source">${lyricsSavedSource(data)}</p>`;
  $("#lyrics-viewer").showModal();
  $("#lyrics-viewer-close").focus({preventScroll: true});
}

// Where displayed lyrics are kept. The LRCLIB link text is a service name.
function lyricsSavedSource(data) {
  return data.source === "lrclib"
    ? TagcastI18n.html("lyrics.source.savedLocal", {link: TagcastI18n.trusted('<a href="https://lrclib.net/" target="_blank" rel="noopener noreferrer">LRCLIB ↗</a>')})
    : TagcastI18n.html("lyrics.source.savedIbroadcast");
}

function canEditTrackLyrics(entry) {
  return state.connection.premium !== false && entry.data?.can_save === true;
}

function lyricsSelection(track) {
  if (!track || !live() || state.loading) return null;
  return {track_id: String(track.id), title: track.title, artist: track.artist,
    session: state.connection.playback_session};
}

const lyricsKey = selection => JSON.stringify(selection);

function lyricsEntry(selection) {
  if (trackLyrics.details !== state.details) {
    resetTrackLyrics(); trackLyrics.details = state.details;
  }
  const key = lyricsKey(selection);
  let entry = trackLyrics.entries.get(key);
  if (!entry) {
    entry = {selection, data: null, error: "", loading: false, pending: null, draft: null, open: true};
    trackLyrics.entries.set(key, entry);
    while (trackLyrics.entries.size > 100) trackLyrics.entries.delete(trackLyrics.entries.keys().next().value);
  }
  return entry;
}

function visibleLyricsSelection(context) {
  if (context === "track") {
    if (!editing || editing.tab === "album" || !$("#editor").open) return null;
    const id = $("#track-inline").dataset.track;
    return lyricsSelection(editing.originals.flatMap(a => a.tracks).find(t => String(t.id) === id));
  }
  return $("#now-playing-panel").hidden ? null : lyricsSelection(player.queue[player.index]);
}

function renderLyrics(context, selection = visibleLyricsSelection(context)) {
  const box = $(context === "track" ? "#track-lyrics" : "#now-playing-lyrics");
  if (!box) return;
  box.hidden = !selection;
  if (!selection) { box.innerHTML = ""; return; }
  const entry = lyricsEntry(selection), data = entry.data;
  if (!data && !entry.loading && !entry.error && !lyricsRepaintOnly) loadTrackLyrics(selection, entry);
  const focused = document.activeElement?.closest?.(context === "track" ? "#track-lyrics" : "#now-playing-lyrics");
  const focusAction = focused ? document.activeElement?.dataset?.lyricsAction : null;
  const action = (name, label, disabled = false) => `<button type="button" class="button small" data-lyrics-action="${name}" data-lyrics-context="${context}" ${disabled ? "disabled" : ""}>${label}</button>`;
  const status = entry.loading ? `<p class="operation-status muted" data-working="true" role="status">${TagcastI18n.html("lyrics.status.checking")}</p>`
    : entry.error ? `<p class="error-text" role="status">${escapeHtml(TagcastI18n.errorText(entry.error))}</p>${action("retry", TagcastI18n.html("lyrics.action.checkAgain"))}` : "";
  const note = data?.status === "instrumental" ? TagcastI18n.html("lyrics.note.instrumental")
    : data?.status === "missing" ? TagcastI18n.html("lyrics.note.missing")
      : data?.status === "not_cached" ? TagcastI18n.html("lyrics.note.notCached") : "";
  const find = data?.can_lookup ? action("find", TagcastI18n.html("lyrics.action.find"), entry.loading) : "";
  const refresh = data ? action("retry", TagcastI18n.html("lyrics.action.checkIbroadcast"), entry.loading) : "";
  const text = data?.text ? `<details data-lyrics-expanded="${context}" ${entry.open ? "open" : ""}><summary>${data.source === "lrclib" ? "LRCLIB" : "iBroadcast"}</summary><div class="lyrics-text">${escapeHtml(data.text)}</div>${data.source === "lrclib" ? `<p class="muted lyrics-source">${lyricsSavedSource(data)}</p>` : ""}</details>` : "";
  if (context === "track" && canEditTrackLyrics(entry)) {
    const draft = entry.draft ?? data?.native_text ?? "";
    const field = TagcastI18n.html("lyrics.editor.field");
    box.innerHTML = `<h4>${TagcastI18n.html("lyrics.heading")}</h4><label class="field"><span>${field}</span><textarea id="track-lyrics-text" rows="8" maxlength="50000" aria-label="${field}" ${entry.loading ? "disabled" : ""}>${escapeHtml(draft)}</textarea></label><p class="muted">${TagcastI18n.html("lyrics.editor.note")}</p><div class="lyrics-actions">${find}${data?.source === "lrclib" && data.text ? action("use", TagcastI18n.html("lyrics.action.use"), entry.loading) : ""}${action("review", TagcastI18n.html("lyrics.action.review"), entry.loading || draft === data?.native_text)}${refresh}</div>${status}${note ? `<p class="muted">${note}</p>` : ""}${data?.source === "lrclib" ? text : ""}`;
  } else {
    box.innerHTML = `<h3>${TagcastI18n.html("lyrics.heading")}</h3>${text}${status}${note ? `<p class="muted">${note}</p>` : ""}<div class="lyrics-actions">${find}${refresh}</div>`;
  }
  if (focusAction) box.querySelector(`[data-lyrics-action="${focusAction}"]`)?.focus({preventScroll: true});
}

function repaintLyrics() {
  for (const context of ["track", "player"]) renderLyrics(context);
  refreshAlbumLyricsLabels();
}

// Language changes repaint lyrics from memory only: no lyrics request starts while they run.
function repaintWithoutLyricsRequests(render) {
  lyricsRepaintOnly = true;
  try { render(); } finally { lyricsRepaintOnly = false; }
}

function loadTrackLyrics(selection, entry, lookup = false, refresh = false) {
  if (entry.pending) return entry.pending;
  entry.pending = readTrackLyrics(selection, entry, lookup, refresh);
  return entry.pending;
}

async function readTrackLyrics(selection, entry, lookup, refresh) {
  const details = state.details, revision = trackLyrics.revision;
  const current = () => details === state.details && revision === trackLyrics.revision
    && selection.session === state.connection.playback_session && live()
    && trackLyrics.entries.get(lyricsKey(selection)) === entry;
  entry.loading = true; entry.error = "";
  try {
    const data = lookup ? await api("/api/lyrics", {...selection, lookup: true})
      : await api(`/api/lyrics?${new URLSearchParams({...selection, refresh: refresh ? "1" : "0"})}`);
    if (!current()) return;
    entry.data = data;
  } catch (error) { if (current()) entry.error = error; }
  finally {
    if (current()) {
      entry.pending = null;
      entry.loading = false; repaintLyrics();
      if (entry.focusAfterLoad && lyricsKey(visibleLyricsSelection("track")) === lyricsKey(selection)) {
        $("#track-lyrics-text")?.focus({preventScroll: true});
      }
      entry.focusAfterLoad = false;
    }
  }
}

async function reviewTrackLyrics(selection, entry) {
  if (trackLyrics.busy || entry.loading || !canEditTrackLyrics(entry)) return;
  const details = state.details, revision = trackLyrics.revision;
  if (entry.data.persisted) {
    const before = entry.data.native_text;
    entry.draft ??= before;
    await loadTrackLyrics(selection, entry, false, true);
    if (details !== state.details || revision !== trackLyrics.revision
        || selection.session !== state.connection.playback_session || entry.error) return;
    if (entry.data.native_text !== before) {
      entry.error = playbackFailure("errors.lyrics.changed_since_cache");
      renderLyrics("track", selection); return;
    }
  }
  entry.loading = true; renderLyrics("track", selection);
  try {
    const data = await api("/api/lyrics/review", {...selection,
      before_token: entry.data.before_token, lyrics: entry.draft ?? entry.data.native_text});
    if (details !== state.details || revision !== trackLyrics.revision
        || selection.session !== state.connection.playback_session || !$("#editor").open
        || lyricsKey(visibleLyricsSelection("track")) !== lyricsKey(selection)) return;
    trackLyrics.review = {data, entry, selection, details, revision};
    const none = TagcastI18n.html("lyrics.review.none");
    $("#lyrics-review-content").innerHTML = `<h3>${escapeHtml(data.title)}</h3><p>${TagcastI18n.html("lyrics.review.intro")}</p><details><summary>${TagcastI18n.html("lyrics.review.before")}</summary><div class="lyrics-text">${data.before ? escapeHtml(data.before) : none}</div></details><details open><summary>${TagcastI18n.html(data.after ? "lyrics.review.after" : "lyrics.review.afterRemove")}</summary><div class="lyrics-text">${data.after ? escapeHtml(data.after) : none}</div></details>`;
    $("#lyrics-save-status").textContent = ""; $("#lyrics-save").disabled = false;
    $("#lyrics-review").showModal();
  } catch (error) { if (details === state.details && revision === trackLyrics.revision) entry.error = error; }
  finally { entry.loading = false; if (details === state.details) renderLyrics("track"); }
}

async function saveTrackLyrics() {
  const review = trackLyrics.review;
  if (!review || trackLyrics.busy || !canEditTrackLyrics(review.entry) || review.details !== state.details
      || review.revision !== trackLyrics.revision || review.selection.session !== state.connection.playback_session) return;
  trackLyrics.busy = true; $("#lyrics-save").disabled = true;
  for (const button of $("#lyrics-review").querySelectorAll('[data-close="lyrics-review"]')) button.disabled = true;
  const status = $("#lyrics-save-status");
  status.classList.add("operation-status"); status.dataset.working = "true";
  status.textContent = TagcastI18n.text("lyrics.review.saving");
  // Consume the browser review too; errors require a new native read and review.
  trackLyrics.review = null;
  try {
    const data = await api("/api/lyrics/save", {id: review.data.id, approved: true});
    if (review.details !== state.details || review.revision !== trackLyrics.revision
        || review.selection.session !== state.connection.playback_session) return;
    if (data.status !== "saved") throw playbackFailure("errors.lyrics.save_unconfirmed");
    review.entry.draft = null; review.entry.data = null; review.entry.error = "";
    review.entry.focusAfterLoad = true;
    $("#lyrics-review").close(); repaintLyrics(); toast(data.cache_error || TagcastI18n.text("lyrics.review.saved"));
  } catch (error) {
    status.textContent = TagcastI18n.text("lyrics.review.saveFailed", {error: TagcastI18n.errorText(error)});
    review.entry.error = playbackFailure("errors.lyrics.check_before_review");
    review.entry.data = null;
    refreshAlbumLyricsLabels();
  } finally {
    trackLyrics.busy = false; status.dataset.working = "false";
    for (const button of $("#lyrics-review").querySelectorAll('[data-close="lyrics-review"]')) button.disabled = false;
  }
}

document.addEventListener("input", event => {
  if (event.target.id !== "track-lyrics-text") return;
  const selection = visibleLyricsSelection("track");
  if (!selection) return;
  const entry = lyricsEntry(selection); entry.draft = event.target.value;
  const button = $("#track-lyrics").querySelector('[data-lyrics-action="review"]');
  if (button) button.disabled = !canEditTrackLyrics(entry) || entry.draft === entry.data.native_text;
});
document.addEventListener("toggle", event => {
  const context = event.target.dataset?.lyricsExpanded;
  const selection = context && visibleLyricsSelection(context);
  if (selection) lyricsEntry(selection).open = event.target.open;
}, true);
document.addEventListener("click", event => {
  if (event.target.closest("#album-lyrics-stop")) { stopAlbumLyricsCheck(); return; }
  const label = event.target.closest("[data-lyrics-view]");
  if (label) { openLyricsViewer(label); return; }
  const button = event.target.closest("[data-lyrics-action]");
  if (!button || button.disabled) return;
  const selection = visibleLyricsSelection(button.dataset.lyricsContext);
  if (!selection) return;
  const entry = lyricsEntry(selection);
  if (entry.loading) return;
  const action = button.dataset.lyricsAction;
  if (action === "use" && canEditTrackLyrics(entry)) { entry.draft = entry.data.text; renderLyrics("track", selection); }
  else if (action === "review") reviewTrackLyrics(selection, entry);
  else if (action === "find" || action === "retry") {
    loadTrackLyrics(selection, entry, action === "find", action === "retry"); repaintLyrics();
  }
});
$("#lyrics-viewer").addEventListener("cancel", event => { event.preventDefault(); closeLyricsViewer(); });
$("#lyrics-viewer").addEventListener("close", () => { if (trackLyrics.viewer) closeLyricsViewer(); });
$("#lyrics-save").addEventListener("click", saveTrackLyrics);
$("#lyrics-review").addEventListener("cancel", event => { if (trackLyrics.busy) event.preventDefault(); });
$("#lyrics-review").addEventListener("close", () => {
  trackLyrics.review = null;
  if (!trackLyrics.busy) {
    repaintLyrics();
    if (visibleLyricsSelection("track")) $("#track-lyrics-text")?.focus({preventScroll: true});
  }
});

// A language change rewrites read-only lyrics text from memory: album lyrics labels, the album
// check status and the open viewer's labels. Lyrics stay as they are; the track editor and the
// review dialog keep their text until they are drawn again. Now playing repaints in player.js.
TagcastI18n.subscribe(() => {
  if (typeof albumView === "undefined") return;
  refreshAlbumLyricsLabels(); renderAlbumLyricsCheck();
  const viewer = trackLyrics.viewer, data = viewer && knownTrackLyrics(albumLyricsTrack(viewer.id));
  if (!data) return;
  const content = $("#lyrics-viewer-content");
  content.querySelector(".lyrics-text")?.setAttribute("aria-label", TagcastI18n.text("lyrics.viewer.region"));
  const source = content.querySelector(".lyrics-source");
  if (source) source.innerHTML = lyricsSavedSource(data);
});
