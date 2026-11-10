# Scrollable-menu smoke validation — 10 November 2026

## Investigation

The post-merge Builds run `42778717470` failed only on macOS ARM64 at
`420/light/theme: menu choices receive pointer input`; Distribution verification
then correctly failed because a required build had failed. The PR Builds run
`42777562692` succeeded. PR head `f4110dc` and merge `f2becda` have identical trees,
and both ARM64 jobs used Electron 44.9.3 on macOS 15.8.2, image
`macos-15-arm64/20261104.0514`. Linux, Windows and Intel builds succeeded.
The post-merge Tests run `42778717442` subsequently completed successfully,
including its Linux PCM job and application verification.

Ordinary local checks did not reproduce the failure: 60 menu matrices and twelve
complete source-app smoke runs passed. A controlled smaller available viewport
and normal document scroll reproduce the exact 420/light assertion: Edit themes
is inside the browser viewport but clipped below the theme menu's own scrollport.
Its centre consequently hits an album card underneath. A height matrix also
reproduces the same faulty assumption at 761px. This is a smoke-test visibility
error, not evidence of a newly introduced UI stacking regression.

The original CI report did not record its hit target, viewport or menu geometry.
Its exact native resize/scroll state cannot be reconstructed; the controlled
reproduction establishes the erroneous assertion without claiming an unmeasured
CI height or a particular timing delay.

## Correction

The smoke test now scrolls each rendered menu choice into view before measuring
its rectangle and requiring that `elementFromPoint` belongs to that exact choice.
It checks every rendered choice, including clipped ones formerly skipped outside
the viewport, and retains the sticky-toolbar overlap and Escape/focus assertions.
An occluded point fails immediately; there is no retry, larger timeout or fallback
to another control. Failure reports include the blocked control, actual hit target,
menu scrollport and viewport geometry. Product CSS, menu behavior, playback, account
state and runtime code are unchanged.

## Local checks

- All 50 Electron unit tests pass. Three new cases exercise clipped controls,
  immediate rejection of a genuine overlay, and rejection of empty coverage.
- The same controlled 420/light reproduction passes with all choices checked.
- 120 real Electron menu cases pass across widths 420/761/1280, Light/Dark, both
  menus and available heights 500–800px, including the original clipping cases.
- An actual native mouse click on the revealed Edit themes button opens Appearance
  settings at 420/light, preserving the audio element and queue.
- A negative real-browser control lowers the theme menu behind the sticky toolbar:
  the corrected test still fails immediately on the intercepted palette control.

Condensed evidence: `validation/menu-smoke-2026-11-10.json`. Full run logs, the
controlled reproductions and local packages remain under
`build/menu-smoke-investigation-2026-11-10/` in the primary checkout.
The new Apple Silicon archive was built, extracted and checked with the same
production packaging path as CI. Its final smoke code matches the reviewed source;
initial startup and restart pass with disposable settings/profiles. The local app
is ad-hoc signed, not notarized or published. Remote CI is checked independently.
Version and tag remain 1.6.5; no release or public binaries are produced.
