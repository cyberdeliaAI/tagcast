"use strict";

// Optional public background text; no library scan, metadata writes or audio changes.
const albumInformation = {enabled: false, revision: 0, serverRevision: null, entries: new Map()};
let albumInformationRetryTimer;

function resetAlbumInformation() {
  clearTimeout(albumInformationRetryTimer);
  albumInformation.revision += 1; albumInformation.entries.clear();
  const box = $("#album-information");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

function applyAlbumInformationSettings(data) {
  const enabled = data.album_information === true;
  if (enabled !== albumInformation.enabled || data.album_information_revision !== albumInformation.serverRevision) resetAlbumInformation();
  albumInformation.serverRevision = data.album_information_revision;
  albumInformation.enabled = enabled;
  renderAlbumInformation();
}

function albumInformationSelection() {
  if (!live() || state.loading || state.screen !== "album" || albumView.loading) return null;
  const album = state.albums.find(a => String(a.id) === albumView.id);
  return album ? {album_id: String(album.id), album: album.name, artist: album.artist,
    session: state.connection.playback_session} : null;
}

const albumInformationKey = selection => JSON.stringify([selection.album_id, selection.artist, selection.album, selection.session]);

function albumInformationFocus() {
  const focused = document.activeElement;
  return focused?.matches?.("#album-information summary") ? "summary"
    : focused?.matches?.("#album-information [data-album-information-retry]") ? "[data-album-information-retry]" : "";
}

// quiet: repaint from memory after a language change; never starts or refreshes a lookup.
function renderAlbumInformation(restoreFocus = "", quiet = false) {
  const box = $("#album-information");
  if (!box) return;
  const selection = albumInformationSelection();
  const source = albumBackgroundSource();
  const key = selection && albumInformationKey(selection);
  if (quiet && albumInformation.enabled && selection && source === "theaudiodb" && !albumInformation.entries.has(key)) return;
  clearTimeout(albumInformationRetryTimer);
  box.hidden = !albumInformation.enabled || !selection || source !== "theaudiodb";
  if (box.hidden) {
    box.innerHTML = "";
    // A metadata-only cache replacement can reach this renderer without an album repaint.
    if (albumInformation.enabled && selection && source === "pending" && !quiet) loadGuideAlbumNotes();
    return;
  }
  let entry = albumInformation.entries.get(key);
  if (!entry) {
    entry = {data: null, loading: true, error: ""}; albumInformation.entries.set(key, entry);
    while (albumInformation.entries.size > 100) albumInformation.entries.delete(albumInformation.entries.keys().next().value);
    loadAlbumInformation(selection, key, entry);
  } else if (!quiet && !entry.loading && !entry.error && entry.data?.expires_at <= Date.now() / 1000
      && Date.now() - entry.checkedAt >= 60000) {
    entry.loading = true; loadAlbumInformation(selection, key, entry);
  }
  const focused = restoreFocus || albumInformationFocus();
  const data = entry.data, wait = Math.max(0, Math.ceil(((entry.retryAt || 0) - Date.now()) / 1000));
  const retryTime = wait ? TagcastI18n.dateTime(entry.retryAt, {hour: "2-digit", minute: "2-digit", second: "2-digit"}) : "";
  if (entry.error && wait) {
    const revision = albumInformation.revision;
    albumInformationRetryTimer = setTimeout(() => {
      if (revision === albumInformation.revision && albumInformation.enabled
          && albumInformation.entries.get(key) === entry
          && albumInformationSelection() && albumInformationKey(albumInformationSelection()) === key) renderAlbumInformation();
    }, wait * 1000);
  }
  const note = entry.error ? `<p class="error-text" role="status">${escapeHtml(TagcastI18n.errorText(entry.error))} <button type="button" class="text-action" data-album-information-retry${wait ? " disabled" : ""}>${wait ? TagcastI18n.html("artists.biography.retryAt", {time: retryTime}) : TagcastI18n.html("common.tryAgain")}</button></p>`
    : entry.loading ? `<p class="muted" role="status">${TagcastI18n.html("albumInfo.loading")}</p>` : "";
  box.dataset.albumInformationKey = key;
  if (data?.status === "ready" && data.description) {
    const url = /^https:\/\/www\.theaudiodb\.com\/album\/[0-9]{1,20}$/.test(data.url || "") ? data.url : "https://www.theaudiodb.com/";
    const link = TagcastI18n.trusted(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">TheAudioDB ↗</a>`);
    box.innerHTML = `<details ${entry.open ? "open" : ""}><summary>${TagcastI18n.html("albumInfo.summary")} <span class="muted">TheAudioDB</span></summary><div class="artist-biography-text">${String(data.description).split(/\n+/).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join("")}</div><p class="artist-biography-source">${TagcastI18n.html("albumInfo.source", {source: link})}</p>${note}</details>`;
  } else {
    const missing = data?.reason === "missing_identity" ? "albumInfo.missingIdentity"
      : data?.status === "ambiguous" ? "albumInfo.ambiguous"
      : data?.status === "unavailable" ? "albumInfo.unavailable"
      : data?.status === "missing" ? "albumInfo.missing" : "";
    const source = data?.status === "unavailable" && /^https:\/\/www\.theaudiodb\.com\/album\/[0-9]{1,20}$/.test(data.url || "")
      ? ` <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("albumInfo.view")} ↗</a>` : "";
    box.innerHTML = `${missing ? `<p class="muted">${TagcastI18n.html(missing)}${source}</p>` : ""}${note}`;
    box.hidden = !box.innerHTML;
  }
  if (focused) box.querySelector(focused)?.focus();
}

async function loadAlbumInformation(selection, key, entry) {
  const details = state.details, revision = albumInformation.revision;
  entry.checkedAt = Date.now();
  const current = () => live() && !state.loading && details === state.details
    && selection.session === state.connection.playback_session && revision === albumInformation.revision
    && albumInformation.enabled && albumInformation.entries.get(key) === entry;
  const visible = () => current() && albumInformationSelection()
    && albumInformationKey(albumInformationSelection()) === key && albumBackgroundSource() === "theaudiodb";
  try {
    const cached = await api("/api/album-information", selection);
    if (!current()) return;
    if (!cached.enabled) { applyAlbumInformationSettings({album_information: false}); return; }
    entry.data = cached;
    if (visible()) renderAlbumInformation();
    if (cached.needs_lookup && visible()) {
      const data = await api("/api/album-information", {...selection, lookup: true});
      if (!current()) return;
      if (!data.enabled) { applyAlbumInformationSettings({album_information: false}); return; }
      entry.data = data;
    }
  } catch (error) {
    if (current()) {
      entry.error = error;
      const wait = Number(error.data?.retry_after);
      entry.retryAt = Number.isFinite(wait) && wait > 0 ? Date.now() + Math.min(wait, 60) * 1000 : 0;
    }
  } finally {
    entry.loading = false;
    if (current()) {
      // Leaving during a cache-only read must not trigger a hidden provider lookup.
      if (entry.data?.needs_lookup && !entry.error && !visible()) albumInformation.entries.delete(key);
      if (visible()) renderAlbumInformation();
    } else if (albumInformation.entries.get(key) === entry) {
      albumInformation.entries.delete(key);
      const selected = albumInformationSelection();
      // A metadata/tag refresh can replace only the details Map. Recover the visible same album.
      if (revision === albumInformation.revision && albumInformation.enabled && selected
          && albumInformationKey(selected) === key) renderAlbumInformation();
    }
  }
}

document.addEventListener("toggle", event => {
  if (!event.target.isConnected || !event.target.matches?.("#album-information details")) return;
  const entry = albumInformation.entries.get($("#album-information").dataset.albumInformationKey);
  if (entry) entry.open = event.target.open;
}, true);

document.addEventListener("click", event => {
  if (!event.target.closest("[data-album-information-retry]")) return;
  const selection = albumInformationSelection();
  if (!selection || !albumInformation.enabled || albumBackgroundSource() !== "theaudiodb") return;
  const key = albumInformationKey(selection), entry = albumInformation.entries.get(key);
  if (!entry || entry.loading || entry.retryAt > Date.now()) return;
  entry.error = ""; entry.retryAt = 0; entry.loading = true;
  loadAlbumInformation(selection, key, entry); renderAlbumInformation();
});
