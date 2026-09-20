import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTestDatabaseReset } from '../../scripts/test-database-safety.js';

const testUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/contentos_test';
const valid = (overrides: Parameters<typeof validateTestDatabaseReset>[0] = {}) => validateTestDatabaseReset({
  databaseUrl: testUrl,
  allowReset: '1',
  ...overrides,
});

test('requires the dedicated test admin URL and never falls back to DATABASE_URL', () => {
  assert.throws(() => validateTestDatabaseReset({ allowReset: '1' }), /TEST_DB_RESET_URL_REQUIRED/);
  assert.throws(() => validateTestDatabaseReset({ databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/production', allowReset: '1' }), /TEST_DB_RESET_UNSAFE_DATABASE_NAME/);
});

test('requires explicit destructive-reset permission', () => {
  assert.throws(() => valid({ allowReset: undefined }), /TEST_DB_RESET_NOT_EXPLICITLY_ALLOWED/);
  assert.throws(() => valid({ allowReset: '0' }), /TEST_DB_RESET_NOT_EXPLICITLY_ALLOWED/);
});

test('refuses production regardless of the reset permission', () => {
  assert.throws(() => valid({ nodeEnv: 'production' }), /TEST_DB_RESET_FORBIDDEN_IN_PRODUCTION/);
});

test('accepts only PostgreSQL URLs with the expected test database', () => {
  assert.deepEqual(valid({ nodeEnv: undefined }).databaseName, 'contentos_test');
  assert.deepEqual(valid({ nodeEnv: 'test', expectedDatabaseName: 'contentos_test' }).databaseName, 'contentos_test');
  assert.throws(() => valid({ databaseUrl: 'mysql://root:root@127.0.0.1:3306/contentos_test' }), /TEST_DB_RESET_INVALID_PROTOCOL/);
  assert.throws(() => valid({ databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/contentos_prod' }), /TEST_DB_RESET_UNSAFE_DATABASE_NAME/);
  assert.throws(() => valid({ databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' }), /TEST_DB_RESET_UNSAFE_DATABASE_NAME/);
  assert.throws(() => valid({ expectedDatabaseName: 'production' }), /TEST_DB_RESET_UNSAFE_DATABASE_NAME/);
  assert.throws(() => valid({ expectedDatabaseName: 'contentos_test', databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/other_test' }), /TEST_DB_RESET_DATABASE_MISMATCH/);
});
