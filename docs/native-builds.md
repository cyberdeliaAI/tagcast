# Standalone downloads and builds

Tagcast 1.7.0 packages the shared Python server and editor/player in an Electron
desktop app. No separate browser, Python or Node.js installation is required.
Python/source installs and the bundled terminal CLI retain browser use. See
[Electron desktop and Python/browser use](electron.md) for the shared-code design.

## Start and stop

| System | Download | Start |
|---|---|---|
| macOS, Apple Silicon | `tagcast-1.7.0-macos-arm64.zip` | Extract `Tagcast.app`, move it to Applications and open it. |
| macOS, Intel | `tagcast-1.7.0-macos-x64.zip` | Extract `Tagcast.app`, move it to Applications and open it. |
| Windows, x64 | `tagcast-1.7.0-windows-x64.zip` | Extract the whole folder and open `Tagcast.exe`. |
| Linux, x64 | `tagcast-1.7.0-linux-x64.tar.gz` | Extract with permissions and symlinks preserved; run `./Tagcast` inside the `Tagcast` folder. |
| Debian / Ubuntu, x64 | `tagcast-1.7.0-linux-amd64.deb` | Install with `sudo apt install ./tagcast-1.7.0-linux-amd64.deb`; open Tagcast from the app menu. |

Keep the complete extracted Windows/Linux package together and the macOS app's
Contents intact. Closing the last window or choosing Quit stops the server owned
by that app after accepted requests/read-backs finish. A matching existing server
is reused and left running. Other versions or occupied foreign ports are rejected.
**Stop the older Tagcast before upgrading.** Closing a browser tab alone does not
stop a browser-based server.

Development main keeps a **Finishing Tagcast** window visible while an owned server
drains accepted changes, read-backs and local storage. Idle sockets, playback,
download/upload transfers and the download folder chooser are stopped separately.
An interrupted upload can still have reached iBroadcast; unknown outcomes are
reported before closing and never automatically retried. A second launch focuses
the finishing window. **Keep Tagcast open** cancels closing and restores the same
backend and drafts; playback, transfers and cleanup stay stopped. It does not
cancel an accepted metadata write or start another one. There is no deadline that
kills a protected operation. If a provider read remains stuck, keep Tagcast open
and allow the operation to settle; OS-forced termination cannot provide a clean
shutdown guarantee. Reused servers remain owned by their original launcher.

Settings, tokens, cache and local account favourites remain in `~/.tagcast/`, or
`TAGCAST_HOME`. Electron's Chromium profile is separate from your browser's
preferences, local Change history and remembered queue; those are not migrated.
Within the same profile/origin and account, the selected queue track and sorting
choices are restored after restart. Playback never starts automatically and elapsed
playback time is not restored.

Official macOS releases from 1.2.0 are Developer ID signed and notarized.
Ordinary PR/local test builds use an ad-hoc integrity signature instead. Windows
signing is still pending; only for trusted official downloads, use **More info →
Run anyway** if Windows warns. See [Code signing](code-signing.md).

Each archive has a separate `.sha256` companion under release Assets. Compare with
`shasum -a 256` on macOS, `sha256sum` on Linux, or `Get-FileHash` on Windows.

Native CI covers macOS 15 (Apple Silicon and Intel), Windows Server 2022
and Ubuntu 22.04. Linux needs a graphical desktop and compatible system libraries
(glibc 2.35 or newer); the download is not a universal Linux executable. Audio
outputs and codecs depend on Chromium and the operating system.

The Debian package is installed, started with Chromium's sandbox enabled and
removed on Ubuntu 22.04 and 24.04 in CI. It installs the app in `/opt/Tagcast`,
a desktop-menu entry, and `tagcast-cli` in `/usr/bin`. Remove with
`sudo apt remove tagcast`; user settings and sign-in data are retained.
The package uses electron-builder's standard per-application AppArmor/sandbox
installation hooks. Do not use `--no-sandbox` or globally disable AppArmor.
The portable TAR.GZ does not install these hooks: Ubuntu 24.04 can require
additional sandbox integration for that archive. Other Linux distributions are
not covered by these Debian installation checks.

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

Linux builds also repackage that same hardened app as a `.deb`; no second frontend
or backend is built. Debian installation/removal reports are tied to the exact
package checksum and required on both Ubuntu versions before publication.

Every extracted application check starts the actual app with temporary Tagcast
settings and an isolated Chromium profile, outside the checkout in a path with
spaces. It checks shared assets, a disconnected account, sandboxing, context
isolation, owned-server shutdown and CLI help/version. macOS signatures are
verified and SHA-256 companions written after a successful check. PR builds retain
that ad-hoc integrity signature without a signing certificate or key; certificate
signing is not enabled by this override. Explicit `--sign-macos` builds additionally
require Developer ID signing, Apple notarization, a stapled ticket and Gatekeeper
verification of the extracted ZIP; see [Code signing](code-signing.md). These checks
never sign in to a live account or issue iBroadcast writes.

Extracted app checks also run `tools/check_shutdown.py` against a disposable
loopback iBroadcast fixture: real native close/second launch, idle TCP, active
synthetic audio, stalled reads, accepted writes, pending read-backs, a lost write
answer, cleanup, uploads/downloads, folder selection, History after restart, and
recovery after an idle backend crash. Fixture writes never reach the real service.
The native folder chooser can be unavailable on a headless Linux host; its result
is recorded explicitly. Reports are retained in `build/reports/electron-shutdown.json`.
See [shutdown validation](audits/reliable-shutdown-2026-11-10.md) for the safety
model, original reproduction and platform limitations.

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

A main commit named exactly `Publish Tagcast VERSION` creates a draft stable release
after all regression, start-script and native build checks pass. The beta branch
retains the `Publish Tagcast X.Y.Z beta N` convention, Python version `X.Y.ZbN`,
release tag `vX.Y.Z-beta.N` and matching `X.Y.Z-beta.N.md` notes. Beta releases do
not replace the latest stable release.

The release marker must be the entire commit message, with no body or appended
pull-request number. For a squash merge, set the commit title explicitly and leave
the commit body empty. Keep the release explanation in the pull request and the
versioned release-notes file instead; the publication check compares the complete
commit message with the package version.

`Builds` requires its final verification gate, all four archives/checksums, the Debian package/checksum, installation reports and
archive-bound signing/notarization reports for both macOS architectures. It uploads
to the draft, checks the resulting asset set and only then makes the release public.
Failures leave the draft unpublished. An interrupted partial upload needs explicit
maintainer review before assets can be replaced. Publishing a
release manually also triggers native builds. To rebuild an existing compatible
release, run `Builds` manually with its tag; an empty tag builds artifacts only.
A nonempty tag requires macOS signing regardless of the test-signing checkbox.
Existing release assets are never overwritten automatically. Replacing a public
archive requires a separate, explicitly reviewed publication procedure.
The tag must match its application version. Tags from before 0.10.1 retain the
earlier single-console executable format, using the pinned legacy recipe. Only
publication jobs have write permission. There is no automatic app updater.
