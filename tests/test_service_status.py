"""Public health must never turn missing/stale data into a green connection claim."""

import copy
import io
import json
import ssl
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from unittest.mock import Mock, patch
from urllib.error import URLError
from urllib.request import HTTPSHandler

import certifi

from tagcast.service_status import (
    MAX_BYTES,
    SERVICES,
    NoStatusRedirect,
    ServiceStatus,
    read_status,
)


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_792_922_400
        stamp = datetime.fromtimestamp(self.now, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        self.feed = {"status": "green", "message": "All systems operational", "last_check": stamp,
                     "services": {key: {"status": "green", "available": True, "issues": "",
                                        "last_check": stamp} for _, key, _ in SERVICES}}
        self.calls = 0
        self.failure = None
        def fetch():
            self.calls += 1
            if self.failure:
                raise self.failure
            return copy.deepcopy(self.feed)
        self.status = ServiceStatus(fetch=fetch, clock=lambda: self.now, monotonic=lambda: self.now)

    def test_all_operational_and_distinct_local_and_provider_times(self):
        result = self.status.get()
        self.assertEqual(result["overall"], "operational")
        self.assertEqual(len(result["services"]), 5)
        self.assertEqual({s["state"] for s in result["services"]}, {"operational"})
        self.assertIn("fetched_at", result)
        self.now += 10
        result = self.status.get()
        self.assertEqual(self.calls, 1)
        self.assertEqual(result["checked_at"], result["fetched_at"])
        self.assertFalse(result["stale"])

    def test_degraded_outage_and_multiple_failures(self):
        for raw, available, expected in [("yellow", True, "degraded"), ("outage", False, "outage")]:
            with self.subTest(raw=raw):
                self.feed["services"]["Streaming"].update(status=raw, available=available, issues="Test issue")
                self.now += 301
                result = self.status.get()
                self.assertEqual(result["overall"], expected)
                self.assertEqual(result["services"][0]["details"], "Test issue")
        self.feed["services"]["API Server"].update(status="outage", available=False)
        self.now += 301
        stamp = datetime.fromtimestamp(self.now, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        self.feed["last_check"] = stamp
        for row in self.feed["services"].values():
            row["last_check"] = stamp
        self.assertEqual(sum(s["state"] == "outage" for s in self.status.get()["services"]), 2)

    def test_failure_timeout_and_invalid_json_do_not_reuse_confirmed_green(self):
        first = self.status.get()
        for failure in [URLError("offline"), TimeoutError(), ValueError("invalid JSON")]:
            with self.subTest(failure=type(failure).__name__):
                self.failure = failure
                self.now += 301
                result = self.status.get()
                self.assertEqual(result["overall"], "unknown")
                self.assertTrue(all(s["state"] == "unknown" for s in result["services"]))
                self.assertEqual(result["fetched_at"], first["fetched_at"])
                self.assertNotEqual(result["checked_at"], first["checked_at"])
                self.assertIn("does not mean", result["error"])

    def test_missing_and_contradictory_values_never_confirm_operational(self):
        for replacement in [None, {}, {"status": "green", "available": False},
                            {"status": "green", "available": "true"},
                            {"status": "new-provider-code", "available": True}]:
            with self.subTest(replacement=replacement):
                self.feed["services"]["Streaming"] = replacement
                self.now += 301
                result = self.status.get()
                self.assertEqual(result["overall"], "unknown")
                self.assertEqual(result["services"][0]["state"], "unknown")

    def test_old_missing_future_or_invalid_provider_timestamp_is_unknown(self):
        for stamp in [None, "bad", "2020-01-01 00:00:00", "2099-01-01 00:00:00"]:
            with self.subTest(stamp=stamp):
                self.feed["last_check"] = stamp
                self.now += 301
                result = self.status.get()
                self.assertTrue(result["stale"])
                self.assertEqual(result["overall"], "unknown")
                self.assertTrue(all(s["state"] == "unknown" for s in result["services"]))

    def test_one_stale_service_and_a_global_incident_cannot_produce_all_green(self):
        self.feed["services"]["Streaming"]["last_check"] = "2020-01-01 00:00:00"
        self.assertEqual(self.status.get()["services"][0]["state"], "unknown")
        self.feed["services"]["Streaming"] = copy.deepcopy(self.feed["services"]["API Server"])
        self.feed["status"] = "incident"
        self.now += 301
        self.assertEqual(self.status.get()["overall"], "unknown")

    def test_recovery_and_manual_refresh_are_rate_limited(self):
        self.failure = URLError("offline")
        self.status.get()
        self.status.get(refresh=True)
        self.assertEqual(self.calls, 1)
        self.failure = None
        self.now += 31
        self.assertEqual(self.status.get(refresh=True)["overall"], "operational")
        self.assertEqual(self.calls, 2)

    def test_concurrent_callers_share_one_read_without_account_or_library(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.status.get(), range(20)))
        self.assertEqual(self.calls, 1)
        results[0]["services"][0]["state"] = "changed"
        self.assertEqual(self.status.get()["services"][0]["state"], "operational")
        self.assertFalse(hasattr(self.status, "studio"))

    def test_invalid_container_and_bounded_details(self):
        self.status.fetch = lambda: {"services": []}
        self.assertEqual(self.status.get()["overall"], "unknown")
        self.status.fetch = lambda: self.feed
        self.feed["services"]["Streaming"].update(status="outage", available=False, issues="x" * 10000)
        self.now += 301
        self.assertEqual(len(self.status.get()["services"][0]["details"]), 600)

    def test_http_read_is_bounded_without_authorization_or_cookies(self):
        response = io.BytesIO(json.dumps(self.feed).encode())
        with patch("tagcast.service_status.build_opener") as opener:
            opener.return_value.open.return_value = response
            self.assertEqual(read_status()["status"], "green")
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://status.ibroadcast.com/status.json")
            self.assertNotIn("Authorization", request.headers)
            self.assertNotIn("Cookie", request.headers)
            self.assertEqual(opener.return_value.open.call_args.kwargs["timeout"], 5)
            opener.return_value.open.return_value = io.BytesIO(b"x" * (MAX_BYTES + 1))
            with self.assertRaises(ValueError):
                read_status()

    def test_https_uses_bundled_roots_with_certificate_and_hostname_verification(self):
        response = io.BytesIO(json.dumps(self.feed).encode())
        with patch("tagcast.service_status.ssl.create_default_context",
                   wraps=ssl.create_default_context) as create_context, \
                patch("tagcast.service_status.build_opener") as opener:
            opener.return_value.open.return_value = response
            read_status()
            create_context.assert_called_once_with(cafile=certifi.where())
            redirect, https = opener.call_args.args
            self.assertIsInstance(redirect, NoStatusRedirect)
            self.assertIsInstance(https, HTTPSHandler)
            self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(https._context.check_hostname)
            self.assertGreater(https._context.cert_store_stats()["x509_ca"], 0)

    def test_http_endpoint_is_public_but_retains_host_and_fetch_metadata_guards(self):
        from functools import partial
        from http.client import HTTPConnection
        from tempfile import TemporaryDirectory
        from types import SimpleNamespace

        from tagcast.app import Handler, Server
        handler = type("StatusHandler", (Handler,), {"studio": SimpleNamespace(service_status=self.status, queue_sync=Mock(), metadata_export=Mock(), audio_downloads=Mock()), "port": 0})
        with TemporaryDirectory() as directory:
            server = Server(("127.0.0.1", 0), partial(handler, directory=directory))
            handler.port = server.server_port
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for headers, code in [({}, 200), ({"Sec-Fetch-Site": "cross-site"}, 403), ({"Host": "evil.invalid"}, 403)]:
                    connection = HTTPConnection("127.0.0.1", handler.port)
                    connection.request("GET", "/api/service-status", headers=headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, code)
                    response.read()
                    connection.close()
                self.assertEqual(self.calls, 1)
            finally:
                server.shutdown()
                server.server_close()
