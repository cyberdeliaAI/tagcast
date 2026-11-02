"""Release publication is tested with synthetic bytes and a mocked gh CLI only."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))
import release_assets as assets  # noqa: E402


class ReleaseAssetsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.downloads, self.reports = self.root / 'downloads', self.root / 'reports'
        self.downloads.mkdir()
        self.info = {'tag': 'v1.2.1', 'version': '1.2.1', 'prerelease': False}
        for target, suffix in assets.TARGETS.items():
            path = self.downloads / f'tagcast-1.2.1-{target}{suffix}'
            path.write_bytes(b'isolated build fixture ' + target.encode())
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            path.with_name(path.name + '.sha256').write_text(f'{digest}  {path.name}\n')
            if target.startswith('macos'):
                report = self.reports / f'smoke-reports-{target}' / 'macos-signing.json'
                report.parent.mkdir(parents=True)
                report.write_text(json.dumps({**dict.fromkeys(assets.SIGNING, True),
                                              'archive': path.name, 'sha256': digest}))

    def invoke(self):
        assets.publish('v1.2.1', 'tested-commit', self.downloads, self.reports, self.info)

    def release(self, **kwargs):
        return {'isDraft': True, 'targetCommitish': 'tested-commit', 'assets': [], **kwargs}

    def test_complete_checked_assets_are_uploaded_before_publication(self):
        names = [{'name': p.name, 'size': p.stat().st_size} for p in self.downloads.iterdir()]
        with patch.object(assets, 'gh', side_effect=[self.release(), self.release(assets=names)]), \
                patch.object(assets.subprocess, 'run') as run:
            self.invoke()
        self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(run.call_args_list[0].args[0][:3], ['gh', 'release', 'upload'])
        self.assertEqual(len(run.call_args_list[0].args[0][4:]), 8)
        self.assertIn('--draft=false', run.call_args_list[1].args[0])
        self.assertNotIn('--clobber', str(run.call_args_list))

    def test_missing_changed_extra_and_unsigned_assets_block_all_network_actions(self):
        path = self.downloads / 'tagcast-1.2.1-macos-arm64.zip'
        old = path.read_bytes()
        for mode in ('missing', 'checksum', 'extra', 'unsigned', 'other-archive'):
            with self.subTest(mode=mode):
                extra = self.downloads / 'unexpected.zip'
                report = self.reports / 'smoke-reports-macos-arm64/macos-signing.json'
                saved = report.read_text()
                if mode == 'missing':
                    path.unlink()
                elif mode == 'checksum':
                    path.write_bytes(b'changed')
                elif mode == 'extra':
                    extra.write_bytes(b'extra')
                else:
                    data = json.loads(saved)
                    data['developer_id' if mode == 'unsigned' else 'sha256'] = False
                    report.write_text(json.dumps(data))
                with patch.object(assets, 'gh') as gh, patch.object(assets.subprocess, 'run') as run:
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        self.invoke()
                    gh.assert_not_called()
                    run.assert_not_called()
                path.write_bytes(old)
                extra.unlink(missing_ok=True)
                report.write_text(saved)

    def test_public_existing_and_wrong_target_releases_cannot_be_overwritten(self):
        for change in ({'isDraft': False}, {'targetCommitish': 'other'}, {'assets': [{'name': 'existing'}]}):
            with self.subTest(change=change), patch.object(assets, 'gh', return_value=self.release(**change)), \
                    patch.object(assets.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    self.invoke()
                run.assert_not_called()

    def test_failed_upload_or_incomplete_remote_assets_never_publish(self):
        with patch.object(assets, 'gh', return_value=self.release()), \
                patch.object(assets.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'gh')) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                self.invoke()
            self.assertEqual(run.call_count, 1)
        with patch.object(assets, 'gh', side_effect=[self.release(), self.release(assets=[])]), \
                patch.object(assets.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                self.invoke()
            self.assertEqual(run.call_count, 1)
