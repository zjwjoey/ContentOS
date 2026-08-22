import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveHealth, deriveStages, type ProjectCenterRuleInput } from '../../apps/api/src/project-center.js';

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
