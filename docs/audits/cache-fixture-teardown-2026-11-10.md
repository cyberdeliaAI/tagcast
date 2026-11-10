# Collection fixture cache teardown — 2026-11-10

Baseline: main `309366704ed0aa26cf812a91622c44b3ae62b10c`.

PR #52's initial Windows/Python 3.13 run failed with WinError 145 during
CollectionTests.tearDown, after the browsing assertions passed. The existing
fixture acquired and released cache_lock, incorrectly treating this as a join.
A background writer that had not entered its target could acquire the lock
after temporary-directory removal and recreate that directory. A deterministic
gated real worker reproduces the failure on macOS too; it is not a Windows-only
application defect.

The fixture now calls the existing local _disconnect before draining cache_lock.
That stops fixture services and invalidates pending writers through the existing
captured-client ownership guard. A writer which already passed that guard still
holds cache_lock, so teardown waits for its write to finish before removing files.
The restarted Studio in the favourites persistence test uses the same sequence.
This does not call logout, revoke OAuth credentials or contact the service.

Two event-driven regressions cover a delayed worker after removal and a write
already holding the cache lock. The former fails against the original teardown;
both require their real worker to execute and finish. The latter proves that the
write completes and removal cannot run while it is blocked. No sleeps, retry,
assertion weakening, ignored cleanup errors or production timeout changes.

All changes are in collection test fixtures and this evidence record. Production
cache, shutdown, account/session and remote write/read-back behavior are unchanged.
The correction does not claim to redesign production cache-worker accounting.

Validation: all 66 collection tests and 92 subtests pass locally. Complete Python
3.11.17 and 3.13.16 suites each pass 983 tests and 2,635 subtests; all 857 frontend,
media and Electron unit tests pass. Ruff and whitespace checks pass. Protected PR
CI results are recorded in the PR after completion. Original failing evidence
remains in the local build evidence folders.
