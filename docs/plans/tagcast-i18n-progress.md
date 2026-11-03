# Tagcast interface translation: progress

Branch `feature/internationalization`, based on `c47f2e0` (Tagcast 1.3.0). Phase 3 makes the
whole existing English interface translatable and adds the complete Dutch translation. English
stays the source and the per-key fallback. See [the plan](tagcast-internationalization-plan.md)
and [the proof of concept evaluation](tagcast-i18n-poc-evaluation.md).

## Parts (one commit each, in this order)

| # | Part | Files | Status |
|---|---|---|---|
| 1 | Foundation: missing-text checks, pseudo-localization, number and date formats, shared texts, browser scan tools | `i18n.js`, `tests/i18n.test.cjs`, `docs/plans/i18n/tools/` | done |
| 2 | Static page markup (sidebar, page headers, dialog shells) | `index.html` | done |
| 3 | Navigation, browsing and album pages | `navigation.js`, `artists.js`, `browse.js`, `tracks.js`, `favourites.js`, `album.js`, `album-info.js`, `album-guide.js` | done |
| 4 | Library view, search and filters, metadata editor, review and change history | `app.js`, `credits.js`, `genres.js`, `artwork.js` | done |
| 5 | Playlists, playlist import and tags | `collections.js`, `playlist-tools.js`, `playlist-order.js`, `playlist-import.js`, `tags.js` | done |
| 6 | Downloads, uploads, overview and metadata health, export, sign-in, updates, service status | `downloads.js`, `uploads.js`, `overview.js`, `metadata-export.js`, `sign-in.js`, `updates.js`, `service-status.js` | done |
| 7 | Settings and configuration screens | `settings.js`, `lookup.js`, `theme-editor.js`, `themes.js`, `visualizer.js`, `queue-sync.js`, `gapless-controls.js`, `gapless-diagnostics.js`, `language.js` | done |
| 8 | Metadata Cleanup, album merging, trash and year review | `cleanup.js`, `trash.js`, `year-review.js`, `album-merge.js` | done |
| 9 | Contextual help | `help.js` | done |
| 10 | Desktop menus, window titles and native dialogs | `electron/` | done |
| 11 | Player, lyrics, gapless playback and Mini Player (remaining texts) | `player.js`, `playback-lyrics.js`, `lyrics.js`, `lyrics-import.js`, `gapless.js`, `gapless-media.js`, `mini-player.js` | done |
| 12 | Full coverage: Dutch marked complete, interaction tests, documentation | `manifest.json`, tests, `AGENTS.md` | done |

## Numbers

- 3,025 interface texts (3,212 catalog entries including 187 plural families) in `en.json`, all
  translated in `nl.json`. The inventory at `c47f2e0` counted 3,361 frontend and 47 desktop
  interface strings; repeated texts share keys and sentence fragments became whole messages.
- Not yet translated by design: about 690 error messages and 36 status texts sent by the Python
  server. They show in English in a Dutch interface unless they carry a code. Three server codes are
  translated today; the rest is the separate final phase.

## Checks

- `tests/i18n.test.cjs`: every referenced key exists, every key is used, Dutch covers every key,
  key-like literals are real keys, `TagcastI18n.text()` never appears inside an HTML template,
  plural forms per language, generated English bundle current, desktop texts identical to the
  catalog.
- Browser scan (`docs/plans/i18n/tools/text-scan.cjs`, 84 screens and dialogs against
  `tests/mock_ibroadcast.py`): English text and attributes are identical to `c47f2e0` apart from the
  new Language section; the Dutch scan shows no untranslated interface text apart from library data,
  product names, words that are the same in Dutch and server messages. The scan found no clipped
  controls in Dutch at full width, at 420 px or in dark mode.
- Frontend interaction tests switch languages during playback, with an open metadata draft, on the
  library, album and Settings screens: no requests besides the catalog, no lost state.

## Remaining risks

- Server messages in English (above).
- Dialogs holding drafts keep their current language until reopened; their static labels switch.
- A few English counts keep their old wording for a count of 1 ("1 albums") so English output stays
  identical. Fixing them only needs the English `_one` values.
- Existing installs whose system language is Dutch and whose language setting is Automatic switch to
  Dutch after this update.
