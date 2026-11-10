"""Browser CSP protects the real served document, including live source updates."""

import base64
import hashlib
import os
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from pathlib import Path

from tagcast.app import Handler, Server
from tagcast.content_security import BASE_POLICY, RULES, content_policy


def script_hash(source):
    return "'sha256-" + base64.b64encode(hashlib.sha256(source.encode()).digest()).decode() + "'"


class PolicyTests(unittest.TestCase):
    def test_only_exact_script_text_is_authorised_with_html_line_endings(self):
        body = '\nconst label = "é";\n'
        expected = script_hash(body)
        for newline in ("\n", "\r\n", "\r"):
            self.assertIn(expected, content_policy(("<SCRIPT>" + body + "</SCRIPT>").replace("\n", newline)))
        self.assertNotIn(script_hash(body.strip()), content_policy("<script>" + body + "</script>"))
        self.assertNotIn(expected, content_policy('<script>const label = "x";</script>'))
        self.assertNotIn("sha256-", content_policy('<script src="app.js"></script><script> </script>'))

    def test_permissions_are_narrow_and_keep_media_and_artwork(self):
        self.assertEqual(RULES["script-src"], ["'self'"])
        self.assertEqual(RULES["connect-src"], ["'self'"])
        self.assertEqual(RULES["media-src"], ["'self'", "blob:"])
        self.assertEqual(RULES["img-src"], ["'self'", "https:", "data:", "blob:"])
        for directive in ("object-src", "frame-src", "frame-ancestors"):
            self.assertEqual(RULES[directive], ["'none'"])
        self.assertNotIn("unsafe-eval", BASE_POLICY)
        self.assertNotIn("*", BASE_POLICY)
        self.assertNotIn("'unsafe-inline'", BASE_POLICY.split("script-src ")[1].split(";")[0])


class ServedPolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.page = b'<html><script>window.notice = "before";</script></html>'
        (self.root / "index.html").write_bytes(self.page)
        (self.root / "app.js").write_text("// local", encoding="utf-8")
        (self.root / "notes.json").write_text("{}", encoding="utf-8")
        os.utime(self.root / "notes.json", (1_000_000_000, 1_000_000_000))
        handler = type("CSPHandler", (Handler,), {"port": 0})
        self.server = Server(("127.0.0.1", 0), partial(handler, directory=self.directory.name))
        handler.port = self.server.server_port
        self.worker = threading.Thread(target=self.server.serve_forever)
        self.worker.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.directory.cleanup()

    def request(self, path, method="GET", headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_main_get_and_head_hash_the_served_snapshot_and_keep_security_headers(self):
        for path in ("/", "/index.html", "/?auth_error=%3Cscript%3Ebad()%3C/script%3E"):
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method):
                    status, headers, body = self.request(path, method, {"If-None-Match": '"old"'})
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["Content-Security-Policy"], content_policy(self.page))
                    self.assertEqual(headers["Cache-Control"], "no-store")
                    self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                    self.assertEqual(headers["X-Frame-Options"], "DENY")
                    self.assertEqual(headers["Referrer-Policy"], "no-referrer")
                    self.assertEqual(body, self.page if method == "GET" else b"")
                    self.assertEqual(int(headers["Content-Length"]), len(self.page))
                    self.assertNotIn(script_hash("bad()"), headers["Content-Security-Policy"])

    def test_unchanged_timestamp_and_size_cannot_reuse_stale_script_hashes(self):
        path = self.root / "index.html"
        os.utime(path, (1_000_000_000, 1_000_000_000))
        before = self.request("/")[1]["Content-Security-Policy"]
        changed = self.page.replace(b"before", b"after!")
        self.assertEqual(len(changed), len(self.page))
        path.write_bytes(changed)
        os.utime(path, (1_000_000_000, 1_000_000_000))
        status, headers, body = self.request("/")
        self.assertEqual((status, body), (200, changed))
        self.assertNotEqual(headers["Content-Security-Policy"], before)
        self.assertEqual(headers["Content-Security-Policy"], content_policy(changed))

    def test_other_responses_have_base_policy_without_authorising_dynamic_input(self):
        for path, expected in (("/app.js", 200), ("/api/app", 200), ("/missing", 404)):
            status, headers, _ = self.request(path)
            self.assertEqual(status, expected)
            self.assertEqual(headers["Content-Security-Policy"], BASE_POLICY)
        status, headers, _ = self.request("/notes.json", headers={"If-Modified-Since": "Thu, 01 Jan 2037 00:00:00 GMT"})
        self.assertEqual(status, 304)
        self.assertEqual(headers["Content-Security-Policy"], BASE_POLICY)
        self.assertEqual(self.request("/api/app", headers={"Host": "foreign.invalid"})[0], 403)
        self.assertEqual(self.request("/api/app", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
