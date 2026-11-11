<p align="center"><img src="media/social/tagcast-social-preview.png" width="800" height="400" alt="Tagcast — your iBroadcast library. Your way."></p>

<p align="center"><b>Metadata editor &amp; player for iBroadcast.</b></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="src/tagcast/static/ibroadcast-dark-compact-powered.svg"><img src="src/tagcast/static/ibroadcast-light-compact-powered.svg" width="220" alt="Powered by iBroadcast"></picture><br><small>Independent app by Cyberdelia</small></p>
<p align="center"><a href="https://github.com/cyberdeliaAI/tagcast/actions/workflows/tests.yml"><img src="https://github.com/cyberdeliaAI/tagcast/actions/workflows/tests.yml/badge.svg" alt="Tests"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2e7d4f" alt="MIT license"></a></p>

Browse, discover and play your [iBroadcast](https://www.ibroadcast.com/) collection.
Fix metadata, find covers and artist images, review your changes, then save them
to iBroadcast. Use the **Electron desktop app** on macOS, Windows or Linux, or
run Tagcast in your browser with **Python**. Both share the same editor and player.

**Why Electron?**

Electron gives Tagcast a consistent desktop environment across macOS, Windows and
Linux. This helps us focus on reliable playback and safe metadata editing, while
keeping the interface shared with the browser version.

**Your existing local music files are never changed.** Optional album downloads
create separate local copies. Optional music uploads read selected local audio and
send copies to your own iBroadcast library only after review; see
[setup, privacy and current validation limits](docs/music-uploads.md). Tagcast's server listens on `127.0.0.1` only. It is an independent project, not made or endorsed by iBroadcast.

**New in [Tagcast 1.7.0](https://github.com/cyberdeliaAI/tagcast/releases/tag/v1.7.0):**
Optional continuous browsing and Random Order make larger libraries easier to
explore. Expanded Now playing offers eight local music visualizations and automatic
30-second rotation. This release also improves settings integrity, uncertain-write
verification, cached browsing, shutdown/restart, browser security and recovery from
temporary audio failures. Notifications no longer block controls beneath them.

Experimental Gapless playback remains optional and off by default. Unsupported
transitions safely use ordinary playback. See the
[release notes](.github/release-notes/1.7.0.md) and
[Gapless setup and limitations](docs/gapless-playback.md).

[Website](https://tagcast.app/) · [Install](#install) · [Wiki and user guide](https://github.com/cyberdeliaAI/tagcast/wiki) · [Community](#community) · [Screenshots](#screenshots) · [Updates](#updating) · [Media kit](media/README.md)

**Offline guide:** [Download the illustrated Tagcast 1.4.0 manual (PDF)](https://raw.githubusercontent.com/wiki/cyberdeliaAI/tagcast/manuals/Tagcast-1.4.0-User-Manual.pdf) — English, 38 pages, with screenshots and clickable contents.

![Pet Shop Boys in Now playing with album artwork, stereo meters, synchronised LRCLIB lyrics, the queue and compact player.](docs/screenshots/2026-11-11-interface/now-playing-lyrics-queue.png)

*Tagcast 1.7.0 — Now playing, captured on 11 November 2026. [See browsing, editing and fullscreen views below](#screenshots).*

## Watch the walkthrough

[![Watch the Tagcast feature walkthrough: fullscreen CD playback and synchronised lyrics](docs/screenshots/2026-11-08-walkthrough/feature-tour.jpg)](https://tagcast.app/#walkthrough)

**[Watch the Tagcast walkthrough](https://tagcast.app/#walkthrough)** — 2 minutes 42 seconds,
with short English captions and no sound. A tour of playback, lyrics, themes,
browsing, cleanup, album downloads and playlist import, recorded in November 2026.

## What you can do

iBroadcast controls account limits, available tracks and Premium entitlements.
Tagcast does not provide storage, remove provider limits or replace every iBroadcast
feature. See [iBroadcast's announced plan changes](https://news.ibroadcast.com/an-important-update-on-ibroadcast-s-pricing)
for storage and bandwidth rules; music hidden by those limits has not necessarily
been deleted. Original-quality streaming and lyrics saving require the corresponding
iBroadcast Premium access.

- **Browse and discover:** artists, albums, tracks, genres, tags, years, decades
  and the optional 1001 Albums guide.
- **Listen:** album playback, a play queue, playlists, fullscreen or in-window Now playing,
  volume and available audio outputs, supported system media controls and optional
  experimental gapless playback for compatible FLAC albums in order.
- **Edit metadata:** album/track details, separate artists and credit roles, genres,
  composers and artwork, assisted
  by online sources and a before/after review.
- **Organise:** native iBroadcast tags, independent local album and artist favourites,
  native star ratings, private playlists, folders, covers, CSV and public playlist URL import.
- **Clean up:** find missing metadata, review duplicate suggestions or select
  complete albums for iBroadcast's trash. Merge album fragments or manually split
  selected tracks into a new album after review. Nothing is permanently deleted.
- **Download albums:** reviewed local audio copies using the existing account connection,
  with quality choices, resumable streaming transfers and existing-file protection.
- **Upload music:** optional, reviewed uploads of selected local files or folders,
  with identical-file checks and explicit Start, Pause and Stop controls.
- **Lyrics:** follow temporary online text in expanded Now playing, or explicitly find
  ordinary LRCLIB text in the editor and review it before saving. See [lyrics sources
  and privacy](docs/now-playing-lyrics.md).
- **Personalise:** choose from six built-in palettes, create custom Light/Dark colour themes, preview changes and share
  themes through JSON import/export.
- **Export:** full loaded-library metadata as JSON or linked CSVs in a ZIP.
- **Keep track:** read-back checks distinguish confirmed saves from uncertain
  results; Change history records metadata outcomes and available artwork Undo.

[Album downloads](docs/audio-downloads.md) use
[ibfetch](https://github.com/cyberdeliaAI/ibfetch)'s transfer engine. For individual
tracks, playlists and advanced command-line download options, use ibfetch.

[Manually split an album](docs/album-splitting.md) includes an illustrated
real-library example and explains the review, limits and failure handling.

## Install

### Desktop app — no Python required

Download the archive for your computer from
[Tagcast 1.7.0](https://github.com/cyberdeliaAI/tagcast/releases/tag/v1.7.0):

| System | Download | Start |
|---|---|---|
| macOS, Apple Silicon | [ZIP](https://github.com/cyberdeliaAI/tagcast/releases/download/v1.7.0/tagcast-1.7.0-macos-arm64.zip) | Move `Tagcast.app` to Applications and open it. |
| macOS, Intel | [ZIP](https://github.com/cyberdeliaAI/tagcast/releases/download/v1.7.0/tagcast-1.7.0-macos-x64.zip) | Move `Tagcast.app` to Applications and open it. |
| Windows, x64 | [ZIP](https://github.com/cyberdeliaAI/tagcast/releases/download/v1.7.0/tagcast-1.7.0-windows-x64.zip) | Extract the whole archive, then open `Tagcast.exe`. |
| Linux, x64 | [TAR.GZ](https://github.com/cyberdeliaAI/tagcast/releases/download/v1.7.0/tagcast-1.7.0-linux-x64.tar.gz) | Extract with permissions intact; run `./Tagcast` in the `Tagcast` folder. |
| Debian / Ubuntu, x64 | [DEB](https://github.com/cyberdeliaAI/tagcast/releases/download/v1.7.0/tagcast-1.7.0-linux-amd64.deb) | Install with `sudo apt install ./tagcast-1.7.0-linux-amd64.deb`; open Tagcast from the app menu. |

macOS requires **13 Ventura or newer**. Linux needs a graphical desktop and
glibc 2.35 or newer. Keep the complete package together. No separate browser,
Python or Node.js installation is required. Each archive has a SHA-256 companion.

**[Code signing policy](#code-signing-policy)** · **[Privacy policy](PRIVACY.md)**

The macOS downloads are **Developer ID signed and notarized by Apple**. Windows
downloads are not yet Authenticode signed; Windows may show **More info → Run anyway**
after you review the download. See the
[installation guide](https://github.com/cyberdeliaAI/tagcast/wiki/Getting-started)
for details and the bundled browser CLI.

### Homebrew on macOS

```sh
brew install --cask cyberdeliaAI/apps/tagcast
```

Homebrew installs the matching desktop app and links `tagcast-cli` for terminal use.
[Homebrew guide](https://github.com/cyberdeliaAI/homebrew-apps#readme).

### Python/browser version

Extract the release's **Source code** archive or clone this repository. With
**Python 3.11+** or **uv**, use the script for your computer:

| macOS | Windows | Linux |
|---|---|---|
| `start-tagcast.command` | `start-tagcast.bat` | `./start-tagcast.sh` |

The scripts prepare a local environment and open your browser. Keep the terminal
open; Ctrl+C stops its server. From the source folder, uv users can also run:

```sh
uv run --frozen tagcast --open
```

[Source setup and port options](https://github.com/cyberdeliaAI/tagcast/wiki/Getting-started#run-from-source-with-python-or-uv).
No Node.js or Tk is required for normal Python/browser use.

## Connect iBroadcast

Choose **Connect iBroadcast → Sign in with iBroadcast** and approve Tagcast in the
iBroadcast sign-in window. Tagcast returns automatically; a code and browser link
remain available as a fallback. No client ID setup or client secret is needed;
your password stays on iBroadcast. Without an account, a demo library lets you
preview browsing and edits without saving to iBroadcast.

Settings, tokens, cache and local album favourites stay in `~/.tagcast/`, or
`TAGCAST_HOME`. Electron has its own Chromium profile; browser-local preferences,
Change history and queues are separate from your other browsers.
[Connection guide](https://github.com/cyberdeliaAI/tagcast/wiki/Connecting-to-iBroadcast).

## User guide

The **[Wiki](https://github.com/cyberdeliaAI/tagcast/wiki)** contains the full guide,
organised into focused pages:

| Topic | Guide |
|---|---|
| Install, connect and update | [Getting started](https://github.com/cyberdeliaAI/tagcast/wiki/Getting-started) · [Sign-in](https://github.com/cyberdeliaAI/tagcast/wiki/Connecting-to-iBroadcast) |
| Artists, albums, filters and appearance | [Browsing and discovery](https://github.com/cyberdeliaAI/tagcast/wiki/Browsing-and-discovery) |
| Sound, Now playing, queues and remote control | [Playback and queue](https://github.com/cyberdeliaAI/tagcast/wiki/Playback-and-queue) |
| Stars and hearts | [Ratings and favourites](https://github.com/cyberdeliaAI/tagcast/wiki/Ratings-and-favourites) |
| Playlists, folders and imports | [Playlists](https://github.com/cyberdeliaAI/tagcast/wiki/Playlists) · [CSV import](https://github.com/cyberdeliaAI/tagcast/wiki/Importing-playlists) · [Public playlist URLs](https://github.com/cyberdeliaAI/tagcast/wiki/Importing-public-playlists) |
| Native iBroadcast labels | [Tags](https://github.com/cyberdeliaAI/tagcast/wiki/Tags) |
| Editing metadata and compilation albums | [Metadata editor](https://github.com/cyberdeliaAI/tagcast/wiki/Editing-metadata) · [Various Artists walkthrough](https://github.com/cyberdeliaAI/tagcast/wiki/Various-Artists) · [Artist credits](https://github.com/cyberdeliaAI/tagcast/wiki/Artists-and-credits) |
| Suggestions, images and lyrics | [Online sources](https://github.com/cyberdeliaAI/tagcast/wiki/Online-sources) · [Artwork](https://github.com/cyberdeliaAI/tagcast/wiki/Artwork-and-artist-images) · [Lyrics](https://github.com/cyberdeliaAI/tagcast/wiki/Lyrics) · [LRC/TXT import](https://github.com/cyberdeliaAI/tagcast/wiki/Importing-lyrics) |
| Reviewed cleanup and trash | [Cleanup and duplicates](https://github.com/cyberdeliaAI/tagcast/wiki/Cleanup-and-duplicates) |
| Listening-list matches and background texts | [1001 Albums](https://github.com/cyberdeliaAI/tagcast/wiki/1001-Albums) |
| Settings, Help, saves, multi-disc sets and large libraries | [Settings and help](https://github.com/cyberdeliaAI/tagcast/wiki/Settings-and-help) · [Saving and history](https://github.com/cyberdeliaAI/tagcast/wiki/Saving-and-history) |

## Screenshots

The latest captures show **Tagcast 1.7.0** on macOS, captured on 11 November 2026.
Now playing appears above. The gallery below covers browsing, album and artist
details, image comparison, metadata editing/review and fullscreen CD/cover views.
Online lyrics are temporary display; a review is not a confirmed save.

<details>
<summary>Tagcast 1.7.0 — browsing, editing, review and fullscreen lyrics</summary>

![Tagcast 1.7.0 album grid with Continuous scroll, Random order and album selection controls.](docs/screenshots/2026-11-11-interface/albums-continuous-random.png)

*Browse your albums.*

![Full House by Wes Montgomery with genres, a native tag, ratings, album actions and attributed TheAudioDB background information.](docs/screenshots/2026-11-11-interface/album-full-house.png)

*Album details.*

![Wes Montgomery's artist page with photograph, ratings and a continuous album shelf.](docs/screenshots/2026-11-11-interface/artist-wes-montgomery.png)

*An artist's albums.*

![Album artists in Tagcast 1.7.0 with artist photographs, album counts, Random ordering and Continuous scroll.](docs/screenshots/2026-11-11-interface/album-artists.png)

*Explore album artists.*

![The O'Jays artist image chooser comparing no current image with a source-labelled suggestion; selection alone does not save.](docs/screenshots/2026-11-11-interface/artist-image-review.png)

*Compare artist images.*

![The Back On Top album editor with album fields, additional artist credits and online metadata suggestions.](docs/screenshots/2026-11-11-interface/editor-album.png)

*Edit album metadata.*

![Before/After review of album and track years and genres, with an explicit Save button; this is not a confirmed save.](docs/screenshots/2026-11-11-interface/metadata-review.png)

*Review before saving.*

![Expanded CD view with Pet Shop Boys artwork, track information, synchronised LRCLIB lyrics and the shared playback controls.](docs/screenshots/2026-11-11-interface/fullscreen-cd-lyrics.png)

*CD view and lyrics.*

![Expanded cover view with synchronised LRCLIB lyrics and an album-coloured background; provider attribution remains visible.](docs/screenshots/2026-11-11-interface/fullscreen-cover-lyrics.png)

*Cover view and lyrics.*

</details>

See the [full Wiki gallery](https://github.com/cyberdeliaAI/tagcast/wiki/Screenshots)
for all eight visualizations and other workflows. The
[capture inventory](docs/screenshots/2026-11-11-interface/README.md) records the unchanged originals.
[Earlier interface captures](https://github.com/cyberdeliaAI/tagcast/wiki/Screenshot-history)
remain archived. The [refresh checklist](docs/screenshot-checklist.md) tracks the
remaining capture work for the Wiki and a future PDF edition.

## Updating

**Quit the older Tagcast first**, or stop its terminal server with Ctrl+C. Replace
it with the new download, or update your source checkout. Your server settings
and local account favourites remain in place. Electron rejects an older server
on its port rather than loading the old interface.

For Homebrew: `brew update`, then `brew upgrade --cask cyberdeliaAI/apps/tagcast`.
Tagcast's update check only notifies; it never installs updates automatically.
[Update instructions](https://github.com/cyberdeliaAI/tagcast/wiki/Getting-started#updating-tagcast).

## Code signing policy

Tagcast has applied for Windows code signing through SignPath. Signing is
**not yet active**; approval and integration are pending.
Windows downloads remain unsigned. The macOS downloads are Developer
ID signed and notarized by Apple, independently of SignPath.

The planned signing service, subject to approval and integration, is:
Free code signing provided by [SignPath.io](https://signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

- **Committers and reviewers:** [kaosnews](https://github.com/kaosnews).
- **Approvers:** [kaosnews](https://github.com/kaosnews).
- People with source-code or signing approval access are required to use MFA on
  GitHub and SignPath. This policy does not certify individual account settings.
- Once enabled, release signing requests must be manually approved by the
  designated approver. Only verified builds from this repository will be submitted;
  release notes will identify which downloads are signed.

See the [privacy policy](PRIVACY.md) for iBroadcast connections, optional source
lookups, automatic update checks and the public service-status feed, including
the available controls. macOS signing and notarization are separate from SignPath.

## Community

Join **[r/Tagcast on Reddit](https://www.reddit.com/r/Tagcast/)** to ask questions,
share ideas and discuss Tagcast with other listeners. For bug reports, use
[GitHub Issues](https://github.com/cyberdeliaAI/tagcast/issues).

## Development

A Python server and plain JavaScript frontend are shared by both routes.
[Development and API notes](https://github.com/cyberdeliaAI/tagcast/wiki/Development),
[Electron design](docs/electron.md) and [native builds](docs/native-builds.md)
describe the architecture, test commands and packaging. See
[documentation maintenance](docs/documentation.md) for Wiki updates.

## Media, credits and license

The [media kit](media/README.md) contains logos, icons, wordmarks, screenshots and
the GitHub social preview. [Download the media ZIP](https://github.com/cyberdeliaAI/tagcast/raw/refs/heads/main/media/tagcast-media-kit.zip).

Developed by Cyberdelia, with AI-assisted development using Claude (Anthropic),
ChatGPT / Codex (OpenAI) and Mistral (Mistral AI).

[MIT](LICENSE) for Tagcast code. The original Powered by iBroadcast logos belong
to iBroadcast and are displayed under its
[branding guidelines](https://help.ibroadcast.com/en/developer/branding).
