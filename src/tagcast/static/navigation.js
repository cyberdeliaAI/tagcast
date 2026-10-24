"use strict";

// Browser history for the pages: every page gets its own address (#/artists, #/artist/<name>,
// #/albums, #/album/<id>, #/tracks, #/favourites, #/overview and the four browse groups), so Back and Forward work and
// Album breadcrumbs return to the browsing context you came from. Each history entry remembers that page's
// search, filter, sort and page number. Dialogs get no entry: Back never closes an editor.

const nav = {ready: false, restoring: false, pending: null, views: new Map(), details: null, scope: 0, scroll: null, crumbs: []};
const DIALOGS_WITH_DRAFTS = ["#editor", "#review", "#artwork", "#trash-review", "#cleanup", "#duplicate-cleanup", "#playlist-dialog", "#playlist-import", "#tag-dialog", "#lyrics-import"];

const SIDEBAR_ITEMS = [
  ["show-artists", "Album artists", true], ["all-albums", "Albums", true],
  ["show-track-artists", "Track artists"], ["show-composers", "Composers"],
  ["show-genres", "Genres"], ["show-tags", "Tags"], ["show-years", "Release year"], ["show-decades", "Decades"],
  ["show-tracks", "Tracks"], ["show-favourites", "Favourites"], ["show-playlists", "Playlists"],
  ["show-recently-played", "Recently played"],
  ["show-album-guide", "1001 Albums"], ["show-overview", "Overview"], ["show-history", "Change history", true],
];
const sidebarLayout = readSidebarLayout();

function readSidebarLayout() {
  const defaults = SIDEBAR_ITEMS.map(([id]) => id), optional = new Set(SIDEBAR_ITEMS.filter(i => !i[2]).map(i => i[0]));
  try {
    const saved = JSON.parse(localStorage.getItem("tagcast-sidebar") || "{}");
    const legacy = Array.isArray(saved?.order) && saved.order.includes("show-album-favourites");
    const order = Array.isArray(saved?.order) ? saved.order.map(id => id === "show-album-favourites" ? "show-favourites" : id).filter(id => defaults.includes(id)) : [];
    let hidden = Array.isArray(saved?.hidden) ? saved.hidden.filter(id => optional.has(id)) : [];
    // Keep the combined shortcut available if either of the old shortcuts was visible.
    if (legacy && !saved.hidden?.includes?.("show-album-favourites")) hidden = hidden.filter(id => id !== "show-favourites");
    return {order: [...new Set([...order, ...defaults])], hidden: [...new Set(hidden)]};
  } catch { return {order: defaults, hidden: []}; }
}

function applySidebarLayout() {
  const container = $("#workspace-nav");
  const buttons = sidebarLayout.order.map(id => {
    const button = $(`#${id}`);
    button.hidden = sidebarLayout.hidden.includes(id)
      || (id === "show-album-guide" && !albumGuide.enabled)
      || (id === "show-recently-played" && (!live() || !playReporting.enabled));
    return button;
  });
  if (buttons.some((button, index) => container.children[index] !== button)) {
    const focus = document.activeElement, scroll = container.scrollTop;
    // DOM order also controls keyboard navigation. Leave unchanged nodes in place
    // on routine status/settings updates, preserving focus and the sidebar scroll.
    for (const button of buttons) container.appendChild(button);
    if (container.contains?.(focus) && !focus.hidden) focus.focus({preventScroll:true});
    container.scrollTop = scroll;
  }
}

function saveSidebarLayout() {
  applySidebarLayout();
  try { localStorage.setItem("tagcast-sidebar", JSON.stringify(sidebarLayout)); }
  catch { toast("Sidebar changed for this tab. This browser could not save the preference."); }
}

function sidebarSettingsRows() {
  return sidebarLayout.order.map((id, index) => {
    const [, label, required] = SIDEBAR_ITEMS.find(item => item[0] === id);
    const note = required ? "Always available" : id === "show-album-guide" && !albumGuide.enabled ? "Enable 1001 Albums under Discovery to show it"
      : id === "show-recently-played" && !playReporting.enabled ? "Enable play reporting under Playback to show it" : "";
    return `<li class="sidebar-setting-row"><label><input type="checkbox" data-sidebar-item="${id}" ${sidebarLayout.hidden.includes(id) ? "" : "checked"} ${required ? "disabled" : ""}><span>${label}${note ? `<small>${note}</small>` : ""}</span></label><div><button type="button" class="button small" data-sidebar-move="${id}" data-direction="-1" aria-label="Move ${label} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="button small" data-sidebar-move="${id}" data-direction="1" aria-label="Move ${label} down" ${index === sidebarLayout.order.length - 1 ? "disabled" : ""}>↓</button></div></li>`;
  }).join("");
}

function sidebarSettingsPanel() {
  return `<section class="sidebar-layout-settings"><h3>Sidebar</h3><details><summary>Choose shortcuts and order</summary><p class="muted">Show or hide extra shortcuts and move items with the arrow buttons. Changes apply immediately and are remembered in this browser. Hiding a shortcut keeps its feature and your music available. Connection controls and Settings always stay visible.</p><ul id="sidebar-layout-list">${sidebarSettingsRows()}</ul><button type="button" class="button small" data-sidebar-reset>Restore default sidebar</button></details></section>`;
}

document.addEventListener("change", event => {
  const input = event.target.matches?.("[data-sidebar-item]") ? event.target : null;
  if (!input) return;
  const item = SIDEBAR_ITEMS.find(([id]) => id === input.dataset.sidebarItem);
  if (!item || item[2]) return;
  sidebarLayout.hidden = sidebarLayout.hidden.filter(id => id !== item[0]);
  if (!input.checked) sidebarLayout.hidden.push(item[0]);
  saveSidebarLayout();
});
document.addEventListener("click", event => {
  const move = event.target.closest("[data-sidebar-move]");
  if (move) {
    const index = sidebarLayout.order.indexOf(move.dataset.sidebarMove), delta = Number(move.dataset.direction);
    if (index < 0 || ![-1, 1].includes(delta) || !sidebarLayout.order[index + delta]) return;
    [sidebarLayout.order[index], sidebarLayout.order[index + delta]] = [sidebarLayout.order[index + delta], sidebarLayout.order[index]];
    saveSidebarLayout(); $("#sidebar-layout-list").innerHTML = sidebarSettingsRows();
    const focus = document.querySelector(`[data-sidebar-move="${move.dataset.sidebarMove}"][data-direction="${delta}"]`);
    if (focus && !focus.disabled) focus.focus();
    else document.querySelector(`[data-sidebar-move="${move.dataset.sidebarMove}"][data-direction="${-delta}"]`)?.focus();
  }
  if (event.target.closest("[data-sidebar-reset]")) {
    sidebarLayout.order = SIDEBAR_ITEMS.map(([id]) => id); sidebarLayout.hidden = [];
    saveSidebarLayout(); $("#sidebar-layout-list").innerHTML = sidebarSettingsRows();
    toast("Default sidebar restored.");
  }
});
applySidebarLayout();

// The mobile menu is a disclosure, not a page or a dialog. Desktop navigation
// stays visible through CSS; opening the menu never adds a history entry.
function setSidebarMenu(open) {
  $("#sidebar").classList.toggle("menu-open", open);
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
  $("#menu-toggle").setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
}

function closeSidebarMenu() {
  if (!$("#sidebar").classList.contains("menu-open")) return;
  setSidebarMenu(false);
  $("#menu-toggle").focus();
}

$("#menu-toggle").addEventListener("click", () => setSidebarMenu(!$("#sidebar").classList.contains("menu-open")));
$("#sidebar-menu").addEventListener("click", event => {
  if (event.target.closest("button")) closeSidebarMenu();
});
$("#home").addEventListener("click", closeSidebarMenu);
document.addEventListener("keydown", event => {
  if (!event.defaultPrevented && event.key === "Escape") closeSidebarMenu();
});

function currentRoute() {
  if (state.screen === "browse") return `${browseView.kind}${browseView.key === null ? "" : `/${encodeURIComponent(browseView.key)}`}`;
  if (state.screen === "playlists" && collectionsView.playlist) return `playlist/${encodeURIComponent(collectionsView.playlist)}`;
  if (state.screen === "album" && albumView.id) return `album/${encodeURIComponent(albumView.id)}`;
  if (["overview", "artists", "tracks", "favourites", "playlists", "album-favourites", "artist-favourites", "recently-played", "album-guide"].includes(state.screen)) return state.screen;
  return state.artist ? `artist/${encodeURIComponent(state.artist)}` : "albums";
}

function parseRoute(hash) {
  const [kind, ...rest] = String(hash || "").replace(/^#\/?/, "").split("/");
  let value = "";
  try { value = decodeURIComponent(rest.join("/")); } catch { return null; }
  if (Object.hasOwn(browseKinds, kind)) return {screen: "browse", kind, key: rest.length ? value : null};
  if (["artists", "albums", "tracks", "favourites", "playlists", "album-favourites", "artist-favourites", "recently-played", "overview", "album-guide"].includes(kind)) return {screen: kind};
  if (kind === "playlist" && /^\d+$/.test(value)) return {screen: "playlists", playlist: value};
  if (kind === "artist" && value) return {screen: "albums", artist: value};
  if (kind === "album" && value) return {screen: "album", album: value};
  return null;
}

function routeLabel(hash, saved = history.state) {
  const route = parseRoute(hash);
  if (!route) return "";
  if (route.screen === "album-guide") return "1001 Albums";
  if (route.screen === "browse") return route.key === null ? browseKinds[route.kind].label : saved?.browse?.label || browseKinds[route.kind].label;
  if (route.playlist) return saved?.label || (String(collectionsView.data?.id) === route.playlist ? collectionsView.data.name : "Playlist");
  if (route.album) return state.albums.find(a => String(a.id) === route.album)?.name || "the album";
  return route.artist || {artists: "Album artists", albums: "Albums", tracks: "Tracks", favourites: "Favourite tracks", playlists: "Playlists", "album-favourites": "Album favourites", "artist-favourites": "Favourite album artists", "recently-played": "Recently played", overview: "Overview"}[route.screen];
}

function viewState(index, from) {
  return {index, from, scrollY: nav.scroll?.hash === `#/${currentRoute()}` ? nav.scroll.top : Math.max(0, window.scrollY || 0),
    label: state.screen === "browse" && browseView.key !== null ? browseView.label : state.screen === "playlists" && collectionsView.playlist ? collectionsView.data?.name || "Playlist" : routeLabel(`#/${currentRoute()}`, {}),
    albumOrigin: state.screen === "album" ? history.state?.albumOrigin || [] : [], search: $("#search").value, filter: $("#filter").value, sort: $("#sort").value, page: state.page,
    albumsRandomIds: $("#sort").value === "random" ? albumOrder.ids : [], albumsLibrary: albumOrder.library,
    artistsSearch: $("#artists-search").value, artistsSort: $("#artists-sort").value, artistsFilter: $("#artists-filter").value, artistsPage: artistBrowse.page,
    artistsRandomNames: $("#artists-sort").value === "random" ? artistBrowse.randomNames : [], artistsLibrary: artistBrowse.library,
    tracksSearch: $("#tracks-search").value, tracksPage: trackSearch.page, favouritesSearch: $("#favourites-search").value, favouritesPage: favourites.page,
    collections: {query: collectionsView.query, offset: collectionsView.offset},
    favouriteArtists: {query: $("#favourite-artists-search").value, sort: $("#favourite-artists-sort").value, page: favouriteArtists.page},
    recentSearch: $("#recently-played-search").value, recentPage: recentlyPlayed.page,
    guide: {query: albumGuide.query, filter: albumGuide.filter, decade: albumGuide.decade, sort: albumGuide.sort, page: albumGuide.page},
    browse: {query: $("#browse-search").value, page: browseView.page, sort: browseView.sort, label: browseView.label, randomIds: browseView.randomIds}};
}

// Remember browsing context only within this loaded library.
function navigationScope() {
  if (nav.details === state.details) return;
  nav.details = state.details; nav.scope += 1; nav.views.clear(); nav.scroll = null; nav.crumbs = [];
}

function navigationSnapshot(hash, saved) {
  const {albumOrigin, ...view} = saved;
  return {hash, label: saved.label || routeLabel(hash, saved), index: saved.index, scope: nav.scope, saved: view};
}

function rememberNavigationScroll() {
  if (!nav.ready || nav.restoring || nav.scroll || !history.state) return;
  const entry = {...history.state, scrollY: Math.max(0, window.scrollY || 0)};
  try { history.replaceState(entry, "", location.hash); } catch { return; }
  if (parseRoute(location.hash)?.screen !== "album") nav.views.set(location.hash, navigationSnapshot(location.hash, entry));
}

function albumOrigin(hash, entry) {
  const source = parseRoute(hash);
  if (!source) return [];
  if (source.screen === "album") return (entry.albumOrigin || []).filter(item => item.scope === nav.scope);
  const parent = source.screen === "browse" && source.key !== null ? `#/${source.kind}`
    : source.artist ? "#/artists" : source.playlist ? "#/playlists" : null;
  const trail = parent ? [nav.views.get(parent) || {hash: parent, label: routeLabel(parent, {}), scope: nav.scope, saved: {}}] : [];
  trail.push(navigationSnapshot(hash, entry));
  return trail;
}

function restoreNavigationScroll() {
  const pending = nav.scroll;
  if (!pending || pending.hash !== location.hash) { nav.scroll = null; return; }
  // Run after rendering and page-opening scroll resets, including lazy server results.
  setTimeout(() => {
    if (nav.scroll !== pending || pending.hash !== location.hash || pending.scope !== nav.scope) return;
    const loading = state.loading || (state.screen === "album" && albumView.loading)
      || (state.screen === "browse" && (browseView.loading || !browseView.loaded && !browseView.error))
      || (state.screen === "tracks" && trackSearch.loading) || (state.screen === "favourites" && favourites.loading)
      || (state.screen === "recently-played" && recentlyPlayed.loading)
      || (state.screen === "album-guide" && albumGuide.loading) || (state.screen === "playlists" && collectionsView.loading);
    if (loading) return;
    window.scrollTo?.({top: pending.top}); nav.scroll = null;
  }, 0);
}

// Same-page renders update filters; only page changes add history entries.
function syncHistory() {
  syncSearchClearButtons();
  if (!nav.ready || nav.restoring) return;
  navigationScope();
  const hash = `#/${currentRoute()}`, entry = history.state || {};
  try {
    if (hash !== location.hash) {
      const origin = state.screen === "album" ? albumOrigin(location.hash, entry) : [];
      for (const [key, view] of nav.views) if (view.index > (entry.index || 0)) nav.views.delete(key);
      const view = viewState((entry.index || 0) + 1, routeLabel(location.hash, entry));
      view.albumOrigin = origin; view.scrollY = nav.scroll?.hash === hash ? nav.scroll.top : 0;
      history.pushState(view, "", hash);
    } else {
      // Safari refuses more than ~100 history updates in a short time.
      const view = viewState(entry.index || 0, entry.from || "");
      if (JSON.stringify(view) !== JSON.stringify(entry)) history.replaceState(view, "", hash);
    }
    if (state.screen !== "album") {
      nav.views.set(hash, navigationSnapshot(hash, history.state));
      if (nav.views.size > 100) nav.views.delete(nav.views.keys().next().value);
    }
  } catch { /* the page works without history; Back then leaves Tagcast */ }
  showArtistBack(); renderAlbumBreadcrumb(); restoreNavigationScroll();
}

function renderAlbumBreadcrumb() {
  if (state.screen !== "album") return;
  navigationScope();
  const origin = (history.state?.albumOrigin || []).filter(item => item.scope === nav.scope && parseRoute(item.hash));
  nav.crumbs = origin.length ? origin : [{hash: "#/albums", label: "Albums", scope: nav.scope, saved: {}}];
  const album = state.albums.find(a => String(a.id) === albumView.id);
  $("#breadcrumb").innerHTML = nav.crumbs.map((item, index) => `<button type="button" class="breadcrumb-link" data-album-crumb="${index}">${escapeHtml(item.label)}</button><span class="slash" aria-hidden="true">/</span>`).join("")
    + `<span aria-current="page">${escapeHtml(album?.name || "Album")}</span>`;
}

function followBreadcrumb(target) {
  if (!target || DIALOGS_WITH_DRAFTS.some(id => $(id).open)) return;
  navigationScope();
  if (target.scope !== nav.scope) return;
  const route = parseRoute(target.hash);
  if (!route) return;
  const known = nav.views.get(target.hash), current = history.state?.index || 0;
  if (Number.isInteger(target.index) && target.index < current && known?.index === target.index) {
    history.go(target.index - current); return;
  }
  rememberNavigationScroll();
  nav.scroll = {hash: target.hash, top: target.saved?.scrollY || 0, scope: nav.scope};
  nav.restoring = true;
  try { showRoute(route, target.saved || {}); } finally { nav.restoring = false; }
  syncHistory();
}

document.addEventListener("click", event => {
  const crumb = event.target.closest("[data-album-crumb]");
  if (crumb && state.screen === "album") followBreadcrumb(nav.crumbs[Number(crumb.dataset.albumCrumb)]);
  if (event.target.closest("[data-breadcrumb-root]")) {
    navigationScope();
    followBreadcrumb(nav.views.get("#/artists") || {hash: "#/artists", scope: nav.scope, saved: {}});
  }
});

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
  if (fallback === "playlists") { showCollections("playlists"); return; }
  if (fallback === "artists") showArtistBrowse();
  else { showScreen("albums"); render(); }
}

function showRoute(route, saved = {}) {
  if (route.screen === "album-guide") {
    showAlbumGuide(saved.guide || {});
  } else if (route.screen === "browse") {
    showBrowse(route.kind, route.key, saved.browse || {});
  } else if (route.screen === "artists") {
    if (saved.artistsSearch !== undefined) $("#artists-search").value = saved.artistsSearch;
    if (saved.artistsSort) $("#artists-sort").value = saved.artistsSort;
    if (saved.artistsFilter) $("#artists-filter").value = saved.artistsFilter;
    if (saved.artistsLibrary === artistBrowse.library && Array.isArray(saved.artistsRandomNames)) {
      artistBrowse.randomNames = [...new Set(saved.artistsRandomNames.filter(name => typeof name === "string"))];
    }
    artistBrowse.page = saved.artistsPage || 0;
    showArtistBrowse();
  } else if (route.screen === "tracks") {
    if (saved.tracksSearch !== undefined) $("#tracks-search").value = saved.tracksSearch;
    showTracks(saved.tracksPage || 0);
  } else if (route.screen === "favourites") {
    if (saved.favouritesSearch !== undefined) $("#favourites-search").value = saved.favouritesSearch;
    showFavourites(saved.favouritesPage || 0);
  } else if (route.screen === "artist-favourites") {
    $("#favourite-artists-search").value = saved.favouriteArtists?.query || "";
    $("#favourite-artists-sort").value = ["za", "rating_high", "rating_low"].includes(saved.favouriteArtists?.sort) ? saved.favouriteArtists.sort : "az";
    showFavouriteArtists(saved.favouriteArtists?.page || 0);
  } else if (route.screen === "recently-played") {
    if (saved.recentSearch !== undefined) $("#recently-played-search").value = saved.recentSearch;
    showRecentlyPlayed(saved.recentPage || 0);
  } else if (["playlists", "album-favourites"].includes(route.screen)) {
    showCollections(route.screen, route.playlist || null, saved.collections || {});
  } else if (route.screen === "overview") {
    showScreen("overview");
  } else if (route.screen === "album" && state.albums.some(a => String(a.id) === route.album)) {
    openAlbum(route.album);
  } else {
    const artist = route.artist && state.albums.some(a => albumHasArtist(a, route.artist)) ? route.artist : null;
    if (artist !== state.artist) state.selected.clear();
    state.artist = artist;
    if (saved.search !== undefined) $("#search").value = saved.search;
    if (saved.filter) $("#filter").value = saved.filter;
    if (saved.sort) $("#sort").value = saved.sort;
    if (saved.albumsLibrary === albumOrder.library && Array.isArray(saved.albumsRandomIds)) {
      albumOrder.ids = [...new Set(saved.albumsRandomIds.filter(id => typeof id === "string"))];
    }
    state.page = saved.page || 0;
    showScreen("albums"); render();
  }
}

window.addEventListener("popstate", event => {
  closeSidebarMenu();
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
  navigationScope();
  nav.scroll = {hash: location.hash, top: event.state?.scrollY || 0, scope: nav.scope};
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
  nav.ready = true; navigationScope();
  history.replaceState(viewState(0, ""), "", `#/${currentRoute()}`);
})();
