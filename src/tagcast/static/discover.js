"use strict";

// Explicit local reads only. Never populate album details, a queue or a provider cache here.
const artistDiscover = {albums: null, details: null, session: null, entries: new Map(), request: 0};

function resetArtistDiscover() {
  artistDiscover.request += 1;
  artistDiscover.entries.clear();
  artistDiscover.albums = state.albums; artistDiscover.details = state.details;
  artistDiscover.session = state.connection.playback_session;
  $("#artist-discover").hidden = true;
  $("#artist-discover-cards").innerHTML = "";
}

function discoverSelection() {
  if (!live() || state.loading || state.screen !== "albums" || !state.artist) return null;
  const selection = artistProfileSelection(state.artist);
  return selection?.artists.length <= 100 && selection.session ? selection : null;
}

function renderArtistDiscover() {
  if (artistDiscover.albums !== state.albums || artistDiscover.details !== state.details
    || artistDiscover.session !== state.connection.playback_session) resetArtistDiscover();
  const selection = discoverSelection(), section = $("#artist-discover");
  section.hidden = !selection;
  if (!selection) return;
  const entry = artistDiscover.entries.get(selection.name), opened = entry?.open === true;
  const button = $("#artist-discover-toggle"), results = $("#artist-discover-results");
  button.textContent = TagcastI18n.text("discover.action");
  button.setAttribute("aria-expanded", String(opened));
  results.hidden = !opened;
  $("#artist-discover-heading").textContent = TagcastI18n.text("discover.heading", {artist: selection.name});
  $("#artist-discover-refresh").textContent = TagcastI18n.text("discover.refresh");
  $("#artist-discover-refresh").disabled = Boolean(entry?.loading);
  $("#artist-discover-intro").textContent = TagcastI18n.text("discover.intro");
  const message = entry?.loading ? TagcastI18n.text("discover.loading") : entry?.error ? TagcastI18n.errorText(entry.error)
    : entry?.data?.status === "missing_genres" ? TagcastI18n.text("discover.missingGenres")
    : entry?.data?.status === "no_matches" ? TagcastI18n.text("discover.noMatches") : "";
  setActionStatus("#artist-discover-status", message, Boolean(entry?.loading));
  $("#artist-discover-status").classList.toggle("error-text", Boolean(entry?.error));
  if (!opened) return;
  const shelf = new Map(albumShelf().map(a => [String(a.id), a]));
  const cards = (entry?.data?.albums || []).map(row => {
    const album = shelf.get(String(row.id));
    if (!album) return "";
    return `<article class="discover-card"><button type="button" class="row-open discover-cover" data-album="${escapeHtml(album.id)}" aria-label="${TagcastI18n.html("library.open.album", {name: album.name})}">${thumb(album)}</button><div class="discover-card-text"><button type="button" class="row-open row-title" data-album="${escapeHtml(album.id)}">${escapeHtml(album.name)}</button><div>${albumArtistLinks(album)}</div><p class="muted">${TagcastI18n.html("discover.sharedGenres", {genres: row.shared_genres.join(" · ")})}</p></div>${row.playable ? albumCardActions(album) : `<small class="muted">${TagcastI18n.html("discover.playbackUnavailable")}</small>`}</article>`;
  }).join("");
  const list = $("#artist-discover-cards");
  // Routine renders do not replace focused Play/Queue buttons or restart image loading.
  if (list.innerHTML !== cards) keepFocusWhile(list, () => { list.innerHTML = cards; });
}

// Leaving a page retires pending work, but retains completed, bounded results for Back.
function leaveArtistDiscover() {
  for (const [name, entry] of artistDiscover.entries) {
    if (entry.loading) artistDiscover.entries.delete(name);
  }
  artistDiscover.request += 1;
}

async function loadArtistDiscover() {
  renderArtistDiscover();
  const selection = discoverSelection();
  if (!selection) return;
  if (artistDiscover.entries.get(selection.name)?.loading) return;
  const entry = {open: true, loading: true, data: null, error: null};
  const albums = state.albums, details = state.details, request = ++artistDiscover.request;
  artistDiscover.entries.set(selection.name, entry);
  while (artistDiscover.entries.size > 12) artistDiscover.entries.delete(artistDiscover.entries.keys().next().value);
  const current = () => request === artistDiscover.request && albums === state.albums && details === state.details
    && state.connection.playback_session === selection.session && state.screen === "albums"
    && state.artist === selection.name && live() && !state.loading
    && artistDiscover.entries.get(selection.name) === entry;
  renderArtistDiscover();
  try {
    const data = await api("/api/discover", selection);
    if (!current()) return;
    if (data.artist !== selection.name || data.session !== selection.session || !Array.isArray(data.albums)
      || data.albums.length > 6 || !["ready", "missing_genres", "no_matches"].includes(data.status)
      || data.albums.some(row => !row || typeof row.id !== "string" || typeof row.playable !== "boolean"
        || !Array.isArray(row.shared_genres) || row.shared_genres.length > 3
        || row.shared_genres.some(g => typeof g !== "string" || g.length > 200))) {
      throw TagcastI18n.failure("discover.invalid_response");
    }
    entry.data = data;
  } catch (error) {
    if (current()) entry.error = error;
  } finally {
    if (current()) { entry.loading = false; renderArtistDiscover(); }
  }
}

$("#artist-discover-toggle").addEventListener("click", () => {
  const selection = discoverSelection();
  if (!selection) return;
  const entry = artistDiscover.entries.get(selection.name);
  if (entry?.open) {
    entry.open = false;
    if (entry.loading) { leaveArtistDiscover(); artistDiscover.entries.delete(selection.name); }
    renderArtistDiscover();
  } else if (entry) { entry.open = true; renderArtistDiscover(); }
  else loadArtistDiscover();
});
$("#artist-discover-refresh").addEventListener("click", loadArtistDiscover);

// Translation only repaints the visible, already-read results; no request or state change.
TagcastI18n.subscribe(() => {
  if (state.screen === "albums" && state.artist) renderArtistDiscover();
});
