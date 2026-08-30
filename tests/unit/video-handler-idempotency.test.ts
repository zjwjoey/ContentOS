import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoJobHandler } from '../../workers/video-worker/src/video-handler.js';

test('Video Worker returns an already completed Render without rendering again', async () => {
  let updateCalls = 0;
  const handler = createVideoJobHandler({
    db: {} as never,
    storage: { root: 'E:/storage' } as never,
    assets: { importFile: async () => { throw new Error('must not import a second output'); } } as never,
    jobs: {} as never,
    video: {
      planJob: async () => ({ manifestId: 'manifest-1', renderId: 'render-1', manifest: { projectId: 'project-test' }, renderStatus: 'SUCCEEDED', outputAssetId: 'asset-output-1' }),
      updateRender: async () => { updateCalls += 1; },
    } as never,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  });

  const result = await handler({ id: 'job-test', projectId: 'project-test' } as never, 'attempt-test', new AbortController().signal);
  assert.deepEqual(result, { manifestId: 'manifest-1', renderId: 'render-1', outputAssetId: 'asset-output-1' });
  assert.equal(updateCalls, 0);
});

test('Video Worker fails the current Job attempt when Render start is rejected', async () => {
  const handler = createVideoJobHandler({
    db: {} as never,
    storage: { root: 'E:/storage' } as never,
    assets: {} as never,
    jobs: { withCurrentAttemptFence: async () => ({ executed: true, value: false }) } as never,
    video: {
      planJob: async () => ({ manifestId: 'manifest-1', renderId: 'render-1', manifest: { projectId: 'project-test', seed: 1 }, renderStatus: 'QUEUED', outputAssetId: null }),
    } as never,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  });

  await assert.rejects(
    handler({ id: 'job-test-start-rejected', projectId: 'project-test', attemptCount: 1 } as never, 'attempt-current', new AbortController().signal),
    (error: unknown) => (error as { code?: string }).code === 'RENDER_START_REJECTED',
  );
});
