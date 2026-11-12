"use strict";

// Presentation only. Reuse the shared queue; details read loaded metadata, never providers.
const workspacePanel = {tab: "playlist", focus: null, markup: "", scope: state.details,
  session: state.connection.playback_session};
let navigationCollapsed = false;
try { navigationCollapsed = localStorage.getItem("tagcast-navigation-collapsed") === "true"; } catch { /* private window */ }

function syncNavigationToggle() {
  const desktop = globalThis.matchMedia?.("(min-width: 761px)").matches ?? true;
  const closed = desktop && navigationCollapsed;
  if (closed && $("#sidebar").contains?.(document.activeElement)) $("#navigation-toggle").focus({preventScroll: true});
  $("#sidebar").hidden = closed;
  document.body.classList.toggle("navigation-collapsed", closed);
  $("#navigation-toggle").setAttribute("aria-expanded", String(!closed));
  $("#navigation-toggle").setAttribute("aria-label", TagcastI18n.text(closed ? "nav.menu.open" : "nav.menu.close"));
}
$("#navigation-toggle").addEventListener("click", () => {
  navigationCollapsed = !navigationCollapsed;
  try { localStorage.setItem("tagcast-navigation-collapsed", String(navigationCollapsed)); } catch { /* private/full storage */ }
  syncNavigationToggle();
});
window.addEventListener("resize", syncNavigationToggle);

const workspaceSortGroups = {
  albums: [
    ["workspace.sort.artist", "artist", "artist_za", "↑", "↓"],
    ["workspace.sort.title", "title", "title_za", "↑", "↓"],
    ["workspace.sort.year", "newest", "year", "↓", "↑"],
    ["workspace.sort.added", "uploaded_newest", "uploaded_oldest", "↓", "↑"],
    ["workspace.sort.rating", "rating_high", "rating_low", "↓", "↑"],
  ],
  artists: [
    ["workspace.sort.name", "az", "za", "↑", "↓"],
    ["workspace.sort.rating", "rating_high", "rating_low", "↓", "↑"],
    ["library.sort.random", "random", "random", "", ""],
  ],
};
function syncWorkspaceSort(kind) {
  const host = $(`#${kind}-sort-buttons`), groups = workspaceSortGroups[kind];
  if (!host || !groups) return;
  const current = browseChoiceInputs(kind).sort.value;
  const labels = kind === "albums" ? albumSortLabels : artistSortLabels;
  const focused = host.contains?.(document.activeElement) ? document.activeElement.dataset.sortGroup : null;
  const markup = groups.map(([key, first, second, up, down], index) => {
    const selected = [first, second].includes(current), next = current === first ? second : first;
    return `<button type="button" class="browse-sort-button" data-sort-kind="${kind}" data-sort-group="${index}" data-sort-value="${next}" aria-pressed="${selected}" aria-label="${escapeHtml(labels[next])}" title="${escapeHtml(labels[next])}">${TagcastI18n.html(key)}<span aria-hidden="true">${selected ? current === first ? up : down : ""}</span></button>`;
  }).join("");
  if (host.innerHTML !== markup) {
    host.innerHTML = markup;
    if (focused !== null) host.querySelector(`[data-sort-group="${focused}"]`)?.focus({preventScroll: true});
  }
  if (kind === "albums") $("#albums-random-order").setAttribute("aria-pressed", String(current === "random"));
}
function chooseWorkspaceSort(kind, value) {
  if (state.screen !== kind || !workspaceSortGroups[kind]?.some(group => group[1] === value || group[2] === value)) return;
  const input = browseChoiceInputs(kind).sort;
  input.value = value;
  closeBrowseOptions();
  // Reuse reset, continuous-browse and persistence listeners on the original inputs.
  input.dispatchEvent(new Event("change"));
}
document.addEventListener("click", event => {
  const button = event.target.closest("[data-sort-kind]");
  if (button) chooseWorkspaceSort(button.dataset.sortKind, button.dataset.sortValue);
});

// Presentation metadata is bounded by live queued occurrences, never persisted or published.
const workspaceQueueDetails = new WeakMap();
let workspaceQueueScope = state.details, workspaceQueueGeneration = 0;
function workspaceQueueOwner() {
  if (workspaceQueueScope !== state.details) {
    workspaceQueueScope = state.details; workspaceQueueGeneration += 1;
  }
  return workspaceQueueGeneration;
}
function rememberWorkspaceQueueDetails(entry, metadata) {
  workspaceQueueDetails.set(entry, {metadata, generation: workspaceQueueOwner(), session: state.connection.playback_session});
}
function workspaceDetailsData() {
  // Follow the player's current occurrence, independently of the browsing route.
  const track = player.queue[player.index], captured = track && workspaceQueueDetails.get(track);
  const current = captured && captured.generation === workspaceQueueOwner() && captured.session === state.connection.playback_session;
  const metadata = current ? captured.metadata : null;
  const albumId = metadata?.track?.album_id || track?.album?.id;
  const summary = state.albums.find(a => String(a.id) === String(albumId));
  if (track && summary) {
    const cached = state.details.get(String(albumId));
    // A current cached membership is authoritative, including a removed queued track.
    if (cached) return {album: cached, track: cached.tracks.find(t => String(t.id) === String(track.id)) || null};
    return {album: {...track.album, ...metadata?.album, ...summary},
      track: captured && !current ? null : metadata?.track || track};
  }
  return null;
}
function workspaceFacts(rows) {
  return `<dl class="workspace-facts">${rows.filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== 0)
    .map(([key, value]) => `<div><dt>${TagcastI18n.html(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}
function workspaceNames(values) {
  return [...new Set(values.filter(value => typeof value === "string" && value.trim()))].join(" · ");
}
function workspaceCredits(record) {
  return (record.credits || []).map(entry => TagcastI18n.text("workspace.credit", {
    name: entry.name, role: Object.hasOwn(creditRoleLabels, entry.type) ? creditRoleLabels[entry.type] : entry.type || creditRoleLabels.artist,
    phrase: entry.phrase ? ` · ${entry.phrase}` : ""})).join("; ");
}
function workspaceUploaded(value) {
  return value && Number.isFinite(Date.parse(value)) ? TagcastI18n.dateTime(value) : "";
}
function workspaceRating(records) {
  if (!records.length || records.some(record => !Number.isInteger(record.rating) || record.rating < 0 || record.rating > 5)) return "";
  const values = [...new Set(records.map(record => record.rating))];
  return values.length > 1 ? TagcastI18n.text("workspace.rating.mixed")
    : values[0] ? TagcastI18n.text("workspace.rating.value", {value: values[0]}) : TagcastI18n.text("workspace.rating.unset");
}
function renderWorkspaceDetails() {
  const host = $("#workspace-details"), data = workspaceDetailsData();
  const {album, track} = data || {};
  const tracks = album?.tracks || [], discs = album?.discs || (album ? [album] : []);
  const completeDuration = tracks.length && tracks.every(t => Number.isFinite(t.length) && t.length > 0);
  const completeSize = tracks.length && tracks.every(t => Number.isSafeInteger(t.size) && t.size > 0);
  const bytes = value => Number.isSafeInteger(value) && value > 0 ? TagcastI18n.text("workspace.bytes", {value}) : "";
  const albumRows = album ? [
    ["workspace.field.title", album.name], ["workspace.field.artist", workspaceNames(discs.flatMap(disc => albumArtistEntries(disc).map(entry => entry.name)))],
    ["workspace.field.year", album.year], ["workspace.field.tracks", album.tracks ? TagcastI18n.number(album.tracks.length) : album.track_count ? TagcastI18n.number(album.track_count) : ""],
    ["workspace.field.disc", workspaceNames(discs.map(disc => disc.disc ? TagcastI18n.number(disc.disc) : ""))],
    ["workspace.field.duration", completeDuration ? trackDuration(tracks.reduce((sum, t) => sum + t.length, 0)) : ""],
    ["workspace.field.genres", workspaceNames(tracks.length ? tracks.flatMap(t => t.genres || (t.genre ? [t.genre] : [])) : album.genres || [])],
    ["workspace.field.tags", workspaceNames(tracks.flatMap(t => (t.tags || []).map(tag => tag.name)))],
    ["workspace.field.rating", workspaceRating(discs)],
    ["workspace.field.credits", workspaceNames(discs.map(workspaceCredits))],
    ["workspace.field.size", completeSize ? bytes(tracks.reduce((sum, t) => sum + t.size, 0)) : ""],
    ["workspace.field.lastUpload", workspaceUploaded(tracks.map(t => t.uploaded_at || "").sort().at(-1) || album.uploaded_at)],
  ] : [];
  const trackRows = track ? [
    ["workspace.field.title", track.title], ["workspace.field.artist", track.artist],
    ["workspace.field.album", album.name], ["workspace.field.year", track.year],
    ["workspace.field.trackNumber", track.track ? TagcastI18n.number(track.track) : ""],
    ["workspace.field.duration", track.length ? trackDuration(track.length) : ""],
    ["workspace.field.format", track.format], ["workspace.field.composer", (track.composers || []).join(", ")],
    ["workspace.field.genres", workspaceNames(track.genres || (track.genre ? [track.genre] : []))],
    ["workspace.field.tags", workspaceNames((track.tags || []).map(tag => tag.name))],
    ["workspace.field.performers", workspaceNames((track.performers || []).map(entry => entry.name))],
    ["workspace.field.credits", workspaceCredits(track)],
    ["workspace.field.rating", workspaceRating([track])],
    ["workspace.field.size", bytes(track.size)],
    ["workspace.field.plays", Number.isSafeInteger(track.plays) && track.plays >= 0 ? TagcastI18n.number(track.plays) : ""],
    ["workspace.field.gain", Number.isFinite(track.replay_gain) ? TagcastI18n.text("workspace.gain", {value: track.replay_gain}) : ""],
    ["workspace.field.added", workspaceUploaded(track.uploaded_at)],
  ] : [];
  const markup = album ? `<div class="workspace-detail-cover">${cover(album, true)}<div><strong>${escapeHtml(track?.title || album.name)}</strong><p>${escapeHtml(track?.artist || album.artist)}</p></div></div>
    <details data-workspace-section="album" open><summary>${TagcastI18n.html("workspace.field.album")}</summary>${workspaceFacts(albumRows)}</details>
    <details data-workspace-section="track" open><summary>${TagcastI18n.html("workspace.track")}</summary>${track ? workspaceFacts(trackRows) : `<p class="muted">${TagcastI18n.html("workspace.trackUnavailable")}</p>`}</details>`
    : `<p class="empty">${TagcastI18n.html("workspace.empty")}</p>`;
  if (markup !== workspacePanel.markup) {
    const focused = host.contains?.(document.activeElement)
      ? document.activeElement.closest?.("[data-workspace-section]")?.dataset.workspaceSection : "";
    const sections = new Map([...host.querySelectorAll("details")].map(node => [node.dataset.workspaceSection, node.open]));
    host.innerHTML = markup; workspacePanel.markup = markup;
    for (const node of host.querySelectorAll("details")) if (sections.has(node.dataset.workspaceSection)) node.open = sections.get(node.dataset.workspaceSection);
    if (focused) host.querySelector(`[data-workspace-section="${focused}"] summary`)?.focus({preventScroll: true});
  }
}
function syncWorkspacePanel() {
  workspaceQueueOwner();
  if (workspacePanel.scope !== state.details || workspacePanel.session !== state.connection.playback_session) {
    workspacePanel.markup = "";
    $("#workspace-details").innerHTML = "";
    workspacePanel.scope = state.details; workspacePanel.session = state.connection.playback_session;
  }
  const page = state.screen === "now-playing", details = !page && workspacePanel.tab === "details";
  const panel = $("#now-playing-panel");
  panel.setAttribute("aria-label", TagcastI18n.text(page ? "player.nowPlaying.region" : "workspace.panel"));
  $("#workspace-panel-tabs").hidden = page;
  $("#workspace-details").hidden = !details;
  $("#workspace-playlist").hidden = details;
  $(".now-playing-footer").hidden = details || (page && !player.queue.length);
  $("#workspace-panel-toggle").hidden = page;
  $("#workspace-panel-toggle").setAttribute("aria-expanded", String(!panel.hidden && !page));
  panel.dataset.workspaceTab = details ? "details" : "playlist";
  for (const tab of ["playlist", "details"]) {
    const button = $(`#workspace-tab-${tab}`), active = workspacePanel.tab === tab;
    button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
  }
  if (page) {
    $("#workspace-playlist").removeAttribute("role"); $("#workspace-playlist").removeAttribute("aria-labelledby");
  } else {
    $("#workspace-playlist").setAttribute("role", "tabpanel"); $("#workspace-playlist").setAttribute("aria-labelledby", "workspace-tab-playlist");
  }
  if (details && !panel.hidden) renderWorkspaceDetails();
}
function setWorkspaceTab(tab, focus = false) {
  if (!["playlist", "details"].includes(tab)) return;
  closeQueueActions();
  workspacePanel.tab = tab;
  syncWorkspacePanel();
  if (tab === "playlist") renderNowPlaying();
  // Existing native reads retire their player context when it is no longer visible.
  if (typeof renderLyrics === "function") renderLyrics("player");
  if (focus) $(`#workspace-tab-${tab}`).focus({preventScroll: true});
}
$("#workspace-panel-toggle").addEventListener("click", () => {
  workspacePanel.focus = $("#workspace-panel-toggle");
  if (typeof closeSidebarMenu === "function") closeSidebarMenu();
  setNowPlaying($("#now-playing-panel").hidden);
});
$("#workspace-panel-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-workspace-tab]");
  if (button) setWorkspaceTab(button.dataset.workspaceTab);
});
$("#workspace-panel-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  setWorkspaceTab(event.key === "Home" ? "playlist" : event.key === "End" ? "details"
    : workspacePanel.tab === "playlist" ? "details" : "playlist", true);
});
TagcastI18n.subscribe(() => { workspacePanel.markup = ""; syncWorkspacePanel(); syncNavigationToggle(); });
syncNavigationToggle(); syncWorkspacePanel();
for (const kind of Object.keys(workspaceSortGroups)) syncWorkspaceSort(kind);
