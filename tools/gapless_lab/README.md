# Gapless measurement lab

Test-only tools for the current production MSE engine. They do not change Tagcast playback, app settings or account data. Read `docs/gapless-playback-review-followup.md` before interpreting results.

## Requirements and commands

Node 22+, an FFmpeg executable on PATH (or `FFMPEG=/absolute/path`), and the repository's pinned Electron development dependency. FFmpeg and the measurement worklet are test tools, not application runtime dependencies.

From the repository root:

```sh
npm ci --prefix electron
node --test tests/frontend.test.cjs tests/gapless-media.test.cjs tests/gapless-oracle.test.cjs
node tools/gapless_lab/fixtures.cjs build/gapless-fixtures --stress
electron/node_modules/.bin/electron tools/gapless_lab/electron.cjs --fixtures build/gapless-fixtures --out build/gapless-smoke --suite smoke
electron/node_modules/.bin/electron tools/gapless_lab/electron.cjs --fixtures build/gapless-fixtures --out build/gapless-diagnostics --suite diagnostics
node tools/gapless_lab/verify.cjs build/gapless-smoke build/gapless-diagnostics
node tools/gapless_lab/negative.cjs --fixtures build/gapless-fixtures --out build/gapless-negative
```

On Linux use a functioning audio server/null sink and `xvfb-run -a` for the Electron commands, as in `.github/workflows/tests.yml`. On macOS the `.bin/electron` launcher starts the installed Electron.app. On Windows use the corresponding `.cmd` launcher. These platforms do not necessarily have identical decoder/quota behaviour.

`--suite smoke` runs twelve compatible playback scenarios (including short-track preparation, long-track startup and Repeat), each preceded by a unified single-file reference. `--suite diagnostics` runs mixed blocks, delayed C, sequential startup, early seek and, when generated with `--stress`, 96/192 kHz memory probes. `--suite all` runs both. `--case block-small-to-large,memory-96000` selects named cases. A full stress suite can take a few minutes because the EOF/stall probes intentionally wait for deadlines. No test reads local music.

**Required diagnostics are now regression checks.** A nonzero exit indicates a failed gating/required scenario or an invalid run. A small-to-large block transition deliberately ends the isolated MSE run after A and delegates B to normal playback; `expectedBoundaryFallback` identifies that expected outcome, not full-queue PCM continuity. The separate full-application test must confirm B actually plays normally. Early seek is a partial policy test; near-end seek checks a specifically identified contiguous tail window. Never count either as a full-album accuracy measurement. Historical evidence retains the original failures unmodified.

The 1.0 stabilization fixes a historical gate defect: `app.quit()` could discard
Node's `process.exitCode` and return zero after a failed measurement. Both harnesses
now finish with an explicit Electron exit code and always write a failure report.
`contract.cjs` requires the known scenario inventory, reference calibrations and
consistent per-case JSON/PCM artifacts. Empty, unknown or incomplete selections fail.
Pass `--stress` to the harnesses in CI to require both memory fixtures rather than
silently omitting them. `verify.cjs` independently rejects incomplete or missing
artifacts. `negative.cjs` checks real nonzero subprocess exits for bad hashes,
missing cases, failed calibration and a full-application media failure. It uses
copies of synthetic fixtures and saves sanitized exit evidence. These controls
change test infrastructure only; production playback is unchanged.

The twelve smoke cases require complete PCM continuity and lifecycle completion,
each with a passing reference. The seven stress-suite diagnostics are also required
to pass their explicitly defined contracts, but mixed-block fallback and early-seek
policy checks are **not** full-run PCM measurements. Reporting distinguishes those
outcomes instead of counting every green diagnostic as sample-accurate playback.

Use `--diagnostics` to measure the same fixtures with the listening build's optional, bounded event collector enabled. It does not replace the measurement tap. Its anonymous event report is included in each result; renderer wrappers are restored before cleanup. The default remains off.

## Files and responsibilities

- `counter.cjs`: independent reversible position/channel/track signal and exact integer-codeword oracle. One capture-start anchor; no boundary realignment. Observed per-track displacement is supplementary, never used to forgive mismatches.
- `fixtures.cjs`: independent FFmpeg encoding and PCM round-trip, requested maximum-block verification, fixture SHA-256 manifest and unified controls. 16/24-bit, mono/stereo, 44.1/48/96/192 kHz, 1152/4096 blocks and fractional durations. The stress signal has intentionally poor compression to exercise encoded-byte limits; it is not representative music compression.
- `electron.cjs`, `preload.cjs`: private loopback fixture server, fresh sandboxed isolated Electron context, bounded PCM IPC recording, result aggregation and fixture hash checking. No production profile; temporary lab profiles are removed on exit where the OS releases locks.
- `environment.js`: small host adapters for the real engine. Does not reproduce the full Tagcast UI, native backend or ordinary fallback player. A fallback records intent and stops. No real API token or library.
- `run.js`, `harness.html`: load the actual unchanged `gapless.js` / `gapless-media.js`; log appends, removals, source-state events, requests, parser/packer timings, native audio events and final engine state. These are instrumentation wrappers in the test page only.
- `capture.js`: AudioWorklet measurement tap at the source rate. Captures both channels before output, sends interleaved Float32 chunks, outputs silence. No scheduling or playback replacement.
- `application.cjs`: actual Tagcast index and page scripts, native audio, `playCurrent`, queue and event handlers with only a private synthetic endpoint replacing the service. Output is muted at the Electron shell. Exercises normal fallback, a fault-injected stall, pause/speed/seek, Repeat/queue edits, evicted backward seek, prepared-file reuse, pending queue replacement and high-rate startup. It does not use the isolated host adapters.
- `mp3_headers.py`: separate explicitly authorized bounded real-header diagnostic; **never run automatically or in CI**.

## Measurement rules

1. Generated FLACs round-trip through a decoder independent of the production parser. The manifest and source hashes bind a run to exact inputs and playback code.
2. Single-file controls establish working capture rate, channel routing, gain and one of two PCM normalization mappings. Unknown conversion or missing anchors is inconclusive. The paired engine run uses the control's mapping.
3. Signed integer codewords are recovered at 16/24 bits, then compared at every expected frame. There is zero dropped/duplicated sample tolerance. Nonzero extra tail and channel changes fail. Capture padding silence is allowed; silence at an expected nonzero counter position fails.
4. The early seek-policy probe intentionally stops before the end. `partialCapture=true` and `signal.exact=null` exclude it from whole-run accuracy claims. Its assertion requires the buffered target to apply without deferral. The near-end probe waits for preparation and then checks the final 256 samples of B plus complete C with a single fixed anchor (`sourceStart`); this proves that measured tail boundary, not the first sample after the intentional seek or the omitted earlier run.
5. `boundaryWaiting` considers internal boundaries only. `endWaiting` and missing `ended` diagnose termination separately. A run with exact PCM can still fail lifecycle completion.
6. Recorder channels during initial all-zero graph negotiation are ignored; channel changes during actual signal remain checked. The two-channel independent signature also detects swaps/missing channels.
7. `observedTrackStarts` is a first matching short anchor at/after the expected slot. It can explain inserted silence in these controlled fixtures; periodic 16-bit patterns and arbitrary reorder/corruption mean it is not a universal alignment estimator. Whole-run comparison remains authoritative.
8. Process metrics include Electron, full input files and the recorder/capture arrays; they are not SourceBuffer occupancy or proof of a leak. The 256 MiB PCM recording bound prevents unbounded captures. No physical output or AirPlay accuracy claim follows from this pre-output tap.

Outputs: a manifest; per-case JSON; aggregate `results.json` with runtime/source versions and process-memory snapshots; generated `.flac` fixtures; local `.f32le` raw captures. CI uploads only manifests/JSON. The Linux job generates stress fixtures and gates required 96/192 kHz lifecycle/PCM probes; it does not raise browser memory limits. Hosted CI still requires a separately authorized push. Do not commit generated media, profiles or large captures. Small unit tests exercise the oracle with deliberately corrupted signals before trusting the media measurements.

## Real MP3 headers — explicit scope only

Only after permission for the currently chosen album:

```sh
python tools/gapless_lab/mp3_headers.py --origin http://127.0.0.1:LOCAL_PORT --album DISPLAYED_ALBUM_ID --output build/mp3-headers.json
```

Replace placeholders with the explicitly chosen local server and album. Reads that one album response in memory (2 MiB bound), retains at most five IDs transiently, then requests at most 256 KiB per stream head for each requested quality (128/320). No credentials, names, native IDs or audio are written. Never substitute a library-wide search. Close each response after the bounded read. Error output is sanitized; no signed URLs or exception bodies are saved.

The Python inspector reports header compatibility and the current metadata-derived PCM bound. `alignment_verified` stays false: tags and sample counts cannot establish actual decoded start/end alignment. Request failure is not evidence of absent metadata. Unit tests use only the repository's synthetic MP3 fixture, with malformed/truncated variants.

## Reproduce the independent decoder-bound check

After fixture generation, this deliberately builds an invalid standalone FLAC with A's STREAMINFO and B's original frames. It isolates the first-header maximum-block restriction, separate from the valid individual fixture round-trips and the actual MSE failure:

```sh
node - <<'JS'
const fs=require('node:fs');
const media=require('./src/tagcast/static/gapless-media.js');
const dir='build/gapless-fixtures/';
const m=JSON.parse(fs.readFileSync(dir+'manifest.json'));
const c=m.cases.find(c=>c.id==='block-small-to-large');
const info=c.tracks.slice(0,2).map(id=>media.parseFlac(new Uint8Array(fs.readFileSync(dir+m.specs.find(s=>s.id===id).file))));
fs.writeFileSync(dir+'mixed-first-header.flac',Buffer.concat([Buffer.from('fLaC'),Buffer.from([128,0,0,34]),info[0].streaminfo,...info[1].frames.map(f=>f.data)]));
JS
ffmpeg -v warning -i build/gapless-fixtures/mixed-first-header.flac -f null -
```

The recorded FFmpeg run rejects larger blocks. Its deliberately inconsistent total/MD5 are not the reason for the explicit `blocksize 4096 > 1152` errors. This probe alone does not predict Chromium's error propagation; the separate Electron run observes a waiting stall without fallback.

## Full application regression checks

```sh
electron/node_modules/.bin/electron tools/gapless_lab/application.cjs --fixtures build/gapless-fixtures --out build/gapless-application
```

Use `--case mixed-block-fallback,stalled-playback-fallback` to select cases. There is no real account, credential loading or metadata write; external network access is blocked. JSON captures native media events, source URL changes, visible transport state, fixture request counts and action outcomes. Screenshots are synthetic and contain no personal library. A deliberately removed future SourceBuffer range tests the production eight-second liveness fallback; it is fault injection, not a claim that iBroadcast routinely removes that data. Cached-next skipping checks that B and C are requested only once. All application cases assert their outcomes and fail the process on failure.

## Targeted extended-session check

Use the existing full-application harness with `--soak-seconds 900` to repeat the compatible 24-bit FLAC fixtures in real time. It samples preparation/buffer/JS-heap state and Electron process memory every fifteen seconds, asserts forward progress, the same audio element and synchronized queue/current entries, and stops on unsupported fallback or an exceeded preparation bound. Output remains muted and no real account is loaded. This is a lifecycle/memory check, not a long-run PCM oracle or a measurement of physical output. The request/event bookkeeping contributes some laboratory memory overhead.

For the actual packaged production app, `python tools/check_electron.py APP_EXECUTABLE VERSION --restart` runs the existing isolated package check twice on one temporary fixed port/profile, verifying that browser and server preferences survive a real app exit/restart without touching installed profiles.
