# Documentation maintenance

The [GitHub Wiki](https://github.com/cyberdeliaAI/tagcast/wiki) is the full user guide.
The repository README stays a short introduction, installation entry point and
feature overview. Detailed source/build notes remain in `docs/` and link to the
relevant Wiki pages.

## Structure

The README has six parts: what Tagcast is, download and install, what you can do,
a screenshot and the walkthrough, documentation and support, and privacy, security
and development. Keep release-specific descriptions out of it: they belong in
`.github/release-notes/` and the Wiki's *Release history*. Keep the *Code signing
policy* heading, because `PRIVACY.md` and the Wiki link to `#code-signing-policy`.

The Wiki's `Home.md` is the navigation hub, with six pathways: Getting started,
Listening to music, Managing your collection, Cleaning and organising, Advanced
features, and Help and reference. Each guide opens with a breadcrumb to its
pathway, and `_Sidebar.md` repeats the pathways in short form. Canonical pages own
shared explanations, so other guides link to them instead of repeating them:
*Saving, history and recovery*, *Multi-disc albums*, *What is saved where* and
*Privacy and security*. Pages kept only for older links (*Editing metadata and
artwork*, *Ratings, favourites and playlists*, *Cleanup and duplicates* and
*Upcoming changes*) stay in place, because the website, release notes and shared
links use them.

The Wiki has its own Git history and sidebar:

```sh
git clone https://github.com/cyberdeliaAI/tagcast.wiki.git
cd tagcast.wiki
```

Edit the relevant Markdown page, check its links and images, then commit and push.
Use relative links for other Wiki pages and complete repository/raw URLs for code,
reference documents and screenshots. `_Sidebar.md` owns the topic navigation;
`_Footer.md` contains source, release and issue links. Keep its links aligned with
`Home.md` when adding or renaming a page. Wiki edits do not publish an app release.

## Checks for documentation changes

Choose validation by the complete change, rather than waiting for a release:

| Change | Validation |
|---|---|
| Wiki only | Check content, links, images and GitHub rendering; no application CI. |
| Allowlisted documentation only in the main repository | Lightweight documentation checks; no application tests, measured Gapless suite or native builds. |
| Application code, tests, dependencies, configuration or workflows | Full Tests and Builds before merging, including measured Gapless PCM and macOS/Windows/Linux packages; verify the post-merge runs too. |
| Official release | Full regression and final distribution checks, including macOS signing/notarization, extracted-package smoke tests, Debian installation and checksums. |
| Manually dispatched Builds | Full native build/package checks even for documentation; macOS test signing is optional with an empty tag. |

The lightweight route applies only when the **entire** pull request or push
contains allowlisted documentation: `README.md`, `PRIVACY.md`, `LICENSE`,
Markdown and images under `docs/`, theme examples under `docs/themes/`, and Markdown
release notes under `.github/release-notes/`. This check validates local image
references, nonempty regular files and theme JSON without contacting providers.
It does not build the application or run the measured Gapless audio suite.

Code, test, dependency, configuration and workflow changes, unknown paths or an
unreadable comparison always require the complete test/build matrix. Renames
include both old and new paths. Explicit builds and releases always run the full
checks, including a `Publish Tagcast VERSION` commit that changes only release notes.

The existing fourteen required check names and branch-protection settings stay in
place. For documentation, each check only confirms that the lightweight validation
passed, on an Ubuntu runner; its application/build steps are skipped. The job log
explicitly states that no application tests or builds were needed. A missing or
invalid scope fails the check instead of silently passing. Do not skip the entire
workflow with path filters or commit-message instructions: that can leave required
checks pending indefinitely.

For documentation-only work, do not dispatch Builds or repeat manual listening and
platform checks just because their required job names remain visible. Inspect
**Check changed files** and the job summary to see which route actually ran.
For application work, choose additional hands-on browser, audio and device checks
for the affected behavior; a passing automated suite does not establish support
for every physical output or desktop environment. A manual Builds run does not
replace the separate Tests workflow.

## Publishing and screenshots

Document changes on `main` that are not yet released on the Wiki's **Upcoming
changes (unreleased)** page, which is an archive while nothing is pending. Link to it
from affected guide pages and the home/sidebar while a change is pending, and keep the
released version's instructions usable. When releasing, move the instructions into the
relevant guide sections, add a summary to *Release history* and update or remove the
availability notes.

At release time, update the version-pinned links: the README download table and
release link, the Wiki's `Home.md` and `_Footer.md`, and the Homebrew tap. The Wiki's
*Getting started* download table links to the latest release and needs no version change.

Keep the README's **Code signing policy** and `PRIVACY.md` linked beside desktop
downloads and from release notes. State the signing status of the actual published
artifacts; an application for signing support or a locally installed certificate
does not make existing downloads signed. Keep privacy descriptions aligned with
automatic checks, source defaults and available opt-outs. Updating these documents
does not change application preferences, account MFA or the release pipeline.

Screenshots stay in `docs/screenshots/` in the main repository. Keep earlier-interface
examples labelled and preserve attribution for the bundled Wikipedia excerpts.

The guide was reorganised for 0.60.0. The complete pre-Wiki version remains in
the [0.60.0 README](https://github.com/cyberdeliaAI/tagcast/blob/v0.60.0/README.md).

Keep the category pages as short navigation guides. Put task-specific instructions,
such as the [Various Artists walkthrough](https://github.com/cyberdeliaAI/tagcast/wiki/Various-Artists),
on their own pages. Retain the old page addresses and section headings as links to
the detailed guides when splitting a page, so existing README, Help and shared
fragment links remain useful. Keep released behavior separate from local test builds.

Before publishing a documentation change:

- Check current instructions against the released source, including visible button
  labels, accessible names for icon buttons and complete Settings category paths.
  Keep older screenshot labels and historical release descriptions unchanged.
- Link save and recovery guidance to the canonical guide. Lyrics and ordinary
  metadata mutations both follow the send-once rules; ratings and track hearts
  save directly rather than opening the metadata review. Describe actual defaults
  and available opt-outs: the public Overview status feed has no Settings switch.
- Keep upgrade advice pointed at the latest stable release. Put an earlier fix's
  version-specific explanation in Release history instead of recommending an old
  download from a current task guide.
- Check where old fragment links land, not just whether the IDs exist. Put an
  alias beside the relevant instructions or a specific link to their new section;
  release bookmarks should lead to the corresponding version. Check Home, the
  Sidebar, breadcrumbs and affected website links for consistency and duplication.
- Inspect GitHub's rendered pages as well as local Markdown, including old
  fragments, tables, images and collapsed details. Report an external service's
  access refusal separately from a missing link; HTTP success alone does not prove
  that a fragment reaches the intended explanation.

## Offline PDF editions

The Wiki's [PDF manual](https://github.com/cyberdeliaAI/tagcast/wiki/PDF-manual)
page links to the illustrated English 1.9.0 guide (56 pages, 13 November 2026). Versioned PDFs live once in the
Wiki repository under `manuals/`; the application README and product website link
to the same file. They are documentation downloads, not application resources or
release-gate inputs. Keep older screenshots labelled and retain the version/date
and SHA-256 on the Wiki page when publishing another edition.

The 1.9.0 edition adds selected [13 November captures](screenshots/2026-11-13-1.9.0/README.md) to earlier illustrated workflows. Its source manifest, checksum and validation reports are published beside the PDF. The 1.7.0 edition uses the final eight [manual captures](screenshots/2026-11-11-manual/README.md) and earlier archived sets. Keep useful older examples labelled rather than requiring a new screenshot for every step. The historical 1.4.0 and 1.7.0 PDFs remain unchanged in the Wiki. The current PDF's Wiki page records its checksum, source revisions and validation manifest.
