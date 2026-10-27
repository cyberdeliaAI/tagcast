# iBroadcast API coverage and limits

Audit date: 2026-10-18. Baseline source: `fb1e00251c65fd703c9a56859a303eddf1e50936`.
Updated for the implementation published in Tagcast 0.70.0.

This describes Tagcast 0.70.0, including artist ratings, multiple album artists,
track credits, thumbs-down and the genre/playlist fixes. Verification uses local mocks;
no real iBroadcast account data was changed for the audit or implementation tests.

## Scope and confidence

The inventory covers every operation in the public API reference, OAuth, the
documented component protocols, and additional operations found in the official
web client. The public reference is incomplete: metadata editing, image uploads
and several account operations are visible in the web client but absent there.
Consequently, an exhaustive list of every private server operation cannot be
guaranteed from public material.

- **Supported** means a reachable Tagcast feature uses the operation.
- **Partial** means some options or contexts are unavailable.
- **No** means Tagcast does not expose or call it. A method in a dependency alone
  does not establish Tagcast support.
- **Local** means Tagcast implements the feature itself rather than calling a
  corresponding iBroadcast operation.
- **Documented** identifies an explicit public protocol or limit.
- **Observed** identifies an official web-client request, without a published
  third-party API contract.
- **Unknown** means no numerical server limit was found in the reviewed sources;
  it does not mean unlimited.

## Public JSON API inventory

All 20 named modes in the [API reference](https://help.ibroadcast.com/en/developer/api)
are listed below, followed by the library operation and history parameter.

| Operation | Tagcast | Current behavior or missing part |
| --- | --- | --- |
| `status` | Supported | Connection, a sanitized account view, subscription and library revision checks. |
| `getbitratepref` | No | A preference can be displayed from account status; this dedicated mode is not called. |
| `setbitratepref` | No | Streaming quality is a Tagcast server setting; it does not change the account preference. |
| `revokeplaylistpublic` | No | No public-sharing management. |
| `makeplaylistpublic` | No | New Tagcast playlists are private. |
| `playqueue_token` | Supported, opt-in | One-use token stays on the local server. |
| `badfile` | No | No user-facing corruption/re-encoding report. |
| `tagtracks` | Supported | Reviewed assignments/removals for one album/set or one track; development also supports explicit complete-album selections. |
| `deletetags` | Supported | Reviewed global tag deletion; music is preserved. |
| `createtag` | Supported | Creates an empty native label. |
| `updatetag` | Partial | Rename; no archive/unarchive control. |
| `rateartist` | Supported in development | Native stars on album-artist pages; independently stored local heart. No separate rating control on a track-artist browse group. |
| `ratealbum` | Supported | Native stars, individually written/read back per disc. |
| `ratetrack` | Supported | Heart (5), thumbs-down (1) and clear (0), with current-value checks and read-back. |
| `playlistorder` | No | No persisted ordering of the playlist catalogue. See the documentation discrepancy below. |
| `deleteplaylist` | Supported | Reviewed deletion of editable user playlists; tracks remain. |
| `createplaylist` | Partial | Explicit selected tracks or an empty private playlist; development also creates new private playlists from reviewed CSV matches. No mood, seed or public creation. |
| `appendplaylist` | Supported | Reviewed append with duplicate suppression. |
| `updateplaylist` | Partial | Replace contents, rename and description through the playlist editor. Development supports a separately reviewed artwork-only update; no dedicated drag-to-reorder UI. |
| `random_tracks` | No | Tagcast's random-album action chooses a loaded album summary locally. |
| Library server (`library`) | Supported | Tracks, albums, artists, tags and selected playlist fields; caching and compact browser summaries. |
| `history` request parameter | Partial, opt-in | Reports a play after more than ten seconds of actual listening. Does not report skips or send Last.fm scrobbles. |

Code: [client.py](../src/tagcast/client.py),
[collections.py](../src/tagcast/collections.py), [tags.py](../src/tagcast/tags.py),
[library.py](../src/tagcast/library.py).

The [playlist component guide](https://help.ibroadcast.com/en/developer/components/playlists)
adds creation by mood or seed and empty-playlist creation. Tagcast supports the
last of these. Public sharing is described there; the API reference also lists
an optional playlist artwork field. Development now supports reviewed playlist
artwork updates; public sharing remains outside Tagcast.

**Documentation discrepancy:** the API reference describes `playlistorder` as
ordering playlists, while the component guide describes ordering tracks using
that same name. The official web client uses it for playlist catalogue order.
The component examples also use `playlist_id` where the API reference and
Tagcast use `playlist`. These need clarification before implementing new options;
they do not justify changing currently working payloads blindly.

## Authentication and component protocols

| Capability | Tagcast | Notes |
| --- | --- | --- |
| OAuth device-code sign-in | Supported | Default public client; handles pending approval, slowdown, denial and expiry responses. |
| OAuth authorization code and PKCE | Supported for custom client configurations | State validation, verifier/challenge and loopback callback. |
| Token refresh | Supported | Refreshes expired/rejected access tokens; stores rotated tokens server-side. Current development shares a single in-flight refresh per client across API, artwork and streams, ignores late rejections of an older token generation, and guards delayed persistence callbacks. |
| Token revocation | Supported | Disconnect attempts revocation and forgets local credentials even if revocation fails. |
| Account, app and device administration | No | Reading basic account status and listing queue sessions do not provide these administrative operations. |
| Streaming and HTTP Range | Supported | Same audio element; local streaming proxy keeps credentials out of the browser. |
| Alternative streaming qualities | Supported | Premium checked before any quality other than 128. Original can fall back once to 128. |
| Offline audio storage / library download | No dedicated feature | Playback and the browser's native media menu are not a library export/download workflow. |
| Artwork retrieval | Supported | Native thumbnails and larger artwork on explicit enlargement / Now playing. |
| WebSocket `get_state` and `set_state` | Supported, opt-in | Queue state, up-next, position, pause, volume and repeat; explicit restore/play. |
| Queue sessions and remote control | Supported, opt-in | Sanitized device list, joinable target, player/controller roles. |
| Queue `update_library` event | Partial | Records a notification; the user explicitly reloads the library. |
| Queue `end_session` event | Supported | Disconnects the session. |
| Queue shuffle state | Partial | Stored/synchronized state; no equivalent complete iBroadcast shuffle/radio feature set. |
| Crossfade | No | Tagcast publishes `crossfade: false`; no crossfade engine. |

Sources: [Authentication](https://help.ibroadcast.com/en/developer/authentication),
[JSON API](https://help.ibroadcast.com/en/developer/components/json-api),
[Library](https://help.ibroadcast.com/en/developer/components/library),
[Streaming](https://help.ibroadcast.com/en/developer/components/streaming),
[Artwork](https://help.ibroadcast.com/en/developer/components/artwork),
[Play Queue](https://help.ibroadcast.com/en/developer/components/play-queue).
Code: [auth.py](../src/tagcast/auth.py), [queue_sync.py](../src/tagcast/queue_sync.py),
[queue-sync.js](../src/tagcast/static/queue-sync.js),
[player.js](../src/tagcast/static/player.js), [playback.js](../src/tagcast/static/playback.js).

The shared request builder supplies the required client/version/device/user-agent
fields, matching User-Agent header, JSON content type and bearer authorization.
The audit also checked the installed `ibroadcast` 2.0.1 request/PKCE helpers used
by Tagcast, rather than assuming all dependency features are reachable in the app.

### OAuth permissions

The public authentication page lists these permissions. A permission is an
authorization category, not documentation for every possible endpoint within it.

| Scope | Tagcast requests it? |
| --- | --- |
| `user.account:read` | Yes |
| `user.account:write` | No |
| `user.apps:read` / `user.apps:write` | No / No |
| `user.devices:read` / `user.devices:write` | No / No |
| `user.library:read` / `user.library:write` | Yes / Yes |
| `user.queue:read` / `user.queue:write` | Only when queue sync is enabled |
| `user.upload` | No |

## Metadata and image operations outside the public reference

The requests below were observed in the official
[library editor](https://media.ibroadcast.com/js/iBroadcastLibraryEditor.js).
Tagcast's supported variants are implemented and checked against fresh library
data, but these are not complete publicly specified API contracts.

| Capability / operation | Tagcast | Scope |
| --- | --- | --- |
| `update_album`: title, primary artist, year, disc | Supported | Review within one album or one album artist; one native update per applicable disc. |
| `update_track`: title, primary artist, year, track number | Supported | Explicit track changes take precedence over album-wide changes. |
| Main/additional genres (`genre`, `genres_additional`) | Supported | Stored on tracks. Album-wide selection applies them to its tracks. |
| Composer credits (`artists_additional`) | Supported | Normal composer editor preserves non-composer credits. |
| Additional performers / credit roles | Supported in development | Individual track editor for all nine native roles; retains IDs, order, phrases and existing unknown roles. Reviewed semicolon cleanup remains separate. |
| Multiple album artists (`artists_additional` on albums) | Supported in development | Separate additional artists/bands, reviewed writes and read-back; compact artist browsing, hearts, stars, images and links include them. |
| `create_artist` | Supported | Creates a missing name needed by a reviewed save/cleanup; no general artist administration page. |
| ReplayGain metadata / playback normalization | No | No supported editor field or normalization implementation. |
| Move an individual track to another album | No | Ordinary metadata editing still excludes reassignment. The separate reviewed complete-album merge below is a narrow exception. |
| Album merging | Supported in development | Reviewed complete single-disc fragments only: 2–20 albums / 500 tracks, explicit destination, unchanged numbering, single-use approval, fresh membership checks, non-retryable `update_track` membership write and read-back. Different discs / displayed multi-disc sets are blocked. Payload observed in the official web editor on 2026-10-27. |
| `create_album`, album splitting | No | No general album creation, split or arbitrary track-move UI. Existing multi-disc shelf grouping remains display-only. |
| `get_artwork` | Supported | Existing iBroadcast image choices for the selected album/artist. |
| `artwork-upload.ibroadcast.com` | Supported | Upload file or server-fetched image, then apply separately after comparison. |
| `set_artwork` | Partial | Full selected album/disc cover and per-track restoration for Undo; no independent track-cover editor. |
| `set_artist_artwork` | Supported | Selected native artist image. |
| Playlist `artwork_id` | Supported in development | Shared file/URL comparison, artwork-only `updateplaylist`, full snapshot checks and read-back. |
| `createplaylistfolder` / native `type=folder` | Supported in development | Separate reviewed folder creation, rename, add/remove references and empty/unreferenced deletion. Observed official-client protocol; never interpret folder IDs as music tracks. |
| `gettrackuserdata`, custom metadata and lyrics | No | No lyrics/custom-metadata reader or editor. |
| `trash` | Supported | Reviewed track, complete-album selection and duplicate-cleanup workflows; never permanent deletion. |
| `trash_albums` | No direct call | Equivalent reviewed complete-album removal uses validated track IDs through `trash`. |

Sources: [Editing your library](https://help.ibroadcast.com/editing-library),
the [official library editor](https://media.ibroadcast.com/js/iBroadcastLibraryEditor.js)
and [official UI](https://media.ibroadcast.com/js/iBroadcastUI.js).
Code: [library.py](../src/tagcast/library.py), [client.py](../src/tagcast/client.py),
[cleanup.py](../src/tagcast/cleanup.py), [artwork.py](../src/tagcast/artwork.py).

### Other observed official-client requests that Tagcast does not implement

These names establish that an official client uses them, not that third-party
OAuth clients are authorized or supported to call them. Their complete schemas
and permissions would need confirmation before implementation.

| Area | Observed names / capability | Tagcast |
| --- | --- | --- |
| Restore or empty Trash | `restore`, `empty_trash` | No |
| Hide/archive tracks by tags | `archivetracks` | No; archived tags can be read and removed from a selection, but not added/archived here. |
| Track Dashboard | `dashboard_files`, `dashboard_meta`, `dashboard_suggestions`, `dashboard_missing_meta_count`, `dashboard_upload_issue_count`, `dashboard_upload_status` | No |
| Dashboard restoration/deletion | `restore_file`, `dashboard_delete` | No |
| Audio uploads | Upload server and processing flow | No; Tagcast edits the existing cloud library. |
| Playlist-file import | `upload_playlist` | No |
| Download/export | `downloadlibrary`, download server | No library audio export. Current development adds read-only JSON / CSV ZIP metadata snapshots from the loaded library; no download server API is used. |
| Single-track sharing | `sharetrack` | No |
| Similar tracks | `createtracklist` | No |
| Discovery | `home` | No; Tagcast's own discovery screens are local. |
| Account preferences/profile | `set_preference`, `update_profile` | No; theme, source and playback settings are local Tagcast choices. |
| Account details / verification | `changeemailaddress`, `changepassword`, `setusername`, `resendverificationemail`, `verify`, `reset` | No |
| Device administration | `nickname_device`, `revoke_token` | No; own OAuth disconnect is separate. |
| Authorized apps / developer apps | `getapps`, `myapps`, `enableapp`, `revokeapp`, `deleteapp`, `regenerateclientsecret`, `requestreview` | No |
| Last.fm account linking | `lastfmauth`, `unlinklastfm` | No; metadata lookups through Last.fm are a separate feature. |
| Streaming usage | `streaming_usage` | No dedicated usage display. |
| Support and notifications | `send_message`, `flag_read`, `blackbox` | No |
| Legacy logout | `logout` | No; current Tagcast uses OAuth revocation. |

Observed sources: [UI](https://media.ibroadcast.com/js/iBroadcastUI.js),
[Playlists](https://media.ibroadcast.com/js/iBroadcastPlaylists.js),
[Upload](https://media.ibroadcast.com/js/iBroadcastUpload.js),
[Account](https://media.ibroadcast.com/js/iBroadcastAccount.js),
[Suggestion engine](https://media.ibroadcast.com/js/iBroadcastSuggestionEngine.js),
[core client](https://media.ibroadcast.com/js/iBroadcast.js).
This is an inventory of the inspected public client files, not a claim to list
every private endpoint or dynamic mode name.

## Limits: service rules versus Tagcast safeguards

| Subject | Published iBroadcast rule | Current Tagcast check | Assessment |
| --- | --- | --- | --- |
| Artwork download sizes | 150, 300 or 1000 pixels square | Uses these native sizes; large view changes known 150/300 URLs to 1000, with fallback | Covered. A delivery size is not an upload maximum. |
| Artwork upload dimensions | No maximum/minimum pixels or required aspect ratio found | No dimension, decoded-pixel, aspect-ratio check or resize | Unknown service contract; Tagcast does not enforce a hypothetical 1024×1024 rule. |
| Artwork upload file size | No numerical upload byte limit found in the reviewed artwork docs | 15 MiB, both browser and server; 24 MiB local JSON-body ceiling accommodates base64 | Enforced Tagcast limit, not a confirmed iBroadcast maximum. UI calls it MB. |
| Artwork input format | Artwork delivery is documented as JPEG; upload formats not specified there | JPEG, PNG, WebP, GIF signatures; validates bytes/base64 and remote URL access | Input is not fully decoded to prove image integrity. Delivery JPEG does not imply uploads must be JPEG. |
| Genre count | No numeric maximum found; genres belong to tracks | Normal editor: at most 20 total labels, including the main genre | Server enforced; not evidence of an official 20-genre maximum. No confirmed 10-genre maximum found. |
| Genre-label length | Unknown | Editor, normal/legacy server writes and cleanup: 200 Unicode code points | Unified local safeguard; invalid input is retained with a visible error, never silently truncated. |
| Composer and full-credit bounds | No numeric maximum found | Album-wide composer shortcut: 20 names of 1000 characters; full-credit editor: 100 additional entries, names/phrases up to 1000 | Tagcast safeguards; native IDs, roles, order and phrases are preserved when unchanged. |
| Album/artist rating | Integer 0–5; 0 clears it | Both backend and UI restrict new ratings to 0–5; one displayed group, up to 20 native IDs | Covered for supported contexts. The 20-ID bound is Tagcast's. |
| Track rating | Documented choices 0, 1, 5 | Writes 0, 1 or 5; compares previous value and reads back | Covered. Existing other nonzero ratings require frontend confirmation before replacement. |
| Names and titles | No field-length maximum found | Most normal metadata text: at most 1000 characters; required names/titles cannot be blank | Local safeguards; no proof that all server fields accept that length. |
| Release year | No numeric edit interval found | New values 1800–2050, or 0 to clear; existing invalid fields can be left untouched | Local product rule. |
| Track/disc number | No numeric maximum found | Integer 0–9999 | Local product rule. |
| Playlist quantity/size | Help center says no limit on playlist count or tracks | Stored reads can exceed 10,000; 100 details per page and compact full-definition snapshots. Submitted lists/full replacement remain bounded to 10,000 | Large lists open normally; playback explicitly queues the current page. Reviewed append/delete remain available; full-content editing is disabled above the write bound. |
| Playlist name/description | No numeric character maximum found | 200 / 2000 characters, browser and server | Local safeguards. |
| Metadata save size | No public numerical batch limit found | 2000 changed records; generated update requests contain at most 500 rows | Local safeguards; ordinary save remains within one album/album artist. |
| Tag name/assignments | No published numerical maxima found | Name 1–200 characters; assignment selection at most 500 tracks and 20 tag operations; development multi-album selection at most 20 displayed albums / 100 native discs | The 20-operation bound is per review, not a total of 20 tags per track. |
| Trash | No public numerical batch maximum found | Normal track/album selection: up to 500 tracks; complete-album selection: up to 20 displayed sets | Local safeguards; read-back and explicit review retained. |
| Cleanup / duplicate cleanup | No public numerical batch maximum found | Up to 200 tracks / 20 displayed albums per batch | Local safeguards. |
| Artwork assignment track lists | No public numerical maximum found | Sends all active tracks of one selected disc in `set_artwork`; no separate 500-track cap/chunk there | Metadata/trash batch caps cannot be assumed to cover every image write. |
| Streaming | Documented qualities 96, 128, 192, 256, 320, original; free is 128 | Validated quality enumeration; all non-128 choices require Premium | Covered. Browser support still determines which original codecs play. |
| Recording a play | More than ten seconds | Validates `10 < listened <= 86400`, tracks actual listening and deduplicates events | Covered; the 24-hour bounds are local, and skips are not sent. |
| Queue volume | 0.0–1.0 | Finite numeric value in that interval | Covered. |
| Queue size/timing | No published track-list length or seek maximum found | 10,000 IDs per validated list; position at most 86,400 seconds; incoming frame at most 2,000,000 characters | Local bounds, potentially relevant to very long audio or enormous queues. |
| Queue reconnect | Wait five seconds; idle sockets can close after ten minutes | Five-second reconnect, fresh one-use token, 30-second ping | Covered. |
| OAuth PKCE/state | Verifier length 43–128; state at most 128 characters | Uses dependency PKCE generation and random state; verifies callback state | Covered by the current flow; no generic user-supplied verifier. |
| Device-code polling | Use server interval; handle pending and slowdown | Uses returned interval, adds five seconds on slowdown; handles expiry/denial | Covered for normal responses. |
| General API request rate | No published universal requests/second or request-size quota found | Retries eligible transient failures after 2 and 6 seconds; unsafe mutations/history excluded | Not a documented-rate-limit policy. Generic JSON retries do not honor `Retry-After`. |
| Audio upload | Help center states 1.5 GB per file | No music-upload feature or `user.upload` permission | Not applicable to current Tagcast; this is not an artwork limit. |
| Overall cloud library size | Help center states no total-size limit | No arbitrary album/track total cap; full library is held server-side, compact summaries/lazy detail in browser | Hardware/memory and specific feature bounds remain relevant. |

Service sources: [Artwork](https://help.ibroadcast.com/en/developer/components/artwork),
[API reference](https://help.ibroadcast.com/en/developer/api),
[Editing](https://help.ibroadcast.com/editing-library),
[Organizing: playlist limits](https://help.ibroadcast.com/organizing-library#playlist-limits),
[Streaming](https://help.ibroadcast.com/en/developer/components/streaming),
[Playing music](https://help.ibroadcast.com/playing-music),
[Quick start](https://help.ibroadcast.com/en/developer/quick-start),
[Play Queue](https://help.ibroadcast.com/en/developer/components/play-queue),
[Authentication](https://help.ibroadcast.com/en/developer/authentication),
[Uploading: file size](https://help.ibroadcast.com/uploading-music#file-size-limit),
[Account: library limits](https://help.ibroadcast.com/account#library-size-limits).

Local checks are defined in [library.py](../src/tagcast/library.py),
[artwork.py](../src/tagcast/artwork.py), [app.py](../src/tagcast/app.py),
[collections.py](../src/tagcast/collections.py), [tags.py](../src/tagcast/tags.py),
[cleanup.py](../src/tagcast/cleanup.py),
[duplicate_cleanup.py](../src/tagcast/duplicate_cleanup.py),
[queue_sync.py](../src/tagcast/queue_sync.py),
[genres.js](../src/tagcast/static/genres.js) and
[artwork.js](../src/tagcast/static/artwork.js).

## Tagcast features that are not separate iBroadcast APIs

| Feature | Where it is implemented |
| --- | --- |
| Album and album-artist hearts | Account-scoped local JSON files, independent of native stars. |
| Artist biographies | Opt-in TheAudioDB request and a local SQLite cache. |
| 1001 Albums matching and background notes | Local catalogue/report and bundled attributed text. |
| Search, rating/date sorting, years, decades and duplicate analysis | Derived from the downloaded library; no separate server search/sort API required. |
| Random album selection | Local choice from loaded compact summaries; only the chosen album's details are loaded. |
| Change history export | Browser-local JSON; not an export of audio files or the complete library. |
| Full library metadata export (development) | Explicit read-only JSON / linked CSV ZIP snapshots from the loaded server library, with separate ordered artist credits, roles and phrases. See [format and completeness](metadata-export.md). |

This distinction matters: local support for a similar feature does not establish
support for the native API operation or cross-device account synchronization.

## Findings and recommended next work

1. **Get the missing service contract confirmed.** Ask iBroadcast for artwork
   upload bytes/dimensions/formats, metadata field lengths, total additional
   genre/credit counts, request/batch limits and rate-limit guidance. Without it,
   local validation is not proof of compliance with hidden server limits.
2. **Genre validation fixed in development.** All relevant paths use 200 characters
   and 20 labels; the editor retains invalid input and shows the error. These remain
   local safeguards, not evidence of the service limits.
3. **Playlist reads fixed in development.** Existing oversized lists page normally.
   Compact account/session/playlist snapshots protect append/delete while submitted
   lists and full replacement stay bounded; oversized playback is per page.
4. **Improve image feedback after the upload contract is known.** Decode/inspect
   dimensions and show resolution and size before upload. Only resize/reject to a
   service maximum once that maximum has been confirmed. Keep explicit comparison.
5. **Document the remaining intentional omissions.** Play skips, playlist sharing/mood/seed and ReplayGain remain distinct
   missing options. Track thumbs-down, multiple album artists and general additional
   credit editing have been added in development. Native restore/empty-trash and account changes have
   a different impact from ordinary editor features and need their own designs.
6. **Treat additional endpoints as candidates, not automatic additions.** Public
   web-client code does not establish a stable supported API for third-party apps.
   Resolve the playlist documentation contradictions and metadata payload contract
   before changing working requests.

The existing validation tests cover invalid genre lists, numeric/year bounds,
image byte limits and formats, ratings, tag validation and safe collection
operations. They use fixtures/local mocks, not real-account writes or tests of
hidden production limits. No tests establish an official pixel or genre ceiling.
The baseline Python suite was run during the audit: **299 tests and 1,351 subtests
passed**. New regressions cover the implemented additions, stale native IDs and
roles, combined-set restrictions, Unicode genre lengths and oversized playlists. A noncanonical subset ordering also exposed a test-isolation dependency
on `test_client.py` reloading the client module; no implementation changes were
made as part of this inventory.

## Rechecking this inventory

- Compare current public docs and the official web-client requests with the
  `_jsonrequest` call sites and generated `write_requests()` payloads.
- Check both the UI and server validator; an HTML attribute alone is insufficient.
- Distinguish display grouping from native writes, and local preferences/hearts
  from account settings/ratings.
- Record explicit documented limits separately from conservative local caps.
- Update this audit when changing API coverage or receiving written
  clarification from iBroadcast.
