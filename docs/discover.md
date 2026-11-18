# Artist discovery

On an **Album artists** page, choose an artist, then open **Similar in your library**.
It is a disclosure alongside **About this artist**, with the active source next to
the title: **Last.fm**, or **Your library** for local results. **Refresh suggestions**
is inside the open section. New artist pages start closed; returning to a previously
opened artist can restore completed results without another request.
Tagcast tries **Last.fm** first. Up to six albums from other artists in the loaded
iBroadcast library appear above the album toolbar. Cards
reuse Open album/artist, Play and Queue. Viewing results changes neither playback,
selection nor Change history. The feature is unavailable in the demo or during a
library load. There is no per-artist source selector. Under **Settings → Discovery →
Similar music**, turn off **Use Last.fm for similar artists** to use only local genres,
then save. The preference defaults to on and persists in local `config.json` across
restarts. Saving or opening a page never starts discovery; only explicitly opening
this section or choosing Refresh does. Restoring its open state on Back does not start a request, and no global open preference is saved.

Opening a suggested album labels its breadcrumb **Discover from [artist]**, so a
recommendation is not presented as part of the seed artist's discography. This link
returns to that artist's page and the existing suggestions, preserving browsing
state and scroll. Back/Forward and interface-language changes retain the context;
replacing the loaded library invalidates it like other album origins.

## Last.fm

Enable Last.fm and add its API key under **Settings → Sources & keys**. Existing
saved/environment keys are reused server-side. No Last.fm user login, personal
listening history or scrobbling is required. Only explicitly opening
**Similar in your library** or choosing **Refresh suggestions** sends the selected artist name to `artist.getSimilar` at the fixed HTTPS Last.fm
API. No library records, iBroadcast credentials or audio are sent. Artist names
longer than 200 characters are rejected rather than silently truncated.
The privacy explanation is available in Settings → Discovery and Help, without
repeating it below the artist-page disclosure.

Last.fm supplies up to 100 related artists. Tagcast matches their names locally,
ignoring case, NFC spelling and surrounding/repeated whitespace while preserving
accents, punctuation and full names. Ambiguous normalized native names are skipped;
there is no fuzzy match, automatic spelling correction or invented MBID. A name
match cannot resolve every homonymous artist. MusicBrainz and ListenBrainz lookups
are not part of this implementation.

Provider similarity determines the artist order. Native album ratings, artist
ratings and stable title/ID order choose one album per represented artist. The
label links to the related artist's Last.fm catalogue page; no percentage or
album-to-album similarity is claimed. Additional album-artist credits and the
existing conservative disc-set grouping are respected. This does not establish
audio identity or edition completeness.

If a healthy Last.fm response provides no usable local matches, Tagcast shows the
existing local genre suggestions with an explicit fallback notice. Results are
never padded with unrelated genre matches. Missing keys, disabled sources,
ambiguous seed identity, malformed data, network failures and rate limiting remain
separate errors; they are not reported as an empty successful search.

Requests use the existing provider pacing plus at most one new Discover request
per second. There is no automatic retry or hidden pagination. Redirects, cookies,
account authentication, environment netrc credentials and provider image downloads
are not used. Response bodies are limited to 512 KiB with connection/read timeouts
and a body budget. A running OS DNS lookup cannot be interrupted immediately.
429/503 responses honor Retry-After; Last.fm error 29 causes a one-minute backoff.

The public artist cache is RAM-only, at most 64 entries / 2 MiB of response data.
Cache-Control, Age and Expires determine retention, capped at six hours; without
origin directives the default is one hour. No-store/no-cache/private data is not
retained for reuse. The browser reuses online results only within the returned
lifetime; expiry never starts a request. An active result remains readable, but
closing or leaving removes expired results. Refresh recomputes local availability
and can reuse a still-fresh provider response. Keys, accounts and sessions have
separate cache identities. Settings changes retire browser results; preference/source/key
changes and account/session/library replacement reject in-flight responses before
publication. Neither Studio.lock nor a library lock is held during network I/O.

Last.fm supplies its data under its own [API terms](https://www.last.fm/api/tos),
including attribution, non-commercial-use, rate-limit and caching conditions.
The view retains Powered by AudioScrobbler attribution, catalogue links and the
API terms link. Using a personal API key does not waive those conditions.

## Local genres

With Last.fm disabled for discovery, or after a healthy Last.fm search without
usable local matches, the selected artist's loaded albums supply the genre set.
Other albums are ranked by weighted genre overlap, with less common genres contributing more. Genre labels
compare without case or surrounding whitespace; punctuation and distinct labels
remain distinct. Native album ratings, then artist ratings, break equal genre
scores. Favourites and listening history are not inputs. Missing genres or shared
genres produce honest empty states. No provider request is made in this mode.

## Shared limits and validation

One result per represented artist is returned, with at most six results. Native
artist ID zero identifies compilations, not the name Various Artists. An index
belongs to the captured Library snapshot, coalesces builds outside Studio.lock
and uses an inverse genre/artist index rather than all-pairs comparisons. The
browser retains at most twelve artist/source results. Replaced snapshots are
rejected even when their revision number is unchanged. Rating read-backs invalidate
results. No discovery report is saved to disk and no metadata is written.

Playback controls require active tracks and usable streaming metadata in every
selected disc. Open album remains available when those details are missing. Normal
player permission and membership guards still run on explicit playback actions;
service availability is not guaranteed. Artwork uses the existing iBroadcast route.

Backend tests cover local ranking, strict identities, provider order, healthy-empty
fallback, disabled/missing/refused keys, source/account/library changes, bounded
streamed bodies/cache, origin cache controls, redirects, rate limits and unchanged
account data. Frontend tests cover the default source, saved local-only preference,
attribution, safe links, fallback/error states, cache expiry, translation, late replies
and existing actions.
All six interface languages include the new controls and messages. Public provider
validation used example artist names, without uploading a library or listening data.
