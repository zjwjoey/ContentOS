import pg from 'pg';
import { migrateUp } from '../packages/database/src/index.js';
import { validateTestDatabaseReset } from './test-database-safety.js';

const validated = validateTestDatabaseReset({
  databaseUrl: process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL,
  expectedDatabaseName: process.env.CONTENTOS_EXPECTED_TEST_DATABASE_NAME,
  allowReset: process.env.CONTENTOS_ALLOW_TEST_DB_RESET,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`ContentOS test database reset: ${validated.databaseName}`);

const database = new pg.Pool({ connectionString: validated.url.toString() });
try {
  await database.query('drop schema public cascade');
  await database.query('create schema public');
  await database.query('grant all on schema public to public');
  await migrateUp(database);
} finally {
  await database.end();
}
