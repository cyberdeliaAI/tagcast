# Send-once writes and read-back verification

Included since Tagcast 1.0. Earlier stable versions can retry ordinary metadata,
ratings and artwork assignments after an ambiguous transport failure.

`StudioClient._post` retries only `library`, plain `status`, `get_artwork` and
`gettrackuserdata`. Network failures and HTTP 429/5xx retain bounded read retries
(two and six seconds). A `status` request containing play history is a mutation.
Unknown/new modes default to send-once. Explicit HTTP 401 / authentication rejection
retains the existing coordinated OAuth refresh; this is distinct from replaying a
write whose result is unknown.

This policy covers normal album/track changes, cleanup, lyrics, album merge,
track/album/artist ratings, artwork assignments, playlists, tags, trash and play
reporting. The image-upload endpoint already sends once, with refresh only on an
explicit authentication rejection. A lost upload response cannot supply an artwork
ID, so Tagcast does not proceed to an assignment or upload automatically again.
Streaming uses its existing separate read path.

An interrupted mutation, HTTP 429/5xx or unusable success response raises
`UncertainWrite`. Ordinary metadata saves stop subsequent groups and read back the
attempted changes. Matching values become `saved`; differing/missing values become
`unverified`; subsequent groups remain `not_sent`. Explicit rejections remain
`failed`. Read-back failure never claims that the write succeeded. Fresh conflict
checks still precede a newly reviewed action. Read-back establishes current values,
not ownership of an edit or transactional isolation on the remote service.

Track ratings and artwork assignments also read back after an ambiguous response.
Artwork undo stops subsequent assignment groups after any uncertainty/error; it
checks the whole reviewed target rather than pretending a partial operation was
complete. Album ratings remember attempted discs before sending. Cleanup already
persists intent, stops on errors, reads back and requires explicit resume with fresh
checks; the transport fix removes its formerly hidden automatic write retries.
Existing single-use lyrics, tag, playlist and merge review gates remain unchanged.

`tests/test_write_reliability.py` uses the real transport, save planning and read-back
checks against synthetic in-memory state. It covers applied-but-lost replies,
intervening external changes, stale reviews, partial batches, 429/500/503, connection
errors, timeouts, invalid responses, explicit authentication rejection, read retries,
artwork and ratings. Existing cleanup, collection, artwork and refresh suites cover
their scope, conflict and lifecycle rules. No real account is modified.

### Temporary sign-in renewal failures

OAuth timeouts, unavailable services, malformed renewal responses and TLS
validation failures retain the current session and saved credentials. Retry the
operation later; certificate validation is never bypassed. Only an explicit
OAuth credential rejection (or a repeated authenticated API rejection) requires
reconnection. A shared failed renewal still wakes all waiting requests without
resending ambiguous writes or persisting replacement credentials.

### Audit follow-up: ambiguous collection, merge, trash and lyrics writes

The thirteen missing uncertainty/read-back call sites identified in the November
2026 audit now continue read-only verification after `UncertainWrite`, without
replaying the mutation. Playlist/folder/import creation without a confirmed new
ID refreshes the catalogue but remains unknown; matching a name or even the whole
definition does not identify a lost creation receipt. The UI consumes the review
and warns against creating another copy. Failed reads and replaced accounts or
sessions never produce a confirmed result. See the [remediation record](audits/data-integrity-remediation-2026-11-10.md)
for the complete call-site inventory, regressions and unresolved append contract.

## Reviewed iBroadcast trash emptying (development)

**Settings → Data & exports → Review iBroadcast trash…** explicitly checks the remote library
revision and shows only tracks whose native trashed flag is set, 50 per page. Nothing is
selected or sent when Settings opens. Empty trash produces an ordinary empty
state; reviews above 10,000 tracks or with unreadable metadata are blocked.
These are Tagcast bounds, not claims about the service's limits.

The review requires acknowledgement and an extra confirmation before submitting.
Its bounded, expiring, single-use token stays in memory and binds the account,
session and complete trash identity snapshot, including the combine setting.
The save lane checks the remote revision again and compares the complete trash
snapshot, rejecting added, removed, restored or renamed members in the current
library. Both pre-write checks reuse the existing account/combine-bound library
only when iBroadcast reports the same known revision; changed or unknown revisions
require a download. A failed revision check blocks progress without a mutation.
This uses the normal library freshness contract, not an assumption that a revision
observed after a write belongs only to Tagcast. As with other revision-based checks,
changes that the service has not yet distinguished in its revision can remain unseen.
The operation then sends exactly one `empty_trash` with the reviewed
IDs. It never sends active tracks, automatic retries, permanent Dashboard
deletion requests or restore operations. No local music files are touched.

A fresh read-back still downloads the library, even if its revision did not change,
and confirms the reviewed IDs are absent. An unchanged library therefore needs
one full download after emptying, instead of three across review/save/read-back.
The progress text distinguishes revision checking, emptying, read-back and local
review paging without extra network polling or an invented percentage. A
restored active record is not treated as confirmation. Lost replies are checked
without replaying the request; refusals, partial results and failed read-backs
remain distinct. History/export retain an aggregate result and review digest,
without review tokens, metadata Undo or a resend action. Account/library changes
invalidate the browser review; accepted work remains part of normal shutdown
draining.

Emptying Trash is not permanent deletion. Per iBroadcast, these files appear as
Unavailable Files in the Track Dashboard and can still count toward storage.
Further Dashboard management remains in iBroadcast. The service offers no
conditional transaction for the local review; concurrent changes during the
request cannot be ruled out by these checks. Public-client contract observations
and real-account validation limits are recorded in [the API audit](ibroadcast-api-audit.md).
