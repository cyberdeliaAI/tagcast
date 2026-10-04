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


if __name__ == "__main__":
    unittest.main()
