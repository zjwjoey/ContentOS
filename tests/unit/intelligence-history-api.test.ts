import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerIntelligentEditingRoutes } from '../../apps/api/src/intelligent-editing-routes.js';

test('analysis history validates bounded pagination and only enriches matching persisted Jobs', async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  const dependencies = {
    projects: { get: async (id: string) => id === 'project-1' ? { id } : null },
    intelligence: { listRuns: async (...args: unknown[]) => {
      calls.push(args);
      return { items: [{ id: 'run-1', projectId: 'project-1', jobId: 'job-1', status: 'RUNNING' }, { id: 'run-2', projectId: 'project-1', jobId: 'foreign-job', status: 'QUEUED' }], nextCursor: 'cursor-fixture' };
    } },
    jobs: { get: async (id: string) => ({ id, type: 'MEDIA_ANALYSIS', projectId: id === 'job-1' ? 'project-1' : 'project-2', state: 'RETRY_WAIT', progress: 42, error: null, payload: { runId: id === 'job-1' ? 'run-1' : 'run-2' } }) },
  } as unknown as Parameters<typeof registerIntelligentEditingRoutes>[1];
  registerIntelligentEditingRoutes(app, dependencies);
  try {
    const response = await app.inject('/api/v1/projects/project-1/intelligence/analyses?limit=2');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [['project-1', { limit: 2 }]]);
    assert.equal(response.json().items[0].jobState, 'RETRY_WAIT');
    assert.equal(response.json().items[0].progress, 42);
    assert.equal(response.json().items[1].jobState, null);
    assert.equal(response.json().nextCursor, 'cursor-fixture');
    assert.equal((await app.inject('/api/v1/projects/project-1/intelligence/analyses?limit=101')).statusCode, 422);
    assert.equal((await app.inject('/api/v1/projects/project-1/intelligence/analyses?cursor=garbage')).statusCode, 422);
    assert.equal((await app.inject('/api/v1/projects/project-2/intelligence/analyses')).statusCode, 404);
  } finally { await app.close(); }
});
