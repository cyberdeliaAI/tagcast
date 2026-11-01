"""The page's scripts share one global scope, so a name declared in two of them
silently replaces the other (a function) or stops a script from loading (const/let)."""

import re
import unittest
from pathlib import Path

STATIC = Path(__file__).parent.parent / "src" / "tagcast" / "static"
DECLARATION = re.compile(r"^(?:async\s+)?function\s+([\w$]+)|^(?:const|let|var)\s+([\w$]+)", re.M)


class StaticScriptTests(unittest.TestCase):
    def test_top_level_names_are_unique_across_scripts(self):
        seen = {}
        for script in sorted(STATIC.glob("*.js")):
            for match in DECLARATION.finditer(script.read_text(encoding="utf-8")):
                name = match.group(1) or match.group(2)
                self.assertNotIn(name, seen, f"{name} is declared in {seen.get(name)} and {script.name}")
                seen[name] = script.name

    def test_every_script_is_loaded_by_the_page(self):
        page = (STATIC / "index.html").read_text(encoding="utf-8")
        for script in STATIC.glob("*.js"):
            self.assertIn(f'src="{script.name}"', page)

    def test_dark_css_is_built_from_the_current_style_css(self):
        import sys
        sys.path.insert(0, str(STATIC.parent.parent.parent / "tools"))
        from build_dark_css import build
        self.assertEqual((STATIC / "dark.css").read_text(encoding="utf-8"), build((STATIC / "style.css").read_text(encoding="utf-8")),
                         "Run python3 tools/build_dark_css.py")

    def test_palette_text_and_controls_have_readable_contrast_in_both_appearances(self):
        css = (STATIC / "palettes.css").read_text(encoding="utf-8")
        page = (STATIC / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('href="dark.css"'), page.index('href="palettes.css"'))

        def luminance(colour):
            if len(colour) == 4:
                colour = "#" + "".join(channel * 2 for channel in colour[1:])
            rgb = [int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            channels = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
                        for v in rgb]
            return sum(v * weight for v, weight in zip(channels, (.2126, .7152, .0722)))

        def contrast(a, b):
            low, high = sorted((luminance(a), luminance(b)))
            return (high + .05) / (low + .05)

        for palette in ("ocean", "warm", "ibroadcast", "apple"):
            selector = f':root[data-palette="{palette}"]'
            light = re.search(re.escape(selector) + r"\{([^}]+)\}", css).group(1)
            dark = re.search(re.escape(selector + '[data-theme="dark"]')
                             + r"\{([^}]+)\}", css).group(1)
            auto = re.search(re.escape(selector + ':not([data-theme="light"])')
                             + r"\{([^}]+)\}", css).group(1)
            self.assertEqual(dark, auto, "Auto dark and explicit dark must use the same palette")
            values = dict(re.findall(r"--palette-([\w-]+):(#[\da-f]{6})", light))
            for appearance, overrides in (("light", ""), ("dark", dark)):
                values.update(re.findall(r"--palette-([\w-]+):(#[\da-f]{6})", overrides))
                for foreground in ("ink", "muted", "link"):
                    for background in ("paper", "surface", "soft", "tint"):
                        with self.subTest(palette=palette, appearance=appearance,
                                          foreground=foreground, background=background):
                            self.assertGreaterEqual(contrast(values[foreground], values[background]), 4.5)
                for foreground, background in (("shell-ink", "sidebar"),
                                               ("shell-muted", "sidebar"),
                                               ("shell-ink", "shell-active")):
                    self.assertGreaterEqual(contrast(values[foreground], values[background]), 4.5)
                if "nav-icon" in values:
                    for background in ("sidebar", "shell-active"):
                        self.assertGreaterEqual(contrast(values["nav-icon"], values[background]), 3)
                self.assertGreaterEqual(contrast("#ffffff", values["primary"]), 4.5)

        # Forest uses fallbacks rather than the named palette overrides above.
        # These are the small text/background pairs measured in the current UI.
        for appearance, filename in (("light", "style.css"), ("dark", "dark.css")):
            forest = (STATIC / filename).read_text(encoding="utf-8")
            values = {
                role: re.search(r"--" + role + r":var\(--palette-[\w-]+,(#[\da-f]+)\)",
                                forest).group(1)
                for role in ("muted", "paper", "white")
            }
            values["eyebrow"] = re.search(
                r"\.eyebrow\{color:var\(--palette-muted,(#[\da-f]+)\)", forest
            ).group(1)
            for foreground, background in (("muted", "paper"), ("muted", "white"),
                                           ("eyebrow", "paper")):
                with self.subTest(palette="forest", appearance=appearance,
                                  foreground=foreground, background=background):
                    self.assertGreaterEqual(contrast(values[foreground], values[background]), 4.5)

            def fallback_colour(selector, property_name):
                if appearance == "dark":
                    selector = ",".join(':root[data-theme="dark"] ' + part
                                        for part in selector.split(","))
                declarations = re.findall(r"(?:^|[}\n])\s*" + re.escape(selector)
                                          + r"\s*\{([^}]+)\}", forest)[-1]
                return re.search(re.escape(property_name) + r":\s*(?:var\(--palette-[\w-]+,\s*)?"
                                 r"(#[\da-f]+)", declarations).group(1)

            inline_background = fallback_colour(".track-inline", "background")
            artwork_background = fallback_colour(".art-compare img,.art-empty", "background")
            selected_track_background = fallback_colour(".editor-track-list .editing-track", "background")
            playing_track_background = fallback_colour(".track-table tr.playing td", "background")
            text_backgrounds = {
                ".card-meta": (values["paper"],),
                ".field small": (values["paper"], values["white"], inline_background),
                ".lookup-state": (values["paper"],),
                ".suggestion-year": (values["white"],),
                ".art-empty": (artwork_background,),
                ".stat-tile small": (values["white"],),
                ".col-axis": (values["white"],),
                ".top-list li:before": (values["white"],),
                "#metadata-form .field,#metadata-form .checkline": (
                    values["paper"], values["white"], inline_background),
                (".editor-track-list .track-table th,"
                 ".editor-track-list .track-table tr:not(.disc-row)>td:first-child,"
                 ".editor-track-list .track-table td:nth-child(3)"): (
                    values["paper"], selected_track_background, playing_track_background),
            }
            for selector, backgrounds in text_backgrounds.items():
                for background in backgrounds:
                    with self.subTest(palette="forest", appearance=appearance,
                                      selector=selector, background=background):
                        self.assertGreaterEqual(
                            contrast(fallback_colour(selector, "color"), background), 4.5)

            # The same fallback is used by controls, genre chips and the scroll region.
            focus_colours = set(re.findall(
                r"outline:3px solid var\(--palette-focus,(#[\da-f]+)\)", forest))
            self.assertTrue(focus_colours)
            for focus in focus_colours:
                for background in (values["paper"], values["white"], inline_background,
                                   artwork_background, "#1e3027"):
                    with self.subTest(palette="forest", appearance=appearance,
                                      focus=focus, background=background):
                        self.assertGreaterEqual(contrast(focus, background), 3)


if __name__ == "__main__":
    unittest.main()
