"use strict";

// Browser history for the pages: every page gets its own address (#/artists, #/artist/<name>,
// #/albums, #/album/<id>, #/tracks, #/overview), so the browser's Back and Forward buttons work and
// "← Back" returns to the page you came from. Each history entry remembers that page's
// search, filter, sort and page number. Dialogs get no entry: Back never closes an editor.

const nav = {ready: false, restoring: false, pending: null};
const DIALOGS_WITH_DRAFTS = ["#editor", "#review", "#artwork", "#trash-review"];

function currentRoute() {
  if (state.screen === "album" && albumView.id) return `album/${encodeURIComponent(albumView.id)}`;
  if (["overview", "artists", "tracks"].includes(state.screen)) return state.screen;
  return state.artist ? `artist/${encodeURIComponent(state.artist)}` : "albums";
}

function parseRoute(hash) {
  const [kind, ...rest] = String(hash || "").replace(/^#\/?/, "").split("/");
  let value = "";
  try { value = decodeURIComponent(rest.join("/")); } catch { return null; }
  if (["artists", "albums", "tracks", "overview"].includes(kind)) return {screen: kind};
  if (kind === "artist" && value) return {screen: "albums", artist: value};
  if (kind === "album" && value) return {screen: "album", album: value};
  return null;
}

function routeLabel(hash) {
  const route = parseRoute(hash);
  if (!route) return "";
  if (route.album) return state.albums.find(a => String(a.id) === route.album)?.name || "the album";
  return route.artist || {artists: "Album artists", albums: "Albums", tracks: "Tracks", overview: "Overview"}[route.screen];
}

function viewState(index, from) {
  return {index, from, search: $("#search").value, filter: $("#filter").value, sort: $("#sort").value, page: state.page,
    artistsSearch: $("#artists-search").value, artistsSort: $("#artists-sort").value, artistsFilter: $("#artists-filter").value, artistsPage: artistBrowse.page,
    tracksSearch: $("#tracks-search").value, tracksPage: trackSearch.page};
}

// Called after every page change and render: a new page adds a history entry, the same page
// only updates the remembered search, filter and page number of its entry.
function syncHistory() {
  if (!nav.ready || nav.restoring) return;
  const hash = `#/${currentRoute()}`, entry = history.state || {};
  try {
    if (hash !== location.hash) history.pushState(viewState((entry.index || 0) + 1, routeLabel(location.hash)), "", hash);
    else {
      // Only when something changed: Safari refuses more than ~100 updates in a short time.
      const view = viewState(entry.index || 0, entry.from || "");
      if (JSON.stringify(view) !== JSON.stringify(entry)) history.replaceState(view, "", hash);
    }
  } catch { /* the page works without history; Back then leaves Tagcast */ }
  showArtistBack();
}

// On an artist's albums, a button back to where you came from (normally Album artists).
function showArtistBack() {
  const button = $("#artist-back");
  button.hidden = !(state.screen === "albums" && state.artist);
  button.textContent = `← Back to ${backLabel("Album artists")}`;
}
$("#artist-back").addEventListener("click", () => goBack("artists"));

function canGoBack() {
  return (history.state?.index || 0) > 0;
}

// The label of a "← Back" button: the page you came from, or where Back falls back to.
function backLabel(fallback) {
  return canGoBack() && history.state.from ? history.state.from : fallback;
}

function goBack(fallback) {
  if (canGoBack()) { history.back(); return; }
  if (fallback === "artists") showArtistBrowse();
  else { showScreen("albums"); render(); }
}

function showRoute(route, saved = {}) {
  if (route.screen === "artists") {
    if (saved.artistsSearch !== undefined) $("#artists-search").value = saved.artistsSearch;
    if (saved.artistsSort) $("#artists-sort").value = saved.artistsSort;
    if (saved.artistsFilter) $("#artists-filter").value = saved.artistsFilter;
    artistBrowse.page = saved.artistsPage || 0;
    showArtistBrowse();
  } else if (route.screen === "tracks") {
    if (saved.tracksSearch !== undefined) $("#tracks-search").value = saved.tracksSearch;
    showTracks(saved.tracksPage || 0);
  } else if (route.screen === "overview") {
    showScreen("overview");
  } else if (route.screen === "album" && state.albums.some(a => String(a.id) === route.album)) {
    openAlbum(route.album);
  } else {
    const artist = route.artist && state.albums.some(a => a.artist === route.artist) ? route.artist : null;
    if (artist !== state.artist) state.selected.clear();
    state.artist = artist;
    if (saved.search !== undefined) $("#search").value = saved.search;
    if (saved.filter) $("#filter").value = saved.filter;
    if (saved.sort) $("#sort").value = saved.sort;
    state.page = saved.page || 0;
    showScreen("albums"); render();
  }
}

window.addEventListener("popstate", event => {
  const route = parseRoute(location.hash);
  if (!route) return;
  if (DIALOGS_WITH_DRAFTS.some(id => $(id).open)) {
    // Keep the page under an open editor; Back works again once it is closed.
    nav.restoring = true;
    try { showRoute(parseRoute(`#/${currentRoute()}`) || {screen: "artists"}); } finally { nav.restoring = false; }
    history.pushState(viewState((event.state?.index || 0) + 1, routeLabel(location.hash)), "", `#/${currentRoute()}`);
    toast("Close the editor first, then go back.");
    return;
  }
  nav.restoring = true;
  try { showRoute(route, event.state || {}); } finally { nav.restoring = false; }
  syncHistory();
});

// The start page is Album artists. An address with a page that needs the library (an artist
// or an album) is opened once the library has loaded, unless you have moved on by then.
function restorePendingRoute() {
  const route = nav.pending;
  nav.pending = null;
  if (!route || canGoBack() || state.screen !== "artists") return;
  if (route.album && !state.albums.some(a => String(a.id) === route.album)) return;
  nav.restoring = true;
  try { showRoute(route); } finally { nav.restoring = false; }
  history.replaceState(viewState(0, ""), "", `#/${currentRoute()}`);
}

(() => {
  const route = parseRoute(location.hash);
  if (route && !route.artist && !route.album) showRoute(route);
  else { nav.pending = route; showScreen("artists"); renderArtistBrowse(); }
  nav.ready = true;
  history.replaceState(viewState(0, ""), "", `#/${currentRoute()}`);
})();
