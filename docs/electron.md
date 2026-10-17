# Electron desktop and Python/browser use

Since 0.60.0, standalone downloads for macOS (Apple Silicon and Intel), Windows x64
and Linux x64 use Electron 44.9.0. Source installs and the existing Python startscripts
continue to open the browser. Earlier releases retain their original browser launcher.

## One application, two ways to open it

Both routes use the same `src/tagcast/` server and `static/` interface. There is no
second editor, player, library model or implementation of iBroadcast writes.
`electron/` adds window/menu handling, navigation restrictions and child-process
ownership. It bundles the Python server, so end users need neither Python nor Node.js.

The desktop window has standard Edit, View and Window menus, zoom, fullscreen and
Quit. Existing Media Session controls, output selection, volume and streaming stay
in the shared player. AirPlay/Sonos support and audio quality are not implied by
Electron; available devices/codecs still depend on Chromium and the operating system.

## Settings, sign-in and closing

- Credentials, library cache, settings and local album favourites stay in the same
  `~/.tagcast/` folder, or the explicit `TAGCAST_HOME`. Nothing is copied into JavaScript.
- Electron has its own Chromium profile. Browser-local preferences, History/Undo
  and in-memory queues are separate from Safari/Chrome/Brave. They are not migrated
  automatically. The optional existing queue-sync feature remains available.
- The server binds to `127.0.0.1:8912`, or `TAGCAST_PORT`. A matching server already
  running on that port is reused and is left running on Quit. A different program,
  old version or incompatible host protocol is rejected; close it and retry.
- Closing the last window quits the desktop app. Only its owned server is stopped.
  Reviewed requests/read-backs finish; running cleanup batches stop between batches.
  There is no automatic forced kill or automatic resumption of writes.
- Existing unsaved-change/save warnings remain in force. Sign-in and external HTTPS
  links open in the system browser; web pages do not replace the application window.
  For an existing custom OAuth browser-redirect registration, return to Electron and
  use View > Reload after the browser confirms sign-in. Device-code sign-in updates
  the window normally and is the default.

## Run from source

Install the normal Python development environment first (`uv sync --frozen`), and
Node.js 24 LTS with npm. From the repository:

```sh
cd electron
npm ci
node node_modules/electron/install.js
npm start
```

The source launcher uses the repository's `.venv` Python, or an explicit
`TAGCAST_PYTHON`. It never installs a Python environment or changes dependencies
automatically. `TAGCAST_ELECTRON_PROFILE` can point at a separate Chromium profile
for development; use a separate `TAGCAST_HOME` for mock-account tests.

Python/browser use is unchanged: `start-tagcast.command`, `start-tagcast.sh`,
`start-tagcast.bat`, or `uv run tagcast --open`. Node.js is not required for this route.

## Build standalone downloads

Build on the target OS/architecture with Python 3.13, Node.js 24 LTS and npm:

```sh
uv run --frozen --with-requirements requirements-build.txt python tools/build_electron.py
```

Use `--dir` for an unpacked local test app and `--skip-install` only after `npm ci`.
The build freezes `tagcast.electron_host` and the browser CLI without Tk, packages them in Electron and
checks the actual app with disposable settings/profile folders. Complete downloads
are extracted and checked before their SHA-256 files are written to `dist/packages/`.
The macOS result is `Tagcast.app`, Windows has `Tagcast.exe`, Linux has `Tagcast`.
The separate `tagcast-cli` executable in `resources/backend/` (macOS:
`Tagcast.app/Contents/Resources/backend/`) retains normal browser/terminal use.
Keep the complete extracted package together.

Builds use ad-hoc macOS integrity signatures, not Developer ID notarization, and no
Windows Authenticode certificate. Platform opening requirements still apply.
The Electron MIT and Chromium notices remain in the app alongside the Python/runtime
licenses. All package/server/page/lockfile versions must match.

The Builds workflow checks all four targets. Ordinary pushes produce CI artifacts;
only the existing explicit release workflow attaches downloads to a release.
No Electron auto-updater is enabled. Tagcast's existing release check only notifies.

## Security and regression checks

The renderer is sandboxed, isolated and has no Node.js, preload bridge or generic IPC.
It can navigate only to the shared application's entry pages. External links are
parsed as HTTPS URLs; native/file/JavaScript protocols and new app windows are denied.
Permissions are restricted to the main application frame's fullscreen, audio output
and sanitized clipboard writes; camera, microphone and screen capture are denied.
The existing early theme scripts are hashed in the desktop CSP. API Host/header/Fetch
Metadata guards remain shared with the browser version.

```sh
uv run --frozen pytest -q
node --test tests/frontend.test.cjs
node --test electron/tests/*.test.cjs
python tools/release_info.py
```

The shell tests cover protocol/address validation, forbidden navigation/permissions,
CSP, real child startup/shutdown and a missing interpreter. Extracted downloads also
check the bundled CLI's help and version. Python tests cover owned
and reused servers, foreign/old servers, parent EOF, HTTP guards and graceful writes.
Manual playback/output/fullscreen checks are still needed on each platform; an app
loading successfully does not establish support for every audio device.
