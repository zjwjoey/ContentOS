import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateDown, migrateUp } from '../../packages/database/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Publisher foundation migration creates bounded tables and constraints', async () => {
  const db = await createDatabase(databaseUrl);
  try {
    await migrateUp(db);
    const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'publisher_%' order by table_name");
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'publisher_accounts', 'publisher_attempts', 'publisher_external_posts', 'publisher_request_revisions', 'publisher_requests',
    ]);
    const constraints = await db.query<{ constraint_name: string }>("select constraint_name from information_schema.table_constraints where table_schema = 'public' and constraint_name in ('publisher_accounts_project_platform_name_key', 'publisher_requests_idempotency_key', 'publisher_request_revisions_request_revision_key', 'publisher_external_posts_account_external_key') order by constraint_name");
    assert.deepEqual(constraints.rows.map((row) => row.constraint_name), [
      'publisher_accounts_project_platform_name_key', 'publisher_external_posts_account_external_key', 'publisher_request_revisions_request_revision_key', 'publisher_requests_idempotency_key',
    ]);
  } finally {
    await db.end();
  }
});

test('Publisher foundation migration down and up restores the latest schema', async () => {
  const db = await createDatabase(databaseUrl);
  try {
    await migrateUp(db);
    const down = await migrateDown(db);
    assert.equal(down.removed, 1);
    const removed = await db.query("select to_regclass('public.publisher_requests') as table_name");
    assert.equal(removed.rows[0]?.table_name, null);
    const restored = await migrateUp(db);
    assert.equal(restored.applied, 1);
    const present = await db.query("select to_regclass('public.publisher_requests') as table_name");
    assert.equal(present.rows[0]?.table_name, 'publisher_requests');
  } finally {
    await db.end();
  }
});
