# macOS Developer ID signing and notarization

This is a build procedure, not a claim about already-published downloads. The
existing 1.1.0 archives and checksums are unchanged. Windows signing through
SignPath is separate and still awaiting approval/integration.

## Credentials

Use GitHub Actions secrets, never repository files, workflow literals or logs:

| Secret | Value |
|---|---|
| `CSC_LINK` | Base64-encoded, password-protected Developer ID Application `.p12`, including its private key |
| `CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | The Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password created at account.apple.com, not the account password |
| `APPLE_TEAM_ID` | The ten-character team identifier associated with the certificate |

The signing certificate and its intermediate chain must be valid. App-specific
passwords require two-factor authentication. Notarization uses Apple's notary
service; no Mac App Store app listing or App Store submission is required.
Creating secrets alone does not change any existing app or release.

## Explicit test build

Run **Builds** manually on the reviewed signing branch (or main after merging),
enable **sign_macos**, and leave **tag empty**. The workflow creates CI artifacts
only, including Apple Silicon and Intel macOS ZIPs; it does not publish a release,
create a tag or overwrite existing release assets. Ordinary pushes and pull
requests keep their existing ad-hoc macOS checks without signing secrets.
Automatic release builds accept only a successful Tests run triggered by a push
in this same repository, with the existing explicit publication commit message;
successful fork/pull-request runs cannot select the credential-bearing path.

The equivalent command on macOS, with these five variables supplied securely, is:

```sh
uv run --frozen --python python --with-requirements requirements-build.txt python tools/build_electron.py --sign-macos
```

Missing credentials, a non-macOS host and inappropriate GitHub event types fail
before the helper starts build/install work. GitHub injects the credentials into
the selected build step. The Python helper removes them from its dependency-install,
Python-freezing and smoke-check child processes; it passes them only to the
pack/sign/notarize subprocess. The launched application and CLI also filter these
variables. electron-builder imports the `.p12` into
its temporary keychain and disposes of that keychain after the build.

## Verification and release use

The explicit signed configuration reuses the normal package, backend, CLI,
hardening hook and fuses. It requires a distribution Developer ID signature,
the hardened runtime and Electron's JIT entitlement. It does not disable library
validation, enable debugging, introduce an App Sandbox entitlement or change the
renderer sandbox. Electron's signer signs nested Mach-O code, including the
bundled Python runtime and executables, before sealing the outer app.

electron-builder submits the signed app to Apple and staples the accepted ticket.
After extracting the final ZIP, the build verifies the signature, its team,
hardened runtime, stapled ticket and Gatekeeper assessment. The existing isolated
app/server/CLI smoke check still runs. A failure stops the build; it never quietly
substitutes an unsigned archive. Checksums are written only after successful checks.
`build/reports/macos-signing.json` contains boolean verification results, no keys,
passwords or account email.

For future releases containing this recipe, the existing explicit release events
select signed macOS builds automatically. All four platform builds must pass
before download attachment. Historical tags continue to use their own build
recipe, and are not silently converted into signed releases. The workflow's
existing nonempty **tag** input is a publication action; do not fill it when
testing. Update release notes and installation wording only when describing
downloads actually built and verified with this route.

First notarizations or Apple service delays can take longer than an ordinary
build. The CI timeout is 60 minutes. A timeout is not approval: inspect the Apple
result before deciding whether another submission is appropriate. Windows/Linux
builds and playback tests do not establish macOS notarization, and successful
notarization does not replace runtime/device testing.

References: [Apple notarization authentication](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool),
[Apple app-specific passwords](https://support.apple.com/en-us/102654),
[electron-builder signing](https://www.electron.build/v26/docs/features/code-signing/).
