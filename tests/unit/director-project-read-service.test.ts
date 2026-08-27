import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectorProjectReadService } from '../../packages/modules/director/src/director-project-read-service.js';

test('Director project read uses the legacy aggregate only when V1 has no state', async () => {
  const legacy = {
    list: async () => [{ id: 'legacy-brief', projectId: 'project-test', status: 'ACTIVE', createdAt: '2026-08-23T00:00:00.000Z' }],
    getCurrent: async () => ({ id: 'legacy-script', status: 'APPROVED' }),
  } as never;
  const v1 = { getProjectSummary: async () => null } as never;

  const summary = await new DirectorProjectReadService(v1, legacy).get('project-test');

  assert.equal(summary?.source, 'LEGACY');
  assert.equal(summary?.hasRevision, true);
  assert.equal(summary?.readyForVideo, true);
});

test('Director project read prefers V1 and does not hide V1 failures with legacy data', async () => {
  let legacyCalled = false;
  const legacy = {
    list: async () => { legacyCalled = true; return []; },
    getCurrent: async () => { legacyCalled = true; return null; },
  } as never;
  const v1 = {
    getProjectSummary: async () => ({
      projectId: 'project-test', source: 'V1' as const, hasRevision: true, readyForVideo: true,
      currentScript: { targetId: 'script-1', targetRevisionId: 'script-revision-1' },
      currentStoryboard: { targetId: 'storyboard-1', targetRevisionId: 'storyboard-revision-1' },
    }),
  } as never;

  const summary = await new DirectorProjectReadService(v1, legacy).get('project-test');
  assert.equal(summary?.source, 'V1');
  assert.equal(legacyCalled, false);

  const failingV1 = { getProjectSummary: async () => { throw new Error('database unavailable'); } } as never;
  await assert.rejects(() => new DirectorProjectReadService(failingV1, legacy).get('project-test'), /database unavailable/);
  assert.equal(legacyCalled, false);
});
