# Active Analysis segment 1: binding and owner recovery foundation

2026-10-08. Isolated branch codex/fv2-analysis-attempt-fence, base 27d43854f0571d127bb1ed4ac01334ff294409b2. [ADR-019](../adr/ADR-019-media-analysis-attempt-owner.md) records the approved conservative choices. This segment is independently testable infrastructure; it is not the full active-analysis fix, coordinator cutover or production migration rollout.

## Precondition A: global recovery coverage

Repository search found all production recovery entrypoints call JobService.reconcileExpiredLeases:

- Media worker main.ts:31.
- Asset worker main.ts:27.
- Video worker main.ts:169.
- Digital Human worker dev-main.ts:20.

Registering a handler in the Media worker alone would permit a different worker's global sweep to invalidate an opted-in attempt without changing its domain record. The implemented contract persists requires_owner_recovery in Job. A new withOwnerRecoveryAttemptFence sets this opt-in under the existing Job lock and invokes the owner start on that same transaction connection. Owner rejection rolls both back. Every recovery entry therefore observes the flag irrespective of process/JobService instance. Type-specific handlers are supplied via an additive third parameter; flagged jobs with no matching handler skip recovery and cannot use the old cancellation callback as a bypass. Other jobs default false and retain existing behavior. Recovery callback exceptions roll back all owner/Job/attempt changes and use existing isolated recovery diagnostics. The lease policy remains recovery/cancel revocation, not pure wall-clock fencing.

No production worker calls the new start fence, and no worker is registered with the new dispatcher in this segment. Future adoption can register the Media owner only in its process without unsafe sweeps from other processes: outsiders park flagged jobs. Recovery availability depends on the owner process or an explicitly configured owner dispatcher; it must be supervised at cutover. Legacy unflagged Media remains on its historical behavior until approved migration/drain.

## Precondition B: caller / compatibility inventory

- API intelligent-editing-routes.ts:23–25 attaches a Job only to a QUEUED unlinked run; it does not rebind an existing linked run. This is an indirect linked lifecycle caller, whose create/enqueue behavior must be preserved.
- Production analyzeRun has one source caller: Media handler.ts:18; main.ts:42–44 consumption and :70–78 registered invocation both instantiate generic JobRunner. Neither is switched now.
- Linked intelligent-editing-v15.test.ts:26 runs that handler under generic Runner; :27 makes linked direct reuse/source-stale calls and reconstructs old keyframe paths. These need explicit adaptation at cutover.
- Historical media-analysis-attempt-fence.test.ts uses the linked handler/public APIs for red reproduction. New media-analysis-owner.test.ts uses only owner ports.
- Closure, planning and gold integration tests construct unlinked runs and use offline analyzeRun; their API and result behavior are retained. worker mock coverage retains its existing handler/run behavior.
- Existing reconcileStaleRuns is invoked by Media worker main.ts:37 and legacy analysis tests; its linked RUNNING UPDATE...FROM jobs is unchanged here. It must be safely excluded/replaced in the same future activation as the coordinator, not run beside bound writers.
- No production analyzeRun source call was found in apps/ or scripts/. This does not prove that exported library APIs have no supported external callers.

**Activation remains blocked on supported external linked-call compatibility and a safe legacy RUNNING drain/first-bind plan.** Existing unbound RUNNING/FAILED/CANCELLED rows are rejected by the new start port; no lazy adoption/backfill, public linked API restriction, worker switch or legacy reconciliation removal is performed. This preserves the unknown compatibility boundary rather than treating it as approved. The seven ordinary protocol choices are recorded as approved conservative implementation choices, not additional user questions.

## Implemented independent segment

New forward/down pair 0053 adds nullable Analysis attempt id/number (paired positive-number constraint) and default-false Job recovery flag. Historical migrations, filename-based loader and rollback-only historical 0047 remain unchanged. No cross-module foreign key is added.

MediaAnalysisAttemptOwner has same-connection start, terminal and recovery ports, no pool and no provider. It verifies persisted run/job/project/asset linkage against additive locked-Job type/project scope metadata, scoped Job attempt and pinned generation. Duplicate bound/RUNNING starts reject without advancing generation. Only a newer authorized attempt can restart bound FAILED/CANCELLED; legacy unbound non-QUEUED records require drain. Successful checksum-matching REUSE preserves results, timestamps and generation, refreshing authority binding only. STALE throws a control sentinel inside the Job transaction, vetoing all Job terminal writes. Recovery uses supplied scope, preserves completed results and resets matching active generations atomically. These trusted callbacks require awaited executor-only SQL; generic Runner fallback remains unsupported and unmodified.

Child stage writers, Media coordinator, immutable file paths and E2E integration are **not implemented** in this segment. Existing red business/Runner probes still describe unfixed production paths; the passing owner tests are not a claim those probes are green.

## Test evidence

Fresh task-owned postgres:16 container contentos-fv2-analysis-owner-test, loopback 55440; current_database contentos_test verified. Guarded reset only in this fresh isolated DB; unique owned schemas per contract test. No real provider/network service. Every provider method in the owner fixture throws PROVIDER_CALL_FORBIDDEN; all new owner tests perform zero provider calls. Existing gate tests may run local FFmpeg and fixture providers, with zero external provider calls.

Commands:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55440/contentos_test CONTENTOS_TEST_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55440/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55440/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/job.test.ts tests/integration/migration-matrix.test.ts tests/unit/test-database-safety.test.ts tests/integration/media-analysis-owner.test.ts
DATABASE_URL=postgresql://postgres@127.0.0.1:55440/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55440/contentos_test corepack pnpm test:intelligent-editing-v15
corepack pnpm format
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
```

Final actual result: owner contract **10/10 PASS**, zero provider calls; Job + migration matrix + test DB safety + owner suite **39/39 PASS**, zero skipped; full Intelligent Editing gate **38/38 PASS**, zero skipped. format PASS (412 files), lint PASS (218 TypeScript files), typecheck/build/git diff --check PASS. The historical production/Runner red suite rerun remains **2 PASS / 12 FAIL**, proving the unfinished integration is not being called green; log /tmp/fv2-analysis-owner-remaining-red.log. New migration applied only in isolated test schemas/database, never a business database. Logs: /tmp/fv2-analysis-owner-matrix.log, /tmp/fv2-analysis-owner-test.log (initial seven), /tmp/fv2-analysis-owner-gate.log, /tmp/fv2-analysis-owner-build.log. Test service is stopped after verification. Only the new green owner suite is appended to the existing Intelligent Editing gate; every old entry and six workflow jobs are retained, historical red probes stay outside that green gate.

## Remaining increments

Next review should validate the persisted recovery policy and first-bind guards independently. After compatibility/drain approval, implement the Media-only coordinator and owner stage writers, simultaneously replacing both dispatch paths and linked legacy reconciliation; verify Runner exits and recovery from other instances. Then add immutable attempt-specific files/fenced publication, followed by production Runner/E2E and complete regression checks. No migration rollout, merge or release is authorized by this segment; GitHub API actions remain stopped after Forbidden.

## P1 follow-up: claim-before-owner-start crash gap

Independent review found that requires_owner_recovery remains true after retry, while recover previously required binding equality. After attempt1 recovery, a claim2 crash before owner.start left binding1 and the registered dispatcher could not recover attempt2. The same gap existed after authorized requeue of FAILED/CANCELLED runs.

Before the fix, all six QUEUED/FAILED/CANCELLED × normal/CANCEL_REQUESTED real-PG cases failed with recovery count 0; log /tmp/fv2-crash-gap-six-red.log (earlier queued pair: /tmp/fv2-crash-gap-red.log). The fix accepts only the validated current Job scope with an older non-active binding. Normal recovery preserves the domain snapshot; cancellation preserves completed/already-cancelled records or changes pending state in the same Job transaction. No new binding/generation is invented. A later claim can start normally or REUSE completed results. Old RUNNING/same-number-other-id/future bindings and wrong owner/linkage reject; absent dispatcher still skips. Write-then-throw handlers roll back Job, attempt and owner changes.

New cases also cover completed reuse, retained binding/generation, authorized third claim, stale old attempt rejection, and rollback. Final owner suite **19/19 PASS**; Job + migration matrix + safety + owner regression **48/48 PASS**, zero skipped. format/lint/typecheck/diff checks PASS. Six required crash-gap cases were red before the fix and are now green; no real provider calls. Current command:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:55441/contentos_test CONTENTOS_TEST_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1:55441/contentos_test CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55441/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/job.test.ts tests/integration/migration-matrix.test.ts tests/unit/test-database-safety.test.ts tests/integration/media-analysis-owner.test.ts
```

Fresh task-owned PostgreSQL16.15/contentos_test container on loopback55441, guarded reset then owned schemas; provider methods remain forbidden in these fixtures. Logs /tmp/fv2-crash-gap-green.log (17 owner tests before completed-result additions), /tmp/fv2-crash-gap-regression.log. This follow-up does not enable production paths or resolve pending external-call/legacy-drain compatibility. Full Intelligent Editing 38/38 above is historical b1be083 evidence; current follow-up runs the targeted DB/owner/migration regression and static checks.
