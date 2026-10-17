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

Screenshots stay in `docs/screenshots/` in the main repository. Keep earlier-interface
examples labelled and preserve attribution for the bundled Wikipedia excerpts.

The guide was reorganised for 0.60.0. The complete pre-Wiki version remains in
the [0.60.0 README](https://github.com/cyberdeliaAI/tagcast/blob/v0.60.0/README.md).
