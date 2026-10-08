# Active Media Analysis attempt fencing: red reproduction and minimal contract proposal

Status: **RED / proposal only; no implementation**, 2026-10-08.

Branch `codex/fv2-analysis-attempt-fence`, isolated worktree `/workspace/ContentOS-analysis-attempt-fence`, base `27d43854f0571d127bb1ed4ac01334ff294409b2`. Only this proposal and reproduction tests are changed. No runtime/API/schema/provider/migration/CI changes; no imports or merges from Phase0, claim-retry-at or queued-cancellation branches.

## Checked source and root cause

Line numbers refer to the exact base above.

| Location | Observed behavior / implication |
| --- | --- |
| `workers/media-intelligence-worker/src/handler.ts:13–18` | Receives `_attemptId` but discards it; calls analyzeRun(runId, signal), so Analysis has no Job attempt identity. |
| `packages/modules/intelligence/src/media-intelligence-service.ts:112–127` | Reads a snapshot, then unconditionally sets RUNNING and increments domain attempt_count by runId. No Job fence, expected project/job linkage or pinned domain count. |
| Same file `:130–139` | Technical/shot provider returns are persisted via unconditional run/shot upserts and shot deletion; no post-provider signal check here and no durable attempt revalidation. |
| Same file `:143–166` | ASR/VISION have signal checks, but all result/embedding writes still lack durable Job fencing. Abort cooperativeness is not ownership. |
| Same file `:167–172` | Success updates by runId only; catch similarly updates FAILED/CANCELLED by runId only. A stale error/abort can overwrite a newer success even if no stale result upsert occurs. |
| Same file `:176–204` | Keyframe referenced/ready/failed writes and embedding upserts are also unfenced. Keyframe filesystem paths are shared by run/shot, requiring separate late-output design before broad acceptance. |
| `packages/modules/job/src/job-service.ts:241–264` | Existing withCurrentAttemptFence locks Job, requires RUNNING and matching current RUNNING attempt number, and supplies the same transaction executor. Analysis currently does not call it. |
| Same file `:267–315`, `:155–180` | Existing succeedWithCurrentAttempt, fail(callback), cancelAttempt(callback) can atomically combine owner writes with Job terminal transitions. |
| Same file `:332–355` | Lease recovery locks Job and invalidates the old attempt before retry. A cancellation recovery callback already receives a JobAttemptScope. |
| Same file `:386–401` | JobRunner observes heartbeat and fences Job terminal writes only after the handler; Analysis has already changed business records. |
| `workers/media-intelligence-worker/src/main.ts:31–37` | Existing lease-cancel callback ignores its scope and calls pool-backed markCancelled using payload; legacy RUNNING reconciliation separately cross-reads jobs. These paths require coordinated owner-port adoption, not expansion of private-table SQL. |

Production-source call search found analyzeRun called only by the Media Analysis handler. Direct public use exists in tests; preserving those test/offline consumers needs an explicit compatibility policy. Existing Video/Asset handlers demonstrate the current Job executor pattern; a new generic workflow engine is not needed.

## Actual isolated PostgreSQL evidence

Fresh task-owned Docker postgres:16 container `contentos-fv2-analysis-fence-test`, loopback port 55438. Verified current_database = **contentos_test**, PostgreSQL **16.15**. Project reset guard executed once with exact test name and allow-reset, solely on this fresh isolated database. Each new test subsequently owns a unique schema, runs all existing forward migrations there, and removes only that schema. No real business database or paid service.

Every provider is created by createFakeIntelligenceProviders. Metadata-only technical/shot fixtures use no real provider or network. Explicit promise barriers hold the old technical provider. Lease expiry is driven by the existing reconcileExpiredLeases clock argument set to the persisted lease expiration + 1 second; actual DB recovery, re-claim and handler execution follow. This is an injected reconciliation clock, not a claim of waiting 30 seconds or exercising heartbeat timers.

```bash
CONTENTOS_TEST_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55438/contentos_test CONTENTOS_EXPECTED_TEST_DATABASE_NAME=contentos_test CONTENTOS_ALLOW_TEST_DB_RESET=1 ./node_modules/.bin/tsx scripts/reset-test-database.ts
CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55438/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/media-analysis-attempt-fence.test.ts
```

New suite executed twice with identical observations: **1 PASS / 4 FAIL / zero skipped** each, exit 1 deliberately retained. Assertions express the required safe behavior; no expected-failure skip/todo or inverted green assertion.

| Controlled ordering | Actual persisted result | Required assertion |
| --- | --- | --- |
| Old provider blocked → lease recovered → new claim → replacement succeeds → old success returns | Job remains SUCCEEDED/new attempt; technical width changes 1920→640 and model replacement-attempt→old-attempt; run completion metadata changes | Replacement run/results snapshot must remain unchanged: FAIL |
| Same ordering, old provider throws OLD_PROVIDER_FAILURE | Job remains SUCCEEDED; run becomes FAILED | Replacement success must remain unchanged: FAIL |
| Same ordering, old controller aborted then provider throws abort at explicit release | Job remains SUCCEEDED; run becomes CANCELLED | Old abort must not cancel replacement success: FAIL |
| Active provider blocked → requestCancel → signal abort → existing owner markCancelled → cancelAttempt commits → noncooperative provider returns | Job remains CANCELLED; run resurrects SUCCEEDED and gains technical/shot rows | Durable cancellation snapshot/results must remain unchanged: FAIL |
| Existing Job fence control after recovery/new claim, then cancellation | Old callback skipped; current callback executes in same transaction; CANCEL_REQUESTED callback skipped | Existing public fence works: PASS |

The cancellation case intentionally invokes existing public application APIs and explicit abort rather than relying on JobRunner heartbeat timing. It proves the post-cancellation write hazard when a provider ignores abort. New tests do not claim a new owner contract or implement a production cancellation callback.

Related actual command:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55438/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55438/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/job.test.ts tests/integration/intelligent-analysis-closure-v15.test.ts tests/integration/intelligent-editing-v15.test.ts tests/worker/media-intelligence-worker.test.ts tests/unit/test-database-safety.test.ts
```

Existing limited checks: **22/22 PASS**, zero skipped — Job15, DB analysis closure1, real FFmpeg shot/keyframe analysis1, offline worker1, reset safety4. This green associated result does not negate the four new red failures. format PASS (410 files), lint PASS (217 TypeScript files), typecheck/build/git diff --check PASS. Node 24.19.0, frozen pnpm10.32.1 install; lockfile unchanged.

Logs: `/tmp/fv2-analysis-fence-red.log`, `/tmp/fv2-analysis-fence-red-repeat.log`, `/tmp/fv2-analysis-fence-existing.log`, `/tmp/fv2-analysis-fence-reset.log`, `/tmp/fv2-analysis-fence-build.log`. Synthetic test service is stopped at handoff.

## Proposed minimum compatible change, awaiting review

Reuse **existing Job APIs**. No new Job cancellation fence, Job state, JobRunner protocol, database migration or attempt table is required to reject a recovered/replaced attempt. Add narrowly scoped **Intelligence owner application ports** accepting existing JobAttemptScope, expected persisted run/job/project/asset linkage and the domain attempt_count captured at a fenced start. Exact names are provisional:

1. `startAttemptWithExecutor(scope, expectedLinkage)` locks the linked analysis run, validates ownership, and starts only an eligible run. Return the pinned domain attempt_count and analysis input snapshot. Preserve successful checksum-matching reuse and existing fingerprint/config behavior; never unconditionally resurrect a CANCELLED run. Explicit retry's allowed domain transitions must be defined in review.
2. `persistAttemptStageWithExecutor(scope, identity, typedStageResult)` first locks/checks the owner's run/linkage/status and pinned domain count, then updates only that stage's existing result tables on this executor. Use a finite stage union or explicit owner methods, not a generic query/workflow service. Guard before technical/shot upserts and deletes, ASR/VISION/embedding writes, and keyframe state updates. A mismatch returns no-write, not a domain failure. The pinned existing domain counter prevents an earlier computation within a duplicate same-Job-attempt invocation from overwriting a later start; it is distinct from Job attempt number and is not a cancellation generation token.
3. `finishAttemptWithExecutor(scope, identity, outcome)` conditionally finalizes the same RUNNING analysis generation. Success runs inside succeedWithCurrentAttempt; failure inside fail's existing callback; cancellation inside cancelAttempt's existing callback. The worker must route these outcomes itself before returning/throwing; generic JobRunner's later terminal update alone is insufficient. A skipped stale fence exits without unfenced cleanup/error writes.

Worker retains MEDIA_ANALYSIS type and payload validation, passes the real attemptId, and treats persisted run→job/project/asset linkage as authoritative. A payload cannot select a different owner. All provider/FFmpeg/filesystem work happens outside locked transactions. After each await, attempt authority is revalidated for **every write**, including the error path; signal checks merely improve prompt cancellation. The existing lease-cancellation handler should use its provided scope and the same Intelligence owner cancellation port, rather than opening another pool connection under the Job lock. Legacy cross-table reconciliation is a separately reviewed dependency/path; do not add new cross-module SQL.

Minimal transaction order for each database stage:

**Job row lock → Job current state/attempt identity check → Analysis run row lock → persisted linkage + pinned domain count/state check → owner child writes / terminal update → one commit.**

No analysis lock may be retained while calling a pool-backed Job API; no connection held across provider or file I/O. Recovery/requeue wins first: old fence skips before owner work. Old stage commits first: it legitimately precedes recovery; later ownership checks reject subsequent stale writes. Terminal callback and Job transition share the same commit. A domain callback exception rolls back both.

Keyframes need an explicit extension to this narrow design: write generated files to attempt-specific temporary/content-addressed paths outside the transaction, then publish only references inside a successful fence. Shared run/shot paths cannot safely be overwritten by an old FFmpeg completion. Cancellation/recovery must not delete paths that a current attempt still references. This is proposed design and remains unimplemented/unverified; the new red tests cover technical/shot DB writes, not filesystem races.

## Dependencies and limits

- **ADR-018 / 99d324a is not a required implementation dependency for active attempt authority.** This branch has no such commit imported. Existing active JobAttemptScope and fences suffice for the proposed core DB path. Queued terminal cancellation and active attempt cancellation are distinct; a terminal JobCancellationScope cannot replace a current attempt scope. If the implementation later reuses ADR-018 callback guard machinery or composes its queued scan, explicitly declare/review that dependency before integrating either branch.
- **Additive Intelligence application ports require ADR + architecture review before implementation**, per AGENTS.md. This document is the review input, not an accepted ADR or an authorization to implement.
- Existing active scopes do not have ADR-018's stronger statement/nested-call guards. Proposed callbacks must be trusted, awaited, executor-only SQL with no transaction control/nested pool/Job calls/external I/O. Hardening the shared active scope is not bundled into this proposal.
- Existing withCurrentAttemptFence checks state/attempt ownership, **not lease_expires_at wall-clock validity**. The demonstrated guarantee begins once existing recovery has invalidated the old attempt, or cancellation changes Job state. A strict “no write after timestamp expiry before recovery” policy needs a separately reviewed predicate change; no such guarantee is claimed here.
- Direct/unlinked analyzeRun callers must retain the existing public signature or migrate explicitly; linked durable-worker runs must not retain an unfenced bypass. This compatibility decision needs review and tests, not a silent breaking change.
- Provider retry budgets, costs, fingerprint/config schemas, historical migrations, and EDIT_MANIFEST_V0 are unchanged. No real-provider cancellation, restart/full browser/Windows/remote CI validation is claimed.

## Required acceptance after design approval

Turn all four red tests green without weakening assertions. Add observed real PostgreSQL lock-order tests for recovery-before-stage and stage-before-recovery, cancellation-before-finalize and finalize-before-cancellation. Confirm rollback after partial stage writes; stale count/id/project/job linkage never invokes child writes; same-attempt duplicate generation rejection; small-pool progress; durable retry/cancel and successful reuse semantics; DB rows and keyframe files remain unchanged after old success/failure/abort; no provider I/O under locks; current successes commit owner and Job together. Adopt leased cancellation scope and account explicitly for legacy reconciliation ordering. Keep existing gates and add the new now-green tests only after the implementation is reviewed and accepted.

## Remote handoff

Only reproduction tests and this proposal are committed/pushed; final SHA is verified at handoff. No fix is claimed. GitHub PR/Issue/Actions APIs remain stopped after the prior Forbidden, with no API retry or credential/proxy/connector workaround. No PR/Issue/remote CI status was obtained this round. Main and all previous branches/worktrees remain unchanged; no merge or release.
