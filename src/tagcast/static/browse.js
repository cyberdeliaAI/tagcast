"use strict";

// Exact, paginated groups that open their albums. Live libraries are indexed on the server;
// only the local demo uses the browser's complete album details.
// Interface text keys per group. `label` and `subtitle` read in the current language, so other
// pages (help, breadcrumbs) that use browseKinds follow a language change too.
const browseKinds = Object.fromEntries(Object.entries({
  decades: {label: "nav.sidebar.decades", subtitle: "browse.decades.subtitle", search: "browse.decades.search", sort: "browse.decades.sort", count: "browse.decades.count"},
  "track-artists": {label: "nav.sidebar.trackArtists", subtitle: "browse.trackArtists.subtitle", search: "browse.trackArtists.search", sort: "browse.trackArtists.sort", count: "browse.trackArtists.count"},
  composers: {label: "nav.sidebar.composers", subtitle: "browse.composers.subtitle", search: "browse.composers.search", sort: "browse.composers.sort", count: "browse.composers.count"},
  genres: {label: "nav.sidebar.genres", subtitle: "browse.genres.subtitle", search: "browse.genres.search", sort: "browse.genres.sort", count: "browse.genres.count"},
  tags: {label: "nav.sidebar.tags", subtitle: "browse.tags.subtitle", search: "browse.tags.search", sort: "browse.tags.sort", count: "browse.tags.count"},
  years: {label: "nav.sidebar.releaseYear", subtitle: "browse.years.subtitle", search: "browse.years.search", sort: "browse.years.sort", count: "browse.years.count"},
  "upload-folders": {label: "nav.sidebar.uploadFolders", subtitle: "browse.uploadFolders.subtitle", search: "browse.uploadFolders.search", sort: "browse.uploadFolders.sort", count: "browse.uploadFolders.count"},
  uploaded: {label: "nav.sidebar.dateUploaded", subtitle: "browse.uploaded.subtitle", search: "browse.uploaded.search", sort: "browse.uploaded.sort", count: "browse.uploaded.count"},
}).map(([kind, keys]) => [kind, {keys,
  get label() { return TagcastI18n.text(keys.label); },
  get subtitle() { return TagcastI18n.text(keys.subtitle); }}]));

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
  "1900": "browse.decadeIntro.y1900", "1910": "browse.decadeIntro.y1910", "1920": "browse.decadeIntro.y1920",
  "1930": "browse.decadeIntro.y1930", "1940": "browse.decadeIntro.y1940", "1950": "browse.decadeIntro.y1950",
  "1960": "browse.decadeIntro.y1960", "1970": "browse.decadeIntro.y1970", "1980": "browse.decadeIntro.y1980",
  "1990": "browse.decadeIntro.y1990", "2000": "browse.decadeIntro.y2000", "2010": "browse.decadeIntro.y2010",
  "2020": "browse.decadeIntro.y2020",
};

function decadeIntroduction(key) {
  if (Object.hasOwn(decadeIntroductions, key)) return TagcastI18n.text(decadeIntroductions[key]);
  const year = Number(key);
  if (!Number.isInteger(year) || year <= 0 || year % 10 !== 0) return "";
  if (year >= 1800 && year < 1900) return TagcastI18n.text("browse.decadeIntro.nineteenthCentury");
  if (year < 1800) return TagcastI18n.text("browse.decadeIntro.earlier");
  if (year > new Date().getFullYear()) return TagcastI18n.text("browse.decadeIntro.future");
  return TagcastI18n.text("browse.decadeIntro.general");
}
const browseView = {kind: "track-artists", key: null, label: "", rows: [], albumIds: new Set(), total: 0, page: 0,
  query: "", sort: "az", pageSize: storedPageSize("tagcast-browse-per-page") || 24,
  request: 0, details: null, loaded: false, loading: false, error: "", randomIds: [], membershipQuery: ""};
// Each group overview remembers its own display choice. Album shelves share one choice.
const browseAlbumContinuous = new ContinuousBrowse("browse-albums", "browse");
const browseGroupContinuous = new Map(Object.keys(browseKinds).map(kind => {
  const controller = new ContinuousBrowse(`browse-${kind}`, "browse");
  controller.batch = 50; controller.count = 50;
  return [kind, controller];
}));
function browseContinuous() {
  return browseView.key !== null ? browseAlbumContinuous : browseGroupContinuous.get(browseView.kind);
}
for (const controller of [browseAlbumContinuous, ...browseGroupContinuous.values()]) {
  controller.isActive = () => browseContinuous() === controller && browseView.loaded && !browseView.loading && !state.loading;
}
function continuousBrowseEnabled() {
  // Decades keep their deliberately bounded random album sample.
  return browseView.kind !== "decades" && browseContinuous().enabled;
}
let browseTimer;

function resetBrowse() {
  clearTimeout(browseTimer);
  for (const controller of [browseAlbumContinuous, ...browseGroupContinuous.values()]) controller.clear();
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
    if (!group) throw viewFailure("errors.nav.group_missing");
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
  browseView.rows = continuousBrowseEnabled() ? rows : rows.slice(browseView.page * browseView.pageSize, (browseView.page + 1) * browseView.pageSize);
}

async function loadBrowse() {
  const request = ++browseView.request, details = state.details;
  browseView.query = $("#browse-search").value.trim();
  browseView.moreLoading = false; browseView.moreError = null;
  browseView.details = details; browseView.error = ""; browseView.rows = []; browseView.albumIds = new Set(); browseView.total = 0; browseView.loaded = false;
  if (state.loading) { browseView.loading = false; renderBrowse(); return; }
  browseView.loading = true; renderBrowse();
  try {
    if (!live()) localBrowse();
    else {
      const params = new URLSearchParams({kind: browseView.kind, q: browseView.query,
        offset: String(continuousBrowseEnabled() ? 0 : browseView.page * browseView.pageSize), limit: String(continuousBrowseEnabled() ? 50 : browseView.pageSize), sort: browseView.key === null ? browseView.sort : "az"});
      if (browseView.key !== null) params.set("key", browseView.key);
      const data = await api(`/api/browse?${params}`);
      if (request !== browseView.request || details !== state.details) return;
      browseView.rows = data.groups || [];
      browseView.albumIds = new Set(data.album_ids || []);
      if (!data.group) { browseView.total = data.total || 0; browseView.page = Math.floor((data.offset || 0) / browseView.pageSize); }
      if (data.group) browseView.label = data.group.label;
    }
    // Restore only the previously revealed overview prefix for browser Back, never all groups.
    if (live() && browseView.key === null && continuousBrowseEnabled()) {
      const target = browseContinuous().pendingCount || 50;
      while (browseView.rows.length < target && browseView.rows.length < browseView.total) {
        const rows = await fetchBrowseMore();
        if (request !== browseView.request || details !== state.details) return;
        browseView.rows.push(...rows);
      }
    }
    browseView.membershipQuery = browseView.query; browseView.loaded = true;
  } catch (error) {
    if (request !== browseView.request || details !== state.details) return;
    // An Error, shown through TagcastI18n.errorText() so a language change can show it again.
    browseView.error = error.status === 404 ? viewFailure("errors.nav.browse_outdated") : error;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
  } finally {
    if (request === browseView.request && details === state.details) { browseView.loading = false; renderBrowse(); }
  }
}

async function fetchBrowseMore() {
  const offset = browseView.rows.length;
  const params = new URLSearchParams({kind: browseView.kind, q: browseView.query,
    offset: String(offset), limit: "50", sort: browseView.sort});
  const data = await api(`/api/browse?${params}`);
  const rows = data.groups;
  if (data.offset !== offset || !Array.isArray(rows) || !rows.length || rows.length > 50
    || new Set([...browseView.rows, ...rows].map(row => row.key)).size !== offset + rows.length) {
    throw viewFailure("errors.nav.group_missing");
  }
  return rows;
}

async function loadMoreBrowseGroups() {
  if (!continuousBrowseEnabled() || browseView.key !== null || browseView.moreLoading
    || !browseView.loaded || browseView.loading || !live()) return;
  const request = browseView.request, details = state.details, controller = browseContinuous();
  const current = () => request === browseView.request && details === state.details
    && state.screen === "browse" && controller === browseContinuous() && continuousBrowseEnabled();
  browseView.moreLoading = true; browseView.moreError = null;
  controller.auto = false;
  controller.message = `<span role="status">${TagcastI18n.html("common.loading")}</span>`;
  controller.renderFooter();
  try {
    const rows = await fetchBrowseMore();
    if (!current()) return;
    browseView.rows = [...browseView.rows, ...rows];
    controller.restore(browseView.rows.length);
  } catch (error) {
    if (!current()) return;
    browseView.moreError = error;
    if (error.status === 401) { state.connection.connected = false; updateChrome(); }
  } finally {
    if (current()) { browseView.moreLoading = false; renderBrowse(); }
  }
}

function browseCard(g) {
  const people = ["track-artists", "composers"].includes(browseView.kind);
  const albums = g.albums == null ? "" : TagcastI18n.html("browse.count.albums", {count: g.albums});
  const tracks = TagcastI18n.html("browse.count.tracks", {count: g.tracks});
  const image = g.image ? `<img src="${escapeHtml(g.image.replace(/-150$/, "-300"))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-error="remove">` : "";
  return `<button class="artist-card ${people ? "" : "browse-label-card"}" data-browse-key="${escapeHtml(g.key)}" data-browse-label="${escapeHtml(g.label)}" aria-label="${TagcastI18n.html("browse.card.open", {label: g.label})}">
    ${people ? `<span class="artist-card-photo">${image}<span>${escapeHtml(initials(g.label))}</span></span>` : ""}
    <strong>${escapeHtml(g.label)}</strong>${g.archived ? `<small class="muted">${TagcastI18n.html("browse.card.archived")}</small>` : ""}<span class="artist-card-count">${albums || tracks}</span>${albums ? `<small class="artist-card-tracks">${tracks}</small>` : ""}</button>`;
}

function browseAlbumCard(a) {
  return `<article class="album-card"><button class="album-open" data-album="${escapeHtml(a.id)}" aria-label="${TagcastI18n.html("browse.albumCard.open", {name: a.name})}">${cover(a)}<span class="album-name">${escapeHtml(a.name)}</span><span class="album-artist">${escapeHtml(a.artist)}</span></button>
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
  for (const controller of [browseAlbumContinuous, ...browseGroupContinuous.values()]) controller.discardStale(state.details);
  if (state.screen !== "browse") return;
  if (!state.loading && !browseView.loading && (browseView.details !== state.details || !browseView.loaded && !browseView.error)) { loadBrowse(); return; }
  const config = browseKinds[browseView.kind], detail = browseView.key !== null;
  const uploads = uploadBrowseKind(), uploadDetail = uploads && detail;
  $("#browse-page").dataset.kind = browseView.kind;
  $("#browse-tag-actions").hidden = browseView.kind !== "tags" || !live();
  $("#browse-tag-rename").hidden = !detail;
  $("#browse-tag-delete").hidden = !detail;
  const decades = browseView.kind === "decades", surprise = detail && decades;
  const groupTitle = (uploads ? uploadBrowseTitle() : browseView.label) || TagcastI18n.text("nav.sidebar.albums");
  $("#browse-title").textContent = detail ? groupTitle : TagcastI18n.text("browse.overview.title", {label: config.label});
  $("#breadcrumb").innerHTML = detail ? `${escapeHtml(config.label)}<span class="slash" aria-hidden="true">/</span><span aria-current="page">${escapeHtml(groupTitle)}</span>` : escapeHtml(config.label);
  $("#browse-eyebrow").textContent = detail ? config.label.toLocaleUpperCase() : TagcastI18n.text("browse.eyebrow");
  $("#browse-subtitle").textContent = uploadDetail ? TagcastI18n.text("browse.detail.uploadSubtitle")
    : surprise ? TagcastI18n.text("browse.detail.decadeSubtitle") : detail ? TagcastI18n.text("browse.detail.subtitle") : config.subtitle;
  $("#browse-upload-path").hidden = !(uploadDetail && browseView.kind === "upload-folders");
  $("#browse-upload-path").textContent = uploadDetail && browseView.kind === "upload-folders" ? browseView.label : "";
  const introduction = surprise ? decadeIntroduction(browseView.key) : "";
  $("#browse-decade-intro").textContent = introduction;
  $("#browse-decade-intro").hidden = !introduction;
  $("#browse-back").hidden = !detail;
  $("#browse-back").textContent = TagcastI18n.text("nav.back", {page: backLabel(config.label)});
  $("#browse-toolbar").hidden = decades && !detail;
  $("#browse-search-field").hidden = decades && !detail;
  $("#browse-search").placeholder = TagcastI18n.text(uploadDetail ? "browse.detail.searchUpload" : detail ? "browse.detail.search" : config.keys.search);
  $("#browse-search").setAttribute("aria-label", TagcastI18n.text(detail ? "browse.detail.searchLabel" : config.keys.search));
  const continuous = continuousBrowseEnabled(), controller = browseContinuous();
  $("#browse-per-page").value = continuous ? "continuous" : String(browseView.pageSize);
  $("#browse-per-page option[value=continuous]").hidden = decades;
  $("#browse-per-page").hidden = decades && !detail;
  $("#browse-surprise").hidden = !surprise;
  $("#browse-surprise").disabled = state.loading || browseView.loading || Boolean(browseView.error);
  const sort = $("#browse-sort");
  sort.hidden = decades;
  sort.setAttribute("aria-label", TagcastI18n.text(detail ? "browse.detail.sortLabel" : config.keys.sort));
  const sorts = detail ? [["artist", "browse.sort.albumArtistAz"], ["artist_za", "browse.sort.albumArtistZa"], ["title", "browse.sort.albumTitleAz"],
      ["title_za", "browse.sort.albumTitleZa"], ["year", "browse.sort.releaseYearOldest"], ["newest", "browse.sort.releaseYearNewest"]]
    : browseView.kind === "uploaded" ? [["za", "browse.sort.uploadDayNewest"], ["az", "browse.sort.uploadDayOldest"], ["count", "browse.sort.mostTracks"]]
    : ["years", "decades"].includes(browseView.kind) ? [["az", "browse.sort.yearOldest"], ["za", "browse.sort.yearNewest"], ["count", "browse.sort.mostTracks"]]
    : [["az", "browse.sort.nameAz"], ["za", "browse.sort.nameZa"], ["count", "browse.sort.mostTracks"]];
  const options = sorts.map(([value, key]) => `<option value="${value}">${TagcastI18n.html(key)}</option>`).join("");
  if (sort.innerHTML !== options) sort.innerHTML = options;
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
    rows = continuous ? albums : albums.slice(browseView.page * browseView.pageSize, (browseView.page + 1) * browseView.pageSize);
  }
  $("#browse-results").textContent = state.loading || browseView.loading ? TagcastI18n.text("common.loading") : browseView.error ? ""
    : surprise ? TagcastI18n.text("browse.results.random", {count: rows.length, total: browseView.total})
    : TagcastI18n.text(detail ? "browse.count.albums" : config.keys.count, {count: browseView.total});
  const list = $("#browse-list");
  if (continuous && browseView.loaded && !state.loading && !browseView.loading && !browseView.error) {
    controller.update({items: rows, key: `${browseView.kind}:${browseView.key}:${browseView.query}:${browseView.sort}`,
      scope: state.details, host: list, footer: $("#browse-pagination"),
      layout: detail ? "album-grid" : uploads ? "upload-group-list" : "artists-grid",
      render: items => items.map(detail ? browseAlbumCard : browseCard).join(""),
      empty: `<div class="empty">${TagcastI18n.html("browse.list.empty")}</div>`, changed: renderBrowse,
      total: browseView.total, loadMore: !detail && live() ? loadMoreBrowseGroups : null,
      auto: !browseView.moreLoading && !browseView.moreError,
      message: browseView.moreLoading ? `<span role="status">${TagcastI18n.html("common.loading")}</span>`
        : browseView.moreError ? `<span role="alert">${escapeHtml(TagcastI18n.errorText(browseView.moreError))}</span>` : ""});
    updateFavouriteControls(); updateRandomControls();
    if (typeof syncHistory === "function") syncHistory();
    return;
  }
  list.className = detail ? "album-grid" : uploads ? "upload-group-list" : "artists-grid";
  list.innerHTML = state.loading || browseView.loading ? `<div class="empty" role="status"><span class="spinner"></span>${TagcastI18n.html("browse.list.loading")}</div>`
    : browseView.error ? `<p class="error-box" role="alert">${escapeHtml(TagcastI18n.errorText(browseView.error))}</p>`
    : !rows.length ? `<div class="empty">${TagcastI18n.html("browse.list.empty")}</div>`
    : detail ? rows.map(browseAlbumCard).join("") : rows.map(browseCard).join("");
  const max = Math.max(0, Math.ceil(browseView.total / browseView.pageSize) - 1);
  $("#browse-pagination").innerHTML = !surprise && !state.loading && !browseView.loading && max > 0 ? `<button class="button small" data-browse-page="-1" ${browseView.page === 0 ? "disabled" : ""}>${TagcastI18n.html("common.pagination.previous")}</button><span>${TagcastI18n.html("common.pagination.pageCounted", {page: browseView.page + 1, pages: max + 1})}</span><button class="button small" data-browse-page="1" ${browseView.page === max ? "disabled" : ""}>${TagcastI18n.html("common.pagination.next")}</button>` : "";
  updateFavouriteControls();
  updateRandomControls();
  if (typeof syncHistory === "function") syncHistory();
}

function showBrowse(kind, key = null, saved = {}) {
  if (!browseKinds[kind]) return;
  clearTimeout(browseTimer);
  const uploads = ["upload-folders", "uploaded"].includes(kind);
  if (!saved.sort && typeof rememberedBrowseSort === "function") saved = {...saved, sort: rememberedBrowseSort(browseGroupSortKey(kind, key !== null), key === null ? ["az", "za", "count"] : Object.keys(SORTS), "")};
  Object.assign(browseView, {kind, key, label: saved.label || "", query: kind === "decades" && key === null ? "" : saved.query || "", page: saved.page || 0,
    sort: kind === "decades" && key === null ? "za" : (uploads && key !== null ? ({album:"artist",az:"title",za:"title_za"}[saved.sort] || saved.sort) : saved.sort) || (key !== null ? "artist" : ["years","uploaded"].includes(kind) ? "za" : "az"), rows: [], albumIds: new Set(), details: null, loaded: false, randomIds: Array.isArray(saved.randomIds) ? saved.randomIds.filter(id => typeof id === "string") : []});
  browseContinuous().restore(saved.continuousCount);
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
  const continuous = event.target.value === "continuous", size = Number(event.target.value);
  if (!continuous && ![24, 50, 100, 200].includes(size)) return;
  browseView.request += 1; browseView.moreLoading = false; browseView.moreError = null;
  browseContinuous().setEnabled(continuous);
  if (continuous) { browseView.page = 0; refreshBrowseList(); scrollListingStart("#browse-page"); return; }
  browseView.page = Math.floor(browseView.page * browseView.pageSize / size); browseView.pageSize = size;
  rememberPageSize("tagcast-browse-per-page", size); refreshBrowseList();
});
document.addEventListener("click", event => {
  const kind = event.target.closest("[data-browse-kind]");
  if (kind) { showBrowse(kind.dataset.browseKind, kind.dataset.browseKey ?? null, {label: kind.dataset.browseLabel}); return; }
  const group = event.target.closest("[data-browse-key]");
  if (group) { showBrowse(browseView.kind, group.dataset.browseKey, {label: group.dataset.browseLabel}); return; }
  const page = event.target.closest("[data-browse-page]");
  if (page && !browseView.loading) { browseView.page = Math.max(0, browseView.page + Number(page.dataset.browsePage)); refreshBrowseList(); scrollListingStart("#browse-page"); }
});

// A language change repaints the visible overview or group from memory. A page that is still
// waiting for its first or a newer library read is left to that read.
TagcastI18n.subscribe(() => {
  if (state.screen !== "browse") return;
  if (state.loading || browseView.loading || browseView.details === state.details && (browseView.loaded || browseView.error)) renderBrowse();
});
