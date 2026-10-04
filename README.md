# Library Studio for iBroadcast

A local editor for your iBroadcast collection, **one album or one album artist at a time**. Sign in with your own iBroadcast app, fix titles, artists, years, disc and track numbers and genres, review every change, then save it to iBroadcast.

The server runs on your computer and listens on `127.0.0.1` only. Your music files are never touched.

## 1. Create an iBroadcast app

1. Open [media.ibroadcast.com](https://media.ibroadcast.com/), open the side menu and choose **Apps**.
2. Click **Developer** at the bottom and create an app.
3. Copy the **client ID**. The client secret isn't needed.

Want to use browser sign-in instead of a code? Add `http://127.0.0.1:8912/callback` as a redirect URI in the app settings.

## 2. Run

With [uv](https://docs.astral.sh/uv/):

```bash
uv run ibroadcast-editor --open
```

Or with plain Python 3.11+:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
ibroadcast-editor --open
```

Open <http://127.0.0.1:8912>, click **Connect iBroadcast**, paste the client ID and choose **Sign in with a code**. Approve Library Studio on the iBroadcast page and your library loads.

You can also set the client ID up front: `IBROADCAST_CLIENT_ID=... uv run ibroadcast-editor`.

The client ID and sign-in tokens are stored in `~/.library-studio/` (files readable by you only). Set `LIBRARY_STUDIO_HOME` to use a different folder. **Disconnect** revokes the token and deletes it. Use `--port` to change the port; the redirect URI changes with it.

## What it does

- Loads your live iBroadcast library, with album artwork. Built for large libraries (tested with 286,000 tracks); see below.
- Search, filter on missing years, missing genres or named editions.
- Edit one album: title, album artist, year, disc number, genre for all tracks, and each track individually.
- Select albums **within one artist** and change only the fields you tick.
- Review before/after values, then **Save to iBroadcast**.
- Look up the album on MusicBrainz or Last.fm (website links, nothing automatic).
- Without an account it still runs with demo data, or with an imported library JSON. Those are never saved online.

### Large libraries

iBroadcast can only send the whole library at once (about 92 MB and 20–30 seconds for 286,000 tracks). Library Studio downloads it only when something changed:

- Each load first asks iBroadcast when the library last changed (`lastmodified` from the `status` call, the same signal the web player uses). If that matches the copy Library Studio has, the copy is used: from memory (under a second) or from `~/.library-studio/library-cache.json.gz` after a restart (about 2 seconds).
- The cache holds only library metadata (tracks, albums, artists), no account details. It is readable by you only and deleted when you **Disconnect**. **Download everything again** in the account dialog skips the check.
- The browser gets a small list of albums (about 5 MB for 18,000 albums). Tracks are fetched when you open an album.

The server keeps the library in memory: count on roughly 750 MB for 286,000 tracks.

### How saving stays safe

1. The server checks your library against iBroadcast and compares every "before" value with it. If anything changed in iBroadcast since you loaded it, **nothing is written** and you're asked to reload. When iBroadcast reports no change since the last download, the copy in memory is used for this check; otherwise a fresh copy is downloaded first.
2. Artist names are matched to existing artists (exact name first, then case-insensitive). A name that doesn't exist yet is shown as a warning in the review and created with `create_artist` when you save.
3. Changes are sent with `update_album` and `update_track`, grouped like the official web editor does. Only the changed fields are sent.
4. The library is **downloaded again and read back** and every record is reported as *Saved*, *Not confirmed* or *Failed*. If one request fails, later requests are not sent. With a large library this read-back takes about as long as a full download.

Album year changes leave track years alone unless you tick that option. Individual track edits win over album-wide changes.

## API notes

Built on [ibroadcast-python](https://github.com/ctrueden/ibroadcast-python) for OAuth (device code and PKCE authorization code flows), token refresh and the request format.

The [public API reference](https://help.ibroadcast.com/en/developer/api) documents reading the library, tags, playlists and ratings. Metadata writes (`update_album`, `update_track`, `create_artist`) come from the official [web editor script](https://media.ibroadcast.com/js/iBroadcastLibraryEditor.js), inspected on 2026-10-04. They aren't documented publicly, so:

- year and disc are sent as strings, the way the web editor sends input values; track number is sent as `track_no`;
- the app requests the scopes `user.library:read`, `user.library:write` and `user.account:read`;
- if iBroadcast refuses a write mode for third-party apps, the save reports **Failed** with iBroadcast's message and nothing else is sent.

The whole flow is tested against a fake iBroadcast server (`tests/mock_ibroadcast.py`), not yet against a real account. Try a single, easy-to-undo edit first.

## Tests

```bash
uv run --with pytest pytest          # or:
PYTHONPATH=src python3 -m unittest discover -s tests -v
node --check src/ibroadcast_editor/static/app.js
```

To click through the full flow without a real account:

```bash
python3 tests/mock_ibroadcast.py 9555 &
LIBRARY_STUDIO_IBROADCAST_BASE=http://127.0.0.1:9555 LIBRARY_STUDIO_HOME=/tmp/ls-test \
  IBROADCAST_CLIENT_ID=test PYTHONPATH=src python3 -m ibroadcast_editor.app
```

## Not in scope

Whole-library automatic enrichment, uploads, deletions, artwork changes and local file edits.
