# Album merge walkthrough — 27 October 2026

Author-supplied screenshots of a successful real-library test of the **local album-merge test build**.
They are copied without rescaling or editing. The app version inherited by this test build is
0.85.1; album merging is **not included in the released 0.85.1 downloads**.
The feature is documented as unreleased development functionality; these captures
do not announce a new application release.

The illustrated [Merge albums guide](https://github.com/cyberdeliaAI/tagcast/wiki/Merge-albums)
uses these four selected captures. Intermediate confirmation and checking screens are
omitted to keep the guide focused; the text explains those steps.

| File | Step |
| --- | --- |
| [selected-albums.png](selected-albums.png) | Four fragments selected after searching for 8bits |
| [destination-album.png](destination-album.png) | Explicitly choosing the existing Various Artists destination album |
| [review-tracks.png](review-tracks.png) | Reviewing the destination, preserved metadata and resulting track list |
| [merged-album.png](merged-album.png) | The merged album with eight tracks, track performers, composer credits and tags |

The user selected four fragments of *The 8bits of Christmas*, explicitly kept an existing
Various Artists album, reviewed eight tracks and confirmed the merge. The application
reported all eight tracks confirmed after read-back; the user reported that the test worked.
This is evidence for this test case, not a claim of validation across every album or platform.

Track performers, composer credits and tags remain visible in the resulting album. Choosing
Various Artists is not automatic: this example retains the destination's existing album artist.
The general collection totals are background context, not a library-wide before/after audit.
No local music files were changed by Tagcast.

`manifest.json` records original filenames, dimensions and SHA-256 checksums.
