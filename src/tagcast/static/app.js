"use strict";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const colors = ["#627b70", "#ab7555", "#6c7b89", "#a98a56", "#836d7b", "#71856b"];
// state.albums holds small album summaries (no tracks); full albums live in state.details.
const state = {albums: [], details: new Map(), albumFavourites: new Set(), albumFavouriteError: "", artistFavourites: new Set(), artistFavouriteError: "", artistNames: [], editorNames: {genres: [], composers: []}, artist: null, view: storedView(), perPage: storedPageSize("tagcast-per-page"), history: storedHistory(), selected: new Set(), page: 0, mode: "demo", loading: false, connection: {connected: false, configured: false, account: ""}};
const libraryNotice = {visible: document.documentElement.dataset.libraryNotice !== "hidden"};
let libraryLoadRequest = 0;

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
  libraryLoadRequest += 1; state.loading = false;
  $("#library-loading").hidden = true;
  closeBrowseOptions();
  resetEditorArtistChoices();
  if (typeof resetTags === "function") resetTags();
  if (typeof closeHelp === "function") closeHelp(false);
  if (typeof resetGuideAlbumNotes === "function") resetGuideAlbumNotes();
  if (typeof resetAlbumGuide === "function") resetAlbumGuide(false);
  if (typeof resetCleanup === "function") resetCleanup(true);
  if (typeof resetDuplicateCleanup === "function") resetDuplicateCleanup(true);
  if (typeof resetSelectedAlbumTrash === "function") resetSelectedAlbumTrash();
  if (typeof resetArtistBrowse === "function") resetArtistBrowse();
  if (typeof resetAlbumInformation === "function") resetAlbumInformation();
  if (typeof resetBrowse === "function") resetBrowse();
  if (typeof resetFavourites === "function") resetFavourites();
  if (typeof resetPlaylistImport === "function") resetPlaylistImport();
  if (typeof resetRecentlyPlayed === "function") resetRecentlyPlayed();
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
  return album.artwork ? `data-cover-preview data-cover-src="${escapeHtml(album.artwork)}" data-cover-name="${escapeHtml(album.name)}" data-cover-artist="${escapeHtml(album.artist)}" title="Double-click to enlarge the cover"` : "";
}

function cover(album, small = false, enlarge = false) {
  const initials = album.artist.split(/\s+/).map(s => s[0]).slice(0, 2).join("");
  const art = album.artwork ? `<img src="${escapeHtml(album.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.remove('has-art');this.remove()">` : "";
  return `<div class="cover ${art ? "has-art" : ""}" ${!small && enlarge ? coverPreviewAttrs(album) : ""} style="--cover-color:${album.color}">${art}<span class="cover-letter">${escapeHtml(initials)}</span>${small || art ? "" : '<span class="cover-caption">TAGCAST / PLACEHOLDER</span>'}</div>`;
}

const EDITION = /remaster|deluxe|anniversary|re-record|live|edition|expanded/i;
const FILTERS = {
  all: ["All albums", () => true],
  year: ["Missing year", a => !a.year],
  genre: ["Missing genre", a => a.no_genre > 0],
  artist_image: ["Artist without image", a => !a.artist_image && a.artist !== "Various Artists"],
  cover: ["Missing cover", a => a.no_cover > 0],
  combined: ["Combined genres", a => a.combined_genres > 0],  // tags like "Pop;Rock" stored as one genre
  composer: ["Missing composer", a => a.no_composer > 0],  // search "classical" to narrow it down
  small: ["1–2 tracks", a => a.track_count <= 2],
  incomplete: ["Possibly incomplete", a => a.track_gaps > 0],
  duplicates: ["Duplicate tracks", hasDuplicateTracks],
  edition: ["Named editions", a => EDITION.test(a.name)],
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
const albumSortLabels = {artist: "Album artist · A–Z", artist_za: "Album artist · Z–A",
  title: "Album title · A–Z", title_za: "Album title · Z–A", year: "Release year · oldest first",
  newest: "Release year · newest first", rating_high: "Rating · highest first", rating_low: "Rating · lowest first",
  uploaded_newest: "Date uploaded · newest first", uploaded_oldest: "Date uploaded · oldest first"};
const artistSortLabels = {az: "Name · A–Z", za: "Name · Z–A", random: "Random",
  rating_high: "Rating · highest first", rating_low: "Rating · lowest first"};
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
      key: `filter:${option.value}`, label: `${option.label}${option.count ? ` · ${option.count.toLocaleString("en")}` : ""}`,
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
  const html = '<div class="browse-options-title" role="presentation"><span>Filter and sort</span><button type="button" role="menuitem" data-browse-close aria-label="Close filter and sort" tabindex="-1">×</button></div>'
    + [["sort", "Sort"], ["filter", "Show"]].map(([kind, label]) => `<div role="group" aria-label="${label}"><div class="browse-options-heading" role="presentation">${label}</div>${options.filter(option => option.key.startsWith(`${kind}:`)).map(option => `<button type="button" role="menuitemradio" aria-checked="${option.selected}" data-browse-choice="${option.key}" tabindex="-1" ${option.disabled ? "disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg><span>${escapeHtml(option.label)}</span></button>`).join("")}</div>`).join("");
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
  } else { state.page = 0; render(); }
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
const discLabel = album => { const set = discSet(album); return set ? `Disc ${album.disc || "?"} of ${set.length}` : ""; };

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
  const art = album.artwork ? `<img src="${escapeHtml(album.artwork.replace(/-300$/, "-150"))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<span class="thumb" style="--cover-color:${album.color}">${art}<span>${escapeHtml(initials(album.artist))}</span></span>`;
}

function avatar(name, image) {
  const img = image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
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

function filteredAlbums() {
  const query = $("#search").value.toLocaleLowerCase().trim(), keep = (FILTERS[$("#filter").value] || FILTERS.all)[1];
  const items = albumShelf().filter(a => (!state.artist || albumHasArtist(a, state.artist)) && keep(a)
    && (!query || [a.name, albumArtistsText(a), ...a.genres].join(" ").toLocaleLowerCase().includes(query)));
  return items.sort(SORTS[$("#sort").value] || SORTS.artist);
}

function badge(a) {
  return !a.year ? '<span class="pill missing">Missing year</span>' : a.no_genre ? '<span class="pill missing">Missing genre</span>' : "";
}

function hasDuplicateTracks(album) {
  return album.repeated_numbers > 0 || album.duplicates > 0;
}

function duplicateAlbumBadge(album) {
  return hasDuplicateTracks(album) ? '<span class="pill missing" title="Repeated track numbers on the same disc. Open the album to compare the tracks.">Duplicated</span>' : "";
}

function albumCardMetadata(a) {
  return `${a.year || "Year unknown"} · ${a.track_count} ${a.track_count === 1 ? "track" : "tracks"} · ${EDITION.test(a.name) ? "edition" : "album"}${discNote(a) ? ` · ${discNote(a)}` : ""}`;
}

const isSelected = a => itemIds(a).every(id => state.selected.has(id));
// The discs of a set as CD icons: up to six, then the number.
function discIcons(count) {
  const cd = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13zM8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z"/></svg>';
  return `<span class="disc-icons" role="img" aria-label="${count} discs" title="${count} discs">${cd.repeat(Math.min(count, 6))}${count > 6 ? `<small>${count}</small>` : ""}</span>`;
}
const discNote = a => a.discs ? discIcons(a.discs.length) : a.disc > 1 ? `Disc ${a.disc}` : "";

function selectBox(a) {
  return state.artist || live() ? `<label class="album-select"><input type="checkbox" data-select="${escapeHtml(a.id)}" aria-label="Select ${escapeHtml(a.name)}" ${isSelected(a) ? "checked" : ""}></label>` : "";
}

function gridView(items) {
  return items.map(a => `<article class="album-card ${isSelected(a) ? "selected" : ""}">${selectBox(a)}<button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="Open ${escapeHtml(a.name)}">${cover(a)}<span class="album-name">${escapeHtml(a.name)}</span><span class="album-artist">${escapeHtml(albumArtistsText(a))}</span>${hasDuplicateTracks(a) ? `<span class="album-duplicate">${duplicateAlbumBadge(a)}</span>` : ""}</button><div class="card-meta"><div class="album-card-meta-text"><span>${albumCardMetadata(a)}</span>${badge(a)}</div>${typeof albumCardActions === "function" ? albumCardActions(a) : ""}</div></article>`).join("");
}

function listView(items) {
  const genre = a => a.genres.length ? escapeHtml(a.genres.slice(0, 3).join(", ") + (a.genres.length > 3 ? " …" : "")) : "";
  const missing = a => a.no_genre ? `<span class="pill missing">${a.no_genre === a.track_count ? "None" : `${a.no_genre} missing`}</span>` : "";
  const selectable = state.artist || live();
  return `<table class="album-table"><thead><tr>${selectable ? '<th class="col-check" aria-label="Select albums"></th>' : ""}<th class="col-thumb"></th><th>Album</th><th>Album artist</th><th class="col-num">Year</th><th class="col-num">Tracks</th><th>Genre</th><th aria-label="Play or queue album"></th></tr></thead><tbody>${items.map(a => `<tr class="${isSelected(a) ? "selected" : ""}">${selectable ? `<td class="col-check">${selectBox(a)}</td>` : ""}<td class="col-thumb"><button class="row-open" data-album="${escapeHtml(a.id)}" aria-label="Open ${escapeHtml(a.name)}">${thumb(a)}</button></td><td><button class="row-open row-title" data-album="${escapeHtml(a.id)}">${escapeHtml(a.name)}</button> ${duplicateAlbumBadge(a)}${discNote(a) ? ` <span class="muted">· ${discNote(a)}</span>` : ""}</td><td>${albumArtistLinks(a)}</td><td class="col-num">${a.year || '<span class="pill missing">—</span>'}</td><td class="col-num">${a.track_count}</td><td>${genre(a)} ${missing(a)}</td><td>${typeof albumCardActions === "function" ? albumCardActions(a) : ""}</td></tr>`).join("")}</tbody></table>`;
}

function render() {
  if (typeof syncMetadataExport === "function") syncMetadataExport();
  const scope = albumShelf().filter(a => !state.artist || albumHasArtist(a, state.artist));
  syncBrowseChoices("albums", Object.entries(FILTERS).map(([value, [label, keep]]) => ({value, label, count: scope.filter(keep).length})), albumSortLabels, "artist");
  $("#cleanup-filter").hidden = !live() || $("#filter").value !== "combined";
  $("#duplicate-cleanup-open").hidden = !live() || $("#filter").value !== "duplicates";
  $("#browse-artist-count").textContent = artistGroups().length.toLocaleString("en");
  $("#total-albums").textContent = $("#album-count").textContent = albumShelf().length.toLocaleString("en");
  const trackCount = state.albums.reduce((sum, a) => sum + a.track_count, 0);
  $("#track-count").textContent = trackCount.toLocaleString("en");
  $("#total-tracks").textContent = `${trackCount.toLocaleString("en")} ${trackCount === 1 ? "track" : "tracks"}`;
  $("#history-count").textContent = state.history.length;
  if (!state.screen || state.screen === "albums") $("#breadcrumb").textContent = state.artist || "Albums";
  $("#page-title").textContent = state.artist || "Your albums.";
  $("#page-eyebrow").textContent = state.artist ? "ALBUM ARTIST" : "A LITTLE ORDER. ONE ALBUM AT A TIME.";
  renderArtistPanel();
  $("#page-subtitle").textContent = $("#filter").value === "duplicates"
    ? "Albums with repeated track numbers on the same disc, including tracks whose titles differ. Open an album to compare the copies."
    : state.artist ? "Open an album to listen, or select albums by this artist to edit or move to the trash together." : live() ? "Browse your collection, play an album, or select albums to move to the trash together." : "Browse your collection, play an album, and edit its details when you choose.";
  $("#selection-help").textContent = state.artist ? "Selection is limited to this artist" : live() ? "Select albums to move them to the trash together" : "Open an album to see its tracks and listen";
  $("#all-albums").classList.toggle("active", !state.artist && (!state.screen || state.screen === "albums"));
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  const items = filteredAlbums(), size = pageSize(), maxPage = Math.max(0, Math.ceil(items.length / size) - 1);
  $("#per-page").value = String(size);
  state.page = Math.min(state.page, maxPage);
  $("#results-count").textContent = `${items.length.toLocaleString("en")} ${items.length === 1 ? "album" : "albums"}${state.artist ? ` by ${state.artist}` : " in your collection"}`;
  const page = items.slice(state.page * size, (state.page + 1) * size);
  $("#albums").className = state.view === "list" ? "album-list" : "album-grid";
  $("#albums").innerHTML = (page.length ? (state.view === "list" ? listView(page) : gridView(page)) : "") || (state.loading ? '<div class="empty"><span class="spinner"></span>Checking your iBroadcast library… A full download of a large library can take half a minute.</div>' : '<div class="empty">No albums match your filters. Try another artist or search.</div>');
  $("#selection-bar").hidden = !state.selected.size;
  $("#trash-selection").hidden = !live();
  $("#trash-selection").disabled = saving || checking > 0 || !state.selected.size;
  $("#edit-selection").hidden = !state.artist;
  const chosen = albumShelf().filter(a => itemIds(a).some(id => state.selected.has(id)));
  const visible = new Set(items), outside = chosen.filter(a => !visible.has(a)).length;
  $("#selection-count").textContent = `${chosen.length} ${chosen.length === 1 ? "album" : "albums"} selected${state.artist ? ` · ${state.artist}` : ""}${outside ? ` · ${outside} outside current results` : ""}`;
  $("#pagination").innerHTML = maxPage > 0 ? `<button class="button small" data-page="-1" ${state.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${state.page + 1} of ${(maxPage + 1).toLocaleString("en")}</span><button class="button small" data-page="1" ${state.page === maxPage ? "disabled" : ""}>Next →</button>` : "";
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
}

// On an artist's page the artist image takes the place of the library total.
function renderArtistPanel() {
  const panel = $("#artist-panel"), albums = state.artist ? albumShelf().filter(a => albumHasArtist(a, state.artist)) : [];
  $("#library-total").hidden = Boolean(state.artist);
  panel.hidden = !state.artist;
  if (!state.artist) return;
  const people = albums.flatMap(albumArtistEntries).filter(a => a.name === state.artist);
  const image = people.find(a => a.image)?.image || "";
  const canChange = live() && people.some(a => Number(a.id) > 0);
  const tracks = albums.reduce((sum, a) => sum + a.track_count, 0);
  panel.innerHTML = `<div class="artist-photo">${image ? `<img src="${escapeHtml(image.replace(/-150$/, "-300"))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${escapeHtml(initials(state.artist))}</span></div><div class="artist-meta"><strong>${albums.length.toLocaleString("en")}</strong><span>${albums.length === 1 ? "album" : "albums"}</span><small>${tracks.toLocaleString("en")} ${tracks === 1 ? "track" : "tracks"}</small>${canChange ? `<button class="text-action" id="change-artist-page-image">${image ? "Change image" : "Add an image"}</button>` : ""}</div>`;
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

function field(name, label, value, options = {}) {
  const {type = "text", wide = false, hint = "", bulk = false, placeholder = ""} = options;
  return `<div class="field ${wide ? "wide" : ""}">${bulk ? `<label class="field-check"><input type="checkbox" aria-label="Change ${label}" data-enable="${name}"> ${label}</label>` : `<span>${label}</span>`}<input aria-label="${label}" name="${name}" type="${type}" value="${escapeHtml(value || "")}" ${type === "number" ? numberInputAttributes(name, value) : 'maxlength="1000"'} placeholder="${escapeHtml(placeholder)}" ${bulk ? "disabled" : ""}>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

function albumArtistField(albums, bulk) {
  const various = albums.every(a => a.artist_id === 0 && a.artist === "Various Artists");
  const value = various ? "" : common(albums, "artist");
  return `<div class="field wide">${bulk ? '<label class="field-check"><input type="checkbox" aria-label="Change Album artist" data-enable="artist"> Album artist</label>' : '<span>Album artist</span>'}${artistChoiceInput(`aria-label="Album artist" name="artist" type="text" maxlength="1000" value="${escapeHtml(value)}" placeholder="Type to find an existing artist, or enter a new name" ${bulk || various ? "disabled" : ""} ${various ? "hidden" : ""}`, bulk || various)}<label class="checkline"><input type="checkbox" id="album-various-artists" ${various ? "checked" : ""} ${bulk ? "disabled" : ""}> Various Artists</label><small>Choose an existing artist from the suggestions, or type a new name. Track artists stay unchanged.</small></div>`;
}

// Reuse already loaded names; only a small matching list enters the DOM.
const editorArtistChoices = {albums: null, names: null, labels: null, indexes: new Map(), values: [], input: null, results: [], active: -1, details: null, draft: null};

function artistChoiceInput(attributes, disabled = false, kind = "artist") {
  const noun = kind === "genre" ? "genres" : kind === "composer" ? "composers" : "artists";
  return `<span class="artist-choice"><input ${attributes} role="combobox" aria-autocomplete="list" aria-controls="editor-artist-names" aria-expanded="false" data-artist-suggestions data-editor-choice-kind="${kind}" autocomplete="off"><button type="button" class="artist-choice-toggle" data-artist-choices-toggle aria-label="Show existing ${noun}" aria-haspopup="listbox" aria-controls="editor-artist-names" ${disabled ? "disabled" : ""}>▾</button></span>`;
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
  const menu = $("#editor-artist-names"), noun = kind === "genre" ? "genre" : kind === "composer" ? "composer" : "artist";
  menu.setAttribute("aria-label", `Existing ${noun}s`);
  menu.innerHTML = matches.map((name, index) => `<button type="button" role="option" aria-selected="false" tabindex="-1" id="editor-artist-choice-${index}" data-artist-choice="${index}">${escapeHtml(name)}</button>`).join("")
    + `<p class="muted">${matches.length === 40 ? "Showing up to 40 matches. Type more to narrow the list." : matches.length ? `Choose ${noun === "artist" ? "an" : "a"} ${noun}, or type a new name.` : `No existing ${noun} matches. You can keep this new name.`}</p>`;
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
    } catch (error) { toast(error.message); return; }
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
    toast("Choose albums within one artist."); return;
  }
  let albums;
  opening = true; document.body.classList.add("busy");
  try {
    albums = await albumDetails(chosen.map(a => String(a.id)));
  } catch (error) {
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
    toast(`Could not open the album: ${error.message}`); return;
  } finally { opening = false; document.body.classList.remove("busy"); }
  if (albums.length !== chosen.length) { toast("This album is no longer in your library. Reload the library."); return; }
  if (whole) albums.sort((a, b) => (a.disc || 0) - (b.disc || 0));
  const album = albums[0], bulk = albums.length > 1 && !whole, single = !bulk;
  editing = {ids: albums.map(a => String(a.id)), originals: structuredClone(albums), trackPatches: {}, bulk, set: whole, dirty: new Set()};
  resetEditorArtistChoices();
  const allTracks = albums.flatMap(a => a.tracks);
  // Two discs of one set with one disc number would no longer be a set.
  const sameSet = bulk && albums.some(a => (discSet(a) || []).filter(d => editing.ids.includes(String(d.id))).length > 1);
  const mixed = key => whole && !common(albums, key) && albums.some(a => a[key]) ? {placeholder: "Mixed: the discs differ"} : {};
  const trackRow = t => `<tr data-row="${escapeHtml(t.id)}"><td>${live() ? `<button class="play" data-play="${escapeHtml(t.id)}" aria-label="Play ${escapeHtml(t.title)}">▶</button>` : ""}${t.track || "–"}</td><td>${escapeHtml(t.title)}${t.composers?.length ? `<small class="track-composer">${escapeHtml(t.composers.join(", "))}</small>` : ""}</td><td>${t.year || "–"} / <span data-genre-cell="${escapeHtml(t.id)}" class="${hasCombined(t.genres) ? "combined" : ""}">${escapeHtml(genresText(t.genres) || "No genre")}</span></td><td><button class="track-edit" data-track="${escapeHtml(t.id)}">Edit</button></td></tr>`;
  const trackRows = whole ? albums.map(a => `<tr class="disc-row"><td colspan="4">Disc ${a.disc || "?"}</td></tr>${a.tracks.map(trackRow).join("")}`).join("") : album.tracks.map(trackRow).join("");
  $("#editor-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${whole ? `ONE ALBUM / ALL ${albums.length} DISCS` : bulk ? "ONE ARTIST / SELECTED ALBUMS" : "ONE ALBUM / YOUR DETAILS"}</div><h2>${bulk ? "Edit selected albums" : "Edit album"}</h2></div><div class="dialog-heading-actions"><button type="button" class="button small help-trigger" data-help-context="editing" aria-label="Help with album editing" title="Help with album editing">?</button><button class="close" data-close="editor" aria-label="Close album editor">×</button></div></div><div class="album-header">${bulk || !live() ? cover(album, true) : `<button class="cover-button" id="change-cover" title="Change the cover">${cover(album, true)}<span>Change cover</span></button>`}<div><h3>${escapeHtml(bulk ? `${albums.length} albums by ${state.artist || album.artist}` : album.name)}</h3><div class="muted">${escapeHtml(album.artist)} <span aria-hidden="true">·</span> ${allTracks.length} tracks${whole ? ` <span aria-hidden="true">·</span> ${albums.length} discs` : !bulk ? ` <span aria-hidden="true">·</span> ${discLabel(album) || `Disc ${album.disc || "unknown"}`}` : ""}${!bulk && !whole && discSet(album) ? ` <button class="text-action" data-edit-set="${escapeHtml(album.id)}">Edit all ${discSet(album).length} discs together →</button>` : ""}</div><div class="header-actions"><span class="pill">${live() ? "Live iBroadcast library" : "Sample data · local draft"}</span>${live() && single ? `<button class="text-action" data-play-album>▶ Play album</button>${album.artist_id ? `<button class="text-action" id="change-artist-image">${avatar(album.artist, album.artist_image)}Artist image</button>` : ""}` : ""}</div></div></div><div class="edit-layout"><form id="metadata-form"><div class="fields">${bulk ? "" : field("name", "Album title", whole ? common(albums, "name") : album.name, {wide: true, ...mixed("name")})}${albumArtistField(albums, bulk)}${creditsField(albums[0], {album: true, bulk: bulk || !albums.every(a => sameValue(a.credits || [], albums[0].credits || [])), mixed: !albums.every(a => sameValue(a.credits || [], albums[0].credits || []))})}${field("year", "Release year", common(albums, "year"), {type: "number", bulk, hint: "1800–2050. Use 0 to clear the year.", ...mixed("year")})}${whole || sameSet ? "" : field("disc", "Disc number", common(albums, "disc"), {type: "number", bulk})}${genreField("genres", "Genres · all tracks in this selection", allTracks.every(t => sameValue(t.genres, allTracks[0].genres)) ? allTracks[0].genres : [], {bulk, mixed: !allTracks.every(t => sameValue(t.genres, allTracks[0].genres)), hint: "The first genre is the main one; click another to make it the main genre."})}${allTracks.some(t => hasCombined(t.genres)) ? `<p class="genre-note wide">${allTracks.filter(t => hasCombined(t.genres)).length} ${allTracks.filter(t => hasCombined(t.genres)).length === 1 ? "track has" : "tracks have"} several genres stored as one text, like “${escapeHtml(allTracks.find(t => hasCombined(t.genres)).genres.find(g => g.includes(";")))}”. <button type="button" class="text-action" data-split-album-genres>Split combined genres</button></p>` : ""}${genreField("composers", "Composers · all tracks in this selection", allTracks.every(t => sameValue(t.composers, allTracks[0].composers)) ? allTracks[0].composers : [], {bulk, ordered: false, noun: "composer", mixed: !allTracks.every(t => sameValue(t.composers, allTracks[0].composers)), hint: "Mostly for classical music. A name iBroadcast doesn't know yet is added as an artist when you save."})}</div><label class="checkline"><input type="checkbox" id="track-years"> Also apply the release year to tracks in this selection</label><div class="scope-note">${whole ? `All ${albums.length} discs of this album are included; iBroadcast keeps each disc as its own album and gets the change once per disc. A cover goes on every disc; change a disc number per disc, from the album page.` : bulk ? `Only these ${albums.length} selected albums and their tracks are included. Check a field to change it; unchecked fields stay as they are.` : "Only this album is being edited. Suggestions only fill in the form: nothing is saved until you review it."}</div><div id="track-inline"></div></form>${bulk ? '<aside class="sources"><div class="eyebrow">YOUR SELECTION</div><h3>Included albums</h3>' + albums.map(a => `<p class="muted">${escapeHtml(a.name)}${discLabel(a) ? ` · ${discLabel(a)}` : ""}</p>`).join("") + '<div class="year-note"><strong>Look up one album at a time</strong>Open an individual album to consult MusicBrainz or Last.fm.</div></aside>' : lookupPanel(album)}</div>${bulk ? "" : `<div class="tracks-heading"><h3>Tracks <span class="muted">(${allTracks.length})</span></h3><span class="muted">Edit a track individually</span></div><table class="track-table"><thead><tr><th>#</th><th>Title</th><th>Year / Genre</th><th></th></tr></thead><tbody>${trackRows}</tbody></table>`}<div class="dialog-footer"><span class="muted">${live() ? "You review every change before it is saved to iBroadcast." : "Nothing is sent to iBroadcast."}</span><button class="button" data-close="editor">Cancel</button>${bulk ? "" : `<button class="button" id="next-album" ${nextAlbumId(album.id) ? "" : "disabled"}>Next album →</button>`}<button class="button primary" id="review-button">Review draft →</button></div>`;
  $("#metadata-form").addEventListener("submit", e => e.preventDefault());
  const various = albums.map(a => a.artist_id === 0 && a.artist === "Various Artists");
  $("#album-various-artists").checked = various.every(Boolean);
  $("#album-various-artists").indeterminate = various.some(Boolean) && !various.every(Boolean);
  syncAlbumArtistControls();
  $("#editor").showModal();
  if (!bulk) startLookups(album);
}

function readNumber(value) {
  if (value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw Error("Numbers must be whole values from 0 to 9999.");
  return n;
}

function readYear(value) {
  const n = Number(value || 0);
  if (!Number.isInteger(n) || (n !== 0 && (n < 1800 || n > 2050))) {
    throw Error("Years must be from 1800 to 2050. Use 0 to clear the year.");
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
  catch (error) { message = error.message; }
  input.setCustomValidity?.(message);
}

function stashTrack() {
  const pane = $("#track-inline");
  if (!pane?.dataset.track) return;
  const original = editing.originals.flatMap(a => a.tracks).find(t => String(t.id) === pane.dataset.track);
  const data = {};
  for (const input of pane.querySelectorAll("input[data-key]")) {
    if (input.dataset.key === "year" && input.validity?.badInput) {
      throw Error("Years must be from 1800 to 2050. Use 0 to clear the year.");
    }
    data[input.dataset.key] = input.type === "number" ? readMetadataNumber(input.dataset.key, input.value, original[input.dataset.key]) : input.value.trim();
  }
  const genres = pane.querySelector('[data-genres="track-genres"]');
  if (genres) { commitTyped(genres); data.genres = getGenres(genres); }
  const composers = pane.querySelector('[data-genres="track-composers"]');
  if (composers) { commitTyped(composers); data.composers = getGenres(composers); }
  const credits = pane.querySelector('[data-credit-editor="track-credits"]');
  if (credits && (credits.dataset.dirty === "true" || editing.trackPatches[pane.dataset.track]?.credits)) data.credits = readCredits(credits);
  if (!data.title) throw Error("A track title cannot be empty.");
  editing.trackPatches[pane.dataset.track] = Object.fromEntries(Object.entries(data).filter(([key, value]) => !sameValue(original[key], value)));
}

function editTrack(id) {
  try { stashTrack(); } catch (error) { toast(error.message); return; }
  showTrackGenres();
  const original = editing.originals.flatMap(a => a.tracks).find(t => String(t.id) === id);
  if (!original) return;
  const track = {...original, ...(editing.trackPatches[id] || {})};
  const pane = $("#track-inline"); pane.dataset.track = id;
  pane.innerHTML = `<div class="track-inline"><h3>Track ${original.track}: ${escapeHtml(original.title)}</h3><div class="fields">${[["title", "Track title", "text"], ["artist", "Track artist", "text"], ["year", "Track year", "number"], ["track", "Track number", "number"]].map(([key, label, type]) => `<label class="field ${key === "title" ? "wide" : ""}"><span>${label}</span>${key === "artist" ? artistChoiceInput(`data-key="artist" aria-label="Track artist" type="text" maxlength="1000" value="${escapeHtml(track.artist || "")}" placeholder="Find an existing artist, or enter a new name"`) : `<input data-key="${key}" aria-label="${label}" type="${type}" ${type === "number" ? numberInputAttributes(key, original[key]) : 'maxlength="1000"'} value="${escapeHtml(track[key] || "")}">`}</label>`).join("")}${genreField("track-genres", "Track genres", track.genres || [])}${creditsField(track)}</div><p class="muted">Track years: 1800–2050; use 0 to clear. Individual track edits take priority over album-wide track changes.</p></div>`;
  pane.scrollIntoView({block: "nearest", behavior: "smooth"});
}

function buildReview() {
  try {
    stashTrack();
    const form = $("#metadata-form");
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
      if (["name", "artist"].includes(key) && !value) throw Error("Album title and artist cannot be empty.");
      if (editing.originals.every(item => item[key] === value)) continue;
      albumPatch[key] = value;
    }
    const credits = form.querySelector('[data-credit-editor="album-credits"]');
    if (credits && !credits.classList.contains("disabled") && credits.dataset.dirty === "true") albumPatch.credits = readCredits(credits);
    if (albumPatch.artist_id === 0) albumPatch.credits = [];
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
      if (form.elements.year.disabled) throw Error("Enable Release year before applying it to tracks.");
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
    if (!changes.length) { toast("There are no changes to review."); return; }
    pending = {scope: editing.bulk ? "artist" : "album", selection: editing.originals.map(a => ({id: a.id, name: a.name, artist: a.artist})), changes};
    showReview(changes);
  } catch (error) { toast(error.message); }
}

const shown = value => (Array.isArray(value) ? value.map(entry => typeof entry === "object" && entry !== null
  ? `${entry.name} (${creditRoleLabels[entry.type || "artist"] || entry.type}${entry.phrase ? ` · ${entry.phrase}` : ""})` : entry).join(" · ") : value) || "Empty";
const fieldLabel = key => key === "credits" ? "Additional artists and credits" : key === "name" ? "Title" : key === "track" ? "Track number" : key === "artist_id" ? "Album artist" : key[0].toUpperCase() + key.slice(1);
const fieldShown = (key, values, side) => key === "artist_id" ? values[`${side}_name`] || (values[side] === 0 ? "Various Artists" : `Artist ${values[side]}`) : shown(values[side]);

// Albums one by one; track changes grouped by field and value, so twelve tracks that get
// the same genre read as one line instead of twelve.
function reviewList(changes) {
  const row = (key, v) => `<div class="diff-row"><span>${escapeHtml(fieldLabel(key))}</span><del>${escapeHtml(fieldShown(key, v, "before"))}</del><span>→</span><ins>${escapeHtml(fieldShown(key, v, "after"))}</ins></div>`;
  const albums = changes.filter(c => c.kind === "album");
  const tracks = changes.filter(c => c.kind === "track");
  const severalAlbums = new Set(tracks.map(c => String(c.albumId))).size > 1;
  const albumName = id => {
    const a = state.details.get(String(id)) || editing?.originals.find(o => String(o.id) === String(id));
    return a ? a.name + (discSet(a) ? ` · Disc ${a.disc || "?"}` : "") : "";
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
    : `<details class="diff-tracks"><summary>${g.labels.length} tracks</summary><ul>${g.labels.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul></details>`}`).join("");
  return albums.map(c => `<section class="diff-group"><h3>Album · ${escapeHtml(c.label)}</h3>${Object.entries(c.fields).map(([key, v]) => row(key, v)).join("")}</section>`).join("")
    + (tracks.length ? `<section class="diff-group"><h3>${tracks.length === 1 ? "Track" : `Tracks · ${tracks.length} changed`}</h3>${trackRows}</section>` : "");
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
    if (!target) { toast("The selection changed. Open the album again."); return; }
    for (const [key, value] of Object.entries(change.fields)) if (!sameValue(key === "credits" ? creditValues(target) : target[key], value.before)) { toast("A value changed since this draft. Review it again."); return; }
  }
  const next = thenNext();
  applyLocally(pending.changes);
  state.history.unshift({...structuredClone(pending), created: new Date().toISOString(), status: "preview_only", source: state.mode});
  pending = null; editing = null; state.selected.clear();
  if (next) setTimeout(() => openEditor(shelfIds(next)), 0);
  if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
  $("#review").close(); $("#editor").close(); render();
  toast("Draft applied to this preview. Your iBroadcast library was not changed.");
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

function showHistory() {
  $("#history-status").textContent = "";
  $("#history-clear-review").hidden = true;
  updateHistoryControls();
  $("#history-content").innerHTML = state.history.length ? state.history.map((entry, index) => `<section class="history-item">${statusPill(entry.status)}${entry.artwork && !entry.undone && ["saved", "sent", "unverified"].includes(entry.status) ? `<button class="button small history-undo" data-undo="${index}" ${artworkUndoNote(entry) ? `disabled title="${escapeHtml(artworkUndoNote(entry))}"` : ""}>Undo</button>` : ""}${entry.artwork ? `<div class="history-art">${entry.artwork.before ? `<img src="${escapeHtml(entry.artwork.before)}" alt="Before" referrerpolicy="no-referrer">` : ""}<span>→</span><img src="${escapeHtml(entry.artwork.after)}" alt="After" referrerpolicy="no-referrer"></div>` : ""}${entry.artwork && !entry.undone && artworkUndoNote(entry) ? `<p class="muted">${escapeHtml(artworkUndoNote(entry))}</p>` : ""}<h3>${escapeHtml([...new Set(entry.selection.map(a => a.name))].join(", "))}</h3><p class="muted">${new Date(entry.created).toLocaleString("en-GB")} · ${entry.changes.length} records</p>${entry.error ? `<div class="error-box">${escapeHtml(entry.error)}</div>` : ""}${!entry.artwork && !entry.trash && entry.source === "ibroadcast" && entry.changes.some(c => ["failed", "not_sent", "blocked"].includes(c.status)) ? `<p><button class="button small" data-review-rest="${index}">Review the rest again →</button></p>` : ""}${entry.changes.map(c => `<p class="muted">${c.status ? statusPill(c.status) + " " : ""}${escapeHtml(c.label)}: ${Object.entries(c.fields).map(([key, v]) => `${escapeHtml(fieldLabel(key))}: ${escapeHtml(fieldShown(key, v, "before"))} → ${escapeHtml(fieldShown(key, v, "after"))}`).join(" · ")}</p>`).join("")}</section>`).join("") : '<p class="empty">No drafts yet. Open an album to start editing.</p>';
  $("#history").showModal();
}

document.addEventListener("click", event => {
  const close = event.target.closest("[data-close]");
  if (close) { $(`#${close.dataset.close}`).close(); return; }
  const artist = event.target.closest("[data-artist]");
  if (artist) { setArtist(artist.dataset.artist); return; }
  const album = event.target.closest("[data-album]");
  if (album) {
    coverClick(event, () => openAlbum(album.dataset.album), coverPreviewFor(event.target)); return;
  }
  const track = event.target.closest("[data-track]");
  if (track) { editTrack(track.dataset.track); return; }
  const page = event.target.closest("[data-page]");
  if (page) { state.page += Number(page.dataset.page); render(); return; }
  if (event.target.closest("#review-button")) buildReview();
});
document.addEventListener("change", event => {
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
for (const id of ["#filter", "#sort"]) $(id).addEventListener("change", () => { state.page = 0; render(); });
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
  if (!state.history.length) { toast("Make and review an edit before exporting the change history."); return; }
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
    $(id).title = busy ? "Wait until saves and their checks have finished." : "";
  }
}

$("#history-clear").addEventListener("click", () => {
  if (!state.history.length || saving || checking) return;
  $("#history-status").textContent = "";
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
    $("#history-status").textContent = "Change history could not be cleared from browser storage. Try again when storage is available.";
    return;
  }
  state.history = [];
  render(); showHistory();
  $("#history-content").innerHTML = '<p class="empty">Change history cleared. Your library is unchanged.</p>';
  $("#history .close").focus();
});
window.addEventListener("beforeunload", event => { if (saving || state.history.some(h => h.status === "preview_only")) { event.preventDefault(); event.returnValue = ""; } });
useLocal(demoLibrary(), "demo");
updateChrome();
render();
boot();

// ---- iBroadcast connection --------------------------------------------------

async function api(path, body) {
  const options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-Tagcast": "1"}, body: JSON.stringify(body)};
  const response = await fetch(path, options);
  let data = {};
  try { data = await response.json(); } catch { /* empty or non-JSON body */ }
  if (!response.ok) {
    const error = Error(data.error || `Tagcast returned HTTP ${response.status}.`);
    error.status = response.status; error.data = data;
    throw error;
  }
  return data;
}

function colorize(albums) {
  const known = new Map(state.albums.map(a => [String(a.id), a.color]));
  return albums.map((a, i) => ({...a, color: known.get(String(a.id)) || colors[i % colors.length]}));
}

function statusPill(status) {
  const labels = {saved: "Saved", sent: "Checking…", blocked: "Not sent · setting", unverified: "Not confirmed", failed: "Failed", not_sent: "Not sent", preview_only: "Preview only"};
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(labels[status] || status)}</span>`;
}

function updateChrome() {
  if (typeof csvImportCurrent === "function" && $("#playlist-import").open && !csvImportCurrent()) resetPlaylistImport();
  if (typeof syncMetadataExport === "function") syncMetadataExport();
  if (typeof updateAlbumGuideControls === "function") updateAlbumGuideControls();
  if (typeof updateRecentlyPlayedControls === "function") updateRecentlyPlayedControls();
  if (typeof updateFavouriteControls === "function") updateFavouriteControls();
  updateHistoryControls();
  const c = state.connection;
  $("#status-dot").className = `status-dot ${live() && !state.loading ? "live" : state.loading ? "busy" : ""}`;
  $("#connection-title").textContent = live() ? `${c.account || "Connected"} · iBroadcast` : c.connected ? `${c.account || "Connected"} · Snapshot` : "Preview workspace";
  $("#connection-title").title = c.connected ? `Connected to iBroadcast as ${c.account || "your account"}` : "No iBroadcast account connected";
  $("#connection-text").hidden = live();
  $("#connection-text").textContent = live() ? "" : c.connected ? "Reload your library to edit it live." : "No account connected. Edits stay in this browser tab.";
  $("#connect-button").hidden = c.connected;
  $("#reload-button").hidden = !c.connected;
  $("#logout-button").hidden = !c.connected;
  const badge = $("#mode-badge");
  badge.classList.toggle("live", live());
  badge.textContent = state.loading ? "Loading library…" : checking ? "Checking saves…" : live() ? "Live" : "Demo · Connect";
  badge.title = c.connected ? `Connected as ${c.account || "your iBroadcast account"}. Open connection details.` : "Connect your iBroadcast account.";
  badge.setAttribute("aria-label", `${badge.textContent}. ${badge.title}`);
  $("#data-notice").textContent = live() ? "Live iBroadcast library. Metadata saves are checked against iBroadcast first and read back afterwards. Your music files are never touched."
    : "Demo library with sample records. Connect your iBroadcast account to edit your own collection.";
  $("#library-notice").hidden = !libraryNotice.visible;
  $("#library-loading").hidden = !state.loading;
  $("#history-note").textContent = live() ? "Saved changes are listed with their read-back status. Export the changes if you want a record of this session." : "Export the changes before closing this tab. Preview drafts are not saved to iBroadcast.";
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has("auth_error")) toast(`Sign-in failed: ${params.get("auth_error")}`);
  if (params.has("connected")) toast("Connected to iBroadcast.");
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
  const request = ++libraryLoadRequest, session = state.connection.playback_session;
  const current = () => request === libraryLoadRequest && session === state.connection.playback_session;
  let completed = false;
  resetEditorArtistChoices();
  if (typeof resetTags === "function") resetTags();
  if (typeof closeHelp === "function") closeHelp(false);
  if (typeof resetGuideAlbumNotes === "function") resetGuideAlbumNotes();
  if (typeof resetAlbumGuide === "function") resetAlbumGuide(false);
  if (typeof resetCleanup === "function") resetCleanup();
  if (typeof resetDuplicateCleanup === "function") resetDuplicateCleanup(true);
  if (typeof resetSelectedAlbumTrash === "function") resetSelectedAlbumTrash();
  if (typeof resetArtistBrowse === "function") resetArtistBrowse();
  if (typeof resetAlbumInformation === "function") resetAlbumInformation();
  if (typeof resetBrowse === "function") resetBrowse();
  if (typeof resetFavourites === "function") resetFavourites();
  if (typeof resetPlaylistImport === "function") resetPlaylistImport();
  if (typeof resetRecentlyPlayed === "function") resetRecentlyPlayed();
  if (typeof resetAlbumView === "function") resetAlbumView();
  state.loading = true; state.mode = "live"; state.albums = []; state.details = new Map(); state.selected.clear(); state.editorNames = {genres: [], composers: []};
  state.albumFavourites = new Set(); state.albumFavouriteError = "";
  state.artistFavourites = new Set(); state.artistFavouriteError = "";
  $("#library-loading-detail").textContent = refresh ? "Downloading a fresh copy of your collection. Large libraries can take a little while." : "Checking for changes and retrieving your collection. Large libraries can take a little while.";
  updateChrome(); render();
  try {
    const data = await api(`/api/library${refresh ? "?refresh=1" : ""}`);
    if (!current()) return;
    completed = true;
    state.albums = colorize(data.albums); state.artistNames = data.artists || [];
    applyEditorNames(data.editor_names);
    state.albumFavourites = new Set(data.album_favourites?.albums || []);
    state.albumFavouriteError = data.album_favourites?.error || "";
    state.artistFavourites = new Set(data.artist_favourites?.artists || []);
    state.artistFavouriteError = data.artist_favourites?.error || "";
    state.connection.combine_sets = Boolean(data.combine_sets);
    if (Object.hasOwn(data, "premium")) state.connection.premium = data.premium;
    if (typeof favourites !== "undefined") favourites.count = data.favourites_count ?? null;
    const count = `${state.albums.length.toLocaleString("en")} albums`;
    toast(data.source === "download" ? `Downloaded ${count} from iBroadcast.` : `Loaded ${count}. Nothing changed in iBroadcast since the last download.`);
  } catch (error) {
    if (!current()) return;
    completed = true;
    if (error.status === 401) state.connection.connected = false;
    useLocal(demoLibrary(), "demo");
    toast(`Could not load your library: ${error.message}`);
  } finally {
    if (!completed && request !== libraryLoadRequest) return;
    if (!completed && session !== state.connection.playback_session) {
      state.loading = false; updateChrome(); return;
    }
    state.loading = false;
    if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
    state.page = 0; updateChrome(); render();
    if (typeof refreshPlayerRatings === "function") refreshPlayerRatings();
    if (typeof restorePendingRoute === "function") restorePendingRoute();
  }
}

function connectView(view, extra = {}) {
  const c = state.connection, box = $("#connect-content");
  const error = extra.error ? `<div class="error-box">${escapeHtml(extra.error)}</div>` : "";
  if (view === "connected") {
    box.innerHTML = `<div class="connect-step"><p class="muted">Connected${c.account ? ` as <strong>${escapeHtml(c.account)}</strong>` : ""}. Tagcast can read your library and save metadata you review.</p>${error}</div><div class="dialog-footer"><button class="button" id="connect-logout">Disconnect</button><button class="button" id="connect-redownload" title="Normally the library is only downloaded when iBroadcast reports a change">Download everything again</button><button class="button primary" id="connect-reload">Reload library</button></div>`;
  } else if (view === "ready") {
    const previous = c.using_default_client === false;
    box.innerHTML = `<div class="connect-step"><p class="muted">Sign in with a short code on the iBroadcast website. Tagcast asks for permission to <strong>read and edit your music library</strong> and to show your account name. Your password stays on iBroadcast.</p><p class="muted">${previous ? "Your previously configured app registration is still in use." : "Tagcast is already registered with iBroadcast. You do not need to create an app or enter a client ID."}</p>${error}</div><div class="dialog-footer">${previous && !c.client_id_from_env && !c.connected ? '<button class="text-button" id="client-default" style="color:var(--green);margin-right:auto">Use Tagcast sign-in</button>' : ""}${previous ? '<button class="button" id="browser-start">Use browser redirect</button>' : ""}<button class="button primary" id="device-start">Sign in with a code →</button></div>${previous ? `<p class="muted">Browser redirect uses <code>http://127.0.0.1:${location.port || 80}/callback</code>; it must match your existing registration.</p>` : ""}`;
  } else if (view === "device") {
    const d = extra.device, link = d.verification_uri_complete || d.verification_uri;
    box.innerHTML = `<div class="connect-step"><p class="muted">Open the iBroadcast sign-in page and enter this code:</p><div class="device-code">${escapeHtml(d.user_code)}</div><p class="muted"><span class="spinner"></span>Waiting for you to approve Tagcast…</p>${error}</div><div class="dialog-footer"><button class="button" id="device-cancel">Cancel</button><a class="button primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open iBroadcast sign-in ↗</a></div>`;
  }
}

function openConnect() {
  const c = state.connection;
  connectView(c.device?.state === "pending" ? "device" : c.connected ? "connected" : "ready", {device: c.device});
  if (c.device?.state === "pending") pollDevice();
  $("#connect").showModal();
}

function stopPoll() { clearTimeout(devicePoll); devicePoll = null; }

function pollDevice() {
  stopPoll();
  devicePoll = setTimeout(async () => {
    try {
      const status = await api("/api/status");
      state.connection = status;
      if (status.connected && !["pending", "error"].includes(status.device?.state)) {
        stopPoll(); $("#connect").close(); toast("Connected to iBroadcast."); updateChrome(); loadLive(); return;
      }
      if (!status.device) { stopPoll(); return; }
      if (status.device.state === "error") { stopPoll(); connectView("ready", {error: status.device.error}); return; }
      if (status.device.expires_at && status.device.expires_at * 1000 < Date.now()) { stopPoll(); connectView("ready", {error: "The code expired. Start again."}); return; }
    } catch { /* keep polling through brief hiccups */ }
    pollDevice();
  }, 2000);
}

async function connectAction(target) {
  try {
    if (target.id === "client-default") {
      state.connection = await api("/api/config/default", {});
      updateChrome(); connectView("ready");
    } else if (target.id === "device-start") {
      target.disabled = true;
      const {device} = await api("/api/auth/device", {});
      state.connection.device = device;
      connectView("device", {device}); pollDevice();
    } else if (target.id === "device-cancel") {
      stopPoll(); await api("/api/auth/cancel", {}); state.connection.device = null; connectView("ready");
    } else if (target.id === "browser-start") {
      const {url} = await api("/api/auth/browser", {});
      location.href = url;
    } else if (target.id === "connect-reload" || target.id === "reload-button") {
      $("#connect").close(); loadLive();
    } else if (target.id === "connect-redownload") {
      $("#connect").close(); loadLive(true);
    } else if (target.id === "connect-logout" || target.id === "logout-button") {
      if (!confirm("Disconnect from iBroadcast? Your saved changes stay in iBroadcast; the sign-in on this computer is removed.")) return;
      await api("/api/auth/logout", {});
      state.connection = {...state.connection, connected: false, account: "", device: null};
      if ($("#connect").open) $("#connect").close();
      useLocal(demoLibrary(), "demo"); state.artist = null; state.selected.clear();
      updateChrome(); render(); toast("Disconnected. The sign-in was removed from this computer.");
    }
  } catch (error) {
    target.disabled = false;
    const view = ["device-start", "browser-start", "client-default"].includes(target.id) ? "ready" : state.connection.connected ? "connected" : "ready";
    if ($("#connect").open) connectView(view, {error: error.message}); else toast(error.message);
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
  apply.textContent = live() ? `Save ${count} ${count === 1 ? "record" : "records"} to iBroadcast` : "Apply to preview";
  $("#review-cancel").disabled = false;
  $("#review-status").innerHTML = "";
  $("#review-intro").textContent = live()
    ? "Saving writes these values to your iBroadcast library. Tagcast first checks that nothing changed in iBroadcast since you loaded it; if something did, nothing is written."
    : "These changes apply only to this preview. Connect your account to save them to iBroadcast.";
  const warnings = [];
  if (live()) {
    const known = knownArtists();
    const fresh = [...new Set(changes.flatMap(c => [...(c.fields.artist ? [c.fields.artist.after] : []), ...(c.fields.composers?.after || [])]))].filter(n => !known.has(n.toLocaleLowerCase()));
    if (fresh.length) warnings.push(`New ${fresh.length === 1 ? "artist" : "artists"} in iBroadcast: ${fresh.map(n => `“${escapeHtml(n)}”`).join(", ")}. Check the spelling; Tagcast will create ${fresh.length === 1 ? "it" : "them"} unless your library already has ${fresh.length === 1 ? "an artist" : "artists"} with that name.`);
    if (state.connection.combine_sets && changes.some(c => c.kind === "album")) warnings.push("“Combine Multi-Disc Album Sets” is on in your iBroadcast settings. iBroadcast doesn't accept album changes (title, album artist, year, disc) while it is, so those will not be sent; track changes such as genres are saved. To save album changes, turn the setting off in iBroadcast first, then use “Review the rest” afterwards.");
    if (changes.some(c => c.kind === "album" && c.fields.artist)) warnings.push("Changing an album artist can make iBroadcast regroup the album. The library is read back after saving so you see the result.");
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
  const apply = $("#apply-draft");
  apply.disabled = true; $("#review-cancel").disabled = true; apply.textContent = "Saving…";
  $("#review-status").innerHTML = '<span class="spinner"></span>Checking iBroadcast and saving…';
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
    else toast(`${statuses.length} ${statuses.length === 1 ? "record" : "records"} saved. Checking the result with iBroadcast in the background…`);
    if (result.job) followJob(result.job, entry);
    if (next && overall !== "failed") openEditor(shelfIds(next));
  } catch (error) {
    apply.disabled = false; $("#review-cancel").disabled = false;
    apply.textContent = "Try again";
    if (error.status === 401) {
      state.connection.connected = false; updateChrome();
      $("#review-status").innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
      apply.disabled = true;
    } else if (error.status === 409) {
      $("#review-status").innerHTML = `<span class="error-text">${escapeHtml(error.message)}</span>`;
      apply.textContent = "Reload library"; reloadOnApply = true;
      apply.disabled = false;
      return;
    } else {
      $("#review-status").innerHTML = `<span class="error-text">Nothing was confirmed: ${escapeHtml(error.message)}</span>`;
    }
  } finally {
    saving = false;
  }
}

// Poll the background read-back of a save and update its history entry.
async function followJob(jobId, entry, onDone, stillCurrent = () => true) {
  const order = ++saveOrder;
  rememberHistory();
  checking += 1; updateChrome();
  let job;
  try {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (job.state !== "checking") break;
    }
  } catch (error) {
    job = {state: "error", error: error.message};
  } finally { checking -= 1; updateChrome(); }
  if (!stillCurrent()) return null;
  if (job.state === "error") {
    entry.status = "unverified"; entry.error = [entry.error, job.error].filter(Boolean).join(" ");
    for (const c of entry.changes) if (c.status === "sent") c.status = "unverified";
    rememberHistory(); toast(job.error); return job;
  }
  const byId = new Map(job.results.map(r => [`${r.kind}:${r.id}`, r.status]));
  for (const c of entry.changes) {
    c.status = byId.get(`${c.kind}:${c.id}`) || c.status;
    const result = job.results.find(r => r.kind === c.kind && String(r.id) === String(c.id));
    if (c.status === "saved" && c.fields?.credits && result?.credits) c.fields.credits.after = structuredClone(result.credits);
  }
  entry.status = overallStatus(entry.changes.map(c => c.status));
  rememberHistory();
  if (order !== saveOrder) { /* a later save's read-back brings newer albums */ }
  else if (!$("#editor").open && !$("#review").open) {
    applyEditorNames(job.editor_names);
    state.albums = colorize(job.albums); state.details = new Map();
    if (state.artist && !state.albums.some(a => albumHasArtist(a, state.artist))) state.artist = null;
    render();
  } else { applyEditorNames(job.editor_names); pendingAlbums = job.albums; }
  onDone?.(job);
  const done = job.results.filter(r => r.status === "saved").length;
  if (entry.status === "saved") toast(`Confirmed by iBroadcast: ${done} ${done === 1 ? "record" : "records"} saved.`);
  else showResults({results: job.results, error: entry.error}, entry.status, entry);
  return job;
}

function showResults(result, overall, entry) {
  const rows = result.results || [];
  const saved = rows.filter(r => r.status === "saved").length;
  $("#results-title").textContent = !rows.length ? "Already up to date" : overall === "saved" ? `${saved} ${saved === 1 ? "record" : "records"} saved` : overall === "unverified" ? "Saved, partly not confirmed" : "Save incomplete";
  const notes = [];
  if (result.message) notes.push(`<p class="muted">${escapeHtml(result.message)}</p>`);
  if (result.error) notes.push(`<div class="error-box">${escapeHtml(result.error)}</div>`);
  if (result.created_artists?.length) notes.push(`<p class="muted">New artists created: ${result.created_artists.map(n => `“${escapeHtml(n)}”`).join(", ")}.</p>`);
  if (overall === "unverified") notes.push('<div class="warn-box">iBroadcast accepted the request, but the library it returned does not show every new value yet. Reload the library in a minute to check.</div>');
  if (result.readBackFailed) notes.push('<div class="warn-box">The library could not be read back. Reload it before editing further.</div>');
  const index = entry ? state.history.indexOf(entry) : -1;
  if (index >= 0 && !entry.artwork && !entry.trash && entry.changes.some(c => ["failed", "not_sent", "blocked"].includes(c.status))) {
    notes.push(`<p><button class="button small" data-review-rest="${index}">Review the rest again →</button> <span class="muted">Sends only what wasn't saved.</span></p>`);
  }
  $("#results-content").innerHTML = notes.join("") + rows.map(r => `<div class="result-row"><div>${escapeHtml(r.kind === "album" ? "Album" : "Track")} · ${escapeHtml(r.label)}<small>${escapeHtml(r.fields.map(f => f === "name" ? "title" : f === "track" ? "track number" : f).join(", "))}</small></div>${statusPill(r.status)}</div>`).join("");
  if (!$("#results").open) $("#results").showModal();
}

document.addEventListener("click", event => {
  const target = event.target.closest("#client-default, #device-start, #device-cancel, #browser-start, #connect-reload, #connect-redownload, #connect-logout, #reload-button, #logout-button");
  if (target) connectAction(target);
});
$("#connect-button").addEventListener("click", openConnect);
$("#mode-badge").addEventListener("click", openConnect);

function flushPendingAlbums() {
  if (!pendingAlbums || $("#editor").open || $("#review").open) return;
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
    if (!next || (changed && !confirm("Leave this album without reviewing your changes?"))) return;
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
  else if (rest) toast("Connect your iBroadcast account to save these changes.");
});

document.addEventListener("click", event => {
  const button = event.target.closest("[data-edit-set]");
  if (!button) return;
  const album = state.albums.find(a => String(a.id) === button.dataset.editSet), set = album && discSet(album);
  if (!set) return;
  const changed = editing && (editing.dirty.size || Object.keys(editing.trackPatches).length);
  if (changed && !confirm("Leave this album without reviewing your changes?")) return;
  $("#editor").close();
  openEditor(set.map(a => String(a.id)));
});

// Appearance and colour palette are independent, local-only preferences.
function showTheme() {
  const theme = document.documentElement.dataset.theme || "auto";
  const palette = document.documentElement.dataset.palette || "forest";
  const label = {auto: "Auto", light: "Light", dark: "Dark"}[theme];
  const colour = {forest: "Forest", ocean: "Ocean", warm: "Warm", ibroadcast: "iBroadcast inspired"}[palette];
  $("#theme-button").textContent = `${{auto: "◐", light: "☀", dark: "☾"}[theme]} Theme ▾`;
  $("#theme-button").title = `${colour} · ${label}. Choose colour and appearance.`;
  for (const value of ["auto", "light", "dark"]) $("#appearance-" + value).checked = theme === value;
  for (const value of ["forest", "ocean", "warm", "ibroadcast"]) $("#palette-" + value).checked = palette === value;
}

function setThemeMenu(open, restoreFocus = false) {
  $("#theme-menu").hidden = !open;
  $("#theme-button").setAttribute("aria-expanded", String(open));
  if (open) $("#appearance-" + (document.documentElement.dataset.theme || "auto")).focus();
  else if (restoreFocus) $("#theme-button").focus();
}
$("#theme-button").addEventListener("click", () => setThemeMenu($("#theme-menu").hidden));
$("#theme-menu").addEventListener("change", event => {
  if (event.target.dataset.appearanceChoice !== undefined) {
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
  const palette = ["ocean", "warm", "ibroadcast"].includes(value) ? value : "forest";
  if (palette === "forest") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
  showTheme();
  return palette;
}
try { setColourPalette(localStorage.getItem("tagcast-palette")); }
catch { setColourPalette("forest"); }
setThemeMenu(false);
