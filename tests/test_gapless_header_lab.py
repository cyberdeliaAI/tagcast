"""Test-only bounded MP3 header inspection; no network or account is used."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gapless_header_lab", ROOT / "tools/gapless_lab/mp3_headers.py")
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)


class HeaderLabTests(unittest.TestCase):
    def test_independent_encoded_fixture_contains_expected_metadata_but_proves_no_alignment(self):
        result = LAB.inspect((ROOT / "tests/fixtures/gapless/tone.mp3").read_bytes())
        self.assertTrue(result["eligible_header"])
        self.assertEqual(result["samples_from_metadata"], 88200)
        self.assertEqual((result["delay"], result["padding"]), (576, 1080))
        self.assertFalse(result["alignment_verified"])

    def test_short_or_malformed_inputs_fail_closed(self):
        for data in (b"", b"ID3", b"ID3\x04\x00\x00\x80\x00\x00\x00", b"not audio" * 20):
            with self.subTest(length=len(data)):
                self.assertFalse(LAB.inspect(data)["eligible_header"])

    def test_missing_xing_count_or_encoder_are_distinct(self):
        original = (ROOT / "tests/fixtures/gapless/tone.mp3").read_bytes()
        at = original.index(b"Info")
        missing_marker = bytearray(original)
        missing_marker[at:at + 4] = b"none"
        self.assertEqual(LAB.inspect(missing_marker)["reason"], "no_xing_or_info")
        missing_count = bytearray(original)
        missing_count[at + 4:at + 8] = bytes(4)
        self.assertEqual(LAB.inspect(missing_count)["reason"], "no_frame_count")
        encoder = original.index(b"Lavc", at)
        self.assertEqual(LAB.inspect(original[:encoder + 23])["reason"], "no_recognized_encoder_tag")

    def test_overstated_frame_count_does_not_claim_production_eligibility(self):
        data = bytearray((ROOT / "tests/fixtures/gapless/tone.mp3").read_bytes())
        at = data.index(b"Info")
        data[at + 8:at + 12] = bytes([255]) * 4
        result = LAB.inspect(data)
        self.assertFalse(result["production_pcm_bound_allows"])
        self.assertFalse(result["eligible_header"])


if __name__ == "__main__":
    unittest.main()
