import test from 'node:test';
import assert from 'node:assert/strict';
import { FakePublisherAdapter, type PublisherFailureCode } from '../../packages/modules/publisher/src/index.js';

test('Fake Publisher exposes capabilities and idempotent success', async () => {
  const adapter = new FakePublisherAdapter();
  const capabilities = adapter.capabilities();
  assert.equal(capabilities.platformId, 'fake-platform');
  const auth = await adapter.authenticate({ profileDir: 'profile-a', accountId: 'account-a', credentialRef: 'vault://fake/account-a' });
  assert.equal(auth.status, 'AUTHENTICATED');
  const snapshot = { requestId: 'request-1', idempotencyKey: 'publish-1', assetId: 'asset-render-1', title: '测试发布', description: 'fake' };
  const first = await adapter.publish({ profileDir: 'profile-a', accountId: 'account-a', credentialRef: 'vault://fake/account-a' }, snapshot);
  const second = await adapter.publish({ profileDir: 'profile-a', accountId: 'account-a', credentialRef: 'vault://fake/account-a' }, snapshot);
  assert.equal(first.status, 'PUBLISHED'); assert.equal(first.externalPostId, second.externalPostId);
});

test('Fake Publisher normalizes auth, verification, DOM, crash and retry outcomes', async () => {
  const scenarios: Array<[FakePublisherAdapter['outcome'], PublisherFailureCode, string]> = [
    ['AUTH_EXPIRED', 'AUTH_EXPIRED', 'HUMAN_ACTION_REQUIRED'],
    ['VERIFICATION', 'REQUIRES_VERIFICATION', 'HUMAN_ACTION_REQUIRED'],
    ['DOM_DRIFT', 'PLATFORM_CHANGED', 'PERMANENT'],
    ['BROWSER_CRASH', 'UNKNOWN_EXTERNAL_STATE', 'RECONCILIATION_REQUIRED'],
    ['RATE_LIMIT', 'RATE_LIMIT', 'RETRYABLE'],
    ['NETWORK', 'NETWORK_ERROR', 'RETRYABLE'],
  ];
  for (const [outcome, code, classification] of scenarios) {
    const result = await new FakePublisherAdapter(outcome).publish({ profileDir: `profile-${outcome}`, accountId: 'account-a', credentialRef: 'vault://fake' }, { requestId: 'r', idempotencyKey: outcome, assetId: 'asset', title: 'title', description: '' });
    assert.equal(result.status, code === 'UNKNOWN_EXTERNAL_STATE' ? 'UNKNOWN_EXTERNAL_STATE' : 'FAILED');
    assert.equal(result.failure?.code, code); assert.equal(result.failure?.classification, classification);
  }
});
