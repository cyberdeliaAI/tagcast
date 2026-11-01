# Tagcast stabilization progress — 1 November 2026

Follow-up: the [final integration validation](integration-validation-2026-11-01.md)
records three additional targeted build/release corrections and the final Python
3.11/3.13, frontend, Electron, media and extracted-package checks. Historical
results below are preserved unchanged. Durable logs and measurements are indexed
in [evidence/README.md](evidence/README.md), outside disposable build directories.

## Baseline and boundaries

- Original audit: Claude 5.5, `technical-audit-2026-11-01.md`.
- Independent verification: `technical-audit-fable-review-2026-11-01.md` and its evidence archive.
- Audited baseline: `58c8230b3fc9f348b3dc51485b65fe6194f0cf70` (1.2.0).
- Working branch: `codex/stabilization-audit`, isolated worktree at
  `/private/tmp/tagcast-stabilization-certifi-2026-11-01`.
- Preserved security branch: `codex/stabilization-certifi`, commit
  `613938266a38d1f84ff09c559009eec0a1deada8`.
- Canonical main, its untracked audits, Apple Music worktree (`ed68408`) and all
  unrelated worktrees are untouched. No real-account mutations, merge, push,
  tag, release, deployment or changes to installed applications are authorized.
- Every fix receives a separate local commit and focused regression coverage.
  Synthetic/mocked tests do not establish real-provider or hardware behaviour.

## Fixed and verified

### NEW-FE-1 — Overview streaming-quality HTML sink

- Original severity: P3 (new Fable finding); selected security priority 1.
- Root cause: account preference text passed through a nested template into
  `innerHTML` without escaping; a synthetic `<img onerror>` remained executable markup.
- Correction: apply existing `escapeHtml` at the interpolation. Known quality
  labels and intentional warning markup remain unchanged.
- Files: `src/tagcast/static/overview.js`, `tests/frontend.test.cjs`.
- Regression: malicious image/SVG strings, ampersands/quotes, known labels and
  preserved warning markup. Test failed before the fix and passes afterwards.
- Validation: all 591 frontend tests; overview syntax check; diff check.
- Commit: `1ac2234`.
- Limit: malicious-provider-input test, not evidence of a compromised account.

### R-09 — Download resume continuity

- Original classification: potential risk; Fable reproduced it and recommends P3.
- Root cause: a matching partial tracked identity but no prior total or response
  validator; a 4/10-byte partial accepted a new 4–12/13 response as complete.
- Correction: persist total and a strong ETag (otherwise Last-Modified) before
  bytes; reject changed totals or missing/changed recorded validators before
  append, including 416 completion. Validate zero/malformed lengths. Preserve
  older unknown-size partials with an explicit fresh-folder instruction.
- Files: `download_engine.py`, `tests/test_download_engine.py`, `docs/audio-downloads.md`.
- Regression: changed totals, validator changes/disappearance, first-response
  record ordering, misleading 416, invalid zero length, truncated resume and
  legacy partials. Five new cases failed on the original engine. Existing range,
  checksum, cancellation, ZIP and crash-recovery cases remain covered.
- Validation: 120 download tests, 52 subtests; Ruff and diff check passed.
- Commit: `a36cbd1`.
- Limits: synthetic streams only. Size alone cannot detect same-size changes
  without a server validator; a local digest is not a remote content guarantee.
  Completed files and manifest version/identity remain unchanged.


### Additional completed fixes

| ID / original severity | Root cause and smallest correction | Regression evidence | Commit |
|---|---|---|---|
| TC-01 / P1 | All refresh errors became NotConnected and triggered token deletion. Explicit OAuth credential rejection now differs from temporary/malformed service responses and TLS failures; status retries recover without deleting credentials. | Studio-level token-file/session preservation and explicit invalid_grant; shared-refresh concurrency; 95 Python tests / 53 subtests passed. | `c2b9c82` |
| TC-10 / P2, TC-39 / P3, TC-38 / P3 | Bare OSError erased terminal auth/TLS, local errno and cancellation distinctions. Stop the batch on auth/TLS/local disk prerequisites, keep bounded transient retries, never fallback on disk errors; cancellation is stopped. | 123 download tests / 56 subtests, including 3-track rejection (one request), TLS, timeout, ENOSPC/EACCES/EIO/ENAMETOOLONG; sensitive text suppressed. | `9ffbc23` |
| TC-43 / P3 | Skipped matrix dependencies could qualify a workflow. Explicit application/distribution fan-in gates require all expected successful jobs and valid scope. | Actual inline gate scripts exercised for success, docs-only, missing, failed, cancelled and skipped jobs; scope tests pass. | `da4ac23` |
| TC-13 / P3 | Tagged dispatch could upload ad-hoc archives with --clobber. Tagged runs now require signing and automatic replacement is forbidden. | Workflow regression; existing signing-secret isolation tests. | `53ecdcb` |
| TC-44 / P3 | Release went public before signed assets existed. Create a draft; validate exactly four archives/four hashes, archive-bound signing evidence and target SHA; upload, recheck remote names/sizes, then publish. | Synthetic files and mocked gh only: missing/changed/extra/unsigned assets, existing public releases/targets, upload failure/partial results; 31 release/build/scope tests / 98 subtests. | `24cd4ec` |
| TC-09 / P2/P3 | Fingerprint shortcut reused unrelated local rows; delayed restore seek could affect a newer track. Require restored-array identity plus current track/session/request guards. | Failing-before stale 37-second seek; successful restoration fetches fresh rows. | `6209048` |
| NEW-PB-1 / P3 | Connecting overwrote the queue before the offered local-vs-remote choice. Hold remote application until explicit choice; failed local publication retains the pending choice. | Local queue and source remain paused; no queue-track request before choice; explicit local publication sends original IDs. | `b046365` |
| TC-32 / P3 | Retiring Gapless while Queue Sync disallowed playback removed the source/position. Prepare a paused ordinary source and retain its track-relative position until metadata arrives. | Failing-before missing source; simulated native load reset; correct 17-second handover and no autoplay. | `0a424fd` |
| TC-05 / P2 | Cleanup's finally depended on an unrelated details-map identity. Clear only the still-current request's busy/status state after replacement. | Both Cleanup and duplicate Cleanup tested; existing reset/cancel tests retained. | `3f58c4e` |
| TC-06 / P2 | Appending changed the idle predicate after queue exhaustion; Play next could drop the first addition. Capture idle before insertion and wrap explicit Next in Repeat queue. | Three failing-before player tests: append, Play next, Repeat; native source/title/play state checked. | `95f36e7` |
| TC-07 / P2 at large libraries | Delivered read-backs retained large albums/editor_names, checking jobs were pruned and could reappear after disconnect. Deliver summaries once without mutating in-flight responses, preserve checking markers, bound completed jobs and clear/discard old-session jobs. | Ownership/lifecycle tests, compact repeated read-back frontend test; no per-job Library reference. | `6476a41` |
| TC-04 / P3, NEW-FE-2 / P3 | Reload/local replacement did not invalidate old read-back ordering or editor fetches. Advance saveOrder on explicit library replacement; bind editor response to load generation/details. | Two failing-before races; late editor stays closed and local library stays selected. | `8635342` |
| TC-50 / P3 | CSP blocked nine inline image onerror handlers. Replace with a delegated capture listener and fixed data actions, retaining the CSP. | 602 frontend tests; actual isolated Electron DOM with the production CSP: malformed artwork removed, placeholder restored, provider HTML escaped and no injected script. | `382f1d6` |
| TC-40 / P3 | os.walk silently ignored unreadable folders. Fail preparation explicitly on traversal errors; no audio/upload changes. | Baseline function failed regression; 57 upload/integration tests / 7 subtests pass. | `028374e` |
| TC-20 / P3 | Replacement logs inherited umask 022 and became 0644. Create logs with 0600, new settings directories with 0700 and tighten the existing three log files. | Regression forces rollover four times with umask 022; fails before and passes after. POSIX permissions only; Windows ACL behaviour is unverified. | `496e2c4` |

The exact files per correction are listed below; `git show --stat SHA` also shows each independent change.
Tests use synthetic data/local servers, not a real iBroadcast account. Release
publication has **not** been exercised against GitHub; its remote operations are
mocked. The new CI gates must be selected as required checks on GitHub after an
authorized push. Existing protection cannot acquire new check names locally.

## Fixed but requiring further platform validation

### TC-02 — certifi trust roots

- Original severity: P1.
- Root cause: locked and packaged certifi 2026.7.22 trusts emSign ECC Root CA - G3.
- Correction: direct minimum `certifi>=2026.10.19`; lock to 2026.10.23.
- Files: `pyproject.toml`, `uv.lock`, `tests/test_certifi.py`.
- Regression: direct security floor, locked/runtime versions and actual CA
  fingerprint; all failed appropriately with the old package.
- Validation: 778 Python tests / 2,242 subtests; 590 frontend; 40 Electron;
  Ruff, 44 JS syntax checks and version consistency. Actual macOS arm64 archive
  built/extracted/smoke-tested; its CA matches the updated wheel and excludes the
  compromised root. Frozen account-free backend HTTPS request succeeded.
  12 supported PCM scenarios + 12 references: no sample mismatches; nine actual
  page playback cases passed. See `build/certifi-stabilization/` evidence.
- Commit: `613938266a38d1f84ff09c559009eec0a1deada8` (preserved separately).
- Limits: no fresh Intel/Windows/Linux build or remote CI; test package ad hoc
  signed, no new notarization. Existing public releases remain unchanged.

## Not reproduced or false positive

- **TC-23:** Fable establishes that the write equals the reviewed After value;
  normalization is shared with the editor and documented. No behaviour change.
  This is an informational review-display limitation, not a mismatched write.
- R-03 remains a latent lock-order risk, not a demonstrated normal-flow deadlock.
  R-18 has an existing final-stat mitigation; no timestamp defect was reproduced.
- No P0 was established. Both verified P1 findings (TC-01 and TC-02) are addressed.

## Deferred due to implementation risk

- **TC-03:** the narrow stale-client disconnect/flag race remains. Existing `_owner`
  and `_keep` gates substantially restrict it; account assignment in `status()` is
  now guarded, but `_account_name` and `_remote_state` are not comprehensively
  owner-checked. A complete correction must atomically bind every disconnect and
  account flag update to the captured client, preserving refresh/queue lock order.
  A superficial check before an unconditional disconnect leaves the race intact.
- **TC-16 / TC-21 / TC-48:** graceful shutdown across browser, launcher and Electron
  deserves one coordinated change. A short global socket timeout also truncates
  valid streams; forced process termination risks accepted writes. The ordinary
  packaged Electron shutdown passes, but another client holding the same server
  open remains a known exception. No timeout/kill workaround was introduced.
- **TC-19 / TC-25 / TC-26 / TC-28:** changes to uncertain-write history, preserved
  cross-account intent, malformed on-disk task recovery and legacy playlist review
  paths require dedicated compatibility/recovery tests. They were not folded into
  unrelated connection fixes. Existing single-use, fresh-snapshot and no-retry
  write guards remain intact. Corrupt user files were not modified or discarded.
- **TC-08 / TC-29 / TC-31:** play-report identity and native error fallback need
  explicit event-order tests across emptied/playing/metadata events. Global epoch
  changes or a simple fallback flag would regress valid queue additions or count
  a listen again. These lower-severity playback edges remain open.
- **TC-46 / TC-47:** authenticating a reused local server, changing packaging fuses
  or removing smoke entry points is a coordinated cross-process/build-hardening
  change, not a safe one-line patch. Simply enabling asar-integrity fuses can
  prevent packages from starting. No runtime environment/fuse changes were made.
- **R-19:** Ubuntu 24.04/AppArmor cannot be verified on this macOS host. Commit
  `607205a` documents that boundary, the actual Ubuntu 22.04 workflow and the need
  for a real extracted-package test. It does **not** claim to fix Ubuntu 24.04.
  Neither `--no-sandbox` nor a global sandbox relaxation was added.
- Rejected approaches remain rejected: a complete Library per background job,
  general `player.epoch` increments, TC-23 genre semantic changes, portable
  no-overwrite publication via hard links, and unvalidated fuse flips.

## Not yet addressed — complete finding disposition

The following table distinguishes completed work from remaining lower-priority
work; it does not claim every audit item was independently reproduced in this
round. Original/Fable reproduction evidence supports remaining mechanisms unless
noted. "Deferred" means a separate focused change is needed, not a false positive.
The selected round stops after the security/release priorities and worthwhile
bounded reliability fixes; it does not redesign all error-recovery workflows.

| Finding | Original → reviewed severity | Final disposition / next evidence needed |
|---|---|---|
| TC-01 | P1 → P1 | Fixed `c2b9c82`; transient refresh retains credentials; explicit rejection still requires reconnect. |
| TC-02 | P1 → P1 | Fixed `6139382`; patched CA verified inside the final macOS arm64 archive. Other native platforms still require fresh builds. |
| TC-03 | P2 → P3 | Deferred: atomic captured-client ownership for disconnect/flags, as described above. |
| TC-04 | P2 → P3 | Fixed `8635342`, with job lifecycle support in `6476a41`; late results cannot replace a newer loaded/local library. |
| TC-05 | P2 → P2 (borderline P3) | Fixed `3f58c4e`; current Cleanup requests always release busy state. |
| TC-06 | P2 → P2 | Fixed `95f36e7`; exhausted queue additions start, and Play next does not discard its first track. |
| TC-07 | P2 → P2 at large libraries | Fixed `6476a41`; delivered large summaries released, checking jobs retained, disconnected jobs retired. Up to 20 **unconsumed completed** payloads can still be retained; no claim of zero memory overhead. |
| TC-08 | P2 → P3 | Deferred: duplicate play reporting on Gapless fallback with both opt-ins active; needs event-identity tests, no engine rewrite. |
| TC-09 | P2 → P2/P3 | Fixed `6209048`; restored-row identity and stale seek/session guards. |
| TC-10 | P2 → P2 | Fixed `9ffbc23` after TC-01; terminal auth/TLS aborts a batch rather than retrying every track. |
| TC-11 | P2 → conditional P3 | Open: length-less 200 body cannot prove completeness; real iBroadcast headers, especially transcodes, unverified. Do not reject every such stream or claim size proves audio identity. R-09 fixes resume continuity separately. |
| TC-12 | P2 → P3 | Open: an external writer creating the exact target during transfer can race publication. Separate destinations are already required. No hard-link publication or manifest protocol migration introduced. |
| TC-13 | P2 → P3 | Fixed `53ecdcb`; tagged rebuild requires signing and cannot automatically overwrite release assets. |
| TC-14 | P3 | Remaining: client abort/upstream stream exceptions can produce traceback noise, with upstream closed. No demonstrated data leak or resource leak; not changed alongside playback timing. |
| TC-15 | P3 | Remaining: malformed/negative Content-Length and foreign-Host static HEAD handling need focused HTTP parser tests. HEAD exposes no API response; only local clients can send the malformed requests. GET/POST security guards were not weakened. |
| TC-16 | P3 | Deferred coordinated shutdown: a second idle/stalled client can prevent exit. Normal extracted-app shutdown passed; no forced kill. |
| TC-17 | P3 | Remaining: Queue Sync status/connect may hold Studio.lock during network work. Moving I/O requires reconnect/role ownership tests and atomic thread/socket transitions. Existing bounded requests remain. |
| TC-18 | P3 / risk boundary | Remaining: an artificially delayed cold cache decode can overwrite newer memory. Normal boot makes one library request. Future fix should coalesce under download_lock and verify session/order; not broad cache refactoring. |
| TC-19 | P3 | Deferred: uncertain trash lacks a read-back job, like several documented write paths. Preserve explicit uncertainty and no retry; review the group consistently. |
| TC-20 | P3 | Fixed `496e2c4`; private rotation/new directories. Windows ACLs not established by POSIX tests. |
| TC-21 | P3 | Deferred: browser/CLI/Tk Ctrl+C shutdown does not share all Electron accepted-write waits. Include every launcher and lock order in a separate shutdown fix. |
| TC-22 | P3, low | Remaining: externally duplicated folder references are all unlinked by one ID-based removal. Tagcast cannot create the duplicate state and real server acceptance is unknown; playlist/music is not deleted. Future review could explicitly say all occurrences. |
| TC-23 | P3 → informational | False positive as review/write divergence; preserve documented normalization. |
| TC-24 | P3 | Remaining: semicolon track/composer split can include a duplicate credit already present. Review displays it and exact read-back fails safely on server normalization. Needs role/phrase deduplication contract tests. |
| TC-25 | P3 | Deferred: another account can replace a non-running saved report including uncertain intent; running tasks are protected. Refuse unsafe replacement or migrate ownership deliberately, never erase evidence automatically. |
| TC-26 | P3 | Deferred: structurally malformed local task/link JSON needs non-destructive validation/recovery. Atomic ordinary writes reduce frequency; do not silently rewrite a corrupt user file. |
| TC-27 | P3 | Remaining: disconnect/thread-start failure in Duplicate Cleanup may leave persisted running state without a worker. Needs state restoration fault injection; no request is sent by the failure itself. |
| TC-28 | P3, low | Deferred: crafted legacy playlist before-list bypasses newer description/session binding. Shipped UI uses before_token; changing legacy compatibility requires migrating callers/tests together. |
| TC-29 | P3 | Deferred: system Next/Previous unregister after final media error. Keep playability distinct from existing queue entries in a dedicated media-session change. |
| TC-30 | P3 | Remaining: a Queue Sync controller's local Now playing jump can mutate local Up next rows before playback is refused. Remote mode is opt-in; add role-change/DOM tests before adjustment. |
| TC-31 | P3 | Deferred: ordinary Original-to-128 fallback restarts at zero. Carrying position needs native metadata/error ordering and user pause tests; does not justify another audio architecture. |
| TC-32 | P3 | Fixed `0a424fd`; paused source and position retained through own-queue handover. Real WebSocket devices/output hardware remain untested. |
| TC-33 | P3 | Remaining: Overview can retain old account presentation or a late account reply after Disconnect. Read-only UI privacy/staleness, not writes; reset/render ownership needs a targeted page lifecycle test. |
| TC-34 | P3 | Remaining: Review the rest again can discard another open draft after late Results. No writes occur without review; confirmation behaviour is a separate unsaved-draft decision. |
| TC-35 | P3 | Not selected: avoid repeated artist sorting when only a count is needed. A performance issue, not a stabilization prerequisite; unsafe identity-only memoization rejected. |
| TC-36 | P3 / conditional | Remaining hardening: HTTPS-only provider links. Chrome noopener behaviour prevents the claimed simple execution; Safari/Firefox not tested. No exploitability claim for those browsers. |
| TC-37 | P3 | Remaining: artwork choice can re-enable Save during an existing request. Server save lock/fresh snapshot prevent duplicate writes; needs a presentation busy-state test. |
| TC-38 | P3 | Fixed `9ffbc23`; disconnected/cancelled transfer is stopped, not a generic failed download. |
| TC-39 | P3 | Fixed `9ffbc23`; auth/TLS and local errno are not collapsed into retry/fallback network errors. |
| TC-40 | P3 | Fixed `028374e`; unreadable traversal fails explicitly, never a misleading empty review. Native ACL/TCC conditions still need platform validation. |
| TC-41 | P3 / documented | Windows upload identity cannot detect every same-size/restored-mtime replacement. Requires native NTFS evidence; do not discard the hash cache or claim ctime parity. |
| TC-42 | P3 / documented | Tagcast/ibfetch concurrent same-destination lock interoperability remains unsupported/documented. Cross-project protocol change not selected, consistent with user's earlier decision to keep products separate. |
| TC-43 | P3 | Fixed `da4ac23`; fan-in gates tested locally. GitHub required-check selection and actual workflow execution await authorized push. |
| TC-44 | P3 / observed release risk | Fixed `24cd4ec`; drafts remain private until all eight assets and archive-bound macOS signing evidence pass. Mocked remote operations only. |
| TC-45 | P3 / hardening | Deferred maintainer policy: pin third-party Actions/build dependencies and define signing approvals. Existing limited signing-secret step retained; no credentials accessed. |
| TC-46 | P3 / local attacker | Deferred: authenticate reused server in both browser and Electron; owner protocol change and lifecycle tests required. Known heuristic remains. |
| TC-47 | P3 / local attacker | Deferred: package/debug/smoke hardening and embedded asar hash support must be changed together and checked on signed macOS/Windows. No untested fuse flips. |
| TC-48 | P3 | Deferred: visible wait feedback during graceful exit. Do not force-kill accepted writes; ordinary exit passes, second-client exception remains. |
| TC-49 | P3 / packaging | Remaining: audit bundled OpenSSL/libffi/zlib attribution against actual platform distributions; Python package licence inventory is not a complete legal audit. |
| TC-50 | P3 | Fixed `382f1d6`; CSP-compatible image fallback tested in a real Electron DOM. |
| NEW-FE-1 | P3 / security priority | Fixed `1ac2234`; account preference escaped. |
| NEW-FE-2 | P3 | Fixed `8635342`; stale editor details ignored after local/library replacement. |
| NEW-PB-1 | P3 | Fixed `b046365`; explicit local/remote choice preserves local queue. |

### Potential risks R-01–R-19

| ID | Disposition / evidence boundary |
|---|---|
| R-01 | Open: device-code polling stops on transient failure. TC-01 fixes refresh classification, not this separate sign-in polling policy. No real sign-in attempted. |
| R-02 | Deferred: power-loss durability/fsync across settings, intent and manifests is filesystem-dependent and needs recovery testing; atomic replacement alone is not claimed power-loss durable. |
| R-03 | Not demonstrated in ordinary loaded-library flow; latent lock order should be covered if cold-library behaviour changes. |
| R-04 | Provider-dependent partial result:false semantics unverified; no real-account writes allowed. |
| R-05 | Last.fm HTTP-200 error cache behaviour remains provider-dependent; no real error capture obtained. |
| R-06 | Artwork DNS/slow-drip/global save-lock risks remain; do not claim URL validation prevents DNS rebinding. Separate bounded-network test needed. |
| R-07 | Real server normalization of empty phrases/roles unverified; current exact comparison fails safely. |
| R-08 | Open: rare Cleanup Thread.start failure can leave running flag; pair with TC-27 fault injection. |
| R-09 | Fixed `a36cbd1` for changed totals/recorded validators/invalid resume. Same-size remote changes without a validator remain unprovable; real transcode stability unverified. |
| R-10 | Preserved fail-safe: changed-path/foreign partial remains blocked, existing bytes kept. User must choose a fresh destination rather than automatic deletion. |
| R-11 | Open: resolving an unavailable network destination under locks may stall snapshots/startup. No NAS on this host; future pre-resolution should preserve path/identity safety. |
| R-12 | Windows junction traversal unverified; requires Python 3.11-compatible native test, not a Linux/macOS symlink assertion. |
| R-13 | iBroadcast Expires enforcement against old caches unverified without real account/audio requests. |
| R-14 | Physical sleep/Bluetooth/output effects of the analyser AudioContext unverified; no second audio element or analyser architecture changes. |
| R-15 | Deferred product decision: consistent unsaved-draft confirmation, including Escape/close. |
| R-16 | Browser CSP hardening remains separate; current sink fixed, production Electron CSP preserved and image fallbacks checked. |
| R-17 | Safari/Firefox immediate blob revoke and localStorage quota behaviour not tested. Existing 300-entry history bound retained. |
| R-18 | Not reproduced; current final-stat timestamp baseline mitigates plain precision truncation. SMB/exFAT validation still needed. |
| R-19 | Documented `607205a`, not validated/fixed. Actual Ubuntu 24.04 sandboxed launch remains required. |

## Final verification

### Actual final checks

Application/build commit: `607205a4fa0a3ce786e50b23504a26772f23c287`.
The subsequent report-only commit does not alter the tested application.

| Check | Actual result | Evidence under `build/stabilization/` |
|---|---|---|
| Full Python suite, Python 3.13.16 | **802 passed; 2,294 subtests passed**, 135.12 s | `full-python-final.txt` |
| Full frontend suite | **602 passed, 0 failed** | `full-frontend.txt` |
| Full Electron shell tests | **40 passed, 0 failed** | `full-electron.txt` |
| Ruff, all src/tests/tools | All checks passed | `ruff.txt` (earlier run); final rerun recorded in `final-checks.txt` |
| JavaScript syntax | All 44 shared static scripts parsed | `final-checks.txt` |
| Version consistency | 1.2.0 throughout; no release/version bump | `final-checks.txt` |
| Diff whitespace | Passed | `final-checks.txt` |
| Synthetic media smoke | 12 supported scenarios + 12 reference controls; **zero PCM mismatches** | `gapless-smoke/results.json` |
| Diagnostic media | All 7 expected contracts pass; see limits below | `gapless-diagnostics-final/results.json` |
| Actual shared Tagcast page | 10 scenarios pass: disabled, startup fallback, mixed blocks, stall recovery, pause/rate/seek/cancel, repeat/queue edit, evicted seek, prepared skip, late replacement, high-rate start | `gapless-application-final/results.json` |
| Actual shared-page Queue Sync handover | Same native audio, ordinary source, paused position retained and explicit resume advances | `handover-real/results.json` |
| Real Electron DOM / production CSP | External account text escaped; no injected image/script; failed artwork removed and placeholder restored | `browser-safety.json` |
| Extracted final macOS arm64 app | Build, CLI help/version, sandbox/context isolation, settings/theme/mini-player smoke, owned-server exit all pass | `macos-build.txt`, `electron-smoke.json` |
| Archive dependency/assets | certifi 2026.10.23; 118 roots; compromised SHA-256 absent; CA byte-identical to tested wheel; all 11 modified JS assets byte-identical to source; archive checksum matches | `packaged-verification.json` |

**Failures and corrections, not hidden:** the first diagnostic invocation used
an older fixture directory and correctly failed its contract because the required
96/192 kHz stress files were absent. Fresh deterministic fixtures (35 files,
19 cases) were generated, all seven diagnostics and ten application cases rerun,
and `verify.cjs` validated every expected per-case artifact and capture length.
An auxiliary package-inspection assertion initially expected wheel `.dist-info`
inside PyInstaller's archive; PyInstaller uses `licenses/versions.json` instead.
The inspection was corrected to read that existing inventory and verify the
actual CA bytes/fingerprints; no package or dependency was changed to satisfy it.

**PCM interpretation:** the small-to-large block-size diagnostic deliberately
exercises the known incompatible raw MSE path and records 61,824 raw mismatches;
the production-page test separately confirms normal-playback fallback. The
`seek-early` diagnostic records 1,797,569 raw timeline mismatches because it skips
part of the signal; its contract is seek/readiness behaviour, not whole-stream
identity. Neither is counted as zero-mismatch/sample-accurate playback. The
supported smoke cases and both 96/192 kHz memory diagnostics have zero mismatches,
including their measured boundaries. These are synthetic decoded-PCM results,
not a claim about arbitrary music files or physical speaker/output continuity.
The high-rate tests are bounded sessions, not an overnight leak measurement.

The additional handover harness temporarily prevents unrelated mocked queue
polls during the controlled transition. It validates the real page/source/seek
sequence, **not** a real iBroadcast WebSocket device session. Unit tests cover
request/session replacement separately. No real account was connected or changed.

### Final local package

- Path: `dist/packages/tagcast-1.2.0-macos-arm64.zip` in the isolated worktree.
- SHA-256: `5e8d217c32693678a0a3fd302d9ef75dbc9b429e7be6d414d77d591d0bbef41f`.
- CA SHA-256: `2ef52ad56b4803e264045c915e55c236cbfa045b84b81efefc218a19eb44bd2b`.
- This is an **ad-hoc local verification package**, not a new official 1.2.0,
  Developer ID/notarized build or replacement for the installed app.
- The preserved certifi-only branch also has earlier isolated frozen-backend
  HTTPS evidence; the final archive contains the same verified CA bundle.

### Limits and integration recommendation

**Conditional GO for integration review, not an unconditional release GO.**
Both confirmed P1 issues, selected release-safety priorities and the selected
Cleanup/queue/read-back retention defects are corrected locally. Remaining P3
and provider/platform risks are explicitly listed above; they are not all fixed.

Before merging/publishing:

1. Obtain the user's explicit push/merge authorization. Keep this branch separate
   from the Apple Music/theme branch and unrelated dirty worktrees.
2. Run the existing complete GitHub platform matrix on this exact change set:
   macOS arm64/Intel, Windows and Linux, including media contracts. No remote CI
   was started in this round, and no fresh Windows/Intel/Linux package is claimed.
3. Select **Application verification** and **Distribution verification** as the
   required aggregate checks after they exist on GitHub; docs-only paths should
   still pass their deliberately lightweight checks.
4. Exercise the draft/signing/asset workflow with signing credentials in the
   intended authorized CI environment. Local tests mock `gh`; real artifact names,
   signing/notarization reports and GitHub permissions remain an integration test.
   A partially uploaded draft deliberately stays unpublished and needs explicit
   maintainer review; no automatic replacement. Historical tags without the new
   helper/signing evidence are not silently republished by this new recipe.
5. Test Ubuntu 24.04 on a real host and communicate its current sandbox limitation.
   Add targeted manual queue reconnect/handover and large-library save/read-back
   checks on a non-destructive test setup; this round measured ownership release,
   not peak RSS during a real 18,739-album account session.
6. Prepare a new version/security release after approval. **Existing public 1.2.0
   downloads still contain the old CA bundle and other baseline defects** until
   replaced by a newly built release. The trust-root issue is conditional on an
   on-path attacker/compromised chain; this is not evidence of an actual compromise.
   Source installs following the old lock also need the updated dependency.

No merges, pushes, tags, releases, deployments, installed-app replacements or
real iBroadcast writes were performed. No application CSS, palettes or Apple
Music theme files were changed. Settings/tokens in user profiles were not opened
or rewritten; tests used temporary profiles and synthetic state.

## Exact changed files by local commit

The following paths are repository-relative to the isolated worktree above.
The certifi commit remains independently usable on `codex/stabilization-certifi`.

| Commit | Changed files |
|---|---|
| `6139382` | `pyproject.toml`, `tests/test_certifi.py`, `uv.lock` |
| `1ac2234` | `src/tagcast/static/overview.js`, `tests/frontend.test.cjs` |
| `a36cbd1` | `docs/audio-downloads.md`, `src/tagcast/download_engine.py`, `tests/test_download_engine.py` |
| `c2b9c82` | `docs/write-reliability.md`, `src/tagcast/auth.py`, `src/tagcast/client.py`, `tests/test_auth.py`, `tests/test_token_refresh.py` |
| `9ffbc23` | `docs/audio-downloads.md`, `src/tagcast/client.py`, `src/tagcast/download_engine.py`, `src/tagcast/downloads.py`, `tests/test_download_engine.py`, `tests/test_downloads.py` |
| `da4ac23` | `.github/workflows/builds.yml`, `.github/workflows/tests.yml`, `tests/test_ci_scope.py` |
| `53ecdcb` | `.github/workflows/builds.yml`, `docs/code-signing.md`, `docs/native-builds.md`, `tests/test_ci_scope.py` |
| `24cd4ec` | `.github/workflows/builds.yml`, `docs/native-builds.md`, `tests/test_release_assets.py`, `tools/build_electron.py`, `tools/release_assets.py`, `tools/release_info.py` |
| `6209048` | `src/tagcast/static/queue-sync.js`, `tests/frontend.test.cjs` |
| `b046365` | `src/tagcast/static/queue-sync.js`, `tests/frontend.test.cjs` |
| `0a424fd` | `src/tagcast/static/gapless.js`, `src/tagcast/static/queue-sync.js`, `tests/frontend.test.cjs` |
| `3f58c4e` | `src/tagcast/static/cleanup.js`, `src/tagcast/static/trash.js`, `tests/frontend.test.cjs` |
| `95f36e7` | `src/tagcast/static/player.js`, `tests/frontend.test.cjs` |
| `6476a41` | `src/tagcast/client.py`, `src/tagcast/static/app.js`, `tests/frontend.test.cjs`, `tests/test_readback_retention.py` |
| `8635342` | `src/tagcast/static/app.js`, `tests/frontend.test.cjs` |
| `382f1d6` | `src/tagcast/static/app.js`, `src/tagcast/static/artists.js`, `src/tagcast/static/artwork.js`, `src/tagcast/static/browse.js`, `src/tagcast/static/lookup.js`, `tests/frontend.test.cjs` |
| `028374e` | `src/tagcast/uploads.py`, `tests/test_uploads.py` |
| `496e2c4` | `src/tagcast/app.py`, `tests/test_logging_privacy.py` |
| `607205a` | `docs/native-builds.md` |
