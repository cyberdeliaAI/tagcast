"use strict";

// Overview: your iBroadcast account, the collection in numbers, metadata health (each
// row opens the matching album or album artist filter) and what you play most.

const overview = {data: null, loading: false, error: null};
// Display numbers only: English keeps 1,234, other languages use their own separators.
const fmt = n => TagcastI18n.number(Number(n || 0));

function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = Number(n || 0);
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i += 1; }
  const whole = v >= 100 || i === 0, digits = whole ? 0 : 1;
  return `${TagcastI18n.number(whole ? Math.round(v) : v, {useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits})} ${units[i]}`;
}

function duration(seconds) {
  const days = seconds / 86400;
  if (days >= 2) return TagcastI18n.html("overview.duration.days", {count: Math.round(days)});
  return TagcastI18n.html("overview.duration.hours", {count: Math.round(seconds / 3600) || 0});
}

// Page names in the top bar; translated when shown, never stored.
const SCREEN_BREADCRUMBS = {"now-playing": "player.nowPlaying.heading", settings: "overview.route.settings", uploads: "overview.route.uploads",
  downloads: "overview.route.downloads", overview: "overview.route.overview", artists: "overview.route.artists",
  tracks: "overview.route.tracks", favourites: "overview.route.favourites", "recently-played": "overview.route.recentlyPlayed"};
// Screens whose top bar text showScreen sets on its own; other screens render their own trail.
const SCREEN_BREADCRUMB_OWNED = ["settings", "uploads", "downloads", "overview", "artists", "tracks", "recently-played", "now-playing"];

function screenBreadcrumb(name) {
  if (name === "album-guide") return "1001 Albums";
  if (name === "browse") return browseKinds[browseView.kind].label;
  if (Object.hasOwn(SCREEN_BREADCRUMBS, name)) return TagcastI18n.text(SCREEN_BREADCRUMBS[name]);
  if (name === "album") return state.albums.find(a => String(a.id) === albumView.id)?.name || TagcastI18n.text("overview.route.album");
  return state.artist || TagcastI18n.text("overview.route.albums");
}

function showScreen(name) {
  const wasSettings = state.screen === "settings";
  closeBrowseOptions();
  if (typeof rememberNavigationScroll === "function") rememberNavigationScroll();
  if (!["playlists", "album-favourites"].includes(name) && typeof rememberFavouriteView === "function") rememberFavouriteView();
  if (typeof resetTrackComparison === "function") resetTrackComparison();
  if (typeof closeHelp === "function") closeHelp(false);
  if (name !== "album-guide") $("#guide-link-dialog").close();
  if (typeof closeQueueActions === "function") closeQueueActions();
  if (typeof closeAlbumActions === "function") closeAlbumActions();
  if (typeof closeCoverLightbox === "function") closeCoverLightbox();
  if (typeof closeLyricsViewer === "function") closeLyricsViewer(false);
  if (typeof cancelAlbumLyricsCheck === "function") cancelAlbumLyricsCheck();
  if (typeof resetAlbumLyricsImport === "function") resetAlbumLyricsImport();
  if (typeof resetPlaylistOrder === "function") resetPlaylistOrder();
  if (name !== "browse" && typeof browseView !== "undefined") {
    clearTimeout(browseTimer); browseView.request += 1; browseView.loading = false;
  }
  if (name !== "album") { albumView.request += 1; albumView.loading = false; }
  state.screen = name;
  if (typeof syncNowPlayingPage === "function") syncNowPlayingPage();
  $("#settings").hidden = name !== "settings";
  $("#settings-button").classList.toggle("active", name === "settings");
  if (wasSettings && name !== "settings") settingsPageLeft();
  $("#collections-page").hidden = !["playlists", "album-favourites"].includes(name);
  $("#show-playlists").classList.toggle("active", name === "playlists");
  $("#uploads-page").hidden = name !== "uploads";
  $("#show-uploads").classList.toggle("active", name === "uploads");
  $("#downloads-page").hidden = name !== "downloads";
  $("#show-downloads").classList.toggle("active", name === "downloads");
  $("#overview-page").hidden = name !== "overview";
  $("#album-guide-page").hidden = name !== "album-guide";
  $("#show-album-guide").classList.toggle("active", name === "album-guide");
  $("#albums-page").hidden = name !== "albums";
  $("#album-page").hidden = name !== "album";
  $("#artists-page").hidden = name !== "artists";
  $("#favourites-page").hidden = name !== "favourites";
  $("#artist-favourites-page").hidden = name !== "artist-favourites";
  if (name === "album-favourites") {
    $("#collections-page").setAttribute("role", "tabpanel");
    $("#collections-page").setAttribute("aria-labelledby", "favourites-tab-albums");
    $("#collections-page").setAttribute("tabindex", "0");
  } else {
    for (const attribute of ["role", "aria-labelledby", "tabindex"]) $("#collections-page").removeAttribute(attribute);
  }
  $("#recently-played-page").hidden = name !== "recently-played";
  $("#show-recently-played").classList.toggle("active", name === "recently-played");
  $("#show-favourites").classList.toggle("active", Object.values(favouriteViews).includes(name));
  $("#tracks-page").hidden = name !== "tracks";
  $("#browse-page").hidden = name !== "browse";
  for (const kind of Object.keys(browseKinds)) $("#show-" + kind).classList.toggle("active", name === "browse" && browseView.kind === kind);
  $("#show-overview").classList.toggle("active", name === "overview");
  $("#all-albums").classList.toggle("active", name === "albums" && !state.artist);
  $("#show-artists").classList.toggle("active", name === "artists");
  $("#show-tracks").classList.toggle("active", name === "tracks");
  $("#breadcrumb").textContent = screenBreadcrumb(name);
  if (["playlists", "album-favourites"].includes(name) && typeof renderCollections === "function") renderCollections();
  renderFavouriteHub();
  if (name === "overview") loadOverview();
  syncServiceStatusPage();
  if (typeof syncMusicUploadsPage === "function") syncMusicUploadsPage();
  if (typeof syncAudioDownloadsPage === "function") syncAudioDownloadsPage();
  if (typeof syncHistory === "function") syncHistory();
  if (wasSettings && name !== "settings") resumeSettingsEditor();
}

function overviewDisconnected() {
  $("#overview-page").innerHTML = `${intro(TagcastI18n.html("overview.intro.disconnected"))}${serviceStatusPanel()}`;
  renderServiceStatus();
}

function overviewLoading() {
  return `${intro(`<span class="spinner"></span>${TagcastI18n.html("overview.intro.loading")}`)}${serviceStatusPanel()}`;
}

function overviewFailed(error) {
  $("#overview-page").innerHTML = intro(TagcastI18n.html("overview.intro.failed", {error: TagcastI18n.errorText(error)})) + serviceStatusPanel();
  renderServiceStatus();
}

async function loadOverview() {
  const page = $("#overview-page");
  if (!live()) { overviewDisconnected(); return; }
  if (overview.loading) return;
  overview.loading = true;
  page.classList.add("refreshing");
  if (!overview.data) { overview.error = null; page.innerHTML = overviewLoading(); }
  try {
    overview.data = await api("/api/overview");
    overview.error = null;
    renderOverview(overview.data);
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    overview.error = error;
    overviewFailed(error);
  } finally { overview.loading = false; page.classList.remove("refreshing"); }
}

function intro(subtitle) {
  return `<section class="page-intro"><div><div class="eyebrow">${TagcastI18n.html("overview.intro.eyebrow")}</div><h1>${TagcastI18n.html("overview.intro.heading")}<span>.</span></h1><p>${subtitle}</p></div></section>`;
}

function statTile(label, value, note = "") {
  return `<div class="stat-tile"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`;
}

function renderOverview({account: a, stats: s}) {
  const plan = a.premium ? escapeHtml(`Premium${a.subscription?.frequency ? ` · ${a.subscription.frequency}` : ""}`) : TagcastI18n.html("overview.intro.freeAccount");
  const user = a.username ? escapeHtml(a.username) : TagcastI18n.html("overview.intro.yourAccount");
  $("#overview-page").innerHTML = intro(`${user} <span aria-hidden="true">·</span> ${plan} <span aria-hidden="true">·</span> ${TagcastI18n.html("overview.intro.libraryChanged", {date: a.lastmodified || "—"})}`)
    + `<div class="kpi-row">${[
      statTile(TagcastI18n.html("overview.stats.albums"), fmt(s.albums), TagcastI18n.html("overview.count.tracks", {count: Number(s.tracks || 0)})),
      statTile(TagcastI18n.html("overview.stats.albumArtists"), fmt(s.album_artists), TagcastI18n.html("overview.stats.trackArtists", {count: Number(s.track_artists || 0)})),
      statTile(TagcastI18n.html("overview.stats.playlists"), s.playlists == null ? "—" : fmt(s.playlists), s.playlists == null ? TagcastI18n.html("overview.stats.playlistsPending") : ""),
      statTile(TagcastI18n.html("overview.stats.plays"), fmt(a.plays), TagcastI18n.html("overview.stats.playsNote")),
      statTile(TagcastI18n.html("overview.stats.size"), bytes(s.size)), statTile(TagcastI18n.html("overview.stats.playingTime"), duration(s.length)),
    ].join("")}</div>
    ${serviceStatusPanel()}<div class="overview-grid">${healthCard(s)}${accountCard(a)}${formatsCard(s)}${uploadsCard(s)}${topCard(s)}</div>`;
  renderServiceStatus();
}

// The visible Overview state again, from memory: no request, no change to the data.
function renderOverviewPage() {
  if (!live()) overviewDisconnected();
  else if (overview.error) overviewFailed(overview.error);
  else if (overview.data) renderOverview(overview.data);
  else { $("#overview-page").innerHTML = overviewLoading(); renderServiceStatus(); }
}

// ---- metadata health: meters that open the matching filter ----------------------

function healthCard(s) {
  const rows = [
    ["genre", "overview.health.genre", "overview.health.genreMissing", "genre"],
    ["combined", "overview.health.combined", "overview.health.combinedMissing", "combined"],
    ["year", "overview.health.year", "overview.health.yearMissing", "year"],
    ["artist_image", "overview.health.artistImage", "overview.health.artistImageMissing", "artist_image"],
    ["cover", "overview.health.cover", "overview.health.coverMissing", "cover"],
  ];
  return `<section class="card"><h2>${TagcastI18n.html("overview.health.heading")}</h2><button class="button small" data-cleanup-open>${TagcastI18n.html("overview.health.cleanup")}</button><p class="muted">${TagcastI18n.html("overview.health.intro")}</p>${rows.map(([key, labelKey, missingKey, filter]) => {
    const h = s.health[key] || {missing: 0, total: 0}, done = h.total ? (h.total - h.missing) / h.total : 1, digits = done < 1 && done > 0.995 ? 2 : 1;
    // The meter keeps a machine-readable value; the visible percentage follows the language.
    const pct = (done * 100).toFixed(digits), label = TagcastI18n.html(labelKey);
    const shown = TagcastI18n.html("overview.health.percent", {percent: TagcastI18n.number(done * 100, {useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits})});
    return `<div class="health-row"><div class="health-head"><span>${label}</span><strong>${shown}</strong></div>
      <div class="meter" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${done * 100}%"></span></div>
      <div class="health-foot"><span class="muted">${h.missing ? TagcastI18n.html(missingKey, {count: Number(h.missing)}) : TagcastI18n.html("overview.health.nothingMissing")}</span>${h.missing ? `<button class="text-action" data-health="${filter}">${TagcastI18n.html(key === "artist_image" ? "overview.health.showArtists" : "overview.health.showAlbums")}</button>` : ""}</div></div>`;
  }).join("")}</section>`;
}

// ---- account & settings ------------------------------------------------------------

function accountCard(a) {
  const yes = v => v == null ? "—" : TagcastI18n.html(v ? "overview.settings.on" : "overview.settings.off");
  const rates = {orig: "overview.settings.bitrateOriginal", auto: "overview.settings.bitrateAutomatic"}, rate = a.preferences.bitrate;
  const bitrate = Object.hasOwn(rates, rate) ? TagcastI18n.html(rates[rate]) : rate ? `${escapeHtml(rate)} kbps` : "—";
  const linked = value => TagcastI18n.html(value ? "overview.account.linked" : "overview.account.notLinked");
  const sub = a.subscription;
  const plan = [`Premium${sub?.name && sub.name.toLowerCase() !== "premium" && sub.name.toLowerCase() !== sub.frequency?.toLowerCase() ? ` (${escapeHtml(sub.name)})` : ""}`,
    ...(sub?.frequency ? [escapeHtml(sub.frequency)] : []),
    ...(sub?.renews_on && !sub.canceled ? [TagcastI18n.html("overview.account.renews", {date: sub.renews_on})] : []),
    ...(sub?.canceled ? [TagcastI18n.html("overview.account.canceled")] : [])].join(" · ");
  const rows = [
    [TagcastI18n.html("overview.account.account"), escapeHtml(a.username || "—")],
    [TagcastI18n.html("overview.account.email"), escapeHtml(a.email || "—")],
    [TagcastI18n.html("overview.account.verified"), !a.verified ? TagcastI18n.html("overview.account.no")
      : a.verified_on ? TagcastI18n.html("overview.account.verifiedOn", {date: a.verified_on}) : TagcastI18n.html("overview.account.yes")],
    [TagcastI18n.html("overview.account.plan"), a.premium ? plan : TagcastI18n.html("overview.account.free")],
    [TagcastI18n.html("overview.account.lastfm"), a.linked.lastfm ? TagcastI18n.html("overview.account.linkedAs", {name: a.linked.lastfm}) : linked(false)],
    ["Dropbox · Google Drive", `${linked(a.linked.dropbox)} · ${linked(a.linked.googledrive)}`],
    [TagcastI18n.html("overview.account.achievements"), fmt(a.achievements)],
  ];
  // "Combine Multi-Disc Album Sets" is iBroadcast's own setting name, as its settings page shows it.
  const settings = [
    [TagcastI18n.html("overview.settings.streamingQuality"), bitrate, ""],
    [TagcastI18n.html("overview.settings.oneQueue"), yes(a.preferences.one_queue), ""],
    ["Combine Multi-Disc Album Sets", yes(a.preferences.combine_sets), a.preferences.combine_sets ? TagcastI18n.html("overview.settings.combineNote") : "", true],
    [TagcastI18n.html("overview.settings.artistImages"), yes(a.preferences.artist_images), a.preferences.artist_images === false ? TagcastI18n.html("overview.settings.artistImagesNote") : ""],
    [TagcastI18n.html("overview.settings.replayGain"), yes(a.preferences.replay_gain), ""],
  ];
  const link = TagcastI18n.trusted('<a href="https://media.ibroadcast.com/" target="_blank" rel="noopener noreferrer">media.ibroadcast.com ↗</a>');
  return `<section class="card"><h2>${TagcastI18n.html("overview.account.heading")}</h2><dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <h3>${TagcastI18n.html("overview.settings.heading")}</h3><dl class="facts">${settings.map(([k, v, note, warn]) => `<dt>${k}</dt><dd>${v}${note ? `<small class="${warn ? "warn" : ""}">${note}</small>` : ""}</dd>`).join("")}</dl>
    <p class="muted account-settings-note">${TagcastI18n.html("overview.settings.changeIn", {link})}</p></section>`;
}

// ---- formats: horizontal bars, value at the tip ---------------------------------

function formatsCard(s) {
  const top = s.formats.slice(0, 6), rest = s.formats.slice(6);
  // A display label for the remaining formats, not a format name from the library.
  if (rest.length) top.push({name: TagcastI18n.text("overview.formats.other"), tracks: rest.reduce((n, f) => n + f.tracks, 0), size: rest.reduce((n, f) => n + f.size, 0)});
  const max = Math.max(1, ...top.map(f => f.tracks));
  return `<section class="card"><h2>${TagcastI18n.html("overview.formats.heading")}</h2><p class="muted">${TagcastI18n.html("overview.formats.intro")}</p><div class="hbars">${top.map(f => {
    const share = s.tracks ? TagcastI18n.number(f.tracks / s.tracks * 100, {useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1}) : "0";
    return `<div class="hbar" tabindex="0" data-tip="${escapeHtml(f.name)}|${TagcastI18n.html("overview.formats.tip", {count: Number(f.tracks || 0), size: bytes(f.size), share})}"><span class="hbar-label">${escapeHtml(f.name)}</span><span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(0.5, f.tracks / max * 100)}%"></span></span><span class="hbar-value">${fmt(f.tracks)}</span></div>`;
  }).join("")}</div></section>`;
}

// ---- uploads per year: columns, the busiest year labelled -----------------------

function uploadsCard(s) {
  const years = s.uploads;
  if (!years.length) return `<section class="card"><h2>${TagcastI18n.html("overview.uploads.heading")}</h2><p class="muted">${TagcastI18n.html("overview.uploads.empty")}</p></section>`;
  const max = Math.max(1, ...years.map(y => y.tracks)), peak = years.find(y => y.tracks === max);
  const ticks = [0, max / 2, max].map(v => Math.round(v));
  return `<section class="card"><h2>${TagcastI18n.html("overview.uploads.heading")}</h2><p class="muted">${TagcastI18n.html("overview.uploads.intro")}</p>
    <div class="columns-chart"><div class="col-axis">${ticks.reverse().map(t => `<span>${fmt(t)}</span>`).join("")}</div><div class="cols">${years.map(y => `<div class="col" tabindex="0" data-tip="${escapeHtml(y.year)}|${TagcastI18n.html("overview.count.tracks", {count: Number(y.tracks || 0)})}"><span class="col-bar" style="height:${y.tracks ? Math.max(1, y.tracks / max * 100) : 0}%">${y === peak ? `<b>${fmt(y.tracks)}</b>` : ""}</span></div>`).join("")}</div><span></span><div class="col-years">${years.map(y => `<span>${y.year}</span>`).join("")}</div></div>
    <details class="table-view"><summary>${TagcastI18n.html("overview.uploads.table")}</summary><table><thead><tr><th>${TagcastI18n.html("overview.uploads.year")}</th><th>${TagcastI18n.html("overview.uploads.tracks")}</th></tr></thead><tbody>${years.map(y => `<tr><td>${y.year}</td><td>${fmt(y.tracks)}</td></tr>`).join("")}</tbody></table></details></section>`;
}

// ---- most played -----------------------------------------------------------------------

function topCard(s) {
  const list = (title, rows, cell) => `<div><h3>${title}</h3>${rows.length ? `<ol class="top-list">${rows.map(r => `<li>${cell(r)}<span class="plays">${fmt(r.plays)}</span></li>`).join("")}</ol>` : `<p class="muted">${TagcastI18n.html("overview.top.empty")}</p>`}</div>`;
  return `<section class="card wide"><h2>${TagcastI18n.html("overview.top.heading")}</h2><p class="muted">${TagcastI18n.html("overview.top.intro")}</p><div class="top-grid">
    ${list(TagcastI18n.html("overview.top.tracks"), s.top_tracks, r => `<span><strong>${escapeHtml(r.title)}</strong><small>${escapeHtml(r.artist)} · <button class="text-action" data-album="${escapeHtml(r.album_id)}">${escapeHtml(r.album)}</button></small></span>`)}
    ${list(TagcastI18n.html("overview.top.albums"), s.top_albums, r => `<span><button class="text-action" data-album="${escapeHtml(r.album_id)}">${escapeHtml(r.album)}</button><small>${escapeHtml(r.artist)}</small></span>`)}
    ${list(TagcastI18n.html("overview.top.artists"), s.top_artists, r => `<span><button class="text-action" data-overview-artist="${escapeHtml(r.artist)}">${escapeHtml(r.artist)}</button></span>`)}
  </div></section>`;
}

// ---- tooltip: one element, text only --------------------------------------------------

function showTip(target) {
  const tip = $("#chart-tip"), [title, value] = target.dataset.tip.split("|");
  tip.replaceChildren(Object.assign(document.createElement("strong"), {textContent: value}), Object.assign(document.createElement("span"), {textContent: title}));
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(8, box.top - tip.offsetHeight - 8)}px`;
}
const hideTip = () => { $("#chart-tip").hidden = true; };

for (const [type, handler] of [["pointerover", showTip], ["focusin", showTip]]) {
  document.addEventListener(type, event => { const t = event.target.closest?.("[data-tip]"); if (t) handler(t); });
}
for (const type of ["pointerout", "focusout"]) {
  document.addEventListener(type, event => { if (event.target.closest?.("[data-tip]")) hideTip(); });
}
window.addEventListener("scroll", hideTip, true);

document.addEventListener("click", event => {
  if (event.target.closest("#show-overview")) { showScreen("overview"); return; }
  if (event.target.closest("#all-albums")) { if (state.screen === "overview") showScreen("albums"); return; }
  const health = event.target.closest("[data-health]");
  if (health) {
    if (health.dataset.health === "artist_image") {
      $("#artists-search").value = ""; $("#artists-filter").value = "no_image"; artistBrowse.page = 0;
      showArtistBrowse(); return;
    }
    $("#filter").value = health.dataset.health; $("#search").value = ""; state.artist = null; state.page = 0;
    showScreen("albums"); render(); return;
  }
  const artist = event.target.closest("[data-overview-artist]");
  if (artist) {
    const name = artist.dataset.overviewArtist;
    if (!state.albums.some(a => albumHasArtist(a, name))) { toast(TagcastI18n.text("overview.top.trackArtistOnly", {name})); return; }
    setArtist(name);
  }
});

// A language change redraws the visible Overview and top bar label from memory. Open
// details stay open; nothing is fetched and the service status timer keeps running.
TagcastI18n.subscribe(() => {
  if (SCREEN_BREADCRUMB_OWNED.includes(state.screen)) $("#breadcrumb").textContent = screenBreadcrumb(state.screen);
  if (state.screen !== "overview") return;
  const page = $("#overview-page"), details = () => [...(page.querySelectorAll?.("details") || [])];
  const open = details().map(node => node.open);
  renderOverviewPage();
  details().forEach((node, index) => { if (index < open.length) node.open = open[index]; });
});
