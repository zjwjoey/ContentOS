import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadAndValidateRemoteAvatarResult, validateRemoteVideoProbe, type RemoteVideoProbe } from '../../workers/digital-human-worker/src/handler.js';

const resolvePublic = async () => [{ address: '93.184.216.34', family: 4 as const }];
const validProbe: RemoteVideoProbe = { format: 'mp4', durationMs: 1_250, width: 640, height: 360, videoCodec: 'h264' };

async function withTempPath(run: (tempPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'contentos-avatar-result-'));
  try { await run(join(root, 'result.mp4')); } finally { await rm(root, { recursive: true, force: true }); }
}

function options(tempPath: string, response: Response, probe: (path: string) => Promise<RemoteVideoProbe> = async () => validProbe) {
  return { fetchImpl: async () => response, resolveRemoteMedia: resolvePublic, signal: new AbortController().signal, timeoutMs: 1_000, maxBytes: 1_000, tempPath, probe };
}

test('remote Avatar result allows application/octet-stream when ffprobe identifies a video', async () => {
  await withTempPath(async (tempPath) => {
    const probePaths: string[] = [];
    const result = await downloadAndValidateRemoteAvatarResult('https://provider.test/result', { ...options(tempPath, new Response(Buffer.from('valid-video'), { status: 200, headers: { 'content-type': 'application/octet-stream' } }), async (path) => { probePaths.push(path); return validProbe; }) });
    assert.deepEqual(result, validProbe);
    assert.deepEqual(probePaths, [tempPath]);
    assert.deepEqual(await readFile(tempPath), Buffer.from('valid-video'));
  });
});

for (const contentType of ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml']) {
  test(`remote Avatar result rejects ${contentType} before import`, async () => {
    await withTempPath(async (tempPath) => {
      await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', options(tempPath, new Response('<error/>', { status: 200, headers: { 'content-type': contentType } }))), /invalid media content type/);
      await assert.rejects(access(tempPath));
    });
  });
}

test('remote Avatar result rejects an empty body and cleans the partial file', async () => {
  await withTempPath(async (tempPath) => {
    await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', options(tempPath, new Response(null, { status: 200, headers: { 'content-type': 'application/octet-stream' } }))), /empty response body/);
    await assert.rejects(access(tempPath));
  });
});

test('remote Avatar result rejects a response larger than the configured byte limit', async () => {
  await withTempPath(async (tempPath) => {
    await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', { ...options(tempPath, new Response(Buffer.from('too-large'), { status: 200, headers: { 'content-length': '8', 'content-type': 'application/octet-stream' } })), maxBytes: 4 }), /size limit/);
    await assert.rejects(access(tempPath));
  });
});

for (const [label, probe] of [
  ['zero duration', { ...validProbe, durationMs: 0 }],
  ['zero width', { ...validProbe, width: 0 }],
  ['zero height', { ...validProbe, height: 0 }],
  ['missing video codec', { ...validProbe, videoCodec: undefined }],
  ['unknown format', { ...validProbe, format: 'unknown' }],
] as Array<[string, RemoteVideoProbe]>) {
  test(`remote Avatar result rejects ffprobe ${label}`, async () => {
    await withTempPath(async (tempPath) => {
      await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', options(tempPath, new Response(Buffer.from('invalid-video'), { status: 200, headers: { 'content-type': 'application/octet-stream' } }), async () => probe)), /not a valid video/);
      await assert.rejects(access(tempPath));
    });
  });
}

test('remote Avatar result maps ffprobe failures to an invalid provider result and cleans up', async () => {
  await withTempPath(async (tempPath) => {
    await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', options(tempPath, new Response(Buffer.from('corrupt-mp4'), { status: 200, headers: { 'content-type': 'application/octet-stream' } }), async () => { throw new Error('ffprobe failed'); })), /could not be validated as video/);
    await assert.rejects(access(tempPath));
  });
});

test('remote Avatar result preserves retryability for HTTP 500 but rejects HTTP 400', async () => {
  await withTempPath(async (tempPath) => {
    await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', options(tempPath, new Response('temporarily unavailable', { status: 500 }))), (error: { code?: string; retryable?: boolean }) => error.code === 'AVATAR_RESULT_DOWNLOAD_FAILED' && error.retryable === true);
    await assert.rejects(downloadAndValidateRemoteAvatarResult('https://provider.test/result', options(tempPath, new Response('bad request', { status: 400 }))), (error: { code?: string; retryable?: boolean }) => error.code === 'AVATAR_RESULT_DOWNLOAD_FAILED' && error.retryable === false);
  });
});

test('remote Avatar result cancellation during probe never succeeds and removes the temp file', async () => {
  await withTempPath(async (tempPath) => {
    const controller = new AbortController();
    const running = downloadAndValidateRemoteAvatarResult('https://provider.test/result', { ...options(tempPath, new Response(Buffer.from('valid-video'), { status: 200, headers: { 'content-type': 'application/octet-stream' } })), signal: controller.signal, probe: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); } });
    await assert.rejects(running, /aborted/);
    await assert.rejects(access(tempPath));
  });
});

test('validateRemoteVideoProbe rejects non-video probe shapes', () => {
  assert.throws(() => validateRemoteVideoProbe({ ...validProbe, height: -1 }), /not a valid video/);
  assert.doesNotThrow(() => validateRemoteVideoProbe(validProbe));
});
