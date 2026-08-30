import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { AIService } from '../../packages/modules/ai/src/ai-service.js';
import { FakeAIProvider } from '../../packages/modules/ai/src/fake-provider.js';
import { PromptRegistry } from '../../packages/modules/ai/src/prompt-registry.js';
import type { ModelProfile } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';
const profile: ModelProfile = {
  id: 'fake-profile-integration', providerId: 'fake', modelId: 'fake-zh-v1', displayName: 'Fake Chinese V1',
  capabilities: ['TEXT', 'STRUCTURED'], maxInputCharacters: 20_000, maxOutputTokens: 2_000, enabled: true,
};

async function cleanupFixture(db: Awaited<ReturnType<typeof createDatabase>>, projectId: string, jobId: string, attemptId: string): Promise<void> {
  await db.query('delete from ai_runs where project_id = $1', [projectId]);
  await db.query('delete from job_attempts where id = $1', [attemptId]);
  await db.query('delete from jobs where id = $1', [jobId]);
  await db.query('delete from content_projects where id = $1', [projectId]);
}

test('AIService persists a safe successful AI Run with prompt/model provenance', async () => {
  const db = await createDatabase(databaseUrl);
  const projectId = 'project-ai-run-001'; const jobId = 'job-ai-run-001'; const attemptId = 'attempt-ai-run-001';
  try {
    await migrateUp(db);
    await db.query('delete from ai_runs where project_id = $1', [projectId]);
    await db.query('delete from job_attempts where id = $1', [attemptId]);
    await db.query('delete from jobs where id = $1', [jobId]);
    await db.query('delete from content_projects where id = $1', [projectId]);
    await db.query('insert into content_projects (id, status, metadata) values ($1, $2, $3)', [projectId, 'DRAFT', '{}']);
    await db.query('insert into jobs (id, project_id, type, state, idempotency_key, payload) values ($1, $2, $3, $4, $5, $6)', [jobId, projectId, 'DIRECTOR_GENERATE_SCRIPT', 'RUNNING', `${projectId}:ai:1`, '{}']);
    await db.query('insert into job_attempts (id, job_id, attempt_number, worker_id, status) values ($1, $2, 1, $3, $4)', [attemptId, jobId, 'test-worker', 'RUNNING']);
    const service = new AIService(db, new FakeAIProvider(), new PromptRegistry(), profile);
    const result = await service.generateText({
      projectId, jobId, attemptId, correlationId: 'corr-ai-run-001', operation: 'DIRECTOR_GENERATE_SCRIPT',
      promptKey: 'director.script.v1', variables: { topic: '门店经营', coreThesis: '先验证，再扩大投入。' },
    });
    assert.match(result.output, /先验证/);
    const rows = await db.query<{ provider_id: string; model_profile_id: string; prompt_version_id: string; status: string; input_snapshot: Record<string, unknown> }>('select provider_id, model_profile_id, prompt_version_id, status, input_snapshot from ai_runs where id = $1', [result.aiRunId]);
    const catalog = await db.query<{ id: string }>('select id from ai_model_profiles where provider_id = $1 and model_id = $2', [profile.providerId, profile.modelId]);
    assert.equal(rows.rows[0]?.provider_id, 'fake');
    assert.equal(rows.rows[0]?.model_profile_id, catalog.rows[0]?.id);
    assert.equal(rows.rows[0]?.status, 'SUCCEEDED');
    assert.equal((rows.rows[0]?.input_snapshot as Record<string, unknown>).credential, undefined);
  } finally { await cleanupFixture(db, projectId, jobId, attemptId); await db.end(); }
});

test('AIService rejects invalid structured output and records a failed AI Run', async () => {
  const db = await createDatabase(databaseUrl);
  const projectId = 'project-ai-run-002'; const jobId = 'job-ai-run-002'; const attemptId = 'attempt-ai-run-002';
  try {
    await migrateUp(db);
    await db.query('delete from ai_runs where project_id = $1', [projectId]);
    await db.query('delete from job_attempts where id = $1', [attemptId]);
    await db.query('delete from jobs where id = $1', [jobId]);
    await db.query('delete from content_projects where id = $1', [projectId]);
    await db.query('insert into content_projects (id, status, metadata) values ($1, $2, $3)', [projectId, 'DRAFT', '{}']);
    await db.query('insert into jobs (id, project_id, type, state, idempotency_key, payload) values ($1, $2, $3, $4, $5, $6)', [jobId, projectId, 'DIRECTOR_GENERATE_STORYBOARD', 'RUNNING', `${projectId}:ai:1`, '{}']);
    await db.query('insert into job_attempts (id, job_id, attempt_number, worker_id, status) values ($1, $2, 1, $3, $4)', [attemptId, jobId, 'test-worker', 'RUNNING']);
    const service = new AIService(db, new FakeAIProvider(), new PromptRegistry(), profile);
    await assert.rejects(service.generateStructured({
      projectId, jobId, attemptId, correlationId: 'corr-ai-run-002', operation: 'DIRECTOR_GENERATE_STORYBOARD',
      promptKey: 'director.storyboard.v1', variables: { topic: '门店经营', coreThesis: '先验证，再扩大投入。' },
    }, () => { throw new Error('schema rejected'); }), /schema rejected/);
    const rows = await db.query<{ status: string; error: Record<string, unknown> }>('select status, error from ai_runs where job_id = $1', [jobId]);
    assert.equal(rows.rows[0]?.status, 'FAILED');
    assert.equal((rows.rows[0]?.error as Record<string, unknown>).code, 'INVALID_STRUCTURED_OUTPUT');
  } finally { await cleanupFixture(db, projectId, jobId, attemptId); await db.end(); }
});

test('AIService persists Review analysis operation provenance', async () => {
  const db = await createDatabase(databaseUrl);
  const projectId = 'project-ai-run-review-001'; const jobId = 'job-ai-run-review-001'; const attemptId = 'attempt-ai-run-review-001';
  try {
    await migrateUp(db);
    await db.query('delete from ai_runs where project_id = $1', [projectId]);
    await db.query('delete from job_attempts where id = $1', [attemptId]);
    await db.query('delete from jobs where id = $1', [jobId]);
    await db.query('delete from content_projects where id = $1', [projectId]);
    await db.query('insert into content_projects (id, status, metadata) values ($1, $2, $3)', [projectId, 'DRAFT', '{}']);
    await db.query('insert into jobs (id, project_id, type, state, idempotency_key, payload) values ($1, $2, $3, $4, $5, $6)', [jobId, projectId, 'REVIEW_GENERATE_ANALYSIS', 'RUNNING', `${projectId}:review:1`, '{}']);
    await db.query('insert into job_attempts (id, job_id, attempt_number, worker_id, status) values ($1, $2, 1, $3, $4)', [attemptId, jobId, 'review-test-worker', 'RUNNING']);
    const service = new AIService(db, new FakeAIProvider(), new PromptRegistry(), profile);
    const result = await service.generateStructured({ projectId, jobId, attemptId, correlationId: 'corr-review-ai', operation: 'REVIEW_GENERATE_ANALYSIS', promptKey: 'review.analysis.v1', variables: { platformId: 'fake-platform', publishedAt: '2026-08-30T12:00:00.000Z', metrics: '{"plays":100}', history: '[]' } }, (value) => value);
    assert.ok(result.aiRunId);
    const row = await db.query<{ operation: string; prompt_version_id: string }>('select operation, prompt_version_id from ai_runs where id = $1', [result.aiRunId]);
    assert.equal(row.rows[0]?.operation, 'REVIEW_GENERATE_ANALYSIS');
    assert.ok(row.rows[0]?.prompt_version_id);
  } finally { await cleanupFixture(db, projectId, jobId, attemptId); await db.end(); }
});
