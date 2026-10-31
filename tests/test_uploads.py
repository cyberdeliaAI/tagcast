"""Music uploads against a local fake upload service; synthetic files, no real account."""

import hashlib
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from tagcast import __version__, client, uploads
from tagcast.uploads import (
    CONFIRMED,
    DUPLICATE,
    EMPTY,
    FAILED,
    NEW,
    NOT_REGULAR,
    NOT_SENT,
    QUEUED,
    SENT,
    STOPPED,
    TOO_LARGE,
    UNCERTAIN,
    UNSUPPORTED,
    UPLOADED,
    HashIndex,
    UploadError,
    UploadJob,
    UploadService,
    file_identity,
    plan_summary,
    plan_uploads,
    scan,
    supported_extensions,
)

AUDIO = frozenset({".flac", ".mp3"})
OK = {"result": True}


def md5(data):
    return hashlib.md5(data).hexdigest()


def identity(path):
    return file_identity(os.lstat(path))


def symlink_or_skip(test, target, link):
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        test.skipTest("Symbolic links are not available here.")


def parse_multipart(body, content_type):
    """Fields and files of a complete body; None if the closing boundary never arrived."""
    delimiter = b"--" + content_type.split("boundary=", 1)[1].encode()
    closing = delimiter + b"--\r\n"
    if not body.endswith(closing):
        return None
    fields, files = {}, {}
    for part in body[:-len(closing)].split(delimiter + b"\r\n")[1:]:
        head, _, content = part.partition(b"\r\n\r\n")
        disposition = head.decode("utf-8").split("\r\n")[0]
        name = re.search(r' name="([^"]*)"', disposition).group(1)
        filename = re.search(r'filename="([^"]*)"', disposition)
        if filename:
            files[name] = (filename.group(1), content[:-2])
        else:
            fields[name] = content[:-2].decode("utf-8")
    return fields, files


class FakeUploadService:
    """The upload endpoint's observable behaviour: an MD5 list and one file per request.

    ``script`` sets the answer per complete upload: ok, accept_then_503, lose_with_502,
    refuse, unknown_ok_stored, unknown_ok_lost, html or hold (store, then wait).
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.md5s, self.uploads, self.requests = set(), [], []
        self.tokens = {"good"}
        self.script = []
        self.fail_lists = 0
        self.list_redirect = None  # e.g. 307: answer list requests with that redirect
        self.lists = self.attempts = self.authorized_attempts = self.incomplete = 0
        self.moved = 0  # requests that reached a redirect target
        self.next_track = 7000
        self.received, self.release = threading.Event(), threading.Event()
        service = self

        class Handler(BaseHTTPRequestHandler):
            timeout = 10

            def log_message(self, *args):
                pass

            def reply(self, status, data, content_type="application/json", location=None):
                payload = data if isinstance(data, bytes) else json.dumps(data).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(payload)))
                    if location:
                        self.send_header("Location", location)
                    self.end_headers()
                    self.wfile.write(payload)
                except OSError:
                    pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    body = self.rfile.read(length)
                except OSError:
                    body = b""
                if self.path.startswith("/moved"):
                    with service.lock:
                        service.moved += 1
                    return self.reply(200, {"result": True, "md5": [],
                                            "message": "Moved (9999) uploaded successfully"})
                content_type = self.headers.get("Content-Type", "")
                multipart = content_type.startswith("multipart/form-data")
                authorized = self.headers.get("Authorization", "").removeprefix("Bearer ") in service.tokens
                with service.lock:
                    service.requests.append(dict(self.headers))
                    if multipart:
                        service.attempts += 1
                        service.authorized_attempts += authorized
                if not authorized:
                    return self.reply(401, {"result": False, "authenticated": False})
                if not multipart:
                    with service.lock:
                        service.lists += 1
                        failing = service.fail_lists > 0
                        service.fail_lists -= failing
                        listed = sorted(service.md5s)
                    if service.list_redirect:
                        return self.reply(service.list_redirect, {}, location="/moved")
                    if failing:
                        return self.reply(500, {})
                    return self.reply(200, {"result": True, "md5": listed})
                parsed = parse_multipart(body, content_type) if len(body) == length else None
                if parsed is None:
                    with service.lock:
                        service.incomplete += 1
                    return self.reply(400, {"result": False, "message": "Incomplete upload"})
                fields, files = parsed
                filename, data = files["file"]
                with service.lock:
                    action = service.script.pop(0) if service.script else "ok"
                    if action in ("ok", "accept_then_503", "unknown_ok_stored", "hold"):
                        service.md5s.add(md5(data))
                        service.uploads.append({"fields": fields, "filename": filename,
                                                "data": data, "headers": dict(self.headers)})
                    service.next_track += 1
                    track = service.next_track
                answers = {
                    "accept_then_503": (503, {"result": False, "message": "Busy"}),
                    "lose_with_502": (502, {}),
                    "refuse": (200, {"result": False, "message": "File type not supported"}),
                    "unknown_ok_stored": (200, {"result": True, "message": "Queued"}),
                    "unknown_ok_lost": (200, {"result": True, "message": "Queued"}),
                }
                if action == "html":
                    return self.reply(200, b"<html>OK</html>", "text/html")
                if action.startswith("redirect_"):
                    return self.reply(int(action[9:]), {}, location="/moved")
                if action == "hold":
                    service.received.set()
                    service.release.wait(10)
                if action in answers:
                    return self.reply(*answers[action])
                return self.reply(200, {"result": True,
                                        "message": f"Artist - Title ({track}) uploaded successfully"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/upload"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


class FakeClient:
    """The StudioClient surface the upload service uses, including its refresh retry."""
    _client, _version, _user_agent = "tagcast", "9.9.9", "tagcast/9.9.9"

    def __init__(self, token="good", renewed=None, refresh_error=None, before_refresh=None,
                 before_send=None):
        self.token, self.renewed = token, renewed
        self.refresh_error, self.before_refresh = refresh_error, before_refresh
        self.before_send = before_send

    def _with_fresh_token(self, send):
        if self.before_send:  # a proactive refresh of an expired token
            self.before_send()
        response = send(self.token)
        if response.status_code in (401, 403) and (self.renewed or self.refresh_error):
            response.close()
            if self.before_refresh:
                self.before_refresh()
            if self.refresh_error:
                raise self.refresh_error
            self.token = self.renewed
            response = send(self.token)
        return response


class Files:
    def __init__(self, test):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name).resolve() / "Music"

    def write(self, relative, data):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path


def memory_index():
    store = {}
    return HashIndex(store.get, store.__setitem__), store


class ScanAndPlanTests(unittest.TestCase):
    def test_supported_extensions_are_normalized(self):
        status = {"supported": [{"extension": ".FLAC"}, {"extension": "mp3"},
                                {"extension": " "}, {"type": "x"}, "bad"]}
        self.assertEqual(supported_extensions(status), {".flac", ".mp3"})
        self.assertEqual(supported_extensions({}), frozenset())

    def test_scan_skips_hidden_linked_and_other_files(self):
        files = Files(self)
        keep = [files.write("A/01 One.flac", b"one"), files.write("A/02 Two.MP3", b"two")]
        files.write("A/._01 One.flac", b"appledouble")
        files.write(".hidden/x.flac", b"hidden")
        files.write("A/cover.jpg", b"art")
        files.write("A/album.cue", b"cue")
        try:
            os.symlink(keep[0], files.root / "A" / "linked.flac")
            os.symlink(files.root / "A", files.root / "linked-folder", target_is_directory=True)
        except (OSError, NotImplementedError):
            pass  # Windows without symlink rights; the rest still applies
        found, ignored = scan([files.root], AUDIO)
        self.assertEqual([f.path for f in found], keep)
        self.assertEqual(ignored, 2)
        with self.assertRaises(UploadError):
            scan(["relative/folder"], AUDIO)

    def test_plan_marks_identical_duplicate_and_unusable_files(self):
        files = Files(self)
        there = files.write("Kate Bush/Hounds of Love/01.flac", b"already there")
        new = files.write("Kate Bush/Hounds of Love/02.flac", b"new audio")
        copy = files.write("Kate Bush/Other Copy/02.flac", b"new audio")  # scanned after
        files.write("Kate Bush/Hounds of Love/03.flac", b"")
        files.write("Kate Bush/Hounds of Love/04.flac", b"x" * 40)
        chosen = files.write("Elsewhere/notes.txt", b"text")
        found, _ = scan([files.root / "Kate Bush", chosen], AUDIO)
        index, _ = memory_index()
        with patch.object(uploads, "MAX_FILE_BYTES", 30):
            items = plan_uploads(found, AUDIO, {md5(b"already there")}, index)
        status = {item.path.name if item.path != copy else "copy": item.status for item in items}
        self.assertEqual(status, {"01.flac": UPLOADED, "02.flac": NEW, "copy": DUPLICATE,
                                  "03.flac": EMPTY, "04.flac": TOO_LARGE,
                                  "notes.txt": UNSUPPORTED})
        labels = {item.path: item.label for item in items}
        self.assertEqual(labels[new], "Kate Bush/Hounds of Love/02.flac")
        self.assertEqual(labels[chosen], "Elsewhere/notes.txt")
        self.assertNotIn(str(files.root.parent), "".join(labels.values()))
        summary = plan_summary(items)
        self.assertEqual(summary["bytes_to_send"], len(b"new audio"))
        self.assertEqual(summary["counts"][NEW], 1)
        self.assertEqual(there.read_bytes(), b"already there")  # nothing local changes

    def test_retagged_copy_is_not_recognized_as_uploaded(self):
        # MD5 recognises identical files only, not the same recording with other tags.
        files = Files(self)
        files.write("A/01.flac", b"TAGS:new|audio")
        found, _ = scan([files.root], AUDIO)
        index, _ = memory_index()
        items = plan_uploads(found, AUDIO, {md5(b"TAGS:old|audio")}, index)
        self.assertEqual(items[0].status, NEW)

    def test_plan_checks_files_again_after_the_scan(self):
        files = Files(self)
        grown = files.write("A/01.flac", b"small")
        linked = files.write("A/02.flac", b"audio")
        found, _ = scan([files.root], AUDIO)
        grown.write_bytes(b"x" * 50)  # grew above the limit after the scan
        linked.unlink()
        other = files.write("Elsewhere/02.flac", b"audio")
        symlink_or_skip(self, other, linked)
        index, _ = memory_index()
        with patch.object(uploads, "MAX_FILE_BYTES", 30):
            items = plan_uploads(found, AUDIO, set(), index)
        self.assertEqual([(i.status, i.size) for i in items][0], (TOO_LARGE, 50))
        self.assertEqual(items[1].status, NOT_REGULAR)

    def test_absolute_labels_match_the_official_apps(self):
        files = Files(self)
        path = files.write("A/01.flac", b"one")
        found, _ = scan([files.root], AUDIO)
        index, _ = memory_index()
        items = plan_uploads(found, AUDIO, set(), index, path_mode="absolute")
        self.assertEqual(items[0].label, str(path))

    def test_hash_index_rehashes_only_changed_files_and_persists(self):
        files = Files(self)
        path = files.write("A/01.flac", b"first")
        index, store = memory_index()
        real = uploads.file_md5
        with patch.object(uploads, "file_md5", side_effect=real) as hashed:
            for _ in range(2):
                index.md5(path, identity(path))
            self.assertEqual(hashed.call_count, 1)
            path.write_bytes(b"other")  # same size, new contents
            stat = path.stat()
            os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
            self.assertEqual(index.md5(path, identity(path)), md5(b"other"))
            self.assertEqual(hashed.call_count, 2)
        index.save()
        reopened = HashIndex(store.get, store.__setitem__)
        with patch.object(uploads, "file_md5", side_effect=AssertionError("re-read")):
            self.assertEqual(reopened.md5(path, identity(path)), md5(b"other"))

    def test_hash_index_rereads_a_replaced_file_with_the_same_size_and_time(self):
        files = Files(self)
        path = files.write("A/01.flac", b"first")
        index, _ = memory_index()
        self.assertEqual(index.md5(path, identity(path)), md5(b"first"))
        stat = path.stat()
        replacement = files.write("A/new.tmp", b"other")
        os.utime(replacement, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        os.replace(replacement, path)
        self.assertEqual(index.md5(path, identity(path)), md5(b"other"))

    def test_hash_index_is_bounded(self):
        files = Files(self)
        paths = [files.write(f"{n}.flac", bytes([n])) for n in range(4)]
        store = {}
        index = HashIndex(store.get, store.__setitem__, limit=2)
        for path in paths:
            index.md5(path, identity(path))
        index.save()
        self.assertEqual(list(store[uploads.HASH_FILE]["files"]), [str(p) for p in paths[2:]])


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeUploadService()
        self.addCleanup(self.fake.close)
        self.files = Files(self)
        patcher = patch.object(uploads, "RETRY_DELAYS", (0, 0))
        patcher.start()
        self.addCleanup(patcher.stop)

    def service(self, **kwargs):
        return UploadService(FakeClient(**kwargs), url=self.fake.url)

    def plan(self, *items):
        for name, data in items:
            self.files.write(name, data)
        found, _ = scan([self.files.root], AUDIO)
        index, _ = memory_index()
        return plan_uploads(found, AUDIO, self.service().remote_md5s(), index)

    def statuses(self, items):
        return [item.status for item in items]

    def test_streams_fields_and_file_with_known_length(self):
        data = os.urandom(300_000)
        items = self.plan(("Sigur Rós/Ágætis byrjun/01 Svefn-g-englar.flac", data))
        job = UploadJob(self.service(), items)
        with patch.object(uploads, "CHUNK", 64 * 1024):
            job.run()
        self.assertEqual(job.state, "done")
        upload = self.fake.uploads[0]
        self.assertEqual(upload["data"], data)
        self.assertEqual(upload["filename"], "01 Svefn-g-englar.flac")
        self.assertEqual(upload["fields"], {"client": "tagcast", "version": "9.9.9",
                                            "file_path": "Music/Sigur Rós/Ágætis byrjun/"
                                                         "01 Svefn-g-englar.flac",
                                            "method": "tagcast"})
        self.assertNotIn("Transfer-Encoding", upload["headers"])
        self.assertEqual(upload["headers"]["User-Agent"], "tagcast/9.9.9")
        item = items[0]
        self.assertEqual((item.status, item.track_id, item.sent, item.verified),
                         (SENT, "7001", len(data), True))
        self.assertEqual(job.view()["bytes"], {"total": len(data), "sent": len(data)})
        self.assertEqual((self.fake.lists, self.fake.attempts), (2, 1))  # plan, read-back

    # 1. Unclear answers are confirmed through the MD5 list, never resent.

    def test_unclear_answer_is_confirmed_without_a_second_upload(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["accept_then_503"]
        UploadJob(self.service(), items).run()
        self.assertEqual(self.statuses(items), [CONFIRMED, SENT])
        self.assertEqual(self.fake.attempts, 2)

    def test_unlisted_unclear_upload_stays_uncertain_and_is_not_resent(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["lose_with_502"]
        job = UploadJob(self.service(), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("done", [UNCERTAIN, SENT]))
        self.assertIn("not sent again automatically", items[0].note)
        self.assertEqual(self.fake.attempts, 2)  # one per file
        self.assertFalse(items[0].verified)

    def test_failed_md5_check_after_unclear_answer_ends_the_job_without_resending(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["lose_with_502"]
        self.fake.fail_lists = 99
        job = UploadJob(self.service(), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("failed", [UNCERTAIN, NOT_SENT]))
        self.assertEqual(self.fake.attempts, 1)

    # 2. The session binding is checked before every request.

    def test_session_is_checked_before_the_resend_after_a_token_refresh(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        replaced = threading.Event()
        service = self.service(token="old", renewed="good", before_refresh=replaced.set)
        job = UploadJob(service, items, valid=lambda: not replaced.is_set())
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [STOPPED, NOT_SENT]))
        self.assertIn("Not sent", items[0].note)
        self.assertEqual((self.fake.authorized_attempts, self.fake.uploads), (0, []))

    def test_session_is_checked_before_confirming_an_unclear_upload(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["lose_with_502"]
        answered = []
        job = UploadJob(self.service(), items, valid=lambda: not answered)
        real = job.service.upload

        def upload(item, transfer, **kwargs):
            try:
                return real(item, transfer, **kwargs)
            finally:
                answered.append(item)

        job.service.upload = upload
        lists = self.fake.lists
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [UNCERTAIN, NOT_SENT]))
        self.assertEqual(self.fake.lists, lists)  # no read with the replaced session

    def test_replaced_session_stops_before_the_next_file(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        sent = []
        job = UploadJob(self.service(), items, valid=lambda: not sent)
        real = job.service.upload

        def upload(item, transfer, **kwargs):
            result = real(item, transfer, **kwargs)
            sent.append(item)
            return result

        job.service.upload = upload
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [SENT, NOT_SENT]))

    def test_session_is_checked_again_after_resume(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        valid = threading.Event()
        valid.set()
        job = UploadJob(self.service(), items, valid=valid.is_set)
        real = job.service.upload

        def upload(item, transfer, **kwargs):
            result = real(item, transfer, **kwargs)
            job.pause()
            return result

        job.service.upload = upload
        job.start()
        self.wait_for(lambda: job.state == "paused" and items[0].status == SENT)
        valid.clear()
        job.resume()
        job.join(5)
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [SENT, NOT_SENT]))
        self.assertEqual(self.fake.attempts, 1)

    # 3. Stopping cuts requests off and reports possibly received files as uncertain.

    def test_stop_after_the_last_audio_chunk_keeps_the_request_incomplete(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))

        class StopAfterChunk(UploadJob):
            def _progress(self, item):
                update = super()._progress(item)

                def stop_now(sent):
                    update(sent)
                    self.stop()
                return stop_now

        job = StopAfterChunk(self.service(), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [UNCERTAIN, NOT_SENT]))
        self.assertIn("may have received it", items[0].note)
        self.wait_for(lambda: self.fake.incomplete == 1)
        self.assertEqual(self.fake.uploads, [])

    def test_stop_cuts_off_a_request_waiting_for_its_answer(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["hold"]
        job = UploadJob(self.service(), items)
        job.start()
        self.assertTrue(self.fake.received.wait(5))
        started = time.monotonic()
        job.stop()
        job.join(5)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [UNCERTAIN, NOT_SENT]))
        self.assertNotIn("not uploaded", items[0].note.lower())

    # 4. Only a recognizable confirmation counts as sent.

    def test_unrecognized_answers_are_uncertain_until_listed(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"), ("A/03.flac", b"three"))
        self.fake.script = ["unknown_ok_lost", "unknown_ok_stored", "html"]
        job = UploadJob(self.service(), items)
        job.run()
        self.assertEqual(self.statuses(items), [UNCERTAIN, CONFIRMED, UNCERTAIN])
        self.assertEqual([i.track_id for i in items], ["", "", ""])
        self.assertEqual(self.fake.attempts, 3)

    def check_upload_redirect(self, code):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = [f"redirect_{code}"]
        answered = []
        job = UploadJob(self.service(), items, valid=lambda: not answered)
        real = job.service.upload

        def upload(item, transfer, **kwargs):
            try:
                return real(item, transfer, **kwargs)
            finally:
                answered.append(item)  # the session is gone once the first answer is in

        job.service.upload = upload
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("stopped", [UNCERTAIN, NOT_SENT]))
        self.assertIn(f"redirected the request elsewhere (HTTP {code})", items[0].note)
        self.assertEqual((self.fake.attempts, self.fake.moved, self.fake.uploads), (1, 0, []))

    def test_upload_redirect_307_is_not_followed(self):
        self.check_upload_redirect(307)

    def test_upload_redirect_308_is_not_followed(self):
        self.check_upload_redirect(308)

    def test_redirected_upload_is_uncertain_and_the_job_continues(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["redirect_307"]
        job = UploadJob(self.service(), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("done", [UNCERTAIN, SENT]))
        self.assertEqual((self.fake.attempts, self.fake.moved), (2, 0))
        self.assertEqual([u["data"] for u in self.fake.uploads], [b"two"])

    def test_list_redirects_are_errors_and_not_followed(self):
        for code in (307, 308):
            with self.subTest(code=code):
                self.fake.list_redirect, lists = code, self.fake.lists
                with self.assertRaisesRegex(UploadError, f"HTTP {code}.*not followed"):
                    self.service().remote_md5s()
                self.assertEqual((self.fake.lists - lists, self.fake.moved), (1, 0))

    def test_refusal_is_reported_and_the_job_continues(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        self.fake.script = ["refuse"]
        job = UploadJob(self.service(), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("done", [FAILED, SENT]))
        self.assertEqual(items[0].note, "File type not supported")

    # 5. Files are checked again before sending; replacements and links are refused.

    def test_file_changed_after_planning_is_not_sent(self):
        items = self.plan(("A/01.flac", b"original"), ("A/02.flac", b"two"))
        items[0].path.write_bytes(b"replaced")  # same size, different audio
        job = UploadJob(self.service(), items)
        job.run()
        self.assertEqual(self.statuses(items), [FAILED, SENT])
        self.assertIn("changed after it was planned", items[0].note)
        self.assertEqual(self.fake.attempts, 1)

    def test_replaced_file_is_not_sent_even_with_the_same_contents_and_time(self):
        items = self.plan(("A/01.flac", b"original"),)
        stat = items[0].path.stat()
        twin = self.files.write("twin.tmp", b"original")
        os.utime(twin, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        os.replace(twin, items[0].path)
        UploadJob(self.service(), items).run()
        self.assertEqual((items[0].status, self.fake.attempts), (FAILED, 0))

    def test_file_replaced_by_a_link_is_not_followed(self):
        items = self.plan(("A/01.flac", b"original"),)
        elsewhere = self.files.root.parent / "elsewhere.flac"
        shutil.copy2(items[0].path, elsewhere)
        items[0].path.unlink()
        symlink_or_skip(self, elsewhere, items[0].path)
        UploadJob(self.service(), items).run()
        self.assertEqual((items[0].status, self.fake.attempts), (FAILED, 0))
        self.assertIn("link", items[0].note)

    def test_opening_for_sending_checks_identity_again(self):
        # A replacement between the pre-send check and opening the file.
        items = self.plan(("A/01.flac", b"original"),)
        twin = self.files.write("twin.tmp", b"original")
        os.replace(twin, items[0].path)
        with patch.object(uploads, "check_unchanged", lambda item: None):
            UploadJob(self.service(), items).run()
        self.assertEqual(items[0].status, FAILED)
        self.assertIn("changed after it was checked", items[0].note)
        self.assertEqual(self.fake.uploads, [])

    def test_file_changed_while_sending_is_cut_off_and_uncertain(self):
        data = os.urandom(64 * 1024)
        items = self.plan(("A/01.flac", data), ("A/02.flac", b"two"))

        class ChangeAfterFirstChunk(UploadJob):
            def _progress(self, item):
                update = super()._progress(item)

                def change(sent):
                    update(sent)
                    if item is items[0] and sent == 16 * 1024:
                        with open(item.path, "r+b") as handle:  # same size, same inode
                            handle.seek(-4, os.SEEK_END)
                            handle.write(b"XXXX")
                return change

        job = ChangeAfterFirstChunk(self.service(), items)
        with patch.object(uploads, "CHUNK", 16 * 1024):
            job.run()
        self.assertEqual(self.statuses(items), [UNCERTAIN, SENT])
        self.assertIn("file changed", items[0].note)
        self.wait_for(lambda: self.fake.incomplete == 1)
        self.assertEqual(len(self.fake.uploads), 1)

    # 6. Every failure path settles the file.

    def test_failed_token_refresh_after_a_refusal_settles_the_file(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        expired = client.NotConnected("Your iBroadcast session expired. Connect again.")
        job = UploadJob(self.service(token="old", refresh_error=expired), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("failed", [FAILED, NOT_SENT]))
        self.assertIn("Connect again", job.message)

    def test_failed_proactive_refresh_settles_the_file(self):
        items = self.plan(("A/01.flac", b"one"),)

        def expire():
            raise client.NotConnected("Your iBroadcast session expired. Connect again.")

        job = UploadJob(self.service(before_send=expire), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("failed", [FAILED]))

    def test_rejected_session_stops_the_job(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        job = UploadJob(self.service(token="expired"), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("failed", [FAILED, NOT_SENT]))
        self.assertIn("Connect again", job.message)

    def test_unreachable_service_fails_without_sending_or_guessing(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed = f"http://127.0.0.1:{probe.getsockname()[1]}/upload"
        job = UploadJob(UploadService(FakeClient(), url=closed), items)
        job.run()
        self.assertEqual((job.state, self.statuses(items)), ("failed", [FAILED, NOT_SENT]))
        self.assertIn("Not uploaded", items[0].note)

    # Pause, read-back and the real client.

    def test_pause_waits_between_files(self):
        items = self.plan(("A/01.flac", b"one"), ("A/02.flac", b"two"))
        job = UploadJob(self.service(), items)
        real = job.service.upload

        def upload(item, transfer, **kwargs):
            result = real(item, transfer, **kwargs)
            job.pause()
            return result

        job.service.upload = upload
        job.start()
        self.wait_for(lambda: items[0].status == SENT)
        time.sleep(0.3)
        self.assertEqual((job.state, items[1].status), ("paused", QUEUED))
        job.service.upload = real
        job.resume()
        job.join(5)
        self.assertEqual((job.state, self.statuses(items)), ("done", [SENT, SENT]))

    def test_studio_client_refreshes_an_expired_token_once(self):
        old = client.oauth.TokenSet("old-access", "old-refresh", time.time() + 3600)
        new = client.oauth.TokenSet("new-access", "new-refresh", time.time() + 3600)
        transport = client.StudioClient(access_token=old.access_token,
                                        refresh_token=old.refresh_token, client_id="test-client")
        transport.token_set = old
        self.fake.tokens = {"new-access"}
        self.fake.md5s = {"abc"}
        service = UploadService(transport, url=self.fake.url)
        with patch.object(client.auth, "refresh_access_token", return_value=new) as refresh:
            self.assertEqual(service.remote_md5s(), {"abc"})
        refresh.assert_called_once_with("test-client", "old-refresh")
        self.assertEqual(self.fake.requests[-1]["User-Agent"], f"tagcast/{__version__}")

    def wait_for(self, condition, seconds=5):
        deadline = time.monotonic() + seconds
        while not condition():
            if time.monotonic() > deadline:
                self.fail("Condition not reached in time")
            time.sleep(0.01)


if __name__ == "__main__":
    unittest.main()
