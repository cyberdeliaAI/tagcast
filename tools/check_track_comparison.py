"""Check the packaged comparison against real Studio wiring and a disposable account."""

import json
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from check_shutdown import fixture, fixture_module
from ibroadcast.oauth import TokenSet


def check_track_comparison(executable, inherited, reports):
    mock = fixture_module()
    provider = fixture(mock, 'idle')
    worker = threading.Thread(target=provider.serve_forever, kwargs={'poll_interval': .05})
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix='tagcast comparison check ') as directory:
            root = Path(directory)
            settings, profile, report = root / 'settings', root / 'profile', root / 'report.json'
            settings.mkdir()
            profile.mkdir()
            (settings / 'config.json').write_text(json.dumps({'client_id': 'test',
                'auto_updates': False, 'auto_lookup': False, 'record_plays': False}))
            token = TokenSet(mock.TOKEN, 'synthetic-refresh', time.time() + 3600,
                             scope=['user.library:read'])
            (settings / 'tokens.json').write_text(json.dumps({'client_id': 'test', 'token_set': token.to_dict()}))
            env = {key: value for key, value in inherited.items() if not key.startswith('TAGCAST_')}
            env.pop('IBROADCAST_CLIENT_ID', None)
            env.pop('ELECTRON_RUN_AS_NODE', None)
            env.update(TAGCAST_HOME=str(settings), TAGCAST_ELECTRON_PROFILE=str(profile), TAGCAST_PORT='0',
                       TAGCAST_IBROADCAST_BASE=f'http://127.0.0.1:{provider.server_port}',
                       TAGCAST_TRACK_COMPARISON_SMOKE_REPORT=str(report))
            with (root / 'stderr.log').open('w') as stderr:
                process = subprocess.Popen([str(executable)], env=env, cwd=root,
                                           stdout=subprocess.DEVNULL, stderr=stderr)
                try:
                    result = process.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=15)
                    raise RuntimeError('The isolated track comparison check did not finish') from None
            data = json.loads(report.read_text()) if report.exists() else {'ok': False, 'error': 'Missing report'}
            data['synthetic_account_writes'] = len(mock.STATE['writes'])
            (reports / 'electron-track-comparison.json').write_text(json.dumps(data, indent=2) + '\n')
            if result or not data.get('ok') or mock.STATE['writes']:
                raise RuntimeError(f'Native track comparison failed: {data}')
            print('Checked native comparison: real Studio/HTTP guards, pointer/keyboard and no account writes')
    finally:
        provider.release.set()
        provider.shutdown()
        provider.server_close()
        worker.join(timeout=5)
