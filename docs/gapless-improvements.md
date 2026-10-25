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

## Remaining work

Phase 3 will address startup, buffered seeks and bounded short-track lookahead. The baseline short-track starvation and full-next-file startup gating still apply until that phase is verified.
