"""Private rotating log files, tested only in a disposable settings directory."""

import logging
import os
import stat
import tempfile
import unittest
from pathlib import Path

from tagcast.app import _log_to_file


@unittest.skipIf(os.name == 'nt', 'POSIX mode assertions do not establish Windows ACLs')
class LoggingPrivacyTests(unittest.TestCase):
    def test_new_settings_directory_and_every_rotated_log_are_private(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / 'settings'
            logger = logging.getLogger()
            before = set(logger.handlers)
            mask = os.umask(0o022)
            try:
                _log_to_file(home)
                handlers = set(logger.handlers) - before
                self.assertEqual(len(handlers), 1)
                handler = handlers.pop()
                handler.maxBytes = 32
                for i in range(4):
                    handler.handle(logging.LogRecord('test', logging.WARNING, '', 0,
                                                      f'Synthetic private title {i}', (), None))
                for file in home.glob('tagcast.log*'):
                    self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600, file.name)
                self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o700)
            finally:
                os.umask(mask)
                for handler in set(logger.handlers) - before:
                    logger.removeHandler(handler)
                    handler.close()
