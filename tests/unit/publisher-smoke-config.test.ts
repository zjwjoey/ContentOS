import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublisherSmokeConfig } from '../../scripts/publisher-smoke.js';

const args = ['--platform', 'douyin', '--account', 'account-a', '--media', 'video.mp4', '--credential-ref', 'env://CONTENTOS_CREDENTIAL_DOUYIN', '--profile-root', 'profiles'];

test('publisher smoke config refuses to run without explicit opt-in', () => {
  assert.throws(() => parsePublisherSmokeConfig({ NODE_ENV: 'development' }, args), /CONTENTOS_REAL_PLATFORM_SMOKE=1/);
});

test('publisher smoke config requires platform credentials and approved review', () => {
  const environment = { CONTENTOS_REAL_PLATFORM_SMOKE: '1', CONTENTOS_PUBLISHER_REVIEW_APPROVED: '1', CONTENTOS_PUBLISHER_ALLOW_SUBMIT: '1' };
  assert.throws(() => parsePublisherSmokeConfig(environment, args), /credential/i);
  const configured = parsePublisherSmokeConfig({ ...environment, CONTENTOS_CREDENTIAL_DOUYIN: '{"accessToken":"secret"}' }, args);
  assert.equal(configured.platformId, 'douyin');
  assert.equal(configured.accountId, 'account-a');
  assert.equal(configured.allowSubmit, true);
});

test('publisher smoke config contains no credential material in its safe summary', () => {
  const config = parsePublisherSmokeConfig({ CONTENTOS_REAL_PLATFORM_SMOKE: '1', CONTENTOS_PUBLISHER_REVIEW_APPROVED: '1', CONTENTOS_PUBLISHER_ALLOW_SUBMIT: '1', CONTENTOS_CREDENTIAL_DOUYIN: '{"accessToken":"secret-token"}' }, args);
  assert.equal(JSON.stringify(config).includes('secret-token'), false);
  assert.equal(JSON.stringify(config).includes('CONTENTOS_CREDENTIAL_DOUYIN'), true);
});
