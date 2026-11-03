"""Write the per-string CSV from inv-rows.json (summarize.py) and inv-py.json (inventory_py.py).

Usage: python3 -I export_csv.py <inv-rows.json> <inv-py.json> <out.csv>
"""
import csv
import json
import sys

rows = json.load(open(sys.argv[1], encoding="utf-8"))
py = json.load(open(sys.argv[2], encoding="utf-8"))["items"]
with open(sys.argv[3], "w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    writer.writerow(["layer", "file", "line", "component", "category", "kind", "context", "attribute_or_class",
                     "words", "interpolated", "fragment", "text"])
    for r in sorted(rows, key=lambda r: (r["file"], r["line"])):
        writer.writerow(["frontend" if r["file"].startswith("src") else "electron", r["file"], r["line"], r["component"],
                         r["category"], r["kind"], r["ctx"], r.get("attr") or r.get("key", ""), r["words"],
                         int("{}" in r["text"]), int(bool(r["fragment"])), r["text"]])
    for i in sorted(py, key=lambda i: (i["file"], i["line"])):
        category = {"raise-user": "ui-server-error", "raise-other": "internal-exception",
                    "tk-launcher": "legacy-launcher"}.get(i["kind"], "ui-server-payload")
        writer.writerow(["python", i["file"], i["line"], "Python backend", category, i["kind"], "", i["cls"],
                         i["words"], int(i["interpolated"]), 0, i["text"]])
