# Standalone downloads and builds

Tagcast 0.10.1 packages a desktop launcher and a CLI with PyInstaller. Python,
Tcl/Tk, iBroadcast dependencies and all browser assets are included. The main
interface remains in your browser; no Python installation is required for a download.

## Start and stop

| System | Download | Start |
|---|---|---|
| macOS, Apple Silicon | `tagcast-0.10.1-macos-arm64.zip` | Extract `Tagcast.app`, move it to Applications and open it. |
| macOS, Intel | `tagcast-0.10.1-macos-x64.zip` | Extract `Tagcast.app`, move it to Applications and open it. |
| Windows, x64 | `tagcast-0.10.1-windows-x64.zip` | Extract the whole folder and open `Tagcast.exe`. |
| Linux, x64 | `tagcast-0.10.1-linux-x64.tar.gz` | Extract with permissions and symlinks preserved; run `./Tagcast` inside the `Tagcast` folder. |

Keep Windows/Linux executables and `_internal` together; keep the macOS app's
Contents intact. The launcher opens your browser and stays open. **Stop Tagcast
and close**, the window's close button, or Quit on macOS stops its local server.
Closing a browser tab does not stop the server. If a server was already running,
the launcher opens that instance and leaves it running when its own window closes.

Settings, tokens and cache remain in `~/.tagcast/`, or `TAGCAST_HOME`. Stop your
older Tagcast before upgrading: a second copy otherwise opens the existing server.

The apps are not Developer ID signed/notarized or Authenticode signed. macOS has
an ad-hoc integrity signature. If opening is blocked, use **System Settings →
Privacy & Security → Open Anyway** on macOS, or **More info → Run anyway** on Windows.

Every archive includes a `.sha256` companion file. Compare with `shasum -a 256`
on macOS, `sha256sum` on Linux, or `Get-FileHash` on Windows.

Native CI covers macOS 14 (Apple Silicon), macOS 15 (Intel), Windows Server 2022
and Ubuntu 22.04. Linux needs a graphical desktop and compatible system libraries
(glibc 2.35 or newer); the download is not a universal Linux executable.

## CLI

The separate `tagcast-cli` (`tagcast-cli.exe` on Windows) supports the same
`--port` and `--open` options as a source installation, plus `--help` and `--version`.
On macOS it is inside `Tagcast.app/Contents/MacOS/`:

```sh
"/Applications/Tagcast.app/Contents/MacOS/tagcast-cli" --open
```

The CLI stays in the terminal; stop it with Ctrl+C. The source scripts still work
with Python 3.11+ or uv and do not require Tk for normal browser-based use.

## Build and verify

Build on the target OS/architecture with Python 3.13 including Tk. PyInstaller
does not cross-compile. From this checkout:

```sh
uv run --frozen --python python --with-requirements requirements-build.txt python tools/build_binary.py
```

Or install Tagcast and `requirements-build.txt` in a venv and run
`python tools/build_binary.py`. Linux checks require a display; CI uses `xvfb-run`.
The existing SVG supplies the native icons. Generated assets, work files and
reports are under ignored `build/`; verified archives are under `dist/packages/`.
Project and bundled dependency license notices are included.

Both executables are tested from the extracted archive, outside the checkout in
a path containing spaces. Checks start the real launcher with temporary settings,
verify HTTP assets, MIME types, bundled certificate data and API access guards,
then stop the test server. They never sign in to a live account. CLI help/version
and macOS bundle signatures are checked too.

## Releases

Keep `pyproject.toml`, `src/tagcast/__init__.py`, the version badge in `index.html`
and the Tagcast entry in `uv.lock` consistent. `python tools/release_info.py`
checks them. Store release notes in `.github/release-notes/VERSION.md`.

A main commit named exactly `Publish Tagcast VERSION` creates the stable release
after all regression and start-script checks pass. The beta branch retains the
`Publish Tagcast X.Y.Z beta N` convention, Python version `X.Y.ZbN`, release tag
`vX.Y.Z-beta.N` and matching `X.Y.Z-beta.N.md` notes. Beta releases do not replace
the latest stable release.

`Builds` then attaches all four verified archives and checksums. Publishing a
release manually also triggers native builds. To rebuild an existing compatible
release, run `Builds` manually with its tag; an empty tag builds artifacts only.
The tag must match its application version. Tags from before 0.10.1 retain the
earlier single-console executable format, using the pinned legacy build recipe;
they do not acquire the new launcher or checksums. Only the publication jobs have
write permission.
