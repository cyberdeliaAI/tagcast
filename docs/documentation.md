# Documentation maintenance

The [GitHub Wiki](https://github.com/cyberdeliaAI/tagcast/wiki) is the full user guide.
The repository README stays a short introduction, installation entry point and
feature overview. Detailed source/build notes remain in `docs/` and link to the
relevant Wiki pages.

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

Document changes on `main` that are not yet released on the Wiki's **Upcoming
changes (unreleased)** page. Link to it from affected guide pages and the home/sidebar,
while keeping the released version's instructions usable. When releasing, move the
instructions into the relevant guide sections and update/remove the availability notes.

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
