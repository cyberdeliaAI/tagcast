"""Use lightweight CI only for an explicit allowlist of documentation changes."""

import json
import os
import re
import subprocess
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
DOC_SUFFIXES = {".md", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
IMAGE_LINK = re.compile(r"!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)")


def documentation_path(name):
    """Unknown paths, executable examples and workflow changes require full CI."""
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {".", ".."} for part in path.parts):
        return False
    if name in {"README.md", "PRIVACY.md", "LICENSE"}:
        return True
    if path.parts[:2] == (".github", "release-notes"):
        return path.suffix == ".md"
    if path.parts[:2] == ("docs", "themes"):
        return path.suffix in DOC_SUFFIXES | {".json"}
    return path.parts[:1] == ("docs",) and path.suffix in DOC_SUFFIXES


def git(*args, root=ROOT):
    return subprocess.check_output(["git", *args], cwd=root)


def changed_paths(event_name, event, root=ROOT):
    """Compare the entire PR, or the whole push; never rely on truncated API lists."""
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
    elif event_name == "push":
        if (event.get("head_commit") or {}).get("message", "").startswith("Publish Tagcast "):
            return None
        base, head = event["before"], event["after"]
    else:
        # Releases, explicit builds and workflow_run always use the complete suite.
        return None
    if not all(isinstance(sha, str) and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", sha)
               and set(sha) != {"0"} for sha in (base, head)):
        return None
    if event_name == "pull_request":
        base = git("merge-base", base, head, root=root).decode().strip()
    # Disable rename detection so both the old and new paths are classified.
    raw = git("diff", "--name-only", "--no-renames", "-z", base, head, root=root)
    return [name.decode("utf-8") for name in raw.split(b"\0") if name]


def check_documentation(paths, root=ROOT):
    """Check changed JSON/assets and local Markdown images without external requests."""
    changed = set(paths)
    for name in paths:
        path = root / name
        if path.is_symlink():
            raise ValueError(f"Documentation must not be a symbolic link: {name}")
        if not path.exists():
            continue  # Deleted assets are checked against remaining Markdown below.
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Documentation must be a nonempty regular file: {name}")
        if path.suffix == ".json":
            json.loads(path.read_text(encoding="utf-8"))
    # Also catch deleting/renaming an image still used by an unchanged guide.
    guides = [root / "README.md", root / "PRIVACY.md"]
    guides.extend((root / "docs").rglob("*.md"))
    guides.extend((root / ".github/release-notes").glob("*.md"))
    for guide in guides:
        if not guide.is_file():
            continue
        name = guide.relative_to(root).as_posix()
        for match in IMAGE_LINK.finditer(guide.read_text(encoding="utf-8")):
            url = urlsplit(match[1].strip("<>"))
            if url.scheme or url.netloc or not url.path:
                continue
            image = ((root if url.path.startswith("/") else guide.parent)
                     / unquote(url.path).lstrip("/")).resolve()
            if not image.is_relative_to(root.resolve()):
                raise ValueError(f"Image leaves the repository: {name}")
            image_name = image.relative_to(root.resolve()).as_posix()
            if (name in changed or image_name in changed) and not image.is_file():
                raise ValueError(f"Missing local image in {name}: {image_name}")


def choose_scope(event_name, event, root=ROOT):
    try:
        paths = changed_paths(event_name, event, root)
    except (KeyError, TypeError, ValueError, subprocess.CalledProcessError):
        # Missing history, malformed events and unknown filenames fail closed.
        return True
    if not paths or not all(documentation_path(name) for name in paths):
        return True
    check_documentation(paths, root)
    return False


def main():
    event_name = os.environ["GITHUB_EVENT_NAME"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    full = choose_scope(event_name, event)
    value = str(full).lower()
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"full={value}\n")
    message = ("Full application tests and all native builds required."
               if full else "Documentation only: local images, JSON and file checks passed. "
               "Application tests, media tests and native builds are not needed.")
    print(message)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as output:
            output.write(message + "\n")


if __name__ == "__main__":
    main()
