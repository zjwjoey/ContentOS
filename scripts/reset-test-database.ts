import pg from 'pg';
import { migrateUp } from '../packages/database/src/index.js';

const databaseUrl = process.env.CONTENTOS_TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('CONTENTOS_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required');

const database = new pg.Pool({ connectionString: databaseUrl });
try {
  await database.query('drop schema public cascade');
  await database.query('create schema public');
  await database.query('grant all on schema public to public');
  await migrateUp(database);
} finally {
  await database.end();
}
