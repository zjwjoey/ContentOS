import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildActions, deriveCurrentStage, deriveHealth, deriveStages, type ProjectCenterRuleInput } from '../../apps/api/src/project-center.js';
import { JobService } from '../../packages/modules/job/src/index.js';
import { registerProjectCenterRoutes } from '../../apps/api/src/project-center-routes.js';

const emptyInput: ProjectCenterRuleInput = {
  projectId: 'project-test',
  projectStatus: 'DRAFT',
  hasDirectorRevision: false,
  hasApprovedDirector: false,
  hasReadyVideo: false,
  videoJobStates: [],
  approvalStatus: null,
  publisherStatusCounts: {},
  needsHumanActionCount: 0,
  hasExternalPost: false,
  jobs: [],
};

test('empty project is healthy and starts at Director', () => {
  assert.equal(deriveHealth(emptyInput).level, 'HEALTHY');
  assert.deepEqual(deriveHealth(emptyInput).reasons, []);
  assert.equal(deriveStages(emptyInput)[0]?.status, 'NOT_STARTED');
});

test('project center contract exposes stable stage and action values', () => {
  const stages = deriveStages({ ...emptyInput, hasDirectorRevision: true, hasApprovedDirector: true });
  assert.equal(stages[0]?.key, 'DIRECTOR');
  assert.equal(stages[0]?.status, 'COMPLETE');
  assert.equal(stages[0]?.href, '/projects/project-test/director');
  assert.ok(['DIRECTOR', 'VIDEO', 'APPROVAL', 'PUBLISHER'].includes(stages[0]?.key || ''));
});

test('project job summaries select only safe fields', async () => {
  let sql = '';
  const db = {
    query: async (statement: string) => {
      sql = statement;
      return {
        rows: [{
          id: 'job-1',
          project_id: 'project-test',
          type: 'VIDEO_RENDER',
          state: 'FAILED',
          attempt_count: '2',
          max_attempts: '3',
          created_at: '2026-08-22T00:00:00.000Z',
          payload: { secret: 'must-not-return' },
          error: { token: 'must-not-return' },
        }],
      };
    },
  } as never;
  const summary = await new JobService(db).listProjectSummaries('project-test');
  assert.match(sql, /select id, project_id, type, state, attempt_count, max_attempts, created_at/i);
  assert.equal(summary[0]?.id, 'job-1');
  assert.equal('payload' in (summary[0] || {}), false);
  assert.equal('error' in (summary[0] || {}), false);
});

test('failed render job blocks project health', () => {
  const result = deriveHealth({ ...emptyInput, hasApprovedDirector: true, jobs: [{ type: 'VIDEO_RENDER', state: 'FAILED' }] });
  assert.equal(result.level, 'BLOCKED');
  assert.match(result.reasons.join(' '), /失败/);
  assert.equal(deriveStages({ ...emptyInput, hasApprovedDirector: true, jobs: [{ type: 'VIDEO_RENDER', state: 'FAILED' }] })[1]?.status, 'BLOCKED');
});

test('pending approval requires attention', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'PENDING' };
  assert.equal(deriveHealth(input).level, 'ATTENTION');
  assert.equal(deriveStages(input)[2]?.status, 'ACTION_REQUIRED');
  assert.equal(deriveCurrentStage(deriveStages(input)), 'APPROVAL');
});

test('publisher human action is surfaced as blocked attention', () => {
  const input = { ...emptyInput, projectStatus: 'READY_TO_PUBLISH', hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'APPROVED', needsHumanActionCount: 1, publisherStatusCounts: { FAILED: 1 } };
  assert.equal(deriveHealth(input).level, 'BLOCKED');
  assert.equal(deriveStages(input)[3]?.status, 'ACTION_REQUIRED');
});

test('publisher failure is blocked when no human-action classification exists', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'APPROVED', publisherStatusCounts: { FAILED: 1 } };
  assert.equal(deriveStages(input)[3]?.status, 'BLOCKED');
});

test('non-video jobs do not change video stage', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, jobs: [{ type: 'PUBLISH', state: 'FAILED' }] };
  assert.equal(deriveStages(input)[1]?.status, 'NOT_STARTED');
});

test('unresolved historical job counts affect health and video stage', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, jobStateCounts: { FAILED: 1 }, videoJobStateCounts: { FAILED: 1 } };
  assert.equal(deriveHealth(input).level, 'BLOCKED');
  assert.equal(deriveStages(input)[1]?.status, 'BLOCKED');
});

test('current approval statuses do not hide a pending decision behind a newer approved target', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, approvalStatus: 'APPROVED', approvalStatuses: ['APPROVED', 'PENDING'] };
  assert.equal(deriveHealth(input).level, 'ATTENTION');
  assert.equal(deriveStages(input)[2]?.status, 'ACTION_REQUIRED');
});

test('partial service failures expose safe navigation actions', () => {
  const actions = buildActions('project-test', { level: 'BLOCKED', reasons: [] }, null, { projectId: 'project-test', accountCount: 0, requestCount: 0, statusCounts: {}, confirmedExternalPostCount: 0, needsHumanActionCount: 0 } as never, [], ['Approval']);
  assert.equal(actions[0]?.kind, 'NAVIGATION');
  assert.equal(actions[0]?.href, '/projects/project-test');
});

test('Project Center route redacts unexpected aggregation errors', async () => {
  const app = Fastify({ logger: false });
  registerProjectCenterRoutes(app, { center: { get: async () => { throw new Error('secret sql detail'); } } });
  const response = await app.inject({ method: 'GET', url: '/api/v1/projects/project-test/center' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'PROJECT_CENTER_UNAVAILABLE');
  assert.equal(response.body.includes('secret sql detail'), false);
  await app.close();
});

test('published project is complete', () => {
  const input = { ...emptyInput, projectStatus: 'PUBLISHED', hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'APPROVED', hasExternalPost: true, publisherStatusCounts: { PUBLISHED: 1 } };
  assert.equal(deriveHealth(input).level, 'COMPLETE');
  assert.equal(deriveStages(input)[3]?.status, 'COMPLETE');
  assert.equal(deriveCurrentStage(deriveStages(input)), 'PUBLISHER');
});
