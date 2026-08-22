import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DouyinOpenApiAdapter, InMemoryPublishStateStore, type DouyinHttpTransport } from '../../packages/modules/publisher/src/douyin-open-api-adapter.js';
import type { PublishSnapshot, PublisherContext } from '../../packages/contracts/src/index.js';

const context: PublisherContext = { profileDir: 'profile-douyin', credentialRef: 'env://DOUYIN', credential: { accessToken: 'access-token', openId: 'open-id' } };
const snapshot: PublishSnapshot = { requestId: 'request-1', idempotencyKey: 'publish-douyin-1', assetId: 'asset-1', mediaPath: 'C:/tmp/video.mp4', title: '标题', description: '#话题' };

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('Douyin adapter advertises official API capabilities and requires media credentials', async () => {
  const adapter = new DouyinOpenApiAdapter({ request: async () => response({}) });
  assert.deepEqual(adapter.capabilities(), { platformId: 'douyin', mediaTypes: ['video/mp4', 'video/webm'], scheduling: false, requiresHumanConfirmation: true });
  assert.equal((await adapter.authenticate(context)).status, 'AUTHENTICATED');
  const { mediaPath: _mediaPath, ...withoutMedia } = snapshot;
  const result = await adapter.publish(context, withoutMedia);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failure?.code, 'UPLOAD_FAILED');
});

test('Douyin adapter preserves idempotency and never returns credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-douyin-contract-'));
  const mediaPath = join(root, 'video.mp4');
  await writeFile(mediaPath, Buffer.from('fake-mp4'));
  try {
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const transport: DouyinHttpTransport = { request: async (input) => {
    requests.push({ url: input.url, method: input.method, headers: input.headers || {} });
    if (input.url.endsWith('/video/upload/')) return response({ data: { error_code: 0, video: { video_id: 'encrypted-video-id' } }, extra: { error_code: 0 } });
    return response({ data: { error_code: 0, item_id: 'douyin-item-1' }, extra: { error_code: 0 } });
  } };
  const adapter = new DouyinOpenApiAdapter(transport, new InMemoryPublishStateStore());
  const first = await adapter.publish(context, { ...snapshot, mediaPath });
  const second = await adapter.publish(context, { ...snapshot, mediaPath });
  assert.equal(first.status, 'PUBLISHED'); assert.equal(first.externalPostId, 'douyin-item-1');
  assert.deepEqual(second, first);
  assert.equal(requests.filter((request) => request.url.includes('/video/upload/')).length, 1);
  assert.equal(requests.filter((request) => request.url.includes('/create_video/')).length, 1);
  assert.equal(JSON.stringify(first).includes('access-token'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
