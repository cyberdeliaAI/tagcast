"use strict";

// Online sources: year, genre and cover suggestions side by side, like a tag editor's
// "tag sources". A suggestion only fills the form; saving still goes through the review.

const lookup = {sources: [], auto: true, recordPlays: false, streamQuality: "128", queueSync: false, settingsRevision: 0, keysFromEnv: [], results: new Map(), tokens: {}, album: null};
const sourceLabel = name => lookup.sources.find(s => s.name === name)?.label || name;

function applyLookupSources(sources) {
  const choices = rows => JSON.stringify(rows.map(s => [s.name, s.enabled, s.selected]));
  const changed = lookup.sources.length && choices(lookup.sources) !== choices(sources);
  const lyricsChanged = lookup.sources.length && lookup.sources.find(s => s.name === "lrclib")?.enabled !== sources.find(s => s.name === "lrclib")?.enabled;
  lookup.sources = sources;
  if (lyricsChanged && typeof invalidateLyricsSource === "function") invalidateLyricsSource();
  if (!changed) return;
  // Do not let answers started before a settings change repopulate either chooser.
  for (const channel of Object.keys(lookup.tokens)) lookup.tokens[channel] += 1;
  lookup.results = new Map();
  const box = $("#lookup-results");
  if (box) box.innerHTML = `<p class="muted">${TagcastI18n.html("lookup.results.sourcesChanged")}</p>`;
}

async function loadSettings() {
  const revision = lookup.settingsRevision;
  const languageVersion = typeof interfaceLanguageVersion === "function" ? interfaceLanguageVersion() : 0;
  try {
    const data = await api("/api/settings");
    if (typeof applyServerLanguage === "function") applyServerLanguage(data, languageVersion);
    if (revision !== lookup.settingsRevision) return;
    applyLookupSources(data.sources); lookup.auto = data.auto_lookup; lookup.keysFromEnv = data.keys_from_env || [];
    lookup.recordPlays = data.record_plays === true;
    lookup.albumGuideEnabled = data.album_guide === true;
    if (typeof applyAlbumGuideSettings === "function") applyAlbumGuideSettings(data);
    if (typeof applyArtistSettings === "function") applyArtistSettings(data);
    if (typeof applyAlbumInformationSettings === "function") applyAlbumInformationSettings(data);
    if (typeof applyMusicUploadSettings === "function") applyMusicUploadSettings(data);
    if (typeof applyPlaybackSettings === "function") applyPlaybackSettings(data);
    applyUpdateSettings(data);
    if (typeof settingsView !== "undefined" && state.screen === "settings" && !settingsView.dirty && !settingsView.saving) renderSettingsContent();
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
  const artist = `name="artist" aria-label="${TagcastI18n.html("lookup.panel.artistLabel")}" placeholder="${TagcastI18n.html("lookup.panel.artistPlaceholder")}"`;
  const title = `name="album" aria-label="${TagcastI18n.html("lookup.panel.albumLabel")}" placeholder="${TagcastI18n.html("lookup.panel.albumPlaceholder")}"`;
  return `<aside class="sources lookup"><div class="eyebrow">${TagcastI18n.html("lookup.panel.eyebrow")}</div><h3>${TagcastI18n.html("lookup.panel.heading")}</h3>
    <form id="lookup-form" class="lookup-form">${clearableSearchInput("lookup-artist-search", artist, album.artist)}${clearableSearchInput("lookup-album-search", title, album.name)}<button class="button small">${TagcastI18n.html("lookup.panel.search")}</button></form>
    <p class="muted lookup-hint">${TagcastI18n.html("lookup.panel.hint")}</p>
    <div id="lookup-results"></div>
    <p class="lookup-links">${TagcastI18n.html("lookup.panel.websites", {links: TagcastI18n.trusted(websiteLinks(album.artist, album.name))})}</p>
    <p class="lookup-links"><button class="text-action" data-open-settings>${TagcastI18n.html("lookup.panel.settings")}</button></p></aside>`;
}

function startLookups(album) {
  lookup.album = album; lookup.results = new Map(); lookup.tokens.album = (lookup.tokens.album || 0) + 1;
  const box = $("#lookup-results");
  if (!box) return;
  if (!lookup.sources.length) { box.innerHTML = `<p class="muted">${TagcastI18n.html("lookup.results.needsServer", {command: TagcastI18n.trusted("<code>tagcast</code>")})}</p>`; return; }
  if (lookup.auto) runLookups(album.artist, album.name);
  else box.innerHTML = `<p class="muted">${TagcastI18n.html("lookup.results.pressSearch")}</p>`;
}

// Ask every enabled source; onResult(source, candidates|null, error) fires as each one answers.
// A newer search on the same channel makes older answers be ignored.
function fetchSuggestions(kind, params, onResult, channel = "album") {
  const token = lookup.tokens[channel] = (lookup.tokens[channel] || 0) + 1;
  const sources = lookup.sources.filter(s => s.enabled && (kind === "album" ? s.albums : s.artists));
  for (const source of sources) {
    api(`/api/lookup/${kind}?${new URLSearchParams({source: source.name, ...params})}`)
      .then(data => { if (token === lookup.tokens[channel]) onResult(source, data.candidates, ""); })
      .catch(error => { if (token === lookup.tokens[channel]) onResult(source, null, TagcastI18n.errorText(error)); });
  }
  return sources;
}

function runLookups(artist, album) {
  const box = $("#lookup-results");
  lookup.results = new Map();
  const missing = lookup.sources.filter(s => s.albums && s.selected !== false && !s.enabled);
  const sources = fetchSuggestions("album", {artist, album}, (source, candidates, error) => {
    if (candidates) lookup.results.set(source.name, candidates);
    renderSource(source, candidates, error);
  });
  box.innerHTML = sources.map(s => `<section class="lookup-source" data-source="${s.name}"><h4>${escapeHtml(s.label)}<span class="lookup-state"><span class="spinner"></span></span></h4><div class="lookup-items"></div></section>`).join("")
    + (missing.length ? `<p class="muted lookup-missing">${TagcastI18n.html("lookup.results.needsKey", {count: missing.length, sources: missing.map(s => s.label).join(", ")})} <button class="text-action" data-open-settings>${TagcastI18n.html("lookup.results.addKeys")}</button></p>` : "")
    + (!sources.length && !missing.length ? `<p class="muted">${TagcastI18n.html("lookup.results.off")} <button class="text-action" data-open-settings>${TagcastI18n.html("lookup.results.chooseSources")}</button></p>` : "");
}

function renderSource(source, candidates, error) {
  const section = document.querySelector(`.lookup-source[data-source="${source.name}"]`);
  if (!section) return;
  const state = section.querySelector(".lookup-state");
  if (error) { state.textContent = error; state.classList.add("error"); return; }
  state.textContent = candidates.length ? "" : TagcastI18n.text("lookup.results.noMatch");
  section.classList.toggle("empty", !candidates.length);
  section.querySelector(".lookup-items").innerHTML = candidates.slice(0, 3).map((c, i) => suggestionCard(source.name, c, i)).join("");
}

function suggestionCard(source, c, index) {
  const score = Math.round(c.score * 100);
  const art = c.thumb && c.cover ? `<button class="suggestion-art" data-use-cover="${source}:${index}" title="${TagcastI18n.html("lookup.suggestion.useCoverTitle")}"><img src="${escapeHtml(c.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-error="suggestion"><span>${TagcastI18n.html("lookup.suggestion.useCover")}</span></button>` : "";
  const year = c.year ? `<div class="suggestion-year"><button class="chip year" data-use-year="${c.year}" title="${TagcastI18n.html("lookup.suggestion.useYear", {year: c.year})}">${c.year}</button><span>${escapeHtml(c.note || "")}</span></div>` : "";
  const genres = c.genres.length ? `<div class="chips">${c.genres.map(g => `<button class="chip" data-use-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("")}${c.genres.length > 1 ? `<button class="chip use-all" data-use-genres="${escapeHtml(JSON.stringify(c.genres))}" title="${TagcastI18n.html("lookup.suggestion.useAllTitle")}">${TagcastI18n.html("lookup.suggestion.useAll")}</button>` : ""}</div>` : "";
  const title = c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title)}</a>` : escapeHtml(c.title);
  return `<article class="suggestion">${art}<div class="suggestion-body"><div class="suggestion-title">${title}<span class="score ${score < 75 ? "low" : ""}" title="${TagcastI18n.html("lookup.suggestion.score")}">${score}%</span></div><div class="suggestion-artist">${escapeHtml(c.artist)}</div>${year}${genres}</div></article>`;
}

function setFormField(name, value) {
  const input = $("#metadata-form")?.elements.namedItem(name);
  if (!input || !editing) return;
  if (name === "year") {
    try { readYear(value); } catch (error) { toast(TagcastI18n.errorText(error)); return; }
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
    if (lookup.sources.some(s => s.name === source && !s.enabled)) continue;
    for (const c of candidates) if (c.cover && c.score >= 0.75) out.push({url: c.cover, thumb: c.thumb || c.cover, source: sourceLabel(source), title: c.title, score: c.score});
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---- settings ------------------------------------------------------------------

// The whole Settings content, built from the loaded settings and browser preferences.
function settingsContentMarkup() {
  const keyed = lookup.sources.filter(s => s.key);
  const freeAccount = live() && state.connection.premium === false;
  const immediate = `<span class="settings-mode">${TagcastI18n.html("settings.mode.immediate")}</span>`;
  const saveRequired = `<span class="settings-mode">${TagcastI18n.html("settings.mode.saveRequired")}</span>`;
  return `${typeof languageSettingsSection === "function" ? languageSettingsSection() : ""}<section class="interface-settings" data-settings-category="interface"><h3>${TagcastI18n.html("settings.notice.heading")} ${immediate}</h3>
    <p class="muted" data-notice-description>${TagcastI18n.html(libraryNotice.visible ? "settings.notice.visible" : "settings.notice.hidden")}</p>
    <button type="button" class="button small" data-show-notice ${libraryNotice.visible ? "disabled" : ""}>${TagcastI18n.html("settings.notice.show")}</button>
    </section><section class="metadata-editing-settings" data-settings-category="interface"><h3>${TagcastI18n.html("settings.editing.heading")} ${immediate}</h3>
    <label class="checkline"><input type="checkbox" id="apply-track-year-default" ${metadataEditingDefaults.applyYearToTracks ? "checked" : ""}> ${TagcastI18n.html("settings.editing.trackYear")}</label>
    <p class="muted">${TagcastI18n.html("settings.editing.trackYearNote")}</p>
    <p class="muted">${TagcastI18n.html("settings.editing.trackYearScope")}</p>
    </section><section class="player-display-settings" data-settings-category="playback"><h3>${TagcastI18n.html("settings.display.heading")} ${immediate}</h3>
    <label class="checkline"><input type="checkbox" data-player-display="quality" ${playerDisplay.quality ? "checked" : ""}> ${TagcastI18n.html("settings.display.quality")}</label>
    <label class="checkline"><input type="checkbox" data-player-display="track-artists" ${playerDisplay.trackArtists ? "checked" : ""}> ${TagcastI18n.html("settings.display.trackArtists")}</label>
    <p class="muted">${TagcastI18n.html("settings.display.note")}</p>
    <label>${TagcastI18n.html("settings.display.view")} <select id="player-view-mode"><option value="fullscreen" ${visualPlayerMode === "fullscreen" ? "selected" : ""}>${TagcastI18n.html("settings.display.fullscreen")}</option><option value="window" ${visualPlayerMode === "window" ? "selected" : ""}>${TagcastI18n.html("settings.display.window")}</option></select></label>
    <p class="muted">${TagcastI18n.html("settings.display.viewNote")}</p>
    ${typeof visualDiscSettings === "function" ? visualDiscSettings() : ""}</section>`
    + (typeof playbackLyricsSettings === "function" ? playbackLyricsSettings() : "")
    + (typeof visualizerSettings === "function" ? visualizerSettings() : "")
    + (typeof gaplessSettings === "function" ? gaplessSettings() : "")
    + themeEditorPanel()
    + sidebarSettingsPanel()
    + metadataExportPanel()
    + `<section class="history-settings" data-settings-category="data"><h3>${TagcastI18n.html("settings.history.heading")}</h3>
    <p class="muted">${TagcastI18n.html("settings.history.note")}</p>
    <button type="button" class="button small" id="export-button" ${state.history.length ? "" : "disabled"}>${TagcastI18n.html("settings.history.export")}</button></section>`
    + `<section class="history-settings" data-settings-category="about"><h3>${TagcastI18n.html("settings.community.heading")}</h3>
    <p class="muted">${TagcastI18n.html("settings.community.note")}</p>
    <a class="button small" href="https://tagcast.app/" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("settings.community.website")}</a>
    <a class="button small" href="https://www.reddit.com/r/Tagcast/" target="_blank" rel="noopener noreferrer">${TagcastI18n.html("settings.community.reddit")}</a></section>`
    + (!lookup.sources.length ? `<p class="muted settings-server-note">${TagcastI18n.html("settings.serverNote")}</p>` : `
    <form id="settings-form"><section class="playback-settings" data-settings-category="playback"><h3>${TagcastI18n.html("settings.streaming.heading")} ${saveRequired}</h3>
    ${freeAccount ? `<p>${TagcastI18n.html("settings.streaming.freeQuality")}</p><p class="muted">${TagcastI18n.html("settings.streaming.freeNote")}</p>` : `<label>${TagcastI18n.html("settings.streaming.quality")} <select name="stream_quality">${["96", "128", "192", "256", "320", "orig"].map(q => `<option value="${q}" ${q === lookup.streamQuality ? "selected" : ""}>${q === "orig" ? TagcastI18n.html("settings.streaming.original") : TagcastI18n.html(q === "128" ? "settings.streaming.mp3" : "settings.streaming.mp3Premium", {quality: q})}</option>`).join("")}</select></label>
    <p class="muted">${TagcastI18n.html("settings.streaming.note")}</p>`}
    <label class="checkline"><input type="checkbox" name="record_plays" ${lookup.recordPlays ? "checked" : ""}> ${TagcastI18n.html("settings.streaming.recordPlays")}</label>
    <p class="muted">${TagcastI18n.html("settings.streaming.recordNote")}</p>
    <p class="muted">${TagcastI18n.html("settings.streaming.recentNote")}${playReporting.error ? ` <span class="error-text">${escapeHtml(playReporting.error)}</span>` : ""}</p></section>
    <section class="playback-settings" data-settings-category="playback"><h3>${TagcastI18n.html("settings.devices.heading")} ${saveRequired}</h3>
    <label class="checkline"><input type="checkbox" name="queue_sync" ${lookup.queueSync ? "checked" : ""}> ${TagcastI18n.html("settings.devices.enable")}</label>
    <p class="muted">${TagcastI18n.html("settings.devices.note")}</p>
    <button type="button" class="button small" data-queue-reconnect>${TagcastI18n.html("settings.devices.reconnect")}</button></section>
    <section class="playback-settings" data-settings-category="discovery"><h3>1001 Albums ${saveRequired}</h3>
    <label class="checkline"><input type="checkbox" name="album_guide" ${albumGuide.enabled ? "checked" : ""}> ${TagcastI18n.html("settings.guide.enable")}</label>
    <p class="muted">${TagcastI18n.html("settings.guide.note")}</p>
    <button type="button" class="button small" data-guide-open ${albumGuide.enabled ? "" : "disabled"}>${TagcastI18n.html("settings.guide.open")}</button></section>
    <section class="artist-biography-settings" data-settings-category="discovery"><h3>${TagcastI18n.html("settings.biographies.heading")}</h3>
    <label class="checkline"><input type="checkbox" name="artist_biographies" ${artistProfile.enabled ? "checked" : ""}> ${TagcastI18n.html("settings.biographies.enable")}</label>
    <p class="muted">${TagcastI18n.html("settings.biographies.note")}</p></section>
    <section class="album-information-settings" data-settings-category="discovery"><h3>${TagcastI18n.html("settings.albumInfo.heading")}</h3>
    <label class="checkline"><input type="checkbox" name="album_information" ${albumInformation.enabled ? "checked" : ""}> ${TagcastI18n.html("settings.albumInfo.enable")}</label>
    <p class="muted">${TagcastI18n.html("settings.albumInfo.note")}</p></section>
    <section class="source-settings" data-settings-category="sources"><h3>${TagcastI18n.html("settings.sources.heading")} ${saveRequired}</h3>
    <p class="muted">${TagcastI18n.html("settings.sources.note")}</p>
    ${lookup.sources.map(s => `<label class="checkline"><input type="checkbox" data-source-toggle="${escapeHtml(s.name)}" ${s.selected !== false ? "checked" : ""}> ${escapeHtml(s.label)}${!(s.available ?? s.enabled) ? ` <span class="muted">· ${TagcastI18n.html("settings.sources.needsKey")}</span>` : ""}</label>`).join("")}
    <p class="muted">${TagcastI18n.html("settings.sources.otherNote")}</p>
    <p class="muted">${TagcastI18n.html("settings.sources.keyless", {sources: lookup.sources.filter(s => !s.key).map(s => s.label).join(", ")})}</p>
    ${keyed.map(s => {
      const env = lookup.keysFromEnv.includes(s.key);
      const available = s.available ?? s.enabled;
      return `<div class="setting-row"><div><strong>${escapeHtml(s.label)}</strong> <span class="status ${available ? "saved" : "not_sent"}">${TagcastI18n.html(available ? "settings.sources.keyReady" : "settings.sources.needsKey")}</span><small>${escapeHtml(s.key_help)}</small></div>${env ? `<span class="muted">${TagcastI18n.html("settings.sources.fromEnvironment")}</span>` : `<input type="password" name="${s.key}" autocomplete="off" spellcheck="false" placeholder="${TagcastI18n.html(available ? "settings.sources.keySaved" : "settings.sources.keyPaste")}" aria-label="${TagcastI18n.html("settings.sources.keyLabel", {source: s.label})}">${available ? `<button type="button" class="text-action" data-clear-key="${s.key}">${TagcastI18n.html("common.remove")}</button>` : ""}`}</div>`;
    }).join("")}
    <label class="checkline"><input type="checkbox" name="auto_lookup" ${lookup.auto ? "checked" : ""}> ${TagcastI18n.html("settings.sources.autoLookup")}</label>
    <p class="muted">${TagcastI18n.html("settings.sources.autoLookupNote")}</p>
    </section>
    ${typeof musicUploadsSettingsPanel === "function" ? musicUploadsSettingsPanel() : ""}
    ${updateSettingsPanel()}
    <div class="settings-save-bar" id="settings-save-bar"><p id="settings-save-hint">${TagcastI18n.html("settings.save.hint")}</p><div><button type="button" class="button" data-settings-discard>${TagcastI18n.html("settings.save.discard")}</button><button class="button primary" id="settings-save">${TagcastI18n.html("settings.save.button")}</button></div></div></form>`);
}

function renderSettingsContent() {
  $("#settings-content").innerHTML = settingsContentMarkup();
  settingsView.rendered = true; settingsView.stale = false;
  settingsView.baseline = settingsFormSnapshot();
  updateSettingsPage();
  resumeMetadataExport();
}

async function saveSettings(form, clear) {
  if (settingsView.saving) return;
  const settingsFocus = document.activeElement;
  settingsView.saving = true;
  updateSettingsSaveState();
  const body = {auto_lookup: form.elements.auto_lookup.checked, auto_updates: form.elements.auto_updates.checked};
  const sources = [...form.querySelectorAll("[data-source-toggle]")];
  if (sources.length) body.disabled_sources = sources.filter(input => !input.checked).map(input => input.dataset.sourceToggle);
  if (form.elements.stream_quality) body.stream_quality = form.elements.stream_quality.value;
  if (form.elements.music_uploads) body.music_uploads = form.elements.music_uploads.checked;
  if (form.elements.queue_sync) body.queue_sync = form.elements.queue_sync.checked;
  if (form.elements.record_plays) body.record_plays = form.elements.record_plays.checked;
  if (form.elements.album_guide) body.album_guide = form.elements.album_guide.checked;
  if (form.elements.artist_biographies) body.artist_biographies = form.elements.artist_biographies.checked;
  if (form.elements.album_information) body.album_information = form.elements.album_information.checked;
  for (const input of form.querySelectorAll("input[type=password]")) if (input.value.trim()) body[input.name] = input.value.trim();
  if (clear) body[clear] = "";
  const locked = [...form.querySelectorAll("input, select, button[data-clear-key]")].map(input => [input, input.disabled]);
  for (const [input] of locked) input.disabled = true;
  try {
    const data = await api("/api/settings", body);
    lookup.settingsRevision += 1;
    applyLookupSources(data.sources); lookup.auto = data.auto_lookup;
    lookup.recordPlays = data.record_plays === true;
    applyAlbumGuideSettings(data);
    applyArtistSettings(data);
    applyAlbumInformationSettings(data);
    applyPlaybackSettings(data);
    if (typeof applyMusicUploadSettings === "function") applyMusicUploadSettings(data);
    const wasAutomatic = updateNotice.automatic;
    applyUpdateSettings(data); renderUpdateNotice();
    if (!wasAutomatic && updateNotice.automatic) checkForUpdates();
    renderSettingsContent();
    setSettingsFeedback(() => TagcastI18n.text(clear ? "settings.save.keyRemoved" : "settings.save.saved"));
    toast(TagcastI18n.text("settings.save.saved"));
  } catch (error) { setSettingsFeedback(() => TagcastI18n.errorText(error)); toast(TagcastI18n.errorText(error)); }
  finally { for (const [input, disabled] of locked) input.disabled = disabled; settingsView.saving = false; updateSettingsSaveState();
    if (state.screen === "settings" && settingsFocus?.closest?.("#settings-form") && (document.activeElement === settingsFocus || document.activeElement === document.body)) {
      const focus = $("#settings-save-bar").hidden ? $("#settings-category-title") : $("#settings-save");
      focus.focus({preventScroll: true});
    }
  }
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-show-notice]")) { setLibraryNotice(true); event.target.disabled = true; const description = document.querySelector("[data-notice-description]"); if (description) description.textContent = TagcastI18n.text("settings.notice.visible"); return; }
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
  if (event.target.closest("[data-open-settings]") || event.target.closest("#settings-button")) { openSettings(event.target.closest("[data-open-settings]") ? "sources" : undefined); return; }
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
// Settings handlers use state initialized by the later deferred feature scripts.
document.addEventListener("DOMContentLoaded", loadSettings, {once: true});
