# Stabilization evidence — 1 November 2026

These are repository documentation artifacts, not application assets. The desktop
package recipe includes the shared backend/static assets and its explicit notices;
it does not ship this directory. No account credentials, real music, private
library exports or signing keys were used for these tests.

## Preserved compact records

| Archive | Contents | SHA-256 |
|---|---|---|
| [stabilization-2026-11-01.zip](stabilization-2026-11-01.zip) | 98 original-round records plus internal manifest: report, original 20-commit diff/list, focused/full test logs, measured JSON, real-page CSP/handover evidence and original package verification | `15d8d2d727a8f8c19f3450b9d884ad4309c9ce546e07607bea69df6c03a074a1` |
| [integration-validation-2026-11-01.zip](integration-validation-2026-11-01.zip) | 97 final records plus internal manifest: Python 3.11/3.13, frontend, Electron, release/package regressions including failing-before logs, media cases, fixture manifest, package restart/CA evidence, advisory results and unchanged-worktree snapshots | `46a926a62c5c5e07e17f078481a0d9453e3b1cdddcbccfa82bccf8aa96b02f10` |

[SHA256SUMS](SHA256SUMS) records the archive hashes. Each ZIP also contains
`EVIDENCE-MANIFEST.json` with every member's size and SHA-256. Large generated audio,
raw captures and disposable profiles are deliberately excluded from Git.

The original application/build result is bound to
`607205a4fa0a3ce786e50b23504a26772f23c287`; its report was the twentieth commit,
`63a484a`. The final integration tests are bound to
`9d4ce85bf6ae1ae717b5be61604d936248b8f40d`. The three intervening corrections
change CI, release/payload checks and tests, not application code, themes or
runtime dependencies. A later documentation-only evidence commit does not require
another playback run.

Do not interpret every log as a successful check. `*-before.txt` intentionally
records failing reproductions; the negative media cases require exit code 1.
The full npm audit also exits 1 for existing moderate build-tool advisories;
the production-only npm scan and Python runtime scan report none. Empty actionlint
stdout is accompanied by its version, command and successful exit in
`final-checks.json`. Shellcheck and pyflakes were not available for that check.
See the [integration report](../integration-validation-2026-11-01.md) for scope,
limitations, known findings and platform distinctions.

## Durable full local evidence

The full evidence is additionally preserved outside temporary worktrees and build
directories at:

`/Users/cyberdelia/Documents/Tagcast-validation/stabilization-2026-11-01/`

- `original-round/`: original compact evidence, unchanged.
- `integration/`: final logs/JSON and raw synthetic PCM captures.
- `fixtures/`: independently encoded deterministic FLAC inputs and their manifest.
- `packages/`: the actual checked ad-hoc macOS arm64 archive and checksum.
- `reports/`: both reports and this compact evidence directory.
- `MANIFEST.json`: relative paths, sizes and SHA-256 for the preserved local files.

This directory is approximately 0.5 GB, contains synthetic audio only and is not a
new installation or public release. The archive remains version 1.2.0 solely as a
local verification artifact; it must not replace the published signed 1.2.0 asset.

The media tooling and reproduction commands remain in
[`tools/gapless_lab/README.md`](../../../tools/gapless_lab/README.md). Re-running
requires the pinned Electron runtime, FFmpeg and a suitable sandboxed desktop/audio
environment. Pre-output PCM correctness is not a hardware, AirPlay or universal
cross-platform accuracy claim.
