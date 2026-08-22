import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { PostgresPublishStateStore } from '../../packages/modules/publisher/src/publish-state-store.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';
const key = { platformId: 'douyin' as const, accountId: 'publisher-state-account', idempotencyKey: 'publisher-state-key' };

test('Publisher state survives a new store instance and blocks unknown replay', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  try {
    await db.query('delete from publisher_publication_states where account_id = $1', [key.accountId]);
    const first = new PostgresPublishStateStore(db);
    await first.markPublished(key, 'douyin-post-1');
    assert.deepEqual(await new PostgresPublishStateStore(db).get(key), { status: 'PUBLISHED', externalPostId: 'douyin-post-1' });
    await first.markUnknown({ ...key, idempotencyKey: 'publisher-state-unknown' });
    assert.deepEqual(await new PostgresPublishStateStore(db).get({ ...key, idempotencyKey: 'publisher-state-unknown' }), { status: 'UNKNOWN_EXTERNAL_STATE' });
  } finally { await db.end(); }
});
