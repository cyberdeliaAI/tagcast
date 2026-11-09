"use strict";

// Browser history for the pages: every page gets its own address (#/artists, #/artist/<name>,
// #/albums, #/album/<id>, #/tracks, #/favourites, #/overview and the four browse groups), so Back and Forward work and
// Album breadcrumbs return to the browsing context you came from. Each history entry remembers that page's
// search, filter, sort and page number. Dialogs get no entry: Back never closes an editor.

const nav = {ready: false, restoring: false, pending: null, views: new Map(), details: null, scope: 0, scroll: null, crumbs: []};
const DIALOGS_WITH_DRAFTS = ["#editor", "#review", "#artwork", "#trash-review", "#cleanup", "#duplicate-cleanup", "#playlist-dialog", "#playlist-import", "#tag-dialog", "#lyrics-import", "#album-merge", "#album-split"];

// [id, interface text key (null: a product name shown as is), always visible, hidden by default]
const SIDEBAR_ITEMS = [
  ["show-artists", "nav.sidebar.albumArtists", true], ["all-albums", "nav.sidebar.albums", true],
  ["show-track-artists", "nav.sidebar.trackArtists"], ["show-composers", "nav.sidebar.composers"],
  ["show-genres", "nav.sidebar.genres"], ["show-tags", "nav.sidebar.tags"], ["show-years", "nav.sidebar.releaseYear"], ["show-decades", "nav.sidebar.decades"],
  ["show-upload-folders", "nav.sidebar.uploadFolders", false, true], ["show-uploaded", "nav.sidebar.dateUploaded", false, true],
  ["show-tracks", "nav.sidebar.tracks"], ["show-favourites", "nav.sidebar.favourites"], ["show-playlists", "nav.sidebar.playlists"],
  ["show-recently-played", "nav.sidebar.recentlyPlayed"], ["show-downloads", "nav.sidebar.downloads"], ["show-uploads", "nav.sidebar.uploads"],
  ["show-album-guide", null], ["show-overview", "nav.sidebar.overview"], ["show-history", "nav.sidebar.changeHistory", true],
];
const sidebarItemLabel = key => key ? TagcastI18n.text(key) : "1001 Albums";
const sidebarLayout = readSidebarLayout();

function defaultHiddenSidebarItems() {
  return SIDEBAR_ITEMS.filter(item => item[3]).map(([id]) => id);
}

function readSidebarLayout() {
  const defaults = SIDEBAR_ITEMS.map(([id]) => id), optional = new Set(SIDEBAR_ITEMS.filter(i => !i[2]).map(i => i[0]));
  try {
    const saved = JSON.parse(localStorage.getItem("tagcast-sidebar") || "{}");
    const legacy = Array.isArray(saved?.order) && saved.order.includes("show-album-favourites");
    const order = Array.isArray(saved?.order) ? saved.order.map(id => id === "show-album-favourites" ? "show-favourites" : id).filter(id => defaults.includes(id)) : [];
    let hidden = Array.isArray(saved?.hidden) ? saved.hidden.filter(id => optional.has(id)) : [];
    // New optional upload shortcuts stay off for both new and existing profiles.
    hidden.push(...defaultHiddenSidebarItems().filter(id => !order.includes(id)));
    // Keep the combined shortcut available if either of the old shortcuts was visible.
    if (legacy && !saved.hidden?.includes?.("show-album-favourites")) hidden = hidden.filter(id => id !== "show-favourites");
    return {order: [...new Set([...order, ...defaults])], hidden: [...new Set(hidden)]};
  } catch { return {order: defaults, hidden: defaultHiddenSidebarItems()}; }
}

// Only describe native scroll geometry; never move the viewport or a focused shortcut.
function updateSidebarOverflow() {
  const container = $("#workspace-nav"), more = [];
  if (container.scrollTop > 1) more.push("start");
  if (container.scrollTop + container.clientHeight < container.scrollHeight - 1) more.push("end");
  if (more.length) container.setAttribute("data-more", more.join(" "));
  else container.removeAttribute("data-more");
}

function applySidebarLayout() {
  const container = $("#workspace-nav");
  const buttons = sidebarLayout.order.map(id => {
    const button = $(`#${id}`);
    button.hidden = sidebarLayout.hidden.includes(id)
      || (id === "show-uploads" && (typeof musicUploadsView === "undefined" || !musicUploadsView.enabled))
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
  updateSidebarOverflow();
}

function saveSidebarLayout() {
  applySidebarLayout();
  try { localStorage.setItem("tagcast-sidebar", JSON.stringify(sidebarLayout)); }
  catch { toast(TagcastI18n.text("nav.sidebarSettings.notSaved")); }
}

function sidebarSettingsRows() {
  return sidebarLayout.order.map((id, index) => {
    const [, key, required] = SIDEBAR_ITEMS.find(item => item[0] === id), label = sidebarItemLabel(key);
    const note = required ? "nav.sidebarSettings.alwaysAvailable" : id === "show-album-guide" && !albumGuide.enabled ? "nav.sidebarSettings.enableGuide"
      : id === "show-uploads" && (typeof musicUploadsView === "undefined" || !musicUploadsView.enabled) ? "nav.sidebarSettings.enableUploads"
      : id === "show-recently-played" && !playReporting.enabled ? "nav.sidebarSettings.enableRecentlyPlayed" : "";
    return `<li class="sidebar-setting-row"><label><input type="checkbox" data-sidebar-item="${id}" ${sidebarLayout.hidden.includes(id) ? "" : "checked"} ${required ? "disabled" : ""}><span>${escapeHtml(label)}${note ? `<small>${TagcastI18n.html(note)}</small>` : ""}</span></label><div><button type="button" class="button small" data-sidebar-move="${id}" data-direction="-1" aria-label="${TagcastI18n.html("nav.sidebarSettings.moveUp", {label})}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="button small" data-sidebar-move="${id}" data-direction="1" aria-label="${TagcastI18n.html("nav.sidebarSettings.moveDown", {label})}" ${index === sidebarLayout.order.length - 1 ? "disabled" : ""}>↓</button></div></li>`;
  }).join("");
}

function sidebarSettingsPanel() {
  return `<section class="sidebar-layout-settings" data-settings-category="interface" data-sidebar-settings><h3>${TagcastI18n.html("nav.sidebarSettings.heading")}</h3><p class="muted">${TagcastI18n.html("nav.sidebarSettings.intro")}</p><ul id="sidebar-layout-list">${sidebarSettingsRows()}</ul><button type="button" class="button small" data-sidebar-reset>${TagcastI18n.html("nav.sidebarSettings.restore")}</button></section>`;
}

// After a language change: rebuild only this immediate-preference section of Settings, in place,
// keeping its visibility and the focused control. The server settings form is never touched.
function renderSidebarSettings() {
  const section = document.querySelector("[data-sidebar-settings]");
  if (!section?.isConnected || typeof section.insertAdjacentHTML !== "function") return;
  const focused = section.contains?.(document.activeElement) ? document.activeElement : null;
  const target = focused?.dataset?.sidebarMove ? `[data-sidebar-move="${focused.dataset.sidebarMove}"][data-direction="${focused.dataset.direction}"]`
    : focused?.dataset?.sidebarItem ? `[data-sidebar-item="${focused.dataset.sidebarItem}"]` : focused?.matches?.("[data-sidebar-reset]") ? "[data-sidebar-reset]" : "";
  section.insertAdjacentHTML("afterend", sidebarSettingsPanel());
  const fresh = section.nextElementSibling;
  if (fresh) fresh.hidden = section.hidden;
  section.remove();
  if (target) fresh?.querySelector(target)?.focus();
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
    sidebarLayout.order = SIDEBAR_ITEMS.map(([id]) => id); sidebarLayout.hidden = defaultHiddenSidebarItems();
    saveSidebarLayout(); $("#sidebar-layout-list").innerHTML = sidebarSettingsRows();
    toast(TagcastI18n.text("nav.sidebarSettings.restored"));
  }
});
applySidebarLayout();
$("#workspace-nav").addEventListener("scroll", updateSidebarOverflow, {passive: true});
const sidebarScrollObserver = typeof ResizeObserver === "function" ? new ResizeObserver(updateSidebarOverflow) : null;
sidebarScrollObserver?.observe($("#workspace-nav"));

// The mobile menu is a disclosure, not a page or a dialog. Desktop navigation
// stays visible through CSS; opening the menu never adds a history entry.
function setSidebarMenu(open) {
  $("#sidebar").classList.toggle("menu-open", open);
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
  $("#menu-toggle").setAttribute("aria-label", TagcastI18n.text(open ? "nav.menu.close" : "nav.menu.open"));
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
  if (state.screen === "settings") return `settings/${settingsView.category}`;
  if (state.screen === "browse") return `${browseView.kind}${browseView.key === null ? "" : `/${encodeURIComponent(browseView.key)}`}`;
  if (state.screen === "playlists" && collectionsView.playlist) return `playlist/${encodeURIComponent(collectionsView.playlist)}`;
  if (state.screen === "album" && albumView.id) return `album/${encodeURIComponent(albumView.id)}`;
  if (["now-playing", "uploads", "downloads", "overview", "artists", "tracks", "favourites", "playlists", "album-favourites", "artist-favourites", "recently-played", "album-guide"].includes(state.screen)) return state.screen;
  return state.artist ? `artist/${encodeURIComponent(state.artist)}` : "albums";
}

function parseRoute(hash) {
  const [kind, ...rest] = String(hash || "").replace(/^#\/?/, "").split("/");
  let value = "";
  try { value = decodeURIComponent(rest.join("/")); } catch { return null; }
  if (kind === "settings") return {screen: "settings", category: Object.hasOwn(SETTINGS_CATEGORIES, value) ? value : "interface"};
  if (Object.hasOwn(browseKinds, kind)) return {screen: "browse", kind, key: rest.length ? value : null};
  if (["now-playing", "uploads", "downloads", "artists", "albums", "tracks", "favourites", "playlists", "album-favourites", "artist-favourites", "recently-played", "overview", "album-guide"].includes(kind)) return {screen: kind};
  if (kind === "playlist" && /^\d+$/.test(value)) return {screen: "playlists", playlist: value};
  if (kind === "artist" && value) return {screen: "albums", artist: value};
  if (kind === "album" && value) return {screen: "album", album: value};
  return null;
}

// Page names for breadcrumbs and Back buttons, in the current interface language. History entries
// keep a copy for pages named by library data (an artist, album, playlist or browse group); fixed
// page names are looked up again whenever they are shown, so they follow a language change.
const ROUTE_LABELS = {"now-playing": "player.nowPlaying.heading", artists: "nav.sidebar.albumArtists", albums: "nav.sidebar.albums", tracks: "nav.sidebar.tracks",
  favourites: "nav.route.favouriteTracks", playlists: "nav.sidebar.playlists", "album-favourites": "nav.route.albumFavourites",
  "artist-favourites": "nav.route.favouriteArtists", "recently-played": "nav.sidebar.recentlyPlayed", overview: "nav.sidebar.overview",
  downloads: "nav.sidebar.downloads", uploads: "nav.sidebar.uploads"};

function routeLabel(hash, saved = history.state) {
  const route = parseRoute(hash);
  if (!route) return "";
  if (route.screen === "settings") return TagcastI18n.text("nav.route.settings");
  if (route.screen === "album-guide") return "1001 Albums";
  if (route.screen === "browse") return route.key === null ? browseKinds[route.kind].label : saved?.browse?.label || browseKinds[route.kind].label;
  if (route.playlist) return saved?.label || (String(collectionsView.data?.id) === route.playlist ? collectionsView.data.name : TagcastI18n.text("nav.route.playlist"));
  if (route.album) return state.albums.find(a => String(a.id) === route.album)?.name || TagcastI18n.text("nav.route.theAlbum");
  return route.artist || (ROUTE_LABELS[route.screen] ? TagcastI18n.text(ROUTE_LABELS[route.screen]) : undefined);
}

// True for pages whose name is interface text rather than library data.
function fixedRoute(hash) {
  const route = parseRoute(hash);
  return Boolean(route) && !route.playlist && !route.album && !route.artist && !(route.screen === "browse" && route.key !== null);
}

function viewState(index, from, fromHash = "") {
  return {index, from, fromHash, scrollY: nav.scroll?.hash === `#/${currentRoute()}` ? nav.scroll.top : Math.max(0, window.scrollY || 0),
    label: state.screen === "browse" && browseView.key !== null ? browseView.label : state.screen === "playlists" && collectionsView.playlist ? collectionsView.data?.name || TagcastI18n.text("nav.route.playlist") : routeLabel(`#/${currentRoute()}`, {}),
    albumOrigin: state.screen === "album" ? history.state?.albumOrigin || [] : [], search: $("#search").value, filter: $("#filter").value, sort: $("#sort").value, page: state.page,
    albumsContinuousCount: albumContinuous.count, artistsContinuousCount: artistContinuous.count,
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
      const view = viewState((entry.index || 0) + 1, routeLabel(location.hash, entry), location.hash);
      view.albumOrigin = origin; view.scrollY = nav.scroll?.hash === hash ? nav.scroll.top : 0;
      history.pushState(view, "", hash);
    } else {
      // Safari refuses more than ~100 history updates in a short time.
      const view = viewState(entry.index || 0, entry.from || "", entry.fromHash || "");
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
  nav.crumbs = origin.length ? origin : [{hash: "#/albums", label: TagcastI18n.text("nav.sidebar.albums"), scope: nav.scope, saved: {}}];
  const album = state.albums.find(a => String(a.id) === albumView.id);
  // Fixed page names are shown in the current language; library names come from the entry.
  const label = item => fixedRoute(item.hash) ? routeLabel(item.hash, item.saved || {}) || item.label : item.label;
  $("#breadcrumb").innerHTML = nav.crumbs.map((item, index) => `<button type="button" class="breadcrumb-link" data-album-crumb="${index}">${escapeHtml(label(item))}</button><span class="slash" aria-hidden="true">/</span>`).join("")
    + `<span aria-current="page">${album?.name ? escapeHtml(album.name) : TagcastI18n.html("nav.breadcrumb.album")}</span>`;
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
  button.textContent = TagcastI18n.text("nav.back", {page: backLabel(TagcastI18n.text("nav.sidebar.albumArtists"))});
}
$("#artist-back").addEventListener("click", () => goBack("artists"));

function canGoBack() {
  return (history.state?.index || 0) > 0;
}

// The label of a "← Back" button: the page you came from, or where Back falls back to.
function backLabel(fallback) {
  if (!canGoBack() || !history.state.from) return fallback;
  const hash = history.state.fromHash;
  return hash && fixedRoute(hash) ? routeLabel(hash, {}) || history.state.from : history.state.from;
}

function goBack(fallback) {
  if (canGoBack()) { history.back(); return; }
  if (fallback === "playlists") { showCollections("playlists"); return; }
  if (fallback === "artists") showArtistBrowse();
  else { showScreen("albums"); render(); }
}

function showRoute(route, saved = {}) {
  if (route.screen === "settings") {
    showSettings(route.category, false);
  } else if (route.screen === "album-guide") {
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
    artistContinuous.restore(saved.artistsContinuousCount);
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
  } else if (["downloads", "uploads"].includes(route.screen)) {
    showScreen(route.screen);
  } else if (route.screen === "now-playing") {
    showScreen("now-playing");
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
    albumContinuous.restore(saved.albumsContinuousCount);
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
    history.pushState(viewState((event.state?.index || 0) + 1, routeLabel(location.hash), location.hash), "", `#/${currentRoute()}`);
    toast(TagcastI18n.text("nav.history.closeEditorFirst"));
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

// A language change rewrites the menu button, the Sidebar settings section and the Back and
// breadcrumb labels from memory. Each page's own script re-renders its visible content.
TagcastI18n.subscribe(() => {
  updateSidebarOverflow();
  if (!nav.ready) return;
  $("#menu-toggle").setAttribute("aria-label", TagcastI18n.text($("#sidebar").classList.contains("menu-open") ? "nav.menu.close" : "nav.menu.open"));
  renderSidebarSettings();
  showArtistBack();
  renderAlbumBreadcrumb();
});

(() => {
  const route = parseRoute(location.hash);
  if (route && !route.artist && !route.album) showRoute(route);
  else { nav.pending = route; showScreen("artists"); renderArtistBrowse(); }
  nav.ready = true; navigationScope();
  history.replaceState(viewState(0, ""), "", `#/${currentRoute()}`);
})();
