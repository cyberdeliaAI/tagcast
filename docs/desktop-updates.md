# Desktop update installation

Tagcast 1.9.0 is the first updater-enabled desktop release. Tagcast 1.8.0
continues to check for updates and open the release page; it cannot install
1.9.0 itself. Install 1.9.0 once through the normal download or package-manager
route. Supported installations can then offer a later stable release.

## User flow

The existing daily public GitHub check remains independent of iBroadcast. Its
bounded release description is displayed as escaped, scrollable text: no provider
HTML, scripts, images or remote styles are loaded. The official release link
remains available for the complete notes and manual downloads.

Supported installed desktop copies offer **Download update**, progress, **Restart
and install**, **Later** and **Skip this version**. The dialog does not open itself
and downloading does not pause playback. Optional automatic downloading is off
for a new profile. The preference and skipped version are stored atomically in
the Electron profile, separately from backend/account settings. The existing
automatic-release-check setting still determines whether startup contacts GitHub;
a manual check does not implicitly download an update. A skipped release is
still visible through an explicit check.

Installation always needs an additional native confirmation. Ordinary Quit never
installs a downloaded update. Unsaved drafts retain the existing close prompt.
The owned backend finishes accepted writes, read-backs and local storage before
the native updater receives permission to install. Keeping Tagcast open cancels
that installation attempt; uncertain writes postpone it and resume the same
backend. No timeout kills an accepted write. Transfers and playback follow the
existing shutdown rules, and no iBroadcast mutation is retried.

## Platform routes

| Installation | Update route |
|---|---|
| Developer ID signed macOS app, Apple Silicon or Intel | Native signed-app replacement and restart. Production signing, notarization, stapling and Gatekeeper remain release gates. |
| Homebrew-managed macOS copy | Keep the Homebrew route: `brew upgrade --cask tagcast`. Detection is deliberately conservative when a Homebrew receipt is present. |
| Windows x64 per-user NSIS installation with a pinned trusted publisher | Download the complete NSIS installer, verify its Authenticode signature and run it after safe shutdown. Windows signing is pending, so current unsigned builds retain manual updates. |
| Debian/Ubuntu installation in `/opt/Tagcast` | Download the DEB, then let the native package installer request installation privileges. A rejected privilege prompt must leave the existing installation recoverable. |
| Portable Windows ZIP, Linux TAR.GZ, source/browser or ad-hoc macOS test app | Keep manual installation through the official release page. |
| Window reusing a separately started backend | Keep manual updates; the updater never stops a server it does not own. |

Portable downloads and the bundled `tagcast-cli` remain supported. The updater
never edits music files or the iBroadcast library. Application identity, profile
paths and backend settings remain unchanged.

## Package and publication contract

`electron-updater` 6.8.12 is pinned as a runtime dependency. Its automatic
download and install-on-quit defaults are explicitly disabled. The renderer can
send only a version and fixed actions; main-frame ownership is checked for every
IPC call. No URL, path, credential or command crosses this bridge.
The pinned native adapter disables staged-rollout identity creation and removes
the staging-ID header; no persistent installation identifier is sent to GitHub.

Downloads use a fixed HTTPS prefix under this repository's `releases/download/`
and a validated stable version. Metadata must match that version, an exact known
platform/architecture filename, a bounded size and a complete SHA-512 digest.
External URLs, relative traversal, duplicate entries and web-installer payloads
are rejected before downloading. Failures remain visible; retry is explicit.

Windows `publisherName` is deliberately empty until signing is integrated and
the actual certificate identity is verified. The client then requires a bounded,
nonempty publisher list and retains electron-updater's Authenticode verification.
Never bypass that verifier or treat a SHA-512 checksum as a publisher signature.
Do not advertise Windows installation from the app until that integration and a
signed two-version upgrade test pass.

The release pipeline keeps all existing archives, Debian installation reports,
SHA-256 companions and macOS signing checks. It adds a Windows NSIS installer and
checksum, with disposable install/start/restart/uninstall evidence. Only after
those checks succeed does the draft publisher generate `latest-mac.yml`,
`latest.yml` and `latest-linux.yml` from the exact verified package bytes. Both Mac
architectures share one feed. Feeds and packages enter the same draft, its complete
asset set is verified, and only then can the release become public. No updater
feed or replacement asset is added to an existing public release. Beta releases
do not publish the stable feeds.

Normal local Windows builds still create the checked portable ZIP without
installing software. CI additionally validates NSIS. To run that installer test
elsewhere, explicitly set `TAGCAST_TEST_WINDOWS_INSTALLER=1` only in a disposable
Windows environment; do not use it on a normal installed copy.

## Validation before release

Regression coverage must reject malicious/mismatched feeds, failed downloads,
overlapping actions, failed preference persistence, untrusted IPC senders and
installation before safe shutdown. Browser checks must preserve focus, playback
and history while progress changes. Native package checks must retain sandboxing,
CLI operation and the existing shutdown suite.

There is no earlier public updater-enabled client that can install 1.9.0. Before
publishing the first later stable release that 1.9.0 can install, validate an actual upgrade
between two disposable packages on both macOS architectures, Windows and the
supported Debian/Ubuntu systems, including canceled installation and failed
package verification. Signed macOS upgrade validation needs real signed test
packages with an empty release tag; unit tests and ad-hoc apps cannot establish it.
No real iBroadcast account writes are needed or permitted for these tests.

Local development validation on macOS ARM64 covered the complete Python suite
(1,008 tests and 2,677 subtests), frontend/Electron regressions, a disposable
native package, the existing 15 shutdown cases, and updater pointer/progress
interaction at 420, 760, 768 and 1280 pixels in light and dark themes. Synthetic
transfers exercise the pinned updater's actual checksum/cache path, including
corrupt packages. These checks do not establish signed in-place upgrade behavior
or replace the cross-platform CI and two-version validation above. The first
subsequent update chain must satisfy that gate; publishing the initial 1.9.0 client
does not establish signed in-place upgrade behavior.

References: [electron-builder 26 updater](https://www.electron.build/v26/docs/features/auto-update/),
[native builds](native-builds.md), [signing](code-signing.md).
