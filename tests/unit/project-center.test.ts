import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCurrentStage, deriveHealth, deriveStages, type ProjectCenterRuleInput } from '../../apps/api/src/project-center.js';
import { JobService } from '../../packages/modules/job/src/index.js';

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

test('published project is complete', () => {
  const input = { ...emptyInput, projectStatus: 'PUBLISHED', hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'APPROVED', hasExternalPost: true, publisherStatusCounts: { PUBLISHED: 1 } };
  assert.equal(deriveHealth(input).level, 'COMPLETE');
  assert.equal(deriveStages(input)[3]?.status, 'COMPLETE');
  assert.equal(deriveCurrentStage(deriveStages(input)), 'PUBLISHER');
});
