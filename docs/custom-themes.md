# Custom colour themes

Open **Settings → Appearance**, or **Theme → Edit themes…**. Start from Forest,
Ocean, Warm, iBroadcast inspired or Apple Music Classic, give the theme a name,
and adjust its colours.
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

### Sidebar icon colour

Under **Sidebar, player and other colours**, **Sidebar icons** optionally gives the
main navigation icons their own colour. Labels, counts, player controls and the
mobile menu button keep their existing colours. Light and Dark can use different
icon colours. Check the preview and the icon contrast against both the sidebar and
selected navigation background.

Leave the hex field blank, or use its reset arrow, to restore the base palette's
icon behaviour. Forest, Ocean, Warm and iBroadcast inspired follow the navigation
text, including hover and selection. Existing themes keep that behaviour without
migration or reconfiguration. Apple Music Classic has its own red/pink icon
colours. Changing a preview never changes the active theme until you save it.

The optional JSON colour role is `nav-icon`. Older Tagcast versions that do not
support this role reject a file containing it; removing it from both variants
restores compatibility and makes icons follow text again. Theme files without
this role and with an existing base remain unchanged when imported or exported by
a newer version. A custom theme based on the new `apple` palette also requires a
Tagcast version that supports that base.

### Apple Music Classic

Choose **Theme → Colour → Apple Music Classic** directly; importing JSON is not
required. Light uses white and pale-grey surfaces with red accents, while Dark
uses charcoal surfaces with pink accents. Light / Dark / Auto remains an
independent preference, and the Mini Player follows the same palette. Switching
palettes preserves playback, queue, saved custom themes and other preferences.

This is an independent Tagcast colour adaptation inspired by the
[classic Apple Music interface](https://support.apple.com/en-gb/guide/music/welcome/1.5/mac/15.0),
with text and focus colours adjusted for contrast. It uses Tagcast's own logo,
typography and components, and is not an official Apple theme or endorsement.

## Colour and accessibility boundaries

The editor accepts six-digit hex colours for a fixed set of named palette roles.
It does not accept arbitrary CSS, URLs or scripts. Contrast checks cover eight
representative text, navigation and focus pairs, plus two icon pairs when an icon
colour is set; they warn about low contrast
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
It tests widths 420, 760, 761, 768, 1280 and 1420, all five palettes in Light/Dark,
and 200% zoom. `TAGCAST_THEME_SCREENSHOTS` optionally selects an existing directory
for visual evidence; ordinary app use does not run these checks.
