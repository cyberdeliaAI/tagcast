# Project instructions for Tagcast

## Scope and communication

- Tagcast is a local metadata editor and player for iBroadcast; it does not modify local
  music files.
- Communicate with the user in Dutch. Preserve existing English file, variable
  and function names, code comments and documentation.
- Examine relevant source code and tests before making changes.
- Remove existing functionality or substantially change the architecture or
  behavior only with explicit permission from the user.
- Distinguish established facts, assumptions and potential issues. Ask for
  clarification when missing information determines how to proceed.

## Architecture

The application consists of a Python server and a plain JavaScript frontend.

- `src/tagcast/app.py`: CLI, local HTTP server, API routes, OAuth callback and
  streaming proxy. Uses `ThreadingHTTPServer` and `SimpleHTTPRequestHandler`.
- `src/tagcast/client.py`: `StudioClient` for iBroadcast requests; `Studio` for
  OAuth, connection state, local storage, library caching, saves and read-back jobs.
- `src/tagcast/auth.py`: OAuth requests with timeouts; uses endpoints,
  PKCE helpers and `TokenSet` from `ibroadcast.oauth`.
- `src/tagcast/library.py`: `Record`, `Table` and `Library` read iBroadcast data;
  `plan_save()`, `write_requests()` and `verify()` handle save planning.
- `src/tagcast/sources.py`: external source adapters, matching, request pacing
  and a shared response cache.
- `src/tagcast/cleanup.py`: reviewed semicolon cleanup (including native album artists) and exact genre-label replacement drafts,
  account-scoped reports, bounded batches and explicit stop/resume with fresh checks.
- `src/tagcast/duplicate_cleanup.py`: explicitly analysed, account-scoped duplicate-copy
  drafts, reviewed track exclusions and bounded trash batches with persisted intent and read-back.
- `src/tagcast/updates.py`: public stable-release checks, version comparison and a
  daily persistent cache, independent of iBroadcast credentials.
- `src/tagcast/album_guide.py`: opt-in, explicitly started comparison with the bundled
  cleaned 1001 Albums reference; account-scoped local results, no iBroadcast requests.
- `src/tagcast/collections.py`: local account-scoped album favourites, native album ratings, private playlists, reviewed
  append/replace operations, and bounded metadata for explicitly chosen queued tracks.
- `src/tagcast/playlist_import.py`: bounded local CSV drafts, explicit column mapping, conservative
  loaded-library track matching, manual choices and reviewed single-use private playlist creation.
  `playlist_import_store.py` stores explicitly paused, account-scoped CSV checkpoints.
  `playlist_sources.py` performs bounded explicit reads of public Deezer and test ListenBrainz playlists.
- `src/tagcast/metadata_export.py`: explicit, read-only JSON / linked CSV ZIP snapshots of the loaded library,
  account/session/library-bound background preparation and private temporary streamed downloads.
- `src/tagcast/tags.py`: native tag browsing and reviewed creation, rename, deletion
  and per-album/track assignments, separate from genres and metadata saves.
- `src/tagcast/queue_sync.py`: opt-in server-side WebSocket bridge; extra OAuth queue
  scopes, sanitized account sessions, five-second reconnect pacing and controller roles.
- `src/tagcast/artwork.py`: image validation, base64 decoding and downloads.
- `src/tagcast/artist_bios.py`: opt-in TheAudioDB biographies, fetched only for a visited
  album artist and held in a separate bounded local SQLite cache.
- `src/tagcast/album_info.py`: opt-in TheAudioDB album background text for a visited
  album, with strict artist/full-title matching and a separate bounded SQLite cache.
- `src/tagcast/lyrics.py`: lazy native `gettrackuserdata` reads, an account/track-bound
  native text cache and a separate public LRCLIB SQLite cache; separately reviewed, single-use lyrics
  saves preserve all other native userdata and read back without ambiguous retries.
- `src/tagcast/static/`: HTML, CSS, SVG and shared JavaScript files:
  `app.js`, `metadata-export.js`, `genres.js`, `credits.js`, `lookup.js`, `updates.js`, `artwork.js`, `player.js`, `playback.js`, `album.js`,
  `album-info.js`, `lyrics.js`, `trash.js`, `artists.js`, `tracks.js`, `favourites.js`, `browse.js`, `overview.js`, `cleanup.js`, `collections.js`, `playlist-tools.js`, `playlist-order.js`, `playlist-import.js`, `tags.js`, `queue-sync.js`, `album-guide.js`, `help.js`, `navigation.js`. `album.js` provides album browsing;
  `trash.js` moves chosen tracks of the open album to iBroadcast's trash after a review;
  `artists.js` provides a searchable, paginated album artist grid using album
  summaries; `tracks.js` searches every track through `/api/tracks` (the demo
  searches its own albums) and plays or opens a result. Editing remains in `app.js`, and `player.js` owns browser-local playback and the queue independently of the editor. `navigation.js` gives every page a hash address
  (`#/track-artists`, `#/composers`, `#/genres`, `#/years`, `#/decades` and their group keys, `#/artists`, `#/artist/<name>`, `#/albums`, `#/album/<id>`, `#/tracks`, `#/favourites`, `#/overview`) and
  browser history; it loads last.
- `tests/`: unittest tests that also run through pytest, fixtures and
  `mock_ibroadcast.py`.
- `tools/build_dark_css.py`: generates `static/dark.css` from `static/style.css`.
- `tools/build_binary.py` and `tools/pyinstaller_entry.py`: build a stand-alone
  desktop launcher and CLI with `tagcast.spec`. `src/tagcast/desktop.py` owns
  only the local server it starts; the main interface stays in the browser.
  `tools/bundle_check.py` verifies extracted downloads with temporary settings.
  `.github/workflows/builds.yml` builds macOS (Apple Silicon and Intel), Windows
  and Linux archives and checksums. See `docs/native-builds.md`.
- `electron/` is the standalone desktop shell since 0.60.0; Python/source
  startscripts retain browser use. `tools/build_electron.py` freezes the same server
  with `electron/backend.spec`, packages the shell and verifies extracted apps with
  `tools/check_electron.py`. `src/tagcast/electron_host.py` owns/reuses only a matching
  local server, speaks bounded readiness JSON on stdout and stops on parent EOF.
  Keep the editor/player/static assets shared; never introduce a second frontend.
  The frozen `tagcast-cli` browser entry point shares the backend runtime and remains
  available in each download; keep extracted CLI help/version checks and Homebrew's
  terminal command working when changing the package layout.

The JavaScript files share a single global scope. Keep top-level names unique
and preserve a valid script order in `index.html`.
Start live boot and settings loading on DOMContentLoaded, after all deferred scripts have initialized
their shared browsing/player state; a fast local response can otherwise race them.

## Technology and coding conventions

- Source runs require Python 3.11 or newer; standalone downloads bundle Python.
  The desktop launcher uses Tk; normal source/CLI browser use does not require Tk.
- Runtime dependencies: `ibroadcast>=2.0.1,<3` and `websocket-client>=1.9,<2`; the code also uses `requests`,
  currently a transitive dependency of `ibroadcast`.
- Packaging uses Hatchling; the CLI entry point is `tagcast.app:main`.
- `pyproject.toml` contains dependency and lint configuration; `uv.lock` pins
  dependency versions for the uv workflow.
- Follow the existing naming and style: Python `snake_case`, JavaScript
  `camelCase` and existing class names.
- Ruff checks `E`, `F` and `I`; the configured line length is 100, with `E501`
  excluded.
- Preserve the existing frontend without adding a new build step or framework
  unless the user approves that architecture change.
- Do not edit `dark.css` by hand. Regenerate it after changes to
  `style.css`.
- `palettes.css` defines Ocean, Warm and iBroadcast inspired through named colour
  roles. Forest uses the original fallback colours. Keep palette selection
  (`tagcast-palette`) independent of Light/Dark/Auto (`tagcast-theme`), local to
  the browser, and restore before painting. The Theme disclosure contains both choices; opening it changes
  neither preference. Preserve outside-click and Escape dismissal and focus return.
  Preserve semantic warning/error colours
  and the same audio element when changing appearance.
- Keep package, `__version__`, sidebar footer badge and lockfile versions consistent;
  `python3 tools/release_info.py` checks them. Native build dependencies are
  separate in `requirements-build.txt`; runtime dependencies stay unchanged.

## Behavior to preserve

- The server binds only to `127.0.0.1`, on port 8912 by default.
- Preserve Host validation, the `X-Tagcast` POST header, Fetch Metadata checks
  for GET APIs and existing security headers.
  Serve local HTML/JavaScript/CSS with `Cache-Control: no-store` and ignore their
  conditional cache validators, including HEAD, so source updates cannot reuse older
  UI files with an unchanged version/timestamp. Keep normal caching for static
  reference data/images and the separate account-bound library cache.
- Tokens and source keys stay server-side and must not appear in frontend API
  responses or in the repository.
- Settings, tokens, cache and logs default to `~/.tagcast/`; `TAGCAST_HOME` can
  override this. Preserve existing migration support for the earlier name
  `library-studio`.
- New installations use Tagcast's public OAuth client ID and device-code sign-in,
  without a client secret or user-created app. Existing environment/saved client IDs
  and their tokens take precedence; switching to the default is explicit after
  Disconnect. Preserve browser-redirect sign-in for existing custom configurations.
- OAuth refresh has a per-client lock and shared in-flight result across JSON API,
  streaming and artwork uploads. Recheck token generation/expiry inside the gate;
  bind each request to its captured token so a late rejection never refreshes a newer
  generation. Share success/failure with waiting requests, preserve bounded auth retries
  and existing no-retry rules for ambiguous writes. Publish new credentials atomically;
  release the gate and wake waiters before token persistence, since queue actions may
  hold Studio.lock. Persist only the active client's current TokenSet so delayed callbacks
  cannot overwrite newer tokens or restore a disconnected/replaced session.
- The demo library remains a local preview and is never saved to iBroadcast.
- Library loading shows a global, accessible indeterminate progress indicator, independent
  of the dismissible information banner, on startup and explicit reload. Do not invent a
  percentage for the current whole-response API or add requests just to measure progress.
  Hide it on success, error, disconnect or local replacement; reject older load responses
  after a newer request/session so they cannot replace data or hide its indicator. Keep
  current audio and queue intact during an ordinary live reload.
- Long-running reviewed actions use a compact animated status line while requests and
  read-back are active. Keep the phase text accessible, respect reduced motion, stop
  animation on completion/error/reset, and never infer a percentage or add polling.
  Cleanup running reports and the Checking saves badge retain this subtle activity cue;
  full-library loading keeps its separate larger indicator.
- Tagcast starts on Album artists. Back and Forward follow the browser history;
  dialogs get no history entry, and Back never closes an open editor.
  Album details use a clickable breadcrumb for their browsing origin (artist, tag,
  genre, playlist or discovery page), with Albums as the direct-link fallback. Restore
  source filters, ordering, pagination and scroll; never infer a unique album hierarchy
  from its metadata. Invalidate remembered origins when the loaded library changes.
  The hero aligns cover/title at the top, groups distinct genre/tag chips with a persistent
  + Tag control, and uses neutral unset rating controls; Clear appears only for rated discs.
  More album actions contains Check album lyrics and Move to trash, opening the
  existing reviewed trash selection only on explicit choice. Menu dismissal/navigation
  never selects tracks or affects playback.
  A known release year in the hero opens the existing years browse group; unknown
  years stay plain text. Preserve the same displayed set year and existing browse semantics.
  At mobile widths (760px and below), show the cover at full available width above
  the album title, album artist, metadata and actions. Keep desktop cover/title alignment.
  Album background prose and artist biographies are limited to 85ch; attribution stays visible.
- Artist, genre and composer fields in the metadata editor offer local suggestions,
  with at most 40 choices in the DOM. Reuse native artist names and compact summaries;
  exact active genre labels and composer names are collected during the existing summary
  pass, cached per library copy and returned with library loads and album read-backs.
  Never fetch library/track details or write to populate/select a choice. Genre/composer
  selections add one whole chip, preserving stored semicolons; free typing retains Enter
  and semicolon delimiters, validation and explicit Split. Preserve credit IDs, main-genre
  order, keyboard selection, Escape/Tab dismissal, bulk gates and Various Artists.
  Invalidate the chooser on library/draft/catalogue replacement.
- Online suggestions fill the editor; metadata writes follow only after review.
  Artwork has a separate comparison and explicit save.
- Track lyrics have a separate textarea/review/save, independent of ordinary metadata
  patches. Now playing and the visited track read native userdata lazily; never scan
  lyrics automatically or read audio. Native lyrics take priority. LRCLIB is explicit, follows its source
  switch and validates full title/artist and known duration without dropping version
  text. Public results enter the bounded 30-day SQLite cache. Native lyrics text and
  empty results persist separately in native-lyrics.sqlite3 (5,000 rows / 20 MiB text,
  no timed expiry), keyed by account, native track ID and exact track/album identity.
  Other native/custom userdata and review tokens stay in memory. Premium saves bind one track/account/session and the full
  userdata snapshot, recheck fresh membership/userdata, preserve unknown custom fields,
  consume the review before sending once and verify text plus unchanged custom data.
  No automatic retry or metadata Undo; blank reviewed lyrics remove only that field.
  Album track titles show a subtle Lyrics button only for already-known, nonempty
  text in the current account/session/library cache. Its modal reads that same text
  without requests, playback or history changes; preserve focus and source attribution.
  Refresh only label slots when text arrives; hide missing, stale or invalidated results.
  Free accounts retain native/public reading and explicit LRCLIB lookup, while lyrics
  editing/copy/review/save controls and Premium streaming choices are hidden.
  Explicit Check album lyrics in the album's More menu reads only the open album/set,
  at most 100 distinct loaded tracks, one at a time. Reuse successful/negative results
  without a timer in the bounded memory cache, backed by the separate native text cache; no
  provider searches, writes, playlist checks or automatic scans. Coalesce a concurrent
  per-track read, update label slots/progress without rebuilding the album, and stop
  before the next request on Stop, navigation, replacement, source changes or errors.
  A library/account/session replacement invalidates browser memory, while unchanged
  account/track identities can reuse saved text across restarts. Opening one album
  reads only its bounded local cache, never iBroadcast/providers; restore only current
  identities without replacing fresher/in-flight results. Restore again on a new album
  visit after memory eviction; do not retain an unbounded per-album restoration index.
  Source invalidation releases pending browser reads; late replies cannot clear or
  overwrite a newer read. Explicit per-track Check
  iBroadcast again bypasses the native cache. A disk-cached edit first rereads native
  userdata, preserves the typed draft and blocks review if lyrics changed; review/save
  still use fresh complete snapshots. Invalidate saved text before sending any lyrics
  write, restore only confirmed read-back, and retain no stale cache after uncertainty.
- Album lyrics sidecar import is an explicitly reviewed album-local extension to
  individual lyrics saves. Keep tracks on the left, selected LRC/TXT files on the
  right, and match only unique track-number/full-title combinations (optional disc
  prefixes); preserve version text and leave ambiguities manual. Files, links and
  text stay in browser memory until explicit review. Bound to 100 tracks/files,
  5 MB total, 500 KB/file and 50,000 text characters. Decode UTF-8/BOM-marked UTF-16;
  remove timing/metadata markers and store ordinary text. Review fresh native text
  for linked tracks only, keep existing lyrics by default and require per-track
  replacement choices. Reuse existing single-use per-track prepare/save gates,
  with a complete displayed album/set membership/identity/combine snapshot checked
  before writes. Serialize browser requests, preserve unknown userdata, read back
  each write, stop after conflicts/errors/unconfirmed results or explicit Stop,
  and distinguish confirmed/kept/unchanged/blocked/not-sent/unconfirmed results.
  Never automatically retry uncertain saves, contact LRCLIB, read audio or write
  local music files. Invalidate late reads/results on library/account/navigation
  changes; warn before discarding unsaved imports, preserve focus/history/playback,
  keep local Help and respect free-account save restrictions.
- Tracks go to iBroadcast's trash (`trash`) from the album page after its trash
  review, from a reviewed selection of complete albums in the album overview or an artist's page, or
  through the dedicated reviewed duplicate-copy batch workflow. The server
  first checks active membership. Never delete permanently.
- Complete-album selection trash is separate from metadata saves and duplicate suggestions.
  Load details only for the explicitly selected sets and review all albums/tracks before
  confirming. Send bounded batches of at most 20 displayed sets / 500 tracks to
  `/api/trash/albums`; reject stale names/titles, added/missing tracks, changed combine
  settings and partial merged sets. Complete-album trash selections can span artists;
  metadata editing remains limited to one album or one album artist. Selection survives
  paging/filter changes; flag selected albums outside the current results. Read back each batch before
  proceeding; stop on request errors, unconfirmed results, close or library replacement.
  Keep sent/confirmed/blocked/unverified results in trash History without metadata Undo;
  restarting or reopening never resumes writes automatically. A single set over 500
  tracks must be handled through reviewed smaller track selections on its album page.
- The Duplicate tracks filter includes repeated positive track numbers within one
  disc, even when titles differ. Summary `repeated_numbers` counts the extra numbered
  positions, per disc; merging discs sums these counts without comparing across discs.
  Within a native combined view, also keep the track's original `album_id` in the
  comparison key so separate original discs are not flagged or preselected together.
  Album grid/list badges use the same predicate as the filter and show Duplicated.
  Repeated positions also show Duplicated on track rows; tooltips distinguish matching
  and differing titles. Matching normalized titles contribute to `duplicates`. Title comparison ignores
  case, spacing and straight/curly quotation marks; retain version text and punctuation.
  Repeated titles at different positions or on different discs are not duplicates;
  missing numbers are not matched. Select extra copies keeps its stricter number/title
  rule and the first candidate; differing titles require manual selection. Every trash
  operation still requires review; metadata cannot establish audio identity or quality.
  Trash mode also presents optional format/date suggestions within these per-disc
  repeated positions: prefer FLAC over MP3, then newest upload within the same format.
  Keep unresolved ties and missing-date candidates; do not rank unknown/incomparable
  formats or different artists/durations (>2 seconds). Differing titles require
  complete artist/duration metadata and a visible comparison notice. Opening never
  preselects; Select suggested copies is explicit and remains adjustable before review.
  Show stored upload dates/times and day/format groups only from loaded album details;
  do not scan audio or fetch tracks to build suggestions. Keep uploaded_on day precision
  for set grouping; uploaded_at preserves validated date/time without inventing a timezone.
- The cross-album duplicate workflow is a narrow reviewed exception to album-only trash.
  Opening only reads the saved account-scoped `duplicate-cleanup.json`; explicit analysis
  compares the server's library metadata using the same rules as `trashSuggestion`
  (shared Python/JavaScript contract fixtures). It covers the whole library independently
  of frontend filters/paging, leaves uncertain copies, and allows album/track exclusions.
  Approval is explicit before processing, including on resume. Keep batches within
  200 tracks / 20 displayed albums, serialize against other saves, validate all copies
  and position membership (including keepers) before each batch, and read back afterwards.
  Stop on conflicts, connection/account/combine-setting changes, request errors or
  unconfirmed results. Persist intent before each POST; resume checks outstanding
  intent without resending any unconfirmed request. `trash` transport never retries
  ambiguous failures. Save/export a separate local report; no automatic metadata Undo.
  Never fetch audio, send all library tracks to the browser, or execute when opening
  or analysing. The page-local modal preserves playback, history, focus and scroll.
- A normal editor metadata save remains limited to one album or one album artist.
  Only changed, supported fields are sent.
- A single-album/set editor has Edit album / Edit tracks tabs in the existing dialog.
  Keep both panels in the same metadata form, preserve DOM inputs and drafts on tab
  changes, and include both in the existing review. Tabs make no requests/history or
  playback changes; keep keyboard arrows/Home/End and reveal invalid fields before
  validation. Track selection uses an independently scrolling list beside one form,
  stacked on mobile, retaining disc headings and the separate lyrics review. Bulk
  artist editing keeps its shared fields without individual-track tabs.
- Compare `before` values with the current library view before writes.
  Verify accepted writes afterwards through a fresh library download.
  Preserve the distinction between sent, confirmed, unconfirmed, failed,
  not sent and blocked.
- Saves are not transactional. Preserve error handling for partial saves and
  stop subsequent metadata requests after a request error.
- `create_artist` is not automatically retried after temporary failures.
- Album year edits change track years only when the user chooses that option.
  Individual track edits take precedence over album-wide edits.
- Genres: the first label goes to `genre`, the rest to `genres_additional`.
  Editor, legacy single-genre writes and cleanup accept at most 200 Unicode code points per
  label, 20 labels per track. Reject oversized input visibly and retain it; never truncate.
  Split existing combined labels only on request.
- `credits.js` edits separate native album artists and track additional credits. Keep
  primary artist fields separate; never infer separators in names. Preserve native IDs,
  order, unknown existing roles and optional phrases until explicitly changed. Track roles
  are artist, band, composer, lyricist, conductor, publisher, involved_person,
  original_lyricist and original_artist; album additions allow artist/band. Validate
  at most 100 additional credits and 1000-character names/phrases. Full track credits
  override the album-wide composer shortcut only for that track. Review before writing
  artists_additional, create missing names only for unblocked reviewed records, and
  read back IDs/roles/phrases. Combined-set restrictions still block album changes.
  Compact summaries include every album artist for browsing, native stars, local hearts
  and images; distinct additional album-artist IDs keep disc sets separate.
- Cleanup is a dedicated reviewed exception to normal save scope: semicolon
  splitting for genres, album artists, track artists and composer credits, plus explicitly reviewed
  exact genre-label replacements/removals across the active library. Never infer
  slash/comma boundaries or remove ambiguous text automatically. Empty replacements
  require explicit removal mode; preserve other labels and promote the next label
  to main, or clear both genre fields if no labels remain.
  Preserve per-track values, credit roles/phrases and primary IDs when unchanged.
  Album artist cleanup writes one native album/disc at a time through update_album:
  first primary name stays primary, remaining names become additional artist credits.
  Preserve existing separate credit IDs, roles and phrases; split only performer roles.
  Review every proposed disc with explicit primary/additional labels, keeping merged-disc
  exclusions together. Validate complete active disc membership, album identity, native
  artist names/IDs and combine_sets before writes; combined sets block album cleanup.
  Count affected tracks toward batch limits; block a native disc over 200 tracks for
  individual editing. Track metadata stays unchanged. Never infer other separators. Persist the
  account-scoped draft/report in cleanup.json; never send it to another account.
  Limit batches to 200 tracks / 20 displayed albums, check before writes and read
  back after every batch. Stop on conflicts, request errors or unconfirmed writes.
  Resume explicitly and recheck outstanding writes; never retry create_artist blindly.
  Keep normal editor scope validation intact. Additional performer IDs participate
  in browse, search and links independently of composers and other credit roles.
- Composers use `artists_additional` with type `composer`; preserve other
  credits. An artist marked `trashed` can still be a valid album artist.
- Native iBroadcast tags are separate from genres. Cache only tag names, track IDs
  and archived flags. Show loaded album tags alongside distinct genre chips in the
  hero, with a persistent + Tag control for the existing reviewed manager. Never add
  reads or writes just to choose the display. Preserve partial/archived chips and track controls.
  Upgrade caches missing tags with one explicit feature read.
  Browse Tags by ID, including empty tags and archived labels, using the same active
  membership and merged album counts as other browse groups. Never send complete tag
  track lists to the browser. Album/track tag management reads compact counts and
  prepares explicit add/remove operations; Keep as is preserves partial assignments.
  Scope assignments to one complete displayed album/set or one of its tracks, at most
  500 tracks / 20 tag operations, checking account, full album membership, tag names,
  archived flags and assignments before sending. Preserve all outside memberships.
  Archived tags cannot be added here because they can hide music; do not archive or
  unarchive automatically. Create makes an empty label; rename/delete explicitly review
  their global scope, including hidden/trashed memberships. Delete only the tag, never
  music. Use documented createtag/tagtracks/updatetag/deletetags payloads, serialize
  against other saves, stop subsequent requests after errors and read back all writes.
  Never retry ambiguous tag writes or create metadata Undo entries. Keep partial,
  not-sent and unconfirmed results distinct. Tag dialogs preserve playback, history,
  focus and scroll, reject late reads/writes after library replacement, and have local
  Help. Invalidate loaded tag metadata and browse indexes after checked writes.
- With `Combine Multi-Disc Album Sets` enabled, album changes are blocked;
  track changes can proceed. The cache must match this setting.
- With that setting off, the album lists and the album page show the discs of a
  set (same title, album artist, album year and active-track upload-date set, different disc numbers) as one album
  (`albumShelf`, `mergeDiscs`); every write still goes to the disc's own album.
  Never offer one disc number for two discs of the same set. A set's cover is
  saved disc by disc (`/api/artwork` per disc, reusing the first upload's
  `artwork_id`), with one History entry per disc.
- Preserve compact album summaries, lazy track details and caching keyed by
  account, `lastmodified` and `combine_sets`. Track search runs on the server's
  library copy (`Library.search_tracks`, at most 1,000 results); the browser never
  loads every track.
- Album artists and Albums each have one shared Filter and sort menu with independent
  Sort/Show choices, retaining the existing hidden filter/order values for history and
  discovery links. Show active checkmarks and both choices on the trigger. Omit zero-count
  filters except All; counts use loaded artist groups or the merged album shelf within
  the current artist scope, before text search. A selected filter can remain active
  when its count drops to zero; keep All reachable without silently resetting search.
  Remove the former no_genre/fewest/most sort choices and fall back to artist ordering
  for their old history states. Opening/dismissing never adds history or fetches data.
  Preserve keyboard arrows/Home/End, Enter/Space, Escape/Tab dismissal, outside click,
  focus return and touch scrolling. Close on navigation/library replacement; ignore
  stale menu choices without changing playback, selections or metadata.
- Collection, album artist and browse group totals emphasize albums, with track
  counts shown smaller underneath. Reuse existing summary and group counts;
  never download track details or add requests just to display these totals.
- Playlist browsing offers browser-local cards/list layout, independent of album layout.
  Switching uses the current response, preserving search, paging, navigation and audio.
  List totals use loaded-library active playlist positions (including repeats), with
  unavailable positions and missing duration reported separately; folder IDs are never
  counted as tracks. Summarize only bounded catalogue pages, without extra downloads.
  Playlist/folder browsing and destination choices reuse the loaded account library,
  without a remote status request on opening, searching or paging. Upgrade an older
  cache missing playlists once. Reload library and existing write read-backs refresh
  that shared copy; all write preconditions still use a fresh remote revision check.
  Reviewed name/description-only edits send only changed text fields via updateplaylist,
  never tracks, retaining every native position, cover and playlist type. Bind these
  reviews to session and the complete before snapshot, serialize saves, never retry an
  ambiguous write, and read back both text fields plus unchanged membership and artwork.
  Unchecking tracks retains the separate full replacement review and its limits.
- Playlist reordering is a separate local dialog/draft, limited to 2–10,000 stored
  positions. Keep repeated and unavailable positions distinct using their original
  indices; never deduplicate or validate unavailable IDs as new additions. Drag handles
  show before/after insertion lines; Up/Down and Move to position provide keyboard/touch
  and cross-page alternatives. Search this draft by title/artist/album through loaded
  server metadata, returning only original position IDs and at most 100 row details.
  Apply matches to the current local permutation, preserving unsaved moves and hidden
  positions. Result numbers, arrows, drag and Move to position use the complete draft.
  Search never saves or reads remote state; reject late queries/pages and retain focus.
  Show at most 100 row details and retain only that page's
  metadata, fetched from the loaded library without remote status reads. Focus/reveal
  the moved position. Save order is explicit and sends a complete index permutation
  plus the account/session/full playlist snapshot; recheck fresh native state, serialize
  writes, send updateplaylist with tracks only and no retry, and verify exact order,
  repeats, membership, name/description/type/system/artwork. Reject folders/system lists,
  stale snapshots, missing/duplicate indices and unchanged order. Cancel/Close discards
  local moves, navigation/library replacement invalidates late results, and uncertain
  sends cannot replay. No playback, queue, metadata history or music-file changes.
- Playlist row removal reviews one original stored position and track ID, not a filtered
  row index or every matching ID. Preserve repeats, unavailable positions, all other order
  and playlist metadata. Bind to the full account/session snapshot, recheck native state,
  serialize the tracks-only update without retries and verify the exact result. Limit to
  10,000 stored positions; retain search/paging and leave library tracks and playback alone.
- Playlist detail search filters title, artist and album across all loaded playlist positions
  on the server, returning at most 100 row details. Preserve original active position numbers,
  repeats, full totals/duration and full-playlist editing/playback; above 10,000 positions,
  playback uses only the displayed result page. Search makes no remote library/status reads
  or writes, preserves focus/history and rejects stale replies.
- Playlist details show the duration of all active playlist positions from the loaded
  server library, including repeats across pages; flag missing durations explicitly.
  Playlist covers and the larger rounded-square artist-page photo open the existing
  artwork comparison through an image overlay on hover/focus, always visible on touch.
  Artist overview cards only open albums; they have no image-editing action.
  Edit the native identity supplying the displayed image. The artist-page header shows
  only its photo; its album count remains above the album list, without a track total.
- `browse.js` provides Track artists, Composers, Genres and Release year. Index
  active displayed album membership on the server, lazily per library copy.
  Track artist/composer selections use IDs; genres use stored main/additional
  labels without automatic splitting. Years use track year with album-year
  fallback and an Unknown year group. Cards open matching albums (one matching
  track is enough); the API sends album IDs, and the frontend reuses album
  summaries, merging discs and paginating locally. Preserve exact group membership,
  browser history, genre links and stale-response guards across library changes.
  Card album counts match the merged shelf; duplicate disc numbers remain separate.
- Settings also offers full loaded-library metadata export as JSON or a ZIP of linked CSV
  tables, separate from browser-local Export changes. Prepare only on explicit choice,
  then download a private temporary file without buffering all tracks in browser JS.
  Preserve native album membership/IDs, separate ordered credits/roles/phrases, exact
  stored genres, ratings and upload precision. Optional loaded tags/playlists and
  account-local saved favourites report missing/unavailable data; never fetch library
  details, migrate favourites or write to iBroadcast to prepare an export. Exclude
  tokens, source keys, signed URLs, settings and provider prose. Keep CSV null/text
  encoding reversible and spreadsheet formulas escaped. Bind jobs/downloads to the
  captured account, client, playback session, library copy/revision and combine setting;
  reject stale results. One preparation / two retained jobs, 15-minute expiry,
  explicit cancellation and shutdown cleanup; preserve audio, drafts and history.
- Online metadata/artwork sources are selected by default; Settings persists a validated
  `disabled_sources` list. Keep user selection separate from key availability, preserve
  saved/environment keys, skip disabled sources in automatic/manual/image searches and
  reject direct provider lookups server-side. Invalidate in-flight suggestion channels
  after source preferences change. Biography/album-information opt-ins remain separate.
- Settings contains online sources/keys, playback recording, update checks and
  Export changes under Change history. Export downloads the same browser-local JSON
  history as the History dialog, never submits settings and is disabled when empty;
  keep it out of the topbar. Electron's Help menu opens the GitHub Wiki, r/Tagcast
  and the repository home through the existing HTTPS external-link handler. The
  library information banner is dismissible with a browser-local remembered preference
  and can be restored in Settings. Never hide other warnings or errors with it.
- Help uses a compact **?** button to start only the current page or dialog’s
  read-only tour; there is no topic chooser or automatic start. Scope highlights
  and explanations to that context, including distinct editor/review/chooser help. Use a native modal
  spotlight above existing dialogs, preserving drafts, playback, queue and history.
  Dialog Help and Close share the right-aligned dialog-heading-actions group; the
  circular Close icon uses centered CSS strokes, independent of font metrics.
  Hidden/missing controls get explanatory fallback text; never enable a feature,
  navigate, fetch data or invoke writes just to demonstrate it. Preserve keyboard
  dismissal, focus/scroll return and close Help on navigation or library replacement.
- The mobile sidebar is a disclosure menu; its open/closed state adds no history
  entry. Keep connection and source settings reachable and support Escape.
  Browser-local `tagcast-sidebar` preferences hide optional shortcuts and reorder
  navigation in DOM/keyboard order. Album artists, Albums and Change history cannot
  be hidden; connection controls and Settings remain outside customization. Hiding
  a shortcut never disables its feature or changes the current page/audio. Preserve
  opt-in gates for Recently played and 1001 Albums, support restoring defaults, and
  ignore unknown/duplicate stored IDs. Routine updates preserve focus and scroll.
- Decades reuses the browse indexes and effective track/album years. Exclude unknown
  years, use full decade labels (1980s, 2020s), sample merged album summaries locally
  without duplicates, and preserve the random order on Back. Surprise me again
  reshuffles without downloading tracks or writing to iBroadcast.
- The 1001 Albums discovery page is off by default (`album_guide` in Settings); this
  preference controls its page/shortcut, not offline album background text. Enabling or opening only
  reads the saved report; analysis requires an explicit button. Compare loaded album
  metadata locally, never audio, external sources or individual track details.
  Preserve meaningful title/version text; fuzzy results remain possible matches and
  do not count as found. Count each reference entry once, merging displayed discs.
  `album-guide.json` is scoped to the account, library revision, combine setting and
  catalogue hash. Stale reports require explicit reanalysis; unknown revisions cannot
  be reused across server restarts. Disable/reset and reject late responses across
  library/account changes without changing playback. Reference corrections retain
  entry order, stable IDs and the original selection hash; log original/final values
  and sources for reviewed title/artist/year corrections. They never modify the
  original CSV or the user's metadata.
  Explicit manual links use `album-guide-links.json`, scoped by account and original
  reference selection. Confirm a candidate or search compact album summaries to
  choose one displayed album/set; never fetch tracks or write to iBroadcast for it.
  Preserve links across reanalysis and spelling repairs, compare previous links to
  reject concurrent changes, and support change/undo. An unavailable linked album
  must not silently become a different match. Manual links count as found only while
  all linked discs remain active. Keep distinct numbered volumes out of fuzzy matches.
  Compact decade filters and ascending/descending year sorting use reference years,
  combine with status/search before pagination, and survive Back/Forward without
  triggering analysis or extra library requests.
  The page-local **Show matching details** checkbox remembers its display preference
  in local server settings (`guide_matching_details`), surviving restarts, ports and
  browsers; retain browser storage as an immediate fallback for earlier servers.
  Serialize changes and ignore late reads after a local choice. It controls status
  labels and link controls only. Hiding them never changes
  reports, links, counts, filters, editions or playback; restore the same controls
  by re-enabling the checkbox. Keep missing-cover styling independent.
  Bundled background excerpts live separately in `1001-album-notes.json`, with
  Wikipedia/CC BY-SA attribution and an accompanying license notice. Capture only
  explicit Wikipedia-attributed summaries, never reviews or book excerpts, through
  the manually run `tools/import_album_notes.py`. Keep our reference IDs/selection;
  unique normalized artist/title pairs may import automatically, fuzzy/ambiguous
  candidates require reviewed source links and an unresolved report. Runtime never
  contacts external sites for notes. Lazily load the local file once and show an
  escaped, collapsible About this album above tracks independently of the discovery
  setting. `/api/album-guide/album` validates the visited active album/session/identity
  and checks only that album against a lazily indexed local catalogue using existing
  exact title/artist normalization (including safe edition suffixes), never fuzzy matching.
  Honour account/selection-scoped explicit manual links only while all linked discs
  remain active; a manual copy choice overrides the automatic identity. This per-album
  read never scans the library, reads/writes the full report, starts analysis, downloads
  track details or contacts iBroadcast/external sites. Preserve independent explicit
  analysis/counts semantics and source/license links; cache visited identities only in
  bounded browser memory and reject late results across identity/session/library changes.
- By default the play queue stays in browser memory. Explicit Play replaces it; Add to queue
  appends a single track or all discs of an album, preserving click order. Store
  each queued track's album metadata for covers and navigation across albums.
  Clear queue stops audio and cancels pending additions. Guard lazy loads against
  library changes and clears. Now playing opens without a browser history entry.
  Now playing offers one Remove from play queue button per stored position, replacing
  its number on hover/focus and always visible on touch. Keep it separate from the
  row's Play button, keyboard accessible and bound to the rendered entry/revision.
  Removing another position preserves the current audio/time and adjusts its index;
  removing the current position selects the following entry, preserving paused state,
  or pauses on the preceding retained entry if none follows, keeping the queue reachable. Removing one of
  several identical track IDs affects only that occurrence, including Up next.
  Preserve focus/scroll, queue-sync player/controller ownership and the stopped state;
  never edit saved playlists, library metadata or music files for queue removal.
- Fullscreen Now playing reuses the existing audio element and queued metadata.
  Opening or closing never restarts audio or adds a history entry. Request native
  fullscreen only on a click; fall back to a window-filling view when unavailable.
  Escape, stopping and library replacement close it; restore focus and inert state.
  Settings offers Fullscreen (existing default) or In app window, remembered locally
  in `tagcast-player-view`. Apply on the next opening without requests or audio/queue
  changes. In app window never requests native fullscreen or exits another element's
  fullscreen session. Keep button labels and the Settings Help explanation aligned.
- Covers in grids/lists open the album immediately; compact-player covers immediately
  open Now playing. Enlarge covers only from the album detail page: double-click
  its real cover, or use Enter on its cover button, to open a modal lightbox.
  Other covers have no enlargement tooltip or action. Load larger known iBroadcast
  artwork only when opening, with one fallback
  to the existing image. Keep other provider URLs intact. Escape, close and backdrop
  dismissal restore focus without changing audio, the queue or browser history.
  Close on library replacement; cancel pending cover clicks on navigation. Preserve
  fullscreen focus handling when a lightbox is above Now playing.
- Play random album uses all filtered merged albums, before paging or the decade
  display sample. Load only the chosen set, play from its first track and replace
  the queue. Avoid the current album when alternatives exist. Clear, explicit Play
  and library changes cancel pending random playback; previews cannot play.
- On the album browser, hide random playback for every cleanup/edition filter and
  while albums are selected. All albums and browse discovery groups retain it.
  Compact, aligned Play and + menu buttons on album cards/lists let the user play
  one chosen complete set without navigation. Load only that set, replace the queue
  explicitly and cancel pending playback on clear, another Play or library replacement.
- Album-detail tracklists omit the album artist from performer credits and render no
  empty metadata line. Keep distinct track artists/additional performers, composer
  credits, tags and format exceptions; tag management remains in row actions even
  without tags. Derive a common stored format from loaded tracks only, flag differences
  in amber and identify ties/incomplete data honestly. Search/favourite tables keep
  their own format labels. Cleanup mode retains per-track formats and upload advice.
  Playing rows replace the number with a speaker and a quiet background, without
  recolouring the title or credits. Mouse hover and focus-within reveal actions;
  filled/pending favourite hearts and expanded queue triggers remain visible. Never
  remove keyboard focusability to hide actions. Always show actions with hover:none
  or coarse pointers; preserve normal playback, queue menus, tag dialogs and trash checks.
- Player album artist and album title links open their respective pages. Show a
  third line only for a different track artist; its ID links to matching albums.
  Keep track artist in MediaSession metadata.
- `playback.js` owns optional output selection and Media Session controls for the same
  audio element. The speaker cabinet icon opens Sound with an accessible volume slider and mute
  button above output selection on every platform. Keep these synchronized through
  volumechange, use the actual audio volume/muted values and acknowledge rejected
  changes with a system/device fallback. Never restart audio, request permissions or
  change the queue for volume; keep native controls available. Tint the native panel from the
  shell palette where supported, with a dark native fallback; never replace or hide controls
  for appearance. Do not persist volume
  or change it on opening. Discover permitted output devices only on explicit dialog opening
  or device changes while open; never request microphone access. Feature-detect the
  output picker, sink selection and native AirPlay picker, with system sound settings
  as fallback. Never restart/resume audio or change source/queue when switching outputs;
  reject late picker results after closing, stopping or library/queue replacement.
  Keep device IDs out of persistent settings. The output dialog works inside fullscreen,
  preserves focus/history, and has local read-only Help. Register supported system
  play/pause/stop, previous/next and seek actions independently; keep metadata, state and
  bounded position current. Stop clears the queue. Clear handlers and metadata on stop,
  library replacement or queue-sync controller role; stale handlers must not play audio.
- Artwork uses JPEG, PNG, WebP or GIF, up to 15 MB. Preserve checks for local
  addresses and redirects. Album covers are applied to active tracks;
  undo retains previous artwork IDs per track.
- Track format labels reuse the stored MIME type in album details, search and
  favourites. Omit unknown formats; never download audio or infer bitrate/resolution
  just to show a label.
- Playback goes through the local server, supports Range requests and does
  report no plays by default. Optional `record_plays` in Settings sends the documented
  `history` payload after more than ten seconds of actual listening, excluding pauses,
  buffering and seeks. Bind events to the current playback session and library;
  deduplicate local requests and never automatically retry an ambiguous history write.
  Use cached membership; never download the whole library per play. Keep these events
  separate from metadata History. Tagcast itself does not send Last.fm scrobbles.
- Recently played appears only with optional iBroadcast play reporting enabled. Read
  the native playlist by type `recently-played`, never its display name. Preserve
  its ordering and unique track IDs; omit trashed or missing tracks and do not
  invent play timestamps. Keep only this ID list in the account-scoped library
  cache, upgrading older caches on first use. Search/paginate on the server;
  check on page opening and explicit refresh, never on each playback. Hide/reset
  the page when disabled, guard late responses across library/session changes,
  and keep audio unchanged. Metadata saves use Change history separately.
- Track favourites use native ratings (`ratetrack`, `track_id` array): 5 to like,
  1 for thumbs-down, 0 to clear either control. Dislikes neither skip nor trash tracks.
  Active/pending thumbs-down controls remain visible alongside active hearts. Ratings >= 5 appear as favourites; lower nonzero ratings require
  frontend confirmation before replacement. Compare the displayed rating before
  writing and read back afterwards. These writes are separate from metadata
  History/Undo. `/api/favourites` searches and paginates on the server; never load
  every favourite into the browser. Invalidate pending frontend results when the
  library/session changes.
- Artist hearts are local account-scoped favourites in `artist-favourites.json`, keyed
  by native artist IDs. A named group is a favourite only when all its active album
  artist IDs are marked. Validate the session, exact name, complete group membership
  and previous heart before atomic writes and read-back. Preserve inactive IDs and
  other accounts; malformed files must not be overwritten or prevent library loading.
  Reuse compact album summaries for the Favourite artists filter and card hearts.
  Use the shared SVG heart on artist buttons and cards, with a 44px button hit area;
  do not render platform-dependent heart text glyphs.
  Never change native ratings, album/track hearts, metadata History or playback.
  Metadata/tag detail-cache replacement alone must not discard a confirmed local
  heart reply for the same account/generation; always retire its pending state.
- Native artist stars use documented `rateartist` with scalar `artist_id`, 0–5,
  scoped to one exact displayed artist group and at most 20 native IDs. Validate the
  account/session, full active group and previous ratings before writing, serialize
  saves, stop on the first error and never retry ambiguous artist writes. Read back
  native ratings through the existing compact result job; missing artists cannot
  confirm a cleared rating. Keep sent/uncertain/not-sent results distinct, suppress
  late frontend responses, and never toggle local hearts or metadata History.
  Compact album summaries/details include native `artist_rating` and the latest
  validated active-track `uploaded_at`. Keep existing day-based `upload_dates` set
  grouping unchanged and never invent missing timezones or clock precision. Album
  sorts support rating and Date uploaded in both directions, using all displayed
  discs, with unknown/unrated entries last and stable name tie-breakers. Artist and
  favourite-artist sorts use native artist ratings (minimum for mixed named IDs),
  independently of album stars. Upload-date sorting belongs only to albums.
  Derive all sorting data from loaded summaries; never fetch details for sorting.
  Album-rating read-back invalidates copied multi-disc shelf ratings (including
  partial results) and refreshes visible album ordering. Confirm unnamed native
  artists by their displayed identity while still rejecting missing records.
- One Favourites sidebar shortcut opens a shared heading and accessible Tracks, Albums
  and Album artists tabs. Retain the existing track/album routes and add
  `#/artist-favourites`; all three mark the same shortcut active. Preserve each list's
  search, ordering, page and Back/Forward state independently, including when visiting
  playlists. Keep track pagination on the server and derive album/artist lists and
  counts only from loaded compact summaries. Switching tabs never changes hearts,
  ratings, audio or the queue and never fetches track details or biographies. Migrate
  the former separate album-favourites shortcut without losing access when either old
  shortcut was visible. Arrow keys and Home/End select tabs; all work on touch.
- `artist_biographies` is off by default. Enabling does not scan or fetch. Visiting one
  album artist first reads `artist-biographies.sqlite3`, then looks up only missing or
  expired text through the shared paced free TheAudioDB adapter. Cache English public
  text by source, strict artist name and language for 30 days; missing/ambiguous text
  for one day. Bound cached text to 20 MiB / 5,000 entries and back off on source errors.
  Never fetch track details or contact iBroadcast for a biography. Use exact name matches;
  leave multiple matches unresolved. Strip provider HTML, escape display text, preserve
  attribution and construct the provider link from its numeric ID. Reject late results
  after settings, account, session or library changes. Cached text and source/cache errors
  must not block albums or playback. The disclosure adds no history entry and preserves
  focus and expansion through routine updates and Back. No shared Premium key is bundled.
  Retire stale biography entries after metadata/tag detail-cache replacement;
  recover only the visible unchanged artist, leaving hidden artists lazy. Never
  look up empty stored names via display placeholders. Provider failure backoff
  exposes a bounded retry_after; disable retry until it expires without fetching
  automatically or bypassing shared pacing.
- `album_information` is independently off by default. Enabling alone never scans or
  fetches. A visited album reads `album-information.sqlite3` first; only missing/expired
  text starts a provider request. Send only its stored primary artist and full album
  title, never display placeholders, credentials or tracks. Preserve accents, punctuation,
  numbered volumes and version text when matching; require one exact artist/title result.
  Cache public English text by source, strict identity and language for 30 days, negative
  matches for one day; bound to 5,000 records / 20 MiB plus SQLite overhead. Share source
  pacing with artist biographies and suggestions, coalesce simultaneous lookups and back
  off for one minute on failures. Keep cached text visible during refresh and explicit
  retry; errors never block albums/playback. Strip HTML and escape text, construct numeric
  provider links, preserve source attribution and 85ch prose. Reject late results across
  settings, account, library, session or identity changes; recover only the visible same
  album after detail-cache replacement. Preserve disclosure/focus on routine updates and
  Back. Available confirmed 1001 Albums texts take priority with their licenses unchanged:
  wait for the independent local visited-album identity check and bundled notes before
  reading/requesting TheAudioDB text, even when discovery is disabled or has never been
  analysed. Fall back only when no valid note is available. A matched TheAudioDB album
  without English text is distinct from a missing album and keeps its numeric source link.
  Hide cached/late TheAudioDB results and disallow retry while a guide text has priority. No metadata or
  artwork writes, bulk prefetch, new API keys or Premium integration follow from enabling.
- The original Powered by iBroadcast SVG is displayed with its original colours and
  proportions. Keep Tagcast's independent identity explicit; do not imply endorsement.
  The sidebar header shows Tagcast with an accent-coloured dot and the small, muted
  Metadata editor & player subtitle directly below the name, alongside the icon.
  Omit the for iBroadcast subtitle. Keep the version beside
  Settings at the bottom and the original Powered by logo on its right; Reload library
  and Disconnect share the row above. Keep these controls outside sidebar customization.
  Render the entire version as neutral text without a pill background, including in
  dark mode. The account status uses regular weight. The vendor logo is 78px wide,
  preserving the source SVG, original colours and aspect ratio.
  Album artists uses a microphone, Genres a label and Tags a hash icon. One heart
  shortcut opens all three favourite lists.
- Streaming quality is a local server setting (`stream_quality`), default 128. It
  applies on the next track; show it separately from the stored file format. Original
  playback may fall back to 128 once, preserving the listening event and marking the
  fallback. Require Premium for every choice other than 128; keep all stream tokens server-side.
- Native album ratings use scalar `album_id` with `ratealbum`, one request per disc of
  one displayed set. Check the current rating before writing and read back each disc;
  do not add metadata History entries. Album hearts are independent local favourites,
  persisted per account in album-favourites.json. On first use, import existing active
  five-star albums once; preserve an empty account entry so later ratings never reimport.
  Heart changes never write to iBroadcast or change stars; star changes never toggle hearts.
  Share favourites through the local server/settings folder, not browser storage. Check
  session, loaded account/library, displayed set and previous heart values before atomic
  local writes; preserve other accounts and inactive IDs, and read back before confirming.
  Use original disc IDs inside native combined views. A set is a favourite when all its
  discs are marked. Report file errors without replacing damaged data or blocking library
  loading or star ratings. Ignore late frontend responses after library/account replacement.
  Track favourites retain their existing native rating behavior.
  Show requested ratings/hearts immediately as saving/checking; update confirmed
  cached ratings only after read-back. Rating jobs return only their results, without
  serializing the full album index. Keep playback intact and suppress stale results.
- Playlists use native create/append/update after an explicit review. Reject stale
  track/name snapshots, protect system playlists and keep folders out of track writes, validate active tracks, keep
  first occurrence/order, and read back. Never automatically retry creation or append.
  Stored playlists may exceed 10,000 tracks: read only 100 row details per page, returning
  only current-page IDs for large lists. Use account/session/playlist-bound SHA-256
  snapshots of the full stored definition for reviewed append/deletion, rejecting stale
  membership/name/description or account changes. Submitted lists and full replacement
  remain limited to 10,000; large-list playback explicitly queues only the current page.
  Retain only whitelisted playlist cache fields, excluding sharing keys and credentials.
  Playlist deletion requires an explicit review and matching name/track snapshots;
  use `deleteplaylist` with `playlist`, protect system lists and folders from ordinary playlist deletion, read back and
  never retry automatically. Delete only the playlist definition, never its tracks.
  A track's + menu can add that single track to a playlist using bounded metadata;
  never load all album tracks for that action or interrupt the play queue.
- Native playlist covers use the shared image comparison/file/URL validation, then an
  explicit separate save via `updateplaylist` with only playlist/artwork IDs. No
  album/track image writes or metadata History entry. Recheck the bound session,
  client and full playlist snapshot before uploading/applying; read back artwork plus
  unchanged definition. No ambiguous retries. Covers appear in compact browse cards
  and playlist headers; provider image suggestions are not requested for playlists.
- Playlist folders are native `type=folder` records whose `tracks` field contains
  playlist/folder IDs, never music track IDs. Browse 100 references at a time, show
  unavailable references, preserve native order, nesting, browser history and global
  search. Root views keep legacy cyclic groups reachable without auto-repair. Ordinary
  track destination choices exclude folders. Create/rename/add/remove/empty-delete use
  their own explicit review, current session and full definition hashes (including
  type/system/artwork), selected child snapshots, global save lock and fresh read-back.
  Use observed `createplaylistfolder`, `updateplaylist`, `deleteplaylist` payloads.
  Never retry ambiguous folder mutations or resolve folder IDs as tracks. Prevent self/
  ancestor cycles. Changes select at most 100 references; additions keep at most 10,000,
  while explicit removals can reduce an existing larger folder. Preserve all unselected
  references. Removal only unlinks; deletion requires an empty folder with no parents,
  and never deletes member playlists or music. Schema 2 metadata exports put folders
  and ordered references in `playlist_folders` / `playlist_folder_items`, separate from
  ordinary `playlists` / `playlist_tracks`; preserve missing/repeated/cyclic references
  without traversal or extra provider requests. Keep artwork IDs in both export forms.
- Playlist URL is a separate explicit input beside Import CSV, reusing the same draft,
  matching, pause and final review. Only public Deezer playlists and experimental public
  ListenBrainz playlists are supported; no login, audio, artwork or per-track follow-up
  requests. Parse fixed HTTPS hosts/native IDs, discard tracking queries and never fetch
  arbitrary URLs from input or returned cells/links. Deezer short links have at most four
  checked redirects to known short hosts and a Deezer playlist; API pagination is validated
  but reconstructed on its fixed host. A separate credential-free HTTP session disables
  automatic redirects/netrc; bound time, request count, streamed bytes, rows and text.
  Respect disabled Deezer before and during requests. Fetch one URL at a time, capture
  client/account/session/library/combine context and reject replacement before publication.
  Validate public visibility, complete pagination/counts and Deezer revision markers;
  reject empty/private/oversized/changed/truncated/error/non-JSON responses entirely.
  Retain order, repeats, unavailable positions, missing metadata and full version text;
  never infer artist-name separators. URL defaults map title, performer and seconds only;
  optional album/year/position remain available. Store normalized rows with only a validated
  provider/native-ID origin in an explicitly paused checkpoint. Resume never refetches the
  provider or restores an old approval. Older CSV checkpoints need no origin. Display the
  source and test status, allow CSV export and keep close protection. Late URL responses
  cannot restore a closed dialog; discard their local draft only in the same active session.
- CSV playlist import is a page-local modal under Playlists. Read a file up to 5 MB
  or pasted CSV/TSV text, choose encoding/separator/header and map distinct title/performer
  columns plus optional album, album artist, duration (seconds/ms/mm:ss), year and track
  number. Never evaluate cells or follow CSV URLs/Spotify/ISRCs. No metadata/audio/provider
  fetches for parsing, matching or manual search; use one lazy server-side active-membership
  catalogue and return only 50 CSV rows / 10 suggestions or 50 manual search results.
  By default, full title/performer exact matching preserves version text and requires a unique copy
  consistent with all mapped optional fields; invalid cells and fuzzy/version alternatives
  remain unresolved. Multiple eligible copies default to manual choice. An explicit per-import
  copy_preference may select FLAC, oldest known effective track/album year, first (lowest ID),
  or FLAC then oldest year, using the full eligible index. Unknown years come last; ties
  fall back to lowest native track ID. Preferences never relax eligibility or CSV warnings,
  fetch metadata/audio, or establish audio identity. Explain preference choices, allow manual
  correction and preserve the final creation review. Column mapping explains that Album
  title is a strict condition when used. Persist the preference in paused checkpoints;
  older checkpoints without it use manual. Changing it resets prior matching decisions.
  Native additional performers count, composers do not.
  Explain nonautomatic decisions on each row and compare every bounded suggestion with
  the CSV using the same eligibility checks (title/version, performer, album/album artist,
  year, track number and the three-second duration margin). Identify duplicate eligible
  copies, missing native values, invalid CSV fields and absent suggestions explicitly.
  Preserve the original explanation after manual choices/skips; suggestions remain manual.
  Split artist names only on an explicitly chosen semicolon option. Alternative generation
  is bounded, while automatic matching and explicit paginated search cover the full index.
  Bind at most two in-memory drafts (one-hour expiry) to client/account/session/library copy
  and combine setting. Revision checks reject concurrent choices; close clears/discards,
  library changes invalidate, late replies cannot restore a closed/replaced draft. Never
  persist ordinary unsaved drafts or credentials to disk/history. Playback/history stay intact.
  Explicit Pause import is an authorized exception: save the original parsed CSV cells,
  column mapping, playlist text, manual choices/signatures, skips, filter and page locally.
  Keep at most 10 checkpoints / 64 MB per account in a validated private atomic JSON file;
  never evict a paused import, overwrite a corrupt file, or expose another account's copies.
  Paused copies survive restart without the active draft's one-hour expiry. Resume explicitly
  refreshes the shared library, then rematches conservatively. Retain only unchanged manual
  identities/signatures and explicit skips; changed/missing manual choices stay unresolved
  even through another pause. Mapping changes reset choices. No review token, credentials,
  library object, source lookup, audio or automatic iBroadcast write is persisted/resumed.
  Closing/discarding a resumed active draft keeps its checkpoint; removing that saved copy
  requires a separate review and token comparison. Re-pausing replaces only that same,
  unchanged checkpoint. Before creation persist its consumed intent, so concurrent resumes
  and uncertain requests cannot resend it after restart. Remove the checkpoint on confirmed
  creation; retained uncertain entries are read-only and direct users to check Playlists.
  Once an import has input or a draft, Close, Cancel and Escape ask before discarding
  unsent progress; declining preserves choices, text, filter, page, focus and scroll.
  Warn separately that closing during creation does not cancel the accepted request.
  Empty/finished dialogs and automatic account/library invalidation need no prompt;
  programmatic success closure and the single-use save protections stay unchanged.
  Matching initially shows Unresolved records, using a server-filtered bounded page.
  Users may resolve/skip more rows or explicitly review only their selected automatic/manual
  matches, leaving unresolved rows out. Require a boolean omit_unresolved choice for a
  partial review and at least one selected track; show the omitted count in every final
  review page. Keep unresolved rows and choices intact on Back, restoring filter/page.
  Retain CSV order and distinguish unresolved omissions, explicit skips, blank records
  and duplicate counts. Keep repeated selected IDs once at their first occurrence.
  Explicit unresolved CSV export covers all pages, excluding selected and explicitly skipped
  records, with original columns/cells/order. Use UTF-8 BOM/comma/CRLF and reversible
  spreadsheet escaping with a Tagcast format line; re-import removes only that escape.
  Ordinary files remain limited to 5 MB; identified Tagcast exports may be re-imported up
  to 12 MB (also bounded server-side). Export never persists a file; only explicit paused
  checkpoints may retain parsed CSV contents locally. Export is
  read-only and revision/client/account/session/combine-bound; only this source-file read
  may survive a newer library copy, including the import's own save/read-back. Never relax
  matching or write guards. Offer export in matches, review, uncertain results and the
  completion dialog for a partial import, before Open imported playlist closes/discards it.
  The final review contains ordered native track metadata, name/description and a server-only
  track list behind a single-use review token. Explicit confirmation creates only a new
  private playlist via existing createplaylist, under the shared save lock; recheck current
  library, active selected memberships and identities, then read back its complete definition.
  Consume the draft before sending; never retry an ambiguous creation, overwrite an existing
  playlist, edit music metadata, follow CSV links, fetch audio or enqueue anything.
- Play next inserts a FIFO album block; its entries are consumed after playback while
  the base queue remains intact. Repeat none/queue/track retains base album order.
  The shared + dropdown offers Add to queue and Play next for tracks and albums;
  opening or dismissing it never changes playback. Keep keyboard navigation, Escape,
  outside-click dismissal and focus return, and reject selections after library replacement.
- `queue_sync` is off by default and independent of `record_plays`. Request extra
  queue read/write scopes only when enabled. Explicitly connect one browser tab;
  sanitize sessions to the current account, validate state/revision, and keep one-use
  tokens in the server. Controllers may send commands but must never play local audio,
  report plays, or advance ended tracks. Handle role transitions, pause restoration
  until an explicit user action, and stop the bridge on account replacement/shutdown.
- Update checks use only GitHub's public latest stable release endpoint, without
  credentials or library data. Cache attempts (including failures) for 24 hours in
  `updates.json`; manual checks bypass the interval. `auto_updates` is a local
  setting. Keep failures separate from library loading, validate versions and
  construct release URLs for this repository. Never install or restart automatically.
- The desktop launcher remembers automatic browser opening in `launcher.json`,
  separately from server settings. Default to enabled; the manual browser button
  stays available. CLI `--open` remains explicit.
- Closing the desktop launcher stops only its own server. Reusing an existing
  Tagcast instance must not stop it when the launcher closes.
- Electron uses the shared loopback server and API guards. `/api/app` is a compact,
  account-free version/protocol identity, under the same Host/Fetch Metadata checks.
  Reuse only matching application/version/protocol servers; reject occupied foreign
  ports and stop only owned servers. Close warns for unsaved state, stops cleanup
  between batches and waits for accepted writes/read-backs without forced killing.
  Keep renderer sandbox/context isolation/webSecurity enabled, Node integration and
  webviews disabled, and no generic preload/IPC bridge. Restrict navigation to the
  app entry pages, external opening to parsed credential-free HTTPS, and permissions
  to the app main frame's fullscreen/output/sanitized clipboard; never grant capture.
  Hash existing inline theme scripts in CSP. No automatic updater or playback restart.
  Electron profiles/browser-local histories are separate; server credentials/settings
  and local account favourites retain their normal folder. Fuses disable RunAsNode,
  Node options/inspect injection and loading unpackaged application code.
- iBroadcast write and artwork modes partly follow undocumented endpoints.
  Verify assumptions before changing their payloads or behavior.

## Tests and compatibility

The GitHub Wiki is the full user guide; keep the repository README concise.
Follow `docs/documentation.md` when updating Wiki pages, navigation or screenshot
links. Wiki content has its own Git history; it does not need an app release.

Run the relevant checks for changed components. The existing CI checks are:

```sh
uv run --frozen pytest -q
uv run --frozen ruff check src tests tools
python3 tools/release_info.py
for f in src/tagcast/static/*.js; do node --check "$f"; done
node --test tests/frontend.test.cjs
node --test electron/tests/*.test.cjs
```

After changes to `style.css`:

```sh
python3 tools/build_dark_css.py
python3 tools/build_dark_css.py --check
```

- Use `tests/mock_ibroadcast.py` for controlled iBroadcast flows.
  `TAGCAST_IBROADCAST_BASE` points all iBroadcast endpoints at the mock server.
- Keep test data and settings separate from the real account, for example
  through a temporary `TAGCAST_HOME`.
- Frontend regression tests execute the scripts with a simulated DOM;
  they do not check full browser interaction.
  Check relevant interaction behavior when changing the frontend.
- CI tests Python 3.11 and 3.13 on Linux, macOS and Windows.
- Native builds use Python 3.13 with Tk and check both executables after archive
  extraction, CLI help/version, HTTP assets and macOS signature integrity.
  Preserve symlinks, license notices, SHA-256 files and tag/version checks.
- Release creation uses the matching `Publish Tagcast VERSION` commit after
  tests pass; stable releases also wait for all four native builds to pass.
  Stable/beta conventions and rebuilds are in `docs/native-builds.md`.
- Preserve the start scripts for these platforms, with both uv and the
  Python/venv fallback.
- Preserve explicit MIME types for static files and platform-specific
  port handling.
- `.bat` uses CRLF; `.sh` and `.command` use LF as specified in `.gitattributes`.
