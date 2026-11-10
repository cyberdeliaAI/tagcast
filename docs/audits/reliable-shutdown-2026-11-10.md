# B-01: reliable application shutdown

Baseline: `3688daf2c2314ad691ce53b1ba8c71e6c5bb532c`, PR #47 merged.
Its post-merge Tests run `42806018107` and Builds run `42806018487` succeeded.
The release-only follow-up was skipped as intended. This change does not create
a release or alter `v1.6.5` (`3eaab0e77083b24e98a894c0c515e1bbd6dca9ab`).

## Independently confirmed causes

- `ThreadingHTTPServer.server_close()` joins non-daemon handler threads. A TCP
  connection that sends nothing leaves a handler blocked in request parsing.
  The old owned host exited in 0.439 s when idle, but remained alive for the
  entire 2.005 s observation with one inactive TCP connection. Closing that client
  released it immediately. This reproduces the audit's failure without credentials.
  After the fix, three empty-home samples per case exited successfully with the
  client still open: idle 0.535–0.549 s, inactive TCP 0.536–0.589 s, and an
  incomplete POST 0.541–0.579 s. These are local shutdown observations, not a
  provider-latency guarantee or a new timeout.
- The main Electron window could be destroyed before backend draining finished.
  The process and its single-instance lock remained, with no visible explanation.
  Second-instance handling only restored the main/mini player, which could already
  be gone. There was no safe way to return to the same still-running application.
- Stopping transfer services did not await their workers. A download's executor
  or buffered reader could keep Python alive after the apparent stop. Closing
  `requests.Response` can itself wait on a blocked buffered read.
  Worker registries now also retain in-flight transfers after their account view
  is invalidated, so replacement cannot hide an old executor from shutdown.
- Account replacement clears the account-scoped job view. That view alone cannot
  prove that every old read-back worker has finished. OAuth renewal also releases
  its shared request gate before its credential-persistence callback completes.

## Shutdown sequence

Before: destroy renderer → send stop/EOF → stop the listener → join HTTP handlers
→ wait for save/job/cache locks. An idle HTTP handler could prevent the later
steps indefinitely. Transfer workers and credential persistence were not fully
represented by those waits.

After:

1. Run the existing unsaved-work/active-transfer close guards. Keep the shared
   renderer alive, pause its existing audio element, and show a small sandboxed
   shell status window. Mini Player dismissal cannot reveal the hidden main window.
2. Mark the owned server as closing. Admit no new actions. Incomplete request
   bodies are not accepted mutations; idle/parser sockets and audio streams can
   be interrupted safely. Job polling and `/api/app` remain available.
3. Stop cleanup/duplicate cleanup between batches, and cancel the local chooser.
   Reassert those stop flags to cover an already-admitted start. Once admitted
   POST actions return, stop/join transfer workers, disconnect queue sync and cancel
   export preparation. Waiting until starts return prevents a late worker escaping
   the stop pass. Upload results remain visible if closing is cancelled.
4. Drain accepted HTTP actions, the save lock, active read-back workers, cache
   persistence and credential renewal/persistence. Retain active read-back markers
   independently of the account-scoped job view. Ownership checks remain intact;
   old-account results are never published into a replacement session.
5. Quiesce new OAuth renewals only after protected work drains. Publish bounded,
   account-free progress, then await the shell's finish acknowledgment. Wake an
   existing History poll so a confirmed result can be stored before renderer exit.
6. Explain unknown outcomes and offer reopening. Only after acknowledgment stop
   the HTTP loop, close the listener, join handlers and await the real child exit.
   Then destroy the renderer/status window and release the single-instance lock.

The control capability is advertised as `shutdown_control: 1`; protocol/version
identity otherwise stays unchanged. `drain`, `resume`, `finish` use the existing
private child stdin/stdout pipes. Legacy `stop`, parent EOF and POSIX signals still
drain safely without an acknowledgment from a missing parent. No generic renderer
IPC, remote navigation, new iBroadcast write mode, mutation retry or backend-kill
deadline is added.
Closing during startup keeps the control pipe open until readiness advertises
its capabilities, so the same backend can still be reopened. Startup failure
sends the legacy stop/EOF; it never kills the child.

The listener stays bound while draining; `/api/app` reports `closing: true` and
another launcher rejects reuse of that server. Second-instance activation restores
the finishing window. Reopening clears admission on the same backend and preserves
the renderer/drafts/session. Stopped playback, transfers and cleanup never restart
automatically. An export cancellation does not permanently disable later exports.

## Regression coverage and local validation

Python coverage uses real loopback HTTP/TCP, barriers and disposable settings.
It checks admitted write → read-back ordering without resending; port retention;
503 rejection of new actions; read-back errors and logout; a stalled upstream
audio reader; cleanup start/stop races; a late transfer start; filesystem worker
joins; token persistence after the refresh gate releases; EOF and POSIX shutdown;
resume while a read/storage lock is blocked; and chooser cancellation/reaping.
Windows graceful stop uses stdin/EOF; Windows process termination is not a
catchable POSIX shutdown signal. Platform chooser commands are tested separately.

Electron coverage checks the real backend protocol, idempotent stop, finish
acknowledgment, resume with the same PID, stale acknowledgment rejection,
sanitized progress and the status window's narrow, exact-main-frame IPC guards.
The frontend test proves that a completed read-back reaches History immediately
on a desktop close notification without sending a mutation or waiting for its
ordinary polling interval.

Local full suites: Python 3.11 and 3.13 each passed 953 tests / 2,562 subtests.
The final shutdown/security subset additionally passed 31 tests / 14 subtests,
including the added test preserving all HTTP guards while closing.
Frontend/media: 775 passed. Electron: 58 passed.
Ruff, generated translations, release consistency and diff
whitespace checks passed. The initial HTTP health test used an incomplete Studio
double; it now uses a real temporary Studio and preserves its original guard
assertions. No known pre-existing failures were hidden.

Native verification uses the actual ad-hoc signed macOS ARM64 app, packaged Python
backend and CLI, isolated profiles/settings and a numeric-loopback service fixture.
All 15 native checks passed locally (13 scenarios plus full History/backend
restart launches); the open macOS folder chooser returned an actual cancellation,
not `unavailable`. Restart phases use the same private port/profile because
browser storage belongs to an origin. It includes:

| Scenario | Expected evidence |
|---|---|
| Idle / inactive TCP | Clean backend exit before shell exit; port released |
| Actual audio playback | Muted synthetic MP3 is playing before close; stalled upstream interrupted |
| Stalled native status read | Visible phase; listener retained until fixture release |
| Second launch during shutdown | Existing status window restored; no second backend |
| Keep Tagcast open | Same backend PID/session and renderer; no automatic playback restart |
| Accepted metadata write | Exactly one mutation; read-back and persisted History before exit |
| Pending read-back | Closing waits until a gated library verification completes |
| Lost write answer | Exactly one mutation; fresh read-back confirms success without retry |
| Cleanup | Accepted bounded batch finishes/read-backs; stop flag prevents another batch |
| Download | Reader/executor unwinds; local file locks released before backend exit |
| Upload | One synthetic body accepted; interruption remains explicitly uncertain |
| Open folder picker | Pending native chooser returns cancellation and is reaped |
| History restart | Same profile reloads the confirmed result after full process exit |
| Idle backend crash/restart | Visible error path, shell exits and next launch acquires the lock |

The first native audio fixture was a partial WAV: Chromium waited for metadata
before playback. It did not reproduce an application shutdown failure. The test
now reuses the repository's independently generated MP3 fixture and still requires
the real audio clock to advance. Native prompt choices are automated only in the
isolated smoke entry point. Production retains native confirmation dialogs.

## Limits and risks

- Native reads and read-backs keep their existing provider timeouts. An OS DNS
  lookup, locked filesystem or genuinely stuck library call may outlive those
  timeouts. Feedback remains visible; reopening is the safe recovery action.
  There is deliberately no unsafe force-quit button or automatic retry.
- An upload stopped after bytes were sent may arrive later. Its uncertain outcome
  is reported, not converted to failure/success by the fixture. Real iBroadcast
  cancellation/arrival semantics are not established here; no real-account write
  was performed.
- `requests`/urllib3's underlying socket is used to wake a buffered audio read
  before closing it. Both supported Python versions and real packaged readers
  exercise this path. An unrecognised future adapter may fall back to its normal
  read timeout, with feedback and reopening still available.
- OS shutdown, power loss, an externally killed parent/backend and Windows task
  termination can bypass UI feedback or cleanup. The smoke crash case only kills
  an idle synthetic backend, never an accepted mutation. Existing no-retry,
  uncertain-write and cleanup checkpoint recovery remain authoritative.
- A renderer that has crashed or cannot execute its close guards cannot guarantee
  saving browser-local drafts/History. Renderer-flush bounds apply only after all
  protected backend work has settled; they never terminate a remote write or its
  verification. Resuming reloads a crashed renderer, without restarting playback.
- macOS ARM64 is validated locally. The same native checks are part of extracted
  package verification on macOS Intel, Windows and Linux CI. A Linux runner without
  a supported folder chooser records `unavailable`, not an invented cancellation.

Machine-readable native evidence is `build/reports/electron-shutdown.json`.
The source baseline and complete local logs are retained under the root checkout's
ignored `build/audit-reliable-shutdown-2026-11-10/`. Existing worktrees and their
modified/untracked files are preserved. This PR is not automatically merged.
