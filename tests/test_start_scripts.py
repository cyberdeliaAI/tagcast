"""Exercise fallback startup in a disposable directory, without installing packages."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent.parent


@unittest.skipIf(os.name == "nt", "POSIX launcher; Windows startup is checked in CI")
class StartScriptTests(unittest.TestCase):
    def test_fallback_rebuilds_a_broken_interpreter_but_reuses_a_working_one(self):
        for broken in (False, True):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                shutil.copy(ROOT / "start-tagcast.sh", home)
                binary = home / "bin"
                binary.mkdir()
                venv = home / ".venv" / "bin"
                venv.mkdir(parents=True)
                log = home / "calls"
                python = binary / "python3"
                python.write_text("""#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$START_TEST_LOG"
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  cat > .venv/bin/python <<'SH'
#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$START_TEST_LOG"
SH
  chmod +x .venv/bin/python
fi
""", encoding="utf-8")
                python.chmod(0o755)
                entrypoint = venv / "tagcast"
                entrypoint.write_text('#!/bin/sh\nprintf "usage: tagcast %s\\n" "$*"\n', encoding="utf-8")
                entrypoint.chmod(0o755)
                if broken:
                    (venv / "python").symlink_to(home / "missing-python")
                else:
                    (venv / "python").symlink_to(python)
                env = {**os.environ, "TAGCAST_NO_UV": "1", "START_TEST_LOG": str(log),
                       "PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}
                result = subprocess.run(["sh", str(home / "start-tagcast.sh"), "--help"],
                                        env=env, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("usage: tagcast --open --help", result.stdout)
                calls = log.read_text(encoding="utf-8") if log.exists() else ""
                if broken:
                    self.assertIn("-m venv --clear .venv", calls)
                    self.assertIn("-m pip install --quiet -e .", calls)
                else:
                    self.assertEqual(calls, "")
