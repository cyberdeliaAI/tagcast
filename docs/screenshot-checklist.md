# Screenshot refresh checklist

Capture the current local/source build after reloading the browser. These interface
changes are on `main`; the published 0.42.0 packages still have the earlier interface.
The supplied set contains **37 original PNGs captured on 16 October 2026**.
They are imported without resizing or other image changes; the original files in
Pictures/Screenshots remain untouched. Checked rows have usable captures. Notes
below identify partial coverage and views that still need a new capture. Reuse one
capture wherever it illustrates the same screen.

## Capture setup

- Use one consistent desktop window size, ideally around 1440 × 900, at 100% browser zoom.
- Use Ocean / Dark for the main series. Add the light and mobile variants listed below.
- Keep the logo, breadcrumb and enough page context visible. Include the compact player
  when demonstrating listening; keep tooltips and unrelated menus closed.
- Show realistic albums and useful before/after values. Do not confirm writes just to
  obtain a screenshot. Capture reviews before confirmation; capture progress only
  during work you already intended to run.
- Keep source keys collapsed and omit personal account details.
- Save original PNGs without arrows or annotations. The suggested names have no version
  suffix, so the same documentation slots can be refreshed later.

## Library and album pages

| Done | Suggested PNG | What to show |
|---|---|---|
| [x] | `album-artists.png` | Album artist grid with the complete new sidebar. |
| [x] | `albums.png` | Album collection, filters and aligned Play / + controls. |
| [x] | `artist-albums-selected.png` | One artist's albums with several selected and the Edit / trash actions visible. |
| [ ] | `albums-filtered-selected.png` | 1–2 tracks filter with selected albums and the trash action; random playback is hidden here. |
| [x] | `albums-trash-review.png` | Complete-album trash review with album and track totals, before confirming. |
| [x] | `album-details.png` | A good cover, title/artist, clickable year, genre chips, neutral ratings and compact actions. The queue capture also shows the playing bar. Main README image. |
| [x] | `album-tags.png` | Album opened through a tag: visible context breadcrumb, genre and tag chips, + Tag, and some tagged track rows. |
| [x] | `album-more.png` | The same album with the ⋯ menu open, showing Move to trash. |
| [x] | `album-multi-disc.png` | A multi-disc album with visible disc sections, format labels and individual Edit disc controls. The capture is scrolled to a disc boundary. |
| [x] | `editor.png` | Metadata draft with track fields and useful online suggestions. |
| [x] | `metadata-review.png` | Before/after metadata review, before saving. |

## Tags and cleanup

| Done | Suggested PNG | What to show |
|---|---|---|
| [x] | `tags.png` | Tags overview, with meaningful labels and album counts. |
| [x] | `tag-manager.png` | Album tag manager with assignment counts and Keep as is / add / remove choices. The supplied album is fully assigned; partial-count detail is optional. |
| [x] | `tag-review.png` | An explicit tag-change review, before saving. |
| [ ] | `duplicate-tracks-select.png` | Album trash mode after Select suggested copies, with upload groups, FLAC/MP3 and keep/trash explanations visible. |
| [ ] | `duplicate-tracks-review.png` | Selected duplicate-track review, before confirming. |
| [ ] | `duplicate-cleanup-preview.png` | Library-wide duplicate cleanup preview with album/track exclusions and totals, before processing. |
| [ ] | `cleanup-artists-preview.png` | Credit cleanup preview with before/after artist or composer names and album exclusions. |
| [ ] | `cleanup-genres-progress.png` | Genre cleanup progress during an intended job, with confirmed and outstanding results. |

## 1001 Albums

| Done | Suggested PNG | What to show |
|---|---|---|
| [x] | `1001-albums-found.png` | Found albums, decade controls, filters and the remembered Show matching details checkbox. |
| [x] | `1001-albums-missing.png` | Not found filter with muted placeholder covers. |
| [ ] | `1001-albums-possible.png` | Possible matches that still need review. |
| [x] | `1001-albums-chooser.png` | Choose an album dialog with a suggested matching edition. |
| [x] | Reuse `1001-albums-chooser.png` | The same capture shows the chooser finding an alternate edition through library search. |
| [ ] | `1001-albums-background.png` | Album details with About this album expanded, its narrower prose and attribution visible. |

## Playback and other views

| Done | Suggested PNG | What to show |
|---|---|---|
| [x] | `now-playing-queue.png` | Now playing with a useful queue and playback controls. |
| [x] | `fullscreen.png` | Fullscreen Now playing with cover and controls. |
| [x] | `sound-output.png` | Sound dialog with volume, mute and the browser's available output controls. |
| [x] | `genre-albums.png` | Albums in one genre with the random-play action available. |
| [x] | `composer-albums.png` | Albums associated with a composer. |
| [ ] | `release-year-albums.png` | A year opened by clicking the year on an album. |
| [x] | `decades.png` | A decade's random album selection and introduction. |
| [x] | `favourites.png` | Track favourites with search, queue and heart controls. |
| [ ] | `playlists.png` | Playlist details with tracks and its actions. |
| [x] | `recently-played.png` | Recently played with track rows and playback controls. |
| [x] | `overview.png` | Library totals, metadata health and useful links. |
| [x] | `history.png` | Change history with saved and unconfirmed metadata/artwork results. A trash-result example can be added later. |
| [x] | `settings.png` | Interface, sidebar and Playback settings, without source keys. A Discovery-settings capture can be added later. |
| [x] | `help-tour.png` | A contextual ? tour. The supplied example highlights decade cards. |
| [x] | `album-light.png` | One clean album page in Light appearance. |
| [ ] | `album-mobile.png` | Narrow album view with wrapping chips/actions and the mobile menu button. |

## Remaining captures and partial coverage

- **1–2 tracks filter with selected albums** (`albums-filtered-selected.png`). The
  supplied selected-album view uses an artist's All albums filter.
- **Duplicate suggestions overview and track review** (`duplicate-tracks-select.png`,
  `duplicate-tracks-review.png`). The new Faithless captures show repeated positions
  and explicit manual selection for different artists, not an automatic suggestion.
- **Library-wide duplicate cleanup preview** (`duplicate-cleanup-preview.png`).
- **Credit cleanup preview and genre-cleanup progress** (`cleanup-artists-preview.png`,
  `cleanup-genres-progress.png`). Earlier-interface examples remain linked in the README.
- **1001 possible matches** (`1001-albums-possible.png`), when one is available. The
  supplied report has zero possible matches; no extra capture is needed just to show
  an empty list.
- **1001 background with its attribution visible**: `1001-albums-background.png`
  currently shows the expanded text but its source/license footer is below the viewport.
  The README and media kit retain explicit Wikipedia/CC BY-SA attribution alongside it.
  A replacement should include that footer, for example by choosing a shorter note.
- **Release-year albums**, **playlist details** and **mobile album page**
  (`release-year-albums.png`, `playlists.png`, `album-mobile.png`).

The supplied **Sound** capture already includes Safari's native AirPlay picker. A
plain Sound dialog without that popup, Windows/Linux system media controls, and a
refreshed sign-in dialog are optional additions. The chooser/search checklist rows
reuse the same Aretha Franklin search capture, `1001-albums-chooser.png`.

## Received originals

All imports are byte-for-byte copies of the submitted PNGs. Extra captures are
retained even when the README does not embed them. The contributor's redaction of
Overview account fields is preserved.

| Capture time (16 October 2026) | Imported file | Content |
|---|---|---|
| 18.03.32 | [album-artists.png](screenshots/album-artists.png) | Album artist grid |
| 18.04.56 | [albums.png](screenshots/albums.png) | Album collection |
| 18.05.35 | [artist-albums.png](screenshots/artist-albums.png) | Aphex Twin albums |
| 18.05.57 | [artist-albums-selected.png](screenshots/artist-albums-selected.png) | Selected Aphex Twin albums |
| 18.06.19 | [albums-trash-review.png](screenshots/albums-trash-review.png) | Complete-album trash review |
| 18.06.57 | [album-details.png](screenshots/album-details.png) | Mambo! album details |
| 18.07.32 | [album-tags.png](screenshots/album-tags.png) | Album opened through the Emusic tag |
| 18.07.48 | [album-more.png](screenshots/album-more.png) | More album actions menu |
| 18.08.08 | [tag-manager.png](screenshots/tag-manager.png) | Album tag assignments |
| 18.13.37 | [album-multi-disc.png](screenshots/album-multi-disc.png) | Multi-disc track sections |
| 18.14.00 | [editor.png](screenshots/editor.png) | Metadata editor and source suggestions |
| 18.14.21 | [metadata-review.png](screenshots/metadata-review.png) | Metadata before/after review |
| 18.14.45 | [tags.png](screenshots/tags.png) | Native tag overview |
| 18.14.56 | [tag-create.png](screenshots/tag-create.png) | Create an empty tag |
| 18.15.21 | [tag-review.png](screenshots/tag-review.png) | Tag assignment review |
| 18.16.18 | [duplicate-track-positions.png](screenshots/duplicate-track-positions.png) | Repeated track positions |
| 18.16.43 | [duplicate-tracks-manual.png](screenshots/duplicate-tracks-manual.png) | Manual comparison for differing artist credits |
| 18.17.08 | [album-artists-missing-image.png](screenshots/album-artists-missing-image.png) | Album artists without images |
| 18.17.24 | [history.png](screenshots/history.png) | Checked metadata history |
| 18.55.14 | [1001-albums-found.png](screenshots/1001-albums-found.png) | Matched reference albums |
| 18.55.31 | [1001-albums-missing.png](screenshots/1001-albums-missing.png) | Missing reference albums |
| 18.56.52 | [1001-albums-chooser.png](screenshots/1001-albums-chooser.png) | Search for a matching Aretha Franklin edition |
| 18.57.25 | [1001-albums-reference-search.png](screenshots/1001-albums-reference-search.png) | Search the reference list |
| 19.07.31 | [artwork-compare.png](screenshots/artwork-compare.png) | Album artwork comparison |
| 19.08.15 | [fullscreen.png](screenshots/fullscreen.png) | Fullscreen Now playing |
| 19.08.52 | [1001-albums-background.png](screenshots/1001-albums-background.png) | Expanded album background; attribution below the viewport |
| 19.09.12 | [now-playing-queue.png](screenshots/now-playing-queue.png) | Now playing queue beside album details |
| 19.09.32 | [sound-output.png](screenshots/sound-output.png) | Sound dialog and Safari AirPlay picker |
| 19.09.50 | [genre-albums.png](screenshots/genre-albums.png) | Alternative albums |
| 19.10.44 | [composer-albums.png](screenshots/composer-albums.png) | Burt Bacharach composer albums |
| 19.11.01 | [decades.png](screenshots/decades.png) | 1980s discovery |
| 19.11.12 | [favourites.png](screenshots/favourites.png) | Track favourites |
| 19.11.24 | [recently-played.png](screenshots/recently-played.png) | Recently played tracks |
| 19.11.54 | [overview.png](screenshots/overview.png) | Overview; account fields redacted by the contributor |
| 19.12.14 | [settings.png](screenshots/settings.png) | Interface and playback settings |
| 19.12.28 | [help-tour.png](screenshots/help-tour.png) | Contextual Decades tour |
| 19.12.46 | [album-light.png](screenshots/album-light.png) | Odessa in Light appearance |

## Documentation and media kit updates

1. Done: imported the supplied PNGs into `docs/screenshots/` and updated the README
   links/captions. Earlier captures without replacements remain available.
2. Reuse `album-details.png` for the old album-player/details/format examples where
   the same capture explains them. Reuse `album-more.png` and the duplicate selection
   image in the trash walkthrough. Dark-theme collection images can also replace
   older palette variants when those variants add no distinct feature explanation.
3. Done: copied the album-tags and 1001 background images to `media/screenshots/`,
   preserving the public filenames and adding a source/license notice for the
   background text. Rebuild the ZIP with `tools/build_media.py` after future updates.
4. Remove obsolete screenshot files only after checking for remaining README/media
   references. Retain any screenshots intentionally used as historical examples.

Publishing these documentation updates to GitHub does not require a release.
