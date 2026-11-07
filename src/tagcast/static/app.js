"use strict";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function setActionStatus(selector, message, working = false) {
  const node = $(selector);
  if (!node) return;
  if (message !== undefined) node.textContent = message;
  node.classList.add("operation-status");
  node.setAttribute("data-working", String(working));
  node.setAttribute("role", "status");
}

function searchClearButton(id, value = "", disabled = false) {
  return `<button type="button" class="search-clear" data-search-clear="${escapeHtml(id)}" aria-controls="${escapeHtml(id)}" aria-label="${TagcastI18n.html("common.clearSearch")}" title="${TagcastI18n.html("common.clearSearch")}" ${!value || disabled ? "hidden" : ""}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`;
}

function clearableSearchInput(id, attributes, value = "", disabled = false) {
  return `<span class="clearable-search"><input id="${escapeHtml(id)}" ${attributes} value="${escapeHtml(value)}" ${disabled ? "disabled" : ""}>${searchClearButton(id, value, disabled)}</span>`;
}

function syncSearchClearButtons() {
  for (const button of document.querySelectorAll("[data-search-clear]")) {
    const input = document.getElementById(button.dataset.searchClear);
    button.hidden = !input || !input.value || input.disabled || input.readOnly;
  }
}

document.addEventListener("input", syncSearchClearButtons);
document.addEventListener("click", event => {
  const button = event.target.closest("[data-search-clear]");
  if (!button) return;
  const id = button.dataset.searchClear, input = document.getElementById(id);
  if (!input || !input.value || input.disabled || input.readOnly) return;
  input.value = "";
  syncSearchClearButtons();
  // Reuse each search's input handling; explicit Search forms still wait for submit.
  input.dispatchEvent(new Event("input", {bubbles: true}));
  document.getElementById(id)?.focus();
});

const colors = ["#627b70", "#ab7555", "#6c7b89", "#a98a56", "#836d7b", "#71856b"];
// state.albums holds small album summaries (no tracks); full albums live in state.details.
const state = {playlistsCount: null, albums: [], details: new Map(), albumFavourites: new Set(), albumFavouriteError: "", artistFavourites: new Set(), artistFavouriteError: "", artistNames: [], editorNames: {genres: [], composers: []}, artist: null, view: storedView(), perPage: storedPageSize("tagcast-per-page"), history: storedHistory(), selected: new Set(), page: 0, mode: "demo", loading: false, connection: {connected: false, configured: false, account: ""}};
const metadataEditingDefaults = {applyYearToTracks: storedTrackYearDefault()};
const libraryNotice = {visible: document.documentElement.dataset.libraryNotice !== "hidden"};
let libraryLoadRequest = 0;
// Interface text keys; the visible text follows the interface language.
const libraryLoadingMessages = [
  "library.loading.void",
  "library.loading.cloud",
  "library.loading.sofa",
  "library.loading.counting",
  "library.loading.cable",
  "library.loading.humming",
  "library.loading.records",
  "library.loading.hamsters",
];
let libraryLoadingMessageIndex = -1;
let libraryLoadingRefresh = false;

function nextLibraryLoadingMessage() {
  libraryLoadingMessageIndex = libraryLoadingMessageIndex < 0
    ? Math.floor(Math.random() * libraryLoadingMessages.length)
    : (libraryLoadingMessageIndex + 1) % libraryLoadingMessages.length;
  return TagcastI18n.text(libraryLoadingMessages[libraryLoadingMessageIndex]);
}

// Whole sentences: the playful message, a fresh download note and the patience note.
function libraryLoadingText(message, refresh) {
  return [message, refresh ? TagcastI18n.text("library.loading.fresh") : "", TagcastI18n.text("library.loading.patience")].filter(Boolean).join(" ");
}

function setLibraryNotice(visible) {
  libraryNotice.visible = visible;
  document.documentElement.dataset.libraryNotice = visible ? "shown" : "hidden";
  $("#library-notice").hidden = !visible;
  try { localStorage.setItem("tagcast-library-notice", visible ? "shown" : "hidden"); } catch { /* private window */ }
}

$("#notice-dismiss").addEventListener("click", () => {
  setLibraryNotice(false); $("#mode-badge").focus();
});
const live = () => state.mode === "live";
let devicePoll = null;
let saving = false;
let reloadOnApply = false;
let editing = null;
let pending = null;
let toastTimer;
let searchTimer;
let opening = false;
let checking = 0; // background read-backs still running
let pendingAlbums = null; // read-back albums waiting for the editor to close
let saveOrder = 0; // only the newest save's read-back replaces the album list

// Saves to iBroadcast are kept in this browser, so History (and Undo) survive a reload.
function storedHistory() {
  try {
    const entries = JSON.parse(localStorage.getItem("tagcast-history") || localStorage.getItem("library-studio-history") || "[]");
    return Array.isArray(entries) ? entries.map(h => h.status === "sent" ? {...h, status: "unverified", changes: h.changes.map(c => c.status === "sent" ? {...c, status: "unverified"} : c)} : h) : [];
  } catch { return []; }
}

function rememberHistory() {
  try { localStorage.setItem("tagcast-history", JSON.stringify(state.history.filter(h => h.source === "ibroadcast").slice(0, 300))); } catch { /* private window or full */ }
}

function storedView() {
  try { return localStorage.getItem("tagcast-view") === "list" ? "list" : "grid"; } catch { return "grid"; }
}

// Albums or album artists per page, as chosen; 0 when nothing was chosen yet.
function storedPageSize(key) {
  try { const n = Number(localStorage.getItem(key)); return [24, 50, 100, 200].includes(n) ? n : 0; } catch { return 0; }
}

function rememberPageSize(key, size) {
  try { localStorage.setItem(key, String(size)); } catch { /* private window */ }
}

function storedTrackYearDefault() {
  try { return localStorage.getItem("tagcast-apply-album-year-to-tracks") === "1"; }
  catch { return false; }
}

function setTrackYearDefault(enabled) {
  metadataEditingDefaults.applyYearToTracks = enabled === true;
  try { localStorage.setItem("tagcast-apply-album-year-to-tracks", enabled === true ? "1" : "0"); }
  catch { /* private window */ }
}

function demoLibrary() {
  const examples = [
    ["Pink Floyd", "Wish You Were Here", 1975, "Progressive Rock", ["Shine On You Crazy Diamond (Parts I–V)", "Welcome to the Machine", "Have a Cigar", "Wish You Were Here", "Shine On You Crazy Diamond (Parts VI–IX)"]],
    ["Pink Floyd", "The Dark Side of the Moon (2011 Remaster)", 2011, "Progressive Rock", ["Speak to Me", "Breathe (In the Air)", "On the Run", "Time", "The Great Gig in the Sky", "Money", "Us and Them", "Any Colour You Like", "Brain Damage", "Eclipse"]],
    ["Kate Bush", "Hounds of Love", 0, "", ["Running Up That Hill (A Deal with God)", "Hounds of Love", "The Big Sky", "Mother Stands for Comfort", "Cloudbusting", "And Dream of Sheep", "Under Ice", "Waking the Witch", "Watching You Without Me", "Jig of Life", "Hello Earth", "The Morning Fog"]],
    ["Kate Bush", "The Dreaming", 1982, "Art Pop", ["Sat in Your Lap", "There Goes a Tenner", "Pull Out the Pin", "Suspended in Gaffa", "Leave It Open", "The Dreaming", "Night of the Swallow", "All the Love", "Houdini", "Get Out of My House"]],
    ["Massive Attack", "Mezzanine", 1998, "Trip Hop", ["Angel", "Risingson", "Teardrop", "Inertia Creeps", "Exchange", "Dissolved Girl", "Man Next Door", "Black Milk", "Mezzanine", "Group Four", "(Exchange)"]],
    ["Massive Attack", "Blue Lines", 1991, "", ["Safe from Harm", "One Love", "Blue Lines", "Be Thankful for What You've Got", "Five Man Army", "Unfinished Sympathy", "Daydreaming", "Lately", "Hymn of the Big Wheel"]],
  ];
  return examples.map(([artist, name, year, genre, titles], i) => ({
    id: i + 1, artist, name, year, disc: 1, color: colors[i],
    tracks: titles.map((title, t) => ({id: (i + 1) * 100 + t, title, artist, year, genre, track: t + 1})),
  }));
}

const trackGenres = t => t.genres ?? (t.genre?.trim() ? [t.genre.trim()] : []);
// Match the server: ignore case, spacing and quotation marks; retain version text.
const titleKey = title => String(title || "").replace(/['"‘’‚‛“”„‟«»‹›]/g, "").toLocaleLowerCase().split(/\s+/).filter(Boolean).join(" ");
function duplicateTrackNumber(track) {
  const position = Number(track.track);
  return Number.isInteger(position) && position > 0 ? position : 0;
}
function duplicateTrackPosition(track) {
  const position = duplicateTrackNumber(track);
  // iBroadcast's combined view retains the track's original disc album_id.
  return position ? JSON.stringify([Number(track.album_id) || 0, position]) : "";
}
// A repeated title elsewhere in a track list is not an extra copy. Compare per disc.
function duplicateTrackKey(track) {
  const position = duplicateTrackPosition(track), title = titleKey(track.title);
  return position && title ? JSON.stringify([position, title]) : "";
}

function repeatedTrackPositions(album) {
  const seen = new Set(), repeated = new Set();
  for (const t of album.tracks) {
    const position = duplicateTrackPosition(t);
    if (position) (seen.has(position) ? repeated : seen).add(position);
  }
  return repeated;
}

function summarize(album) {
  const genres = splitGenres(album.tracks.flatMap(trackGenres)).sort();
  return {id: String(album.id), name: album.name, artist: album.artist, year: album.year, disc: album.disc, rating: album.rating || 0,
    album_artists: albumArtistEntries(album), artist_id: album.artist_id || 0, artist_rating: album.artist_rating || 0, artist_image: album.artist_image || "", artist_artwork_id: album.artist_artwork_id || 0,
    artwork: album.artwork || "", color: album.color, track_count: album.tracks.length, genres,
    upload_dates: [...new Set(album.tracks.map(t => String(t.uploaded_on || "").trim().slice(0, 10)))].sort(),
    uploaded_at: album.tracks.map(t => t.uploaded_at || "").sort().at(-1) || "",
    no_genre: album.tracks.filter(t => !trackGenres(t).length).length,
    combined_genres: album.tracks.filter(t => hasCombined(trackGenres(t))).length,
    no_composer: album.tracks.filter(t => !(t.composers || []).length).length,
    track_gaps: (numbers => numbers.size ? Math.max(...numbers) - numbers.size : 0)(new Set(album.tracks.map(t => t.track).filter(Boolean))),
    duplicates: (keys => keys.length - new Set(keys).size)(album.tracks.map(duplicateTrackKey).filter(Boolean)),
    repeated_numbers: (numbers => numbers.length - new Set(numbers).size)(album.tracks.map(duplicateTrackPosition).filter(Boolean)),
    no_cover: album.tracks.filter(t => !(t.artwork_id ?? album.artwork)).length};
}

function useLocal(albums, mode) {
  saveOrder += 1;
  libraryLoadRequest += 1; state.loading = false; state.playlistsCount = null;
  $("#library-loading").hidden = true;
  closeBrowseOptions();
  resetEditorArtistChoices();
  if (typeof resetTags === "function") resetTags();
  if (typeof resetAlbumMerge === "function") resetAlbumMerge();
  if (typeof resetAlbumSplit === "function") resetAlbumSplit();
  if (typeof closeHelp === "function") closeHelp(false);
  if (typeof resetGuideAlbumNotes === "function") resetGuideAlbumNotes();
  if (typeof resetAlbumGuide === "function") resetAlbumGuide(false);
  if (typeof resetCleanup === "function") resetCleanup(true);
  if (typeof resetDuplicateCleanup === "function") resetDuplicateCleanup(true);
  if (typeof resetSelectedAlbumTrash === "function") resetSelectedAlbumTrash();
  resetAlbumOrder();
  if (typeof resetArtistBrowse === "function") resetArtistBrowse();
  if (typeof resetAlbumInformation === "function") resetAlbumInformation();
  if (typeof resetTrackLyrics === "function") resetTrackLyrics();
  if (typeof resetPlaylistOrder === "function") resetPlaylistOrder();
  if (typeof resetBrowse === "function") resetBrowse();
  if (typeof resetFavourites === "function") resetFavourites();
  if (typeof resetPlaylistImport === "function") resetPlaylistImport();
  if (typeof resetRecentlyPlayed === "function") resetRecentlyPlayed();
  if (typeof detachQueueMemory === "function") detachQueueMemory();
  if (typeof stopPlayer === "function") stopPlayer();
  if (typeof resetAlbumView === "function") resetAlbumView();
  for (const album of albums) for (const t of album.tracks) { t.genres = trackGenres(t); t.composers ??= []; }
  state.mode = mode; state.artistNames = []; state.editorNames = {genres: [], composers: []};
  state.albumFavourites = new Set(); state.albumFavouriteError = "";
  state.artistFavourites = new Set(); state.artistFavouriteError = "";
  state.details = new Map(albums.map(a => [String(a.id), a]));
  state.albums = albums.map(summarize);
}

async function albumDetails(ids) {
  const details = state.details;
  const missing = ids.filter(id => !details.has(String(id)));
  if (missing.length && live()) {
    const colorsById = new Map(state.albums.map(a => [String(a.id), a.color]));
    for (let i = 0; i < missing.length; i += 100) {
      const data = await api(`/api/albums?ids=${missing.slice(i, i + 100).map(encodeURIComponent).join(",")}`);
      for (const album of data.albums) details.set(String(album.id), {...album, color: colorsById.get(String(album.id))});
    }
  }
  return ids.map(id => details.get(String(id))).filter(Boolean);
}

function toast(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, Math.max(6000, text.length * 70));
}

function largeArtworkUrl(url) {
  // Known iBroadcast sizes only; keep other providers' URLs intact.
  return url.replace(/(\/artwork\/\d+)-(?:150|300)(?=$|[?#])/, "$1-1000");
}

function coverPreviewAttrs(album) {
  return album.artwork ? `data-cover-preview data-cover-src="${escapeHtml(album.artwork)}" data-cover-name="${escapeHtml(album.name)}" data-cover-artist="${escapeHtml(album.artist)}" title="${TagcastI18n.html("library.cover.enlarge")}"` : "";
}

function cover(album, small = false, enlarge = false) {
  const initials = album.artist.split(/\s+/).map(s => s[0]).slice(0, 2).join("");
  const art = album.artwork ? `<img src="${escapeHtml(album.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-error="album">` : "";
  return `<div class="cover ${art ? "has-art" : ""}" ${!small && enlarge ? coverPreviewAttrs(album) : ""} style="--cover-color:${album.color}">${art}<span class="cover-letter">${escapeHtml(initials)}</span>${small || art ? "" : `<span class="cover-caption">${TagcastI18n.html("library.cover.placeholder")}</span>`}</div>`;
}

const EDITION = /remaster|deluxe|anniversary|re-record|live|edition|expanded/i;
// [interface text key, test]; render() translates the key.
const FILTERS = {
  all: ["library.filter.all", () => true],
  year: ["library.filter.year", a => !a.year],
  genre: ["library.filter.genre", a => a.no_genre > 0],
  artist_image: ["library.filter.artistImage", a => !a.artist_image && a.artist !== "Various Artists"],
  cover: ["library.filter.cover", a => a.no_cover > 0],
  combined: ["library.filter.combined", a => a.combined_genres > 0],  // tags like "Pop;Rock" stored as one genre
  composer: ["library.filter.composer", a => a.no_composer > 0],  // search "classical" to narrow it down
  small: ["library.filter.small", a => a.track_count <= 2],
  incomplete: ["library.filter.incomplete", a => a.track_gaps > 0],
  duplicates: ["library.filter.duplicates", hasDuplicateTracks],
  edition: ["library.filter.edition", a => EDITION.test(a.name)],
};
function compareRating(a, b, descending = true) {
  return !a !== !b ? (a ? -1 : 1) : descending ? b - a : a - b;
}

function compareUpload(a, b, descending = true) {
  const first = a.uploaded_at || "", second = b.uploaded_at || "";
  return !first !== !second ? (first ? -1 : 1) : descending ? second.localeCompare(first) : first.localeCompare(second);
}

const SORTS = {
  artist: (a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name),
  artist_za: (a, b) => b.artist.localeCompare(a.artist) || a.name.localeCompare(b.name),
  title: (a, b) => a.name.localeCompare(b.name),
  title_za: (a, b) => b.name.localeCompare(a.name),
  year: (a, b) => (a.year || 9999) - (b.year || 9999) || a.name.localeCompare(b.name),
  newest: (a, b) => b.year - a.year || a.name.localeCompare(b.name),
  rating_high: (a, b) => compareRating(a.rating || 0, b.rating || 0) || SORTS.artist(a, b),
  rating_low: (a, b) => compareRating(a.rating || 0, b.rating || 0, false) || SORTS.artist(a, b),
  uploaded_newest: (a, b) => compareUpload(a, b) || SORTS.artist(a, b),
  uploaded_oldest: (a, b) => compareUpload(a, b, false) || SORTS.artist(a, b),
};
// Getters keep these shared tables plain value → label maps in the current interface language.
const albumSortLabels = {
  get artist() { return TagcastI18n.text("library.sort.artistAz"); },
  get artist_za() { return TagcastI18n.text("library.sort.artistZa"); },
  get title() { return TagcastI18n.text("library.sort.titleAz"); },
  get title_za() { return TagcastI18n.text("library.sort.titleZa"); },
  get random() { return TagcastI18n.text("library.sort.randomAlbums"); },
  get year() { return TagcastI18n.text("library.sort.yearOldest"); },
  get newest() { return TagcastI18n.text("library.sort.yearNewest"); },
  get rating_high() { return TagcastI18n.text("library.sort.ratingHigh"); },
  get rating_low() { return TagcastI18n.text("library.sort.ratingLow"); },
  get uploaded_newest() { return TagcastI18n.text("library.sort.uploadedNewest"); },
  get uploaded_oldest() { return TagcastI18n.text("library.sort.uploadedOldest"); }};
const artistSortLabels = {
  get az() { return TagcastI18n.text("library.sort.nameAz"); },
  get za() { return TagcastI18n.text("library.sort.nameZa"); },
  get random() { return TagcastI18n.text("library.sort.random"); },
  get rating_high() { return TagcastI18n.text("library.sort.ratingHigh"); },
  get rating_low() { return TagcastI18n.text("library.sort.ratingLow"); }};
const albumOrder = {ids: [], library: 0};
const browseChoices = {views: new Map(), kind: null, trigger: null, details: null};

// Hidden values retain the independent filter/order used by history and discovery links.
// One visible menu changes either value while preserving the other.
function browseChoiceInputs(kind) {
  return {filter: $(kind === "artists" ? "#artists-filter" : "#filter"),
    sort: $(kind === "artists" ? "#artists-sort" : "#sort")};
}

function syncBrowseChoices(kind, filters, sorts, defaultSort) {
  const inputs = browseChoiceInputs(kind);
  if (!filters.some(option => option.value === inputs.filter.value)) inputs.filter.value = "all";
  if (!Object.hasOwn(sorts, inputs.sort.value)) inputs.sort.value = defaultSort;
  const filter = filters.find(option => option.value === inputs.filter.value);
  const options = [
    ...Object.entries(sorts).map(([value, label]) => ({key: `sort:${value}`, label, selected: value === inputs.sort.value})),
    ...filters.filter(option => option.value === "all" || option.count > 0).map(option => ({
      key: `filter:${option.value}`, label: option.count ? TagcastI18n.text("library.browse.optionCount", {label: option.label, count: option.count}) : option.label,
      selected: option.value === inputs.filter.value, disabled: Boolean(option.disabled)})),
  ];
  browseChoices.views.set(kind, options);
  const trigger = $(`#${kind}-browse-options`);
  const label = `<span><strong>${escapeHtml(filter.label)}</strong><small>${escapeHtml(sorts[inputs.sort.value])}</small></span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>`;
  if (trigger.innerHTML !== label) trigger.innerHTML = label;
  if (browseChoices.kind === kind) {
    if (browseChoices.details !== state.details) closeBrowseOptions(true);
    else paintBrowseOptions();
  }
}

function closeBrowseOptions(restoreFocus = false) {
  const trigger = browseChoices.trigger;
  $("#browse-options-menu").hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  browseChoices.kind = null; browseChoices.trigger = null; browseChoices.details = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function paintBrowseOptions() {
  const menu = $("#browse-options-menu"), options = browseChoices.views.get(browseChoices.kind) || [];
  const html = `<div class="browse-options-title" role="presentation"><span>${TagcastI18n.html("library.browse.title")}</span><button type="button" role="menuitem" data-browse-close aria-label="${TagcastI18n.html("library.browse.close")}" tabindex="-1">×</button></div>`
    + [["sort", "library.browse.sort"], ["filter", "library.browse.show"]].map(([kind, label]) => `<div role="group" aria-label="${TagcastI18n.html(label)}"><div class="browse-options-heading" role="presentation">${TagcastI18n.html(label)}</div>${options.filter(option => option.key.startsWith(`${kind}:`)).map(option => `<button type="button" role="menuitemradio" aria-checked="${option.selected}" data-browse-choice="${option.key}" tabindex="-1" ${option.disabled ? "disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg><span>${escapeHtml(option.label)}</span></button>`).join("")}</div>`).join("");
  if (menu.innerHTML === html) return;
  const focused = document.activeElement?.getAttribute?.("data-browse-choice"), scroll = menu.scrollTop;
  menu.innerHTML = html;
  if (focused) [...menu.querySelectorAll("[data-browse-choice]")].find(option => option.dataset.browseChoice === focused)?.focus();
  menu.scrollTop = scroll;
}

function openBrowseOptions(trigger, last = false) {
  const kind = trigger.dataset.browseOptions, same = browseChoices.trigger === trigger;
  closeBrowseOptions();
  if (same || !["albums", "artists"].includes(kind) || state.screen !== kind) return;
  setThemeMenu(false);
  if (typeof closeQueueActions === "function") closeQueueActions();
  if (typeof closeAlbumActions === "function") closeAlbumActions();
  browseChoices.kind = kind; browseChoices.trigger = trigger; browseChoices.details = state.details;
  paintBrowseOptions();
  const menu = $("#browse-options-menu"), anchor = trigger.getBoundingClientRect();
  const height = document.documentElement.clientHeight, width = document.documentElement.clientWidth;
  menu.hidden = false; menu.scrollTop = 0; menu.style.maxHeight = `${Math.max(100, height - 16)}px`;
  const size = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - size.width, width - size.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, height - size.height - 8))}px`;
  trigger.setAttribute("aria-expanded", "true");
  const options = [...menu.querySelectorAll("button:not(:disabled)")];
  (last ? options.at(-1) : menu.querySelector('[aria-checked="true"]') || options[0])?.focus();
}

function chooseBrowseOption(key) {
  const kind = browseChoices.kind, option = browseChoices.views.get(kind)?.find(value => value.key === key);
  if (!option || option.disabled || state.screen !== kind || browseChoices.details !== state.details) { closeBrowseOptions(); return; }
  const [field, value] = key.split(":"), input = browseChoiceInputs(kind)[field];
  const changed = input.value !== value;
  input.value = value; closeBrowseOptions(true);
  if (!changed) return;
  if (kind === "artists") {
    if (field === "sort") artistBrowse.randomNames = [];
    artistBrowse.page = 0; renderArtistBrowse();
  } else {
    if (field === "sort") albumOrder.ids = [];
    state.page = 0; render();
  }
}

document.addEventListener("click", event => {
  const trigger = event.target.closest("[data-browse-options]"), option = event.target.closest("[data-browse-choice]");
  if (event.target.closest("[data-browse-close]")) closeBrowseOptions(true);
  else if (trigger) openBrowseOptions(trigger);
  else if (option) chooseBrowseOption(option.dataset.browseChoice);
  else if (!event.target.closest("#browse-options-menu")) closeBrowseOptions();
});
document.addEventListener("keydown", event => {
  const trigger = event.target.closest("[data-browse-options]");
  if (trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault(); openBrowseOptions(trigger, event.key === "ArrowUp"); return;
  }
  if (!browseChoices.trigger) return;
  if (["Escape", "Tab"].includes(event.key)) {
    closeBrowseOptions(true); if (event.key === "Escape") event.preventDefault(); return;
  }
  if (!event.target.closest("#browse-options-menu") || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const options = [...$("#browse-options-menu").querySelectorAll("button:not(:disabled)")];
  const index = options.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
  options[next]?.focus();
});
window.addEventListener("resize", () => closeBrowseOptions(true));
window.addEventListener("scroll", event => { if (!event.target.closest?.("#browse-options-menu")) closeBrowseOptions(); }, true);
const initials = name => name.split(/\s+/).map(s => s[0]).slice(0, 2).join("");
const pageSize = () => state.perPage || (state.view === "list" ? 100 : 24);

// Discs of one set (matching title, artist, year and upload dates) are separate albums in iBroadcast
// while "Combine Multi-Disc Album Sets" is off.
let discCache = {albums: null, sets: new Map()};
const discSetKey = a => JSON.stringify([a.name.trim().toLocaleLowerCase(), a.artist,
  Number(a.year) || 0, a.upload_dates || [""], albumArtistEntries(a).slice(1).map(entry => entry.id)]);
function discSet(album) {
  if (discCache.albums !== state.albums) {
    const sets = new Map();
    for (const a of state.albums) {
      const key = discSetKey(a);
      if (!sets.has(key)) sets.set(key, []);
      sets.get(key).push(a);
    }
    for (const set of sets.values()) set.sort((a, b) => (a.disc || 0) - (b.disc || 0));
    discCache = {albums: state.albums, sets};
  }
  const set = discCache.sets.get(discSetKey(album)) || [];
  return set.length > 1 && new Set(set.map(a => a.disc)).size === set.length ? set : null;
}
// Plain text for display only; history labels keep their own English form.
const discLabel = album => { const set = discSet(album); return set ? TagcastI18n.text("library.disc.ofSet", {disc: album.disc || "?", count: set.length}) : ""; };

// The album lists show the discs of a set as one album; saving still goes per disc,
// because each disc is its own album in iBroadcast.
let shelfCache = {albums: null, items: []};
function albumShelf() {
  if (shelfCache.albums !== state.albums) {
    const items = [];
    for (const a of state.albums) {
      const set = discSet(a);
      if (!set) items.push(a);
      else if (set[0] === a) items.push(mergeDiscs(set));
    }
    shelfCache = {albums: state.albums, items};
  }
  return shelfCache.items;
}

// A set's numbers add up; its year is missing when one of the discs has none.
function mergeDiscs(set) {
  const sum = key => set.reduce((n, a) => n + (a[key] || 0), 0), years = set.map(a => a.year || 0);
  return {...set[0], rating: Math.min(...set.map(a => a.rating || 0)), ratingMixed: new Set(set.map(a => a.rating || 0)).size > 1, discs: set, year: years.includes(0) ? 0 : Math.min(...years),
    uploaded_at: set.map(a => a.uploaded_at || "").sort().at(-1) || "",
    artwork: set.find(a => a.artwork)?.artwork || "", genres: [...new Set(set.flatMap(a => a.genres))].sort(),
    track_count: sum("track_count"), no_genre: sum("no_genre"), combined_genres: sum("combined_genres"),
    no_composer: sum("no_composer"), track_gaps: sum("track_gaps"), no_cover: sum("no_cover"), duplicates: sum("duplicates"),
    repeated_numbers: sum("repeated_numbers")};
}

// The album IDs behind one album in the lists: every disc of its set, or just itself.
const itemIds = item => (item.discs || [item]).map(a => String(a.id));
function shelfIds(id) {
  const album = state.albums.find(a => String(a.id) === String(id)), set = album && discSet(album);
  return set ? set.map(a => String(a.id)) : [String(id)];
}

// Full albums of one set as one album, tracks in disc order, for the album page and playback.
const joinDiscs = albums => albums.length === 1 ? albums[0]
  : {...albums[0], artwork: albums.find(a => a.artwork)?.artwork || "", tracks: albums.flatMap(a => a.tracks)};

function thumb(album) {
  const art = album.artwork ? `<img src="${escapeHtml(album.artwork.replace(/-300$/, "-150"))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-error="remove">` : "";
  return `<span class="thumb" style="--cover-color:${album.color}">${art}<span>${escapeHtml(initials(album.artist))}</span></span>`;
}

function avatar(name, image) {
  const img = image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-error="remove">` : "";
  return `<span class="artist-avatar">${img}${escapeHtml(initials(name))}</span>`;
}

function artistGroups() {
  const groups = new Map(), ratings = new Map();
  for (const album of albumShelf()) for (const name of new Set(albumArtistEntries(album).map(a => a.name))) {
    const artist = albumArtistEntries(album).find(a => a.name === name);
    const group = groups.get(name) || {count: 0, image: artist.image || "", ids: new Set()};
    group.image ||= artist.image || ""; group.count += 1; groups.set(name, group);
  }
  for (const album of state.albums) for (const artist of albumArtistEntries(album)) {
    if (Number(artist.id) > 0) { groups.get(artist.name)?.ids.add(String(artist.id)); ratings.set(String(artist.id), artist.rating || 0); }
  }
  return [...groups].map(([name, group]) => [name, {...group, ids: [...group.ids].sort((a, b) => Number(a) - Number(b)),
    rating: group.ids.size ? Math.min(...[...group.ids].map(id => ratings.get(id) || 0)) : 0}]).sort((a, b) => a[0].localeCompare(b[0]));
}

function setArtist(artist) {
  state.artist = artist; state.selected.clear(); state.page = 0;
  $("#search").value = "";
  if (state.screen && state.screen !== "albums") showScreen("albums");
  render();
}

function resetAlbumOrder() {
  albumOrder.ids = []; albumOrder.library += 1;
}

function randomAlbumSummaries(albums) {
  const byId = new Map(albums.map(album => [String(album.id), album]));
  const ids = albumOrder.ids.filter(id => byId.has(id)), known = new Set(ids);
  const added = [...byId.keys()].filter(id => !known.has(id));
  for (let i = added.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [added[i], added[j]] = [added[j], added[i]];
  }
  // Shuffle the complete shelf once, before search, artist scope or paging.
  // Metadata read-backs retain existing positions and append any new albums.
  albumOrder.ids = [...ids, ...added];
  return albumOrder.ids.map(id => byId.get(id));
}

function filteredAlbums() {
  const query = $("#search").value.toLocaleLowerCase().trim(), keep = (FILTERS[$("#filter").value] || FILTERS.all)[1];
  const random = $("#sort").value === "random", all = albumShelf();
  const items = (random ? randomAlbumSummaries(all) : all).filter(a => (!state.artist || albumHasArtist(a, state.artist)) && keep(a)
    && (!query || [a.name, albumArtistsText(a), ...a.genres].join(" ").toLocaleLowerCase().includes(query)));
  return random ? items : items.sort(SORTS[$("#sort").value] || SORTS.artist);
}

function badge(a) {
  return !a.year ? `<span class="pill missing">${TagcastI18n.html("library.badge.missingYear")}</span>` : a.no_genre ? `<span class="pill missing">${TagcastI18n.html("library.badge.missingGenre")}</span>` : "";
}

function hasDuplicateTracks(album) {
  return album.repeated_numbers > 0 || album.duplicates > 0;
}

function duplicateAlbumBadge(album) {
  return hasDuplicateTracks(album) ? `<span class="pill missing" title="${TagcastI18n.html("library.badge.duplicatedTitle")}">${TagcastI18n.html("library.badge.duplicated")}</span>` : "";
}

// Markup (the disc note can hold icons); list items joined with " · ".
function albumCardMetadata(a) {
  const kind = EDITION.test(a.name) ? "library.card.edition" : "library.card.album";
  return [a.year || TagcastI18n.html("library.card.yearUnknown"), TagcastI18n.html("common.count.tracks", {count: a.track_count}),
    TagcastI18n.html(kind), discNote(a)].filter(Boolean).join(" · ");
}

const isSelected = a => itemIds(a).every(id => state.selected.has(id));
// The discs of a set as CD icons: up to six, then the number.
function discIcons(count) {
  const cd = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13zM8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z"/></svg>';
  const label = TagcastI18n.html("library.disc.count", {count});
  return `<span class="disc-icons" role="img" aria-label="${label}" title="${label}">${cd.repeat(Math.min(count, 6))}${count > 6 ? `<small>${count}</small>` : ""}</span>`;
}
const discNote = a => a.discs ? discIcons(a.discs.length) : a.disc > 1 ? TagcastI18n.html("common.disc", {disc: a.disc}) : "";

function selectBox(a) {
  return state.artist || live() ? `<label class="album-select"><input type="checkbox" data-select="${escapeHtml(a.id)}" aria-label="${TagcastI18n.html("library.select.album", {name: a.name})}" ${isSelected(a) ? "checked" : ""}></label>` : "";
}

function gridView(items) {
  return items.map(a => `<article class="album-card ${isSelected(a) ? "selected" : ""}">${selectBox(a)}<button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="${TagcastI18n.html("library.open.album", {name: a.name})}">${cover(a)}<span class="album-name">${escapeHtml(a.name)}</span><span class="album-artist">${escapeHtml(albumArtistsText(a))}</span>${hasDuplicateTracks(a) ? `<span class="album-duplicate">${duplicateAlbumBadge(a)}</span>` : ""}</button><div class="card-meta"><div class="album-card-meta-text"><span>${albumCardMetadata(a)}</span>${badge(a)}</div>${typeof albumCardActions === "function" ? albumCardActions(a) : ""}</div></article>`).join("");
}

function listView(items) {
  const genre = a => a.genres.length ? escapeHtml(a.genres.slice(0, 3).join(", ") + (a.genres.length > 3 ? " …" : "")) : "";
  const missing = a => a.no_genre ? `<span class="pill missing">${a.no_genre === a.track_count ? TagcastI18n.html("library.list.genreNone") : TagcastI18n.html("library.list.genreMissing", {count: a.no_genre})}</span>` : "";
  const selectable = state.artist || live();
  return `<table class="album-table"><thead><tr>${selectable ? `<th class="col-check" aria-label="${TagcastI18n.html("library.list.selectAlbums")}"></th>` : ""}<th class="col-thumb"></th><th>${TagcastI18n.html("library.list.album")}</th><th>${TagcastI18n.html("library.list.albumArtist")}</th><th class="col-num">${TagcastI18n.html("library.list.year")}</th><th class="col-num">${TagcastI18n.html("library.list.tracks")}</th><th>${TagcastI18n.html("library.list.genre")}</th><th aria-label="${TagcastI18n.html("library.list.playOrQueue")}"></th></tr></thead><tbody>${items.map(a => `<tr class="${isSelected(a) ? "selected" : ""}">${selectable ? `<td class="col-check">${selectBox(a)}</td>` : ""}<td class="col-thumb"><button class="row-open" data-album="${escapeHtml(a.id)}" aria-label="${TagcastI18n.html("library.open.album", {name: a.name})}">${thumb(a)}</button></td><td><button class="row-open row-title" data-album="${escapeHtml(a.id)}">${escapeHtml(a.name)}</button> ${duplicateAlbumBadge(a)}${discNote(a) ? ` <span class="muted">· ${discNote(a)}</span>` : ""}</td><td>${albumArtistLinks(a)}</td><td class="col-num">${a.year || '<span class="pill missing">—</span>'}</td><td class="col-num">${a.track_count}</td><td>${genre(a)} ${missing(a)}</td><td>${typeof albumCardActions === "function" ? albumCardActions(a) : ""}</td></tr>`).join("")}</tbody></table>`;
}

function render() {
  if (typeof syncMetadataExport === "function") syncMetadataExport();
  renderLibrary();
  if (typeof renderAlbumView === "function") renderAlbumView();
  if (typeof renderArtistBrowse === "function") renderArtistBrowse();
  if (typeof renderArtistProfile === "function") renderArtistProfile();
  if (typeof renderTrackSearch === "function") renderTrackSearch();
  if (typeof renderFavourites === "function") renderFavourites();
  if (typeof renderFavouriteArtists === "function") renderFavouriteArtists();
  if (typeof renderRecentlyPlayed === "function") renderRecentlyPlayed();
  if (typeof renderAlbumGuide === "function") renderAlbumGuide();
  if (typeof renderCollections === "function" && collectionsView.details !== state.details) renderCollections();
  if (typeof renderBrowse === "function") renderBrowse();
  if (typeof updateRandomControls === "function") updateRandomControls();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
  if (typeof syncHistory === "function") syncHistory();
  if (typeof syncAudioDownloadsPage === "function") syncAudioDownloadsPage();
}

// The album shelf with its header, counts, selection and pagination, from memory only.
// A language change repaints just this part (relabel keeps an artist page title, which
// artists.js decorates with the favourite heart; the artist name itself is never translated).
function renderLibrary(relabel = false) {
  const scope = albumShelf().filter(a => !state.artist || albumHasArtist(a, state.artist));
  syncBrowseChoices("albums", Object.entries(FILTERS).map(([value, [label, keep]]) => ({value, label: TagcastI18n.text(label), count: scope.filter(keep).length})), albumSortLabels, "artist");
  $("#cleanup-filter").hidden = !live() || $("#filter").value !== "combined";
  $("#duplicate-cleanup-open").hidden = !live() || $("#filter").value !== "duplicates";
  $("#browse-artist-count").textContent = TagcastI18n.number(artistGroups().length);
  $("#total-albums").textContent = $("#album-count").textContent = TagcastI18n.number(albumShelf().length);
  const trackCount = state.albums.reduce((sum, a) => sum + a.track_count, 0);
  $("#track-count").textContent = TagcastI18n.number(trackCount);
  $("#total-tracks").textContent = TagcastI18n.text("library.total.tracks", {count: trackCount});
  $("#history-count").textContent = state.history.length;
  if (!state.screen || state.screen === "albums") $("#breadcrumb").textContent = state.artist || TagcastI18n.text("library.page.breadcrumb");
  if (!relabel || !state.artist) $("#page-title").textContent = state.artist || TagcastI18n.text("library.page.title");
  $("#page-eyebrow").textContent = TagcastI18n.text(state.artist ? "library.page.eyebrowArtist" : "library.page.eyebrow");
  renderArtistPanel();
  $("#page-subtitle").textContent = TagcastI18n.text($("#filter").value === "duplicates" ? "library.page.subtitleDuplicates"
    : state.artist ? "library.page.subtitleArtist" : live() ? "library.page.subtitleLive" : "library.page.subtitleDemo");
  $("#selection-help").textContent = TagcastI18n.text(state.artist ? "library.selection.helpArtist" : live() ? "library.selection.helpLive" : "library.selection.helpDemo");
  $("#all-albums").classList.toggle("active", !state.artist && (!state.screen || state.screen === "albums"));
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  const items = filteredAlbums(), size = pageSize(), maxPage = Math.max(0, Math.ceil(items.length / size) - 1);
  $("#per-page").value = String(size);
  state.page = Math.min(state.page, maxPage);
  $("#results-count").textContent = state.artist ? TagcastI18n.text("library.results.byArtist", {count: items.length, artist: state.artist})
    : TagcastI18n.text("library.results.collection", {count: items.length});
  const page = items.slice(state.page * size, (state.page + 1) * size);
  $("#albums").className = state.view === "list" ? "album-list" : "album-grid";
  $("#albums").innerHTML = (page.length ? (state.view === "list" ? listView(page) : gridView(page)) : "") || (state.loading ? `<div class="empty"><span class="spinner"></span>${TagcastI18n.html("library.empty.loading")}</div>` : `<div class="empty">${TagcastI18n.html("library.empty.noMatch")}</div>`);
  $("#select-page").checked = page.length > 0 && page.every(isSelected);
  $("#select-page").indeterminate = page.some(isSelected) && !page.every(isSelected);
  $("#select-page").disabled = !page.length || saving || checking > 0;
  $("#select-page-label").textContent = TagcastI18n.text(page.length && page.every(isSelected) ? "library.selectPage.deselect" : "library.selectPage.select", {count: page.length});
  $("#selection-bar").hidden = !state.selected.size;
  if (typeof updateAlbumMergeControls === "function") updateAlbumMergeControls();
  if (typeof updateSelectedAlbumTagControls === "function") updateSelectedAlbumTagControls();
  $("#trash-selection").hidden = !live();
  $("#download-selection").hidden = !live();
  $("#download-selection").disabled = saving || checking > 0 || state.loading || !state.selected.size;
  $("#trash-selection").disabled = saving || checking > 0 || !state.selected.size;
  $("#edit-selection").hidden = !state.artist;
  const chosen = albumShelf().filter(a => itemIds(a).some(id => state.selected.has(id)));
  const visible = new Set(items), outside = chosen.filter(a => !visible.has(a)).length;
  $("#selection-count").textContent = [TagcastI18n.text("library.selection.count", {count: chosen.length}), state.artist,
    outside ? TagcastI18n.text("library.selection.outside", {count: outside}) : ""].filter(Boolean).join(" · ");
  $("#pagination").innerHTML = maxPage > 0 ? `<button class="button small" data-page="-1" ${state.page === 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${TagcastI18n.html("common.pagination.pageCounted", {page: state.page + 1, pages: maxPage + 1})}</span><button class="button small" data-page="1" ${state.page === maxPage ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button>` : "";
}

// On an artist's page the artist image takes the place of the library total.
function renderArtistPanel() {
  const panel = $("#artist-panel"), albums = state.artist ? albumShelf().filter(a => albumHasArtist(a, state.artist)) : [];
  $("#library-total").hidden = Boolean(state.artist);
  panel.hidden = !state.artist;
  if (!state.artist) return;
  const people = albums.flatMap(albumArtistEntries).filter(a => a.name === state.artist);
  const imageArtist = people.find(a => a.image), image = imageArtist?.image || "";
  const imageArtistId = Number(imageArtist?.id) > 0 ? String(imageArtist.id) : String(people.find(a => Number(a.id) > 0)?.id || "");
  const canChange = live() && people.some(a => Number(a.id) > 0);
  const photo = `${image ? `<img src="${escapeHtml(image.replace(/-150$/, "-300"))}" alt="" referrerpolicy="no-referrer" data-image-error="remove">` : ""}<span>${escapeHtml(initials(state.artist))}</span>`;
  panel.innerHTML = `${canChange ? `<button type="button" class="artist-photo image-edit-button" id="change-artist-page-image" data-artist-page-image-id="${escapeHtml(imageArtistId)}" aria-label="${TagcastI18n.html(image ? "library.artistImage.changeFor" : "library.artistImage.addFor", {artist: state.artist})}">${photo}<span class="image-edit-label">${TagcastI18n.html(image ? "library.artistImage.change" : "library.artistImage.add")}</span></button>` : `<div class="artist-photo">${photo}</div>`}`;
}

// The album after this one in the current list, for working through a filter.
function nextAlbumId(id) {
  const items = filteredAlbums(), index = items.findIndex(a => itemIds(a).includes(String(id)));
  return index >= 0 && index + 1 < items.length ? String(items[index + 1].id) : null;
}

function common(items, key) {
  const values = [...new Set(items.map(i => i[key]))];
  return values.length === 1 ? values[0] : "";
}

function numberInputAttributes(key, value) {
  if (key !== "year") return 'min="0" max="9999" step="1"';
  // Allow an existing bad year to remain untouched while editing other metadata.
  const original = Number(value || 0);
  return `min="${Math.min(0, original)}" max="${Math.max(2050, original)}" step="1" data-original-year="${original}"`;
}

// "Change <field>" for a bulk checkbox; label is already escaped markup text.
const changeFieldLabel = label => TagcastI18n.html("editor.field.change", {field: TagcastI18n.trusted(label)});

// label and hint are escaped interface text (TagcastI18n.html); placeholder is plain text.
function field(name, label, value, options = {}) {
  const {type = "text", wide = false, hint = "", bulk = false, placeholder = ""} = options;
  return `<div class="field ${wide ? "wide" : ""}">${bulk ? `<label class="field-check"><input type="checkbox" aria-label="${changeFieldLabel(label)}" data-enable="${name}"> ${label}</label>` : `<span>${label}</span>`}<input aria-label="${label}" name="${name}" type="${type}" value="${escapeHtml(value || "")}" ${type === "number" ? numberInputAttributes(name, value) : 'maxlength="1000"'} placeholder="${escapeHtml(placeholder)}" ${bulk ? "disabled" : ""}>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

function albumArtistField(albums, bulk) {
  const various = albums.every(a => a.artist_id === 0 && a.artist === "Various Artists");
  const value = various ? "" : common(albums, "artist");
  const label = TagcastI18n.html("editor.field.albumArtist");
  return `<div class="field wide">${bulk ? `<label class="field-check"><input type="checkbox" aria-label="${changeFieldLabel(label)}" data-enable="artist"> ${label}</label>` : `<span>${label}</span>`}${artistChoiceInput(`aria-label="${label}" name="artist" type="text" maxlength="1000" value="${escapeHtml(value)}" placeholder="${TagcastI18n.html("editor.field.albumArtistPlaceholder")}" ${bulk || various ? "disabled" : ""} ${various ? "hidden" : ""}`, bulk || various)}<label class="checkline"><input type="checkbox" id="album-various-artists" ${various ? "checked" : ""} ${bulk ? "disabled" : ""}> Various Artists</label><small>${TagcastI18n.html("editor.field.albumArtistHint")}</small><small id="album-various-artists-note" role="status" hidden>${TagcastI18n.html("editor.field.variousArtistsNote")}</small></div>`;
}

// Reuse already loaded names; only a small matching list enters the DOM.
const editorArtistChoices = {albums: null, names: null, labels: null, indexes: new Map(), values: [], input: null, results: [], active: -1, details: null, draft: null};

// Interface text keys of the name suggestions, per kind of name.
const editorChoiceTexts = {
  artist: {show: "editor.choices.showArtists", menu: "editor.choices.existingArtists", choose: "editor.choices.chooseArtist", none: "editor.choices.noArtist"},
  genre: {show: "editor.choices.showGenres", menu: "editor.choices.existingGenres", choose: "editor.choices.chooseGenre", none: "editor.choices.noGenre"},
  composer: {show: "editor.choices.showComposers", menu: "editor.choices.existingComposers", choose: "editor.choices.chooseComposer", none: "editor.choices.noComposer"}};
const editorChoiceText = kind => editorChoiceTexts[kind === "genre" || kind === "composer" ? kind : "artist"];

function artistChoiceInput(attributes, disabled = false, kind = "artist") {
  return `<span class="artist-choice"><input ${attributes} role="combobox" aria-autocomplete="list" aria-controls="editor-artist-names" aria-expanded="false" data-artist-suggestions data-editor-choice-kind="${kind}" autocomplete="off"><button type="button" class="artist-choice-toggle" data-artist-choices-toggle aria-label="${TagcastI18n.html(editorChoiceText(kind).show)}" aria-haspopup="listbox" aria-controls="editor-artist-names" ${disabled ? "disabled" : ""}>▾</button></span>`;
}

function applyEditorNames(names) {
  state.editorNames = {genres: Array.isArray(names?.genres) ? names.genres : [],
    composers: Array.isArray(names?.composers) ? names.composers : []};
  resetEditorArtistChoices();
}

function closeEditorArtistChoices() {
  editorArtistChoices.input?.setAttribute("aria-expanded", "false");
  editorArtistChoices.input?.removeAttribute("aria-activedescendant");
  Object.assign(editorArtistChoices, {input: null, results: [], active: -1, details: null, draft: null});
  $("#editor-artist-names").hidden = true;
}

function resetEditorArtistChoices() {
  closeEditorArtistChoices();
  Object.assign(editorArtistChoices, {albums: null, names: null, labels: null, indexes: new Map(), values: []});
  $("#editor-artist-names").innerHTML = "";
}

function fillEditorArtistChoices(input, all = false) {
  if (!editing || !$("#editor").open || state.loading || input.disabled || input.hidden
      || !input.matches?.("[data-artist-suggestions]") || !input.closest("#metadata-form")) return;
  if (editorArtistChoices.input !== input) closeEditorArtistChoices();
  const kind = input.dataset?.editorChoiceKind || "artist";
  if (editorArtistChoices.albums !== state.albums || editorArtistChoices.names !== state.artistNames
      || editorArtistChoices.labels !== state.editorNames) {
    editorArtistChoices.indexes.clear(); editorArtistChoices.albums = state.albums;
    editorArtistChoices.names = state.artistNames; editorArtistChoices.labels = state.editorNames;
  }
  if (!editorArtistChoices.indexes.has(kind)) {
    const names = new Set(kind === "genre" ? state.editorNames.genres
      : kind === "composer" ? state.editorNames.composers : state.artistNames);
    if (kind === "artist") for (const album of state.albums) for (const artist of albumArtistEntries(album)) names.add(artist.name);
    // Fully loaded details also support old local servers and the preview; never load more.
    if (kind !== "artist" || !live()) for (const album of state.details.values()) for (const track of album.tracks) {
      if (kind === "genre") for (const name of trackGenres(track)) names.add(name);
      else if (kind === "composer") for (const name of track.composers || []) names.add(name);
      else { names.add(track.artist); for (const credit of creditValues(track)) names.add(credit.name); }
    }
    const maximum = kind === "genre" ? 200 : 1000;
    editorArtistChoices.indexes.set(kind, [...names].filter(name => typeof name === "string" && name.trim() && [...name].length <= maximum)
      .sort((a, b) => a.localeCompare(b)).map(name => ({name, folded: name.toLocaleLowerCase()})));
  }
  editorArtistChoices.values = editorArtistChoices.indexes.get(kind);
  const query = all ? "" : input.value.trim().toLocaleLowerCase(), matches = [];
  for (const entry of editorArtistChoices.values) {
    if (entry.folded.includes(query)) matches.push(entry.name);
    if (matches.length === 40) break;
  }
  Object.assign(editorArtistChoices, {input, results: matches, active: -1, details: state.details, draft: editing});
  const menu = $("#editor-artist-names"), texts = editorChoiceText(kind);
  menu.setAttribute("aria-label", TagcastI18n.text(texts.menu));
  menu.innerHTML = matches.map((name, index) => `<button type="button" role="option" aria-selected="false" tabindex="-1" id="editor-artist-choice-${index}" data-artist-choice="${index}">${escapeHtml(name)}</button>`).join("")
    + `<p class="muted">${TagcastI18n.html(matches.length === 40 ? "editor.choices.limit" : matches.length ? texts.choose : texts.none)}</p>`;
  input.removeAttribute("aria-activedescendant"); input.setAttribute("aria-expanded", "true");
  const anchor = input.getBoundingClientRect(), width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  const below = height - anchor.bottom - 8, above = anchor.top - 8, down = below >= Math.min(240, above);
  menu.style.width = `${Math.max(0, Math.min(anchor.width, width - 16))}px`;
  menu.style.maxHeight = `${Math.max(60, Math.min(240, down ? below : above))}px`;
  menu.style.left = `${Math.max(8, Math.min(anchor.left, width - anchor.width - 8))}px`;
  menu.hidden = false; menu.scrollTop = 0;
  menu.style.top = `${Math.max(8, down ? anchor.bottom + 4 : anchor.top - menu.getBoundingClientRect().height - 4)}px`;
}

function chooseEditorArtist(index) {
  const choices = editorArtistChoices, input = choices.input, name = choices.results[index];
  if (!name || !input?.isConnected || input.disabled || input.hidden || state.loading || !$("#editor").open
      || choices.details !== state.details || choices.draft !== editing) { closeEditorArtistChoices(); return; }
  const labels = input.closest(".genre-input");
  if (labels) {
    try {
      const values = getGenres(labels);
      if (!values.some(value => value.toLocaleLowerCase() === name.toLocaleLowerCase())) setGenres(labels, [...values, name]);
      else genreValidation(labels, "");
      input.value = ""; showTrackGenres();
    } catch (error) { toast(TagcastI18n.errorText(error)); return; }
  } else {
    input.value = name;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }
  input.focus(); closeEditorArtistChoices();
}

for (const type of ["focusin", "input"]) document.addEventListener(type, event => {
  if (event.target.matches?.("[data-artist-suggestions]")) fillEditorArtistChoices(event.target);
  else if (type === "focusin" && !event.target.closest?.("#editor-artist-names")) closeEditorArtistChoices();
});
document.addEventListener("pointerdown", event => {
  if (event.target.closest?.("[data-artist-choice], [data-artist-choices-toggle]")) event.preventDefault();
});
document.addEventListener("click", event => {
  const toggle = event.target.closest("[data-artist-choices-toggle]"), choice = event.target.closest("[data-artist-choice]");
  if (toggle) { const input = toggle.closest(".artist-choice").querySelector("input"); input.focus(); fillEditorArtistChoices(input, true); }
  else if (choice) chooseEditorArtist(Number(choice.dataset.artistChoice));
  else if (!event.target.closest("[data-artist-suggestions], #editor-artist-names")) closeEditorArtistChoices();
});
function editorArtistChoiceKey(event) {
  if (event.defaultPrevented) return true;
  const input = event.target;
  if (!input.matches?.("[data-artist-suggestions]")) return;
  const choices = editorArtistChoices, opened = choices.input === input && !$("#editor-artist-names").hidden;
  if (["Escape", "Tab"].includes(event.key)) {
    if (opened && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    closeEditorArtistChoices(); return opened && event.key === "Escape";
  }
  if (event.key === "Enter" && opened && choices.active >= 0) {
    event.preventDefault(); chooseEditorArtist(choices.active); return true;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  if (!opened) fillEditorArtistChoices(input);
  if (!choices.results.length) return true;
  choices.active = event.key === "ArrowDown" ? (choices.active + 1) % choices.results.length
    : (choices.active < 0 ? choices.results.length - 1 : (choices.active - 1 + choices.results.length) % choices.results.length);
  const id = `editor-artist-choice-${choices.active}`;
  input.setAttribute("aria-activedescendant", id);
  for (const [index, option] of [...$("#editor-artist-names").querySelectorAll("[data-artist-choice]")].entries()) option.setAttribute("aria-selected", String(index === choices.active));
  $(`#${id}`)?.scrollIntoView({block: "nearest"});
  return true;
}
document.addEventListener("keydown", editorArtistChoiceKey);
window.addEventListener("scroll", event => { if (!event.target.closest?.("#editor-artist-names, .artist-choice")) closeEditorArtistChoices(); }, true);
window.addEventListener("resize", closeEditorArtistChoices);

function syncAlbumArtistControls() {
  if (!editing) return;
  const form = $("#metadata-form"), box = $("#album-various-artists");
  if (!form || !box) return;
  const enabled = !editing.bulk || Boolean(form.querySelector('[data-enable="artist"]')?.checked);
  box.disabled = !enabled;
  // Match the native clearing rule in buildReview; keep hidden credit drafts intact.
  const clearsCredits = live() && enabled && box.checked && (editing.bulk || editing.dirty.has("artist"));
  const credits = form.querySelector('[data-credit-editor="album-credits"]');
  if (credits) credits.hidden = clearsCredits;
  $("#album-various-artists-note").hidden = !clearsCredits;
  const input = form.elements.namedItem("artist");
  if (input) {
    input.hidden = box.checked; input.disabled = !enabled || box.checked;
    const wrapper = input.closest?.(".artist-choice"), toggle = wrapper?.querySelector("[data-artist-choices-toggle]");
    if (wrapper) wrapper.hidden = box.checked;
    if (toggle) toggle.disabled = input.disabled;
    closeEditorArtistChoices();
  }
}

async function openEditor(ids) {
  if (opening) return;
  const chosen = ids.map(id => state.albums.find(a => String(a.id) === String(id))).filter(Boolean);
  if (!chosen.length) return;
  // All discs of one set are edited as one album; each disc is still saved as its own album.
  const set = chosen.length > 1 ? discSet(chosen[0]) : null;
  const whole = Boolean(set && set.length === chosen.length && set.every(d => chosen.includes(d)));
  if (chosen.length > 1 && !whole && (!state.artist || chosen.some(a => !albumHasArtist(a, state.artist)))) {
    toast(TagcastI18n.text("editor.open.oneArtist")); return;
  }
  let albums;
  const details = state.details, loadRequest = libraryLoadRequest;
  opening = true; document.body.classList.add("busy");
  try {
    albums = await albumDetails(chosen.map(a => String(a.id)));
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    toast(TagcastI18n.text("editor.open.failed", {error: TagcastI18n.errorText(error)})); return;
  } finally { opening = false; document.body.classList.remove("busy"); }
  if (details !== state.details || loadRequest !== libraryLoadRequest) {
    toast(TagcastI18n.text("editor.open.libraryChanged")); return;
  }
  if (albums.length !== chosen.length) { toast(TagcastI18n.text("editor.open.albumMissing")); return; }
  if (whole) albums.sort((a, b) => (a.disc || 0) - (b.disc || 0));
  const album = albums[0], bulk = albums.length > 1 && !whole, single = !bulk;
  editing = {ids: albums.map(a => String(a.id)), originals: structuredClone(albums), trackPatches: {}, bulk, set: whole, tab: "album", dirty: new Set()};
  resetEditorArtistChoices();
  const allTracks = albums.flatMap(a => a.tracks);
  // Two discs of one set with one disc number would no longer be a set.
  const sameSet = bulk && albums.some(a => (discSet(a) || []).filter(d => editing.ids.includes(String(d.id))).length > 1);
  const mixed = key => whole && !common(albums, key) && albums.some(a => a[key]) ? {placeholder: TagcastI18n.text("editor.field.mixedDiscs")} : {};
  const noGenre = TagcastI18n.html("editor.track.noGenre");
  const trackRow = t => `<tr data-row="${escapeHtml(t.id)}"><td>${live() ? `<button type="button" class="play" data-play="${escapeHtml(t.id)}" aria-label="${TagcastI18n.html("editor.track.play", {title: t.title})}">▶</button>` : ""}${t.track || "–"}</td><td>${escapeHtml(t.title)}${t.composers?.length ? `<small class="track-composer">${escapeHtml(t.composers.join(", "))}</small>` : ""}</td><td>${t.year || "–"} / <span data-genre-cell="${escapeHtml(t.id)}" class="${hasCombined(t.genres) ? "combined" : ""}">${genresText(t.genres) ? escapeHtml(genresText(t.genres)) : noGenre}</span></td><td><button type="button" class="track-edit" data-track="${escapeHtml(t.id)}">${TagcastI18n.html("editor.track.edit")}</button></td></tr>`;
  const trackRows = whole ? albums.map(a => `<tr class="disc-row"><td colspan="4">${TagcastI18n.html("common.disc", {disc: a.disc || "?"})}</td></tr>${a.tracks.map(trackRow).join("")}`).join("") : album.tracks.map(trackRow).join("");
  const editorTabs = bulk ? "" : `<div id="editor-tabs" class="favourites-tabs editor-tabs" role="tablist" aria-label="${TagcastI18n.html("editor.tabs.label")}"><button type="button" id="editor-tab-album" role="tab" data-editor-tab="album" aria-selected="true" aria-controls="editor-album-panel" tabindex="0">${TagcastI18n.html("editor.editAlbum")}</button><button type="button" id="editor-tab-tracks" role="tab" data-editor-tab="tracks" aria-selected="false" aria-controls="editor-tracks-panel" tabindex="-1">${TagcastI18n.html("editor.tabs.tracks")} <span>${allTracks.length}</span></button></div>`;
  const trackPanel = bulk ? '<div id="track-inline"></div>' : `<section id="editor-tracks-panel" role="tabpanel" aria-labelledby="editor-tab-tracks" hidden><div class="tracks-heading"><h3>${TagcastI18n.html("editor.tracks.heading")} <span class="muted">(${allTracks.length})</span></h3><span class="muted">${TagcastI18n.html("editor.tracks.choose")}</span></div><div class="editor-track-workspace"><div class="editor-track-list"><table class="track-table"><thead><tr><th>#</th><th>${TagcastI18n.html("editor.tracks.columnTitle")}</th><th>${TagcastI18n.html("editor.tracks.columnYearGenre")}</th><th></th></tr></thead><tbody>${trackRows}</tbody></table></div><div id="track-inline"><p class="empty">${TagcastI18n.html("editor.tracks.empty")}</p></div></div></section>`;
  const eyebrow = whole ? TagcastI18n.html("editor.eyebrow.set", {count: albums.length}) : TagcastI18n.html(bulk ? "editor.eyebrow.bulk" : "editor.eyebrow.album");
  const help = TagcastI18n.html("editor.help.album"), dot = ' <span aria-hidden="true">·</span> ';
  const discText = whole ? TagcastI18n.html("library.disc.count", {count: albums.length})
    : discLabel(album) ? escapeHtml(discLabel(album)) : album.disc ? TagcastI18n.html("common.disc", {disc: album.disc}) : TagcastI18n.html("editor.header.discUnknown");
  const combined = allTracks.filter(t => hasCombined(t.genres));
  const scope = whole ? TagcastI18n.html("editor.scope.set", {count: albums.length}) : bulk ? TagcastI18n.html("editor.scope.bulk", {count: albums.length}) : TagcastI18n.html("editor.scope.album");
  const sources = bulk ? `<aside class="sources"><div class="eyebrow">${TagcastI18n.html("editor.selection.eyebrow")}</div><h3>${TagcastI18n.html("editor.selection.heading")}</h3>` + albums.map(a => `<p class="muted">${escapeHtml(a.name)}${discLabel(a) ? ` · ${escapeHtml(discLabel(a))}` : ""}</p>`).join("") + `<div class="year-note"><strong>${TagcastI18n.html("editor.selection.lookupHeading")}</strong>${TagcastI18n.html("editor.selection.lookupNote")}</div></aside>` : lookupPanel(album);
  $("#editor-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${eyebrow}</div><h2>${TagcastI18n.html(bulk ? "editor.heading.bulk" : "editor.editAlbum")}</h2></div><div class="dialog-heading-actions"><button type="button" class="button small help-trigger" data-help-context="editing" aria-label="${help}" title="${help}">?</button><button class="close" data-close="editor" aria-label="${TagcastI18n.html("editor.close")}">×</button></div></div><div class="album-header">${bulk || !live() ? cover(album, true) : `<button class="cover-button" id="change-cover" title="${TagcastI18n.html("editor.cover.changeTitle")}">${cover(album, true)}<span>${TagcastI18n.html("editor.cover.change")}</span></button>`}<div><h3>${bulk ? TagcastI18n.html("editor.bulk.heading", {count: albums.length, artist: state.artist || album.artist}) : escapeHtml(album.name)}</h3><div class="muted">${escapeHtml(album.artist)}${dot}${TagcastI18n.html("editor.header.tracks", {count: allTracks.length})}${whole || !bulk ? `${dot}${discText}` : ""}${!bulk && !whole && discSet(album) ? ` <button class="text-action" data-edit-set="${escapeHtml(album.id)}">${TagcastI18n.html("editor.header.editSet", {count: discSet(album).length})}</button>` : ""}</div><div class="header-actions"><span class="pill">${TagcastI18n.html(live() ? "editor.header.live" : "editor.header.sample")}</span>${live() && single ? `<button class="text-action" data-play-album>${TagcastI18n.html("editor.header.playAlbum")}</button>${album.artist_id ? `<button class="text-action" id="change-artist-image">${avatar(album.artist, album.artist_image)}${TagcastI18n.html("editor.header.artistImage")}</button>` : ""}` : ""}</div></div></div>${editorTabs}<div class="edit-layout" id="editor-layout"><form id="metadata-form"><section id="editor-album-panel" ${bulk ? "" : 'role="tabpanel" aria-labelledby="editor-tab-album"'}><div class="fields">${bulk ? "" : field("name", TagcastI18n.html("editor.field.albumTitle"), whole ? common(albums, "name") : album.name, {wide: true, ...mixed("name")})}${albumArtistField(albums, bulk)}${creditsField(albums[0], {album: true, bulk: bulk || !albums.every(a => sameValue(a.credits || [], albums[0].credits || [])), mixed: !albums.every(a => sameValue(a.credits || [], albums[0].credits || []))})}${field("year", TagcastI18n.html("editor.field.releaseYear"), common(albums, "year"), {type: "number", bulk, hint: TagcastI18n.html("editor.field.releaseYearHint"), ...mixed("year")})}${whole || sameSet ? "" : field("disc", TagcastI18n.html("editor.field.discNumber"), common(albums, "disc"), {type: "number", bulk})}${genreField("genres", TagcastI18n.html("editor.field.genres"), allTracks.every(t => sameValue(t.genres, allTracks[0].genres)) ? allTracks[0].genres : [], {bulk, mixed: !allTracks.every(t => sameValue(t.genres, allTracks[0].genres)), hint: TagcastI18n.html("editor.field.genresHint")})}${combined.length ? `<p class="genre-note wide">${TagcastI18n.html("editor.genres.combinedNote", {count: combined.length, example: combined[0].genres.find(g => g.includes(";"))})} <button type="button" class="text-action" data-split-album-genres>${TagcastI18n.html("editor.genres.split")}</button></p>` : ""}${genreField("composers", TagcastI18n.html("editor.field.composers"), allTracks.every(t => sameValue(t.composers, allTracks[0].composers)) ? allTracks[0].composers : [], {bulk, ordered: false, noun: "composer", mixed: !allTracks.every(t => sameValue(t.composers, allTracks[0].composers)), hint: TagcastI18n.html("editor.field.composersHint")})}</div><label class="checkline"><input type="checkbox" id="track-years"> ${TagcastI18n.html("editor.field.trackYears")}</label><div class="scope-note">${scope}</div></section>${trackPanel}</form>${sources}</div><div class="dialog-footer"><span class="muted">${TagcastI18n.html(live() ? "editor.footer.live" : "editor.footer.demo")}</span><button class="button" data-close="editor">${TagcastI18n.html("common.cancel")}</button>${bulk ? "" : `<button class="button" id="next-album" ${nextAlbumId(album.id) ? "" : "disabled"}>${TagcastI18n.html("editor.footer.nextAlbum")}</button>`}<button class="button primary" id="review-button">${TagcastI18n.html("editor.footer.review")}</button></div>`;
  $("#metadata-form").addEventListener("submit", e => e.preventDefault());
  // A mixed disc-set year is a blank placeholder, not an instruction to clear tracks.
  $("#track-years").checked = metadataEditingDefaults.applyYearToTracks && !bulk
    && albums.every(a => a.year === album.year);
  const various = albums.map(a => a.artist_id === 0 && a.artist === "Various Artists");
  $("#album-various-artists").checked = various.every(Boolean);
  $("#album-various-artists").indeterminate = various.some(Boolean) && !various.every(Boolean);
  syncAlbumArtistControls();
  $("#editor").showModal();
  if (!bulk) setEditorTab("album");
  if (!bulk) startLookups(album);
}

function setEditorTab(tab, focus = false) {
  if (!editing || editing.bulk || !["album", "tracks"].includes(tab) || !$("#editor").open) return;
  closeEditorArtistChoices();
  editing.tab = tab;
  for (const kind of ["album", "tracks"]) {
    const selected = kind === tab, button = $(`#editor-tab-${kind}`);
    button.setAttribute("aria-selected", String(selected));
    button.setAttribute("tabindex", selected ? "0" : "-1");
    $(`#editor-${kind}-panel`).hidden = !selected;
  }
  $("#editor-layout").classList.toggle("editing-tracks", tab === "tracks");
  const sources = $("#editor .sources");
  if (sources) sources.hidden = tab === "tracks";
  const help = $("#editor .help-trigger");
  if (help) {
    help.dataset.helpContext = tab === "tracks" ? "editing-tracks" : "editing";
    help.setAttribute("aria-label", TagcastI18n.text(tab === "tracks" ? "editor.help.tracks" : "editor.help.album"));
    help.title = TagcastI18n.text(tab === "tracks" ? "editor.help.tracks" : "editor.help.album");
  }
  if (tab === "tracks" && typeof renderLyrics === "function") renderLyrics("track");
  if (focus) $(`#editor-tab-${tab}`).focus({preventScroll: true});
}

function readNumber(value) {
  if (value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw editorFailure("errors.editor.number_range");
  return n;
}

// The error message stays English; show it with TagcastI18n.errorText(error).
function readYear(value) {
  const n = Number(value || 0);
  if (!Number.isInteger(n) || (n !== 0 && (n < 1800 || n > 2050))) {
    throw editorFailure("errors.editor.year_range");
  }
  return n;
}

function readMetadataNumber(key, value, before) {
  if (key !== "year") return readNumber(value);
  return Number(value || 0) === before ? before : readYear(value);
}

function validateYearInput(input) {
  let message = "";
  try { readMetadataNumber("year", input.value, Number(input.dataset.originalYear)); }
  catch (error) { message = TagcastI18n.errorText(error); }
  input.setCustomValidity?.(message);
}

function stashTrack() {
  const pane = $("#track-inline");
  if (!pane?.dataset.track) return;
  const original = editing.originals.flatMap(a => a.tracks).find(t => String(t.id) === pane.dataset.track);
  const data = {};
  for (const input of pane.querySelectorAll("input[data-key]")) {
    if (input.dataset.key === "year" && input.validity?.badInput) {
      throw editorFailure("errors.editor.year_range");
    }
    data[input.dataset.key] = input.type === "number" ? readMetadataNumber(input.dataset.key, input.value, original[input.dataset.key]) : input.value.trim();
  }
  const genres = pane.querySelector('[data-genres="track-genres"]');
  if (genres) { commitTyped(genres); data.genres = getGenres(genres); }
  const composers = pane.querySelector('[data-genres="track-composers"]');
  if (composers) { commitTyped(composers); data.composers = getGenres(composers); }
  const credits = pane.querySelector('[data-credit-editor="track-credits"]');
  if (credits && (credits.dataset.dirty === "true" || editing.trackPatches[pane.dataset.track]?.credits)) data.credits = readCredits(credits);
  if (!data.title) throw editorFailure("errors.editor.track_title_empty");
  editing.trackPatches[pane.dataset.track] = Object.fromEntries(Object.entries(data).filter(([key, value]) => !sameValue(original[key], value)));
}

function editTrack(id) {
  try { stashTrack(); } catch (error) { toast(TagcastI18n.errorText(error)); return; }
  showTrackGenres();
  const original = editing.originals.flatMap(a => a.tracks).find(t => String(t.id) === id);
  if (!original) return;
  setEditorTab("tracks");
  const track = {...original, ...(editing.trackPatches[id] || {})};
  const pane = $("#track-inline"); pane.dataset.track = id;
  const fields = [["title", "editor.track.titleField", "text"], ["artist", "editor.track.artistField", "text"], ["year", "editor.track.yearField", "number"], ["track", "editor.track.numberField", "number"]];
  pane.innerHTML = `<div class="track-inline"><h3>${TagcastI18n.html("editor.track.heading", {number: original.track, title: original.title})}</h3><div class="fields">${fields.map(([key, labelKey, type]) => {
    const label = TagcastI18n.html(labelKey);
    return `<label class="field ${key === "title" ? "wide" : ""}"><span>${label}</span>${key === "artist" ? artistChoiceInput(`data-key="artist" aria-label="${label}" type="text" maxlength="1000" value="${escapeHtml(track.artist || "")}" placeholder="${TagcastI18n.html("editor.choices.findArtist")}"`) : `<input data-key="${key}" aria-label="${label}" type="${type}" ${type === "number" ? numberInputAttributes(key, original[key]) : 'maxlength="1000"'} value="${escapeHtml(track[key] || "")}">`}</label>`;
  }).join("")}${genreField("track-genres", TagcastI18n.html("editor.track.genresField"), track.genres || [])}${creditsField(track)}</div><section id="track-lyrics" class="track-lyrics" hidden></section><p class="muted">${TagcastI18n.html("editor.track.note")}</p></div>`;
  renderLyrics("track", lyricsSelection(original));
  for (const button of document.querySelectorAll("#editor-tracks-panel button[data-track]")) {
    button.setAttribute("aria-pressed", String(button.dataset.track === id));
    button.closest("tr")?.classList.toggle("editing-track", button.dataset.track === id);
  }
  pane.scrollIntoView({block: "start", behavior: "smooth"});
}

function buildReview() {
  try {
    try { stashTrack(); }
    catch (error) { setEditorTab("tracks"); throw error; }
    const form = $("#metadata-form");
    if (form.checkValidity?.() === false) {
      const invalid = form.querySelector(":invalid");
      setEditorTab(invalid?.closest("#editor-tracks-panel") ? "tracks" : "album");
    }
    if (!form.reportValidity()) return;
    const albumPatch = {}, trackPatch = {}, allTracks = editing.originals.flatMap(a => a.tracks);
    const various = $("#album-various-artists");
    if (various?.checked && !various.disabled && (editing.bulk || editing.dirty.has("artist"))) {
      // Native ID 0 is unambiguous even if a regular artist is named Various Artists.
      // The demo's album artist IDs are placeholders; preview the name there instead.
      if (live()) albumPatch.artist_id = 0; else albumPatch.artist = "Various Artists";
    }
    for (const key of ["name", "artist", "year", "disc"]) {
      const input = form.elements.namedItem(key);
      if (!input || input.disabled || (!editing.bulk && !editing.dirty.has(key))) continue;
      const value = input.type === "number" ? readMetadataNumber(key, input.value, common(editing.originals, key)) : input.value.trim();
      if (["name", "artist"].includes(key) && !value) throw editorFailure("errors.editor.album_fields_empty");
      if (editing.originals.every(item => item[key] === value)) continue;
      albumPatch[key] = value;
    }
    const credits = form.querySelector('[data-credit-editor="album-credits"]');
    if (albumPatch.artist_id === 0) albumPatch.credits = [];
    else if (credits && !credits.classList.contains("disabled") && credits.dataset.dirty === "true") albumPatch.credits = readCredits(credits);
    const genres = form.querySelector('[data-genres="genres"]');
    if (genres && !genres.classList.contains("disabled") && (editing.bulk || editing.dirty.has("genres"))) {
      commitTyped(genres);
      const value = getGenres(genres);
      if (!allTracks.every(t => sameValue(t.genres, value))) trackPatch.genres = value;
    }
    const composers = form.querySelector('[data-genres="composers"]');
    if (composers && !composers.classList.contains("disabled") && (editing.bulk || editing.dirty.has("composers"))) {
      commitTyped(composers);
      const value = getGenres(composers);
      if (!allTracks.every(t => sameValue(t.composers, value))) trackPatch.composers = value;
    }
    if ($("#track-years").checked) {
      if (form.elements.year.disabled) throw editorFailure("errors.editor.year_disabled");
      trackPatch.year = readYear(form.elements.year.value);
    }
    const changes = [];
    function diff(kind, item, patch, albumId) {
      const fields = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !sameValue(key === "credits" ? creditValues(item) : item[key], value)).map(([key, value]) => [key, {before: key === "credits" ? creditValues(item) : item[key], after: value}]));
      const disc = editing.set && kind === "album" ? ` · Disc ${item.disc || "?"}` : "";
      if (fields.artist_id) {
        fields.artist_id.before_name = item.artist === "Various Artists" ? "Various Artists (named artist)" : item.artist;
        fields.artist_id.after_name = "Various Artists";
      }
      if (Object.keys(fields).length) changes.push({kind, id: item.id, albumId, label: (item.name || item.title) + disc, fields});
    }
    for (const album of editing.originals) {
      diff("album", album, albumPatch, album.id);
      for (const track of album.tracks) {
        const patch = {...trackPatch, ...(editing.trackPatches[String(track.id)] || {})};
        if (Object.hasOwn(patch, "credits")) delete patch.composers;
        diff("track", track, patch, album.id);
      }
    }
    if (!changes.length) { toast(TagcastI18n.text("review.toast.noChanges")); return; }
    pending = {scope: editing.bulk ? "artist" : "album", selection: editing.originals.map(a => ({id: a.id, name: a.name, artist: a.artist})), changes};
    showReview(changes);
  } catch (error) { toast(TagcastI18n.errorText(error)); }
}

// Review and Change history render stored English data; only these labels follow the
// interface language, at render time.
const shown = value => (Array.isArray(value) ? value.map(entry => typeof entry === "object" && entry !== null
  ? `${entry.name} (${creditRoleLabels[entry.type || "artist"] || entry.type}${entry.phrase ? ` · ${entry.phrase}` : ""})` : entry).join(" · ") : value) || TagcastI18n.text("history.value.empty");
const FIELD_LABELS = {credits: "history.field.credits", name: "history.field.name", title: "history.field.title", track: "history.field.track",
  artist_id: "history.field.artistId", artist: "history.field.artist", year: "history.field.year", disc: "history.field.disc",
  genres: "history.field.genres", composers: "history.field.composers", cover: "history.field.cover", image: "history.field.image",
  trash: "history.field.trash", album: "history.field.album"};
const fieldLabel = key => Object.hasOwn(FIELD_LABELS, key) ? TagcastI18n.text(FIELD_LABELS[key]) : key[0].toUpperCase() + key.slice(1);
const fieldShown = (key, values, side) => key === "artist_id" ? values[`${side}_name`] || (values[side] === 0 ? "Various Artists" : TagcastI18n.text("history.value.artistId", {id: values[side]})) : shown(values[side]);

// Albums one by one; track changes grouped by field and value, so twelve tracks that get
// the same genre read as one line instead of twelve.
function reviewList(changes) {
  const row = (key, v) => `<div class="diff-row"><span>${escapeHtml(fieldLabel(key))}</span><del>${escapeHtml(fieldShown(key, v, "before"))}</del><span>→</span><ins>${escapeHtml(fieldShown(key, v, "after"))}</ins></div>`;
  const albums = changes.filter(c => c.kind === "album");
  const tracks = changes.filter(c => c.kind === "track");
  const severalAlbums = new Set(tracks.map(c => String(c.albumId))).size > 1;
  const albumName = id => {
    const a = state.details.get(String(id)) || editing?.originals.find(o => String(o.id) === String(id));
    return a ? a.name + (discSet(a) ? ` · ${TagcastI18n.text("common.disc", {disc: a.disc || "?"})}` : "") : "";
  };
  const groups = new Map();
  for (const c of tracks) {
    for (const [key, v] of Object.entries(c.fields)) {
      const id = JSON.stringify([key, v.before, v.after]);
      if (!groups.has(id)) groups.set(id, {key, values: v, labels: []});
      groups.get(id).labels.push(severalAlbums && albumName(c.albumId) ? `${c.label} · ${albumName(c.albumId)}` : c.label);
    }
  }
  const trackRows = [...groups.values()].map(g => `${row(g.key, g.values)}${g.labels.length === 1
    ? `<p class="diff-tracks">${escapeHtml(g.labels[0])}</p>`
    : `<details class="diff-tracks"><summary>${TagcastI18n.html("review.diff.tracks", {count: g.labels.length})}</summary><ul>${g.labels.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul></details>`}`).join("");
  return albums.map(c => `<section class="diff-group"><h3>${TagcastI18n.html("review.group.album", {label: c.label})}</h3>${Object.entries(c.fields).map(([key, v]) => row(key, v)).join("")}</section>`).join("")
    + (tracks.length ? `<section class="diff-group"><h3>${TagcastI18n.html("review.group.tracks", {count: tracks.length})}</h3>${trackRows}</section>` : "");
}

function showReview(changes) {
  renderReviewChrome(changes);
  if (live() && changes.some(c => c.kind === "album")) {
    api("/api/account-settings").then(settings => {
      if (Boolean(settings.combine_sets) === Boolean(state.connection.combine_sets) || !$("#review").open) return;
      state.connection.combine_sets = settings.combine_sets; renderReviewChrome(changes);
    }).catch(() => { /* the save checks again */ });
  }
    $("#review-changes").innerHTML = reviewList(changes);
  $("#review").showModal();
}

// Put the changes of a save that didn't (fully) go through back in review.
function reviewRest(entry) {
  if (entry.albumSplit) return;
  const changes = entry.changes.filter(c => ["failed", "not_sent", "blocked"].includes(c.status)).map(({status, ...change}) => change);
  if (!changes.length) return;
  pending = {scope: entry.scope || "album", selection: entry.selection, changes};
  if ($("#results").open) $("#results").close();
  if ($("#history").open) $("#history").close();
  showReview(changes);
}

function applyDraft() {
  if (!pending) return;
  if (reloadOnApply) { reloadOnApply = false; pending = null; $("#review").close(); $("#editor").close(); loadLive(); return; }
  if (live()) { saveDraft(); return; }
  for (const change of pending.changes) {
    const album = state.details.get(String(change.albumId));
    const target = change.kind === "album" ? album : album?.tracks.find(t => String(t.id) === String(change.id));
    if (!target) { toast(TagcastI18n.text("review.toast.selectionChanged")); return; }
    for (const [key, value] of Object.entries(change.fields)) if (!sameValue(key === "credits" ? creditValues(target) : target[key], value.before)) { toast(TagcastI18n.text("review.toast.valueChanged")); return; }
  }
  const next = thenNext();
  applyLocally(pending.changes);
  state.history.unshift({...structuredClone(pending), created: new Date().toISOString(), status: "preview_only", source: state.mode});
  pending = null; editing = null; state.selected.clear();
  if (next) setTimeout(() => openEditor(shelfIds(next)), 0);
  if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
  $("#review").close(); $("#editor").close(); render();
  toast(TagcastI18n.text("review.toast.previewApplied"));
}

// Show reviewed values right away; a live save replaces them with iBroadcast's read-back.
function applyLocally(changes) {
  for (const change of changes) {
    const album = state.details.get(String(change.albumId));
    const target = change.kind === "album" ? album : album?.tracks.find(t => String(t.id) === String(change.id));
    if (target) for (const [key, value] of Object.entries(change.fields)) {
      target[key] = value.after;
      if (key === "genres") target.genre = value.after[0] || "";
      if (key === "credits") {
        if (change.kind === "album") delete target.album_artists;
        else {
          target.composers = value.after.filter(e => e.type === "composer").map(e => e.name);
          target.performers = [{id: target.artist_id || 0, name: target.artist}, ...value.after.filter(e => !e.type || ["artist", "band"].includes(e.type)).map(e => ({id: e.artist_id, name: e.name}))];
        }
      }
      if (change.kind === "album" && key === "artist_id" && value.after === 0) {
        target.artist = "Various Artists";
        target.artist_image = "";
        target.artist_artwork_id = 0;
      }
      if (change.kind === "album" && key === "artist") {
        // Reuse a known artist; a newly created artist gets its ID from the read-back.
        const artist = state.albums.find(a => a.artist === value.after && a.artist_id);
        target.artist_id = artist?.artist_id || 0;
        target.artist_image = artist?.artist_image || "";
        target.artist_artwork_id = artist?.artist_artwork_id || 0;
      }
    }
  }
  const touched = new Set(changes.map(c => String(c.albumId)));
  state.albums = state.albums.map(a => touched.has(String(a.id)) && state.details.has(String(a.id)) ? {...summarize(state.details.get(String(a.id))), color: a.color} : a);
}

// Take tracks that went to the trash out of the view; the read-back follows.
function dropTracks(ids) {
  const gone = new Set(ids.map(String)), touched = new Set();
  for (const [id, album] of state.details) {
    const kept = album.tracks.filter(t => !gone.has(String(t.id)));
    if (kept.length !== album.tracks.length) { album.tracks = kept; touched.add(id); }
  }
  state.albums = state.albums.flatMap(a => !touched.has(String(a.id)) ? [a]
    : state.details.get(String(a.id)).tracks.length ? [{...summarize(state.details.get(String(a.id))), color: a.color}] : []);
  if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
}

// What Change history shows besides the entries: a cleared note and a status key.
const historyView = {cleared: false, status: ""};

function showHistory() {
  $("#history-status").textContent = "";
  historyView.cleared = false; historyView.status = "";
  $("#history-clear-review").hidden = true;
  updateHistoryControls();
  renderHistory();
  $("#history").showModal();
}

// Entries are stored English data; labels, status pills, dates and counts are rendered in
// the interface language. A language change repaints this while the dialog is open.
function historyDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : TagcastI18n.dateTime(date);
}

function renderHistory() {
  $("#history-content").innerHTML = state.history.length ? state.history.map((entry, index) => `<section class="history-item">${statusPill(entry.status)}${entry.artwork && !entry.undone && ["saved", "sent", "unverified"].includes(entry.status) ? `<button class="button small history-undo" data-undo="${index}" ${artworkUndoNote(entry) ? `disabled title="${escapeHtml(artworkUndoNote(entry))}"` : ""}>${TagcastI18n.html("history.undo")}</button>` : ""}${entry.artwork ? `<div class="history-art">${entry.artwork.before ? `<img src="${escapeHtml(entry.artwork.before)}" alt="${TagcastI18n.html("history.art.before")}" referrerpolicy="no-referrer">` : ""}<span>→</span><img src="${escapeHtml(entry.artwork.after)}" alt="${TagcastI18n.html("history.art.after")}" referrerpolicy="no-referrer"></div>` : ""}${entry.artwork && !entry.undone && artworkUndoNote(entry) ? `<p class="muted">${escapeHtml(artworkUndoNote(entry))}</p>` : ""}<h3>${escapeHtml([...new Set(entry.selection.map(a => a.name))].join(", "))}</h3><p class="muted">${[escapeHtml(historyDate(entry.created)), TagcastI18n.html("history.records", {count: entry.changes.length})].filter(Boolean).join(" · ")}</p>${entry.error ? `<div class="error-box">${escapeHtml(entry.error)}</div>` : ""}${!entry.artwork && !entry.trash && !entry.albumMerge && !entry.albumSplit && entry.source === "ibroadcast" && entry.changes.some(c => ["failed", "not_sent", "blocked"].includes(c.status)) ? `<p><button class="button small" data-review-rest="${index}">${TagcastI18n.html("history.reviewRest")}</button></p>` : ""}${entry.changes.map(c => `<p class="muted">${c.status ? statusPill(c.status) + " " : ""}${escapeHtml(c.label)}: ${Object.entries(c.fields).map(([key, v]) => `${escapeHtml(fieldLabel(key))}: ${escapeHtml(fieldShown(key, v, "before"))} → ${escapeHtml(fieldShown(key, v, "after"))}`).join(" · ")}</p>`).join("")}</section>`).join("")
    : `<p class="empty">${TagcastI18n.html(historyView.cleared ? "history.cleared" : "history.empty")}</p>`;
}

document.addEventListener("click", event => {
  const close = event.target.closest("[data-close]");
  if (close) {
    if (close.dataset.close === "lyrics-review" && trackLyrics.busy) return;
    if (close.dataset.close === "playlist-import") {
      if (typeof requestClosePlaylistImport === "function") requestClosePlaylistImport();
      else toast(TagcastI18n.text("app.update.reloadImport"));
    }
    else $(`#${close.dataset.close}`).close();
    return;
  }
  const editorTab = event.target.closest("[data-editor-tab]");
  if (editorTab) { setEditorTab(editorTab.dataset.editorTab); return; }
  const artist = event.target.closest("[data-artist]");
  if (artist) { setArtist(artist.dataset.artist); return; }
  const album = event.target.closest("[data-album]");
  if (album) {
    coverClick(event, () => openAlbum(album.dataset.album), coverPreviewFor(event.target)); return;
  }
  const track = event.target.closest("button[data-track]");
  if (track) { editTrack(track.dataset.track); return; }
  const page = event.target.closest("[data-page]");
  if (page) { state.page += Number(page.dataset.page); render(); scrollListingStart("#albums-page"); return; }
  if (event.target.closest("#review-button")) buildReview();
});
document.addEventListener("keydown", event => {
  const tab = event.target.closest?.("#editor-tabs [data-editor-tab]");
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? "album" : event.key === "End" ? "tracks"
    : tab.dataset.editorTab === "album" ? "tracks" : "album";
  setEditorTab(next, true);
});
document.addEventListener("change", event => {
  if (event.target.id === "apply-track-year-default") setTrackYearDefault(event.target.checked);
  if (event.target.id === "select-page") {
    const page = filteredAlbums().slice(state.page * pageSize(), (state.page + 1) * pageSize());
    for (const album of page) for (const id of itemIds(album)) {
      if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
    }
    render();
  }
  if (event.target.matches("[data-select]")) {
    for (const id of shelfIds(event.target.dataset.select)) {
      if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
    }
    render();
  }
  if (event.target.matches("[data-enable]")) {
    const name = event.target.dataset.enable, labels = document.querySelector(`#metadata-form [data-genres="${name}"]`);
    if (labels) { labels.classList.toggle("disabled", !event.target.checked); for (const control of labels.querySelectorAll("input, [data-artist-choices-toggle]")) control.disabled = !event.target.checked; }
    else $("#metadata-form").elements.namedItem(name).disabled = !event.target.checked;
    if (name === "year") {
      if (!event.target.checked) $("#track-years").checked = false;
      else if (metadataEditingDefaults.applyYearToTracks) $("#track-years").checked = true;
    }
    if (name === "artist") syncAlbumArtistControls();
  }
});
document.addEventListener("input", event => {
  if (event.target.name === "year" || event.target.dataset?.key === "year") validateYearInput(event.target);
  if (editing && event.target.id === "album-various-artists") {
    editing.dirty.add("artist");
    syncAlbumArtistControls();
    return;
  }
  if (editing && event.target.closest("#metadata-form") && event.target.name) editing.dirty.add(event.target.name);
});
$("#home").addEventListener("click", event => { event.preventDefault(); showArtistBrowse(); });
$("#all-albums").addEventListener("click", () => setArtist(null));
for (const id of ["#filter", "#sort"]) $(id).addEventListener("change", () => {
  if (id === "#sort") albumOrder.ids = [];
  state.page = 0; render();
});
// A different page size keeps the first album you were looking at in view.
$("#per-page").addEventListener("change", event => {
  const size = Number(event.target.value);
  state.page = Math.floor(state.page * pageSize() / size); state.perPage = size;
  rememberPageSize("tagcast-per-page", size); render();
});
$("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 0; render(); }, 150); });
$("#clear-selection").addEventListener("click", () => { state.selected.clear(); render(); });
$("#edit-selection").addEventListener("click", () => openEditor([...state.selected]));
$("#apply-draft").addEventListener("click", applyDraft);
$("#show-history").addEventListener("click", showHistory);
function exportHistory() {
  if (!state.history.length) { toast(TagcastI18n.text("history.export.empty")); return; }
  const blob = new Blob([JSON.stringify({format: "tagcast-history", version: 2, exported: new Date().toISOString(), entries: state.history}, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `tagcast-history-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#history-export").addEventListener("click", exportHistory);
document.addEventListener("click", event => {
  if (event.target.closest("#export-button")) exportHistory();
});

function updateHistoryControls() {
  const busy = saving || checking > 0;
  $("#history-export").disabled = !state.history.length;
  const settingsExport = $("#export-button");
  if (settingsExport) settingsExport.disabled = !state.history.length;
  for (const id of ["#history-clear", "#history-clear-confirm"]) {
    $(id).disabled = !state.history.length || busy;
    $(id).title = busy ? TagcastI18n.text("history.clear.busy") : "";
  }
}

$("#history-clear").addEventListener("click", () => {
  if (!state.history.length || saving || checking) return;
  $("#history-status").textContent = ""; historyView.status = "";
  $("#history-clear-review").hidden = false;
  $("#history-clear-cancel").focus();
});
$("#history-clear-cancel").addEventListener("click", () => {
  $("#history-clear-review").hidden = true;
  $("#history-clear").focus();
});
$("#history-clear-confirm").addEventListener("click", () => {
  if ($("#history-clear-review").hidden || !state.history.length || saving || checking) return;
  try {
    // Keep an empty current key so the earlier library-studio history cannot return.
    localStorage.setItem("tagcast-history", "[]");
  } catch {
    historyView.status = "history.clear.storageFailed";
    $("#history-status").textContent = TagcastI18n.text("history.clear.storageFailed");
    return;
  }
  state.history = [];
  render(); showHistory();
  historyView.cleared = true; renderHistory();
  $("#history .close").focus();
});
window.addEventListener("beforeunload", event => { if (saving || state.history.some(h => h.status === "preview_only")) { event.preventDefault(); event.returnValue = ""; } });
useLocal(demoLibrary(), "demo");
updateChrome();
render();
// Later deferred scripts define shared browsing/player state used by a live load.
document.addEventListener("DOMContentLoaded", boot, {once: true});

// ---- iBroadcast connection --------------------------------------------------

async function api(path, body) {
  const options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-Tagcast": "1"}, body: JSON.stringify(body)};
  const response = await fetch(path, options);
  let data = {};
  try { data = await response.json(); } catch { /* empty or non-JSON body */ }
  if (!response.ok) {
    const error = Error(data.error || `Tagcast returned HTTP ${response.status}.`);
    error.status = response.status; error.data = data;
    // A stable code lets the interface translate known errors; the English message stays as is.
    if (typeof data.code === "string") { error.code = data.code; error.params = data.params && typeof data.params === "object" ? data.params : {}; }
    throw error;
  }
  return data;
}

function colorize(albums) {
  const known = new Map(state.albums.map(a => [String(a.id), a.color]));
  return albums.map((a, i) => ({...a, color: known.get(String(a.id)) || colors[i % colors.length]}));
}

// Stored statuses stay codes; the pill shows them in the interface language.
const STATUS_LABELS = {saved: "history.status.saved", sent: "history.status.sent", blocked: "history.status.blocked", unverified: "history.status.unverified",
  failed: "history.status.failed", not_sent: "history.status.notSent", preview_only: "history.status.previewOnly"};
function statusPill(status) {
  return `<span class="status ${escapeHtml(status)}">${Object.hasOwn(STATUS_LABELS, status) ? TagcastI18n.html(STATUS_LABELS[status]) : escapeHtml(status)}</span>`;
}

function updatePlaylistCount(value = state.playlistsCount) {
  state.playlistsCount = Number.isSafeInteger(value) && value >= 0 ? value : null;
  const node = $("#playlist-count");
  const known = live() && state.connection.connected && !state.loading && state.playlistsCount !== null;
  node.hidden = !known;
  node.textContent = known ? TagcastI18n.number(state.playlistsCount) : "";
}

function updateChrome() {
  updatePlaylistCount();
  if (typeof updateAlbumMergeControls === "function") updateAlbumMergeControls();
  if (typeof updateSelectedAlbumTagControls === "function") updateSelectedAlbumTagControls();
  if (typeof csvImportCurrent === "function" && $("#playlist-import").open && !csvImportCurrent()) resetPlaylistImport();
  if (typeof syncMetadataExport === "function") syncMetadataExport();
  if (typeof updateAlbumGuideControls === "function") updateAlbumGuideControls();
  if (typeof updateRecentlyPlayedControls === "function") updateRecentlyPlayedControls();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
  updateHistoryControls();
  paintChrome();
}

// Connection, mode and notice texts from the current state only; also repainted on a
// language change.
function paintChrome() {
  const c = state.connection, account = c.account || TagcastI18n.text("connection.title.connected");
  $("#status-dot").className = `status-dot ${live() && !state.loading ? "live" : state.loading ? "busy" : ""}`;
  $("#connection-title").textContent = live() ? `${account} · iBroadcast` : c.connected ? `${account} · ${TagcastI18n.text("connection.title.snapshot")}` : TagcastI18n.text("connection.title.preview");
  $("#connection-title").title = !c.connected ? TagcastI18n.text("connection.title.none")
    : c.account ? TagcastI18n.text("connection.title.as", {account: c.account}) : TagcastI18n.text("connection.title.asYourAccount");
  $("#connection-text").hidden = live();
  $("#connection-text").textContent = live() ? "" : TagcastI18n.text(c.connected ? "connection.text.reload" : "connection.text.none");
  $("#connect-button").hidden = c.connected;
  $("#reload-button").hidden = !c.connected;
  $("#logout-button").hidden = !c.connected;
  const badge = $("#mode-badge");
  badge.classList.add("operation-status");
  badge.setAttribute("data-working", String(checking > 0 && !state.loading && live() && c.connected));
  badge.classList.toggle("live", live());
  badge.textContent = TagcastI18n.text(state.loading ? "connection.badge.loading" : checking ? "connection.badge.checking" : live() ? "connection.badge.live" : "connection.badge.demo");
  badge.title = !c.connected ? TagcastI18n.text("connection.badge.connect")
    : c.account ? TagcastI18n.text("connection.badge.as", {account: c.account}) : TagcastI18n.text("connection.badge.asYourAccount");
  badge.setAttribute("aria-label", `${badge.textContent}. ${badge.title}`);
  $("#data-notice").textContent = TagcastI18n.text(live() ? "connection.notice.live" : "connection.notice.demo");
  $("#library-notice").hidden = !libraryNotice.visible;
  $("#library-loading").hidden = !state.loading;
  $("#history-note").textContent = TagcastI18n.text(live() ? "history.note.live" : "history.note.demo");
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has("auth_error")) toast(TagcastI18n.text("connection.signIn.failed", {error: params.get("auth_error")}));
  if (params.has("connected")) toast(TagcastI18n.text("connection.signIn.connected"));
  if (params.size) history.replaceState(null, "", location.pathname);
  try {
    state.connection = await api("/api/status");
  } catch {
    if (typeof restorePendingRoute === "function") restorePendingRoute();
    return; // opened without the Python server: the demo still works
  }
  updateChrome();
  checkForUpdates();
  if (state.connection.connected) loadLive();
  else if (typeof restorePendingRoute === "function") restorePendingRoute();
}

async function loadLive(refresh = false) {
  saveOrder += 1;
  const request = ++libraryLoadRequest, session = state.connection.playback_session;
  const current = () => request === libraryLoadRequest && session === state.connection.playback_session;
  let completed = false;
  resetEditorArtistChoices();
  if (typeof resetTags === "function") resetTags();
  if (typeof resetAlbumMerge === "function") resetAlbumMerge();
  if (typeof resetAlbumSplit === "function") resetAlbumSplit();
  if (typeof closeHelp === "function") closeHelp(false);
  if (typeof resetGuideAlbumNotes === "function") resetGuideAlbumNotes();
  if (typeof resetAlbumGuide === "function") resetAlbumGuide(false);
  if (typeof resetCleanup === "function") resetCleanup();
  if (typeof resetDuplicateCleanup === "function") resetDuplicateCleanup(true);
  if (typeof resetSelectedAlbumTrash === "function") resetSelectedAlbumTrash();
  resetAlbumOrder();
  if (typeof resetArtistBrowse === "function") resetArtistBrowse();
  if (typeof resetAlbumInformation === "function") resetAlbumInformation();
  if (typeof resetTrackLyrics === "function") resetTrackLyrics();
  if (typeof resetBrowse === "function") resetBrowse();
  if (typeof resetFavourites === "function") resetFavourites();
  if (typeof resetPlaylistImport === "function") resetPlaylistImport();
  if (typeof resetRecentlyPlayed === "function") resetRecentlyPlayed();
  if (typeof resetAlbumView === "function") resetAlbumView();
  state.loading = true; state.mode = "live"; state.playlistsCount = null; state.albums = []; state.details = new Map(); state.selected.clear(); state.editorNames = {genres: [], composers: []};
  state.albumFavourites = new Set(); state.albumFavouriteError = "";
  state.artistFavourites = new Set(); state.artistFavouriteError = "";
  libraryLoadingRefresh = refresh;
  $("#library-loading-detail").textContent = libraryLoadingText(nextLibraryLoadingMessage(), refresh);
  updateChrome(); render();
  try {
    const data = await api(`/api/library${refresh ? "?refresh=1" : ""}`);
    if (!current()) return;
    completed = true;
    state.albums = colorize(data.albums); state.artistNames = data.artists || [];
    if (typeof bindQueueMemory === "function") bindQueueMemory(data.playback_profile);
    applyEditorNames(data.editor_names);
    updatePlaylistCount(data.playlists_count);
    state.albumFavourites = new Set(data.album_favourites?.albums || []);
    state.albumFavouriteError = data.album_favourites?.error || "";
    state.artistFavourites = new Set(data.artist_favourites?.artists || []);
    state.artistFavouriteError = data.artist_favourites?.error || "";
    state.connection.combine_sets = Boolean(data.combine_sets);
    if (Object.hasOwn(data, "premium")) state.connection.premium = data.premium;
    if (typeof favourites !== "undefined") favourites.count = data.favourites_count ?? null;
    toast(TagcastI18n.text(data.source === "download" ? "library.load.downloaded" : "library.load.unchanged", {count: state.albums.length}));
  } catch (error) {
    if (!current()) return;
    completed = true;
    if (error.status === 401) state.connection.connected = false;
    useLocal(demoLibrary(), "demo");
    toast(TagcastI18n.text("library.load.failed", {error: TagcastI18n.errorText(error)}));
  } finally {
    if (!completed && request !== libraryLoadRequest) return;
    if (!completed && session !== state.connection.playback_session) {
      state.loading = false; updateChrome(); return;
    }
    state.loading = false;
    if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
    state.page = 0; updateChrome(); render();
    if (state.screen === "overview" && typeof loadOverview === "function") loadOverview();
    if (typeof refreshPlayerRatings === "function") refreshPlayerRatings();
    if (typeof restorePendingRoute === "function") restorePendingRoute();
    if (typeof syncMusicUploadsPage === "function") syncMusicUploadsPage();
    if (typeof restoreQueueMemory === "function" && live()) restoreQueueMemory();
  }
}

function connectView(view, extra = {}) {
  const c = state.connection, box = $("#connect-content");
  const error = extra.error ? `<div class="error-box">${escapeHtml(extra.error)}</div>` : "";
  if (view === "connected") {
    const connected = c.account ? TagcastI18n.html("connection.connected.as", {account: TagcastI18n.trusted(`<strong>${escapeHtml(c.account)}</strong>`)}) : TagcastI18n.html("connection.connected.plain");
    box.innerHTML = `<div class="connect-step"><p class="muted">${connected} ${TagcastI18n.html("connection.connected.note")}</p>${error}</div><div class="dialog-footer"><button class="button" id="connect-logout">${TagcastI18n.html("connection.disconnect")}</button><button class="button" id="connect-redownload" title="${TagcastI18n.html("connection.redownload.title")}">${TagcastI18n.html("connection.redownload.label")}</button><button class="button primary" id="connect-reload">${TagcastI18n.html("common.reloadLibrary")}</button></div>`;
  } else if (view === "ready") {
    const previous = c.using_default_client === false;
    const permission = TagcastI18n.html("connection.ready.permission", {permission: TagcastI18n.trusted(`<strong>${TagcastI18n.html("connection.ready.permissionScope")}</strong>`)});
    const intro = [TagcastI18n.html("connection.ready.intro"), permission, TagcastI18n.html("connection.ready.password"),
      typeof musicUploadsView !== "undefined" && musicUploadsView.enabled ? TagcastI18n.html("connection.ready.uploads") : ""].filter(Boolean).join(" ");
    const redirect = TagcastI18n.html("connection.ready.redirect", {url: TagcastI18n.trusted(`<code>http://127.0.0.1:${escapeHtml(location.port || 80)}/callback</code>`)});
    box.innerHTML = `<div class="connect-step"><p class="muted">${intro}</p><p class="muted">${TagcastI18n.html(previous ? "connection.ready.previous" : "connection.ready.registered")}</p>${error}</div><div class="dialog-footer">${previous && !c.client_id_from_env && !c.connected ? `<button class="text-button" id="client-default" style="color:var(--green);margin-right:auto">${TagcastI18n.html("connection.ready.useDefault")}</button>` : ""}${previous ? `<button class="button" id="browser-start">${TagcastI18n.html("connection.ready.useBrowser")}</button>` : ""}<button class="button primary" id="device-start">${TagcastI18n.html("connection.ready.signIn")}</button></div>${previous ? `<p class="muted">${redirect}</p>` : ""}`;
  } else if (view === "device") {
    box.innerHTML = signInDeviceMarkup(extra.device, {error, fallback: extra.fallback});
  }
}

function openConnect() {
  const c = state.connection;
  connectView(c.device?.state === "pending" ? "device" : c.connected ? "connected" : "ready", {device: c.device});
  if (c.device?.state === "pending") pollDevice();
  $("#connect").showModal();
}

function stopPoll() { clearTimeout(devicePoll); devicePoll = null; signInPollGeneration += 1; }

function pollDevice(delay = 2000) {
  stopPoll();
  const generation = signInPollGeneration;
  devicePoll = setTimeout(async () => {
    if (generation !== signInPollGeneration) return;
    if (!signInDesktop() && signInFlow.popup?.closed) { await cancelSignIn(); return; }
    try {
      const status = await api("/api/status");
      if (generation !== signInPollGeneration) return;
      state.connection = status;
      if (status.connected && !["pending", "error"].includes(status.device?.state)) { finishSignIn(status); return; }
      if (!status.device) {
        stopPoll(); closeSignInChild(); signInFlow.requestId = "";
        if ($("#connect").open) connectView("ready");
        return;
      }
      if (status.device.state === "error" || (status.device.expires_at && status.device.expires_at * 1000 < Date.now())) {
        stopPoll(); closeSignInChild(); signInFlow.requestId = "";
        connectView("ready", {error: status.device.error || TagcastI18n.text("connection.signIn.expired")}); return;
      }
    } catch { /* keep the existing single poller through brief hiccups */ }
    if (generation === signInPollGeneration) pollDevice();
  }, delay);
}

async function connectAction(target) {
  try {
    if (target.id === "client-default") {
      state.connection = await api("/api/config/default", {});
      updateChrome(); connectView("ready");
    } else if (target.id === "device-start") {
      await beginSignIn(target);
    } else if (target.id === "device-open") {
      await reopenSignIn();
    } else if (target.id === "device-cancel") {
      await cancelSignIn();
    } else if (target.id === "browser-start") {
      const {url} = await api("/api/auth/browser", {});
      location.href = url;
    } else if (target.id === "connect-reload" || target.id === "reload-button") {
      $("#connect").close(); loadLive();
    } else if (target.id === "connect-redownload") {
      $("#connect").close(); loadLive(true);
    } else if (target.id === "connect-logout" || target.id === "logout-button") {
      if (!confirm(TagcastI18n.text("connection.disconnectConfirm"))) return;
      await api("/api/auth/logout", {});
      state.connection = {...state.connection, connected: false, account: "", device: null};
      if ($("#connect").open) $("#connect").close();
      useLocal(demoLibrary(), "demo"); state.artist = null; state.selected.clear();
      updateChrome(); render(); toast(TagcastI18n.text("connection.disconnected"));
    }
  } catch (error) {
    target.disabled = false;
    const view = ["device-start", "browser-start", "client-default"].includes(target.id) ? "ready" : state.connection.connected ? "connected" : "ready";
    if ($("#connect").open) connectView(view, {error: TagcastI18n.errorText(error)}); else toast(TagcastI18n.errorText(error));
  }
}

// ---- saving -----------------------------------------------------------------

function knownArtists() {
  const names = new Set(state.artistNames.map(n => n.toLocaleLowerCase()));
  for (const a of state.details.values()) { names.add(a.artist.toLocaleLowerCase()); for (const t of a.tracks) { names.add(t.artist.toLocaleLowerCase()); for (const c of t.composers || []) names.add(c.toLocaleLowerCase()); } }
  return names;
}

function renderReviewChrome(changes) {
  const apply = $("#apply-draft"), count = changes.length;
  $("#then-next-label").hidden = pending?.scope !== "album";
  apply.disabled = false; reloadOnApply = false;
  apply.textContent = live() ? TagcastI18n.text("review.apply.save", {count}) : TagcastI18n.text("review.apply.preview");
  $("#review-cancel").disabled = false;
  $("#review-status").innerHTML = "";
  $("#review-intro").textContent = TagcastI18n.text(live() ? "review.intro.live" : "review.intro.demo");
  const warnings = [];  // markup
  if (live()) {
    const known = knownArtists();
    const fresh = [...new Set(changes.flatMap(c => [...(c.fields.artist ? [c.fields.artist.after] : []), ...(c.fields.composers?.after || [])]))].filter(n => !known.has(n.toLocaleLowerCase()));
    if (fresh.length) warnings.push(TagcastI18n.html("review.warning.newArtists", {count: fresh.length, names: TagcastI18n.trusted(fresh.map(n => `“${escapeHtml(n)}”`).join(", "))}));
    if (state.connection.combine_sets && changes.some(c => c.kind === "album")) warnings.push(TagcastI18n.html("review.warning.combineSets"));
    if (changes.some(c => c.kind === "album" && c.fields.artist)) warnings.push(TagcastI18n.html("review.warning.albumArtist"));
  }
  $("#review-warnings").innerHTML = warnings.map(w => `<div class="warn-box">${w}</div>`).join("");
}

function thenNext() {
  return pending?.scope === "album" && $("#then-next").checked ? nextAlbumId(pending.selection[0].id) : null;
}

function overallStatus(statuses) {
  return statuses.some(s => s === "failed" || s === "not_sent" || s === "blocked") ? "failed" : statuses.some(s => s === "sent") ? "sent" : statuses.some(s => s === "unverified") ? "unverified" : "saved";
}

async function saveDraft() {
  if (saving || !pending) return;
  saving = true;
  const yearReviewContext = typeof beginYearReviewSave === "function" ? beginYearReviewSave(editing) : null;
  const apply = $("#apply-draft");
  apply.disabled = true; $("#review-cancel").disabled = true; apply.textContent = TagcastI18n.text("review.saving");
  setActionStatus("#review-status", TagcastI18n.text("review.status.checkingAndSaving"), true);
  try {
    const result = await api("/api/save", {changes: pending.changes});
    const byId = new Map((result.results || []).map(r => [`${r.kind}:${r.id}`, r.status]));
    const statuses = [...byId.values()];
    const overall = statuses.length ? overallStatus(statuses) : "saved";
    const next = thenNext();
    const newArtist = pending.scope === "artist" ? pending.changes.find(c => c.kind === "album" && c.fields.artist)?.fields.artist.after : null;
    const entry = {...structuredClone(pending), created: new Date().toISOString(), status: overall, source: "ibroadcast", error: result.error || "",
      created_artists: result.created_artists || [], changes: pending.changes.map(c => ({...c, status: byId.get(`${c.kind}:${c.id}`) || "saved"}))};
    state.history.unshift(entry);
    pendingAlbums = null; // an older read-back; this save's own read-back follows
    if (result.albums) { state.albums = colorize(result.albums); state.details = new Map(); applyEditorNames(result.editor_names); }
    else applyLocally(pending.changes.filter(c => byId.get(`${c.kind}:${c.id}`) === "sent"));
    pending = null; editing = null; state.selected.clear();
    if (newArtist) state.artist = newArtist;
    if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
    $("#review").close(); $("#editor").close(); render();
    if (overall === "failed" || !statuses.length || result.error) showResults(result, overall, entry);
    else toast(TagcastI18n.text("review.saved", {count: statuses.length}));
    if (yearReviewContext) acceptedYearReviewSave(yearReviewContext);
    if (result.job) {
      const verification = followJob(result.job, entry);
      if (yearReviewContext) verification.then(job => finishedYearReviewSave(yearReviewContext, job, entry));
    } else if (yearReviewContext) finishedYearReviewSave(yearReviewContext, null, entry);
    if (next && overall !== "failed") openEditor(shelfIds(next));
  } catch (error) {
    if (yearReviewContext) yearReviewContext.saving = false;
    apply.disabled = false; $("#review-cancel").disabled = false;
    apply.textContent = TagcastI18n.text("common.tryAgain");
    if (error.status === 401) {
      state.connection.connected = false; updateChrome();
      $("#review-status").innerHTML = `<span class="error-text">${escapeHtml(TagcastI18n.errorText(error))}</span>`;
      apply.disabled = true;
    } else if (error.status === 409) {
      $("#review-status").innerHTML = `<span class="error-text">${escapeHtml(TagcastI18n.errorText(error))}</span>`;
      apply.textContent = TagcastI18n.text("common.reloadLibrary"); reloadOnApply = true;
      apply.disabled = false;
      return;
    } else {
      $("#review-status").innerHTML = `<span class="error-text">${TagcastI18n.html("review.error.notConfirmed", {error: TagcastI18n.errorText(error)})}</span>`;
    }
  } finally {
    saving = false;
    setActionStatus("#review-status", undefined);
  }
}

// Poll the background read-back of a save and update its history entry.
async function followJob(jobId, entry, onDone, stillCurrent = () => true) {
  const order = ++saveOrder;
  rememberHistory();
  checking += 1; updateChrome();
  let job, shownError = "";
  try {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (job.state !== "checking") break;
    }
  } catch (error) {
    // The history entry keeps the English message; the toast shows a known code translated.
    job = {state: "error", error: error.message}; shownError = TagcastI18n.errorText(error);
  } finally { checking -= 1; updateChrome(); }
  if (!stillCurrent()) return null;
  if (job.state === "error") {
    entry.status = "unverified"; entry.error = [entry.error, job.error].filter(Boolean).join(" ");
    for (const c of entry.changes) if (c.status === "sent") c.status = "unverified";
    rememberHistory(); toast(shownError || job.error); return job;
  }
  const byId = new Map(job.results.map(r => [`${r.kind}:${r.id}`, r.status]));
  for (const c of entry.changes) {
    c.status = byId.get(`${c.kind}:${c.id}`) || c.status;
    const result = job.results.find(r => r.kind === c.kind && String(r.id) === String(c.id));
    if (c.status === "saved" && c.fields?.credits && result?.credits) c.fields.credits.after = structuredClone(result.credits);
  }
  entry.status = overallStatus(entry.changes.map(c => c.status));
  rememberHistory();
  if (order !== saveOrder || !Array.isArray(job.albums)) { /* summaries are delivered once; keep the current library otherwise */ }
  else if (!$("#editor").open && !$("#review").open) {
    applyEditorNames(job.editor_names);
    state.albums = colorize(job.albums); state.details = new Map();
    if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
    render();
  } else { applyEditorNames(job.editor_names); pendingAlbums = job.albums; }
  onDone?.(job);
  const done = job.results.filter(r => r.status === "saved").length;
  if (entry.status === "saved") toast(TagcastI18n.text("review.confirmed", {count: done}));
  else if (!entry.albumSplit) showResults({results: job.results, error: entry.error}, entry.status, entry);
  return job;
}

// Field codes in save results, as short lowercase names; unknown codes stay as they are.
const RESULT_FIELDS = {name: "review.resultField.title", title: "review.resultField.title", track: "review.resultField.trackNumber",
  artist: "review.resultField.artist", year: "review.resultField.year", disc: "review.resultField.disc",
  genres: "review.resultField.genres", composers: "review.resultField.composers", credits: "review.resultField.credits"};
const resultFieldName = field => Object.hasOwn(RESULT_FIELDS, field) ? TagcastI18n.text(RESULT_FIELDS[field]) : field;

function showResults(result, overall, entry) {
  const rows = result.results || [];
  const saved = rows.filter(r => r.status === "saved").length;
  $("#results-title").textContent = !rows.length ? TagcastI18n.text("review.results.upToDate") : overall === "saved" ? TagcastI18n.text("review.results.saved", {count: saved})
    : TagcastI18n.text(overall === "unverified" ? "review.results.partlyUnconfirmed" : "review.results.incomplete");
  const notes = [];
  if (result.message) notes.push(`<p class="muted">${escapeHtml(result.message)}</p>`);
  if (result.error) notes.push(`<div class="error-box">${escapeHtml(result.error)}</div>`);
  if (result.created_artists?.length) notes.push(`<p class="muted">${TagcastI18n.html("review.results.createdArtists", {count: result.created_artists.length, names: TagcastI18n.trusted(result.created_artists.map(n => `“${escapeHtml(n)}”`).join(", "))})}</p>`);
  if (overall === "unverified") notes.push(`<div class="warn-box">${TagcastI18n.html("review.results.unverified")}</div>`);
  if (result.readBackFailed) notes.push(`<div class="warn-box">${TagcastI18n.html("review.results.readBackFailed")}</div>`);
  const index = entry ? state.history.indexOf(entry) : -1;
  if (index >= 0 && !entry.artwork && !entry.trash && !entry.albumMerge && !entry.albumSplit && entry.changes.some(c => ["failed", "not_sent", "blocked"].includes(c.status))) {
    notes.push(`<p><button class="button small" data-review-rest="${index}">${TagcastI18n.html("history.reviewRest")}</button> <span class="muted">${TagcastI18n.html("review.results.restNote")}</span></p>`);
  }
  $("#results-content").innerHTML = notes.join("") + rows.map(r => `<div class="result-row"><div>${TagcastI18n.html(r.kind === "album" ? "review.results.album" : "review.results.track")} · ${escapeHtml(r.label)}<small>${escapeHtml(r.fields.map(resultFieldName).join(", "))}</small></div>${statusPill(r.status)}</div>`).join("");
  if (!$("#results").open) $("#results").showModal();
}

document.addEventListener("click", event => {
  const target = event.target.closest("#client-default, #device-start, #device-open, #device-cancel, #browser-start, #connect-reload, #connect-redownload, #connect-logout, #reload-button, #logout-button");
  if (target) connectAction(target);
});
$("#connect-button").addEventListener("click", openConnect);
$("#mode-badge").addEventListener("click", openConnect);

function flushPendingAlbums() {
  if (!pendingAlbums || $("#editor").open || $("#review").open || (typeof settingsView !== "undefined" && settingsView.editor)) return;
  state.albums = colorize(pendingAlbums); state.details = new Map(); pendingAlbums = null;
  if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
  render();
}
$("#editor").addEventListener("close", flushPendingAlbums);
$("#editor").addEventListener("close", resetEditorArtistChoices);
$("#review").addEventListener("close", flushPendingAlbums);

document.addEventListener("click", event => {
  const view = event.target.closest("[data-view]");
  if (view) {
    state.view = view.dataset.view; state.page = 0;
    try { localStorage.setItem("tagcast-view", state.view); } catch { /* private window */ }
    render(); return;
  }
  if (event.target.closest("#next-album")) {
    const next = editing && nextAlbumId(editing.ids[0]);
    const changed = editing && (editing.dirty.size || Object.keys(editing.trackPatches).length || $("#track-inline")?.dataset.track);
    if (!next || (changed && !confirm(TagcastI18n.text("editor.leaveConfirm")))) return;
    $("#editor").close(); openEditor(shelfIds(next));
  }
});
try { $("#then-next").checked = localStorage.getItem("tagcast-then-next") === "1"; } catch { /* private window */ }
$("#then-next").addEventListener("change", event => {
  try { localStorage.setItem("tagcast-then-next", event.target.checked ? "1" : "0"); } catch { /* private window */ }
});

document.addEventListener("click", event => {
  const rest = event.target.closest("[data-review-rest]");
  if (rest && live()) reviewRest(state.history[Number(rest.dataset.reviewRest)]);
  else if (rest) toast(TagcastI18n.text("history.reviewRestConnect"));
});

document.addEventListener("click", event => {
  const button = event.target.closest("[data-edit-set]");
  if (!button) return;
  const album = state.albums.find(a => String(a.id) === button.dataset.editSet), set = album && discSet(album);
  if (!set) return;
  const changed = editing && (editing.dirty.size || Object.keys(editing.trackPatches).length);
  if (changed && !confirm(TagcastI18n.text("editor.leaveConfirm"))) return;
  $("#editor").close();
  openEditor(set.map(a => String(a.id)));
});

// Appearance and colour palette are independent, local-only preferences.
function showTheme() {
  TagcastThemes.apply();
  const theme = document.documentElement.dataset.theme || "auto";
  const palette = document.documentElement.dataset.palette || "forest";
  const label = TagcastI18n.text({auto: "app.theme.auto", light: "app.theme.light", dark: "app.theme.dark"}[theme]);
  const palettes = {forest: "app.theme.forest", ocean: "app.theme.ocean", warm: "app.theme.warm", ibroadcast: "app.theme.ibroadcast", apple: "app.theme.apple", amber: "app.theme.amber"};
  // A custom theme's name is the user's own text; built-in palette names follow the interface language.
  const colour = TagcastThemes.active()?.name || (Object.hasOwn(palettes, palette) ? TagcastI18n.text(palettes[palette]) : undefined);
  $("#theme-button").textContent = TagcastI18n.text("app.theme.button", {icon: {auto: "◐", light: "☀", dark: "☾"}[theme]});
  $("#theme-button").title = TagcastI18n.text("app.theme.buttonTitle", {colour, appearance: label});
  for (const value of ["auto", "light", "dark"]) $("#appearance-" + value).checked = theme === value;
  for (const value of TagcastThemes.builtins) $("#palette-" + value).checked = !TagcastThemes.active() && palette === value;
  const customFocus = document.activeElement?.dataset?.customThemeChoice !== undefined ? document.activeElement.value : null;
  const custom = $("#theme-custom-list"), themes = TagcastThemes.snapshot().themes;
  if (custom) custom.innerHTML = themes.length ? `<fieldset><legend>${TagcastI18n.html("app.theme.mine")}</legend>${themes.map(item => `<label><input type="radio" name="palette" value="${item.id}" data-custom-theme-choice ${item.id === TagcastThemes.active()?.id ? "checked" : ""}> ${escapeHtml(item.name)}</label>`).join("")}</fieldset>` : "";
  if (customFocus) custom?.querySelector(`[value="${customFocus}"]`)?.focus({preventScroll: true});
}

function setThemeMenu(open, restoreFocus = false) {
  $("#theme-menu").hidden = !open;
  $("#theme-button").setAttribute("aria-expanded", String(open));
  if (open) $("#appearance-" + (document.documentElement.dataset.theme || "auto")).focus();
  else if (restoreFocus) $("#theme-button").focus();
}
$("#theme-button").addEventListener("click", () => setThemeMenu($("#theme-menu").hidden));
document.addEventListener("click", event => { if (event.target.closest?.("[data-open-theme-editor]")) { setThemeMenu(false); showSettings("appearance"); } });
$("#theme-menu").addEventListener("change", event => {
  if (event.target.dataset.customThemeChoice !== undefined) {
    try { TagcastThemes.activate(event.target.value); showTheme(); } catch { showTheme(); toast(TagcastI18n.text("app.theme.applyFailed")); }
  } else if (event.target.dataset.appearanceChoice !== undefined) {
    const value = event.target.value;
    if (!["auto", "light", "dark"].includes(value)) return;
    if (value === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    try { localStorage.setItem("tagcast-theme", value); } catch { /* private window */ }
    showTheme();
  } else if (event.target.dataset.paletteChoice !== undefined) {
    const palette = setColourPalette(event.target.value);
    try { localStorage.setItem("tagcast-palette", palette); } catch { /* private window */ }
  }
});
document.addEventListener("click", event => {
  if (!event.target.closest(".appearance-controls")) setThemeMenu(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#theme-menu").hidden) {
    event.preventDefault();
    setThemeMenu(false, true);
  }
});

function setColourPalette(value) {
  const palette = TagcastThemes.builtin(value);
  showTheme();
  return palette;
}
TagcastThemes.apply(); showTheme();
setThemeMenu(false);

// Image errors do not bubble. Capture them without weakening the desktop CSP.
document.addEventListener("error", event => {
  const image = event.target, action = image?.dataset?.imageError;
  if (image?.tagName !== "IMG" || !action) return;
  if (action === "current") image.outerHTML = `<div class="art-empty">${TagcastI18n.html("artwork.noImage")}</div>`;
  else if (action === "tile") image.closest(".art-tile")?.remove();
  else if (action === "suggestion") image.closest(".suggestion-art")?.remove();
  else {
    if (action === "album") image.parentNode?.classList.remove("has-art");
    image.remove();
  }
}, true);

// A language change repaints only read-only views, from memory: the album shelf with its
// header and pagination, the artist panel, connection and mode texts, the theme button, the
// loading note and Change history while it is open. The metadata editor, review, artwork,
// results and connection dialogs keep their content and drafts until they are opened again;
// no request, selection, page, save or read-back changes.
TagcastI18n.subscribe(() => {
  renderLibrary(true);
  if (browseChoices.kind === "artists") paintBrowseOptions();
  paintChrome();
  updateHistoryControls();
  showTheme();
  if (state.loading && libraryLoadingMessageIndex >= 0) {
    $("#library-loading-detail").textContent = libraryLoadingText(TagcastI18n.text(libraryLoadingMessages[libraryLoadingMessageIndex]), libraryLoadingRefresh);
  }
  if ($("#history").open) {
    const focused = document.activeElement, undo = focused?.dataset?.undo, rest = focused?.dataset?.reviewRest;
    renderHistory();
    if (historyView.status) $("#history-status").textContent = TagcastI18n.text(historyView.status);
    if (undo !== undefined || rest !== undefined) {
      [...document.querySelectorAll("#history-content [data-undo], #history-content [data-review-rest]")]
        .find(node => undo !== undefined ? node.dataset.undo === undo : node.dataset.reviewRest === rest)?.focus();
    }
  }
});
