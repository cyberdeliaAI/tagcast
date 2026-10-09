"""Check the package, CLI, page and lockfile versions before publishing."""

import argparse
import json
import os
import re
import subprocess
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def wait_for_native_builds(commit):
    """Do not publish a release whose four native downloads failed to build."""
    repository = os.environ["GH_REPO"]
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        output = subprocess.check_output([
            "gh", "api", f"repos/{repository}/actions/workflows/builds.yml/runs"
            f"?head_sha={commit}&event=push&per_page=10"], text=True)
        runs = [run for run in json.loads(output)["workflow_runs"]
                if run["head_sha"] == commit and run["event"] == "push"]
        if runs:
            latest = max(runs, key=lambda run: run["id"])
            if latest["status"] == "completed":
                if latest["conclusion"] != "success":
                    raise RuntimeError(f'Native builds failed: {latest["html_url"]}')
                return
        print("Waiting for all native builds to pass", flush=True)
        time.sleep(15)
    raise RuntimeError("Timed out waiting for native builds")


def release_info(root=ROOT):
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    match = re.fullmatch(r"(\d+\.\d+\.\d+)(?:b(\d+))?", version)
    if not match:
        raise ValueError(f"Unsupported release version: {version}")
    base, beta = match.groups()
    display = f"{base} beta {beta}" if beta else base
    tag = f"v{base}-beta.{beta}" if beta else f"v{base}"
    init = (root / "src/tagcast/__init__.py").read_text(encoding="utf-8")
    if not re.search(r'__version__\s*=\s*"' + re.escape(version) + r'"', init):
        raise ValueError("src/tagcast/__init__.py does not match pyproject.toml")
    page = (root / "src/tagcast/static/index.html").read_text(encoding="utf-8")
    if f'<span class="pill">{display}</span>' not in page:
        raise ValueError("The page version does not match pyproject.toml")
    lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    locked = [p["version"] for p in lock["package"] if p["name"] == "tagcast"]
    if locked != [version]:
        raise ValueError("uv.lock does not match pyproject.toml")
    return {"version": version, "display": display, "tag": tag,
            "prerelease": bool(beta), "notes": f".github/release-notes/{tag[1:]}.md"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true", help="Publish the tested GitHub Actions commit")
    args = parser.parse_args()
    info = release_info()
    print(json.dumps(info), flush=True)
    if not args.publish:
        return
    branch = "refs/heads/codex/album-player-beta" if info["prerelease"] else "refs/heads/main"
    if os.environ.get("GITHUB_EVENT_NAME") != "push" or os.environ.get("GITHUB_REF") != branch:
        raise ValueError("Releases require a push to the matching stable or beta branch")
    commit = os.environ["GITHUB_SHA"]
    message = subprocess.check_output(["git", "log", "-1", "--format=%B", commit], text=True).strip()
    if message != f'Publish Tagcast {info["display"]}':
        raise ValueError("The release commit message does not match the package version")
    if not (ROOT / info["notes"]).is_file():
        raise ValueError(f'Release notes are missing: {info["notes"]}')
    if not info["prerelease"]:
        wait_for_native_builds(commit)
    command = ["gh", "release", "create", info["tag"], "--target", commit,
               "--title", f'Tagcast {info["display"]}', "--notes-file", info["notes"]]
    command += ["--prerelease", "--latest=false"] if info["prerelease"] else ["--latest"]
    subprocess.run(command, check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
