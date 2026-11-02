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
app or select iBroadcast only to stop new lookups. Already-started network reads may finish before cancellation is noticed;
obsolete lookups stop before their next request and cannot replace or cache the
current selection. Concurrent requests for the same track share one lookup.

## LRCLIB fallback

LRCLIB is checked after Unison has no usable result, including a temporary service
failure or rate limit, when the user has allowed the fallback. A usable Unison
result, including ordinary line-timed or untimed text, keeps priority.

1. Bounded `/api/search` requests use the original title/artist and, only when
   different, a typography variant. With a known duration, one extra query may
   use the title without recognized release labels and the first credited artist.
2. Matched candidates are ranked by closest duration, then synced before plain
   text, then album identity. A malformed candidate is skipped independently.
3. `/api/get` is used only when search has no usable candidate. It receives the
   full title, artist, album and duration where supported.
4. Supported word-timed Lyricsfile data, enhanced LRC or ordinary synced LRC drives
   the per-track highlighting. Plain text remains readable without timing; a
   confirmed instrumental result is identified.

With a known duration, title identity ignores punctuation, diacritics and recognized
release labels such as `(Remastered 2011)`, `- 2013 Remaster`, `(Mono Version)` and
`(feat. Guest)`. Live, acoustic, remix, demo and instrumental qualifiers remain
part of the title. Descriptive parentheses are retained. Artist comparisons use
whole credited names, including common separator variants and a leading “The”;
partial-name substrings are never matches. LRCLIB duration must be within two
seconds. There is no wider ten-second plain-text tolerance or free-text search.

Unison receives the cleaned title and rounded duration. Its `/lyrics` reply omits
`duration`; Tagcast relies on Unison's server-side duration filter in that case.
A present invalid or mismatched duration is rejected. This is a provider contract,
not independent proof that the recording is identical.

With no known duration, full title/artist and album identity are required, and
ambiguous LRCLIB search results remain unmatched. Unsupported or empty results do
not change playback. **Sources & keys → LRCLIB** also disables this fallback,
including reuse of previously displayed LRCLIB text. Source/account/session
changes reject late results before caching or display.

The public API uses fixed HTTPS endpoints, no redirects or credentials, sequential
requests per lookup, response/text/result limits and a twelve-second budget per
provider. Cache/library locks are never held during network reads or waits. A
newer track request supersedes the older one; short provider spacing uses
cancellable waits instead of a “Please wait” error.

For HTTP 429/503, a requested `Retry-After` of at most two seconds permits one retry
of that step within the budget. Longer delays skip that provider. Backoff is
separate for Unison and LRCLIB and honours the full server delay (it is not raised
to a minute or shortened to a local cap). Other temporary errors do not retry the
same request. If no provider is usable, the view offers a retry instead of caching
an outage as “no lyrics”. A missing result may be cached for five minutes, at most
twelve entries; all online text is memory-only.

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
imported. Its partial-word matching is not used. The bounded, duration-guarded
release-label normalization described above is also reused by explicit editor searches.

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
word segments leave the complete readable line in place. TTML evaluates absolute
and parent-relative timing for the complete document against line/container and
recording boundaries; absolute is preferred if both readings fit. Namespace names
do not determine timing. Ambiguous timing cannot be independently verified from
metadata. Positive LRC `[offset:]` values shift both lines and words earlier;
negative offsets shift them later, clamped at zero.

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

## Verification and scope of this reliability fix

Synthetic tests cover the real Unison response shape, provider errors and short
retries, per-provider backoff, superseded/coalesced requests, conservative identity,
absolute and relative TTML, offsets and malformed candidate isolation. They do not
prove that every contributed text or timing matches a real recording. The API
response shape and filtering were checked against the [Unison source](https://github.com/better-lyrics/unison/blob/master/src/routes/lyrics.transformers.ts)
and its [duration filter](https://github.com/better-lyrics/unison/blob/master/src/db/lyrics.ts).

Next-track prefetch, animation-frame line following and changing the meaning of
“iBroadcast first” are deliberately outside this fix. Existing preference values,
ordinary and Gapless Playback, queue operations and native lyrics saves are unchanged.

## Explicit Find lyrics in the metadata editor

**Find lyrics on LRCLIB** now reuses the same bounded search-first, get-fallback
provider reader, duration/identity checks and parsers. This does not use Unison,
read or populate the temporary Now playing result cache, or start automatically.
The existing LRCLIB source switch is required. Only metadata is sent; no account
credentials, cookies, audio or native lyrics text is sent to LRCLIB.

The editor keeps LRCLIB’s ordinary plain text first when available, independently
of optional timing quality. Otherwise LRC, enhanced LRC and supported Lyricsfile
lines are converted into ordinary text before the result reaches the editor or its
public SQLite cache. Timing and LRC metadata markers from those timed formats
are not copied. Empty lines between verses are preserved;
the existing total 50,000-character limit includes the joined line breaks. A result
must still be checked by the user: a metadata match is not proof that contributed
lyrics describe the intended recording.

The workflow remains **Find lyrics → Use these lyrics → Review lyrics → Save lyrics
to iBroadcast**. Finding does not change the textarea draft, library or music files.
Fresh native reads may refresh the separate native cache with iBroadcast text; public results
never replace that cached native text. Saving retains the existing fresh
userdata/membership checks,
complete custom-field preservation, single-use review, one write without ambiguous
retries and read-back confirmation. Native iBroadcast lyrics still take priority.
Premium restrictions and the separate album sidecar-import workflow are unchanged.

LRCLIB spacing/backoff is shared with display lookups to respect provider limits,
but player-track changes do not cancel an explicitly requested editor lookup.
Account, session, library or source changes are checked between provider steps and
before caching. Native reads and saves retain their existing serialized workflow;
this change does not refactor that locking or the audio engine.

The editor's public cache remains separate: valid results expire after 30 days,
missing results after one day, with the existing 1,000-row/10 MiB bound. Its key now
includes the lookup version and full album identity. Old public results remain
subject to normal expiry/size cleanup but are not reused by the new lookup, so an
old miss or marker-bearing result cannot mask it. A new request still requires
**Find lyrics**. Saved native lyrics, user preferences and review semantics are
not migrated or reset. Display lookups continue to be memory-only.
