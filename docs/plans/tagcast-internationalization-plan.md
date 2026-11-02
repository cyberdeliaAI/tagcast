# Tagcast internationalization and localization plan

Status: proposal only. No application code, tests, packages or settings were changed.
Date: 2 November 2026.

This plan is grounded in a full static inventory of the repository. Every number marked
**Measured** comes from a script run against the inspected commit. Numbers marked
**Estimate** are judgement calls and are given as ranges.

---

## 0. Inspection record

| Item | Value |
|---|---|
| Repository | `cyberdeliaAI/tagcast` on GitHub |
| Branch inspected | `main` |
| Commit inspected | `c47f2e01df2237240d60572e25af22f48558cf2a` (2 Nov 2026 13:11 +0100, "Merge pull request #26 from cyberdeliaAI/codex/readme-storm-front-screenshot") |
| Application code equivalence | Identical to `29e9d1708cb15bc61a86b0421ec096037ef9e65c` ("Publish Tagcast 1.3.0", tag `v1.3.0`). The four later commits only touch `README.md` and two README screenshots. |
| Local working copy | `/Users/cyberdelia/Documents/GitHub/tagcast` is on `main` at `58c8230b3fc9f348b3dc51485b65fe6194f0cf70`, 37 commits behind its own `origin/main` ref (`29e9d17`). It has an untracked `docs/audits/` folder, one stash and eight extra worktrees. None of these were touched. |
| Files changed by this study | Only this file: `docs/plans/tagcast-internationalization-plan.md` (new, untracked). |
| Baseline tests | `node --test tests/*.test.cjs` passed 627/627 on a Linux copy of `c47f2e0`. Python tests weren't run because nothing changed. |

**Important for implementation:** start any i18n branch from the current `origin/main`
(1.3.0 or later), not from the local `main` checkout, which predates the stabilization work.

### Method

- JavaScript (`src/tagcast/static/**/*.js`, `electron/*.cjs`) was parsed with acorn 8.19.0.
  Every string literal and template literal was classified by its syntactic sink
  (`textContent`, `innerHTML`, `setAttribute("aria-label")`, `toast()`, `confirm()`,
  `Error()`, label tables and so on). HTML fragments inside templates were tokenized into
  text segments and translatable attributes (`title`, `aria-label`, `placeholder`, `alt`,
  `aria-valuetext`).
- Static HTML (`index.html`, `mini-player/index.html`) was parsed with parse5 7.
- Python was parsed with the standard `ast` module: messages passed to raised exceptions,
  user-facing dictionary values (`error`, `note`, `title`, `message`) and the Tk launcher.
- The analysis tools ran in a separate scratch environment. Nothing was installed in the repository.
- A random sample of 100 inventory items was checked by hand. About 97 were genuine UI
  text. The rest were product names (for example "Discogs") or data sentinels (for example
  "Various Artists"). Treat all counts as accurate to roughly ±5%.
- A per-string CSV (4,410 rows with file, line, component, category, kind, context and text)
  was produced alongside this plan. It isn't committed to the repository.

### Coverage limits

- Strings created at runtime from internal keys (for example `fieldLabel()` capitalizing a
  field name) aren't literals, so they're described as patterns rather than counted.
- Python strings that are returned without passing through `raise`, a known dictionary key
  or a known variable name may be missing.
- The app wasn't launched. Layout and overflow risks are inferred from CSS patterns, not
  measured in screenshots.
- The GitHub Wiki, website, release notes and README were out of scope.
- No first-party usage data exists. Tagcast sends no analytics (`PRIVACY.md`, line 14).

---

## 1. Executive summary

**What exists today (Measured)**

- Tagcast has no localization layer. Both pages hardcode `<html lang="en">`. There are 45
  hardcoded `toLocale*("en")` or `("en-GB")` calls, 80 English-only plural ternaries
  (`n === 1 ? "track" : "tracks"`), zero uses of `Intl` and 181 `innerHTML` assignments.
- The frontend and Electron shell contain **3,408 user-visible text occurrences**,
  **2,652 unique texts** and about **21,200 words** of unique text across 53 files.
- `help.js` alone holds 6,390 words, which is 28% of all frontend words.
- The Python backend raises **690 user-facing error messages (595 unique, 5,567 words)** in
  25 modules. Each one reaches the browser verbatim through `{"error": str(error)}`.
- English text churns fast. Between v0.70.0 (18 Oct) and the inspected commit (2 Nov),
  about 1,025 unique texts and roughly 10,300 words were added.

**The real risks aren't in the translation itself**

1. English placeholders double as data. The server injects "Various Artists",
   "Untitled album" and "Unknown artist" into metadata fields and uses them in disc-set
   grouping keys and identity checks. "Unknown Artist" and "Unknown Album" become folder
   names for downloaded music.
2. English display text is persisted. Change history (`tagcast-history`), cleanup reports,
   duplicate-cleanup reasons and `.ibfetch.json` download notes store English sentences.
3. Translated text inserted through 181 `innerHTML` sinks can open XSS holes if the API
   doesn't separate plain text from trusted markup.
4. A naive language switch could reload the page, which would stop playback and drop the
   in-memory queue and open drafts.
5. The global function name `t` would be shadowed. The code base has 501 identifiers
   named `t`, and 121 functions take a parameter called `t`.

**Recommendation in one paragraph**

Use **Option A**: a small native module (estimated 250 to 350 lines) built on `Intl`, with
flat JSON catalogs that use a small ICU MessageFormat subset. Keep English as a generated,
synchronously loaded fallback. Store the preference in the local server settings so the
browser and the Electron app agree. Switch languages without reloading and never touch
audio, the queue, drafts or iBroadcast. Do an English-only extraction first that keeps the
output byte-identical, then pilot one language end to end. Python messages stay English at
first and gain optional error codes later.

**Effort (Estimate)**

| Milestone | Developer days | Native review hours |
|---|---:|---:|
| Foundation (Phase 1a) | 5-8 | 0 |
| English extraction with parity (Phase 1b) | 17-30 | 0 |
| First pilot language end to end (Phase 2) | 5-8 | 25-40 |
| Each further European language | 2-4 | 25-45 |
| Japanese | 5-8 | 35-60 |
| **First non-English preview** | **about 28-47** | **25-40** |
| **All five recommended languages** | **about 43-74** | **about 135-235** |

**Readiness:** Tagcast is ready to start the foundation work once the local checkout is
synced to 1.3.0 and four decisions are taken (section 12). It isn't ready to ship a
translated build soon. The English extraction is the long pole.

### Target languages in brief

The proposed set (German, French, Spanish and Japanese) is defensible but mostly
assumption-based. The only usage evidence is two third-party traffic estimates for
ibroadcast.com, and they contradict each other. One puts Japan second at 15.5% of visits.
The other doesn't list Japan at all. Both agree that English-speaking countries dominate
(53% to 86% of estimated visits). This plan recommends **Dutch as the pilot language**
because the maintainer can review it natively at no cost, followed by German, French and
Spanish, with Japanese last and given dedicated typography work. Details are in
section 8.1.

---

## 2. Repository translation inventory

### 2.1 Totals (Measured)

| Surface | Occurrences | Unique texts | Words |
|---|---:|---:|---:|
| Frontend JavaScript (45 files in `src/tagcast/static`) | 2,946 | 2,375 | 20,950 |
| Static HTML (`index.html`, `mini-player/index.html`) | 415 | 329 | 1,467 |
| Electron main process (6 files) | 47 | 44 | 281 |
| **Frontend and Electron total** | **3,408** | **2,652** | **22,698** (occurrence-weighted), 21,199 (unique) |
| Python user-facing exception messages (25 modules) | 690 | 595 | 5,567 |
| Python payload and display texts (notes, reasons, labels) | 37 | 37 | about 300 |
| Legacy Tk launcher (`desktop.py`) | 11 | 11 | about 60 |

The frontend counts break down as follows:

- `index.html` contains 240 text nodes (including `<title>`) and 157 attributes: 116
  `aria-label`, 30 `title`, 9 `placeholder`, 1 `alt` and 1 `aria-valuetext`.
- Frontend JavaScript contains 1,510 string literals, 926 text segments inside HTML
  template literals, 235 template literals with text, 153 plural ternary branches and 122
  attributes inside templates.
- There are **350 accessibility and tooltip strings** in total: `aria-label` 242, `title`
  78, `placeholder` 19, `alt` 7 and `aria-valuetext` 4.
- Electron role-based menu items (Undo, Copy, Paste, Quit, Zoom In and so on) have no
  strings in the code. They rely on Electron's English defaults, which means about 25
  labels must be added before menus can be localized.

Excluded from the totals: 95 strings in Electron smoke and visual test harnesses, the CSP
string in `security.cjs`, 72 demo
library strings (`app.js` lines 127 to 140), 5 theme-preview sample titles, 14 standalone
product names and 25 gapless diagnostics in `gapless-media.js`.

### 2.2 By component (Measured)

| Component | Files | Occurrences | Unique texts | Words | With placeholders | Fragments | Plural ternaries | `innerHTML =` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Core shell, album grid, editor, review and history (`app.js`) | 1 | 341 | 297 | 1,720 | 69 | 60 | 14 | 22 |
| Static page skeleton (`index.html`) | 1 | 397 | 319 | 1,422 | 0 | 2 | 0 | 0 |
| Navigation, sidebar and settings | 2 | 72 | 60 | 288 | 3 | 1 | 0 | 4 |
| Appearance and theme editor | 2 | 126 | 116 | 657 | 17 | 5 | 0 | 2 |
| Help tours | 1 | 337 | 328 | 6,390 | 1 | 1 | 0 | 0 |
| Browsing: artists, albums, tracks, browse groups, favourites | 5 | 276 | 219 | 1,676 | 43 | 42 | 14 | 24 |
| Overview, service status and updates | 3 | 149 | 136 | 581 | 20 | 18 | 2 | 6 |
| Album background, biographies and 1001 Albums | 2 | 66 | 65 | 371 | 8 | 7 | 1 | 10 |
| Metadata editor helpers: credits, genres, online lookup, artwork | 4 | 212 | 199 | 1,444 | 38 | 20 | 2 | 17 |
| Cleanup, year review, trash and duplicates, album merge | 4 | 302 | 260 | 1,858 | 55 | 62 | 13 | 19 |
| Playlists and CSV/URL import | 4 | 445 | 374 | 2,207 | 66 | 94 | 24 | 34 |
| Tags | 1 | 75 | 66 | 336 | 17 | 19 | 4 | 10 |
| Playback, queue, output, gapless, visualizer, queue sync | 8 | 199 | 180 | 1,305 | 41 | 16 | 2 | 6 |
| Lyrics (editor, import, Now playing) | 3 | 137 | 121 | 848 | 21 | 12 | 1 | 15 |
| Downloads, uploads and metadata export | 3 | 182 | 173 | 1,124 | 20 | 20 | 3 | 12 |
| Sign-in | 1 | 14 | 14 | 102 | 0 | 0 | 0 | 0 |
| Mini Player window | 2 | 31 | 23 | 88 | 2 | 2 | 0 | 0 |
| Electron main process | 6 | 47 | 44 | 281 | 0 | 1 | 0 | 0 |
| **Total** | **53** | **3,408** | **2,652** | **22,698** | **421** | **382** | **80** | **181** |

"Fragments" are pieces of a larger sentence, such as `" in your collection"`,
`"· Disc {}"` or a bare `"tracks"`. They have to be merged into whole messages before
translation. Unique fragments: 255.

### 2.3 By source file (Measured)

| File | Occurrences | Unique | Words | Main kinds |
|---|---:|---:|---:|---|
| `static/app.js` | 341 | 297 | 1,720 | 216 string, 73 html text, 28 plural |
| `static/index.html` | 397 | 319 | 1,422 | 240 html text, 157 attr |
| `static/navigation.js` | 53 | 41 | 158 | 48 string, 3 html text, 2 attr |
| `static/settings.js` | 19 | 19 | 130 | 19 string |
| `static/theme-editor.js` | 119 | 109 | 588 | 66 string, 42 html text, 11 attr |
| `static/themes.js` | 7 | 7 | 69 | 7 string |
| `static/help.js` | 337 | 328 | 6,390 | 337 string |
| `static/browse.js` | 93 | 85 | 938 | 62 string, 21 html text, 8 plural |
| `static/favourites.js` | 62 | 49 | 305 | 33 string, 21 html text, 6 plural |
| `static/artists.js` | 49 | 42 | 197 | 20 string, 19 html text, 6 plural |
| `static/album.js` | 47 | 46 | 144 | 16 string, 16 html text, 13 attr |
| `static/tracks.js` | 25 | 25 | 92 | 12 html text, 9 string, 2 attr |
| `static/overview.js` | 99 | 88 | 291 | 74 string, 23 html text, 2 plural |
| `static/service-status.js` | 30 | 28 | 137 | 19 string, 11 html text |
| `static/updates.js` | 20 | 20 | 153 | 12 html text, 8 string |
| `static/album-guide.js` | 54 | 54 | 299 | 36 string, 15 html text, 2 plural |
| `static/album-info.js` | 12 | 12 | 72 | 6 string, 6 html text |
| `static/lookup.js` | 100 | 94 | 942 | 79 html text, 14 string, 5 attr |
| `static/artwork.js` | 61 | 60 | 260 | 37 string, 19 html text, 5 attr |
| `static/credits.js` | 32 | 31 | 152 | 21 string, 8 html text, 3 attr |
| `static/genres.js` | 19 | 17 | 90 | 14 string, 3 attr, 2 plural |
| `static/trash.js` | 133 | 117 | 725 | 58 html text, 55 string, 14 plural |
| `static/cleanup.js` | 67 | 67 | 422 | 38 html text, 29 string |
| `static/year-review.js` | 57 | 53 | 401 | 28 html text, 21 string, 8 plural |
| `static/album-merge.js` | 45 | 41 | 310 | 24 html text, 16 string, 4 plural |
| `static/playlist-import.js` | 189 | 170 | 1,136 | 93 html text, 75 string, 20 plural |
| `static/collections.js` | 124 | 108 | 612 | 62 string, 45 html text, 12 plural |
| `static/playlist-tools.js` | 96 | 81 | 325 | 42 html text, 34 string, 14 plural |
| `static/playlist-order.js` | 36 | 36 | 134 | 17 string, 13 html text, 4 attr |
| `static/tags.js` | 75 | 66 | 336 | 31 html text, 28 string, 8 attr |
| `static/player.js` | 65 | 59 | 300 | 55 string, 4 plural, 3 attr |
| `static/gapless.js` | 48 | 40 | 477 | 40 string, 8 html text |
| `static/queue-sync.js` | 28 | 27 | 147 | 17 html text, 11 string |
| `static/playback.js` | 21 | 19 | 146 | 20 string, 1 html text |
| `static/gapless-controls.js` | 11 | 11 | 20 | 11 string |
| `static/gapless-diagnostics.js` | 9 | 9 | 100 | 5 html text, 4 string |
| `static/visualizer.js` | 9 | 9 | 80 | 6 string, 3 html text |
| `static/mini-player.js` | 8 | 8 | 35 | 8 string |
| `static/lyrics-import.js` | 68 | 65 | 362 | 46 string, 16 html text, 4 attr |
| `static/lyrics.js` | 42 | 35 | 232 | 26 string, 13 html text, 3 attr |
| `static/playback-lyrics.js` | 27 | 26 | 254 | 18 string, 9 html text |
| `static/uploads.js` | 93 | 88 | 561 | 50 string, 39 html text, 2 attr |
| `static/downloads.js` | 69 | 66 | 378 | 42 html text, 22 string, 3 plural |
| `static/metadata-export.js` | 20 | 20 | 185 | 12 html text, 8 string |
| `static/sign-in.js` | 14 | 14 | 102 | 8 string, 6 html text |
| `static/mini-player/index.html` | 18 | 13 | 45 | 15 attr, 3 html text |
| `static/mini-player/view.js` | 13 | 13 | 43 | 13 string |
| `electron/main.cjs` | 22 | 22 | 139 | 22 string |
| `electron/sign-in.cjs` | 8 | 5 | 26 | 8 string |
| `electron/upload-picker.cjs` | 7 | 7 | 33 | 7 string |
| `electron/backend.cjs` | 7 | 7 | 57 | 7 string |
| `electron/mini-player.cjs` | 2 | 2 | 24 | 2 string |
| `electron/help-menu.cjs` | 1 | 1 | 2 | 1 string (plus 3 labels classified as product names: "Tagcast Website", "Tagcast on Reddit", "Tagcast on GitHub") |

Not listed: `gapless-media.js` (25 FLAC/MP3 parser diagnostics) and the Electron test
harnesses `smoke.cjs`, `sign-in-smoke.cjs`, `mini-smoke.cjs`, `theme-smoke.cjs` and
`mini-visual.cjs`.

### 2.4 Python backend (Measured)

`app.py` lines 76 to 90 map exceptions straight to JSON: `ConflictError` becomes 409,
`NotConnected` 401, retry errors 429 and `ApiError`, `LibraryError`, `ArtworkError` or
`SourceError` 400. The body is always `{"error": str(error)}`. The frontend's single
`api()` helper (`app.js` lines 1292 to 1303) turns that into `Error(data.error)`. It has
109 call sites and 147 places read `error.message`.

| Python module | User-facing messages | Unique | Words | Most common exception classes |
|---|---:|---:|---:|---|
| `client.py` | 90 | 77 | 691 | ApiError 64, NotConnected 10, ConflictError 9 |
| `collections.py` | 86 | 70 | 703 | LibraryError 64, ConflictError 22 |
| `playlist_import.py` | 53 | 48 | 473 | LibraryError 43, ConflictError 10 |
| `library.py` | 52 | 48 | 419 | LibraryError 48, ConflictError 4 |
| `lyrics.py` | 42 | 38 | 352 | ConflictError 21, LibraryError 20, SourceError 1 |
| `cleanup.py` | 38 | 34 | 315 | LibraryError 38 |
| `downloads.py` | 32 | 29 | 231 | LibraryError 14, ConflictError 7, TerminalTransferError 5 |
| `playback_lyrics.py` | 32 | 27 | 193 | SourceError 28, LibraryError 2, ConflictError 2 |
| `playlist_sources.py` | 28 | 27 | 313 | LibraryError 28 |
| `tags.py` | 28 | 27 | 231 | LibraryError 23, ConflictError 5 |
| `download_engine.py` | 27 | 25 | 230 | Fail 14, ServiceError 13 |
| `uploads.py` | 24 | 22 | 169 | FileChanged 10, UploadError 7, UncertainUpload 3 |
| `queue_sync.py` | 19 | 19 | 131 | LibraryError 19 |
| `album_merge.py` | 18 | 17 | 165 | LibraryError 10, ConflictError 8 |
| `sources.py` | 18 | 15 | 103 | SourceError 18 |
| `duplicate_cleanup.py` | 17 | 14 | 133 | LibraryError 17 |
| `album_guide.py` | 15 | 15 | 131 | ConflictError 8, LibraryError 7 |
| `artwork.py` | 13 | 11 | 83 | ArtworkError 13 |
| `music_uploads.py` | 13 | 13 | 97 | LibraryError 7, ConflictError 5, UploadError 1 |
| `year_review.py` | 12 | 11 | 111 | LibraryError 8, ConflictError 4 |
| `album_info.py` | 10 | 7 | 96 | ConflictError 7, LibraryError 3 |
| `metadata_export.py` | 9 | 9 | 72 | LibraryError 7, ConflictError 2 |
| `artist_bios.py` | 6 | 4 | 54 | LibraryError 3, ConflictError 3 |
| `playlist_import_store.py` | 5 | 5 | 64 | LibraryError 4, ConflictError 1 |
| `app.py` | 3 | 3 | 7 | ApiError 3 |
| **Total (25 modules)** | **690** | **595** | **5,567** | |

A keyword heuristic over these messages finds 203 that describe stale or changed state
("Reload", "again", "changed", "expired"), 58 that describe limits, about 30 about network,
provider or permission problems and 57 that look like defensive request validation
("Invalid", "Choose a valid"). **Estimate:** 200 to 300 messages are plausibly seen in
normal use. The rest mostly guard against stale tabs or malformed requests.

Other Python text:

- 37 display texts in payloads. Examples: lookup notes in `sources.py` such as "Original
  release", duplicate reasons in `duplicate_cleanup.py` lines 29 to 36, download notes in
  `download_engine.py` such as "network error ({})" and the cleanup title "Disc {}".
- 11 Tk launcher strings in `desktop.py`.
- 25 logging calls and 10 argparse help texts. These stay English.

### 2.5 Structural patterns that affect translation (Measured)

| Pattern | Count | Why it matters |
|---|---:|---|
| `toLocaleString("en")`, `toLocaleTimeString("en-GB")` and similar | 45 | Hardcoded English number and time formats (`overview.js` line 7, `service-status.js` line 15, `album-info.js` line 62, `artists.js` line 75) |
| English plural ternaries (`=== 1 ?`) | 80 (153 branches) | Wrong for French (0 is singular), Spanish and French "many" and Japanese (no plural) |
| Sentence fragments | 382 (255 unique) | Word order differs per language |
| Messages with interpolated values | 421 | Need named placeholders |
| Inline markup inside sentences | `<strong>` 60, `<a` 20, `<br>` 3, `<code>` 2 | Need rich-text placeholders, not split strings |
| Top-level label tables evaluated at load time | 18 tables, about 426 strings | Examples: `HELP_TOPICS`, `SETTINGS_CATEGORIES`, `SIDEBAR_ITEMS`, `browseKinds`, `libraryLoadingMessages`, `themeRoleLabels`, `creditRoleLabels`. They must resolve lazily for runtime switching. |
| `innerHTML =` assignments | 181 | XSS-sensitive sinks for translated text |
| HTML template literals | 510 | Text and attributes must be escaped consistently |
| `escapeHtml(` calls | 535 | Existing escaping discipline to preserve |
| Separator `" · "` | 309 | Japanese and other languages may prefer different separators |
| Directional arrows in text (`→ ← ↓ ↗`) | 890 | Need review for future RTL |
| Hand-written uppercase eyebrows ("REVIEW ALBUM MERGE", "iBROADCAST LABELS") | about 24 | Translators must supply uppercase. CSS uppercasing would break "iBroadcast". |
| Labels derived from keys | `fieldLabel()` in `app.js` line 1028 capitalizes API field names | Must become an explicit key-to-message map |
| Delimiter-packed tooltip | `overview.js` lines 180 and 210 pack `name|value` into `data-tip` and split on `|` | A translation containing `|` would break it |
| Native `confirm()` | 13 | OK and Cancel buttons follow the OS or Chromium locale, not Tagcast's |
| Electron native dialogs | 7 call sites | Main process needs its own catalog |
| `localeCompare()` without a locale | 24 | Uses the runtime default locale today. Must not start following the UI language by accident. |
| `toLocaleLowerCase()` without a locale | 28 | Same, used in search and matching (`tracks.js` line 12, `app.js` line 144) |
| Global identifier `t` | 501 identifiers, 121 functions with a parameter named `t` | A global `t()` translation function would be shadowed all over the code |
| CSS physical direction properties | 124, versus 2 logical | Cost indicator for a future RTL language |
| CSS fixed widths, min-widths and nowrap or ellipsis rules | 237, 39 and 27 | Text expansion hot spots |

### 2.6 Secondary surfaces that are easy to miss

- Document titles: `index.html` `<title>`, the mini page `<title>`, the sign-in popup title
  (`sign-in.js` line 25) and Electron `BrowserWindow` titles.
- Electron: application menu (`main.cjs` lines 83 to 94, role-based items), Help menu
  (`help-menu.cjs`), About panel copyright, close confirmation (`main.cjs` line 72), five
  error boxes, file picker titles and filters (`upload-picker.cjs`) and backend start-up
  errors shown through `showErrorBox` (`backend.cjs`).
- Mini Player: static ARIA labels and titles, runtime labels in `view.js` and the
  `status`, `title` and `artist` placeholder text produced by the owner
  (`mini-player.js` lines 19 and 25).
- `aria-valuetext` such as "{} of {}" on sliders and screen-reader labels with metadata
  such as "Play {title}".
- Toast durations scale with character count (`app.js` line 235). That's still fine for
  Japanese because of the six-second minimum.
- Humorous loading messages (`app.js` line 49): eight jokes that need transcreation, not
  literal translation.
- OAuth error descriptions passed back in `?auth_error=` (`app.py` line 383) come from
  iBroadcast. They're external text.
- `send_error(403, "Open Tagcast via http://127.0.0.1")` is a plain HTTP error page.
- The Tk launcher and the CLI.

### 2.7 Strings that must not be translated

| Category | Examples and evidence | Rule |
|---|---|---|
| Music and account metadata | Artist names, album titles, track titles, genres, iBroadcast tags, playlist names, lyrics, ratings | Never translated, never transformed. Passed only as placeholder values. |
| Sentinels that the server injects into data | `library.py` line 316 returns "Various Artists" for ID 0 and line 317 "Unknown artist". Lines 393, 419, 486, 612, 616 and 832 substitute "Untitled album" or "Untitled track". Line 554 uses these values in the disc-set grouping key. `album_guide.py` line 141 and `album_info.py` line 117 compare a browser-supplied name with the placeholder. | Stay English inside data. Translate only at render time, and only where an explicit flag says the value is a placeholder. |
| "Various Artists" as both reserved ID and stored name | `app.js` lines 663, 861, 973 and 1007 to 1008, `lookup.js` line 126, `library.py` lines 875, 961 to 1048, `cleanup.py` line 133, `metadata_export.py` line 121, `downloads.py` line 73 | Keep "Various Artists" as an untranslated term everywhere in phases 1 to 4 |
| File and folder naming | `download_engine.py` lines 221 and 224 ("Unknown Artist", "Unknown Album"). `DEFAULT_LAYOUT` at line 35 uses `{albumartist}/{album} ({year})/{disctrack} {title}`. | Never translated. A translated fallback folder would break resume and create duplicates. |
| Persisted payloads | History entries in `localStorage` key `tagcast-history` and the export format `tagcast-history` version 2 (`app.js` lines 1239 to 1241). Pseudo-fields such as `{trash: {before: "In your library", after: "In the trash"}}` (`trash.js` lines 76 and 414). Change labels with `" · Disc N"` (`app.js` line 1005). `before_name` "Various Artists (named artist)" (`app.js` line 1007). Saved `error` strings. | Stored text stays as written. New UI text must never be written into stored values. |
| Server-stored reports and notes | `cleanup.json`, `duplicate-cleanup.json` reasons, `.ibfetch.json` download notes, CSV import checkpoints | Stay English on disk |
| Data formats | CSV export marker "# Tagcast playlist CSV 1: escaped text" (`playlist_import.py` line 25), metadata export columns (`metadata_export.py` line 26), theme JSON `format: "tagcast-theme"` | Never translated |
| Identifiers | Status codes (`saved`, `sent`, `blocked`, `unverified`, `failed`, `not_sent`, `preview_only`), credit role IDs, `<option value>` codes (every option has an explicit value), stream quality codes (`orig`, `96` to `320`), hash routes, API paths, `localStorage` keys, settings keys, CSS classes, `data-*` attributes, event names, keyboard key names, accelerators like `CmdOrCtrl+Shift+M` | Never translated |
| Download layout tokens | `{albumartist}`, `{album}`, `{year}`, `{disc}`, `{track}`, `{disctrack}`, `{title}`, `{artist}` (`downloads.js` line 21) | Inserted as placeholder values so they can't clash with message syntax |
| Product, service and format names | Tagcast, iBroadcast, "Powered by iBroadcast" (an SVG), Premium, Last.fm, TheAudioDB, LRCLIB, Unison, Deezer, ListenBrainz, Discogs, Wikipedia, GitHub, Reddit, Homebrew, FLAC, MP3, LRC, CSV, JSON, ZIP, kbps | Kept as is |
| External content | TheAudioDB biographies and album text (cached in English by design), Wikipedia 1001 Albums excerpts, lyrics, iBroadcast service status incidents, provider suggestions, Deezer and ListenBrainz playlist data, OAuth error descriptions | Displayed as received with source attribution. Only the surrounding UI is translated. |
| Demo and sample content | `demoLibrary()` in `app.js` lines 127 to 140, theme preview sample titles (`theme-editor.js` line 33) | Kept as sample metadata |
| Diagnostics and logs | Gapless diagnostics, `tagcast-playback-diagnostics.json`, `tagcast.log`, logging calls, CLI help | English, for support |

### 2.8 String churn (Measured)

The same extractor was run on earlier tags. These counts include demo and product strings,
so they're slightly higher than the totals above.

| Version | Date | Unique texts | Added | Removed | Words added |
|---|---|---:|---:|---:|---:|
| v0.70.0 | 18 Oct 2026 | 1,820 | | | |
| v0.80.0 | 23 Oct 2026 | 2,135 | 362 | 47 | 3,833 |
| v1.0.0 | 27 Oct 2026 | 2,381 | 266 | 20 | 2,616 |
| v1.2.0 | 31 Oct 2026 | 2,705 | 347 | 23 | 3,085 |
| `c47f2e0` (1.3.0 code) | 2 Nov 2026 | 2,750 | 50 | 5 | 760 |

At this pace each language would need roughly 5,000 words of new review per week. That
cost is the main driver of long-term maintenance.

---

## 3. Recommended architecture

### 3.1 Constraints from the code base

- `AGENTS.md`: no new frontend framework or build step without approval. All scripts share
  one global scope with unique top-level names (`tests/test_static.py`). Script order in
  `index.html` matters. Live boot starts on `DOMContentLoaded` (`app.js` line 1288,
  `lookup.js` line 296).
- `tools/bundle_check.py` (`page_scripts`) and `tests/test_static.py` require every
  top-level `static/*.js` to be loaded exactly once by `index.html`, and vice versa. A
  script in a subfolder would fail `bundle_check`.
- Electron builds its CSP once at start-up and hashes the inline scripts of the served page
  (`security.cjs` lines 25 to 30). The HTML must stay static, so no server-rendered
  per-language pages.
- The main window CSP allows `connect-src 'self'`, so JSON catalogs can be fetched. The
  Mini Player has `connect-src 'none'` and a separate partition `tagcast-mini`
  (`mini-player.cjs` lines 45 and 54), so it can't fetch catalogs or share `localStorage`
  with the main window.
- The local server marks `.html`, `.js` and `.css` as `no-store` (`app.py` lines 100 to
  103), but `.json` gets normal caching. A stale cached catalog would pair old translations
  with new keys.
- The frontend test harness loads exactly the scripts listed in `index.html` into a vm
  with a minimal DOM stand-in (`tests/frontend.test.cjs` lines 313 to 413). At least 150
  assertions compare English UI text.
- There's a precedent for lazily fetched JSON (`album-guide.js` line 92 loads
  `/1001-album-notes.json`) and for synchronous pre-paint scripts (`themes.js` in `<head>`).
- There's a precedent for an immediate server-stored UI preference that survives ports and
  browsers: `guide_matching_details` (`client.py` lines 1165, 1188 and 1233 to 1234).
- There's a precedent for generated, checked-in assets: `tools/build_dark_css.py` builds
  `dark.css` and the tests check that it's current.

### 3.2 Option A versus Option B

| Criterion | Option A: native module plus JSON catalogs | Option B: i18next 26.7.1 (UMD) |
|---|---|---|
| Implementation complexity | About 250 to 350 lines of own code: lookup, ICU subset parser, `Intl.PluralRules`, formatters, static DOM pass, pseudo-locale | Configuration plus glue for escaping, static HTML, the Mini Player and Electron. The core is ready-made. |
| Dependencies | None | Vendored `i18next.min.js`. ICU syntax needs `i18next-icu` as well. A license notice and a manual update process are needed because there's no frontend package manager. |
| Size and start-up (Measured on the npm packages) | Estimated 8 to 12 KB unminified | `i18next.min.js` 50,269 bytes (15.7 KB gzipped). `i18nextICU.min.js` adds 41,670 bytes. The local server doesn't compress and serves scripts as `no-store`, so the browser parses about 50 to 92 KB more on every launch. |
| Translation maintenance | Flat JSON with ICU messages. Weblate, Crowdin and Lokalise support this format. | Strong tooling (i18next-parser, platform support). Default syntax is `{{var}}` with `_one` and `_other` key suffixes unless the ICU plugin is used. |
| Plurals and interpolation | `Intl.PluralRules` (built in), named placeholders, `select` | Same underlying `Intl.PluralRules`, more features (context, nesting) |
| Runtime switching | Same: an event plus re-render of idle views | `changeLanguage()` plus the same re-render work. The library doesn't remove the hard part. |
| Electron and browser | Same code in both. The main process needs a small catalog either way. | Same |
| Escaping | Designed in from the start: plain text by default, explicit trusted fragments for markup | `escapeValue: true` escapes placeholders, which double-escapes with the existing `escapeHtml` pattern. It would need `escapeValue: false` plus discipline. |
| Testing | The same module runs in the vm harness and powers CI validation | Works in the harness. Validation needs extra tooling. |
| Long-term extensibility | Can migrate later because the catalog format is standard ICU JSON | More features than needed today |

### 3.3 Recommendation: Option A

1. Tagcast's hard problems are data boundaries, escaping, runtime switching and the Mini
   Player contract. A library doesn't solve any of them.
2. Everything i18next adds that Tagcast needs (plurals and number or date formatting) is
   already in `Intl`, which Electron 44 and current Chrome, Firefox and Safari ship with
   full locale data.
3. No vendoring, no license file, no update chore and no extra parse cost on every launch.
4. Choosing standard flat ICU JSON keeps the exit open. If Tagcast ever needs many
   languages or a translation platform, the catalogs can move to `intl-messageformat` or
   i18next with the ICU plugin without rewriting translations.

Other libraries considered: Mozilla Fluent handles grammatical features well but has
weaker tooling and less familiarity for AI-assisted drafting. `@messageformat/core`
offers nothing that the subset below lacks.

### 3.4 Runtime design

**Files**

- `static/i18n.js`: the runtime. It's loaded synchronously in `<head>` right after
  `themes.js`, sets `<html lang dir>` before first paint and starts fetching the selected
  catalog.
- `static/i18n-en.js`: generated from `static/i18n/en.json` and the manifest by
  `tools/build_i18n.py`, with a `--check` mode tested like `dark.css`. It keeps English
  available synchronously for first paint, fallback and the test harness. It stays a
  top-level file so `bundle_check` and `test_static` need no changes.
- `static/i18n/<tag>.json`: translations, fetched on demand.

**Global names.** One object, `TagcastI18n`, plus two short functions that are unused
today: `msg()` for plain text and `msgHtml()` for HTML contexts. The name `t` is
deliberately avoided.

```js
// static/i18n.js (illustrative sketch)
"use strict";
const TagcastI18n = (() => {
  const english = globalThis.TagcastI18nEnglish;          // from i18n-en.js
  let active = {tag: "en", messages: english.messages, format: "en-GB", dir: "ltr"};
  const plurals = new Map();
  const missing = new Set();
  const trusted = new WeakSet();

  function lookup(key) {
    const text = active.messages[key] ?? english.messages[key];
    if (text === undefined && !missing.has(key)) { missing.add(key); console.warn(`Missing message: ${key}`); }
    return text ?? key;                                    // CI makes this unreachable in releases
  }
  function rules(tag) {
    if (!plurals.has(tag)) plurals.set(tag, new Intl.PluralRules(tag));
    return plurals.get(tag);
  }
  // render() implements the ICU subset: {name}, {n, plural, ...}, {x, select, ...} and '{' escapes.
  // `encode` escapes literal text and untrusted values for HTML; it's the identity for plain text.
  function format(key, params, encode) { /* parse once, cache, then render with rules(active.tag) */ }
  // Own copy, so the <head> script doesn't depend on app.js loading first.
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

  return {
    msg: (key, params = {}) => format(key, params, value => String(value)),
    msgHtml: (key, params = {}) => format(key, params, value => trusted.has(value) ? value.html : escape(value)),
    html: fragment => { const value = {html: String(fragment)}; trusted.add(value); return value; },
    get tag() { return active.tag; },
    // load(tag), activate(tag), translateStatic(root), number(n), dateOnly(iso), dateTime(iso), bytes(n), list(items)
  };
})();
const msg = TagcastI18n.msg;
const msgHtml = TagcastI18n.msgHtml;
```

**Escaping rules**

- `msg()` returns plain text. Use it only with `textContent`, `setAttribute`, `title`,
  `toast()`, `confirm()` and IPC payloads.
- `msgHtml()` HTML-escapes the message text and every placeholder value, except values
  explicitly wrapped with `TagcastI18n.html()`. Translators can't inject markup, and
  metadata such as track titles is always escaped.
- Catalogs may not contain `<` or `>`. Inline emphasis uses placeholders filled with
  trusted fragments built by code.

```js
// Before (updates.js): text split around <strong>, English only
`<p>Tagcast <strong>${escapeHtml(latest)}</strong> is available. You are running ${escapeHtml(current)}.</p>`
// After
`<p>${msgHtml("updates.available", {latest: TagcastI18n.html(`<strong>${escapeHtml(latest)}</strong>`), current})}</p>`
// en.json: "updates.available": "Tagcast {latest} is available. You are running {current}."
```

**Formatting helpers** replace the 45 hardcoded calls:

- `TagcastI18n.number(n)` uses `Intl.NumberFormat(formatLocale)`. For English the format
  locale is `en-GB`, which produces the same digits as today's `toLocaleString("en")` and
  the same dates as today's `en-GB` calls, so English output doesn't change.
- `TagcastI18n.dateOnly("2026-03-01")` formats with `timeZone: "UTC"`. A date-only value
  parsed as UTC midnight shows as the previous day west of UTC (measured: `2/28/2026` in
  `America/Los_Angeles`), and AGENTS.md forbids inventing time zones for `uploaded_on`.
  `uploaded_at` values without a zone are formatted as floating wall-clock time the same
  way.
- `TagcastI18n.bytes(n)` keeps the existing decimal steps (`overview.js` line 9) but takes
  unit labels from the catalog. English keeps "KB" (Intl would print "kB"). French gets
  "Ko", "Mo" and "Go".
- Track durations (`3:45`, `1:02:03`) stay as they are. Clock notation is universal.
- Stream qualities stay "MP3 · 320 kbps". Intl would print "320 kb/s".

**Static HTML.** Elements get `data-i18n="key"` and, where needed,
`data-i18n-attr="aria-label=key;title=key"`. The pass only replaces an element's own first
non-empty text node and named attributes, so no wrapper spans are added and existing CSS
selectors keep working. The English text stays in `index.html`, so first paint, no-JS
loading and the test harness are unchanged. A CI test checks that the text in `index.html`
equals `en.json[key]`.

**Boot sequence**

1. `i18n.js` reads the cached choice from `localStorage` (`tagcast-language`) and resolves
   it (section 5.3).
2. For English it does nothing else. Boot stays synchronous so behaviour is byte-identical.
3. For another language it marks `<html data-i18n="loading">`, sets `lang` and `dir`
   immediately and starts `fetch("/i18n/<tag>.json")`.
4. The existing `DOMContentLoaded` boot waits for that promise, with a 1,500 ms ceiling.
   On a timeout or invalid catalog it continues in English and shows a non-blocking toast.
5. A CSS rule hides the body while `data-i18n="loading"`, which prevents a flash of
   English. Electron's `ready-to-show` still fires because the window paints its
   background.
6. The server must serve `static/i18n/*.json` with `Cache-Control: no-store`. The suffix
   check in `app.py` line 103 has to cover that folder (Phase 1a).

### 3.5 Electron main process and Mini Player

**Main process**

- Add `electron/locales/<tag>.json` (about 70 strings including the role labels) and a
  helper `electron/i18n.cjs`. Add the folder to `build.files` in `electron/package.json`.
  The main process can't use the web catalogs because start-up errors can occur before the
  local server exists.
- Expand `role: "editMenu"` and `role: "windowMenu"` into explicit items and give every
  role item a `label`. Electron doesn't localize role labels. Signal Desktop had to do the
  same.
- Add one narrow, validated IPC channel to the existing `player-preload.cjs`, for example
  `tagcastInterface.language(tag)`. The main process checks the sender the way
  `mini-player.cjs` does (`fromOwner`), accepts only supported tags, rebuilds the menu,
  updates the About panel and writes `userData/interface.json` atomically, like
  `mini-player.json`. That cached value is used at the next start-up, before the server is
  ready.
- Don't set Chromium's `--lang` switch. It would also change `navigator.language` and the
  default collation behind the 24 `localeCompare()` calls, which would silently change sort
  order. Native `confirm()` buttons and file dialogs therefore keep the OS language.

```js
// electron/main.cjs (sketch)
const l = key => mainMessage(language, key);   // language comes from userData/interface.json, then IPC
{label: l("menu.edit"), submenu: [
  {role: "undo", label: l("menu.edit.undo")}, {role: "redo", label: l("menu.edit.redo")}, {type: "separator"},
  {role: "cut", label: l("menu.edit.cut")}, {role: "copy", label: l("menu.edit.copy")},
  {role: "paste", label: l("menu.edit.paste")}, {role: "selectAll", label: l("menu.edit.selectAll")}]}
```

**Mini Player**

The Mini Player stays passive. The owner window already sends a sanitized presentation
snapshot every 250 ms (`mini-player.js`, `mini-contract.cjs`). Extend that contract:

- `language`: an allowlisted tag, applied to `<html lang dir>` in the mini page.
- `labels`: a fixed set of about 15 keys (play, pause, previous, next, seek, pin, unpin,
  open Tagcast, window title and so on). Each value is a string capped at 120 characters.
  `snapshot()` drops unknown keys.
- `idle: true` instead of sending "Nothing playing" in the `title` field. Today the same
  field carries either a track title or an English placeholder (`mini-player.js` line 19).
  After the change, metadata fields only ever carry metadata.

The Mini Player therefore always follows the main window's language, with no catalogs, no
storage and no new permissions. Its static English text is visible only until the first
snapshot arrives, which happens on `mini:ready`.

### 3.6 Python messages

Phases 1 to 3 keep Python messages in English. The server never learns the UI language.
There's no per-request locale and no translation in background jobs. English stays the
language of logs, tests, persisted reports and history entries.

An optional later track adds machine-readable codes to the messages that users actually
see:

```python
class ApiError(Exception):
    def __init__(self, message, *, code=None, **params):
        super().__init__(message)          # English stays the canonical text
        self.code, self.params = code, params

# app.py _run
payload = {"error": str(error)}
if getattr(error, "code", None):
    payload.update(code=error.code, params=error.params)   # plain strings and numbers only
```

The frontend's `api()` keeps `error.message` and adds `error.code` and `error.params`.
A helper `errorText(error)` uses `msg("server." + code, params)` when the active catalog has
that key and falls back to the English message otherwise. Call sites that already add
context ("Could not load the overview: {error}") get that frame translated right away, even
while the detail stays English.

---

## 4. Proposed file and translation-key structure

### 4.1 Layout

```text
src/tagcast/static/
  i18n.js                  runtime (new, sync in <head>)
  i18n-en.js               generated English bundle plus manifest (new, checked in)
  i18n/
    manifest.json          supported languages, endonyms, direction, status, format locale
    en.json                English source of truth
    nl.json  de.json  fr.json  es.json  ja.json
electron/
  i18n.cjs                 main-process lookup
  locales/en.json  nl.json  de.json  fr.json  es.json  ja.json
i18n/                      not shipped
  notes.en.json            translator context per key: meaning, max length, screen, glossary terms
  state/<tag>.json         per key: sha of the English source when translated, review status, reviewer, date
tools/
  build_i18n.py            en.json and manifest to i18n-en.js (with --check)
  i18n_report.py           coverage, stale keys and words to review, per language
tests/
  i18n.test.cjs            catalog validation and runtime tests (picked up by node --test tests/*.test.cjs)
  test_i18n.py             server setting validation, manifest, packaging and no-store
```

### 4.2 Catalog and message syntax

Flat keys, sorted alphabetically (CI enforces the order for clean diffs). Values use an ICU
MessageFormat subset: `{name}`, `{count, plural, ...}` with `#`, `=0` or `=1` and the CLDR
categories, `{value, select, ...}` and apostrophe escapes for literal braces. No HTML.

```json
{
  "albums.results.inCollection": "{count, plural, one {# album in your collection} other {# albums in your collection}}",
  "albums.results.byArtist": "{count, plural, one {# album by {artist}} other {# albums by {artist}}}",
  "common.pagination": "Page {page} of {pages}",
  "downloads.layout.fields": "Fields: {tokens}",
  "help.uploads.prepare.text": "Enable Music uploads under Settings → Data & exports, save, and reconnect once to approve upload permission.",
  "history.trash.before": "In your library",
  "player.seekIn": "Seek in {title}",
  "review.status.saved": "Saved"
}
```

```json
{
  "albums.results.inCollection": "{count, plural, other {コレクション内のアルバム #枚}}",
  "player.seekIn": "「{title}」の再生位置を変更"
}
```

The examples show why sentence assembly has to go. Today `app.js` line 589 builds
`"N albums" + (" by X" or " in your collection")`. Word order and counters differ in
Japanese, so each variant becomes one message.

### 4.3 Key conventions

- Namespace by feature, matching the components in section 2.2: `common`, `nav`,
  `settings`, `appearance`, `help`, `browse`, `albums`, `artists`, `tracks`, `favourites`,
  `overview`, `status`, `updates`, `guide`, `editor`, `review`, `history`, `credits`,
  `genres`, `lookup`, `artwork`, `cleanup`, `years`, `trash`, `merge`, `playlists`,
  `import`, `tags`, `player`, `output`, `gapless`, `visualizer`, `queueSync`, `lyrics`,
  `downloads`, `uploads`, `export`, `signIn`, `mini`, `server`, `menu`, `dialog`.
- Keys describe meaning, not wording: `review.apply` rather than `review.applyChanges`.
  Wording can then change without a new key, and the source hash marks the translation as
  stale.
- One key per complete sentence or label. No keys for fragments like `common.by`.
- Shared keys only in `common.*`, and only when the meaning is truly identical in every
  language. "Cancel" in a dialog footer can be shared. "Play" as a verb and "Play" in a
  noun phrase can't.
- Help tours: `help.<topic>.<step>.title` and `help.<topic>.<step>.text`.
- Server codes: `server.<code>`, for example `server.libraryChanged`.
- Optional humour: `library.loading.joke.1` to `.8`. A language may leave them out. The
  runtime then shows the neutral loading text instead of falling back to English jokes.
- Placeholder names are semantic (`{artist}`, `{count}`, `{title}`) and identical across
  languages. CI enforces that.

### 4.4 Developer rules (to add to AGENTS.md in Phase 1a)

1. Every new user-visible string goes through `msg()`, `msgHtml()` or `data-i18n` in
   static HTML.
2. Never build sentences by concatenation. Never pluralize with `=== 1`.
3. Never translate, store or send a UI label as a data value. Store codes and render
   labels at display time.
4. Never pass the UI language to `localeCompare`, `toLocaleLowerCase`, `Intl.Collator` or
   any matching, grouping, sorting or naming code.
5. Format numbers, dates and sizes only through `TagcastI18n` helpers.
6. Insert translated text into HTML only through `msgHtml()`.
7. A pull request that adds strings also adds `notes.en.json` context for them.

---

## 5. Language selection and persistence

### 5.1 User interface

- Place a "Language" section first under Settings → Interface. The `interface` category
  is already the "Immediate preferences" category (`settings.js` line 5,
  `lookup.js` line 149).
- Use a `<select>` without a `name` attribute so it stays out of `settingsFormSnapshot()`
  (`settings.js` line 16) and never marks the server settings form as dirty. That's the
  same approach as the existing `apply-track-year-default` checkbox.
- Options:
  - "Automatic (System language: Deutsch)"
  - "English"
  - Each translated language by its endonym from the manifest: Nederlands, Deutsch,
    Français, Español and 日本語.
  - Preview languages labelled "(preview)".
- Mode label: "Immediate · all browsers and the app on this computer".
- Hide the section until the manifest lists at least two languages.

### 5.2 Storage

| Store | Purpose |
|---|---|
| Server `config.json` key `interface_language` (`"auto"` or a supported tag) | Source of truth. It's shared by every browser, every port and the Electron profile. `localStorage` alone would split here: Electron uses the `persist:tagcast` partition and a different port is a different origin. Validated against the manifest in `save_settings()`, following the `guide_matching_details` pattern. |
| `localStorage` `tagcast-language` | Pre-paint cache only. Reconciled with the server value after boot. |
| Electron `userData/interface.json` | Language for menus and dialogs before the server is ready |
| Mini Player | Nothing. It follows the snapshot. |

### 5.3 Resolution

```js
function resolveLanguage(choice, manifest, navigatorLanguages = []) {
  const supported = new Map(manifest.languages.map(l => [l.tag.toLowerCase(), l]));
  if (choice && choice !== "auto") return supported.has(choice.toLowerCase()) ? choice : "en";
  for (const wanted of navigatorLanguages) {
    const exact = supported.get(wanted.toLowerCase());
    const base = [...supported.values()].find(l => l.tag.split("-")[0] === wanted.split("-")[0].toLowerCase());
    const hit = exact || base;
    if (hit && hit.status === "complete") return hit.tag;   // automatic choice never picks a preview language
  }
  return "en";
}
```

- Manual selection always wins.
- Automatic uses `navigator.languages`. The vm harness passes an empty navigator, which
  falls through to English. In Electron, `navigator.languages` reflects the OS language.
- Automatic only picks languages whose status is `complete`. Users can still select a
  preview language by hand.
- Unknown or removed tags fall back to English without an error.
- Recommended default: `"en"` until the first language reaches `complete`, then `"auto"`
  for profiles that never chose. That way existing users don't suddenly see a preview
  translation.

### 5.4 Switching at runtime, without a reload

A reload would destroy the audio element, the in-memory queue and open drafts. The plan
therefore switches in place and accepts that some open views update when they're next
opened.

```js
async function chooseInterfaceLanguage(choice) {
  const tag = resolveLanguage(choice, TagcastI18n.manifest, navigator.languages || []);
  await TagcastI18n.load(tag);                 // fetch and validate; on failure stay on the current language
  TagcastI18n.activate(tag);                   // <html lang dir>, formatters, plural rules
  TagcastI18n.translateStatic(document);       // only [data-i18n] nodes: text nodes and attributes
  document.dispatchEvent(new Event("tagcast-language-change"));   // like "tagcast-theme-change"
  rememberLanguage(choice);                    // localStorage cache, server setting, Electron IPC
}
```

What updates immediately:

- The static skeleton: sidebar, page headings, player controls and `aria-label`s.
- The Settings page itself, if it has no pending server changes. When
  `settingsView.dirty` is true, the form isn't re-rendered (re-rendering would discard the
  pending edits, as the Discard button does). A short note says the page updates after
  Save or Discard.
- The current browse page, if no dialog is open. It re-renders through its normal render
  function.
- The Mini Player, within 250 ms.
- Electron menus.

What waits until it's next opened:

- Any open `<dialog>`, including the metadata editor and review. Their DOM holds drafts and
  must not be rebuilt.
- Open help tours. They close on language change, as they already close on navigation.
- Toasts that are already showing.

Guaranteed by tests (section 7):

- No `api()` call other than the single settings POST for `interface_language`.
- No change to `audio.src`, `player.queue`, `player.index`, the paused state,
  `state.history`, editor or review DOM inputs, `location.hash` or browser history.

### 5.5 Fallback behaviour

| Situation | Result |
|---|---|
| Key missing in the selected language | English text for that key. Development builds log once. |
| Catalog fails to load or is invalid | Whole UI in English, toast once, preference kept |
| Placeholder missing in a translation | CI fails. At runtime the English message is used for that key. |
| Unsupported stored tag | English |
| Older server without `interface_language` | `localStorage` value only, like the `guide_matching_details` fallback |

---

## 6. Translation boundaries and metadata protections

### 6.1 Principles

1. Translation is a pure presentation step at the last moment of rendering. Nothing
   translated is ever compared, stored, sent to the server, written to iBroadcast or used
   to build a file name.
2. Values cross every boundary as codes or raw metadata. Labels are looked up from codes.
3. Where the server currently mixes a placeholder into a value, the placeholder stays
   English until an explicit flag exists.

### 6.2 Hazards and required handling

| Hazard | Where | Handling |
|---|---|---|
| Field labels derived from API keys | `app.js` line 1028 (`fieldLabel`) | Explicit map from field key to message key |
| "Empty" shown where a value would be | `app.js` line 1027 | Render as a styled placeholder element, not as a value |
| Placeholder "Various Artists" for ID 0 in the review | `app.js` line 1029, plus `before_name` and `after_name` at lines 1007 to 1008 | Keep the term "Various Artists". Store nothing new. |
| Change label with `" · Disc N"` suffix | `app.js` lines 1005 and 1010, echoed by the server (`client.py` line 1071, `library.py` line 1176) and kept in History | Leave the stored English label for compatibility. Add a separate `disc` number to new entries and render the suffix at display time. |
| Trash pseudo-field values | `trash.js` lines 76 and 414 | Keep the stored values. At render time, map the field key `trash` plus those two exact stored strings to messages. |
| Status codes | `statusPill()` in `app.js` line 1310 already maps codes to labels | Same pattern, with labels from the catalog |
| Browse labels built on the server | `library.py` line 682 ("Unknown year", `"{value}s"` for decades), searched and sorted on the server (lines 725 to 737) | Frontend renders labels from `key`: year `0` means unknown, decade `1980`. Server search keeps matching English labels. That's a documented limitation for the Unknown year card only. |
| "Unknown year" built in the browser | `browse.js` line 90, `year-review.js` line 8, `playlist-import.js` line 268 | Render from the year value, never stored |
| Placeholder titles in API data | `library.py` lines 393, 419, 486, 612 and 616 | Phase 1 to 4: show as is. Later and optional: add `name_missing: true` flags so the browser can translate the placeholder without touching data. |
| Grouping and identity checks on placeholders | `library.py` line 554, `album_guide.py` line 141, `album_info.py` line 117 | Server code unchanged. The browser must send back the value it received, never a displayed label. |
| Download fallback folder names | `download_engine.py` lines 221 and 224 | Never localized. Covered by a test. |
| Mini Player placeholders in metadata fields | `mini-player.js` line 19 | `idle` flag (section 3.5) |
| Tooltip packing with `|` | `overview.js` lines 180 and 210 | Two data attributes instead of one packed string |
| Native `<option>` values | All options have explicit `value` attributes (Measured: 0 without) | Keep it that way. Test it. |
| Comparisons against English UI text | None found that read `textContent` back for logic. The comparisons found are against metadata ("Various Artists") or codes. | A CI grep blocks `textContent ===` and similar patterns |

### 6.3 Sorting, matching and comparison semantics

- The 24 `localeCompare()` calls and 28 `toLocaleLowerCase()` calls keep their current
  form, without a locale argument. They follow the runtime default locale today, which is
  the browser or OS locale. Switching the Tagcast UI language must not change sort order,
  duplicate detection, title keys (`app.js` line 144), CSV matching or the shared
  Python/JavaScript duplicate contract.
- Python sorts and matches with `casefold()` and isn't affected.
- Collation that follows the UI language (for example kana ordering for Japanese album
  artists) can be a separate, explicit feature later.

### 6.4 Safe insertion

- Catalogs are data from the repository, but they're still treated as untrusted text.
  `msgHtml()` escapes message text and placeholders.
- CI rejects `<` and `>` in catalogs, unbalanced braces, unknown placeholders and control
  characters other than the no-break space (U+00A0) and narrow no-break space (U+202F),
  which French typography needs.
- A test renders every message with hostile placeholder values such as
  `<img src=x onerror=…>` and checks that the result contains no unescaped tag. That
  mirrors the stabilization fix `1ac2234` (NEW-FE-1) for the Overview streaming quality.

### 6.5 Guard tests against unintended writes

- With fetch mocked, switch language with live state, playback running, an open editor
  with a draft and an open review. Assert that exactly one request goes out
  (`POST /api/settings` with only `interface_language`) and nothing else changes.
- Python: `save_settings({"interface_language": ...})` changes only that key in
  `config.json` and doesn't disconnect queue sync or close uploads. Today
  `save_settings()` ends with `queue_sync.disconnect()` when queue sync is off and closes
  uploads when they're off. Both are no-ops when they're already off, but the test pins it.

---

## 7. Testing and CI strategy

### 7.1 Layers

| Layer | Where | What it proves |
|---|---|---|
| Catalog validation | `tests/i18n.test.cjs` (runs in the existing `node --test tests/*.test.cjs` step) | Valid JSON, sorted keys, no duplicate keys after normalization, keys exist in `en.json`, same placeholder set as English, every plural has `other` plus each category the language needs (`Intl.PluralRules(tag).resolvedOptions().pluralCategories`), parses with the runtime parser, no markup, uncommon characters, manifest consistency |
| Unused and missing keys | Same test, using a key scan of `static/**/*.js`, `index.html` `data-i18n*` and `electron/*.cjs` | Every key in code exists in English. Keys never referenced fail CI (allowlist for dynamic families such as `server.*`). |
| Runtime unit tests | Same file | Interpolation, plurals for en, nl, de, fr (0 is singular, "many"), es and ja (only `other`), select, escapes, English fallback per key, missing-key behaviour, `msgHtml` escaping, trusted fragments, formatters with UTC date-only values |
| English parity | Existing 627 Node tests plus Python tests, unchanged | Phase 1 changes no English output |
| Pseudo-locale scan | Harness runs main screens with `en-XA` (section 7.2) | Hardcoded strings and expansion problems |
| Switching behaviour | Harness | Section 6.5 guarantees, plus `<html lang>` and `dir`, plus `tagcast-language-change` re-render of idle views |
| Persistence | Harness and `tests/test_i18n.py` | `localStorage` cache, server value wins, validation, older-server fallback |
| Mini Player | `electron/tests/mini.test.cjs`, `tests/mini-player-view.test.cjs` | Contract sanitizes `language`, `labels` and `idle`. The view applies `lang` and labels. The `title` field never carries UI text. |
| Electron | `electron/tests/shell.test.cjs` and a new menu test | Menu labels for each language, the IPC sender check, the tag allowlist and `interface.json` |
| Packaging | `tools/bundle_check.py`, `tools/check_electron.py`, new checks | `i18n/*.json` served with `application/json` and `no-store`, `electron/locales` inside the asar, all manifest languages present |
| Data boundaries | Python and harness tests | Download fallback names, history storage and export format, server setting isolation |
| Layout (manual and semi-automatic) | Playwright screenshots in a later phase | Overflow at 1440 px, 1024 px, 760 px and 420 px in light and dark themes, per language and pseudo-locale |
| Accessibility | Harness plus a manual screen reader pass | Every translated `aria-label`, `title`, `placeholder`, `alt` and `aria-valuetext` resolves, `lang` updates |

### 7.2 Pseudo-localization

`en-XA` is generated at runtime from English, so no catalog file is needed. It's offered in
the selector only for source runs or when `TAGCAST_I18N_DEV=1` is set.

- Accented letters: "Album artists" becomes "Ȧŀƀŭḿ ȧřŧīşŧş".
- About 35% expansion with padding, which approximates German and French growth.
- Brackets mark each message, for example `⟦…⟧`. Text without brackets on a pseudo-locale
  screen is hardcoded. The harness scan collects all `textContent`, `innerHTML` text and
  translatable attributes after rendering each screen. Anything with Latin letters outside
  the brackets fails, minus an allowlist for fixture metadata and product names.
- A second mode, `ar-XB` style with `dir="rtl"`, can be added later to measure RTL readiness.

### 7.3 GitHub Actions

- Validation and unit tests run inside the existing Node step, on every OS and Python
  combination, at no extra configuration cost.
- `python3 tools/build_i18n.py --check` runs next to the existing `dark.css` check.
- `tools/i18n_report.py` writes a coverage table to the job summary: per language, the
  percentage of keys translated, keys stale because English changed (source sha mismatch)
  and words awaiting review. It doesn't fail the build.
- Gates:
  - Missing English keys, placeholder mismatches, invalid plurals and markup fail the
    build for every language.
  - Coverage below 100% never fails for a `preview` language.
  - A language marked `complete` fails below 98% translated or when a
    **safety-critical key** is stale or unreviewed. Safety-critical namespaces: `review`,
    `trash`, `merge`, `cleanup`, `uploads`, `downloads`, `history`, `server`, `dialog` and
    every `confirm()` message. In these namespaces an English fallback is better than an
    unreviewed translation.
- `tools/ci_scope.py` already treats changes outside its documentation allowlist as full
  CI, so catalog changes get full tests. This plan file is under `docs/` and only triggers
  documentation checks.

### 7.4 Manual QA matrix (Phase 2 and Phase 4)

macOS (Apple Silicon), Windows and Linux packaged apps, plus the browser version in Chrome,
Firefox and Safari.

Check for each language: Light, Dark and one custom theme; widths 1440, 1024, 760 and
420 px; Mini Player pinned and unpinned; a language switch during playback, with an open
editor draft, during a running download and during a lyrics import; Electron menus and the
close dialog; sign-in.

---

## 8. Translation workflow and glossary

### 8.1 Target languages: evidence and recommendation

| Language | Usage evidence (external, weak) | Complexity | Native reviewer | Recommendation |
|---|---|---|---|---|
| Dutch (`nl`) | None. The maintainer is Dutch and based in the Netherlands. | Medium: German-like compounds and expansion, a du/u choice | Available now | **Pilot language** |
| German (`de`) | Not in the top five of either estimate | Medium: about 20-35% expansion, compounds, noun capitalization, "Titel" means both track and title | Needed | First wave |
| French (`fr`) | Similarweb: 2.67% of visits | Medium: expansion, narrow no-break spaces, "Mo" and "Go" units, 0 is singular | Needed | First wave |
| Spanish (`es`) | None | Medium: pick neutral Spanish versus `es-419`, gender agreement in counts, "many" plural | Needed | First wave, lowest priority of the three |
| Japanese (`ja`) | Semrush: Japan 15.54% of September 2026 visits (second). Similarweb: not in the top five. | High: counters (曲, 枚), no plurals, politeness level, typography, fonts, line breaking | Needed, essential | Last of the wave, preview until reviewed |
| Italian (`it`) | Semrush: Italy 6.27% | Medium | Unknown | Watch list |
| Brazilian Portuguese (`pt-BR`) | None | Medium | Unknown | Future |

Evidence details:

- Semrush, data for September 2026 (page updated 13 October 2026): ibroadcast.com had
  194,760 visits. United States 37.39%, Japan 15.54%, United Kingdom 15.16%, Italy 6.27%,
  Czechia 5.7%.
- Similarweb, last three months as of September 2026: 202,600 visits. United States
  65.42%, Canada 10.09%, United Kingdom 10.03%, Uzbekistan 8.08%, France 2.67%.
- Both are modelled estimates of website visits, not app users and certainly not Tagcast
  users. They disagree sharply, so they only support two conclusions: English-speaking
  users are the majority, and a Japanese audience may exist.
- ibroadcast.com shows no language selector, so Tagcast users already accept an English
  service.

Conclusions:

- **Assumption, not evidence:** that German, French and Spanish speakers are a large share
  of Tagcast users.
- Dutch is the cheapest and fastest way to prove the pipeline. Its expansion is close to
  German, so it exercises layouts almost as hard.
- Don't commit to a language without a named native reviewer.
- If evidence matters, ask the community on r/Tagcast and Discord, or open a "translation
  volunteers" issue. Don't add telemetry. It would contradict `PRIVACY.md`.

### 8.2 Workflow

1. A developer adds or changes English text in `en.json` with context in
   `notes.en.json`.
2. `tools/i18n_report.py` lists new and stale keys per language.
3. An AI model drafts translations with the glossary, style rules and notes as input. The
   drafts are written as `machine` in `i18n/state/<tag>.json`.
4. A native reviewer works through the stale and `machine` keys in context, using the
   pseudo-locale screenshots and the CSV of keys with screen notes. Reviewed keys record
   the English source sha.
5. CI enforces the gates in section 7.3.

**Where AI drafts are fine:** short labels, common UI vocabulary, the first pass of help
tours and consistency checks against the glossary.

**Where a human is required:**

- Every safety-critical message: reviews, trash, merges, uploads, downloads, conflicts,
  confirmation dialogs.
- Japanese throughout: counters, politeness, natural phrasing instead of katakana.
- The help tours (6,390 words that explain data safety).
- The jokes.
- The final in-context screenshot pass.

**Keeping translations in sync:**

- Changed English text changes its sha, so the translation is flagged stale. It's still
  shown for normal keys and replaced by English for safety-critical keys.
- A string freeze of 48 hours before a release candidate lets reviewers catch up.
- Releases ship with whatever coverage exists. New text simply appears in English until
  translated.

### 8.3 Style rules per language

- **All languages:** match Tagcast's friendly, direct tone. Keep product names. Use the
  glossary. Never translate placeholders.
- **Dutch:** choose "je" or "u" once. Recommendation: "je", which fits the tone. Follow
  current Dutch UI conventions ("Instellingen", "Afspeellijst").
- **German:** pick "du" or "Sie" once, with the reviewer. Recommendation: "du". Use
  "Titel" for a track and "Titelname" for the title field to avoid the ambiguity.
  Uppercase eyebrows need "SS" for "ß".
- **French:** use "vous". Put narrow no-break spaces before `; : ! ?`. Use "Mo" and "Go"
  for sizes. Remember that 0 is singular.
- **Spanish:** use neutral Spanish with "tú" and no regionalisms. Decide between `es` and
  `es-419` before Phase 3. Use inverted punctuation and keep gender agreement in counts.
- **Japanese:** use です and ます in sentences and noun phrases on buttons. Use 「」 for
  quotes and full-width 、 and 。 punctuation. No space between a number and its counter.
  Consider ・ or ／ instead of the `" · "` separator. Use counters 曲 for tracks and 枚 or
  件 for albums, decided by the reviewer.

### 8.4 Glossary (drafts for native review)

| English | Meaning in Tagcast | nl | de | fr | es | ja |
|---|---|---|---|---|---|---|
| Album artist | Native primary album artist | Albumartiest | Albuminterpret | Artiste de l’album | Artista del álbum | アルバムアーティスト |
| Track artist | Per-track performer | Trackartiest | Titelinterpret | Artiste du morceau | Artista de la pista | トラックアーティスト |
| Additional artists and credits | `artists_additional` | Extra artiesten en credits | Weitere Interpreten und Mitwirkende | Autres artistes et crédits | Otros artistas y créditos | その他のアーティストとクレジット |
| Composer | Credit role | Componist | Komponist | Compositeur | Compositor | 作曲者 |
| Release year | Album or track year | Jaar van uitgave | Erscheinungsjahr | Année de sortie | Año de lanzamiento | リリース年 |
| Compilation | | Compilatie | Kompilation | Compilation | Recopilatorio | コンピレーション |
| Various Artists | Reserved iBroadcast ID 0 and a common stored name | Various Artists | Various Artists | Various Artists | Various Artists | Various Artists |
| Metadata | | Metadata | Metadaten | Métadonnées | Metadatos | メタデータ |
| Tags (iBroadcast) | Native labels, separate from genres | Tags | Tags | Tags | Etiquetas | タグ |
| File tags | Tags embedded in audio files (downloads and uploads) | Bestandstags | Datei-Tags | Balises du fichier | Etiquetas del archivo | ファイルのタグ情報 |
| Genre | | Genre | Genre | Genre | Género | ジャンル |
| Gapless playback | | Naadloos afspelen | Lückenlose Wiedergabe | Lecture sans blanc | Reproducción sin pausas | ギャップレス再生 |
| Play queue | | Afspeelwachtrij | Warteschlange | File d’attente | Cola de reproducción | 再生キュー |
| Now playing | | Nu aan het afspelen | Aktuelle Wiedergabe | En cours de lecture | Reproduciendo ahora | 再生中 |
| Mini Player | | Minispeler | Miniplayer | Mini-lecteur | Minirreproductor | ミニプレーヤー |
| Original quality | Stream or download quality `orig` | Originele kwaliteit | Originalqualität | Qualité d’origine | Calidad original | オリジナル音質 |
| Merge albums | | Albums samenvoegen | Alben zusammenführen | Fusionner des albums | Fusionar álbumes | アルバムを統合 |
| Review changes | Mandatory step before a write | Wijzigingen controleren | Änderungen prüfen | Vérifier les modifications | Revisar los cambios | 変更内容を確認 |
| Apply to tracks | | Toepassen op tracks | Auf Titel anwenden | Appliquer aux morceaux | Aplicar a las pistas | トラックに適用 |
| Track | | Track | Titel | Morceau | Pista | トラック (曲 in counts) |
| Disc | | Schijf | CD (reviewer decides) | Disque | Disco | ディスク |
| Library | | Bibliotheek | Mediathek | Bibliothèque | Biblioteca | ライブラリ |
| Trash | iBroadcast trash, reversible | Prullenbak | Papierkorb | Corbeille | Papelera | ゴミ箱 |
| Saved / Checking / Not confirmed / Not sent / Blocked / Failed | Write result states, must stay distinct | Opgeslagen / Controleren… / Niet bevestigd / Niet verzonden / Geblokkeerd / Mislukt | Gespeichert / Wird geprüft… / Nicht bestätigt / Nicht gesendet / Blockiert / Fehlgeschlagen | Enregistré / Vérification… / Non confirmé / Non envoyé / Bloqué / Échec | Guardado / Comprobando… / Sin confirmar / No enviado / Bloqueado / Error | 保存済み / 確認中… / 未確認 / 未送信 / ブロック / 失敗 |
| Free account | iBroadcast plan | Gratis account | Kostenloses Konto | Compte gratuit | Cuenta gratuita | 無料アカウント |

**Kept in English everywhere:** Tagcast, iBroadcast, Premium, Various Artists, Powered by
iBroadcast, 1001 Albums (as the feature name), Last.fm, TheAudioDB, LRCLIB, Unison,
Deezer, ListenBrainz, Discogs, Wikipedia, GitHub, Reddit, FLAC, MP3, LRC, CSV, JSON, ZIP,
kbps and the download layout tokens.

---

## 9. Phased implementation roadmap

The proposed sequence is sound. This plan refines it in five ways:

1. Phase 1 splits into foundation and extraction.
2. The pilot language is chosen by reviewer availability.
3. QA runs continuously instead of only in Phase 4.
4. Safety-critical keys get their own gate.
5. Python codes become a separate, optional track.

| Phase | Goal | Deliverables | Exit criteria | Regression risk |
|---|---|---|---|---|
| **0. Decisions** (mostly done by this document) | Agree architecture and conventions | Decisions in section 12, glossary sign-off for the pilot language, AGENTS.md rules drafted | Approved plan | None |
| **1a. Foundation** | Infrastructure with no visible change | `i18n.js`, `i18n-en.js` generator, manifest with English only, formatters, `msgHtml`, static pass, pseudo-locale, `tests/i18n.test.cjs`, `interface_language` server setting (selector hidden), `no-store` for catalogs, bundle checks, Electron `locales` with explicit role labels, Mini Player contract fields (`language`, `labels`, `idle`) defaulting to English, AGENTS.md rules | All 627 Node and existing Python tests green, unchanged. English screenshots identical. | Low |
| **1b. English extraction** | Every UI string goes through the catalog, output byte-identical | Batches below, one pull request each | Pseudo-locale scan clean for each extracted component. Existing tests unchanged. | Medium (many lines touched), well contained by parity |
| **1c. Server codes** (optional, can follow Phase 3) | Translate the server errors users actually see | `code` and `params` on about 200 to 300 messages, `errorText()` | Python tests still assert English text. New tests for codes. | Low to medium |
| **2. Pilot language** (`nl`, or `de` if a reviewer is lined up first) | One language end to end | Full catalog, Settings selector visible, runtime switching, Electron menus and dialogs, Mini Player, help tours, packaged apps on three OSes | Section 7.4 matrix passes. Native review complete. Ships as preview. | Medium: first real layout and switching exposure |
| **3. Remaining languages** | `de`, `fr`, `es` in parallel, then `ja` | Catalogs, reviewer sign-off, Japanese font and line-break CSS | Gates in section 7.3. Each starts as preview. `complete` only after review. | Low for European languages, medium for Japanese |
| **4. Quality pass** | Cross-language hardening | Screenshot matrix, accessibility audit, packaged app checks, enabling `auto` detection for complete languages | No open P1 or P2 i18n issues | Low |
| **5. Maintenance** | Keep it sustainable | Contributor guide, release checklist (string freeze, coverage summary), optional Weblate or Crowdin with the same JSON | Two releases with translations kept current | Low |

**Extraction batches for Phase 1b**, ordered from lowest to highest risk:

1. Electron main process and Mini Player. Small, with contract tests already in place.
2. Help tours (`help.js`). Large but read-only and isolated.
3. Static skeleton (`index.html`), navigation, settings, sidebar, sign-in.
4. Overview, service status, updates, album background and 1001 Albums.
5. Browsing pages and favourites.
6. Playback, output, gapless, visualizer, queue sync and lyrics display.
7. Downloads, uploads and metadata export.
8. Playlists, CSV and URL import.
9. Tags.
10. Cleanup, year review, trash, duplicates and album merge.
11. Editor helpers: credits, genres, lookup, artwork.
12. Core `app.js` (album grid, editor, review, History) last, after the boundary fixes in
    section 6.2 have their own tests.

Coordination: the stabilization report defers TC-19, TC-25, TC-26 and TC-28
(uncertain-write history and recovery paths). Batch 12 touches History rendering only. It
should still land after, or be rebased onto, any fix for those items.

---

## 10. Complexity and effort estimates

### 10.1 Measurable facts

- 2,652 unique UI texts, 3,408 occurrences, about 21,200 unique words in 53 frontend and
  Electron files.
- 595 unique Python messages (5,567 words) in 25 modules, plus 37 payload texts.
- About 25 Electron role labels that don't exist as strings yet.
- 80 plural ternaries, 382 fragments, 421 interpolated messages, 18 top-level label tables
  and 181 `innerHTML` sinks.
- Test assets to keep green: 627 Node tests (`tests/frontend.test.cjs` alone is 11,077
  lines) and 870 Python test functions.
- Files affected by full extraction: 45 static JS files, 2 HTML files and 6 Electron
  files. Optional server codes touch up to 25 Python modules.
- New files: about 8 runtime and catalog files per the layout, plus 2 tools and 2 test
  files.
- Churn: about 1,025 unique texts added in the 15 days before the inspected commit.

### 10.2 Estimates

All values are estimates for one developer working with AI assistance. Review and test
time dominates, not typing.

| Work item | Developer days | Notes |
|---|---:|---|
| Phase 1a foundation | 5-8 | Runtime 1.5-2.5, generator, validators and pseudo-locale 1.5-2.5, server setting and selector 1-1.5, boot, static pass, `no-store` and packaging 1-1.5 |
| Phase 1b: Electron main and Mini Player | 1.5-2.5 | Includes menu role expansion and contract tests |
| Phase 1b: help tours | 1-1.5 | Mechanical |
| Phase 1b: static skeleton, navigation, settings, sign-in | 2-3 | `data-i18n` annotation of 397 items |
| Phase 1b: overview, status, updates, album info, 1001 Albums | 1-1.5 | |
| Phase 1b: browsing and favourites | 1.5-2.5 | 14 plural ternaries, 42 fragments |
| Phase 1b: playback, gapless, visualizer, queue sync, lyrics | 1.5-3 | |
| Phase 1b: downloads, uploads, export | 1-1.5 | |
| Phase 1b: playlists and import | 2-3 | Most fragments (94) and plural ternaries (24) |
| Phase 1b: tags | 0.5-1 | |
| Phase 1b: cleanup, years, trash, merge | 1.5-3 | Safety-critical wording |
| Phase 1b: editor helpers | 1-2 | |
| Phase 1b: core `app.js` | 2-4 | Highest risk, boundary fixes |
| Phase 1b: theme editor | 0.5-1 | |
| **Phase 1b total** | **17-30** | |
| Phase 1c server codes, about 250 messages | 4-7 | Optional. The full 595 would be about 10-15. |
| Phase 2 pilot language, developer side | 5-8 | Switching UX, layout fixes, packaged QA on three OSes |
| Each further European language, developer side | 2-4 | Layout fixes and QA |
| Japanese, developer side | 5-8 | Fonts (`:lang(ja)` stack), `word-break: auto-phrase` (Chromium 119 and later, needs `lang="ja"`), `line-break: strict`, counters, QA |
| Phase 4 quality pass | 4-7 | |

| Translation review per language (about 23,000 words including top server messages) | Hours |
|---|---:|
| Dutch, German, French, Spanish (post-editing AI drafts at about 500-900 words per hour) | 25-45 |
| Japanese | 35-60 |

| Ongoing maintenance | Estimate |
|---|---|
| Developer overhead on new UI work | +5-10% (keys, notes, no concatenation) |
| Review per language per release, at the measured 760 to 3,800 new words per release | 1-5 hours |
| Review per language at the October pace (about 5,000 words per week) | About 6-10 hours per week |

### 10.3 Quick wins

These are low risk and useful even before any translation exists:

1. Replace `fieldLabel()` derivation with an explicit map (`app.js` line 1028).
2. Introduce `TagcastI18n.number` and `TagcastI18n.dateOnly` with English parity and the
   UTC rule. This fixes a latent off-by-one-day risk if date-only values are ever
   formatted.
3. Add the Mini Player `idle` flag so metadata fields never carry UI text.
4. Split the packed `data-tip` in `overview.js` into two attributes.
5. Turn the pseudo-locale scan into a report-only CI job. It measures progress and blocks
   nothing.
6. Add the i18n rules to AGENTS.md now, so new features stop adding concatenations and
   `=== 1` plurals.

### 10.4 High-risk areas

- `app.js` editor, review and History. Data adjacency, persisted labels and the
  "Various Artists" logic.
- Any template that ends up in `innerHTML` (181 sinks).
- Runtime switching while dialogs, playback or transfers are active.
- Electron IPC and the Mini Player contract, which are deliberately hardened.
- Japanese layout and fonts on Linux, where CJK fonts may be missing.
- The pace of English changes compared to reviewer capacity.

---

## 11. Risks and potential regressions

| # | Risk | Likelihood | Impact | Mitigation | Detection |
|---|---|---|---|---|---|
| R1 | A translated placeholder is sent back as data and breaks an identity check or grouping | Medium without rules | High: blocked saves, wrong disc grouping | Section 6: server values untouched, render-time mapping only | Boundary tests, pseudo-locale run with live mocks |
| R2 | Download fallback folders get translated | Low | High: duplicates, broken resume | Rule plus test on `download_engine.py` | Python test |
| R3 | XSS through a translation or a metadata placeholder | Medium without `msgHtml` | High | `msgHtml` escaping, no markup in catalogs, hostile-value test | CI |
| R4 | A language switch stops playback or loses a draft | Medium if a reload is used | High | No reload, open dialogs not re-rendered, guard tests | Harness tests |
| R5 | Sort or matching order changes with the UI language | Medium if someone "fixes" `localeCompare` | Medium | Rule in AGENTS.md, test with a different language and identical sort output | Harness test |
| R6 | A stale cached catalog doesn't match new keys after an update | High without `no-store` | Low (English fallback) | `no-store` for `i18n/*.json` | Python test on headers |
| R7 | Text expansion breaks layouts | High for German and French | Medium | Pseudo-locale at 135%, screenshot matrix, flexible widths | Screenshots |
| R8 | Missing CJK fonts on Linux | Medium | Medium (tofu) | Document `fonts-noto-cjk`, `:lang(ja)` font stack, don't bundle fonts | Manual QA on Linux |
| R9 | Mixed-language UI from English server errors and native dialogs | Certain at first | Low to medium | Translated context frames, later server codes, documented limitation | Review |
| R10 | Unreviewed machine translation in a safety-critical message misleads a user | Medium | High | Safety-critical gate (section 7.3) | CI |
| R11 | Translations fall behind fast English churn | High | Medium | English fallback, stale detection, string freeze, preview status | Coverage report |
| R12 | The global name `t` gets shadowed | Certain if used | Medium | Use `msg()` | `test_static.py` already checks uniqueness |
| R13 | Phase 1 changes English output and breaks the 627 Node tests | Medium | Low (caught) | Byte-identical parity is the definition of done | Existing tests |
| R14 | Electron menus show English after a switch | Medium | Low | IPC channel plus `interface.json` | Electron tests |
| R15 | A boot gate delay or flash on slow systems | Low | Low | Fetch starts in `<head>`, 1,500 ms ceiling, English fallback | Timing test |
| R16 | `bundle_check` or `test_static` break because of new script locations | Certain if scripts go in a subfolder | Low | Top-level `i18n.js` and `i18n-en.js`, JSON in the subfolder | Existing checks |
| R17 | Japanese counters and politeness handled badly by AI drafts | High | Medium | Native reviewer required, preview status | Review |
| R18 | Work collides with open stabilization items TC-19, TC-25, TC-26 and TC-28 | Medium | Medium | History batch last, rebased | Code review |

---

## 12. Final recommendation

**Approach.** Option A: a small native `TagcastI18n` module on `Intl`, flat ICU JSON
catalogs, generated synchronous English, server-stored preference, in-place switching
without reload and a Mini Player that follows the main window through its existing
snapshot. No framework, no build step for the page and no third-party runtime.

**Work involved.**

- About 28-47 developer-days to a first non-English preview: foundation, full English
  extraction and the pilot.
- About 43-74 developer-days and 135-235 native review hours for all five recommended
  languages.
- Ongoing: roughly 1-5 review hours per language per release, plus 5-10% overhead on
  frontend feature work.

**What could go wrong.** The serious failures aren't bad translations. They're translated
labels leaking into data (placeholders, History, download paths), unescaped HTML and a
language switch that reloads the page. Section 6 and the guard tests in section 7 address
all three. The practical risk is churn: at October's pace translations would lag unless
English fallback and stale detection are accepted as normal.

**Is Tagcast ready to start?** Yes for Phase 0 and Phase 1a. No for shipping a translated
build soon.

Before starting:

1. Sync or rebranch from `origin/main` at 1.3.0. The local `main` checkout is 37 commits
   behind.
2. Decide four things:
   - The pilot language. Recommendation: Dutch.
   - Server-stored preference. Recommendation: yes.
   - Whether Python error codes are in scope. Recommendation: later, as Phase 1c.
   - Whether the initial set stays German, French, Spanish and Japanese, or whether
     Japanese waits until a native reviewer is committed.
3. Land Phase 1a and the six quick wins. They have value on their own and change nothing
   visible.
4. Only start Phase 2 once Phase 1b's pseudo-locale scan is clean. Translating a partially
   extracted UI produces mixed-language screens and double work.

---

## Appendix A. Sources

- Semrush, ibroadcast.com overview (September 2026 data, updated 13 October 2026):
  <https://www.semrush.com/website/ibroadcast.com/overview/>
- Similarweb, ibroadcast.com (September 2026 page, last three months):
  <https://www.similarweb.com/website/ibroadcast.com/>
- Signal Desktop commit "Make all OS menus localizable" (Electron role labels aren't
  localized automatically):
  <https://git.uninsane.org/colin/Signal-Desktop/commit/4415293100e3d019bc649784068aa18b3ae2431a>
- Chrome Developers, "Introducing four new international features in CSS"
  (`word-break: auto-phrase` from Chrome 119, requires `lang="ja"`):
  <https://developer.chrome.com/blog/css-i18n-features>
- npm package measurements, read from the published tarballs on 2 November 2026:
  - `i18next@26.7.1`, `dist/umd/i18next.min.js`: 50,269 bytes, 15,698 bytes gzipped
  - `i18next-icu@2.6.1`, `dist/umd/i18nextICU.min.js`: 41,670 bytes
  - `intl-messageformat@12.1.4`, `intl-messageformat.iife.js`: 66,207 bytes (unminified)
- `Intl` output examples (units, separators, plural categories, the date-only shift) were
  measured with Node 22.23.4 (ICU 78.3). Electron 44 ships its own full ICU, so exact
  strings can differ slightly. The categories and behaviour shown are stable CLDR data.
