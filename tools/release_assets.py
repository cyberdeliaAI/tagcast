"""Publish a draft only after all checked distributions and signing evidence exist."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from release_info import release_info
from update_metadata import update_metadata

TARGETS = {'macos-arm64': '.zip', 'macos-x64': '.zip',
           'windows-x64': '.zip', 'linux-x64': '.tar.gz', 'linux-amd64': '.deb',
           'windows-x64-setup': '.exe'}
SIGNING = ('developer_id', 'hardened_runtime', 'notarization_ticket', 'gatekeeper')
WINDOWS_PUBLISHERS = json.loads((Path(__file__).resolve().parent.parent /
                                 'electron/update-config.json').read_text())['publisherName']


def checked_assets(downloads, reports, version):
    expected = {f'tagcast-{version}-{target}{suffix}' for target, suffix in TARGETS.items()}
    expected |= {name + '.sha256' for name in tuple(expected)}
    paths = {path.name: path for path in downloads.iterdir()}
    feeds = {'latest.yml', 'latest-mac.yml', 'latest-linux.yml'}
    if set(paths) not in (expected, expected | feeds):
        raise ValueError('All platform archives, the Debian package, Windows installer and their checksums are required.')
    for name in set(paths) - expected:
        path = paths[name]
        if path.is_symlink() or not path.is_file():
            raise ValueError('Update feeds must be regular files.')
        if path.read_text('utf-8') != update_metadata(downloads, version)[name]:
            raise ValueError('An update feed does not match the checked packages.')
    paths = {name: paths[name] for name in expected}
    for name, path in paths.items():
        if path.is_symlink() or not path.is_file() or not path.stat().st_size:
            raise ValueError('Release assets must be nonempty regular files.')
        if name.endswith('.sha256'):
            continue
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if paths[name + '.sha256'].read_text('ascii').strip() != f'{digest}  {name}':
            raise ValueError('A release checksum does not match its archive.')
        if name.endswith('-windows-x64-setup.exe'):
            data = json.loads((reports / 'smoke-reports-windows-x64/windows-installer.json').read_text())
            if (any(data.get(key) is not True for key in ('installed_startup', 'restart', 'removed'))
                    or data.get('package') != name or data.get('version') != version
                    or data.get('sha256') != digest):
                raise ValueError('Windows installer evidence is missing or does not match the package.')
            if WINDOWS_PUBLISHERS and data.get('authenticode') is not True:
                raise ValueError('An enabled Windows updater requires verified installer signing.')
        if name.endswith('.deb'):
            for distribution in ('ubuntu-22.04', 'ubuntu-24.04'):
                data = json.loads((reports / f'deb-reports-{distribution}' / 'linux-deb.json').read_text())
                if (any(data.get(key) is not True for key in
                        ('installed_startup', 'sandbox', 'desktop_launcher', 'cli', 'removed'))
                        or data.get('package') != name or data.get('sha256') != digest
                        or data.get('version') != version or data.get('distribution') != distribution):
                    raise ValueError('Debian installation evidence is missing or does not match the package.')
        for target in ('macos-arm64', 'macos-x64'):
            if name == f'tagcast-{version}-{target}.zip':
                data = json.loads((reports / f'smoke-reports-{target}' / 'macos-signing.json').read_text())
                if (any(data.get(key) is not True for key in SIGNING)
                        or data.get('archive') != name or data.get('sha256') != digest):
                    raise ValueError('macOS signing evidence is missing or does not match the archive.')
    return [paths[name] for name in sorted(paths)]


def gh(*args):
    return json.loads(subprocess.check_output(['gh', *args], text=True))


def publish(tag, commit, downloads, reports, info):
    if tag != info['tag']:
        raise ValueError('Release tag does not match the checked-out application.')
    assets = checked_assets(downloads, reports, info['version'])
    fields = 'isDraft,targetCommitish,assets'
    release = gh('release', 'view', tag, '--json', fields)
    if not release['isDraft'] or release['targetCommitish'] != commit:
        raise ValueError('Only the draft for this exact tested commit can be published.')
    if release['assets']:
        raise ValueError('Draft already has assets; review it explicitly before replacing anything.')
    feeds = {} if info['prerelease'] else update_metadata(downloads, info['version'])
    for name, contents in feeds.items():
        path = downloads / name
        path.write_bytes(contents.encode('utf-8'))
        assets.append(path)
    subprocess.run(['gh', 'release', 'upload', tag, *(str(path) for path in assets)], check=True)
    uploaded = gh('release', 'view', tag, '--json', fields)
    actual = {item['name']: item['size'] for item in uploaded['assets']}
    if (actual != {path.name: path.stat().st_size for path in assets}
            or not uploaded['isDraft'] or uploaded['targetCommitish'] != commit):
        raise ValueError('Uploaded assets or draft target do not match; draft remains unpublished.')
    subprocess.run(['gh', 'release', 'edit', tag, '--draft=false',
                    '--latest=false' if info['prerelease'] else '--latest'], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--downloads', type=Path, default=Path('downloads'))
    parser.add_argument('--reports', type=Path, default=Path('reports'))
    args = parser.parse_args()
    publish(args.tag, args.commit, args.downloads, args.reports, release_info())


if __name__ == '__main__':
    main()
