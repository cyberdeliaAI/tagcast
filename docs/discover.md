# Local artist discovery

This is the first Discover implementation. It suggests music already in the loaded
iBroadcast library; external recommendations remain outside this version's scope.

Open an **Album artists** page, choose an artist, then choose **Discover similar
music**. Up to six albums by other artists appear above the album toolbar. Each
card explains its shared genres and offers the existing album/artist navigation,
Play and Queue controls. Viewing suggestions does not change playback, selection
or Change history. The action is unavailable in the demo or while a library loads.

**Refresh suggestions** explicitly calculates the results again. Closing and
reopening the section, returning with Back, or changing the interface language
reuses completed results. Missing genres and a lack of shared genres produce
separate empty states rather than invented recommendations.

## Selection and limits

The artist's loaded albums supply the genre set. The server ranks other albums
by weighted genre overlap: less common genres contribute more than broad ones.
Genre labels compare without case or surrounding whitespace, but punctuation
and distinct labels remain distinct. Native album ratings, then artist ratings,
break equal genre scores; names and native IDs provide a stable final order.
Favourites and listening history are not inputs.

Only one album per represented artist is returned. Additional native album-artist
credits count for both seed exclusion and this spread. Native artist ID zero
identifies compilations; a genuine artist called Various Artists is still eligible.
Albums use the existing conservative disc-set grouping, including separate copies
with repeated disc numbers. No edition normalization or external identity matching
is performed. Shared metadata does not establish audio identity or completeness.

Playback controls require active tracks and usable streaming metadata in every
selected disc. If that information is missing, the card retains Open album without
Play or Queue. The existing player still checks the current library and permissions
when a playback action is chosen; network and service availability are not guaranteed.

## Data flow

`POST /api/discover` is a read-only calculation behind the existing local HTTP
guards. It requires the current playback session, exact displayed artist name and
complete positive native artist-ID group. It uses the loaded Library object without
refreshing it, contacting recommendation providers, changing metadata or reading audio.
Rendering covers uses the normal iBroadcast artwork route. Explicit navigation,
playback and queue choices retain their normal lazy detail and audio requests.

One in-memory index belongs to each Library snapshot. Concurrent first requests
share the index build, outside `Studio.lock`. The inverse genre index avoids an
all-pairs artist comparison. The response contains at most six native album IDs,
three reason labels per album and playback eligibility; the browser resolves card
metadata from its existing summaries. The browser keeps at most twelve completed
artist results. Replacing the account, session or library invalidates old work,
including a replacement with the same revision number. Rating read-backs invalidate
visible results. Nothing is persisted as a discovery report or sent as listening data.

## Validation

`tests/test_discover.py` covers scoring, rating ties, genre punctuation, bounds,
native artist identities and credits, disc grouping, missing streaming metadata,
concurrent requests and replacement during calculation. It also asserts unchanged
library data and no account/provider requests or files. `tests/test_app.py` includes
the route in the HTTP security checks. Frontend regressions cover explicit-only
requests, stale replies, cache bounds, empty/error states, escaping, translations,
existing Play/Queue actions and unchanged playback/history while viewing results.

A local synthetic benchmark with 50,007 native albums took approximately 1.0 seconds
to build the index and 0.1 seconds for a warm recommendation query on the development
machine. This measures invented metadata, not a real account or a hardware guarantee.
Browser checks used a temporary profile and invented library: desktop dark/light,
390-pixel mobile cards, keyboard disclosure, album navigation and return with Back.
Audio output and provider availability are not validated by this fixture.
