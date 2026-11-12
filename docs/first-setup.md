# First setup

This guided view of existing preferences is a development change after 1.7.0.
It does not change the release version, music metadata or iBroadcast write protocol.

## Flow and ownership

A genuinely new server settings folder and browser profile opens Welcome once,
after both startup status and settings have settled. Existing config, tokens,
library cache or update cache excludes automatic onboarding. A later failed
connection, disconnect or application update does not restart it. Existing users
can open it from Settings → Interface → First setup.

Welcome opens the existing device/custom-client OAuth dialog. Successful sign-in
continues to Playback without introducing another login or library fetch. Users
can explore the existing demo without connecting. Playback shows account-appropriate
quality (Free remains 128 kbps), and the existing opt-in experimental gapless switch.
Lyrics explains native-only, native-first and Unison-first, including the existing
consented LRCLIB fallback. Workspace exposes language, appearance, built-in palette,
continuous browsing/pages and the expanded player mode. Optional services exposes
play reporting and device control; existing reconnect/scope rules still apply.
The final summary links to all settings.

Every step applies only on Save and continue, using existing preference helpers and
partial `/api/settings` bodies. Unchanged settings are not posted; source keys and
unrelated preferences are never copied into a wizard form. All choices in a step
are validated before applying it. Failed server persistence leaves the step and
its inputs available, without applying following local choices. A failed language
save restores the previous profile language. Account/session replacement or changed
baseline preferences blocks a stale save. An in-flight save prevents closing/advancing.
Existing editor, Settings and theme drafts block opening the wizard.

Back and Set up later retain unapplied inputs in memory. Skip drops that step's
unapplied choices. The profile stores only progress/version/status, never account
data, credentials or drafts. After restart, paused setup is reopened explicitly
from Settings and uses current saved preferences; unapplied choices from the prior
process are not retained. A mid-step application exit resumes the step on restart.
Saved steps are already normal settings; completion adds no second configuration.
Defaults and optional services are not enabled by opening, skipping or finishing.
Choosing gapless or a lyrics source has the same explicit effect as in Settings.

## Validation

Backend tests cover read-only first-run eligibility and exclusion of existing
profiles. Frontend tests cover both startup response orders, pause/resume/Back/Skip,
completion, partial saves/failures, account/session replacement, language rollback,
Free account restrictions, existing OAuth reuse and draft protection. Browsing,
playback, queue, history and original audio remain independent. All six interface
languages include the new text; no inline script or CSP exception is added.

The packaged Electron smoke check uses actual pointer input at 420, 760, 768 and
1280 pixels in Light/Dark, with keyboard Escape, progress and no horizontal overflow.
It checks that skipped steps make no POSTs and preserve preferences, queue, audio
and history. A separate real-browser check covers automatic first-run behavior,
persisted pause/completion and explicit saving using synthetic local endpoints.
No real iBroadcast account writes are part of validation.

### Validation evidence (2026-11-12)

- Python 3.13.16: 984 tests and 2,640 subtests passed with the local mock.
- Frontend/i18n and Electron unit suites: 792 tests passed.
- Chromium and WebKit: 16 viewport/theme combinations passed, including automatic
  first run, paused/completed profile state, explicit source selection, language
  and browsing choices, server persistence failure/recovery and CSP checks.
- Extracted macOS ARM64 package: startup/restart, 8 setup pointer/keyboard cases,
  existing theme/workspace checks and all 15 native shutdown scenarios passed.
- Ruff, JavaScript syntax, generated translation/CSS checks and release metadata passed.

Platform CI results and combined test-app provenance are recorded in the PR.
This local test build is ad-hoc signed; it is not a notarized production release.
