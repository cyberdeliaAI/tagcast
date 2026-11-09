# Optional continuous browsing

Validated locally on 9 November 2026, against baseline `3eaab0e` (Tagcast 1.6.5).
Implementation branch: `codex/continuous-browsing`. No version bump, push or release.

## Behaviour

- Album artists and Albums each offer **Continuous scroll** in their existing
  page-size selector. Numeric pagination remains the default, and its saved size
  is retained. The two browsing preferences persist independently in the profile.
- Reveal 60 more summaries near the bottom, with an explicit **Show more** button
  for keyboard use. Sixty makes complete rows in the existing grid column counts.
- Use only the already loaded compact summaries. No additional library, detail or
  audio requests are introduced by scrolling. Album list view is also supported.
- Keep nearby chunks rendered and replace distant chunks with measured-height
  placeholders. A focused chunk stays rendered. Appending retains existing nodes.
- Search/filter/order changes reset the revealed scope; Back restores the revealed
  count and scroll position. Width changes remeasure the window. Disabling the mode
  or replacing the library releases the controller's old summary references.
- **Select loaded albums** covers the revealed results, including windowed-out
  cards, rather than all matching results. Later reveals do not select new albums.
  Existing selections outside filters remain available for the normal review gates.
- New strings are translated in English, Dutch, German, French, Spanish and Japanese.
  Toolbars wrap when translated choices would otherwise overflow.

## Automated checks

| Check | Result |
| --- | --- |
| `node --test tests/*.test.cjs` | 746 passed, no failures/skips |
| `node --test electron/tests/*.test.cjs` | 47 passed, no failures/skips |
| `.venv/bin/python -m pytest -q` | 909 passed, 2,512 subtests passed; one existing upload test failed (below) |
| `.venv/bin/ruff check src tests tools` | Passed |
| `python3 tools/build_i18n.py --check` | Passed; six complete catalogues |
| `python3 tools/build_dark_css.py --check` | Passed |
| `node --check` for every production static JavaScript file | Passed |
| `python3 tools/release_info.py` | Consistent 1.6.5 |
| `git diff --check` | Passed |

Eight new regression tests cover windowing, scroll height, focus retention,
automatic reveal, stale timers, resizing, history restoration, preference/storage
behaviour, empty/small collections, released references and explicit selections.
They execute the production controller and the production frontend scripts.

## Real-browser checks

Headless Chromium on macOS Apple Silicon, using the actual static frontend and
synthetic local data. API calls were intercepted; no real account was used.

- 18,739 synthetic albums/artists, including long titles: after revealing 540 albums,
  120 card elements remained mounted. The 60 explicitly selected albums stayed
  selected. Scrolling added zero API requests (three startup requests before/after).
- Opening a cached album and returning with Back restored 540 revealed albums and
  exactly the previous scroll position (41,616 CSS pixels).
- Switching to numeric pagination restored 24 cards and scrolled to the listing
  controls. Grid/list changes, search, empty results and independent artist browsing
  passed. Artist browsing reached 300 revealed results with at most 120 mounted cards.
- 120 layout combinations: both pages, six languages, Light/Dark and widths 420,
  760, 761, 1280 and 1600 CSS pixels. No document horizontal overflow or runtime
  errors. Representative broad/narrow screenshots were inspected separately.
- The same audio element remained in use; the empty playback queue stayed unchanged.

## Existing unrelated failure and limits

`TransferTests.test_file_changed_while_sending_is_cut_off_and_uncertain` fails with
`['sent', 'sent']` instead of `['uncertain', 'sent']` on local Python 3.14.10.
The complete suite and a targeted rerun reproduced it. A pristine archive of
baseline `3eaab0e`, run separately with its own `src` and the same interpreter,
also failed identically. Upload code/tests were not changed for this feature.
The cause is not established here; this result must not be reported as an entirely
green Python suite.

No Windows/Linux/Intel run was performed, and no live-account playback or metadata
operation was attempted. A local Apple Silicon app was subsequently built and checked
as described below. The new feature does
not modify the playback engine; no new PCM/media measurement is claimed.
Browser Find and accessibility navigation only see currently mounted cards;
the existing library search covers all loaded summaries. Very different card
heights can refine placeholder estimates as chunks become visible.

## Local Apple Silicon test app

Built from `2669841` on 9 November 2026 with the frozen lockfile, Python 3.14.10,
PyInstaller 6.22.3 and Electron 44.9.3. The output remains **Tagcast.app 1.6.5**,
bundle identifier `nl.cyberdelia.tagcast`, with the existing production profile and
settings paths. The installed app and real user data were not replaced or opened.

- Verified the actual copied arm64 app with `tools/check_electron.py --restart`: initial
  launch, restart, saved preferences, bundled CLI, same local origin, owned-server
  shutdown, sandbox/context isolation, mini player and presentation checks passed.
- All 13 changed frontend/catalogue files in the frozen backend match the source
  byte for byte, including `continuous-browse.js` and all six language bundles.
- `codesign --verify --deep --strict` passed. This local test build has an ad-hoc
  integrity signature; it is not a Developer ID signed/notarized public release.
- Bundled certifi 2026.10.23 and its CA bundle passed the existing package check.
- No release, tag, remote push or installation was performed.

Test app: `build/continuous-browsing-2026-11-09/Tagcast.app` in the original checkout.
The build log and complete bounded Electron validation report accompany it.

## Extended group and album shelves

The follow-up extends the same optional mode to Track artists, Composers, Genres,
Tags, Release year, Upload folders and Date uploaded overviews, their album shelves,
and favourite albums. The existing Decades random sample remains unchanged.
Numeric pagination remains available and is still the initial default.

- Group overview preferences are independent; their album shelves share a separate
  display preference. Favourite albums retain their own choice.
- Live group overviews request 50 compact results at a time through the existing
  browse API. Album shelves and favourite albums reveal 60 locally loaded summaries
  at a time, without additional album, library or audio requests.
- Older responses cannot append after navigation, search/display changes or library
  replacement. Overlapping, empty or misplaced result pages are rejected.
- An incremental request failure retains the displayed prefix, stops automatic
  loading and offers explicit Show more recovery. No automatic retry loop.
- Back restores only the previously revealed server prefix and the previous scroll
  position. Keyboard focus stays on Show more, or the footer after the final batch.
- All existing review gates, selection behaviour, audio and queue remain shared.

Follow-up verification on macOS Apple Silicon:

- JavaScript suite: **754 passed**, no failures/skips. Eight additional regressions
  cover bounded server pages, independent display preferences, numeric fallback,
  errors/manual retry, stale replies, history, all seven ordinary album shelves,
  local preview/favourites, malformed pages and library replacement.
- Electron unit suite: **47 passed**, no failures/skips.
- Ruff, JavaScript syntax, generated CSS, six-language completeness/fallback checks,
  version consistency (1.6.5) and whitespace checks passed.
- Actual Chromium, synthetic 18,739 groups: 450 unique results revealed with 100 cards
  mounted. Bounded requests, exact Back scroll restoration (34,359 CSS pixels),
  failure/recovery and keyboard focus passed. All seven album shelves revealed
  60 to 120 results without another request.
- **240 rendered layouts**: four pages, six languages, Light/Dark, widths 420, 760,
  761, 1280 and 1600 CSS pixels. No horizontal overflow or JavaScript runtime errors.
  Representative screenshots were inspected, including the themed favourites selector.
- The same audio element and unchanged queue were verified in the browser. No real
  account, music transfers, metadata writes or additional-platform runs were used.

An ad-hoc targeted Python invocation collected `test_upload_browse` before
`test_collections`; the latter imports `test_client`, which reloads `tagcast.client`.
That order left the former's imported `ApiError` class stale and caused its exception
assertions to fail. This is a test collection interaction, not a changed backend path;
no Python production or test files are modified by this feature.

The full Python suite in its normal collection order completed with **909 passed,
2,512 subtests passed and the same one existing upload-test failure** described
above (141.25 seconds). The isolated upload-browse module passed all eight tests
and six subtests. No new Python failure occurred in the complete run.

### Expanded Apple Silicon test app

The expanded application was built with the frozen dependencies on 9 November 2026.
The actual delivered copy passed `tools/check_electron.py --restart`, including
launch/restart, preference persistence, bundled CLI, owned-server lifecycle and
Electron security checks. Its executable is arm64; deep/strict code-signature
verification passed. All **14 changed frontend/catalogue assets** match source
byte for byte, and all six language catalogues are included. Certifi and CA bundle
verification passed in the existing packaged-app check.

This remains Tagcast 1.6.5, `nl.cyberdelia.tagcast`, using the normal profile and
settings locations. It has an ad-hoc local integrity signature, not release
Developer ID signing/notarization. Nothing was installed over the existing app,
and no real profile was used for automated validation.

Delivered app: `build/continuous-browsing-expanded-2026-11-09/Tagcast.app` in the
original checkout. The build log, copied-app validation log, Electron JSON report,
asset comparison, browser evidence and automated test logs accompany it. No push,
merge, tag or release was performed.

## Follow-up: loading placeholder on startup

A saved continuous Album artists preference exposed an initial-loading regression:
transitioning from zero results to the first populated prefix was treated as an
append, leaving the old loading message above the cards. Navigating away and back
replaced that markup, explaining the user's workaround.

Appending now requires an existing nonempty result window. The first results replace
empty/loading markup. A focused regression was run before the change and failed on
`empty<div data-continuous-chunk=...`; after the fix it passes. The full JavaScript
suite passes **755 tests**, no failures/skips.

A real Chromium check uses the production `loadLive()` lifecycle, a saved continuous
preference and a deliberately delayed synthetic library response of 2,623 artists.
Both initial loading and reload remove the loading message without navigation and
render exactly 60 cards in one chunk; no runtime errors. No real account is used.
The Apple Silicon test app is rebuilt with this fix, retaining version 1.6.5 and the
normal Tagcast name/profile. Package verification and restart evidence are stored
with `build/continuous-browsing-startup-fix-2026-11-09/Tagcast.app` in the original
checkout. This is a local ad-hoc signed test copy, not a public release.

## Follow-up: gaps between group grid windows

Genre/group overviews fetched 50 summaries per independent grid chunk. This leaves
incomplete rows at chunk boundaries for three/four columns. They now use the shared
60-summary window (divisible by every supported column count). The read-only browse
API accepts 60 in addition to its existing sizes; its 200-result bound remains intact.
Ordinary pagination, including 50 per page, is unchanged. Partial prefixes repaint
their last chunk when expanded, and append positions use the previously rendered
count so local reveals and server-prefix growth both retain every result.

Two focused regressions failed before correction: incompatible group window sizes
and missing cards when a partial prefix grows. Coverage also asserts placeholders
for every locally revealed chunk. Validation:

- Complete frontend JavaScript suite: **757 passed**, no failures/skips.
- Complete Electron unit suite: **47 passed**, no failures/skips (local test servers
  require permission to bind; the restricted attempt could not bind).
- Targeted Python browse checks: **20 passed, 10 subtests**; complete library and
  upload-browse modules: **66 passed, 69 subtests**.
- Ruff, JavaScript syntax, version consistency and whitespace checks passed.
- Actual Chromium reproduced holes in the original four-column layout. Corrected
  layouts at 420, 760, 761, 1280 and 1600 CSS pixels rendered 180 unique cards without
  intermediate empty cells, horizontal overflow or runtime errors. Normal 50-item
  pagination and the bounded mounted window were checked. Synthetic data only.

The Apple Silicon test app is rebuilt from these sources, keeping version 1.6.5,
the normal Tagcast name, bundle ID and profile. Build and delivered-copy restart
verification evidence accompanies
`build/continuous-browsing-grid-fix-2026-11-09/Tagcast.app` in the original checkout.
This is a local ad-hoc signed test copy. No real library writes, other-platform runs,
push, merge, tag or public release are part of this correction.
