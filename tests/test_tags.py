"""Tag API contracts and conservative writes using an in-memory library only."""

import copy
import json
import threading
import unittest
from unittest.mock import patch

import requests
from test_duplicate_cleanup import library_data

from tagcast.client import ApiError, StudioClient
from tagcast.library import ConflictError, Library, LibraryError
from tagcast.tags import Tags


class TagStudio:
    def __init__(self):
        self.raw = library_data(2, 2)
        self.raw["library"]["tags"] = {
            "10": {"name": "Listen later", "archived": False, "tracks": [10002, 10003, 20002, 99999], "private_key": "never-cache"},
            "20": {"name": "Weekend", "archived": False, "tracks": []},
            "30": {"name": "Hidden", "archived": True, "tracks": [10004]},
        }
        self.library_user = "owner"
        self.playback_session = "tag-session"
        self.client = self
        self.save_lock = threading.Lock()
        self.downloads = 0
        self.writes = []
        self.jobs = {}
        self.tags = Tags(self)
        self.ignore = self.fail = self.accept_then_fail = self.omit_id = False
        self.on_write = None

    def _require_client(self):
        if not self.client:
            raise LibraryError("Disconnected")
        return self.client

    def _current(self, client, **kwargs):
        return Library(copy.deepcopy(self.raw)), "memory"

    def _check_later(self, client, written, check, include_albums=True):
        self.jobs["tag-job"] = {"state": "done", "results": check(Library(copy.deepcopy(self.raw)))}
        assert not include_albums
        return "tag-job"

    def _jsonrequest(self, mode, **body):
        self.writes.append((mode, copy.deepcopy(body)))
        if self.fail:
            raise LibraryError("Lost reply")
        tags = self.raw["library"]["tags"]
        result = {"result": True}
        if not self.ignore:
            if mode == "createtag":
                tags["40"] = {"name": body["tagname"], "tracks": [], "archived": False}
                if not self.omit_id:
                    result["id"] = 40
            elif mode == "tagtracks":
                row = tags[str(body["tagid"])]
                members = set(row["tracks"])
                row["tracks"] = sorted(members - set(body["tracks"]) if body["untag"] else members | set(body["tracks"]))
            elif mode == "updatetag":
                tags[str(body["tag_id"])]["name"] = body["name"]
            elif mode == "deletetags":
                for i in body["tags"]:
                    del tags[str(i)]
            else:
                raise AssertionError(mode)
        if self.on_write:
            self.on_write()
        if self.accept_then_fail:
            raise LibraryError("Lost reply after acceptance")
        return result


class TagTests(unittest.TestCase):
    def setUp(self):
        self.studio = TagStudio()
        self.tags = self.studio.tags

    def assignment(self, changes, track=None, albums=None, multiple=False):
        selection = self.tags.selection(albums or ["1"], track, multiple)
        return {"approved": True, "action": "change", "target": selection["target"], "before": selection["before"],
                "changes": [{"id": str(i), "action": action, "before": self.tags.catalogue(tag_id=str(i))["before"]}
                            for i, action in changes]}

    def test_cache_keeps_only_tag_fields_and_marks_old_caches_unloaded(self):
        library = Library(self.studio.raw)
        cache = library.to_cache()
        self.assertNotIn("never-cache", json.dumps(cache))
        self.assertEqual(set(cache["library"]["tags"]["10"]), {"name", "tracks", "archived"})
        self.assertTrue(Library(cache).tags_loaded)
        del cache["library"]["tags"]
        self.assertFalse(Library(cache).tags_loaded)
        self.assertFalse(Library(cache).album_view(1)["tags_loaded"])
        self.assertNotIn("tags", Library(cache).to_cache()["library"])

    def test_browse_and_album_details_keep_tags_separate_from_genres_and_include_empty_tags(self):
        library = Library(self.studio.raw)
        groups = library.browse("tags")
        self.assertEqual(groups["total"], 3)
        self.assertEqual(library.browse("tags", "10")["album_ids"], ["1", "2"])
        self.assertEqual(library.browse("tags", "20")["album_ids"], [])
        hidden = library.browse("tags", "30")["group"]
        self.assertTrue(hidden["archived"])
        track = library.track_view(10002)
        self.assertEqual(track["genres"], [])
        self.assertEqual(track["tags"], [{"id": "10", "name": "Listen later", "archived": False}])

    def test_merged_discs_count_once_and_partial_sets_cannot_be_tagged(self):
        self.studio.raw["library"]["albums"]["2"].update(name="Album 1", disc=2)
        library = Library(self.studio.raw)
        self.assertEqual(library.browse("tags", "10")["group"]["albums"], 1)
        with self.assertRaises(LibraryError):
            self.tags.selection(["1"])
        self.assertEqual(self.tags.selection(["1", "2"])["tracks"], 8)

    def test_catalogue_paginates_and_never_sends_tag_track_lists(self):
        for i in range(100, 160):
            self.studio.raw["library"]["tags"][str(i)] = {"name": f"Tag {i}", "tracks": [], "archived": False}
        first = self.tags.catalogue("tag")
        second = self.tags.catalogue("tag", "50")
        self.assertEqual((len(first["tags"]), len(second["tags"]), first["total"]), (50, 10, 60))
        self.assertTrue(all(isinstance(t["tracks"], int) and "private_key" not in t for t in first["tags"]))
        selection = self.tags.selection(["1"])
        self.assertEqual(selection["tracks"], 4)
        self.assertEqual({t["id"]: t["selected"] for t in selection["tags"]}, {"10": 2, "30": 1})
        self.assertEqual(self.studio.writes, [])

    def test_reviewed_assignment_preserves_outside_and_untouched_partial_tags(self):
        before_tracks = copy.deepcopy(self.studio.raw["library"]["tracks"])
        self.tags.save(self.assignment([(10, "add"), (20, "add")]))
        self.assertEqual(self.studio.writes, [
            ("tagtracks", {"tagid": 10, "tracks": [10004, 10005], "untag": False}),
            ("tagtracks", {"tagid": 20, "tracks": [10002, 10003, 10004, 10005], "untag": False})])
        self.assertEqual(self.studio.raw["library"]["tags"]["10"]["tracks"], [10002, 10003, 10004, 10005, 20002, 99999])
        self.assertEqual(self.studio.raw["library"]["tags"]["30"]["tracks"], [10004])
        self.assertEqual(self.studio.raw["library"]["tracks"], before_tracks)
        self.assertEqual([r["status"] for r in self.studio.jobs["tag-job"]["results"]], ["saved", "saved"])

    def test_track_removal_never_replaces_other_memberships(self):
        self.tags.save(self.assignment([(10, "remove")], "10002"))
        self.assertEqual(self.studio.writes, [("tagtracks", {"tagid": 10, "tracks": [10002], "untag": True})])
        self.assertEqual(self.studio.raw["library"]["tags"]["10"]["tracks"], [10003, 20002, 99999])

    def test_approval_stale_memberships_labels_tracks_and_accounts_block_all_writes(self):
        for mutate in (lambda b: b.update(approved=False), lambda b: b.update(before="old"),
                       lambda b: b["changes"][0].update(before="old"),
                       lambda b: b["changes"].append(b["changes"][0]),
                       lambda b: b["target"].update(track="20002")):
            body = self.assignment([(10, "add")])
            mutate(body)
            with self.assertRaises(LibraryError):
                self.tags.save(body)
        body = self.assignment([(10, "add")])
        self.studio.library_user = "another-account"
        with self.assertRaises(ConflictError):
            self.tags.save(body)
        self.studio.library_user = "owner"
        self.studio.raw["library"]["tags"]["10"]["tracks"].append(10004)
        with self.assertRaises(ConflictError):
            self.tags.save(body)
        self.assertEqual(self.studio.writes, [])

    def test_added_or_removed_album_tracks_invalidate_review(self):
        body = self.assignment([(20, "add")])
        self.studio.raw["library"]["albums"]["1"]["tracks"].pop()
        with self.assertRaises(ConflictError):
            self.tags.save(body)
        self.assertEqual(self.studio.writes, [])

    def test_archived_tags_cannot_be_assigned_but_can_be_explicitly_removed(self):
        with self.assertRaisesRegex(LibraryError, "hide music"):
            self.tags.save(self.assignment([(30, "add")]))
        self.assertEqual(self.studio.writes, [])
        self.tags.save(self.assignment([(30, "remove")]))
        self.assertEqual(self.studio.writes, [("tagtracks", {"tagid": 30, "tracks": [10004], "untag": True})])

    def test_create_rename_and_delete_use_documented_payloads_without_touching_music(self):
        original = copy.deepcopy(self.studio.raw["library"]["tracks"])
        self.tags.save({"approved": True, "action": "create", "name": "A; B"})
        row = self.tags.catalogue(tag_id="40")
        self.tags.save({"approved": True, "action": "rename", "id": "40", "before": row["before"], "name": "New label"})
        row = self.tags.catalogue(tag_id="40")
        self.tags.save({"approved": True, "action": "delete", "id": "40", "before": row["before"]})
        self.assertEqual(self.studio.writes, [("createtag", {"tagname": "A; B"}),
            ("updatetag", {"tag_id": 40, "name": "New label"}), ("deletetags", {"tags": [40]})])
        self.assertEqual(self.studio.raw["library"]["tracks"], original)

    def test_global_tag_review_rejects_changed_outside_membership(self):
        row = self.tags.catalogue(tag_id="10")
        self.studio.raw["library"]["tags"]["10"]["tracks"].append(20003)
        for action in ("rename", "delete"):
            with self.assertRaises(ConflictError):
                self.tags.save({"approved": True, "action": action, "id": "10", "name": "Changed", "before": row["before"]})
        self.assertEqual(self.studio.writes, [])

    def test_invalid_names_duplicates_batch_bounds_and_shared_save_lock(self):
        for name in ("", "x" * 201, "Line\nbreak", "weekend"):
            with self.assertRaises(LibraryError):
                self.tags.save({"approved": True, "action": "create", "name": name})
        body = self.assignment([(20, "add")])
        body["changes"] *= 21
        with self.assertRaises(LibraryError):
            self.tags.save(body)
        self.studio.save_lock.acquire()
        try:
            with self.assertRaises(LibraryError):
                self.tags.save(self.assignment([(10, "remove")]))
        finally:
            self.studio.save_lock.release()
        self.assertEqual(self.studio.writes, [])

    def test_unknown_create_result_and_ambiguous_failure_are_never_retried(self):
        self.studio.omit_id = True
        result = self.tags.save({"approved": True, "action": "create", "name": "Fresh"})
        self.assertIn("could not be confirmed", result["error"])
        self.assertEqual(len(self.studio.writes), 1)
        self.studio.fail = True
        result = self.tags.save(self.assignment([(10, "add"), (20, "add")]))
        self.assertTrue(result["error"])
        self.assertEqual(len(self.studio.writes), 2)
        self.assertEqual([r["status"] for r in self.studio.jobs["tag-job"]["results"]], ["unverified", "not_sent"])

    def test_readback_distinguishes_unconfirmed_and_accepted_lost_reply(self):
        self.studio.ignore = True
        self.tags.save(self.assignment([(10, "add")]))
        self.assertEqual(self.studio.jobs["tag-job"]["results"][0]["status"], "unverified")
        self.studio.ignore = False
        self.studio.accept_then_fail = True
        result = self.tags.save(self.assignment([(10, "add"), (20, "add")]))
        self.assertTrue(result["error"])
        self.assertEqual([r["status"] for r in self.studio.jobs["tag-job"]["results"]], ["saved", "not_sent"])

    def test_tag_transport_never_retries_ambiguous_writes(self):
        transport = StudioClient()
        with patch.object(transport, "_auth_headers", return_value={}), patch("tagcast.client.time.sleep"):
            for mode in ("createtag", "updatetag", "deletetags", "tagtracks"):
                with self.subTest(mode=mode), patch("tagcast.client.requests.post", side_effect=requests.Timeout) as post:
                    with self.assertRaises(ApiError):
                        transport._post("https://api.ibroadcast.com", {"mode": mode})
                    self.assertEqual(post.call_count, 1)

    def test_old_cache_fetches_tags_once_before_browsing_or_writing(self):
        original = self.studio._current
        reads = []

        def current(client, refresh=False):
            reads.append(refresh)
            if not refresh:
                raw = copy.deepcopy(self.studio.raw)
                del raw["library"]["tags"]
                return Library(raw), "cache"
            return original(client)

        self.studio._current = current
        self.assertEqual(self.tags.catalogue()["total"], 3)
        self.assertEqual(reads, [False, True])
        self.assertEqual(self.studio.writes, [])

    def test_multiple_albums_require_explicit_scope_and_show_complete_compact_summaries(self):
        with self.assertRaises(LibraryError):
            self.tags.selection(["1", "2"])
        selected = self.tags.selection(["1", "2"], multiple=True)
        self.assertEqual(selected["target"], {"albums": ["1", "2"], "track": None, "multiple": True})
        self.assertEqual((selected["label"], selected["tracks"]), ("2 selected albums", 8))
        self.assertEqual(selected["albums"], [
            {"ids": ["1"], "name": "Album 1", "artist": "Artist", "tracks": 4},
            {"ids": ["2"], "name": "Album 2", "artist": "Artist", "tracks": 4}])
        self.assertEqual({t["id"]: t["selected"] for t in selected["tags"]}, {"10": 3, "30": 1})
        self.assertEqual(self.studio.writes, [])

    def test_multi_album_tagging_preserves_other_albums_genres_and_partial_tags(self):
        extra = library_data(3, 2)["library"]
        self.studio.raw["library"]["albums"]["3"] = extra["albums"]["3"]
        self.studio.raw["library"]["tracks"].update({k: v for k, v in extra["tracks"].items() if k.startswith("3")})
        self.studio.raw["library"]["artists"]["2"] = {"name": "Another artist"}
        self.studio.raw["library"]["albums"]["2"]["artist_id"] = 2
        before = copy.deepcopy(self.studio.raw["library"]["tracks"])
        self.tags.save(self.assignment([(20, "add")], albums=["1", "2"], multiple=True))
        chosen = [10002, 10003, 10004, 10005, 20002, 20003, 20004, 20005]
        self.assertEqual(self.studio.writes, [("tagtracks", {"tagid": 20, "tracks": chosen, "untag": False})])
        self.assertEqual(self.studio.raw["library"]["tags"]["10"]["tracks"], [10002, 10003, 20002, 99999])
        self.assertEqual(self.studio.raw["library"]["tags"]["30"]["tracks"], [10004])
        self.assertEqual(self.studio.raw["library"]["tracks"], before)
        self.assertEqual(self.studio.jobs["tag-job"]["results"], [{"id": "20", "status": "saved"}])
        self.tags.save(self.assignment([(10, "remove")], albums=["1", "2"], multiple=True))
        self.assertEqual(self.studio.raw["library"]["tags"]["10"]["tracks"], [99999])

    def test_multi_album_review_blocks_changed_membership_names_session_account_and_mode(self):
        mutations = [
            lambda: self.studio.raw["library"]["albums"]["2"].update(name="Renamed"),
            lambda: self.studio.raw["library"]["tracks"]["20002"].update(title="Renamed track"),
            lambda: self.studio.raw["library"]["albums"]["2"]["tracks"].pop(),
            lambda: self.studio.raw.update(combine_sets=True),
            lambda: setattr(self.studio, "playback_session", "another-session"),
            lambda: setattr(self.studio, "library_user", "another-account"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp()
                body = self.assignment([(20, "add")], albums=["1", "2"], multiple=True)
                mutate()
                with self.assertRaises(LibraryError):
                    self.tags.save(body)
                self.assertEqual(self.studio.writes, [])
        self.setUp()
        body = self.assignment([(20, "add")], multiple=True)
        body["target"]["multiple"] = False
        with self.assertRaises(ConflictError):
            self.tags.save(body)
        self.assertEqual(self.studio.writes, [])

    def test_multi_album_scope_keeps_discs_together_and_detects_regrouped_sets(self):
        third = library_data(3, 1)["library"]
        self.studio.raw["library"]["albums"]["3"] = third["albums"]["3"]
        self.studio.raw["library"]["tracks"].update({k: v for k, v in third["tracks"].items() if k.startswith("3")})
        self.studio.raw["library"]["albums"]["2"].update(name="Album 1", disc=2)
        with self.assertRaises(LibraryError):
            self.tags.selection(["1", "3"], multiple=True)
        selected = self.tags.selection(["1", "2", "3"], multiple=True)
        self.assertEqual((selected["label"], selected["tracks"]), ("2 selected albums", 10))
        self.assertEqual(selected["albums"][0]["ids"], ["1", "2"])
        body = self.assignment([(20, "add")], albums=["1", "2", "3"], multiple=True)
        self.studio.raw["library"]["albums"]["2"]["year"] = 2000
        with self.assertRaises(ConflictError):
            self.tags.save(body)
        self.assertEqual(self.studio.writes, [])

    def test_multi_album_bounds_and_invalid_modes_never_write(self):
        tags = self.studio.raw["library"]["tags"]
        self.studio.raw = library_data(21, 1)
        self.studio.raw["library"]["tags"] = tags
        self.assertEqual(self.tags.selection([str(i) for i in range(1, 21)], multiple=True)["tracks"], 40)
        with self.assertRaisesRegex(LibraryError, "20 displayed"):
            self.tags.selection([str(i) for i in range(1, 22)], multiple=True)
        for mode in (1, None, "true", [], {}):
            with self.subTest(mode=mode), self.assertRaises(LibraryError):
                self.tags.selection(["1"], multiple=mode)
        for albums, track in ((["1", "1"], None), (["1", "2"], "10002"), ([str(i) for i in range(1, 102)], None)):
            with self.subTest(albums=albums, track=track), self.assertRaises(LibraryError):
                self.tags.selection(albums, track, multiple=True)
        for count, allowed in ((250, True), (251, False)):
            self.studio.raw = library_data(1, count)
            self.studio.raw["library"]["tags"] = tags
            if allowed:
                self.assertEqual(self.tags.selection(["1"], multiple=True)["tracks"], 500)
            else:
                with patch.object(Library, "album_view", side_effect=AssertionError("No oversized detail views")):
                    with self.assertRaisesRegex(LibraryError, "500 tracks"):
                        self.tags.selection(["1"], multiple=True)
        self.assertEqual(self.studio.writes, [])

    def test_new_tag_is_confirmed_empty_before_explicit_multi_album_assignment(self):
        self.tags.save({"approved": True, "action": "create", "name": "Together"})
        self.assertEqual(self.studio.raw["library"]["tags"]["40"]["tracks"], [])
        self.assertEqual(len(self.studio.writes), 1)
        self.tags.save(self.assignment([(40, "add")], albums=["1", "2"], multiple=True))
        self.assertEqual(len(self.studio.raw["library"]["tags"]["40"]["tracks"]), 8)
        self.assertEqual([mode for mode, body in self.studio.writes], ["createtag", "tagtracks"])

    def test_multi_album_archived_and_uncertain_writes_keep_existing_safeguards(self):
        with self.assertRaisesRegex(LibraryError, "hide music"):
            self.tags.save(self.assignment([(30, "add")], albums=["1", "2"], multiple=True))
        self.assertEqual(self.studio.writes, [])
        self.studio.accept_then_fail = True
        result = self.tags.save(self.assignment([(20, "add"), (10, "add")], albums=["1", "2"], multiple=True))
        self.assertTrue(result["error"])
        self.assertEqual(len(self.studio.writes), 1)
        self.assertEqual([r["status"] for r in self.studio.jobs["tag-job"]["results"]], ["saved", "not_sent"])
