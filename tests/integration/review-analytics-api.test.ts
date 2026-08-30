import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Review Analytics API validates input and exposes project-scoped routes', async () => {
  const db = await createDatabase(databaseUrl);
  const app = await buildApi(db);
  try {
    await migrateUp(db);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/projects/missing/reviews/analytics' });
    assert.equal(missing.statusCode, 404);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project/reviews/analytics/posts/post/analyze',
      payload: { metricSnapshotIds: [] },
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal((invalid.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
    await db.end();
  }
});
