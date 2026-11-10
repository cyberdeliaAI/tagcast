# Visible toast pointer input

Baseline: verified main `694e8dcd94cf5f74c01b46839374644ef1d914ac`.

The real browser regression failed in light and dark at 420 by 656 pixels:
the Edit themes control's centre `(176, 596)` hit `#toast`, and the actual mouse
click did not open Appearance settings. The toast is fixed near the bottom,
painted at z-index 99 above the header/menu stacking context. This is a real input
obstruction, whose timing also makes native smoke intermittent.

The shared toast is status-only. Its sole writer uses `textContent`; it has no
links, buttons, children or input handlers. `pointer-events:none` preserves its
position, colours, lifetime, visibility and `role=status` announcement while
allowing workspace controls underneath to receive input. No notification is
hidden and the existing menu hit-test assertions are unchanged. `dark.css` is
regenerated from `style.css`.

The new extracted-app regression keeps a real toast visible, scrolls the menu
control into view, hit-tests it and sends actual pointer down/up input. It checks
that Appearance settings opens and the notification remains visible. It also
requires a physical toast/control overlap and rejects interactive toast children.
Coverage is light/dark, widths 420/760/768/1280 and heights 656/800, in addition to
the existing menu, toolbar overlap, Escape and focus checks.

Local validation: the new browser probe passed all 16 cases in each of Chromium,
Firefox and WebKit; all 857 frontend/Electron tests passed. The locally packaged
macOS ARM64 app passed the new pointer matrix, existing startup/CLI/security
checks and all 15 shutdown cases. All accounts, settings and audio were disposable
or synthetic. No release, version or dependency change is included.
