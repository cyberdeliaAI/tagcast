# Unpublished 1.0 documentation preparation

No Wiki page, website or public download has been changed by this preparation.
The application candidate is **1.0.0b1 / 1.0.0-beta.1**, with public downloads
remaining at 0.85.1. Stable 1.0.0 is a proposal, not an available release.

## Wiki candidate patch

`wiki-candidate.patch` targets Wiki snapshot
`f9349e32aff46758401fb75ebda4baf231a3993e` from 27 October 2026. It updates seven
existing pages without changing their names or existing section addresses:
Home, Upcoming changes, Browsing and discovery, Saving and history, Playback and
queue, Settings and help, and What is saved where. Candidate availability is explicit;
the illustrated merge/Various Artists/import guides and screenshot archive stay intact.
It reuses the existing Mini Player screenshot rather than duplicating the image.

Apply only in a clean Wiki checkout after checking the remote revision:

```sh
git apply --check /path/to/wiki-candidate.patch
git apply /path/to/wiki-candidate.patch
```

Publishing the Wiki still requires approval. Once stable 1.0 is actually available,
update candidate availability sentences and the Home download link in that same
publication; do not change their section addresses or historical release notes.

## Website stable patch

`website-stable.patch` targets `tagcast-website/site/index.html` as checked on
27 October 2026. It prepares the stable version, all four fallback download URLs,
Mini Player/merge/upload/reliability highlights and the iBroadcast limits link.
It deliberately leaves the site's latest-stable fetch/cache and deployment code alone.
**Do not deploy it for this beta or before all four stable 1.0.0 assets exist.**
Check/apply in that repository, run its existing checks, preview, then obtain the
separate deployment approval. If remote contents changed, reconcile the patch;
never force it over newer work.

## Release communication

The beta notes are `.github/release-notes/1.0.0-beta.1.md`. The professional stable
announcement is prepared separately as `1.0.0-announcement-draft.md`; it is not the
stable publishing tool's version-matched notes file. Final version/stable notes,
CI, platform archives and checksums require a separate approved publication step.
See `docs/tagcast-v1-candidate-validation.md` for actual evidence and open gates.
