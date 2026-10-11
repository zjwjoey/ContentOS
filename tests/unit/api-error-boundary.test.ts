import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildApi } from '../../apps/api/src/app.js';

test('API error envelopes expose a unique correlation identity without credentials', async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const app = await buildApi(db);
  app.get('/test-failure', async () => { throw new Error('provider timeout password=fixture-secret'); });
  try {
    const first = await app.inject({ method: 'GET', url: '/test-failure', headers: { 'x-correlation-id': 'untrusted-input' } });
    const second = await app.inject({ method: 'GET', url: '/test-failure' });
    assert.equal(first.statusCode, 500);
    assert.doesNotMatch(first.body, /fixture-secret/);
    const correlation = first.json().error.correlationId;
    assert.ok(correlation && correlation !== 'api' && correlation !== 'untrusted-input');
    assert.equal(first.headers['x-correlation-id'], correlation);
    assert.notEqual(second.json().error.correlationId, correlation);
  } finally { await app.close(); }
});

test('malformed JSON remains a client validation error with a correlation identity', async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  const app = await buildApi(db);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.equal(response.headers['x-correlation-id'], response.json().error.correlationId);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: {} });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.headers['x-correlation-id'], invalid.json().error.correlationId);
  } finally { await app.close(); }
});
