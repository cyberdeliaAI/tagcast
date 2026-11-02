"""Read-only inventory of user-visible English text produced by Tagcast's Python backend.

Usage: python3 -I inventory_py.py <repo-root> <out.json>
"""
import ast
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

root = Path(sys.argv[1])
out = Path(sys.argv[2])

# Exceptions whose str() is returned to the browser by app.py `_run` or by job/result payloads.
USER_EXCEPTIONS = {
    "ApiError", "NotConnected", "ConnectionUnavailable", "ConnectionSecurityError", "UncertainWrite",
    "LibraryError", "ConflictError", "ArtworkError", "SourceError", "BiographyRetryError",
    "AlbumInformationRetryError", "UploadError", "UncertainUpload", "AuthRejected", "Unreachable",
    "Fail", "TerminalTransferError", "ServiceError", "FileChanged", "Stopped", "SessionChanged",
}
UI_KEYS = {"error", "message", "phase_text", "note", "warning", "detail", "title", "label", "explanation",
           "summary", "hint", "text", "status_text", "description"}


def text_of(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            parts.append(value.value if isinstance(value, ast.Constant) else "{}")
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = text_of(node.left), text_of(node.right)
        if left is not None or right is not None:
            return (left or "{}") + (right or "{}")
    if isinstance(node, ast.IfExp):
        a, b = text_of(node.body), text_of(node.orelse)
        return a or b
    return None


def letters(value):
    return len(re.findall(r"[^\W\d_]", value))


def words(value):
    return len(re.findall(r"[^\W_][\w'’-]*", value.replace("{}", " ")))


def name_of(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


items = []
other = Counter()
for path in sorted((root / "src/tagcast").glob("*.py")):
    rel = str(path.relative_to(root))
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
            cls = name_of(node.exc.func)
            if node.exc.args:
                value = text_of(node.exc.args[0])
                if value is not None and letters(value) >= 2:
                    kind = "raise-user" if cls in USER_EXCEPTIONS else "raise-other"
                    items.append({"file": rel, "line": node.lineno, "kind": kind, "cls": cls, "text": value,
                                  "words": words(value), "interpolated": "{}" in value})
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value in UI_KEYS:
                    shown = text_of(value)
                    if shown is not None and letters(shown) >= 2 and " " in shown.strip():
                        items.append({"file": rel, "line": value.lineno, "kind": f"dict:{key.value}", "cls": "",
                                      "text": shown, "words": words(shown), "interpolated": "{}" in shown})
        elif isinstance(node, ast.Call):
            callee = name_of(node.func)
            if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) \
                    and node.func.value.id in ("logging", "logger", "log"):
                other["logging calls"] += 1
                continue
            if callee in ("add_argument", "ArgumentParser", "add_parser"):
                other["argparse (CLI help)"] += 1
                continue
            if rel.endswith("desktop.py"):
                for keyword in node.keywords:
                    if keyword.arg == "text":
                        shown = text_of(keyword.value)
                        if shown and letters(shown) >= 2:
                            items.append({"file": rel, "line": node.lineno, "kind": "tk-launcher", "cls": "",
                                          "text": shown, "words": words(shown), "interpolated": "{}" in shown})
                if callee in ("set", "showerror", "title") and node.args:
                    for arg in node.args:
                        shown = text_of(arg)
                        if shown and letters(shown) >= 2 and " " in shown:
                            items.append({"file": rel, "line": node.lineno, "kind": "tk-launcher", "cls": "",
                                          "text": shown, "words": words(shown), "interpolated": "{}" in shown})
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            # note = "..." / reason = "..." / error = "..." local variables that flow into payloads
            target = node.targets[0].id
            if target in ("note", "reason", "error", "message", "warning", "detail", "phase", "label"):
                shown = text_of(node.value)
                if shown is not None and letters(shown) >= 2 and " " in shown.strip():
                    items.append({"file": rel, "line": node.lineno, "kind": f"var:{target}", "cls": "",
                                  "text": shown, "words": words(shown), "interpolated": "{}" in shown})

by_file = defaultdict(lambda: Counter())
for item in items:
    by_file[item["file"]][item["kind"].split(":")[0]] += 1
json.dump({"items": items, "other": other, "by_file": by_file}, out.open("w"), indent=1)
kinds = Counter(i["kind"].split(":")[0] for i in items)
print("total", len(items), "unique", len({i["text"] for i in items}), "words", sum(i["words"] for i in items))
print(kinds)
print(other)
for file, counter in sorted(by_file.items(), key=lambda kv: -sum(kv[1].values())):
    print(f"{file:40s} {sum(counter.values()):4d} {dict(counter)}")
