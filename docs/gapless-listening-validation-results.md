# Isolated gapless listening build — validation results

Date: 25 October 2026. Base engine: `339930b8e8e7eba8bb669c18f9705c3477f92c2c`. This report covers preparation and automated validation, not completed real-world listening. No real iBroadcast account, music stream or account write was used in these checks.

## Result

**GO for a private listening test; not yet a release-candidate recommendation.** The actual Apple Silicon Electron bundle starts, is sandboxed, retains its CLI, blocks account-library writes and shuts down its owned local server. The deterministic and full-interface regression suites pass with optional diagnostics enabled. Real CDN variability, physical outputs and long-session behaviour remain to be checked by the user with the [listening checklist](gapless-listening-validation.md).

No playback algorithm, scheduling gate, stream reader, codec/parser, queue algorithm, native audio element or track-relative transport was changed for this task. SHA-256 comparisons confirm that `gapless.js`, `gapless-media.js`, `player.js`, `playback.js` and `gapless-controls.js` are byte-for-byte identical to the base commit, both in source and the frozen bundle.

## What was prepared

- Separate app identifier `nl.cyberdelia.tagcast.gapless-validation`, profile `Tagcast Gapless Validation` and backend home `.tagcast-gapless-validation`. Ordinary launches ignore inherited normal profile/home overrides. Existing build checks may explicitly use disposable temporary locations. Two concurrent backend tests confirm distinct owned loopback ports.
- The native installed release and older Gapless Test app were not replaced or stopped. Their bundle metadata, executable and ASAR hashes match their recorded pre-task values.
- The isolated GUI starts its backend with `TAGCAST_PLAYBACK_VALIDATION=1`. A fail-closed POST allowlist permits authentication, local settings and explicitly selected reads, rejecting library saves, tags, playlists, ratings, artwork, lyrics writes, trash, play reporting and queue-sync actions. Startup forces play reporting and queue sync off; settings reject attempts to enable either before changing other preferences. Normal launches without the flag retain their existing behaviour.
- Native/global service reads remain available. Sign-in is fresh; no credentials, catalogue or cached private metadata was copied from another installation. No account/settings files or lab fixtures are embedded in the app.
- Optional diagnostics attach reversible wrappers and native media event listeners only while explicitly enabled. They keep at most 2,000 whitelisted anonymous events in memory, restore original functions/methods and release the previous SourceBuffer on cancellation/replacement. They do not poll, change playback decisions, record audio, upload or automatically write files. Performance timestamps use `performance.now()`; a wall-clock start time and numeric runtime versions provide context. Total memory is intentionally measured manually in Activity Monitor.

## Automated results

| Check | Result | Scope |
| --- | --- | --- |
| Python suite | 520 tests + 1,785 subtests passed | Existing backend/security/review/save suite plus the isolated validation gate; Python 3.14 locally |
| Frontend, media/parser, oracle and diagnostics units | 485 passed | Includes off-by-default, bounded/private export, wrapper restoration, late completion and unchanged quota exceptions |
| Electron shell suite | 12 passed | Existing security/Help/ownership plus profile isolation and two concurrent validation servers |
| Deterministic Electron media suite with diagnostics enabled | 31/31 passed | 16 complete engine PCM runs, 12 unified single-file controls, two explicitly partial seek probes and one intentionally normal-fallback boundary |
| Exact measured complete-run signal | 20,749,929 sample frames across 30 boundaries | No missing/duplicated samples or channel mismatch in these synthetic supported FLAC cases; no speaker/AirPlay claim |
| Full Tagcast application with diagnostics enabled | 9/9 passed | Startup quota fallback, mixed-block fallback, injected stalled recovery, pause/seek/speed/session cancellation, Repeat/queue edits, evicted backward seek, prepared skip reuse, pending queue replacement and high-rate startup |
| Bundled app/CLI smoke | Passed | Frozen Python 3.13 backend, Tagcast 0.80.0 experimental branch, Electron 44.9.0 / Chromium 152.0.7977.167, macOS arm64; no renderer/CSP errors |
| Build identity/defaults | Passed | Own profile; Gapless off and diagnostics off in a fresh profile; writes HTTP 403, forbidden recording setting HTTP 400; same native audio; in-window Now playing retained |
| Visual check | Passed | Actual packaged diagnostics at desktop and 420px; no horizontal overflow in the narrow check; existing native checkbox/button/focus styling |
| Parse/lint/version | Passed | 42 frontend/shell scripts parse; Ruff clean; package/sidebar/lock/version check remains 0.80.0 |
| Signing/bundle content | Passed | arm64 executable, deep/strict ad-hoc signature, source/bundled asset hashes agree; not notarized or publicly distributed |

Source settings and playback flags remain at their established defaults. The Electron test profile is not the installed application's profile. No push, tag, merge or release was made. Existing untracked review packages remain untouched.

Evidence is retained locally under `build/gapless-real-world-2026-10-25/`: suite logs, `summary.json`, `measured-diagnostics/results.json`, per-case JSON/PCM captures, `application-diagnostics/results.json`, desktop/narrow screenshots, build output, bundled smoke report and bundle verification. The anonymous event collector retained at most 641 rows in these media runs; a separate unit test exercises dropping beyond 5,000 events. Generated PCM, app bundles and profiles are not committed.

## Known limitations and open validation

- The shell's existing free-port launch policy changes the web origin. Browser-only preferences, including the Gapless switch, may reset after restart despite the persisted profile directory. Recheck that switch before each listening session; backend streaming quality and sign-in persist separately. No port/storage redesign was introduced here.
- Current-file full preparation remains necessary. Near-end readiness holds, incompatible FLAC block/format fallbacks and unsupported MP3 fallbacks remain as documented in the implementation review. An explicit Next/Previous or a changed queue is not promised seamless output.
- Normal playback controls remain available. Remote iBroadcast queue sync, library editing and listening history are intentionally unavailable in this safety build; use the normal installed app for those tasks.
- Subjective listening is still pending. No actual live album, real CDN latency, built-in/external audio device, AirPlay, network interruption, sleep/wake or 30–60 minute session was verified for this delivery. Memory snapshots from short synthetic recorder runs cannot establish long-session leak freedom.
- Windows/Linux builds, hosted CI and notarization were not run; the requested deliverable is a local Apple Silicon test. The relevant unit test command is wired into the existing CI workflow, but no remote workflow was triggered.
- Diagnostics add finite execution overhead when enabled. Passing synthetic measurements is evidence for those inputs, not a guarantee for arbitrary media or physical output. The MP3 path's real-world decoded alignment remains unestablished.

No additional playback defect was reproduced in this preparation. Further changes should follow an actionable listening report, not speculative optimization.
