# Gapless playback — 0.81.0 candidate

Experimental and **off by default**. This is a locally prepared candidate; it is not included in the published 0.80.0 downloads yet.

## Enable for an album

Open **Settings → Playback**, choose **Original file (Premium)** under Streaming & listening history, and **Save changes**. Then enable **Gapless playback for albums in order**. This immediate browser/profile preference applies on the next track: start a fresh run with **Play album**.

Gapless prepares consecutive tracks in the same ordered album run. Shuffle album, Random Album, playlists and active queue sync use standard playback. The normal audio element, output selection, volume, playback speed and queue remain shared. The time bar and system media controls show the current track's position, rather than the cumulative album timeline.

The production desktop app retains its existing app identifier, Chromium profile, `~/.tagcast/` backend settings (or `TAGCAST_HOME`) and default port 8912. Saved preferences remain available after restart on the same profile/local address. Explicitly changing the port changes the browser origin, so browser-only preferences belong to that address. The old isolated listening app deliberately used different homes and a changing port; its reset issue is not the production default. No migration from that private profile is performed.

## Supported audio and safe fallback

Original FLAC is the primary validated path: mono/stereo, 16/24-bit, 8–192 kHz within the existing parser, preparation and buffer limits. Consecutive streams need compatible sample rate, channels, bit depth and decoder block sizes. A later file with a maximum FLAC block larger than the initial decoder configuration uses standard playback at that boundary. Some large or unusual files can exceed the preparation or coded-buffer budget.

Supported FLAC frames are repackaged into a continuous MediaSource buffer without crossfading, silence removal or changing their audio samples. Existing deterministic tests establish exact continuity for their measured inputs; they do **not** establish universal sample accuracy for every file, platform or physical output.

MP3 is separately experimental. It needs accepted encoder delay/padding metadata and uses the existing browser decode-to-24-bit-FLAC path. Real-stream decoded alignment has not been established across iBroadcast MP3 streams. Missing/unsupported metadata uses standard playback. This candidate adds no MP3 optimizations.

Unsupported files/transitions and preparation/decoder failures safely return to normal playback. The UI reports that fallback; the resulting boundary is not advertised as gapless. A slow network or unsupported output can still produce a pause. Intentional silence already present in a recording remains.

## Preparation and controls

The current file is prepared before playback, so starting can take longer than normal streaming. Longer tracks start while subsequent preparation continues; very short consecutive tracks can require one additional file before startup. A near-end seek can wait for preparation while current audio continues. Explicit Next/Previous and queue changes are supported but are not promised seamless transitions.

The existing bounded preparation, coded-buffer eviction and fallback timeouts remain in place. Sleep/wake and physical device changes depend on the operating system and need separate practical validation; a successful synthetic pre-output measurement does not prove those paths. AirPlay through System default remains a system output route, not a new native AirPlay integration.

Turning Gapless off retains normal playback. Normal queue synchronisation, play reporting, metadata review/save, artwork, lyrics, tags and library operations are available in the production candidate; the private listening build's write restrictions are removed. These actions still follow their existing permissions and review guards.

## Optional diagnostics

**Settings → Playback → Optional playback diagnostics** collects at most 2,000 recent anonymous technical events in memory. It starts off each app launch, makes no automatic upload or disk log, and records no track titles/IDs, account details, credentials, stream URLs, raw exception messages or audio. Enable it to reproduce a problem, then explicitly download the JSON before closing. Re-enabling starts a fresh log. It is a support tool, not proof of sample accuracy or a total-memory monitor.

## Validation and remaining release gates

See [candidate validation](gapless-rc-validation.md) for actual test results and platform scope. The user's successful real-world macOS listening is useful reported evidence; no exact duration, format coverage or physical-output accuracy is inferred from it. Windows/Linux candidate checks require an authorized branch push/PR; previous green builds of main are baseline evidence only.
