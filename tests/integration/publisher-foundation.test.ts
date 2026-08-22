import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateDown, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { PublisherService } from '../../packages/modules/publisher/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

async function fixture(db: Awaited<ReturnType<typeof createDatabase>>) {
  const project = await new ProjectService(db).create(`Publisher Foundation ${randomUUID()}`);
  const assetId = `asset-publisher-${randomUUID()}`;
  await db.query('insert into assets (id, project_id, kind, checksum, byte_size, storage_key, lifecycle, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)', [assetId, project.id, 'VIDEO_RENDER', `sha256:${randomUUID()}`, 100, `renders/${assetId}.mp4`, 'READY', { width: 1080, height: 1920 }]);
  const publisher = new PublisherService(db);
  const account = await publisher.createAccount({ projectId: project.id, platformId: 'fake-platform', displayName: `Fake ${randomUUID()}`, credentialRef: 'fake-credential:account', profileKey: `profile-${randomUUID()}`, status: 'READY', capabilitySnapshot: { platformId: 'fake-platform', mediaTypes: ['video/mp4'], scheduling: true, requiresHumanConfirmation: false } });
  const request = await publisher.createRequest({
    projectId: project.id,
    accountId: account.id,
    idempotencyKey: `publisher-request-${randomUUID()}`,
    correlationId: `correlation-${randomUUID()}`,
    revision: { assetId, assetChecksum: String((await db.query<{ checksum: string }>('select checksum from assets where id = $1', [assetId])).rows[0]?.checksum), title: '测试发布', description: '描述', desiredPublishAt: null, createdBy: 'test' },
  });
  return { publisher, projectId: project.id, assetId, accountId: account.id, request };
}

async function cleanup(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string): Promise<void> {
  await db.query('delete from publisher_external_posts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_attempts where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('update publisher_requests set current_revision_id = null where project_id = $1', [projectId]);
  await db.query('delete from publisher_request_revisions where request_id in (select id from publisher_requests where project_id = $1)', [projectId]);
  await db.query('delete from publisher_requests where project_id = $1', [projectId]);
  await db.query('delete from publisher_accounts where project_id = $1', [projectId]);
  await db.query('delete from project_assets where project_id = $1', [projectId]);
  await db.query('delete from assets where project_id = $1', [projectId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

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

test('Publisher service persists account, immutable revision and stable request idempotency', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    await migrateUp(db);
    const fixtureResult = await fixture(db);
    projectId = fixtureResult.projectId;
    const duplicate = await fixtureResult.publisher.createRequest({
      projectId,
      accountId: fixtureResult.accountId,
      idempotencyKey: fixtureResult.request.request.idempotencyKey,
      correlationId: fixtureResult.request.request.correlationId,
      revision: { ...fixtureResult.request.revision, title: '不同标题' },
    });
    assert.equal(duplicate.request.id, fixtureResult.request.request.id);
    assert.equal(duplicate.revision.id, fixtureResult.request.revision.id);
    assert.equal((await fixtureResult.publisher.getCurrentRevision(fixtureResult.request.request.id))?.title, '测试发布');
    const account = await fixtureResult.publisher.getAccount(projectId, fixtureResult.accountId);
    assert.equal(account?.credentialRef, 'fake-credential:account');
    assert.equal(JSON.stringify(account).includes('password'), false);
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});

test('Publisher service guards transitions, appends attempts and deduplicates external posts', async () => {
  const db = await createDatabase(databaseUrl);
  let projectId = '';
  try {
    await migrateUp(db);
    const fixtureResult = await fixture(db);
    projectId = fixtureResult.projectId;
    const requestId = fixtureResult.request.request.id;
    await fixtureResult.publisher.transitionRequest(requestId, 'SCHEDULED');
    await fixtureResult.publisher.transitionRequest(requestId, 'QUEUED');
    await fixtureResult.publisher.transitionRequest(requestId, 'PUBLISHING');
    assert.throws(() => fixtureResult.publisher.assertTransition('PUBLISHED', 'QUEUED'), /Invalid Publisher request transition/);
    const attempt = await fixtureResult.publisher.startAttempt({ requestId, revisionId: fixtureResult.request.revision.id, operation: 'PUBLISH', jobId: null, jobAttemptId: null });
    await fixtureResult.publisher.finishAttempt(attempt.id, { status: 'SUCCEEDED' });
    const post = await fixtureResult.publisher.recordExternalPost({ requestId, accountId: fixtureResult.accountId, platformId: 'fake-platform', externalPostId: 'fake-post-1', externalUrl: null });
    const duplicatePost = await fixtureResult.publisher.recordExternalPost({ requestId, accountId: fixtureResult.accountId, platformId: 'fake-platform', externalPostId: 'fake-post-1', externalUrl: null });
    assert.equal(duplicatePost.id, post.id);
    assert.equal((await db.query('select count(*)::int as count from publisher_attempts where request_id = $1', [requestId])).rows[0]?.count, 1);
    assert.equal((await db.query('select count(*)::int as count from publisher_external_posts where request_id = $1', [requestId])).rows[0]?.count, 1);
  } finally {
    if (projectId) await cleanup(db, projectId);
    await db.end();
  }
});
