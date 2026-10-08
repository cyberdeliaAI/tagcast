# Project instructions for Tagcast

## Scope and communication

- Tagcast is a local metadata editor for iBroadcast; it does not modify local
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
- `src/tagcast/artwork.py`: image validation, base64 decoding and downloads.
- `src/tagcast/static/`: HTML, CSS, SVG and seven JavaScript files:
  `app.js`, `genres.js`, `lookup.js`, `artwork.js`, `player.js`, `album.js`,
  `overview.js`. `album.js` provides read-only album browsing; editing remains
  in `app.js`, and `player.js` plays one album independently of the editor.
- `tests/`: unittest tests that also run through pytest, fixtures and
  `mock_ibroadcast.py`.
- `tools/build_dark_css.py`: generates `static/dark.css` from `static/style.css`.

The JavaScript files share a single global scope. Keep top-level names unique
and preserve a valid script order in `index.html`.

## Technology and coding conventions

- Python 3.11 or newer is required.
- Runtime dependency: `ibroadcast>=2.0.1,<3`; the code also uses `requests`,
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

## Behavior to preserve

- The server binds only to `127.0.0.1`, on port 8912 by default.
- Preserve Host validation, the `X-Tagcast` POST header, Fetch Metadata checks
  for GET APIs and existing security headers.
- Tokens and source keys stay server-side and must not appear in frontend API
  responses or in the repository.
- Settings, tokens, cache and logs default to `~/.tagcast/`; `TAGCAST_HOME` can
  override this. Preserve existing migration support for the earlier name
  `library-studio`.
- Demo and imported JSON libraries remain local previews and are never saved
  to iBroadcast.
- Online suggestions fill the editor; metadata writes follow only after review.
  Artwork has a separate comparison and explicit save.
- A metadata save remains limited to one album or one album artist.
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
- Composers use `artists_additional` with type `composer`; preserve other
  credits. An artist marked `trashed` can still be a valid album artist.
- With `Combine Multi-Disc Album Sets` enabled, album changes are blocked;
  track changes can proceed. The cache must match this setting.
- Preserve compact album summaries, lazy track details and caching keyed by
  account, `lastmodified` and `combine_sets`.
- Artwork uses JPEG, PNG, WebP or GIF, up to 15 MB. Preserve checks for local
  addresses and redirects. Album covers are applied to active tracks;
  undo retains previous artwork IDs per track.
- Playback goes through the local server, supports Range requests and does
  not report plays or scrobbles to iBroadcast.
- iBroadcast write and artwork modes partly follow undocumented endpoints.
  Verify assumptions before changing their payloads or behavior.

## Tests and compatibility

Run the relevant checks for changed components. The existing CI checks are:

```sh
uv run --frozen pytest -q
uv run --frozen ruff check src tests tools
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
- Preserve the start scripts for these platforms, with both uv and the
  Python/venv fallback.
- Preserve explicit MIME types for static files and platform-specific
  port handling.
- `.bat` uses CRLF; `.sh` and `.command` use LF as specified in `.gitattributes`.
