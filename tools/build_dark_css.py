"""Build static/dark.css from static/style.css.

Every colour in a rule gets a dark counterpart: the same hue and chroma, with its
lightness (OKLab L) mapped through a fixed curve, so light surfaces become dark ones
and dark text becomes light. A few surfaces and controls are set by hand. The sidebar
and the player are already dark and are left out.

Run after changing style.css:  python3 tools/build_dark_css.py
(tests/test_static.py fails when dark.css is out of date.)
"""

import re
import sys
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "src" / "tagcast" / "static"

# Already dark, or colours that sit on artwork: keep as they are.
KEEP = re.compile(r"^\s*(\.sidebar|\.brand|img\.brand|\.nav|\.artist-search|\.artist-list|\.artist-button|"
                  r"\.artist-more|\.artist-avatar|\.status-dot|\.sidebar-bottom|\.text-button|\.player|\.chart-tip|"
                  r"\.toast|\.cover|\.thumb|\.suggestion-art span|\.cover-button>span|\.art-tile span)")

# Variables that belong to the (already dark) sidebar.
KEEP_VARIABLES = ("--sidebar", "--accent")

# Set by hand: the main surfaces (cards lighter than the page, as dark themes do).
FIXED = {"#ffffff": "#1b2520", "#fbfcf9": "#18211c", "#f7f8f4": "#121915", "#fff": "#1b2520"}

# OKLab lightness in -> out, between these points linearly.
CURVE = [(0.0, 0.98), (0.30, 0.92), (0.45, 0.80), (0.58, 0.74), (0.75, 0.62),
         (0.90, 0.37), (0.97, 0.28), (1.0, 0.24)]

HAND = """
/* set by hand */
:root{color-scheme:dark}
.button.primary{background:#3e8a62;border-color:#3e8a62;color:#fff}
.button.primary:hover{background:#469a6e}
.overview{--chart:#52a874;--chart-track:#26372d}
.error-text{color:#f0a89b}
dialog::backdrop{background:#030806b3}
.field .genre-input input{border:0;background:none}
.art-compare img,.art-empty{background:#1f2a24}
"""


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _gamma(c):
    c = min(1.0, max(0.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def to_oklab(r, g, b):
    r, g, b = _lin(r), _lin(g), _lin(b)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def from_oklab(L, a, b):
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (_gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            _gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            _gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))


def curve(L):
    for (x0, y0), (x1, y1) in zip(CURVE, CURVE[1:]):
        if x0 <= L <= x1:
            return y0 + (y1 - y0) * (L - x0) / (x1 - x0)
    return CURVE[-1][1]


def dark(hex_colour):
    h = hex_colour.lower().lstrip("#")
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    rgb, alpha = h[:6], h[6:]
    if f"#{rgb}" in FIXED and not alpha:
        return FIXED[f"#{rgb}"]
    if alpha and int(alpha, 16) < 0x60:  # faint shadows and washes stay as they are
        return hex_colour
    L, a, b = to_oklab(*(int(rgb[i:i + 2], 16) / 255 for i in (0, 2, 4)))
    out = curve(L)
    if out < 0.45:  # dark surfaces and lines: less colour, or they look tinted
        a, b = a * 0.6, b * 0.6
    r, g, bl = from_oklab(out, a, b)
    return "#" + "".join(f"{round(v * 255):02x}" for v in (r, g, bl)) + alpha


COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b")


def rules(css):
    """Yield (at_rule_or_None, selector, declarations) for every plain rule."""
    i, wrapper = 0, None
    while i < len(css):
        start = css.find("{", i)
        if start < 0:
            return
        head = css[i:start].strip()
        if head.startswith("@media"):
            depth, j = 1, start + 1
            while depth:
                depth += {"{": 1, "}": -1}.get(css[j], 0)
                j += 1
            for _, sel, decl in rules(css[start + 1:j - 1]):
                yield head, sel, decl
            i = j
            continue
        if head.startswith("@keyframes"):
            depth, j = 1, start + 1
            while depth:
                depth += {"{": 1, "}": -1}.get(css[j], 0)
                j += 1
            i = j
            continue
        end = css.find("}", start)
        yield wrapper, re.sub(r"/\*.*?\*/", "", head, flags=re.S).strip(), css[start + 1:end]
        i = end + 1


def build(css):
    plain, auto = [], []
    for media, selector, declarations in rules(css):
        if not selector or KEEP.match(selector):
            continue
        coloured = [d.strip() for d in declarations.split(";") if COLOUR.search(d) and ":" in d
                    and not d.strip().startswith(KEEP_VARIABLES)]
        if not coloured:
            continue
        body = ";".join(COLOUR.sub(lambda m: dark(m.group(0)), d) for d in coloured)
        parts = [p.strip() for p in selector.split(",")]
        for prefix, out in ((':root[data-theme="dark"]', plain), (':root:not([data-theme="light"])', auto)):
            sel = ",".join(prefix if p == ":root" else f"{prefix} {p}" for p in parts)
            rule = f"{sel}{{{body}}}"
            out.append(f"{media}{{{rule}}}" if media else rule)
    hand_plain = HAND.replace(":root{", ':root[data-theme="dark"]{')
    hand_plain = re.sub(r"^(?!:root|/\*)(\S[^{]*)\{", lambda m: ",".join(
        f':root[data-theme="dark"] {s.strip()}' for s in m.group(1).split(",")) + "{", hand_plain, flags=re.M)
    hand_auto = hand_plain.replace(':root[data-theme="dark"]', ':root:not([data-theme="light"])')
    return ("/* Generated by tools/build_dark_css.py from style.css. Do not edit by hand. */\n"
            + "\n".join(plain) + "\n" + hand_plain
            + "\n@media (prefers-color-scheme: dark){\n" + "\n".join(auto) + "\n" + hand_auto + "}\n")


def main():
    output = build((STATIC / "style.css").read_text(encoding="utf-8"))
    if "--check" in sys.argv:
        sys.exit(0 if (STATIC / "dark.css").read_text(encoding="utf-8") == output else 1)
    (STATIC / "dark.css").write_text(output, encoding="utf-8")
    print(f"wrote {STATIC / 'dark.css'} ({len(output):,} bytes)")


if __name__ == "__main__":
    main()
