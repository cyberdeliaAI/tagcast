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
- `src/tagcast/cleanup.py`: reviewed semicolon cleanup and exact genre-label replacement drafts, account-scoped local
  reports, bounded track-only batches and explicit stop/resume with fresh checks.
- `src/tagcast/duplicate_cleanup.py`: explicitly analysed, account-scoped duplicate-copy
  drafts, reviewed track exclusions and bounded trash batches with persisted intent and read-back.
- `src/tagcast/updates.py`: public stable-release checks, version comparison and a
  daily persistent cache, independent of iBroadcast credentials.
- `src/tagcast/album_guide.py`: opt-in, explicitly started comparison with the bundled
  cleaned 1001 Albums reference; account-scoped local results, no iBroadcast requests.
- `src/tagcast/collections.py`: native album ratings, private playlists, reviewed
  append/replace operations, and bounded metadata for explicitly chosen queued tracks.
- `src/tagcast/queue_sync.py`: opt-in server-side WebSocket bridge; extra OAuth queue
  scopes, sanitized account sessions, five-second reconnect pacing and controller roles.
- `src/tagcast/artwork.py`: image validation, base64 decoding and downloads.
- `src/tagcast/static/`: HTML, CSS, SVG and nineteen JavaScript files:
  `app.js`, `genres.js`, `lookup.js`, `updates.js`, `artwork.js`, `player.js`, `album.js`,
  `trash.js`, `artists.js`, `tracks.js`, `favourites.js`, `browse.js`, `overview.js`, `cleanup.js`, `collections.js`, `queue-sync.js`, `album-guide.js`, `help.js`, `navigation.js`. `album.js` provides album browsing;
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

The JavaScript files share a single global scope. Keep top-level names unique
and preserve a valid script order in `index.html`.

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
- Keep package, `__version__`, page badge and lockfile versions consistent;
  `python3 tools/release_info.py` checks them. Native build dependencies are
  separate in `requirements-build.txt`; runtime dependencies stay unchanged.

## Behavior to preserve

- The server binds only to `127.0.0.1`, on port 8912 by default.
- Preserve Host validation, the `X-Tagcast` POST header, Fetch Metadata checks
  for GET APIs and existing security headers.
- Tokens and source keys stay server-side and must not appear in frontend API
  responses or in the repository.
- Settings, tokens, cache and logs default to `~/.tagcast/`; `TAGCAST_HOME` can
  override this. Preserve existing migration support for the earlier name
  `library-studio`.
- New installations use Tagcast's public OAuth client ID and device-code sign-in,
  without a client secret or user-created app. Existing environment/saved client IDs
  and their tokens take precedence; switching to the default is explicit after
  Disconnect. Preserve browser-redirect sign-in for existing custom configurations.
- The demo library remains a local preview and is never saved to iBroadcast.
- Tagcast starts on Album artists. Back and Forward follow the browser history;
  dialogs get no history entry, and Back never closes an open editor.
- Online suggestions fill the editor; metadata writes follow only after review.
  Artwork has a separate comparison and explicit save.
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
  Split existing combined labels only on request.
- Cleanup is a dedicated reviewed exception to normal save scope: semicolon
  splitting for genres, track artists and composer credits, plus explicitly reviewed
  exact genre-label replacements/removals across the active library. Never infer
  slash/comma boundaries or remove ambiguous text automatically. Empty replacements
  require explicit removal mode; preserve other labels and promote the next label
  to main, or clear both genre fields if no labels remain.
  Preserve per-track values, credit roles/phrases and primary IDs when unchanged.
  Never split album artists or infer separators other than semicolons. Persist the
  account-scoped draft/report in cleanup.json; never send it to another account.
  Limit batches to 200 tracks / 20 displayed albums, check before writes and read
  back after every batch. Stop on conflicts, request errors or unconfirmed writes.
  Resume explicitly and recheck outstanding writes; never retry create_artist blindly.
  Keep normal editor scope validation intact. Additional performer IDs participate
  in browse, search and links independently of composers and other credit roles.
- Composers use `artists_additional` with type `composer`; preserve other
  credits. An artist marked `trashed` can still be a valid album artist.
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
- Collection, album artist and browse group totals emphasize albums, with track
  counts shown smaller underneath. Reuse existing summary and group counts;
  never download track details or add requests just to display these totals.
- `browse.js` provides Track artists, Composers, Genres and Release year. Index
  active displayed album membership on the server, lazily per library copy.
  Track artist/composer selections use IDs; genres use stored main/additional
  labels without automatic splitting. Years use track year with album-year
  fallback and an Unknown year group. Cards open matching albums (one matching
  track is enough); the API sends album IDs, and the frontend reuses album
  summaries, merging discs and paginating locally. Preserve exact group membership,
  browser history, genre links and stale-response guards across library changes.
  Card album counts match the merged shelf; duplicate disc numbers remain separate.
- Settings contains online sources/keys, playback recording and update checks. The
  library information banner is dismissible with a browser-local remembered preference
  and can be restored in Settings. Never hide other warnings or errors with it.
- Help uses a compact **?** button to start only the current page or dialog’s
  read-only tour; there is no topic chooser or automatic start. Scope highlights
  and explanations to that context, including distinct editor/review/chooser help. Use a native modal
  spotlight above existing dialogs, preserving drafts, playback, queue and history.
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
- 1001 Albums is off by default (`album_guide` in Settings). Enabling or opening only
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
  escaped, collapsible About this album above tracks only for confirmed entries in
  the current account/library's saved guide report. Reading that report is allowed;
  never auto-analyse, display text on possible/stale matches, or change playback or
  history. Preserve source/license links and suppress late DOM updates after changes.
- By default the play queue stays in browser memory. Explicit Play replaces it; Add to queue
  appends a single track or all discs of an album, preserving click order. Store
  each queued track's album metadata for covers and navigation across albums.
  Clear queue stops audio and cancels pending additions. Guard lazy loads against
  library changes and clears. Now playing opens without a browser history entry.
- Fullscreen Now playing reuses the existing audio element and queued metadata.
  Opening or closing never restarts audio or adds a history entry. Request native
  fullscreen only on a click; fall back to a window-filling view when unavailable.
  Escape, stopping and library replacement close it; restore focus and inert state.
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
- Player album artist and album title links open their respective pages. Show a
  third line only for a different track artist; its ID links to matching albums.
  Keep track artist in MediaSession metadata.
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
- Track favourites use native ratings (`ratetrack`, `track_id` array): 5 to add,
  0 to remove. Ratings >= 5 appear as favourites; lower nonzero ratings require
  frontend confirmation before replacement. Compare the displayed rating before
  writing and read back afterwards. These writes are separate from metadata
  History/Undo. `/api/favourites` searches and paginates on the server; never load
  every favourite into the browser. Invalidate pending frontend results when the
  library/session changes.
- The original Powered by iBroadcast SVG is displayed with its original colours and
  proportions. Keep Tagcast's independent identity explicit; do not imply endorsement.
- Streaming quality is a local server setting (`stream_quality`), default 128. It
  applies on the next track; show it separately from the stored file format. Original
  playback may fall back to 128 once, preserving the listening event and marking the
  fallback. Require Premium for every choice other than 128; keep all stream tokens server-side.
- Native album ratings use scalar `album_id` with `ratealbum`, one request per disc of
  one displayed set. Check the current rating before writing and read back each disc;
  do not add metadata History entries. A set is a favourite only when all discs rate 5.
  Show requested ratings/hearts immediately as saving/checking; update confirmed
  cached ratings only after read-back. Rating jobs return only their results, without
  serializing the full album index. Keep playback intact and suppress stale results.
- Playlists use native create/append/update after an explicit review. Reject stale
  track/name snapshots, protect system playlists/folders, validate active tracks, keep
  first occurrence/order, and read back. Never automatically retry creation or append.
  Retain only whitelisted playlist cache fields, excluding sharing keys and credentials.
  Playlist deletion requires an explicit review and matching name/track snapshots;
  use `deleteplaylist` with `playlist`, protect system lists/folders, read back and
  never retry automatically. Delete only the playlist definition, never its tracks.
  A track's + menu can add that single track to a playlist using bounded metadata;
  never load all album tracks for that action or interrupt the play queue.
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
- iBroadcast write and artwork modes partly follow undocumented endpoints.
  Verify assumptions before changing their payloads or behavior.

## Tests and compatibility

Run the relevant checks for changed components. The existing CI checks are:

```sh
uv run --frozen pytest -q
uv run --frozen ruff check src tests tools
python3 tools/release_info.py
for f in src/tagcast/static/*.js; do node --check "$f"; done
node --test tests/frontend.test.cjs
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
