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
4. Supported word-timed Lyricsfile data, enhanced LRC or ordinary synced LRC drives
   the per-track highlighting. Plain text remains
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
Tagcast reads word/segment timing from Unison TTML and enhanced LRC. LRCLIB's
`lyricsfile` field supports the [Lyricsfile 1.0 draft](https://github.com/tranxuanthang/lyricsfile/blob/main/SPECIFICATION.md),
including `lines[].words`; `hasWordSync` is only a hint, never a substitute for
validating the actual words. No NetEase, Kugou or additional provider is introduced.

## Word-timed display

The active line stays bold with a moving underline beneath its timed words or
syllables. All text retains the theme's normal contrast. Overlapping lines can be
active together; no separate singer columns or translated/background-vocal layout
is inferred. Without word timing, the same view follows lines or displays plain
text. Timing quality and word coverage depend on the contributed source.

Both providers use one internal display format: `{start, end, text}` in seconds,
with optional `words: [{start, end, text}]` on a line. Word text must reconstruct
the complete line, timings must be ordered and fit its boundaries, and explicit
overlaps are preserved. Missing ends may be inferred for display only. Invalid
word segments leave the complete readable line in place.

Lyricsfile uses PyYAML's safe loader with document, nesting, node and text limits.
Aliases, anchors, duplicate keys and non-basic YAML tags are rejected. The version
must be exactly `"1.0"`; nonzero `offset_ms` is unsupported because the draft does
not yet define its meaning. Embedded title/artist and optional duration must agree
with the already matched LRCLIB record. Unsupported documents fall back to legacy
LRC/plain text, without further requests. Limits: 2,000 lines, 50,000 text characters,
12,000 word segments overall and 1,000 per line, within the existing response limit.

The display reads the authoritative player's track-relative clock, including
Gapless Playback. Seeking, pause/resume and speed changes use that same clock.
Animation frames run only while the word-timed lyrics view is visible and playing;
close, hide, pause and reset cancel them. Reduced motion uses stepped underlines
with ordinary player updates. There is no second audio element, new audio graph
or provider polling. Audio, queue, native lyrics caches, editor and reviewed plain
text saves are unchanged.
