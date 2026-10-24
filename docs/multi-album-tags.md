# Tags for selected albums

Unreleased development feature, after Tagcast 0.80.0. The shared interface serves
both the Electron app and Python/browser version.

In **Albums** or an album artist’s page, tick complete albums in either the covers
or list view, then choose **Tag…** in the selection bar. Selections on other pages
or outside the current search/filter are included. The dialog lists every selected
album, its artist and track count; all discs of a displayed set stay together.

## Existing tags

Search for a native iBroadcast tag. **Keep as is** preserves existing assignments,
including partial assignments. **Add to all tracks** fills in the tag on the whole
selection; **Remove from all tracks** removes it only from the selection. Other
albums and tags remain unchanged. Archived tags cannot be added because they may
hide music in iBroadcast.

Choose **Review tag changes →**, check the album list and proposed changes, then
**Save tag changes**. Opening, searching and reviewing do not write anything.
Playback, queue and browsing filters are preserved. After all changes are saved and
confirmed, the reviewed albums are automatically deselected. Cancelling, errors
or unconfirmed results keep the selection; creating an empty tag alone also keeps it.

## New tags

Choose **New tag…**, enter a name and review creation of the empty label. Once
creation is confirmed, **Return to selected album tags** restores the complete
selection and searches for that name. Choose **Add to all tracks**, review the
assignment and save it. Creating the tag and assigning albums have separate
confirmations; creation alone never changes an album’s assignments.

## Bounds and safeguards

One review covers at most 20 displayed albums, 100 native discs, 500 active tracks
and 20 tag operations. These are local safeguards, not documented iBroadcast
limits. Use smaller selections for a larger collection.

Before writing, Tagcast checks the account/session, complete displayed album and
disc membership, album/artist names, track identities, combine-sets setting and
current tag names, archive states and assignments. Every write is read back. A
conflict, request failure or uncertain result stops later operations; no ambiguous
write is automatically retried. A partially completed save is not transactional.

Tags stay separate from genres, metadata editing, music files and metadata Undo.
The feature neither reads audio nor changes local music files.
