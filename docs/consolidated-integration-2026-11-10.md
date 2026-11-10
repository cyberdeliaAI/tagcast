# Consolidated development validation — 10 November 2026

Baseline: published Tagcast 1.6.5, `3eaab0e`. Version and release tag remain unchanged.
The integration retains the continuous-browse history (`2669841`, `24e1dcf`,
`e2b63a6`, `49254fa`), Random order (`136e178`), local visualizations (`d1c4848`)
and eight-effect rotation (`104a247`). Lyrics review optimization `b922507` is
included once as `b1de676`; it is independent of the visualization branch.

## Startup issue found during integration

The first isolated package checks failed with missing update functions. Network
diagnostics against the actual packaged server reproduced script connection resets
after four Electron page loads. Static files were byte-identical, not missing from
the bundle. The default HTTP listen backlog was too small for cold-start bursts.
`ae80d25` keeps a bounded queue of 64 pending connections, preserving loopback-only
binding, Host/Fetch Metadata checks, headers and existing request behavior.

A real-socket regression fails before the correction with ConnectionResetError and
passes afterwards. Thirty source-server starts and thirty final packaged-server
starts have no missing update functions or failed script loads. The final app also
passes initial startup and restart, including saved preferences, the same local
origin, CLI help/version, Mini Player, sandbox and owned-server shutdown. Earlier
failures and diagnostic harness errors remain in the local logs.

## Final local results

| Check | Result |
| --- | --- |
| Python 3.11.17 | 916 passed; 2,518 subtests; zero failures |
| Python 3.13.16 | 916 passed; 2,518 subtests; zero failures |
| Complete frontend suite, including i18n/browse/effects | 772 passed |
| Complete Electron unit suite | 47 passed |
| Continuous browser layouts | 120 passed |
| Group/favourite browser layouts | 240 passed |
| Random order browser layouts | 60 passed |
| Eight effects and random transitions in Chromium | Passed; same audio; no external requests |
| FLAC smoke and independent references | 24 measurements passed; zero PCM mismatches |
| Media diagnostics | Seven contracts passed |
| Full-page ordinary/Gapless playback | Ten scenarios passed with effects off and ten with Random |
| Negative media controls | Six expected failures correctly rejected |
| Media artifact completeness | Passed |
| Ruff, JS syntax, generated i18n/CSS, version/diff checks | Passed |
| New Apple Silicon app and Python wheel | All 89 static files match source bytes |
| App signature | Strict deep verification passed; local ad-hoc only |

Diagnostic mixed-block and seek cases intentionally measure differences; their
contract pass is not a sample-accuracy claim. No physical-output or real-account
validation is inferred. Windows, Linux and Intel execution belongs to remote CI.
The historical Python 3.14 upload-test failure is preserved in the earlier reports;
that test passes in both final supported CI interpreter suites.

## Recovery and publication scope

Before integration, every tracked change and untracked file in existing Tagcast
worktrees was archived with hashes, binary patches and a full verified Git bundle.
Verification read back 4,939 regular file contents from the archives. Historical
worktrees and their build/download artifacts are retained unless clean, redundant,
fully merged and free of user artifacts. No force removal or history reset is used.

Recovery data, full logs, local test apps and the final cleanup inventory live in
`build/repository-integration-2026-11-10/` in the primary checkout. Condensed results
and asset hashes are committed beside this report in
`validation/consolidated-integration-2026-11-10.json`.

The three enabled GitHub workflows were inspected. Ordinary integration messages
start Tests/Builds; publication requires the explicit `Publish Tagcast ` prefix,
a release event or a manually supplied release tag. This task makes no version
bump, release tag, release dispatch, installation replacement or public binaries.
