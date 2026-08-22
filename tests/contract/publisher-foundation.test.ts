import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublisherRequestTransition,
  type PublisherAccountStatus,
  type PublisherRequestStatus,
} from '../../packages/modules/publisher/src/index.js';

test('Publisher foundation exposes bounded account and request statuses', () => {
  const account: PublisherAccountStatus = 'READY';
  const request: PublisherRequestStatus = 'DRAFT';
  assert.equal(account, 'READY');
  assert.equal(request, 'DRAFT');
});

test('Publisher foundation allows only explicit request transitions', () => {
  assert.doesNotThrow(() => assertPublisherRequestTransition('DRAFT', 'SCHEDULED'));
  assert.doesNotThrow(() => assertPublisherRequestTransition('SCHEDULED', 'QUEUED'));
  assert.doesNotThrow(() => assertPublisherRequestTransition('QUEUED', 'PUBLISHING'));
  assert.doesNotThrow(() => assertPublisherRequestTransition('PUBLISHING', 'PUBLISHED'));
  assert.doesNotThrow(() => assertPublisherRequestTransition('PUBLISHING', 'RECONCILING'));
  assert.throws(() => assertPublisherRequestTransition('PUBLISHED', 'QUEUED'), /Invalid Publisher request transition/);
});
