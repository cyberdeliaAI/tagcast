"use strict";

// Read-only tours: highlight existing controls without navigating, opening forms,
// loading data or invoking the controls. Native modality also protects open drafts.
const HELP_TOPICS = {
  "playlist-order": {title: "Playlist order", scope: "#playlist-order", steps: [
    ["Find a track", "Search title, artist or album across the whole playlist, including positions on other pages. Search keeps your unsaved moves. Result numbers and Move to position refer to the complete current draft. Drag and arrow moves also use that full order, including hidden tracks. Clear the search to see every position again.", ["#playlist-order-search", "#playlist-order-content"]],
    ["Move saved positions", "Drag a handle to the insertion line for a nearby move. With the handle focused, use Up or Down. Move to position accepts any position in the whole playlist, including another page. Repeated and unavailable tracks remain separate positions.", ["#playlist-order-content"]],
    ["Save or cancel", "Save order sends only the reviewed order, then checks it in iBroadcast. Cancel or Close discards the local changes. The playing queue stays intact. If the playlist changed elsewhere, reopen it before trying again; uncertain writes are not repeated.", ["#playlist-order-save", "#playlist-order-cancel"]],
  ]},
  "lyrics-viewer": {title: "Track lyrics", scope: "#lyrics-viewer", steps: [
    ["Known lyrics", "The Lyrics label appears only after Tagcast has found text for this track. Opening this window uses that text without starting playback or fetching lyrics. No label can also mean the track has not been checked yet.", ["#lyrics-viewer-content"]],
    ["Text source", "The source is shown below the text: lyrics saved in iBroadcast, or a public LRCLIB result. Close or press Escape to return to the album.", ["#lyrics-viewer-content .lyrics-source", "#lyrics-viewer-close"]],
  ]},
  "lyrics-import": {title: "Import album lyrics", scope: "#lyrics-import", steps: [
    ["Choose sidecar files", "Select or drop up to 100 UTF-8 or UTF-16 LRC/TXT files, at most 5 MB in total. The left column shows this album’s tracks; the right column shows imported files. Reading files stays local until review. Original music and lyrics files stay unchanged.", ["#lyrics-import-content"]],
    ["Check the links", "Unique track-number and title matches are linked automatically. A disc prefix can distinguish multi-disc positions. Select a track and a file, then Link selected track and file to correct a match. Unlink keeps a track out of the import. Ambiguous matches stay manual. LRC timing markers are removed; ordinary lyrics text is saved.", ["#lyrics-import-content"]],
    ["Review before saving", "Review linked lyrics checks fresh iBroadcast lyrics for linked tracks only. Compare Before and After. Existing text is kept unless you choose Replace existing lyrics for that track. Save reviewed lyrics requires Premium and sends individual changes in sequence, preserving other userdata. Stop finishes the current request and its check. Errors or unconfirmed results stop remaining writes, with no automatic retries.", ["#lyrics-import-review", "#lyrics-import-save", "#lyrics-import-status"]],
  ]},
  "lyrics-review": {title: "Track lyrics", scope: "#lyrics-review", steps: [
    ["Review the text", "Compare Before and After. This changes only one track’s lyrics stored in iBroadcast; other additional metadata is preserved. A blank After removes the lyrics. Original music-file tags are unchanged.", ["#lyrics-review-content"]],
    ["Save once and check", "Save lyrics requires iBroadcast Premium. Tagcast checks the track and its complete additional metadata again, sends once and reads the lyrics back. An uncertain save requires checking iBroadcast before reviewing again.", ["#lyrics-save", "#lyrics-save-status"]],
  ]},
  "audio-output": {title: "Sound", scope: "#audio-output-dialog", steps: [
    ["Adjust player volume", "The slider and Mute control the current player, even when your browser hides its own volume controls. Arrow keys adjust the focused slider. Your system or speaker may also have its own volume control. Playback and the queue stay in place.", [".audio-volume-controls", "#audio-volume-note"]],
    ["Choose where to listen", "System default follows your computer’s sound settings. This selection changes only this browser player; the same audio and queue keep running.", ["#audio-output-current"]],
    ["Available devices", "Choose output opens your browser’s device picker where supported. The list contains only outputs the browser makes available. Tagcast never requests microphone access to discover speakers. If no choices appear, use your system sound settings.", [".audio-output-controls", "#audio-output-note"]],
    ["Wireless outputs", "AirPlay appears only when your browser supports it and an output is available. It opens the native route picker. Otherwise, use your system sound settings for supported network speakers. Tagcast does not discover Sonos or Chromecast devices itself.", ["#audio-output-airplay", "#audio-output-note"]],
  ]},
  tags: {title: "Tags", scope: "#tag-dialog", steps: [
    ["Your own labels", "iBroadcast tags are separate from genres. On an album, changes apply to its tracks, including every disc of the displayed set; track controls affect only that track. In Albums or an artist’s page, select complete albums and choose Tag… to manage up to 20 albums / 500 tracks together. The selection count shows partial assignments.", ["#tag-dialog-content"]],
    ["Choose changes", "Keep as is preserves existing assignments. Add applies the label to the chosen tracks; Remove unassigns it. Choices survive tag search and paging. Archived tags cannot be added here because they may hide music.", ["#tag-choices", "#tag-dialog-content"]],
    ["Review and confirm", "Review tag changes before saving. New tag creates an empty label to assign afterwards. Rename and Delete affect the label throughout iBroadcast. Deleting a label keeps your music. Every write is checked and read back; there is no automatic retry or metadata Undo.", ["#tag-review", "#tag-dialog-content"]],
  ]},
  "duplicate-cleanup": {title: "Suggested duplicate copies", scope: "#duplicate-cleanup", steps: [
    ["Analyse all duplicate albums", "Analyse all albums applies the album page's Select suggested copies rules across your entire library, regardless of search or pagination. It reads stored metadata and prepares a local draft; it does not move tracks.", ["#duplicate-cleanup-preview"]],
    ["Compare and adjust", "Prefer FLAC over MP3, then the newest upload in the same format. Uncertain copies remain. Review each repeated position, including differing titles. Uncheck an album or an individual proposed copy to keep it.", ["#duplicate-cleanup-content .cleanup-albums"]],
    ["Approve and process", "Approve your selection before moving copies to iBroadcast's trash in batches. Current metadata and retained copies are checked before each batch, then the result is read back. Stop prevents further requests; uncertain requests are never automatically retried.", ["#duplicate-cleanup-approved", "#duplicate-cleanup-start", "#duplicate-cleanup-stop"]],
  ]},
  artists: {title: "Album artists", scope: "#artists-page", steps: [
    ["Browse your album artists", "Each card groups the albums credited to one album artist. The totals refer to albums in your library.", ["#artists-page .page-intro"]],
    ["Find an artist", "Search by name. The combined Filter and sort menu has separate Sort and Show sections: changing one keeps the other. Checkmarks identify both current choices. Empty filters are omitted; All album artists stays available. Sort by name, native artist rating or Random. Unrated artists stay last.", ["#artists-page .toolbar"]],
    ["Open their albums", "Choose an artist card to see their albums. On the artist page, hover or focus the larger photo to change it through the existing comparison; that action stays visible on touch devices. Back returns to this list with your search, order and page preserved. A filled heart identifies an artist favourite; choose Favourite artists in the filter to show only these artists.", ["#artists-grid .artist-card", "#artists-grid"]],
    ["Browse more artists", "Choose how many artists to show per page, then use Previous and Next to move through the results.", ["#artists-pagination", "#artists-per-page"]],
  ]},
  albums: {title: "Albums", scope: "#albums-page", steps: [
    ["Your album collection", "These cards show your albums, or the albums by the artist you opened. Discs belonging to the same set are displayed together.", ["#albums-page .page-intro"]],
    ["Artist favourites and biographies", "On an album artist's page, the heart beside the name saves a local favourite for your account, independently of album hearts and stars. Artist biographies are optional in Settings. When enabled, only visited artists are looked up on TheAudioDB; text is cached locally and can be expanded in About this artist. Check the source when artists share a name.", ["#albums-page [data-artist-favourite]", "#artist-biography"], "Open an album artist to use artist favourites. Enable optional biographies in Settings."],
    ["Artist rating", "The stars below an artist's name are their native iBroadcast rating, separate from the local heart and all album or track ratings. Choose one to save it; Clear removes it. Saving checks the previous value and reads the result back. Different artist ratings means this displayed name groups multiple native artists.", ["#artist-rating"], "Open an album artist to rate them."],
    ["Search, filter and sort", "Search titles, artists or genres. One Filter and sort menu combines Sort and Show, with independent checked choices. Filters with no albums in the current artist scope are omitted; All albums remains available. Sort by album rating or Date uploaded as well as name or release year. Date uploaded uses the latest known active-track upload, including every disc in a set. Unknown dates and unrated albums stay last. Sorting never downloads tracks.", ["#albums-page .toolbar"]],
    ["Open, play or queue", "Click a cover or title to open the album. Its small Play button starts the full album and replaces the queue. The + menu adds it to the queue or plays it next. Enlarge covers on the album page.", ["#albums-page .album-card"]],
    ["Select or discover", "With a connected account, tick albums in the grid or list, including filtered results such as 1–2 tracks. Tag… opens the existing tag manager for all selected albums, including selections on other pages or outside the current results. Move selected albums to trash reviews all chosen albums and their tracks before confirmation. On an artist's page, you can also edit their selected albums together. Play random album is available in All albums when no albums are selected; cleanup filters hide it.", ["#albums-page .album-select", "#albums-page .selection-bar", "#albums-random"]],
  ]},
  album: {title: "Album details", scope: "#album-page", steps: [
    ["Your album", "The breadcrumb returns to the browsing context where you opened this album, with its filters and position. The header shows the album artist, release year, track count and duration. Click a known year to browse releases from that year. Genre and tag chips stay together; + Tag opens tag management. Double-click a real cover to enlarge it. If About this album is available below the header, expand it to read the background text. Optional TheAudioDB album information is enabled separately in Settings, fetched only for the album you visit and saved locally for 30 days.", ["#album-page .album-detail-header"]],
    ["Album ratings", "Stars rate this album in iBroadcast. The heart saves a separate album favourite locally for your account, without changing its stars. Both apply to every disc of a multi-disc set.", ["#album-page .album-rating"], "Album ratings are available with a connected iBroadcast account."],
    ["Play or queue", "Play album starts from the beginning and replaces the queue. Shuffle album replaces the queue with all tracks in a newly mixed order, including every disc of the set; each track plays once per pass. The displayed album order stays unchanged. The + menu offers Add to queue and Play next, preserving disc and track order. Add to playlist saves the album after a review.", ["#album-page .album-detail-actions"]],
    ["Choose a track", "A track number becomes Play on hover or keyboard focus and starts listening from that track. The playing row has a speaker and a quiet highlight. Extra performers, composer credits and tags appear only when present; the album artist is not repeated. The heading shows the common file format; amber labels identify different formats. Row actions appear on hover or keyboard focus, and stay visible on touch devices. An active heart or thumbs-down stays visible. Hearts set the native track rating to 5, thumbs-down to 1; click the active control to clear it. Dislikes do not skip or trash tracks. Use # for track tags or + for queue and playlist actions.", ["#album-page .album-tracks"]],
    ["Edit this album", "Edit opens a draft with online suggestions. Review the changes before saving. A multi-disc set also has an Edit disc option for each disc.", ["#album-page [data-edit-album]"]],
    ["Check album lyrics", "Choose More album actions (⋯) → Check album lyrics to read this album’s native lyrics one track at a time, up to 100 tracks. Results, including empty results, are saved locally for your account and survive restarts. Opening an album restores known labels from that local cache. Use Check iBroadcast again on a track to refresh changed text. Labels open known text without playback. Stop checking or leave the album to stop further reads. No LRCLIB searches or playlist checks run automatically.", ["#album-page [data-album-more]", "#album-lyrics-check"], "Album lyrics checks need a connected account."],
    ["Reviewed trash selection", "Open More album actions (⋯), then Move to trash to choose tracks. Duplicated marks repeated track numbers on the same disc, even when the titles differ. The album overview shows the same label. Upload dates and suggested keep/trash labels help compare copies: prefer FLAC over MP3, then the newest upload in the same format. Select suggested copies fills the checkboxes; uncertain versions remain manual. Select extra copies only chooses matching titles and keeps the first. Review the exact selection before confirming. Trashed tracks leave the library in every iBroadcast app.", ["#album-page [data-album-more]"], "Moving tracks to the trash is available with a connected account."],
  ]},
  editing: {title: "Edit metadata", scope: "#editor", steps: [
    ["Your editing selection", "This header identifies the album, discs or albums by one artist included in the draft. Nothing is saved just by opening the editor.", ["#editor .album-header"]],
    ["Edit your draft", "Change the title, primary album artist, additional album artists, year or genres. Type in artist, genre or composer fields to search existing library names, or use the arrow to browse. Selecting a genre or composer adds one whole label; typed semicolons still separate new labels. Click a name or use Up/Down and Enter; Escape closes the list. You can still type a new name. Keep each album artist separate. Various Artists clears additional album credits in the review while keeping track artists. Genres allow 200 characters per label and 20 labels per track; invalid input stays in the field. Applying the year to tracks is a separate choice.", ["#metadata-form .fields"], "These fields appear in the album editor."],
    ["Compare suggestions", "Online sources can suggest metadata and artwork. Metadata suggestions fill your draft. Cover changes have their own comparison and save action.", ["#editor .sources", "#change-cover"], "Online suggestions are available when editing a single album."],
    ["Album and track tabs", "Edit album contains shared album fields and online suggestions. Choose Edit tracks for the track list, individual credits and lyrics. Switching tabs retains both drafts and makes no requests. Review draft includes metadata changes from both tabs. Lyrics keep their separate review and save.", ["#editor-tabs"], "Individual track editing is available for one album or disc set; bulk artist editing keeps its shared fields."],
    ["Review before saving", "Choose Review draft to compare the before and after values. You can then keep editing or explicitly save the reviewed changes to iBroadcast.", ["#review-button"]],
  ]},
  "editing-tracks": {title: "Edit tracks", scope: "#editor", steps: [
    ["Choose what to edit", "Edit tracks keeps the track list beside one track’s form. Edit album returns to shared fields and suggestions. Switching tabs preserves entered values and never saves or starts a lookup.", ["#editor-tabs"]],
    ["Select a track", "Choose Edit beside a title. The list scrolls independently; disc headings are preserved for multi-disc sets. Selecting another track keeps the previous track’s valid changes in the draft.", ["#editor-tracks-panel .editor-track-list"]],
    ["Track details and credits", "Edit title, primary artist, year, number, genres and additional credits. Keep each performer and role separate. Individual changes take precedence over album-wide track edits. Review draft includes metadata changes from both tabs.", ["#track-inline"], "Choose a track to show its form."],
    ["Lyrics", "The track lyrics field reads iBroadcast first. Find lyrics explicitly searches LRCLIB if none are stored. Use these lyrics fills the separate field; Review lyrics and Save lyrics to iBroadcast require a separate confirmation and Premium. Original file tags stay unchanged.", ["#track-lyrics"], "Choose a track to read its lyrics."],
    ["Review all metadata", "Review draft compares all album and track metadata changes before saving. Switching tabs does not change the save scope or start playback.", ["#review-button"]],
  ]},
  review: {title: "Review your draft", scope: "#review", steps: [
    ["Check before and after", "Read the proposed changes and check which albums and tracks they affect. Only changed, supported fields are sent.", ["#review-changes", "#review-intro"]],
    ["Read warnings", "Warnings can block changes or require attention. Keep editing returns to your draft without saving it.", ["#review-warnings", "#review-cancel"]],
    ["Save and check the result", "The save button sends your reviewed changes. Tagcast checks current values before writing and reads accepted changes back afterwards. A save can partly succeed; read the result before trying again.", ["#apply-draft", "#review-status"]],
  ]},
  settings: {title: "Settings", scope: "#settings", steps: [
    ["Now playing view", "Choose Fullscreen or In app window for the expanded player. The choice is remembered in this browser or desktop profile and applies the next time you open Now playing. Playback and the queue stay unchanged.", ["#player-view-mode"]],
    ["Interface", "Restore the library information banner or choose which details to show in the compact player. These display choices apply immediately in this browser.", ["#settings .interface-settings"]],
    ["Sidebar", "Show, hide and reorder optional shortcuts. Album artists, Albums, Change history and connection controls remain available. Restore default sidebar resets the layout.", ["#settings .sidebar-layout-settings"]],
    ["Library metadata", "Prepare JSON or a ZIP of linked CSV tables from the full loaded library, including separate artists, roles and credit phrases. Then choose Download. Optional tags, playlists and local favourites are included when available; the manifest reports missing data. This does not fetch tracks, save settings or change iBroadcast.", ["#metadata-export"]],
    ["Export changes", "Download the change history saved in this browser as a JSON file. Export is available after a change has been recorded, and does not save pending settings. You can also export from Change history.", ["#settings #export-button"]],
    ["Playback and devices", "Choose streaming quality separately from the stored file format. Optional play reporting and queue synchronisation are independent and off by default. Save server preferences with the Save button.", ["#settings .playback-settings"], "Playback preferences need the local Tagcast server."],
    ["Discovery", "Enable 1001 Albums here and save to show its shortcut. Analysis starts only when you choose it on that page; enabling the feature does not scan your library. This setting controls the discovery page; bundled album background texts stay available when it is off.", ["#settings [name=album_guide]"], "Discovery preferences need the local Tagcast server."],
    ["Artist biographies", "Optional English biographies from TheAudioDB are off by default. After enabling and saving, visiting an album artist checks the local cache first. Only missing or outdated text needs an external lookup of that artist's name. Biographies do not edit your music metadata.", ["#settings .artist-biography-settings"], "Artist biographies need the local Tagcast server."],
    ["Album information", "Optional English album background text from TheAudioDB is off by default and independent of artist biographies and 1001 Albums. After saving, visiting an album checks its local cache first, then fetches missing or outdated text for one exact artist and full title. Text is reused for 30 days and never changes your metadata.", ["#settings .album-information-settings"], "Album information needs the local Tagcast server."],
    ["Sources and updates", "Select online sources individually, then Save. All are selected by default; sources requiring a key still need one. Disabling keeps saved keys and skips metadata and image suggestions. Biographies and album information have separate switches. Automatic lookup sends album and artist names only to selected, available sources. Update settings control release checks; updates are installed manually.", ["#settings .source-settings", "#settings #check-updates"], "Source and update preferences need the local Tagcast server."],
  ]},
  tracks: {title: "Tracks", scope: "#tracks-page", steps: [
    ["Search your tracks", "Search titles, performers, albums or composers across your library. Results are paginated; narrow the search if there are many matches.", ["#tracks-page .toolbar"]],
    ["Open or play a result", "Play a result to listen, or open its album to see the full track list and editor. Artist links open albums featuring that performer.", ["#tracks-list"]],
    ["Track actions", "A track's + menu offers queue, play next and playlist actions. The heart sets the native track rating to 5; thumbs-down sets it to 1. Click the active control to clear to 0. Replacing a nonzero rating asks for confirmation. Dislikes do not skip or trash tracks. A format label describes the stored file, not the selected streaming quality.", ["#tracks-list .queue-menu-trigger", "#tracks-list"]],
  ]},
  favourites: {title: "Favourite tracks", scope: "main", steps: [
    ["Choose your favourites", "The tabs switch between Tracks, Albums and Album artists. Searches and pages stay separate, and playback continues when switching.", ["#favourites-tabs"]],
    ["Your favourite tracks", "This list uses iBroadcast track ratings of 5. It includes existing five-star tracks and changes made in other iBroadcast apps after reloading the library.", ["#favourites-page"]],
    ["Find and play", "Search this list, choose the page size, then play a track or open its album. The + menu offers queue and playlist actions.", ["#favourites-page .toolbar", "#favourites-list"]],
    ["Remove a favourite", "The filled heart removes a favourite by setting its rating to 0. The track remains in your library. Thumbs-down replaces the rating with 1 after confirmation and removes the track from this favourites list. Rating changes are checked afterwards.", ["#favourites-list"]],
  ]},
  "album-favourites": {title: "Album favourites", scope: "main", steps: [
    ["Choose your favourites", "Favourites in the sidebar opens this shared page. Use Tracks, Albums or Album artists to switch lists without changing playback.", ["#favourites-tabs"]],
    ["Your favourite albums", "Albums marked with a heart appear here, independently of their stars. These favourites are saved on this computer for your account. A multi-disc set appears once when all its discs are favourites.", ["#collections-page"]],
    ["Find an album", "Search favourite albums by title or artist. Open a card to listen, change its stars or toggle its separate heart. Removing a favourite keeps its star rating and music.", ["#collection-search", "#collections-page .album-card"]],
  ]},
  "artist-favourites": {title: "Favourite album artists", scope: "main", steps: [
    ["Choose your favourites", "Use the tabs to switch between favourite tracks, albums and album artists. Searches and pages stay separate; Back and Forward return to the previous list.", ["#favourites-tabs"]],
    ["Your favourite album artists", "Artist hearts are saved on this computer for your account, independently of album hearts and stars. Open a card to see that artist’s albums. The heart beside their name adds or removes the artist favourite.", ["#favourite-artists-grid"]],
    ["Find an artist", "Search names, change their order or choose a page size. This list uses loaded album summaries and never downloads all track details.", ["#artist-favourites-page .toolbar"]],
  ]},
  playlists: {title: "Playlists", scope: "#collections-page", steps: [
    ["Your playlists", "Browse and search your iBroadcast playlists using the loaded library, without an online check each time. Reload library retrieves changes made elsewhere; saves still check and read back fresh data. Choose cards or list with the view buttons; this browser remembers the choice. The list shows covers, names, active track counts and duration, with unavailable tracks and unknown times labelled. Open a playlist to see its tracks in order. Open folders to browse their playlist references. System playlists remain managed by iBroadcast.", ["#collections-page .page-intro", "#collections-page"]],
    ["Playlist folders", "Create an empty folder, then review additions, removals and name changes. Removing a reference leaves its playlist and music intact. Search finds nested playlists too. Folder loops are blocked; only empty folders without parent references can be deleted.", ["[data-folder-create]", "#collections-page"]],
    ["Create a playlist", "Choose Create playlist to create a private playlist. You review its name and contents before it is sent to iBroadcast.", ["[data-playlist-create]", "#collection-search"]],
    ["Paused imports", "Paused imports holds up to 10 locally saved CSV imports / 64 MB for this account, including after restart. Refresh library & resume retrieves new uploads and checks matches again. It keeps unchanged manual choices and skips, while changed choices need review. No playlist is created until you approve a new final review.", ["[data-csv-paused]"]],
  ]},
  playlist: {title: "Playlist", scope: "#collections-page", steps: [
    ["Playlist contents", "Tracks appear in the playlist's order, 100 per page. Search this playlist matches title, artist or album across every page using the loaded library. Original position numbers remain visible; clearing the search restores all tracks. Playback and editing still use the complete playlist (or the displayed page above 10,000 tracks). Playlists over 10,000 tracks can be opened and paged; Play this page queues only the current page. Full-content replacement stays limited to 10,000 tracks. Adding tracks and reviewed deletion remain available. Use + for individual queue actions. The cross at the right removes only that playlist occurrence after confirmation; library tracks and the current play queue stay intact. Removing positions is limited to playlists with up to 10,000 saved positions.", ["#collections-page .track-results", "#collections-page"]],
    ["Shuffle playback", "Shuffle playlist replaces the play queue with the complete playlist in a newly mixed order. Each entry appears once per pass; the saved playlist and displayed positions keep their order. Play playlist restores ordinary ordered playback. Above 10,000 tracks, Shuffle this page uses only the current page, just like Play this page. Opening Help never starts playback.", ["[data-playlist-shuffle]", "[data-playlist-play]"]],
    ["Playlist cover", "Hover the cover or focus it with the keyboard to choose Change cover; the action stays visible on touch devices. Compare the current image with your file or image URL. Save explicitly, then wait for confirmation. Only this playlist artwork changes; track and album covers, playback and metadata history stay intact.", ["[data-playlist-cover]"]],
    ["Edit details or contents", "If all track choices stay checked, changing the name or description sends only the changed text. The review shows Before and After; every stored track position stays intact. Unchecking tracks prepares a full contents replacement instead. Both routes require confirmation and iBroadcast read-back.", ["[data-playlist-edit]"]],
    ["Add your queue", "You can append the current queue to this playlist after reviewing the change. Adding an individual track or album is also available from its playlist action.", ["[data-playlist-add-queue]"], "Queue additions are available for editable private playlists."],
    ["Delete the playlist", "Delete playlist requires a review. It removes only the playlist definition; all its tracks remain in your library. System playlists and folders cannot be deleted here.", ["[data-playlist-delete]"], "Deletion is available only for editable playlists."],
  ]},
  "playlist-folder": {title: "Playlist folder", scope: "#collections-page", steps: [
    ["Folder references", "Open a member playlist or nested folder. These are playlist identities, never song IDs. Unavailable references stay visible and can be removed explicitly.", ["#collections-page .playlist-cards", "#collections-page .playlist-list"]],
    ["Manage the folder", "Rename or add references after review. Remove from folder unlinks only that reference. Delete is available only for an empty folder that is not referenced by another folder.", ["[data-folder-add]", "[data-folder-delete]"]],
  ]},
  "playlist-review": {title: "Playlist review", scope: "#playlist-dialog", steps: [
    ["Review the change", "Check the name, destination and selected contents before confirming. Folder reviews add or remove playlist references; ordinary playlist reviews operate on tracks. Closing cancels an unsent draft.", ["#playlist-dialog-content"]],
    ["Confirm and wait", "Confirm once, then wait for a fresh read-back. An uncertain request is not repeated automatically. System playlists stay protected; music files are never deleted by folder or playlist-definition operations.", ["#playlist-dialog-content .dialog-footer"]],
  ]},
  "playlist-import": {title: "Playlist import", scope: "#playlist-import", steps: [
    ["Public playlist URL", "Playlist URL accepts public Deezer playlists and experimental ListenBrainz playlists. Paste a supported link and explicitly choose Fetch playlist. No source login or audio download is used. Fetching validates the complete list; blocked, private, oversized or incomplete responses show an error rather than preparing a partial import. Deezer respects its switch in Settings. After fetching, the same columns, matching, preferences, pause and final review are used. Album is available but not mapped by default. CSV cells containing links are never followed.", ["#playlist-url-form"], "Open Playlist URL from Playlists to fetch a public playlist. Opening this Help never fetches anything."],
    ["Read and link columns", "Choose a CSV, separator, encoding and header setting. Confirm track title and performing artist columns. Album, album artist, duration, year and track number are optional. Numeric durations need seconds or milliseconds; mm:ss also works. Mapping Album title makes matching stricter; leave it unused to allow other albums or compilations. When multiple tracks match defaults to Choose manually; you can prefer FLAC, the oldest stored year, the first match, or FLAC then oldest year. Preferences apply only to copies matching all mapped fields. Unknown years come last; remaining ties use the lowest track ID.", ["#csv-file-form", "#csv-map-form"], "Linking columns comes before matching. CSV cells are plain text."],
    ["Check every choice", "Results open on Unresolved records. Use Show to inspect automatic or manual matches too. A unique full-title and performer match is chosen automatically; an explicitly selected copy preference can also choose between fully matching copies. Match explanation says why a manual choice was needed; each suggestion lists its differences from the CSV. Multiple matching copies and invalid CSV fields are explained too. Search the loaded library or skip a record. Change match also lets you correct automatic choices. No online lookup or playback starts here.", [".csv-import-rows", ".csv-candidates", "#csv-search-form"], "Match the CSV first to see candidates and library search."],
    ["Review and create", "Choose more matches, or continue with only the selected tracks. Review matched tracks leaves unresolved records out and shows their count before confirmation. At least one track is required. Back to matches preserves unresolved rows so you can make more choices. Chosen tracks follow CSV order, with repeated IDs kept once at their first position. Confirm to create a new private playlist. Wait for read-back; an uncertain creation is never repeated automatically.", ["#csv-review-form", ".csv-review-list", "[data-csv-save]"], "The final review becomes available after matching. Existing playlists and music metadata stay unchanged."],
    ["Keep unresolved records", "Export unresolved records as CSV from the matches, final review or completion screen. The file includes all unresolved rows across every page, with original columns and order. Explicitly skipped records are excluded. Re-import recognises Tagcast's spreadsheet-safe text format automatically. Download before closing the import; the draft is temporary.", ["[data-csv-export]"], "The export button appears when unresolved records remain after matching."],
    ["Keep your progress", "Once you have input or a draft, Close, Cancel and Escape ask before discarding it. Choose Keep importing, or press Escape in that confirmation, to continue with your choices intact. Only Discard import throws away the draft. Closing during playlist creation does not cancel the accepted request. Empty and finished imports close directly.", ["[data-close=\"playlist-import\"]"]],
    ["Pause for later", "After reading a CSV or fetching a public playlist, Pause import saves its columns, source records, playlist text, copy preference and choices locally for this account. You can then upload missing tracks. Open Playlists → Paused imports and choose Refresh library & resume to recheck your matches. Pause again to update that saved copy. Closing a resumed draft keeps its last checkpoint; Remove separately reviews deletion. Pausing or resuming never creates a playlist.", ["#csv-import-pause", "#csv-import-content"], "Read a CSV or fetch a playlist first to make Pause import available. In the paused list, resume or explicitly remove one saved copy."],
  ]},
  "playlist-cover": {title: "Playlist cover", scope: "#artwork", steps: [
    ["Compare covers", "Choose a JPEG, PNG, WebP or GIF file up to 15 MB, or an image URL. Compare Now and New before saving. This is a playlist cover; it does not replace the covers of its tracks or albums.", ["#artwork .art-compare", "#artwork .art-own"]],
    ["Save and check", "Save explicitly and wait for iBroadcast read-back. If the playlist or account changed during upload, the image is not applied. An uncertain save needs a fresh review before retrying.", ["#art-save", "#art-status"]],
  ]},
  "recently-played": {title: "Recently played", scope: "#recently-played-page", steps: [
    ["Your recent listening", "This is iBroadcast's recent tracks playlist, including plays reported by other devices. The most recent track is first and each track appears once. iBroadcast provides no play timestamps in this list.", ["#recently-played-page .page-intro"]],
    ["Search or refresh", "Search and page through the current list. Refresh from iBroadcast fetches the latest ordering. This page is available while optional play reporting is enabled.", ["#recently-played-page .toolbar", "#recently-played-refresh"]],
    ["Listen again", "Play a track, open its album or use its + menu for queue and playlist actions. Listening history is separate from metadata Change history.", ["#recently-played-list"]],
  ]},
  overview: {title: "Overview", scope: "#overview-page", steps: [
    ["Your library in numbers", "Overview summarises your collection and account using the loaded library. Album totals use the same displayed sets as the album browser.", ["#overview-page"]],
    ["Explore metadata", "Metadata health counts highlight missing or combined values. Follow a count’s link to inspect the matching albums or album artists before deciding whether to edit them.", ["#overview-page [data-health]", "#overview-page"]],
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
  if ($("#lyrics-import").open) return "lyrics-import";
  if ($("#playlist-order").open) return "playlist-order";
  if ($("#playlist-import").open) return "playlist-import";
  if ($("#audio-output-dialog").open) return "audio-output";
  if ($("#tag-dialog").open) return "tags";
  if ($("#lyrics-review").open) return "lyrics-review";
  if ($("#lyrics-viewer").open) return "lyrics-viewer";
  if ($("#playlist-dialog").open) return "playlist-review";
  if ($("#artwork").open && art.target?.target === "playlist") return "playlist-cover";
  for (const [id, context] of [["duplicate-cleanup", "duplicate-cleanup"], ["review", "review"], ["settings", "settings"], ["guide-link-dialog", "guide-link"], ["editor", "editing"]]) {
    if ($(`#${id}`).open) return context === "editing" && editing?.tab === "tracks" ? "editing-tracks" : context;
  }
  if (state.screen === "album-guide") return "guide";
  if (state.screen === "playlists" && collectionsView.playlist) return collectionsView.data?.is_folder ? "playlist-folder" : "playlist";
  return state.screen;
}

function helpContentFor(context) {
  if (context !== "browse") return HELP_TOPICS[context];
  if (browseView.kind === "tags") return {title: "Tags", scope: "#browse-page", steps: [
    ["Your iBroadcast labels", "Tags are custom labels attached to tracks. These cards include empty tags and show the matching album and track totals. Archived labels are marked.", ["#browse-list", "#browse-subtitle"]],
    ["Find albums", "Open a tag to see albums with at least one tagged track, then open an album to manage its tags or a single track's tags. Search, sort and page without loading every track into the browser.", ["#browse-toolbar", "#browse-list"]],
    ["Manage labels", "New tag creates an empty label after review. Inside a tag, Rename and Delete affect that label throughout iBroadcast. Deleting a tag keeps your tracks. Tags can be hidden or reordered in Settings like other optional shortcuts.", ["#browse-tag-actions"]],
  ]};
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
