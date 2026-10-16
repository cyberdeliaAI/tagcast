"""No real account: review, batch limits, retained copies and interrupted trash writes."""

import copy
import json
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

from tagcast.client import StudioClient
from tagcast.duplicate_cleanup import DuplicateCleanup, suggest_copies
from tagcast.library import Library, LibraryError


def library_data(albums=1, positions=2):
    data = {"artists": {"1": {"name": "Artist"}}, "albums": {}, "tracks": {}}
    for album in range(1, albums + 1):
        ids = []
        for position in range(1, positions + 1):
            for copy_id in range(2):
                track_id = album * 10000 + position * 2 + copy_id
                ids.append(track_id)
                data["tracks"][str(track_id)] = {"title": f"Song {position}", "artist_id": 1,
                    "album_id": album, "track": position, "length": 180, "type": "audio/flac",
                    "uploaded_on": "2022-01-01" if not copy_id else "2026-01-01",
                    "uploaded_time": "12:30:00"}
        data["albums"][str(album)] = {"name": f"Album {album}", "artist_id": 1,
                                             "disc": 1, "tracks": ids}
    return {"library": data, "combine_sets": False}


class LocalStudio:
    def __init__(self, raw=None, store=None):
        self.raw = raw or library_data()
        self.store = store if store is not None else {}
        self.save_lock = threading.Lock()
        self.client = self
        self.library_user = "owner"
        self.writes = []
        self.on_write = None
        self.fail = self.accept_then_fail = self.ignore = self.fail_readback = False
        self.cleanup = DuplicateCleanup(self)

    def _read(self, name):
        return copy.deepcopy(self.store.get(name))

    def _write(self, name, value):
        self.store[name] = copy.deepcopy(value)

    def _require_client(self):
        if self.client is None:
            raise LibraryError("Disconnected")
        return self.client

    def _library(self):
        return Library(copy.deepcopy(self.raw)), self.library_user

    def _current(self, client, refresh=False):
        if self.fail_readback and self.writes:
            raise LibraryError("Read-back failed")
        return self._library()[0], "memory"

    def _jsonrequest(self, mode, **body):
        assert mode == "trash"
        self.writes.append(copy.deepcopy(body["tracks"]))
        if self.fail:
            raise LibraryError("Lost reply")
        if not self.ignore:
            for track_id in body["tracks"]:
                self.raw["library"]["tracks"][str(track_id)]["trashed"] = True
        if self.on_write:
            self.on_write()
        if self.accept_then_fail:
            raise LibraryError("Accepted but reply lost")
        return {}


def finished(studio):
    for _ in range(500):
        if not studio.cleanup.running:
            return studio.cleanup.view(report=True)
        time.sleep(.01)
    raise AssertionError("Duplicate cleanup did not finish")


class DuplicateCleanupTests(unittest.TestCase):
    def run_plan(self, studio, excluded=None):
        preview = studio.cleanup.prepare()
        studio.cleanup.start(preview["id"], excluded or [], True)
        return finished(studio)

    def test_shared_suggestion_fixtures_match_album_page_rules(self):
        cases = json.loads(Path(__file__).with_name("fixtures").joinpath("duplicate_suggestions.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case=case["name"]):
                tracks = [{"id": str(i + 1), "album_id": "1", "track": 1, "title": "Song",
                           "artist": "Artist", "length": 180, "format": "FLAC",
                           "uploaded_at": "2022-01-01", **t} for i, t in enumerate(case["tracks"])]
                choices = suggest_copies(tracks)
                self.assertEqual([t["id"] for t in choices if t["choice"] == "trash"], case["remove"])
                self.assertEqual([t["id"] for t in choices if t["choice"] == "manual"], case["manual"])
                self.assertEqual([{k: t[k] for k in ("choice", "reason")} for t in choices], case["choices"])

    def test_open_and_analysis_are_read_only_and_exclusions_keep_copies(self):
        studio = LocalStudio()
        self.assertEqual(studio.cleanup.view(), {"state": "empty"})
        preview = studio.cleanup.prepare()
        self.assertEqual((preview["tracks"], preview["scanned"], preview["manual"]), (2, 1, 0))
        self.assertEqual(studio.writes, [])
        for approved, excluded in [(False, []), (True, []), (True, ["fake"])]:
            if approved and not excluded:
                continue
            with self.assertRaises(LibraryError):
                studio.cleanup.start(preview["id"], excluded, approved)
        with self.assertRaises(LibraryError):
            studio.cleanup.start(preview["id"], [t["id"] for t in preview["selection"]], True)
        studio.cleanup.start(preview["id"], ["10002"], True)
        report = finished(studio)
        self.assertEqual(report["state"], "done")
        self.assertEqual(report["counts"], {"excluded": 1, "confirmed": 1})
        self.assertEqual(studio.writes, [[10004]])
        self.assertFalse(studio.raw["library"]["tracks"]["10003"].get("trashed"))

    def test_batch_limits_for_many_albums_and_many_tracks_on_one_album(self):
        for albums, positions in [(23, 1), (1, 205), (22, 11)]:
            with self.subTest(albums=albums, positions=positions):
                studio = LocalStudio(library_data(albums, positions))
                report = self.run_plan(studio)
                self.assertEqual(report["state"], "done")
                self.assertEqual(report["counts"], {"confirmed": albums * positions})
                for batch in studio.writes:
                    self.assertLessEqual(len(batch), 200)
                    self.assertLessEqual(len({t // 10000 for t in batch}), 20)
                self.assertEqual(len({t for batch in studio.writes for t in batch}), albums * positions)

    def test_changes_to_either_copy_or_membership_block_the_batch(self):
        mutations = [lambda raw: raw["tracks"]["10003"].update(title="Remix"),
                     lambda raw: raw["tracks"]["10003"].update(type="audio/mpeg"),
                     lambda raw: raw["tracks"]["10003"].update(uploaded_time="13:00:00"),
                     lambda raw: raw["tracks"]["10003"].update(trashed=True),
                     lambda raw: raw["tracks"]["10003"].update(album_id=2),
                     lambda raw: raw["albums"]["1"]["tracks"].remove(10003),
                     lambda raw: (raw["tracks"].update({"10999": {**raw["tracks"]["10003"]}}),
                                  raw["albums"]["1"]["tracks"].append(10999))]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                studio = LocalStudio()
                preview = studio.cleanup.prepare()
                mutate(studio.raw["library"])
                studio.cleanup.start(preview["id"], [], True)
                report = finished(studio)
                self.assertEqual(report["state"], "error")
                self.assertIn("changed", report["error"])
                self.assertEqual(studio.writes, [])

    def test_changed_combine_setting_and_other_saves_are_blocked(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare()
        with studio.save_lock, self.assertRaises(LibraryError):
            studio.cleanup.start(preview["id"], [], True)
        studio.raw["combine_sets"] = True
        studio.cleanup.start(preview["id"], [], True)
        self.assertIn("multi-disc", finished(studio)["error"])
        self.assertEqual(studio.writes, [])

    def test_stop_resume_and_restart_preserve_confirmed_copies(self):
        studio = LocalStudio(library_data(21, 1))
        studio.on_write = lambda: studio.cleanup.stop.set()
        report = self.run_plan(studio)
        self.assertEqual(report["state"], "stopped")
        self.assertEqual(len(studio.writes), 1)
        restarted = LocalStudio(studio.raw, studio.store)
        restarted.cleanup.start(report["id"], [], True)
        report = finished(restarted)
        self.assertEqual(report["state"], "done")
        self.assertEqual(report["counts"], {"confirmed": 21})
        self.assertEqual(len(restarted.writes), 1)
        self.assertEqual(len(restarted.writes[0]), 1)

    def test_accepted_request_with_lost_reply_stops_and_resume_only_checks_it(self):
        studio = LocalStudio(library_data(21, 1))
        studio.accept_then_fail = True
        report = self.run_plan(studio)
        self.assertEqual(report["state"], "error")
        self.assertEqual(report["counts"], {"confirmed": 20, "pending": 1})
        studio.accept_then_fail = False
        studio.cleanup.start(report["id"], [], True)
        self.assertEqual(finished(studio)["state"], "done")
        self.assertEqual(len(studio.writes), 2)

    def test_unconfirmed_requests_never_retry_even_after_restart(self):
        for mode in ("fail", "ignore", "fail_readback"):
            with self.subTest(mode=mode):
                studio = LocalStudio()
                setattr(studio, mode, True)
                report = self.run_plan(studio)
                self.assertEqual(report["state"], "error")
                self.assertEqual(len(studio.writes), 1)
                restarted = LocalStudio(studio.raw, studio.store)
                restarted.cleanup.start(report["id"], [], True)
                after = finished(restarted)
                if mode == "fail_readback":
                    self.assertEqual(after["state"], "done")  # request succeeded before failed read-back
                else:
                    self.assertIn("not be retried", after["error"])
                    self.assertEqual(after["counts"], {"unconfirmed": 2})
                self.assertEqual(restarted.writes, [])

    def test_persisted_running_intent_is_not_repeated(self):
        studio = LocalStudio()
        studio.cleanup.prepare()
        studio.cleanup.task["state"] = "running"
        for item in studio.cleanup._items():
            item["status"] = "sent"
        studio.cleanup._persist()
        restarted = LocalStudio(studio.raw, studio.store)
        self.assertEqual(restarted.cleanup.view()["state"], "stopped")
        restarted.cleanup.start(studio.cleanup.task["id"], [], True)
        self.assertIn("not be retried", finished(restarted)["error"])
        self.assertEqual(restarted.writes, [])

    def test_accounts_cannot_read_or_execute_each_others_report(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare()
        studio.library_user = "other"
        for action in (studio.cleanup.view, lambda: studio.cleanup.start(preview["id"], [], True),
                       lambda: studio.cleanup.cancel(preview["id"])):
            with self.assertRaises(LibraryError):
                action()
        self.assertEqual(studio.writes, [])
        new = studio.cleanup.prepare()  # explicitly replace previous account's plan
        self.assertNotEqual(new["id"], preview["id"])

    def test_disconnect_during_batch_prevents_subsequent_writes(self):
        studio = LocalStudio(library_data(21, 1))
        studio.on_write = lambda: setattr(studio, "client", None)
        preview = studio.cleanup.prepare()
        studio.cleanup.start(preview["id"], [], True)
        for _ in range(500):
            if not studio.cleanup.running:
                break
            time.sleep(.01)
        self.assertFalse(studio.cleanup.running)
        self.assertEqual(len(studio.writes), 1)
        studio.client = studio
        self.assertEqual(studio.cleanup.view()["state"], "error")

    def test_disc_boundaries_and_manual_cases_remain_in_report(self):
        raw = library_data(2, 1)
        raw["library"]["albums"]["2"].update(name="Album 1", disc=2)
        raw["library"]["tracks"]["10002"]["length"] = 210
        studio = LocalStudio(raw)
        preview = studio.cleanup.prepare()
        self.assertEqual((preview["scanned"], preview["tracks"], preview["manual"]), (1, 1, 1))
        self.assertEqual(len(preview["groups"][0]["positions"]), 2)
        # Native combined membership still separates tracks' original album IDs.
        raw["library"]["albums"]["1"]["tracks"].extend(raw["library"]["albums"].pop("2")["tracks"])
        studio = LocalStudio(raw)
        preview = studio.cleanup.prepare()
        self.assertEqual((preview["tracks"], preview["manual"]), (1, 1))
        self.assertEqual(len(preview["groups"][0]["positions"]), 2)

    def test_no_positive_repeated_numbers_means_no_suggestions(self):
        raw = library_data()
        for track in raw["library"]["tracks"].values():
            track["track"] = 0
        studio = LocalStudio(raw)
        report = studio.cleanup.prepare()
        self.assertEqual((report["tracks"], report["scanned"]), (0, 0))
        for offset, limit in [("x", 10), (0, 21), (-1, 1)]:
            with self.assertRaises(LibraryError):
                studio.cleanup.view(offset, limit)

    def test_missing_original_album_ids_do_not_merge_separate_displayed_discs(self):
        raw = library_data(2, 1)
        for track in raw["library"]["tracks"].values():
            track["album_id"] = 0
        studio = LocalStudio(raw)
        preview = studio.cleanup.prepare()
        self.assertEqual((preview["scanned"], preview["tracks"]), (2, 2))

    def test_trash_transport_does_not_retry_a_lost_reply(self):
        client = StudioClient()
        with patch("tagcast.client.time.sleep"), \
                patch("tagcast.client.requests.post", side_effect=requests.ConnectionError) as post:
            with self.assertRaises(Exception):
                client._post("https://api.ibroadcast.com/trash", {"mode": "trash", "tracks": [1]})
            self.assertEqual(post.call_count, 1)
