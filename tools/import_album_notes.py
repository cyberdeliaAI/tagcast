"""Build offline album notes from explicitly matched public reference pages.

This maintenance tool is never called by Tagcast. It changes no library data.
Only the Album Summary and its Wikipedia attribution are captured, never reviews.
"""

import argparse
import hashlib
import json
import re
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://1001albumsgenerator.com"
INDEX = BASE + "/albums"
LICENSE = "https://creativecommons.org/licenses/by-sa/4.0/"
USER_AGENT = "Tagcast-reference-import/0.50.0 (+https://github.com/cyberdeliaAI/tagcast)"


def normalized(value, artist=False):
    value = unicodedata.normalize("NFKD", value).casefold().replace("&", " and ")
    value = "".join(c for c in value if not unicodedata.combining(c))
    if artist:
        value = re.sub(r"^the\s+", "", value.strip())
    return "".join(c for c in value if c.isalnum())


def source_url(value):
    url = urlsplit(urljoin(BASE, value))
    if url.scheme != "https" or url.netloc != "1001albumsgenerator.com" \
            or not re.fullmatch(r"/albums/[A-Za-z0-9]+/[a-z0-9-]+", url.path) \
            or url.query or url.fragment:
        raise ValueError("Expected a public album URL from the source index")
    return url.geturl()


def additional_sources(entry):
    # A lookup URL is a research aid, not a confirmed album identity or reusable text.
    path = "/".join(quote(entry[field], safe="") for field in ("artist", "album"))
    return [{"name": "Last.fm", "url": f"https://www.last.fm/music/{path}", "verified": False}]


def reviewed_note(value):
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("text"), str) \
            or not value["text"].strip() or len(value["text"].split()) > 200 \
            or not isinstance(value.get("reason"), str) or not value["reason"]:
        raise ValueError("Editorial notes need bounded text, a Wikipedia source and a review reason")
    url = urlsplit(value.get("source_url", ""))
    if url.scheme != "https" or url.netloc != "en.wikipedia.org" \
            or not url.path.startswith("/wiki/") or url.query or url.fragment:
        raise ValueError("Editorial notes need an explicit English Wikipedia source")
    return value


class SourceIndex(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "tr" and attrs.get("data-album") and attrs.get("data-artist"):
            self.row = {"album": attrs["data-album"], "artist": attrs["data-artist"],
                        "year": int(attrs["data-year"])}
        if tag == "a" and self.row and not self.row.get("url") \
                and attrs.get("href", "").startswith("/albums/"):
            self.row["url"] = source_url(attrs["href"])

    def handle_endtag(self, tag):
        if tag == "tr" and self.row:
            if self.row.get("url"):
                self.rows.append(self.row)
            self.row = None


class AlbumSummary(HTMLParser):
    def __init__(self):
        super().__init__()
        self.heading = None
        self.active = False
        self.paragraph = None
        self.paragraphs = []
        self.wikipedia = ""

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "h3":
            self.heading = []
            self.active = False
        if tag == "p" and self.active and "card-text" in attrs.get("class", "").split():
            self.paragraph = []
        if tag == "a" and self.active and "wiki-link" in attrs.get("class", "").split():
            url = urlsplit(attrs.get("href", ""))
            if url.scheme == "https" and url.netloc == "en.wikipedia.org" \
                    and url.path.startswith("/wiki/") and not url.query and not url.fragment:
                self.wikipedia = url.geturl()
        if tag == "br" and self.paragraph is not None:
            self.paragraph.append("\n")

    def handle_data(self, data):
        if self.heading is not None:
            self.heading.append(data)
        if self.paragraph is not None:
            self.paragraph.append(data)

    def handle_endtag(self, tag):
        if tag == "h3" and self.heading is not None:
            self.active = "".join(self.heading).strip() == "Album Summary"
            self.heading = None
        if tag == "p" and self.paragraph is not None:
            self.paragraphs.append("".join(self.paragraph))
            self.paragraph = None
        if tag == "section":
            self.active = False

    def note(self):
        if not self.wikipedia:
            raise ValueError("Summary has no explicit Wikipedia source; manual review required")
        text = " ".join(" ".join(self.paragraphs).split())
        text = re.sub(r"(?<=[a-z])\.(?=[A-Z][a-z])", ". ", text)
        if not text:
            raise ValueError("No Album Summary found")
        words = text.split()
        if len(words) > 200:
            excerpt = " ".join(words[:200])
            stops = list(re.finditer(r"[.!?](?:[\"’”])?(?=\s|$)", excerpt))
            text = excerpt[:stops[-1].end()] if stops and stops[-1].end() > 350 else excerpt + "…"
        return {"text": text, "source_url": self.wikipedia,
                "attribution": "Wikipedia contributors", "license_url": LICENSE,
                "excerpt": len(words) > 200, "modified": True}


class SourceRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https" or target.netloc != "1001albumsgenerator.com":
            raise ValueError("Refusing a redirect away from the public source host")
        return super().redirect_request(request, file, code, message, headers, newurl)


class Capture:
    def __init__(self, cache, delay):
        self.cache, self.delay, self.last = cache, delay, 0
        self.opener = build_opener(SourceRedirects())
        cache.mkdir(parents=True, exist_ok=True)

    def get(self, url, limit=3_000_000):
        time.sleep(max(0, self.delay - (time.monotonic() - self.last)))
        self.last = time.monotonic()
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with self.opener.open(request, timeout=30) as response:
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise ValueError("Source page exceeds the capture size limit")
            return raw.decode("utf-8")

    def index(self):
        path = self.cache / "albums.html"
        if not path.exists():
            path.write_text(self.get(INDEX, 5_000_000), encoding="utf-8")
        parser = SourceIndex()
        parser.feed(path.read_text(encoding="utf-8"))
        if len(parser.rows) < 1000 or len({r["url"] for r in parser.rows}) != len(parser.rows):
            raise ValueError("Unexpected source index; review before capturing")
        return parser.rows

    def note(self, url):
        path = self.cache / (hashlib.sha256(url.encode()).hexdigest() + ".json")
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        parser = AlbumSummary()
        parser.feed(self.get(url))
        note = {**parser.note(), "captured_from": url, "captured_at": utc_now()}
        write_json(path, note)
        return note


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def write_review(path, report):
    from html import escape

    rows = []
    for entry in report["unresolved"]:
        candidates = "".join(
            f'<p><a href="{escape(c["url"], quote=True)}" target="_blank" rel="noopener noreferrer">'
            f'{escape(c["artist"])} · {escape(c["album"])}</a> ({c["year"]})</p>'
            for c in entry["candidates"])
        extra = "".join(
            f'<p><a href="{escape(source["url"], quote=True)}" target="_blank" rel="noopener noreferrer">'
            f'Look up on {escape(source["name"])}</a> (unverified)</p>'
            for source in entry.get("additional_sources", []))
        rows.append(f'<tr><td>{entry["id"]}</td><td><strong>{escape(entry["album"])}</strong><br>'
                    f'{escape(entry["artist"])} · {entry["year"]}</td>'
                    f'<td>{candidates or "No close candidate; search the source list manually."}</td>'
                    f'<td>{extra}</td></tr>')
    reviewed = "".join(
        f'<tr><td>{entry["id"]}</td><td><strong>{escape(entry["album"])}</strong><br>'
        f'{escape(entry["artist"])}</td><td><a href="{escape(entry["source"]["url"], quote=True)}" '
        f'target="_blank" rel="noopener noreferrer">{escape(entry["source"]["artist"])} · '
        f'{escape(entry["source"]["album"])}</a><br>{escape(entry["reason"])}</td></tr>'
        for entry in report.get("reviewed", []))
    path.with_suffix(".html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        '<title>1001 album notes · manual review</title><style>body{font:16px system-ui;line-height:1.6;'
        'max-width:1200px;margin:40px auto;padding:0 24px}table{width:100%;border-collapse:collapse}'
        'td,th{padding:14px;text-align:left;border-bottom:1px solid #ccc;vertical-align:top}'
        'td:first-child{width:60px}p{margin:0 0 8px}a{color:#235d91}</style>'
        '<h1>1001 album notes · manual review</h1>'
        f'<p>{report["source_count"]} source albums · {report["reference_count"]} reference entries · '
        f'{report["captured"]} notes captured · {len(report["unresolved"])} unresolved.</p>'
        '<p>Suggestions below are <strong>not approved</strong>. Keep the original reference IDs and selection. '
        'Review each artist/title and recording, then add approved source URLs to a separate links JSON file.</p>'
        '<p>Last.fm links are additional research aids. Their existence and descriptions have not been '
        'verified; no Last.fm text has been captured or bundled.</p>'
        '<table><thead><tr><th>ID</th><th>Our reference</th><th>Source suggestions</th>'
        '<th>Other sources</th></tr></thead><tbody>'
        + "".join(rows) + '</tbody></table>'
        '<h2>Reviewed source links</h2><p>Editorial links are kept separately from the reference selection '
        'and from users’ iBroadcast library links. They do not change album matching results.</p>'
        '<table><thead><tr><th>ID</th><th>Our reference</th><th>Reviewed source and reason</th></tr></thead><tbody>'
        + reviewed + '</tbody></table></html>\n', encoding="utf-8")


def compare(reference, sources, links):
    pairs, artists, titles = defaultdict(list), defaultdict(list), defaultdict(list)
    for source in sources:
        artist, title = normalized(source["artist"], True), normalized(source["album"])
        pairs[artist, title].append(source)
        artists[artist].append(source)
        titles[title].append(source)
    urls = {s["url"]: s for s in sources}
    results = []
    for entry in reference:
        artist, title = normalized(entry["artist"], True), normalized(entry["album"])
        exact = pairs.get((artist, title), [])
        manual = links.get(str(entry["id"]))
        manual_data = manual if isinstance(manual, dict) else {"url": manual} if manual else {}
        chosen = None
        if manual:
            url = source_url(manual_data["url"])
            chosen = urls.get(url)
            if chosen is None:
                # A separately reviewed page may be absent from the current index.
                source = manual_data.get("source", {})
                if not isinstance(source, dict) or not manual_data.get("reason") \
                        or not all(isinstance(source.get(k), str) and source[k]
                                                          for k in ("album", "artist")) \
                        or not isinstance(source.get("year"), int):
                    raise ValueError(f"Manual link {entry['id']} is not in the source index")
                chosen = {**source, "url": url}
        elif len(exact) == 1:
            chosen = exact[0]
        candidates = []
        if not chosen:
            for source in sources:
                a = SequenceMatcher(None, artist, normalized(source["artist"], True)).ratio()
                t = SequenceMatcher(None, title, normalized(source["album"])).ratio()
                score = .4 * a + .6 * t
                if (t == 1 or a >= .65) and t >= .6 and (score >= .74 or t == 1):
                    candidates.append({**source, "score": round(score, 4)})
        results.append({**entry, "status": "manual" if manual else "matched" if chosen
                        else "possible" if candidates else "missing", "source": chosen,
                        "candidates": sorted(candidates, key=lambda c: -c["score"])[:3],
                        "context": manual_data.get("context", ""),
                        "note": reviewed_note(manual_data.get("note"))})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true", help="Capture matched summaries; otherwise compare only")
    parser.add_argument("--delay", type=float, default=.5, help="Seconds between source requests (minimum .25)")
    parser.add_argument("--limit", type=int, default=0, help="Capture at most this many notes; 0 means all")
    parser.add_argument("--cache", type=Path, default=ROOT / "build/guide-import")
    parser.add_argument("--report", type=Path, default=ROOT / "build/guide-import/report.json")
    parser.add_argument("--output", type=Path, default=ROOT / "src/tagcast/static/1001-album-notes.json")
    parser.add_argument("--links", type=Path, default=ROOT / "docs/1001-album-note-links.json",
                        help="Reviewed source links; defaults to the bundled editorial review")
    args = parser.parse_args()
    if args.delay < .25 or args.limit < 0:
        parser.error("Use delay >= .25 and limit >= 0")
    reference = json.loads((ROOT / "src/tagcast/static/1001-albums.json").read_text(encoding="utf-8"))
    links = json.loads(args.links.read_text(encoding="utf-8"))
    ids = {str(e["id"]) for e in reference["entries"]}
    if not isinstance(links, dict) or set(links) - ids or not all(
        isinstance(v, str) or isinstance(v, dict) and isinstance(v.get("url"), str)
        and isinstance(v.get("context", ""), str) and len(v.get("context", "")) <= 2000
        for v in links.values()
    ):
        parser.error("Manual links must map valid reference IDs to source URLs")
    capture = Capture(args.cache, args.delay)
    sources = capture.index()
    results = compare(reference["entries"], sources, links)
    stats = dict(Counter(r["status"] for r in results))
    report = {"source": INDEX, "source_count": len(sources), "reference_count": len(results),
              "created_at": utc_now(), "counts": stats, "captured": 0, "errors": [],
              "reviewed": [{"id": r["id"], "album": r["album"], "artist": r["artist"],
                            "source": r["source"],
                            "reason": links[str(r["id"])].get("reason", "Explicitly reviewed source URL")
                            if isinstance(links[str(r["id"])], dict) else "Explicitly reviewed source URL"}
                           for r in results if r["status"] == "manual"],
              "unresolved": [{**r, "additional_sources": additional_sources(r)}
                             for r in results if not r["source"]]}
    if not args.fetch and args.output.exists():
        existing = json.loads(args.output.read_text(encoding="utf-8"))
        if existing.get("selection_sha256") == reference["source_sha256"]:
            report["captured"] = len(existing.get("entries", []))
    write_json(args.report, report)
    write_review(args.report, report)
    print(json.dumps({k: report[k] for k in ["source_count", "reference_count", "counts"]}), flush=True)
    if not args.fetch:
        return
    notes = {"schema": 1, "selection_sha256": reference["source_sha256"], "source_list": INDEX,
             "license": "CC BY-SA 4.0", "license_url": LICENSE,
             "description": "Wikipedia-attributed excerpts captured from Album Summary, with reviewed album-specific paraphrases; whitespace normalized and texts limited to 200 words. No reviews or book excerpts.",
             "entries": []}
    selected = [r for r in results if r["source"]]
    if args.limit:
        selected = selected[:args.limit]
    try:
        for index, entry in enumerate(selected, 1):
            try:
                note = capture.note(entry["source"]["url"])
                if entry["note"]:
                    override = entry["note"]
                    note = {**note, "text": override["text"], "source_url": override["source_url"],
                            "editorial_reason": override["reason"], "modified": True}
                notes["entries"].append({"id": entry["id"], "album": entry["album"], "artist": entry["artist"],
                                         "year": entry["year"], **note,
                                         **({"context": entry["context"]} if entry["context"] else {})})
            except (OSError, ValueError) as error:
                report["errors"].append({"id": entry["id"], "url": entry["source"]["url"], "error": str(error)})
                if isinstance(error, HTTPError) and error.code in (403, 429, 503):
                    raise RuntimeError("Source refused or limited requests; stop and resume later") from error
            if index % 25 == 0:
                report["captured"] = len(notes["entries"])
                write_json(args.output, notes)
                write_json(args.report, report)
                print(f"Captured {len(notes['entries'])}/{len(selected)}; {len(report['errors'])} errors", flush=True)
    finally:
        report["captured"] = len(notes["entries"])
        write_json(args.output, notes)
        write_json(args.report, report)
        write_review(args.report, report)
        print(f"Saved {report['captured']} notes; {len(report['unresolved'])} unresolved; {len(report['errors'])} errors", flush=True)


if __name__ == "__main__":
    main()
