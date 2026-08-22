import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDatabase, migrateUp } from '../../packages/database/src/index.js';
import { ProjectService } from '../../packages/modules/project/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/director-v1-service.js';
import { DirectorJobService, DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD } from '../../packages/modules/director/src/director-job-service.js';
import { AIService } from '../../packages/modules/ai/src/ai-service.js';
import { FakeAIProvider } from '../../packages/modules/ai/src/fake-provider.js';
import { PromptRegistry } from '../../packages/modules/ai/src/prompt-registry.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { createDirectorWorker, type DirectorWorkerDependencies } from '../../workers/director-worker/src/main.js';
import { createDirectorDevRunner } from '../../workers/director-worker/src/dev-main.js';
import type { ModelProfile } from '../../packages/contracts/src/index.js';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://contentos_dev:change-me@127.0.0.1:55432/contentos_dev';
const profile: ModelProfile = { id: 'fake-profile-worker', providerId: 'fake', modelId: 'fake-zh-v1', displayName: 'Fake Worker', capabilities: ['TEXT', 'STRUCTURED'], maxInputCharacters: 20_000, maxOutputTokens: 2_000, enabled: true };
const briefInput = { topic: '门店经营', targetPlatform: 'douyin', channelPositioning: '经营知识栏目', targetDurationSeconds: 45, contentType: 'knowledge', audience: '小微商家', coreThesis: '先验证，再扩大投入。', tone: '清晰', referenceMaterial: '访谈笔记', mustInclude: ['反例'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'operator' };

test('Director worker fails closed without explicit composition and registers only two handlers', () => {
  assert.throws(() => createDirectorWorker(), /explicit Director worker dependencies/);
  const fake = {} as DirectorWorkerDependencies;
  const worker = createDirectorWorker(fake);
  assert.deepEqual(worker.handlerTypes(), [DIRECTOR_GENERATE_SCRIPT, DIRECTOR_GENERATE_STORYBOARD]);
});

test('development Director composition does not trigger the production fail-closed guard', async () => {
  const source = await readFile('workers/director-worker/src/main.ts', 'utf8');
  assert.match(source, /basename\(process\.argv\[1\]/);
});

test('Director jobs enqueue work and worker creates idempotent Script and Storyboard revisions', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director Worker Integration');
  const director = new DirectorV1Service(db); const jobs = new JobService(db); const jobService = new DirectorJobService(jobs);
  try {
    const brief = await director.createBrief(project.id, briefInput);
    const script = await director.createScript(project.id, brief.id);
    const dependencies: DirectorWorkerDependencies = { jobs, director, ai: new AIService(db, new FakeAIProvider(), new PromptRegistry(), profile), modelProfile: profile };
    const worker = createDirectorWorker(dependencies);
    await worker.start();
    const scriptJob = await jobService.createScriptGeneration({ projectId: project.id, briefId: brief.id, scriptAggregateId: script.id, correlationId: 'corr-worker-script' });
    assert.equal((await jobs.get(scriptJob.id))?.state, 'QUEUED');
    const firstRun = await worker.execute(DIRECTOR_GENERATE_SCRIPT, { jobId: scriptJob.id });
    assert.equal((firstRun as { state: string }).state, 'SUCCEEDED');
    const revisions = await director.listScriptRevisions(project.id); assert.equal(revisions.length, 1); assert.equal(revisions[0]?.sourceJobId, scriptJob.id);
    const secondRun = await worker.execute(DIRECTOR_GENERATE_SCRIPT, { jobId: scriptJob.id }); assert.equal((secondRun as { state: string }).state, 'SUCCEEDED');
    assert.equal((await director.listScriptRevisions(project.id)).length, 1);
    const accepted = await director.acceptScript(project.id, revisions[0]!.id); const storyboard = await director.createStoryboard(project.id);
    const boardJob = await jobService.createStoryboardGeneration({ projectId: project.id, scriptRevisionId: accepted.id, storyboardAggregateId: storyboard.id, correlationId: 'corr-worker-storyboard' });
    const boardRun = await worker.execute(DIRECTOR_GENERATE_STORYBOARD, { jobId: boardJob.id }); assert.equal((boardRun as { state: string }).state, 'SUCCEEDED');
    const boards = await director.listStoryboardRevisions(project.id); assert.equal(boards.length, 1); assert.equal(boards[0]?.scriptRevisionId, accepted.id);
  } finally {
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_storyboard_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_storyboards where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from ai_runs where project_id = $1', [project.id]);
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});

test('local Director runner polls queued Jobs and completes Script generation', async () => {
  const db = await createDatabase(databaseUrl); await migrateUp(db);
  const project = await new ProjectService(db).create('Director Worker Polling');
  const director = new DirectorV1Service(db); const jobs = new JobService(db); const jobService = new DirectorJobService(jobs);
  const dependencies: DirectorWorkerDependencies = { jobs, director, ai: new AIService(db, new FakeAIProvider(), new PromptRegistry(), profile), modelProfile: profile };
  const runner = createDirectorDevRunner(dependencies, { pollIntervalMs: 10 });
  try {
    const brief = await director.createBrief(project.id, briefInput);
    const script = await director.createScript(project.id, brief.id);
    const scriptJob = await jobService.createScriptGeneration({ projectId: project.id, briefId: brief.id, scriptAggregateId: script.id, correlationId: 'corr-worker-polling' });
    await runner.start();
    const deadline = Date.now() + 2_000;
    let state = await jobs.get(scriptJob.id);
    while (state?.state !== 'SUCCEEDED' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await jobs.get(scriptJob.id);
    }
    assert.equal(state?.state, 'SUCCEEDED');
    assert.equal((await director.listScriptRevisions(project.id)).length, 1);
  } finally {
    await runner.stop();
    await db.query('delete from director_project_state where project_id = $1', [project.id]);
    await db.query('delete from director_script_revisions where project_id = $1', [project.id]);
    await db.query('delete from director_scripts where project_id = $1', [project.id]);
    await db.query('delete from director_briefs where project_id = $1', [project.id]);
    await db.query('delete from ai_runs where project_id = $1', [project.id]);
    await db.query('delete from job_events where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from job_attempts where job_id in (select id from jobs where project_id = $1)', [project.id]);
    await db.query('delete from jobs where project_id = $1', [project.id]);
    await db.query('delete from content_projects where id = $1', [project.id]); await db.end();
  }
});
