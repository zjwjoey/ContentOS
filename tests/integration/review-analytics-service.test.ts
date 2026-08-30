import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { ReviewAnalyticsService } from '../../packages/modules/review/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Review Analytics jobs are project scoped and idempotent', async () => {
  const db = await createDatabase(databaseUrl);
  const projectId = `review-service-${randomUUID()}`;
  const postId = `external-post-${randomUUID()}`;
  try {
    await migrateUp(db);
    await db.query("insert into content_projects (id, status) values ($1, 'DRAFT')", [projectId]);
    const analytics = new ReviewAnalyticsService(db, new JobService(db), {
      async getExternalPost(project, externalPost) {
        return project === projectId && externalPost === postId
          ? {
              id: postId,
              requestId: 'request',
              accountId: 'account',
              platformId: 'fake-platform',
              externalPostId: 'external-id',
              externalUrl: null,
              firstObservedAt: new Date().toISOString(),
              lastReconciledAt: null,
            }
          : null;
      },
    });
    const input = {
      projectId,
      externalPostId: postId,
      source: 'FAKE' as const,
      idempotencyKey: `review-collect-${randomUUID()}`,
      correlationId: `corr-${randomUUID()}`,
    };
    const first = await analytics.createMetricCollectionJob(input);
    const second = await analytics.createMetricCollectionJob(input);
    assert.equal(second.id, first.id);
    await assert.rejects(() => analytics.createMetricCollectionJob({ ...input, externalPostId: `${postId}-other` }), /ExternalPost not found|idempotency/i);
  } finally {
    await db.query('delete from jobs where project_id = $1', [projectId]);
    await db.query('delete from content_projects where id = $1', [projectId]);
    await db.end();
  }
});
