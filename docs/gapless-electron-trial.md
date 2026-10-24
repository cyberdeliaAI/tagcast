# Local Electron gapless playback trial

This branch is an isolated experiment based on Tagcast 0.80.0, not a new release.
Do not publish it as an official build. The shared editor, server, native audio element,
security policy and reviewed metadata workflows remain in place.

## Trying the app

Open **Tagcast Gapless Test.app** in the dedicated test folder. It has a separate
application identifier and browser profile; it does not replace Tagcast.app.
The bundled backend starts on its own free localhost port. Existing server-side
Tagcast sign-in/settings remain available; browser-local display preferences and
history are separate. Avoid editing the same library concurrently in both apps.

1. In Settings, leave **Enable gapless playback in this test app** selected.
2. For a first comparison, choose **Original file (Premium)** streaming quality.
3. Play a continuous live/classical FLAC album in album order.
4. Listen across several natural transitions. Previous/Next deliberately start a new
   sequence; automatic transitions retain the same audio element and continuous source.
5. To compare ordinary playback, disable the experiment and start the album again.

No crossfade is used, and musical silence is never detected or removed. The first
track must be prepared completely, so startup may take longer than ordinary streaming.
The next track is prepared while the current one plays. Slow networks and incompatible
files can still cause an interruption; this prototype does not promise gapless output
for every iBroadcast file, streaming quality or audio device.

## Scope and limits

- Native FLAC is validated and repackaged into fragmented MP4 without transcoding
  its original audio frames. Mono/stereo, 16/24-bit, 8–192 kHz are accepted by the parser;
  real playback validation used 44.1 kHz stereo 16-bit source FLAC.
- MP3 requires Xing/Info frame counts and known LAME/Lavc/Lavf delay/padding metadata.
  Electron decodes it, the decoded sample count must match, and it is then framed as
  24-bit PCM/FLAC without a second lossy encode. Unknown padding uses ordinary playback.
- Adjacent sample rate, channel count and bit depth must match for a continuous sequence.
  A format change falls back to the ordinary player. Queue sync also uses that player.
- Current and next files only: 96 MiB encoded/file, 128 MiB decoded MP3 PCM/file,
  60-second preparation request timeout. Small media fragments bound the decoded
  playback buffer and old samples are evicted. Audio is not stored persistently.
- **The native time bar is cumulative for the prepared sequence.** It does not show
  the current track alone. Earlier buffered tracks are not a seekable track cache;
  use Previous/Next to revisit tracks. Labels, listening reports and system media
  position/seek commands use the current track. This is the principal UI limitation
  of the trial, and must be resolved before considering a production rollout.
- The gapless switch applies on the next track; restarting an album makes A/B testing clear.
- AirPlay, physical audio interfaces, sleep/wake, offline/network recovery and Windows/Linux
  audio backends have not been validated. Existing system output controls are retained.

## Validation on macOS Apple Silicon

- Full Python suite: 502 tests and 1,767 subtests passed.
- Frontend/media tests: 435 passed; Electron shell tests: 9 passed.
- Ruff, JavaScript syntax, version consistency and whitespace checks passed.
- Actual sandboxed Electron 44.9.0 player with synthetic account/audio: three consecutive
  2-second FLAC tracks and three MP3 tracks retained one source and the same audio element.
  An AudioWorklet captured all 264,600 expected samples per channel in each sequence;
  the longest internal zero run was one sample (the synthetic sine's natural zero crossing).
  This measures decoded audio internally, not physical speaker/AirPlay output.
- Pause, track-based seek, Previous/Next, Stop, play-next consumption, future removal,
  Repeat track/queue, cancellation during preparation and incompatible-rate fallback passed.
- A 12-second track produced one intercepted play report only after ten seconds of
  listening; prefetched tracks produced none. No actual account writes were made.
- A 20-track queue, accelerated for the retention check, discarded old decoded audio:
  at 30.07 seconds the buffered range started at 20.74 seconds. No console errors.
- Settings checked visually at 1280 and 420 px with fictional library data.

Reproduce the committed checks with `python -m pytest -q`,
`node --test tests/frontend.test.cjs tests/gapless-media.test.cjs`,
`node --test electron/tests/*.test.cjs` and `ruff check src tests tools`.
The captured signal/control reports and screenshots are local build artifacts.
Build/install integrity checks are recorded alongside the test app.
