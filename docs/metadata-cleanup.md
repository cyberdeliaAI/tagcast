# Clean up metadata

Available since Tagcast 0.30.0, including standalone downloads.

Open **Overview → Metadata health → Clean up metadata…**. The Albums page also
shows **Split combined genres…** when the **Combined genres** filter is selected.

1. Choose **Genres**, **Album artists**, **Track artists** or **Composers** and click **Prepare preview**.
   Preparing a draft does not write to iBroadcast.
2. Review the before/after examples. The preview covers the whole active library,
   independently of the current album filter or page. Uncheck albums to exclude them;
   a multi-disc set is one selection. Export the full JSON report to inspect every track.
3. Check the approval box and click **Start selected albums**. This sends the reviewed
   changes to iBroadcast. Local music files are never modified.
4. Keep track of confirmed, pending, sent, unconfirmed and excluded tracks. Each batch
   contains at most 200 tracks from 20 displayed albums and is read back before another
   batch is sent. The browser may close while the server continues processing.
5. **Stop after current request** prevents further requests. Writes already sent are
   checked and stay saved. **Resume after checking** rechecks current values before
   continuing; confirmed writes are not sent again.
6. Click **Refresh library** when processing has stopped or finished to update the
   displayed albums, artist groups and search results.

The latest draft and report are stored in `cleanup.json` in the Tagcast settings
folder, separately from browser History. Export the report before making a new
preview, which replaces it. A server restart stops execution; resume is explicit.
There is no batch Undo button. The report includes each track's original values.

## Album and track years (unreleased)

The next release adds **Album and track years** to the Category menu. This is a
separate comparison of the already loaded library, not a semicolon-cleanup batch.
Choose **Analyse years**, search/filter the results, then choose one complete
album/set and choose **Album year → track years…**, **Track year → album year…**,
or **Track year → album + all tracks…**.
Mixed track years require an explicit choice; unknown years are never copied and
Tagcast does not infer the oldest, most common or correct release year.

Each action opens the existing metadata editor and before/after review, bounded
to **20 discs / 500 tracks**. The selected action changes only the track years,
only the album years, or both to the chosen known track year. Tracks already at
that year stay unchanged. The general checkbox preference is overridden for that
draft alone. Normal conflict checks, History, read-back and combined-set
restrictions still apply. Other cleanup drafts remain separate.

The comparison stays open behind the review. After iBroadcast confirms the save,
it refreshes with search, filter, page and position preserved where possible.
This waits for the normal library read-back, which can take time for large
libraries. Cancel returns without saving; uncertain results retain their warnings
and never trigger automatic write retries. See the illustrated
[album and track years guide](https://github.com/cyberdeliaAI/tagcast/wiki/Album-and-track-years).
This feature is not included in the installed 1.0.0 downloads.

## Split album artists

The **Album artists** category is available in Tagcast 0.70.0, including desktop
downloads. It reads native library records, never a CSV export.
For example, `Caetano Veloso;Gal Costa` becomes primary album artist **Caetano
Veloso**, with **Gal Costa** as an additional album artist. Both then have the
album in their own artist view. This does not rename the old artist throughout
iBroadcast, or change track artists, track credits, titles, ratings or favourites.

Prepare a preview to see **every affected disc**, its previous names, proposed
**Primary** artist and **Additional** artists. Existing separate credits retain
their IDs, roles and phrases. Additional performer names containing semicolons
can also be split while keeping an unchanged primary artist. Other credit roles
stay intact. Duplicate generated names are avoided, and existing separate credits
take precedence over a generated duplicate.

Uncheck albums to exclude their complete displayed sets, then explicitly approve
and start. Each write uses the original native disc's album ID and is read back.
The report's affected-track totals count all active tracks on those discs; progress
counts **disc records**. Batches remain bounded to 200 affected tracks / 20 displayed
albums. A native disc larger than 200 tracks is blocked for individual editing.
Invalid names or more than 100 additional credits are also visibly blocked.

The following original capture, supplied on 18 October 2026, shows an approved
cleanup in progress in an unreleased source build. **Sent / checking** records are
still awaiting read-back; the screenshot does not represent a completed job.

![Running album artist cleanup with primary and additional artists, confirmed discs and pending read-back](screenshots/cleanup-album-artists-running.png)

**Combine Multi-Disc Album Sets must be disabled in iBroadcast.** Tagcast checks
this setting, exact active track membership, album title/disc/year and artist
identities before writing. Changes since the preview stop processing. Stop/resume,
account protection, request-error handling and separate local reports work as with
the other cleanup categories. Missing artist names are created only for a selected,
checked batch; an ambiguous creation reply stops processing until explicit resume
checks the fresh library. Nothing is written by opening Cleanup or preparing a preview.

**Show Additional Artists and Composers** is a separate iBroadcast display option;
it does not have to be enabled for Tagcast cleanup. Existing links stay stored and
Tagcast reads them independently. New names split from the primary field use the
**Artist** role. iBroadcast treats this role as another main artist, visible even
when additional roles are hidden. Other roles such as Composer can be hidden in
iBroadcast while remaining available in Tagcast. See the
[official iBroadcast explanation](https://news.ibroadcast.com/?page=1).

## Review genre labels

Choose **Review genre labels** for ambiguous values such as
`Alternative/Indie Rock/Pop/Indie Pop/Folk/Rock/Rock & Roll/R`.
Search the live library's stored main and additional labels, then select one exact
label. The picker shows affected album and track counts and paginates on the server.
Enter the desired labels **one per line**; the original text starts as a single
line, with no automatic splitting or suggested deletions. Keep `Films/Games` as one
line when it is a single genre. Uncertain fragments such as `R` are not removed
unless you explicitly leave them out of your replacements.

To remove one existing label, select it and check **Remove this label from matching
tracks**. Replacement text is disabled. The preview shows the remaining genres,
or **No genres** when removing the only label. Removing a main genre promotes the
next remaining label to main. Clearing the replacement box alone never removes
a label; the explicit removal checkbox is required.

Click **Prepare preview**, check the before/after examples, exclude any albums and
export the report. Editing the rule requires a new preview and renewed approval.
Only tracks containing that exact label are changed, including case. The replacement
labels take its original position; other genres keep their order, with duplicate
labels removed ignoring case. The first resulting genre stays the main genre.
The same checked batches, stop/resume, account protection and read-back apply.
A CSV export is useful for investigation, but is never the source for these writes.

## Split rules

Only semicolons are separators. Spaces around names are trimmed, empty labels are
removed and repeated genre labels are deduplicated without changing their order.
Slashes, commas and ampersands remain part of a name: `Films/Games`, `R&B` and
`Earth, Wind & Fire` stay intact.

- **Genres:** split the track's main and additional labels. The first resulting label
  becomes the main genre; the remaining labels become additional genres. Each track
  retains its own labels; no album-wide union is applied.
- **Track artists:** split combined primary and additional performer names. The first
  primary name stays primary; the rest become additional artist credits. Existing
  artists are reused by ID where possible; missing artists are created. Other roles
  and credit phrases are preserved. Album artists stay unchanged.
- **Album artists:** split the primary and additional performer names
  of each native album, preserving existing separate credits. The first primary
  name stays primary; remaining names become additional album artists. Track
  metadata stays unchanged. See the review and restrictions above.
- **Composers:** split only credits with the composer role, preserving the primary
  performer, guest artists and all other roles.

Separate artists and genres already stored correctly are not cleanup candidates.
The CSV album_artist column contains only the primary album artist, without a
separate field for additional album artists. The current server library determines
the draft; an export is not used as a write source.
Additional performers appear in Track artists, track search and individual links
on album pages and in the player.

The usual metadata editor remains limited to one album or one album artist. Cleanup
is a dedicated reviewed operation: only the selected genre/artist fields can change,
never titles, years, artwork or track numbers. It checks the account, active album membership and the
reviewed original values before writing. A conflicting edit, request error or
unconfirmed result stops further batches. A failed artist creation is not retried
in the background; explicit resume first checks the fresh library for that name.
