import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { ReviewService } from '../../packages/modules/review/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Review keeps immutable decisions and exposes the current decision', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Review Integration');
  const review = new ReviewService(db);
  try {
    const pending = await review.create({ projectId: project.id, targetType: 'RENDER', targetId: 'render-1', status: 'PENDING', reviewer: 'operator' });
    assert.equal(pending.revision, 1);
    const approved = await review.approve(project.id, 'RENDER', 'render-1', 'lead');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.revision, 2);
    assert.equal((await review.getCurrent(project.id, 'RENDER', 'render-1'))?.status, 'APPROVED');
    assert.deepEqual((await review.list(project.id)).map((item) => item.status), ['PENDING', 'APPROVED']);
    await assert.rejects(() => review.reject(project.id, 'RENDER', 'render-1', 'lead', 'late'), /must be PENDING/);
  } finally {
    await db.query('delete from review_decisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});

test('Review requires a rejection reason and preserves project traceability', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Review Rejection');
  const review = new ReviewService(db);
  try {
    await assert.rejects(() => review.create({ projectId: project.id, targetType: 'PUBLISH', targetId: 'publish-1', status: 'REJECTED', reviewer: 'operator' }), /reason/);
    const pending = await review.create({ projectId: project.id, targetType: 'PUBLISH', targetId: 'publish-1', status: 'PENDING', reviewer: 'operator', evidence: { source: 'fake-publisher' } });
    const rejected = await review.reject(project.id, 'PUBLISH', 'publish-1', 'lead', 'Needs a new caption');
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.projectId, project.id);
    assert.deepEqual(rejected.evidence, { source: 'fake-publisher' });
    assert.equal((await review.getCurrent(project.id, 'PUBLISH', 'publish-1'))?.revision, 2);
    assert.equal(pending.status, 'PENDING');
  } finally {
    await db.query('delete from review_decisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});

test('Review approval is bound to the latest immutable publish snapshot digest', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create('Review Publish Integrity');
  const review = new ReviewService(db);
  const snapshotDigest = 'a'.repeat(64);
  try {
    await review.create({ projectId: project.id, targetType: 'PUBLISH', targetId: 'publish-1', status: 'PENDING', reviewer: 'operator', evidence: { snapshotDigest } });
    const approved = await review.approve(project.id, 'PUBLISH', 'publish-1', 'lead');
    assert.equal(await review.isApprovedForPublishSnapshot({ projectId: project.id, targetId: 'publish-1', reviewDecisionId: approved.id, snapshotDigest }), true);
    assert.equal(await review.isApprovedForPublishSnapshot({ projectId: project.id, targetId: 'publish-1', reviewDecisionId: approved.id, snapshotDigest: 'b'.repeat(64) }), false);
  } finally {
    await db.query('delete from review_decisions where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]);
    await db.end();
  }
});
