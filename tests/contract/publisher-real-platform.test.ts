import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublisherCredential, PublishResult, PublishSnapshot, PublisherContext, PublisherPlatformId } from '../../packages/contracts/src/index.js';
import { EnvironmentCredentialProvider } from '../../packages/modules/publisher/src/credential-provider.js';

test('real publisher contract carries media references and stable platform IDs', async () => {
  const platformIds: PublisherPlatformId[] = ['fake-platform', 'douyin', 'wechat-channels'];
  assert.deepEqual(platformIds, ['fake-platform', 'douyin', 'wechat-channels']);
  const snapshot: PublishSnapshot = { requestId: 'request-1', idempotencyKey: 'publish:project:revision', assetId: 'asset-1', mediaPath: 'E:/contentos/objects/asset-1.mp4', coverPath: 'E:/contentos/objects/asset-1.jpg', title: '测试标题', description: '#测试' };
  assert.equal(snapshot.mediaPath?.endsWith('.mp4'), true);
  const context: PublisherContext = { profileDir: 'profile', accountId: 'account', credentialRef: 'vault://publisher/account', credential: { accessToken: 'secret-token', openId: 'open-1' } };
  assert.equal(context.credential?.openId, 'open-1');
  const safeResult: PublishResult = { status: 'PUBLISHED', externalPostId: 'external-1' };
  assert.equal(JSON.stringify(safeResult).includes('secret-token'), false);
});

test('environment credential provider resolves refs without serializing secrets', async () => {
  const credential: PublisherCredential = { accessToken: 'token-value', clientKey: 'client-key', openId: 'open-1' };
  const provider = new EnvironmentCredentialProvider({ 'CONTENTOS_CREDENTIAL_DOUYIN_ACCOUNT': JSON.stringify(credential) });
  const resolved = await provider.resolve('env://CONTENTOS_CREDENTIAL_DOUYIN_ACCOUNT');
  assert.deepEqual(resolved, credential);
  assert.equal(JSON.stringify({ ref: 'env://CONTENTOS_CREDENTIAL_DOUYIN_ACCOUNT' }).includes('token-value'), false);
});
