# Job claim retry_at guard — isolated engineering delivery

2026-10-08. Branch: `codex/fv2-claim-retry-at`, base `27d43854f0571d127bb1ed4ac01334ff294409b2`. Worktree: `/workspace/ContentOS-claim-retry-at`. Phase0 branch remains `9f95f1d90a98fa813960efa087a649d4ca4b515e`; none of its documentation/CI/audit commits were imported. No dependency on Phase0 changes is needed for these tests. Baseline CI already covers codex/** pushes; integration-target PR coverage is the separate Phase0 delivery.

## Problem and minimal fix

listRunnable filters future retry_at, but claim previously checked only state and scheduled_at after SELECT FOR UPDATE. Direct/delayed delivery or a stale runnable ID could start a new RETRY_WAIT attempt before its backoff expires, including after waiting for another transaction to change the row.

`packages/modules/job/src/job-service.ts:122` adds only a RETRY_WAIT + future retry_at guard inside the existing locked transaction. It rolls back/returns null before generating an attempt ID, incrementing attempt_count or writing events. The final guard reads driver Date values with getTime() and parses only string values, preserving millisecond precision. The earlier Date-to-string comparison was corrected after review; see the subsecond follow-up below. No change to maxAttempts policy, defer, explicit requeue, migrations, module boundaries or any other audit finding.

## Real PostgreSQL setup and safety

Fresh task-specific Docker container `contentos-fv2-claim-test`, image postgres:16, loopback port 55436. No existing DB/container was reused. Server reports PostgreSQL **16.15**; current_database was verified as **contentos_test** before reset. The project reset script was invoked with its explicit expected-name/allow-reset guards, only against this synthetic local database. No production/real-business DB accessed. The task container is stopped after verification; worktrees and evidence logs remain.

```bash
docker run --detach --rm --name contentos-fv2-claim-test --publish 127.0.0.1:55436:5432 --env POSTGRES_DB=contentos_test --env POSTGRES_HOST_AUTH_METHOD=trust postgres:16
# Confirm current_database() == contentos_test and server_version starts with 16.
CONTENTOS_TEST_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/contentos_test CONTENTOS_EXPECTED_TEST_DATABASE_NAME=contentos_test CONTENTOS_ALLOW_TEST_DB_RESET=1 ./node_modules/.bin/tsx scripts/reset-test-database.ts
```

Dependencies installed with pinned pnpm **10.32.1**, Node **24.19.0**, `pnpm install --frozen-lockfile`; lockfile unchanged. Existing Linux embedded-Postgres install-script restriction was preserved; this regression uses the isolated official PG16 service.

## Test-first evidence

Three new tests in the existing `tests/integration/job.test.ts`:

1. Defer to future retry_at; claim must return null without another attempt/state/event mutation.
2. Due and null retry_at remain claimable, including defer with maxAttempts=1 leading to attempt 2.
3. Capture a runnable ID, hold its PostgreSQL row lock, start claim, observe pg_blocking_pids/pg_stat_activity proving the claim is waiting, change the locked row to RETRY_WAIT with future retry_at, commit; waiting claim must re-evaluate and return null. No mock DB or sleep-only race assumption.

Focused command:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55436/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 --test-name-pattern='Job claim (refuses|accepts|rechecks)' tests/integration/job.test.ts
```

Before implementation: **1 passed, 2 failed** on the unchanged baseline service. Both failing tests received a RUNNING claimed attempt instead of null; concurrent test first confirmed a real database lock wait. After the one-line fix: **3 passed, 0 failed, 0 skipped**.

## Initial regression and review (before subsecond follow-up)

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55436/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/job.test.ts tests/unit/test-database-safety.test.ts tests/unit/video-handler-idempotency.test.ts tests/worker/media-intelligence-worker.test.ts
```

**25/25 PASS, zero skipped**: full Job integration **18/18** (including pg-boss delivery, duplicate/idempotent creation, normal retry, defer, cooperative cancellation, lease recovery, poisoned recovery isolation, stale-attempt rejection, rollback and heartbeat), reset guards **4/4**, Video worker idempotency/start-rejection **2/2**, Media worker mock regression **1/1**. Only Job integration is real DB evidence; the latter worker tests remain focused offline/mock evidence.

pnpm format **PASS** (409 files), lint **PASS** (217 TypeScript files), typecheck **PASS**, git diff --check **PASS**. Self-review confirms row-lock ordering, unchanged eligibility behavior for due/null and explicit requeue, no maxAttempts cap, rollback cleanup of the concurrent test and no migration/lockfile/CI change. Full browser/render/Windows/full-product suites were not run for this bounded change. Runtime zombie evidence belongs to the untouched Phase0 branch and is not erased by this result.

Raw session logs: `/tmp/fv2-claim-red.log`, `/tmp/fv2-claim-green.log`, `/tmp/fv2-claim-regression.log`. Results above preserve the acceptance evidence after temporary logs expire.

## Remote limits

Commit/push and ls-remote verification are performed on this independent feature branch; final SHA is reported at handoff. No merge into main or Foundation integration. GitHub API PR/Issue/Actions operations remain paused after their earlier Forbidden responses; no credential/proxy/connector workaround or API retry. Push coverage alone does not establish a CI run or result; exact-head remote CI, browser/Windows/full-product acceptance remain unverified.

## Subsecond review follow-up — latest acceptance

Review found the first guard's `new Date(String(row.retry_at))` converted a driver Date to a human-readable string without milliseconds. Deadline xx:10.900 could become xx:10.000 and allow claim at xx:10.500. The initial +60 seconds / -1 second / null tests did not detect that precision defect.

Added two real PostgreSQL integration tests, `Job claim preserves subsecond retry_at returned as Date` and `... as string`. A per-test application Date.now clock is fixed at a second boundary +500ms; stored PostgreSQL retry_at is +900ms. The database is real PG16, the default driver Date representation is asserted, and a separate Pool-local timestamptz text parser exercises the supported string representation without changing global parser settings. Only the application comparison clock is controlled to avoid flaky wall-time sleeps; DB queries, transactions and the existing lock-wait test are real. Each test requires no state/attempt/event mutation 400ms before the deadline, then successful attempt 2 exactly at the deadline, preserving defer/maxAttempts=1 behavior. Test-context clock mocks restore automatically.

Before the precision fix on fe6cf61: **Date test FAIL, string test PASS (1/2)**. After the fix: all five claim-focused cases **5/5 PASS**, including real concurrent lock wait. Guard uses Date.getTime() for Date and Date.parse() only for strings; no new coercion of arbitrary objects/numbers, no maxAttempts/migration/module/other-job-field changes.

Latest full scoped command (same regression command above): **27/27 PASS, zero skipped** — real Job integration **20/20**, reset guards **4/4**, Video offline **2/2**, Media worker offline **1/1**. pnpm format/lint/typecheck and git diff --check also PASS. Source review confirms milliseconds are retained, future blocks and equality is eligible, clock/parser isolation is local to each test, and pending lock claims are released during cleanup.

Focused commands:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55436/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 --test-name-pattern='Job claim preserves subsecond' tests/integration/job.test.ts
DATABASE_URL=postgresql://postgres@127.0.0.1:55436/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 --test-name-pattern='Job claim (refuses|accepts|preserves|rechecks)' tests/integration/job.test.ts
```

Latest session logs: `/tmp/fv2-claim-subsecond-red.log`, `/tmp/fv2-claim-subsecond-green.log`, `/tmp/fv2-claim-subsecond-regression.log`. A fresh task-specific postgres:16 container was verified as contentos_test/16.15 and initialized through the same reset guard, then stopped after verification. No GitHub API action retried; PR/Issue/current-head CI remains blocked/unverified. No merge.
