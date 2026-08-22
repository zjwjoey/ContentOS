import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateDown, migrateUp } from '../../packages/database/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';

test('database migrations create the first vertical-slice schema and are idempotent', async () => {
  const db = await createDatabase(databaseUrl);
  try {
    const first = await migrateUp(db);
    const second = await migrateUp(db);
    assert.ok(first.applied >= 0);
    assert.equal(second.applied, 0);
    const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('content_projects','assets','jobs','job_attempts','job_dependencies','edit_manifests','publisher_publication_states','renders') order by table_name");
    assert.deepEqual(tables.rows.map((row) => row.table_name), ['assets', 'content_projects', 'edit_manifests', 'job_attempts', 'job_dependencies', 'jobs', 'publisher_publication_states', 'renders']);
  } finally {
    await db.end();
  }
});

test('project, asset, job and manifest records retain project traceability', async () => {
  const db = await createDatabase(databaseUrl);
  try {
    await migrateUp(db);
    const projectId = 'project-test-001';
    const assetId = 'asset-test-001';
    const jobId = 'job-test-001';
    await db.query('delete from renders where project_id = $1', [projectId]);
    await db.query('delete from edit_manifests where project_id = $1', [projectId]);
    await db.query('delete from project_assets where project_id = $1', [projectId]);
    await db.query('delete from assets where project_id = $1', [projectId]);
    await db.query('delete from jobs where project_id = $1', [projectId]);
    await db.query('delete from content_projects where id = $1', [projectId]);
    await db.query('insert into content_projects (id, status, metadata) values ($1, $2, $3)', [projectId, 'DRAFT', '{}']);
    await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, projectId, 'VIDEO', 'sha256:test', 10, 'staging/test', 'STAGED', '{}']);
    await db.query('insert into jobs (id, project_id, type, state, idempotency_key, payload) values ($1, $2, $3, $4, $5, $6)', [jobId, projectId, 'video.render', 'QUEUED', 'project-test-001:video.render:1', '{}']);
    await db.query('insert into edit_manifests (id, project_id, revision, schema_version, manifest, status) values ($1, $2, $3, $4, $5, $6)', ['manifest-test-001', projectId, 1, 'EDIT_MANIFEST_V0', '{}', 'PERSISTED']);
    const result = await db.query<{ count: string }>('select count(*)::text as count from jobs where project_id = $1', [projectId]);
    assert.equal(result.rows[0]?.count, '1');
  } finally {
    await db.end();
  }
});

test('migration down removes the latest migration and up restores it', async () => {
  const db = await createDatabase(databaseUrl);
  try {
    await migrateUp(db);
    const down = await migrateDown(db);
    assert.equal(down.removed, 1);
    const restored = await migrateUp(db);
    assert.equal(restored.applied, 1);
  } finally {
    await db.end();
  }
});
