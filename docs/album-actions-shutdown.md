# Compact album actions and shutdown appearance

Development baseline: `e05b828685e75e9a4da17911abed131f8a5b83da` (after #74).
This change does not merge #75/#76 or change the published version.

## Album actions

The album hero offers Play, an icon-only Shuffle with a translated accessible name
and tooltip, Queue, Edit and More. Both playback actions retain the existing complete
disc-set ordering, queue replacement, controller ownership and audio implementation.
Add to playlist is in More and opens the existing playlist chooser/review; opening
or dismissing the menu makes no requests. Moving the action adds no write protocol.
Menu selection captures the visited album, library map and playback session;
preparation also rejects navigation, account/session or library replacement.
Keyboard navigation includes the playlist item, and dismissal returns focus.
All six interface languages use the shorter Play label.

## Shutdown appearance

The finishing window previously embedded fixed green colours in its separate
HTML and native window background, independently of the main interface's palette.
It now starts with the active resolved CSS colours and follows Light/Dark/Auto,
built-in palettes and custom overrides, even without opening Mini Player.

The isolated main preload reports seven colour roles and an appearance mode only,
on initial DOM readiness and appearance changes. No new page-callable API, browser
storage, credentials, playback metadata or arbitrary stylesheet is forwarded.
Main accepts reports only from the current local application's exact main frame.
The finishing view accepts a complete bounded set of three/six-digit hex colours,
normalizes them to six digits and rejects invalid reports without replacing its
last valid appearance. Initial HTML and the native background share those colours;
progress updates and reopening retain them. A neutral fallback covers closing
before the interface is ready. Forced-colour system settings retain native colours.
The finishing window retains its sandbox, isolated context, no-script/no-network
CSP, disabled navigation and narrow resume-only control.

The backend drain sequence, accepted-write/read-back protection, unknown-outcome
warning, resume behavior and single-instance lock are unchanged. No timeout,
assertion or mutation-retry rule is relaxed.

## Track-list comparison recommendation (not implemented)

Current MusicBrainz suggestions use release groups and do not provide a selected
edition's track list. A future explicit Compare track list action should choose a
specific release (date, country, format, label/catalogue number and disc count),
then show current and reference positions, titles and known durations side by side.
Different editions and incomplete community data must remain distinguishable.
For a mixed album, compare more than one reference without inferring a split or
moving/renaming anything automatically. Start read-only. Any later chosen title
changes belong in the existing explicit draft/review/save workflow.

MusicBrainz distinguishes a [release](https://musicbrainz.org/doc/Release) from a
release group; media retain their own ordered track lists, which may be incomplete.
No comparison endpoint, external lookup or real-account write is added here.

## Validation (2026-11-12)

- Python 3.13: 986 tests / 2,645 subtests passed; Ruff and release consistency passed.
- Frontend, i18n, media and Electron: 889 tests passed. Focused tests cover complete
  disc-set playback, accessible shuffle, the existing playlist chooser, menu keyboard
  order, stale library/session/navigation rejection and asynchronous replacement.
- Chromium and WebKit: all 16 combinations of 420/760/768/1280 px and Light/Dark
  passed under the existing CSP, using actual pointer and keyboard input. No horizontal
  overflow, mutation, playback replacement or extra request on menu dismissal.
- The packaged macOS ARM64 app passed normal startup and a same-profile restart,
  CLI/version/security checks and all 15 shutdown/recovery scenarios. In a gated
  read, its actual finishing renderer matched the owner through 17 appearance checks:
  initial Amber Dark; six built-in palettes in both modes; custom Light/Dark; and
  custom Auto following simulated system Light/Dark. The second launch restored
  that same finishing window, and accepted-write/read-back coverage stayed intact.
- Native theme fixtures use a valid disposable custom-theme ID and wait for the
  owner's media-query/custom-colour application before capturing reference colours.
  Earlier fixture errors are retained in local validation logs. No deadline or
  expected result was relaxed. Build evidence is under the root checkout's ignored
  `build/album-actions-shutdown-20261112/`, with packaged reports in this worktree's
  `build/reports/`. Cross-platform CI remains an independent gate.

This local test package is ad-hoc signed; it is not a notarized public release.
No real iBroadcast account writes, tags, release assets or versions were changed.
