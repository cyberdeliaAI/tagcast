# Library summary reuse

The first performance change after the Theme Editor reuses album summaries within a
single downloaded `Library` snapshot. It changes neither playback nor the UI.

## Why this change

`Studio.load_library()` and metadata read-back responses return compact summaries for
all active albums. Previously, `Library.album_index()` scanned all those albums and
their tracks again on every call, even when Studio reused exactly the same library.
The editor's genre/composer suggestions already reused that pass. The summaries now
reuse it too.

This benefits repeated library responses shared by album and artist browsing,
filters and navigation. Ordinary page navigation generally uses data already loaded
in the frontend; it does not suddenly become another hundred times faster.

## Freshness and ownership

- The cache belongs to one `Library` instance, without a global revision/account cache,
  timer, disk format change or new request.
- Studio's existing account/revision/combine-setting checks remain unchanged. A fresh
  download creates a new `Library`, including during read-back with an unchanged
  `lastmodified` timestamp.
- Saving still checks current values and verifies accepted writes through fresh native
  data. Cached summaries are never used as evidence that a write succeeded.
- A per-instance lock coalesces concurrent summary requests. Summaries and editor names
  become available only after a complete successful build. A failed build is retryable.
- Each caller owns the returned list, dictionaries, genre/upload-date lists and artist
  dictionaries. Editing one response cannot corrupt another response or the cache.
  The ownership regression test traverses the entire schema, including nested fields.
- Native tables remain immutable snapshots by convention, like the existing search,
  browse and overview caches. Future code must replace a snapshot instead of modifying
  its tables in place. A new mutable summary field also needs an independent copy.
- Unreferenced snapshots can be collected even while a returned response remains alive.
  Existing jobs/reports can still retain a snapshot for their normal lifetime.

## Measurements

Offline measurements on Apple Silicon, Python 3.13.16, using synthetic compact data:
18,739 albums, 291,071 tracks and 2,631 artists. No account, actual music, providers
or network requests were involved. These are local computation times, not total
application response times. Warm values are medians of three runs; cold builds were
measured once and should not be treated as statistically established changes.

| Operation | Before | After |
| --- | ---: | ---: |
| First album-summary build | 1,525 ms | 1,554 ms |
| Summary response for the same snapshot | 1,450 ms | 15 ms |
| JSON encoding of summaries and editor names | 42 ms | 41 ms |
| Year comparison | 479 ms | 474 ms |
| Warm whole-library track search | 59 ms | 60 ms |

Only the repeated summary pass was optimized. The approximately 97-fold improvement
applies to that operation. Fresh downloads, first index creation, network latency and
remote write/read-back time remain. In particular, this does not remove the wait for
iBroadcast to confirm year edits.

The measured additional retained summary-cache object graph is approximately 32.3 MiB
for this large fixture. Eight further reloads did not grow that graph. This measurement
excludes native tables, caller-owned responses, Python allocator overhead and total
process RSS. It is a deliberate CPU/memory trade-off per retained snapshot.

## Verification and scope

`tests/test_library_index.py` covers reuse, nested response ownership, empty libraries,
editor-first requests, concurrent loads, interrupted builds and new snapshots at the
same revision with changed metadata, artists, artwork, membership and upload dates.
Additional mock-server tests in `tests/test_client.py` verify that repeated loads still
check remote state, same-revision read-back returns fresh years/genres, and external
edits still prevent conflicting writes. The full Python, frontend and Electron suites
remain the regression reference.

First-use search/browse index construction, very large queue rendering and native
network waits remain separate investigation topics. No eager startup scan, persistent
derived cache, partial read-back shortcut or playback change is included.
