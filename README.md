<p align="center"><img src="assets/tagcast-icon.svg" width="96" alt=""></p>

<h1 align="center">Tagcast</h1>
<p align="center"><b>Metadata editor &amp; player for iBroadcast.</b></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="src/tagcast/static/ibroadcast-dark-compact-powered.svg"><img src="src/tagcast/static/ibroadcast-light-compact-powered.svg" width="220" alt="Powered by iBroadcast"></picture><br><small>Independent app by Cyberdelia</small></p>
<p align="center"><a href="https://github.com/cyberdeliaAI/tagcast/actions/workflows/tests.yml"><img src="https://github.com/cyberdeliaAI/tagcast/actions/workflows/tests.yml/badge.svg" alt="Tests"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2e7d4f" alt="MIT license"></a></p>

Browse, discover and play your [iBroadcast](https://www.ibroadcast.com/) collection. Fix metadata, find album covers and artist images, review your changes, then save them to iBroadcast.

Tagcast runs on your computer, with its interface in your browser. **Your local music files are never changed.** It listens on `127.0.0.1` only.

**New in [0.42.0](https://github.com/cyberdeliaAI/tagcast/releases/tag/v0.42.0):** Discover your collection with optional **1001 Albums**, manual matching and offline album background texts. Page-specific **?** tours explain the current screen. Duplicate-track cleanup now compares upload dates and formats, preferring FLAC over MP3 and then the newest upload. Customize the sidebar and explore decades with short music introductions. All features are included in the standalone downloads for macOS, Windows and Linux.

**Development on `main` (unreleased):** native tag management, reviewed album
selection trash, refreshed branding/sidebar and album pages, clickable browsing
breadcrumbs and release years, plus audio-output and system playback controls.
The packaged **0.42.0** downloads are unchanged. The current development interface is shown in the new screenshots below;
see the [capture checklist](docs/screenshot-checklist.md) for the remaining views.

[Install](#install) · [Connect iBroadcast](#connect-ibroadcast) · [Using Tagcast](#using-tagcast) · [Screenshots](#screenshots) · [Update](#updating-tagcast) · [Media kit](media/README.md)

![Current Tagcast album page for Mambo! by Yma Sumac, with context breadcrumb, genre chips, ratings and compact playback actions](docs/screenshots/album-details.png)

> Tagcast is an independent project. It is not made or endorsed by iBroadcast.

## Install

### Standalone downloads — no Python required

Open the [latest release](https://github.com/cyberdeliaAI/tagcast/releases/latest) and download the archive for your computer under **Assets**. These are the **0.42.0** packages:

| System | Download | Start |
|---|---|---|
| macOS, Apple Silicon | [tagcast-0.42.0-macos-arm64.zip](https://github.com/cyberdeliaAI/tagcast/releases/download/v0.42.0/tagcast-0.42.0-macos-arm64.zip) | Extract `Tagcast.app`, move it to Applications and open it. |
| macOS, Intel | [tagcast-0.42.0-macos-x64.zip](https://github.com/cyberdeliaAI/tagcast/releases/download/v0.42.0/tagcast-0.42.0-macos-x64.zip) | Extract `Tagcast.app`, move it to Applications and open it. |
| Windows, x64 | [tagcast-0.42.0-windows-x64.zip](https://github.com/cyberdeliaAI/tagcast/releases/download/v0.42.0/tagcast-0.42.0-windows-x64.zip) | Extract the whole archive, then open `Tagcast.exe` in the extracted folder. |
| Linux, x64 | [tagcast-0.42.0-linux-x64.tar.gz](https://github.com/cyberdeliaAI/tagcast/releases/download/v0.42.0/tagcast-0.42.0-linux-x64.tar.gz) | Extract with `tar -xzf tagcast-0.42.0-linux-x64.tar.gz`, then run `./Tagcast` inside the extracted `Tagcast` folder. |

On a Mac, **About This Mac** tells you whether you have an Apple chip or an Intel processor. Linux needs a graphical desktop and glibc 2.35 or newer. Keep the Windows/Linux executables and `_internal` folder together; keep the macOS app's Contents intact.

A small launcher window opens Tagcast in your default browser at <http://127.0.0.1:8912>. If the browser does not open, use **Open Tagcast in browser** in the launcher. **Keep the launcher open while using Tagcast.** Choose **Stop Tagcast and close** or close the launcher to stop the server it started. Closing just the browser tab does not stop Tagcast. If the launcher reused a server that was already running, closing it leaves that server running.

The downloads are not Developer ID signed/notarized on macOS or Authenticode signed on Windows. If your operating system blocks opening one, use **System Settings → Privacy & Security → Open Anyway** on macOS, or **More info → Run anyway** on Windows.

The launcher has an **Open browser automatically** checkbox, enabled by default. Untick it when using an app wrapper such as Unite Pro; the server still starts and **Open Tagcast in browser** remains available. The choice is remembered in `~/.tagcast/launcher.json` (or `TAGCAST_HOME`) and also applies when reusing an existing server. It does not change the CLI’s explicit `--open` option.

Each archive has a separate `.sha256` checksum file under Assets. See the [standalone guide](docs/native-builds.md) for checksum verification, the separate CLI and platform requirements. GitHub's **Source code** archives are for the source installation below.

### Homebrew on macOS

Install the same standalone app through the [Cyberdelia Homebrew tap](https://github.com/cyberdeliaAI/homebrew-apps):

```sh
brew install --cask cyberdeliaAI/apps/tagcast
```

Homebrew selects the Apple Silicon or Intel download, verifies its checksum and
installs the app in Applications, with `tagcast-cli` available in your terminal.
The first launch follows the same macOS security checks as the direct download.
If you installed Tagcast manually, stop it and move the existing
`/Applications/Tagcast.app` aside first; your separate settings stay in place.

For updates, stop Tagcast, run `brew update`, then
`brew upgrade --cask cyberdeliaAI/apps/tagcast`. New releases become available
after this tap's version and checksums are updated. See the
[tap guide](https://github.com/cyberdeliaAI/homebrew-apps#readme) for removal and maintenance.

<details>
<summary><b>Run from source with Python or uv</b></summary>

Download and extract **Source code (zip)** from the release, or clone this repository:

```bash
git clone https://github.com/cyberdeliaAI/tagcast.git
cd tagcast
```

You need [uv](https://docs.astral.sh/uv/) or **Python 3.11 or newer**. In the extracted/cloned folder, start the script for your system:

| System | Start script |
|---|---|
| macOS | Double-click `start-tagcast.command` (right-click → Open if macOS asks). |
| Windows | Double-click `start-tagcast.bat`. |
| Linux | Run `./start-tagcast.sh`. |

The scripts use uv when available. Otherwise they create a `.venv` beside the script and install Tagcast on the first start. Set `TAGCAST_NO_UV=1` to use the Python fallback explicitly. Keep the terminal window open; Ctrl+C stops the server it started. Starting another copy opens the existing Tagcast.

Or run it directly from a terminal in the source folder:

**With uv:**

```bash
uv run --frozen tagcast --open
```

**With Python on macOS/Linux:**

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/tagcast --open
```

**With Python on Windows (PowerShell):**

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\tagcast.exe --open
```

Use `--port 8913` to choose another local port, for example `uv run --frozen tagcast --port 8913 --open`.

</details>

## Connect iBroadcast

Without an account, Tagcast opens a **demo library** so you can try browsing and preview metadata edits. Demo edits are never saved to iBroadcast. Playback, the play queue and favourites need a live connection.

### Sign in from Tagcast

Tagcast includes its public iBroadcast client ID. **You do not need to create an
app, copy a client ID or supply a client secret.** You approve access on the
iBroadcast website; your password stays on iBroadcast.

1. In Tagcast, click **Connect iBroadcast**.
2. Choose **Sign in with a code**, then **Open iBroadcast sign-in**.
3. Enter the displayed code if asked, and approve Tagcast on the iBroadcast page.
4. Return to Tagcast. Your library loads automatically, and the sidebar shows your account name with a green connection dot.

![Tagcast's connection dialog, with direct code sign-in and no client ID setup](docs/screenshots/connect-ibroadcast.png)

The first download of a large library can take a little while. Later starts reuse a local cache when iBroadcast reports no changes. **Reload library** checks for changes; **Download everything again** in the connection dialog forces a fresh download.

**Existing connections are preserved.** A previously saved client ID or
`IBROADCAST_CLIENT_ID` environment override still takes precedence, and tokens
continue to use the registration that issued them. No automatic migration or
reconnection takes place. If you want to switch an older saved configuration,
choose **Disconnect**, reopen **Connect iBroadcast**, choose **Use Tagcast sign-in**
and sign in with a code. An environment override must be removed before restarting
to switch to Tagcast's default registration.

Browser redirect remains available for an existing custom configuration. Its
registered redirect URI must match `http://127.0.0.1:8912/callback`, or the actual
port you use. The shared Tagcast registration uses code sign-in, which also works
with the standalone launcher's automatically chosen port.

Tokens, saved configuration and cache stay in `~/.tagcast/` (`.tagcast` in your user
folder on Windows). Set `TAGCAST_HOME` to use another folder. Settings from the
earlier `~/.library-studio/` folder are migrated on first start. **Disconnect**
revokes the token and removes the local library cache. The bundled client ID is
public; access and refresh tokens are private and stay in the local server.

iBroadcast Support confirmed that Tagcast may distribute its public client ID
while review is pending. The review determines listing on iBroadcast's Apps page;
Tagcast does not claim that listing or endorsement.

## Using Tagcast

### Browse and discover

Tagcast starts on **Album artists**. Choose an artist to see their albums, or use **Albums** to browse the whole collection. Search, filter, sort, and switch between covers and a compact list. Choose **24, 50, 100 or 200 items per page**; Tracks and Favourites offer 50, 100 or 200.

| Page | What you can do |
|---|---|
| **Album artists** | Search artists, see their photos and album counts, or filter those without an image. Sort by name or choose **Random** for a shuffled list; its order stays the same while searching, paging and going Back. Choose a name sort and then Random again to reshuffle. Open an artist's albums and select several of their albums to edit together. |
| **Track artists / Composers** | Find albums featuring a performer or composer, with album and track counts. Stored iBroadcast artist IDs determine membership. |
| **Genres** | Browse main and additional genres. Click a genre on an album to open the same group. Combined labels such as `Pop;Rock` stay as stored until you choose to split them in the editor or reviewed cleanup. |
| **Tags** | Browse custom iBroadcast labels, including empty tags. Manage assignments on albums or individual tracks, or create, rename and delete labels after review. |
| **Release year** | Browse albums by track year, falling back to album year. Tracks without either appear under **Unknown year**. |
| **Decades** | Choose a period such as **1980s** for a random selection of albums. **Surprise me again** gives you another selection; use the page-size control to choose how many to show. |
| **Tracks** | Search every track by title, artist, album or composer. Case and accents do not matter: `bjork` finds Björk. Searches return at most 1,000 results. Open a result's album or play from that track. |

Track artist, composer, genre and year cards open **matching albums**, rather than a separate track list. One matching active track is enough to include an album. Multi-disc sets stay together and count as one album in these cards. Decades use the same year fallback and omit tracks with unknown years.

Album filters help you find missing years, genres, covers or composers; combined genres; artists without an image; albums with only 1–2 tracks; gaps in track numbering; repeated track numbers; and named editions. **Next album** lets you work through a filtered collection.

Browser **Back** and **Forward** restore the page you came from, including its search, filters and page. Back also preserves a decade's random selection. Collection and artist totals emphasize albums, with track counts below, using existing summaries. On a narrow screen, the hamburger menu keeps navigation, connection controls and source settings accessible.

In **Settings → Sidebar → Choose shortcuts and order**, hide optional shortcuts or
move items up and down. These changes apply immediately and are remembered in this
browser. **Album artists**, **Albums**, **Change history**, Settings and connection
controls remain available. **Restore default sidebar** resets the layout. Hiding a
shortcut does not disable its feature; Recently played and 1001 Albums still require
their separate opt-in settings.

The **Theme** button opens one menu with **Appearance** (Auto, Light or Dark) and **Colour**: **Forest** (the original green), **Ocean**, **Warm** and **iBroadcast inspired**. Colour and light/dark appearance are independent and remembered in this browser. The palette also applies to the sidebar, player and fullscreen Now playing. Switching colours keeps playback running and makes no library requests.

The sidebar header shows **Tagcast.**, with a dot in the palette's accent colour.
**Metadata editor & player** sits directly below the name, alongside the icon.
The version appears in one muted colour beside **Settings** in the footer,
with a compact original Powered by iBroadcast logo on the right.
The account status uses regular text weight.
**Reload library** and **Disconnect** share a row. Album artists uses a microphone,
Genres a label and Tags a hash icon. Album favourites uses a disc with a heart,
distinct from the heart for track favourites.

The cassette-in-sleeve sidebar icon follows the chosen colour palette. The standalone
app icon uses the primary blue and cream design.

### Your own iBroadcast tags

**Tags** in the sidebar shows your custom iBroadcast labels, including empty tags.
Open one to browse albums containing at least one tagged track. Search, sort and
page through tags as in the other overviews. Settings can hide or reorder this shortcut.

Album tags share a compact row with the genre chips. **+ Tag** stays available
whether or not tags are assigned and opens the same manager. You can also use
**Tags…** below a track's artist.
Album changes apply to all its tracks, including every disc of the displayed set.
The counts show partial assignments. **Keep as is** preserves them; choose
**Add to all tracks** or **Remove from all tracks** only for labels you want to change.
Search and paging retain your choices. **Review tag changes** lists the exact actions
before you confirm. Assignments are limited to 500 tracks / 20 tags per review.

**New tag…** creates an empty label after review; assign it to music afterwards.
Inside a tag's overview, **Rename tag…** and **Delete tag…** review changes to that
label throughout iBroadcast, including hidden and trashed memberships. Deleting a
tag keeps the music. Archived labels are marked; adding them is blocked because
they can hide music. Manage archiving in iBroadcast itself.

Tags remain separate from genres. Writes are checked against current data and
read back, without automatic retry or metadata Undo. Playback stays unchanged.
Existing assignments on other albums and untouched labels are preserved.

![Native Emusic tag on an album and its tracks, with genre chips, + Tag and the browsing breadcrumb](docs/screenshots/album-tags.png)

### Help and guided tours

Choose **?** in the top bar to start help for the page you are viewing. Album
artists explains that artist list; 1001 Albums explains its analysis and matching.
There is no topic chooser or unrelated tour. The **?** inside the album editor,
draft review, Settings and album chooser explains that dialog specifically.

Use **Previous**, **Next**, **Finish**, or **×** / Escape. Tours highlight controls
within the current page or dialog. If content is not available yet, the explanation
stays readable without opening another page. Tours never start playback, analysis
or saves, change preferences, or add browser history. Open drafts stay intact;
closing Help returns focus and the previous scroll position.

### 1001 Albums (optional)

Based on [*1001 Albums You Must Hear Before You Die*](https://en.wikipedia.org/wiki/1001_Albums_You_Must_Hear_Before_You_Die),
edited by **Robert Dimery**, with contributions from music critics.

Enable **1001 Albums** in **Settings → Discovery** and save. The sidebar then shows
the optional listening list. Press **Analyse my library** to compare it with your
loaded albums. Enabling the feature or opening the page never starts an analysis.

The page separates **In your library**, **Possible matches** and **Not found**.
Small decade buttons filter by the reference release year; **Year · oldest first**
and **Year · newest first** sort the complete filtered selection before pagination.
These choices combine with search and matching status and are restored on Back.
Open or queue a found album as usual. Multiple discs/editions count once for each
reference entry. Results are saved locally for your account; library changes are
flagged and require **Analyse again**. No audio is scanned and nothing is written
to iBroadcast.

Uncheck **Show matching details**, next to **Analyse again**, to hide the match
labels and the choose/change/undo link buttons on cards. Check it again to manage
links. This display choice is saved on this computer, including after a restart
or when Tagcast opens on a different local port or in another browser. Matches and links stay saved. Album names, editions, counts, filters and queue actions remain available.

Open a confirmed matching album to find **About this album** above its tracks.
Expand it for a locally bundled background text, with Wikipedia attribution and
license links. All 1,001 reference entries have a background text; reviewed title
and credit variants keep their original reference IDs. Reading a text makes no request to
Wikipedia or 1001 Albums Generator. See [offline texts and the capture tool](docs/1001-albums.md#offline-album-background)
for the comparison report and adding reviewed source links.

Choose **Confirm match…** for a possible match, or **Choose album…** to search your
loaded library and select the correct album yourself. Confirm with **Use this
album**. It then counts as found and is marked **Linked by you**. Manual links stay
local to your account and survive **Analyse again**. Use **Change link…** or **Undo
link** to revise a choice; undo restores the automatic analysis result.

The bundled selection contains the supplied 1,001 albums from 1955–2007, with repaired
characters, titles, artist names, swapped columns and selected release years. The
original entry order and manual links remain intact. After updating, restart Tagcast
and choose **Analyse again** to use the revised reference. Matching allows recognised remaster/deluxe suffixes while
retaining live/remix distinctions. A match does not confirm that every track is
present. See [reference cleanup and matching details](docs/1001-albums.md).

<details>
<summary><b>1001 Albums: results and choosing your edition</b></summary>

**In your library:** browse the matched albums, filter by decade and sort by year.

![1001 Albums showing matched albums, decade buttons and matching filters](docs/screenshots/1001-albums-found.png)

**Not found:** grey, softened placeholders keep missing entries visible in the list.

![Missing reference albums shown with grey placeholder covers](docs/screenshots/1001-albums-missing.png)

**Possible matches:** compare suggested editions before confirming them.

[Earlier-interface example of possible matches](docs/screenshots/1001-albums-possible.png).
The current capture set has no unresolved possible matches.

**Confirm a match:** check the album and choose **Use this album** to save a local link.

![Local album chooser finding Lady Soul with bonus selections by Aretha Franklin, with Use this album](docs/screenshots/1001-albums-chooser.png)

**Search the reference list:** find entries by artist or title. To choose a local
edition, use the search field in the chooser shown above.

![1001 Albums reference-list search showing Emmylou Harris and Violent Femmes results](docs/screenshots/1001-albums-reference-search.png)

**Album background:** open a confirmed match to read its locally bundled, attributed text.

![Violent Femmes album with the narrower About this album text expanded and the compact player running](docs/screenshots/1001-albums-background.png)

Background text: adapted from [Wikipedia contributors, *Violent Femmes (album)*](https://en.wikipedia.org/wiki/Violent_Femmes_(album)),
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The in-app
attribution is below this capture’s viewport; [text-license notice](src/tagcast/static/1001-album-notes-LICENSE.txt).

</details>

### Listen, Now playing and the play queue

Open an album and choose **Play album**, or use ▶ beside a track to start there and continue through the album. Playback continues while you browse or edit another album.

| Control | What happens |
|---|---|
| **Play album / ▶ on a track** | Starts that album, from the chosen track, and replaces the existing queue. Clicking the already-current track toggles pause/play. |
| **+ ▾** on an album card / **+ Queue ▾** on its page | Opens a menu for the entire album, including every disc of a set. Opening the menu does not change playback. |
| **+ ▾** beside a track | Opens the same menu for just that track. Use the arrow keys to choose, Escape to close, or click outside. |
| **Add to queue** in the menu | Appends the chosen track or album without interrupting the current track. An empty queue starts playing when you add to it. |
| **Player cover / queue button** | Opens **Now playing** with a large cover, the current track and the full play queue. Click a queue entry to jump to it. |
| **Play next** in the menu | Adds a track or a full album to Up next in click order, preserving disc/track order. Up next is consumed before returning to the original queue. |
| **Add to playlist…** in a track's **+ ▾** menu | Reviews adding only that track to a private new playlist or an existing playlist. Available in album tracks, Tracks, Favourites, Recently played and playlist tracks. |
| **↻ Repeat** | Cycles Off → Queue → Track. Queue repeat preserves album order; Track repeat applies when a track ends naturally. |
| **Save as playlist…** | Prepares a review of the queue before creating a private native playlist or appending to an existing playlist. |
| **Clear queue & stop** | Stops playback and removes the entire queue, including the current track. |

Use the player's previous/next buttons, seek bar and volume controls while browsing. Its album artist and album title link to their pages. A third line appears when the track artist differs; that name opens albums featuring that track artist.

The **speaker button → Sound** always provides a **Player volume** slider and
**Mute**, independently of the browser's native media controls. It adjusts the same
audio element without restarting playback or changing the queue, and follows
volume changes made through the native controls. It controls this player, separately
from system or speaker volume. Outputs or browsers that refuse volume changes show
a message to use the system or device controls.

Below the volume controls, **Audio output** offers a browser device picker or a list of
permitted outputs when supported. In Safari and compatible wrappers, **AirPlay…**
opens the native route picker when available. Otherwise, choose an output in your
computer's sound settings; compatible AirPlay speakers, including supported Sonos
models, may appear there. Available devices depend on your browser and system.
Tagcast does not request microphone access to discover speakers. Changing an output
keeps the existing audio element, track position and queue; the choice is not saved
as a Tagcast preference. This does not add direct Sonos or Chromecast control.

Where the browser supports Media Session, system media controls and media keys can
play/pause, move to the previous/next track and seek. The system receives the current
track artist, album, cover, playback state and progress. **Stop** clears the queue,
like **Clear queue & stop**. The controls operate only this browser's local player;
an optional queue-sync controller does not claim system playback. The controls
shown by the operating system vary by browser and platform.

Track rows show the file format (such as FLAC or MP3) below the duration when iBroadcast provides a recognized format. The same label appears in Tracks search and Favourites; it requires no extra requests and does not indicate the playback stream’s bitrate or resolution.

By default, the queue lives in the current browser page and resets when you reload it. Save it as a playlist to keep its contents, or explicitly connect the optional queue synchronisation described below. Audio goes through Tagcast's local server, keeping the access token out of the page; supported audio formats depend on your browser. **Play reporting is off by default.** Enable **Settings → Playback → Record played tracks in iBroadcast** to send a track ID and UTC timestamp after more than ten seconds of actual listening. Pauses, buffering and seeking do not count toward the threshold. Each playback sends at most one play; replaying the track starts another. Enabling midway starts counting from that moment; earlier plays and skips are not sent. An uncertain request is not automatically retried, so a network failure can leave a play unrecorded. Playback continues, and the error is available in Settings. Tagcast itself does not send Last.fm scrobbles.

![Now playing beside the Violent Femmes album, with the queued tracks, playlist action and Clear queue and stop](docs/screenshots/now-playing-queue.png)

### Streaming quality, album ratings and playlists

**Settings → Playback → Streaming quality** chooses MP3 96/128/192/256/320 kbps
or **Original**. The preference applies to the next track. [Free accounts use 128 kbps](https://help.ibroadcast.com/playing-music); all other choices, including 96 kbps and Original, require Premium; a free account uses 128 kbps for a selected
Premium option. The player displays **File: FLAC · Stream: MP3 128 kbps**, for
example: the uploaded file format and this playback request are different things.
If Original cannot play in the browser, Tagcast tries MP3 128 kbps once and labels
the fallback. It does not infer bit depth, sample rate or audio identity.

The album page has native **0–5 star ratings** and an **album favourite** heart
(rating 5). **Album favourites** lists the rated albums using existing summaries.
A merged set is rated disc by disc and appears as a favourite when every disc is
rated 5. Mixed ratings are shown explicitly. Each write checks the current rating
and reads it back; ratings stay separate from metadata Change history. The requested
stars appear immediately with **Saving rating…**, followed by **Checking iBroadcast…**
and a confirmation or error. The cached rating changes only after read-back, and
the page updates automatically. Large libraries can still take time to verify.
Track hearts also show the requested choice while saving/checking.

**Playlists** lists your editable iBroadcast playlists. Open one to play from its
first track or any selected position, rename it or uncheck tracks in an edit.
**Add to playlist…** on an album includes all of its discs in order. **Save as
playlist…** in Now playing saves the entire queue; **Add this track to playlist…**
adds only the currently playing track. A track's **+ ▾ → Add to playlist…** does the
same for a selected track without loading its entire album. Choose a private new playlist
or find an existing playlist by name; **Add current queue…** on a playlist page
appends directly to that playlist after review. Repeated track IDs are retained
once in their first position, as iBroadcast's append operation does. System
playlists and folders cannot be edited. Nothing is sent until **Save to
iBroadcast**, and a stale preview is rejected before writing. A failed/uncertain
creation or append is never retried automatically; inspect Playlists first.

Open a playlist and choose **Delete playlist…** to review its name and track count.
Confirm **Delete playlist** to remove that playlist from iBroadcast. Its music stays
in your library and the current play queue keeps running. System playlists and
folders are protected; a changed name or track list requires a new review. Deletion
is read back, cannot be undone in Tagcast and is never retried automatically.

### Optional queue synchronisation and remote control

1. Enable **Settings → Devices & queue synchronisation → Enable queue
   synchronisation and remote control**, then save.
2. Use **Reconnect iBroadcast** and approve `user.queue:read` and
   `user.queue:write`. Ordinary sign-in keeps the existing library/account scopes
   when this option is disabled.
3. Open **Devices** and choose **Connect this app's queue**. Restore the saved
   queue and explicitly play here, or replace it with your current local queue.
4. Choose **Control [device]** to join an available device's queue. Previous/Next,
   Play/Pause, position, volume and repeat control that device. The controller
   pauses its local audio, records no plays and never advances a finished track.
5. **Disconnect queue** stops the bridge without stopping the remote device.
   Disabling the option closes the connection. Only one browser tab owns a bridge;
   another tab can explicitly disconnect it before taking over.

The server obtains a fresh one-use WebSocket token and keeps it and OAuth tokens
out of the frontend. It restores native `tracks`/`play_next`, retains the base
queue for Previous and repeat, and waits five seconds between reconnect attempts.
Library-change notifications offer a manual reload so an edit is not interrupted.
These flows are covered by mock API/WebSocket tests and browser interaction checks;
compatibility with a particular real iBroadcast device still requires its live
session and the additional OAuth consent. Queue synchronisation is independent
of optional play reporting and is off by default.

### Settings and the library information banner

**Settings** in the sidebar contains playback recording, online sources and keys,
automatic lookups and Tagcast update checks. Use the **×** at the right of the
library information banner to hide it. This preference is remembered in the
current browser. Restore it through **Settings → Interface → Show library information
banner**. Hiding this banner does not hide save errors or review warnings, and
changing these preferences does not restart the player.

**Settings → Interface** also lets you show or hide **file format and stream quality**
and **track artists** in the compact player. Both are shown by default. These choices
apply immediately and are remembered in the current browser. The title, album artist
and album stay visible; track and album pages and fullscreen Now playing keep their
information. Hiding the quality label does not change the streaming quality.

### Enlarging album covers

Open an album, then double-click its cover to open a lightbox, or focus the cover
button and press Enter. Close with **Escape**, the **×**, or a click outside the
image view. Covers in grids and lists open their album immediately. The compact
player's cover opens Now playing immediately.

Album cards and list rows have a small **Play** button beside the compact **+**
menu. Play starts the complete album/set and replaces the queue without opening
another page. The + menu keeps its queue actions. **Play random album** remains
available in All albums and discovery groups; cleanup filters and manual album
selections hide it.

The viewer contains the full image without cropping. Larger iBroadcast artwork
loads only when you open it; if unavailable, Tagcast falls back to the existing
cover. Playback, the queue and browser history stay unchanged.

### Recently played

Enable **Settings → Playback → Record played tracks in iBroadcast** to show
**Recently played** in the sidebar. This page reads iBroadcast's native recent
tracks playlist, including plays reported by your other devices. Disabling play
recording hides the page; Tagcast does not maintain a separate local listening list.

Tracks stay in iBroadcast's order, most recent first, with each track appearing
once. The playlist does not provide play timestamps or a complete event history.
Search and pagination run on the server; play a track, open its album, or add it
to the queue using the usual controls.

Opening the page checks for an updated library. **Refresh from iBroadcast** fetches
it again, including when iBroadcast's change timestamp has not advanced. A large
library can take longer to refresh; playback never downloads the library just to
update this page. Older caches are upgraded once on first use. If iBroadcast does
not supply this playlist, the page explains that it is unavailable.

### Favourites

Click the **heart** on an album track, a track search result or the player to add or remove a favourite. **Favourites** gives you a searchable, paginated list of your liked tracks; you can play them or add them to the queue.

Favourites use **iBroadcast's native track ratings**: adding sets the rating to **5**, and removing clears it to **0**. Tracks rated 5 or higher are already included. Replacing a lower nonzero rating asks for confirmation first. These changes save directly, check the displayed rating against iBroadcast and read the result back. They are separate from metadata Change history and Undo.

### Edit metadata and artwork

1. Open an album and choose **Edit**. Edit its title, album artist, release year or disc number, and genres or composers for its tracks. Individual tracks can also have their own title, artist, year, track number, genres and composers.
2. Use the online suggestions beside the form if helpful. Click a year or genre to fill the form, Shift-click a genre to add it, or choose **Use all** for the suggested genres. Suggestions do not save anything by themselves.
3. **Review** the before/after values, then choose **Save to iBroadcast**. Tagcast checks the existing values first and downloads the library again to confirm accepted writes. Change history shows the progress and result.

To edit several albums, open **one album artist**, tick their album cards and edit the selection. Only the fields you enable are changed. Album year changes leave track years alone unless you tick **Also apply the release year to tracks**; individual track edits take precedence over album-wide edits.

For compilations, tick **Various Artists** beneath **Album artist**. This uses iBroadcast's native Various Artists album artist and preserves every track's artist and additional credits. Untick it to enter an album artist again. The choice is included in the normal before/after review, also for all discs of a set; when editing a selection, first enable **Change Album artist**.

New album and track years must be **1800–2050**; use **0** or clear the field to remove a year. The editor and server both enforce this range, including online suggestions and album-wide track-year changes. An existing year outside the range can remain untouched while you edit other metadata.

Genres are separate labels: the first is the main genre, and the others become additional genres. **Split** or **Split combined genres** explicitly separates labels such as `Pop;Rock`. Composers are stored as composer credits; other credits, such as featured artists, are preserved.

For covers and artist images, choose an online suggestion, existing iBroadcast artwork, your own file, a pasted image or an image URL. Compare old and new, then explicitly save the artwork. JPEG, PNG, WebP and GIF are supported, up to **15 MB**. Image URLs pointing to this computer or the local network are refused.

**Artwork Undo restores a previous image when one exists.** If an artist had no image before, Undo cannot remove the new image and explains that no previous image is available. Metadata edits, favourites and trash moves do not have automatic Undo. See [how saving stays safe](#how-saving-stays-safe) and [multi-disc sets](#combine-multi-disc-album-sets) below.

### Fullscreen Now playing

Album pages keep the cover aligned with the title and group genres and tags in one
compact row. Click the release year to browse that year in your collection.
**+ Tag** opens tag management; partial and archived assignments remain
visible. Unset hearts/stars stay neutral, and **Clear** appears only when rated.
Use **⋯ → Move to trash…** for the existing track selection and review.
The clickable breadcrumb follows where you opened the album, such as
**Workspace / Tags / Emusic / album**. Return to that context with its filters,
order, page and scroll position; direct album links fall back to **Albums**.

The fullscreen icon in the player opens a focused view of the current album cover,
track title, album artist and album. A different track artist appears underneath.
The same player controls remain available, so playback and the queue continue
without restarting. Press **Escape** or use the close button to return to your
library. Where native browser fullscreen is unavailable, the view fills the browser
window. No extra album or track details are downloaded for this view.

### Random album playback

**Play random album** is available on Albums, an album artist’s collection, and
the album lists within Genres, Release year, Decades, Track artists and Composers.

The button respects the current artist, search and filters and chooses from all
matching albums across every page. Within a decade it uses the whole matching
decade, not just the displayed random sample. It plays the complete album in track
and disc order and replaces the queue. Disc sets have one chance each. When there
is another choice, the currently playing album is skipped. Plays follow your
optional play-reporting setting; starting a random album does not change metadata.

### Batch metadata cleanup

Open **Overview → Metadata health → Clean up metadata…**, or use the shortcut
in the Combined genres album filter. Prepare a
library-wide preview for combined genres, track artists or composers. The separate
**Review genre labels** category lets you choose one exact stored label and enter
its replacements, one per line, without guessing slash or comma separators.
**Remove this label from matching tracks** explicitly removes only that label,
preserving other genres or clearing the genre when it was the only one. Exclude
albums, then approve and start. Changes are saved to iBroadcast in checked batches,
with progress, stop/resume and a downloadable before/after report. Additional track
artists are included in browsing, search and player links. Album cards use a compact
queue `+` in their aligned information row.

Semicolon cleanup splits only `;`; slashes, commas and ampersands are kept. Each
batch contains at most **200 tracks from 20 displayed albums** and is read back
before the next batch. Conflicts, request errors or unconfirmed writes stop the
job. Resume is explicit and rechecks current values. Preparing a preview does not
save anything. See the [cleanup instructions](docs/metadata-cleanup.md) for the
complete steps, exact genre replacement and recovery.

### Move tracks to trash

In **Albums**, use any filter, such as **1–2 tracks**, then tick albums in the grid
or list and choose **Move selected albums to trash…**. Albums by different artists
can be selected together; the same action is available on an album artist's page.
Selections survive paging and filter changes. The selection count flags albums
outside the current results, and **Clear** clears the whole selection.
The review lists every album and lets you expand its tracks. Confirm once; larger selections use
batches of up to 20 displayed albums / 500 tracks, checking complete membership
and reading back each batch before continuing. Stop or close the review to prevent
later batches. Changed albums or unconfirmed results stop processing. Results go
to Change history; restarting never resumes the operation automatically. A single
album/set above 500 tracks requires smaller track selections from its album page.

To find candidate albums, open **Albums** and choose the **Duplicate tracks**
filter. Open an album to inspect its tracks.

For many albums, choose **Review suggested copies across all albums…** on that
page. **Analyse all albums** prepares a local draft using the same format/date
rules as **Select suggested copies**, across the entire library regardless of
search or pagination. Opening the dialog only reads its saved report.

Expand an album to compare each proposed copy with the retained copies. Uncheck
an album or an individual proposed track to keep it. Uncertain copies stay out
of the selection; differing titles have an explicit comparison notice. After
reviewing, tick the approval checkbox and choose **Move selected copies to trash**.
Tagcast processes up to 200 tracks from 20 displayed albums per batch, checks
current metadata and retained copies before writing, and reads the results back.
**Stop after current request** prevents later batches. Drafts and results survive
restarts on this computer and belong to the connected account. **Check outstanding
and continue** checks interrupted requests first; an uncertain request is never
automatically resent. Export the full report to keep a copy, and use **Refresh album
list** afterwards to update the displayed counts. A new analysis replaces the old
report. Batch results use this report separately from metadata Change history.

Remove unwanted duplicate copies from an album in three reviewed steps:

Use **Albums → Duplicate tracks** to find albums with repeated track numbers on
one disc, for example `1, 1, 2, 3, 4, 4`. The filter includes different titles,
such as a plain title and a copy with added soundtrack information.

1. **Open the album and choose ⋯ → Move to trash…** **Duplicated** appears on album
   cards, list rows and tracks with repeated positive track numbers on the same
   disc, even when titles differ. Hover over a track badge for the matching reason.
   Checkboxes appear beside the tracks; nothing is sent yet.
2. **Select the copies you want to remove.** Upload dates/times and **Suggested keep**,
   **Suggested trash** or **Compare manually** labels help you compare the copies.
   **Select suggested copies** prefers FLAC over MP3, then the newest upload within
   the same format. **Upload dates and formats** groups the tracks by day and format
   on each disc, so two uploads of ten tracks are easier to identify.
   Nothing is preselected on opening. Tick tracks individually, or use
   **Select extra copies** to select each matching title after the first on its
   disc, regardless of format or date. It leaves differing titles unselected so you can compare and select those
   manually. The first matching copy stays unselected. Check the selection and change it if
   you prefer to keep another copy; listen and compare the displayed duration
   and file format where available. **Select all** selects the entire album,
   including tracks without duplicates. The bar shows the selected track count.
3. **Choose Review → and confirm the list.** Check the titles and count, then
   choose **Move N tracks to the trash**. Use **Cancel** while selecting or **Keep them**
   in the review to leave the tracks unchanged.

Tagcast first checks that the selected tracks are still active on their albums,
then moves them to **iBroadcast's trash** and reads the result back. Wait for the
checking to finish; **Change history** shows the result. These tracks leave the active
library in Tagcast and other iBroadcast apps. They are never permanently deleted
by Tagcast, and your local music files are unchanged. Restore them through
**iBroadcast's trash**; Tagcast cannot restore them. An album disappears from
Tagcast when it has no active tracks left.

The stricter title comparison ignores case, spacing and quotation marks. For
example, `Red Shoes (from the "Dumplin'" Original Motion Picture Soundtrack)` and
`Red Shoes (from the Dumplin' Original Motion Picture Soundtrack)` match at the
same track number on the same disc. Straight and curly apostrophes also match.
Version text such as `(Live)` or `(Radio Edit)` remains part of the comparison.
At a repeated track number, differing versions receive the **Duplicated** label
and require manual selection; they are not automatically selected as extra copies.
A repeated title at track 1 and track 17, or on separate discs, is not a duplicate. Missing track
numbers are not matched. Audio files and recording quality are not compared,
and the format preference does not prove recording quality or audio identity.
The suggestions compare only repeated positive positions on the same disc. Different
artists, durations differing by more than two seconds, unknown/incomparable formats,
missing dates and tied newest uploads can require manual comparison. Different
titles are explicitly flagged even when duration and artist agree. The suggestion
keeps unresolved preferred copies; it never chooses an arbitrary winner.
**Select extra copies** retains its separate, stricter title rule and keeps the first.

<details>
<summary><b>Step-by-step screenshots: remove duplicate tracks</b></summary>

**1. Open ⋯ → Move to trash… on the album.** Opening this menu does not select
tracks or send a change.

![More album actions menu with Move to trash](docs/screenshots/album-more.png)

**2. Compare repeated track positions.** The Faithless example shows Duplicated
badges even when title text or artist credits differ.

![Faithless tracks with Duplicated badges on repeated track numbers and different title or artist credits](docs/screenshots/duplicate-track-positions.png)

**3. Check uncertain copies manually.** Upload timestamps and file formats remain
visible. Different artist credits are marked **Compare manually**; the checked
rows below were chosen by the user, not by an automatic suggestion.

![Manual track selection with upload timestamps, FLAC formats and Compare manually notices for different artist credits](docs/screenshots/duplicate-tracks-manual.png)

**4. Choose Review → before confirming.** Review the exact tracks and count. Only
**Move N tracks to the trash** sends the change; **Keep them** closes the review.

The current upload-group suggestion and final track-review captures are still
pending in the [checklist](docs/screenshot-checklist.md). These earlier-interface
examples retain the same review steps:

- [Upload groups and suggested copies](docs/screenshots/duplicate-tracks-upload-suggestions.png)
- [Final selected-track review](docs/screenshots/duplicate-tracks-review.png)

</details>

### Overview and Change history

**Overview** shows library totals, collection size, playing time, formats, uploads per year and iBroadcast's existing play counts. **Metadata health** links to albums with missing metadata or artwork. Account and iBroadcast settings are shown here too; settings such as **Combine Multi-Disc Album Sets** are changed on the iBroadcast website.

**Change history** stores saves and their results in this browser. Export it as JSON with **Export changes**. **Clear change history** asks for confirmation and removes the local entries, including their artwork Undo information; it does not revert saved changes in iBroadcast. Clearing is available after ongoing saves and read-back checks finish. Change history belongs to this browser and local address, so another browser or port has its own history.

## Updating Tagcast

Tagcast checks GitHub for a newer **stable release** at startup, at most once a day. A notification links to the release page. Use **Settings → Tagcast updates** to check immediately or disable automatic checks. No account credentials or library data are sent to GitHub. Updates are downloaded and installed manually.

1. **Stop the old Tagcast first.** Close its desktop launcher, or stop its terminal server with Ctrl+C. Closing only the browser tab is not enough.
2. Download and extract the new package for your computer, then replace the old application/folder. Source users should update their checkout or use a freshly extracted source archive.
3. Start the new version. Your account settings, tokens and cache remain in `~/.tagcast/`, or your configured `TAGCAST_HOME`. Reload the browser page if it still shows the old interface.

If you start the new copy while the old server is still running, the launcher opens that existing server. The small version beside **Settings** at the bottom of the sidebar tells you which version you are using.

## Screenshots

Captured on 16 October 2026 from the local development build. The cassette logo,
compact sidebar, album breadcrumbs, tags and Sound controls reflect `main`; the
published 0.42.0 packages retain their earlier interface. All supplied originals
are indexed in the [capture checklist](docs/screenshot-checklist.md), which also
lists missing and partially covered views. The older sign-in illustration and
linked cleanup examples retain their earlier styling.

<details open>
<summary><b>Artists, albums and reviewed album selection</b></summary>

**Album artists:** searchable artist cards with the refreshed sidebar.

![Album artist grid with artist images and collection counts](docs/screenshots/album-artists.png)

**Albums:** search/filter/sort controls and compact Play / + actions on cards.

![Album collection with Al Green covers, filters and compact Play and queue buttons](docs/screenshots/albums.png)

**Select an artist's albums:** edit together or review complete albums for the trash.

![Two Aphex Twin albums selected with edit and reviewed trash actions](docs/screenshots/artist-albums-selected.png)

![Complete-album trash review for Syro, showing one album and twelve tracks before confirmation](docs/screenshots/albums-trash-review.png)

**Multi-disc albums:** tracks stay in disc sections with separate Edit disc actions.
This capture is scrolled to the boundary between discs.

![10cc multi-disc album track list with Disc 2 and Edit disc 2 visible](docs/screenshots/album-multi-disc.png)

</details>

<details>
<summary><b>Native tags and their reviews</b></summary>

**Tags:** browse your iBroadcast labels, separate from genres.

![Tags overview showing Emusic and Hoorspel with album and track counts](docs/screenshots/tags.png)

**Manage assignments:** keep existing values or choose explicit add/remove operations.

![Album tag manager showing assignment counts and Keep as is choices](docs/screenshots/tag-manager.png)

**Review:** inspect the label and track count before saving.

![Review of adding Hoorspel to twelve tracks, before confirmation](docs/screenshots/tag-review.png)

</details>

<details>
<summary><b>Metadata drafts, review and artwork</b></summary>

The editor combines album/track fields with source suggestions. Changes still need
an explicit before/after review.

![10cc metadata editor with album fields, genres and online source suggestions](docs/screenshots/editor.png)

![Metadata review showing genre changes across 53 tracks, before saving](docs/screenshots/metadata-review.png)

Artwork has its own comparison and save action.

![Violent Femmes artwork comparison with existing cover, selected replacement and online suggestions](docs/screenshots/artwork-compare.png)

[Earlier-interface credit cleanup preview](docs/screenshots/cleanup-artists-preview.png)
· [Earlier-interface genre cleanup progress](docs/screenshots/cleanup-genres-running.png).
Updated cleanup captures are still pending.

</details>

<details>
<summary><b>Playback, queue, fullscreen and Sound</b></summary>

The compact player and queue remain active while browsing other pages.

![Album page with Now playing and its track queue open](docs/screenshots/now-playing-queue.png)

**Fullscreen Now playing:** a large cover and controls using the same audio element.

![Fullscreen Now playing for Blister In The Sun by Violent Femmes](docs/screenshots/fullscreen.png)

**Sound:** player volume and mute stay separate from the chosen output. This example
shows Safari's native AirPlay picker; other browsers expose the outputs they support
or direct you to system sound settings.

![Sound dialog with volume and Mute, and Safari's native AirPlay output picker open](docs/screenshots/sound-output.png)

</details>

<details>
<summary><b>Genres, composers and decades</b></summary>

**Genres:** albums containing matching tracks, with random playback available.

![Alternative genre albums with random album playback and the compact player](docs/screenshots/genre-albums.png)

**Composers:** browse albums with tracks credited to Burt Bacharach.

![Burt Bacharach composer albums with sorting and random playback](docs/screenshots/composer-albums.png)

**Decades:** discover a sample and choose Surprise me again for another selection.

![1980s discovery page with its introduction, sampled albums and Surprise me again](docs/screenshots/decades.png)

</details>

<details>
<summary><b>Favourites and Recently played</b></summary>

**Favourites:** search native track favourites and play or queue them.

![Track favourites with artist and album details, hearts and playback controls](docs/screenshots/favourites.png)

**Recently played:** native listening history with search and playback controls.

![Recently played list with Yma Sumac tracks and a separate active compact player](docs/screenshots/recently-played.png)

</details>

<details>
<summary><b>Overview, History, Settings and contextual help</b></summary>

**Overview:** collection totals, metadata health and iBroadcast settings. The account
fields in this capture were redacted by the contributor.

![Library overview with collection totals, metadata health and redacted account values](docs/screenshots/overview.png)

**Change history:** confirmed saves and unconfirmed outcomes stay distinct.

![Change history showing saved artwork and unconfirmed metadata results](docs/screenshots/history.png)

**Settings:** the library banner, sidebar preferences, stream quality and optional
play reporting.

![Settings showing interface preferences, sidebar customization and playback options](docs/screenshots/settings.png)

**Help:** the ? tour explains the current context without triggering actions.

![Decades help tour highlighting the decade cards](docs/screenshots/help-tour.png)

</details>

<details>
<summary><b>Light appearance</b></summary>

The same album controls with light content surfaces and the independent sidebar.

![Odessa by Bee Gees in Light appearance, with album actions and the compact player](docs/screenshots/album-light.png)

</details>

## Online sources and keys

MusicBrainz (with Cover Art Archive), Deezer, Apple Music / iTunes (iTunes Search) and TheAudioDB work without a key. Apple covers appear directly among the cover suggestions. For the others, open **Settings** in the sidebar:

| Source | What it adds | Key |
|---|---|---|
| Discogs | Styles and genres, original year, covers, artist images | Personal token: Discogs → Settings → Developers |
| Last.fm | Listener tags as genres, covers | API key: [last.fm/api/account/create](https://www.last.fm/api/account/create) |
| fanart.tv | Artist images | Personal API key: [fanart.tv/get-an-api-key](https://fanart.tv/get-an-api-key/) |

Keys are stored in `~/.tagcast/config.json` (readable by you only), or supplied through `DISCOGS_TOKEN`, `LASTFM_API_KEY` and `FANART_API_KEY`. Saved keys stay server-side and are never returned to the page. The Last.fm key is for metadata lookups, not scrobbling.

By default, opening an album's **editor** looks it up in the available sources. Turn automatic lookup off in **Settings** if you prefer to press **Search** yourself. A lookup sends the artist and album name to each source. Requests are spaced per source and responses are cached for an hour.

Matching ignores case, accents, "The", and edition text such as "(2011 Remaster)" or "- Deluxe Edition"; each suggestion shows its title/artist match score. MusicBrainz and Discogs give the **first release** year. Deezer and Apple Music give the date of the edition they have, which may be a later remaster.

## Combine Multi-Disc Album Sets

**Keep this iBroadcast setting off.** Tagcast groups the discs itself while retaining the separate album records needed to save changes. You can change the setting on [media.ibroadcast.com](https://media.ibroadcast.com/), then reload your library in Tagcast.

- **Setting off:** discs with the same title, album artist, album year and set of upload dates, and different disc numbers appear as one album in Tagcast. One card represents the set, with a CD icon per disc; its album page lists all discs, and Play/Add to queue includes them all. Duplicate disc numbers remain separate, as do different titles such as `Album (CD1)` and `Album (CD2)`.
- **Editing a set:** title, album artist, year, genres or composers apply across its discs. The review lists changes per disc because iBroadcast receives separate writes. Change a disc number individually with **Edit disc 2**, for example. A shared cover is uploaded once and applied disc by disc, with a Change history entry and available artwork Undo per disc. Each disc waits for the previous read-back.
- **Setting on:** iBroadcast combines disc records in the library it sends and refuses album changes. Tagcast warns in the review, can still save supported track changes, and marks album changes **Not sent · setting**. Turn the setting off, reload, and use **Review the rest again** in the results or Change history.

The upload-date comparison uses active tracks and calendar dates, ignoring time of day. Unknown years or dates only group with the same unknown values. Different years or dates keep albums separate; these are clues, not release identifiers. This display grouping never splits tracks already inside an iBroadcast album into separate uploads or releases.

The library cache follows this setting, so changing it triggers a fresh download. **Overview uses iBroadcast's album totals**, counting separate discs when the setting is off; the sidebar and browsing cards count Tagcast's grouped albums. These totals can therefore differ.

## How saving stays safe

1. The server checks your library against iBroadcast and compares every **before** value. If something changed since you loaded it, the conflicting save is blocked and you are asked to reload. If iBroadcast reports no change, the in-memory copy is used; otherwise the library is downloaded first.
2. Artist names match existing artists by exact name first, then case-insensitively. A new name is flagged in the review and created only when you save.
3. Only changed, supported fields are sent. Saves are **not transactional**: if a request fails, later metadata requests stop, but earlier accepted changes may already have been applied.
4. A fresh library download verifies accepted writes. Change history distinguishes confirmed saves, sent but unconfirmed changes, failures, blocked changes and requests not sent. Read-back runs in the background, shown as **Checking…**.

Temporary network errors, HTTP 429 and 5xx responses are retried twice, after 2 and 6 seconds. Creating an artist is never automatically retried. Refusals are shown in the results and Change history and logged in the terminal and `~/.tagcast/tagcast.log`.

Artwork has its own comparison and explicit save. The current artwork is checked before uploading and applying the new image, then read back. Album covers apply to active tracks; Undo retains previous artwork IDs per track and restores the available previous images.

## Large libraries

Tagcast caches library metadata locally and sends compact album summaries to the browser. Track details load when you open an album; track search and favourites search run on the server. Browse indexes are built lazily, and group selections send album IDs so the browser can reuse the summaries.

Each library load checks iBroadcast's `lastmodified` value. If it matches, Tagcast uses memory or `~/.tagcast/library-cache.json.gz`; otherwise it downloads the library. The cache is tied to your account and the multi-disc setting, contains library metadata rather than account details, and is deleted on Disconnect.

As an example, a tested library of roughly **286,000 tracks** required a full download of about **92 MB**, taking **20–30 seconds**, while a cached restart took about **2 seconds**. The browser received about **5 MB** of summaries for 18,000 albums. These are example measurements, not guaranteed timings; network, computer and library size affect them. Read-back after a save needs a full download, and the server held roughly **750 MB** in memory for this library.

## API notes

Built on [ibroadcast-python](https://github.com/ctrueden/ibroadcast-python) for OAuth device-code and PKCE browser-redirect flows, token refresh and the request format. The requested scopes are `user.library:read`, `user.library:write` and `user.account:read`.

The [public API reference](https://help.ibroadcast.com/en/developer/api) documents library reads, ratings and native tags (`createtag`, `tagtracks`, `updatetag`, `deletetags`); `trash` is supported by ibroadcast-python. Metadata modes (`update_album`, `update_track`, `create_artist`) and artwork modes (`set_artwork`, `set_artist_artwork`, `get_artwork` and artwork upload) partly follow the official [web editor script](https://media.ibroadcast.com/js/iBroadcastLibraryEditor.js), inspected on 2026-10-04. Year and disc are sent as strings and track number as `track_no`, matching the web editor. These write modes are not all publicly documented; server refusals and partial results are reported explicitly.

During Tagcast's app review, iBroadcast Support confirmed that these metadata and
artwork operations are acceptable for third-party apps and that the existing
sidebar logo placement is sufficient. Play and skip reporting are recommended,
but optional; Tagcast's play reporting remains off by default.

Automated write tests use [the mock iBroadcast server](tests/mock_ibroadcast.py), which lets the save, read-back, trash, rating and artwork flows run without a real account. Passing mock tests does not establish compatibility with every live-service response. Audio streaming follows iBroadcast's web-player format, with the token kept in the local server.

## Development and tests

The application uses a Python server and plain JavaScript. Standalone packaging and release checks are described in [native builds](docs/native-builds.md).

`src/tagcast/static/dark.css` is generated from `src/tagcast/static/style.css` by `tools/build_dark_css.py`. After a style change, run the generator and its consistency check; do not edit the generated file by hand.

```bash
uv run --frozen pytest -q
uv run --frozen ruff check src tests tools
python3 tools/release_info.py
python3 tools/build_dark_css.py --check
for f in src/tagcast/static/*.js; do node --check "$f"; done
node --test tests/frontend.test.cjs
```

Without uv, Python tests can also run with `PYTHONPATH=src python3 -m unittest discover -s tests -v`. After changing styles, regenerate with `python3 tools/build_dark_css.py`.

To try the connected flow with separate test settings and no real account:

```bash
python3 tests/mock_ibroadcast.py 9555 &
TAGCAST_IBROADCAST_BASE=http://127.0.0.1:9555 TAGCAST_HOME=/tmp/tagcast-test \
  IBROADCAST_CLIENT_ID=test PYTHONPATH=src python3 -m tagcast.app
```

## Limits

Tagcast does not upload music, permanently delete tracks or edit local music files. It does not send Last.fm scrobbles. Queue synchronisation and native iBroadcast play reporting are optional and off by default. Playlist changes and metadata suggestions require your review; automatic updates only notify you and do not install software.

An artist name change assigns an existing artist or creates a new one; it does not rename the original artist in place. Metadata saves stay limited to one album or albums by one album artist. Artwork Undo needs a previous image; it does not undo metadata, ratings or trash moves.

## Media and press

The [media kit](media/README.md) contains the cassette logo, SVG and transparent PNG
exports, wordmarks for light/dark backgrounds, screenshots and the GitHub social
preview. [Download all media as a ZIP](https://github.com/cyberdeliaAI/tagcast/raw/refs/heads/main/media/tagcast-media-kit.zip).

## Development credits

Developed by Cyberdelia, with AI-assisted development using Claude (Anthropic) and ChatGPT / Codex (OpenAI).

## License

[MIT](LICENSE) for Tagcast code. The official Powered by iBroadcast logos belong to iBroadcast and are displayed unchanged under its [branding guidelines](https://help.ibroadcast.com/en/developer/branding). Tagcast is an independent project and not affiliated with iBroadcast.
