# Gapless listening validation — isolated macOS test

This is a private Apple Silicon listening build, not a release candidate. The MSE/SourceBuffer engine, native audio element, queue, fallback and track-relative transport are unchanged from the three completed improvement phases. Do not use a listening impression as evidence of sample accuracy: the deterministic PCM suite is the reference for the measured cases.

## Start safely

1. Open **Tagcast Gapless Test.app** in the new `Gapless-validation-2026-10-25` test folder. Leave the installed Tagcast application in place. The Dock name is the same as the earlier experiment; check the folder when opening it.
2. Sign in again. This build does not copy an existing token or library. Its Electron identifier is `nl.cyberdelia.tagcast.gapless-validation`, browser profile is `~/Library/Application Support/Tagcast Gapless Validation`, and backend settings are `~/.tagcast-gapless-validation`. Backend sign-in/settings and the separate profile directory persist across subsequent listening sessions. The backend asks the OS for a free loopback port; it does not reuse the normal app's server. Do not manually copy your normal settings into these folders.
3. Open **Settings → Playback**. Gapless is experimental and **off by default in this fresh profile**. The browser remembers that choice for the current local address. Because the shell requests a fresh free port, browser-only choices can return to their defaults after a restart: check the Gapless switch each time. This existing shell limitation does not reset the backend sign-in or saved streaming quality. Diagnostics are off on every app launch.
4. For the first tests, choose **Original file (Premium)** and Save. Enable **Gapless playback** and then start an album with **Play album** in normal album order. The preference applies on the next track.
5. This listening build blocks library writes at the backend, including ratings, lyrics, artwork, tags, playlists, trash and play reporting. Queue sync and listening history cannot be enabled. Local playback/queue changes and streaming-quality preferences still work. Editing controls elsewhere can remain visible, but saving returns a clear error. Use the normal app for library management.

Account authorization and read requests still contact iBroadcast. Device sign-in works independently; remote queue testing is intentionally excluded to avoid altering the account. No local music files are modified.

## First round: three albums, about 20–30 minutes of active checks

Choose albums you already know. The examples below describe types, not a prescribed catalogue.

| Test | What to do | Expected result |
| --- | --- | --- |
| Continuous FLAC | Play several transitions on a live album with constant audience sound or an album with joined tracks. Listen once with Gapless off and again with it on, starting a fresh album run each time. | Supported transitions have no added pause/click. Intentional silence in the recording stays intact. |
| Short interludes | Play through several short consecutive tracks, including one under ten seconds. | Correct track order and titles; no stuck Preparing/Waiting. Startup may wait for an extra following track. |
| Higher resolution | Try a known 24-bit/96 kHz or 192 kHz FLAC album if available. | Playback progresses and finishes, or clearly falls back to standard playback. No claim of support follows from the file extension alone. |
| Seek that previously failed | Immediately after starting a long album track, drag the time bar to about ten seconds before the end. Repeat once after preparation has finished. Also seek normally within a track. | A near-end seek may briefly wait while current audio continues. The displayed position remains relative to the current track; playback eventually proceeds or safely falls back. A permanent hold is a defect. |
| Everyday controls | Pause/resume; Next/Previous; change speed then restore 1×; enable Repeat; remove or replace a following queue item. | No doubled audio, stale title, wrong track or broken time bar. Explicit skips/queue edits need not themselves be gapless. |
| Excluded modes | Start Shuffle album, Random Album and a playlist. Disable Gapless and start an ordinary album again. | These use normal playback. No unsupported transition should be described as gapless. |

Then let a supported album/queue run for 30–60 minutes while using the app normally. Record total app memory in Activity Monitor around 5, 30 and 60 minutes, noting all related Electron/helper/backend processes. A single renderer's JavaScript heap is not total app memory; a temporary peak or cached buffer alone is not evidence of a leak.

## Diagnostics: only when useful

Open **Settings → Playback → Optional playback diagnostics**, enable **Collect playback diagnostics**, then reproduce the issue. Stop collection if desired and choose **Download diagnostics**. Re-enabling starts a fresh log; closing the app loses it. Download before quitting.

The JSON contains at most 2,000 recent events (older events are dropped in bounded batches): anonymous queue positions, preparation times/format numbers, buffer append/removal timing and byte counts, boundary events, native waiting/stalled/seek/pause/speed events and coarse fallback categories. `ms` uses a monotonic clock relative to collection start; `started` is a wall-clock timestamp. Runtime versions are numeric only. A missing event after collection started mid-track is not proof that preparation did not happen.

No names, native track IDs, account data, authentication tokens, stream URLs, raw exception messages or audio are included. There is no automatic upload, disk log, recurring diagnostic timer or memory sampler. MediaSource events describe the browser buffer, not measured speaker output. Buffer byte counts do not equal total application memory. Diagnostics add some execution overhead when enabled; compare with them off if timing changes.

To report a failure, include the action (for example, immediate seek to ten seconds before the boundary), elapsed time, anonymous track position, Original/MP3 quality, output device, expected/actual behaviour and whether it repeats with diagnostics off. A voluntarily supplied album name can help reproduction, but the diagnostic file does not collect it. Keep a short result note even when a transition succeeds.

## Optional second round

Only deepen testing if the first round is stable or reveals a reproducible issue:

- Built-in speakers versus an available external device. For AirPlay, keep **System default** in Tagcast and select the device in macOS. Hardware/output buffering is a separate test from pre-output PCM continuity.
- Brief network interruption, followed by recovery; sleep/wake; a longer session; rapid repeated controls. Do not interrupt another app's work merely to test these.
- Mixed block sizes, sample rates, channel layouts or unsupported files: standard fallback can be intentional. A transition that changes FLAC decoder format is not promised gapless.
- MP3 separately. Reliable encoder metadata is required; earlier real header checks did not establish decoded sample alignment. An MP3 fallback is expected for unsupported streams and is not itself a FLAC regression.

## Decision rule

A release-candidate recommendation needs successful real iBroadcast listening, sensible startup/seek behaviour, safe fallback, synchronized UI/queue and bounded memory in a longer session. Synthetic PCM tests must remain exact for their supported cases. A reproducible stuck player, wrong order, duplicated audio or silent loss of a supported transition blocks that recommendation. Unsupported formats taking the documented standard path do not.

No GitHub push, tag, merge or release is part of this validation. Do not add further playback optimizations without a reproducible failure and evidence.
