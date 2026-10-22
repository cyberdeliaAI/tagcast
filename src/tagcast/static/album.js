"use strict";

// Read-only album details use the same lazy library cache as the metadata editor.
const albumView = {id: null, request: 0, loading: false, trash: null, found: ""};  // trash: track IDs chosen for the trash; found: a track opened from Tracks
const coverLightbox = {open: false, focus: null, timer: null, fallback: "", fallbackTried: false};
const albumActions = {trigger: null, details: null, id: null};

function closeAlbumActions(restoreFocus = false) {
  const trigger = albumActions.trigger;
  $("#album-action-menu").hidden = true;
  albumActions.trigger = null; albumActions.details = null; albumActions.id = null;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openAlbumActions(trigger) {
  const same = albumActions.trigger === trigger;
  closeAlbumActions(); closeQueueActions();
  if (same || trigger.disabled || !live() || state.loading || state.screen !== "album"
      || albumView.loading || albumView.trash || saving || checking) return;
  albumActions.trigger = trigger; albumActions.details = state.details; albumActions.id = albumView.id;
  trigger.setAttribute("aria-expanded", "true");
  const menu = $("#album-action-menu"); menu.hidden = false;
  $("#album-action-lyrics").textContent = albumLyricsCheck?.running ? "Stop checking lyrics" : "Check album lyrics";
  $("#album-action-lyrics-import").hidden = state.connection.premium === false;
  const anchor = trigger.getBoundingClientRect(), size = menu.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  menu.style.left = `${Math.max(8, Math.min(anchor.right - size.width, width - size.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6 + size.height <= height - 8
    ? anchor.bottom + 6 : anchor.top - size.height - 6, height - size.height - 8))}px`;
  $("#album-action-lyrics").focus();
}

$("#album-action-lyrics").addEventListener("click", () => {
  const {trigger, details, id} = albumActions;
  closeAlbumActions(true);
  if (trigger?.isConnected && !trigger.disabled && details === state.details && id === albumView.id) checkAlbumLyrics();
});
$("#album-action-lyrics-import").addEventListener("click", () => {
  const {trigger, details, id} = albumActions;
  closeAlbumActions(true);
  if (trigger?.isConnected && !trigger.disabled && details === state.details && id === albumView.id) openAlbumLyricsImport();
});
$("#album-action-trash").addEventListener("click", () => {
  const {trigger, details, id} = albumActions;
  closeAlbumActions(true);
  if (trigger?.isConnected && !trigger.disabled && details === state.details && id === albumView.id) startAlbumTrash();
});
$("#album-action-menu").addEventListener("keydown", event => {
  if (event.key === "Escape" || event.key === "Tab") {
    closeAlbumActions(true);
    if (event.key === "Escape") event.preventDefault();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const items = [$("#album-action-lyrics"), $("#album-action-lyrics-import"), $("#album-action-trash")].filter(item => !item.hidden);
    const index = items.indexOf(document.activeElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  }
});
document.addEventListener("keydown", event => {
  const trigger = event.target.closest("[data-album-more]");
  if (trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault(); openAlbumActions(trigger);
  }
});
window.addEventListener("resize", () => closeAlbumActions());
window.addEventListener("scroll", () => closeAlbumActions(), true);

function cancelCoverClick() {
  clearTimeout(coverLightbox.timer); coverLightbox.timer = null;
}

function coverPreviewFor(target) {
  const node = target.closest("#album-page [data-cover-preview]");
  return node?.dataset.coverSrc ? {album: {artwork: node.dataset.coverSrc,
    name: node.dataset.coverName, artist: node.dataset.coverArtist}, focus: node.closest("button") || node} : null;
}

function coverClick(event, action, preview) {
  cancelCoverClick();
  // Keyboard activation and title clicks keep their immediate navigation.
  if (!preview || !event.detail) { action(); return; }
  if (event.detail > 1) return; // the following dblclick opens the cover instead
  const details = state.details, screen = state.screen;
  coverLightbox.timer = setTimeout(() => {
    coverLightbox.timer = null;
    if (details === state.details && screen === state.screen && !state.loading) action();
  }, 400);
}

function finishCoverLightbox() {
  if (!coverLightbox.open) return;
  coverLightbox.open = false;
  document.body.classList.remove("cover-lightbox-open");
  $("#cover-lightbox-image").removeAttribute("src");
  const focus = coverLightbox.focus;
  coverLightbox.focus = null; coverLightbox.fallback = "";
  (focus && focus.isConnected !== false ? focus : $("#home")).focus();
}

function closeCoverLightbox() {
  cancelCoverClick();
  if (!coverLightbox.open) return;
  $("#cover-lightbox").close(); finishCoverLightbox();
}

function openCoverLightbox(preview) {
  cancelCoverClick();
  if (!preview?.album.artwork || state.loading || coverLightbox.open || document.querySelector("dialog[open]")) return;
  const album = preview.album, image = $("#cover-lightbox-image");
  coverLightbox.open = true; coverLightbox.focus = preview.focus || document.activeElement;
  document.body.classList.add("cover-lightbox-open");
  coverLightbox.fallback = album.artwork; coverLightbox.fallbackTried = false;
  $("#cover-lightbox-title").textContent = album.name || "Album cover";
  $("#cover-lightbox-artist").textContent = album.artist || "";
  $("#cover-lightbox-status").textContent = "Loading cover…";
  image.alt = `Cover of ${album.name || "this album"}`; image.hidden = false;
  image.src = largeArtworkUrl(album.artwork);
  $("#cover-lightbox").showModal(); $("#cover-lightbox-close").focus();
}

$("#cover-lightbox-close").addEventListener("click", closeCoverLightbox);
$("#cover-lightbox").addEventListener("close", finishCoverLightbox);
$("#cover-lightbox").addEventListener("cancel", event => { event.preventDefault(); closeCoverLightbox(); });
$("#cover-lightbox").addEventListener("click", event => {
  if (event.target !== $("#cover-lightbox")) return;
  const rect = $("#cover-lightbox").getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeCoverLightbox();
});
$("#cover-lightbox-image").addEventListener("load", () => {
  if (coverLightbox.open) $("#cover-lightbox-status").textContent = "";
});
$("#cover-lightbox-image").addEventListener("error", () => {
  if (!coverLightbox.open) return;
  const image = $("#cover-lightbox-image");
  if (!coverLightbox.fallbackTried && image.getAttribute("src") !== coverLightbox.fallback) {
    coverLightbox.fallbackTried = true; image.src = coverLightbox.fallback; return;
  }
  image.hidden = true; $("#cover-lightbox-status").textContent = "This cover could not be loaded.";
});
document.addEventListener("dblclick", event => {
  const preview = coverPreviewFor(event.target);
  if (preview) { event.preventDefault(); openCoverLightbox(preview); }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && coverLightbox.open) { event.preventDefault(); closeCoverLightbox(); }
});

function trackDuration(seconds) {
  const value = Math.floor(Number(seconds));
  if (!Number.isFinite(value) || value <= 0) return "–";
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

// The library's file format, not a claim about the stream's bitrate or resolution.
function trackFormatLabel(track) {
  return track.format ? `<small class="track-format" title="File format">${escapeHtml(track.format)}</small>` : "";
}

function albumTrackFormats(tracks) {
  const counts = new Map();
  for (const track of tracks) if (track.format) counts.set(track.format, (counts.get(track.format) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const main = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : "";
  const known = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const label = main ? `${main}${ranked.length > 1 ? " · mixed formats" : ""}` : ranked.map(([name]) => name).join(" / ");
  return {main, label: label && `${label}${known < tracks.length ? " (known files)" : ""}`};
}

function albumTrackMetadata(album, track, formats) {
  const nameKey = value => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const people = track.performers?.length ? track.performers : [{id: track.artist_id || track.artistId, name: track.artist}];
  const seen = new Set(), extra = people.filter(person => {
    const name = nameKey(person.name);
    if (!name || albumArtistEntries(album).some(a => name === nameKey(a.name) || (Number(a.id) > 0 && String(person.id) === String(a.id))) || seen.has(name)) return false;
    seen.add(name); return true;
  });
  const credits = extra.length ? `<span>${performerLinks({...track, performers: extra})}</span>` : "";
  const composers = track.composers?.length ? `<span>Composer${track.composers.length > 1 ? "s" : ""}: ${escapeHtml(track.composers.join(", "))}</span>` : "";
  const otherCredits = (track.credits || []).filter(e => ![null, "", "artist", "band", "composer"].includes(e.type));
  const other = otherCredits.map(e => `<span>${escapeHtml(creditRoleLabels[e.type] || e.type)}: ${escapeHtml(e.name)}${e.phrase ? ` · ${escapeHtml(e.phrase)}` : ""}</span>`).join("");
  const tags = live() && typeof tagLinks === "function" ? tagLinks(track.tags) : "";
  const format = !albumView.trash && track.format && track.format !== formats.main
    ? `<span class="pill missing track-format-exception" title="File format: ${escapeHtml(track.format)}${formats.main ? ` · album mainly ${escapeHtml(formats.main)}` : " · mixed-format album"}">${escapeHtml(track.format)}</span>` : "";
  return credits || composers || other || tags || format ? `<div class="album-track-meta">${credits}${composers}${other}${tags}${format}</div>` : "";
}

function trackNumberControl(track, position, action, canPlay) {
  return `<button class="album-track-play" ${action} aria-label="Play ${escapeHtml(track.title)}" ${canPlay ? "" : "disabled"}><span class="track-position" aria-hidden="true">${escapeHtml(position)}</span><span class="track-play-icon" aria-hidden="true">▶</span><svg class="track-playing-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg></button>`;
}

function albumTrackNumber(track, albumId, canPlay) {
  return trackNumberControl(track, track.track || "–",
    `data-play="${escapeHtml(track.id)}" data-play-album-id="${escapeHtml(albumId)}"`, canPlay);
}

function resetAlbumView() {
  closeCoverLightbox(); closeAlbumActions();
  albumView.id = null; albumView.request += 1; albumView.loading = false; albumView.trash = null;
  if (state.screen === "album") showScreen("albums");
}

// A set's year, as the album lists show it: missing when one of the discs has none.
function albumYear(discs) {
  const years = discs.map(d => d.year || 0);
  return years.includes(0) ? 0 : Math.min(...years);
}

// Matching numbered positions and titles that appear more than once on one disc.
function twice(album) {
  const seen = new Set(), doubled = new Set();
  for (const key of album.tracks.map(duplicateTrackKey).filter(Boolean)) (seen.has(key) ? doubled : seen).add(key);
  return doubled;
}

function duplicateTrackBadge(track, titles, numbers) {
  if (titles.has(duplicateTrackKey(track))) return ' <span class="pill missing" title="This track number and title occur more than once on this disc. Compare the tracks before choosing a copy.">Duplicated</span>';
  if (numbers.has(duplicateTrackPosition(track))) return ' <span class="pill missing" title="This track number occurs more than once on this disc, with different titles. Compare the tracks before choosing a copy.">Duplicated</span>';
  return "";
}

// The discs of a set open as one album page, under the address of the first disc.
async function openAlbum(id, found = "") {
  const summary = state.albums.find(a => String(a.id) === String(id));
  if (!summary) return;
  const ids = shelfIds(id);
  if (albumView.id !== ids[0]) albumView.trash = null;
  albumView.id = ids[0]; albumView.found = String(found);
  const request = ++albumView.request, details = state.details;
  albumView.loading = true;
  showScreen("album");
  window.scrollTo?.({top: 0});
  $("#album-page").innerHTML = `<p class="empty" role="status"><span class="spinner"></span>Loading album tracks…</p>`;
  try {
    const albums = await albumDetails(ids);
    if (request !== albumView.request || details !== state.details || state.screen !== "album") return;
    if (albums.length !== ids.length) throw Error("This album is no longer in your library. Reload the library.");
    albumView.loading = false;
    renderAlbumView();
  } catch (error) {
    if (request !== albumView.request || details !== state.details || state.screen !== "album") return;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    $("#album-page").innerHTML = `<p class="error-box" role="alert">${escapeHtml(error.message)}</p><button class="button" data-album="${escapeHtml(id)}">Try again</button>`;
  } finally {
    if (request === albumView.request) {
      albumView.loading = false;
      if (typeof syncHistory === "function") syncHistory();
    }
  }
}

function renderAlbumView() {
  if (state.screen !== "album" || albumView.loading) return;
  if (!state.albums.some(a => String(a.id) === albumView.id)) { resetAlbumView(); return; }
  const ids = shelfIds(albumView.id), discs = ids.map(i => state.details.get(i));
  if (ids[0] !== albumView.id || !discs.every(Boolean)) { openAlbum(albumView.id); return; }
  const album = joinDiscs(discs), several = discs.length > 1, year = albumYear(discs);
  const informationFocus = typeof albumInformationFocus === "function" ? albumInformationFocus() : "";
  const formats = albumTrackFormats(album.tracks);
  const id = escapeHtml(album.id), canPlay = live() && album.tracks.length > 0;
  const total = album.tracks.length && album.tracks.every(t => Number(t.length) > 0)
    ? ` · ${trackDuration(album.tracks.reduce((sum, t) => sum + Number(t.length), 0))}` : "";
  const genres = [...new Map(album.tracks.flatMap(trackGenres).map(g => [g.toLocaleLowerCase(), g])).values()];
  const doubled = new Map(discs.map(d => [d, twice(d)]));
  const repeated = new Map(discs.map(d => [d, repeatedTrackPositions(d)]));
  const trashAdvice = albumView.trash ? trashSuggestion(discs) : null;
  closeAlbumActions();
  $("#breadcrumb").textContent = album.name;
  $("#album-page").innerHTML = `
    <div class="album-detail-header"><button type="button" class="album-cover-preview" data-cover-view aria-label="Enlarge cover of ${escapeHtml(album.name)}" ${album.artwork ? "" : "disabled"}>${cover(album, false, true)}</button><div class="album-detail-info">
      <h1>${escapeHtml(album.name)}</h1><div class="album-artist-links">${albumArtistLinks(album)}</div>
      <p class="muted album-detail-meta">${year ? `<button type="button" class="album-year-link" data-browse-kind="years" data-browse-key="${escapeHtml(year)}" data-browse-label="${escapeHtml(year)}" aria-label="Browse releases from ${escapeHtml(year)}">${escapeHtml(year)}</button>` : "Year unknown"} · ${album.tracks.length} tracks${several ? ` · ${discIcons(discs.length)}` : album.disc > 1 ? ` · Disc ${album.disc}` : ""}${total}</p>
      <div class="album-labels" aria-label="Genres and tags">${genres.map(g => `<button type="button" class="album-genre-chip" data-browse-kind="genres" data-browse-key="${escapeHtml(g.toLocaleLowerCase())}" data-browse-label="${escapeHtml(g)}" title="Genre: ${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("")}${typeof albumTagChips === "function" ? albumTagChips(album) : ""}</div>
      ${albumRatingControls(discs)}
      <div class="album-detail-actions"><button class="button primary" data-play-album data-play-album-id="${id}" ${canPlay ? "" : "disabled"}>▶ Play album</button>
        ${queueButton(album.id, null, false, true)}${playlistAlbumButton(album.id)}<button class="button" data-edit-album="${escapeHtml(ids.join(","))}">Edit</button>${live() ? `<button type="button" class="button album-more" data-album-more aria-label="More album actions" aria-haspopup="menu" aria-controls="album-action-menu" aria-expanded="false" ${albumView.trash || saving || checking ? "disabled" : ""}>⋯</button>` : ""}</div>
      ${live() ? "" : '<p class="muted">Connect iBroadcast to listen. You can edit this local preview.</p>'}</div></div>
    <section id="album-guide-notes" aria-label="Album background" hidden></section>
    <section id="album-information" class="album-information artist-biography" aria-label="TheAudioDB album information" hidden></section>
    <div class="tracks-heading"><h2>Tracks</h2><span class="muted track-list-summary">${album.tracks.length} ${album.tracks.length === 1 ? "track" : "tracks"}${total}${formats.label ? ` · ${escapeHtml(formats.label)}` : ""}${canPlay ? "" : " · Local preview"}</span></div>
    <div id="album-lyrics-check" class="lyrics-actions" hidden><span id="album-lyrics-status" class="muted" role="status" aria-live="polite"></span><button type="button" class="text-action" id="album-lyrics-stop" hidden>Stop checking</button></div>
    ${albumView.trash ? trashBar(discs) : ""}<table class="album-tracks album-tracklist ${albumView.trash ? "trash-mode" : ""}"><thead><tr><th class="track-number"><span class="track-number-label">#</span></th><th>Title</th><th class="track-time">Time</th><th class="track-heart" aria-label="Track actions"></th></tr></thead><tbody>
      ${discs.map((d, i) => (several ? `${i ? '<tr class="disc-gap" aria-hidden="true"><td colspan="4"></td></tr>' : ""}<tr class="disc-row"><td colspan="4"><span>Disc ${d.disc || "?"}</span><button class="text-action" data-edit-album="${escapeHtml(d.id)}">Edit disc ${d.disc || "?"}</button></td></tr>` : "") + d.tracks.map(t => `<tr data-row="${escapeHtml(t.id)}"${String(t.id) === albumView.found ? ' class="found"' : ""}><td class="track-number">${albumView.trash ? trashCheck(t) : ""}${albumTrackNumber(t, album.id, canPlay)}</td>
        <td><strong>${escapeHtml(t.title)}${duplicateTrackBadge(t, doubled.get(d), repeated.get(d))}</strong>${albumLyricsLabel(t)}${albumTrackMetadata(album, t, formats)}${trashAdvice ? trashTrackNote(t, trashAdvice) : ""}</td><td class="track-time">${trackDuration(t.length)}${albumView.trash ? trackFormatLabel(t) : ""}</td><td class="track-heart"><div class="track-row-actions">${typeof trackTagControls === "function" ? trackTagControls(album, t) : ""}${queueButton(album.id, t)}${heartButton(t)}</div></td></tr>`).join("")).join("")}
    </tbody></table>`;
  if (typeof syncHistory === "function") syncHistory();
  markPlaying();
  renderAlbumLyricsCheck();
  restoreAlbumLyrics();
  if (typeof loadGuideAlbumNotes === "function") loadGuideAlbumNotes();
  if (typeof renderAlbumInformation === "function") renderAlbumInformation(informationFocus);
}

document.addEventListener("click", event => {
  if (!event.detail && event.target.closest("[data-cover-view]")) openCoverLightbox(coverPreviewFor(event.target));
  const more = event.target.closest("[data-album-more]");
  if (more) { openAlbumActions(more); return; }
  if (!event.target.closest("#album-action-menu")) closeAlbumActions();
  const edit = event.target.closest("[data-edit-album]");
  if (edit) openEditor(edit.dataset.editAlbum.split(","));
});
$("#editor").addEventListener("close", renderAlbumView);
