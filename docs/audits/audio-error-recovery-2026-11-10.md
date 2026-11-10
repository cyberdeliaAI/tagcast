# Audio error recovery — B-02

Baseline: `b7fdfd72e9572c5e9efe80a026620f646ed06b6b`, after merged PR #49.
Main Tests run `42843517708` and Builds run `42843517785` succeeded before
development. Tests required a second attempt for the previously observed Windows
download-manifest file-sharing race; this was not an audio failure. Release
`v1.6.5` and its tag remain unchanged. Scope is B-02 only.

## Confirmed failure

The ordinary player's `error` handler discarded the listening watch and displayed
a toast. It had no recovery path. Original quality fell back to 128 kbps for any
error, without distinguishing a network failure from authentication or decoding.
Gapless already had its own bounded fallback; queue memory was not the cause.

Reproduced on the baseline in Chromium 158.0.8127.18 with the real Python host,
stream proxy and a throttled synthetic WAV from a loopback iBroadcast mock. A
mid-body socket disconnect produced `MediaError.code === 2`, paused at
2.218175 seconds and discarded the reporting watch. Restoring the upstream and
waiting another 1.8 seconds produced no new requests or progress. The queue entry
was unchanged. The focused frontend regression failed before implementation.

## Recovery and ownership

`static/playback-recovery.js` coordinates ordinary-source restarts; it does not
implement another audio engine. `player.js`, system controls, the Mini Player and
queue-sync controls use that same coordinator and existing audio element.

- A terminal media network error, or a media source error confirmed as transient
  by the proxy, permits **one** automatic source reload for the selected queue
  occurrence. Duplicate error events coalesce. A second failure stops visibly;
  restoring connectivity alone cannot start another retry. Explicit Play can
  retry without resetting the automatic budget. New track selection starts a new
  budget. A prior Gapless fallback consumes the ordinary automatic budget.
- The attempt starts after 500 ms. Offline attempts wait for `online` within a
  30-second recovery deadline. This bounds recovery state, not ordinary streams;
  existing stream, OAuth, decoder and Gapless timeouts remain unchanged. There is
  no startup delay, background polling, audio probe or automatic track skip.
- Each normal source has a fresh opaque request ID and existing playback-session
  identity. The proxy records already observed headers/body errors. The local
  `/api/playback/stream-status` GET returns only an outcome enum, with no upstream
  requests. At most 64 observations survive for 120 seconds; connect/disconnect
  clears them. No audio, token, signed URL, client or library is retained there.
- HTTP 408/500/502/503/504 and transport failures are transient; 401/403,
  certificate failures, unavailable tracks and other rejected statuses are not.
  In particular, 429 is not automatically retried. Browser cancellation is not
  classified as an upstream network error. A later Range success cannot erase
  an observed terminal rejection. Unknown observations block automatic network
  recovery; an explicit user retry is separate.
- Decode errors and unsupported formats do not receive a network retry. The
  existing one-time Original-to-128 codec fallback remains available, preserving
  position and pause intent. An Original network interruption reloads Original;
  authentication failures do not trigger a quality downgrade.
- The record binds the exact queue-entry object, generation, current library
  details map, account playback session and effective streaming quality. Stop,
  navigation departure, application shutdown and new selection abort work;
  replaced sessions/libraries and late results cannot restart playback. No
  recovery state or source URL is added to persistent queue memory.
- Metadata readiness and completed seeking precede resumption. Only `playing`
  confirms resumed playback. Pause/seek during preparation override captured
  intent/position; superseded play promises cannot override newer intent. A
  seek to the exact end stays paused without advancing the queue. Speed, volume,
  metadata, queue order, shuffle and repeat are retained. Existing controls show
  preparation and allow Pause even if duration is unknown.
- Electron's normal shutdown/reopen notifications cancel recovery without
  altering the protected-write drain protocol. Reopening never resumes it
  automatically. Timers and the local classification request are cancelled;
  shared media listeners are installed once, not per attempt.

## Listening history and Gapless

Reloads retain the same watch object, event ID, start timestamp, accumulated
listening and attempted flag. Waiting, recovery, seek jumps and sleep wall time
cannot add listening time. Already sent, unconfirmed or response-lost play writes
remain single-use; the iBroadcast reporting protocol and server deduplication
are unchanged.

Gapless keeps its existing preparation, buffering, FLAC parser, PCM timeline and
failure ownership. Its fallback now samples/freezes the existing watch and marks
normal playback as a continuation instead of starting another reporting event.
An error handled by Gapless does not also schedule ordinary recovery. No changes
were made to `gapless-media.js`, visualization DSP, audio output or queue storage.

## Validation

All service traffic used synthetic credentials, disposable settings and loopback
mocks. No real account or music was accessed and no real remote writes occurred.
Full logs, screenshots, baseline reproduction and JSON measurements are retained
under the main checkout's ignored
`build/audit-audio-recovery-2026-11-10/`; PCM artifacts are in this worktree's
`build/gapless-{smoke,diagnostics,application}/` directories.

| Check | Result |
| --- | --- |
| Full Python 3.11 and 3.13 suites | Each: 969 tests and 2,585 subtests passed |
| Full frontend, translation and Electron Node suites | 857 passed, including 797 frontend tests |
| Ruff, generated translations, JavaScript parsing, release versions | Passed; no version/dependency change |
| Extracted macOS ARM64 Electron 44.9.3 package | Startup, CLI, sandbox, shared interface, CSP, signatures and all 15 shutdown/restart cases passed |
| Isolated PCM smoke | All 12 cases plus 12 independently encoded references passed |
| PCM diagnostics | All 7 required stress cases passed |
| Actual application Gapless suite | All 10 cases passed |
| Independent Gapless verification and negative harness | Passed; deliberate invalid runs returned failure |

New backend tests cover header/body classification, safe local status reads,
cache bounds/expiry/priority, cancellation, connect/disconnect and stale session
guards. New frontend cases cover all fourteen requested failure/state categories,
including offline wake simulation, non-zero seek, retry exhaustion, unchanged
quality, codec fallback, auth/TLS/decode/cancellation, shutdown, account/library
replacement, actual queue-occurrence identity and sent/uncertain reporting.
Final review also reproduced two edge cases before correction: a user seek made
after autoplay rejection was lost on explicit Play, and an already timed-out
classification response could affect a newer explicit attempt on the same queue
occurrence. Prepared sources now apply that seek directly; classification replies
must still own the active attempt after JSON completion. Both have focused
regressions in the full passing suite.

The optional `tools/check_audio_recovery.cjs` drives real media events through
`tools/browser_audio_fixture.py`, not DOM-injected error events or substituted API
responses. It checks one source reload, one local diagnosis and no extra UI or
upstream play write. The reporting measurement waits for the first actual
successful play response, not merely the earlier client-side attempted flag.
The native probe checks the frozen served code's SHA-256 against the candidate.
Native close coverage uses the existing extracted-package shutdown harness:
its active-stream case injects pending recovery, calls the real
`BrowserWindow.close()` path and asserts cancellation, paused audio, inactive
reporting and the same watch before the backend exits. This complements the
probe's genuine socket-disconnect cases and real Mini Player Pause command.
DevTools target disposal bypasses that application close interception and is
not used as evidence of graceful shutdown.
Use a separate installed Playwright and the project Python, for example:

```sh
TAGCAST_PYTHON=/path/to/project/python \
NODE_PATH=/path/to/playwright/node_modules TAGCAST_AUDIO_ENGINES=chromium,firefox \
node tools/check_audio_recovery.cjs build/audio-recovery

TAGCAST_PYTHON=/path/to/project/python \
NODE_PATH=/path/to/playwright/node_modules TAGCAST_AUDIO_ENGINES=electron \
TAGCAST_AUDIO_EXECUTABLE=/path/to/extracted/Tagcast.app/Contents/MacOS/Tagcast \
node tools/check_audio_recovery.cjs build/audio-recovery-native
```

Initial measured recovery (terminal media error to resumed forward progress) was
4.67 s in Chromium 158, 7.26 s in Firefox 159, and 4.68 s in the extracted native
Chromium 152. These are controlled-fixture measurements, not service latency
promises. Each retained the same queue entry/watch and exactly one reported play
before and after recovery. The synthetic stream deliberately limits buffering.

## Limits and regression risks

WebKit 27.2 plays the fixture but stays in native buffering after the injected
disconnect, without a terminal media error even though the proxy records a network
failure. Position stopped around 5.36 s; restoring the test upstream did not make
that existing source progress. Consequently this fixture does **not** validate
WebKit's error-triggered recovery. The strict probe reports failure instead of
claiming success. This change deliberately does not turn ordinary `waiting` or
`stalled` events into retries: those events can occur while buffered audio still
plays. Actual Safari and physical sleep/wake/output-device changes need separate
practical validation; the automated wake case tests state and elapsed-time safety.

The PCM smoke checks establish continuity for their deterministic inputs only.
The mixed-block diagnostic intentionally verifies boundary fallback, and early
seek is a partial policy check; neither claims full-album PCM continuity. The
near-end case verifies its identified tail. Physical output, AirPlay and arbitrary
real recordings are outside these measurements.

Recovery depends on a terminal media error, a still-current session and a useful
position/seekable source. Expired observations fail closed. Persistent outages or
autoplay restrictions remain visible and require explicit user action. More
complex retry/backoff or automatic stall detection is not introduced.
