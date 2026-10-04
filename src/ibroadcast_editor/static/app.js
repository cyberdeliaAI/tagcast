"use strict";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const colors = ["#627b70", "#ab7555", "#6c7b89", "#a98a56", "#836d7b", "#71856b"];
// state.albums holds small album summaries (no tracks); full albums live in state.details.
const state = {albums: [], details: new Map(), artistNames: [], artist: null, selected: new Set(), page: 0, history: [], mode: "demo", loading: false, connection: {connected: false, configured: false, account: ""}};
const live = () => state.mode === "live";
let devicePoll = null;
let saving = false;
let reloadOnApply = false;
let editing = null;
let pending = null;
let toastTimer;
let searchTimer;
let opening = false;

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
        artist: artistName(t.artist_id), year: Number(t.year) || 0, genre: String(t.genre || ""), track: Number(t.track) || 0})),
    };
  }).filter(a => a.tracks.length);
}

function summarize(album) {
  const genres = [...new Set(album.tracks.map(t => t.genre.trim()).filter(Boolean))].sort();
  return {id: String(album.id), name: album.name, artist: album.artist, year: album.year, disc: album.disc,
    artwork: album.artwork || "", color: album.color, track_count: album.tracks.length, genres,
    no_genre: album.tracks.filter(t => !t.genre.trim()).length};
}

function useLocal(albums, mode) {
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
  return `<div class="cover ${art ? "has-art" : ""}" style="--cover-color:${album.color}">${art}<span class="cover-letter">${escapeHtml(initials)}</span>${small || art ? "" : '<span class="cover-caption">LIBRARY STUDIO / PLACEHOLDER</span>'}</div>`;
}

function artistGroups() {
  const counts = new Map();
  state.albums.forEach(a => counts.set(a.artist, (counts.get(a.artist) || 0) + 1));
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderArtists() {
  const query = $("#artist-search").value.toLocaleLowerCase();
  const groups = artistGroups();
  $("#artist-count").textContent = groups.length;
  $("#artists").innerHTML = groups.filter(([name]) => name.toLocaleLowerCase().includes(query)).slice(0, 200).map(([name, count]) => `<button class="artist-button ${state.artist === name ? "active" : ""}" data-artist="${escapeHtml(name)}"><span class="artist-avatar">${escapeHtml(name.split(/\s+/).map(s => s[0]).slice(0, 2).join(""))}</span><span>${escapeHtml(name)}</span><b>${count}</b></button>`).join("");
}

function setArtist(artist) {
  state.artist = artist; state.selected.clear(); state.page = 0;
  $("#search").value = "";
  render();
}

function filteredAlbums() {
  const query = $("#search").value.toLocaleLowerCase().trim(), filter = $("#filter").value;
  const items = state.albums.filter(a => (!state.artist || a.artist === state.artist)
    && (!query || [a.name, a.artist, ...a.genres].join(" ").toLocaleLowerCase().includes(query))
    && (filter !== "year" || !a.year)
    && (filter !== "genre" || a.no_genre > 0)
    && (filter !== "edition" || /remaster|deluxe|anniversary|re-record|live/i.test(a.name)));
  const sort = $("#sort").value;
  items.sort((a, b) => sort === "year" ? (a.year || 9999) - (b.year || 9999) || a.name.localeCompare(b.name)
    : sort === "title" ? a.name.localeCompare(b.name) : a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
  return items;
}

function render() {
  renderArtists();
  $("#album-count").textContent = state.albums.length;
  $("#total-tracks").textContent = state.albums.reduce((sum, a) => sum + a.track_count, 0).toLocaleString("en");
  $("#history-count").textContent = state.history.length;
  $("#breadcrumb").textContent = state.artist || "Albums";
  $("#page-title").textContent = state.artist || "Your albums.";
  $("#page-subtitle").textContent = state.artist ? "Open an album, or select albums by this artist to edit together." : "Browse your collection, check the details, and make it yours.";
  $("#selection-help").textContent = state.artist ? "Selection is limited to this artist" : "Open an album to edit its metadata";
  $("#all-albums").classList.toggle("active", !state.artist);
  const items = filteredAlbums(), size = 20, maxPage = Math.max(0, Math.ceil(items.length / size) - 1);
  state.page = Math.min(state.page, maxPage);
  $("#results-count").textContent = `${items.length} ${items.length === 1 ? "album" : "albums"}${state.artist ? ` by ${state.artist}` : " in your collection"}`;
  $("#albums").innerHTML = items.slice(state.page * size, (state.page + 1) * size).map(a => `<article class="album-card ${state.selected.has(String(a.id)) ? "selected" : ""}">${state.artist ? `<label class="album-select"><input type="checkbox" data-select="${escapeHtml(a.id)}" aria-label="Select ${escapeHtml(a.name)}" ${state.selected.has(String(a.id)) ? "checked" : ""}></label>` : ""}<button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="Edit ${escapeHtml(a.name)}">${cover(a)}<span class="album-name">${escapeHtml(a.name)}</span><span class="album-artist">${escapeHtml(a.artist)}</span></button><div class="card-meta"><span>${a.year || "Year unknown"} <span aria-hidden="true">·</span> ${a.track_count} tracks</span>${!a.year ? '<span class="pill missing">Missing year</span>' : a.no_genre ? '<span class="pill missing">Missing genre</span>' : /remaster|deluxe|anniversary|re-record|live/i.test(a.name) ? '<span class="pill">Edition</span>' : '<span class="pill">Album</span>'}</div></article>`).join("") || (state.loading ? '<div class="empty"><span class="spinner"></span>Checking your iBroadcast library… A full download of a large library can take half a minute.</div>' : '<div class="empty">No albums match your filters. Try another artist or search.</div>');
  $("#selection-bar").hidden = !state.selected.size;
  $("#selection-count").textContent = `${state.selected.size} albums selected · ${state.artist || ""}`;
  $("#pagination").innerHTML = maxPage > 0 ? `<button class="button small" data-page="-1" ${state.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${state.page + 1} of ${maxPage + 1}</span><button class="button small" data-page="1" ${state.page === maxPage ? "disabled" : ""}>Next →</button>` : "";
}

function common(items, key) {
  const values = [...new Set(items.map(i => i[key]))];
  return values.length === 1 ? values[0] : "";
}

function field(name, label, value, options = {}) {
  const {type = "text", wide = false, hint = "", bulk = false, placeholder = ""} = options;
  return `<div class="field ${wide ? "wide" : ""}">${bulk ? `<label class="field-check"><input type="checkbox" aria-label="Change ${label}" data-enable="${name}"> ${label}</label>` : `<span>${label}</span>`}<input aria-label="${label}" name="${name}" type="${type}" value="${escapeHtml(value || "")}" ${type === "number" ? 'min="0" max="9999" step="1"' : 'maxlength="1000"'} placeholder="${escapeHtml(placeholder)}" ${bulk ? "disabled" : ""}>${hint ? `<small>${hint}</small>` : ""}</div>`;
}

function sourceLinks(album) {
  const mb = `https://musicbrainz.org/search?query=${encodeURIComponent(`${album.artist} ${album.name}`)}&type=release_group&method=indexed`;
  const last = `https://www.last.fm/music/${encodeURIComponent(album.artist)}/${encodeURIComponent(album.name)}`;
  return `<aside class="sources"><div class="eyebrow">CHECK THE DETAILS</div><h3>Metadata sources</h3><p class="muted">Consult a source for this album, then enter the details you want to use.</p><a class="source-link" href="${escapeHtml(mb)}" target="_blank" rel="noopener noreferrer"><span class="source-icon">M</span><span><strong>MusicBrainz</strong><small>Release dates & editions</small></span><span class="arrow">↗</span></a><a class="source-link" href="${escapeHtml(last)}" target="_blank" rel="noopener noreferrer"><span class="source-icon last">lfm</span><span><strong>Last.fm</strong><small>Album information & tags</small></span><span class="arrow">↗</span></a><div class="year-note"><strong>Which year belongs here?</strong>An original release and a later remaster can have different years. Check the edition before changing this field.</div><p class="muted">These are website links. Nothing is looked up automatically.</p></aside>`;
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
  $("#editor-content").innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${bulk ? "ONE ARTIST / SELECTED ALBUMS" : "ONE ALBUM / YOUR DETAILS"}</div><h2>${bulk ? "Edit selected albums" : "Edit album"}</h2></div><button class="close" data-close="editor" aria-label="Close album editor">×</button></div><div class="album-header">${cover(album, true)}<div><h3>${escapeHtml(bulk ? `${albums.length} albums by ${album.artist}` : album.name)}</h3><div class="muted">${escapeHtml(album.artist)} <span aria-hidden="true">·</span> ${allTracks.length} tracks${!bulk ? ` <span aria-hidden="true">·</span> Disc ${album.disc || "unknown"}` : ""}</div><div class="pill">${live() ? "Live iBroadcast library" : state.mode === "imported" ? "Imported library · local draft" : "Sample data · local draft"}</div></div></div><div class="edit-layout"><form id="metadata-form"><div class="fields">${bulk ? "" : field("name", "Album title", album.name, {wide: true})}${field("artist", "Album artist", common(albums, "artist"), {wide: true, bulk, hint: "Track artists stay unchanged."})}${field("year", "Release year", common(albums, "year"), {type: "number", bulk, hint: "Use 0 to clear the year."})}${field("disc", "Disc number", common(albums, "disc"), {type: "number", bulk})}${field("genre", "Genre · all tracks in this selection", common(allTracks, "genre"), {wide: true, bulk, placeholder: common(allTracks, "genre") ? "" : "Mixed or missing genres"})}</div><label class="checkline"><input type="checkbox" id="track-years"> Also apply the release year to tracks in this selection</label><div class="scope-note">${bulk ? `Only these ${albums.length} selected albums and their tracks are included. Check a field to change it; unchecked fields stay as they are.` : "Only this album is being edited. Source lookups and edits are always started by you."}</div><div id="track-inline"></div></form>${bulk ? '<aside class="sources"><div class="eyebrow">YOUR SELECTION</div><h3>Included albums</h3>' + albums.map(a => `<p class="muted">${escapeHtml(a.name)}</p>`).join("") + '<div class="year-note"><strong>Look up one album at a time</strong>Open an individual album to consult MusicBrainz or Last.fm.</div></aside>' : sourceLinks(album)}</div>${bulk ? "" : `<div class="tracks-heading"><h3>Tracks <span class="muted">(${album.tracks.length})</span></h3><span class="muted">Edit a track individually</span></div><table class="track-table"><thead><tr><th>#</th><th>Title</th><th>Year / Genre</th><th></th></tr></thead><tbody>${album.tracks.map(t => `<tr><td>${t.track || "–"}</td><td>${escapeHtml(t.title)}</td><td>${t.year || "–"} / ${escapeHtml(t.genre || "No genre")}</td><td><button class="track-edit" data-track="${escapeHtml(t.id)}">Edit</button></td></tr>`).join("")}</tbody></table>`}<div class="dialog-footer"><span class="muted">${live() ? "You review every change before it is saved to iBroadcast." : "Nothing is sent to iBroadcast."}</span><button class="button" data-close="editor">Cancel</button><button class="button primary" id="review-button">Review draft →</button></div>`;
  $("#metadata-form").addEventListener("submit", e => e.preventDefault());
  $("#editor").showModal();
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
  for (const input of pane.querySelectorAll("input")) {
    data[input.dataset.key] = input.type === "number" ? readNumber(input.value) : input.value.trim();
  }
  if (!data.title) throw Error("A track title cannot be empty.");
  const original = editing.originals[0].tracks.find(t => String(t.id) === pane.dataset.track);
  editing.trackPatches[pane.dataset.track] = Object.fromEntries(Object.entries(data).filter(([key, value]) => original[key] !== value));
}

function editTrack(id) {
  try { stashTrack(); } catch (error) { toast(error.message); return; }
  const original = editing.originals[0].tracks.find(t => String(t.id) === id);
  if (!original) return;
  const track = {...original, ...(editing.trackPatches[id] || {})};
  const pane = $("#track-inline"); pane.dataset.track = id;
  pane.innerHTML = `<div class="track-inline"><h3>Track ${original.track}: ${escapeHtml(original.title)}</h3><div class="fields">${[["title", "Track title", "text"], ["artist", "Track artist", "text"], ["year", "Track year", "number"], ["track", "Track number", "number"], ["genre", "Track genre", "text"]].map(([key, label, type]) => `<label class="field ${key === "title" || key === "genre" ? "wide" : ""}"><span>${label}</span><input data-key="${key}" aria-label="${label}" type="${type}" ${type === "number" ? 'min="0" max="9999" step="1"' : 'maxlength="1000"'} value="${escapeHtml(track[key] || "")}"></label>`).join("")}</div><p class="muted">Individual track edits take priority over album-wide track changes.</p></div>`;
  pane.scrollIntoView({block: "nearest", behavior: "smooth"});
}

function buildReview() {
  try {
    stashTrack();
    const form = $("#metadata-form");
    if (!form.reportValidity()) return;
    const albumPatch = {}, trackPatch = {}, allTracks = editing.originals.flatMap(a => a.tracks);
    for (const key of ["name", "artist", "year", "disc", "genre"]) {
      const input = form.elements.namedItem(key);
      if (!input || input.disabled || (!editing.bulk && !editing.dirty.has(key))) continue;
      const value = input.type === "number" ? readNumber(input.value) : input.value.trim();
      if (["name", "artist"].includes(key) && !value) throw Error("Album title and artist cannot be empty.");
      const originals = key === "genre" ? allTracks : editing.originals;
      if (originals.every(item => item[key] === value)) continue;
      if (key === "genre") trackPatch.genre = value;
      else albumPatch[key] = value;
    }
    if ($("#track-years").checked) {
      if (form.elements.year.disabled) throw Error("Enable Release year before applying it to tracks.");
      trackPatch.year = readNumber(form.elements.year.value);
    }
    const changes = [];
    function diff(kind, item, patch, albumId) {
      const fields = Object.fromEntries(Object.entries(patch).filter(([key, value]) => item[key] !== value).map(([key, value]) => [key, {before: item[key], after: value}]));
      if (Object.keys(fields).length) changes.push({kind, id: item.id, albumId, label: item.name || item.title, fields});
    }
    for (const album of editing.originals) {
      diff("album", album, albumPatch, album.id);
      for (const track of album.tracks) diff("track", track, {...trackPatch, ...(editing.trackPatches[String(track.id)] || {})}, album.id);
    }
    if (!changes.length) { toast("There are no changes to review."); return; }
    pending = {scope: editing.bulk ? "artist" : "album", selection: editing.originals.map(a => ({id: a.id, name: a.name, artist: a.artist})), changes};
    renderReviewChrome(changes);
    $("#review-changes").innerHTML = changes.map(change => `<section class="diff-group"><h3>${escapeHtml(change.kind === "album" ? "Album" : "Track")} · ${escapeHtml(change.label)}</h3>${Object.entries(change.fields).map(([key, values]) => `<div class="diff-row"><span>${escapeHtml(key === "name" ? "Title" : key === "track" ? "Track number" : key[0].toUpperCase() + key.slice(1))}</span><del>${escapeHtml(values.before || "Empty")}</del><span>→</span><ins>${escapeHtml(values.after || "Empty")}</ins></div>`).join("")}</section>`).join("");
    $("#review").showModal();
  } catch (error) { toast(error.message); }
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
  for (const change of pending.changes) {
    const album = state.details.get(String(change.albumId));
    const target = change.kind === "album" ? album : album.tracks.find(t => String(t.id) === String(change.id));
    for (const [key, value] of Object.entries(change.fields)) target[key] = value.after;
  }
  const touched = new Set(pending.changes.map(c => String(c.albumId)));
  state.albums = state.albums.map(a => touched.has(String(a.id)) ? summarize(state.details.get(String(a.id))) : a);
  state.history.unshift({...structuredClone(pending), created: new Date().toISOString(), status: "preview_only", source: state.mode});
  pending = null; editing = null; state.selected.clear();
  if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
  $("#review").close(); $("#editor").close(); render();
  toast("Draft applied to this preview. Your iBroadcast library was not changed.");
}

function showHistory() {
  $("#history-content").innerHTML = state.history.length ? state.history.map(entry => `<section class="history-item">${statusPill(entry.status)}<h3>${escapeHtml(entry.selection.map(a => a.name).join(", "))}</h3><p class="muted">${new Date(entry.created).toLocaleString("en-GB")} · ${entry.changes.length} records${entry.error ? ` · ${escapeHtml(entry.error)}` : ""}</p>${entry.changes.map(c => `<p class="muted">${c.status ? statusPill(c.status) + " " : ""}${escapeHtml(c.label)}: ${Object.entries(c.fields).map(([key, v]) => `${escapeHtml(key)}: ${escapeHtml(v.before || "Empty")} → ${escapeHtml(v.after || "Empty")}`).join(" · ")}</p>`).join("")}</section>`).join("") : '<p class="empty">No drafts yet. Open an album to start editing.</p>';
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
    $("#metadata-form").elements.namedItem(event.target.dataset.enable).disabled = !event.target.checked;
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
  const blob = new Blob([JSON.stringify({format: "library-studio-history", version: 2, exported: new Date().toISOString(), entries: state.history}, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `library-studio-history-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("beforeunload", event => { if (saving || state.history.some(h => h.status === "preview_only")) { event.preventDefault(); event.returnValue = ""; } });
useLocal(demoLibrary(), "demo");
updateChrome();
render();
boot();

// ---- iBroadcast connection --------------------------------------------------

async function api(path, body) {
  const options = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-Library-Studio": "1"}, body: JSON.stringify(body)};
  const response = await fetch(path, options);
  let data = {};
  try { data = await response.json(); } catch { /* empty or non-JSON body */ }
  if (!response.ok) {
    const error = Error(data.error || `Library Studio returned HTTP ${response.status}.`);
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
  const labels = {saved: "Saved", unverified: "Not confirmed", failed: "Failed", not_sent: "Not sent", preview_only: "Preview only"};
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
  badge.textContent = state.loading ? "LOADING LIBRARY…" : live() ? `LIVE · ${(c.account || "iBroadcast").toUpperCase()}` : state.mode === "imported" ? "IMPORTED SNAPSHOT" : "DEMO · CONNECT ACCOUNT";
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
    box.innerHTML = `<div class="connect-step"><p class="muted">Connected${c.account ? ` as <strong>${escapeHtml(c.account)}</strong>` : ""}. Library Studio can read your library and save metadata you review.</p>${error}</div><div class="dialog-footer"><button class="button" id="connect-logout">Disconnect</button><button class="button" id="connect-redownload" title="Normally the library is only downloaded when iBroadcast reports a change">Download everything again</button><button class="button primary" id="connect-reload">Reload library</button></div>`;
  } else if (view === "client") {
    box.innerHTML = `<div class="connect-step"><p class="muted">Library Studio signs in with your own iBroadcast app, so it only gets the access you approve.</p><ol class="muted"><li>Open <a href="https://media.ibroadcast.com/" target="_blank" rel="noopener noreferrer"><u>media.ibroadcast.com</u></a>, open the side menu and choose <strong>Apps</strong>.</li><li>Click <strong>Developer</strong> at the bottom and create an app.</li><li>Paste its <strong>client ID</strong> below. The client secret is not needed.</li></ol><div class="connect-row"><input id="client-id" placeholder="Client ID" aria-label="Client ID" autocomplete="off" spellcheck="false"><button class="button primary" id="client-save">Save</button></div><p class="muted">Stored on this computer only, in the Library Studio settings folder.</p>${error}</div>`;
    setTimeout(() => $("#client-id")?.focus(), 50);
  } else if (view === "ready") {
    box.innerHTML = `<div class="connect-step"><p class="muted">Sign in with a short code on the iBroadcast website. Library Studio asks for permission to <strong>read and edit your music library</strong> and to show your account name.</p>${error}</div><div class="dialog-footer">${c.client_id_from_env ? "" : '<button class="text-button" id="client-change" style="color:var(--green);margin-right:auto">Change client ID</button>'}<button class="button" id="browser-start">Use browser redirect</button><button class="button primary" id="device-start">Sign in with a code →</button></div><p class="muted">Browser redirect needs <code>http://127.0.0.1:${location.port || 80}/callback</code> as the redirect URI in your app settings.</p>`;
  } else if (view === "device") {
    const d = extra.device, link = d.verification_uri_complete || d.verification_uri;
    box.innerHTML = `<div class="connect-step"><p class="muted">Open the iBroadcast sign-in page and enter this code:</p><div class="device-code">${escapeHtml(d.user_code)}</div><p class="muted"><span class="spinner"></span>Waiting for you to approve Library Studio…</p>${error}</div><div class="dialog-footer"><button class="button" id="device-cancel">Cancel</button><a class="button primary" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open iBroadcast sign-in ↗</a></div>`;
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
  for (const a of state.details.values()) { names.add(a.artist.toLocaleLowerCase()); for (const t of a.tracks) names.add(t.artist.toLocaleLowerCase()); }
  return names;
}

function renderReviewChrome(changes) {
  const apply = $("#apply-draft"), count = changes.length;
  apply.disabled = false; reloadOnApply = false;
  apply.textContent = live() ? `Save ${count} ${count === 1 ? "record" : "records"} to iBroadcast` : "Apply to preview";
  $("#review-cancel").disabled = false;
  $("#review-status").innerHTML = "";
  $("#review-intro").textContent = live()
    ? "Saving writes these values to your iBroadcast library. Library Studio first checks that nothing changed in iBroadcast since you loaded it; if something did, nothing is written."
    : "These changes apply only to this preview. Connect your account to save them to iBroadcast.";
  const warnings = [];
  if (live()) {
    const known = knownArtists();
    const fresh = [...new Set(changes.flatMap(c => c.fields.artist ? [c.fields.artist.after] : []))].filter(n => !known.has(n.toLocaleLowerCase()));
    if (fresh.length) warnings.push(`New ${fresh.length === 1 ? "artist" : "artists"} in iBroadcast: ${fresh.map(n => `“${escapeHtml(n)}”`).join(", ")}. Check the spelling; Library Studio will create ${fresh.length === 1 ? "it" : "them"} unless your library already has ${fresh.length === 1 ? "an artist" : "artists"} with that name.`);
    if (changes.some(c => c.kind === "album" && c.fields.artist)) warnings.push("Changing an album artist can make iBroadcast regroup the album. The library is read back after saving so you see the result.");
  }
  $("#review-warnings").innerHTML = warnings.map(w => `<div class="warn-box">${w}</div>`).join("");
}

async function saveDraft() {
  if (saving || !pending) return;
  saving = true;
  const apply = $("#apply-draft");
  apply.disabled = true; $("#review-cancel").disabled = true; apply.textContent = "Saving…";
  $("#review-status").innerHTML = '<span class="spinner"></span>Checking iBroadcast, saving and reading back…';
  try {
    const result = await api("/api/save", {changes: pending.changes});
    const byId = new Map((result.results || []).map(r => [`${r.kind}:${r.id}`, r.status]));
    const statuses = [...byId.values()];
    const overall = statuses.some(s => s === "failed" || s === "not_sent") ? "failed" : statuses.some(s => s === "unverified") ? "unverified" : "saved";
    const newArtist = pending.scope === "artist" ? pending.changes.find(c => c.kind === "album" && c.fields.artist)?.fields.artist.after : null;
    state.history.unshift({...structuredClone(pending), created: new Date().toISOString(), status: overall, source: "ibroadcast", error: result.error || "",
      created_artists: result.created_artists || [], changes: pending.changes.map(c => ({...c, status: byId.get(`${c.kind}:${c.id}`) || (statuses.length ? "unverified" : "saved")}))});
    if (result.albums) { state.albums = colorize(result.albums); state.details = new Map(); }
    pending = null; editing = null; state.selected.clear();
    if (newArtist && state.albums.some(a => a.artist === newArtist)) state.artist = newArtist;
    if (state.artist && !state.albums.some(a => a.artist === state.artist)) state.artist = null;
    $("#review").close(); $("#editor").close(); render();
    showResults(result, overall);
  } catch (error) {
    apply.disabled = false; $("#review-cancel").disabled = false;
    apply.textContent = "Try again";
    if (error.status === 401) {
      state.connection.connected = false; updateChrome();
      $("#review-status").innerHTML = `<span style="color:#9a4334">${escapeHtml(error.message)}</span>`;
      apply.disabled = true;
    } else if (error.status === 409) {
      $("#review-status").innerHTML = `<span style="color:#9a4334">${escapeHtml(error.message)}</span>`;
      apply.textContent = "Reload library"; reloadOnApply = true;
      apply.disabled = false;
      return;
    } else {
      $("#review-status").innerHTML = `<span style="color:#9a4334">Nothing was confirmed: ${escapeHtml(error.message)}</span>`;
    }
  } finally {
    saving = false;
  }
}

function showResults(result, overall) {
  const rows = result.results || [];
  const saved = rows.filter(r => r.status === "saved").length;
  $("#results-title").textContent = !rows.length ? "Already up to date" : overall === "saved" ? `${saved} ${saved === 1 ? "record" : "records"} saved` : overall === "unverified" ? "Saved, partly not confirmed" : "Save incomplete";
  const notes = [];
  if (result.message) notes.push(`<p class="muted">${escapeHtml(result.message)}</p>`);
  if (result.error) notes.push(`<div class="error-box">${escapeHtml(result.error)}</div>`);
  if (result.created_artists?.length) notes.push(`<p class="muted">New artists created: ${result.created_artists.map(n => `“${escapeHtml(n)}”`).join(", ")}.</p>`);
  if (overall === "unverified") notes.push('<div class="warn-box">iBroadcast accepted the request, but the library it returned does not show every new value yet. Reload the library in a minute to check.</div>');
  if (!result.albums) notes.push('<div class="warn-box">The library could not be read back. Reload it before editing further.</div>');
  $("#results-content").innerHTML = notes.join("") + rows.map(r => `<div class="result-row"><div>${escapeHtml(r.kind === "album" ? "Album" : "Track")} · ${escapeHtml(r.label)}<small>${escapeHtml(r.fields.map(f => f === "name" ? "title" : f === "track" ? "track number" : f).join(", "))}</small></div>${statusPill(r.status)}</div>`).join("");
  $("#results").showModal();
}

document.addEventListener("click", event => {
  const target = event.target.closest("#client-save, #client-change, #device-start, #device-cancel, #browser-start, #connect-reload, #connect-redownload, #connect-logout, #reload-button, #logout-button");
  if (target) connectAction(target);
});
document.addEventListener("keydown", event => { if (event.key === "Enter" && event.target.id === "client-id") connectAction($("#client-save")); });
$("#connect-button").addEventListener("click", openConnect);
$("#mode-badge").addEventListener("click", openConnect);
