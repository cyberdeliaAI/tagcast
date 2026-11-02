"""Compare two text-scan.cjs dumps.

python3 text-compare.py english <before.json> <after.json>
    Every scenario must show the same texts and attributes (English must not change).
python3 text-compare.py untranslated <english.json> <translated.json>
    Lists visible texts in the translated dump that are identical to English interface text,
    excluding library data, product names and numbers.
"""
import collections
import json
import re
import sys

# Library data in tests/mock_ibroadcast.py and names that are never translated.
DATA = {"Kate Bush", "Pink Floyd", "pink floyd", "Hounds of Love", "The Dreaming", "Wish You Were Here", "Running Up That Hill",
        "Sat in Your Lap", "Old deleted", "Art Pop;New Wave", "Art Pop", "New Wave", "Rock", "wilfred", "Tagcast", "iBroadcast",
        "AirPlay…", "MusicBrainz", "Deezer", "Discogs", "Last.fm", "TheAudioDB", "Wikipedia", "LRCLIB", "Spotify", "Apple Music",
        "1001 Albums", "Tagcast for iBroadcast", "GitHub", "Reddit", "Various Artists", "CSV", "JSON", "M3U", "FLAC", "MP3", "OK"}
DYNAMIC = re.compile(r"^[\d\s:.,/%×·–\-+()#↑↓←→↗✓✕×•…]*$|^\d{1,2} [A-Z][a-z]{2} \d{4}|^v?\d+\.\d+")


def load(name):
    with open(name, encoding="utf-8") as handle:
        return json.load(handle)


def entries(scenario, visible_only=False):
    items = [("text", t["text"]) for t in scenario["texts"] if t["visible"] or not visible_only]
    items += [(a["name"], a["text"]) for a in scenario["attrs"] if a["visible"] or not visible_only]
    return items


def english(before, after):
    problems = 0
    for name, scenario in before["scenarios"].items():
        other = after["scenarios"].get(name)
        if other is None:
            print(f"## {name}: missing in second dump")
            problems += 1
            continue
        a, b = collections.Counter(entries(scenario)), collections.Counter(entries(other))
        gone, new = a - b, b - a
        if gone or new:
            problems += 1
            print(f"## {name}")
            for (kind, text), count in sorted(gone.items()):
                print(f"  - [{kind}] {text}" + (f" ×{count}" if count > 1 else ""))
            for (kind, text), count in sorted(new.items()):
                print(f"  + [{kind}] {text}" + (f" ×{count}" if count > 1 else ""))
    print(f"{problems} scenarios differ")
    return problems


def untranslated(english_dump, translated):
    known = {text for scenario in english_dump["scenarios"].values() for _, text in entries(scenario)}
    found = collections.defaultdict(set)
    for name, scenario in translated["scenarios"].items():
        for kind, text in entries(scenario, visible_only=True):
            if text in known and text not in DATA and not DYNAMIC.match(text) and re.search(r"[A-Za-z]{3}", text):
                found[(kind, text)].add(name)
    for (kind, text), names in sorted(found.items(), key=lambda item: (-len(item[1]), item[0])):
        print(f"[{kind}] {text}    ({len(names)}: {', '.join(sorted(names)[:3])})")
    print(f"{len(found)} distinct untranslated texts")
    return len(found)


if __name__ == "__main__":
    command, first, second = sys.argv[1:4]
    count = (english if command == "english" else untranslated)(load(first), load(second))
    sys.exit(1 if count else 0)
