# Music uploads: engine and integration notes

Status: integrated locally as an optional feature, disabled by default. The reviewed
v3 engine remains in `src/tagcast/uploads.py`; `music_uploads.py` adds account/session
binding, background preparation, single-use reviews and bounded API responses.
The same page is shared by browser and Electron. No real uploads were made during
integration testing by the agent; synthetic files and a fake upload service were used.
The user subsequently reported two complete albums uploaded successfully and visible
in both iBroadcast and Tagcast. This does not establish every error/recovery behaviour.

## Using Uploads

1. Open **Settings → Data & exports → Music uploads**, enable the option and **Save changes**.
2. If upload permission has not been granted, choose **Approve upload permission…**
   and sign in again on iBroadcast. This adds the optional `user.upload` scope; it
   does not upload music or reset preferences. After approval the button is hidden
   and Settings confirms that permission is approved.
3. Open **Uploads** in the sidebar. In Electron, choose files or a folder with the
   native picker; **File and folder paths** can also be expanded for manual entry.
   In browser mode, enter complete paths on the computer running Tagcast, one per
   line. A folder includes its non-hidden subfolders.
4. Choose **Prepare & review**. Tagcast reads only your selection, gets the supported
   formats and current remote MD5 list, and shows new, already uploaded, duplicate
   or unreadable files. This does not send audio. Up to 100 chosen paths and 1,000
   discovered files are accepted per review, with at most 1.5 GB per file.
5. Review the filenames and choose **Start uploads**. Only files marked **Ready to
   upload** are sent, one at a time. The reviewed selection stays locked until you
   choose **Change selection**. Reviews expire after 15 minutes or a library change.
6. **Pause after this file** waits between files. **Stop** cancels preparation or
   interrupts a transfer where possible. A file already sent may still arrive.
   No uncertain upload is automatically repeated. Check iBroadcast before preparing
   those files again. A new explicit review always checks the remote MD5 list again.
7. Use **Reload library** after processing to see new music. Processing time belongs
   to iBroadcast; Tagcast does not automatically reload the library or disturb playback.
8. After a fully successful upload, the old path selection is cleared. Results remain
   visible until **New upload**. Failed, uncertain or incomplete results retain the
   selection for inspection; changing it never resends files automatically.

Files are grouped by source folder. **Uploaded** means a strict upload acknowledgement
or subsequent MD5 confirmation was received. The additional uploaded-file list check
is described under **Details**; a delayed list entry does not undo a successful
acknowledgement. **Needs checking** is reserved for genuinely uncertain uploads and
always retains the warning to check iBroadcast before preparing again.

Uploaded copies use the original local files and embedded metadata. Tagcast does
not retag, move, delete or adopt your local music. Byte-identical files are skipped;
changing tags changes the MD5, so this is not audio-level duplicate detection.

### Privacy and lifetime

The optional permission is requested only while Music uploads is enabled. Disabling
it stops the task and hides the sidebar entry, without disconnecting your account.
The current OAuth grant may still include the scope until you revoke/reapprove it
on iBroadcast. No credentials are exposed to the renderer or file picker.

Preparation sends no audio. Starting sends the selected audio bytes and a relative
`file_path` label (folder/filename) to iBroadcast, together with the existing app
identity and authorization. Absolute local paths, cached file MD5s and file identity
stay in `upload-hashes.json` in the private Tagcast settings directory. They are not
written into music folders. The remote MD5 list is read for matching and confirmation.
Selections, review IDs and job results are memory-only and disappear when Tagcast
stops. Navigating to another page keeps an existing task running, but stops its
page-local status polling. Disconnecting, replacing the account or shutting down
stops it. Opening Uploads never scans or starts a transfer. No watch-folder/sync or
remote deletion protocol is used.

## Which iBroadcast route

There are two upload routes. Tagcast uses the first.

| Route | Auth | Status | Used by |
| --- | --- | --- | --- |
| `POST upload.ibroadcast.com` | OAuth bearer token, `user.upload` scope | Documented permission; request shape from ibroadcast-python 2.0.1 (`iBroadcast.upload`, `_download_md5s`) and community uploaders | ibroadcast-python, community uploaders; the desktop app uses it for its MD5 list |
| `PUT/DELETE sync.ibroadcast.com/directory/{uuid}/files/{md5}` | Legacy `user_id` + `token` from an email/password `status` login | Observed only, in the official desktop app 1.0.0-beta1 (Electron); not publicly documented | Official desktop app folder sync |

The sync route is not used because it needs the legacy password login (Tagcast signs in
with OAuth device code only), is undocumented, and its `DELETE` removes library tracks
when a local file disappears. That conflicts with Tagcast's explicit, reviewed writes.

### Protocol as implemented

- **MD5 list:** `POST` with an empty `application/x-www-form-urlencoded` body. Accepted
  answer: `{"result": true, "md5": [...]}`.
- **Upload:** `POST multipart/form-data` with fields `client`, `version`, `file_path`,
  `method` and the audio in field `file`.
- **Confirmation:** only `result: true` with a message matching
  `(TRACK_ID) uploaded successfully` counts as sent. `result: false` or another 4xx is
  a refusal. 429, 5xx, a dropped connection after audio was sent, and any other answer
  (including `result: true` without that message, or non-JSON) are **uncertain**.
- **Redirects are never followed** (`allow_redirects=False` on both requests), because
  `requests` would otherwise send the file again by itself, outside the stop and
  session checks. A 3xx answer to an upload is uncertain (the file was sent once); a
  3xx answer to the MD5 list is an error and is not retried.
- **Supported types:** explicitly request `status` with `supported_types: true`,
  then parse its `supported` list (`[{"extension": ".flac", ...}]`). The current
  service omits this list without that request flag. This was verified with a
  read-only live request on 31 October 2026 and matches the official desktop app's
  API request. Preparation fails closed if the list is missing; errors identify
  the failed preparation step without exposing provider details or credentials.
- **Limit:** 1.5 GB per file (help center).

## What MD5 can and cannot tell

iBroadcast lists the MD5 of each uploaded file. The MD5 covers the complete file, so it
recognises **byte-identical files only**. The same recording with different tags,
artwork or encoding has a different MD5 and is planned as new. "Already in iBroadcast"
and "duplicate" in a plan mean "an identical file", nothing more.

Absence from the list does not prove that an upload failed: how quickly iBroadcast
lists a newly received file is not verified. Likewise, how iBroadcast treats an
incomplete or cut-off request is not verified. The engine therefore makes no promises
about either and reports such files as uncertain.

## Engine behaviour

- **Scan** (`scan`): explicit files/folders only. Regular files; hidden entries
  (including macOS `._` AppleDouble files) and links are skipped and never followed.
  Other files in chosen folders are counted, not listed. At most 100,000 files.
- **Plan** (`plan_uploads`): checks every file again, because it can change after the
  scan: file type, regular file (not a link), current size against the empty/1.5 GB
  limits. States: `new`, `uploaded` (identical file already listed), `duplicate`
  (identical file selected twice), `empty`, `too_large`, `unreadable`, `not_regular`,
  `unsupported`. Reads files to hash them; sends nothing.
- **File identity:** size, modification time, inode and (outside Windows) change time,
  recorded at planning. Files are opened without following links (`O_NOFOLLOW`
  where available) and must keep the same identity while being read.
- **Hash index** (`HashIndex`): MD5 per local path, reused only while the identity
  matches, so a replaced file with the same size and time is read again. Stored as
  `upload-hashes.json` through `Studio._read` / `Studio._write`, in the Tagcast folder,
  never inside a music folder (the official app writes `.ibsync/` there). Bounded to
  200,000 entries.
- **`file_path` label** (`path_label`): `relative` by default, starting at the chosen
  folder's own name (`Music/Artist/Album/01.flac`), so home folders and drive layout
  stay local. `absolute` matches the official apps.
- **Before sending** (`check_unchanged`, `MultipartBody`): the path must still be the
  planned regular file with the same identity; otherwise the file fails without any
  request. The opened file is checked again, and while sending, the audio must match
  the planned size and MD5. A mismatch or a stop abandons the request before its
  closing boundary.
- **Transfer** (`UploadService`, `Transfer`): streamed body with a known
  `Content-Length`. Requests go through `StudioClient._with_fresh_token`, so the shared
  OAuth refresh gate applies. Each request checks the stop flag and `valid()` first,
  including the resend after a token refresh. Its sockets are tracked once connected
  (direct and HTTP proxy connections), so a stop cuts off a request that is sending or
  waiting for an answer. See the limits below for the phase before that.
- **Job** (`UploadJob`): one file at a time; pause waits between files.
  - An uncertain answer is **never resent**. The engine checks the MD5 list after 2 s
    and 6 s: listed → `confirmed`; not listed → `uncertain`, and the job continues.
    If that check itself fails, the job ends and the remaining files are not sent.
  - A refusal fails that file; the job continues.
  - No connection before any audio left the computer → `failed` ("Not uploaded"),
    job ends. A rejected token or permission → `failed`, job ends.
  - A stop or session change before any audio was sent → `stopped` ("Not sent").
    After audio was sent → `uncertain`, never "not uploaded".
  - Every file ends in a final state: `sent`, `confirmed`, `uncertain`, `failed`,
    `stopped` or `not_sent`.
  - After the last file, one fresh MD5 list is read back. `sent` files are marked
    verified when listed; `uncertain` files that are listed become `confirmed`.

## Known limits

- **DNS lookup:** the system resolver looks up the host name before any connection.
  Neither the request timeouts nor a stop bound that lookup; how long it can take
  depends on the operating system's resolver settings. There is no guaranteed upper
  limit from Tagcast's side.
- **Connect and TLS handshake:** a stop cannot cut these off, because a socket is
  tracked only once it is connected. The 15-second connect timeout applies per socket
  operation and per address tried, not as a total for the phase. After the phase ends,
  the stop takes effect before any request data is sent.
- **Read timeout:** 600 seconds per socket operation while waiting for an answer, not
  a total. A stop cuts this wait off.
- **SOCKS proxies** are not tracked (they need PySocks, which Tagcast does not ship).
- **Windows:** file identity uses size, modification time and file index, without a
  change time.

## Integration boundaries

- `Studio.music_uploads` captures the client, account, session and a generation. A
  late preparation cannot publish into another session. Review also captures the
  loaded library identity and a monotonic expiry. Start consumes its server-side
  random review token before the worker can send audio.
- API: `GET /api/uploads?session=…&page=…`; explicit POST actions `prepare` (paths),
  `start` (review token), `pause`, `resume`, `stop`, `clear` (all session-bound).
  The existing Host, GET Fetch Metadata and POST `X-Tagcast` guards remain intact.
  Responses show 50 files per page, counts and status; no absolute file paths,
  hashes, file identities, tokens or complete service URLs are returned.
- Preparation and uploads use background workers; Studio's state lock is never held
  while scanning, hashing, waiting for sockets, or transferring. Hash-index writes
  are serialized. Stop signals session validity immediately and aborts sockets off
  the request thread. The existing upload engine handles the transfer outcomes.
- `uploads.js` owns presentation only. It never changes the player queue, stream
  settings, Gapless engine, metadata drafts, or save/review semantics. One status
  poll runs only while the Uploads page is visible and work is active.
- `electron/upload-picker.cjs` accepts only `files` or `folder` from the trusted
  main frame. It does not expose arbitrary dialog options, file reads or general
  IPC. Cancellation, reload, remote frames and stale picker results are rejected.
- Tests: `tests/test_uploads.py` (reviewed engine), `tests/test_music_uploads.py`
  (integration and API guards), frontend regression cases in `frontend.test.cjs`,
  and `electron/tests/upload-picker.test.cjs`. Real browser checks use a separate
  synthetic service that cannot contact iBroadcast.

## To verify against a real account

Read-only validation on 31 October 2026 confirmed that the granted OAuth token
can read the upload service's MD5 list and that the explicit supported-types
request above returns the file formats. No real audio was sent by these checks.

Before any release, check with a test account and synthetic audio:

- that a Tagcast OAuth token with `user.upload` is accepted by `upload.ibroadcast.com`;
- the exact answers for a new upload, an identical file and a refused file;
- how soon a new MD5 appears in the list;
- what happens to a request cut off before its closing boundary;
- how the `file_path` label appears in the library `path` field.

Until then, keep the uncertain/unverified wording above.
