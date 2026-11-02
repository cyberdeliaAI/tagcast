"""Publish a draft only after all checked distributions and signing evidence exist."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from release_info import release_info

TARGETS = {'macos-arm64': '.zip', 'macos-x64': '.zip',
           'windows-x64': '.zip', 'linux-x64': '.tar.gz'}
SIGNING = ('developer_id', 'hardened_runtime', 'notarization_ticket', 'gatekeeper')


def checked_assets(downloads, reports, version):
    expected = {f'tagcast-{version}-{target}{suffix}' for target, suffix in TARGETS.items()}
    expected |= {name + '.sha256' for name in tuple(expected)}
    paths = {path.name: path for path in downloads.iterdir()}
    if set(paths) != expected:
        raise ValueError('The complete four-platform distribution and checksum set is required.')
    for name, path in paths.items():
        if path.is_symlink() or not path.is_file() or not path.stat().st_size:
            raise ValueError('Release assets must be nonempty regular files.')
        if name.endswith('.sha256'):
            continue
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if paths[name + '.sha256'].read_text('ascii').strip() != f'{digest}  {name}':
            raise ValueError('A release checksum does not match its archive.')
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
