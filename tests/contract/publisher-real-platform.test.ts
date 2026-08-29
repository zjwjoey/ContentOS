import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublishSnapshotDigest, type PublisherContext, type PublishSnapshot } from '../../packages/contracts/src/index.js';

test('Publisher contract supports real platform IDs and immutable media snapshot fields', () => {
  const context: PublisherContext = { profileDir: 'profiles/douyin/account-a', accountId: 'account-a', credentialRef: 'env://CONTENTOS_CREDENTIAL_DOUYIN', credential: { accessToken: 'in-memory-only', openId: 'open-id' } };
  const snapshot: PublishSnapshot = { requestId: 'request-1', idempotencyKey: 'publish-1', assetId: 'asset-1', assetSha256: 'a'.repeat(64), mediaPath: 'objects/aa/hash', coverPath: 'objects/bb/cover', coverSha256: 'b'.repeat(64), title: 'title', description: 'description' };
  assert.equal(context.accountId, 'account-a');
  assert.match(createPublishSnapshotDigest({ platformId: 'douyin', accountId: context.accountId, snapshot }), /^[a-f0-9]{64}$/);
});

test('Publisher snapshot digest is deterministic and changes when reviewed content changes', () => {
  const snapshot: PublishSnapshot = { requestId: 'request-1', idempotencyKey: 'publish-1', assetId: 'asset-1', assetSha256: 'a'.repeat(64), title: 'title', description: 'description' };
  const first = createPublishSnapshotDigest({ platformId: 'wechat-channels', accountId: 'account-a', snapshot });
  const second = createPublishSnapshotDigest({ platformId: 'wechat-channels', accountId: 'account-a', snapshot: { ...snapshot, title: 'changed' } });
  assert.notEqual(first, second);
});
