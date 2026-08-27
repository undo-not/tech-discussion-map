import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { getLocalLaunchSecret } from '../adapters/companion/launch-secret.ts';
import { POST, PUT } from '../app/api/local-launch/route.ts';

const endpoint = 'http://127.0.0.1:3000/api/local-launch';
const origin = 'http://127.0.0.1:3000';
const secret = 'd'.repeat(64);

function request(method, body, requestOrigin = origin) {
  return new Request(endpoint, {
    method,
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('launch secret is provisioned once and retrieved only by exact same-origin POST', async () => {
  assert.equal((await POST(request('POST', { request: 'local-launch-secret' }, 'https://attacker.example'))).status, 403);
  assert.equal((await POST(request('POST', { request: 'local-launch-secret' }))).status, 404);
  assert.equal((await PUT(request('PUT', { launchSecret: secret }))).status, 204);
  assert.equal((await PUT(request('PUT', { launchSecret: 'e'.repeat(64) }))).status, 409);
  const response = await POST(request('POST', { request: 'local-launch-secret' }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { launchSecret: secret });
});
test('browser launch-secret adapter uses a no-store same-origin body and caches only in memory', async () => {
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls += 1;
    assert.equal(url, '/api/local-launch');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(JSON.parse(init.body).request, 'local-launch-secret');
    return Response.json({ launchSecret: secret });
  };
  assert.equal(await getLocalLaunchSecret(fakeFetch), secret);
  assert.equal(await getLocalLaunchSecret(() => assert.fail('cached secret should avoid a second request')), secret);
  assert.equal(calls, 1);
});

test('launcher source never places the secret in a URL, process argument, or log', async () => {
  const source = await readFile(new URL('../../scripts/start-mvp.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /techmap-launch|launchUrl|Start-Process\s+[^\r\n]*Secret/i);
  assert.match(source, /Set-WebLaunchSecret \$launchSecret/);
  assert.match(source, /Start-Process 'http:\/\/127\.0\.0\.1:3000\/'/);
  assert.match(source, /TECHMAP_LAUNCH_SECRET = \$launchSecret/);
  assert.match(source, /@\(\$webCli, 'start', '--hostname', '127\.0\.0\.1', '--port', '3000'\)/);
  assert.match(source, /AddSeconds\(30\)[\s\S]*Set-WebLaunchSecret/);
});
