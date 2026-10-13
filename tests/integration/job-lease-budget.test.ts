import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, migrateUp, migrateDown } from '../../packages/database/src/index.js';
import { JobService, type JobLeaseRecoveryHandler, type JobAttemptScope } from '../../packages/modules/job/src/index.js';

async function fixture() {
  const url = process.env.CONTENTOS_TEST_DATABASE_URL;
  assert.ok(url, 'explicit isolated test database required');
  assert.equal(new URL(url).pathname, '/contentos_test');
  const admin = await createDatabase(url);
  const schema = `contentos_lease_budget_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString: scoped.toString(), max: 2, connectionTimeoutMillis: 2_000 });
  await migrateUp(db);
  await db.query('create table lease_owner_fixture (job_id text primary key, state text not null, output text)');
  const jobs = new JobService(db);
  const create = async (id: string = randomUUID(), type = 'LEASE_BUDGET_FIXTURE', maxAttempts = 1) => {
    await jobs.create({ id, type, projectId: null, payload: {}, idempotencyKey: id, maxAttempts });
    await db.query("insert into lease_owner_fixture values($1,'RUNNING',null)", [id]);
    return id;
  };
  const expire = (id: string) => db.query("update jobs set lease_expires_at=now()-interval '1 second' where id=$1", [id]);
  const owner: JobLeaseRecoveryHandler = async (job, scope, context) => {
    await scope.query('update lease_owner_fixture set state=$2 where job_id=$1', [job.id, context.outcome]);
    return true;
  };
  const recover = (service = jobs, handler = owner) => service.reconcileExpiredLeases(new Date(), undefined, { types: ['LEASE_BUDGET_FIXTURE'], recover: handler });
  const streak = async (id: string) => Number((await db.query('select consecutive_lease_failures from jobs where id=$1', [id])).rows[0].consecutive_lease_failures);
  return { db, jobs, create, expire, owner, recover, streak, close: async () => { await db.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end(); } };
}

test('third consecutive lease loss stops automatic execution and persists across service restarts', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    for (let loss = 1; loss <= 3; loss += 1) {
      const service = new JobService(f.db);
      assert.ok(await service.claim(id, 'crashing-worker', 30_000));
      await f.expire(id);
      assert.equal(await f.recover(service), 1);
      assert.equal((await service.get(id))?.state, loss < 3 ? 'RETRY_WAIT' : 'FAILED');
      assert.equal(await f.streak(id), loss);
    }
    assert.equal(await f.jobs.claim(id, 'fourth-worker', 30_000), null);
    assert.equal((await f.jobs.attempts(id)).length, 3);
    assert.equal((await f.db.query('select state from lease_owner_fixture where job_id=$1', [id])).rows[0].state, 'FAILED');
    assert.equal(((await f.jobs.get(id))?.error as { code: string }).code, 'LEASE_RETRY_EXHAUSTED');
  } finally { await f.close(); }
});

test('remote pending defer breaks crash streak without using maxAttempts as a crash budget', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    for (let loss = 0; loss < 2; loss += 1) { await f.jobs.claim(id, 'crash', 30_000); await f.expire(id); await f.recover(); }
    for (let poll = 0; poll < 5; poll += 1) {
      const active = await f.jobs.claim(id, 'remote-poll', 30_000); assert.ok(active);
      await f.jobs.defer(id, active.attemptId, { code: 'EXTERNAL_TASK_PENDING' }, 10);
      assert.equal(await f.streak(id), 0);
      await f.jobs.requeue(id);
    }
    const final = await f.jobs.claim(id, 'remote-done', 30_000); assert.ok(final);
    assert.equal((await f.jobs.succeed(id, final.attemptId, { done: true })).state, 'SUCCEEDED');
    assert.equal((await f.jobs.attempts(id)).length, 8);
  } finally { await f.close(); }
});

test('manual terminal retry resets only the crash budget and commits its event atomically', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    for (let loss = 0; loss < 3; loss += 1) { await f.jobs.claim(id, 'crash', 30_000); await f.expire(id); await f.recover(); }
    await f.db.query("create function reject_manual_retry() returns trigger language plpgsql as $$ begin if new.event_type='job.requeued' then raise exception 'fixture rejects retry event'; end if; return new; end $$");
    await f.db.query('create trigger reject_manual_retry before insert on job_events for each row execute function reject_manual_retry()');
    await assert.rejects(f.jobs.requeueTerminal(id), /fixture rejects retry event/u);
    assert.equal((await f.jobs.get(id))?.state, 'FAILED');
    assert.equal(await f.streak(id), 3);
    await f.db.query('drop trigger reject_manual_retry on job_events');
    assert.equal((await f.jobs.requeueTerminal(id)).state, 'QUEUED');
    assert.equal(await f.streak(id), 0);
    assert.equal((await f.jobs.attempts(id)).length, 3);
    for (let loss = 0; loss < 3; loss += 1) { await f.jobs.claim(id, 'crash-again', 30_000); await f.expire(id); await f.recover(); }
    assert.equal((await f.jobs.get(id))?.state, 'FAILED');
    assert.equal((await f.jobs.attempts(id)).length, 6);
  } finally { await f.close(); }
});

test('concurrent recovery counts one loss and late heartbeat/result cannot resurrect it', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    const active = await f.jobs.claim(id, 'crash', 30_000); assert.ok(active);
    await f.expire(id);
    assert.deepEqual((await Promise.all([f.recover(), f.recover()])).sort(), [0, 1]);
    assert.equal(await f.streak(id), 1);
    assert.equal(await f.jobs.heartbeat(id, active.attemptId, 30_000), 'STALE');
    assert.equal((await f.jobs.succeed(id, active.attemptId, { late: true })).state, 'RETRY_WAIT');
    const replacement = await f.jobs.claim(id, 'replacement', 30_000); assert.ok(replacement);
    await f.expire(id);
    assert.equal(await f.jobs.heartbeat(id, replacement.attemptId, 30_000), 'ACTIVE');
    assert.equal(await f.recover(), 0);
    assert.equal(await f.streak(id), 1);
  } finally { await f.close(); }
});

test('owner failure rolls back its Job and owner but does not poison other recoveries', async () => {
  const f = await fixture();
  try {
    const bad = await f.create('a-poisoned'); const good = await f.create('b-healthy');
    for (const id of [bad, good]) { await f.jobs.claim(id, 'crash', 30_000); await f.expire(id); }
    assert.equal(await f.recover(f.jobs, async (job, scope, context) => {
      await f.owner(job, scope, context);
      if (job.id === bad) throw new Error('sensitive details do not belong in recovery event');
      return true;
    }), 1);
    assert.equal((await f.jobs.get(bad))?.state, 'RUNNING');
    assert.equal(await f.streak(bad), 0);
    assert.equal((await f.db.query('select state from lease_owner_fixture where job_id=$1', [bad])).rows[0].state, 'RUNNING');
    assert.equal((await f.jobs.get(good))?.state, 'RETRY_WAIT');
    const diagnostic = (await f.db.query("select details from job_events where job_id=$1 and event_type='job.lease_recovery_failed'", [bad])).rows[0].details;
    assert.deepEqual(diagnostic, { code: 'LEASE_RECOVERY_FAILED' });
  } finally { await f.close(); }
});

test('missing owner blocks exhausted Job and same reconciler repairs it without new attempts', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    for (let loss = 0; loss < 3; loss += 1) { await f.jobs.claim(id, 'crash', 30_000); await f.expire(id); await f.jobs.reconcileExpiredLeases(); }
    assert.equal((await f.jobs.get(id))?.state, 'BLOCKED');
    assert.equal(((await f.jobs.get(id))?.error as { code: string }).code, 'LEASE_RECOVERY_OWNER_UNAVAILABLE');
    assert.equal(await f.jobs.claim(id, 'blind-retry', 30_000), null);
    assert.equal((await f.jobs.requeueTerminal(id)).state, 'BLOCKED');
    assert.equal(await f.jobs.reconcileExpiredLeases(), 0);
    assert.equal(await f.streak(id), 3);
    assert.equal(await f.recover(f.jobs, async (job, scope, context) => { await f.owner(job, scope, context); return false; }), 0);
    assert.equal((await f.db.query('select state from lease_owner_fixture where job_id=$1', [id])).rows[0].state, 'RUNNING', 'refusing callback must roll back its writes');
    assert.equal(await f.recover(), 1);
    assert.equal((await f.jobs.get(id))?.state, 'FAILED');
    assert.equal((await f.jobs.attempts(id)).length, 3);
    assert.equal((await f.db.query("select count(*)::int as n from job_events where job_id=$1 and event_type='job.lease_retry_exhausted'", [id])).rows[0].n, 1);
  } finally { await f.close(); }
});

test('lease recovery scope rejects control, nested Job APIs, unawaited queries and use after close', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); await f.jobs.claim(id, 'crash', 30_000); await f.expire(id);
    let captured: JobAttemptScope | undefined;
    assert.equal(await f.recover(f.jobs, async (_job, scope) => {
      captured = scope;
      await assert.rejects(scope.query('commit'));
      return true;
    }), 0);
    assert.equal((await f.jobs.get(id))?.state, 'RUNNING');
    await assert.rejects(captured!.query('select 1'), /no longer active/u);
    assert.equal(await f.recover(f.jobs, async () => { await assert.rejects(f.jobs.get(id)); return true; }), 0);
    assert.equal(await f.recover(f.jobs, async (_job, scope) => { void scope.query('select pg_sleep(0.02)'); return true; }), 0);
    assert.equal(await f.recover(), 1);
  } finally { await f.close(); }
});

test('throwing recovery closes its captured scope before rollback can permit autocommit writes', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); await f.jobs.claim(id, 'crash', 30_000); await f.expire(id);
    let late: Promise<void> = Promise.resolve();
    assert.equal(await f.recover(f.jobs, async (_job, scope) => {
      void scope.query('select pg_sleep(0.08)');
      late = new Promise<void>((resolve, reject) => setTimeout(() => {
        void assert.rejects(scope.query("update lease_owner_fixture set state='LATE' where job_id=$1", [id]), /no longer active/u).then(resolve, reject);
      }, 10));
      throw new Error('owner threw with a query in flight');
    }), 0);
    await late;
    assert.equal((await f.jobs.get(id))?.state, 'RUNNING');
    assert.equal((await f.db.query('select state from lease_owner_fixture where job_id=$1', [id])).rows[0].state, 'RUNNING');
  } finally { await f.close(); }
});

test('cancellation precedes crash exhaustion and owner type filtering excludes other Jobs', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); const other = await f.create('other-job', 'OTHER_OWNER');
    for (let loss = 0; loss < 2; loss += 1) { await f.jobs.claim(id, 'crash', 30_000); await f.expire(id); await f.recover(); }
    await f.jobs.claim(id, 'cancel', 30_000); await f.jobs.claim(other, 'other', 30_000);
    await f.jobs.requestCancel(id); await f.expire(id); await f.expire(other);
    assert.equal(await f.jobs.reconcileExpiredLeases(new Date(), async (job, scope) => {
      await scope.query("update lease_owner_fixture set state='CANCELLED' where job_id=$1", [job.id]); return true;
    }, { types: ['LEASE_BUDGET_FIXTURE'], recover: f.owner }), 1);
    assert.equal((await f.jobs.get(id))?.state, 'CANCELLED');
    assert.equal(await f.streak(id), 0);
    assert.equal((await f.jobs.get(other))?.state, 'RUNNING');
  } finally { await f.close(); }
});

test('migration 0053 is additive, constrained, reversible and reapplies without deleting history', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); await f.jobs.claim(id, 'existing', 30_000);
    await assert.rejects(f.db.query('update jobs set consecutive_lease_failures=-1 where id=$1', [id]));
    assert.equal((await migrateDown(f.db)).removed, 1);
    assert.equal((await f.jobs.attempts(id)).length, 1);
    assert.equal((await migrateUp(f.db)).applied, 1);
    assert.equal(await f.streak(id), 0);
    assert.equal((await f.jobs.get(id))?.state, 'RUNNING');
  } finally { await f.close(); }
});
