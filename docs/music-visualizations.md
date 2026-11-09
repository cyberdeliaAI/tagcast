# Optional music visualizations

The expanded player can replace the cover/CD presentation with an audio-reactive
visualization. This is off by default. Choose **Visualization** in the expanded
player or **Settings → Playback → Fullscreen visualizations**. The preference is
local to the current browser/app profile. Cover or CD returns to the existing
artwork presentation. Lyrics can remain visible alongside an effect.

Available presentations:

- MilkDrop · Aurora, Orbit and Ribbons: three original bundled Butterchurn presets.
- Retro · LED spectrum: amber segmented frequency bars.
- Retro · Oscilloscope: a green waveform with a grid and rising-edge alignment.

VisualBee informed the retro presentation ideas; no VisualBee code/assets or
LRCLIBee changes are included. Lyrics lookup, attribution and saving are unchanged.
This does not import arbitrary MilkDrop presets or provide the MilkDrop desktop app.

## Audio, resources and security

Effects read samples from Tagcast's existing `captureStream` analyser and share its
animation loop. There is one authoritative audio element. Butterchurn receives a
null AudioContext and sample arrays, so it creates no audio nodes or output path.
Its left/right inputs currently both contain the existing mono mix; these effects
are not independent stereo meters. Native speed/output controls, queue and Gapless
continue through the existing playback path.

Rendering is capped at 30 frames/second and a 1280 × 720 backing surface, with a
32 × 24 Butterchurn mesh. These are upper limits, not a guaranteed frame rate.
Pause freezes the effect; closing/hiding it releases its canvas and GPU context.
Reduced-motion preferences and unsupported audio capture show artwork instead.
WebGL2 is needed for MilkDrop effects. A load/context/render failure returns to
artwork without stopping music; selecting an effect again permits recovery.

Butterchurn 2.6.7 is bundled locally under MIT with its license and provenance in
`src/tagcast/static/vendor/butterchurn/README.md`. It loads only when a MilkDrop
effect is first needed. Tagcast's small presets use function equations; the
upstream string-to-code compiler is removed from the vendored build. No CDN,
external visualization service, preset downloads, `unsafe-eval`, CSP relaxation,
Electron permission changes or sandbox changes are introduced.

## Validation — 10 November 2026

All execution below was on macOS Apple Silicon. No Windows, Linux or macOS Intel
execution or real-account music test is claimed. A local Apple Silicon packaged
app was subsequently built and checked as described below.

- Frontend: `node --test tests/*.test.cjs` — **768 passed**.
- Electron: `node --test electron/tests/*.test.cjs` — **47 passed**.
- Python: `.venv/bin/python -m pytest -q` — **909 passed, 1 failed**, plus 2512
  subtests. The failing upload test is described separately below.
- Ruff, JS syntax, i18n completeness/fallback checks, generated dark CSS and
  `tools/release_info.py` passed. Version remains 1.6.5.
- Synthetic sandboxed Chromium test: all five effects and Off, Light/Dark at
  420/760/1280 CSS pixels, lyrics at those widths, pause/resume, seek/speed,
  close/reopen, reduced motion and context loss/recovery. One audio element,
  no runtime errors or external requests. Screenshots were inspected.
- Deterministic FLAC smoke: 12 paired reference/engine cases (24 measurements),
  all passed with zero PCM mismatches. Fixtures include mono/stereo, 16/24-bit,
  44.1/48/96/192 kHz, short tracks, repeat and delayed preparation. These runs
  use the standalone engine harness with effects off; they are not measurements
  of every format/platform or a claim of universal sample accuracy.
- Seven existing diagnostic media cases passed their contracts. The deliberately
  diagnostic small-to-large-block and early-seek cases still measure differences;
  they must not be counted as exact PCM transitions. Production fallback is
  exercised by the full-page tests instead.
- Full production page: ten playback/Gapless scenarios passed with effects off,
  and the same ten passed with the real Aurora renderer active. They cover normal
  playback, startup/mixed-block/stall fallback, pause/seek/speed, repeat, queue edits,
  backward seek after eviction, prepared-next skip, pending queue replacement and
  high-rate startup. These are state/compatibility checks, not PCM capture tests.
  Electron 44.9.0 / Chromium 152.0.7977.167 was used for these media runs.
- A wheel was built and inspected: both visualization assets, renderer/license and
  all six language catalogues are included.

### Local Apple Silicon test application

A production-named **Tagcast.app 1.6.5** was built with the frozen runtime lockfile,
PyInstaller 6.22.3 and Electron 44.9.3. The delivered copy is at
`build/music-visualizations-2026-11-10/Tagcast.app` in the original checkout.
The installed application was not replaced. Its production bundle identifier
`nl.cyberdelia.tagcast` and ordinary profile/settings locations are preserved, so
quit another Tagcast instance before opening this test copy.

The delivered app passed `tools/check_electron.py ... 1.6.5 --restart` using
throwaway settings/profile directories: bundled CLI help/version, initial launch,
restart with saved preferences and the same local origin, Mini Player operations,
shared audio/queue, theme checks, sandbox/context isolation and owned-server shutdown.
All 89 bundled static files match their source bytes, including the visualization
renderer, license and six language catalogues. The executable is arm64 and passes
`codesign --verify --deep --strict`. The local test build is ad-hoc signed and is
not notarized; no Developer ID signing or public release is claimed.
Bundled certifi 2026.10.23 and its CA bundle passed the extracted-app checks
(118 roots; the removed compromised root is absent). Real-account visualizer
listening remains a user test, distinct from synthetic browser/media checks.

### Existing unrelated Python failure

`tests/test_uploads.py::TransferTests::test_file_changed_while_sending_is_cut_off_and_uncertain`
returns `sent/sent` where the test expects `uncertain/sent` on Python 3.14.10.
It reproduces in isolation and in a pristine archive of baseline `136e178` using
the same interpreter/dependencies. This failure was already recorded in
`docs/continuous-browsing-validation.md`; upload code/tests are unchanged here.
The Python suite must not be described as entirely green. Its cause and release
impact require separate follow-up before shipping, not a workaround in this feature.

### Reproduction

Use the project's frozen environment and normal Electron test prerequisites:

```sh
node --test tests/*.test.cjs
node --test electron/tests/*.test.cjs
.venv/bin/python -m pytest -q
.venv/bin/ruff check src tests tools
python3 tools/build_i18n.py --check
python3 tools/build_dark_css.py --check
python3 tools/release_info.py
node tools/gapless_lab/fixtures.cjs build/music-visualizations-fixtures --stress
```

Run the existing `tools/gapless_lab/electron.cjs` runner with those fixtures and
`--suite smoke --stress`, then `--suite diagnostics --stress`, using separate
`--out` directories. Run `tools/gapless_lab/application.cjs` with `--stress` first
normally and then with `--music-visualization aurora`. Verify each result directory
with `node tools/gapless_lab/verify.cjs DIRECTORY`. These use Electron with the
Chromium sandbox enabled; no `--no-sandbox` flag is needed.

`tools/check_music_visualizations.cjs` is an optional development-only Playwright
probe; it uses the real frontend, Electron's production CSP, intercepted account
APIs and generated synthetic audio. Install Playwright outside the runtime app;
if needed set `NODE_PATH` to its module directory and `TAGCAST_CHROMIUM` to an
existing Chromium executable. Run `node tools/check_music_visualizations.cjs`.
It writes screenshots and `report.json` under `build/music-visualizations-browser`.
No real library or music file is read or modified.

The durable condensed result record is
`docs/validation/music-visualizations-2026-11-10.json`. Raw media/PCM captures and
screenshots remain under the corresponding local `build/music-visualizations-*`
directories. No push, merge, version bump, tag or release was performed.
