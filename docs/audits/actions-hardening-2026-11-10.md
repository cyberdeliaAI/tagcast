# Immutable workflow actions — 2026-11-10

Baseline: main `694e8dcd94cf5f74c01b46839374644ef1d914ac`.

S-02 is confirmed: three workflows contained 28 references to six third-party
actions through movable major-version tags. All 28 now use full commit IDs with
their release version in a comment. Local reusable workflow paths remain local.

## Provenance and scope

The pins are the exact commits resolved by the successful main Builds run
`42866827475`, checked against action downloads in jobs `130007411200` and
`130012584910`. The official repositories' major tags, patch tags, commit objects
and action.yml blob identities were independently checked through GitHub's API.
The dated [verification manifest](actions-pins-2026-11-10.json) records each result.
No action implementation is upgraded in this change.

- actions/checkout v4.4.0
- actions/setup-python v5.6.0
- astral-sh/setup-uv v6.8.0
- actions/setup-node v4.4.0
- actions/upload-artifact v4.6.2
- actions/download-artifact v4.3.0

After normalizing each uses value to its previous version tag, all existing
workflow documents must equal their baseline. This verifies that triggers,
permissions, expressions, shell commands, environments, signing conditions and
packaging inputs are unchanged. Workflow permissions remain read-only by default
with their existing explicitly scoped job exceptions.

Dependabot proposes weekly GitHub Actions updates, capped at five open PRs.
Proposals require review and normal protected checks; automatic merging is not
configured. A regression test rejects mutable remote action/workflow references
without tying future updates to this historical manifest.

## Validation and limitations

Actionlint 1.7.12 passes before and after pinning; its downloaded binary archive
was checked against the official release checksum. Targeted scope, release,
packaging and signing-environment tests verify existing gates with synthetic
credentials. The full required PR Tests and Builds workflows must pass, including
all four native archives, extracted CLI/application smoke checks, PCM verification
and Linux distribution checks.

PR packages use the existing ad-hoc macOS signing path. Developer ID signing and
Apple notarization are deliberately not invoked: those require the existing
explicit release/manual workflow gates. Credentials and signing configuration
are unchanged and no credential values were inspected. Successful ad-hoc CI does
not establish a new notarized release validation.

Pins constrain reviewed action source code, not every network dependency an
action or package installer can fetch. Dependabot proposals still need provenance
review and packaging tests. No version, tag or release is created by this change.
