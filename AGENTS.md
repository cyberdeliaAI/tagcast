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
- `src/tagcast/updates.py`: public stable-release checks, version comparison and a
  daily persistent cache, independent of iBroadcast credentials.
- `src/tagcast/collections.py`: native album ratings, private playlists, reviewed
  append/replace operations, and bounded metadata for explicitly chosen queued tracks.
- `src/tagcast/queue_sync.py`: opt-in server-side WebSocket bridge; extra OAuth queue
  scopes, sanitized account sessions, five-second reconnect pacing and controller roles.
- `src/tagcast/artwork.py`: image validation, base64 decoding and downloads.
- `src/tagcast/static/`: HTML, CSS, SVG and seventeen JavaScript files:
  `app.js`, `genres.js`, `lookup.js`, `updates.js`, `artwork.js`, `player.js`, `album.js`,
  `trash.js`, `artists.js`, `tracks.js`, `favourites.js`, `browse.js`, `overview.js`, `cleanup.js`, `collections.js`, `queue-sync.js`, `navigation.js`. `album.js` provides album browsing;
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
- The demo library remains a local preview and is never saved to iBroadcast.
- Tagcast starts on Album artists. Back and Forward follow the browser history;
  dialogs get no history entry, and Back never closes an open editor.
- Online suggestions fill the editor; metadata writes follow only after review.
  Artwork has a separate comparison and explicit save.
- Tracks go to iBroadcast's trash (`trash`) only from the album page, after the
  trash review; the server first checks that every track is still active on its
  album. Never delete permanently.
- Duplicate candidates require the same positive track number and normalized title
  within one disc. Title comparison ignores case, spacing and straight/curly quotation
  marks; retain version text and other punctuation. Repeated titles at different positions
  or on different discs are not duplicates; missing numbers are not matched. Summary counts, badges and
  Select extra copies use the same rule. Selection keeps the first candidate and
  still requires review; metadata cannot establish audio identity or quality.
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
- The mobile sidebar is a disclosure menu; its open/closed state adds no history
  entry. Keep connection and source settings reachable and support Escape.
- Decades reuses the browse indexes and effective track/album years. Exclude unknown
  years, use full decade labels (1980s, 2020s), sample merged album summaries locally
  without duplicates, and preserve the random order on Back. Surprise me again
  reshuffles without downloading tracks or writing to iBroadcast.
- By default the play queue stays in browser memory. Explicit Play replaces it; Add to queue
  appends a single track or all discs of an album, preserving click order. Store
  each queued track's album metadata for covers and navigation across albums.
  Clear queue stops audio and cancels pending additions. Guard lazy loads against
  library changes and clears. Now playing opens without a browser history entry.
- Fullscreen Now playing reuses the existing audio element and queued metadata.
  Opening or closing never restarts audio or adds a history entry. Request native
  fullscreen only on a click; fall back to a window-filling view when unavailable.
  Escape, stopping and library replacement close it; restore focus and inert state.
- Double-clicking album covers in grids/lists, album details and the player opens
  a modal lightbox. Mouse clicks on small covers briefly defer their usual action;
  title and keyboard activation stay immediate. Placeholder covers keep their normal
  action. Load larger known iBroadcast artwork only when opening, with one fallback
  to the existing image. Keep other provider URLs intact. Escape, close and backdrop
  dismissal restore focus without changing audio, the queue or browser history.
  Close on library replacement; cancel pending cover clicks on navigation. Preserve
  fullscreen focus handling when a lightbox is above Now playing.
- Play random album uses all filtered merged albums, before paging or the decade
  display sample. Load only the chosen set, play from its first track and replace
  the queue. Avoid the current album when alternatives exist. Clear, explicit Play
  and library changes cancel pending random playback; previews cannot play.
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
