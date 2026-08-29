import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { PostgresPublishStateStore } from '../../packages/modules/publisher/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

test('Postgres publish state is idempotent and never downgrades PUBLISHED', async () => {
  const db = await createDatabase(databaseUrl);
  const store = new PostgresPublishStateStore(db);
  const key = { platformId: 'douyin' as const, accountId: `state-test-${randomUUID()}`, idempotencyKey: `publish-${randomUUID()}` };
  try {
    await migrateUp(db);
    await store.markUnknown(key);
    assert.deepEqual(await store.get(key), { status: 'UNKNOWN_EXTERNAL_STATE' });
    await store.markPublished(key, 'external-1');
    await store.markPublished(key, 'external-1');
    assert.deepEqual(await store.get(key), { status: 'PUBLISHED', externalPostId: 'external-1' });
    await store.markUnknown(key);
    assert.deepEqual(await store.get(key), { status: 'PUBLISHED', externalPostId: 'external-1' });
  } finally {
    await db.query('delete from publisher_publication_states where account_id = $1', [key.accountId]);
    await db.end();
  }
});
