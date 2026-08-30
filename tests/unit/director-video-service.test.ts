import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectorVideoService } from '../../packages/modules/video/src/index.js';

test('Director Video uses one current V1 input instead of a stale pair', async () => {
  let createCalls = 0;
  const oldPair = {
    brief: { id: 'brief-old' },
    script: { id: 'script-old', status: 'ACCEPTED' },
    storyboard: { id: 'storyboard-old', status: 'APPROVED', scenes: [{ durationHintSeconds: 1 }] },
  };
  const director = {
    getCurrentPair: async () => oldPair,
    getProjectSummary: async () => ({ source: 'V1', readyForVideo: false }),
    getCurrentVideoInput: async () => ({ brief: { id: 'brief-new' }, script: null, storyboard: null }),
  };
  const video = { createJob: async () => { createCalls += 1; return { id: 'job-should-not-exist' }; } };

  await assert.rejects(() => new DirectorVideoService(director as never, video as never).createVideoJob('project-test', { videoAssetIds: ['asset-1'] }), /approved Script and Storyboard pair/i);
  assert.equal(createCalls, 0);
});
