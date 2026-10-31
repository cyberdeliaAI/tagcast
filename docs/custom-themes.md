# Custom colour themes

Open **Settings → Appearance**, or **Theme → Edit themes…**. Start from Forest,
Ocean, Warm or iBroadcast inspired, give the theme a name, and adjust its colours.
The preview includes navigation, controls, an album card, tracks, review statuses
and a player illustration. It performs no playback or library actions.

- **Light** and **Dark** edit separate variants. They do not switch the app's
  existing Light / Dark / Auto preference. Auto continues to follow the system.
- **Save & use** saves the draft and applies it. **Save theme** saves without
  switching away from another active theme. Editing an already active theme updates
  that theme when saved.
- **Duplicate draft** creates a separately named copy. **Discard changes** returns
  to the draft's starting values. Individual reset arrows, or the variant reset,
  restore inherited base colours. Built-in palettes are never overwritten.
- Saved themes are available in the main **Theme** menu. Deleting the active custom
  theme returns to the previously selected built-in palette.

Changes initially affect only the preview. A draft survives navigation between
Settings categories and other pages. Leaving the application with edited colours
asks before discarding unsaved work. Invalid hex input stays visible and cannot be
saved or silently lost when switching variants. Failed browser storage preserves
both the draft and the previously saved custom theme.

Themes are local to the browser origin or Electron profile, like the existing
palette and appearance preferences. They are not synchronized with iBroadcast.
A different source-server port has a different browser origin. Tagcast 1.2.0 stores
at most 20 themes. **Export JSON** saves one theme, including both variants.
**Import JSON…** validates a Tagcast theme file and opens it as a new unsaved
preview; existing themes are preserved. Review the colours, then save explicitly.
Theme files contain no credentials, account details or library data.

## Colour and accessibility boundaries

The editor accepts six-digit hex colours for a fixed set of named palette roles.
It does not accept arbitrary CSS, URLs or scripts. Contrast checks cover eight
representative text, navigation and focus pairs; they warn about low contrast
without changing the chosen colours. They are not a complete accessibility audit
of every page. Forest's original fallback colours vary in some individual roles,
so its preview is representative rather than a pixel-identical copy of every view.

Warning/error colours retain their semantic styling. Browser-native audio controls,
output pickers and operating-system window borders keep their native presentation.
Custom colours also reach the Mini Player through its existing sanitized presentation
snapshot. The Mini Player still contains no playback engine or audio element.

## Implementation and validation

`static/themes.js` restores appearance synchronously before styles paint, validates
bounded local storage, and applies only named CSS variables. `theme-editor.js` owns
the in-memory draft and preview; `theme-editor.css` scopes its presentation. No
server preferences, metadata storage, playback or queue logic are changed.

`tests/themes.test.cjs` covers persistence, variants, validation, limits, unavailable
storage, built-in restoration and palette/IPC role parity. The existing frontend
and Mini Player tests cover routing, escaped names, server-setting separation and
clearing old custom colours. `electron/theme-smoke.cjs`, called by the existing
isolated packaging smoke test, checks the actual DOM, keyboard interactions,
save/reload, preview isolation, native audio/queue identity and Mini Player colours.
It tests widths 420, 760, 761, 768, 1280 and 1420, all four palettes in Light/Dark,
and 200% zoom. `TAGCAST_THEME_SCREENSHOTS` optionally selects an existing directory
for visual evidence; ordinary app use does not run these checks.
