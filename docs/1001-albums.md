# 1001 Albums

Based on [*1001 Albums You Must Hear Before You Die*](https://en.wikipedia.org/wiki/1001_Albums_You_Must_Hear_Before_You_Die),
edited by **Robert Dimery**, with contributions from music critics. The first
edition was published in 2005; the supplied selection used here covers 1955–2007.

This optional discovery page compares the bundled **1001 Albums You Must Hear Before
You Die** selection with your loaded iBroadcast album metadata. It is disabled by
default. Enable **1001 Albums** in **Settings → Discovery**, save, then open the page
and choose **Analyse my library**. Enabling or opening it does not start a scan.

The page separates **In your library**, **Possible matches**, and **Not found**.
Search and pagination use the saved results. Open an album or add a confirmed match
to the queue as usual. Multiple discs and editions count once per reference entry;
separate library editions can be opened individually. A metadata match does not
establish that the album has all its tracks or a particular recording/mastering.

Compact decade buttons and the year sort use the reference release year, rather
than the year of a library reissue. Choose **All decades** to clear that filter.
**List order**, **Year · oldest first** and **Year · newest first** apply before
pagination and combine with search/matching status. Back and Forward retain them;
these controls do not trigger analysis or make library requests.

**Show matching details** next to **Analyse again** toggles the status labels and
link controls on cards. It saves your choice in the local Tagcast settings, including across restarts,
local ports and browsers, without changing the report, manual links, filters or playback. Turn it back on to choose or undo a
link. Missing covers keep their grey appearance.

Missing entries use a grey, softened placeholder cover. Their title, artist and
matching status remain readable. See the [illustrated walkthrough](../README.md#1001-albums-optional)
for found, possible and missing results and the album chooser. The **?** on this page
starts its six-step 1001 Albums tour; it never starts an analysis or saves a link.

## Confirm or choose a match

1. Open **Possible matches** and choose **Confirm match…** on an entry. The chooser
   initially shows its suggested library editions.
2. Check the artist and title, then choose **Use this album**. You can search the
   loaded library by title or artist to select a different album. For a **Not found**
   entry, start with **Choose album…** and search for your edition.
3. The entry is marked **Linked by you** and counts as found. **Change link…** lets
   you select another album; **Undo link** restores the automatic analysis result.

Links only identify an album already in your library. They do not upload music,
create playlists or edit any iBroadcast metadata. Searching uses compact album
summaries and does not fetch tracks. Multiple discs of a displayed set are linked
together. A manual choice remains across restarts and explicit reanalysis; if the
chosen album later disappears, the entry is marked unavailable instead of silently
switching to a different album.

If the chooser says the running server does not support manual links, restart the
Tagcast server/launcher and then reload the browser page. Refreshing only the page
does not load new Python server code.

## Matching and storage

- Compare album artist and album title, ignoring case, accents, whitespace and
  punctuation. `&` and `and`, and a leading artist `The`, are equivalent.
- Recognised trailing edition labels such as `(2011 Remaster)` or `[Deluxe Edition]`
  do not prevent a match. Meaningful subtitles, live versions, remixes and
  rerecordings are retained. The reference year is displayed but is not a mandatory
  match: a library copy may be a later reissue.
- Close artist/title spellings appear only as possible matches. They do not increase
  the found count until manually confirmed. Different numbered volumes are not fuzzy
  candidates for each other. No automatic metadata corrections or playlist writes
  are made.
- The analysis uses the server's existing library copy. It does not download audio,
  request individual track details, send names to external matching services, or
  change iBroadcast metadata, ratings or playback.
- Results are stored in `album-guide.json` in the Tagcast settings folder, scoped to
  the iBroadcast account, library revision, multi-disc setting and reference revision.
  Another account never receives those results. A changed revision requires an
  explicit **Analyse again**. If iBroadcast supplies no library revision, a saved
  report cannot be reused after restarting the server.
- Manual links are stored separately in `album-guide-links.json`, scoped by account
  and the original reference selection. They survive spelling repairs to that
  selection. Concurrent changes to a link are rejected; reopen the page to read the
  current choice. Another account cannot view or overwrite your links.
- Disable the feature in Settings to hide it. The saved report remains local and
  can be reused if enabled again while the same library revision is still loaded.

## Offline album background

For confirmed reference matches, the album page offers **About this album** above
the track list. Expand it to read a locally bundled excerpt, with its Wikipedia
attribution and CC BY-SA 4.0 link. The texts are independent of the book's authorship.
They are not book excerpts or user reviews. The reference selection remains 1,001
albums; the [source index](https://1001albumsgenerator.com/albums) covers 1,101 across different editions.

All **1,001** reference entries have a background text. The initial comparison found
894 exact artist/title pairs; the remaining 107 source links were reviewed individually
and captured. One further review replaced an unrelated Fats Domino biography.
The 108 editorial links, their reasons and four album-specific text repairs are
stored in `docs/1001-album-note-links.json`. Uncertain links are never approved by
similarity alone. `1001-album-notes.json` is a separate file: updating
notes does not invalidate analyses, change reference IDs or affect manual library
links. Texts are at most 200 words, with whitespace and sentence spacing normalized.
See `src/tagcast/static/1001-album-notes-LICENSE.txt` for attribution details.
Two entries have a visible context note: the Mamas and the Papas debut uses an
alternative UK title, distinct from the later self-titled album; the paired
**Shalimar / College Girl** reference has background covering Shalimar only.

Tagcast never contacts the source site or Wikipedia to show a note. It reads the
bundled JSON once per browser page, lazily when a confirmed matching album is opened.
If necessary it first reads the account's saved local guide report; it never starts
analysis. Notes are shown only for found/manual-found reference matches in a current
report, not possible, stale or unavailable matches. Disable 1001 Albums to hide them.
Opening and closing a note does not change playback, metadata or browser history.

### Refresh or complete the text collection

`tools/import_album_notes.py` is an explicit maintenance tool, not part of normal
startup. It reads the public source index and matches **unique normalized artist +
title pairs**. It does not replace our list with the site's wider selection. Source
year differences do not rewrite the reference year. Similarity is used only to
suggest manual review candidates. Ambiguous or absent matches stay unresolved.

```sh
python3 tools/import_album_notes.py
python3 tools/import_album_notes.py --fetch
```

The default command compares using the bundled editorial links; `--fetch` captures
matched summaries and applies the reviewed text repairs. Both write
`build/guide-import/report.json` and an HTML review alongside it. The HTML lists
unresolved reference IDs with candidate links, followed by all editorial source links
and their review reasons. Captures are cached locally,
requests are paced (0.5 seconds by default), and refusal/rate limiting stops the run.
Rerunning resumes from cached notes. Only the Album Summary with an explicit English
Wikipedia source is kept; comments and images are excluded. Each entry retains its
source URL, capture URL/date, attribution and modification notice.

For each unresolved entry, the report also provides a **Last.fm** album lookup link,
built from the reference artist and title. These are unverified research aids, not
confirmed matches or imported texts. Last.fm offers `album.getInfo` with an API key;
its [API terms](https://www.last.fm/api/tos) include separate attribution, public-use
and redistribution conditions. Check those before adding a Last.fm text capture;
the current tool does not scrape Last.fm or use the user's saved API key.

To approve another source match, copy `docs/1001-album-note-links.json` to a separate
file and add or replace the original reference ID's reviewed source URL, for example:

```json
{"2": "https://1001albumsgenerator.com/albums/SOURCE_ID/reviewed-album-slug"}
```

Use actual URLs from the report/source index; the example is not a valid link.
Then run `python3 tools/import_album_notes.py --fetch --links YOUR_LINKS_FILE.json`.
The `.example.json` file is an empty template for a fresh review. Use the populated
file to retain the existing reviews, then pass your copy with `--links`.
The bundled notes file is generated. A URL absent
from the source index needs an explicit `source` object with its album, artist and
year, plus a review `reason`; this is used for the individually verified Phil Spector
Christmas album page. All URLs must remain on the approved source host. Reviewed
`note` overrides require at most 200 words, an English Wikipedia `source_url` and a
review reason. They repair summaries that describe an artist or film instead of
the album. Optional `context` text explains title ambiguity or partial coverage.
This file links reference
entries to background-text sources, separately from the user's iBroadcast album links.
For a trial capture, use `--limit 5 --output build/guide-import/trial-notes.json` to
avoid replacing the complete bundled file with a partial trial.

## Reference and spelling cleanup

`src/tagcast/static/1001-albums.json` derives from the user-supplied
`1001-albums-you-must-hear-before-you-die.csv`. It retains that file's 1,001 entries,
order and stable IDs, covering 1955–2007. Titles, artists and selected original
release years have been corrected after review. The order is still the source
order, so corrected years do not necessarily increase from one entry to the next;
use the year sort for that. This is the supplied selection, not a claim to represent
the latest edition of the book. It has no external release identifiers.

The original CSV is unchanged. The bundled reference repairs the export's
underscore substitutions and malformed accented characters. Exceptional underscores
used for quotation marks, ellipses, separators and year ranges were reviewed
individually. Clear spelling errors such as `Cindy Lauper`, `Chic Manish` and
`Fullfillingness` were corrected. The JSON includes the source SHA-256 and a
field-by-field `corrections` log (195 fields across 164 entries), so each change is
traceable to the original CSV. The follow-up review corrected another 92 fields,
including swapped artist/title columns, truncated or incorrect titles, artist
spellings and 20 release years. Two of those fields had already received encoding
repairs, so their log entries retain the original value and the final correction.
The reviewed fields include source links. These reference corrections never alter
the user's library.

Examples include **Crossing the Red Sea with the Adverts** instead of `tori amos`,
**Manassas** by Stephen Stills (1972), **The New Tango** by Astor Piazzolla & Gary
Burton, **Whatever** by Aimee Mann, and **São Paulo Confessions** by Suba. The
reference uses 1963 for **The Freewheelin' Bob Dylan**, 1970 for **Cosmo's Factory**
and 1971 for **Hunky Dory**, as given by the artist/label sources below. Original
release years can differ from regional editions or reissues in the library; they
are not required for matching.

After a reference update, restart Tagcast and choose **Analyse again**. The changed
catalogue hash makes older reports stale. Existing manual links keep the same
entry IDs and original selection hash and remain available after reanalysis.

The downloadable corrected CSV uses the same **Year, Album, Artist** columns and
reference order, encoded as UTF-8 without a BOM. The original supplied CSV remains
unchanged. A BOM is an encoding marker used by some spreadsheet programs, not part
of the column name; imports should not treat it as text.

Examples of artist/label references used to check repaired names and accents:

- [ECM: The Köln Concert](https://ecmrecords.com/product/the-koln-concert-keith-jarrett/)
- [Björk official store: Medúlla](https://shop.bjork.com/products/bjork-medulla)
- [Fania: Siembra](https://fania.com/es/eras/willie-colon-and-ruben-blades-siembra/)
- [Nonesuch: k.d. lang and Ingénue](https://www.nonesuch.com/artists/kd-lang)
- [Universal Music: Café Bleu](https://www.universalmusic.it/popular-music/album/cafe-bleu_36981379453/)
- [Motörhead official site: anniversary editions](https://imotorhead.com/category/new-releases/page/3/)
- [Fire Records: Crossing the Red Sea with the Adverts](https://www.firerecords.com/product/the-adverts-crossing-the-red-sea-with-the-adverts-2011-cd/)
- [Crammed Discs: São Paulo Confessions](https://crammed.be/index.php?id=37&rel_id=188&tracklist=full)
- [Bob Dylan: The Freewheelin' Bob Dylan (1963)](https://www.bobdylan.com/albums/freewheelin-bob-dylan/)
- [Craft Recordings: Cosmo's Factory (1970)](https://craftrecordings.com/blogs/permanent-record/ccr-cosmos-factory)
- [David Bowie: Hunky Dory (1971)](https://www.davidbowie.com/blog/2021/12/4/hunky-dory-hits-half-a-century)
- [Rhino: Grievous Angel (1974)](https://www.rhino.com/aod/grievous-angel-gram-parsons-0)
- [Penguin Cafe: debut title and 1976 release](https://www.penguincafe.com/pages/about)
