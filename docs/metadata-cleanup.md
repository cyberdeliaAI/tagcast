# Clean up metadata

Available since Tagcast 0.30.0, including standalone downloads.

Open **Overview → Metadata health → Clean up metadata…**. The Albums page also
shows **Split combined genres…** when the **Combined genres** filter is selected.

1. Choose **Genres**, **Track artists** or **Composers** and click **Prepare preview**.
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
- **Composers:** split only credits with the composer role, preserving the primary
  performer, guest artists and all other roles.

Separate artists and genres already stored correctly are not cleanup candidates,
although a CSV export may join those values with semicolons again. The current
server library determines the draft; an export is not used as a write source.
Additional performers appear in Track artists, track search and individual links
on album pages and in the player.

The usual metadata editor remains limited to one album or one album artist. Cleanup
is a dedicated track-only operation: it cannot change titles, years, album artists,
artwork or track numbers. It checks the account, active album membership and the
reviewed original values before writing. A conflicting edit, request error or
unconfirmed result stops further batches. A failed artist creation is not retried
in the background; explicit resume first checks the fresh library for that name.
