import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakePublisherAdapter, FakePublisherService } from '../../packages/modules/publisher/src/index.js';

const snapshot = { requestId: 'request-fake-1', idempotencyKey: 'publish-fake-1', assetId: 'asset-render-1', title: 'Fake', description: '' };

test('Fake Publisher isolates profile directories and preserves idempotent result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-publisher-'));
  try {
    const service = new FakePublisherService(root);
    const first = await service.publish('account-a', snapshot);
    const second = await service.publish('account-a', snapshot);
    await service.publish('account-b', { ...snapshot, idempotencyKey: 'publish-fake-2' });
    assert.equal(first.status, 'PUBLISHED'); assert.equal(first.externalPostId, second.externalPostId);
    assert.notEqual(service.profileDirectory('account-a'), service.profileDirectory('account-b'));
    assert.ok((await stat(service.profileDirectory('account-a'))).isDirectory());
    assert.ok((await stat(service.profileDirectory('account-b'))).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Fake Publisher returns a safe human-action result for expired auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-publisher-auth-'));
  try {
    const result = await new FakePublisherService(root, new FakePublisherAdapter('AUTH_EXPIRED')).publish('account-auth', snapshot);
    assert.equal(result.status, 'FAILED'); assert.equal(result.failure?.code, 'AUTH_EXPIRED');
    assert.equal(JSON.stringify(result).includes('credential'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Fake Publisher reconciles an uncertain side effect and distinguishes a missing post', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-publisher-reconcile-'));
  try {
    const service = new FakePublisherService(root, new FakePublisherAdapter('BROWSER_CRASH'));
    const unknown = await service.publish('account-reconcile', snapshot);
    assert.equal(unknown.status, 'UNKNOWN_EXTERNAL_STATE');
    const confirmed = await service.reconcile('account-reconcile', snapshot.idempotencyKey);
    assert.equal(confirmed.status, 'PUBLISHED');
    assert.ok(confirmed.externalPostId);
    const missing = await service.reconcile('account-reconcile', 'publish-never-started');
    assert.equal(missing.status, 'NOT_FOUND');
  } finally { await rm(root, { recursive: true, force: true }); }
});
