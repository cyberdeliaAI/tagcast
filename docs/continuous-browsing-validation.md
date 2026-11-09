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
