# QUEUED Media Analysis cancellation — historical red regression and contract review

Current status: delegated technical review accepted the additive contract with conditions on 2026-10-08; implementation is recorded in [ADR-018](../adr/ADR-018-queued-media-analysis-cancellation.md) and [delivery evidence](MEDIA_ANALYSIS_CANCEL_DELIVERY.md).

The remainder of this document preserves the historical WIP/red evidence at b1749327. Statements about implementation being paused, unchanged business source or absent green evidence describe that earlier checkpoint, not the current branch.

Branch `codex/fv2-media-analysis-cancel`, worktree `/workspace/ContentOS-media-analysis-cancel`, base `27d43854f0571d127bb1ed4ac01334ff294409b2`. No claim/Phase0 commits imported. Existing worktrees preserved. Only this document and regression tests change; business source, contracts, workers, migrations, providers, defer and maxAttempts remain byte-identical to the base.

The delegated instruction explicitly requires reporting a proposal and pausing when a safe fix must change public contracts or table ownership. Root AGENTS.md also requires evidence, ADR update and review for boundary/invariant changes. The proposed work preserves table ownership, but needs an additive published module application port; no runtime contract addition has been made without that review.

## Revalidated source evidence

- `packages/modules/job/src/job-service.ts:219` / `:220`: requestCancel changes QUEUED/RETRY_WAIT immediately to CANCELLED; an unstarted Job has no attempt.
- `packages/modules/intelligence/src/media-intelligence-service.ts:99` / `:107`: reconcileStaleRuns only matches domain RUNNING, so linked QUEUED runs never receive cancellation.
- `workers/media-intelligence-worker/src/main.ts:31`–`:37`: lease cancellation handles only expired active jobs; normal polling at `:40` cannot consume terminal CANCELLED work.
- `packages/modules/job/src/job-service.ts:62`: get is a non-locking snapshot; `:208` requeueTerminal can concurrently restart CANCELLED work.
- `:241` / `:267` attempt fences require RUNNING and a current attempt. `:292` cancelAttempt requires CANCEL_REQUESTED plus a RUNNING attempt. None can fence a terminal CANCELLED Job without an attempt.
- `packages/modules/intelligence/src/media-intelligence-service.ts:97`: markCancelled opens an independent pool query and allows RUNNING updates; it cannot reuse a Job-held transaction executor. It protects SUCCEEDED/FAILED/STALE, but provides no guarantee against a stale caller cancelling a replacement RUNNING run.

A get(CANCELLED) → markCancelled sequence is not atomic with requeue/claim. A QUEUED-only domain condition protects an already RUNNING target, but cannot prove that a still-QUEUED run belongs to a still-CANCELLED Job after concurrent explicit retry. Expanding the existing cross-module `UPDATE ... FROM jobs` would extend the private-table debt and lacks an explicit Job-owned lock/revalidation guarantee. Neither shortcut satisfies this task's boundary/concurrency constraints.

## Real DB reproduction and limited baseline controls

Fresh Docker postgres:16 container `contentos-fv2-media-cancel-test`, loopback 55437. Confirmed PostgreSQL **16.15** and current_database **contentos_test**. Project reset guard used with explicit expected name and allow-reset only on this isolated local database. Test cases subsequently each create a unique schema within contentos_test, migrate the existing inventory there, and remove only their owned schema in teardown. No business DB, paid service or real external provider involved; fake providers and synthetic Asset fixtures are explicit.

```bash
CONTENTOS_TEST_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test CONTENTOS_EXPECTED_TEST_DATABASE_NAME=contentos_test CONTENTOS_ALLOW_TEST_DB_RESET=1 ./node_modules/.bin/tsx scripts/reset-test-database.ts
CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/media-analysis-queued-cancel.test.ts
```

Actual new regression result: **2 PASS / 1 FAIL / zero skipped**.

1. **FAIL** `QUEUED media analysis cancellation propagates idempotently before any provider call`: calls requestCancel twice, starts/stops the actual worker/reconciliation and verifies Job CANCELLED, zero provider calls and no attempts. Domain run remains **QUEUED**, expected CANCELLED, assertion at new test line 55. Finished/error/restart-idempotency assertions are authored but are not reached on this failing baseline; they are not claimed as passes.
2. **PASS** `cancelled queued Job reconciliation preserves completed analysis results`: actual Fake analysis succeeds; repeated cancellation/reconcile preserves raw status/finished/error and result records.
3. **PASS** `cancellation reconciliation preserves a newly claimed active analysis attempt`: actual terminal cancellation is explicitly requeued and claimed; a deferred fake technical provider holds the new run at RUNNING while existing reconciliation executes. New Job/attempt and run remain RUNNING, then provider release allows SUCCEEDED. This checks an already active replacement; it does **not** validate an unimplemented snapshot-to-commit fence or rollback race.

The new failing regression is neither skipped nor weakened. It is not added to default CI scripts while implementation is paused; a green existing script cannot be treated as proof this new test passes. No workflow/job gate was changed.

## Related executed checks

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/job.test.ts tests/integration/intelligent-analysis-closure-v15.test.ts tests/integration/intelligent-editing-v15.test.ts tests/worker/media-intelligence-worker.test.ts tests/unit/test-database-safety.test.ts
```

Clean isolated DB result: **22/22 PASS, zero skipped** — Job integration 15/15, real DB analysis failure/retry/cancel closure 1/1, real shot/keyframe analysis 1/1, offline worker mock 1/1, reset guard 4/4. Node 24.19.0 and frozen pnpm 10.32.1 install; lockfile unchanged. format PASS (410 files), lint PASS (217 TypeScript files), typecheck PASS and git diff --check PASS.

An initial trial of new fixtures in public left one RUNNING synthetic Job. The first related suite then reported 21/22 because its global lease reconciler also recovered that fixture (`job.lease_recovered` verified on that synthetic id). New tests were corrected to per-test owned schemas, and the task-local public schema was reset using the project guard before the limited related-suite rerun. This is test isolation evidence, not a product change or a hidden ignored failure.

Logs: `/tmp/fv2-media-cancel-red.log`, `/tmp/fv2-media-cancel-existing.log` (initial contamination), `/tmp/fv2-media-cancel-existing-clean.log` (22/22). The task container is stopped after verification. Other worktrees and remote branches remain intact.

## Concrete minimal proposal awaiting review

No new HTTP/API schema, database migration, queue or generic workflow engine. Preserve Job table ownership in JobService and analysis table ownership in MediaIntelligenceService. Reuse the existing transaction-executor pattern.

1. **Job-owned terminal cancellation fence, additive application port.** A narrow `withCancelledJobFence(jobId, expectedType/projectId/attemptCount, action)` acquires the existing Job row with SELECT FOR UPDATE, rechecks CANCELLED/type/owner/expected attempt count, and passes a transaction-local JobQueryExecutor plus Job identity to the callback. Zero-attempt QUEUED cancellation uses this terminal scope, not a fabricated JobAttemptScope. It returns executed=false on requeue/new attempt/owner mismatch. Callback failure rolls back and releases the same connection.
2. **Analysis-owned queued cancellation write, additive application port.** `markQueuedCancelledWithExecutor(executor, runId, expectedJobId, error)` updates only a still-QUEUED run with the matching linked job, sets stable cancellation error and coalesced finished_at, and never updates RUNNING/SUCCEEDED/FAILED/STALE. It uses the provided connection; it does not read Job tables or open another pool connection while the Job lock is held. Repeat calls are no-ops preserving the first completion/error metadata.
3. **Bounded owner discovery and existing worker coordination.** Obtain a bounded list of linked QUEUED runs from Intelligence's own tables, use existing jobs.get for the advisory candidate snapshot, then revalidate inside the Job-owned fence before the owner write. No direct Job SQL in Intelligence/worker and no new polling service. The existing active cancellation/provider/defer paths stay unchanged.

Required transaction order: **Job row lock → terminal identity/type/attempt-count revalidation → analysis owner conditional update → one commit**. No provider, FFmpeg, browser or external I/O while holding this transaction. An explicit requeue that commits first makes cancellation skip; cancellation that commits first precedes the new retry legitimately. A stale candidate cannot cancel a replacement attempt, even if a later Job is CANCELLED again with a different attempt count. The domain condition protects already-completed and changed-linked-job records.

Required additional acceptance after review: the current red case becomes green including all restart-idempotency assertions; controlled real PG lock races prove both requeue-before-fence and fence-before-requeue ordering; stale expected attempt count skips; thrown domain callback rolls back; a small connection pool does not starve; existing active cancellation and all 22 related cases remain green. Register the now-green regression in the existing analysis CI/test script once implementation is accepted. Do not infer this acceptance from the two baseline controls.

This adds module application methods, so it is intentionally presented for review instead of implemented under the current stop condition. Exact naming/signatures and any required ADR belong to that review. Existing cross-table reconciliation debt and full analysis attempt fencing remain separate audit tasks, not bundled here.

## Remote / delivery state

Only WIP tests and this reviewable proposal are committed/pushed for review. No production fix or green new-regression result is claimed. Final SHA is verified and reported at handoff. Claim branch remains pending independent review; no source or merge changes there. GitHub API PR/Issue/Actions actions remain paused after Forbidden; no credential, proxy or connector workaround, API retry, merge or paid service.
