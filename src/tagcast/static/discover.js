"use strict";

// Discovery starts only on a click, using the saved preference rather than a page selector.
const artistDiscover = {albums: null, details: null, session: null, entries: new Map(), request: 0, settings: null};

function discoverSource() { return lookup.discoverLastfm ? "lastfm" : "local"; }

function applyDiscoverSettings(data) {
  const enabled = data.discover_lastfm !== false;
  if (enabled === lookup.discoverLastfm) return;
  lookup.discoverLastfm = enabled;
  resetArtistDiscover();
  if (state.screen === "albums" && state.artist) renderArtistDiscover();
}

function resetArtistDiscover() {
  artistDiscover.request += 1;
  artistDiscover.entries.clear();
  artistDiscover.albums = state.albums; artistDiscover.details = state.details;
  artistDiscover.session = state.connection.playback_session;
  artistDiscover.settings = lookup.settingsRevision;
  $("#artist-discover").hidden = true;
  $("#artist-discover").open = false;
  $("#artist-discover-cards").innerHTML = "";
}

function discoverSelection() {
  if (!live() || state.loading || state.screen !== "albums" || !state.artist) return null;
  const selection = artistProfileSelection(state.artist);
  return selection?.artists.length <= 100 && selection.session ? selection : null;
}

function discoverEntryKey(selection) { return JSON.stringify([discoverSource(), selection.name]); }
function discoverExpired(entry) { return entry?.expires !== undefined && Date.now() >= entry.expires; }

function renderArtistDiscover() {
  if (artistDiscover.albums !== state.albums || artistDiscover.details !== state.details
    || artistDiscover.session !== state.connection.playback_session || artistDiscover.settings !== lookup.settingsRevision) resetArtistDiscover();
  const selection = discoverSelection(), section = $("#artist-discover");
  section.hidden = !selection;
  if (!selection) return;
  const key = discoverEntryKey(selection), entry = artistDiscover.entries.get(key), opened = entry?.open === true;
  const online = discoverSource() === "lastfm";
  $("#artist-discover-setup").hidden = !online || lookup.sources.some(s => s.name === "lastfm" && s.enabled);
  const button = $("#artist-discover-toggle"), results = $("#artist-discover-results");
  $("#artist-discover-label").textContent = TagcastI18n.text("discover.action");
  $("#artist-discover-source").textContent = entry?.data?.source === "local" || !online
    ? TagcastI18n.text("discover.yourLibrary") : "Last.fm";
  // Restoring a completed disclosure never starts a provider request.
  section.open = opened;
  button.setAttribute("aria-expanded", String(opened));
  results.hidden = !opened;
  $("#artist-discover-refresh").textContent = TagcastI18n.text("discover.refresh");
  $("#artist-discover-refresh").disabled = Boolean(entry?.loading);
  $("#artist-discover-intro").textContent = TagcastI18n.text(entry?.data?.source === "lastfm" ? "discover.introLastfm" : "discover.intro", {artist: selection.name});
  $("#artist-discover-fallback").hidden = !entry?.data?.fallback;
  $("#artist-discover-attribution").hidden = entry?.data?.source !== "lastfm";
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
    return `<article class="discover-card"><button type="button" class="row-open discover-cover" data-album="${escapeHtml(album.id)}" aria-label="${TagcastI18n.html("library.open.album", {name: album.name})}">${thumb(album)}</button><div class="discover-card-text"><button type="button" class="row-open row-title" data-album="${escapeHtml(album.id)}">${escapeHtml(album.name)}</button><div>${albumArtistLinks(album)}</div><p class="muted">${entry.data.source === "lastfm" ? `<a href="${escapeHtml(row.lastfm_url)}" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("discover.relatedArtist", {artist: row.related_artist})}</a>` : TagcastI18n.html("discover.sharedGenres", {genres: row.shared_genres.join(" · ")})}</p></div>${row.playable ? albumCardActions(album) : `<small class="muted">${TagcastI18n.html("discover.playbackUnavailable")}</small>`}</article>`;
  }).join("");
  const list = $("#artist-discover-cards");
  // Routine renders do not replace focused Play/Queue buttons or restart image loading.
  if (list.innerHTML !== cards) keepFocusWhile(list, () => { list.innerHTML = cards; });
}

// Leaving a page retires pending work, but retains completed, bounded results for Back.
function leaveArtistDiscover() {
  for (const [name, entry] of artistDiscover.entries) {
    if (entry.loading || discoverExpired(entry)) artistDiscover.entries.delete(name);
  }
  artistDiscover.request += 1;
}

async function loadArtistDiscover() {
  renderArtistDiscover();
  const selection = discoverSelection();
  if (!selection) return;
  const key = discoverEntryKey(selection), source = discoverSource(), settings = lookup.settingsRevision;
  if (artistDiscover.entries.get(key)?.loading) return;
  const entry = {open: true, loading: true, data: null, error: null};
  const albums = state.albums, details = state.details, request = ++artistDiscover.request;
  artistDiscover.entries.set(key, entry);
  while (artistDiscover.entries.size > 12) artistDiscover.entries.delete(artistDiscover.entries.keys().next().value);
  const current = () => request === artistDiscover.request && albums === state.albums && details === state.details
    && state.connection.playback_session === selection.session && state.screen === "albums"
    && state.artist === selection.name && live() && !state.loading
    && artistDiscover.entries.get(key) === entry && discoverSource() === source && lookup.settingsRevision === settings;
  renderArtistDiscover();
  try {
    const data = await api("/api/discover", {...selection, source});
    if (!current()) return;
    if (data.artist !== selection.name || data.session !== selection.session || !Array.isArray(data.albums)
      || (data.requested_source || "local") !== source
      || (data.source && !["local", "lastfm"].includes(data.source))
      || (source === "local" && data.source === "lastfm")
      || (source === "lastfm" && (typeof data.fallback !== "boolean" || !data.source
        || data.fallback !== (data.source === "local")))
      || (source === "lastfm" && (!Number.isInteger(data.expires_in) || data.expires_in < 0 || data.expires_in > 21600))
      || data.albums.length > 6 || !["ready", "missing_genres", "no_matches"].includes(data.status)
      || data.albums.some(row => !row || typeof row.id !== "string" || typeof row.playable !== "boolean"
        || !Array.isArray(row.shared_genres) || row.shared_genres.length > 3
        || row.shared_genres.some(g => typeof g !== "string" || g.length > 200)
        || (data.source === "lastfm" && (typeof row.related_artist !== "string" || row.related_artist.length > 200
          || row.lastfm_url !== "https://www.last.fm/music/" + encodeURIComponent(row.related_artist).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()))))) {
      throw TagcastI18n.failure("discover.invalid_response");
    }
    entry.data = data;
    if (source === "lastfm") entry.expires = Date.now() + data.expires_in * 1000;
  } catch (error) {
    if (current()) entry.error = error;
  } finally {
    if (current()) { entry.loading = false; renderArtistDiscover(); }
  }
}

$("#artist-discover-toggle").addEventListener("click", event => {
  // Native summary keyboard activation also dispatches click. Handle the state
  // here, not on toggle: programmatic restoration must remain read-only.
  event.preventDefault();
  const selection = discoverSelection();
  if (!selection) return;
  const key = discoverEntryKey(selection), entry = artistDiscover.entries.get(key);
  if (entry?.open) {
    entry.open = false;
    if (entry.loading || discoverExpired(entry)) { leaveArtistDiscover(); artistDiscover.entries.delete(key); }
    renderArtistDiscover();
  } else if (entry && !discoverExpired(entry)) { entry.open = true; renderArtistDiscover(); }
  else loadArtistDiscover();
});
$("#artist-discover-refresh").addEventListener("click", loadArtistDiscover);

// Translation only repaints the visible, already-read results; no request or state change.
TagcastI18n.subscribe(() => {
  if (state.screen === "albums" && state.artist) renderArtistDiscover();
});
