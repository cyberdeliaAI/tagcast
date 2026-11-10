"""Only the disposable local chooser can be terminated; never the backend."""

import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

from tagcast import download_engine


class ShutdownPickerTests(unittest.TestCase):
    def test_cancel_ends_and_reaps_real_chooser_process(self):
        cancel, started = threading.Event(), threading.Event()
        children, result = [], []
        popen = subprocess.Popen
        def spawn(*_args, **kwargs):
            process = popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
            children.append(process)
            started.set()
            return process
        with patch.object(download_engine.sys, "platform", "darwin"), \
                patch.object(download_engine.subprocess, "Popen", spawn):
            worker = threading.Thread(target=lambda: result.append(download_engine.choose_folder("/tmp", cancel)))
            worker.start()
            try:
                self.assertTrue(started.wait(3))
                cancel.set()
                worker.join(timeout=3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(result, [""])
                self.assertIsNotNone(children[0].poll())
            finally:
                cancel.set()
                worker.join(timeout=3)

    def test_platform_chooser_commands_and_normal_selection_stay_intact(self):
        for platform, os_name, available, command in (("darwin", "posix", None, "osascript"),
                ("win32", "nt", None, "powershell"), ("linux", "posix", "/bin/zenity", "zenity"),
                ("linux", "posix", None, None)):
            with self.subTest(platform=platform, available=available), \
                    patch.object(download_engine.sys, "platform", platform), \
                    patch.object(download_engine.os, "name", os_name), \
                    patch.object(download_engine.shutil, "which", return_value=available), \
                    patch.object(download_engine.subprocess, "Popen") as popen:
                popen.return_value.communicate.return_value = ("/selected/folder\n", "")
                popen.return_value.returncode = 0
                result = download_engine.choose_folder("/tmp")
                if command:
                    self.assertEqual(result, "/selected/folder")
                    self.assertEqual(popen.call_args.args[0][0], command)
                    popen.return_value.terminate.assert_not_called()
                else:
                    self.assertIsNone(result)
                    popen.assert_not_called()
