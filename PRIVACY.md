# Tagcast privacy policy

Last updated: 30 October 2026.

This policy describes the Tagcast application distributed from
[cyberdeliaAI/tagcast](https://github.com/cyberdeliaAI/tagcast), including its
Electron desktop and Python/browser versions. It describes current behaviour;
it does not announce new settings or a signed release. Tagcast is an independent
project maintained by Cyberdelia, not made or endorsed by iBroadcast.

## Local application and stored data

Tagcast runs on your computer. Its server listens on `127.0.0.1`, not on a public
network interface. The application does not send analytics or automatic crash
reports to the project maintainer.

Settings, OAuth tokens, source API keys, library caches, native lyrics caches,
account-scoped favourites, paused imports and operation reports are stored on
your computer, normally in `~/.tagcast/` or the folder selected by `TAGCAST_HOME`.
Browser/Electron profile storage holds interface preferences, local playback
state and Change history. Some caches have expiry or size limits; saved settings
and other persistent records can remain until you remove them. These files are
not automatically uploaded to the maintainer.

Metadata/history exports and audio downloads are created locally at your request.
Your existing local music files are not retagged. Files or reports you choose to
post in an issue or send to another person are shared by that separate action.

## Connections to iBroadcast

After you connect your account, Tagcast uses iBroadcast's OAuth, library, API,
artwork and streaming/download services. Requests carry the authorisation and
identifiers needed for the operation. Your password is entered on iBroadcast's
sign-in page, not in Tagcast's metadata editor.

Restoring a connected session can refresh its token and load the library without
a new sign-in. Displaying library images contacts iBroadcast's artwork service.
Playback requests the selected audio and may prepare subsequent tracks. Metadata,
lyrics, tags, playlists and trash changes require the relevant explicit action
and review. Local audio downloads start only when you choose Start downloads.

Two additional features are **off by default**:

- **Settings → Playback → Record played tracks in iBroadcast:** when enabled,
  sends the track ID and playback timestamp after more than ten seconds of actual
  playback. Turn it off and save to stop future play reports from Tagcast.
- **Settings → Playback → Enable queue synchronisation and remote control:**
  after enabling and approving the additional OAuth permissions, explicitly
  connecting through Devices exchanges queue and playback state with iBroadcast's
  queue service. Disable and save to stop using this feature.

Use **Disconnect** to stop the account connection. Settings or integrations you
enable directly in iBroadcast, such as its Last.fm scrobbling, are controlled by
iBroadcast and may process listening activity under their own policies.

## Automatic checks and online lookups

| Feature | When it connects and what it sends | Your control |
|---|---|---|
| Release checks | Enabled by default. At startup, with attempts cached for 24 hours, requests this project's latest stable release from `api.github.com`. Sends a `Tagcast/<version>` user agent, not account credentials, library contents or track names. | Under **Settings → About & updates**, untick **Automatically check for new stable releases** and save. **Check for updates** remains an explicit request. Nothing is installed automatically. |
| Public service status | Opening Overview requests `https://status.ibroadcast.com/status.json`; scheduled refreshes run about every five minutes while Overview is visible. This is separate from the account connection and sends no account credentials or library identifiers. | Leaving Overview or hiding the page stops scheduled refreshes. The current version has no separate status-feed switch. Refresh makes an explicit additional request subject to caching. |
| Editor metadata suggestions | Automatic lookup is on by default. Opening a single-album editor can send the artist and album search text to enabled sources. Manual searches send the text you enter. | Under **Settings → Sources & keys**, turn off **Look up an album in selected sources as soon as you open it** and save to require manual metadata searches. Individual source switches can disable that source for metadata and image suggestions. |
| Artwork suggestions and previews | Opening an artwork chooser can search enabled sources for the artist/album even when automatic editor lookup is off. Displaying returned thumbnails and images contacts the provider's image host or CDN. Using an image URL contacts the host you chose. | Disable the relevant sources and save to prevent new provider suggestion searches. Avoid remote image previews/URLs if you do not want those image requests. Uploading a chosen image to iBroadcast requires an explicit save. |
| Artist biographies and album information | Both off by default. Once enabled, visiting an artist/album can send its name, or artist and album title, to TheAudioDB when a current local result is absent. Text is cached locally; revisiting after expiry can start another lookup. Bundled 1001 Albums background texts do not require an online lookup. | Separate **Settings → Discovery** switches; disable and save. These switches are independent of TheAudioDB's metadata-source switch. |
| Lyrics lookup | Only choosing **Find lyrics** contacts LRCLIB, sending track title, artist and a known duration. Native lyrics reads use iBroadcast; previously cached text may be displayed without a new provider lookup. | Do not start Find lyrics, or disable LRCLIB under **Sources & keys** and save. Album Check lyrics reads native iBroadcast lyrics, not LRCLIB. |
| Public playlist import | Only fetching a supplied Deezer or experimental ListenBrainz playlist URL contacts that provider, using the public playlist identifier. Deezer short links may first contact the supported redirect service. Matching uses the loaded library locally. | Do not fetch a public URL. CSV matching and local LRC/TXT imports do not contact these public playlist services. |

Enabled metadata/image sources are MusicBrainz, Cover Art Archive (through
MusicBrainz artwork), Deezer, Apple iTunes Search, Discogs, Last.fm, TheAudioDB
and fanart.tv, as applicable to the requested operation. A source that needs an
API key is unavailable until one is supplied. A supplied key goes to its
corresponding provider; iBroadcast account tokens are not sent to these lookup
providers. Tagcast sends search metadata rather than uploading your music or
entire library to them.

All remote services and image hosts can see ordinary network information such
as your IP address, request time and HTTP headers. API user agents may identify
Tagcast and its version; image requests can carry the browser's user agent.
"No account or library data" does not mean a request is anonymous to its recipient.
Provider requests, caches and image hosting can involve other infrastructure
operated by those services.

## Third-party privacy information

Each operator controls its own service logs, retention and international data
processing. Consult its current policies before enabling a feature:

- [iBroadcast privacy policy](https://www.ibroadcast.com/privacy/) — account,
  library, audio, artwork, queue and public service-status services.
- [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  — release checks, downloads, source hosting and issues.
- [MetaBrainz privacy policy](https://metabrainz.org/privacy) — MusicBrainz and
  ListenBrainz; Cover Art Archive also uses external image hosting.
- [Deezer privacy policy](https://www.deezer.com/legal/personal-datas).
- [Apple privacy policy](https://www.apple.com/legal/privacy/en-ww/) — iTunes Search.
- [Discogs privacy policy](https://support.discogs.com/hc/en-us/articles/360009334513-Privacy-Policy).
- [Last.fm privacy policy](https://www.last.fm/legal/privacy).
- [TheAudioDB privacy policy](https://www.theaudiodb.com/docs_privacy_policy.php).
- [fanart.tv privacy policy](https://fanart.tv/privacy-policy/).
- [LRCLIB service and API information](https://lrclib.net/) — no separate public
  privacy-policy page was identified when this document was prepared.

Opening Help, source attribution, community or other external links visits the
chosen site, whose privacy/cookie policy applies. Installing through Homebrew,
Python/uv or other package tools also makes those tools' normal download requests.
This application policy does not describe all tracking or cookies on external
websites, including provider sign-in pages.

## Code signing and questions

Signing and notarization are release-preparation services, not additional account
or music-data uploads by the running Tagcast application. See the
[Code signing policy](README.md#code-signing-policy) for current availability.

For questions about Tagcast's behaviour, contact the maintainer through
[GitHub Issues](https://github.com/cyberdeliaAI/tagcast/issues). Issues are public;
do not include tokens, source keys or an unredacted private metadata export.
For data held by an external service, use that provider's privacy contact.
