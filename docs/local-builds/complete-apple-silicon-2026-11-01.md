# Complete Apple Silicon test build — 1 November 2026

This is a local integration build of Tagcast 1.2.0, not a new public release.
No additional general audit was performed.

## Included work

The starting point is `455bd0f53bb9f72088894efa8d683247171b3274`, the 26-commit
stabilization and Apple Music Classic combination submitted as draft PR #24.
It includes the existing uploads, downloads, theme editor, playlist, year-cleanup,
Mini Player, live spectrum and ordinary/native lyrics features from main.

The older development worktree was compared using its own committed baseline.
Its remaining functional changes were display-only Now playing lyrics and the
optional softened cover background. These are integrated here without replacing
newer stabilization fixes or the Apple Music changes. The original worktrees and
all their uncommitted files remain unchanged.

Now playing offers three profile-local source preferences in Settings → Playback:

- iBroadcast only (the default; no Unison lookup).
- iBroadcast first, with Unison as fallback.
- Unison first, with iBroadcast as fallback.

Unison receives title, track artist, album and known duration only while the
expanded lyrics view is open and an online option is selected. Its results are
bounded, temporary RAM data. They never populate the editor or write lyrics to
iBroadcast. Timed lines follow the existing current-track playback position,
including Gapless Playback; word-by-word karaoke is not implemented. The separate
cover-background preference defaults off. No NetEase or Kugou provider is included.

## Targeted verification

- Python 3.13: 822 tests and 2,379 subtests passed.
- Python 3.11: all 16 newly integrated lyrics tests and 16 subtests passed.
- All JavaScript suites: 616 passed; Electron shell: 40 passed.
- Ruff, syntax of 45 shared scripts, generated dark CSS and version checks passed.
- Existing full-page Electron media scenarios passed: ordinary playback, startup
  fallback, mixed-block fallback, stall recovery, pause/seek/session replacement,
  Repeat/queue edits, evicted backward seek, prepared Next and late queue replacement.
- The actual packaged HTML/CSS/JavaScript was exercised with synthetic lyrics in
  sandboxed Electron under the production CSP: five palettes × Light/Dark ×
  420/760/761/768/1280 px, plus 200% zoom, keyboard focus, cover background and
  unchanged audio-element/queue identity. Screenshots use invented test metadata.
- The frozen app, backend and CLI are arm64. The existing package checker verifies
  actual app startup, server shutdown, security settings, CLI, preference persistence
  and the bundled certifi CA. Current static files are compared with packaged bytes.

No real account, real music or public lyrics query was used for these checks.
Live Unison availability and coverage remain provider-dependent and should be
checked during ordinary listening. These are macOS Apple Silicon results; this
local build adds no Windows, Linux or Intel runtime claim. Existing deterministic
PCM evidence is preserved; it was not regenerated for a display-only integration.

## Local test packaging

The test package has a distinct app identity and fixed local origin. A small
packaging-only entry file sets defaults before loading the unchanged Electron
main module; explicit smoke-test environment overrides still take precedence.

- App: `Tagcast Complete Test.app`
- App ID: `nl.cyberdelia.tagcast.complete-test`
- Settings: `~/.tagcast-complete-test`
- Browser profile: `~/Library/Application Support/Tagcast Complete Test`
- Default port: `18991`

Production configuration, release version, default profile and playback engine
are unchanged. The test package is ad-hoc signed locally; it is not a notarized
Developer ID release. A fresh sign-in is required in its separate profile.
The package includes a ZIP checksum and a build manifest with exact source commit,
checks and test-only overlay hashes. Nothing is installed over the regular app.

No new push, merge, tag or release is part of this local build.
