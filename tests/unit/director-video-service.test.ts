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
  const video = {
    createJob: async () => {
      createCalls += 1;
      return { id: 'job-should-not-exist' };
    },
  };

  await assert.rejects(
    () => new DirectorVideoService(director as never, video as never).createVideoJob('project-test', { videoAssetIds: ['asset-1'] }),
    /approved Script and Storyboard pair/i,
  );
  assert.equal(createCalls, 0);
});

test('approved Director V1 does not silently fall back to Random Montage', async () => {
  const director = {
    getCurrentVideoInput: async () => ({
      brief: { id: 'brief-1' },
      script: { id: 'script-1', status: 'ACCEPTED' },
      storyboard: { id: 'storyboard-1', status: 'APPROVED', scenes: [{ sceneIndex: 1, durationHintSeconds: 2 }] },
    }),
  };
  const video = { createJob: async () => ({ id: 'job-1' }) };

  await assert.rejects(
    () => new DirectorVideoService(director as never, video as never).createVideoJob('project-1', { videoAssetIds: ['asset-1'] }),
    /scene asset bindings/i,
  );
});
