"""Controlled cleanup drafts, interruption, conflicts and credit preservation."""

import copy
import threading
import time
import unittest
from unittest.mock import patch

from tagcast.cleanup import Cleanup, candidate, split_labels
from tagcast.library import Library, LibraryError, plan_save


def data():
    return {"library": {
        "artists": {"1": {"name": "SBB;10cc"}, "2": {"name": "10cc"},
                    "3": {"name": "Bach; Handel"}, "4": {"name": "Guest"}},
        "albums": {"10": {"name": "A", "artist_id": 2, "disc": 1, "tracks": [100]},
                   "11": {"name": "B", "artist_id": 4, "disc": 1, "tracks": [101]}},
        "tracks": {"100": {"title": "First", "artist_id": 1, "album_id": 10,
                            "genre": "Pop; Rock; Films/Games; Comedy", "genres_additional": ["ROCK", "Jazz"],
                            "artists_additional": [{"artist_id": 3, "type": "composer", "phrase": None},
                                                   {"artist_id": 4, "type": "artist", "phrase": "feat."}]},
                   "101": {"title": "Second", "artist_id": 2, "album_id": 11,
                            "genre": "Jazz; Blues"}}}}


class LocalStudio:
    """No network: a server-side library whose writes can be interrupted deliberately."""
    def __init__(self, raw=None, store=None):
        self.raw = raw or data()
        self.store = store or {}
        self.save_lock = threading.Lock()
        self.library_user = "test-owner"
        self.client = self
        self.writes, self.creations, self.downloads = [], [], 0
        self.fail = False
        self.accept_then_fail = False
        self.ignore = False
        self.on_write = None
        self.cleanup = Cleanup(self)

    def _read(self, name):
        return copy.deepcopy(self.store.get(name))

    def _write(self, name, value):
        self.store[name] = copy.deepcopy(value)

    def _require_client(self):
        if self.client is None:
            raise LibraryError("Disconnected")
        return self.client

    def _library(self):
        return Library(self.raw), self.library_user

    def _current(self, client, refresh=False):
        self.downloads += bool(refresh)
        return Library(copy.deepcopy(self.raw)), "memory"

    def _jsonrequest(self, mode, **body):
        if mode == "create_artist":
            self.creations.append(body["name"])
            artists = self.raw["library"]["artists"]
            i = max(map(int, artists)) + 1
            artists[str(i)] = {"name": body["name"]}
            return {"artist_id": i}
        assert mode == "update_track"
        self.writes.append(copy.deepcopy(body["tracks"]))
        if self.fail:
            raise LibraryError("Rejected write")
        if not self.ignore:
            for row in body["tracks"]:
                self.raw["library"]["tracks"][str(row["file_id"])].update(
                    {k: v for k, v in row.items() if k != "file_id"})
        if self.on_write:
            self.on_write()
        if self.accept_then_fail:
            raise LibraryError("Lost reply")
        return {}


def finished(studio):
    for _ in range(500):
        if not studio.cleanup.running:
            return studio.cleanup.view(report=True)
        time.sleep(.01)
    raise AssertionError("Cleanup did not finish")


class CleanupTests(unittest.TestCase):
    def test_explicit_label_removal_preserves_others_promotes_primary_and_can_clear_only_genre(self):
        for genre, extras, after in [("P", ["Rock", "Films/Games"], ["Rock", "Films/Games"]),
                                     ("Rock", ["P", "Films/Games"], ["Rock", "Films/Games"]),
                                     ("P", [], [])]:
            with self.subTest(genre=genre, extras=extras):
                raw = data()
                raw["library"]["tracks"]["100"].update(genre=genre, genres_additional=extras)
                raw["library"]["tracks"]["101"].update(genre="p", genres_additional=[])
                studio = LocalStudio(raw)
                preview = studio.cleanup.prepare("genre-labels", "P", [], remove=True)
                self.assertEqual(preview["tracks"], 1)
                self.assertEqual(preview["groups"][0]["examples"][0]["after"], after)
                self.assertTrue(preview["mapping"]["remove"])
                self.assertEqual(studio.writes, [])
                studio.cleanup.start(preview["id"], [])
                self.assertEqual(finished(studio)["counts"], {"confirmed": 1})
                self.assertEqual(studio.writes[0][0], {"file_id": 100,
                    "genre": after[0] if after else "", "genres_additional": after[1:]})
                self.assertEqual(studio.raw["library"]["tracks"]["101"]["genre"], "p")
                self.assertEqual(LocalStudio(studio.raw, studio.store).cleanup.view()["mapping"], preview["mapping"])

    def test_removal_requires_explicit_boolean_and_empty_replacements(self):
        studio = LocalStudio()
        for category, replacements, remove in [("genre-labels", [], False),
                                               ("genre-labels", [], "true"),
                                               ("genre-labels", ["Pop"], True),
                                               ("genres", [], True)]:
            with self.subTest(category=category, remove=remove), self.assertRaises(LibraryError):
                studio.cleanup.prepare(category, "P", replacements, remove=remove)
        self.assertEqual(studio.writes, [])

    def test_manual_label_inventory_is_exact_active_searchable_and_paged(self):
        raw = data()
        raw["library"]["albums"]["11"].update(name="A", artist_id=2, disc=2)
        raw["library"]["tracks"]["100"].update(genre="Films/Games", genres_additional=["Rock/Pop/R"])
        raw["library"]["tracks"]["101"].update(genre="Films/Games", genres_additional=["rock/pop/r"])
        raw["library"]["tracks"]["102"] = {"album_id": 10, "genre": "Hidden", "trashed": True}
        raw["library"]["albums"]["10"]["tracks"].append(102)
        studio = LocalStudio(raw)
        inventory = studio.cleanup.labels(limit=1)
        self.assertEqual(inventory, {"labels": [{"label": "Films/Games", "tracks": 2, "albums": 1}],
                                    "total": 3, "offset": 0, "limit": 1})
        self.assertEqual(studio.cleanup.labels("rock/", offset=1, limit=1)["labels"][0]["label"], "rock/pop/r")
        self.assertEqual(studio.writes, [])
        for offset, limit in [(-1, 50), (0, 101), ("bad", 50)]:
            with self.assertRaises(LibraryError):
                studio.cleanup.labels(offset=offset, limit=limit)

    def test_manual_label_replacement_preserves_other_genres_and_requires_exact_match(self):
        raw = data()
        raw["library"]["tracks"]["100"].update(genre="Jazz", genres_additional=["Rock/Pop/R", "Films/Games"])
        raw["library"]["tracks"]["101"].update(genre="rock/pop/r")
        studio = LocalStudio(raw)
        preview = studio.cleanup.prepare("genre-labels", "Rock/Pop/R", ["Rock", "Pop", "R"])
        self.assertEqual(preview["tracks"], 1)
        self.assertEqual(preview["groups"][0]["examples"][0]["after"],
                         ["Jazz", "Rock", "Pop", "R", "Films/Games"])
        self.assertEqual(studio.writes, [])
        self.assertEqual(preview["mapping"], {"label": "Rock/Pop/R", "replacements": ["Rock", "Pop", "R"]})
        studio.cleanup.start(preview["id"], [])
        self.assertEqual(finished(studio)["counts"], {"confirmed": 1})
        self.assertEqual(studio.writes, [[{"file_id": 100, "genre": "Jazz",
                                          "genres_additional": ["Rock", "Pop", "R", "Films/Games"]}]])
        self.assertEqual(studio.creations, [])
        self.assertEqual(studio.raw["library"]["tracks"]["101"]["genre"], "rock/pop/r")

    def test_manual_label_batches_stop_resume_persist_and_check_conflicts(self):
        raw = data()
        for row in raw["library"]["tracks"].values():
            row.update(genre="Rock/Pop/R", genres_additional=[])
        studio = LocalStudio(raw)
        preview = studio.cleanup.prepare("genre-labels", "Rock/Pop/R", ["Rock", "Pop", "R"])
        studio.on_write = lambda: studio.cleanup.cancel(preview["id"])
        with patch("tagcast.cleanup.BATCH_TRACKS", 1):
            studio.cleanup.start(preview["id"], [])
            self.assertEqual(finished(studio)["counts"], {"confirmed": 1, "pending": 1})
        restarted = LocalStudio(studio.raw, studio.store)
        self.assertEqual(restarted.cleanup.view()["mapping"], preview["mapping"])
        restarted.raw["library"]["tracks"]["101"]["genre"] = "Changed elsewhere"
        restarted.cleanup.start(preview["id"])
        self.assertEqual(finished(restarted)["counts"], {"confirmed": 1, "conflict": 1})
        self.assertEqual(restarted.writes, [])
        restarted.library_user = "another-account"
        with self.assertRaises(LibraryError):
            restarted.cleanup.view()

    def test_manual_label_rules_validate_input_and_block_overfull_tracks(self):
        studio = LocalStudio()
        for label, replacements in [(None, ["Rock"]), ("", ["Rock"]), ("Rock", []),
                                    ("Rock", "Pop"), ("Rock", [3]), ("Rock", [""]),
                                    ("Rock", ["x" * 201]), ("Rock", ["x"] * 21)]:
            with self.subTest(label=label, replacements=replacements), self.assertRaises(LibraryError):
                studio.cleanup.prepare("genre-labels", label, replacements)
        label = studio.raw["library"]["tracks"]["100"]["genre"]
        preview = studio.cleanup.prepare("genre-labels", label, [f"Genre {i}" for i in range(20)])
        self.assertEqual(preview["counts"], {"blocked": 1})
        with self.assertRaises(LibraryError):
            studio.cleanup.start(preview["id"], [])
        self.assertEqual(studio.writes, [])

    def test_only_semicolons_split_and_keep_order_trim_and_deduplicate(self):
        self.assertEqual(split_labels([" Pop; Rock ;pop;;Films/Games", "R&B", "Earth, Wind & Fire"]),
                         ["Pop", "Rock", "Films/Games", "R&B", "Earth, Wind & Fire"])

    def test_preview_is_read_only_paged_and_track_specific(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        self.assertEqual((preview["albums"], preview["tracks"]), (2, 2))
        self.assertEqual(preview["groups"][0]["examples"][0]["after"],
                         ["Pop", "Rock", "Films/Games", "Comedy", "Jazz"])
        self.assertEqual(len(studio.cleanup.view(limit=1)["groups"]), 1)
        self.assertEqual(studio.writes, [])
        self.assertEqual(studio.creations, [])
        for kwargs in ({"offset": -1}, {"limit": 0}, {"offset": "bad"}):
            with self.assertRaises(LibraryError):
                studio.cleanup.view(**kwargs)

    def test_merged_discs_have_one_selection_and_exclude_together(self):
        raw = data()
        raw["library"]["albums"]["11"].update(name="A", artist_id=2, disc=2)
        studio = LocalStudio(raw)
        preview = studio.cleanup.prepare("genres")
        self.assertEqual(preview["albums"], 1)
        studio.cleanup.start(preview["id"], ["10"])
        self.assertEqual(finished(studio)["counts"], {"excluded": 2})
        self.assertEqual(studio.writes, [])

    def test_genres_only_batches_across_artists_verify_once_per_batch(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        with patch("tagcast.cleanup.BATCH_TRACKS", 1):
            studio.cleanup.start(preview["id"], [])
            report = finished(studio)
        self.assertEqual(report["counts"], {"confirmed": 2})
        self.assertEqual(len(studio.writes), 2)
        self.assertEqual(studio.downloads, 3)  # initial check plus one read-back per batch
        self.assertEqual(set(studio.writes[0][0]), {"file_id", "genre", "genres_additional"})
        self.assertEqual(studio.raw["library"]["tracks"]["101"]["genre"], "Jazz")
        self.assertNotIn("owner", report)
        self.assertFalse(studio.save_lock.locked())

    def test_track_artist_split_reuses_ids_preserves_composers_and_guest_phrase(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("track-artists")
        studio.cleanup.start(preview["id"], [])
        self.assertEqual(finished(studio)["counts"], {"confirmed": 1})
        self.assertEqual(studio.creations, ["SBB"])
        track = studio.raw["library"]["tracks"]["100"]
        self.assertEqual(track["artist_id"], 5)
        self.assertEqual(track["artists_additional"], [
            {"artist_id": 2, "type": "artist", "phrase": None},
            {"artist_id": 3, "type": "composer", "phrase": None},
            {"artist_id": 4, "type": "artist", "phrase": "feat."}])
        library = Library(studio.raw)
        self.assertEqual(library.browse("track-artists", key="2")["album_ids"], ["10", "11"])
        self.assertEqual(library.browse("track-artists", key="4")["album_ids"], ["10"])
        self.assertEqual(library.search_tracks("Guest")["tracks"][0]["id"], "100")
        self.assertEqual(library.track_view(100)["performers"][1], {"id": "2", "name": "10cc"})
        self.assertEqual(library.stats()["track_artists"], 3)

    def test_composer_split_preserves_primary_and_unrelated_roles(self):
        studio = LocalStudio()
        studio.raw["library"]["tracks"]["100"]["artist_id"] = 0
        preview = studio.cleanup.prepare("composers")
        studio.cleanup.start(preview["id"], [])
        self.assertEqual(finished(studio)["counts"], {"confirmed": 1})
        track = studio.raw["library"]["tracks"]["100"]
        self.assertEqual(track["artist_id"], 0)
        self.assertEqual(studio.creations, ["Bach", "Handel"])
        self.assertEqual(track["artists_additional"][-1], {"artist_id": 4, "type": "artist", "phrase": "feat."})
        self.assertEqual(Library(studio.raw).track_view(100)["composers"], ["Bach", "Handel"])

    def test_conflict_or_moved_track_stops_before_writes(self):
        for field, value in (("genre", "Changed elsewhere"), ("album_id", 11), ("trashed", True)):
            with self.subTest(field=field):
                studio = LocalStudio()
                preview = studio.cleanup.prepare("genres")
                studio.raw["library"]["tracks"]["100"][field] = value
                studio.cleanup.start(preview["id"], [])
                self.assertEqual(finished(studio)["state"], "error")
                self.assertEqual(studio.writes, [])

    def test_error_stops_subsequent_batches_and_explicit_resume_rechecks(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        studio.fail = True
        with patch("tagcast.cleanup.BATCH_TRACKS", 1):
            studio.cleanup.start(preview["id"], [])
            self.assertEqual(finished(studio)["counts"], {"unconfirmed": 1, "pending": 1})
            self.assertEqual(len(studio.writes), 1)
            studio.fail = False
            studio.cleanup.start(preview["id"])
            self.assertEqual(finished(studio)["counts"], {"confirmed": 2})

    def test_lost_reply_is_checked_and_resume_never_resends_confirmed_tracks(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        studio.accept_then_fail = True
        studio.cleanup.start(preview["id"], [])
        self.assertEqual(finished(studio)["counts"], {"confirmed": 2})
        self.assertEqual(studio.cleanup.view()["state"], "error")
        studio.accept_then_fail = False
        studio.cleanup.start(preview["id"])
        self.assertEqual(finished(studio)["state"], "done")
        self.assertEqual(len(studio.writes), 1)

    def test_stop_allows_inflight_readback_then_resume_after_restart(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        studio.on_write = lambda: studio.cleanup.cancel(preview["id"])
        with patch("tagcast.cleanup.BATCH_TRACKS", 1):
            studio.cleanup.start(preview["id"], [])
            report = finished(studio)
        self.assertEqual(report["state"], "stopped")
        self.assertEqual(report["counts"], {"confirmed": 1, "pending": 1})
        restarted = LocalStudio(studio.raw, studio.store)
        restarted.cleanup.start(preview["id"])
        self.assertEqual(finished(restarted)["counts"], {"confirmed": 2})
        self.assertEqual(len(restarted.writes), 1)

    def test_unconfirmed_results_stop_even_without_api_error(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        studio.ignore = True
        studio.cleanup.start(preview["id"], [])
        self.assertEqual(finished(studio)["state"], "error")
        self.assertEqual(studio.cleanup.view()["counts"], {"unconfirmed": 2})

    def test_wrong_account_stale_token_and_overlapping_save_are_blocked(self):
        studio = LocalStudio()
        preview = studio.cleanup.prepare("genres")
        with self.assertRaises(LibraryError):
            studio.cleanup.start("wrong", [])
        studio.library_user = "other-owner"
        with self.assertRaises(LibraryError):
            studio.cleanup.view()
        with self.assertRaises(LibraryError):
            studio.cleanup.start(preview["id"], [])
        studio.library_user = "test-owner"
        studio.save_lock.acquire()
        with self.assertRaises(LibraryError):
            studio.cleanup.start(preview["id"], [])
        studio.save_lock.release()
        self.assertEqual(studio.writes, [])

    def test_normal_editor_still_refuses_cross_artist_saves(self):
        library = Library(data())
        changes = [{"kind": "track", "id": str(i), "albumId": str(a), "fields": {
            "genres": {"before": library.track_view(i)["genres"], "after": ["Pop"]}}}
            for i, a in [(100, 10), (101, 11)]]
        with self.assertRaisesRegex(LibraryError, "one album artist"):
            plan_save(library, changes)

    def test_no_split_for_already_separate_credits_and_genres(self):
        raw = data()
        track = raw["library"]["tracks"]["100"]
        track.update(artist_id=2, genre="Pop", genres_additional=["Rock"],
                     artists_additional=[{"artist_id": 4, "type": "artist"}])
        library = Library(raw)
        for category in ("genres", "track-artists", "composers"):
            self.assertIsNone(candidate(library, 100, category))
