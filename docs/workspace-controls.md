# Workspace navigation, sorting and side panel

These controls are development changes after 1.7.0; no release version is changed.

## Navigation

The sidebar button in the desktop header hides or shows the left navigation.
Its preference is local to this browser origin or Electron profile. The button
remains outside the hidden sidebar so Settings and the connection controls stay
reachable after reopening it. Narrow windows retain the existing mobile menu.
Resizing between the two layouts never leaves mobile navigation hidden by a
desktop preference. Collapsing navigation does not change the page or playback.

Settings → Interface still controls which optional shortcuts are visible and
their order. This is separate from collapsing the whole sidebar. Existing
mandatory shortcuts, source permission gates and Restore defaults are retained.

## Fixed sort buttons

Albums and Album artists have a second row beneath the search controls. It stays
in the existing sticky toolbar during ordinary document scrolling. Very short
windows retain the existing normal-scroll fallback.

Albums offers Artist, Title, Year, Added and Rating. Clicking a new choice selects
its initial direction; clicking it again reverses that direction. Artist and Title
start A–Z; Year and Added start newest first; Rating starts highest first. The
pressed state and arrow identify the current ordering. Unknown dates and unrated
albums keep their established ordering rules. Added means iBroadcast's stored
upload date, not a new Tagcast import timestamp.

Album artists offers Name, Rating and its existing Random ordering. The Albums
Random order shortcut stays separate from Play random album. Filters is now a
dedicated menu; all existing nonempty filters, counts and selected zero-result
filters retain their behavior. Changing order preserves the independent filter,
selection, playback and existing history/continuous-browsing state rules.

## One Playlist / Details side panel

The right-panel button opens the existing side panel. Playlist shows Tagcast's
current local play queue, with the existing row actions and Save as playlist
workflow. It is separate from the native Playlists page. The full Now playing
page remains available, sharing the same queue and audio element.

Details uses read-only Album and Track accordions. It shows the open album or the
current queued track. The information button beside an album track selects that
track without playing it. The button stays visible; existing queue, tag and rating
actions retain their hover/focus behavior. Only known, loaded fields are shown;
opening Details never starts a provider lookup, a metadata fetch or a write.
Opening an album itself retains its existing lazy detail/cache reads.

Arrow Left/Right and Home/End switch tabs. Escape closes the side panel and returns
focus to the opening control. Accordion state survives read-only refreshes. A
library or session replacement clears captured selections and rendered old details,
including while the panel is closed. Details does not introduce another editor,
playback engine, source, library cache or account session.

## Validation

Frontend tests cover sorting and persistence, independent filters, sidebar/mobile
access, read-only track inspection, tab keyboard navigation, metadata escaping and
replacement invalidation. Existing browsing, playback, lyrics, settings and history
regressions continue to exercise the shared implementation. All six interface
catalogues include the new text.

The packaged Electron smoke check uses real pointer and keyboard events for the
new controls at 420, 768 and 1280 pixels in Light and Dark. It verifies hit targets,
the original audio element, focus restoration and absence of horizontal overflow.
It uses synthetic demo metadata only. Browser validation and native startup/restart
checks remain separate from real-account or hardware-audio compatibility claims.
