# Screenshot refresh checklist

Capture the current local/source build after reloading the browser. These interface
changes are on `main`; the published 0.42.0 packages still have the earlier interface.
All current app screenshots need the new brand/sidebar. The rows below describe a
complete replacement set, including new features that do not yet have screenshots.
Reuse one capture wherever it illustrates the same screen.

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
| [ ] | `album-artists.png` | Album artist grid with the complete new sidebar. |
| [ ] | `albums.png` | Album collection, filters and aligned Play / + controls. |
| [ ] | `artist-albums-selected.png` | One artist's albums with several selected and the Edit / trash actions visible. |
| [ ] | `albums-filtered-selected.png` | 1–2 tracks filter with selected albums and the trash action; random playback is hidden here. |
| [ ] | `albums-trash-review.png` | Complete-album trash review with album and track totals, before confirming. |
| [ ] | `album-details.png` | A good cover, title/artist, clickable year, genre chips, neutral ratings, compact actions and the playing bar. Main README image. |
| [ ] | `album-tags.png` | Album opened through a tag: visible context breadcrumb, genre and tag chips, + Tag, and some tagged track rows. |
| [ ] | `album-more.png` | The same album with the ⋯ menu open, showing Move to trash. |
| [ ] | `album-multi-disc.png` | A multi-disc album with visible disc sections, format labels and individual Edit disc controls. |
| [ ] | `editor.png` | Metadata draft with track fields and useful online suggestions. |
| [ ] | `metadata-review.png` | Before/after metadata review, before saving. |

## Tags and cleanup

| Done | Suggested PNG | What to show |
|---|---|---|
| [ ] | `tags.png` | Tags overview, with meaningful labels and album counts. |
| [ ] | `tag-manager.png` | Album tag manager with a partial assignment and Keep as is / add / remove choices. |
| [ ] | `tag-review.png` | An explicit tag-change review, before saving. |
| [ ] | `duplicate-tracks-select.png` | Album trash mode after Select suggested copies, with upload groups, FLAC/MP3 and keep/trash explanations visible. |
| [ ] | `duplicate-tracks-review.png` | Selected duplicate-track review, before confirming. |
| [ ] | `duplicate-cleanup-preview.png` | Library-wide duplicate cleanup preview with album/track exclusions and totals, before processing. |
| [ ] | `cleanup-artists-preview.png` | Credit cleanup preview with before/after artist or composer names and album exclusions. |
| [ ] | `cleanup-genres-progress.png` | Genre cleanup progress during an intended job, with confirmed and outstanding results. |

## 1001 Albums

| Done | Suggested PNG | What to show |
|---|---|---|
| [ ] | `1001-albums-found.png` | Found albums, decade controls, filters and the remembered Show matching details checkbox. |
| [ ] | `1001-albums-missing.png` | Not found filter with muted placeholder covers. |
| [ ] | `1001-albums-possible.png` | Possible matches that still need review. |
| [ ] | `1001-albums-chooser.png` | Choose an album dialog with a suggested matching edition. |
| [ ] | `1001-albums-search.png` | The chooser finding an alternate edition through library search. |
| [ ] | `1001-albums-background.png` | Album details with About this album expanded, its narrower prose and attribution visible. |

## Playback and other views

| Done | Suggested PNG | What to show |
|---|---|---|
| [ ] | `now-playing-queue.png` | Now playing with a useful queue and playback controls. |
| [ ] | `fullscreen.png` | Fullscreen Now playing with cover and controls. |
| [ ] | `sound-output.png` | Sound dialog with volume, mute and the browser's available output controls. |
| [ ] | `genre-albums.png` | Albums in one genre with the random-play action available. |
| [ ] | `composer-albums.png` | Albums associated with a composer. |
| [ ] | `release-year-albums.png` | A year opened by clicking the year on an album. |
| [ ] | `decades.png` | A decade's random album selection and introduction. |
| [ ] | `favourites.png` | Track favourites with search, queue and heart controls. |
| [ ] | `playlists.png` | Playlist details with tracks and its actions. |
| [ ] | `recently-played.png` | Recently played with track rows and playback controls. |
| [ ] | `overview.png` | Library totals, metadata health and useful links. |
| [ ] | `history.png` | Change history with useful checked results; keep metadata and trash outcomes identifiable. |
| [ ] | `settings.png` | Relevant Playback / Discovery settings and sidebar preferences, without source keys. |
| [ ] | `help-tour.png` | A contextual ? tour highlighting an album-page control. |
| [ ] | `album-light.png` | One clean album page in Light appearance. |
| [ ] | `album-mobile.png` | Narrow album view with wrapping chips/actions and the mobile menu button. |

Optional: a Safari AirPlay picker when available, a Windows/Linux system media-control
view, and a refreshed sign-in dialog. The external iBroadcast website's older setup
screenshots do not need recapturing for Tagcast's visual changes.

## Documentation and media kit updates

1. Put the selected documentation PNGs in `docs/screenshots/` and update the README
   links and captions together. Keep existing images until their replacements are ready.
2. Reuse `album-details.png` for the old album-player/details/format examples where
   the same capture explains them. Reuse `album-more.png` and the duplicate selection
   image in the trash walkthrough. Dark-theme collection images can also replace
   older palette variants when those variants add no distinct feature explanation.
3. Copy the chosen album-tags and 1001 background images to `media/screenshots/`,
   keeping those two public media-kit filenames. Refresh the media-kit ZIP with
   `tools/build_media.py` after the captures are final; its command is in `media/README.md`.
4. Remove obsolete screenshot files only after checking for remaining README/media
   references. Retain any screenshots intentionally used as historical examples.

Publishing these documentation updates to GitHub does not require a release.
