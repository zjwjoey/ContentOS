import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublisherAdapterRegistry, createPublisherHandler, type ReviewApprovalProvider } from '../../packages/modules/publisher/src/publisher-registry.js';
import type { AuthResult, ExternalStateResult, PlatformCapabilityProfile, PublishResult, PublishSnapshot, PublisherAdapter, PublisherContext, PublisherCredential, PublisherFailure } from '../../packages/contracts/src/index.js';
import { createPublisherWorker, createRealPublisherWorker } from '../../workers/publisher-worker/src/main.js';
import type { BrowserSessionFactory } from '../../packages/modules/publisher/src/browser-session.js';

class RecordingAdapter implements PublisherAdapter {
  readonly contexts: PublisherContext[] = [];
  constructor(private readonly platformId: 'douyin' | 'wechat-channels') {}
  capabilities(): PlatformCapabilityProfile { return { platformId: this.platformId, mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: true }; }
  async authenticate(_context: PublisherContext): Promise<AuthResult> { return { status: 'AUTHENTICATED' }; }
  async publish(context: PublisherContext, _snapshot: PublishSnapshot): Promise<PublishResult> { this.contexts.push(context); return { status: 'PUBLISHED', externalPostId: `${this.platformId}-post` }; }
  async reconcile(_context: PublisherContext, _idempotencyKey: string): Promise<ExternalStateResult> { return { status: 'NOT_FOUND' }; }
}

const snapshot: PublishSnapshot = { requestId: 'request-worker', idempotencyKey: 'publish-worker', assetId: 'asset-1', mediaPath: 'video.mp4', title: 'title', description: 'description' };

test('Publisher Worker dispatches both real platform IDs with isolated profiles and resolved refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-real-publisher-worker-'));
  try {
    const douyin = new RecordingAdapter('douyin'); const wechat = new RecordingAdapter('wechat-channels');
    const registry = new PublisherAdapterRegistry(); registry.register(douyin); registry.register(wechat);
    const approval: ReviewApprovalProvider = { isApproved: async (input) => input.targetType === 'PUBLISH' && input.reviewDecisionId === 'review-1' };
    const credential: PublisherCredential = { accessToken: 'secret-token', openId: 'open-id' };
    const handler = createPublisherHandler({ registry, approval, credentials: { resolve: async () => credential }, profileRoot: root });
    const worker = createPublisherWorker(handler); await worker.start();
    const result = await worker.execute('publisher.publish', { platformId: 'douyin', accountId: 'account-a', credentialRef: 'env://DOUYIN', projectId: 'project-1', targetId: 'render-1', reviewDecisionId: 'review-1', snapshot });
    assert.equal((result as PublishResult).status, 'PUBLISHED');
    assert.equal(douyin.contexts[0]?.profileDir, join(root, 'douyin', 'account-a'));
    assert.equal(douyin.contexts[0]?.credential?.accessToken, 'secret-token');
    const second = await worker.execute('publisher.publish', { platformId: 'wechat-channels', accountId: 'account-b', credentialRef: 'profile://WECHAT', projectId: 'project-1', targetId: 'publish-1', reviewDecisionId: 'review-1', snapshot: { ...snapshot, idempotencyKey: 'publish-worker-2' } });
    assert.equal((second as PublishResult).status, 'PUBLISHED');
    assert.equal(wechat.contexts[0]?.profileDir, join(root, 'wechat-channels', 'account-b'));
    await worker.shutdown('test');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Publisher Worker refuses unapproved publish jobs and duplicate registry IDs', async () => {
  const registry = new PublisherAdapterRegistry(); registry.register(new RecordingAdapter('douyin'));
  assert.throws(() => registry.register(new RecordingAdapter('douyin')), /already registered/);
  const approval: ReviewApprovalProvider = { isApproved: async () => false };
  const handler = createPublisherHandler({ registry, approval, credentials: { resolve: async () => ({}) }, profileRoot: join(tmpdir(), 'contentos-real-publisher-reject') });
  const result = await handler({ platformId: 'douyin', accountId: 'account-a', credentialRef: 'env://DOUYIN', projectId: 'project-1', targetId: 'render-1', reviewDecisionId: 'review-not-approved', snapshot });
  assert.equal((result as PublishResult).status, 'FAILED');
  assert.equal((result as PublishResult).failure?.code, 'HUMAN_CONFIRMATION_REQUIRED');
});

test('Publisher Worker composition root registers Douyin and WeChat Channels adapters', async () => {
  const browser: BrowserSessionFactory = { open: async () => { throw new Error('browser should not open before review approval'); } };
  const worker = createRealPublisherWorker({ profileRoot: join(tmpdir(), 'contentos-composition-root'), browser, credentials: { resolve: async () => ({}) }, approval: { isApproved: async () => false } });
  await worker.start();
  const payload = { platformId: 'douyin', accountId: 'account', credentialRef: 'env://DOUYIN', projectId: 'project', targetId: 'publish', reviewDecisionId: 'review', snapshot } as const;
  const douyin = await worker.execute('publisher.publish', payload);
  const wechat = await worker.execute('publisher.publish', { ...payload, platformId: 'wechat-channels' });
  assert.equal((douyin as PublishResult).failure?.code, 'HUMAN_CONFIRMATION_REQUIRED');
  assert.equal((wechat as PublishResult).failure?.code, 'HUMAN_CONFIRMATION_REQUIRED');
  await worker.shutdown('test');
});
