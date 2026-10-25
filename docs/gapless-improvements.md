# Gapless Reliability and Performance Improvements

25 October 2026. Local experimental branch only; disabled by default. The single HTML audio element / MSE / SourceBuffer architecture is retained. No crossfade, silence trimming, streaming-parser rewrite, MP3 redesign or additional playlist/shuffle scope.

## Baseline and evidence

The immutable baseline is documented in `gapless-playback-review-followup.md`. Earlier raw results remain in `build/gapless-followup-2026-10-25`; new per-phase results are separate in `build/gapless-improvements-2026-10-25`. The completed pre-existing review/tools were preserved in baseline commit `4ef80f8` before development.

## Phase 1 — Liveness and compatibility

- Any production removal of SourceBuffer ranges clears the terminal `finished` flag. When `remove()` reopens an ended source, `updateend` can close it again. No timestamp/window redesign was needed.
- Packed media exposes the first initialization STREAMINFO maximum FLAC block size. Every later entry is checked against that original decoder bound, not the preceding track's bound. Larger blocks use normal playback at the boundary. This is an intentional conservative fallback, not a claim of mixed-block gaplessness.
- A playing, ready timeline that has not advanced by 10 ms in eight seconds falls back once through the existing player. Paused, seeking, not-yet-ready and ended states reset the clock. Existing failure records prevent re-entering the same failed route in the same session/quality.
- The tick does not schedule another timer after cancellation/fallback. Existing session guards and normal audio element are retained.

### Phase 1 verification

Eight unchanged compatible engine cases plus eight single-file controls pass with zero missing/duplicated/wrong-channel samples. The 96 kHz two-track stress run now reaches native `ended`, with all 6,144,043 sample frames exact. Reverse mixed blocks remain exact. Small-to-large blocks are rejected before the decoder; the isolated adapter only ends A, while the full application independently verifies B playing through the ordinary native URL route with native controls visible.

`tools/gapless_lab/application.cjs` loads the actual index, all page scripts, existing `playCurrent`, native `ended`/`error` handlers and real HTML audio. Only the account/stream endpoint is a private synthetic fixture server. No production playback functions are replaced. Audio is muted at the Electron output. It verifies four actual application scenarios: mixed-block ordinary fallback; a deliberately removed future buffer followed by watchdog fallback and resumed ordinary playback; pause, speed, backward seek and session replacement; Repeat followed by queue removal through the existing queue action. These are behavioural checks, not PCM accuracy claims for fallback.

517 Python tests / 1,785 subtests, 470 frontend/media/oracle tests and nine Electron shell tests pass. The full-app cases and media probes ran locally on macOS arm64 / Electron 44.9.0. CI now runs the full-app checks too, but has not been pushed or executed remotely.

## Phase 2 — Coded-byte buffering

The pump now uses a 6 MiB conservative coded-byte budget in addition to time. `pack()` reports peak fragment bytes/second and largest fragment size. The engine retains the highest density observed in its run, reserves space for the next head, and scales lookahead/backward retention down for dense high-rate streams. Buffered range duration multiplied by that peak density is an estimate, not Chromium's exact internal accounting. Oversized fragments or an impossible startup head choose normal playback. Backpressure waits for playback/eviction instead of repeatedly appending; a real quota exception still takes the existing single fallback path. Chromium process flags/quotas are unchanged.

Both 32 s + 32 s high-rate runs now pass: **6,144,043 sample frames at 96 kHz and 12,288,043 at 192 kHz**, with zero codeword mismatches, no boundary waiting and native `ended`. The earlier 192 kHz failure happened before `playing`; the updated full-app check confirms MSE playback progressing beyond one second. The normal eight scenarios plus controls still all pass. The full application additionally verifies backward seek to an evicted position without replacing the source, alongside all phase 1 controls and fallback tests.

517 Python tests / 1,785 subtests, 472 frontend/media/oracle tests and nine Electron shell tests pass. Six full-application scenarios pass locally. Data is retained separately under `phase2-*`. Prepared-file/renderer memory remains distinct from SourceBuffer accounting; fixed byte estimates do not guarantee every platform's quota. Conservative normal fallback remains necessary.

## Phase 3 — Startup, seeking and bounded preparation

- Long current tracks (at least ten seconds of remaining runway) can start after their own first fragment is appended, without a full-next-file startup gate. The current file still downloads and parses completely; no streaming parser was introduced.
- A forward target already buffered for at least one second applies immediately when at least ten seconds remain. Near-end targets retain the next-head gate. A pending intent belongs to one segment, is replaced by later input and is discarded on a segment/queue change.
- Short A+B runs also prepare C before startup. Only one extra entry beyond next is prepared, so the steady-state horizon is current plus at most two following entries. This intentionally trades startup latency on very short runs for an uninterrupted measured boundary.
- Preparation is coalesced by the original queue entry, quality and engine/session. Completed entries can be reused when skipping within the same queue; pending old-engine reads are never adopted. Queue edits selectively retire/cancel unwanted records, including guards against late replies repopulating a replacement's cache.
- Prepared coded media plus tracked incoming bytes share a 96 MiB budget, distinct from the 6 MiB SourceBuffer estimate and the existing per-file bound. Shared media objects are counted once. Temporary copy/decoder/recorder allocations are not falsely claimed to be bounded by that figure.
- Asynchronous file preparation stops after 20 s without received audio bytes or 60 s total. Startup uses a 20 s inactivity deadline refreshed by preparation progress, with a 120 s absolute bound across the bounded short-track preparations. A deferred near-end seek retains its ten-second deadline. A playing stall retains the eight-second liveness fallback. Synchronous main-thread parsing cannot be interrupted exactly at a wall-clock deadline; no worker was added.
- Fallback now distinguishes ready playback from merely appended startup data. It preserves the original autoplay request during startup and an actual paused state after readiness; a deferred seek fallback preserves its requested track-relative position.
- Existing explanatory text is updated only for these changed policies. The feature remains experimental, disabled by default and restricted to ordered album queues. MP3 decoding and normal player code are unchanged.

### Matched before/after evidence

The earlier evidence was not overwritten. A frozen checkout of phase 2 (`1f15e02`) runs the same new long-startup fixture for a matched comparison. All 31 original track fixture hashes match the extended 35-file manifest.

| Check | Before | After |
| --- | --- | --- |
| 96 kHz 32 s + 32 s | All PCM correct but no native ended event | All 6,144,043 sample frames correct; native ended |
| 192 kHz 32 s + 32 s | Quota exception before first sound | All 12,288,043 sample frames correct; native ended, no boundary waiting |
| 1152 → 4096 maximum block size | Waiting stall without fallback | Safe rejection before B enters this decoder; actual application plays B through normal URL playback |
| Short B, C response delayed 1.8 s | C starts 59,390 samples late (~1.347 s) | Zero displaced/missing/duplicated samples; startup deliberately waits for C |
| Long startup, A delayed 300 ms / B delayed 2 s | ~2.384 s to first playing in frozen phase 2 | ~0.356 s in the final phase 3 probe; complete PCM run also exact |
| Buffered seek to 1 s in a 40 s track | Deferred despite ~39 s remaining | Immediate position assignment; no next-file wait |
| Seek to 0.4 s before end with delayed C | Existing gate intended to protect transition | Gate retained; applied after ~1.82 s in the final probe; final 256 B samples plus complete C are exact |
| Skip to an already prepared next entry | Preparation restarted | Full-app request log shows B and C requested only once |
| Fault during startup | Could retain paused state despite Play request | Injected quota error resumes ordinary native playback and restores native controls |

These are controlled localhost experiments, not production-CDN latency guarantees. Millisecond measurements vary with scheduling and machine load. The near-end oracle explicitly checks one contiguous tail window after the intentional seek; it does not claim sample accuracy at the first requested seek position or over intentionally omitted content.

### Final verification

- 517 Python tests and 1,785 subtests pass; nine Electron shell tests pass.
- 481 frontend/media/oracle tests pass, including targeted EOS, first-init block compatibility, stalled/paused/seek states, byte budget, shared preparation accounting, retired replies, readiness and startup autoplay regressions.
- Final media run: **31/31 assertions pass**. Sixteen full-engine runs compare 20,749,929 sample frames across 30 boundaries, with twelve independent unified-file controls; the ordinary-fallback case and two partial seek probes are separately identified.
- Original PCM cases remain exact; new short-run, long-startup and Repeat track/queue fixtures compare every codeword against independent unified single-file controls. Both 96/192 kHz long runs remain required regression probes.
- Nine full-application scenarios verify ordinary fallback at an incompatible boundary; actual recovery after a deliberate stall; startup exception fallback; pause/speed/seek/session cancellation; Repeat/queue removal; evicted backward seek; completed-file reuse; pending queue replacement; high-rate startup. Renderer error logs are empty. These use the actual document/page scripts and native element; only the service endpoint is synthetic and shell output is muted.
- CI includes the extended PCM checks, stress fixtures and full-application tests, with required diagnostics failing on regressions. An intentionally delegated mixed-block transition is explicitly labeled; it is not counted as full-queue MSE continuity. Hosted CI was configured locally only, with no push.
- Ruff, JavaScript parsing, version consistency and generated Dark CSS checks pass. No styling, backend, dependency, metadata-save or normal-player source changes were made.

## Remaining limitations and next stage

Safe fallback is the supported handling for larger later FLAC blocks; gapless normalization/reinitialization of such files is deliberately deferred. Arbitrary network delays or many extremely short tracks cannot be guaranteed seamless with a bounded two-entry preparation horizon and event-driven queue/UI updates. Long files still require a complete first-file download, and slow preparation can deliberately select normal playback at the documented deadlines.

All measured output is a same-rate pre-output PCM tap on macOS arm64 / Electron 44.9.0 (Chromium 152). Full-app transport tests are behavioural, including native 1.25× speed; they do not establish hardware/AirPlay bit perfection or PCM continuity at every playback speed. No Windows/Linux packaged media run, sleep/wake/output-device exercise, hour-long production memory run or real-CDN performance benchmark has been performed here. The recorder's RSS is not a production memory-leak measurement. MP3 padding/alignment uncertainty from the prior report remains unchanged. The playing-stall watchdog intentionally excludes native seeking; a browser fault that never completes a native seek is not proven to recover automatically by these tests, unlike the bounded preparation/deferred-intent cases.

Recommended next stage: a separate updated macOS test build and real continuous-album listening, then hosted Linux CI and packaged Windows/Linux verification, output changes and a long-session memory test. Keep streaming-parser and MP3 redesign proposals separate until those observations justify them. No push, tag, release or installed-app replacement is part of this work.

## Implementation references

`src/tagcast/static/gapless.js`: `gaplessStartupReady`, `gaplessSeekReady`, `gaplessReadiness`, `gaplessPrepare`, `gaplessHeldBytes`, `gaplessPrune`, `gaplessPrefetchAhead`, `gaplessBufferPolicy`, `gaplessPump`, `gaplessWatch`, `gaplessFallback` and `gaplessBegin`. `gapless-media.js:pack` adds only bounded-buffer metadata; original frame contents/timestamps and the MP3 decoder path remain intact. Regression coverage is in `tests/frontend.test.cjs`, `tests/gapless-media.test.cjs`, `tests/gapless-oracle.test.cjs` and `tools/gapless_lab/`.


## Original FLAC transfer follow-up (local beta.1)

A user-supplied listening log contained two preparation failures at 20,003 ms and 20,002 ms, before any MediaSource was created. A second real-album run reproduced the same fixed deadline while preparing the third track, even though the current track still had over five minutes remaining. The first transition in that run stayed on the continuous MediaSource.

Bounded read-only measurements of the three explicitly selected Original FLAC streams found valid 44.1 kHz, stereo, 16-bit FLAC with matching 4,608-sample maximum blocks. Files were approximately 17.7, 37.2 and 55.0 MB. Transfer times varied: the second file took 18.7 s inside Electron; the third completed in 18.6 s through the Python proxy probe but exceeded 20 s inside Electron. Parsing and repackaging in the separate probe took under 0.35 s per file. This establishes an overly restrictive elapsed-transfer deadline; it does not identify the precise upstream reason for the fluctuating throughput.

The follow-up changes only preparation deadlines and their startup watchdog integration. A steadily progressing read can exceed twenty seconds; a stalled read still aborts after twenty seconds, and the sixty-second file limit prevents a trickle from holding preparation indefinitely. Explicit timeout errors classify as `prepare-timeout` instead of `other`. The 96 MiB preparation budget, coded-buffer policy, seek deadline, decoder checks, queue rules, and normal playback path are unchanged. Deterministic clock tests cover progress, idle expiry, the hard bound, cancellation/cleanup and bounded startup. No stream URLs, credentials, identifiers or real music are saved by the timing probes.

With the correction in the rebuilt macOS arm64 beta.1 app, the third real Original FLAC file completed in **26,795.6 ms**, above the former deadline, and the first two track transitions retained the same continuous playback route. The fourth file also prepared successfully. The captured 489-event diagnostic report contained no preparation failure, fallback, buffer exception or decoder error. Two intentional near-end seeks were included. This is a runtime reliability check, not a sample-accuracy measurement of commercial music.

Validation: 491 frontend/media tests; 518 Python tests with 1,785 subtests; ten Electron shell tests; ten full-application native media scenarios. The targeted deterministic 44.1 kHz 16-bit, 24-bit and short-delayed-third cases, each calibrated against a single-file reference, all reported zero sample mismatches and no boundary waiting. The built arm64 app passed the existing bundled CLI/server/sandbox check. Windows/Linux were not rebuilt or played in this follow-up. Play reporting was temporarily disabled for the live test, then restored; metadata and library memberships were not written.
