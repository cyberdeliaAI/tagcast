"""Desktop ownership checks use real local HTTP with a display-independent UI."""

import json
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.request import urlopen

from tagcast import app, desktop


class Value:
    def __init__(self, master=None, value=None):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        handlers = set(logging.getLogger().handlers)

        def close_test_logs():
            for handler in set(logging.getLogger().handlers) - handlers:
                logging.getLogger().removeHandler(handler)
                handler.close()

        self.addCleanup(close_test_logs)
        env = patch.dict(os.environ, {"TAGCAST_HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)
        tk = types.ModuleType("tkinter")
        tk.StringVar = tk.BooleanVar = Value
        tk.ttk = types.ModuleType("tkinter.ttk")
        for name in ("Frame", "Label", "Button", "Checkbutton"):
            setattr(tk.ttk, name, MagicMock())
        modules = patch.dict(sys.modules, {"tkinter": tk, "tkinter.ttk": tk.ttk})
        modules.start()
        self.addCleanup(modules.stop)

    def status(self, port):
        with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as response:
            return json.load(response)

    def test_browser_defaults_on_and_remembers_toggles_without_touching_server_config(self):
        config = Path(self.home.name) / "config.json"
        config.write_text('{"auto_lookup": false, "custom": "keep"}', encoding="utf-8")
        before = config.read_bytes()
        with patch.object(desktop.webbrowser, "open") as browser:
            launcher = desktop.Desktop(MagicMock(), port=0)
            try:
                self.assertTrue(launcher.auto_open.get())
                browser.assert_called_once_with(launcher.url)
                browser.reset_mock()
                launcher.auto_open.set(False)
                launcher.save_browser_preference()
                browser.assert_not_called()
                self.assertEqual(json.loads(launcher.preferences_path.read_text()), {"open_browser": False})
                self.assertEqual(config.read_bytes(), before)
                second = desktop.Desktop(MagicMock(), port=launcher.port)
                try:
                    self.assertFalse(second.auto_open.get())
                    self.assertIsNone(second.server)
                    browser.assert_not_called()
                    second.open()
                    browser.assert_called_once_with(launcher.url)
                    browser.reset_mock()
                    second.auto_open.set(True)
                    second.save_browser_preference()
                    browser.assert_not_called()
                finally:
                    second.close()
                third = desktop.Desktop(MagicMock(), port=launcher.port)
                try:
                    browser.assert_called_once_with(launcher.url)
                    self.assertTrue(third.auto_open.get())
                finally:
                    third.close()
            finally:
                launcher.close()

    def test_disabled_browser_setting_also_applies_to_a_new_server(self):
        preferences = Path(self.home.name) / "launcher.json"
        preferences.write_text('{"open_browser": false}', encoding="utf-8")
        with patch.object(desktop.webbrowser, "open") as browser:
            launcher = desktop.Desktop(MagicMock(), port=0)
            try:
                self.assertTrue(launcher.ready)
                self.assertFalse(self.status(launcher.port)["connected"])
                browser.assert_not_called()
                launcher.open()
                browser.assert_called_once_with(launcher.url)
            finally:
                launcher.close()

    def test_invalid_or_missing_preferences_default_to_opening(self):
        preferences = Path(self.home.name) / "launcher.json"
        self.assertTrue(desktop.automatic_browser(preferences))
        for content in ('{', 'null', '[]', '{}', '{"open_browser": "false"}', '{"open_browser": 0}'):
            with self.subTest(content=content):
                preferences.write_text(content, encoding="utf-8")
                self.assertTrue(desktop.automatic_browser(preferences))

    def test_save_failure_keeps_preferences_and_server_and_reports_the_problem(self):
        launcher = desktop.Desktop(MagicMock(), port=0, open_browser=False)
        try:
            launcher.save_browser_preference()
            before = launcher.preferences_path.read_bytes()
            launcher.auto_open.set(False)
            with patch.object(desktop.os, "replace", side_effect=OSError("disk unavailable")), self.assertLogs(level="ERROR"):
                launcher.save_browser_preference()
            self.assertEqual(launcher.preferences_path.read_bytes(), before)
            self.assertIn("Could not remember", launcher.status.get())
            self.assertEqual(list(Path(self.home.name).glob("launcher-*.tmp")), [])
            self.assertFalse(self.status(launcher.port)["connected"])
            launcher.save_browser_preference()
            self.assertNotIn("Could not remember", launcher.status.get())
            self.assertFalse(desktop.automatic_browser(launcher.preferences_path))
        finally:
            launcher.close()

    def test_closing_stops_the_owned_server(self):
        root = MagicMock()
        launcher = desktop.Desktop(root, port=0, open_browser=False)
        worker = launcher.worker
        try:
            self.assertTrue(launcher.ready)
            self.assertFalse(self.status(launcher.port)["connected"])
            with patch.object(desktop.webbrowser, "open") as browser:
                launcher.open()
                browser.assert_called_once_with(launcher.url)
        finally:
            launcher.close()
        self.assertFalse(worker.is_alive())
        root.destroy.assert_called_once()
        with self.assertRaises(OSError):
            self.status(launcher.port)

    def test_closing_a_second_launcher_leaves_the_existing_server_running(self):
        first = desktop.Desktop(MagicMock(), port=0, open_browser=False)
        try:
            second = desktop.Desktop(MagicMock(), port=first.port, open_browser=False)
            self.assertTrue(second.ready)
            self.assertIsNone(second.server)
            second.close()
            self.assertFalse(self.status(first.port)["connected"])
            self.assertTrue(first.worker.is_alive())
        finally:
            first.close()

    def test_a_foreign_process_on_the_port_is_not_opened_or_stopped(self):
        server = app.Server(("127.0.0.1", 0), app.Handler)
        try:
            with patch.object(app, "_already_running", return_value=False), patch.object(desktop.webbrowser, "open") as browser:
                launcher = desktop.Desktop(MagicMock(), port=server.server_port)
                self.assertFalse(launcher.ready)
                self.assertIsNone(launcher.server)
                browser.assert_not_called()
                launcher.close()
            self.assertNotEqual(server.fileno(), -1)
        finally:
            server.server_close()
