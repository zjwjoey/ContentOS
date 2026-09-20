const DEFAULT_TEST_DATABASE_NAME = 'contentos_test';
const UNSAFE_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1', 'contentos', 'contentos_prod', 'production']);

export type TestDatabaseResetOptions = {
  databaseUrl?: string | undefined;
  expectedDatabaseName?: string | undefined;
  allowReset?: string | undefined;
  nodeEnv?: string | undefined;
};

export type ValidatedTestDatabase = {
  url: URL;
  databaseName: string;
};

export class TestDatabaseResetError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`ContentOS test database reset refused:\n${code}`);
    this.name = 'TestDatabaseResetError';
    this.code = code;
  }
}

function refuse(code: string): never {
  throw new TestDatabaseResetError(code);
}

function databaseNameFromUrl(url: URL): string {
  const encodedName = url.pathname.replace(/^\/+/, '');
  if (!encodedName) refuse('TEST_DB_RESET_DATABASE_MISMATCH');
  try {
    return decodeURIComponent(encodedName);
  } catch {
    refuse('TEST_DB_RESET_DATABASE_MISMATCH');
  }
}

export function validateTestDatabaseReset(options: TestDatabaseResetOptions): ValidatedTestDatabase {
  if ((options.nodeEnv || '').toLocaleLowerCase() === 'production') refuse('TEST_DB_RESET_FORBIDDEN_IN_PRODUCTION');
  if (!options.databaseUrl) refuse('TEST_DB_RESET_URL_REQUIRED');
  if (options.allowReset !== '1') refuse('TEST_DB_RESET_NOT_EXPLICITLY_ALLOWED');

  const expectedDatabaseName = (options.expectedDatabaseName || DEFAULT_TEST_DATABASE_NAME).trim();
  if (!expectedDatabaseName.toLocaleLowerCase().includes('test')) refuse('TEST_DB_RESET_UNSAFE_DATABASE_NAME');
  if (UNSAFE_DATABASE_NAMES.has(expectedDatabaseName.toLocaleLowerCase())) refuse('TEST_DB_RESET_UNSAFE_DATABASE_NAME');

  let url: URL;
  try {
    url = new URL(options.databaseUrl);
  } catch {
    refuse('TEST_DB_RESET_INVALID_PROTOCOL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') refuse('TEST_DB_RESET_INVALID_PROTOCOL');

  const databaseName = databaseNameFromUrl(url);
  if (UNSAFE_DATABASE_NAMES.has(databaseName.toLocaleLowerCase())) refuse('TEST_DB_RESET_UNSAFE_DATABASE_NAME');
  if (databaseName !== expectedDatabaseName) refuse('TEST_DB_RESET_DATABASE_MISMATCH');
  return { url, databaseName };
}
