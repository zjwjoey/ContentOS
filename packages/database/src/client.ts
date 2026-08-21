import pg from 'pg';

export type Database = pg.Pool;

export async function createDatabase(connectionString: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString, max: 4 });
  await pool.query('select 1');
  return pool;
}
