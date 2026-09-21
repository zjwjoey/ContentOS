import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteMediaSecurityError, safeFetchRemoteMedia, validateRemotePublicHttpUrl, type RemoteMediaResolver } from '../../packages/modules/digital-human/src/index.js';

const publicResolver: RemoteMediaResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('remote media validation allows a resolved public HTTPS URL', async () => {
  const url = await validateRemotePublicHttpUrl('https://cdn.example.test/result.mp4', publicResolver);
  assert.equal(url.hostname, 'cdn.example.test');
});

for (const address of ['127.0.0.1', '192.168.10.10', '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1']) {
  test(`remote media validation rejects blocked IPv4 ${address}`, async () => {
    await assert.rejects(() => validateRemotePublicHttpUrl(`http://${address}/result.mp4`), (error: unknown) => error instanceof RemoteMediaSecurityError && error.code === 'REMOTE_MEDIA_URL_UNSAFE');
  });
}

test('remote media validation rejects localhost suffixes and IPv6 loopback', async () => {
  await assert.rejects(() => validateRemotePublicHttpUrl('http://localhost/result.mp4'), /blocked hostname/);
  await assert.rejects(() => validateRemotePublicHttpUrl('http://worker.localhost/result.mp4'), /blocked hostname/);
  await assert.rejects(() => validateRemotePublicHttpUrl('http://[::1]/result.mp4'), /non-public address/);
  await assert.rejects(() => validateRemotePublicHttpUrl('http://[fc00::1]/result.mp4'), /non-public address/);
  await assert.rejects(() => validateRemotePublicHttpUrl('http://[::ffff:192.168.1.1]/result.mp4'), /non-public address/);
});

test('remote media validation rejects a hostname resolving to any private address', async () => {
  const resolver: RemoteMediaResolver = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ];
  await assert.rejects(() => validateRemotePublicHttpUrl('https://mixed.example.test/result.mp4', resolver), /non-public address/);
});

test('safe remote media fetch validates every redirect and uses manual redirect mode', async () => {
  const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), redirect: init?.redirect });
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: '/final.mp4' } });
    return new Response('video', { status: 200 });
  };
  const response = await safeFetchRemoteMedia('https://cdn.example.test/start.mp4', { fetchImpl, resolveAll: publicResolver });
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [
    { url: 'https://cdn.example.test/start.mp4', redirect: 'manual' },
    { url: 'https://cdn.example.test/final.mp4', redirect: 'manual' },
  ]);
});

test('safe remote media fetch rejects a public redirect to localhost or private IP', async () => {
  for (const location of ['http://localhost/result.mp4', 'http://192.168.1.20/result.mp4', 'http://[::1]/result.mp4']) {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 302, headers: { location } });
    await assert.rejects(() => safeFetchRemoteMedia('https://cdn.example.test/start.mp4', { fetchImpl, resolveAll: publicResolver }), /blocked hostname|non-public address/);
  }
});

test('safe remote media fetch rejects redirect loops and excessive redirects', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/loop.mp4' } }); };
  await assert.rejects(() => safeFetchRemoteMedia('https://cdn.example.test/start.mp4', { fetchImpl, resolveAll: publicResolver, maxRedirects: 5 }), /redirect limit/);
  assert.equal(calls, 6);
});

test('safe remote media fetch follows a valid public redirect', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 307, headers: { location: 'https://download.example.test/result.mp4' } })
      : new Response('video', { status: 200 });
  };
  const response = await safeFetchRemoteMedia('https://cdn.example.test/start.mp4', { fetchImpl, resolveAll: publicResolver });
  assert.equal(response.status, 200);
});
