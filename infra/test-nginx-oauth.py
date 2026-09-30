#!/usr/bin/env python3
"""Validate candidate nginx in an isolated local container with synthetic OAuth/webhook markers only.
Uses an already installed nginx:1.27-alpine image; no production requests or logs.
"""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'nginx:1.27-alpine'
NAME = 'chaggu-nginx-oauth-review-' + uuid.uuid4().hex[:8]


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


with tempfile.TemporaryDirectory(prefix='chaggu-nginx-oauth-') as temporary:
    base = Path(temporary)
    config = base / 'tiecoms'
    shutil.copytree(ROOT / 'infra/nginx', config)
    logs = base / 'logs'
    logs.mkdir()
    web = base / 'web'
    (web / 'app/assets').mkdir(parents=True)
    (web / 'site').mkdir()
    (web / 'app/index.html').write_text('<!doctype html><title>Local proxy fixture</title>')
    (web / 'app/assets/fixture.js').write_text('// Local proxy fixture\n')
    for folder in ['tls', 'tls-chaggu']:
        target = config / folder
        target.mkdir()
        command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                '-subj', '/CN=app.chaggu.com', '-keyout', str(target / 'privkey.pem'),
                '-out', str(target / 'fullchain.pem'))
    (base / 'nginx.conf').write_text('''events {}
http {
    include /etc/nginx/mime.types;
    include /etc/nginx/tiecoms/00-tiecoms-cloudflare.conf;
    include /etc/nginx/tiecoms/tiecoms.conf;
    include /etc/nginx/tiecoms/chaggu-http.conf;
    # Synthetic backend. Closing the upstream socket exercises nginx's error path.
    server {
        listen 127.0.0.1:3020;
        access_log off;
        error_log /dev/null crit;
        location / {
            if ($arg_fail) { return 444; }
            add_header Cache-Control no-store always;
            add_header Referrer-Policy no-referrer always;
            return 302 https://app.chaggu.com/ajustes?provider=google&receipt=FAKE_REDIRECT_RECEIPT;
        }
    }
}
''')
    mounts = ['--mount', f'type=bind,src={base / "nginx.conf"},dst=/etc/nginx/nginx.conf,readonly',
              '--mount', f'type=bind,src={config},dst=/etc/nginx/tiecoms,readonly',
              '--mount', f'type=bind,src={logs},dst=/var/log/nginx',
              '--mount', f'type=bind,src={web},dst=/opt/tiecoms/web/current,readonly']
    command('docker', 'run', '--rm', '--pull=never', '--network=none', *mounts, IMAGE, 'nginx', '-t')
    command('docker', 'run', '-d', '--name', NAME, '--pull=never', '--network=none', *mounts, IMAGE)
    try:
        # Local Docker loopback is allowed by the existing Cloudflare origin guard.
        def request(path, host='app.chaggu.com', referer=None):
            args = ['docker', 'exec', NAME, 'curl', '-ksS', '--max-time', '5', '-D', '-',
                    '-o', '/dev/null', '-H', f'Host: {host}']
            if referer:
                args.extend(['-H', f'Referer: {referer}'])
            args.append('https://127.0.0.1' + path)
            return command(*args).stdout.lower()

        for _ in range(30):
            try:
                request('/assets/fixture.js')
                break
            except subprocess.CalledProcessError:
                time.sleep(0.1)
        checks = []
        for path, host, expected in [
            ('/ajustes?provider=google&receipt=FAKE_RECEIPT_SECRET', 'app.chaggu.com', '200'),
            ('/ajustes?provider=google&receipt=FAKE_LEGACY_SECRET', 'app.tiecoms.com', '301'),
            ('/api/v1/auth/google/callback?code=FAKE_GOOGLE_SECRET&state=FAKE_STATE', 'app.chaggu.com', '302'),
            ('/api/v1/auth/microsoft/callback?code=FAKE_MS_SECRET&state=FAKE_STATE', 'app.tiecoms.com', '302'),
            ('/api/v1/meetings/zoom/callback?code=FAKE_ZOOM_SECRET&state=FAKE_STATE', 'app.chaggu.com', '302'),
            ('/api/v1/auth/google/callback?fail=1&code=FAKE_ERROR_SECRET', 'app.chaggu.com', '502'),
            ('/api/v1/meetings/zoom/callback?fail=1&code=FAKE_ZOOM_ERROR_SECRET', 'app.chaggu.com', '502'),
            ('/api/hooks/local-id/FAKE_HOOK_TOKEN', 'app.chaggu.com', '302'),
            ('/api/hooks/local-id/FAKE_HOOK_ERROR_TOKEN?fail=1', 'app.chaggu.com', '502'),
            ('/api/%68ooks/local-id/FAKE_ENCODED_HOOK_TOKEN?fail=1', 'app.chaggu.com', '502'),
        ]:
            headers = request(path, host)
            assert headers.splitlines()[0].split()[1] == expected, (path.split('?')[0], 'status', headers.splitlines()[0])
            assert 'cache-control: no-store' in headers, (path.split('?')[0], 'cache')
            policies = [x.strip() for x in headers.splitlines() if x.startswith('referrer-policy:')]
            assert policies and all(x == 'referrer-policy: no-referrer' for x in policies), (path.split('?')[0], policies)
            checks.append({'path': '/api/hooks/[redacted]' if 'FAKE_' in path.split('?')[0] else path.split('?')[0], 'host': host, 'status': int(expected), 'noStore': True, 'noReferrer': True})
        malformed = request('/api/%68ooks/local-id/FAKE_MALFORMED_REQUEST%ZZ')
        assert malformed.splitlines()[0].split()[1] == '400'
        normal = request('/assets/fixture.js?normal=kept', referer='https://app.chaggu.com/ajustes?receipt=FAKE_REFERER_SECRET')
        assert 'referrer-policy: strict-origin-when-cross-origin' in normal
        request('/assets/fixture.js?other=kept', referer='https://app.chaggu.com/c/test?normal=kept')
        request('/assets/fixture.js?hook=kept', referer='https://app.chaggu.com/api/hooks/local-id/FAKE_REFERER_HOOK')
        request('/assets/fixture.js?encoded=kept', referer='https://app.chaggu.com/api/%68ooks/local-id/FAKE_REFERER_HOOK%ZZ')
        request('/assets/fixture.js?encoded-api=kept', referer='https://app.chaggu.com/%61pi%2Fhooks/local-id/FAKE_REFERER_PREFIX%ZZ')
        # Only synthetic local logs are inspected; never read production log contents.
        access = '\n'.join(p.read_text() for p in logs.glob('*access.log'))
        assert 'FAKE_' not in access
        assert '/assets/fixture.js?normal=kept HTTP/' in access
        assert 'https://app.chaggu.com/c/test?normal=kept' in access
        errors = '\n'.join(p.read_text() for p in logs.glob('*error.log'))
        assert 'FAKE_' not in errors
        print(json.dumps({'nginxSyntax': 'passed', 'containerImage': IMAGE, 'network': 'isolated local loopback',
                          'routeChecks': checks, 'malformedEncodedHookStatus': 400, 'syntheticSecretsInAccessLogs': 0, 'syntheticSecretsInErrorLogs': 0,
                          'ordinaryQueryAndRefererPreserved': True}, indent=2))
    finally:
        command('docker', 'rm', '-f', NAME, check=False)
