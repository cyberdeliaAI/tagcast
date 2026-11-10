# Data integrity audit remediation — 2026-11-10

Scope: B-04, F2-01 and investigation of F2-02 from the two independent audits
against `76dc49f`. Both reports were read in full; the second report supersedes
conflicting conclusions. Other findings are outside this change.

## Baseline and preservation

`origin/main` was fetched and independently checked with `ls-remote` before work:
`76dc49f5dd44cb49c40c9497073b565e9b06a9da`. No newer fixes were present.
`v1.6.5` still points to `3eaab0e77083b24e98a894c0c515e1bbd6dca9ab`.
Work uses `codex/audit-data-integrity-phase1` in a new worktree. Existing worktrees,
local artifacts and uncommitted work were retained. No real account was used.

## B-04 — confirmed

`Studio.save_settings()` changed active configuration while still validating keys,
and changed biography/information revisions before persisting the file. Validation
or an atomic-file replacement failure could therefore leave memory, persisted
preferences, requested OAuth scopes and running services inconsistent.

The method now stages a separate configuration, validates the complete submission,
persists it, then publishes it and updates invalidation revisions. Service cleanup
still happens outside `Studio.lock`, only after successful persistence. Omitted
fields are retained. `auto_lookup` is validated as a boolean like the other opt-ins.
The separate interface-language save follows the same persist-before-publish rule.
Tokens and their granted scopes are not rewritten by preference changes.

`tests/test_settings_atomicity.py` checks invalid keys at each key position,
overlong keys, partial submissions, failed enable/disable requests, OAuth scope
stability, cache revisions, running-service cleanup and actual `os.replace` failure.
A subsequent unrelated successful save cannot persist a previously rejected edit.

## F2-01 — all thirteen reported call sites confirmed

The audit counts call sites, not distinct native API modes or user actions.
The two conditional call sites each cover several operations.

| Original location at `76dc49f` | Operation | Correction and regression coverage |
| --- | --- | --- |
| `collections.py:466` | Create folder | Read back even without a receipt; unknown identity stays unverified |
| `collections.py:517` | Rename/add/remove/delete folder | Continue to full-definition read-back after uncertainty |
| `collections.py:554` | Playlist cover assignment | Check artwork and unchanged definition after uncertainty |
| `collections.py:676` | Playlist name/description | Check text and every unchanged saved position |
| `collections.py:764` | Playlist ordering | Verify the exact positional permutation, including repeats |
| `collections.py:798` | Remove one playlist position | Verify every remaining position, including repeats |
| `collections.py:837` | Create playlist | Refresh the catalogue; never guess an ID from a name |
| `collections.py:860` | Append/replace playlist | Continue existing result verification; append semantics unchanged |
| `collections.py:888` | Delete playlist definition | Check absence in a returned playlist table |
| `playlist_import.py:726` | CSV/URL import creation | Refresh even without an ID; consume the draft and retain submitted checkpoint intent |
| `album_merge.py:170` | Move tracks into selected album | Verify full membership and preserved metadata; review remains consumed |
| `client.py:1505` | Reviewed album/track trash | Verify each attempted track; never send the write again |
| `lyrics.py:420` | Reviewed userdata/lyrics save | Read complete userdata after uncertainty; verify lyrics and all unrelated fields |

Only `UncertainWrite` is intercepted. Explicit rejections still fail through the
existing error path; arbitrary programmer errors are not converted into success.
No transport retry policy was changed. Existing save locks, fresh conflict checks,
review consumption and account/session gates remain in place. Background jobs also
reject confirmation/payload publication after account or session replacement.
Missing playlist tables cannot prove deletion or any other playlist result.

Outcome rules:

- A returned, previously absent creation ID plus matching complete reviewed
  definition can confirm that creation. Existing-object writes require their
  expected read-back. `saved` means the checked current state matches.
- An explicit native rejection remains a failure. A fresh conflict blocks sending.
- A lost/missing/invalid creation ID stays **unknown**, even if a new playlist has
  exactly the requested name and contents. There is no native idempotency key or
  reliable attribution receipt. The refresh makes current playlists visible but
  cannot establish which creation request produced a matching record.
- A differing or failed read-back stays unverified/unknown, not confirmed failure:
  delayed application or an intervening external edit cannot be excluded.

For unknown creation identity the API returns an empty ID, `outcome: unknown` and
a read-back job. The frontend follows the job, refreshes the visible catalogue and
warns against creating another copy. It consumes its review and offers no resend.
The message exists in all six complete languages. Existing import checkpoints
remain read-only after submission; a later matching name does not clear that intent.

The collection tests simulate native writes being applied by the HTTP mock before
losing the response. Separate transport tests exercise timeouts, invalid responses
and HTTP failures with one send only. Merge, lyrics and trash tests cover applied
writes followed by lost replies; lyrics also tests changed unrelated userdata.

## F2-02 — unresolved contract; production semantics unchanged

The audit is correct about the global-deduplication assumption in the implementation
and mock, but its claim that duplicate suppression appears *only* in the mock is too
broad. The official [playlist component guide](https://help.ibroadcast.com/en/developer/components/playlists),
checked on 2026-11-10, documents suppressing an incoming track already present in
the destination. The [API reference](https://help.ibroadcast.com/en/developer/api)
lists the append request/response fields. Neither establishes whether existing
repeated positions survive append, nor precisely how repeated incoming IDs behave.
The guide's `playlist_id` example also differs from the reference's `playlist` field.

Current code sends first-occurrence selected IDs, then expects
`dict.fromkeys(existing + selected)`. The mock implements that same **whole-list**
deduplication. This is a model assumption, not observed service behavior. In
particular, it can falsely confirm a result that dropped intentional existing
positions. A literal-append server would instead disagree with that expectation.
This investigation does not change the payload, expected append semantics or mock,
and does not replace append with a potentially destructive full-list update.
Reordering, text edits and removal regression tests retain intentional duplicates.

A future, separately authorized service experiment must use disposable playlists,
record every position before/after, inspect both the immediate receipt and a fresh
library download, and check these cases independently (A/B/C are real test IDs):

| Existing positions | Append request | Question |
| --- | --- | --- |
| `[A]` | `[A, B]` | Is the incoming overlap suppressed as documented? |
| `[A, B, A]` | `[C]` | Do both existing A positions remain, in order? |
| `[A, B, A]` | `[A, C]` | Are overlap handling and old-position preservation independent? |
| `[A]` | `[B, B]` | Are repeated new incoming IDs kept or suppressed? |
| `[A, B, A]` | `[]` | Does a no-op append unexpectedly rewrite existing positions? |

No such service write was performed. Until verified, global deduplication remains
an unresolved risk; this PR does not claim F2-02 is fixed. See the API audit for the
same contract boundary.

## Validation

Local validation results are recorded after completion below. All tests use
synthetic data, temporary settings and/or the loopback mock; no live writes.

| Check | Local result |
| --- | --- |
| Full backend, Python 3.11.17 | 928 passed; 2,547 subtests passed |
| Full backend, Python 3.13.16 | 928 passed; 2,547 subtests passed |
| Focused affected backend suites | 184 passed; 435 subtests passed |
| All frontend/media/catalogue suites | 773 passed |
| Electron shell and backend startup suite | 50 passed |
| Ruff (`src tests tools`) | Passed |
| Generated translations and version consistency | Passed; version remains 1.6.5 |
| Patch whitespace check | Passed |

An existing cover-error assertion initially expected wording encouraging a retry.
It was updated for the deliberately neutral result message and now also rejects
that retry wording. Initial new-test fixture failures (module reload identity,
immutable library tables, and reuse of already-saved lyrics) were corrected; there
are no remaining local failures. CI provides the Linux/macOS/Windows matrix and
packaged application checks on the PR; this record does not claim those ran locally.

Regression risks are the newly reachable verification paths and extra read-only
library downloads after uncertainty, plus UI wording in six languages. Existing
successful response shapes remain unchanged. Unknown creations add an explicit
outcome marker and no usable ID. There are no new dependencies, migrations,
release changes or changes to playback. The remaining known append assumption is
not resolved by these passing mock-based suites.
