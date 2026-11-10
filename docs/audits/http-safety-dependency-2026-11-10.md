# Direct HTTP dependency and request safety — 2026-11-10

Baseline: `694e8dcd94cf5f74c01b46839374644ef1d914ac` (main after PR #50).

## Confirmed defects

- B-07: source imports `requests` directly, but installation relied on the
  transitive dependency from `ibroadcast`. Declare `requests>=2.34.2,<3`, using
  the existing tested lockfile version as the minimum. The lockfile changes only
  the root dependency metadata; no resolved package version changes.
- S-03: inherited `HEAD` bypassed Tagcast's Host validation; inherited static
  directory listings exposed file names. Negative `Content-Length` reached
  `read(-1)`, potentially waiting for EOF. Nondecimal lengths escaped the intended
  API error handling, and conflicting lengths were not rejected explicitly.

## Correction

HEAD applies the existing Host and API Fetch Metadata guards, then serves only
static metadata under normal read admission. It never executes API or OAuth GET
actions. The existing CSP script hashes, no-store headers and reference caching
remain shared with GET. Draining rejects HEAD through the existing lifecycle gate.
Directories without an index return 403; explicit public files remain readable.

Request bodies accept only one bounded ASCII decimal Content-Length, with HTTP
optional whitespace and leading zeroes permitted. Missing length and zero retain
the existing empty-object behavior. Negative, signed, nondecimal, repeated,
comma-combined and oversized lengths, and unsupported Transfer-Encoding, fail
before reading or admitting a mutation. Invalid framing closes the connection.
Truncated bodies cannot become an accepted empty action. No upstream write,
read-back, retry, account/session or accepted-write shutdown policy changes.

## Validation

- Reproduced the original Host, directory and framing failures against the
  baseline. Retained the failing and passing logs in the local evidence directory.
- Ten focused regression tests cover framing without body reads, early HTTP
  rejection without mutation, HEAD guards/CSP/cache parity, disabled listings and
  shutdown admission. The targeted HTTP, application, CSP and lifecycle selection
  passes: 39 tests and 65 subtests.
- Independent clean `uv sync --frozen` installations and the complete Python
  suites pass on Python 3.11.17 and 3.13.16: each 979 tests and 2,605 subtests.
  Both installed CLI entry points report the unchanged version 1.6.5.
- Complete JavaScript frontend/media and Electron unit suites, Ruff, version
  consistency, frozen lock validation and diff whitespace checks pass.

PR CI additionally exercises all supported test platforms, packaged applications,
measured gapless PCM and distribution verification. PR builds remain ad-hoc;
this work does not request signing, publishing or a release.
