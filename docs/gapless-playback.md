# Gapless playback — 0.85.0

Available in Tagcast 0.85.0. Experimental and **off by default**.

## Enable for an album

Open **Settings → Playback**, choose **Original file (Premium)** under Streaming & listening history, and **Save changes**. Then enable **Gapless playback for albums in order**. This immediate browser/profile preference applies on the next track: start a fresh run with **Play album**.

Gapless prepares consecutive tracks in the same ordered album run. Shuffle album, Random Album, playlists and active queue sync use standard playback. The normal audio element, output selection, volume, playback speed and queue remain shared. The time bar and system media controls show the current track's position, rather than the cumulative album timeline.

The production desktop app retains its existing app identifier, Chromium profile, `~/.tagcast/` backend settings (or `TAGCAST_HOME`) and default port 8912. Saved preferences remain available after restart on the same profile/local address. Explicitly changing the port changes the browser origin, so browser-only preferences belong to that address. The old isolated listening app deliberately used different homes and a changing port; its reset issue is not the production default. No migration from that private profile is performed.

## Supported audio and safe fallback

Original FLAC is the primary validated path: mono/stereo, 16/24-bit, 8–192 kHz within the existing parser, preparation and buffer limits. Consecutive streams need compatible sample rate, channels, bit depth and decoder block sizes. A later file with a maximum FLAC block larger than the initial decoder configuration uses standard playback at that boundary. Some large or unusual files can exceed the preparation or coded-buffer budget.

Supported FLAC frames are repackaged into a continuous MediaSource buffer without crossfading, silence removal or changing their audio samples. Existing deterministic tests establish exact continuity for their measured inputs; they do **not** establish universal sample accuracy for every file, platform or physical output.

MP3 is separately experimental. It needs accepted encoder delay/padding metadata and uses the existing browser decode-to-24-bit-FLAC path. Real-stream decoded alignment has not been established across iBroadcast MP3 streams. Missing/unsupported metadata uses standard playback. This release adds no MP3 optimizations.

Unsupported files/transitions and preparation/decoder failures safely return to normal playback. The UI reports that fallback; the resulting boundary is not advertised as gapless. A slow network or unsupported output can still produce a pause. Intentional silence already present in a recording remains.

## Preparation and controls

The current file is prepared before playback, so starting can take longer than normal streaming. Longer tracks start while subsequent preparation continues; very short consecutive tracks can require one additional file before startup. A near-end seek can wait for preparation while current audio continues. Explicit Next/Previous and queue changes are supported but are not promised seamless transitions.

The existing bounded preparation, coded-buffer eviction and fallback timeouts remain in place. Sleep/wake and physical device changes depend on the operating system and need separate practical validation; a successful synthetic pre-output measurement does not prove those paths. AirPlay through System default remains a system output route, not a new native AirPlay integration.

Turning Gapless off retains normal playback. Normal queue synchronisation, play reporting, metadata review/save, artwork, lyrics, tags and library operations are available in the production app; the private listening build's write restrictions are removed. These actions still follow their existing permissions and review guards.

## Validation and platform scope

Deterministic synthetic FLAC tests measure sample continuity against independently encoded single-file references. Additional tests cover short tracks, seeking, Repeat, queue changes, decoder rejection and normal fallback. Real-world macOS listening also checks reliability; it does not prove sample accuracy for every album or physical output.

The release uses the existing cross-platform Python/frontend tests, native package checks and Linux Electron PCM measurements. Windows and Intel macOS package checks are not a substitute for listening on those devices. Sleep/wake and physical output changes still need device-specific practical testing. The earlier [candidate validation record](gapless-rc-validation.md) and [technical follow-up](gapless-improvements.md) document the measured scope and limitations.
