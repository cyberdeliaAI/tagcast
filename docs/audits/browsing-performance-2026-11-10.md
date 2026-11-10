# B-03 browsing performance remediation — 2026-11-10

## Verified baseline

Work started from fetched `origin/main` at
`f8d6243238a01f34f5168b93dc791714bbebc06d`. PR #46 was confirmed merged and
its post-merge [Tests](https://github.com/cyberdeliaAI/tagcast/actions/runs/42799354237)
and [Builds](https://github.com/cyberdeliaAI/tagcast/actions/runs/42799353810)
workflows both succeeded. The release-only follow-up was intentionally skipped.
A separate `codex/audit-browsing-performance` worktree preserves all existing work.

## Root cause and path inventory

`Studio._current()` always checks native `status` before it can reuse a matching
in-memory or disk library. Ordinary browse pages and native track favourites called
it for every request. `Tags.library()` was shared by read-only tag views and saves,
so tag catalogue/detail and album/track/multiple-album selection also checked status.
Continuous group browsing and Back restoration amplify that cost: the unchanged
frontend reads bounded 60-group pages, one request for each previously revealed page.

| Path | Previous behavior | Result |
| --- | --- | --- |
| `Studio.browse()` — track artists, composers, genres, years, decades, tags; group lists/details, search/sort/page changes | One status request per call with a valid snapshot | Read the current loaded snapshot |
| `Studio.favourites()` — native track likes, search and pagination | One status request per call | Read the loaded snapshot |
| `Tags.catalogue()` and `Tags.selection()` | `Tags.library()` checked status on every read | Use the browsing snapshot; retain bounded tag metadata |
| `browse.js` — initial page, more groups, deep Back restoration | One upstream check per bounded local page | Same local requests, zero upstream checks |
| Upload-folder/date browsing | Already loaded-only, with owner/snapshot guards | Unchanged |
| Album details/search, private playlists/folders/order reads, queue metadata | Already use loaded snapshots (playlist cache upgrades remain explicit) | Unchanged |
| Local album/artist hearts | Already local/account-scoped | Unchanged |
| Library loading/reloading, missing snapshot or missing tag data | Need a native read | Preserve the existing remote check/download |
| Recently played | Its live native history intentionally checks on opening/explicit refresh, independently of metadata read-back | Preserve existing behavior |
| Account settings/overview | Explicit current native account/preferences reads | Preserve existing behavior |
| Metadata, ratings, artwork, playlists, tags, lyrics, trash and other writes | Fresh conflict checks followed by send-once writes/read-back | Unchanged |
| Merge/split review, cleanup/duplicate analysis and reviewed batch preparation | Explicit preparation for remote mutations, not ordinary browsing | Preserve fresh checks |

No write request, payload, retry rule, `_current()` implementation or `_check_later()`
behavior was changed. In particular, `Tags.library()` remains the fresh path used
by `Tags.save()`; it was not globally turned into a cache reader.

## Snapshot, ownership and read-back behavior

`Studio._browse_library()` captures the active client, account, session and loaded
snapshot. It validates them before computation and again before returning the result,
without holding `Studio.lock` across index construction. Replacement during a read
produces a conflict rather than returning the replaced account/library's response.
The helper retains no cache, timer, job or snapshot beyond the request.

A missing library still loads normally. A legacy library without tags is upgraded
only when tag functionality is explicitly read; subsequent complete tag reads are
local. An unavailable first load or missing feature cannot be supplied offline.

While read-back is pending, browsing can read the existing snapshot without waiting
for or polling the job. A completed read-back publishes its fresh library through
unchanged `_current()`/`_keep()` behavior; following reads use that new instance and
its own derived indexes. A failed remote read retains the old loaded snapshot and
leaves the job unknown/error. A read-back that fetched data but could not confirm a
mutation can still publish current data; browsing never turns that into proof of
success. It never restarts a failed job or retries a mutation. Explicit refresh and
fresh pre-write checks remain the way to observe external edits.

This follows the existing album/search snapshot model. External edits, remote token
revocation and account preference changes are not discovered merely by changing
browse categories. Disconnect/reconnect clears the snapshot, and writes still check
the native revision before comparing the reviewed values. Snapshot replacement during
an in-flight page can produce the existing conflict/reload message, preventing mixed
page membership.

## Measurements

`tools/benchmark_browsing.py` uses a temporary Studio home, a real loopback HTTP
status mock and the real Studio/Library methods. The service accepts only read modes;
no real credentials, music, provider calls or mutations are used. Dimensions follow
the existing large-library fixture: 18,739 albums, 291,071 tracks, 2,631 artists,
plus 240 synthetic tags and native likes. The fixture explicitly has `combine_sets`
false, matching its loaded snapshot. All measured warm operations downloaded zero
libraries, both before and after.

Apple Silicon macOS, Python 3.13.16; five samples per warm operation. Timings include
endpoint computation and any upstream loopback request, but exclude the incoming
application HTTP request, JSON encoding, rendering and provider/service variability.
The 50 ms profile injects 50 ms into each status response; this is an experiment,
not a claim about real iBroadcast latency. The zero-delay profile still includes
actual loopback HTTP overhead. No first-index/CPU algorithm was optimized.

| Operation | Status requests before → after | 50 ms profile, before → after (ms) | Zero added delay, before → after (ms) |
| --- | ---: | ---: | ---: |
| Warm genres | 1 → 0 | 58.12 → <0.01 | 0.59 → <0.01 |
| Warm artist page, count order | 1 → 0 | 57.66 → 0.77 | 1.30 → 0.75 |
| Change four categories | 4 → 0 | 231.82 → 0.81 | 3.07 → 0.80 |
| Search/page native favourites | 1 → 0 | 75.01 → 2.48 | 3.14 → 2.66 |
| Tag catalogue | 1 → 0 | 61.73 → 1.13 | 1.66 → 1.08 |
| Album tag selection | 1 → 0 | 62.73 → 1.53 | 2.10 → 1.52 |
| Twenty continuous pages (1,200 groups) | 20 → 0 | 1,182.34 → 14.60 | 25.37 → 14.19 |
| Restore forty pages (2,400 groups) | 40 → 0 | 2,372.95 → 28.63 | 50.83 → 27.97 |

The removed ordinary-browsing status traffic is reduced by 100%; startup, explicit
refresh, feature upgrades, account reads and write/read-back traffic remain. Warm
response JSON digests match across before/after for every sample of every operation,
including ordering, membership, counts, tags and review fingerprints.

For the outage experiment the mock returns HTTP 503. Each of genres, favourites,
tag catalogue and tag selection previously failed after three status requests.
Each now succeeds with zero upstream attempts. Only the experiment shortens read
backoff to 10/20 ms; production's two/six-second delays remain unchanged.

The retained object graph rooted at the existing browse indexes, shared browse pairs,
album grouping and favourites was 63,991,387 bytes (about 61.0 MiB) before and after,
and remained exactly the same after fifty further category reads. The same snapshot
was reused; replacing it allowed garbage collection. This metric excludes native
tables, separate tag-membership/summary caches, caller responses, allocator overhead
and process RSS. The implementation adds no derived cache or eager index.

### Real-browser probe

`tools/check_browsing_snapshot.cjs` ran against `benchmark_browsing.py --serve`, the
actual shared frontend and HTTP API, with all external browser requests blocked.
Chromium 156.0.8078.4 loaded the full 18,739-album fixture. With upstream service
failure enabled, it loaded and restored 2,400 groups through forty bounded local
requests in 106 ms, preserving all keys, sort order and scroll position exactly
(10,000 px). One chunk was mounted after restoration; placeholders retained the
revealed scope. Sorting, filtering, category changes, favourites and tag reads still
worked. Native status count stayed at its single startup check. An explicit refresh
then made the existing three attempts and failed; subsequent tag browsing still
worked from the retained snapshot. No page script errors occurred.

That one browser sample includes frontend/local HTTP work and is not a statistical
cross-browser performance claim. The unchanged frontend's forty local requests remain;
no batching, virtual-window redesign or history behavior change was introduced.

### Reproduction

Use `PYTHONPATH` to select the baseline source at `f8d6243` or the feature source,
while executing the same benchmark script. Run sequentially with
`--status-delay-ms 50` and `--status-delay-ms 0`, each with a separate `--output` file.
Use a separate export/worktree for old source rather than reverting working changes.
For the browser check, start the benchmark with `--serve`, then supply its printed
loopback origin to `node tools/check_browsing_snapshot.cjs ORIGIN OUTPUT_DIRECTORY`.
Playwright is a test-only dependency; `TAGCAST_BROWSE_CHROMIUM` can select an existing
compatible executable. It adds no application dependency or frontend build step.
Raw JSON samples, source hashes, browser output and logs are retained under the
local ignored `build/audit-browsing-performance-2026-11-10/` evidence directory.

## Regression coverage and validation

`tests/test_browsing_snapshot.py` covers repeated categories, groups, filters,
sorting, favourite/tag reads, outages, failed explicit refresh, first load, missing
tag cache upgrade, actual account replacement and owner/snapshot changes during
computation. It also holds real read-back jobs pending after successful or remotely
applied-but-lost rating writes, verifies local browsing while pending, then checks
completed and failed outcomes without polling or replay. Tag writes still fetch
current native state and block stale cached reviews.

The frontend adds a 2,400-group Back regression checking every restored offset,
60-item bounds, complete keys, scroll and no library reload. Existing continuous,
selection, history, playback, i18n, uncertainty and Electron suites remain required.

| Validation | Result |
| --- | --- |
| Full backend, Python 3.11.17 | 936 passed; 2,558 subtests passed |
| Full backend, Python 3.13.16 | 936 passed; 2,558 subtests passed |
| Focused snapshot/tag regressions | 31 passed; 29 subtests passed |
| Frontend/media/i18n/continuous browsing | 774 passed |
| Electron shell and backend startup | 50 passed |
| Real Chromium large-library/history/outage probe | Passed; no page errors |
| Ruff, generated catalogues, release/version consistency, diff check | Passed; version remains 1.6.5 |

The original tag test assumed reads used the same fresh helper as writes. Its fresh
write/legacy-upgrade assertion is retained on that helper, while real-Studio tests
now cover the separate read path and one-time upgrade. No failed check is ignored.
The full suites include PR #46's applied-but-lost write regressions.

Remaining limits: timings are synthetic and hardware-specific; no real account or
service latency was measured. Cold index construction, forty local history requests,
large favourites scans, native read-back cost and process RSS remain outside this
optimization. The primary behavior trade-off is deliberate snapshot browsing until
an explicit reload or existing read-back publishes newer data. No release, automatic
merge, background refresh, extra persistent cache or write-protocol change is part
of this work.
