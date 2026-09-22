import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { ProductionRunService } from '../../packages/modules/production-run/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test';

test('production run is durable, resumable, idempotent, retryable and cancellable', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create(`Production ${randomUUID()}`);
  try {
    const service = new ProductionRunService(db);
    const first = await service.create({ projectId: project.id, title: '闭环短视频', digitalHumanMode: 'NONE', idempotencyKey: 'same-click' });
    assert.equal(first.steps.length, 10); assert.equal(first.steps.find((step) => step.stage === 'DIGITAL_HUMAN')?.status, 'SKIPPED');
    const duplicate = await service.create({ projectId: project.id, title: '不应重复', idempotencyKey: 'same-click' }); assert.equal(duplicate.id, first.id);
    const running = await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'RUNNING', outputRefs: { contentId: 'content-1' } }); assert.equal(running.status, 'RUNNING');
    const failed = await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'FAILED', errorCode: 'DOMAIN_JOB_FAILED', errorMessage: 'temporary' }); assert.equal(failed.status, 'FAILED');
    const retried = await service.retry(project.id, first.id, 'CONTENT'); assert.equal(retried.steps[0]?.status, 'PENDING');
    await service.updateStep(project.id, first.id, { stage: 'CONTENT', status: 'SUCCEEDED', outputRefs: { contentId: 'content-1' } });
    const reloaded = new ProductionRunService(db); const resumed = await reloaded.get(project.id, first.id); assert.equal(resumed?.trace.contentId, 'content-1');
    const cancelled = await reloaded.cancel(project.id, first.id); assert.equal(cancelled.status, 'CANCELLED'); assert.ok(cancelled.steps.every((step) => ['SUCCEEDED', 'SKIPPED', 'CANCELLED'].includes(step.status)));
  } finally { await db.query('delete from content_projects where id=$1', [project.id]); await db.end(); }
});

test('production refs reject unknown domain data and approval bypass is explicit', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db); const project = await new ProjectService(db).create(`Production ${randomUUID()}`);
  try { const service = new ProductionRunService(db); await assert.rejects(() => service.create({ projectId: project.id, title: '非法', approvalRequired: true, approvalBypassed: true }), /PRODUCTION_APPROVAL_BYPASS/); const run = await service.create({ projectId: project.id, title: '合法', approvalRequired: false, approvalBypassed: true }); await assert.rejects(() => service.updateStep(project.id, run.id, { stage: 'CONTENT', status: 'RUNNING', outputRefs: { secretPayload: 'nope' } }), /PRODUCTION_REF_KEY_INVALID/); }
  finally { await db.query('delete from content_projects where id=$1', [project.id]); await db.end(); }
});
