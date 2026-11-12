# Workspace navigation, sorting and side panel

These controls are development changes after 1.7.0; no release version is changed.

## Navigation

The sidebar button in the desktop header hides or shows the left navigation.
Navigation starts open. Its manual preference is local to this browser origin or Electron profile. The button
remains outside the hidden sidebar so Settings and the connection controls stay
reachable after reopening it. Narrow windows retain the existing mobile menu.
Resizing between the two layouts never leaves mobile navigation hidden by a
desktop preference. Opening Playlist or Details never collapses it automatically.
Collapsing navigation does not change the page or playback.

Settings → Interface still controls which optional shortcuts are visible and
their order. This is separate from collapsing the whole sidebar. Existing
mandatory shortcuts, source permission gates and Restore defaults are retained.

## Fixed sort buttons

Albums and Album artists have a second row beneath the search controls. It stays
in the existing sticky toolbar during ordinary document scrolling. Very short
windows retain the existing normal-scroll fallback.

Albums offers Artist, Title, Year, Added, Rating and Random. For the first five,
clicking a new choice selects its initial direction; clicking it again reverses
that direction. Artist and Title
start A–Z; Year and Added start newest first; Rating starts highest first. The
pressed state and arrow identify the current ordering. Unknown dates and unrated
albums keep their established ordering rules. Added means iBroadcast's stored
upload date, not a new Tagcast import timestamp.

Random shuffles the existing complete album shelf; another click reshuffles it.
The active Random choice has a trailing shuffle icon in the same slot as the
direction arrow, for both Albums and Album artists.
Artist scope, search, filters and selection stay intact. It never starts playback
or replaces the queue. The album browser no longer offers a separate Play random
album shortcut; each album retains its explicit Play action. Random playback in
discovery groups is unchanged. Album artists retains its existing Random ordering.
Filters is a compact, single-column menu without duplicate headings or a close button. Close
it through its trigger, an outside click or Escape; Escape returns keyboard focus
to the trigger. All existing nonempty filters, counts and selected zero-result
filters retain their behavior. Changing order preserves the independent filter,
selection, playback and existing history/continuous-browsing state rules.

## One Playlist / Details side panel

The right-panel button at the far right of the header, after Live, opens the existing
side panel. Compact segmented Playlist/Details tabs keep larger touch targets on
mobile. Playlist shows Tagcast's
current local play queue, with the existing row actions and Save as playlist
workflow. It is separate from the native Playlists page. The full Now playing
page remains available, sharing the same queue and audio element. Devices now lives
beside the Play queue heading in this shared view, including with an empty queue.
It retains the existing queue-sync opt-in gate, dialog and account/session guards;
moving it does not connect a device or start playback. It is also reachable in the
full Now playing page. The header no longer contains a Devices shortcut.

Details uses read-only Album and Track accordions for the player's current queued
track and its original native album. Browsing or opening another album never
changes this subject. Track transitions update both sections; pausing retains the
current track. An empty or cleared queue shows a playback hint, even on an album
page. There is no separate browsing-track selection in this panel.
Only known, loaded fields are shown; opening Details never starts a provider
lookup, a metadata fetch or a write. Opening an album itself retains its existing
lazy detail/cache reads.

The accordions include loaded artist credits, disc/track numbers, genres, tags and
native ratings, with mixed disc ratings distinguished from unrated albums. Album
duration and file-size totals appear only when every loaded track has a known
value. Last upload means the latest track upload, not an album creation date;
dates use the interface locale without inventing a timezone. Optional library
size, play-count and stored ReplayGain values are bounded metadata only. ReplayGain
is not applied to playback here. No bit depth or sample rate is inferred from a
format label, and no audio is downloaded to inspect technical properties.

Restored local queues retain the requested tracks' public metadata in the existing
account/session-bound restore response. This never expands all album tracks or
adds upstream requests. Details combines that bounded, memory-only metadata with
the current loaded album summary (count, native disc, genres, rating and last upload),
so the album need not have been opened after restart. The metadata follows queued
occurrences through a weak map and is excluded from playback storage and Queue Sync.
A library/session replacement invalidates it; fresh cached membership takes priority.
Unknown ratings are omitted; a confirmed zero remains Not rated. A partial queue,
including repeated occurrences, never establishes complete-album duration or size.

Arrow Left/Right and Home/End switch tabs. Escape closes the side panel and returns
focus to the opening control. Accordion state survives read-only refreshes. A
library or session replacement clears rendered old details,
including while the panel is closed. Details does not introduce another editor,
playback engine, source, library cache or account session.

## Validation

Frontend tests cover sorting and persistence, independent filters, sidebar/mobile
access, current-track details across browsing, cross-album transitions, pause/stop,
tab keyboard navigation, metadata escaping and replacement invalidation, restored
queues before visiting their albums, duplicate positions,
unknown ratings and stale cached membership. Existing browsing, playback, lyrics, settings and history
regressions continue to exercise the shared implementation. All six interface
catalogues include the new text.

The packaged Electron smoke check uses real pointer and keyboard events for the
new controls at 420, 760, 768 and 1280 pixels in Light and Dark. It verifies hit targets,
the original audio element, focus restoration and absence of horizontal overflow.
It uses synthetic demo metadata only. Browser validation and native startup/restart
checks remain separate from real-account or hardware-audio compatibility claims.

### Restored-queue regression validation (2026-11-12)

The new startup-restore regression fails against the original #73 implementation
with the same missing album fields and false Not rated result. The correction
passes four frontend cases covering startup without an album visit, unknown ratings,
replacement/membership invalidation and original-disc identity. Backend coverage
confirms duplicate occurrence positions, unchanged ownership checks, no remote
reads/writes and no full-album expansion in the existing restore response.

Python 3.13: 985 tests / 2,640 subtests passed. Frontend/i18n, media and Electron:
819 tests passed. Chromium/WebKit passed 16 real startup/restore viewport-theme
cases with CSP, unchanged queue/audio/history, no autoplay and no extra Details
requests. The extracted macOS ARM64 package passed eight synthetic restore cases
using pointer input plus the existing application/shutdown checks. Normal Playlist
native-lyrics reading remains separate; the Details request invariant is measured
without first opening that lyrics view. No timeout or assertion was relaxed.

### Current-playback subject correction (2026-11-12)

The visited album previously took priority over the player's current occurrence.
Details now follows only the current queued track and its original album, including
restored queues while browsing another album. Regression coverage includes actual
play/next/pause/stop events, cross-album transitions, an empty queue on an album
page, read-only rendering and the existing session/membership invalidation guards.
The packaged pointer/keyboard matrix now exercises the current-track subject and
restoration while a different album is open, retaining its audio, history, focus,
request-count and overflow assertions.
