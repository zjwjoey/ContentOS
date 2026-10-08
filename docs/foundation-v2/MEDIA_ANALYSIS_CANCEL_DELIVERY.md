# QUEUED Media Analysis cancellation delivery

2026-10-08. Base: `27d43854f0571d127bb1ed4ac01334ff294409b2`. Branch: `codex/fv2-media-analysis-cancel`. The historical red checkpoint is `b1749327bd810d5eae289cdabdc4e4082a6b240b`; [its evidence](MEDIA_ANALYSIS_CANCEL_CONTRACT_PROPOSAL.md) is retained. Delegated technical review approved implementation with conditions, recorded before runtime edits in [ADR-018](../adr/ADR-018-queued-media-analysis-cancellation.md).

## Implemented contract

Job owns the transaction and first row lock. Exact nonempty Job id/type/project, current CANCELLED state and safe nonnegative integer expected attempt count must match before callback execution. A branded cancellation executor expires before commit/release. Forbidden statements, nested Job APIs, SQL failure (including caught query errors), callback errors and outstanding queries poison the transaction. Callers must await every query and perform no external I/O; this is an application contract, not an arbitrary-JavaScript sandbox.

Intelligence owns the conditional update of its QUEUED run, checking persisted run/job/project linkage on the same connection. Stable MEDIA_ANALYSIS_JOB_CANCELLED error and coalesced finished_at preserve first completion metadata. The return distinguishes a skipped fence from an executed callback that changed no domain row. Attempts/results and protected run states are preserved.

The existing worker performs bounded discovery (default 25, maximum 100) using its domain owner. Discovery finishes before Job→analysis locks. Stable id cursor plus cycle high-water mark and wraparound progress past pending, malformed or unrelated Jobs. Concurrent scans on one worker share a pass; shutdown awaits that pass. Per-candidate errors log only a stable event/code and do not abort the batch. Job payload never selects the target run.

## Executed evidence

Cloud Node 24.19.0; pnpm 10.32.1 frozen install, unchanged lockfile. Fresh task-owned Docker postgres:16, PostgreSQL 16.15, loopback port 55437. Verified current_database = contentos_test. Project reset guard used only against this isolated test database. New contract tests create unique schemas inside contentos_test, migrate the existing 52 forward migrations and remove only their owned schema. Fake providers/synthetic Assets are explicit; no paid service or business database.

Commands (synthetic local test endpoint):

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/job.test.ts tests/unit/test-database-safety.test.ts
DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/contentos_test corepack pnpm test:intelligent-editing-v15
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
```

- Job integration + test database safety: **19/19 PASS**, zero skipped (15 + 4).
- Full Intelligent Editing V1.5 gate: **40/40 PASS**, zero skipped, including all **12/12** new cancellation contract tests, existing real DB analysis/retry/cancellation/planning tests, real FFmpeg scene detection and offline worker coverage.
- format: PASS (410 files); lint: PASS (217 TypeScript files); typecheck/build/git diff --check: PASS.
- Original red case now passes actual worker start/shutdown and restart idempotency with zero provider calls. Both lock orders use observed PostgreSQL pg_blocking_pids wait chains, not delay-based guesses. Requeue-first checks its queued blocker before the fence; fence-first observes requeue waiting on the callback connection.
- Additional cases: stale count and malformed counts/identities; missing/wrong type/project/linkage; RUNNING/SUCCEEDED/FAILED/STALE preservation; attempts/results/first timestamp preservation; write-then-throw and caught SQL failure rollback; scope use after rollback/commit; forbidden transaction/nested Job calls with a one-connection pool; unawaited in-flight query rejection; one-connection concurrent fence progress; bounded scan beyond bad/pending first candidates, fixed cycle upper bound, wraparound and misleading payload.

Two intermediate expanded-suite failures were test observation errors: fence waits behind the queued requeue backend (soft blocker), and createRun('') generates a fallback id. The wait-chain assertion now checks the actual requeue backend; malformed discovery uses a persisted empty linked Job id. These failures were resolved without increasing timeout or weakening assertions. An additional self-review test proves caught SQL errors cannot be reported as successful commits.

Logs in this environment: `/tmp/fv2-media-cancel-contract.log`, `/tmp/fv2-media-cancel-job.log`, `/tmp/fv2-media-cancel-gate.log`, `/tmp/fv2-media-cancel-build.log`. The task-owned PostgreSQL container is stopped after tests.

## Gate and handoff limits

The new green test file is appended to the existing test:intelligent-editing-v15 command. Every prior test entry and all six existing workflow jobs are retained. Workflow files, existing migrations (including historical rollback-only 0047), dependency lockfile, providers and retry/defer behavior are unchanged. This branch does not import Phase0 or claim-retry-at commits; those worktrees and remote branch heads remain intact.

Git transport read/push is verified separately from GitHub API. PR/Issue/Actions APIs previously returned Forbidden and remain paused as instructed, without retry or credential/proxy/connector workaround. This delivery records local actual test evidence and verified remote commit SHA at handoff, not remote CI success or a created PR. No merge, main write or formal release.

attemptCount is not a cancellation-generation token; requeue/cancel with no new attempt can retain it. The locked current Job terminal state and owner linkage/QUEUED predicates are the guarantee here. Existing unfenced analyzeRun, legacy cross-table RUNNING reconciliation, provider cancellation during active work and all broader attempt races remain separate follow-up review tasks. No new Windows packaging/browser validation was run; prior evidence is historical only.
