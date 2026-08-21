import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../packages/config/src/index.js';
import { createLogger } from '../../packages/logging/src/index.js';
import { serializeError } from '../../packages/shared/src/errors.js';

test('config fails closed when DATABASE_URL is missing', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', STORAGE_ROOT: './storage/test' }), /DATABASE_URL/);
});

test('config parses boot values without logging raw secrets', () => {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://user:password@localhost/db', STORAGE_ROOT: './storage/test', PORT: '3010', VIDEO_WORKER_CONCURRENCY: '2' });
  assert.equal(config.port, 3010);
  assert.equal(config.videoWorkerConcurrency, 2);
  assert.equal(config.databaseUrl, 'postgresql://user:password@localhost/db');
});

test('structured logger redacts password, token, cookie and authorization values', () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info('publish.started', { projectId: 'project-1', token: 'secret-token', cookie: 'session-cookie', authorization: 'Bearer secret' });
  const output = lines.join('\n');
  assert.doesNotMatch(output, /secret-token|session-cookie|Bearer secret/);
  assert.match(output, /REDACTED/);
  assert.match(output, /project-1/);
});

test('errors serialize into safe stable envelopes', () => {
  const result = serializeError(new Error('database password=secret'), 'InfrastructureError', 'corr-1');
  assert.deepEqual(result, { code: 'INFRASTRUCTURE_ERROR', message: 'database password=secret', correlationId: 'corr-1', details: [] });
});
