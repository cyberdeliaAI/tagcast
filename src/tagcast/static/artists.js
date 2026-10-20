"use strict";

// Album artists come from compact album summaries; opening this view loads no tracks.
const artistBrowse = {page: 0, pageSize: storedPageSize("tagcast-artists-per-page") || 24, randomNames: [], library: 0};
const artistProfile = {enabled: false, revision: 0, serverRevision: null, entries: new Map(), favourite: null, rating: null};
const favouriteArtists = {page: 0, pageSize: storedPageSize("tagcast-favourite-artists-per-page") || 24};
let artistBrowseTimer, artistBiographyRetryTimer;

function resetArtistBrowse() {
  clearTimeout(artistBrowseTimer);
  clearTimeout(artistBiographyRetryTimer);
  artistBrowse.page = 0; artistBrowse.randomNames = []; artistBrowse.library += 1;
  favouriteArtists.page = 0;
  if (artistProfile.rating?.pending) collectionsView.busy = false;
  artistProfile.revision += 1; artistProfile.entries.clear(); artistProfile.favourite = null; artistProfile.rating = null;
  $("#artist-biography").hidden = true;
  $("#artist-rating").hidden = true;
}

const favouriteArtistGroup = group => group.ids.length > 0 && group.ids.every(id => state.artistFavourites.has(id));

function artistProfileSelection(name) {
  const ids = [...new Set(state.albums.flatMap(albumArtistEntries).filter(a => a.name === name && Number(a.id) > 0)
    .map(a => String(a.id)))].sort((a, b) => Number(a) - Number(b));
  return ids.length ? {artists: ids, name, session: state.connection.playback_session} : null;
}

function applyArtistSettings(data) {
  const enabled = data.artist_biographies === true;
  if (enabled !== artistProfile.enabled || data.artist_biographies_revision !== artistProfile.serverRevision) {
    artistProfile.revision += 1; artistProfile.entries.clear();
  }
  artistProfile.serverRevision = data.artist_biographies_revision;
  artistProfile.enabled = enabled;
  renderArtistProfile();
}

function renderArtistProfile() {
  clearTimeout(artistBiographyRetryTimer);
  const box = $("#artist-biography"), status = $("#artist-favourite-status");
  const selection = live() && !state.loading && state.artist ? artistProfileSelection(state.artist) : null;
  status.hidden = true;
  $("#artist-rating").hidden = !selection || state.screen !== "albums";
  if (!selection || state.screen !== "albums") { box.hidden = true; return; }
  renderArtistRating(selection);
  const update = artistProfile.favourite?.name === state.artist ? artistProfile.favourite : null;
  const favourite = update?.pending ? update.value : selection.artists.every(id => state.artistFavourites.has(id));
  const title = $("#page-title"), titleHtml = `${escapeHtml(state.artist)} <button type="button" class="artist-favourite ${favourite ? "is-selected" : ""}" data-artist-favourite="${escapeHtml(state.artist)}" aria-label="${favourite ? "Remove artist favourite" : "Favourite artist"}" aria-pressed="${favourite}" aria-busy="${Boolean(update?.pending)}" title="Artist favourite · saved locally for your account" ${update?.pending || state.artistFavouriteError ? "disabled" : ""}>${heartIcon}</button>`;
  // Background biography results must not replace an unchanged, focused heart.
  if (title.artistProfileHtml !== titleHtml || !title.querySelector("[data-artist-favourite]")) {
    title.innerHTML = titleHtml; title.artistProfileHtml = titleHtml;
  }
  const message = state.artistFavouriteError || (update?.pending ? "Saving artist favourite locally…" : update?.error || "");
  status.hidden = !message; status.textContent = message;
  status.className = state.artistFavouriteError || update?.error ? "error-text" : "muted";
  box.hidden = !artistProfile.enabled;
  if (!artistProfile.enabled) return;
  const key = JSON.stringify([selection.artists, selection.name]);
  let entry = artistProfile.entries.get(key);
  if (!entry) {
    entry = {data: null, loading: true, error: ""}; artistProfile.entries.set(key, entry);
    while (artistProfile.entries.size > 100) artistProfile.entries.delete(artistProfile.entries.keys().next().value);
    loadArtistBiography(selection, key, entry);
  } else if (!entry.loading && !entry.error && entry.data?.expires_at <= Date.now() / 1000
      && Date.now() - entry.checkedAt >= 60000) {
    entry.loading = true; loadArtistBiography(selection, key, entry);
  }
  const opened = entry.open ?? (box.dataset.biographyKey === key && box.querySelector("details")?.open);
  const focused = document.activeElement;
  const focusSelector = focused?.matches?.("#artist-biography summary") ? "summary"
    : focused?.matches?.("#artist-biography [data-artist-biography-retry]") ? "[data-artist-biography-retry]" : "";
  box.dataset.biographyKey = key;
  const data = entry.data;
  const wait = Math.max(0, Math.ceil(((entry.retryAt || 0) - Date.now()) / 1000));
  const retryTime = wait ? new Date(entry.retryAt).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit", second: "2-digit"}) : "";
  if (entry.error && wait) {
    const revision = artistProfile.revision;
    artistBiographyRetryTimer = setTimeout(() => {
      if (artistProfile.revision === revision && artistProfile.entries.get(key) === entry
          && artistProfile.enabled && live() && selection.session === state.connection.playback_session
          && state.screen === "albums" && state.artist === selection.name) renderArtistProfile();
    }, wait * 1000);
  }
  const note = entry.error ? `<p class="error-text" role="status">${escapeHtml(entry.error)} <button type="button" class="text-action" data-artist-biography-retry${wait ? " disabled" : ""}>${wait ? `Try again at ${escapeHtml(retryTime)}` : "Try again"}</button></p>`
    : entry.loading ? '<p class="muted" role="status">Loading artist biography…</p>' : "";
  if (data?.status === "ready" && data.biography) {
    const url = /^https:\/\/www\.theaudiodb\.com\/artist\/\d+$/.test(data.url || "") ? data.url : "https://www.theaudiodb.com/";
    box.innerHTML = `<details ${opened ? "open" : ""}><summary>About this artist <span class="muted">TheAudioDB</span></summary><div class="artist-biography-text">${String(data.biography).split(/\n+/).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join("")}</div><p class="artist-biography-source">Biography: <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">TheAudioDB ↗</a> · English · Saved on this computer</p>${note}</details>`;
  } else {
    const missing = data?.reason === "missing_name" ? "Add an artist name to look up a biography."
      : data?.status === "ambiguous" ? "More than one artist matches this name on TheAudioDB; no biography was chosen."
      : data?.status === "missing" || data?.status === "unavailable" ? "No English biography found on TheAudioDB." : "";
    box.innerHTML = `${missing ? `<p class="muted">${escapeHtml(missing)}</p>` : ""}${note}`;
    if (!box.innerHTML) box.hidden = true;
  }
  if (focusSelector) box.querySelector(focusSelector)?.focus();
}

function nativeArtistRatings(selection) {
  const ratings = new Map(state.albums.flatMap(albumArtistEntries).map(a => [String(a.id), a.rating || 0]));
  return selection.artists.map(id => ratings.get(id) || 0);
}

function renderArtistRating(selection) {
  const box = $("#artist-rating"), values = nativeArtistRatings(selection), update = artistProfile.rating;
  const current = update?.details === state.details && update.session === state.connection.playback_session
    && update.name === selection.name ? update : null;
  const rating = current?.pending ? current.value : Math.min(...values);
  const disabled = state.loading || collectionsView.busy || saving || checking;
  const html = `<small class="muted">iBroadcast rating</small>${[1, 2, 3, 4, 5].map(n => `<button type="button" class="album-rating-choice ${n <= rating ? "is-selected" : ""}" data-artist-rating="${n}" aria-label="Rate artist ${n} out of 5" aria-pressed="${n <= rating}" ${disabled ? "disabled" : ""}>${n <= rating ? "★" : "☆"}</button>`).join("")}${(current?.pending ? rating > 0 : values.some(n => n > 0)) ? `<button type="button" class="text-action" data-artist-rating="0" ${disabled ? "disabled" : ""}>Clear</button>` : ""}${new Set(values).size > 1 && !current?.pending ? '<small class="muted">Different artist ratings</small>' : ""}${current ? `<small role="status" class="${current.error ? "error-text" : "muted"}">${escapeHtml(current.message)}</small>` : ""}`;
  box.setAttribute("aria-busy", String(Boolean(current?.pending)));
  if (box.ratingHtml !== html) { box.innerHTML = html; box.ratingHtml = html; }
}

async function rateArtist(rating) {
  if (!live() || state.loading || state.screen !== "albums" || !state.artist || collectionsView.busy || saving || checking) return;
  if (document.querySelector("dialog[open]")) { toast("Close the open dialog first."); return; }
  const selection = artistProfileSelection(state.artist);
  if (!selection) return;
  const focused = document.activeElement?.getAttribute?.("data-artist-rating") === String(rating);
  const before = nativeArtistRatings(selection), details = state.details;
  const update = {name: selection.name, details, session: selection.session, value: rating, pending: true, error: false, message: "Saving artist rating…"};
  const current = () => live() && details === state.details && selection.session === state.connection.playback_session;
  artistProfile.rating = update; collectionsView.busy = true; renderArtistProfile();
  try {
    const response = await api("/api/artist-rating", {...selection, before, rating});
    if (!current()) return;
    update.message = "Artist rating sent · checking iBroadcast…"; renderArtistProfile();
    const job = await collectionJob(response, current);
    if (!current()) return;
    const confirmed = new Map((job.results || []).map(r => [String(r.id), Number(r.rating) || 0]));
    for (const album of [...state.albums, ...state.details.values()]) {
      if (confirmed.has(String(album.artist_id))) album.artist_rating = confirmed.get(String(album.artist_id));
      for (const artist of album.album_artists || []) if (confirmed.has(String(artist.id))) artist.rating = confirmed.get(String(artist.id));
    }
    if (response.error || !selection.artists.every(id => job.results?.some(r => String(r.id) === id && r.status === "saved" && Number(r.rating) === rating))) throw Error(response.error || "The artist rating was not confirmed. Reload before trying again.");
    update.message = "Artist rating saved and confirmed in iBroadcast."; toast(update.message);
  } catch (error) { if (current()) { update.error = true; update.message = error.message; toast(error.message); } }
  finally {
    update.pending = false;
    if (artistProfile.rating === update) collectionsView.busy = false;
    if (current()) {
      const restoreFocus = focused && (document.activeElement === document.body || $("#artist-rating").contains?.(document.activeElement));
      renderArtistProfile(); renderArtistBrowse(); renderFavouriteArtists();
      if (restoreFocus && state.screen === "albums" && state.artist === selection.name) {
        (document.querySelector(`#artist-rating [data-artist-rating="${rating}"]`) || document.querySelector('#artist-rating [data-artist-rating="1"]'))?.focus();
      }
    }
  }
}

async function loadArtistBiography(selection, key, entry) {
  const details = state.details, revision = artistProfile.revision;
  entry.checkedAt = Date.now();
  const current = () => live() && !state.loading && details === state.details && selection.session === state.connection.playback_session
    && revision === artistProfile.revision && artistProfile.enabled && artistProfile.entries.get(key) === entry;
  const visible = () => current() && state.screen === "albums" && state.artist === selection.name;
  try {
    const cached = await api("/api/artist-biography", selection);
    if (!current()) return;
    if (!cached.enabled) { applyArtistSettings({artist_biographies: false}); return; }
    entry.data = cached;
    if (visible()) renderArtistProfile();
    if (cached.needs_lookup && visible()) {
      const data = await api("/api/artist-biography", {...selection, lookup: true});
      if (!current()) return;
      if (!data.enabled) { applyArtistSettings({artist_biographies: false}); return; }
      entry.data = data;
    }
  } catch (error) {
    if (current()) {
      entry.error = error.message;
      const wait = Number(error.data?.retry_after);
      entry.retryAt = Number.isFinite(wait) && wait > 0 ? Date.now() + Math.min(wait, 60) * 1000 : 0;
    }
  }
  finally {
    entry.loading = false;
    if (current()) {
      // A cache-only read completed after leaving. Fetch only if this page is visited again.
      if (entry.data?.needs_lookup && !entry.error && !visible()) artistProfile.entries.delete(key);
      if (visible()) renderArtistProfile();
    } else if (artistProfile.entries.get(key) === entry) {
      // Save/tag read-back can replace only the metadata Map, without resetting this cache.
      // Retire its stale request and read fresh data only for the still-visible same group.
      artistProfile.entries.delete(key);
      const selected = artistProfileSelection(selection.name);
      if (live() && !state.loading && revision === artistProfile.revision && artistProfile.enabled
          && selection.session === state.connection.playback_session && state.screen === "albums"
          && state.artist === selection.name && selected?.artists.join(",") === selection.artists.join(",")) renderArtistProfile();
    }
  }
}

async function toggleArtistFavourite(name) {
  if (!live() || state.loading || name !== state.artist || artistProfile.favourite?.pending || state.artistFavouriteError || saving || checking) return;
  if (document.querySelector("dialog[open]")) { toast("Close the open dialog first."); return; }
  const selection = artistProfileSelection(name);
  if (!selection) return;
  const generation = artistBrowse.library, before = selection.artists.every(id => state.artistFavourites.has(id));
  const focused = document.activeElement?.getAttribute?.("data-artist-favourite") === name;
  const update = {name, pending: true, value: !before, error: ""};
  // Local hearts use native IDs: a metadata-only refresh must not discard a confirmed write.
  const current = () => live() && !state.loading && generation === artistBrowse.library
    && selection.session === state.connection.playback_session && artistProfile.favourite === update;
  artistProfile.favourite = update; renderArtistProfile();
  try {
    const data = await api("/api/artist-favourite", {...selection, before, favourite: !before});
    if (!current()) return;
    if (!selection.artists.every(id => data.results?.some(r => r.id === id && r.favourite === !before))) throw Error("The local artist favourite was not confirmed. Reload before trying again.");
    for (const id of selection.artists) { if (before) state.artistFavourites.delete(id); else state.artistFavourites.add(id); }
    toast(before ? "Artist favourite removed locally." : "Artist favourite saved locally.");
  } catch (error) { if (current()) { update.error = error.message; toast(error.message); } }
  finally {
    update.pending = false;
    if (current()) {
      renderArtistProfile(); renderArtistBrowse(); renderFavouriteArtists(); renderFavouriteHub();
      if (focused && state.screen === "albums" && state.artist === name) $("#page-title [data-artist-favourite]")?.focus();
    }
  }
}

// Album artists without an image, like the albums filter "Artist without image".
const noArtistImage = ([name, group]) => !group.image && name !== "Various Artists";

function randomArtistGroups(groups) {
  const byName = new Map(groups), names = artistBrowse.randomNames.filter(name => byName.has(name));
  const known = new Set(names), added = groups.map(([name]) => name).filter(name => !known.has(name));
  for (let i = added.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [added[i], added[j]] = [added[j], added[i]];
  }
  // Shuffle once before filtering/paging; metadata edits keep the remaining artists in place.
  artistBrowse.randomNames = [...names, ...added];
  return artistBrowse.randomNames.map(name => [name, byName.get(name)]);
}

function filteredArtistGroups(all = artistGroups()) {
  const query = $("#artists-search").value.toLocaleLowerCase().trim(), filter = $("#artists-filter").value;
  const ordered = $("#artists-sort").value === "random" ? randomArtistGroups(all) : all;
  const groups = ordered.filter(entry => entry[0].toLocaleLowerCase().includes(query)
    && (filter !== "no_image" || noArtistImage(entry)) && (filter !== "favourites" || favouriteArtistGroup(entry[1])));
  return $("#artists-sort").value === "random" ? groups : orderArtistGroups(groups, $("#artists-sort").value);
}

function orderArtistGroups(groups, sort) {
  return groups.sort((a, b) => (sort === "rating_high" ? compareRating(a[1].rating, b[1].rating)
    : sort === "rating_low" ? compareRating(a[1].rating, b[1].rating, false) : 0)
    || (sort === "za" ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0])));
}

function artistCard([name, group]) {
  const image = group.image ? `<img src="${escapeHtml(group.image.replace(/-150$/, "-300"))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<button class="artist-card" data-browse-artist="${escapeHtml(name)}" aria-label="Open albums by ${escapeHtml(name)}">
    <span class="artist-card-photo">${image}<span>${escapeHtml(initials(name))}</span></span>
    <strong>${escapeHtml(name)}${favouriteArtistGroup(group) ? ` <span class="artist-card-favourite" aria-label="Favourite artist">${heartIcon}</span>` : ""}</strong><span class="artist-card-count">${group.count.toLocaleString("en")} ${group.count === 1 ? "album" : "albums"}</span></button>`;
}

function renderFavouriteArtists() {
  if (state.screen !== "artist-favourites") return;
  renderFavouriteHub();
  const query = $("#favourite-artists-search").value.toLocaleLowerCase().trim();
  const groups = artistGroups().filter(([name, group]) => favouriteArtistGroup(group) && name.toLocaleLowerCase().includes(query));
  orderArtistGroups(groups, $("#favourite-artists-sort").value);
  const size = favouriteArtists.pageSize, max = Math.max(0, Math.ceil(groups.length / size) - 1);
  favouriteArtists.page = Math.max(0, Math.min(favouriteArtists.page, max));
  $("#favourite-artists-per-page").value = String(size);
  $("#favourite-artists-results").textContent = live() && !state.loading && !state.artistFavouriteError
    ? `${groups.length.toLocaleString("en")} ${groups.length === 1 ? "album artist" : "album artists"}` : "";
  $("#favourite-artists-grid").innerHTML = !live() ? '<div class="empty">Connect iBroadcast to see your favourite album artists.</div>'
    : state.loading ? '<div class="empty" role="status"><span class="spinner"></span>Loading favourite album artists…</div>'
    : state.artistFavouriteError ? `<p class="error-box" role="alert">${escapeHtml(state.artistFavouriteError)}</p>`
    : groups.slice(favouriteArtists.page * size, (favouriteArtists.page + 1) * size).map(artistCard).join("")
      || '<div class="empty">No favourite album artists match. Open an album artist and use the heart beside their name to add one.</div>';
  $("#favourite-artists-pagination").innerHTML = live() && !state.loading && !state.artistFavouriteError && max > 0
    ? `<button class="button small" data-favourite-artist-page="-1" ${favouriteArtists.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${favouriteArtists.page + 1} of ${(max + 1).toLocaleString("en")}</span><button class="button small" data-favourite-artist-page="1" ${favouriteArtists.page === max ? "disabled" : ""}>Next →</button>` : "";
  if (typeof syncHistory === "function") syncHistory();
}

function showFavouriteArtists(page = favouriteArtists.page) {
  favouriteArtists.page = page; showScreen("artist-favourites"); renderFavouriteArtists(); window.scrollTo?.({top: 0});
}

$("#favourite-artists-search").addEventListener("input", () => { favouriteArtists.page = 0; renderFavouriteArtists(); });
$("#favourite-artists-sort").addEventListener("change", () => { favouriteArtists.page = 0; renderFavouriteArtists(); });
$("#favourite-artists-per-page").addEventListener("change", event => {
  const size = Number(event.target.value);
  if (![24, 50, 100, 200].includes(size)) return;
  favouriteArtists.page = Math.floor(favouriteArtists.page * favouriteArtists.pageSize / size); favouriteArtists.pageSize = size;
  rememberPageSize("tagcast-favourite-artists-per-page", size); renderFavouriteArtists();
});

function updateArtistSearchClear() {
  $("#artists-search-clear").hidden = !$("#artists-search").value;
}

function renderArtistBrowse() {
  if (state.screen !== "artists") return;
  updateArtistSearchClear();
  const all = artistGroups();
  syncBrowseChoices("artists", [
    {value: "all", label: "All album artists", count: all.length},
    {value: "no_image", label: "Without image", count: all.filter(noArtistImage).length},
    {value: "favourites", label: "Favourite artists", count: all.filter(([, group]) => favouriteArtistGroup(group)).length,
      disabled: !live() || Boolean(state.artistFavouriteError)},
  ], artistSortLabels, "az");
  const groups = filteredArtistGroups(all), size = artistBrowse.pageSize;
  const maxPage = Math.max(0, Math.ceil(groups.length / size) - 1);
  artistBrowse.page = Math.max(0, Math.min(artistBrowse.page, maxPage));
  $("#artists-per-page").value = String(size);
  $("#artist-favourites-error").hidden = !state.artistFavouriteError;
  $("#artist-favourites-error").textContent = state.artistFavouriteError;
  $("#artists-results").textContent = `${groups.length.toLocaleString("en")} ${groups.length === 1 ? "album artist" : "album artists"}`;
  $("#artists-grid").innerHTML = groups.slice(artistBrowse.page * size, (artistBrowse.page + 1) * size).map(artistCard).join("") || (state.loading ? '<div class="empty" role="status"><span class="spinner"></span>Loading album artists…</div>'
    : '<div class="empty">No album artists match your search.</div>');
  $("#artists-pagination").innerHTML = maxPage > 0 ? `<button class="button small" data-artist-page="-1" ${artistBrowse.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${artistBrowse.page + 1} of ${(maxPage + 1).toLocaleString("en")}</span><button class="button small" data-artist-page="1" ${artistBrowse.page === maxPage ? "disabled" : ""}>Next →</button>` : "";
  if (typeof syncHistory === "function") syncHistory();
}

function showArtistBrowse() {
  showScreen("artists");
  renderArtistBrowse();
  window.scrollTo?.({top: 0});
}

$("#show-artists").addEventListener("click", showArtistBrowse);
$("#artists-search-clear").addEventListener("click", () => {
  clearTimeout(artistBrowseTimer);
  $("#artists-search").value = ""; artistBrowse.page = 0;
  renderArtistBrowse();
  $("#artists-search").focus();
});
$("#artists-search").addEventListener("input", () => {
  updateArtistSearchClear();
  clearTimeout(artistBrowseTimer);
  artistBrowseTimer = setTimeout(() => { artistBrowse.page = 0; renderArtistBrowse(); }, 150);
});
$("#artists-sort").addEventListener("change", () => {
  artistBrowse.randomNames = []; artistBrowse.page = 0; renderArtistBrowse();
});
$("#artists-filter").addEventListener("change", () => { artistBrowse.page = 0; renderArtistBrowse(); });
$("#artists-per-page").addEventListener("change", event => {
  const size = Number(event.target.value);
  artistBrowse.page = Math.floor(artistBrowse.page * artistBrowse.pageSize / size); artistBrowse.pageSize = size;
  rememberPageSize("tagcast-artists-per-page", size); renderArtistBrowse();
});
document.addEventListener("toggle", event => {
  if (!event.target.matches?.("#artist-biography details")) return;
  const entry = artistProfile.entries.get($("#artist-biography").dataset.biographyKey);
  if (entry) entry.open = event.target.open;
}, true);
document.addEventListener("click", event => {
  const artistRating = event.target.closest("[data-artist-rating]");
  if (artistRating) { rateArtist(Number(artistRating.dataset.artistRating)); return; }
  const favouritePage = event.target.closest("[data-favourite-artist-page]");
  if (favouritePage && state.screen === "artist-favourites") {
    favouriteArtists.page += Number(favouritePage.dataset.favouriteArtistPage); renderFavouriteArtists(); return;
  }
  const favourite = event.target.closest("[data-artist-favourite]");
  if (favourite) { toggleArtistFavourite(favourite.dataset.artistFavourite); return; }
  if (event.target.closest("[data-artist-biography-retry]")) {
    const selection = state.artist && artistProfileSelection(state.artist);
    const key = selection && JSON.stringify([selection.artists, selection.name]);
    const entry = artistProfile.entries.get(key);
    if (selection && !entry?.loading && !(entry?.retryAt > Date.now())) {
      if (entry) {
        entry.loading = true; entry.error = ""; entry.retryAt = 0;
        loadArtistBiography(selection, key, entry);
      }
      renderArtistProfile();
    }
    return;
  }
  const artist = event.target.closest("[data-browse-artist]");
  if (artist) {
    $("#filter").value = "all";
    setArtist(artist.dataset.browseArtist);
    window.scrollTo?.({top: 0});
    return;
  }
  const page = event.target.closest("[data-artist-page]");
  if (page) {
    artistBrowse.page += Number(page.dataset.artistPage);
    renderArtistBrowse();
    window.scrollTo?.({top: 0});
  }
});
