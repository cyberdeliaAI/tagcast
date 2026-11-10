# Browser Content Security Policy — S-01

Baseline: `d497741068b3a7086500127c0c202867649552f7`, after PR #48.
PR #48 is merged; its main Tests run `42827346221` and Builds run `42827346715`
both succeeded before this work began. Release `v1.6.5` remains unchanged.
This investigation addresses only S-01 from the independent audits of `76dc49f`.

## Confirmed weakness and resource inventory

An isolated baseline Python host returned HTTP 200 for both GET `/` and HEAD `/`
without a Content-Security-Policy header. Electron already installed a strict
response policy in `electron/security.cjs`; normal browser requests bypassed it.
Existing Host, Fetch Metadata, POST-header, nosniff, framing and referrer guards
were present and remain intact. CSP adds defence in depth, not a replacement for
escaping, account ownership or write review.

The current application has one nonempty inline script in `index.html`: early
restoration of the dismissed library notice. Its whitespace matters to the hash.
Theme restoration runs in synchronous, same-origin `themes.js`, before styles and
deferred application scripts. The Mini Player HTML has only external scripts.
There are no inline event-handler attributes in the shipped HTML. Runtime image
error handling uses existing delegated listeners.

| Resource / operation | Required permission |
| --- | --- |
| Main scripts, translations, API fetches | Same origin only |
| One trusted inline restoration block | Exact SHA-256 hash |
| Theme variables, previews, layout styles | Same-origin CSS and inline **styles** |
| Native, provider and explicitly chosen HTTPS artwork | `img-src https:` |
| Artwork previews and locally created images | `img-src data: blob:` |
| Audio proxy / seeking | `media-src 'self'` |
| Gapless MediaSource object URLs | `media-src blob:`; same-origin fetch |
| Eight visualizations | Canvas/WebGL and the existing captureStream graph |
| Butterchurn dynamic script | Same-origin `vendor/butterchurn/butterchurn.js` |
| OAuth | Existing device screen; browser navigation or HTTP callback redirect |
| External providers / queue WebSocket | Server-side; no browser origin exception |

The vendored Butterchurn compiler was already removed. It uses bounded function
presets and GLSL shaders, without JavaScript eval. Static code inspection found no
`eval`, `new Function`, WebAssembly, workers, AudioWorklet modules or remote font
loaders requiring a policy exception. Ordinary external links/OAuth navigation
are not script, form, frame or fetch permissions.

## Implementation

`static/content-security-policy.json` supplies one ordered set of browser/main
Electron rules. Python reads this package resource; Electron reads the same source
file during development and its explicit `extraResources` copy after packaging.
No generated policy, frontend build step, dependency or release-version change.

```text
default-src 'self'; script-src 'self' <exact inline hashes>;
style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:;
media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`unsafe-inline` applies only to styles, as in the existing Electron policy.
JavaScript has neither `unsafe-inline` nor `unsafe-eval`, wildcard origins, data
scripts or blob scripts. HTTPS image origins remain broad because user-chosen and
native/provider artwork is not confined to one host; scripts/connections do not
inherit that exception. `frame-ancestors 'none'` agrees with the existing DENY
framing header. CSP2-compatible directives and SHA-256 hashes are used; no Trusted
Types, strict-dynamic, WebAssembly exceptions or browser-specific syntax.

`content_security.py` hashes exact trusted UTF-8 script bodies after CRLF/CR → LF
normalisation, as required by [HTML/CSP processing](https://www.w3.org/TR/CSP3/#match-element-to-source-list).
It preserves remaining whitespace, ignores empty blocks and deduplicates hashes.
The HTTP handler reads, hashes and serves **one byte snapshot** of the main HTML
for GET and HEAD. It does not cache hashes by version/mtime/size, reread a different
body after hashing, or hash query parameters, API output or error text. Existing
no-store behaviour and validator removal remain. Other responses receive the base
policy without authorising inline input; reference-data conditional GET still works.
Browsing/API responses do not read the whole HTML to calculate their headers.

Electron retains all previous restrictions, with matching newline normalisation
and explicit framing denial. Its Mini Player and data-URL shutdown window retain
their independent, stricter policies. The native smoke check now rejects a missing
or divergent HTTP policy before checking the renderer.

## Browser validation

The optional `tools/check_browser_csp.cjs` starts the **real Python HTTP/API host**
through `tools/browser_csp_fixture.py`, using disposable settings and the existing
loopback iBroadcast mock. It neither injects a CSP header nor replaces application
API responses. Audio is the bundled synthetic sine fixture; HTTPS test artwork is
intercepted locally. All other external browser requests are blocked. No real
iBroadcast credentials, music or remote mutations were used.

| Browser on macOS ARM64 | Results |
| --- | --- |
| Chromium 158.0.8127.18 | Startup, restoration, sign-in dialog, browsing, favourites/tags, editor, NL/EN, theme pointer input at 420/760/1280px, HTTPS artwork, streamed MP3/seek, FLAC MSE/blob boundary and all eight visualizations passed |
| Firefox 159.0 (Playwright) | Same checks passed, including all eight visualizations and FLAC boundary |
| WebKit 27.2 (Playwright) | Common checks passed; FLAC MSE/captureStream unavailable, ordinary audio and artwork fallback passed; dynamic local Butterchurn still loaded |
| Safari 27.2 (22625.2.8.11.9), actual app | Manual startup, dark/Ocean selection and restoration after reload, artist/album navigation, metadata dialog, MP3 playback, stop and Dutch catalogue loading passed |

Chromium, Firefox and WebKit reported **zero unexpected CSP violations and zero
page errors** during the application checks. Separate negative probes executed as
an ordinary allowed same-origin script, not a privileged DevTools evaluation,
proved that eval, unknown inline code, inline handlers, remote scripts and remote
fetches are blocked. Expected negative-probe console messages are recorded apart
from the application results.

Safari WebDriver cannot start because Allow Remote Automation is disabled. No
system security setting was changed. Its manual results are narrower than the
automated WebKit matrix: no claim of full Safari console/negative-probe coverage,
gapless support or visualization support. Playwright WebKit is not Safari.
Firefox initially hit the macOS protected default app-data startup error; a fresh
`CFFIXED_USER_HOME` for that test process resolved it without touching the personal
profile ([upstream issue](https://github.com/microsoft/playwright/issues/42768)).
Cleanup removes macOS deny-delete ACLs only inside its own new temporary folder.

Reproduce after installing Playwright and its Chromium/Firefox/WebKit browsers in
an external tools environment (not a new application dependency):

```sh
TAGCAST_PYTHON=/path/to/venv/bin/python NODE_PATH=/path/to/tools/node_modules \
  node tools/check_browser_csp.cjs build/browser-csp
```

JSON evidence and screenshots are written per engine. `TAGCAST_CSP_ENGINES` can
select a comma-separated subset. Local evidence for this investigation is under
`build/audit-browser-csp-2026-11-10/` in the main checkout, outside tracked source.

## Regression and native validation

- Python 3.13 and 3.11: **962 tests, 2,568 subtests passed** in each full suite.
- Frontend/media/translations: **775 tests passed** (`tests/*.test.cjs`).
- Electron: **60 tests passed**, including cross-language policy/hash parity and
  native-smoke rejection of missing/divergent headers.
- New HTTP tests exercise GET/HEAD, unchanged mtime/size with changed script text,
  UTF-8/CRLF/CR hash input, unchanged existing security headers, API/error policies,
  Host/Fetch Metadata rejection and preserved reference-data 304 responses.
- Ruff, script syntax, version agreement, generated translations and dark CSS checks.
- Locally built ad-hoc signed macOS ARM64 Electron 44.9.3 package: bundled CLI,
  shared CSP resource/header parity, renderer security, themes, initial launch and
  same-origin restart passed; all 15 native shutdown scenarios passed.

The first native smoke attempt failed on the existing `Visible keyboard focus`
assertion. The unchanged check passed on a repeat without simultaneous manual UI
activity, including restart and the shutdown matrix. No timeout/assertion was
weakened and no focus/product change was made. This single intermittent result is
retained in `native.log`; successful evidence is in `native-recheck.log`.

Remaining limits: synthetic fixtures cannot prove every user artwork host, OAuth
provider flow, device or audio format. Browser behaviour depends on supported
media APIs; the existing fallbacks remain. Future inline blocks/resources must be
reviewed with both policy tests and real browser probes. Windows/Linux native
packaging and complete remote CI are verified by the PR checks; no release or tag
operation is part of this work.
