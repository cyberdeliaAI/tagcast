# Audio downloads

Available in **Tagcast 1.1.0** and from source. Tagcast 1.0.0 does not include
audio downloads.

## Download albums

1. Connect and load your library using the normal Tagcast sign-in.
2. Open an album's **⋯ → Download album…**, or select album cards and choose
   **Download…**. A displayed multi-disc album contributes every disc.
3. On **Downloads**, check the selection and choose a destination on the computer
   running Tagcast. A mounted drive is also supported. In browser mode this is the
   server computer, which may be different from the browser computer.
4. Choose **Review download**. This prepares filenames from the already-loaded
   library and shows counts and example paths; no audio is fetched yet.
5. Choose **Start downloads** to create local copies. Stop preserves completed
   files and matching streaming partials. Starting again requires another review.

The playing queue and metadata drafts are independent. Downloading does not edit
or delete anything in iBroadcast, change ratings/tags, or report a play.
Downloads share Tagcast's account connection and token-refresh gate.

## Quality and embedded metadata

Premium accounts can choose Original or MP3 at 96, 128, 192, 256 or 320 kbps.
Free accounts use 128 kbps MP3, matching iBroadcast's access restrictions.

**Original → iBroadcast download service** is the default for Premium. It reads
one streamed ZIP per track from the official download service. To include current
embedded tags, enable **Download Updated Metadata** in iBroadcast. Tagcast does
not change that account setting or rewrite tags locally. The service, not Tagcast,
decides which metadata fields it embeds. Rebuilt files are not necessarily
byte-identical to the upload, including when FLAC audio is lossless.

After bounded download-service failures, the engine can use the original upload
from the streaming server. A visible, persisted **Fallback** note makes clear
that iBroadcast's subsequent tag edits were not embedded in that file. Choose
**Original upload · streaming server** directly for the uploaded bytes/tags.
Converted MP3 always uses the streaming route.

Existing completed files are kept independently of which source created them.
Changing the source does not retag or replace those files. Use a different
output folder if you deliberately need another copy with different metadata.

## Files, folders and interruption handling

- Default naming: `{albumartist}/{album} ({year})/{disctrack} {title}`.
  Filenames are sanitized, disc prefixes retained and collisions disambiguated
  using track identity. Other supported fields appear under advanced options.
- Existing unverified or locally modified files are preserved with an explanation.
  There is no automatic adoption, overwrite or deletion of existing music.
- SHA-256 baselines are generated while downloading. Completed files normally
  reuse their saved size/mtime baseline. **Recheck checksums** explicitly reads
  previously completed files for full checksum verification.
- A hidden `.ibfetch.json` manifest lives beside the downloaded music. Matching
  `.part` files can resume over validated HTTP byte ranges on the streaming route.
  The original total size and any strong ETag (otherwise Last-Modified) are saved
  before receiving bytes. A changed total or missing/changed saved validator blocks
  resumption and preserves the partial file. Older partials without an original
  size also remain untouched; choose a different folder to start a fresh copy.
  Size checks alone cannot detect same-size changes when the server supplies no
  validator; local SHA-256 baselines do not prove remote content identity.
  ZIP downloads restart their own incomplete attempt and validate the archive's
  end marker, directory, CRC and size before completion.
- Local OS locks serialize matching targets inside the same Tagcast settings
  profile. They are deliberately not stored on the destination NAS. Use separate
  destinations when running ibfetch or another Tagcast profile simultaneously;
  independent applications do not share these local locks.
- An optional work folder completes files locally before moving them to the
  destination, retaining recovery receipts. It must be outside the destination.
- The default is **one file at a time**, with up to four available. Downloads
  still share network/disk capacity with playback; increase concurrency carefully.
- Options persist when a download is started. Selection, reviews and progress
  remain session-local. After restarting, reselect albums and review again; the
  integrity manifests recognize completed files and resumable partials.
- Closing Tagcast or changing the account stops the task. Cancellation can wait
  for an in-flight request/read to unwind; network operations have connect/read
  timeouts. There is no automatic restart after reopening or reconnecting.

## Scope and implementation

Tagcast covers albums and multi-album selections (at most 200 native discs /
10,000 tracks per task). Individual-track and playlist download actions are
deliberately left to [ibfetch](https://github.com/cyberdeliaAI/ibfetch), linked
directly from the Downloads page. Use it for track/playlist selections, advanced
filters and command-line downloads. Persistent queue history and adoption of
existing files are also outside this integration. The existing metadata export
remains a separate feature.

`downloads.py` manages selection, single-use reviews, options, account/session
ownership and a small result/status API. Reviews also bind the library snapshot
and expire after 15 minutes. Planning runs outside the Studio lock; transfers
release the captured library and path indexes after finishing. Status polling is
page-local, with one timer while preparation or downloading is active. Tokens,
provider URLs and complete library track lists never enter these responses.

`download_engine.py` is a focused adaptation of ibfetch **1.3.1**, commit
`3691d75`. It does not import ibfetch's server, UI, login or settings. Its MIT
[license](../src/tagcast/static/licenses/ibfetch.txt) is bundled with the shared
static assets in source and standalone distributions. Tagcast adds the existing
connection transport and supports the service's explicit JSON authentication
rejection through its shared, generation-aware refresh gate.

There is no new runtime dependency, frontend framework, IPC bridge or audio
engine. Normal playback, Gapless, native controls and the existing metadata
save/review paths are preserved.

## Validation and remaining checks

Automated tests use synthetic byte streams and ZIPs only. They cover filesystem
integrity, crash/interruption recovery, resumed ranges, ZIP failures/fallbacks,
collisions, work-folder moves, sessions, single-use reviews, HTTP origin guards,
quality restrictions, UI navigation/focus and preservation of playback state.

The real browser walkthrough confirms album selection → Downloads → review →
completed local files with synthetic music. Four palettes in Light/Dark and
420/760/761/768/1024/1280px layouts were checked without horizontal overflow.

The macOS 1.1.0 packaged server was also checked against a local synthetic service:
two files downloaded with verified bytes, a second run kept both completed files,
and no metadata writes or play reports were made. Download assets and the ibfetch
license were present in the bundle.

The user has also successfully tested album downloads with their own account.
That observation does not verify every embedded tag or output format. Native
folder-chooser interaction and real-account transfers on each operating system
remain manual checks. Platform builds and extracted-app smoke checks do not
certify every filesystem, account or embedded metadata field.
No claims are made that every iBroadcast tag field or source format is rewritten
correctly by the download service. No real-account music has been downloaded
for this integration's automated or visual checks.

An explicitly rejected session or TLS validation failure stops the download task
without streaming fallback. Temporary network errors retain the bounded read
retries. Local disk/access failures stop the task so they cannot trigger repeated
requests or a different download source. Cancellation is reported as stopped,
not as a failed file. Fix the cause before explicitly starting a new task.
