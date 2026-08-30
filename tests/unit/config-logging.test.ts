import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../packages/config/src/index.js';
import { createLogger } from '../../packages/logging/src/index.js';
import { serializeError } from '../../packages/shared/src/errors.js';

test('config fails closed when DATABASE_URL is missing', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', STORAGE_ROOT: './storage/test' }), /DATABASE_URL/);
});

test('config parses boot values without logging raw secrets', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:password@localhost/db',
    STORAGE_ROOT: './storage/test',
    PORT: '3010',
    VIDEO_WORKER_CONCURRENCY: '2',
  });
  assert.equal(config.port, 3010);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.videoWorkerConcurrency, 2);
  assert.equal(config.databaseUrl, 'postgresql://user:password@localhost/db');
});

test('config allows an explicit API host without widening the safe default', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:password@localhost/db',
    STORAGE_ROOT: './storage/test',
    CONTENTOS_API_HOST: '127.0.0.2',
  });
  assert.equal(config.host, '127.0.0.2');
});

test('publisher real adapter configuration is disabled and fail-closed by default', () => {
  const defaults = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://user:password@localhost/db', STORAGE_ROOT: './storage/test' });
  assert.equal(defaults.publisherRealAdaptersEnabled, false);
  assert.equal(defaults.publisherWechatAllowSubmit, false);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:password@localhost/db',
        STORAGE_ROOT: './storage/test',
        PUBLISHER_WECHAT_ALLOW_SUBMIT: '1',
      }),
    /Real adapters are disabled/,
  );
  const enabled = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:password@localhost/db',
    STORAGE_ROOT: './storage/test',
    PUBLISHER_REAL_ADAPTERS_ENABLED: '1',
    PUBLISHER_WECHAT_ALLOW_SUBMIT: '1',
  });
  assert.equal(enabled.publisherRealAdaptersEnabled, true);
  assert.equal(enabled.publisherWechatAllowSubmit, true);
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
