import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  buildActions,
  currentApprovalRecords,
  deriveCurrentStage,
  deriveHealth,
  deriveStages,
  ProjectCenterService,
  type ProjectCenterRuleInput,
} from '../../apps/api/src/project-center.js';
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
  assert.equal(stages[0]?.key, 'ASSETS');
  assert.equal(stages[1]?.key, 'DIRECTOR');
  assert.equal(stages[1]?.status, 'COMPLETE');
  assert.equal(stages[1]?.href, '/projects/project-test/director');
  assert.ok(['ASSETS', 'DIRECTOR', 'VIDEO', 'APPROVAL', 'PUBLISHER'].includes(stages[0]?.key || ''));
});

test('current approvals ignore legacy Director editorial rows', () => {
  const records = currentApprovalRecords(
    [
      {
        targetType: 'SCRIPT',
        targetId: 'script-aggregate',
        targetRevisionId: 'script-old',
        status: 'REJECTED',
        revision: 1,
        createdAt: '2026-08-22T00:00:00.000Z',
      },
      {
        targetType: 'SCRIPT',
        targetId: 'script-aggregate',
        targetRevisionId: 'script-current',
        status: 'PENDING',
        revision: 1,
        createdAt: '2026-08-22T00:01:00.000Z',
      },
      {
        targetType: 'STORYBOARD',
        targetId: 'storyboard-aggregate',
        targetRevisionId: 'storyboard-old',
        status: 'REJECTED',
        revision: 1,
        createdAt: '2026-08-22T00:00:00.000Z',
      },
      {
        targetType: 'STORYBOARD',
        targetId: 'storyboard-aggregate',
        targetRevisionId: 'storyboard-current',
        status: 'APPROVED',
        revision: 1,
        createdAt: '2026-08-22T00:01:00.000Z',
      },
    ],
    new Set(),
    null,
    {
      script: { targetId: 'script-aggregate', targetRevisionId: 'script-current' },
      storyboard: { targetId: 'storyboard-aggregate', targetRevisionId: 'storyboard-current' },
    },
  );
  assert.deepEqual(records, []);
});

test('current approvals match the exact current Render target', () => {
  const records = currentApprovalRecords(
    [
      { targetType: 'RENDER', targetId: 'render-old', targetRevisionId: 'asset-old', status: 'REJECTED', revision: 1, createdAt: '2026-08-22T00:00:00.000Z' },
      {
        targetType: 'RENDER',
        targetId: 'render-current',
        targetRevisionId: 'asset-current',
        status: 'PENDING',
        revision: 1,
        createdAt: '2026-08-22T00:01:00.000Z',
      },
    ],
    new Set(),
    'legacy-render',
    {},
    { targetId: 'render-current', targetRevisionId: 'asset-current' },
  );
  assert.deepEqual(
    records.map((record) => record.targetId),
    ['render-current'],
  );
});

test('current approvals ignore Render decisions when no current Render target exists', () => {
  const records = currentApprovalRecords(
    [
      {
        targetType: 'RENDER',
        targetId: 'render-legacy',
        targetRevisionId: 'director-revision',
        status: 'PENDING',
        revision: 1,
        createdAt: '2026-08-22T00:00:00.000Z',
      },
    ],
    new Set(),
    'director-revision',
    {},
  );
  assert.deepEqual(records, []);
});

test('cancelled Publisher requests do not keep their Approval decision current', async () => {
  const center = new ProjectCenterService({
    projects: { get: async () => ({ id: 'project-test', name: 'Test', status: 'DRAFT', updatedAt: '2026-08-23T00:00:00.000Z' }) },
    director: {
      get: async () => ({
        projectId: 'project-test',
        source: 'NONE',
        hasRevision: false,
        readyForVideo: false,
        activeScript: null,
        activeStoryboard: null,
        legacyRevisionId: null,
      }),
    },
    assets: { listPublishable: async () => [] },
    video: { getCurrentRender: async () => null },
    jobs: {
      listProjectSummaries: async () => [],
      listProjectFailedSummaries: async () => [],
      getProjectStateSummary: async () => ({ stateCounts: {}, videoStateCounts: {} }),
    },
    approvals: {
      list: async () => [
        {
          targetType: 'PUBLISH',
          targetId: 'request-cancelled',
          targetRevisionId: 'revision-cancelled',
          status: 'REJECTED',
          revision: 1,
          createdAt: '2026-08-23T00:00:00.000Z',
        },
      ],
    },
    publisher: {
      getProjectSummary: async () => ({
        projectId: 'project-test',
        accountCount: 0,
        requestCount: 1,
        statusCounts: { CANCELLED: 1 },
        confirmedExternalPostCount: 0,
        needsHumanActionCount: 0,
      }),
      listRequests: async () => [{ id: 'request-cancelled', currentRevisionId: 'revision-cancelled', status: 'CANCELLED' }],
    },
  } as never);

  const snapshot = await center.get('project-test');
  assert.ok(snapshot);
  assert.equal(snapshot.health.level, 'HEALTHY');
  assert.equal(snapshot.stages.find((stage) => stage.key === 'APPROVAL')?.status, 'NOT_STARTED');
});

test('project job summaries select only safe fields', async () => {
  let sql = '';
  const db = {
    query: async (statement: string) => {
      sql = statement;
      return {
        rows: [
          {
            id: 'job-1',
            project_id: 'project-test',
            type: 'VIDEO_RENDER',
            state: 'FAILED',
            attempt_count: '2',
            max_attempts: '3',
            created_at: '2026-08-22T00:00:00.000Z',
            payload: { secret: 'must-not-return' },
            error: { token: 'must-not-return' },
          },
        ],
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
  assert.equal(deriveStages({ ...emptyInput, hasApprovedDirector: true, jobs: [{ type: 'VIDEO_RENDER', state: 'FAILED' }] })[2]?.status, 'BLOCKED');
});

test('pending approval requires attention', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'PENDING' };
  assert.equal(deriveHealth(input).level, 'ATTENTION');
  assert.equal(deriveStages(input)[3]?.status, 'ACTION_REQUIRED');
  assert.equal(deriveCurrentStage(deriveStages(input)), 'APPROVAL');
});

test('publisher human action is surfaced as blocked attention', () => {
  const input = {
    ...emptyInput,
    projectStatus: 'READY_TO_PUBLISH',
    hasApprovedDirector: true,
    hasReadyVideo: true,
    approvalStatus: 'APPROVED',
    needsHumanActionCount: 1,
    publisherStatusCounts: { FAILED: 1 },
  };
  assert.equal(deriveHealth(input).level, 'BLOCKED');
  assert.equal(deriveStages(input)[4]?.status, 'ACTION_REQUIRED');
});

test('publisher failure is blocked when no human-action classification exists', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, hasReadyVideo: true, approvalStatus: 'APPROVED', publisherStatusCounts: { FAILED: 1 } };
  assert.equal(deriveStages(input)[4]?.status, 'BLOCKED');
});

test('a failed matrix request is not hidden by another confirmed post', () => {
  const input = {
    ...emptyInput,
    projectStatus: 'PUBLISHED',
    hasApprovedDirector: true,
    hasReadyVideo: true,
    approvalStatus: 'APPROVED',
    publisherStatusCounts: { PUBLISHED: 1, FAILED: 1 },
    hasExternalPost: true,
  };
  assert.equal(deriveHealth(input).level, 'BLOCKED');
  assert.equal(deriveStages(input)[4]?.status, 'BLOCKED');
});

test('a published project with a pending Approval still needs attention', () => {
  const input = { ...emptyInput, projectStatus: 'PUBLISHED', approvalStatus: 'PENDING', approvalStatuses: ['PENDING'] };
  assert.equal(deriveHealth(input).level, 'ATTENTION');
});

test('a published project with an in-flight matrix request still needs attention', () => {
  for (const status of ['QUEUED', 'PUBLISHING', 'RECONCILING']) {
    const input = { ...emptyInput, projectStatus: 'PUBLISHED', publisherStatusCounts: { PUBLISHED: 1, [status]: 1 }, hasExternalPost: true };
    assert.equal(deriveHealth(input).level, 'ATTENTION', status);
  }
});

test('cancelled Publisher history does not make the Publisher stage ready', () => {
  const input = { ...emptyInput, publisherStatusCounts: { CANCELLED: 1 } };
  assert.equal(deriveStages(input)[4]?.status, 'NOT_STARTED');
});

test('Director editorial gates do not create formal Approval decisions', async () => {
  const center = new ProjectCenterService({
    projects: { get: async () => ({ id: 'project-test', name: 'Test', status: 'DRAFT', updatedAt: '2026-08-23T00:00:00.000Z' }) },
    director: {
      get: async () => ({
        projectId: 'project-test',
        source: 'V1',
        hasRevision: true,
        readyForVideo: true,
        activeScript: { aggregateId: 'script-1', revisionId: 'script-revision-1' },
        activeStoryboard: { aggregateId: 'storyboard-1', revisionId: 'storyboard-revision-1' },
        legacyRevisionId: null,
      }),
    },
    assets: { listPublishable: async () => [] },
    video: { getCurrentRender: async () => null },
    jobs: {
      listProjectSummaries: async () => [],
      listProjectFailedSummaries: async () => [],
      getProjectStateSummary: async () => ({ stateCounts: {}, videoStateCounts: {} }),
    },
    approvals: {
      list: async () => [
        {
          targetType: 'SCRIPT',
          targetId: 'script-1',
          targetRevisionId: 'script-revision-1',
          status: 'APPROVED',
          revision: 1,
          createdAt: '2026-08-23T00:00:00.000Z',
        },
      ],
    },
    publisher: {
      getProjectSummary: async () => ({
        projectId: 'project-test',
        accountCount: 0,
        requestCount: 0,
        statusCounts: {},
        confirmedExternalPostCount: 0,
        needsHumanActionCount: 0,
      }),
      listRequests: async () => [],
    },
  } as never);

  const snapshot = await center.get('project-test');
  assert.ok(snapshot);
  assert.equal(snapshot.health.level, 'HEALTHY');
  assert.equal(snapshot.stages.find((stage) => stage.key === 'APPROVAL')?.status, 'NOT_STARTED');
});

test('non-video jobs do not change video stage', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, jobs: [{ type: 'PUBLISH', state: 'FAILED' }] };
  assert.equal(deriveStages(input)[2]?.status, 'NOT_STARTED');
});

test('unresolved historical job counts affect health and video stage', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, jobStateCounts: { FAILED: 1 }, videoJobStateCounts: { FAILED: 1 } };
  assert.equal(deriveHealth(input).level, 'BLOCKED');
  assert.equal(deriveStages(input)[2]?.status, 'BLOCKED');
});

test('current approval statuses do not hide a pending decision behind a newer approved target', () => {
  const input = { ...emptyInput, hasApprovedDirector: true, approvalStatus: 'APPROVED', approvalStatuses: ['APPROVED', 'PENDING'] };
  assert.equal(deriveHealth(input).level, 'ATTENTION');
  assert.equal(deriveStages(input)[3]?.status, 'ACTION_REQUIRED');
});

test('partial service failures expose safe navigation actions', () => {
  const actions = buildActions(
    'project-test',
    { level: 'BLOCKED', reasons: [] },
    null,
    { projectId: 'project-test', accountCount: 0, requestCount: 0, statusCounts: {}, confirmedExternalPostCount: 0, needsHumanActionCount: 0 } as never,
    [],
    ['Approval'],
  );
  assert.equal(actions[0]?.kind, 'NAVIGATION');
  assert.equal(actions[0]?.href, '/projects/project-test');
});

test('Approval source failure does not invent missing current decisions', async () => {
  const center = new ProjectCenterService({
    projects: { get: async () => ({ id: 'project-test', name: 'Test', status: 'DRAFT', updatedAt: '2026-08-23T00:00:00.000Z' }) },
    director: {
      get: async () => ({
        projectId: 'project-test',
        source: 'V1',
        hasRevision: true,
        readyForVideo: true,
        activeScript: { aggregateId: 'script-1', revisionId: 'script-revision-1' },
        activeStoryboard: { aggregateId: 'storyboard-1', revisionId: 'storyboard-revision-1' },
        legacyRevisionId: null,
      }),
    },
    assets: { listPublishable: async () => [] },
    video: { getCurrentRender: async () => null },
    jobs: {
      listProjectSummaries: async () => [],
      listProjectFailedSummaries: async () => [],
      getProjectStateSummary: async () => ({ stateCounts: {}, videoStateCounts: {} }),
    },
    approvals: {
      list: async () => {
        throw new Error('Approval unavailable');
      },
    },
    publisher: {
      getProjectSummary: async () => ({
        projectId: 'project-test',
        accountCount: 0,
        requestCount: 0,
        statusCounts: {},
        confirmedExternalPostCount: 0,
        needsHumanActionCount: 0,
      }),
      listRequests: async () => [],
    },
  } as never);

  const snapshot = await center.get('project-test');
  assert.ok(snapshot);
  assert.equal(snapshot.stages.find((item) => item.key === 'APPROVAL')?.status, 'BLOCKED');
  assert.deepEqual(
    snapshot.actions.filter((action) => action.id.startsWith('approval-missing')),
    [],
  );
  assert.ok(snapshot.actions.some((action) => action.id === 'source-unavailable-Approval'));
});

test('historical READY assets do not make a superseded Render current', async () => {
  const center = new ProjectCenterService({
    projects: { get: async () => ({ id: 'project-test', name: 'Test', status: 'DRAFT', updatedAt: '2026-08-23T00:00:00.000Z' }) },
    director: {
      get: async () => ({
        projectId: 'project-test',
        source: 'NONE',
        hasRevision: false,
        readyForVideo: false,
        activeScript: null,
        activeStoryboard: null,
        legacyRevisionId: null,
      }),
    },
    assets: { listPublishable: async () => [{ id: 'asset-old', projectId: 'project-test', kind: 'VIDEO_RENDER', lifecycle: 'READY' }] },
    video: { getCurrentRender: async () => null },
    jobs: {
      listProjectSummaries: async () => [],
      listProjectFailedSummaries: async () => [],
      getProjectStateSummary: async () => ({ stateCounts: {}, videoStateCounts: {} }),
    },
    approvals: { list: async () => [] },
    publisher: {
      getProjectSummary: async () => ({
        projectId: 'project-test',
        accountCount: 0,
        requestCount: 0,
        statusCounts: {},
        confirmedExternalPostCount: 0,
        needsHumanActionCount: 0,
      }),
      listRequests: async () => [],
    },
  } as never);

  const snapshot = await center.get('project-test');
  assert.ok(snapshot);
  assert.equal(snapshot.stages.find((item) => item.key === 'VIDEO')?.status, 'NOT_STARTED');
});

test('an active Video Job takes precedence over an older ready output', () => {
  const input = { ...emptyInput, hasReadyVideo: true, jobs: [{ type: 'VIDEO_RENDER', state: 'RUNNING' }] };
  assert.equal(deriveStages(input)[2]?.status, 'IN_PROGRESS');
});

test('historical failed jobs remain actionable when outside recent summaries', () => {
  const actions = buildActions(
    'project-test',
    { level: 'BLOCKED', reasons: ['存在失败或阻塞 Job'] },
    null,
    { projectId: 'project-test', accountCount: 0, requestCount: 0, statusCounts: {}, confirmedExternalPostCount: 0, needsHumanActionCount: 0 } as never,
    [],
    [],
    { FAILED: 1 },
  );
  assert.ok(actions.some((action) => action.kind === 'JOB_FAILURE'));
});

test('approval actions preserve pending work when another current approval is rejected', () => {
  const actions = buildActions(
    'project-test',
    { level: 'BLOCKED', reasons: ['当前审批已驳回'] },
    'REJECTED',
    { projectId: 'project-test', accountCount: 0, requestCount: 0, statusCounts: {}, confirmedExternalPostCount: 0, needsHumanActionCount: 0 } as never,
    [],
    [],
    {},
    [],
    ['REJECTED', 'PENDING'],
  );
  const approvalActions = actions.filter((action) => action.kind === 'APPROVAL');
  assert.equal(approvalActions.length, 2);
  assert.ok(approvalActions.some((action) => action.title.includes('待审批')));
  assert.ok(approvalActions.some((action) => action.title.includes('驳回')));
});

test('historical failed job action includes a safe job summary', () => {
  const actions = buildActions(
    'project-test',
    { level: 'BLOCKED', reasons: ['存在失败或阻塞 Job'] },
    null,
    { projectId: 'project-test', accountCount: 0, requestCount: 0, statusCounts: {}, confirmedExternalPostCount: 0, needsHumanActionCount: 0 } as never,
    [],
    [],
    { FAILED: 1 },
    [
      {
        id: 'job-old',
        projectId: 'project-test',
        type: 'VIDEO_RENDER',
        state: 'FAILED',
        attemptCount: 1,
        maxAttempts: 1,
        createdAt: '2026-08-22T00:00:00.000Z',
      },
    ],
  );
  assert.ok(actions.some((action) => action.kind === 'JOB_FAILURE' && action.detail.includes('job-old')));
});

test('render approval actions do not navigate to the Publisher workbench', () => {
  const actions = buildActions(
    'project-test',
    { level: 'ATTENTION', reasons: ['存在待处理审批'] },
    'PENDING',
    { projectId: 'project-test', accountCount: 0, requestCount: 0, statusCounts: {}, confirmedExternalPostCount: 0, needsHumanActionCount: 0 } as never,
    [],
    [],
    {},
    [],
    [],
    [{ targetType: 'RENDER', status: 'PENDING' }],
  );
  const approvalAction = actions.find((action) => action.kind === 'APPROVAL');
  assert.equal(approvalAction?.href, '/projects/project-test/video');
});

test('Project Center route redacts unexpected aggregation errors', async () => {
  const app = Fastify({ logger: false });
  registerProjectCenterRoutes(app, {
    center: {
      get: async () => {
        throw new Error('secret sql detail');
      },
    },
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/projects/project-test/center' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'PROJECT_CENTER_UNAVAILABLE');
  assert.equal(response.body.includes('secret sql detail'), false);
  await app.close();
});

test('published project is complete', () => {
  const input = {
    ...emptyInput,
    projectStatus: 'PUBLISHED',
    hasApprovedDirector: true,
    hasReadyVideo: true,
    approvalStatus: 'APPROVED',
    hasExternalPost: true,
    publisherStatusCounts: { PUBLISHED: 1 },
  };
  assert.equal(deriveHealth(input).level, 'COMPLETE');
  assert.equal(deriveStages(input)[4]?.status, 'COMPLETE');
  assert.equal(deriveCurrentStage(deriveStages(input)), 'PUBLISHER');
});
