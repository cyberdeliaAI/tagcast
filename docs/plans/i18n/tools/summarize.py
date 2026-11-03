"""Aggregate the JS/HTML and Python inventories into the tables used by the plan."""
import json
import re
import sys
from collections import Counter, defaultdict

js = json.load(open(sys.argv[1]))
py = json.load(open(sys.argv[2]))

EXCLUDE_FILES = {"electron/smoke.cjs", "electron/sign-in-smoke.cjs", "electron/mini-smoke.cjs", "electron/theme-smoke.cjs",
                 "electron/mini-visual.cjs", "electron/security.cjs", "electron/harden.cjs"}
SAMPLE_TEXTS = {"After Hours", "The Tagcast Ensemble", "Blue in the evening", "A quieter place"}
PRODUCT_ONLY = re.compile(r"^(\{\})?(Tagcast|iBroadcast|Last\.fm|GitHub|Reddit|TheAudioDB|LRCLIB|Unison|Deezer|ListenBrainz|"
                          r"Wikipedia|Electron|Chrome|AirPlay|FLAC|MP3|Tagcast Website|Tagcast on GitHub|Tagcast on Reddit)$")
DIAGNOSTIC_FILES = {"src/tagcast/static/gapless-media.js"}

COMPONENTS = [
    ("Core shell, album grid, editor, review & history (app.js)", ["static/app.js"]),
    ("Static page skeleton (index.html)", ["static/index.html"]),
    ("Navigation, sidebar & settings", ["static/navigation.js", "static/settings.js"]),
    ("Appearance & theme editor", ["static/theme-editor.js", "static/themes.js"]),
    ("Help tours", ["static/help.js"]),
    ("Browsing: artists, albums, tracks, browse groups, favourites", ["static/album.js", "static/artists.js", "static/browse.js",
        "static/tracks.js", "static/favourites.js"]),
    ("Overview, service status & updates", ["static/overview.js", "static/service-status.js", "static/updates.js"]),
    ("Album background, biographies & 1001 Albums", ["static/album-info.js", "static/album-guide.js"]),
    ("Metadata editor helpers: credits, genres, online lookup, artwork", ["static/credits.js", "static/genres.js",
        "static/lookup.js", "static/artwork.js"]),
    ("Cleanup, year review, trash/duplicates & album merge", ["static/cleanup.js", "static/year-review.js", "static/trash.js",
        "static/album-merge.js"]),
    ("Playlists & CSV/URL import", ["static/collections.js", "static/playlist-tools.js", "static/playlist-order.js",
        "static/playlist-import.js"]),
    ("Tags", ["static/tags.js"]),
    ("Playback, queue, output, gapless, visualizer, queue sync", ["static/player.js", "static/playback.js", "static/gapless.js",
        "static/gapless-controls.js", "static/gapless-diagnostics.js", "static/gapless-media.js", "static/visualizer.js",
        "static/queue-sync.js", "static/mini-player.js"]),
    ("Lyrics (editor, import, Now playing)", ["static/lyrics.js", "static/lyrics-import.js", "static/playback-lyrics.js"]),
    ("Downloads, uploads & metadata export", ["static/downloads.js", "static/uploads.js", "static/metadata-export.js"]),
    ("Sign-in", ["static/sign-in.js"]),
    ("Mini Player window", ["static/mini-player/index.html", "static/mini-player/view.js"]),
    ("Electron main process", ["electron/main.cjs", "electron/help-menu.cjs", "electron/mini-player.cjs", "electron/sign-in.cjs",
        "electron/upload-picker.cjs", "electron/backend.cjs"]),
]


def component(path):
    for name, files in COMPONENTS:
        if any(path.endswith(f) for f in files):
            return name
    return "Other"


def category(item):
    if item["file"] in EXCLUDE_FILES:
        return "excluded-test-or-build"
    if item["file"].endswith("static/app.js") and 127 <= item["line"] <= 140:
        return "dnt-demo-metadata"
    if item["text"] in SAMPLE_TEXTS:
        return "dnt-sample-metadata"
    if PRODUCT_ONLY.match(item["text"]):
        return "dnt-product-name"
    if item["file"] in DIAGNOSTIC_FILES:
        return "technical-diagnostic"
    return "ui"


rows = []
for path, result in js["files"].items():
    for item in result["items"]:
        item["category"] = category(item)
        item["component"] = component(path)
        rows.append(item)

cat = Counter(r["category"] for r in rows)
ui = [r for r in rows if r["category"] in ("ui", "technical-diagnostic")]
print("CATEGORIES", dict(cat))
print("UI+diag items", len(ui), "unique", len({r["text"] for r in ui}), "words", sum(r["words"] for r in ui))
uionly = [r for r in rows if r["category"] == "ui"]
print("UI items", len(uionly), "unique", len({r["text"] for r in uionly}), "words", sum(r["words"] for r in uionly))


def kind(r):
    if r["kind"] == "html-attr":
        return "attr:" + r.get("attr", "")
    if r["kind"] == "html-text" and r["file"].endswith(".html"):
        return "static-html-text"
    if r["kind"] == "html-text":
        return "js-html-text"
    return "js-" + r["kind"]


print("KINDS", Counter(kind(r) for r in uionly).most_common())
print("ARIA-ish in JS sinks", Counter(r["key"] for r in uionly if r["ctx"] in ("ui-attr", "ui-prop")).most_common())
print("fragments", sum(r["fragment"] for r in uionly), "interpolated", sum(bool(r.get("interpolated")) or "{}" in r["text"] for r in uionly))
print("plural items", sum(r["kind"] == "plural" for r in uionly))

# per component
by = defaultdict(list)
for r in uionly:
    by[r["component"]].append(r)
files_by_comp = defaultdict(set)
for path, result in js["files"].items():
    if path in EXCLUDE_FILES:
        continue
    files_by_comp[component(path)].add(path)
metrics_by = defaultdict(Counter)
for path, result in js["files"].items():
    if path in EXCLUDE_FILES:
        continue
    metrics_by[component(path)].update(result.get("metrics", {}))
print()
print("| Component | Files | Items | Unique texts | Words | Interpolated | Fragments | Plural ternaries | `toLocale*(\"en…\")` | `localeCompare` | `innerHTML =` | `confirm()` |")
for name, _ in COMPONENTS:
    items = by[name]
    m = metrics_by[name]
    print(f"| {name} | {len(files_by_comp[name])} | {len(items)} | {len({r['text'] for r in items})} | {sum(r['words'] for r in items)} | "
          f"{sum(('{}' in r['text']) for r in items)} | {sum(r['fragment'] for r in items)} | {m['pluralTernaries']} | {m['toLocaleEn']} | {m['localeCompare']} | {m['innerHTML']} | {m['confirms']} |")
tot = Counter()
for path, result in js["files"].items():
    if path not in EXCLUDE_FILES:
        tot.update(result.get("metrics", {}))
print("TOTAL metrics", dict(tot))
print()
print("PER FILE")
for path, result in sorted(js["files"].items(), key=lambda kv: -len([i for i in kv[1]["items"] if i.get("category") == "ui"])):
    items = [i for i in result["items"] if i.get("category") == "ui"]
    if not items:
        continue
    print(f"| `{path.replace('src/tagcast/', '')}` | {len(items)} | {len({i['text'] for i in items})} | {sum(i['words'] for i in items)} |")

# python
pitems = py["items"]
user = [i for i in pitems if i["kind"] == "raise-user"]
print()
print("PY raise-user", len(user), "unique", len({i['text'] for i in user}), "words", sum(i['words'] for i in user))
print("PY other kinds", Counter(i["kind"].split(":")[0] for i in pitems))
print("PY by class", Counter(i["cls"] for i in user).most_common())
defensive = [i for i in user if re.match(r"^(Invalid|Choose a valid|Unknown|Unsupported|Request too large|Only )", i["text"])]
print("PY defensive-looking", len(defensive))
print("PY interpolated", sum(i["interpolated"] for i in user))
pfiles = Counter(i["file"] for i in user)
print("PY files", len(pfiles))
for f, n in pfiles.most_common():
    print(f"| `{f.replace('src/tagcast/', '')}` | {n} |")
print("PY non-raise payload text", [(i['file'].split('/')[-1], i['line'], i['kind'], i['text'][:70]) for i in pitems if not i['kind'].startswith('raise')])
json.dump(rows, open(sys.argv[3] if len(sys.argv) > 3 else "inv-rows.json", "w"))
