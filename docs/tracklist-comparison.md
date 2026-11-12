# Read-only album track-list comparison

Tagcast 1.8.0 offers **Compare track list…** in the album's More menu.

## User flow

Opening shows the already loaded complete displayed album/disc set and prefilled
artist/title fields. It makes no comparison/provider request. **Search MusicBrainz**
is explicit and editable, so a mixed album can be inspected against more than one
reference. No edition is selected automatically. Choose a specific release using
its title/artist, date, country, formats, disc/track totals, label/catalogue number,
status and disambiguation. A direct HTTPS link retains source attribution.

Search reads 20 editions per page, up to 200 per query. Refine the artist/title for
more results. Paging retains the submitted query even if the input fields were
edited without submitting. Only choosing an edition reads its track list. The
loaded reference can be replaced by another explicit choice/search; it is not a
library-wide scan or a retained account cache.

The columns compare displayed positions in the complete local set and chosen
release, retaining disc/track numbering, vinyl labels, duplicate positions/titles
and version text. They never infer an audio match. Differences show titles,
disc/track labels and known duration differences over two seconds. Unknown values
are identified separately. A title also appearing elsewhere is only a navigation
observation, not a proposed mapping. Extra displayed positions mean there is no
corresponding row, not proof of a missing/wrong song. The differences-only checkbox
also retains unknown fields. No title, order, membership, playlist or audio changes
are sent by comparison. There is no Apply/Save button or automatic matching/splitting.
Optional explicit field choices can fill a separate editor draft, as described below.

MusicBrainz can have incomplete metadata. Empty media, missing media/track positions, mismatched
track counts and additional pregap/data sections are flagged as an incomplete audio
track list; the linked release remains authoritative for inspection. Those additional
sections are not silently treated as ordinary audio positions. Native and reference
lists are limited to 1,000 audio tracks; oversized lists are rejected rather than
silently compared in part. Unavailable lengths are not borrowed from recording
lengths or interpreted as zero-length audio.

## Ownership, transport and UI

Two GET-only local endpoints, `/api/tracklist/search` and `/api/tracklist/release`,
retain the server's Host/Fetch Metadata/shutdown admission protections. They require
an active client, loaded library, available album and current playback session.
They never call `_current()`, download/refresh the iBroadcast library, read audio,
prepare a review or mutate anything. Capture/recheck client, account, session,
library identity and the album snapshot around public I/O. MusicBrainz's source
switch is checked before and after the request. The Studio lock is not held during
network/pacing waits. Uncertain-write/read-back and fresh-write checks are untouched.

Only the entered public artist/title search and public release ID go to fixed
MusicBrainz HTTPS endpoints, without iBroadcast credentials, native IDs or session
data. Release IDs are validated UUIDs; remote fields/links are bounded and
whitelisted. Reuse the existing User-Agent, shared host pacing and bounded public
HTTP cache. Errors are visible/retryable by a new explicit read, never polled or
retried automatically. Closing/navigation/replacement/source changes discard local
comparison data and invalidate late replies. A provider read already in progress
can finish within its existing timeout; closing does not create another request.

The modal preserves input drafts on language/appearance changes, ordinary playback,
the same audio element, history and scrolling. All six languages include its labels,
status and errors. Escape/Close return focus and scroll only to the same still-current
album. Navigation/account/library invalidation never restores an old scroll position.
Local Help explains search privacy, edition selection and positional observations.

## Contract references

- [MusicBrainz Release](https://musicbrainz.org/doc/Release): editions and ordered
  media track lists are distinct from a release group; lists may be incomplete.
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API): explicit release
  search with limit/offset, then release lookup with `recordings artist-credits labels`.

No iBroadcast write or playlist append contract is changed or tested against a real
account. Public service availability and data quality remain external limitations.

## Validation (2026-11-12)

- Full local Python 3.13 after the runtime correction: 998 tests / 2,660 subtests passed. Focused provider /
  ownership cases also pass after stricter structural/count validation. They cover
  literal queries, selected UUIDs, disc/track order, repeats, unknown lengths,
  incomplete/oversized references, no iBroadcast reads/writes, source gating,
  account/session/library/in-place album replacement and no lock during public I/O.
- Frontend/media/Electron: 889 tests passed. Tests include explicit requests only,
  positional/version/duration semantics, escaped metadata, query paging, close/focus,
  active playback time/state preservation, stale answers and visible no-retry errors.
- Chromium/WebKit: 16 width/appearance combinations passed using actual pointer and
  keyboard input at 420/760/768/1280 px in Light/Dark, with the existing CSP.
- The real packaged macOS ARM64 app passed all eight native comparison width/theme
  combinations in a separate isolated process, plus ordinary startup, same-profile
  restart, CLI/security checks and all 15 shutdown/recovery cases. The new native
  check does not extend the existing full-application smoke deadline.
- An initial native fixture returned a non-cloneable function; the fixture now
  returns no value. One subsequent local Mini Player native-focus check failed;
  its production/test code was unchanged, and the exact same package passed on
  recheck without simultaneous browser automation. Keep this as a native-focus
  validation limitation, not a silently suppressed product failure.
- Playwright automatic scrolling can dismiss the More menu after its click on
  unmodified main too (420px reproduction retained). The browser harness now waits
  for completed scroll frames before the pointer click, like the native harness;
  no menu dismissal assertion, timeout or production scroll behavior was weakened.
- A public MusicBrainz request initially returned busy/503. One later explicit
  validation succeeded: 152 search results, 20 editions on the page, then the
  selected public release `a538a1f0-7d61-46a0-b2c7-c0249773cf4c` with one disc / five
  audio tracks. This used no iBroadcast account or writes. Automatic retries are
  not added to Tagcast. Availability and community metadata remain external limits.

Local logs/reports are retained under the root checkout's ignored
`build/tracklist-comparison-20261112/` and the development worktree's `build/reports/`.
Ruff, generated translations/CSS, version consistency and diff checks pass. Native
CI on all supported targets remains an independent gate. No assertion was relaxed.

## Runtime correction and integration regression

The first test app failed before provider I/O: `Studio.disabled_sources` is a
method, but the comparison checked membership on the method object at both
ownership gates. This produced a TypeError and the HTTP handler's generic 500.
The initial test double incorrectly exposed a list, hiding that wiring defect.
Both gates now call the method. Ownership tests use a real Studio with private
temporary settings, replacing only the public transport. Three additional HTTP
integration tests exercise actual search/release routes, source/session guards,
and a lost public service without automatic retries or any iBroadcast calls.
The corrected tests reproduce the TypeError against the previous implementation
and pass with the fix. An empty zero-track medium is also marked incomplete.

The packaged smoke now signs into the loopback synthetic iBroadcast fixture and
calls both real comparison routes through the frozen Studio/Lookup, asserting
structured input errors rather than generic 500 responses. Only the subsequent
eight viewport/theme UI cases substitute public replies. The combined test must
leave the synthetic account's writes empty. Startup, restart and shutdown checks
retain their original assertions and deadlines.

[Vespertine's MusicBrainz client](https://github.com/szeremeta1/Vespertine/blob/main/Packages/VespertineKit/Sources/VespertineLibrary/OnlineServices.swift)
uses the same public release search by quoted artist and album, then an explicit
release lookup for ordered media/tracks. Its UI may select a result automatically
at a score of 95 and offers metadata application; Tagcast deliberately retains
manual edition choice and comparison only. Vespertine also retries transient
provider failures; this correction does not introduce retries or change Tagcast's
transport policy. The reported generic error was a local integration defect,
independent of MusicBrainz query matching or availability.

## Explicit title and artist correction drafts

A separate follow-up to the read-only comparison adds **Use title** and **Use artist
credits** for each displayed local/reference pair. Clicking confirms the user's own
pairing; no pair or field is preselected. **Choose another reference track…** changes
one local row's reference with one bounded selector (at most 1,000 options, never a
selector per row). Changing a staged pairing asks before clearing its choices.
Duplicate positions/titles remain independent native track IDs. The same reference
can be explicitly used more than once without deduplicating local tracks.

**Open corrections in editor…** transfers only chosen changed titles and artist
fields. It rechecks the complete loaded album/set snapshot and session before and
after opening the existing editor. It never imports numbers, years, durations,
membership or album fields. No public source suggestions start on this handoff;
initial lyrics reads are deferred until explicit track selection, which retains
the ordinary editor's lazy native-lyrics behavior.
Normal review, fresh save checks, partial/uncertain outcomes and read-back are
unchanged. Choices, mapping and drafts are memory-only; closing/replacing a chosen
reference asks before discarding, while invalid ownership clears stale work.

MusicBrainz artist credits are returned as bounded separate names/join phrases,
without treating public MusicBrainz IDs as native iBroadcast IDs. The first name
fills the primary track artist; additional names add neutral artist-role credits
with the supplied phrase. All existing credits, native IDs, roles and phrases are
kept, including unknown roles. Existing artist credits are not duplicated and
case-only primary names reuse the native name. This operation does not globally
rename artists or flatten a `feat.` display string into one new artist. Invalid or
missing structured credits disable artist adoption; the display string stays
available for comparison. Only explicit track/recording credits enable adoption;
the release-artist display fallback is never imported as track-artist evidence.
The ordinary review remains editable before saving.

Follow-up validation (2026-11-12): full Python 3.13 **999 tests / 2,660 subtests**;
**896 frontend/media/Electron tests**; Chromium and WebKit at 420/760/768/1280 px
in Light/Dark (16 cases), with actual pointer/keyboard input and CSP. The native
macOS ARM64 app passes startup/restart, all eight comparison/choice cases plus an
additional real DOM editor/review transfer with title, primary artist and guest
credit, both frozen Studio/HTTP guards and all 15 shutdown/recovery cases. The
fixture refuses and records any attempted mutation; synthetic account writes stay
zero. Existing deadlines, focus assertions and no-save checks remain intact.
Source snapshots are checked once per render, rather than once per table row.

The first follow-up CI found a real handoff layout race on macOS ARM64: a lazy
native-lyrics response expanded the new editor and moved its Review button after
pointer targeting. A controlled browser response reproduced a movement from
y=739.86 to y=1151.47. Initial comparison correction display now defers native
lyrics (including background/cache/language repaints) until explicit track/tab
selection. Ordinary editor selections retain their existing lazy reads and smooth
scrolling; initial handoff uses immediate positioning and focus without scroll.
The same reproduction now keeps y=739.47 unchanged and hits Review. A new test
proves ordinary track selection still loads lyrics, and the native fixture asserts
zero handoff lyrics reads as well as zero writes. Pointer/focus assertions and
deadlines are unchanged; diagnostics include hit element and current coordinates.
The same CI run also had a separate unchanged first-setup smoke timeout on macOS
Intel; it remains recorded and the new head must pass that original check.
