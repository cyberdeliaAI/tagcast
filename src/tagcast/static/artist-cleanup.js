"use strict";

const artistCleanupView = {request: 0, details: null, data: null};

function resetArtistCleanup(close = false) {
  artistCleanupView.request += 1;
  artistCleanupView.details = null;
  artistCleanupView.data = null;
  $("#artist-cleanup-results").innerHTML = "";
  $("#artist-cleanup-analyse").disabled = false;
  setActionStatus("#artist-cleanup-status", "");
  if (close && $("#artist-cleanup").open) $("#artist-cleanup").close();
}

function openArtistCleanup() {
  if (!live()) { toast(TagcastI18n.text("cleanup.open.connect")); return; }
  resetArtistCleanup();
  $("#artist-cleanup").showModal();
}

function renderArtistCleanup(data) {
  const albums = data.albums.map(album => `<section class="cleanup-album">
    <h3>${escapeHtml(album.title)}</h3><p class="muted">${escapeHtml(album.artist)}</p>
    ${album.tracks.map(track => `<div class="cleanup-example">
      <strong>${escapeHtml(track.title)}</strong>
      <p class="muted">${TagcastI18n.html("artistCleanup.credit", {artist: track.artist, guest: track.guest})}</p>
      <button type="button" class="button small" data-artist-cleanup-track="${escapeHtml(track.id)}" data-album-id="${escapeHtml(album.id)}">${TagcastI18n.html("artistCleanup.edit")}</button>
    </div>`).join("")}
  </section>`).join("");
  $("#artist-cleanup-results").innerHTML = data.total_tracks ? `<p>${TagcastI18n.html("cleanup.count.tracks", {count: data.total_tracks})} · ${TagcastI18n.html("cleanup.count.albums", {count: data.total_albums})}</p>
    ${albums}
    ${data.total_tracks > data.limit ? `<div class="pagination">
      <button type="button" class="button small" data-artist-cleanup-page="${data.offset - data.limit}" ${data.offset === 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button>
      <span>${Math.floor(data.offset / data.limit) + 1} / ${Math.ceil(data.total_tracks / data.limit)}</span>
      <button type="button" class="button small" data-artist-cleanup-page="${data.offset + data.limit}" ${data.offset + data.limit >= data.total_tracks ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button>
    </div>` : ""}` : `<p class="empty">${TagcastI18n.html("artistCleanup.empty")}</p>`;
}

async function analyseArtistCleanup(offset = 0) {
  const dialog = $("#artist-cleanup"), button = $("#artist-cleanup-analyse");
  if (!dialog.open || !live() || button.disabled) return;
  const request = ++artistCleanupView.request, details = state.details;
  const current = () => request === artistCleanupView.request && details === state.details && dialog.open && live();
  const moveFocus = dialog.contains(document.activeElement);
  button.disabled = true;
  setActionStatus("#artist-cleanup-status", TagcastI18n.text("artistCleanup.loading"), true);
  try {
    const data = await api(`/api/artist-cleanup?offset=${offset}`);
    if (!current()) return;
    artistCleanupView.data = data;
    artistCleanupView.details = details;
    renderArtistCleanup(data);
    setActionStatus("#artist-cleanup-status", "");
    dialog.scrollTop = 0;
  } catch (error) {
    if (!current()) return;
    if (error.status === 409) {
      artistCleanupView.data = null;
      $("#artist-cleanup-results").innerHTML = "";
    }
    setActionStatus("#artist-cleanup-status", TagcastI18n.errorText(error));
  } finally {
    if (request === artistCleanupView.request && dialog.open) {
      button.disabled = false;
      if (details !== state.details) artistCleanupChanged();
      if (moveFocus && document.activeElement === document.body) button.focus({preventScroll: true});
    }
  }
}

function artistCleanupChanged() {
  resetArtistCleanup();
  setActionStatus("#artist-cleanup-status", TagcastI18n.text("artistCleanup.changed"));
}

async function openArtistCleanupTrack(albumId, trackId) {
  const {details, data, request} = artistCleanupView;
  const canOpen = () => $("#artist-cleanup").open && live() && details === state.details
    && data === artistCleanupView.data && request === artistCleanupView.request;
  if (!canOpen()) { artistCleanupChanged(); return; }
  const album = data?.albums.find(item => item.id === albumId);
  if (!album?.tracks.some(track => track.id === trackId) || $("#artist-cleanup-analyse").disabled) return;
  await openEditor([albumId], {onlineSuggestions: false, canOpen});
  if (!canOpen() || !$("#editor").open || editing?.ids[0] !== albumId) return;
  editTrack(trackId, {loadLyrics: false, scrollBehavior: "instant"});
  $("#track-inline [data-credit-add]")?.focus({preventScroll: true});
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-artist-cleanup-open]")) openArtistCleanup();
});

$("#artist-cleanup").addEventListener("click", event => {
  if (event.target.closest("#artist-cleanup-analyse")) return analyseArtistCleanup();
  const page = event.target.closest("[data-artist-cleanup-page]");
  if (page) return analyseArtistCleanup(Number(page.dataset.artistCleanupPage));
  const edit = event.target.closest("[data-artist-cleanup-track]");
  if (edit) return openArtistCleanupTrack(edit.dataset.albumId, edit.dataset.artistCleanupTrack);
});

$("#artist-cleanup").addEventListener("close", () => {
  if (!$("#artist-cleanup").open) resetArtistCleanup();
});
$("#editor").addEventListener("close", () => {
  if ($("#artist-cleanup").open && artistCleanupView.data && artistCleanupView.details !== state.details) artistCleanupChanged();
});
