# Gapless release candidate — final integration and validation

25 October 2026. Candidate: **0.81.0 beta 1** (`0.81.0b1` / prospective tag `v0.81.0-beta.1`), following the existing prerelease convention. No tag, push, main merge or release has been performed.

## Recommendation

**GO for the locally prepared macOS Apple Silicon candidate and a subsequent reviewed PR/CI run. NO-GO for declaring the multi-platform release ready until this exact candidate passes hosted platform checks.** No remaining reproducible audio-engine defect was found in this round. Windows/Linux/Intel candidate verification is pending because it requires an authorized push; old main build results are not substituted for candidate results.

The user reports successful real-world listening with the isolated macOS app. That is user-reported practical evidence, not a measured statement about every format, duration or output device. The candidate retains that validated engine without additional playback optimizations.

## Integration review

The clean branch starts at `2af2c3f`, contains current `origin/main` (`020d265982722a038bb13dac6ae11538f4587f67`) plus its thirteen local gapless/Settings/status commits, and excludes the prototype's untracked review packages and the primary checkout's unrelated WebView/exporter work.

| Area | Review result |
| --- | --- |
| Normal playback | Gapless defaults off in a fresh profile; the ordinary native source/seek/Next/Previous/ended path remains active. A real Electron scenario covers those controls with Gapless disabled. |
| Audio architecture | `gapless-media.js`, `player.js`, `playback.js` and `gapless-controls.js` are byte-identical to the tested prototype. All `gapless.js` engine functions from `gaplessNote` onward are identical; only Settings descriptions and the initial ready message change. Single native audio element, MSE/SourceBuffer, buffers, parser, queue and fallback architecture are retained. |
| Production identity | Normal `Tagcast` app name/product/identifier restored, with the existing profile and backend-home rules. Forced changing port and isolated credentials/profile policy are removed. Default remains `127.0.0.1:8912`; explicit environment overrides remain supported. No private-test credentials/profile are migrated. |
| Preference persistence | The extracted native app was exited and restarted using one temporary profile and fixed test port. Gapless, compact-player quality visibility, Now playing view, Light theme, Warm palette, Original quality, play reporting and queue-sync preferences survived. Startup code for the production default matches main; it does not force port zero. An explicitly changed port still creates a different web origin, as expected. |
| Removed test restrictions | `validation.cjs`, the backend POST allowlist, validation flag/state fields, disabled controls and forced play-reporting/queue-sync values are removed. A retained old `TAGCAST_PLAYBACK_VALIDATION=1` environment value has no effect on the production backend. |
| Native library operations | Existing Python mocks cover security, connection, library reads/writes, metadata/editor review/save, tags, playlists, artwork, lyrics, play reporting and queue sync. Candidate settings accept and persist native playback preferences. No real account writes were used to establish these results. |
| Settings integration | Routed Settings, Back/Forward/editor-draft protections and local-versus-Save preference behaviour are retained. The old package smoke test still called the removed modal's `.close()`; it now calls the routed `closeSettings()` helper. |
| Queue sync / reporting | Existing native logic is restored without policy overrides. Active queue sync intentionally uses normal playback. Gapless track-relative state continues through the existing play-reporting hooks; the established guarded/deduplicated reporting implementation is unchanged. |
| Failure recovery | Actual frontend/native media tests cover initial quota failure, incompatible block transition, deliberately stalled playback, late sessions/replies, seek and queue changes with ordinary fallback. Explicit skips/unsupported transitions are not claimed gapless. |
| Diagnostics | Optional, bounded, anonymous in-memory support log retained; off on each launch. It does not alter engine policy or automatically save/upload. |

## Final automated and native results

- **518 Python tests + 1,785 subtests passed.** This includes existing save/security/queue/reporting tests and a targeted normal-preference restart check. The isolated-policy tests are deliberately removed with that policy.
- **486 frontend/media/parser/oracle/diagnostics unit tests passed.** Added a focused normal-player test with Gapless disabled and native seeking/Next/Previous.
- **10 Electron shell tests passed.** Existing ownership/security/Help checks plus normal identity/stable-port configuration regression.
- **10/10 complete-application Electron scenarios passed**, using private synthetic FLAC endpoints: Gapless-disabled native playback, startup failure recovery, mixed block fallback, injected stall recovery, pause/seek/speed/session handling, Repeat/queue edits, evicted backward seek, prepared skip reuse, late queue replacement and high-rate startup.
- **15-minute actual-timeline Electron soak passed:** Original 24-bit/44.1 kHz FLAC repeated in the real frontend, 900.067 seconds, 1,266 observed segment changes, unchanged audio element, synchronized current queue entry, no unexpected fallback, stuck player or exceeded preparation bounds. Output was muted; no audio recording or real iBroadcast account was used.
- **Existing exact PCM evidence reused**, because engine functions/codec/transport are unchanged: 31/31 measurements in `build/gapless-real-world-2026-10-25/measured-diagnostics/results.json`; 16 full engine runs establish 20,749,929 exact sample frames across 30 boundaries, calibrated by twelve single-file controls. Two partial seek probes and one intentional fallback are excluded from complete-run accuracy claims. Includes short tracks, Repeat and 96/192 kHz fixtures. This is not a claim of universal or physical-output sample accuracy.
- **Actual Apple Silicon archive built, extracted and checked**, including bundled CLI help/version, sandbox/context isolation, shared static assets, version agreement, owned-server shutdown and strict ad-hoc signature. The extracted app also passes the two-launch persistence test. Frozen Python 3.13; Electron 44.9.0 / Chromium 152.0.7977.167. No renderer/CSP errors.
- **Ruff, JavaScript parse checks and version consistency pass.** No new runtime dependencies or frontend framework. No CSS/design changes.

## Soak memory evidence and its limits

Fifty-nine renderer samples and sixty process snapshots were collected about fifteen seconds apart. Prepared audio stayed at **576,686 bytes**, with **two prepared-map entries**. Native buffered time stayed between **5.20 and 7.71 seconds**. The reported JavaScript heap ranged from **3.30 to 15.54 MiB**, ending near **11.47 MiB**.

The harness's summed Electron working-set snapshots went from approximately **601.5 to 539.4 MiB** (peak approximately 626.4 MiB), with a lower late median rather than positive drift. These process sums can count shared pages more than once and include laboratory request/event bookkeeping; they are not deduplicated application RAM or SourceBuffer occupancy. The private-byte counter returned zero on this runtime and is treated as unavailable, not zero private memory. This establishes bounded preparation and no uncontrolled growth in this fifteen-minute synthetic session, not proof that hours of real CDN/backend playback cannot leak.

## Platform verification

| Platform | This candidate | Earlier main baseline |
| --- | --- | --- |
| macOS Apple Silicon | Locally built, extracted, signed and app/CLI/restart checked; actual synthetic native media/control/soak tests; user reports good real music on unchanged engine | Green native build |
| macOS Intel | Candidate build/runtime pending | Green build on main |
| Windows x64 | Candidate build/runtime pending; no physical audio test | Green build on main |
| Linux x64 | Candidate build/runtime and measured-media CI pending | Green build on main |

Baseline: [Builds for main 020d265](https://github.com/cyberdeliaAI/tagcast/actions/runs/40115147538) passed all four native build/check jobs; [Tests for that main commit](https://github.com/cyberdeliaAI/tagcast/actions/runs/40115147619) passed. Those commits do not contain the gapless candidate. Existing PR workflows already provide Python 3.11/3.13 across macOS/Windows/Linux, four native packages and the Linux deterministic-media job. No workflow was dispatched against a different revision to manufacture a candidate result. No local Windows/Linux virtualization runtime was available; PyInstaller cannot cross-compile these packages from macOS.

## Artifact, documentation and remaining gates

The local archive is `tagcast-0.81.0b1-macos-arm64.zip`, with SHA-256:

`a78769334df7c89c861a07e4ef5f3820587bd2f1704f155611a7550c1171b876`

Release notes, README availability note, Settings limits, production desktop notes and [Gapless playback guide](gapless-playback.md) are prepared. Wiki changes are committed separately in a clean local Wiki clone, preserving existing addresses/anchors and released 0.80.0 instructions. They have not been pushed.

Remaining gates/limitations:

1. Authorization to push the candidate branch/open a PR, then success of the **candidate's** hosted tests/native builds/media jobs, is required before multi-platform publication. No tag/release/main merge is authorized here.
2. Physical sleep/wake, hotplug/output-device changes, AirPlay and longer real-CDN sessions were not independently exercised in this round. Unit tests retain output-selection/error behaviour; synthetic tests do not establish hardware routing accuracy. The user's successful listening is recorded without inventing its duration or device coverage.
3. Gapless is experimental/off by default, normal ordered albums only. Preparation can delay startup/near-end seeks. Incompatible block/format, oversized/unsupported media, slow preparation and decoder failures can use ordinary playback. MP3 real-stream decoded alignment remains unestablished. These are documented limits rather than reasons to optimize the engine speculatively.
4. The candidate uses normal settings and enables ordinary reviewed iBroadcast operations; unlike the private listening app it is not read-only. Quit an older Tagcast before using the candidate with the normal profile. No installed app has been replaced by this preparation.

Evidence: `build/gapless-rc-2026-10-25/` contains suite logs, `soak-summary.json`, native per-case results, archive/checksum, `electron-restart.json`, build logs, protected-worktree records and the local Wiki clone. Generated apps, captures, profiles and account data are not committed.
