"use strict";

// Native lyrics are lazy and account/session-bound. Public lookup is always explicit.
const trackLyrics = {details: null, entries: new Map(), cacheRead: null, review: null, viewer: null, busy: false, revision: 0};
let albumLyricsCheck = null;

function resetTrackLyrics() {
  cancelAlbumLyricsCheck();
  trackLyrics.revision += 1; trackLyrics.entries.clear(); trackLyrics.review = null;
  trackLyrics.cacheRead = null;
  $("#lyrics-review").close();
  closeLyricsViewer(false); refreshAlbumLyricsLabels();
}

function invalidateLyricsSource() {
  cancelAlbumLyricsCheck();
  trackLyrics.revision += 1; trackLyrics.review = null;
  trackLyrics.cacheRead = null;
  $("#lyrics-review").close();
  for (const entry of trackLyrics.entries.values()) {
    entry.data = null; entry.loading = false; entry.pending = null; entry.error = "";
  }
  repaintLyrics();
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
  const hint = data.source === "lrclib" ? "Lyrics available from LRCLIB" : "Lyrics saved in iBroadcast";
  return `<button type="button" class="lyrics-label" data-lyrics-view="${escapeHtml(track.id)}" title="${hint}" aria-label="View lyrics for ${escapeHtml(track.title)}" aria-haspopup="dialog">Lyrics</button>`;
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
    if (current()) toast(`Could not read saved lyrics: ${error.message}`);
  }
}

function cancelAlbumLyricsCheck() {
  if (albumLyricsCheck) albumLyricsCheck.running = false;
  albumLyricsCheck = null;
}

function stopAlbumLyricsCheck() {
  if (!albumLyricsCheck?.running) return;
  albumLyricsCheck.running = false;
  albumLyricsCheck.message = `Stopped after ${albumLyricsCheck.checked} of ${albumLyricsCheck.total} tracks. Results already read are kept.`;
  renderAlbumLyricsCheck();
}

function renderAlbumLyricsCheck() {
  const box = $("#album-lyrics-check"), job = albumLyricsCheck;
  if (!box) return;
  box.hidden = !job || state.screen !== "album" || job.id !== albumView.id || job.details !== state.details;
  if (box.hidden) return;
  const status = $("#album-lyrics-status");
  status.textContent = job.running ? `Checking album lyrics… ${job.checked} of ${job.total} tracks` : job.message;
  status.classList.toggle("operation-status", job.running); status.dataset.working = String(job.running);
  $("#album-lyrics-stop").hidden = !job.running;
}

async function checkAlbumLyrics() {
  if (!live() || state.loading || state.screen !== "album" || albumView.loading || albumView.trash) return;
  if (albumLyricsCheck?.running) { stopAlbumLyricsCheck(); return; }
  const tracks = [...new Map(albumLyricsTracks().map(track => [String(track.id), track])).values()];
  if (!tracks.length) return;
  // Keep the complete checked album within the existing bounded in-memory cache.
  if (tracks.length > 100) { toast("Album lyrics checks support up to 100 tracks. Check individual tracks in Edit tracks or Now playing for this album."); return; }
  lyricsEntry(lyricsSelection(tracks[0]));
  const job = {id: albumView.id, details: state.details, session: state.connection.playback_session,
    revision: trackLyrics.revision, request: albumView.request, total: tracks.length, checked: 0, found: 0, running: true, message: ""};
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
      job.running = false; job.message = `Lyrics check stopped: ${entry.error} Results already read are kept.`;
      renderAlbumLyricsCheck(); return;
    }
    job.checked += 1;
    if (entry.data?.status === "ready" && entry.data.text?.trim()) job.found += 1;
    refreshAlbumLyricsLabels(); renderAlbumLyricsCheck();
  }
  if (!current()) return;
  job.running = false; job.message = `Checked ${job.checked} tracks · Lyrics available for ${job.found}.`;
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
  $("#lyrics-viewer-content").innerHTML = `<p class="muted">${escapeHtml(track.artist)}</p><div class="lyrics-text" tabindex="0" role="region" aria-label="Lyrics">${escapeHtml(data.text)}</div><p class="muted lyrics-source">${data.source === "lrclib" ? '<a href="https://lrclib.net/" target="_blank" rel="noopener noreferrer">LRCLIB ↗</a> · Saved on this computer' : "Saved in iBroadcast"}</p>`;
  $("#lyrics-viewer").showModal();
  $("#lyrics-viewer-close").focus({preventScroll: true});
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
  if (!data && !entry.loading && !entry.error) loadTrackLyrics(selection, entry);
  const focused = document.activeElement?.closest?.(context === "track" ? "#track-lyrics" : "#now-playing-lyrics");
  const focusAction = focused ? document.activeElement?.dataset?.lyricsAction : null;
  const action = (name, label, disabled = false) => `<button type="button" class="button small" data-lyrics-action="${name}" data-lyrics-context="${context}" ${disabled ? "disabled" : ""}>${label}</button>`;
  const status = entry.loading ? '<p class="operation-status muted" data-working="true" role="status">Checking lyrics…</p>'
    : entry.error ? `<p class="error-text" role="status">${escapeHtml(entry.error)}</p>${action("retry", "Check again")}` : "";
  const source = data?.source === "lrclib" ? '<a href="https://lrclib.net/" target="_blank" rel="noopener noreferrer">LRCLIB ↗</a> · Saved on this computer'
    : "iBroadcast";
  const note = data?.status === "instrumental" ? "LRCLIB marks this recording as instrumental."
    : data?.status === "missing" ? "No matching lyrics found."
      : data?.status === "not_cached" ? "No lyrics stored in iBroadcast. Find lyrics sends this track’s title, artist and duration to LRCLIB." : "";
  const find = data?.can_lookup ? action("find", "Find lyrics on LRCLIB", entry.loading) : "";
  const refresh = data ? action("retry", "Check iBroadcast again", entry.loading) : "";
  const text = data?.text ? `<details data-lyrics-expanded="${context}" ${entry.open ? "open" : ""}><summary>${data.source === "lrclib" ? "LRCLIB" : "iBroadcast"}</summary><div class="lyrics-text">${escapeHtml(data.text)}</div>${data.source === "lrclib" ? `<p class="muted lyrics-source">${source}</p>` : ""}</details>` : "";
  if (context === "track" && canEditTrackLyrics(entry)) {
    const draft = entry.draft ?? data?.native_text ?? "";
    box.innerHTML = `<h4>Lyrics</h4><label class="field"><span>Track lyrics in iBroadcast</span><textarea id="track-lyrics-text" rows="8" maxlength="50000" aria-label="Track lyrics in iBroadcast" ${entry.loading ? "disabled" : ""}>${escapeHtml(draft)}</textarea></label><p class="muted">Save lyrics separately after review. Other track fields and additional metadata stay as they are.</p><div class="lyrics-actions">${find}${data?.source === "lrclib" && data.text ? action("use", "Use these lyrics", entry.loading) : ""}${action("review", "Review lyrics…", entry.loading || draft === data?.native_text)}${refresh}</div>${status}${note ? `<p class="muted">${note}</p>` : ""}${data?.source === "lrclib" ? text : ""}`;
  } else {
    box.innerHTML = `<h3>Lyrics</h3>${text}${status}${note ? `<p class="muted">${note}</p>` : ""}<div class="lyrics-actions">${find}${refresh}</div>`;
  }
  if (focusAction) box.querySelector(`[data-lyrics-action="${focusAction}"]`)?.focus({preventScroll: true});
}

function repaintLyrics() {
  for (const context of ["track", "player"]) renderLyrics(context);
  refreshAlbumLyricsLabels();
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
  } catch (error) { if (current()) entry.error = error.message; }
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
      entry.error = "Lyrics changed since the saved cache. Check the refreshed text and your draft before reviewing again.";
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
    $("#lyrics-review-content").innerHTML = `<h3>${escapeHtml(data.title)}</h3><p>Change only this track’s lyrics in iBroadcast. Additional metadata and music files stay unchanged.</p><details><summary>Before</summary><div class="lyrics-text">${escapeHtml(data.before || "No lyrics")}</div></details><details open><summary>After${data.after ? "" : " · Remove lyrics"}</summary><div class="lyrics-text">${escapeHtml(data.after || "No lyrics")}</div></details>`;
    $("#lyrics-save-status").textContent = ""; $("#lyrics-save").disabled = false;
    $("#lyrics-review").showModal();
  } catch (error) { if (details === state.details && revision === trackLyrics.revision) entry.error = error.message; }
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
  status.textContent = "Saving lyrics and checking iBroadcast…";
  // Consume the browser review too; errors require a new native read and review.
  trackLyrics.review = null;
  try {
    const data = await api("/api/lyrics/save", {id: review.data.id, approved: true});
    if (review.details !== state.details || review.revision !== trackLyrics.revision
        || review.selection.session !== state.connection.playback_session) return;
    if (data.status !== "saved") throw Error("Lyrics were sent but could not be confirmed. Check iBroadcast before reviewing again.");
    review.entry.draft = null; review.entry.data = null; review.entry.error = "";
    review.entry.focusAfterLoad = true;
    $("#lyrics-review").close(); repaintLyrics(); toast(data.cache_error || "Lyrics saved and confirmed in iBroadcast.");
  } catch (error) {
    status.textContent = `${error.message} This request will not be sent again. Close this review and check lyrics again before retrying.`;
    review.entry.error = "Check iBroadcast before reviewing another lyrics change.";
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
