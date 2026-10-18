"use strict";

// Online sources: year, genre and cover suggestions side by side, like a tag editor's
// "tag sources". A suggestion only fills the form; saving still goes through the review.

const lookup = {sources: [], auto: true, recordPlays: false, streamQuality: "128", queueSync: false, settingsRevision: 0, keysFromEnv: [], results: new Map(), tokens: {}, album: null};
const sourceLabel = name => lookup.sources.find(s => s.name === name)?.label || name;

async function loadSettings() {
  const revision = lookup.settingsRevision;
  try {
    const data = await api("/api/settings");
    if (revision !== lookup.settingsRevision) return;
    lookup.sources = data.sources; lookup.auto = data.auto_lookup; lookup.keysFromEnv = data.keys_from_env || [];
    lookup.recordPlays = data.record_plays === true;
    lookup.albumGuideEnabled = data.album_guide === true;
    if (typeof applyAlbumGuideSettings === "function") applyAlbumGuideSettings(data);
    if (typeof applyArtistSettings === "function") applyArtistSettings(data);
    if (typeof applyAlbumInformationSettings === "function") applyAlbumInformationSettings(data);
    if (typeof applyPlaybackSettings === "function") applyPlaybackSettings(data);
    applyUpdateSettings(data);
  } catch { /* opened without the Python server: no online sources */ }
}

function websiteLinks(artist, album) {
  const q = encodeURIComponent(`${artist} ${album}`);
  return [
    ["MusicBrainz", `https://musicbrainz.org/search?query=${q}&type=release_group&method=indexed`],
    ["Discogs", `https://www.discogs.com/search/?q=${q}&type=master`],
    ["Last.fm", `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`],
  ].map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`).join(" · ");
}

function lookupPanel(album) {
  return `<aside class="sources lookup"><div class="eyebrow">ONLINE SOURCES</div><h3>Suggestions</h3>
    <form id="lookup-form" class="lookup-form"><input name="artist" value="${escapeHtml(album.artist)}" aria-label="Artist to search for" placeholder="Artist"><input name="album" value="${escapeHtml(album.name)}" aria-label="Album to search for" placeholder="Album"><button class="button small">Search</button></form>
    <p class="muted lookup-hint">Click a year or genre to put it in the form; Shift-click a genre to add it to the others. Nothing is saved until you review.</p>
    <div id="lookup-results"></div>
    <p class="lookup-links">Websites: ${websiteLinks(album.artist, album.name)}</p>
    <p class="lookup-links"><button class="text-action" data-open-settings>Settings ⚙</button></p></aside>`;
}

function startLookups(album) {
  lookup.album = album; lookup.results = new Map(); lookup.tokens.album = (lookup.tokens.album || 0) + 1;
  const box = $("#lookup-results");
  if (!box) return;
  if (!lookup.sources.length) { box.innerHTML = '<p class="muted">Online sources need the Tagcast server. Start it with <code>tagcast</code>.</p>'; return; }
  if (lookup.auto) runLookups(album.artist, album.name);
  else box.innerHTML = '<p class="muted">Press Search to look this album up.</p>';
}

// Ask every enabled source; onResult(source, candidates|null, error) fires as each one answers.
// A newer search on the same channel makes older answers be ignored.
function fetchSuggestions(kind, params, onResult, channel = "album") {
  const token = lookup.tokens[channel] = (lookup.tokens[channel] || 0) + 1;
  const sources = lookup.sources.filter(s => s.enabled && (kind === "album" ? s.albums : s.artists));
  for (const source of sources) {
    api(`/api/lookup/${kind}?${new URLSearchParams({source: source.name, ...params})}`)
      .then(data => { if (token === lookup.tokens[channel]) onResult(source, data.candidates, ""); })
      .catch(error => { if (token === lookup.tokens[channel]) onResult(source, null, error.message); });
  }
  return sources;
}

function runLookups(artist, album) {
  const box = $("#lookup-results");
  lookup.results = new Map();
  const missing = lookup.sources.filter(s => s.albums && !s.enabled);
  const sources = fetchSuggestions("album", {artist, album}, (source, candidates, error) => {
    if (candidates) lookup.results.set(source.name, candidates);
    renderSource(source, candidates, error);
  });
  box.innerHTML = sources.map(s => `<section class="lookup-source" data-source="${s.name}"><h4>${escapeHtml(s.label)}<span class="lookup-state"><span class="spinner"></span></span></h4><div class="lookup-items"></div></section>`).join("")
    + (missing.length ? `<p class="muted lookup-missing">${missing.map(s => escapeHtml(s.label)).join(", ")} ${missing.length === 1 ? "needs" : "need"} a key. <button class="text-action" data-open-settings>Add keys</button></p>` : "");
}

function renderSource(source, candidates, error) {
  const section = document.querySelector(`.lookup-source[data-source="${source.name}"]`);
  if (!section) return;
  const state = section.querySelector(".lookup-state");
  if (error) { state.textContent = error; state.classList.add("error"); return; }
  state.textContent = candidates.length ? "" : "No match";
  section.classList.toggle("empty", !candidates.length);
  section.querySelector(".lookup-items").innerHTML = candidates.slice(0, 3).map((c, i) => suggestionCard(source.name, c, i)).join("");
}

function suggestionCard(source, c, index) {
  const score = Math.round(c.score * 100);
  const art = c.thumb && c.cover ? `<button class="suggestion-art" data-use-cover="${source}:${index}" title="Use this cover"><img src="${escapeHtml(c.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.suggestion-art').remove()"><span>Use cover</span></button>` : "";
  const year = c.year ? `<div class="suggestion-year"><button class="chip year" data-use-year="${c.year}" title="Use ${c.year} as the release year">${c.year}</button><span>${escapeHtml(c.note || "")}</span></div>` : "";
  const genres = c.genres.length ? `<div class="chips">${c.genres.map(g => `<button class="chip" data-use-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("")}${c.genres.length > 1 ? `<button class="chip use-all" data-use-genres="${escapeHtml(JSON.stringify(c.genres))}" title="Use these genres, the first as the main genre">Use all</button>` : ""}</div>` : "";
  const title = c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title)}</a>` : escapeHtml(c.title);
  return `<article class="suggestion">${art}<div class="suggestion-body"><div class="suggestion-title">${title}<span class="score ${score < 75 ? "low" : ""}" title="How well the title and artist match">${score}%</span></div><div class="suggestion-artist">${escapeHtml(c.artist)}</div>${year}${genres}</div></article>`;
}

function setFormField(name, value) {
  const input = $("#metadata-form")?.elements.namedItem(name);
  if (!input || !editing) return;
  if (name === "year") {
    try { readYear(value); } catch (error) { toast(error.message); return; }
  }
  const previous = input.value;
  if (input.disabled) { const box = document.querySelector(`[data-enable="${name}"]`); if (box) box.checked = true; input.disabled = false; }
  input.value = value; editing.dirty.add(name);
  if (name === "year") validateYearInput(input);
  if (name === "artist") {
    const various = $("#album-various-artists");
    if (various) {
      various.checked = value === "Various Artists"; various.indeterminate = false;
      if (various.checked) input.value = previous;
    }
    syncAlbumArtistControls();
  }
  input.classList.remove("filled"); void input.offsetWidth; input.classList.add("filled");
}

// Covers from the album's suggestions: good matches only, best first.
function coverChoices() {
  const out = [];
  for (const [source, candidates] of lookup.results) {
    for (const c of candidates) if (c.cover && c.score >= 0.75) out.push({url: c.cover, thumb: c.thumb || c.cover, source: sourceLabel(source), title: c.title, score: c.score});
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---- settings ------------------------------------------------------------------

function openSettings() {
  const keyed = lookup.sources.filter(s => s.key);
  $("#settings-content").innerHTML = `<section class="interface-settings"><h3>Interface</h3>
    <p class="muted">The library information banner is ${libraryNotice.visible ? "visible" : "hidden"}. This choice is remembered in this browser.</p>
    <button type="button" class="button small" data-show-notice ${libraryNotice.visible ? "disabled" : ""}>Show library information banner</button>
    <label class="checkline"><input type="checkbox" data-player-display="quality" ${playerDisplay.quality ? "checked" : ""}> Show file format and stream quality in the compact player</label>
    <label class="checkline"><input type="checkbox" data-player-display="track-artists" ${playerDisplay.trackArtists ? "checked" : ""}> Show track artists in the compact player</label>
    <p class="muted">These choices apply immediately and are remembered in this browser. Track and album pages and fullscreen Now playing keep their information.</p></section>`
    + sidebarSettingsPanel()
    + `<section class="history-settings"><h3>Change history</h3>
    <p class="muted">Download the change history saved in this browser as a JSON file for your records.</p>
    <button type="button" class="button small" id="export-button" ${state.history.length ? "" : "disabled"}>Export changes ↓</button></section>`
    + (!lookup.sources.length ? '<p class="muted">Playback and source settings need the Tagcast server.</p>' : `
    <form id="settings-form"><section class="playback-settings"><h3>Playback</h3>
    <label>Streaming quality <select name="stream_quality">${["96", "128", "192", "256", "320", "orig"].map(q => `<option value="${q}" ${q === lookup.streamQuality ? "selected" : ""}>${q === "orig" ? "Original file (Premium)" : `MP3 ${q} kbps${q === "128" ? "" : " (Premium)"}`}</option>`).join("")}</select></label>
    <p class="muted">Applies to the next track. File format (FLAC/MP3) is separate from streaming quality. Free accounts use 128 kbps. All other choices, including 96 kbps and Original, require Premium. Unsupported Original audio falls back to MP3 128 kbps.</p>
    <label class="checkline"><input type="checkbox" name="record_plays" ${lookup.recordPlays ? "checked" : ""}> Record played tracks in iBroadcast</label>
    <p class="muted">Off by default. When enabled, Tagcast sends a track ID and timestamp after more than ten seconds of actual playback. Pausing and seeking do not count. Earlier plays and skips are not sent.</p>
    <p class="muted">Enabling also shows Recently played, using iBroadcast’s recent tracks playlist. Plays are separate from Change history. An uncertain request is not retried automatically.${playReporting.error ? ` <span class="error-text">${escapeHtml(playReporting.error)}</span>` : ""}</p></section>
    <section class="playback-settings"><h3>Devices &amp; queue synchronisation</h3>
    <label class="checkline"><input type="checkbox" name="queue_sync" ${lookup.queueSync ? "checked" : ""}> Enable queue synchronisation and remote control</label>
    <p class="muted">Off by default. Uses iBroadcast’s queue server. After enabling, reconnect iBroadcast once to approve queue read/write permissions, then open Devices. Only the player records plays; remote controllers do not play audio.</p>
    <button type="button" class="button small" data-queue-reconnect>Reconnect iBroadcast</button></section>
    <section class="playback-settings"><h3>Discovery</h3>
    <label class="checkline"><input type="checkbox" name="album_guide" ${albumGuide.enabled ? "checked" : ""}> Enable 1001 Albums</label>
    <p class="muted">Off by default. Save to show 1001 Albums in the sidebar, then start an analysis when you choose. Compares the supplied 1955–2007 selection with your loaded album metadata locally. Results are saved on this computer; your iBroadcast library is unchanged.</p>
    <button type="button" class="button small" data-guide-open ${albumGuide.enabled ? "" : "disabled"}>Open 1001 Albums</button></section>
    <section class="artist-biography-settings"><h3>Artist biographies</h3>
    <label class="checkline"><input type="checkbox" name="artist_biographies" ${artistProfile.enabled ? "checked" : ""}> Show artist biographies from TheAudioDB</label>
    <p class="muted">Off by default. When you visit an album artist, Tagcast sends that artist’s name to TheAudioDB if no current local biography is available. English text is stored separately on this computer for up to 30 days before checking again. No library scan, iBroadcast changes or Last.fm account are needed. Biographies may be unavailable or refer to another artist with the same name; check the source link.</p></section>
    <section class="album-information-settings"><h3>Album information</h3>
    <label class="checkline"><input type="checkbox" name="album_information" ${albumInformation.enabled ? "checked" : ""}> Show album information from TheAudioDB</label>
    <p class="muted">Off by default. When you visit an album, Tagcast sends its album artist and full title to TheAudioDB if no current local text is available. English text is saved on this computer and checked again after 30 days, when revisited. Only one exact artist/title match is used; information is not available for every album or edition. Existing 1001 Albums texts stay available separately.</p></section>
    <section class="source-settings"><h3>Online sources &amp; keys</h3>
    <p class="muted">These sources work without a key: ${lookup.sources.filter(s => !s.key).map(s => escapeHtml(s.label)).join(", ")}. Add a key to use the others. Keys are stored on this computer only, in the Tagcast settings folder.</p>
    ${keyed.map(s => {
      const env = lookup.keysFromEnv.includes(s.key);
      return `<div class="setting-row"><div><strong>${escapeHtml(s.label)}</strong> <span class="status ${s.enabled ? "saved" : "not_sent"}">${s.enabled ? "Ready" : "Needs a key"}</span><small>${escapeHtml(s.key_help)}</small></div>${env ? '<span class="muted">Set by an environment variable</span>' : `<input type="password" name="${s.key}" autocomplete="off" spellcheck="false" placeholder="${s.enabled ? "Saved · type to replace" : "Paste your key"}" aria-label="${escapeHtml(s.label)} key">${s.enabled ? `<button type="button" class="text-action" data-clear-key="${s.key}">Remove</button>` : ""}`}</div>`;
    }).join("")}
    <label class="checkline"><input type="checkbox" name="auto_lookup" ${lookup.auto ? "checked" : ""}> Look up an album in all sources as soon as you open it</label>
    <p class="muted">Looking up sends the artist and album name to each source. Tagcast waits between requests so it stays within each source's limits.</p>
    </section>
    ${updateSettingsPanel()}
    <div class="dialog-footer"><button type="button" class="button" data-close="settings">Cancel</button><button class="button primary">Save</button></div></form>`);
  $("#settings").showModal();
}

async function saveSettings(form, clear) {
  const body = {auto_lookup: form.elements.auto_lookup.checked, auto_updates: form.elements.auto_updates.checked};
  if (form.elements.stream_quality) body.stream_quality = form.elements.stream_quality.value;
  if (form.elements.queue_sync) body.queue_sync = form.elements.queue_sync.checked;
  if (form.elements.record_plays) body.record_plays = form.elements.record_plays.checked;
  if (form.elements.album_guide) body.album_guide = form.elements.album_guide.checked;
  if (form.elements.artist_biographies) body.artist_biographies = form.elements.artist_biographies.checked;
  if (form.elements.album_information) body.album_information = form.elements.album_information.checked;
  for (const input of form.querySelectorAll("input[type=password]")) if (input.value.trim()) body[input.name] = input.value.trim();
  if (clear) body[clear] = "";
  try {
    const data = await api("/api/settings", body);
    lookup.settingsRevision += 1;
    lookup.sources = data.sources; lookup.auto = data.auto_lookup;
    lookup.recordPlays = data.record_plays === true;
    applyAlbumGuideSettings(data);
    applyArtistSettings(data);
    applyAlbumInformationSettings(data);
    applyPlaybackSettings(data);
    const wasAutomatic = updateNotice.automatic;
    applyUpdateSettings(data); renderUpdateNotice();
    if (!wasAutomatic && updateNotice.automatic) checkForUpdates();
    if (clear) openSettings(); else { $("#settings").close(); toast("Settings saved."); }
  } catch (error) { toast(error.message); }
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-show-notice]")) { setLibraryNotice(true); openSettings(); return; }
  const year = event.target.closest("[data-use-year]");
  if (year) { setFormField("year", year.dataset.useYear); return; }
  const genre = event.target.closest("[data-use-genre]"), all = event.target.closest("[data-use-genres]");
  if (genre || all) {
    const field = document.querySelector('#metadata-form [data-genres="genres"]');
    if (!field || field.classList.contains("disabled")) return;
    const picked = all ? JSON.parse(all.dataset.useGenres) : [genre.dataset.useGenre];
    setGenres(field, event.shiftKey && genre ? addGenres(getGenres(field), picked[0]) : addGenres([], picked.join(";")));
    showTrackGenres();
    return;
  }
  const cover = event.target.closest("[data-use-cover]");
  if (cover) {
    const [source, index] = cover.dataset.useCover.split(":");
    const c = lookup.results.get(source)?.[Number(index)];
    if (c) openArtwork(albumArtTarget(), {url: c.cover, thumb: c.thumb || c.cover, source: sourceLabel(source), title: c.title});
    return;
  }
  if (event.target.closest("[data-open-settings]") || event.target.closest("#settings-button")) { openSettings(); return; }
  const clear = event.target.closest("[data-clear-key]");
  if (clear) saveSettings($("#settings-form"), clear.dataset.clearKey);
});
document.addEventListener("submit", event => {
  if (event.target.id === "lookup-form") {
    event.preventDefault();
    const form = event.target;
    runLookups(form.elements.artist.value.trim(), form.elements.album.value.trim());
  } else if (event.target.id === "settings-form") {
    event.preventDefault(); saveSettings(event.target);
  }
});
loadSettings();
