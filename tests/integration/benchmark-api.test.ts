import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { buildApi } from '../../apps/api/src/app.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev@127.0.0.1:55432/contentos_dev';

test('Benchmark API creates project-scoped account/content, queues analysis and attaches reference', async () => {
  const db = await createDatabase(databaseUrl);
  await migrateUp(db);
  const project = await new ProjectService(db).create(`Benchmark API ${randomUUID()}`);
  const app = await buildApi(db);
  try {
    const accountResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/benchmarks/accounts`, payload: { platform: 'DOUYIN', accountName: '样例账号', positioning: '效率工具', category: '科技', keywords: ['效率', '工具'], notes: '' } });
    assert.equal(accountResponse.statusCode, 201);
    const account = accountResponse.json();
    assert.equal(account.accountName, '样例账号');
    const contentResponse = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/benchmarks/contents`, payload: { benchmarkAccountId: account.id, platform: 'DOUYIN', title: '三秒抓住注意力', copy: '开头先给结论，再解释原因。', notes: '' } });
    assert.equal(contentResponse.statusCode, 201);
    const content = contentResponse.json();
    const queued = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/benchmarks/contents/${content.id}/analyze`, payload: { idempotencyKey: `benchmark-api-${randomUUID()}`, correlationId: 'benchmark-api-test' } });
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().state, 'QUEUED');
    const attached = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/benchmarks/contents/${content.id}/reference` });
    assert.equal(attached.statusCode, 204);
    const references = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/benchmarks/references` });
    assert.equal(references.statusCode, 200);
    assert.equal(references.json().items[0].id, content.id);
  } finally { await app.close(); await db.end(); }
});
