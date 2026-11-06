"use strict";

// Read-only tours: highlight existing controls without navigating, opening forms,
// loading data or invoking the controls. Native modality also protects open drafts.
// Topic, step and hint texts are interface text keys. helpContentFor() resolves them in the
// active language each time help opens or the language changes; ids, scopes and selectors stay logic.
const HELP_TOPICS = {
  uploads: {title: "help.uploads.title", scope: "#uploads-page", steps: [
    ["help.uploads.prepare.title", "help.uploads.prepare.body", ["#music-upload-form"]],
    ["help.uploads.review.title", "help.uploads.review.body", ["#music-upload-results"]],
    ["help.uploads.progress.title", "help.uploads.progress.body", ["#music-upload-phase"]],
  ]},
  downloads: {title: "help.downloads.title", scope: "#downloads-page", steps: [
    ["help.downloads.choose.title", "help.downloads.choose.body", ["#audio-download-albums"]],
    ["help.downloads.review.title", "help.downloads.review.body", ["#audio-download-form", "#audio-download-review"]],
    ["help.downloads.source.title", "help.downloads.source.body", ["#audio-download-source-field", "#audio-download-source-note"]],
    ["help.downloads.resume.title", "help.downloads.resume.body", ["#audio-download-progress"]],
  ]},
  "playlist-order": {title: "help.playlistOrder.title", scope: "#playlist-order", steps: [
    ["help.playlistOrder.find.title", "help.playlistOrder.find.body", ["#playlist-order-search", "#playlist-order-content"]],
    ["help.playlistOrder.move.title", "help.playlistOrder.move.body", ["#playlist-order-content"]],
    ["help.playlistOrder.save.title", "help.playlistOrder.save.body", ["#playlist-order-save", "#playlist-order-cancel"]],
  ]},
  "lyrics-viewer": {title: "help.lyricsViewer.title", scope: "#lyrics-viewer", steps: [
    ["help.lyricsViewer.known.title", "help.lyricsViewer.known.body", ["#lyrics-viewer-content"]],
    ["help.lyricsViewer.source.title", "help.lyricsViewer.source.body", ["#lyrics-viewer-content .lyrics-source", "#lyrics-viewer-close"]],
  ]},
  "lyrics-import": {title: "help.lyricsImport.title", scope: "#lyrics-import", steps: [
    ["help.lyricsImport.files.title", "help.lyricsImport.files.body", ["#lyrics-import-content"]],
    ["help.lyricsImport.links.title", "help.lyricsImport.links.body", ["#lyrics-import-content"]],
    ["help.lyricsImport.review.title", "help.lyricsImport.review.body", ["#lyrics-import-review", "#lyrics-import-save", "#lyrics-import-status"]],
  ]},
  "lyrics-review": {title: "help.lyricsReview.title", scope: "#lyrics-review", steps: [
    ["help.lyricsReview.text.title", "help.lyricsReview.text.body", ["#lyrics-review-content"]],
    ["help.lyricsReview.save.title", "help.lyricsReview.save.body", ["#lyrics-save", "#lyrics-save-status"]],
  ]},
  "audio-output": {title: "help.audioOutput.title", scope: "#audio-output-dialog", steps: [
    ["help.audioOutput.volume.title", "help.audioOutput.volume.body", [".audio-volume-controls", "#audio-volume-note"]],
    ["help.audioOutput.destination.title", "help.audioOutput.destination.body", ["#audio-output-current"]],
    ["help.audioOutput.devices.title", "help.audioOutput.devices.body", [".audio-output-controls", "#audio-output-note"]],
    ["help.audioOutput.wireless.title", "help.audioOutput.wireless.body", ["#audio-output-airplay", "#audio-output-note"]],
  ]},
  "album-merge": {title: "help.albumMerge.title", scope: "#album-merge", steps: [
    ["help.albumMerge.keep.title", "help.albumMerge.keep.body", ["#album-merge-content"]],
    ["help.albumMerge.tracks.title", "help.albumMerge.tracks.body", ["#album-merge-content"]],
    ["help.albumMerge.confirm.title", "help.albumMerge.confirm.body", ["#album-merge-content"]],
  ]},
  tags: {title: "help.tags.title", scope: "#tag-dialog", steps: [
    ["help.tags.labels.title", "help.tags.labels.body", ["#tag-dialog-content"]],
    ["help.tags.changes.title", "help.tags.changes.body", ["#tag-choices", "#tag-dialog-content"]],
    ["help.tags.review.title", "help.tags.review.body", ["#tag-review", "#tag-dialog-content"]],
  ]},
  "duplicate-cleanup": {title: "help.duplicateCleanup.title", scope: "#duplicate-cleanup", steps: [
    ["help.duplicateCleanup.analyse.title", "help.duplicateCleanup.analyse.body", ["#duplicate-cleanup-preview"]],
    ["help.duplicateCleanup.compare.title", "help.duplicateCleanup.compare.body", ["#duplicate-cleanup-content .cleanup-albums"]],
    ["help.duplicateCleanup.approve.title", "help.duplicateCleanup.approve.body", ["#duplicate-cleanup-approved", "#duplicate-cleanup-start", "#duplicate-cleanup-stop"]],
  ]},
  artists: {title: "help.artists.title", scope: "#artists-page", steps: [
    ["help.artists.browse.title", "help.artists.browse.body", ["#artists-page .page-intro"]],
    ["help.artists.find.title", "help.artists.find.body", ["#artists-page .toolbar"]],
    ["help.artists.open.title", "help.artists.open.body", ["#artists-grid .artist-card", "#artists-grid"]],
    ["help.artists.pages.title", "help.artists.pages.body", ["#artists-pagination", "#artists-per-page"]],
  ]},
  albums: {title: "help.albums.title", scope: "#albums-page", steps: [
    ["help.albums.collection.title", "help.albums.collection.body", ["#albums-page .page-intro"]],
    ["help.albums.artistFavourites.title", "help.albums.artistFavourites.body", ["#albums-page [data-artist-favourite]", "#artist-biography"], "help.albums.artistFavourites.hint"],
    ["help.albums.artistRating.title", "help.albums.artistRating.body", ["#artist-rating"], "help.albums.artistRating.hint"],
    ["help.albums.search.title", "help.albums.search.body", ["#albums-page .toolbar"]],
    ["help.albums.open.title", "help.albums.open.body", ["#albums-page .album-card"]],
    ["help.albums.select.title", "help.albums.select.body", ["#albums-page .album-select", "#albums-page .selection-bar", "#albums-random"]],
  ]},
  album: {title: "help.album.title", scope: "#album-page", steps: [
    ["help.album.intro.title", "help.album.intro.body", ["#album-page .album-detail-header"]],
    ["help.album.ratings.title", "help.album.ratings.body", ["#album-page .album-rating"], "help.album.ratings.hint"],
    ["help.album.play.title", "help.album.play.body", ["#album-page .album-detail-actions"]],
    ["help.album.track.title", "help.album.track.body", ["#album-page .album-tracks"]],
    ["help.album.edit.title", "help.album.edit.body", ["#album-page [data-edit-album]"]],
    ["help.album.lyrics.title", "help.album.lyrics.body", ["#album-page [data-album-more]", "#album-lyrics-check"], "help.album.lyrics.hint"],
    ["help.album.trash.title", "help.album.trash.body", ["#album-page [data-album-more]"], "help.album.trash.hint"],
  ]},
  editing: {title: "help.editing.title", scope: "#editor", steps: [
    ["help.editing.selection.title", "help.editing.selection.body", ["#editor .album-header"]],
    ["help.editing.draft.title", "help.editing.draft.body", ["#metadata-form .fields"], "help.editing.draft.hint"],
    ["help.editing.releaseYear.title", "help.editing.releaseYear.body", ["#track-years"]],
    ["help.editing.suggestions.title", "help.editing.suggestions.body", ["#editor .sources", "#change-cover"], "help.editing.suggestions.hint"],
    ["help.editing.tabs.title", "help.editing.tabs.body", ["#editor-tabs"], "help.editing.tabs.hint"],
    ["help.editing.review.title", "help.editing.review.body", ["#review-button"]],
  ]},
  "editing-tracks": {title: "help.editingTracks.title", scope: "#editor", steps: [
    ["help.editingTracks.tabs.title", "help.editingTracks.tabs.body", ["#editor-tabs"]],
    ["help.editingTracks.select.title", "help.editingTracks.select.body", ["#editor-tracks-panel .editor-track-list"]],
    ["help.editingTracks.details.title", "help.editingTracks.details.body", ["#track-inline"], "help.editingTracks.details.hint"],
    ["help.editingTracks.lyrics.title", "help.editingTracks.lyrics.body", ["#track-lyrics"], "help.editingTracks.lyrics.hint"],
    ["help.editingTracks.review.title", "help.editingTracks.review.body", ["#review-button"]],
  ]},
  review: {title: "help.review.title", scope: "#review", steps: [
    ["help.review.compare.title", "help.review.compare.body", ["#review-changes", "#review-intro"]],
    ["help.review.warnings.title", "help.review.warnings.body", ["#review-warnings", "#review-cancel"]],
    ["help.review.save.title", "help.review.save.body", ["#apply-draft", "#review-status"]],
  ]},
  settings: {title: "help.settings.title", scope: "#settings", steps: [
    ["help.settings.find.title", "help.settings.find.body", ["#settings-nav", "#settings-category-description"]],
    ["help.settings.nowPlayingView.title", "help.settings.nowPlayingView.body", ["#player-view-mode"]],
    ["listening.settings.transport", "listening.settings.note", ["#now-playing-open", "#player-transport-style", "#now-playing-meter"]],
    ["help.settings.nowPlayingLyrics.title", "help.settings.nowPlayingLyrics.body", ["#playback-lyrics-mode", "#playback-lyrics-cover-background"]],
    ["help.settings.spectrum.title", "help.settings.spectrum.body", ["#player-visualizer-mode"]],
    ["help.settings.interface.title", "help.settings.interface.body", ["#settings .interface-settings"]],
    ["help.settings.sidebar.title", "help.settings.sidebar.body", ["#settings .sidebar-layout-settings"]],
    ["help.settings.libraryMetadata.title", "help.settings.libraryMetadata.body", ["#metadata-export"]],
    ["help.settings.exportChanges.title", "help.settings.exportChanges.body", ["#settings #export-button"]],
    ["help.settings.gapless.title", "help.settings.gapless.body", ["#gapless-test-enabled"]],
    ["help.settings.playback.title", "help.settings.playback.body", ["#settings .playback-settings"], "help.settings.playback.hint"],
    ["help.settings.discovery.title", "help.settings.discovery.body", ["#settings [name=album_guide]"], "help.settings.discovery.hint"],
    ["help.settings.biographies.title", "help.settings.biographies.body", ["#settings .artist-biography-settings"], "help.settings.biographies.hint"],
    ["help.settings.albumInformation.title", "help.settings.albumInformation.body", ["#settings .album-information-settings"], "help.settings.albumInformation.hint"],
    ["help.settings.sources.title", "help.settings.sources.body", ["#settings .source-settings", "#settings #check-updates"], "help.settings.sources.hint"],
  ]},
  tracks: {title: "help.tracks.title", scope: "#tracks-page", steps: [
    ["help.tracks.search.title", "help.tracks.search.body", ["#tracks-page .toolbar"]],
    ["help.tracks.open.title", "help.tracks.open.body", ["#tracks-list"]],
    ["help.tracks.actions.title", "help.tracks.actions.body", ["#tracks-list .queue-menu-trigger", "#tracks-list"]],
  ]},
  favourites: {title: "help.favourites.title", scope: "main", steps: [
    ["help.favourites.tabs.title", "help.favourites.tabs.body", ["#favourites-tabs"]],
    ["help.favourites.tracks.title", "help.favourites.tracks.body", ["#favourites-page"]],
    ["help.favourites.find.title", "help.favourites.find.body", ["#favourites-page .toolbar", "#favourites-list"]],
    ["help.favourites.remove.title", "help.favourites.remove.body", ["#favourites-list"]],
  ]},
  "album-favourites": {title: "help.albumFavourites.title", scope: "main", steps: [
    ["help.albumFavourites.tabs.title", "help.albumFavourites.tabs.body", ["#favourites-tabs"]],
    ["help.albumFavourites.albums.title", "help.albumFavourites.albums.body", ["#collections-page"]],
    ["help.albumFavourites.find.title", "help.albumFavourites.find.body", ["#collection-search", "#collections-page .album-card"]],
  ]},
  "artist-favourites": {title: "help.artistFavourites.title", scope: "main", steps: [
    ["help.artistFavourites.tabs.title", "help.artistFavourites.tabs.body", ["#favourites-tabs"]],
    ["help.artistFavourites.artists.title", "help.artistFavourites.artists.body", ["#favourite-artists-grid"]],
    ["help.artistFavourites.find.title", "help.artistFavourites.find.body", ["#artist-favourites-page .toolbar"]],
  ]},
  playlists: {title: "help.playlists.title", scope: "#collections-page", steps: [
    ["help.playlists.list.title", "help.playlists.list.body", ["#collections-page .page-intro", "#collections-page"]],
    ["help.playlists.folders.title", "help.playlists.folders.body", ["[data-folder-create]", "#collections-page"]],
    ["help.playlists.create.title", "help.playlists.create.body", ["[data-playlist-create]", "#collection-search"]],
    ["help.playlists.paused.title", "help.playlists.paused.body", ["[data-csv-paused]"]],
  ]},
  playlist: {title: "help.playlist.title", scope: "#collections-page", steps: [
    ["help.playlist.contents.title", "help.playlist.contents.body", ["#collections-page .track-results", "#collections-page"]],
    ["help.playlist.shuffle.title", "help.playlist.shuffle.body", ["[data-playlist-shuffle]", "[data-playlist-play]"]],
    ["help.playlist.cover.title", "help.playlist.cover.body", ["[data-playlist-cover]"]],
    ["help.playlist.edit.title", "help.playlist.edit.body", ["[data-playlist-edit]"]],
    ["help.playlist.addQueue.title", "help.playlist.addQueue.body", ["[data-playlist-add-queue]"], "help.playlist.addQueue.hint"],
    ["help.playlist.delete.title", "help.playlist.delete.body", ["[data-playlist-delete]"], "help.playlist.delete.hint"],
  ]},
  "playlist-folder": {title: "help.playlistFolder.title", scope: "#collections-page", steps: [
    ["help.playlistFolder.references.title", "help.playlistFolder.references.body", ["#collections-page .playlist-cards", "#collections-page .playlist-list"]],
    ["help.playlistFolder.manage.title", "help.playlistFolder.manage.body", ["[data-folder-add]", "[data-folder-delete]"]],
  ]},
  "playlist-review": {title: "help.playlistReview.title", scope: "#playlist-dialog", steps: [
    ["help.playlistReview.change.title", "help.playlistReview.change.body", ["#playlist-dialog-content"]],
    ["help.playlistReview.confirm.title", "help.playlistReview.confirm.body", ["#playlist-dialog-content .dialog-footer"]],
  ]},
  "playlist-import": {title: "help.playlistImport.title", scope: "#playlist-import", steps: [
    ["help.playlistImport.url.title", "help.playlistImport.url.body", ["#playlist-url-form"], "help.playlistImport.url.hint"],
    ["help.playlistImport.columns.title", "help.playlistImport.columns.body", ["#csv-file-form", "#csv-map-form"], "help.playlistImport.columns.hint"],
    ["help.playlistImport.matches.title", "help.playlistImport.matches.body", [".csv-import-rows", ".csv-candidates", "#csv-search-form"], "help.playlistImport.matches.hint"],
    ["help.playlistImport.review.title", "help.playlistImport.review.body", ["#csv-review-form", ".csv-review-list", "[data-csv-save]"], "help.playlistImport.review.hint"],
    ["help.playlistImport.unresolved.title", "help.playlistImport.unresolved.body", ["[data-csv-export]"], "help.playlistImport.unresolved.hint"],
    ["help.playlistImport.progress.title", "help.playlistImport.progress.body", ["[data-close=\"playlist-import\"]"]],
    ["help.playlistImport.pause.title", "help.playlistImport.pause.body", ["#csv-import-pause", "#csv-import-content"], "help.playlistImport.pause.hint"],
  ]},
  "playlist-cover": {title: "help.playlistCover.title", scope: "#artwork", steps: [
    ["help.playlistCover.compare.title", "help.playlistCover.compare.body", ["#artwork .art-compare", "#artwork .art-own"]],
    ["help.playlistCover.save.title", "help.playlistCover.save.body", ["#art-save", "#art-status"]],
  ]},
  "recently-played": {title: "help.recentlyPlayed.title", scope: "#recently-played-page", steps: [
    ["help.recentlyPlayed.list.title", "help.recentlyPlayed.list.body", ["#recently-played-page .page-intro"]],
    ["help.recentlyPlayed.search.title", "help.recentlyPlayed.search.body", ["#recently-played-page .toolbar", "#recently-played-refresh"]],
    ["help.recentlyPlayed.again.title", "help.recentlyPlayed.again.body", ["#recently-played-list"]],
  ]},
  overview: {title: "help.overview.title", scope: "#overview-page", steps: [
    ["help.overview.numbers.title", "help.overview.numbers.body", ["#overview-page"]],
    ["help.overview.metadata.title", "help.overview.metadata.body", ["#overview-page [data-health]", "#overview-page"]],
  ]},
  guide: {title: "help.guide.title", scope: "#album-guide-page", steps: [
    ["help.guide.list.title", "help.guide.list.body", ["#album-guide-page .page-intro"]],
    ["help.guide.analyse.title", "help.guide.analyse.body", ["#guide-analyse"]],
    ["help.guide.results.title", "help.guide.results.body", ["#guide-results", "#guide-note"]],
    ["help.guide.decades.title", "help.guide.decades.body", ["#guide-toolbar", "#guide-decades"], "help.guide.decades.hint"],
    ["help.guide.edition.title", "help.guide.edition.body", ["#guide-list .album-card"], "help.guide.edition.hint"],
    ["help.guide.link.title", "help.guide.link.body", ["#guide-list .album-card", "#guide-note"]],
  ]},
  "guide-link": {title: "help.guideLink.title", scope: "#guide-link-dialog", steps: [
    ["help.guideLink.reference.title", "help.guideLink.reference.body", ["#guide-link-reference"]],
    ["help.guideLink.find.title", "help.guideLink.find.body", ["#guide-link-search"]],
    ["help.guideLink.save.title", "help.guideLink.save.body", ["#guide-link-choices"]],
  ]},
};

function currentHelpContext() {
  if ($("#lyrics-import").open) return "lyrics-import";
  if ($("#playlist-order").open) return "playlist-order";
  if ($("#playlist-import").open) return "playlist-import";
  if ($("#audio-output-dialog").open) return "audio-output";
  if ($("#album-merge").open) return "album-merge";
  if ($("#tag-dialog").open) return "tags";
  if ($("#lyrics-review").open) return "lyrics-review";
  if ($("#lyrics-viewer").open) return "lyrics-viewer";
  if ($("#playlist-dialog").open) return "playlist-review";
  if ($("#artwork").open && art.target?.target === "playlist") return "playlist-cover";
  for (const [id, context] of [["duplicate-cleanup", "duplicate-cleanup"], ["review", "review"], ["guide-link-dialog", "guide-link"], ["editor", "editing"]]) {
    if ($(`#${id}`).open) return context === "editing" && editing?.tab === "tracks" ? "editing-tracks" : context;
  }
  if (state.screen === "settings") return "settings";
  if (state.screen === "album-guide") return "guide";
  if (state.screen === "playlists" && collectionsView.playlist) return collectionsView.data?.is_folder ? "playlist-folder" : "playlist";
  return state.screen;
}

// Keyed steps [title, text, targets, hint?] become plain text in the active language, in the
// same shape, so the tour code below never sees a key.
function helpSteps(steps) {
  return steps.map(([heading, copy, targets, hint]) => {
    const step = [TagcastI18n.text(heading), TagcastI18n.text(copy), targets];
    if (hint) step.push(TagcastI18n.text(hint));
    return step;
  });
}

function helpContentFor(context) {
  if (context !== "browse") {
    const topic = Object.hasOwn(HELP_TOPICS, context) ? HELP_TOPICS[context] : null;
    return topic && {title: TagcastI18n.text(topic.title), scope: topic.scope, steps: helpSteps(topic.steps)};
  }
  // Group names (browseView.label) are library data and stay as they are; the kind's label and
  // subtitle are browse.js page texts.
  if (uploadBrowseKind()) return {title: browseKinds[browseView.kind].label, scope: "#browse-page", steps: helpSteps([
    ["help.browseUploads.history.title", "help.browseUploads.history.body", ["#browse-title", "#browse-subtitle"]],
    ["help.browseUploads.find.title", "help.browseUploads.find.body", ["#browse-toolbar", "#browse-upload-path"]],
    ["help.browseUploads.albums.title", "help.browseUploads.albums.body", ["#browse-list", "#browse-pagination"]],
  ])};
  if (browseView.kind === "tags") return {title: TagcastI18n.text("help.browseTags.title"), scope: "#browse-page", steps: helpSteps([
    ["help.browseTags.labels.title", "help.browseTags.labels.body", ["#browse-list", "#browse-subtitle"]],
    ["help.browseTags.find.title", "help.browseTags.find.body", ["#browse-toolbar", "#browse-list"]],
    ["help.browseTags.manage.title", "help.browseTags.manage.body", ["#browse-tag-actions"]],
  ])};
  const detail = browseView.key !== null, decades = browseView.kind === "decades";
  const title = detail ? browseView.label || browseKinds[browseView.kind].label : browseKinds[browseView.kind].label;
  const explanation = browseKinds[browseView.kind].subtitle;
  return {title, scope: "#browse-page", steps: detail ? helpSteps([
    ["help.browseGroup.albums.title", "help.browseGroup.albums.body", ["#browse-title", "#browse-subtitle"]],
    decades ? ["help.browseGroup.sample.title", "help.browseGroup.sample.body", ["#browse-toolbar"]]
      : ["help.browseGroup.find.title", "help.browseGroup.find.body", ["#browse-toolbar"]],
    ["help.browseGroup.play.title", "help.browseGroup.play.body", ["#browse-random", "#browse-list .album-card"]],
  ]) : [
    [title, explanation, ["#browse-title"]],
    ...helpSteps([
      decades ? ["help.browseIndex.decade.title", "help.browseIndex.decade.body", ["#browse-list"]]
        : ["help.browseIndex.find.title", "help.browseIndex.find.body", ["#browse-toolbar"]],
      ["help.browseIndex.open.title", "help.browseIndex.open.body", ["#browse-list"]],
    ]),
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

// `move` is false for a language change: the card is rewritten in place without scrolling the
// page or moving focus.
function renderHelp(move = true) {
  clearTimeout(helpTour.timer);
  const topic = helpTour.content, step = topic.steps[helpTour.index];
  $("#help-progress").textContent = TagcastI18n.text("help.tour.progress", {topic: topic.title, step: helpTour.index + 1, total: topic.steps.length});
  $("#help-title").textContent = step[0];
  $("#help-close").setAttribute("aria-label", TagcastI18n.text("help.tour.close"));
  $("#help-prev").textContent = TagcastI18n.text("common.pagination.previous");
  if (step) {
    $("#help-copy").textContent = step[1];
    $("#help-prev").disabled = helpTour.index === 0;
    $("#help-next").textContent = TagcastI18n.text(helpTour.index === topic.steps.length - 1 ? "help.tour.finish" : "common.pagination.next");
    if (move) helpVisibleTarget(step[2])?.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"});
  }
  positionHelp();
  helpTour.timer = setTimeout(positionHelp, 0);
  if (move) $("#help-title").focus({preventScroll: true});
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
  $("#help-hint").textContent = step && !visible ? step[3] || TagcastI18n.text("help.tour.noTarget") : "";
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
// A language change rewrites an open tour in place: same topic, step, spotlight, scroll positions
// and focus. Nothing is fetched or opened, and nothing happens while help is closed.
TagcastI18n.subscribe(() => {
  if (!$("#help-dialog")?.open || !helpTour.topic || !helpTour.content) return;
  const content = helpContentFor(helpTour.topic);
  if (!content?.steps.length) return;
  helpTour.content = content;
  helpTour.index = Math.min(helpTour.index, content.steps.length - 1);
  renderHelp(false);
});
