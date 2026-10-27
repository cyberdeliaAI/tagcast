# Tagcast 1.0 candidate — Final stabilization and validation

Date: **27 October 2026**. Local preparation only. No push, merge, tag, GitHub
Release, Wiki publication, website deployment or Homebrew update was performed.

## Decision

**CONDITIONAL GO.** The local **1.0.0 beta 1** candidate passes the completed macOS
Apple Silicon, regression, media, upgrade and representative scale checks. The
confirmed F-01, F-02, F-03 and F-04 source defects are corrected. There is no newly
confirmed production playback defect requiring another audio-engine change.

**This is not approval to publish stable 1.0.0 immediately.** A reviewed push/PR is
still needed to run the corrected media gate and native platform workflows on the
exact candidate. Windows/Linux/macOS Intel packages and real desktop checks remain
open. Remote green checks for the earlier source are not substituted for these gates.
There is no authorized way to start this new-commit CI without a push.

The proposed stable version is **1.0.0** after those gates. The current unpublished
candidate is Python **1.0.0b1**, Electron **1.0.0-beta.1**, displayed **1.0.0 beta 1**.
The public release/download links remain **0.85.1**.

## Exact source and isolation

- Branch: `codex/v1-stabilization`.
- Starting source: `f23c08342ae876d63f4a447d3bdcd2838ac30fc3`.
- Frozen application source: **`067df8ed9942c89e3a894713c35973cffda54d54`**.
- The final documentation-only commit follows that source. No application, dependency,
  configuration or test edits were introduced after the frozen-source checks.
- Existing untracked `docs/mini-player-feasibility.md` and the primary historical
  `docs/tagcast-v1-readiness-audit.md` remain uncommitted and unchanged.
- The separate original checkout's AGENTS/Electron-doc edits, WebView experiments
  and lyrics exporter were not staged, copied into the candidate or modified.
- All account/library fault tests use synthetic state. No live-account mutation,
  local music change, installed-app replacement or user-profile migration was performed.
- Temporary validation servers and agent-owned test tabs were closed after checks.

## Confirmed issues resolved

| Finding | Correction and evidence | Scope / remaining boundary |
| --- | --- | --- |
| **F-01: ambiguous writes retried over newer external changes** | Transport retries only known safe reads. Unknown modes, metadata, cleanup, ratings, assignments, collection operations and play reports send once. Lost/invalid replies and 429/5xx are uncertain; metadata stops later requests and reads back attempted values. Ratings/artwork retain checked outcomes. | Remote operations remain non-transactional. Read-back proves current values, not authorship or atomicity. Fresh review/conflict checks remain necessary. Explicit OAuth rejection still permits coordinated refresh; it is not an ambiguous-write retry. |
| **F-02: media test failure could exit successfully** | Both Electron harnesses explicitly exit nonzero on failure. Mandatory plans, fixture hashes, calibration, complete inventories and per-case/PCM artifacts are checked. CI includes the independent verifier and actual negative Electron subprocesses. | Local execution and process exits are proved; the newly corrected GitHub job has not yet run remotely. Fallback/policy diagnostics are not advertised as exact continuity. |
| **F-03: vulnerable Electron 44.9.0** | Runtime/lockfile pinned to **44.9.3**, within major 44. No broad dependency update. Packaged sandbox, context isolation, CLI and shutdown checks pass. | See [official certificate advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9) and [44.9.3 release](https://github.com/electron/electron/releases/tag/v44.9.3). No exploit is claimed or tested. |
| **F-04: upload details show tracks instead of albums** | Reuse existing album cards, merged shelf, ordering and paging. At least one matching upload track qualifies an album. Open/play/queue acts on its complete album/set; the same album may appear in several groups. | Stored paths/dates are unchanged; unknown metadata stays Unknown. No uploads, file scanning, bulk actions or extra full-library downloads. |
| **Account capability display** | `account_view` now uses the same explicit Premium flag as the existing access checks. String `"0"` no longer displays Premium. Free/Premium/Basic/Unlimited/unknown plan-name fixtures exercise the flag independently. | No quota fields or entitlement promises were invented. New real provider responses have not been obtained from a live account. |

The audio engine, native player controls, queue implementation, Mini IPC, Settings
implementation and storage architecture are unchanged by this stabilization.
Gapless remains experimental and disabled by default. Generated `dark.css` is in
sync; only the obsolete upload-track-table CSS was removed.

## Local commits

| Commit | Purpose |
| --- | --- |
| `5f5037e` | Prevent ambiguous iBroadcast writes from being replayed. |
| `160584a` | Make measured media failures fail Electron and CI gates. |
| `70f5603` | Update Electron to patched 44.9.3. |
| `db72369` | Show complete album cards in upload folder/day groups. |
| `3e8363a` | Prepare unpublished 1.0.0 beta 1 version, README and notes. |
| `067df8e` | Align account Premium display with explicit capabilities. |

A final local documentation commit contains this report, prepared Wiki/site patches
and the stable-announcement draft. Review the full file list using
`git diff --stat f23c083..codex/v1-stabilization`; no unrelated tracked edits are included.

## Regression and security results

| Check | Result | Conditions |
| --- | --- | --- |
| Complete Python suite | **555 passed; 2,049 subtests passed** | Python 3.14.8, macOS arm64; 108.67 seconds. This includes fresh token-refresh, metadata save/read-back, cleanup, artwork, merge, lyrics, tags, collection, account and export tests. |
| Complete frontend suite | **517 passed** | `node --test tests/*.test.cjs`, including media-gate, player, Settings, Mini and upload browse regressions. |
| Electron shell suite | **13 passed** | Existing shell/security/lifecycle tests. |
| Ruff | **Passed** | `src tests tools`; no cache. |
| Release consistency | **Passed** | Python/package/lock/footer prerelease agreement; beta notes found. |
| Generated CSS | **Passed** | `tools/build_dark_css.py --check`; existing contrast/static tests included above. |
| Packaged runtime | **Passed** | Electron 44.9.3; sandbox true, contextIsolation true, nodeIntegration false, shared frontend, CLI version/help, backend ownership/shutdown. |
| Current npm audit | **0 high/critical; 1 moderate dependency** | `fast-uri` is transitive build tooling, not a shipped Node runtime dependency. No `audit fix --force`. This is not a complete Python/OS CVE certification. |
| Website preparation | **Passed** | Static paths/anchors/CSP/SEO, all four versioned links, six download/cache tests and 17 mocked deployment tests on the prepared copy. No deployment. |

The website test copy initially omitted its unchanged deployment workflow, causing
one fixture-path error. Copying that workflow into the isolated preparation fixed
the test environment; all 17 tests pass without changing deployment code.

### Write-failure regression scope

`tests/test_write_reliability.py` exercises the real transport/save/read-back paths:
applied-but-lost responses, connection failures/timeouts, 429/500/503, malformed,
empty and non-object JSON, later external edits, stale reviews, partial groups,
failed read-back, ratings/artwork, explicit auth rejection and retained read retries.
Unknown mutation modes are conservative. The ordinary metadata retry expectation
in the earlier test suite was deliberately corrected, rather than retaining the
unsafe replay as a test requirement. Existing review tokens/batch checks remain intact.

## Measured audio and trustworthy failure gates

All measurements below use synthetic sample-counter fixtures and **Electron 44.9.3
on macOS arm64**, not live iBroadcast music or Windows/Linux audio hardware.
Fixture generation independently encodes and round-trips its inputs. The measured
playback-source hashes match the frozen source and packaged static files.

- **31/31 standalone results:** 12 single-file calibrations, 12 corresponding
  continuity cases and seven required diagnostic/stress probes.
- All **12 continuity cases and 12 controls** have exact measured signals, zero
  mismatches, zero trailing missing/extra signal frames, and no boundary waiting.
  They cover mono/stereo, 16/24-bit, 44.1/48/96/192 kHz, small blocks, short delayed
  interludes, longer startup and repeat. This establishes those captured inputs,
  not universal format/device accuracy.
- **10/10 full-application scenarios:** Gapless disabled ordinary playback;
  preparation, mixed-block and stalled-playback fallbacks; pause/seek;
  repeat/queue edits; evicted backward seek; Next; pending queue replacement;
  high-rate startup. Same native audio remains authoritative.
- **6/6 deliberate failures** exited **1**: invalid fixture hash in each harness,
  missing required case in each harness, failed real calibration, and a real
  full-app media failure. Failure JSON alone is no longer considered success.
- The independent result verifier accepts the complete positive reports and checks
  per-case JSON/PCM artifacts. The Node gate regressions additionally reject bad,
  omitted, inconsistent or truncated artifacts.
- Fresh **180-second Original-FLAC repeat run:** 253 observed boundaries; two
  prepared tracks, retained encoded bytes **576,686**, observed buffered window
  approximately 5.3–7.4 seconds. Sampled JS heap ranges about 3.6–16.3 MiB and
  fluctuates with collection. This is a short stability check, not proof of
  constant total-process RAM over hours. Earlier longer evidence remains historical.

**Important distinction:** `block-small-to-large` is a required diagnostic that
successfully detects the known incompatible decoder path, not an exact PCM pass;
its captured signal is not continuous. The production full-app test verifies
normal fallback for that unsupported transition. `seek-early` validates the seek
operation and deliberately skips samples; its whole-track signal cannot be called
exact. Diagnostic success must not be quoted as 31 sample-accurate transitions.
No new audio-engine optimization was justified or implemented.

The CI workflow now runs smoke, required diagnostics/stress, full-app scenarios,
independent artifact verification and six negative subprocesses, with a 25-minute
job limit. The exact new GitHub job still needs the separately approved push/PR.

## Upgrade and platform matrix

| Platform / path | Built / tested now | Not established |
| --- | --- | --- |
| **macOS Apple Silicon** | Native standalone ZIP, extracted CLI, real Electron runtime, normal/MSE media, Mini IPC/lifecycle, sandbox and profile restart. | Not Developer ID notarized. Physical output switching, AirPlay and sleep/wake not repeated. |
| **Public 0.85.1 → candidate → second restart** | Real official ZIP checked against its official SHA-256, then opened with one disposable fixed-origin profile. Theme, palette, compact-player and Now playing/Gapless preferences and server-settings hash survive. | No real credentials or private library were used. Live OAuth/token retention is not claimed from this synthetic upgrade; refresh/persistence is covered by regression fixtures. |
| **macOS Intel** | Existing native workflow inspected; target/config retained. | No native build/runtime for this candidate. |
| **Windows x64** | Existing workflow and platform-sensitive regression logic retained. | No native archive/runtime for this candidate. Windows remains unsigned. |
| **Linux x64** | Corrected measured-media and build jobs prepared. | No new runner execution, native archive, desktop output or Wayland check. |
| **Python/browser** | Full Python/frontend tests; actual local browser, themes, navigation and large library. | No claim of every browser/codec/device combination. |

The production profile/stable server-port mechanism is unchanged. The upgrade uses
the same origin at all three launches; the isolated test app's variable-port issue
was not reintroduced. The packaged candidate permits ordinary settings and does
not carry isolated-test write restrictions.

## Large-library and visual validation

Synthetic dataset: **300,000 tracks / 30,000 albums / 1,500 artists**, 10 tracks per
album, controlled upload dates/paths. It does not model every possible credit,
playlist or cache configuration.

| Measurement | Observed locally |
| --- | --- |
| Cold album-summary index | 1,588.9 ms |
| Search cold / warm | 999.4 / 43.6 ms |
| Overview statistics, cold | 1,061.9 ms |
| Upload folder index cold / warm | 926.7 / 14.4 ms |
| Upload day index, cold | 335.4 ms |
| Benchmark Python peak RSS | 497.3 MiB |
| `/api/library` response | 17.08 MB, 30,000 compact album summaries, **zero track rows**; 1,752.2 ms local receive and 79.4 ms decode. |
| Track search `Needle` | 300 bounded matches; 90,170 bytes, 44.3 ms receive. |
| One upload day | 1,111 qualifying album IDs; 9,714 bytes, 1.4 ms receive, **zero track rows**. |

HTTP timings use the already-loaded synthetic local server, not a cold remote
sync or CDN benchmark. Peak RSS is for the benchmark process, not total desktop
memory. No universal startup-time or RAM claim follows.

The actual browser loads this collection, finishes the indicator, searches tracks,
paginates and browses the day as album cards (page 1 then page 2 of 47). No captured
console errors. Editing/export internals remain covered by the automated suites;
a complete interactive 300k edit/export session was not rerun.

Upload detail screenshots/checks cover **420, 760, 761, 768 and 1280px**, plus all
four palettes in Light/Dark at desktop size. Cards, counts, search, sort and paging
remain usable without document horizontal overflow. Search Tab reaches a visibly
focused sort control. Opening an album and Back restores its group. Images contain
fictional sample data, not the user's Overview/account.

## Documentation prepared, not published

- README: concise local-candidate notice, new features, provider limits; public
  0.85.1 links retained. Existing curated screenshots are retained.
- Beta notes: `.github/release-notes/1.0.0-beta.1.md`.
- Stable English announcement: `.github/release-notes/1.0.0-announcement-draft.md`;
  explicit unpublished label, to be finalized only after quality gates.
- `docs/write-reliability.md`: exact transport, uncertainty and read-back contract.
- `docs/release-preparation/1.0/wiki-candidate.patch`: seven existing pages,
  existing URLs/headings/anchors retained, Mini screenshot reused. Existing
  illustrated album merge, Various Artists and imports stay intact.
- `website-stable.patch`: staged local patch only, for deployment after all four
  stable 1.0.0 archives exist. Latest-stable lookup/cache and deployment logic unchanged.
- Wiki/source patches pass `git apply --check` against their inspected bases.
  Markdown was rendered locally and headings/anchors/image paths checked. Website
  static/theme/link tests pass. A final in-browser file-preview was blocked by the
  browser's local-file URL policy, so no new browser-rendering claim is made for
  these documentation drafts; no alternative access route was attempted.
- iBroadcast's [official account-limit announcement](https://news.ibroadcast.com/an-important-update-on-ibroadcast-s-pricing)
  is linked without promising unlimited storage/bandwidth, new API quota fields,
  plan-name capabilities, full feature parity or automatic library restoration.

## Local distribution

File: `dist/packages/tagcast-1.0.0b1-macos-arm64.zip` (**145,686,302 bytes**).
SHA-256:

```text
e10c563f131537c36f208b5574f75e7fa4bd6ea277da89d593d3762e0e435826
```

Built from frozen source using bundled Python 3.13 and Electron 44.9.3. Extracted
bundle verification passes; the CLI is included. Packaged index/version, browser,
Settings, Mini and audio-engine files equal the checked source. Archive inspection
finds no tests, fixtures, `.git`, `.env`, user `.tagcast` or development node_modules.
macOS ad-hoc signature is an integrity signature, not Apple notarization.

The candidate uses the normal production profile. Quit the existing app before
testing it; do not run it as though it were the isolated Gapless Test profile.

## Remaining gates and deliberately deferred work

1. **Before public stable:** obtain publication-stage approval, push/PR, require
   exact-commit tests/media gates and native macOS arm64/x64, Windows and Linux
   builds/checksums. Do not use old CI or missing measurement reports as success.
2. **Before declaring cross-platform runtime support verified:** perform short
   Windows/Linux desktop checks for sign-in/load, ordinary audio, queue, Mini,
   draft/review, preferences and normal fallback. Intel hardware check if available.
   Build-only success must stay labelled build-only.
3. **Before final public announcement:** set the agreed stable version in source,
   regenerate/reverify all platform assets, finalize stable notes and availability,
   then publish/deploy the prepared documentation only under explicit approval.
4. **Non-blocking follow-up:** targeted `fast-uri` build-tool patch; signing/notarization;
   hardware output/sleep/wake and multi-hour observations. No current evidence
   warrants an engine rewrite, general UI work or new features.

No broader redesign/refactoring, artist merge, downloads, uploader, new monitoring
framework or second audio engine was added. Unproven risks were documented instead
of turning this stabilization into another development programme.

## Evidence and reproducibility

Local bundle:
`/Users/cyberdelia/Documents/GitHub/tagcast/build/v1-stabilization-2026-10-27/`.

- `python.log`, `frontend.log`, `electron-tests.log`, `lint.log`, `npm-audit.json`.
- `frozen-media/results.json`, `frozen-application/results.json`,
  `frozen-negative/results.json`, per-case JSON/PCM and `soak/results.json`.
- `build-macos.log`, `upgrade.json`, `upgrade.log`, `artifact.json`, `SHA256SUMS`,
  `package-static.json`.
- `large/benchmark.json`, `large/http.json`, `large-track-search.png`,
  `large-upload-albums.png`, `visual-checks.json`, before/after/theme/width images.
- `wiki-prepared/`, `wiki-preview/`, `website-prepared/`, `website-checks.log`.
- `comparison.html` presents the main before/after and evidence links.

Core rerun commands from the checkout (media fixtures require the existing test-only
ffmpeg runtime; do not substitute live account music):

```sh
PYTHONPATH=src:tests python -m pytest -q
ruff check src tests tools
node --test tests/*.test.cjs
node --test electron/tests/*.test.cjs
python tools/release_info.py
python tools/build_dark_css.py --check
node tools/gapless_lab/fixtures.cjs /tmp/tagcast-fixtures --stress
electron/node_modules/.bin/electron tools/gapless_lab/electron.cjs --fixtures /tmp/tagcast-fixtures --out /tmp/tagcast-media --suite smoke --stress
electron/node_modules/.bin/electron tools/gapless_lab/electron.cjs --fixtures /tmp/tagcast-fixtures --out /tmp/tagcast-diagnostics --suite diagnostics --stress
electron/node_modules/.bin/electron tools/gapless_lab/application.cjs --fixtures /tmp/tagcast-fixtures --out /tmp/tagcast-application --stress
node tools/gapless_lab/verify.cjs /tmp/tagcast-media /tmp/tagcast-diagnostics /tmp/tagcast-application
node tools/gapless_lab/negative.cjs --fixtures /tmp/tagcast-fixtures --out /tmp/tagcast-negative
```

On Linux use the workflow's virtual output and sandbox setup. The new workflow's
negative job must observe exit 1 inside each intentionally failing subprocess,
while the enclosing negative-check command succeeds only when all six proofs pass.
