# Standalone downloads and builds

Tagcast 1.0.0 packages the shared Python server and editor/player in an Electron
desktop app. No separate browser, Python or Node.js installation is required.
Python/source installs and the bundled terminal CLI retain browser use. See
[Electron desktop and Python/browser use](electron.md) for the shared-code design.

## Start and stop

| System | Download | Start |
|---|---|---|
| macOS, Apple Silicon | `tagcast-1.0.0-macos-arm64.zip` | Extract `Tagcast.app`, move it to Applications and open it. |
| macOS, Intel | `tagcast-1.0.0-macos-x64.zip` | Extract `Tagcast.app`, move it to Applications and open it. |
| Windows, x64 | `tagcast-1.0.0-windows-x64.zip` | Extract the whole folder and open `Tagcast.exe`. |
| Linux, x64 | `tagcast-1.0.0-linux-x64.tar.gz` | Extract with permissions and symlinks preserved; run `./Tagcast` inside the `Tagcast` folder. |

Keep the complete extracted Windows/Linux package together and the macOS app's
Contents intact. Closing the last window or choosing Quit stops the server owned
by that app after accepted requests/read-backs finish. A matching existing server
is reused and left running. Other versions or occupied foreign ports are rejected.
**Stop the older Tagcast before upgrading.** Closing a browser tab alone does not
stop a browser-based server.

Settings, tokens, cache and local account favourites remain in `~/.tagcast/`, or
`TAGCAST_HOME`. Electron's Chromium profile is separate from your browser's
preferences, local Change history and in-memory queue; those are not migrated.

The apps are not Developer ID signed/notarized or Authenticode signed. macOS has
an ad-hoc integrity signature. If opening is blocked, use **System Settings →
Privacy & Security → Open Anyway** on macOS, or **More info → Run anyway** on Windows.

Each archive has a separate `.sha256` companion under release Assets. Compare with
`shasum -a 256` on macOS, `sha256sum` on Linux, or `Get-FileHash` on Windows.

Native CI covers macOS 15 (Apple Silicon and Intel), Windows Server 2022
and Ubuntu 22.04. Linux needs a graphical desktop and compatible system libraries
(glibc 2.35 or newer); the download is not a universal Linux executable. Audio
outputs and codecs depend on Chromium and the operating system.

## CLI and Python/browser use

The bundled `tagcast-cli` (`tagcast-cli.exe` on Windows) supports the same `--port`,
`--open`, `--help` and `--version` options as a source installation. Its location
is `resources/backend/` inside the extracted Windows/Linux package. On macOS:

```sh
"/Applications/Tagcast.app/Contents/Resources/backend/tagcast-cli" --open
```

Homebrew links this executable as `tagcast-cli`. It stays in the terminal; stop
its server with Ctrl+C. The source scripts still work with Python 3.11+ or uv,
without Node.js or Tk for normal browser use:

```sh
uv run --frozen tagcast --open
```

## Build and verify

Build on the target OS/architecture with Python 3.13, Node.js 24 LTS and npm.
PyInstaller does not cross-compile. From this checkout:

```sh
uv run --frozen --python python --with-requirements requirements-build.txt python tools/build_electron.py
```

Use `--dir` for an unpacked local test app. Linux checks require a display; CI uses
`xvfb-run`. The existing SVG supplies native icons. Generated assets, work files
and reports are under ignored `build/`; verified archives are in `dist/packages/`.
The app includes Electron/Chromium notices and project/Python/dependency licenses.
The backend and terminal CLI share one bundled Python runtime, without Tk.

Every extracted application check starts the actual app with temporary Tagcast
settings and an isolated Chromium profile, outside the checkout in a path with
spaces. It checks shared assets, a disconnected account, sandboxing, context
isolation, owned-server shutdown and CLI help/version. macOS signatures are
verified and SHA-256 companions written after a successful check. PR builds retain
that ad-hoc integrity signature without a signing certificate or key; certificate
signing is not enabled by this override. These checks
never sign in to a live account or issue iBroadcast writes.

## Earlier downloads

Releases through 0.50.0 keep the original Tk desktop launcher and separate CLI.
Their interface opens in the browser, and their **Open browser automatically**
choice remains in `launcher.json`. Their build recipe is preserved at each tag;
see the [0.50.0 standalone guide](https://github.com/cyberdeliaAI/tagcast/blob/v0.50.0/docs/native-builds.md).
`tools/build_binary.py` and `tagcast.spec` retain that recipe for older packages.

## Releases

Keep `pyproject.toml`, `src/tagcast/__init__.py`, the version badge in `index.html`,
the Tagcast entry in `uv.lock` and the Electron package/lockfile versions consistent.
`python tools/release_info.py` checks them. Store release notes in
`.github/release-notes/VERSION.md`.

A main commit named exactly `Publish Tagcast VERSION` creates the stable release
after all regression, start-script and native build checks pass. The beta branch
retains the `Publish Tagcast X.Y.Z beta N` convention, Python version `X.Y.ZbN`,
release tag `vX.Y.Z-beta.N` and matching `X.Y.Z-beta.N.md` notes. Beta releases do
not replace the latest stable release.

`Builds` then attaches all four verified archives and checksums. Publishing a
release manually also triggers native builds. To rebuild an existing compatible
release, run `Builds` manually with its tag; an empty tag builds artifacts only.
The tag must match its application version. Tags from before 0.10.1 retain the
earlier single-console executable format, using the pinned legacy recipe. Only
publication jobs have write permission. There is no automatic app updater.
