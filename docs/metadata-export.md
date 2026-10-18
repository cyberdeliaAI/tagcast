# Library metadata export

Available in current source/test builds; not in the published 0.60.0 downloads.

Open **Settings → Export library metadata**, choose the optional data to include,
then **Prepare JSON export** or **Prepare CSV ZIP**. When preparation finishes,
choose **Download JSON** or **Download CSV ZIP**. Closing Settings pauses status
polling; reopen it to find the prepared file. A preparation can be cancelled.
These actions are independent of **Save** and **Export changes**.

The server exports the full **loaded library**, regardless of current page filters,
search, selection or pagination. Open editor drafts and changes made in iBroadcast
after this library copy was loaded are not included. Reload the library first if a
fresh snapshot is needed. Preparing an export does not contact iBroadcast or online
sources, fetch individual tracks, scan audio, migrate favourites or write metadata.

Albums are native album/disc records, without Tagcast's browser grouping. Trashed
albums/tracks and tracks outside active album membership are excluded from core
music tables. Artists retain native IDs, names, stars and artwork IDs, including
artists marked trashed that can still be used in credits. The synthetic artist ID
`0` represents Various Artists. Missing values are distinct from empty text.

## Formats and relationships

JSON contains a `manifest` and the following arrays. The ZIP contains one CSV with
the same name for each table, plus `manifest.json` and `README.txt`:

| Table | Contents / joins |
| --- | --- |
| `artists` | Native artist IDs, names, ratings, artwork IDs and trashed flags. |
| `albums` | Native album ID, title, primary artist ID/name, readable combined artist names, year, disc, rating and representative artwork ID. |
| `album_tracks` | Album ID, active track ID and zero-based order within the supplied active membership. |
| `tracks` | Track ID, membership album ID, original stored `source_album_id`, album/title/primary artist, readable credits/genres, year, track number, duration, rating, stored type/format, artwork ID and upload date/time. |
| `credits` | Album or track ID, zero-based position, primary flag, artist ID/name, native role and credit phrase. Primary rows have null role/phrase; additional rows preserve their native order, IDs, unknown roles, nulls and empty phrases. |
| `genres` | Track ID, position, main/additional flag and exact stored label. Labels containing semicolons or slashes are not split; order and duplicates are preserved. Position 0 is reserved for a stored main genre. |
| `tags`, `tag_tracks` | Loaded tag IDs, names and archived flags, with track membership. |
| `playlists`, `playlist_tracks` | Loaded ordinary/system playlist IDs and supported metadata including artwork IDs, with ordered track membership. Duplicate positions and playlists over 10,000 tracks are retained. |
| `playlist_folders`, `playlist_folder_items` | Native folder records and ordered references to playlist/folder IDs. References never become track IDs. Nested, repeated, missing and cyclic references are preserved without recursive expansion. |
| `favourites` | Locally saved album/artist hearts, scoped to the connected account. Track hearts/thumbs-down are represented by native track ratings. |

IDs are strings, so spreadsheet/JSON tools need not round large IDs. `credits`
uses `entity_type` (`album` or `track`) plus `entity_id`; `artist_id` joins to
`artists`. Readable joined names/genres are conveniences; use relationship tables
to reconstruct separate entries. A missing native artist row may still be referred
to by ID, with Tagcast's usual Unknown artist display fallback in readable columns.

`album_tracks` keeps the membership supplied by iBroadcast. `source_album_id`
retains each track's original stored album ID, which can differ in combined views.
When iBroadcast combines discs, an export cannot reconstruct native records that
were not supplied. `combine_sets` records that library setting in the manifest.
Upload timestamps retain available precision without inventing a timezone; the
original date/time values are included too.

## Optional data and completeness

Tags, playlists and local favourites are selected by default. The checkboxes apply
to the **next preparation**, without saving server settings. Only already loaded
tag/playlist data is included. An older cache may not contain it; its status will
be `not_loaded`, rather than falsely claiming an empty collection. Reload the
library before preparing another export to obtain missing provider data.

Schema 2 separates playlist folders from ordinary playlists. `playlist_folder_items`
uses `folder_id`, `position`, `playlist_id`, `kind` and `in_export`. A target kind is
`playlist`, `folder` or `unavailable`; missing targets have `in_export=false`.
Schema 1 incorrectly placed folder references in `playlist_tracks`; prepare a new
export when folder relationships matter.

Tag and playlist memberships retain stored unavailable/trashed track IDs, using
`in_export=false` when no core track row is exported. Playlist order and repeated
track IDs are preserved. Local favourite files are read without migration; missing
files are reported as empty saved lists, and damaged files as `unavailable`.
Saved favourite IDs outside the exported tables also have `in_export=false`.

The manifest contains schema version `2`, Tagcast version, UTC preparation time,
library revision, combine setting, table counts/columns and optional-data status:
`included`, `not_loaded`, `not_requested` or `unavailable`. Status responses contain
only this small summary, never the complete track catalogue or file contents.

## CSV encoding

CSVs use UTF-8 with a BOM, commas, normal CSV quoting and CRLF record separators.
Null is `\N`; empty text is an empty cell. Booleans are `true`/`false`.
For spreadsheet safety and reversible decoding, an apostrophe is prepended to
text beginning with a backslash, apostrophe or control character, or resembling a
formula (`=`, `+`, `-`, `@`) after leading whitespace. Remove exactly that leading
apostrophe when decoding escaped text. For example, literal `\N` becomes `'\N`,
and a literal initial apostrophe is doubled. JSON preserves native scalar types
without this CSV escaping. No metadata is truncated.

## Temporary files and scope

Preparation writes incrementally to a private temporary file on the local server;
the browser never buffers the complete archive as a JavaScript Blob. Download
streams the same file. At most one export prepares at once and two jobs are retained.
Files expire 15 minutes after preparation starts and are closed on cancellation,
replacement by a third job or server shutdown. A library/account/connection change
invalidates the old export; prepare a new one. Restarting never resumes preparation.

This is a metadata archive, not an audio/image backup or a restore feature. It does
not include OAuth credentials, source API keys, signed streaming/file URLs, account
settings, playlist share keys, change history, third-party biography/album prose or
other local caches. The separate CSV playlist importer matches track lists to the loaded library; it does not restore this metadata archive. Metadata import/restore requires a separate reviewed design.
