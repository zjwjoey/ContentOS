import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakePublisherService } from '../../packages/modules/publisher/src/index.js';
import { createPublisherWorker } from '../../workers/publisher-worker/src/main.js';

test('Publisher Worker executes only the fake publisher contract and shuts down cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contentos-publisher-worker-'));
  const service = new FakePublisherService(root);
  const worker = createPublisherWorker(async (payload) => service.publish('worker-account', payload as { requestId: string; idempotencyKey: string; assetId: string; title: string; description: string }));
  try {
    await worker.start();
    const result = await worker.execute('publisher.publish', { requestId: 'worker-request', idempotencyKey: 'worker-publish', assetId: 'asset', title: 'Fake', description: '' });
    assert.equal((result as { status: string }).status, 'PUBLISHED');
    assert.deepEqual(worker.handlerTypes(), ['publisher.publish']);
  } finally { await worker.shutdown('SIGTERM'); await rm(root, { recursive: true, force: true }); }
  assert.equal(worker.health().status, 'STOPPED');
});
