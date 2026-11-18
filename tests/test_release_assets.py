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

            if suffix == '.deb':
                for distribution in ('ubuntu-22.04', 'ubuntu-24.04'):
                    report = self.reports / f'deb-reports-{distribution}' / 'linux-deb.json'
                    report.parent.mkdir(parents=True)
                    report.write_text(json.dumps({
                        **dict.fromkeys(('installed_startup', 'sandbox', 'desktop_launcher', 'cli', 'removed'), True),
                        'package': path.name, 'sha256': digest, 'version': '1.2.1',
                        'distribution': distribution}))
            if suffix == '.exe':
                report = self.reports / 'smoke-reports-windows-x64/windows-installer.json'
                report.parent.mkdir(parents=True)
                report.write_text(json.dumps({'installed_startup': True, 'restart': True, 'removed': True,
                                              'package': path.name, 'version': '1.2.1', 'sha256': digest}))

    def test_debian_package_requires_matching_installation_evidence_on_both_distributions(self):
        for distribution in ('ubuntu-22.04', 'ubuntu-24.04'):
            report = self.reports / f'deb-reports-{distribution}' / 'linux-deb.json'
            saved = report.read_text()
            for key in ('installed_startup', 'sandbox', 'desktop_launcher', 'cli', 'removed',
                        'package', 'sha256', 'version', 'distribution', 'missing'):
                with self.subTest(distribution=distribution, key=key):
                    data = json.loads(saved)
                    if key == 'missing':
                        report.unlink()
                    else:
                        data[key] = False
                        report.write_text(json.dumps(data))
                    with patch.object(assets, 'gh') as gh, patch.object(assets.subprocess, 'run') as run:
                        with self.assertRaises((ValueError, FileNotFoundError)):
                            self.invoke()
                        gh.assert_not_called()
                        run.assert_not_called()
                    report.write_text(saved)

    def invoke(self):
        assets.publish('v1.2.1', 'tested-commit', self.downloads, self.reports, self.info)

    def release(self, **kwargs):
        return {'isDraft': True, 'targetCommitish': 'tested-commit', 'assets': [], **kwargs}

    def test_complete_checked_assets_are_uploaded_before_publication(self):
        names = [{'name': p.name, 'size': p.stat().st_size} for p in self.downloads.iterdir()]
        names.extend({'name': name, 'size': len(text.encode())}
                     for name, text in assets.update_metadata(self.downloads, '1.2.1').items())
        with patch.object(assets, 'gh', side_effect=[self.release(), self.release(assets=names)]), \
                patch.object(assets.subprocess, 'run') as run:
            self.invoke()
        self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(run.call_args_list[0].args[0][:3], ['gh', 'release', 'upload'])
        self.assertEqual(len(run.call_args_list[0].args[0][4:]), 15)
        self.assertIn('--draft=false', run.call_args_list[1].args[0])
        self.assertNotIn('--clobber', str(run.call_args_list))
        for name, text in assets.update_metadata(self.downloads, '1.2.1').items():
            self.assertEqual((self.downloads / name).read_bytes(), text.encode('utf-8'))

    def test_update_feeds_bind_both_macos_architectures_and_the_installer_to_actual_bytes(self):
        import base64
        feeds = assets.update_metadata(self.downloads, '1.2.1')
        self.assertEqual(set(feeds), {'latest.yml', 'latest-mac.yml', 'latest-linux.yml'})
        for text in feeds.values():
            data = json.loads(text)
            self.assertEqual(data['version'], '1.2.1')
            for entry in data['files']:
                raw = (self.downloads / entry['url']).read_bytes()
                self.assertEqual(entry['size'], len(raw))
                self.assertEqual(entry['sha512'], base64.b64encode(hashlib.sha512(raw).digest()).decode())
        self.assertEqual(len(json.loads(feeds['latest-mac.yml'])['files']), 2)
        self.assertTrue(json.loads(feeds['latest.yml'])['files'][0]['url'].endswith('-setup.exe'))

    def test_windows_installer_requires_matching_install_and_restart_evidence(self):
        report = self.reports / 'smoke-reports-windows-x64/windows-installer.json'
        saved = report.read_text()
        for key in ('installed_startup', 'restart', 'removed', 'package', 'version', 'sha256'):
            with self.subTest(key=key):
                data = json.loads(saved)
                data[key] = False
                report.write_text(json.dumps(data))
                with patch.object(assets, 'gh') as gh:
                    with self.assertRaises(ValueError):
                        self.invoke()
                    gh.assert_not_called()
                report.write_text(saved)

    def test_enabling_windows_updates_requires_verified_signing_before_any_publication(self):
        report = self.reports / 'smoke-reports-windows-x64/windows-installer.json'
        data = json.loads(report.read_text())
        for signed in (None, False, True):
            with self.subTest(signed=signed):
                data['authenticode'] = signed
                report.write_text(json.dumps(data))
                with patch.object(assets, 'WINDOWS_PUBLISHERS', ['Trusted Publisher']), \
                        patch.object(assets, 'gh') as gh:
                    if signed is True:
                        self.assertEqual(len(assets.checked_assets(self.downloads, self.reports, '1.2.1')), 12)
                    else:
                        with self.assertRaisesRegex(ValueError, 'verified installer signing'):
                            self.invoke()
                    gh.assert_not_called()

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
