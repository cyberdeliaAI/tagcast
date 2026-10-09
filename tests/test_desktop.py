"""Desktop ownership checks use real local HTTP with a display-independent UI."""

import json
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch
from urllib.request import urlopen

from tagcast import app, desktop


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = patch.dict(os.environ, {"TAGCAST_HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)
        tk = types.ModuleType("tkinter")
        tk.StringVar = MagicMock()
        tk.ttk = types.ModuleType("tkinter.ttk")
        for name in ("Frame", "Label", "Button"):
            setattr(tk.ttk, name, MagicMock())
        modules = patch.dict(sys.modules, {"tkinter": tk, "tkinter.ttk": tk.ttk})
        modules.start()
        self.addCleanup(modules.stop)

    def status(self, port):
        with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as response:
            return json.load(response)

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
