# Manual album splitting

Status: local implementation for testing; not released.

An iBroadcast album can contain tracks from different uploads or editions. A
different track year does not establish that a track belongs to a different
album. Tagcast therefore offers a manual selection and review, rather than
automatically splitting by year.

## Using the feature

1. Open an album and choose **More album actions → Split album…**.
2. Select the tracks to move. Leave at least one track in the original album.
3. Enter the new album's title, release year and disc number. Its primary album
   artist is copied from the original album.
4. Choose **Review split**, check the selected tracks and the number remaining,
   then explicitly confirm creation and movement in iBroadcast.
5. Wait for read-back before opening the new album. The existing queue and audio
   element continue independently.

For a displayed multi-disc set, select one native source disc at a time. The
feature currently supports 2–500 active tracks per source disc and requires
Combine Multi-Disc Album Sets to be off. Albums with additional album-artist
credits are blocked until those credits can be preserved reliably on creation.
The new primary album artist is not edited in this dialog.

Track IDs, titles, numbers, years, performers, additional credits, genres and
artwork are not changed. Playlists continue to reference the same track IDs.
The new album's cover follows its tracks. The original album's rating and local
favourite are not transferred to the new album. Local music files are untouched.

## Optional selection proposals

Proposals appear only inside the explicitly opened split dialog. They require
all of the following in the loaded metadata:

- Between two and ten distinct upload days, with at least two tracks per group.
- A single known release year within each group, different from every other group.
- Positive track numbers, without duplicate numbers within a group.
- Each group shares at least two track numbers with another group, indicating
  that numbering starts again across uploads.

Nothing is preselected. Choosing a proposal selects its tracks and fills the new
album year; the user can change both before review. Missing metadata, mixed years
within an upload group, or a year difference alone produce no proposal. These
are selection aids, not proof of separate releases or of the correct year.

An invented 24-track example reproduces the reported structure: eleven tracks
from one upload day, year 1991, numbered 1–11, and thirteen from another day,
year 1983, numbered 1–13. The dialog offers two groups. Selecting the second
moves thirteen tracks only after explicit confirmation and leaves eleven behind.

## Native API and failure handling

The payloads were checked against the public official web editor's
`createAlbum` and `moveTracksIntoAlbum` implementation in
[`iBroadcastLibraryEditor.js`](https://media.ibroadcast.com/js/iBroadcastLibraryEditor.js)
on 2026-11-07:

- `create_album`: `name`, `artist_id`, `year`, `disc`.
- `update_track`: a `tracks` array containing only `file_id`, destination
  `album_id`, and destination `album` name for the reviewed tracks.

These are two separate, non-transactional operations. Tagcast consumes a
session/account-bound review, checks the original membership and metadata, then
creates the album once. A successful reply must identify a new album ID. A fresh
library read must confirm the expected empty destination and unchanged source
before any tracks are moved. Membership movement is sent once, without retries.

Final read-back checks both albums, exact active membership and the known track
metadata. An accepted move with a lost reply can be confirmed by read-back.
An unconfirmed operation is never automatically resent. An empty album or a
partial move may remain after a failure; reload and check iBroadcast before
starting a new review. There is no automatic rollback or metadata Undo.

The checks require full iBroadcast library reads, so large libraries can take
time. This feature does not change the library cache or existing save engine.
Selections/reviews are bounded and expire after fifteen minutes. They are not
restored after restart. Change history records results without offering a retry.

## Verification scope

Automated tests cover proposals, manual overrides, stale membership, invalid
targets, account/session replacement, single-use reviews, ambiguous replies,
partial moves, preservation checks, and real local HTTP request/read-back
integration against the existing mock iBroadcast server. Browser checks use
invented albums only. No real account mutation has been performed during
development. Acceptance by the live service still needs an explicit user test.

Local validation on macOS Apple Silicon, 2026-11-07:

- Full Python suite: 900 tests and 2,479 subtests passed.
- Full frontend suite: 645 tests passed, including existing playback/queue tests.
- Electron shell suite: 47 tests passed using the project's Python environment.
- i18n suite: 26 tests passed; all six catalogues include the new controls.
- Ruff, JavaScript syntax (74 files), generated CSS/i18n and unchanged 1.5.5
  version consistency checks passed.
- Browser: English/Dutch, Light/Dark, 1280 × 800 and 420 × 800. Escape cancels;
  the mock split confirmed thirteen moved tracks and eleven remaining tracks.

No packaged application or other operating system was tested for this change.
