"use strict";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const colors = ["#627b70", "#ab7555", "#6c7b89", "#a98a56", "#836d7b", "#71856b"];
// state.albums holds small album summaries (no tracks); full albums live in state.details.
const state = {albums: [], details: new Map(), artistNames: [], artist: null, view: storedView(), history: storedHistory(), selected: new Set(), page: 0, mode: "demo", loading: false, connection: {connected: false, configured: false, account: ""}};
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

function decodeTable(table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) throw Error("This file is missing a library table.");
  const result = {};
  for (const [id, row] of Object.entries(table)) {
    if (!/^\d+$/.test(id)) continue;
    if (Array.isArray(row)) {
      if (!table.map || !Object.keys(table.map).length) throw Error("Array records need an iBroadcast field map.");
      result[id] = Object.fromEntries(Object.entries(table.map).filter(([, index]) => Number.isInteger(index) && index >= 0 && index < row.length).map(([key, index]) => [key, row[index]]));
    } else if (row && typeof row === "object") result[id] = row;
    else throw Error("Unrecognized library record.");
  }
  return result;
}

function importLibrary(input) {
  const raw = input.library || input;
  const albums = decodeTable(raw.albums), tracks = decodeTable(raw.tracks), artists = decodeTable(raw.artists);
  const artistName = id => Number(id) === 0 ? "Various Artists" : String(artists[id]?.name || "Unknown artist");
  return Object.entries(albums).filter(([, a]) => !a.trashed).map(([id, a], index) => {
    const albumTracks = (a.tracks || []).map(t => [t, tracks[t]]).filter(([, t]) => t && !t.trashed);
    return {
      id: String(id), artist: artistName(a.artist_id), name: String(a.name || "Untitled album"),
      year: Number(a.year) || 0, disc: Number(a.disc) || 0, color: colors[index % colors.length],
      tracks: albumTracks.map(([tid, t]) => ({id: String(tid), title: String(t.title || "Untitled track"),
        artist: artistName(t.artist_id), year: Number(t.year) || 0, genre: String(t.genre || ""), track: Number(t.track) || 0,
        genres: [String(t.genre || "").trim(), ...(Array.isArray(t.genres_additional) ? t.genres_additional.map(String) : [])].filter(Boolean)})),
    };
  }).filter(a => a.tracks.length);
}

const trackGenres = t => t.genres ?? (t.genre?.trim() ? [t.genre.trim()] : []);

function summarize(album) {
  const genres = splitGenres(album.tracks.flatMap(trackGenres)).sort();
  return {id: String(album.id), name: album.name, artist: album.artist, year: album.year, disc: album.disc,
    artwork: album.artwork || "", color: album.color, track_count: album.tracks.length, genres,
    no_genre: album.tracks.filter(t => !trackGenres(t).length).length,
    combined_genres: album.tracks.filter(t => hasCombined(trackGenres(t))).length,
    no_composer: album.tracks.filter(t => !(t.composers || []).length).length,
    track_gaps: (numbers => numbers.size ? Math.max(...numbers) - numbers.size : 0)(new Set(album.tracks.map(t => t.track).filter(Boolean))),
    no_cover: album.tracks.filter(t => !(t.artwork_id ?? album.artwork)).length};
}

function useLocal(albums, mode) {
  for (const album of albums) for (const t of album.tracks) { t.genres = trackGenres(t); t.composers ??= []; }
  state.mode = mode; state.artistNames = [];
  state.details = new Map(albums.map(a => [String(a.id), a]));
  state.albums = albums.map(summarize);
}

async function albumDetails(ids) {
  const missing = ids.filter(id => !state.details.has(String(id)));
  if (missing.length && live()) {
    const colorsById = new Map(state.albums.map(a => [String(a.id), a.color]));
    for (let i = 0; i < missing.length; i += 100) {
      const data = await api(`/api/albums?ids=${missing.slice(i, i + 100).map(encodeURIComponent).join(",")}`);
      for (const album of data.albums) state.details.set(String(album.id), {...album, color: colorsById.get(String(album.id))});
    }
  }
  return ids.map(id => state.details.get(String(id))).filter(Boolean);
}

function toast(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, Math.max(6000, text.length * 70));
}

function cover(album, small = false) {
  const initials = album.artist.split(/\s+/).map(s => s[0]).slice(0, 2).join("");
  const art = album.artwork ? `<img src="${escapeHtml(album.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.remove('has-art');this.remove()">` : "";
  return `<div class="cover ${art ? "has-art" : ""}" style="--cover-color:${album.color}">${art}<span class="cover-letter">${escapeHtml(initials)}</span>${small || art ? "" : '<span class="cover-caption">TAGCAST / PLACEHOLDER</span>'}</div>`;
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
  incomplete: ["Possibly incomplete", a => a.track_gaps > 0],  // e.g. tracks 1, 2 and 5  // any track without a cover, like the overview counts
  edition: ["Named editions", a => EDITION.test(a.name)],
};
const SORTS = {
  artist: (a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name),
  title: (a, b) => a.name.localeCompare(b.name),
  year: (a, b) => (a.year || 9999) - (b.year || 9999) || a.name.localeCompare(b.name),
  newest: (a, b) => b.year - a.year || a.name.localeCompare(b.name),
  no_genre: (a, b) => b.no_genre - a.no_genre || SORTS.artist(a, b),
  fewest: (a, b) => a.track_count - b.track_count || SORTS.artist(a, b),
};
const initials = name => name.split(/\s+/).map(s => s[0]).slice(0, 2).join("");
const pageSize = () => state.view === "list" ? 100 : 24;

// Discs of one set (same title and album artist) are separate albums in iBroadcast
// while "Combine Multi-Disc Album Sets" is off.
let discCache = {albums: null, sets: new Map()};
function discSet(album) {
  if (discCache.albums !== state.albums) {
    const sets = new Map();
    for (const a of state.albums) {
      const key = `${a.name.trim().toLocaleLowerCase()}|${a.artist}`;
      if (!sets.has(key)) sets.set(key, []);
      sets.get(key).push(a);
    }
    for (const set of sets.values()) set.sort((a, b) => (a.disc || 0) - (b.disc || 0));
    discCache = {albums: state.albums, sets};
  }
  const set = discCache.sets.get(`${album.name.trim().toLocaleLowerCase()}|${album.artist}`) || [];
  return set.length > 1 && new Set(set.map(a => a.disc)).size === set.length ? set : null;
}
const discLabel = album => { const set = discSet(album); return set ? `Disc ${album.disc || "?"} of ${set.length}` : ""; };

function thumb(album) {
  const art = album.artwork ? `<img src="${escapeHtml(album.artwork.replace(/-300$/, "-150"))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<span class="thumb" style="--cover-color:${album.color}">${art}<span>${escapeHtml(initials(album.artist))}</span></span>`;
}

function avatar(name, image) {
  const img = image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<span class="artist-avatar">${img}${escapeHtml(initials(name))}</span>`;
}

function artistGroups() {
  const groups = new Map();
  for (const a of state.albums) {
    const group = groups.get(a.artist) || {count: 0, image: a.artist_image || ""};
    group.count += 1; groups.set(a.artist, group);
  }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderArtists() {
  const query = $("#artist-search").value.toLocaleLowerCase();
  const groups = artistGroups(), matches = groups.filter(([name]) => name.toLocaleLowerCase().includes(query));
  $("#artist-count").textContent = groups.length.toLocaleString("en");
  $("#artists").innerHTML = matches.slice(0, 200).map(([name, g]) => `<button class="artist-button ${state.artist === name ? "active" : ""}" data-artist="${escapeHtml(name)}">${avatar(name, g.image)}<span>${escapeHtml(name)}</span><b>${g.count}</b></button>`).join("")
    + (matches.length > 200 ? `<p class="artist-more">${(matches.length - 200).toLocaleString("en")} more. Type to narrow the list.</p>` : "");
}

function setArtist(artist) {
  if (state.screen === "overview") showScreen("albums");
  state.artist = artist; state.selected.clear(); state.page = 0;
  $("#search").value = "";
  render();
}

function filteredAlbums() {
  const query = $("#search").value.toLocaleLowerCase().trim(), keep = (FILTERS[$("#filter").value] || FILTERS.all)[1];
  const items = state.albums.filter(a => (!state.artist || a.artist === state.artist) && keep(a)
    && (!query || [a.name, a.artist, ...a.genres].join(" ").toLocaleLowerCase().includes(query)));
  return items.sort(SORTS[$("#sort").value] || SORTS.artist);
}

function badge(a) {
  return !a.year ? '<span class="pill missing">Missing year</span>' : a.no_genre ? '<span class="pill missing">Missing genre</span>' : EDITION.test(a.name) ? '<span class="pill">Edition</span>' : '<span class="pill">Album</span>';
}

function selectBox(a) {
  return state.artist ? `<label class="album-select"><input type="checkbox" data-select="${escapeHtml(a.id)}" aria-label="Select ${escapeHtml(a.name)}" ${state.selected.has(String(a.id)) ? "checked" : ""}></label>` : "";
}

function gridView(items) {
  return items.map(a => `<article class="album-card ${state.selected.has(String(a.id)) ? "selected" : ""}">${selectBox(a)}<button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="Edit ${escapeHtml(a.name)}">${cover(a)}<span class="album-name">${escapeHtml(a.name)}</span><span class="album-artist">${escapeHtml(a.artist)}</span></button><div class="card-meta"><span>${a.year || "Year unknown"} <span aria-hidden="true">·</span> ${a.track_count} tracks${discLabel(a) ? ` <span aria-hidden="true">·</span> ${discLabel(a)}` : ""}</span>${badge(a)}</div></article>`).join("");
}

function listView(items) {
  const genre = a => a.genres.length ? escapeHtml(a.genres.slice(0, 3).join(", ") + (a.genres.length > 3 ? " …" : "")) : "";
  const missing = a => a.no_genre ? `<span class="pill missing">${a.no_genre === a.track_count ? "None" : `${a.no_genre} missing`}</span>` : "";
  return `<table class="album-table"><thead><tr>${state.artist ? '<th class="col-check"></th>' : ""}<th class="col-thumb"></th><th>Album</th><th>Album artist</th><th class="col-num">Year</th><th class="col-num">Tracks</th><th>Genre</th></tr></thead><tbody>${items.map(a => `<tr class="${state.selected.has(String(a.id)) ? "selected" : ""}">${state.artist ? `<td class="col-check">${selectBox(a)}</td>` : ""}<td class="col-thumb"><button class="row-open" data-album="${escapeHtml(a.id)}" aria-label="Edit ${escapeHtml(a.name)}">${thumb(a)}</button></td><td><button class="row-open row-title" data-album="${escapeHtml(a.id)}">${escapeHtml(a.name)}</button>${discLabel(a) ? ` <span class="muted">· ${discLabel(a)}</span>` : a.disc > 1 ? ` <span class="muted">· Disc ${a.disc}</span>` : ""}</td><td><button class="row-artist" data-artist="${escapeHtml(a.artist)}">${avatar(a.artist, a.artist_image)}${escapeHtml(a.artist)}</button></td><td class="col-num">${a.year || '<span class="pill missing">—</span>'}</td><td class="col-num">${a.track_count}</td><td>${genre(a)} ${missing(a)}</td></tr>`).join("")}</tbody></table>`;
}

function render() {
  renderArtists();
  $("#album-count").textContent = state.albums.length.toLocaleString("en");
  $("#total-tracks").textContent = state.albums.reduce((sum, a) => sum + a.track_count, 0).toLocaleString("en");
  $("#history-count").textContent = state.history.length;
  if (state.screen !== "overview") $("#breadcrumb").textContent = state.artist || "Albums";
  $("#page-title").textContent = state.artist || "Your albums.";
  $("#page-eyebrow").textContent = state.artist ? "ALBUM ARTIST" : "A LITTLE ORDER. ONE ALBUM AT A TIME.";
  renderArtistPanel();
  $("#page-subtitle").textContent = state.artist ? "Open an album, or select albums by this artist to edit together." : "Browse your collection, check the details, and make it yours.";
  $("#selection-help").textContent = state.artist ? "Selection is limited to this artist" : "Open an album to edit its metadata";
  $("#all-albums").classList.toggle("active", !state.artist && state.screen !== "overview");
  const scope = state.albums.filter(a => !state.artist || a.artist === state.artist);
  for (const option of $("#filter").options) {
    const [label, keep] = FILTERS[option.value];
    option.textContent = option.value === "all" ? label : `${label} · ${scope.filter(keep).length.toLocaleString("en")}`;
  }
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  const items = filteredAlbums(), size = pageSize(), maxPage = Math.max(0, Math.ceil(items.length / size) - 1);
  state.page = Math.min(state.page, maxPage);
  $("#results-count").textContent = `${items.length.toLocaleString("en")} ${items.length === 1 ? "album" : "albums"}${state.artist ? ` by ${state.artist}` : " in your collection"}`;
  const page = items.slice(state.page * size, (state.page + 1) * size);
  $("#albums").className = state.view === "list" ? "album-list" : "album-grid";
  $("#albums").innerHTML = (page.length ? (state.view === "list" ? listView(page) : gridView(page)) : "") || (state.loading ? '<div class="empty"><span class="spinner"></span>Checking your iBroadcast library… A full download of a large library can take half a minute.</div>' : '<div class="empty">No albums match your filters. Try another artist or search.</div>');
  $("#selection-bar").hidden = !state.selected.size;
  $("#selection-count").textContent = `${state.selected.size} albums selected · ${state.artist || ""}`;
  $("#pagination").innerHTML = maxPage > 0 ? `<button class="button small" data-page="-1" ${state.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${state.page + 1} of ${(maxPage + 1).toLocaleString("en")}</span><button class="button small" data-page="1" ${state.page === maxPage ? "disabled" : ""}>Next →</button>` : "";
}

// On an artist's page the artist image takes the place of the library total.
function renderArtistPanel() {
  const panel = $("#artist-panel"), albums = state.artist ? state.albums.filter(a => a.artist === state.artist) : [];
  $("#library-total").hidden = Boolean(state.artist);
  panel.hidden = !state.artist;
  if (!state.artist) return;
  const image = albums.find(a => a.artist_image)?.artist_image || "";
  const canChange = live() && albums.some(a => a.artist_id) && state.artist !== "Various Artists";
  const tracks = albums.reduce((sum, a) => sum + a.track_count, 0);
  panel.innerHTML = `<div class="artist-photo">${image ? `<img src="${escapeHtml(image.replace(/-150$/, "-300"))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span>${escapeHtml(initials(state.artist))}</span></div><div class="artist-meta"><strong>${tracks.toLocaleString("en")}</strong><span>${tracks === 1 ? "track" : "tracks"} on these albums</span>${canChange ? `<button class="text-action" id="change-artist-page-image">${image ? "Change image" : "Add an image"}</button>` : ""}</div>`;
}

// The album after this one in the current list, for working through a filter.
function nextAlbumId(id) {
  const items = filteredAlbums(), index = items.findIndex(a => String(a.id) === String(id));
  return index >= 0 && index + 1 < items.length ? String(items[index + 1].id) : null;
}

function common(items, key) {
  const values = [...new Set(items.map(i => i[key]))];
  return values.length === 1 ? values[0] : "";
}

function field(name, label, value, options = {}) {
  const {type = "text", wide = false, hint = "", bulk = false, placeholder = ""} = options;
  return `<div class="field ${wide ? "wide" : ""}">${bulk ? `<label class="field-check"><input type="checkbox" aria-label="Change ${label}" data-enable="${name}"> ${label}</label>` : `<span>${label}</span>`}<input aria-label="${label}" name="${name}" type="${type}" value="${escapeHtml(value || "")}" ${type === "number" ? 'min="0" max="9999" step="1"' : 'maxlength="1000"'} placeholder="${escapeHtml(placeholder)}" ${bulk ? "disabled" : ""}>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

async function openEditor(ids) {
  if (opening) return;
  const chosen = ids.map(id => state.albums.find(a => String(a.id) === String(id))).filter(Boolean);
  if (!chosen.length) return;
  if (chosen.length > 1 && (!state.artist || chosen.some(a => a.artist !== state.artist))) {
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
  const album = albums[0], bulk = albums.length > 1;
  editing = {ids: albums.map(a => String(a.id)), originals: structuredClone(albums), trackPatches: {}, bulk, dirty: new Set()};
  const allTracks = albums.flatMap(a => a.tracks);
  $("#editor-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${bulk ? "ONE ARTIST / SELECTED ALBUMS" : "ONE ALBUM / YOUR DETAILS"}</div><h2>${bulk ? "Edit selected albums" : "Edit album"}</h2></div><button class="close" data-close="editor" aria-label="Close album editor">×</button></div><div class="album-header">${bulk || !live() ? cover(album, true) : `<button class="cover-button" id="change-cover" title="Change the cover">${cover(album, true)}<span>Change cover</span></button>`}<div><h3>${escapeHtml(bulk ? `${albums.length} albums by ${album.artist}` : album.name)}</h3><div class="muted">${escapeHtml(album.artist)} <span aria-hidden="true">·</span> ${allTracks.length} tracks${!bulk ? ` <span aria-hidden="true">·</span> ${discLabel(album) || `Disc ${album.disc || "unknown"}`}` : ""}${!bulk && discSet(album) ? ` <button class="text-action" data-edit-set="${escapeHtml(album.id)}">Edit all ${discSet(album).length} discs together →</button>` : ""}</div><div class="header-actions"><span class="pill">${live() ? "Live iBroadcast library" : state.mode === "imported" ? "Imported library · local draft" : "Sample data · local draft"}</span>${live() && !bulk ? `<button class="text-action" data-play-album>▶ Play album</button>${album.artist_id ? `<button class="text-action" id="change-artist-image">${avatar(album.artist, album.artist_image)}Artist image</button>` : ""}` : ""}</div></div></div><div class="edit-layout"><form id="metadata-form"><div class="fields">${bulk ? "" : field("name", "Album title", album.name, {wide: true})}${field("artist", "Album artist", common(albums, "artist"), {wide: true, bulk, hint: "Track artists stay unchanged."})}${field("year", "Release year", common(albums, "year"), {type: "number", bulk, hint: "Use 0 to clear the year."})}${field("disc", "Disc number", common(albums, "disc"), {type: "number", bulk})}${genreField("genres", "Genres · all tracks in this selection", allTracks.every(t => sameValue(t.genres, allTracks[0].genres)) ? allTracks[0].genres : [], {bulk, mixed: !allTracks.every(t => sameValue(t.genres, allTracks[0].genres)), hint: "The first genre is the main one; click another to make it the main genre."})}${allTracks.some(t => hasCombined(t.genres)) ? `<p class="genre-note wide">${allTracks.filter(t => hasCombined(t.genres)).length} ${allTracks.filter(t => hasCombined(t.genres)).length === 1 ? "track has" : "tracks have"} several genres stored as one text, like “${escapeHtml(allTracks.find(t => hasCombined(t.genres)).genres.find(g => g.includes(";")))}”. <button type="button" class="text-action" data-split-album-genres>Split combined genres</button></p>` : ""}${genreField("composers", "Composers · all tracks in this selection", allTracks.every(t => sameValue(t.composers, allTracks[0].composers)) ? allTracks[0].composers : [], {bulk, ordered: false, noun: "composer", mixed: !allTracks.every(t => sameValue(t.composers, allTracks[0].composers)), hint: "Mostly for classical music. A name iBroadcast doesn't know yet is added as an artist when you save."})}</div><label class="checkline"><input type="checkbox" id="track-years"> Also apply the release year to tracks in this selection</label><div class="scope-note">${bulk ? `Only these ${albums.length} selected albums and their tracks are included. Check a field to change it; unchecked fields stay as they are.` : "Only this album is being edited. Suggestions only fill in the form: nothing is saved until you review it."}</div><div id="track-inline"></div></form>${bulk ? '<aside class="sources"><div class="eyebrow">YOUR SELECTION</div><h3>Included albums</h3>' + albums.map(a => `<p class="muted">${escapeHtml(a.name)}</p>`).join("") + '<div class="year-note"><strong>Look up one album at a time</strong>Open an individual album to consult MusicBrainz or Last.fm.</div></aside>' : lookupPanel(album)}</div>${bulk ? "" : `<div class="tracks-heading"><h3>Tracks <span class="muted">(${album.tracks.length})</span></h3><span class="muted">Edit a track individually</span></div><table class="track-table"><thead><tr><th>#</th><th>Title</th><th>Year / Genre</th><th></th></tr></thead><tbody>${album.tracks.map(t => `<tr data-row="${escapeHtml(t.id)}"><td>${live() ? `<button class="play" data-play="${escapeHtml(t.id)}" aria-label="Play ${escapeHtml(t.title)}">▶</button>` : ""}${t.track || "–"}</td><td>${escapeHtml(t.title)}${t.composers?.length ? `<small class="track-composer">${escapeHtml(t.composers.join(", "))}</small>` : ""}</td><td>${t.year || "–"} / <span data-genre-cell="${escapeHtml(t.id)}" class="${hasCombined(t.genres) ? "combined" : ""}">${escapeHtml(genresText(t.genres) || "No genre")}</span></td><td><button class="track-edit" data-track="${escapeHtml(t.id)}">Edit</button></td></tr>`).join("")}</tbody></table>`}<div class="dialog-footer"><span class="muted">${live() ? "You review every change before it is saved to iBroadcast." : "Nothing is sent to iBroadcast."}</span><button class="button" data-close="editor">Cancel</button>${bulk ? "" : `<button class="button" id="next-album" ${nextAlbumId(album.id) ? "" : "disabled"}>Next album →</button>`}<button class="button primary" id="review-button">Review draft →</button></div>`;
  $("#metadata-form").addEventListener("submit", e => e.preventDefault());
  $("#editor").showModal();
  if (!bulk) startLookups(album);
}

function readNumber(value) {
  if (value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw Error("Numbers must be whole values from 0 to 9999.");
  return n;
}

function stashTrack() {
  const pane = $("#track-inline");
  if (!pane?.dataset.track) return;
  const data = {};
  for (const input of pane.querySelectorAll("input[data-key]")) {
    data[input.dataset.key] = input.type === "number" ? readNumber(input.value) : input.value.trim();
  }
  const genres = pane.querySelector('[data-genres="track-genres"]');
  if (genres) { commitTyped(genres); data.genres = getGenres(genres); }
  const composers = pane.querySelector('[data-genres="track-composers"]');
  if (composers) { commitTyped(composers); data.composers = getGenres(composers); }
  if (!data.title) throw Error("A track title cannot be empty.");
  const original = editing.originals[0].tracks.find(t => String(t.id) === pane.dataset.track);
  editing.trackPatches[pane.dataset.track] = Object.fromEntries(Object.entries(data).filter(([key, value]) => !sameValue(original[key], value)));
}

function editTrack(id) {
  try { stashTrack(); } catch (error) { toast(error.message); return; }
  showTrackGenres();
  const original = editing.originals[0].tracks.find(t => String(t.id) === id);
  if (!original) return;
  const track = {...original, ...(editing.trackPatches[id] || {})};
  const pane = $("#track-inline"); pane.dataset.track = id;
  pane.innerHTML = `<div class="track-inline"><h3>Track ${original.track}: ${escapeHtml(original.title)}</h3><div class="fields">${[["title", "Track title", "text"], ["artist", "Track artist", "text"], ["year", "Track year", "number"], ["track", "Track number", "number"]].map(([key, label, type]) => `<label class="field ${key === "title" ? "wide" : ""}"><span>${label}</span><input data-key="${key}" aria-label="${label}" type="${type}" ${type === "number" ? 'min="0" max="9999" step="1"' : 'maxlength="1000"'} value="${escapeHtml(track[key] || "")}"></label>`).join("")}${genreField("track-genres", "Track genres", track.genres || [])}${genreField("track-composers", "Track composers", track.composers || [], {ordered: false, noun: "composer"})}</div><p class="muted">Individual track edits take priority over album-wide track changes.</p></div>`;
  pane.scrollIntoView({block: "nearest", behavior: "smooth"});
}

function buildReview() {
  try {
    stashTrack();
    const form = $("#metadata-form");
    if (!form.reportValidity()) return;
    const albumPatch = {}, trackPatch = {}, allTracks = editing.originals.flatMap(a => a.tracks);
    for (const key of ["name", "artist", "year", "disc"]) {
      const input = form.elements.namedItem(key);
      if (!input || input.disabled || (!editing.bulk && !editing.dirty.has(key))) continue;
      const value = input.type === "number" ? readNumber(input.value) : input.value.trim();
      if (["name", "artist"].includes(key) && !value) throw Error("Album title and artist cannot be empty.");
      if (editing.originals.every(item => item[key] === value)) continue;
      albumPatch[key] = value;
    }
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
      trackPatch.year = readNumber(form.elements.year.value);
    }
    const changes = [];
    function diff(kind, item, patch, albumId) {
      const fields = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !sameValue(item[key], value)).map(([key, value]) => [key, {before: item[key], after: value}]));
      if (Object.keys(fields).length) changes.push({kind, id: item.id, albumId, label: item.name || item.title, fields});
    }
    for (const album of editing.originals) {
      diff("album", album, albumPatch, album.id);
      for (const track of album.tracks) diff("track", track, {...trackPatch, ...(editing.trackPatches[String(track.id)] || {})}, album.id);
    }
    if (!changes.length) { toast("There are no changes to review."); return; }
    pending = {scope: editing.bulk ? "artist" : "album", selection: editing.originals.map(a => ({id: a.id, name: a.name, artist: a.artist})), changes};
    showReview(changes);
  } catch (error) { toast(error.message); }
}

const shown = value => (Array.isArray(value) ? genresText(value) : value) || "Empty";
const fieldLabel = key => key === "name" ? "Title" : key === "track" ? "Track number" : key[0].toUpperCase() + key.slice(1);

// Albums one by one; track changes grouped by field and value, so twelve tracks that get
// the same genre read as one line instead of twelve.
function reviewList(changes) {
  const row = (key, v) => `<div class="diff-row"><span>${escapeHtml(fieldLabel(key))}</span><del>${escapeHtml(shown(v.before))}</del><span>→</span><ins>${escapeHtml(shown(v.after))}</ins></div>`;
  const albums = changes.filter(c => c.kind === "album");
  const tracks = changes.filter(c => c.kind === "track");
  const severalAlbums = new Set(tracks.map(c => String(c.albumId))).size > 1;
  const albumName = id => state.details.get(String(id))?.name || editing?.originals.find(a => String(a.id) === String(id))?.name || "";
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
    for (const [key, value] of Object.entries(change.fields)) if (target[key] !== value.before) { toast("A value changed since this draft. Review it again."); return; }
  }
  const next = thenNext();
  applyLocally(pending.changes);
  state.history.unshift({...structuredClone(pending), created: new Date().toISOString(), status: "preview_only", source: state.mode});
  pending = null; editing = null; state.selected.clear();
  if (next) setTimeout(() => openEditor([next]), 0);
  if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
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
    }
  }
  const touched = new Set(changes.map(c => String(c.albumId)));
  state.albums = state.albums.map(a => touched.has(String(a.id)) && state.details.has(String(a.id)) ? {...summarize(state.details.get(String(a.id))), color: a.color} : a);
}

function showHistory() {
  $("#history-content").innerHTML = state.history.length ? state.history.map((entry, index) => `<section class="history-item">${statusPill(entry.status)}${entry.artwork && !entry.undone && ["saved", "sent", "unverified"].includes(entry.status) ? `<button class="button small history-undo" data-undo="${index}">Undo</button>` : ""}${entry.artwork ? `<div class="history-art">${entry.artwork.before ? `<img src="${escapeHtml(entry.artwork.before)}" alt="Before" referrerpolicy="no-referrer">` : ""}<span>→</span><img src="${escapeHtml(entry.artwork.after)}" alt="After" referrerpolicy="no-referrer"></div>` : ""}<h3>${escapeHtml(entry.selection.map(a => a.name).join(", "))}</h3><p class="muted">${new Date(entry.created).toLocaleString("en-GB")} · ${entry.changes.length} records</p>${entry.error ? `<div class="error-box">${escapeHtml(entry.error)}</div>` : ""}${!entry.artwork && entry.source === "ibroadcast" && entry.changes.some(c => ["failed", "not_sent", "blocked"].includes(c.status)) ? `<p><button class="button small" data-review-rest="${index}">Review the rest again →</button></p>` : ""}${entry.changes.map(c => `<p class="muted">${c.status ? statusPill(c.status) + " " : ""}${escapeHtml(c.label)}: ${Object.entries(c.fields).map(([key, v]) => `${escapeHtml(key)}: ${escapeHtml(shown(v.before))} → ${escapeHtml(shown(v.after))}`).join(" · ")}</p>`).join("")}</section>`).join("") : '<p class="empty">No drafts yet. Open an album to start editing.</p>';
  $("#history").showModal();
}

document.addEventListener("click", event => {
  const close = event.target.closest("[data-close]");
  if (close) { $(`#${close.dataset.close}`).close(); return; }
  const artist = event.target.closest("[data-artist]");
  if (artist) { setArtist(artist.dataset.artist); return; }
  const album = event.target.closest("[data-album]");
  if (album) { openEditor([album.dataset.album]); return; }
  const track = event.target.closest("[data-track]");
  if (track) { editTrack(track.dataset.track); return; }
  const page = event.target.closest("[data-page]");
  if (page) { state.page += Number(page.dataset.page); render(); return; }
  if (event.target.closest("#review-button")) buildReview();
});
document.addEventListener("change", event => {
  if (event.target.matches("[data-select]")) {
    if (event.target.checked) state.selected.add(event.target.dataset.select);
    else state.selected.delete(event.target.dataset.select);
    render();
  }
  if (event.target.matches("[data-enable]")) {
    const name = event.target.dataset.enable, labels = document.querySelector(`#metadata-form [data-genres="${name}"]`);
    if (labels) { labels.classList.toggle("disabled", !event.target.checked); labels.querySelector("input").disabled = !event.target.checked; }
    else $("#metadata-form").elements.namedItem(name).disabled = !event.target.checked;
  }
});
document.addEventListener("input", event => {
  if (editing && event.target.closest("#metadata-form") && event.target.name) editing.dirty.add(event.target.name);
});
$("#home").addEventListener("click", event => { event.preventDefault(); setArtist(null); });
$("#all-albums").addEventListener("click", () => setArtist(null));
$("#artist-search").addEventListener("input", renderArtists);
for (const id of ["#filter", "#sort"]) $(id).addEventListener("change", () => { state.page = 0; render(); });
$("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 0; render(); }, 150); });
$("#clear-selection").addEventListener("click", () => { state.selected.clear(); render(); });
$("#edit-selection").addEventListener("click", () => openEditor([...state.selected]));
$("#apply-draft").addEventListener("click", applyDraft);
$("#show-history").addEventListener("click", showHistory);
$("#import-button").addEventListener("click", () => { $("#import-file").value = ""; $("#import-file").click(); });
$("#import-file").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (state.history.some(h => h.status === "preview_only")) throw Error("Export your drafts and reload this tab before importing another library.");
    if (file.size > 100 * 1024 * 1024) throw Error("This preview accepts library files up to 100 MB.");
    const albums = importLibrary(JSON.parse(await file.text()));
    if (!albums.length) throw Error("No active albums were found in this library export.");
    useLocal(albums, "imported");
    updateChrome();
    setArtist(null); toast(`Imported ${albums.length} albums. Imported snapshots are never saved to iBroadcast.`);
  } catch (error) { toast(error.message || "This library file could not be read."); }
});
$("#export-button").addEventListener("click", () => {
  if (!state.history.length) { toast("Make and review an edit before exporting the history."); return; }
  const blob = new Blob([JSON.stringify({format: "tagcast-history", version: 2, exported: new Date().toISOString(), entries: state.history}, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `tagcast-history-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const c = state.connection;
  $("#status-dot").className = `status-dot ${live() && !state.loading ? "live" : state.loading ? "busy" : ""}`;
  $("#connection-title").textContent = live() ? "Connected to iBroadcast" : c.connected ? "Connected · viewing snapshot" : "Preview workspace";
  $("#connection-text").innerHTML = live() ? `${escapeHtml(c.account || "Your library")}<br>Reviewed edits are saved online.` : c.connected ? "Reload your library to edit it live." : "No account connected.<br>Edits stay in this browser tab.";
  $("#connect-button").hidden = c.connected;
  $("#reload-button").hidden = !c.connected;
  $("#logout-button").hidden = !c.connected;
  const badge = $("#mode-badge");
  badge.classList.toggle("live", live());
  badge.textContent = state.loading ? "LOADING LIBRARY…" : checking ? "CHECKING SAVES…" : live() ? `LIVE · ${(c.account || "iBroadcast").toUpperCase()}` : state.mode === "imported" ? "IMPORTED SNAPSHOT" : "DEMO · CONNECT ACCOUNT";
  $("#data-notice").textContent = live() ? "Live iBroadcast library. Every save is checked against iBroadcast first and read back afterwards. Your music files are never touched."
    : state.mode === "imported" ? "Imported library snapshot. Drafts stay in this tab; nothing is saved to iBroadcast or to the source file."
    : "Demo library with sample records. Connect your iBroadcast account to edit your own collection.";
  $("#history-note").textContent = live() ? "Saved changes are listed with their read-back status. Export the history if you want a record of this session." : "Export the history before closing this tab. Preview drafts are not saved to iBroadcast.";
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has("auth_error")) toast(`Sign-in failed: ${params.get("auth_error")}`);
  if (params.has("connected")) toast("Connected to iBroadcast.");
  if (params.size) history.replaceState(null, "", location.pathname);
  try {
    state.connection = await api("/api/status");
  } catch {
    return; // opened without the Python server: demo and import still work
  }
  updateChrome();
  if (state.connection.connected) loadLive();
}

async function loadLive(refresh = false) {
  state.loading = true; state.mode = "live"; state.albums = []; state.details = new Map(); state.selected.clear();
  updateChrome(); render();
  try {
    const data = await api(`/api/library${refresh ? "?refresh=1" : ""}`);
    state.albums = colorize(data.albums); state.artistNames = data.artists || [];
    state.connection.combine_sets = Boolean(data.combine_sets);
    const count = `${state.albums.length.toLocaleString("en")} albums`;
    toast(data.source === "download" ? `Downloaded ${count} from iBroadcast.` : `Loaded ${count}. Nothing changed in iBroadcast since the last download.`);
  } catch (error) {
    if (error.status === 401) state.connection.connected = false;
    useLocal(demoLibrary(), "demo");
    toast(`Could not load your library: ${error.message}`);
  } finally {
    state.loading = false;
    if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
    state.page = 0; updateChrome(); render();
  }
}

function connectView(view, extra = {}) {
  const c = state.connection, box = $("#connect-content");
  const error = extra.error ? `<div class="error-box">${escapeHtml(extra.error)}</div>` : "";
  if (view === "connected") {
    box.innerHTML = `<div class="connect-step"><p class="muted">Connected${c.account ? ` as <strong>${escapeHtml(c.account)}</strong>` : ""}. Tagcast can read your library and save metadata you review.</p>${error}</div><div class="dialog-footer"><button class="button" id="connect-logout">Disconnect</button><button class="button" id="connect-redownload" title="Normally the library is only downloaded when iBroadcast reports a change">Download everything again</button><button class="button primary" id="connect-reload">Reload library</button></div>`;
  } else if (view === "client") {
    box.innerHTML = `<div class="connect-step"><p class="muted">Tagcast signs in with your own iBroadcast app, so it only gets the access you approve.</p><ol class="muted"><li>Open <a href="https://media.ibroadcast.com/" target="_blank" rel="noopener noreferrer"><u>media.ibroadcast.com</u></a>, click <strong>your name at the top right</strong> and choose <strong>Apps</strong>.</li><li>Scroll to the bottom and click the <strong>developer</strong> link under Developers.</li><li>Next to <strong>Your Apps</strong>, click <strong>+</strong>, give it a name (for example Tagcast) and save it.</li><li>Open the app and paste its <strong>client ID</strong> below. The client secret is not needed.</li></ol><div class="connect-row"><input id="client-id" placeholder="Client ID" aria-label="Client ID" autocomplete="off" spellcheck="false"><button class="button primary" id="client-save">Save</button></div><p class="muted">Stored on this computer only, in the Tagcast settings folder.</p>${error}</div>`;
    setTimeout(() => $("#client-id")?.focus(), 50);
  } else if (view === "ready") {
    box.innerHTML = `<div class="connect-step"><p class="muted">Sign in with a short code on the iBroadcast website. Tagcast asks for permission to <strong>read and edit your music library</strong> and to show your account name.</p>${error}</div><div class="dialog-footer">${c.client_id_from_env ? "" : '<button class="text-button" id="client-change" style="color:var(--green);margin-right:auto">Change client ID</button>'}<button class="button" id="browser-start">Use browser redirect</button><button class="button primary" id="device-start">Sign in with a code →</button></div><p class="muted">Browser redirect needs <code>http://127.0.0.1:${location.port || 80}/callback</code> as the redirect URI in your app settings.</p>`;
  } else if (view === "device") {
    const d = extra.device, link = d.verification_uri_complete || d.verification_uri;
    box.innerHTML = `<div class="connect-step"><p class="muted">Open the iBroadcast sign-in page and enter this code:</p><div class="device-code">${escapeHtml(d.user_code)}</div><p class="muted"><span class="spinner"></span>Waiting for you to approve Tagcast…</p>${error}</div><div class="dialog-footer"><button class="button" id="device-cancel">Cancel</button><a class="button primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open iBroadcast sign-in ↗</a></div>`;
  }
}

function openConnect() {
  const c = state.connection;
  connectView(c.connected ? "connected" : c.device?.state === "pending" ? "device" : c.configured ? "ready" : "client", {device: c.device});
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
      if (status.connected) {
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
    if (target.id === "client-save") {
      state.connection = await api("/api/config", {client_id: $("#client-id").value});
      updateChrome(); connectView("ready");
    } else if (target.id === "client-change") {
      connectView("client");
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
    const view = target.id === "client-save" ? "client" : state.connection.connected ? "connected" : "ready";
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
    if (result.albums) { state.albums = colorize(result.albums); state.details = new Map(); }
    else applyLocally(pending.changes.filter(c => byId.get(`${c.kind}:${c.id}`) === "sent"));
    pending = null; editing = null; state.selected.clear();
    if (newArtist) state.artist = newArtist;
    if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
    $("#review").close(); $("#editor").close(); render();
    if (overall === "failed" || !statuses.length || result.error) showResults(result, overall, entry);
    else toast(`${statuses.length} ${statuses.length === 1 ? "record" : "records"} saved. Checking the result with iBroadcast in the background…`);
    if (result.job) followJob(result.job, entry);
    if (next && overall !== "failed") openEditor([next]);
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
async function followJob(jobId, entry, onDone) {
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
  if (job.state === "error") {
    entry.status = "unverified"; entry.error = [entry.error, job.error].filter(Boolean).join(" ");
    for (const c of entry.changes) if (c.status === "sent") c.status = "unverified";
    rememberHistory(); toast(job.error); return;
  }
  const byId = new Map(job.results.map(r => [`${r.kind}:${r.id}`, r.status]));
  for (const c of entry.changes) c.status = byId.get(`${c.kind}:${c.id}`) || c.status;
  entry.status = overallStatus(entry.changes.map(c => c.status));
  rememberHistory();
  if (order !== saveOrder) { /* a later save's read-back brings newer albums */ }
  else if (!$("#editor").open && !$("#review").open) {
    state.albums = colorize(job.albums); state.details = new Map();
    if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
    render();
  } else pendingAlbums = job.albums;
  onDone?.(job);
  const done = job.results.filter(r => r.status === "saved").length;
  if (entry.status === "saved") toast(`Confirmed by iBroadcast: ${done} ${done === 1 ? "record" : "records"} saved.`);
  else showResults({results: job.results, error: entry.error}, entry.status, entry);
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
  if (index >= 0 && !entry.artwork && entry.changes.some(c => ["failed", "not_sent", "blocked"].includes(c.status))) {
    notes.push(`<p><button class="button small" data-review-rest="${index}">Review the rest again →</button> <span class="muted">Sends only what wasn't saved.</span></p>`);
  }
  $("#results-content").innerHTML = notes.join("") + rows.map(r => `<div class="result-row"><div>${escapeHtml(r.kind === "album" ? "Album" : "Track")} · ${escapeHtml(r.label)}<small>${escapeHtml(r.fields.map(f => f === "name" ? "title" : f === "track" ? "track number" : f).join(", "))}</small></div>${statusPill(r.status)}</div>`).join("");
  if (!$("#results").open) $("#results").showModal();
}

document.addEventListener("click", event => {
  const target = event.target.closest("#client-save, #client-change, #device-start, #device-cancel, #browser-start, #connect-reload, #connect-redownload, #connect-logout, #reload-button, #logout-button");
  if (target) connectAction(target);
});
document.addEventListener("keydown", event => { if (event.key === "Enter" && event.target.id === "client-id") connectAction($("#client-save")); });
$("#connect-button").addEventListener("click", openConnect);
$("#mode-badge").addEventListener("click", openConnect);

function flushPendingAlbums() {
  if (!pendingAlbums || $("#editor").open || $("#review").open) return;
  state.albums = colorize(pendingAlbums); state.details = new Map(); pendingAlbums = null;
  if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
  render();
}
$("#editor").addEventListener("close", flushPendingAlbums);
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
    $("#editor").close(); openEditor([next]);
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
  if (state.artist !== album.artist) setArtist(album.artist); // a selection stays within one album artist
  openEditor(set.map(a => String(a.id)));
});

// Theme: Auto (follows the system), Light or Dark; dark.css does the rest.
function showTheme() {
  const theme = document.documentElement.dataset.theme || "auto";
  const label = {auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark"}[theme];
  $("#theme-button").textContent = label;
  $("#theme-button").title = theme === "auto" ? "Light or dark: follows your system. Click to change." : `${label.slice(2)} theme. Click to change.`;
}
$("#theme-button").addEventListener("click", () => {
  const next = {auto: "light", light: "dark", dark: "auto"}[document.documentElement.dataset.theme || "auto"];
  if (next === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
  try { localStorage.setItem("tagcast-theme", next); } catch { /* private window */ }
  showTheme();
});
showTheme();
