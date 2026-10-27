# Send-once writes and read-back verification

Prepared for the 1.0 candidate. Earlier stable versions can retry ordinary metadata,
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
