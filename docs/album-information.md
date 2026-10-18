# Optional album information

Available in current development/source builds; not yet in a desktop release.
User instructions are in the Wiki's [upcoming changes](https://github.com/cyberdeliaAI/tagcast/wiki/Upcoming-changes#optional-album-information).

Enable **Settings → Album information → Show album information from TheAudioDB**
and save. When visiting an album, **About this album · TheAudioDB** shows available
English background text in a collapsible panel above the tracks. It is independent
of artist biographies. When an album has an available local 1001 Albums text, that text takes priority with its existing Wikipedia
license links. TheAudioDB text is neither read nor requested for that album. The
common prose style stays limited to 85ch.

The option is off by default. Enabling alone does not scan or fetch. A visited
album first resolves only its own identity against the bundled 1001 Albums catalogue
and text, even with the discovery option off or without any saved analysis report.
The local read reuses the existing exact normalization, preserving live/remix/subtitle
distinctions and numbered volumes while accepting recognized edition suffixes.
An ambiguous normalized pair is not selected automatically. Explicit manual links
for the current account/selection take precedence while all linked discs remain active.
The read never scans the library, changes found counts, reads/writes the full report,
fetches track details, starts analysis or contacts iBroadcast/external sites. While that check is pending,
TheAudioDB waits. If no valid reference text is available (including unavailable,
ambiguous identities or a local read failure), the album reads its separate
TheAudioDB cache. Only missing or expired text starts a
background provider request. Album controls and playback remain usable while it
loads or if a request fails. A merged multi-disc page makes one lookup for its
displayed primary disc's identity, not one for every track or disc.

## Matching and requests

The server validates the active album ID, displayed artist/title and playback
session against the loaded library. It uses stored primary artist and album names,
never the Unknown artist/Untitled album placeholders. The public v1 endpoint is:

`https://www.theaudiodb.com/api/v1/json/123/searchalbum.php?s=ARTIST&a=ALBUM`

Only that artist and full title leave Tagcast. Matching allows case, Unicode NFC
and whitespace differences, but retains punctuation, accents, numbered volumes
and edition/live/version text. Exactly one matching result is required. Multiple
matches remain unresolved; a missing English description stays unavailable. A
same-name result can still describe another release, so the source link remains
visible. Current `strDescription` and earlier `strDescriptionEN` fields are supported.

A matched album without an English description is shown as **Album found on
TheAudioDB, but no English background text is available**, with its source link.
This is separate from **No matching album found**. Punctuation is preserved; for
example, the API finds **Mambo!** by Yma Sumac but currently returns no English text.

The adapter returns a whitelist of public identity/text fields and a source link
constructed from the numeric album ID. Provider HTML is stripped and frontend text
is escaped. The shared source HTTP client keeps artist biographies, album text and
suggestions at least 2.1 seconds apart; there is no new key or Premium integration.

## Local cache and failures

`album-information.sqlite3` in the normal Tagcast settings folder holds public
English text by source, strict artist/title identity and language. It contains no
account credentials, library IDs, tracks or artwork. Text can be reused across
albums/accounts with the same public identity, but each request still validates
the current session and active album. Successful text lasts 30 days; missing,
ambiguous and unavailable results last one day. Refresh occurs only on a visit.
The cache is limited to 5,000 records and 20 MiB of stored JSON, plus SQLite overhead.
Disabling retains the file and prevents new reads/lookups through the feature.

Simultaneous visits share one lookup. No session lock is held during the provider
request. Source errors preserve old text and impose a one-minute backoff. The API
returns HTTP 429 with a bounded `retry_after`; the UI enables **Try again** after
the delay without fetching automatically. The disclosure stays open during retry.
Cache errors are local messages and do not overwrite damaged files.

Settings, session, account, library or album identity changes invalidate pending
responses. Navigating away before a cache-only response never starts a hidden
provider lookup. Metadata/tag cache replacement retires an outdated in-flight read
and recovers only the visible unchanged album. Ready text and disclosure state are
reused on Back. The feature never writes to iBroadcast, History, the queue or audio.

## Validation

`tests/test_album_info.py` covers exact/ambiguous matching, response fields, expiry,
negative caching, bounded/corrupt storage, HTML stripping, parallel visits, backoff,
independent settings and late-result rejection. The route joins HTTP security-guard
tests in `tests/test_app.py`. Frontend regressions cover lazy visits, escaping,
playback/history preservation, navigation/Back, disclosure/retry, cache replacement,
settings and 1001 Albums text priority independent of discovery, including delayed
local checks, fallback and suppression of late TheAudioDB responses.
`tests/test_album_background.py` covers the per-album exact/manual matching and
proves that it works without a report, library scan, fuzzy analysis or network. Full browser checks complement the
simulated-DOM suite using a local fixture with temporary settings and canned data.
