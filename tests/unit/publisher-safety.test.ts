import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentCredentialProvider } from '../../packages/modules/publisher/src/index.js';

test('credential provider resolves references without exposing credential values in errors', async () => {
  const provider = new EnvironmentCredentialProvider({ CONTENTOS_CREDENTIAL_DOUYIN: '{"accessToken":"secret-token","openId":"open-id"}' });
  const credential = await provider.resolve('env://CONTENTOS_CREDENTIAL_DOUYIN');
  assert.equal(credential.accessToken, 'secret-token');
  await assert.rejects(() => provider.resolve('env://MISSING_CREDENTIAL'), (error: Error) => !error.message.includes('secret-token'));
  await assert.rejects(() => provider.resolve('vault://not-supported'), /Unsupported publisher credential reference/);
});

test('credential provider rejects malformed credential JSON and non-string fields', async () => {
  const provider = new EnvironmentCredentialProvider({ BAD_JSON: '{', BAD_FIELD: '{"accessToken":42}' });
  await assert.rejects(() => provider.resolve('env://BAD_JSON'), /not valid JSON/);
  await assert.rejects(() => provider.resolve('env://BAD_FIELD'), /invalid accessToken value/);
});
