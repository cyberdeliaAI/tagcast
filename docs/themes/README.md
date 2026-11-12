# Tagcast colour themes

Portable examples with separate Light and Dark variants. The established palette
examples support **Tagcast 1.2.0 and later**; **Amber Midnight requires 1.7.0**.
Every JSON file contains one custom theme. Built-in palettes are unchanged.

**[Browse previews and download the collection on tagcast.app](https://tagcast.app/themes.html)**

## Import a theme

1. Download one JSON file below. If your browser displays its contents, save it with
   the `.json` extension.
2. Open **Settings → Appearance → Import JSON…** in Tagcast.
3. Check the preview, then choose **Save & use**.
4. Choose **Theme → Light / Dark / Auto** independently. The editor's variant buttons
   only switch its preview.

Import creates a new local theme; it does not overwrite existing themes or touch
account, library or playback settings. Each file includes both variants; import it
once unless you deliberately want a separate copy.

## Established palettes, adapted for Tagcast

| Theme | Character | JSON | Original palette |
| --- | --- | --- | --- |
| Nord | Cool blue-grey surfaces and restrained ice-blue accents. | [Download](https://raw.githubusercontent.com/cyberdeliaAI/tagcast/main/docs/themes/tagcast-nord.json) | [Source](https://www.nordtheme.com/docs/colors-and-palettes/) |
| Solarized | Warm parchment in Light; deep petrol in Dark. | [Download](https://raw.githubusercontent.com/cyberdeliaAI/tagcast/main/docs/themes/tagcast-solarized.json) | [Source](https://ethanschoonover.com/solarized/) |
| Gruvbox | Cream, warm charcoal and burnt-orange accents. | [Download](https://raw.githubusercontent.com/cyberdeliaAI/tagcast/main/docs/themes/tagcast-gruvbox.json) | [Source](https://github.com/morhetz/gruvbox) |
| Catppuccin | Soft lavender, mauve accents and gently layered surfaces. | [Download](https://raw.githubusercontent.com/cyberdeliaAI/tagcast/main/docs/themes/tagcast-catppuccin.json) | [Source](https://catppuccin.com/palette/) |
| Rosé Pine | Soft cream or deep plum with rose and iris accents. | [Download](https://raw.githubusercontent.com/cyberdeliaAI/tagcast/main/docs/themes/tagcast-rose-pine.json) | [Source](https://rosepinetheme.com/palette/) |

These are independent Tagcast adaptations, not official ports or endorsements.
Some text, selection, hover and focus colours were adjusted for contrast rather
than copying syntax-highlighting colours into every UI role. All five files pass
Tagcast's importer/exporter. Across the ten variants, 230 representative opaque
colour pairs were measured: normal text at least 4.5:1 and keyboard focus against
page, controls and sidebar at least 3:1. This is not a complete accessibility audit
or proof that one palette suits everyone.

See [attribution and adaptation notes](ATTRIBUTION.md) for palette authors, sources,
licences and the specific changes. Native controls, operating-system window borders
and semantic warning/error styling retain their existing presentation.

## Amber Original

The earlier [Amber · Original (ibfetch) example](ibfetch-amber-original.json) remains
available. For creating and sharing your own colours, see the
[Custom themes guide](https://github.com/cyberdeliaAI/tagcast/wiki/Custom-themes).

## Amber Midnight

[Download Amber · Midnight](tagcast-amber-midnight.json) for Tagcast 1.7.0 and later.
Its Dark variant uses near-black content, a muted plum sidebar, cream text, soft
gold controls and matching gold navigation icons, inspired by the maintainer's reference
screenshots. Light keeps the plum navigation beside warm pale surfaces. Choose
**Theme → Dark** after importing for the requested dark appearance; Light and
Auto retain their normal independent behavior.

This file changes colour roles only. It keeps Tagcast's typography, layout,
navigation, metadata workflows and semantic warning/error colours. It does not
add the reference application's details panel or sorting controls. Import it
through **Settings → Appearance → Import JSON…**, then **Save & use**.

The 46 representative contrast pairs in this theme meet at least 4.5:1 for text
and 3:1 for icons and focus indicators. Import, preview isolation, saving and
reload were checked in Chromium at 420, 760, 768 and 1280 pixels in both variants.
These checks do not constitute a full accessibility audit of every screen.
