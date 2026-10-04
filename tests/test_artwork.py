import base64
import unittest
from unittest import mock

from ibroadcast_editor import artwork
from ibroadcast_editor.artwork import ArtworkError

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489")


class ArtworkTests(unittest.TestCase):
    def test_image_types_are_recognized_by_content(self):
        self.assertEqual(artwork.sniff(PNG), "image/png")
        self.assertEqual(artwork.sniff(b"\xff\xd8\xff\xe0rest"), "image/jpeg")
        self.assertIsNone(artwork.sniff(b"<svg></svg>"))

    def test_uploads_are_decoded_named_and_size_checked(self):
        data, name, mime = artwork.from_data_url(
            "data:image/png;base64," + base64.b64encode(PNG).decode(), "My Cover?.jpeg")
        self.assertEqual((data, name, mime), (PNG, "My Cover.png", "image/png"))
        with self.assertRaises(ArtworkError):
            artwork.from_data_url("data:image/png;base64,!!!")
        with mock.patch.object(artwork, "MAX_IMAGE", 10), self.assertRaises(ArtworkError):
            artwork.checked(PNG)

    def test_local_and_non_http_addresses_are_refused(self):
        for url in ("file:///etc/passwd", "http://127.0.0.1/x.png", "http://192.168.1.1/a.jpg",
                    "ftp://example.com/a.png"):
            with self.assertRaises(ArtworkError, msg=url):
                artwork.from_url(url)


if __name__ == "__main__":
    unittest.main()
