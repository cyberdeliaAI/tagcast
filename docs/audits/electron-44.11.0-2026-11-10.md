# Electron 44.11.0 maintenance candidate — 2026-11-10

Baseline: main `309366704ed0aa26cf812a91622c44b3ae62b10c`, Electron 44.9.3.
Tagcast's public version remains 1.6.5. This is a candidate PR, not a release.

## Upstream verification and rationale

The initially assessed 44.10.2 was superseded during preparation by the official
[44.11.0 release](https://github.com/electron/electron/releases/tag/v44.11.0),
published 2026-11-10 at 19:48:57 UTC. GitHub reports a stable release; npm contains
the matching exact version and integrity hash. Some release-site search indexes
still showed 44.10.2, so they were not used to reject the newer published release.

44.10.x includes Linux D-Bus and X11 paste fixes, ASAR archive validation/path
consistency fixes, a hidden-parent Wayland crash fix and Chromium/Node maintenance.
44.11.0 additionally backports ANGLE, Chromium, Dawn, FFmpeg, PDFium, Skia and V8
fixes. Its fixes cover permission callbacks after webview destruction, notification
subscriptions hanging macOS quit, redirect loops and net.fetch upload errors.
Tagcast disables webviews and does not use those notification subscriptions or
net.fetch, so these are not claimed as reproduced Tagcast shutdown/upload fixes.
The optional new Windows menu-color API is not adopted.

The maintenance benefit is the supported major-44 graphics/media/runtime update.
No major-45 upgrade, new feature, builder/fuses upgrade or playback change is made.
Only the Electron package and corresponding lock metadata change. Other resolved
packages remain byte-identical. The seven moderate npm audit package findings
already exist on the 44.9.3 baseline (builder/minimatch/fast-uri dependency chain);
they are not fixed by this update and no automatic audit fixes are applied.

## Validation plan and evidence

Run all existing Python, frontend/media, Electron/security and signing-isolation
tests. Build/extract native apps for macOS ARM64/x64, Windows and Linux, verify CLI,
CSP, renderer sandbox, fuses and ASAR, exercise all 15 shutdown/restart cases and
the native visible-toast matrix, then verify Debian installation/distribution jobs.
Run the complete measured PCM smoke/reference, full-application, stress diagnostics,
artifact verification and negative-oracle suites with the new runtime. Exercise
real recovery, history, account replacement, mini-player and visualization/rotation.
Results are recorded in the PR after completion; initial failures remain preserved.

A local auxiliary archive installation was attempted before its separate download
completed. It is invalid evidence. The new dependency dist was preserved and
reinstalled through the canonical installer only after verifying the complete
official cached archive against GitHub's SHA256
`ed7e975878e9767de48d7b7bc06fdd3d333d4d5747155c92b874477eaf7bfec3`.
The distinct package build uses electron-builder's verified official archive and
reports Electron 44.11.0 in its actual native smoke checks. No existing worktree or
source artifact was overwritten by the installation recovery.

## Limits

PR macOS packages use ad-hoc integrity signatures, not Developer ID notarization.
Actual signing/stapling/Gatekeeper validation remains an explicit release-preparation
gate. Linux CI uses X11/Xvfb; actual Wayland parented sign-in/picker/window behavior
requires a separate native Wayland check. Passing mocked suites does not resolve
the independent iBroadcast playlist append contract (F2-02).
