"use strict";

// Exact, paginated groups that open their albums. Live libraries are indexed on the server;
// only the local demo uses the browser's complete album details.
const browseKinds = {
  decades: {label: "Decades", noun: "decades", singular: "decade", subtitle: "Choose a decade and discover a random selection of albums. Track years take precedence, with album years as fallback."},
  "track-artists": {label: "Track artists", noun: "track artists", singular: "track artist", subtitle: "Explore the performers credited on your tracks. Open a card to see their albums."},
  composers: {label: "Composers", noun: "composers", singular: "composer", subtitle: "Explore composer credits. Open a card to see their albums."},
  genres: {label: "Genres", noun: "genres", singular: "genre", subtitle: "Explore main and additional genres. Combined labels such as Pop;Rock stay together as stored."},
  tags: {label: "Tags", noun: "tags", singular: "tag", subtitle: "Your own iBroadcast labels, separate from genres. Open a tag to find matching albums. Manage assignments on an album or track."},
  years: {label: "Release year", noun: "release years", singular: "release year", subtitle: "Explore tracks by release year. The track year takes precedence, with the album year as fallback. Missing years appear under Unknown year."},
  "upload-folders": {label: "Upload folders", noun: "upload folders", singular: "upload folder", subtitle: "Find albums by their original upload folder. These are stored upload paths, not folders on this computer or playlist folders."},
  uploaded: {label: "Date uploaded", noun: "upload days", singular: "upload day", subtitle: "Find albums by the upload day stored by iBroadcast, independently of release year. Dates are shown as stored, without a time-zone conversion."},
};

const uploadBrowseKind = () => ["upload-folders", "uploaded"].includes(browseView.kind);

function uploadBrowseTitle() {
  return browseView.kind === "upload-folders" && browseView.key !== "unknown"
    ? browseView.label.split(/[\\/]/).filter(Boolean).at(-1) || browseView.label : browseView.label;
}
// Brief editorial sketches, independent of the albums in a user's collection.
// References: Library of Congress Songs of America and Recorded Sound Research;
// the Met's Nineteenth-Century Classical Music; Smithsonian's Hip-Hop and Rap
// anthology; Rock Hall artist histories; IFPI Global Music Reports 2021 and 2026.
// https://guides.loc.gov/recorded-sound-research/print-materials
// https://www.metmuseum.org/essays/nineteenth-century-classical-music
// https://nmaahc.si.edu/explore/publications/smithsonian-anthology-hip-hop-and-rap
// https://rockhall.com/inductees/joy-division-new-order/
// https://www.ifpi.org/resources/
const decadeIntroductions = {
  "1900": "Ragtime, brass bands and popular songs filled theatres and homes, while early records brought performers to new listeners. In concert music, late Romantic richness met new approaches to harmony and colour.",
  "1910": "Ragtime and dance bands shared the stage with blues and the first jazz recordings. Composers explored new rhythms and harmonies, while folk traditions continued to shape everyday music.",
  "1920": "Jazz, blues and dance orchestras reached growing audiences through records and radio. Improvisation and distinctive voices flourished alongside country recordings, popular songs and adventurous concert music.",
  "1930": "Big-band swing brought dance rhythms, memorable singers and inventive soloists to a wide audience. Blues, country and orchestral music offered equally rich paths through the decade.",
  "1940": "New jazz directions, including bebop, grew alongside swing. Rhythm and blues and bluegrass developed distinctive sounds, while vocalists brought both intimacy and energy to popular songs.",
  "1950": "Rock and roll brought the energy of rhythm and blues and country to new audiences. Doo-wop, vocal pop, electric blues and varied jazz styles added to the decade's colourful sound.",
  "1960": "Pop and rock became a space for rapid experimentation, from the British beat boom and folk-rock to psychedelic studio sounds. Soul, jazz and folk traditions offered a wealth of distinctive voices.",
  "1970": "Funk and disco filled dance floors, progressive rock stretched the album format, and punk brought a sharper edge. Reggae, singer-songwriters, jazz fusion and electronic experiments added their own distinctive sounds.",
  "1980": "Synth-pop, new wave and electronic dance sounds grew around synthesisers, drum machines and sampling. Hip-hop expanded its reach, while guitar-driven rock and metal continued to flourish.",
  "1990": "Grunge, alternative rock and Britpop gave guitar music fresh directions, while hip-hop and R&B became major creative forces. House, techno and other club sounds flourished alongside a wide range of independent scenes.",
  "2000": "Hip-hop, R&B, pop, indie rock and electronic music shared an increasingly digital world. Downloads and online discovery changed how listeners found music, while albums and independent scenes continued to evolve.",
  "2010": "Streaming and playlists changed everyday listening, bringing music from many places within easy reach. Pop, hip-hop and electronic dance music crossed paths, while independent artists found new ways to reach listeners.",
  "2020": "Streaming connects pop, hip-hop and electronic music with regional scenes around the world. New releases sit alongside rediscovered recordings, bringing fresh voices and older favourites into the same listening space.",
};

function decadeIntroduction(key) {
  if (Object.hasOwn(decadeIntroductions, key)) return decadeIntroductions[key];
  const year = Number(key);
  if (!Number.isInteger(year) || year <= 0 || year % 10 !== 0) return "";
  if (year >= 1800 && year < 1900) return "Concert halls, opera houses and music at home shaped this era of classical and Romantic music. Recordings in your collection may revisit works written long before recording became widespread.";
  if (year < 1800) return "Music from earlier centuries lives on through songs, instrumental works and performances passed down across generations. Explore the recordings that connect your collection with this period.";
  if (year > new Date().getFullYear()) return "The music of this decade is still ahead of us. Explore releases associated with these future years in your collection.";
  return "Discover the music your collection connects with these years, from familiar styles to new directions and distinctive voices.";
}
const browseView = {kind: "track-artists", key: null, label: "", rows: [], albumIds: new Set(), total: 0, page: 0,
  query: "", sort: "az", pageSize: storedPageSize("tagcast-browse-per-page") || 24,
  request: 0, details: null, loaded: false, loading: false, error: "", randomIds: [], membershipQuery: ""};
let browseTimer;

function resetBrowse() {
  clearTimeout(browseTimer);
  browseView.request += 1;
  Object.assign(browseView, {rows: [], albumIds: new Set(), total: 0, details: null, loaded: false, loading: false, error: "", randomIds: []});
}

function localBrowse() {
  const groups = new Map(), kind = browseView.kind, paths = new Map();
  const shelf = new Map(albumShelf().flatMap(a => itemIds(a).map(id => [id, String(a.id)])));
  const albums = [...state.details.values()].sort((a, b) => foldText(a.artist).localeCompare(foldText(b.artist))
    || foldText(a.name).localeCompare(foldText(b.name)) || (a.disc || 0) - (b.disc || 0));
  for (const a of albums) for (const t of [...a.tracks].sort((a, b) => (a.track || 9999) - (b.track || 9999))) {
    let entries;
    if (kind === "track-artists") entries = t.performers?.length ? t.performers.map(p => [String(p.id), p.name]) : [[String(t.artist_id ?? `name:${t.artist}`), t.artist]];
    else if (kind === "composers") entries = (t.composers || []).map((name, i) => [String(t.composer_ids?.[i] ?? `name:${name}`), name]);
    else if (kind === "genres") entries = trackGenres(t).map(name => [name.toLocaleLowerCase(), name]);
    else if (kind === "tags") entries = (t.tags || []).map(tag => [tag.id, tag.name]);
    else if (kind === "upload-folders") {
      const path = String(t.path || "");
      if (path.trim() && !paths.has(path)) paths.set(path, `folder-${paths.size}`);
      entries = [[path.trim() ? paths.get(path) : "unknown", path.trim() ? path : "Unknown upload folder"]];
    } else if (kind === "uploaded") {
      const day = String(t.uploaded_at || t.uploaded_on || "").slice(0, 10);
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number(day.slice(0, 4)) > 0 && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
      entries = [[valid ? day : "unknown", valid ? day : "Unknown upload date"]];
    }
    else if (kind === "decades") {
      const year = Number(t.year || a.year) || 0, decade = Math.floor(year / 10) * 10;
      entries = year > 0 ? [[String(decade), `${decade}s`]] : [];
    } else entries = [[String(t.year || a.year || 0), String(t.year || a.year || "Unknown year")]];
    const seen = new Set();
    for (const [key, label] of entries) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, {key, label, image: "", ids: new Set(), rows: []});
      const group = groups.get(key);
      if (group.ids.has(String(t.id))) continue;
      group.ids.add(String(t.id));
      group.rows.push({id: String(t.id), album_id: String(a.id), title: t.title, artist: t.artist,
        album: a.name, album_artist: a.artist, composers: t.composers || [], disc: a.disc, track: t.track,
        year: t.year || a.year, length: t.length || 0, rating: t.rating || 0, performers: t.performers || [],
        format: t.format || "", uploaded_at: t.uploaded_at || t.uploaded_on || ""});
    }
  }
  const words = foldText(browseView.query).split(" ").filter(Boolean);
  const matches = text => words.every(w => foldText(text).includes(w));
  let rows;
  if (browseView.key !== null) {
    const group = groups.get(browseView.key);
    if (!group) throw Error("This group is no longer available. Open the overview again.");
    browseView.label = group.label;
    if (uploadBrowseKind()) {
      rows = group.rows.filter(t => matches([t.title, t.artist, t.album, t.album_artist, ...t.performers.map(p => p.name), ...t.composers].join(" ")));
      browseView.albumIds = new Set(rows.map(t => t.album_id));
      return;
    }
    browseView.albumIds = new Set(group.rows.map(t => t.album_id));
    return;
  } else {
    rows = [...groups.values()].filter(g => matches(g.label)).map(g => ({key: g.key, label: g.label, image: g.image,
      tracks: g.rows.length, albums: new Set(g.rows.map(t => shelf.get(t.album_id) || t.album_id)).size}));
    rows.sort((a, b) => browseView.sort === "count" ? b.tracks - a.tracks || foldText(a.label).localeCompare(foldText(b.label))
      : ["years", "decades"].includes(kind) ? (a.key === "0") - (b.key === "0") || (Number(a.key) - Number(b.key)) * (browseView.sort === "za" ? -1 : 1)
      : foldText(a.label).localeCompare(foldText(b.label)) * (browseView.sort === "za" ? -1 : 1));
    if (uploadBrowseKind()) rows.sort((a, b) => Number(a.key === "unknown") - Number(b.key === "unknown"));
  }
  browseView.total = rows.length;
  browseView.page = Math.min(browseView.page, Math.max(0, Math.ceil(rows.length / browseView.pageSize) - 1));
  browseView.rows = rows.slice(browseView.page * browseView.pageSize, (browseView.page + 1) * browseView.pageSize);
}

async function loadBrowse() {
  const request = ++browseView.request, details = state.details;
  browseView.query = $("#browse-search").value.trim();
  browseView.details = details; browseView.error = ""; browseView.rows = []; browseView.albumIds = new Set(); browseView.total = 0; browseView.loaded = false;
  if (state.loading) { browseView.loading = false; renderBrowse(); return; }
  browseView.loading = true; renderBrowse();
  try {
    if (!live()) localBrowse();
    else {
      const params = new URLSearchParams({kind: browseView.kind, q: browseView.query,
        offset: String(browseView.page * browseView.pageSize), limit: String(browseView.pageSize), sort: browseView.key === null ? browseView.sort : "az"});
      if (browseView.key !== null) params.set("key", browseView.key);
      const data = await api(`/api/browse?${params}`);
      if (request !== browseView.request || details !== state.details) return;
      browseView.rows = data.groups || [];
      browseView.albumIds = new Set(data.album_ids || []);
      if (!data.group) { browseView.total = data.total || 0; browseView.page = Math.floor((data.offset || 0) / browseView.pageSize); }
      if (data.group) browseView.label = data.group.label;
    }
    browseView.membershipQuery = browseView.query; browseView.loaded = true;
  } catch (error) {
    if (request !== browseView.request || details !== state.details) return;
    browseView.error = error.status === 404 ? "Restart Tagcast to use these overviews: the running server is older than this page." : error.message;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
  } finally {
    if (request === browseView.request && details === state.details) { browseView.loading = false; renderBrowse(); }
  }
}

function browseCard(g) {
  const people = ["track-artists", "composers"].includes(browseView.kind);
  const albums = g.albums == null ? "" : `${g.albums.toLocaleString("en")} ${g.albums === 1 ? "album" : "albums"}`;
  const tracks = `${g.tracks.toLocaleString("en")} ${g.tracks === 1 ? "track" : "tracks"}`;
  const image = g.image ? `<img src="${escapeHtml(g.image.replace(/-150$/, "-300"))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
  return `<button class="artist-card ${people ? "" : "browse-label-card"}" data-browse-key="${escapeHtml(g.key)}" data-browse-label="${escapeHtml(g.label)}" aria-label="Open albums for ${escapeHtml(g.label)}">
    ${people ? `<span class="artist-card-photo">${image}<span>${escapeHtml(initials(g.label))}</span></span>` : ""}
    <strong>${escapeHtml(g.label)}</strong>${g.archived ? '<small class="muted">Archived in iBroadcast</small>' : ""}<span class="artist-card-count">${albums || tracks}</span>${albums ? `<small class="artist-card-tracks">${tracks}</small>` : ""}</button>`;
}

function browseAlbumCard(a) {
  return `<article class="album-card"><button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="Open ${escapeHtml(a.name)}">${cover(a)}<span class="album-name">${escapeHtml(a.name)}</span><span class="album-artist">${escapeHtml(a.artist)}</span></button>
    <div class="card-meta"><div class="album-card-meta-text"><span>${albumCardMetadata(a)}</span>${badge(a)}</div>${albumCardActions(a)}</div></article>`;
}

function shuffledAlbumIds(albums) {
  const ids = albums.map(a => a.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

// All matching albums, before pagination or the decade's random display sample.
function browseAlbums() {
  if (browseView.key === null || !browseView.loaded || browseView.loading || browseView.error
    || browseView.details !== state.details || state.loading) return [];
  const words = foldText(browseView.query).split(" ").filter(Boolean);
  return albumShelf().filter(a => itemIds(a).some(id => browseView.albumIds.has(id))
    && (uploadBrowseKind() || words.every(w => foldText([a.name, a.artist, ...a.genres].join(" ")).includes(w))));
}

function renderBrowse() {
  if (state.screen !== "browse") return;
  if (!state.loading && !browseView.loading && (browseView.details !== state.details || !browseView.loaded && !browseView.error)) { loadBrowse(); return; }
  const config = browseKinds[browseView.kind], detail = browseView.key !== null;
  const uploads = uploadBrowseKind(), uploadDetail = uploads && detail;
  $("#browse-page").dataset.kind = browseView.kind;
  $("#browse-tag-actions").hidden = browseView.kind !== "tags" || !live();
  $("#browse-tag-rename").hidden = !detail;
  $("#browse-tag-delete").hidden = !detail;
  const decades = browseView.kind === "decades", surprise = detail && decades;
  $("#browse-title").textContent = detail ? (uploads ? uploadBrowseTitle() : browseView.label) || "Albums" : `${config.label}.`;
  $("#breadcrumb").innerHTML = detail ? `${escapeHtml(config.label)}<span class="slash" aria-hidden="true">/</span><span aria-current="page">${escapeHtml((uploads ? uploadBrowseTitle() : browseView.label) || "Albums")}</span>` : escapeHtml(config.label);
  $("#browse-eyebrow").textContent = detail ? config.label.toLocaleUpperCase() : "EXPLORE YOUR COLLECTION";
  $("#browse-subtitle").textContent = uploadDetail ? "Albums with at least one track in this upload group. An album may appear in several folders or days. Open or play an album to use the complete album."
    : surprise ? "A random selection from this decade. Open an album to listen, add it to your queue, or try Surprise me again." : detail ? "Albums with at least one matching track. Open an album to see its tracks, listen or edit." : config.subtitle;
  $("#browse-upload-path").hidden = !(uploadDetail && browseView.kind === "upload-folders");
  $("#browse-upload-path").textContent = uploadDetail && browseView.kind === "upload-folders" ? browseView.label : "";
  const introduction = surprise ? decadeIntroduction(browseView.key) : "";
  $("#browse-decade-intro").textContent = introduction;
  $("#browse-decade-intro").hidden = !introduction;
  $("#browse-back").hidden = !detail;
  $("#browse-back").textContent = `← Back to ${backLabel(config.label)}`;
  $("#browse-toolbar").hidden = decades && !detail;
  $("#browse-search-field").hidden = decades && !detail;
  $("#browse-search").placeholder = uploadDetail ? "Search albums, artists or tracks in this group" : detail ? "Search albums in this group" : `Search ${config.noun}`;
  $("#browse-search").setAttribute("aria-label", detail ? "Search group albums" : `Search ${config.noun}`);
  $("#browse-per-page").value = String(browseView.pageSize);
  $("#browse-per-page").hidden = decades && !detail;
  $("#browse-surprise").hidden = !surprise;
  $("#browse-surprise").disabled = state.loading || browseView.loading || Boolean(browseView.error);
  const sort = $("#browse-sort");
  sort.hidden = decades;
  sort.setAttribute("aria-label", detail ? "Sort group albums" : `Sort ${config.noun}`);
  sort.innerHTML = detail ? '<option value="artist">Album artist · A–Z</option><option value="artist_za">Album artist · Z–A</option><option value="title">Album title · A–Z</option><option value="title_za">Album title · Z–A</option><option value="year">Release year · oldest first</option><option value="newest">Release year · newest first</option>'
    : browseView.kind === "uploaded" ? '<option value="za">Upload day · newest first</option><option value="az">Upload day · oldest first</option><option value="count">Most tracks first</option>'
    : ["years", "decades"].includes(browseView.kind) ? '<option value="az">Year · oldest first</option><option value="za">Year · newest first</option><option value="count">Most tracks first</option>'
    : '<option value="az">Name · A–Z</option><option value="za">Name · Z–A</option><option value="count">Most tracks first</option>';
  sort.value = browseView.sort;
  let rows = browseView.rows;
  if (detail && browseView.loaded && !state.loading && !browseView.loading) {
    const albums = browseAlbums();
    if (surprise) {
      if (!browseView.randomIds.length) browseView.randomIds = shuffledAlbumIds(albumShelf().filter(a => itemIds(a).some(id => browseView.albumIds.has(id))));
      const order = new Map(browseView.randomIds.map((id, index) => [id, index]));
      albums.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
      browseView.page = 0;
    } else albums.sort(SORTS[browseView.sort] || SORTS.artist);
    browseView.total = albums.length;
    browseView.page = Math.min(browseView.page, Math.max(0, Math.ceil(albums.length / browseView.pageSize) - 1));
    rows = albums.slice(browseView.page * browseView.pageSize, (browseView.page + 1) * browseView.pageSize);
  }
  $("#browse-results").textContent = state.loading || browseView.loading ? "Loading…" : browseView.error ? ""
    : surprise ? `Showing ${rows.length} random ${rows.length === 1 ? "album" : "albums"} of ${browseView.total.toLocaleString("en")}` : `${browseView.total.toLocaleString("en")} ${detail ? browseView.total === 1 ? "album" : "albums" : browseView.total === 1 ? config.singular : config.noun}`;
  const list = $("#browse-list");
  list.className = detail ? "album-grid" : uploads ? "upload-group-list" : "artists-grid";
  list.innerHTML = state.loading || browseView.loading ? '<div class="empty" role="status"><span class="spinner"></span>Loading your collection…</div>'
    : browseView.error ? `<p class="error-box" role="alert">${escapeHtml(browseView.error)}</p>`
    : !rows.length ? '<div class="empty">No matches in this library.</div>'
    : detail ? rows.map(browseAlbumCard).join("") : rows.map(browseCard).join("");
  const max = Math.max(0, Math.ceil(browseView.total / browseView.pageSize) - 1);
  $("#browse-pagination").innerHTML = !surprise && !state.loading && !browseView.loading && max > 0 ? `<button class="button small" data-browse-page="-1" ${browseView.page === 0 ? "disabled" : ""}>← Previous</button><span>Page ${browseView.page + 1} of ${(max + 1).toLocaleString("en")}</span><button class="button small" data-browse-page="1" ${browseView.page === max ? "disabled" : ""}>Next →</button>` : "";
  updateFavouriteControls();
  updateRandomControls();
  if (typeof syncHistory === "function") syncHistory();
}

function showBrowse(kind, key = null, saved = {}) {
  if (!browseKinds[kind]) return;
  clearTimeout(browseTimer);
  const uploads = ["upload-folders", "uploaded"].includes(kind);
  Object.assign(browseView, {kind, key, label: saved.label || "", query: kind === "decades" && key === null ? "" : saved.query || "", page: saved.page || 0,
    sort: kind === "decades" && key === null ? "za" : (uploads && key !== null ? ({album:"artist",az:"title",za:"title_za"}[saved.sort] || saved.sort) : saved.sort) || (key !== null ? "artist" : ["years","uploaded"].includes(kind) ? "za" : "az"), rows: [], albumIds: new Set(), details: null, loaded: false, randomIds: Array.isArray(saved.randomIds) ? saved.randomIds.filter(id => typeof id === "string") : []});
  $("#browse-search").value = browseView.query;
  showScreen("browse"); loadBrowse(); window.scrollTo?.({top: 0});
}

function refreshBrowseList() {
  // Album summaries are already in memory. Search, sort and page them locally;
  // only overview cards and exact group membership need an API request.
  if (browseView.key !== null && browseView.loaded && browseView.details === state.details
    && (!uploadBrowseKind() || browseView.membershipQuery === browseView.query)) renderBrowse();
  else loadBrowse();
}

$("#browse-surprise").addEventListener("click", () => {
  if (browseView.kind !== "decades" || browseView.key === null || !browseView.loaded) return;
  browseView.randomIds = []; browseView.page = 0; renderBrowse();
});
$("#browse-back").addEventListener("click", () => { if (canGoBack()) history.back(); else showBrowse(browseView.kind); });
$("#browse-search").addEventListener("input", () => {
  clearTimeout(browseTimer); browseView.request += 1; browseView.loading = false;
  browseView.query = $("#browse-search").value.trim(); browseView.page = 0;
  syncHistory(); browseTimer = setTimeout(refreshBrowseList, 250);
});
$("#browse-sort").addEventListener("change", event => { browseView.sort = event.target.value; browseView.page = 0; refreshBrowseList(); });
$("#browse-per-page").addEventListener("change", event => {
  const size = Number(event.target.value);
  if (![24, 50, 100, 200].includes(size)) return;
  browseView.page = Math.floor(browseView.page * browseView.pageSize / size); browseView.pageSize = size;
  rememberPageSize("tagcast-browse-per-page", size); refreshBrowseList();
});
document.addEventListener("click", event => {
  const kind = event.target.closest("[data-browse-kind]");
  if (kind) { showBrowse(kind.dataset.browseKind, kind.dataset.browseKey ?? null, {label: kind.dataset.browseLabel}); return; }
  const group = event.target.closest("[data-browse-key]");
  if (group) { showBrowse(browseView.kind, group.dataset.browseKey, {label: group.dataset.browseLabel}); return; }
  const page = event.target.closest("[data-browse-page]");
  if (page && !browseView.loading) { browseView.page = Math.max(0, browseView.page + Number(page.dataset.browsePage)); refreshBrowseList(); window.scrollTo?.({top: 0}); }
});
