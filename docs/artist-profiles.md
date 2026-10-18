# Artist profiles: implementation and local checks

These features are in the development source and have not been published in a
desktop release. See the Wiki's [upcoming changes](https://github.com/cyberdeliaAI/tagcast/wiki/Upcoming-changes)
for user instructions and availability.

Artist favourites and optional biographies use the shared Python server and plain
JavaScript interface in both Electron and browser/source starts. There is no new
runtime dependency; SQLite comes from Python's standard library.

## Local favourites

The heart beside an album artist's name saves the complete named group of native
artist IDs in `artist-favourites.json` under the normal Tagcast settings folder.
Entries are separate for each iBroadcast account, survive restarts, and are shared
by browsers connecting to the same settings folder. They do not sync to other
computers. Renaming an artist preserves their saved native ID.

The Album artists filter includes **Favourite artists**, and a filled heart appears
on matching cards. Counts, filtering and pagination reuse compact album summaries;
they do not request tracks. A group with multiple identically named native IDs is
marked only when all those IDs are favourites. Missing/inactive saved IDs remain
in the local file, but are omitted from active results.

The shared **Favourites** sidebar shortcut has **Tracks**, **Albums** and
**Album artists** tabs. The artist tab reuses those same compact groups and local
hearts; it never requests track details or biographies. Searches and paging remain
separate for each tab, including through Back/Forward and visits to an artist.
Existing `#/favourites` and `#/album-favourites` addresses still work;
`#/artist-favourites` opens favourite album artists directly. The former separate
album-favourites sidebar preference migrates to the shared shortcut. Tabs support
touch, keyboard focus, Left/Right and Home/End selection.

`POST /api/artist-favourite` checks the current playback/account session, exact
artist name, complete active group membership and previous heart state before an
atomic write and read-back. Damaged files are reported without overwriting them
or preventing library loading. Neither heart changes nor reads contact iBroadcast,
change ratings or add metadata History entries.

## Native ratings and sorting

The stars below an album artist's name use iBroadcast's documented `rateartist`
request, with scalar `artist_id` and rating 0–5 (zero clears it). The local heart
stays independent. One displayed name can contain multiple native artist IDs;
the control shows the minimum rating and identifies mixed values. One explicit
choice applies to that complete named group, with at most 20 native IDs.

`POST /api/artist-rating` validates session, complete active membership, exact name
and previous ratings against the current library before writing under the shared
save lock. It stops on error, does not retry ambiguous writes and reads back every
native result through the existing job mechanism. Missing artists cannot confirm
a cleared rating. Jobs return compact results, not the whole album index. Neither
artist hearts, album/track ratings, playback nor metadata History are changed.

Album artist lists and their Favourites tab sort by native artist rating, without
averaging their albums' ratings. Album browsing also sorts by album rating and
**Date uploaded**, newest/oldest first. This is the latest known upload among
active tracks across the displayed album/set. Unknown dates and unrated items
stay last, and names break ties. Existing upload-day set grouping is unchanged.
Upload dates are deliberately not offered as an artist sort. Sorting uses compact
summaries and never downloads tracks or contacts iBroadcast.

## Optional biographies

Enable **Settings → Artist biographies → Show artist biographies from TheAudioDB**
and save. This preference is off by default. Enabling alone never fetches anything.
Visiting an album artist reads the local cache first; only missing or outdated
information starts a separate background lookup. Albums remain usable throughout.
**About this artist** expands the available English biography and source link.

The fixed public API endpoint is
`https://www.theaudiodb.com/api/v1/json/123/search.php?s=ARTIST_NAME`.
The only library information sent is the visited artist's name. The shared source
client paces requests at least 2.1 seconds apart. A provider error backs off for one
minute, preserves existing cached text and permits an explicit retry. No shared or
personal Premium key is included in this feature.

Matching retains accents, punctuation and qualifiers, allowing only Unicode-normalized
case/whitespace differences. Fuzzy matches and multiple exact results are left
unresolved. A single same-name result can still describe another person or band;
the interface retains attribution and a link for checking. An artist image is not
required. Both the current `strBiography` and older `strBiographyEN` English fields
are supported. Provider HTML is stripped and display text is escaped.

The separate `artist-biographies.sqlite3` file is created only on first enabled
use, with owner-only creation permissions where supported. It stores public text
by source, strict artist-name key and language, not account IDs, tracks, images or
credentials. Ready text is reused for 30 days; absent, empty or ambiguous results
for one day. At most 5,000 records and 20 MiB of encoded content are retained;
SQLite file overhead/free pages can add to the on-disk size. Old text is returned
before refresh. Disabling does not delete the cache. A damaged/unwritable cache
reports an error without replacing it or affecting playback or albums.

Late results are rejected after library, account, session or biography-preference
replacement. The disclosure has no browser-history entry, preserves focus through
background updates, and keeps its expanded state when returning from an album.

## Checks

- `tests/test_artist_profiles.py`: account isolation, stable artist IDs, stale group
  validation, file failures, cache reuse/expiry/limits, source matching, concurrent
  requests, provider failures and late results.
- `tests/test_collections.py` and `tests/test_app.py`: compact library restoration,
  opt-in settings and existing HTTP security guards.
- `tests/frontend.test.cjs`: heart state, filtering/Back, lazy biographies, escaping,
  stale results, failure fallback, unchanged audio/ratings and explicit Settings save.
- Manual browser check uses a temporary mock iBroadcast account and synthetic
  biography text, separately from real account/settings folders.

Provider references: [API documentation](https://www.theaudiodb.com/free_music_api),
[JSON fields](https://www.theaudiodb.com/docs_json), and
[terms of use](https://www.theaudiodb.com/docs_terms_of_use.php).
