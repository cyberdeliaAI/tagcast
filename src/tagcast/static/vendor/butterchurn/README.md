# Butterchurn 2.6.7

MIT license; copyright Jordan Berg. https://github.com/jberg/butterchurn

Source: npm butterchurn@2.6.7, lib/butterchurn.js (readable UMD build).
Upstream file SHA-256: 76813ba2b6486baac7c0e80c192c08ad060086e66f88a1043c06eab6a5d4bb65

Local changes: replace the string-equation compilation branch in loadPreset with
an explicit rejection; omit the unavailable source-map directive. Only Tagcast's
bundled function presets are used. No preset imports, extra images, remote assets,
CDNs, unsafe-eval or changes to Electron security are needed.

Tagcast supplies samples from its existing captureStream analyser. Butterchurn
receives a null AudioContext and creates no audio nodes or output connections.
