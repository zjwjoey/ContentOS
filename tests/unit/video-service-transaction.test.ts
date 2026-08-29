import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoService } from '../../packages/modules/video/src/index.js';

test('Video planning serializes manifest replacement inside a project transaction', async () => {
  const poolQueries: string[] = [];
  const clientQueries: string[] = [];
  let connectCalls = 0;
  const client = {
    query: async (statement: string) => {
      clientQueries.push(statement);
      if (statement.includes('coalesce(max(revision)')) return { rows: [{ revision: 1 }] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  const db = {
    query: async (statement: string) => {
      poolQueries.push(statement);
      if (statement.includes('coalesce(max(revision)')) return { rows: [{ revision: 1 }] };
      return { rows: [] };
    },
    connect: async () => { connectCalls += 1; return client; },
  };
  const assets = {
    listReadySourceAssets: async () => [{ id: 'asset-video', projectId: 'project-video', kind: 'VIDEO' as const, storageKey: 'sources/video.mp4', metadata: { durationMs: 1000 } }],
    getReadySourceAsset: async () => null,
  };
  const storage = { objectPath: (storageKey: string) => 'E:/storage/' + storageKey };
  const video = new VideoService(db as never, storage as never, { create: async () => { throw new Error('not used'); } } as never, assets as never);
  const job = {
    id: 'job-video',
    projectId: 'project-video',
    payload: { projectId: 'project-video', videoAssetIds: ['asset-video'], targetDurationMs: 1000, seed: 1 },
  } as never;

  await video.planJob(job);

  assert.equal(connectCalls, 1);
  assert.equal(poolQueries.filter((statement) => !/insert|update|delete/i.test(statement)).length, 1);
  assert.match(poolQueries.find((statement) => /r\.status = 'SUCCEEDED'/.test(statement)) || '', /r\.status = 'SUCCEEDED'/);
  assert.equal(clientQueries[0], 'begin');
  assert.ok(clientQueries.some((statement) => statement.includes('pg_advisory_xact_lock')));
  assert.equal(clientQueries.at(-1), 'commit');
});

test('Video planning rejects a Job whose payload names another project', async () => {
  let connectCalls = 0;
  const client = {
    query: async (statement: string) => statement.includes('coalesce(max(revision)') ? { rows: [{ revision: 1 }] } : { rows: [] },
    release: () => undefined,
  };
  const db = { connect: async () => { connectCalls += 1; return client; } };
  const assets = {
    listReadySourceAssets: async () => [{ id: 'asset-video', projectId: 'project-payload', kind: 'VIDEO' as const, storageKey: 'sources/video.mp4', metadata: { durationMs: 1000 } }],
    getReadySourceAsset: async () => null,
  };
  const video = new VideoService(db as never, { objectPath: (storageKey: string) => 'E:/storage/' + storageKey } as never, { create: async () => { throw new Error('not used'); } } as never, assets as never);
  const job = { id: 'job-video', projectId: 'project-job', payload: { projectId: 'project-payload', videoAssetIds: ['asset-video'], targetDurationMs: 1000, seed: 1 } } as never;

  await assert.rejects(() => video.planJob(job), /Job project scope/i);
  assert.equal(connectCalls, 0);
});

test('Project Video jobs and renders carry the deterministic project workspace scope', async () => {
  const createInputs: Array<{ workspaceId?: string | null }> = [];
  const statements: string[] = [];
  const db = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('select revision, project_id')) return { rows: [{ revision: 2, project_id: 'project-scope', manifest: { projectId: 'project-scope' }, manifest_digest: null }] };
      if (statement.includes('select r.id as render_id')) return { rows: [] };
      return { rows: [] };
    },
  };
  const jobs = { create: async (input: { workspaceId?: string | null }) => { createInputs.push(input); return { id: 'job-1', workspaceId: input.workspaceId } as never; } };
  const service = new VideoService(db as never, { create: jobs.create } as never);
  await service.createManifestRenderJob('project-scope', 'manifest-scope');
  assert.ok(statements.some((statement) => statement.includes('insert into video_workspaces')));
  assert.deepEqual(createInputs.map((input) => input.workspaceId), ['workspace-project-project-scope']);
});
