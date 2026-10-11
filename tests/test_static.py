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
            rgb = [int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            channels = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
                        for v in rgb]
            return sum(v * weight for v, weight in zip(channels, (.2126, .7152, .0722)))

        def contrast(a, b):
            low, high = sorted((luminance(a), luminance(b)))
            return (high + .05) / (low + .05)

        for palette in ("ocean", "warm", "ibroadcast"):
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
                self.assertGreaterEqual(contrast("#ffffff", values["primary"]), 4.5)


if __name__ == "__main__":
    unittest.main()
