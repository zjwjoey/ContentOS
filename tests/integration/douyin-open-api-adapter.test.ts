import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DouyinOpenApiAdapter, type DouyinHttpTransport } from '../../packages/modules/publisher/src/douyin-open-api-adapter.js';
import type { PublishSnapshot, PublisherContext } from '../../packages/contracts/src/index.js';

const context: PublisherContext = { profileDir: 'profile-douyin', credentialRef: 'env://DOUYIN', credential: { accessToken: 'access-token', openId: 'open-id' } };
const baseSnapshot: Omit<PublishSnapshot, 'mediaPath'> = { requestId: 'request-1', idempotencyKey: 'publish-douyin-1', assetId: 'asset-1', title: '标题', description: '#话题' };
const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function withMedia(run: (mediaPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'contentos-douyin-'));
  const mediaPath = join(root, 'video.mp4');
  await writeFile(mediaPath, Buffer.from('fake-mp4'));
  try { await run(mediaPath); } finally { await rm(root, { recursive: true, force: true }); }
}

test('Douyin adapter uploads media and creates an item with the encrypted video id', async () => {
  await withMedia(async (mediaPath) => {
    const bodies: Array<{ url: string; body?: BodyInit }> = [];
    const transport: DouyinHttpTransport = { request: async (input) => {
      bodies.push(input);
      if (input.url.endsWith('/video/upload/')) return jsonResponse({ data: { error_code: 0, video: { video_id: 'encrypted-video-id' } }, extra: { error_code: 0 } });
      assert.equal(input.url.includes('open_id=open-id'), true);
      const createBody = JSON.parse(String(input.body));
      assert.equal(createBody.video_id, 'encrypted-video-id');
      assert.equal(createBody.text, '标题\n#话题');
      return jsonResponse({ data: { error_code: 0, item_id: 'douyin-item-1' }, extra: { error_code: 0 } });
    } };
    const result = await new DouyinOpenApiAdapter(transport).publish(context, { ...baseSnapshot, mediaPath });
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.externalPostId, 'douyin-item-1');
    assert.equal(bodies.length, 2);
  });
});

test('Douyin adapter normalizes auth, rate-limit, upload and uncertain network failures', async () => {
  await withMedia(async (mediaPath) => {
    const scenarios: Array<[string, unknown, string, string]> = [
      ['auth', { data: { error_code: 28001008, description: 'expired' } }, 'AUTH_EXPIRED', 'HUMAN_ACTION_REQUIRED'],
      ['rate', { data: { error_code: 2114007, description: 'quota' } }, 'RATE_LIMIT', 'RETRYABLE'],
      ['upload', { data: { error_code: 2190007, description: 'bad video' } }, 'UPLOAD_FAILED', 'PERMANENT'],
    ];
    for (const [name, body, code, classification] of scenarios) {
      const transport: DouyinHttpTransport = { request: async () => jsonResponse(body) };
      const result = await new DouyinOpenApiAdapter(transport).publish(context, { ...baseSnapshot, idempotencyKey: `publish-${name}`, mediaPath });
      assert.equal(result.status, 'FAILED'); assert.equal(result.failure?.code, code); assert.equal(result.failure?.classification, classification);
    }
    const networkTransport: DouyinHttpTransport = { request: async (input) => input.url.endsWith('/video/upload/') ? jsonResponse({ data: { error_code: 0, video: { video_id: 'encrypted' } } }) : Promise.reject(new Error('socket closed')) };
    const uncertain = await new DouyinOpenApiAdapter(networkTransport).publish(context, { ...baseSnapshot, idempotencyKey: 'publish-network', mediaPath });
    assert.equal(uncertain.status, 'UNKNOWN_EXTERNAL_STATE'); assert.equal(uncertain.failure?.classification, 'RECONCILIATION_REQUIRED');
  });
});
