# Tagcast media kit

Logos, screenshots and a social preview for articles, app listings and links to Tagcast.

**[Download the complete media kit](https://github.com/cyberdeliaAI/tagcast/raw/refs/heads/main/media/tagcast-media-kit.zip)**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logos/tagcast-lockup-light.svg">
  <img src="logos/tagcast-lockup-dark.svg" width="400" alt="Tagcast for iBroadcast">
</picture>

## About Tagcast

Tagcast is an independent metadata editor and album player for iBroadcast, developed
by Cyberdelia. It runs on your computer, with its interface in your browser. Browse
your collection, play albums, review metadata changes and manage artwork, playlists
and tags. Your local music files are never changed.

Available for macOS, Windows and Linux. [Project](https://github.com/cyberdeliaAI/tagcast)
· [Downloads](https://github.com/cyberdeliaAI/tagcast/releases/latest)

## Files

| Asset | SVG | PNG |
|---|---|---|
| Primary cassette-in-sleeve icon | [Vector](logos/tagcast-icon.svg) | [128](logos/tagcast-icon-128.png) · [512](logos/tagcast-icon-512.png) · [1024](logos/tagcast-icon-1024.png) |
| Logo with dark lettering, for light backgrounds | [Vector](logos/tagcast-lockup-dark.svg) | [1600 × 448](logos/tagcast-lockup-dark.png) |
| Logo with light lettering, for dark backgrounds | [Vector](logos/tagcast-lockup-light.svg) | [1600 × 448](logos/tagcast-lockup-light.png) |
| Monochrome icon | [Vector](logos/tagcast-icon-monochrome.svg) | [1024](logos/tagcast-icon-monochrome.png) |
| GitHub / social preview | [Editable source](social/tagcast-social-preview.svg) | [1280 × 640](social/tagcast-social-preview.png) |
| Native iBroadcast tags | — | [App screenshot](screenshots/album-tags.png) |
| 1001 Albums background texts | — | [App screenshot](screenshots/1001-albums-background.png) |

PNG logos have transparent corners/backgrounds. SVG wordmarks use Arial with a
Helvetica/sans-serif fallback; use the PNG when exact lettering is required.
Screenshots were captured on **16 October 2026** while preparing Tagcast 0.50.0,
with the cassette icon, compact sidebar, context breadcrumb and inline tag chips.
Some captures still show the previous development version beside Settings;
the original pixels are preserved.

## Colours and use

The primary icon uses **blue `#5263E8`**, **cream `#FFF7DE`** and **navy `#172D4D`**.
The sidebar adapts the same design to the app's chosen colour palette. Use the
primary blue icon for app listings and general coverage, and preserve its proportions.

The original Tagcast artwork is supplied under the repository's [MIT license](LICENSE).
Album artwork and iBroadcast branding visible in screenshots belong to their
respective owners. The background text in the Frank Sinatra screenshot is adapted
from [Wikipedia contributors](https://en.wikipedia.org/wiki/In_the_Wee_Small_Hours)
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); see the
[screenshot text attribution](screenshots/1001-albums-background-LICENSE.txt).
Tagcast is independent and is not made or endorsed by iBroadcast.

To refresh the exports with the existing build-only image dependencies:

```sh
uv run --frozen --with resvg_py==0.5.0 --with Pillow==12.0.0 python tools/build_media.py
```
