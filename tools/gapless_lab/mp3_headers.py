"""Read at most five chosen-album MP3 headers; never save music, names or native IDs."""

import argparse
import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def inspect(data):
    pos = 0
    if data[:3] == b"ID3":
        if len(data) < 10 or any(b & 128 for b in data[6:10]):
            return {"eligible_header": False, "reason": "invalid_id3"}
        pos = 10 + sum(b << shift for b, shift in zip(data[6:10], (21, 14, 7, 0)))
        if data[5] & 16:
            pos += 10
    if pos + 40 >= len(data) or data[pos] != 255 or data[pos + 1] & 224 != 224:
        return {"eligible_header": False, "reason": "no_frame_within_bounded_head"}
    version, layer, index = data[pos + 1] >> 3 & 3, data[pos + 1] >> 1 & 3, data[pos + 2] >> 2 & 3
    if version == 1 or layer != 1 or index == 3:
        return {"eligible_header": False, "reason": "unsupported_mp3_header"}
    rate = (44100, 48000, 32000)[index] // (1 if version == 3 else 2 if version == 2 else 4)
    mono = data[pos + 3] >> 6 == 3
    at = pos + 4 + (0 if data[pos + 1] & 1 else 2) + ((17 if mono else 32) if version == 3 else (9 if mono else 17))
    marker = data[at:at + 4]
    if marker not in (b"Xing", b"Info"):
        return {"eligible_header": False, "reason": "no_xing_or_info", "rate": rate, "channels": 1 if mono else 2}
    flags = int.from_bytes(data[at + 4:at + 8], "big")
    at += 8
    if not flags & 1:
        return {"eligible_header": False, "reason": "no_frame_count"}
    frames = int.from_bytes(data[at:at + 4], "big")
    at += 4 + (4 if flags & 2 else 0) + (100 if flags & 4 else 0) + (4 if flags & 8 else 0)
    if len(data) < at + 24 or data[at:at + 4] not in (b"LAME", b"Lavc", b"Lavf"):
        return {"eligible_header": False, "reason": "no_recognized_encoder_tag", "xing": marker.decode()}
    delay = data[at + 21] * 16 + (data[at + 22] >> 4)
    padding = (data[at + 22] & 15) * 256 + data[at + 23]
    samples = frames * (1152 if version == 3 else 576) - delay - padding
    channels = 1 if mono else 2
    return {"eligible_header": samples > 0 and samples * channels * 4 <= 128 * 1024 ** 2, "xing": marker.decode(), "encoder": data[at:at + 9].decode("ascii", "replace"),
            "rate": rate, "channels": channels, "frames": frames, "delay": delay, "padding": padding,
            "samples_from_metadata": samples, "production_pcm_bound_allows": samples * channels * 4 <= 128 * 1024 ** 2,
            "alignment_verified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--album", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    url = urlsplit(args.origin)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.username or url.password or url.query or url.fragment
            or url.path not in ("", "/") or not args.album.isdecimal()):
        parser.error("Use one explicit local Tagcast origin and one displayed album ID.")
    with urlopen(args.origin.rstrip("/") + "/api/albums?ids=" + args.album, timeout=15) as response:
        payload = response.read(2 * 1024 ** 2 + 1)
    if len(payload) > 2 * 1024 ** 2:
        raise ValueError("Chosen album response exceeded the diagnostic bound")
    album = json.loads(payload)["albums"][0]
    ids = [str(row["id"]) for row in album["tracks"][:5]]
    del payload, album
    rows = []
    for index, track in enumerate(ids):
        for quality in ("128", "320"):
            request = Request(args.origin.rstrip("/") + "/api/stream/" + track + "?quality=" + quality,
                              headers={"Range": "bytes=0-262143"})
            try:
                with urlopen(request, timeout=20) as response:
                    data = response.read(262144)
                    row = {"sample": index + 1, "quality_requested": quality, "http_status": response.status,
                           "mime": response.headers.get("Content-Type"), "head_bytes": len(data), **inspect(data)}
                    del data
            except (OSError, HTTPError, URLError) as error:
                row = {"sample": index + 1, "quality_requested": quality, "error": "header_request_failed"}
                if isinstance(error, HTTPError):
                    row["http_status"] = error.code
                elif isinstance(error, TimeoutError):
                    row["error"] = "header_request_timeout"
            rows.append(row)
    report = {"scope": "Five tracks from one explicitly chosen album; bounded in-memory headers only. No names, native IDs, credentials or audio persisted.", "results": rows}
    with open(args.output, "w", encoding="utf8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({"requests": len(rows), "recognized_headers": sum(r.get("eligible_header", False) for r in rows),
                      "failed_requests": sum("error" in r for r in rows)}))


if __name__ == "__main__":
    main()
