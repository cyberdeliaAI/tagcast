# Now playing lyrics

The large Now playing view can show saved iBroadcast lyrics or temporary online
lyrics. Choose **Lyrics** in that view. This feature does not edit or save lyrics.

**Settings → Playback → Now playing lyrics** keeps the existing source preferences:

- **iBroadcast only** is the default and makes no public lyrics lookup.
- **iBroadcast first · Unison → LRCLIB fallback** uses saved lyrics when present.
- **Unison → LRCLIB first · iBroadcast fallback** prefers online lyrics, then uses
  saved iBroadcast text when no usable online result is available.

Existing stored preference values remain valid. Selecting an online mode permits
lookups while the expanded lyrics view is open. Title, track artist, album and
known duration are sent; account credentials and audio are not sent. Unison and
LRCLIB results remain in bounded memory and never enter the metadata editor,
iBroadcast or the persistent lyrics databases. Close the lyrics view, hide the
app or select iBroadcast only to stop new lookups. Already-started provider
requests may still finish; late responses cannot replace the current selection.

## LRCLIB fallback

LRCLIB is checked only after Unison returns no matching lyrics, not after a
network error, rate limit or malformed Unison response. A usable Unison result,
including ordinary line-timed or untimed text, keeps priority.

1. `/api/get` receives the full title, artist, album and duration where supported.
2. If that result is missing, mismatched or empty, bounded `/api/search` requests
   use the original title/artist and, only when different, one typography variant.
3. Matching candidates are ranked by duration difference. The full title and
   artist must match, and a known duration must differ by at most two seconds.
   Typographic quotation marks/dashes and spacing can match; Live, Remix, Edit,
   collaborators, accents and other recording identity are retained. There is
   no free-text search or guessing the primary artist from a combined credit.
4. Synced LRC drives the existing per-track line highlighting. Plain text remains
   readable without timing; a confirmed instrumental result is identified.

With no known duration, require a full album match; ambiguous search results are
left unmatched. Unsupported/empty results do not change playback. The existing
**Sources & keys → LRCLIB** switch also disables this fallback, including reuse
of previously displayed LRCLIB text. Source/account/session changes reject late
results before caching or display.

The public API uses fixed HTTPS endpoints, no redirects or credentials, sequential
requests, response/text/result limits and a short per-lookup time budget. Rate
limits honour `Retry-After`; errors stop the search rather than widen it or retry.
Network timeouts are not a hard operating-system DNS deadline. The browser has
its own cancellation deadline and never waits for provider results to play audio.

The [official LRCLIB API reference](https://lrclib.net/docs.txt) documents these
endpoints, returned fields, duration tolerance and rate limits. Tagcast's search
matching is deliberately more conservative than unrestricted nearest-duration
selection. Provider coverage and the correctness of contributed timing are not
guaranteed by a metadata match.

## Reference files and scope

The supplied `online.js` illustrates exact-get/search fallback and closest-duration
selection. These ideas are implemented independently in Tagcast's existing Python
backend; its Electron-only networking, cover searches and extra providers are not
imported. Its partial-word matching and version removal are not used.

The supplied `ttml.js` describes word timings, singer labels and background vocals.
Tagcast currently renders timed **lines**, not word-by-word karaoke. Existing TTML
parsing and playback architecture are unchanged by the LRCLIB fallback. No NetEase
or Kugou integration is introduced.
