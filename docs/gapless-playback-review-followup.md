# Gapless Playback — Independent Review Follow-up

Date: 25 October 2026. Status: **investigation and test infrastructure only**.

## Decision

**Keep the existing single HTML audio element, MediaSource and FLAC-in-MP4 SourceBuffer architecture.** Measurements establish sample-codeword continuity for a useful, explicitly bounded set of FLAC cases. They also expose reproducible failures in decoder compatibility, preparation policy, memory pressure and end-of-stream handling. None currently justifies replacing the audio engine.

**Do not yet promote the experiment to generally reliable gapless playback.** The passing short-file measurements do not cancel the failing cases. Normal playback remains the intended fallback, but one observed stall never requests that fallback. No production fix has been applied in this investigation.

## 1. Reviewed material and preserved baseline

The independent review `gapless.md` was read in full and checked against the actual worktree at `b2ff7245bf7d2352e1b0737bbbac342cf3c6b665`. The playback changes being reviewed originate in:

- `ff352bd` — isolated Electron gapless prototype.
- `a1f3835` — individual track timing and seeking over the continuous timeline.
- `5647903` — startup and forward-seek readiness gates.

Later Settings/Overview commits remain intact. At the task baseline there were **no tracked uncommitted changes**. The existing untracked technical report, review package ZIP and support directories were retained. This investigation adds tests, diagnostic tools, CI instructions and this report, without commits, push, tags or releases.

The five playback source SHA-256 values are recorded in `evidence/baseline.json`. The final preservation check compares them with both the worktree and the source copy used for measurement. This is stronger than relying on the test harness's description of itself.

### Actual mechanism and important seams

| File / function | Relevant current behaviour |
| --- | --- |
| `src/tagcast/static/gapless.js:111`, `gaplessRead` | Fetches the complete proxied stream, with a 96 MiB encoded-file limit; concatenates chunks, parses the full file, then packs it. FLAC frames are retained without audio transcoding. |
| `gapless.js:130–136` | MP3 metadata check, complete `OfflineAudioContext.decodeAudioData`, rate/channel/length validation, then conversion to verbatim 24-bit FLAC. |
| `gapless.js:170`, `gaplessPrefetch` | One next entry only; compares rate/channels/bit-depth key, prepares its whole file, then publishes `g.next`. |
| `gapless.js:184`, `gaplessPump` | Serializes SourceBuffer appends/removals; primes the next first fragment; appends roughly 16 seconds ahead and retains roughly 6–10 seconds behind. Applies per-entry offsets and append windows. |
| `gapless.js:48–78`, readiness/seek functions | Startup waits for the next head to be appended; obtaining that head currently requires full next-file preparation. Every forward seek more than 50 ms ahead waits when that same next boundary is unready. |
| `gapless.js:210`, `gaplessAdvance` | Updates the queue/UI entry from the continuous element clock, then starts preparing the following entry. It does not start a new audio source at an ordinary compatible boundary. |
| `gapless-media.js:41`, `parseFlac` | Validates native FLAC STREAMINFO, frame headers, CRCs, sequence/sample count and bounded format/frame count; supports 16/24-bit mono/stereo at 8–192 kHz. |
| `gapless-media.js`, `pack`, `pcmFlac`, `mp3Info` | Per-frame sample durations in fMP4; first-file STREAMINFO in the only initialization segment; compatibility key omits maximum FLAC block size. MP3 is a separate, expensive preparation path. |
| `src/tagcast/static/player.js:601–627` | Existing `ended` and `error` integration; no equivalent bounded recovery from a persistent `waiting` state. |

The iBroadcast streaming proxy, credentials, queue-sync backend and save/review workflows were not changed. The lab supplies a private loopback fixture endpoint with the same stream URL shape, so most measurements isolate the frontend engine from CDN/account variability.

## 2. Evidence method and its limits

### Deterministic fixtures

`tools/gapless_lab/fixtures.cjs` generates signed 16/24-bit PCM whose sample positions are transformed through a reversible permutation. Left/right channels and track numbers have different salts. This is more discriminating than checking sine-wave silence or decoded length alone. Sample counts deliberately do not align to FLAC block boundaries.

FFmpeg independently encodes the files and independently decodes each fixture back to its original PCM bytes. Generation fails on any byte difference. STREAMINFO's encoded maximum block size is checked against the requested 1152/4096 setting. The manifest records exact sample counts, format, sizes, SHA-256 hashes and FFmpeg version. There are 31 track fixtures and 15 scenarios when stress fixtures are enabled, plus eight unified single-file controls. No real music is involved.

### Actual playback capture

An isolated Electron BrowserWindow loads **the unchanged production `gapless-media.js` and `gapless.js`**. Minimal host adapters provide queue/session state and record UI/fallback calls. Production code still creates the MediaSource, appends fragments, runs its timers and handles transitions.

The native audio element feeds a **measurement-only** AudioWorklet at the fixture's sample rate, volume 1 and playback rate 1. The worklet records PCM before output and emits silence to the sound device. This does not install a Web Audio playback architecture in Tagcast. The process uses a fresh temporary profile, synthetic queue and loopback server; no real account or application profile.

For each passing scenario, a unified single-file FLAC containing the entire expected run is played first through the same measurement path. Its normalization calibrates the corresponding multi-file comparison. Chromium's observed 16-bit conversion uses different positive/negative divisors; 24-bit uses the power-of-two mapping. Inverting these mappings reconstructs **integer codewords**, with **zero missing/duplicate sample-count tolerance**. Literal equality to a naïve Float32 `integer/32768` reference would incorrectly reject otherwise identical 16-bit output. Unknown gain, resampling or missing anchors are reported as inconclusive, never as a pass.

One short two-channel anchor inside the first file establishes capture start. The comparator checks the whole run without realigning at track boundaries, including leading inferred missing samples and nonzero extra tail. Additional observed track-start anchors are diagnostic only and cannot make a failed comparison pass. Independent unit tests deliberately inject missing/duplicated samples, an incorrect boundary, wrong track order, swapped channels, a one-codeword error and inserted starvation silence; all are detected. Initial silent graph channel negotiation is excluded from channel-change detection; actual nonzero signal channel changes are retained.

### What a pass proves

At this renderer measurement point, for these files, this build and normal forward playback, every expected codeword is present in the correct channel/order, at the correct sample position. This is a measured sample-accurate result for the tested subset, **not a universal sample-accuracy claim**.

It does not prove bit-perfect DAC output, AirPlay continuity, system resampling behaviour, arbitrary malformed FLAC safety, all seek/repeat/edit sequences, or an hour-long memory bound. The lab's ordinary fallback adapter records the fallback request and stops; it does not prove the full URL-player recovery chain. Existing frontend/shell tests complement it but are not hardware audio tests.

## 3. Findings against the six requested questions

| Question | Finding | Classification |
| --- | --- | --- |
| FLAC boundary accuracy | Eight normal scenarios and their eight single-file controls pass with zero codeword mismatch, zero nonzero extra tail, correct final queue index and no internal-boundary waiting. Fifteen multi-file boundaries pass. | **Measured for this subset**, not guaranteed universally. |
| Different FLAC block sizes | 1152 → 4096 stalls at the first boundary. 4096 → 1152 → 4096 passes, as do uniform 1152 and uniform 4096. | **Confirmed directional compatibility defect, P1.** |
| Short tracks | A ~1 s → B ~0.5 s → C ~1 s, with a controlled 1.8 s C response delay, stalls between B/C and inserts captured silence. | **Confirmed conditional starvation, P1.** Not every short track necessarily fails. |
| Startup / seek gates | Sequential full A/B preparation delays startup; a seek to 1 s into a 40 s track is deferred while C prepares, despite its target already being buffered. | **Confirmed overbroad policy, P2.** Relaxation still needs a bounded safety policy. |
| Real iBroadcast MP3 metadata | Two received 128-quality streams contain Info/Lavc delay and padding metadata; eight other attempts fail before useful header inspection. | **Positive but partial real evidence.** Reliability, coverage and decoded alignment remain unverified. |
| High-rate FLAC / SourceBuffer memory | Two high-entropy 32 s 192 kHz/24-bit stereo files trigger `QuotaExceededError` before playback. 96 kHz completes the sample sequence without quota errors, but exposes a separate EOF hang. | **Confirmed 192 kHz resource defect, P1; confirmed EOF liveness defect, P1.** |

P1 means a reliability blocker before presenting the opt-in experiment as supported for the affected input class; it is not evidence of a defect in disabled, normal playback. P2 means a reproducible responsiveness limitation.

### 3.1 Normal FLAC continuity

Measured on macOS Apple Silicon, Electron 44.9.0 / Chromium 152.0.7977.167:

| Scenario | Expected sample frames | Result |
| --- | ---: | --- |
| 44.1 kHz / 16-bit / stereo / 4096 blocks | 94,034 | Exact |
| 44.1 kHz / 24-bit / stereo / 4096 blocks | 94,034 | Exact |
| 48 kHz / 16-bit / stereo / 4096 blocks | 102,341 | Exact |
| 48 kHz / 24-bit / stereo / 4096 blocks | 102,341 | Exact |
| 96 kHz / 24-bit / stereo / 4096 blocks, short files | 204,581 | Exact |
| 192 kHz / 24-bit / stereo / 4096 blocks, short files | 409,061 | Exact |
| 44.1 kHz / 16-bit / stereo / 1152 blocks | 94,034 | Exact |
| 44.1 kHz / 16-bit / mono | 71,003 | Exact |

Total: **1,171,429 sample frames** in engine runs, plus the same sequence lengths in controls. These are sample frames, not twice-counted stereo channel samples. Mono, often listed as future parser scope in the review, already works in this test.

### 3.2 Mixed blocks: confirmed stall, revised failure mechanism

All inputs individually pass independent decode/round-trip. A's STREAMINFO advertises a maximum block size of 1152; B contains 4096-sample frames. The production key considers them compatible and retains A's init segment. Playback stops at approximately 0.730385 s, the A/B boundary; 61,824 expected later sample positions fail the comparison.

Crucially, the observed result is **waiting without an audio error or ordinary fallback**, through the diagnostic deadline. The reviewer predicts a loud fatal decoder error followed by fallback. That propagation claim is not supported by this build. The lack of a liveness check leaves the player stuck.

An independent FFmpeg decoder probe, combining A's header with B's original frames, rejects `blocksize 4096 > 1152`. This supports the initialization incompatibility diagnosis. [FFmpeg's decoder](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavcodec/flacdec.c) contains the same bound check; upstream master is supporting evidence, not a claim that its exact revision is Chromium's bundled decoder. See `evidence/ffmpeg-mixed-block.log` and `verified-diagnostics/block-small-to-large.json`.

### 3.3 Short-track starvation

The C request starts only after `gaplessAdvance` recognizes B as current. Preparing B earlier does not prepare C earlier. With B lasting 22,061 frames at 44.1 kHz and C delayed 1.8 seconds, the B/C boundary at sample 66,178 is reached first. Captured `waiting`/`playing` events and the counter demonstrate a real interruption, not merely delayed UI text. A/B remains exact; C is present late, including a nonzero tail outside the expected run.

In the final run, C starts 59,390 captured frames late (about 1.347 s at 44.1 kHz); the native waiting/playing events are about 1.348 s apart. The diagnostic JSON records that displacement without silently trimming it out of the comparison. More lookahead can reduce this failure **within a defined preparation budget**; no finite cache can guarantee continuity through an arbitrarily long outage.

### 3.4 Startup and seek readiness

With deliberate whole-response delays of 300 ms for A and 700 ms for B, B is requested only after A finishes. The first `playing` event arrives about 1.03 s after renderer test start. These are controlled localhost measurements, not representative real-CDN startup benchmarks.

For the seek probe, B lasts 40.000385 s. At roughly 0.05 s into B, the test requests position 1 s. Approximately **39 s remain after that target**, and the SourceBuffer already covers it. `gaplessSeek` leaves the element clock unchanged and stores `seekIntent` because C is not ready. This verifies an unnecessarily broad gate without manipulating internal readiness state. The test intentionally stops after observing this policy; its partial PCM capture must not be read as a whole-run sample-loss measurement.

The gate did address the user's earlier “seek immediately near the end” failure by buying preparation time. Simply removing it would reintroduce that failure. Separate target availability, remaining runway and boundary readiness before changing it.

### 3.5 SourceBuffer pressure and an additional EOF defect

At 192 kHz/24-bit stereo, each 32 s fixture is about 37.7 MB encoded, below the 96 MiB per-file cap. A alone fills the coded-audio buffer before B is prepared and before `audio.play()` is allowed. `appendBuffer` throws `QuotaExceededError` and the production fallback path is requested. A seconds-based 16 s lookahead and the startup hold do not imply a safe byte budget.

[Chromium's memory-limit definitions](https://raw.githubusercontent.com/chromium/chromium/main/media/base/demuxer_memory_limit.h) include a 12 MiB default audio-demuxer limit and smaller alternatives. This is not a universal fixed SourceBuffer capacity, and coded-data accounting is not the same as total process RSS. Exact limits are platform/build dependent. In the final run, 12,456,530 bytes of initialization/media appends return successfully before the next append throws at about 278 ms; no playing event occurs. Successful append byte totals are not exact retained-memory accounting. The measured quota exception is stronger evidence than estimating it from PCM throughput alone.

At 96 kHz, two 32 s files produce all **6,144,043 expected sample frames exactly**, with no internal-boundary waiting or quota exception. Nevertheless, the native `ended` event does not arrive. The engine calls `endOfStream`, then later eviction calls `SourceBuffer.remove`. That operation reopens an ended MediaSource; `g.finished` remains true, preventing the pump from closing it again. At timeout the source is `open`, the engine is `finished`, all parts are consumed and the playhead is at the total duration.

This follows the [MSE `remove()` algorithm](https://w3c.github.io/media-source/#dom-sourcebuffer-remove), which explicitly reopens an ended parent source. It is **not established as a rounding defect**. The review's state-machine assessment missed this terminal-state interaction. A small EOF/eviction fix should be considered before timestamp redesign. The final trace records `endOfStream` at 47.790 s after renderer start, `sourceended`, then a `remove` changing `ended` to `open` at 53.074 s and a new `sourceopen`. No second EOS occurs before the 90 s diagnostic deadline. The same terminal hang appeared in repeated runs. This is a confirmed lifecycle bug; the exact PCM result rules out missing tail samples as its explanation.

The relevant production ordering is:

```js
// gaplessPump: eviction runs before the EOS decision.
if (sb.buffered.length && sb.buffered.start(0) < before - 4) { sb.remove(0, before); return; }
// Later, this guard prevents re-closing a source reopened by remove().
if ((!g.wanted || gaplessFailed(g.wanted, g.quality)) && !g.pending && !g.finished && g.media.readyState === "open") {
  g.finished = true; g.media.endOfStream();
}
```

### 3.6 Real MP3 header inspection

The user explicitly authorized at most five tracks from one opened album. A bounded, read-only diagnostic inspected in-memory headers at requested qualities 128 and 320, at most 256 KiB per successful response. No music, account names, native track IDs or credentials were saved. The initial broader catalogue approach was rejected by automatic approval and was not executed; this narrower approved method replaced it.

Two 128-quality responses succeeded with HTTP 206, `audio/mpeg`, 44.1 kHz stereo:

| Anonymous sample | Encoder tag | Delay | Padding | Metadata-derived samples |
| --- | --- | ---: | ---: | ---: |
| 2 | Info / Lavc58.44 | 576 | 696 | 14,727,048 |
| 3 | Info / Lavc58.10 | 576 | 1,644 | 12,338,004 |

Eight requests failed, including all five 320 attempts. The original diagnostic deliberately persisted generic failures without detailed network causes. They cannot establish absent tags, a provider-wide outage, or 320-quality incompatibility. No repeated catalogue investigation was used to enlarge the authorized sample.

This disproves the broad suggestion that real iBroadcast transcodes might categorically lack recognized metadata. It does **not** establish accurate trimming, reliable metadata across the service, decoded length acceptance, absence of clipping or actual MP3 sample alignment. No complete real stream was decoded in this check. Keep the existing conservative MP3 fallback and evaluate the MP3 path separately before adding complexity or deleting it.

## 4. Review conclusions to accept, qualify or reject

**Accept:** keep one native element and MSE timeline; measure PCM rather than listen only; fix block-size compatibility; prepare beyond a short intermediate track; reconsider full-file startup/seek gating; investigate MP3 independently. Existing session/ticket checks and serialized SourceBuffer mutations are valuable and should survive incremental changes.

**Qualify or reject:**

1. **“Sample accurate by mechanism” is too strong.** It is now measured for the listed subset. Upstream splice/rounding heuristics do not prove every append, eviction or seek sequence; the 96 kHz EOF case demonstrates why state liveness matters independently of sample integrity.
2. **“Mixed blocks fail loudly and fallback” is wrong for the observed build.** They stall without fallback. Different-rate files are already rejected by the compatibility key, so a cross-rate example does not isolate the block-size defect.
3. **A 50 ms next head is not a universal sufficiency proof.** The first fragment may span much longer than 50 ms; continuing it depends on the pump, available memory, network and remaining runway. Our delayed-C fixture disproves unconditional continuity.
4. **Cumulative integer `tfdt` and removing append windows are not presently necessary fixes.** The existing timeline passes all normal counter cases. Such a change could simplify one seam but must first prove seek, overlap, repeat and eviction behaviour; “exact by construction” does not bypass Chromium timestamp conversion or decoder behaviour.
5. **Do not immediately normalize every STREAMINFO field or announce that it is low risk.** First compare directional max-block compatibility/fallback with validated init normalization. Decoder buffer sizing and long-file memory implications need tests. Per-file init changes are another experiment, not guaranteed seamless reconfiguration.
6. **Streaming parsing plus a worker is meaningful engineering work.** It needs bounded carry-over, metadata/frame validation, cancellation, transfer ownership, late failures and truthful duration handling. A CRC is a corruption check, not a security proof. Do not drop the 100,000-frame cap in favour of only encoded bytes: many tiny frames also cost CPU and JavaScript objects.
7. **MP3 metadata/length cannot prove alignment.** Equal length permits a leading shift and compensating tail loss. Quantization/clipping can make the current converted path differ from ordinary decoded playback. Tone/length checks alone are weaker than a decoded-reference correlation test.
8. **Revise memory arithmetic.** Six minutes of 44.1 kHz stereo Float32 is 127,008,000 bytes (~121 MiB); packed 24-bit PCM is 95,256,000 bytes (~91 MiB), versus 5,760,000 bytes of 128 kbps MP3. These are roughly 22× and 16.5× that MP3 payload, before concurrent encoded/fragment copies. The 128 MiB check happens after `decodeAudioData` has allocated actual PCM. Forged frame counts can defeat a metadata pre-check. A 96 MiB file at 128 kbps could expand to roughly 2.1 GiB of stereo Float32; this is an illustrative risk estimate, not a measured allocation limit or universal maximum.
9. **Web Audio does not require a new AudioContext for every source rate.** `decodeAudioData` resamples to its context rate according to the [Web Audio specification](https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-decodeaudiodata). A rewrite would still impose real transport/output/speed tradeoffs and is not warranted here.
10. **No categorical browser-compatibility claim without current tests.** Capability detection and normal playback fallback remain appropriate. This session measured the pinned Electron Chromium engine on macOS, not current Firefox, Safari, Windows or Linux media output.

## 5. Prioritized incremental plan — not implemented

| Order | Change / evidence required | Acceptance criteria | Indicative effort and risk |
| --- | --- | --- | --- |
| 1 | Fix EOF after eviction and mixed-block liveness. Make first-init compatibility explicit; use safe fallback for unsupported later blocks before attempting init normalization. | 96 kHz stress reaches native `ended`; both mixed directions either pass exact PCM or deterministically choose normal fallback; no indefinite waiting. Recheck seek/queue edits after EOS. | 1–2 days including tests; moderate lifecycle risk. |
| 2 | Bound SourceBuffer lookahead by coded bytes as well as time; handle quota under startup holds with bounded retry/eviction or explicit fallback. Preserve backward-seek ownership. | 192 kHz stress starts or falls back predictably without a startup deadlock; no repeated append loop; steady-state retention remains bounded. Record retained encoded files separately from SourceBuffer and process memory. | 1–2 days; moderate resource-policy risk. |
| 3 | Add bounded preparation of C when B is short; serialize cancellation/ownership and cap bytes/concurrency. Then narrow seek/start gates based on buffered target and remaining preparation budget. | Delayed-C fixture passes within the declared budget; early 40 s-track seek is immediate when target buffered; near-end immediate seek remains safe or clearly waits. Queue changes, stop, session replacement and repeat do not publish stale preparations. | 2–3 days; moderate queue/race risk. |
| 4 | Profile and prototype incremental FLAC reads; introduce a worker only if main-thread traces justify it. Avoid retaining chunks plus flattened bytes plus packed copies unnecessarily. | First sound no longer requires two complete downloads, verified on controlled bandwidth and real CDN with permission. Truncated/oversized/cancelled files remain bounded. All counter and lifecycle cases pass. | 3–5 days or more; higher parsing/cancellation risk. |
| 5 | Decide MP3 independently: obtain a broader authorized header/decode sample and compare known decoded references; only then prototype native `audio/mpeg` MSE trimming. | Measured decoded alignment/padding, clipping/gain analysis, predictable unsupported fallback, bounded allocation. No claim of recovering original pre-MP3 PCM exactly. | 2–4 days investigation; implementation depends on findings. |
| 6 | Optional timestamp/init/parser scope changes only after a failing case or clear maintenance benefit. | Existing and new fixtures remain exact; seek after eviction, repeat-wrap and interrupted preparation are explicitly tested. | Case-dependent; defer speculative changes. |
| 7 | Packaged cross-platform and long-session release gate. | Windows/Linux media jobs and macOS package tests; output switch/AirPlay, playback speed, sleep/wake, queue edits, backward seek after eviction, cancellation and hour-long memory runs. | Several test sessions; environment dependent. |

These are planning ranges, not commitments. The review's “no risk” test estimate and half-day policy/timeline estimates understate calibration, cross-platform validation and state-machine work. Do not relax scope into shuffle, playlists, Random Album or queue sync: the requested feature remains opt-in ordered-album playback.

### Retained uncertainty / predicted risks

- No production `waiting` watchdog: the confirmed mixed-block stall exposes a broader recovery gap. Any future watchdog must distinguish buffering, pause, seeks and slow but progressing downloads.
- Rapid queue mutation at an audible boundary and ordinary fallback index/offset identity remain code-review risks; they were not dynamically reproduced here.
- Complete-file retention, encoded/muxed duplication and post-decode MP3 allocation remain memory risks. RSS traces include the measurement recorder and are not proof of a production leak.
- Playback rates other than 1, native output switching, real AirPlay, repeated/reordered queues, long sessions and unusual valid/malformed FLAC require dedicated follow-up. No regression guarantee for those is inferred from a no-production-change task.

## 6. Tests, CI and reproducibility

See `tools/gapless_lab/README.md` for exact commands, calibration rules, output schema, known failures and privacy boundaries.

The CI workflow now includes the six existing media-parser tests and eleven new counter-oracle tests in frontend regression checks. A separate Linux Electron job independently generates fixtures, measures the eight normal scenarios plus controls, records the known-failure diagnostic cases, and uploads JSON evidence. Only the normal reference/engine scenarios are gating; known failures are conspicuously diagnostic until separate production fixes are approved. The automatic publishing job also depends on the new media job.

**CI has only been configured locally.** Nothing was pushed; no hosted Linux/Windows run or packaged release is claimed. High-memory stress probes are opt-in locally and are not silently represented by the short 192 kHz CI case.

Final local checks:

- **517 Python tests and 1,785 subtests passed** (includes four new bounded-header diagnostic tests).
- **467 frontend/media/oracle tests passed** (450 existing frontend + six existing media + eleven new oracle tests).
- **9 Electron shell tests passed**, including a real temporary backend child.
- **16/16 gating Electron measurements passed**: eight unchanged-engine cases and eight single-file controls.
- Seven additional diagnostics completed and retain their individual failures/observations: mixed-small-to-large stall, reverse-direction pass, short-track starvation, sequential-startup pass with measured latency, early-seek policy probe, 96 kHz EOF hang and 192 kHz quota fallback. These are not counted as seven passing playback tests.
- Ruff passed; 41 production/lab JavaScript files parsed; release versions agree; generated Dark CSS check passed without changes; workflow YAML parsed successfully.

Evidence hashes and preservation checks are recorded in `evidence/validation.json`. The evidence package includes fixture manifests, normal and diagnostic results, anonymized MP3 headers, FFmpeg diagnostics and test logs. Generated PCM captures remain local and are reproducible; they are intentionally excluded from the small shareable ZIP and Git. No private music is included.

## Questions for Claude — Independent Architecture Review

1. Does the observed `endOfStream → remove → sourceopen` sequence explain the terminal hang completely, and what smallest invariant preserves EOS without breaking seeks/repeat/queue edits?
2. Is directional maximum-block compatibility sufficient for safe fallback, or are there other STREAMINFO constraints that require per-file init handling? What evidence would justify normalized decoder initialization?
3. Which byte and time budgets can bound startup priming, backward retention and short-track lookahead without deadlock or quota loops?
4. How should a liveness recovery distinguish a silent decoder stall from ordinary buffering, intentional pause and a valid pending seek?
5. Does the paired single-file calibrated codeword test have a blind spot for boundary loss, channel remapping or capture-start alignment? Which additional adversarial fixtures matter most?
6. What minimal extra lookahead state preserves the existing cancellation tickets and queue provenance? Can policy improvements be separated safely from streaming parsing?
7. What decoded-reference test establishes actual MP3 alignment, and how should pre-decode resource limits handle untrustworthy Xing counts?
8. Is any proposed integer-timeline or worker change warranted by measured defects now, or should it remain deferred until the smaller correctness fixes are proved?
