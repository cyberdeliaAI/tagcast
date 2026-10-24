# Synthetic gapless audio fixtures

Generated locally with FFmpeg's `sine` source: 440 Hz, 44,100 Hz, two seconds,
stereo. No recording, music file or third-party artwork is included.

```
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=2 -ac 2 -c:a flac tone.flac
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=2 -ac 2 -c:a libmp3lame tone.mp3
```

Both contain 88,200 intended audio samples per channel. The MP3's Xing/Lavc
metadata specifies 576 samples of encoder delay and 1,080 samples of padding.
These fixtures are for the local experimental gapless branch only.
