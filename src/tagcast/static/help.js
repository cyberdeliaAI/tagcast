"use strict";

// Read-only tours: highlight existing controls without navigating, opening forms,
// loading data or invoking the controls. Native modality also protects open drafts.
const HELP_TOPICS = {
  "duplicate-cleanup": {title: "Suggested duplicate copies", scope: "#duplicate-cleanup", steps: [
    ["Analyse all duplicate albums", "Analyse all albums applies the album page's Select suggested copies rules across your entire library, regardless of search or pagination. It reads stored metadata and prepares a local draft; it does not move tracks.", ["#duplicate-cleanup-preview"]],
    ["Compare and adjust", "Prefer FLAC over MP3, then the newest upload in the same format. Uncertain copies remain. Review each repeated position, including differing titles. Uncheck an album or an individual proposed copy to keep it.", ["#duplicate-cleanup-content .cleanup-albums"]],
    ["Approve and process", "Approve your selection before moving copies to iBroadcast's trash in batches. Current metadata and retained copies are checked before each batch, then the result is read back. Stop prevents further requests; uncertain requests are never automatically retried.", ["#duplicate-cleanup-approved", "#duplicate-cleanup-start", "#duplicate-cleanup-stop"]],
  ]},
  artists: {title: "Album artists", scope: "#artists-page", steps: [
    ["Browse your album artists", "Each card groups the albums credited to one album artist. The totals refer to albums in your library.", ["#artists-page .page-intro"]],
    ["Find an artist", "Search by name, filter artists without an image, or change the order. Random gives you a different way to explore the list.", ["#artists-page .toolbar"]],
    ["Open their albums", "Choose an artist card to see their albums. Back returns to this list with your search, order and page preserved.", ["#artists-grid .artist-card", "#artists-grid"]],
    ["Browse more artists", "Choose how many artists to show per page, then use Previous and Next to move through the results.", ["#artists-pagination", "#artists-per-page"]],
  ]},
  albums: {title: "Albums", scope: "#albums-page", steps: [
    ["Your album collection", "These cards show your albums, or the albums by the artist you opened. Discs belonging to the same set are displayed together.", ["#albums-page .page-intro"]],
    ["Search, filter and sort", "Search titles, artists or genres. Filters can help you find missing metadata or duplicate candidates. Choose the order, page size and cover or list view here.", ["#albums-page .toolbar"]],
    ["Open, play or queue", "Click a cover or title to open the album. Its small Play button starts the full album and replaces the queue. The + menu adds it to the queue or plays it next. Enlarge covers on the album page.", ["#albums-page .album-card"]],
    ["Select or discover", "Select albums by one album artist to edit them or review moving the complete albums to iBroadcast's trash. Play random album is available in All albums when no albums are selected; cleanup filters hide it.", ["#albums-page .selection-bar", "#albums-random"]],
  ]},
  album: {title: "Album details", scope: "#album-page", steps: [
    ["Your album", "The header shows the album artist, release year, track count and duration. Double-click a real cover to enlarge it. If About this album is available below the header, expand it to read the background text.", ["#album-page .album-detail-header"]],
    ["Album ratings", "Choose stars to rate this album, or use the heart to make it a favourite. For a multi-disc set, the rating applies to every disc and is checked afterwards.", ["#album-page .album-rating"], "Album ratings are available with a connected iBroadcast account."],
    ["Play or queue", "Play album starts from the beginning and replaces the queue. The + menu offers Add to queue and Play next, preserving disc and track order. Add to playlist saves the album after a review.", ["#album-page .album-detail-actions"]],
    ["Choose a track", "Play beside a track starts there and continues through the album. A track's + menu can queue just that track or add it to a playlist. Its heart controls the track favourite.", ["#album-page .album-tracks"]],
    ["Edit this album", "Edit album opens a draft with online suggestions. Review the changes before saving. A multi-disc set also has an Edit disc option for each disc.", ["#album-page [data-edit-album]"]],
    ["Reviewed trash selection", "Move to trash opens track selection. Duplicated marks repeated track numbers on the same disc, even when the titles differ. The album overview shows the same label. Upload dates and suggested keep/trash labels help compare copies: prefer FLAC over MP3, then the newest upload in the same format. Select suggested copies fills the checkboxes; uncertain versions remain manual. Select extra copies only chooses matching titles and keeps the first. Review the exact selection before confirming. Trashed tracks leave the library in every iBroadcast app.", ["#album-page [data-trash-start]"], "Moving tracks to the trash is available with a connected account."],
  ]},
  editing: {title: "Edit metadata", scope: "#editor", steps: [
    ["Your editing selection", "This header identifies the album, discs or albums by one artist included in the draft. Nothing is saved just by opening the editor.", ["#editor .album-header"]],
    ["Edit your draft", "Change the title, album artist, year or genres. Various Artists changes the album credit while keeping track artists. Applying the year to tracks is a separate choice.", ["#metadata-form .fields"], "These fields appear in the album editor."],
    ["Compare suggestions", "Online sources can suggest metadata and artwork. Metadata suggestions fill your draft. Cover changes have their own comparison and save action.", ["#editor .sources", "#change-cover"], "Online suggestions are available when editing a single album."],
    ["Check individual tracks", "Edit track titles, artists and other details separately when needed. Individual track edits take precedence over changes applied to the whole selection.", ["#editor .track-table"], "Individual track fields appear when editing a single album or set."],
    ["Review before saving", "Choose Review draft to compare the before and after values. You can then keep editing or explicitly save the reviewed changes to iBroadcast.", ["#review-button"]],
  ]},
  review: {title: "Review your draft", scope: "#review", steps: [
    ["Check before and after", "Read the proposed changes and check which albums and tracks they affect. Only changed, supported fields are sent.", ["#review-changes", "#review-intro"]],
    ["Read warnings", "Warnings can block changes or require attention. Keep editing returns to your draft without saving it.", ["#review-warnings", "#review-cancel"]],
    ["Save and check the result", "The save button sends your reviewed changes. Tagcast checks current values before writing and reads accepted changes back afterwards. A save can partly succeed; read the result before trying again.", ["#apply-draft", "#review-status"]],
  ]},
  settings: {title: "Settings", scope: "#settings", steps: [
    ["Interface", "Restore the library information banner or choose which details to show in the compact player. These display choices apply immediately in this browser.", ["#settings .interface-settings"]],
    ["Sidebar", "Show, hide and reorder optional shortcuts. Album artists, Albums, Change history and connection controls remain available. Restore default sidebar resets the layout.", ["#settings .sidebar-layout-settings"]],
    ["Playback and devices", "Choose streaming quality separately from the stored file format. Optional play reporting and queue synchronisation are independent and off by default. Save server preferences with the Save button.", ["#settings .playback-settings"], "Playback preferences need the local Tagcast server."],
    ["Discovery", "Enable 1001 Albums here and save to show its shortcut. Analysis starts only when you choose it on that page; enabling the feature does not scan your library.", ["#settings [name=album_guide]"], "Discovery preferences need the local Tagcast server."],
    ["Sources and updates", "Online source keys stay on this computer. Automatic lookup sends album and artist names to the chosen sources. Update settings control release checks; updates are installed manually.", ["#settings .source-settings", "#settings #check-updates"], "Source and update preferences need the local Tagcast server."],
  ]},
  tracks: {title: "Tracks", scope: "#tracks-page", steps: [
    ["Search your tracks", "Search titles, performers, albums or composers across your library. Results are paginated; narrow the search if there are many matches.", ["#tracks-page .toolbar"]],
    ["Open or play a result", "Play a result to listen, or open its album to see the full track list and editor. Artist links open albums featuring that performer.", ["#tracks-list"]],
    ["Track actions", "A track's + menu offers queue, play next and playlist actions. The heart adds or removes its iBroadcast favourite. A format label describes the stored file, not the selected streaming quality.", ["#tracks-list .queue-menu-trigger", "#tracks-list"]],
  ]},
  favourites: {title: "Favourites", scope: "#favourites-page", steps: [
    ["Your favourite tracks", "This list uses iBroadcast track ratings of 5. It includes existing five-star tracks and changes made in other iBroadcast apps after reloading the library.", ["#favourites-page .page-intro"]],
    ["Find and play", "Search this list, choose the page size, then play a track or open its album. The + menu offers queue and playlist actions.", ["#favourites-page .toolbar", "#favourites-list"]],
    ["Remove a favourite", "The filled heart removes a favourite by setting its rating to 0. The track remains in your library. Rating changes are checked afterwards.", ["#favourites-list"]],
  ]},
  "album-favourites": {title: "Album favourites", scope: "#collections-page", steps: [
    ["Your favourite albums", "Albums rated 5 appear here. A multi-disc set appears once when all its discs have a rating of 5.", ["#collections-page .page-intro", "#collections-page"]],
    ["Find an album", "Search favourite albums by title or artist. Open a card to listen or change the album rating. Removing its favourite keeps the album in your library.", ["#collection-search", "#collections-page .album-card"]],
  ]},
  playlists: {title: "Playlists", scope: "#collections-page", steps: [
    ["Your playlists", "Browse and search your iBroadcast playlists, then open one to see its tracks in order. System playlists and folders are protected.", ["#collections-page .page-intro", "#collections-page"]],
    ["Create a playlist", "Choose Create playlist to create a private playlist. You review its name and contents before it is sent to iBroadcast.", ["[data-playlist-create]", "#collection-search"]],
  ]},
  playlist: {title: "Playlist", scope: "#collections-page", steps: [
    ["Playlist contents", "Tracks appear in the playlist's order. Play the playlist or a track, or add tracks to your queue with their + menu.", ["#collections-page .track-results", "#collections-page"]],
    ["Add your queue", "You can append the current queue to this playlist after reviewing the change. Adding an individual track or album is also available from its playlist action.", ["[data-playlist-add-queue]"], "Queue additions are available for editable private playlists."],
    ["Delete the playlist", "Delete playlist requires a review. It removes only the playlist definition; all its tracks remain in your library. System playlists and folders cannot be deleted here.", ["[data-playlist-delete]"], "Deletion is available only for editable playlists."],
  ]},
  "recently-played": {title: "Recently played", scope: "#recently-played-page", steps: [
    ["Your recent listening", "This is iBroadcast's recent tracks playlist, including plays reported by other devices. The most recent track is first and each track appears once. iBroadcast provides no play timestamps in this list.", ["#recently-played-page .page-intro"]],
    ["Search or refresh", "Search and page through the current list. Refresh from iBroadcast fetches the latest ordering. This page is available while optional play reporting is enabled.", ["#recently-played-page .toolbar", "#recently-played-refresh"]],
    ["Listen again", "Play a track, open its album or use its + menu for queue and playlist actions. Listening history is separate from metadata Change history.", ["#recently-played-list"]],
  ]},
  overview: {title: "Overview", scope: "#overview-page", steps: [
    ["Your library in numbers", "Overview summarises your collection and account using the loaded library. Album totals use the same displayed sets as the album browser.", ["#overview-page"]],
    ["Explore metadata", "Metadata health counts highlight missing or combined values. Choose Show albums beside a count to inspect the corresponding albums before deciding whether to edit them.", ["#overview-page [data-health]", "#overview-page"]],
  ]},
  guide: {title: "1001 Albums", scope: "#album-guide-page", steps: [
    ["Your listening list", "This selection is based on the book edited by Robert Dimery and covers 1955–2007. Compare it with the albums already in your iBroadcast library.", ["#album-guide-page .page-intro"]],
    ["Analyse when you choose", "Analyse my library compares the reference with your loaded album metadata and saves the results locally. Opening this page does not start an analysis. No audio is scanned.", ["#guide-analyse"]],
    ["Understand the results", "In your library means matched or linked by you. Possible matches need confirmation and do not count as found. Not found entries have a grey placeholder. A match does not establish that every track is present.", ["#guide-results", "#guide-note"]],
    ["Explore by decade or year", "Combine decade buttons with search and matching status. Sort by the reference year or List order. Show matching details hides or restores the labels and link buttons on cards; your matches stay saved.", ["#guide-toolbar", "#guide-decades"], "The filters appear after an analysis is ready."],
    ["Choose your edition", "Use Confirm match or Choose album on a card. Search your library if needed, check the artist and title, then choose Use this album. This saves a local link; it does not edit iBroadcast.", ["#guide-list .album-card"], "Album cards appear after analysis."],
    ["Keep or revise a link", "Change link or Undo link lets you revise your choice. Manual links survive Analyse again. Library or reference changes can require a fresh analysis.", ["#guide-list .album-card", "#guide-note"]],
  ]},
  "guide-link": {title: "Choose an album", scope: "#guide-link-dialog", steps: [
    ["Check the reference", "This is the artist, album and year from the reference list. You are choosing the corresponding edition in your own library.", ["#guide-link-reference"]],
    ["Find your edition", "Search your loaded library by artist or title if the suggested editions are not the one you want.", ["#guide-link-search"]],
    ["Save a local link", "Check the result, then choose Use this album. The link counts as found while its albums remain available. It changes no iBroadcast metadata; you can change or undo it later.", ["#guide-link-choices"]],
  ]},
};

function currentHelpContext() {
  for (const [id, context] of [["duplicate-cleanup", "duplicate-cleanup"], ["review", "review"], ["settings", "settings"], ["guide-link-dialog", "guide-link"], ["editor", "editing"]]) {
    if ($(`#${id}`).open) return context;
  }
  if (state.screen === "album-guide") return "guide";
  if (state.screen === "playlists" && collectionsView.playlist) return "playlist";
  return state.screen;
}

function helpContentFor(context) {
  if (context !== "browse") return HELP_TOPICS[context];
  const detail = browseView.key !== null, decades = browseView.kind === "decades";
  const title = detail ? browseView.label || browseKinds[browseView.kind].label : browseKinds[browseView.kind].label;
  const explanation = browseKinds[browseView.kind].subtitle;
  return {title, scope: "#browse-page", steps: detail ? [
    ["Albums in this group", "An album appears when at least one track belongs to this group. Open an album to see its tracks or use its + menu to queue it.", ["#browse-title", "#browse-subtitle"]],
    [decades ? "A random selection" : "Find an album", decades ? "This page shows a random sample from the decade. Surprise me again reshuffles it locally. Back preserves the current selection." : "Search and sort the matching albums here. The page size controls how many are displayed at once.", ["#browse-toolbar"]],
    ["Play or explore", "Play random album chooses from all matching albums in this group, before pagination or sampling, and replaces the queue. Opening a card shows its full album.", ["#browse-random", "#browse-list .album-card"]],
  ] : [
    [title, explanation, ["#browse-title"]],
    [decades ? "Choose a decade" : "Find a group", decades ? "Choose a decade card to discover its albums. Years come from the tracks, with the album year as fallback. Unknown years are excluded." : "Search or sort the groups, then choose a card to see its matching albums. Album totals follow the same merged sets as the album browser.", decades ? ["#browse-list"] : ["#browse-toolbar"]],
    ["Open matching albums", "Each card opens the albums belonging to that group. Back returns to your previous search and page.", ["#browse-list"]],
  ]};
}
const helpTour = {topic: null, content: null, index: 0, focus: null, timer: null, scroll: [], pageScroll: null};

function helpVisibleTarget(selectors) {
  // Hidden sidebar shortcuts and controls in closed dialogs must not be exposed.
  const scope = helpTour.content?.scope ? $(helpTour.content.scope) : null;
  for (const selector of selectors) for (const node of document.querySelectorAll(selector)) {
    if (scope && !scope.contains(node)) continue;
    if (!node.closest("[hidden]") && !node.closest("dialog:not([open])") && node.getClientRects().length) return node;
  }
  return null;
}

function openHelp(topic = currentHelpContext(), trigger = document.activeElement) {
  const content = helpContentFor(topic);
  if (!content) return;
  if (!$("#help-dialog").open) {
    helpTour.focus = trigger;
    helpTour.pageScroll = [window.scrollX || 0, window.scrollY || 0];
    helpTour.scroll = [...document.querySelectorAll("dialog[open], .workspace-nav, .now-playing-scroll")]
      .map(node => [node, node.scrollTop, node.scrollLeft]);
    cancelCoverClick(); closeQueueActions(); setThemeMenu(false);
    document.body.classList.add("help-open");
    $("#help-dialog").showModal();
  }
  helpTour.topic = topic; helpTour.content = content; helpTour.index = 0;
  renderHelp();
}

function closeHelp(restore = true) {
  if (!$("#help-dialog").open) return;
  clearTimeout(helpTour.timer);
  $("#help-dialog").close();
  document.body.classList.remove("help-open");
  for (const [node, top, left] of helpTour.scroll) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
  if (helpTour.pageScroll) window.scrollTo?.({left: helpTour.pageScroll[0], top: helpTour.pageScroll[1], behavior: "instant"});
  const focus = helpTour.focus;
  Object.assign(helpTour, {topic: null, content: null, index: 0, focus: null, scroll: [], pageScroll: null});
  if (restore && focus?.isConnected) focus.focus({preventScroll: true});
}

function renderHelp() {
  clearTimeout(helpTour.timer);
  const topic = helpTour.content, step = topic.steps[helpTour.index];
  $("#help-progress").textContent = `${topic.title} · ${helpTour.index + 1} of ${topic.steps.length}`;
  $("#help-title").textContent = step[0];
  if (step) {
    $("#help-copy").textContent = step[1];
    $("#help-prev").disabled = helpTour.index === 0;
    $("#help-next").textContent = helpTour.index === topic.steps.length - 1 ? "Finish" : "Next →";
    helpVisibleTarget(step[2])?.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"});
  }
  positionHelp();
  helpTour.timer = setTimeout(positionHelp, 0);
  $("#help-title").focus({preventScroll: true});
}

function helpCardPosition(rect, card, width, height) {
  const gap = 18, edge = 12, centered = {left: (width - card.width) / 2, top: (height - card.height) / 2};
  const candidates = rect ? [
    {left: rect.right + gap, top: rect.top},
    {left: rect.left - card.width - gap, top: rect.top},
    {left: rect.left, top: rect.bottom + gap},
    {left: rect.left, top: rect.top - card.height - gap},
  ] : [];
  const fit = candidates.find(p => p.left >= edge && p.left + card.width <= width - edge
    && p.top >= edge && p.top + card.height <= height - edge) || centered;
  return {left: Math.max(edge, Math.min(fit.left, width - card.width - edge)),
    top: Math.max(edge, Math.min(fit.top, height - card.height - edge))};
}

function positionHelp() {
  if (!$("#help-dialog").open) return;
  const step = helpTour.content?.steps[helpTour.index];
  const target = step ? helpVisibleTarget(step[2]) : null;
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  const box = target?.getBoundingClientRect();
  const rect = box && {left: Math.max(4, box.left - 5), top: Math.max(4, box.top - 5),
    right: Math.min(width - 4, box.right + 5), bottom: Math.min(height - 4, box.bottom + 5)};
  const visible = rect && rect.right > rect.left && rect.bottom > rect.top;
  const spot = $("#help-spotlight");
  Object.assign(spot.style, {left: `${visible ? rect.left : width / 2}px`, top: `${visible ? rect.top : height / 2}px`,
    width: `${visible ? rect.right - rect.left : 0}px`, height: `${visible ? rect.bottom - rect.top : 0}px`});
  spot.classList.toggle("has-target", !!visible);
  $("#help-hint").textContent = step && !visible ? step[3] || "The controls appear here when this page has content available." : "";
  $("#help-hint").hidden = !$("#help-hint").textContent;
  const card = $("#help-card"), position = helpCardPosition(visible ? rect : null, card.getBoundingClientRect(), width, height);
  Object.assign(card.style, {left: `${position.left}px`, top: `${position.top}px`});
}

function queueHelpPosition() {
  if (!$("#help-dialog").open) return;
  clearTimeout(helpTour.timer); helpTour.timer = setTimeout(positionHelp, 0);
}

document.addEventListener("click", event => {
  const trigger = event.target.closest("[data-help-context]");
  if (trigger) { openHelp(trigger.dataset.helpContext, trigger); return; }
  if (event.target.closest("#help-button")) openHelp();
  if (event.target.closest("#help-close") || event.target === $("#help-dialog")) closeHelp();
  if (event.target.closest("#help-prev") && helpTour.index > 0) { helpTour.index -= 1; renderHelp(); }
  if (event.target.closest("#help-next") && helpTour.topic) {
    if (helpTour.index + 1 === helpTour.content.steps.length) closeHelp();
    else { helpTour.index += 1; renderHelp(); }
  }
});
$("#help-dialog").addEventListener("cancel", event => { event.preventDefault(); closeHelp(); });
document.addEventListener("keydown", event => {
  if (!$("#help-dialog").open) return;
  if (event.key === "Escape") {
    event.preventDefault(); event.stopImmediatePropagation(); closeHelp();
  } else if (event.key === "Tab") {
    const controls = [...document.querySelectorAll("#help-card button:not([disabled])")]
      .filter(node => node.getClientRects().length);
    const first = controls[0], last = controls.at(-1), active = document.activeElement;
    if (first && ((event.shiftKey ? active === first : active === last) || !controls.includes(active))) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }
}, true);
window.addEventListener("resize", queueHelpPosition);
document.addEventListener("scroll", queueHelpPosition, true);
