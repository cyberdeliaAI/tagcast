"""Keep source installs and frozen builds off the compromised emSign trust root."""

import hashlib
import re
import ssl
import tomllib
import unittest
from importlib.metadata import version
from pathlib import Path

import certifi

ROOT = Path(__file__).resolve().parent.parent
MINIMUM_CERTIFI = (2026, 10, 19)
# emSign ECC Root CA - G3, removed for GHSA-6q48-6c7w-9gw2.
COMPROMISED_ROOT_SHA256 = "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b"


class CertificateBundleTests(unittest.TestCase):
    def test_unlocked_installs_require_patched_certifi(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        minimums = [
            tuple(map(int, match.groups()))
            for dependency in project["project"]["dependencies"]
            if (match := re.fullmatch(r"certifi>=(\d{4})\.(\d+)\.(\d+)", dependency))
        ]
        self.assertTrue(minimums, "Declare a direct certifi security floor for pip installs")
        self.assertGreaterEqual(max(minimums), MINIMUM_CERTIFI)

    def test_locked_and_installed_certifi_are_patched(self):
        lock = tomllib.loads((ROOT / "uv.lock").read_text())
        locked = next(package for package in lock["package"] if package["name"] == "certifi")
        for source, value in (("uv.lock", locked["version"]), ("runtime", version("certifi"))):
            with self.subTest(source=source):
                self.assertGreaterEqual(tuple(map(int, value.split("."))), MINIMUM_CERTIFI)

    def test_actual_ca_bundle_excludes_compromised_root(self):
        # Load only certifi, not the operating system's independent trust store.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cafile=certifi.where())
        roots = context.get_ca_certs(binary_form=True)
        self.assertTrue(roots, "The packaged CA bundle must remain readable and nonempty")
        fingerprints = {hashlib.sha256(root).hexdigest() for root in roots}
        self.assertNotIn(COMPROMISED_ROOT_SHA256, fingerprints)
