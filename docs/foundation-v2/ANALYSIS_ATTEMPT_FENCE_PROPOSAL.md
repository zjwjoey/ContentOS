> Historical protocol review at 1ec0692. Conservative choices and isolated segment-one implementation are now recorded in [ADR-019](../adr/ADR-019-media-analysis-attempt-owner.md) and [segment evidence](ANALYSIS_ATTEMPT_SEGMENT1.md). In particular, duplicate starts are rejected rather than taking over generations. Statements below about no implementation describe the historical review checkpoint; production activation remains unapproved.

# Active Media Analysis attempt fencing: red reproduction and minimal contract proposal

Status: **RED / revised proposal only; no implementation**, 2026-10-08.

Independent contract review found two blockers in the initial terminal plan: callback no-write does not veto Job terminalization, and generic JobRunner fallback can terminalize without an owner. The revised protocol below supersedes that initial plan. Owner decisions and acceptance remain required; no runtime, schema or runner changes are authorized by this document.

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

## Additional terminal and Runner red evidence

Fresh task-owned postgres:16 container `contentos-fv2-analysis-terminal-test`, loopback 55439, verified **contentos_test / PostgreSQL 16.15**. Same guarded reset and per-test owned-schema isolation as above. New probes do not call any provider (fake or real); they use fixture-owned SQL to model generation 2 and reject generation 1, then call actual existing JobService and JobRunner. Their SQL is test scaffolding, not implementation of an owner port.

Expanded suite executed twice with identical results: **14 tests: 2 PASS / 12 FAIL / zero skipped** each. The original 4 red cases remain. Added 9 probes yield 1 PASS / 8 FAIL. The new failures are negative demonstrations of an unsafe candidate protocol, not a claim that generic Job APIs promised owner-veto semantics. Their raw generic calls remain historical probes; future acceptance must exercise the reviewed owner/coordinator wrapper with the same state-safety assertions, rather than silently change all generic callers:

| Probe | Actual behavior | Missing guarantee |
| --- | --- | --- |
| succeedWithCurrentAttempt callback owner UPDATE matches zero rows and returns STALE_GENERATION | Job SUCCEEDED, owner generation 2 still RUNNING | Success callback return is stored as result, not a veto. |
| fail(callback) owner UPDATE matches zero rows | Job FAILED, owner generation 2 still RUNNING | Void/no-write callback does not veto failure. |
| cancelAttempt(callback) owner UPDATE matches zero rows | Job CANCELLED, owner generation 2 still RUNNING | Void/no-write callback does not veto cancellation. |
| Stale-generation callback throws inside success transaction; handler rethrows to real Runner | Initial transaction demonstrably rolls back to RUNNING; Runner.fail then makes Job FAILED | Transaction rollback alone does not prevent fallback terminalization. |
| requestCancel between final current-attempt check and handler return/pulse | Job CANCELLED, owner RUNNING | Runner.cancelAttempt omits owner callback. |
| Heartbeat transport ERROR injected by a JobService subclass; claim/fail remain real DB APIs | Job RETRY_WAIT, owner RUNNING | Runner turns heartbeat uncertainty into ownerless fail. |
| Handler throws AbortError after requestCancel | Job CANCELLED, owner RUNNING | Catch-path cancellation also omits owner callback. |
| Handler returns structured STALE_GENERATION | Job SUCCEEDED, owner RUNNING | Arbitrary handler return goes through generic succeed. |
| Actual old Job attempt recovered/replaced before handler throws | Replacement Job/attempt remains RUNNING | PASS: generic Runner protects different Job-attempt identity; same-attempt generation is the unprotected distinction. |

Relevant base lines: JobService succeedWithCurrentAttempt `:278–284`, fail `:168–176`, cancelAttempt `:306–312`; JobRunner return/pulse/fallback `:386–401`. A rowCount=0 or returned result is not a transactional precondition in these APIs. Throwing inside the callback rolls back, but generic Runner catch reclassifies the control outcome as a business error. Abort reasons must not collapse user cancellation, revoked ownership and heartbeat uncertainty into one terminal decision.

```bash
CONTENTOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/contentos_test ./node_modules/.bin/tsx --test --test-concurrency=1 tests/integration/media-analysis-attempt-fence.test.ts
```

Current associated suite rerun: **22/22 PASS**, zero skipped. Current format/lint/typecheck/build/diff checks pass. Red logs: `/tmp/fv2-analysis-terminal-red.log`, `/tmp/fv2-analysis-terminal-red-repeat.log`; related log: `/tmp/fv2-analysis-terminal-existing.log`; reset/build logs have the same prefix. Full new suite remains unregistered in green gates and is not claimed as a fix.

## Revised minimum protocol: worker-specific coordination

**Recommended review direction: a MediaAnalysis-specific runner/coordinator.** It uses existing JobService claim/heartbeat/stage/terminal fences, but owns *all* success, failure, cancellation and control exits for MEDIA_ANALYSIS. Both worker consumption and registered invocation use it. No global JobRunner default, callback meaning or other worker is silently changed. An explicit opt-in global terminal hook is an alternative only if Owner prefers it; such a hook would have to intercept every return/catch/pulse branch, not merely add an onSuccess callback. This proposal does not implement either option.

### Identity, start and duplicate policy

Every owner read/write inside a transaction checks persisted runId/jobId/projectId/assetId linkage, the supplied current Job attemptId/attemptNumber, and pinned Analysis generation (existing attempt_count). Lock order is always **Job → Analysis run → Analysis children**, including start, success, failure, cancellation, recovery and stage deletion. No child write precedes owner validation. No analysis lock is held while opening a Job/pool connection. All callback queries are awaited and executor-only; no external I/O or transaction control.

Generation and Job attempt number are distinct. The initial proposal did not durably bind a domain generation to a Job attempt. To remove retry/duplicate ambiguity, propose an additive nullable run-side `active_job_attempt_id` / `active_job_attempt_number` binding, with no cross-module FK. A new forward migration would be reviewed separately; no migration is added now, and frozen config/fingerprint snapshots must not be repurposed for mutable control state. An alternative avoiding these fields must prove equivalent durable ownership, rather than assume domain attempt_count equals Job attempt number. Legacy linked rows need an explicit first-bind/cutover policy.

Proposed duplicate policy is **safe generation takeover**, not two writers sharing one generation. Under the current Job fence, the owner locks the run and advances its generation, pinning the binding to the same current Job attempt. The old computation may finish externally, but every stage and terminal callback sees a stale generation and rolls back/parks. It stops its own heartbeat/task only; it does not fail/cancel/succeed the shared Job or delete the winner's files. Persisted binding distinguishes a same-attempt duplicate from a new authorized Job attempt. Rejecting duplicates instead is an Owner alternative; no implicit generation replacement is acceptable.

A run in FAILED/CANCELLED can restart only after an authorized retry has requeued/reclaimed its linked Job into a *new* current attempt, checked against the stored binding. A direct call or duplicate same-attempt invocation cannot revive it. QUEUED/old RUNNING recovery resume is permitted only under current Job authority and reviewed binding rules. Existing successful unchanged-checksum reuse returns REUSE: no generation increment, no provider recomputation, no result rewrite. A changed-checksum successful run remains subject to the existing stale-source policy. Source checking retains the current snapshot semantics; no new atomic asset-freeze guarantee is claimed.

### Three owner outcomes, with transactional meaning

| Owner decision under both locks | Meaning | Coordinator action |
| --- | --- | --- |
| REUSE | Persisted successful run and unchanged-checksum results legitimately satisfy this authorized current Job; result data/generation unchanged (authority binding may be refreshed under lock) | Success callback may return the existing result **only after** validating REUSE under lock, allowing the Job success commit. Zero owner UPDATE is legitimate for this one explicit case. |
| TERMINAL | Matching current Job attempt, bound generation and allowed run state permit a specific success/fail/cancel owner transition | Write owner/results using scope; existing Job API performs its corresponding terminal transition in the **same transaction**. No post-return generic terminalization. |
| STALE_GENERATION / STALE_OWNER | Identity, binding or generation is no longer authoritative; not a business/provider failure | Throw a dedicated control sentinel **inside the Job callback**, before Job terminal writes. Entire transaction rolls back. Media coordinator catches it **outside** the Job API and parks/returns authoritative state; it never throws/returns this outcome into generic JobRunner. |

A TERMINAL callback must throw if its expected conditional owner write fails; returning false or doing nothing is insufficient. Owner code throws the same control sentinel for a rejected generation. REUSE and TERMINAL must have explicit validated return discriminants; zero rowCount alone cannot distinguish them. The coordinator must never call plain succeed/fail/cancelAttempt for linked Analysis, and must not infer authority from a previously read Job snapshot or signal.

### Coordinator exits and race handling

1. Provider/stage work returns computation only; provider/FFmpeg/file I/O occurs outside locks. Each publish uses withCurrentAttemptFence and owner validation. Stale stage outcome parks without a domain error write.
2. Success/reuse uses succeedWithCurrentAttempt with the validating owner callback. Failure uses fail(callback) only for an actual classified provider/business error, with matching binding/generation. A callback veto rolls back and parks, never becomes another fail call.
3. Job CANCEL_REQUESTED uses cancelAttempt(callback) on the matching current generation. If cancel wins before success/fail locking, those APIs skip; the coordinator re-resolves authoritative Job state and enters the owner cancellation callback. A stale caller cannot close a newer generation: its sentinel parks and current coordinator/recovery handles cancellation.
4. If success commit wins first, requestCancel no longer changes SUCCEEDED; if cancellation wins first, success cannot publish. There is no separate owner-final-check → generic pulse → Job terminal window. Once owner+Job commit finishes, later heartbeat errors or handler return cannot run a second terminal decision.
5. Heartbeat ERROR means uncertain transport, not proof of business failure or user cancellation. Recommended behavior is park/stop this computation, retaining current durable state for recovery; no ownerless fail. A validated coordinated failure policy is an Owner alternative. Signal abort records provenance: user cancel, stale ownership/generation and transport uncertainty have different control paths. ABORT_ERR alone is not authority to write CANCELLED.
6. Actual different Job-attempt ownership revocation skips/parks. Same-attempt generation rejection also parks, despite heartbeat still reporting ACTIVE. Outstanding work may be released/cancelled outside locks, and only its own invocation resources may be stopped.

### Recovery and legacy reconciliation cutover

Lease policy stays **recovery/cancel revokes authority**, not pure lease timestamp expiry. Preserve existing clock/recovery behavior; do not silently add a timestamp check to the current fence.

Lease-cancel uses the already supplied JobAttemptScope; Intelligence validates persisted linkage and the currently bound generation using that same connection. It opens no new pool connection and never trusts payload alone. To replace linked RUNNING legacy reconciliation safely, propose a narrowly additive, optional Job lease-recovery owner callback for *normal* recovery as well as the existing cancel callback. It executes under the existing Job lock/current expiring attempt validation, before recovery state commits, and receives scope plus intended recovery outcome. Analysis then changes that matching RUNNING generation to QUEUED (normal recovery) or CANCELLED (cancellation), preserving applicable results. Failure/veto rolls back recovery; default behavior for other modules remains unchanged. This is an additional API requiring review; existing normal recovery has no such callback.

At Media cutover, remove linked records from the old UPDATE...FROM jobs reconciliation path and route all linked recovery through these callbacks. Legacy reconciliation must not run concurrently on linked fenced records, even temporarily: its stale joined snapshot can overwrite a fenced owner transition. Unlinked offline rows can retain a separately bounded owner-only policy. No new cross-read of Job private tables from Intelligence/worker is permitted. Keeping legacy linked reconciliation active is a release blocker, not deferred cleanup.

### Keyframe publication

Use immutable paths that include run + Job attempt + Analysis generation + content/file identity. Generate files outside transactions, then only fenced-publish their references. Never write or overwrite shared run/shot paths; never interpret “file exists” as permission to reuse across attempt/generation. Legitimate unchanged-checksum REUSE references the already published immutable result. No stale cleanup may delete another generation's files or currently referenced artifacts; initially leave orphan cleanup deferred to a separately reviewed reconciliation policy. Storage_key consumers must follow persisted references, not reconstruct the old path. All DB keyframe referenced/ready/failed writes follow the same owner protocol.

### Linked/unlinked public compatibility and Owner decisions

Keep the existing unlinked/offline public analyzeRun(runId, signal) behavior and signature. Linked writes require durable authority and use the new coordinated path; an unauthorised linked call must fail before any write/provider. Read-only reuse could be allowed under an explicit policy, but must not mutate successful source-stale state without authority. Existing tests that call linked analyzeRun for reuse/source changes must migrate explicitly.

**Owner decisions before implementation:** nullable attempt binding and legacy first-bind policy; safe duplicate takeover versus rejection; linked public-call restriction and handler/Runner consumer migration; atomic per-stage replacement versus retained nonauthoritative partial results during retry; heartbeat uncertainty parking policy; normal lease-recovery hook and removal of legacy linked reconciliation; immutable keyframe path consumer migration. These are additive schema or behavioral changes with compatibility impact, not silently approved routine fixes. No runtime/schema change is made in this round.

## Impacted callers and incremental implementation plan

| Caller/surface checked | Required adaptation if approved |
| --- | --- |
| `workers/media-intelligence-worker/src/main.ts:39–44` consumption | Use Media coordinator instead of generic JobRunner for this job type only. |
| Same file `:70–78` registered invocation | Use the same coordinator; no alternate generic terminal path. |
| `workers/media-intelligence-worker/src/handler.ts:13–20` | Carry real Job attempt authority; separate computation from owner publish/terminal protocol. Signature/behavior migration must be explicit. |
| Same worker `main.ts:30–37` recovery | Use supplied cancellation scope, optional normal-recovery owner hook; disable linked legacy cross-table reconcile in the same cutover. |
| Intelligence analyzeRun/generateKeyframes/persistEmbedding/result methods | Preserve unlinked mode; authority-guard linked stage/terminal writes and publish immutable artifact references. |
| `tests/integration/intelligent-editing-v15.test.ts:26–27` | Replace generic Runner use; explicit authority for linked reuse/source-stale checks; stop reconstructing legacy keyframe path. |
| `tests/worker/media-intelligence-worker.test.ts` | Extend fakes for coordinator ports; retain start/consume/cancel/restart expectations. |
| `tests/integration/intelligent-analysis-closure-v15.test.ts`, `intelligent-planning-v15.test.ts`, `intelligent-gold-v15.test.ts` | Verify which fixtures are unlinked, retaining their offline public calls; add authority only where linked. |
| Existing JobRunner callers in Asset/Video/DigitalHuman/Publisher/Director | No default protocol or behavior change. Existing Job integration/runner tests remain gates. |
| New red tests and queued-cancellation branch | Turn contract tests green after acceptance; explicit integration with ADR-018 later, never a hidden merge. |

Implementation remains blocked on design approval, with small separately reviewable increments:

1. Approve ADR, Owner policies, full caller inventory and nullable binding/legacy cutover plan. Record acceptance for REUSE/TERMINAL/STALE and all coordinator exits; no runtime change in this proposal commit.
2. Add reviewed forward migration (if binding chosen) and owner start/stage/terminal ports with same-connection predicates, trusted callback rules and partial-stage replacement policy. Verify veto rollback and valid REUSE. New ports alone remain unused by production until the coordinated cutover is ready.
3. Add Media-only coordinator and optional normal lease-recovery callback, preserving other modules. Atomically switch both Media dispatch paths and recovery, excluding linked legacy reconciliation; enable DB-only paths only when all terminal/Runner red cases turn green. No interim mixed linked legacy/fenced writer release.
4. Add immutable keyframe paths and fenced reference publication, migrate consumers and add stale filesystem completion/cleanup tests. Keep any incompletely adapted keyframe path unavailable to the new coordinated mode until this increment passes.
5. Verify unlinked compatibility and linked authority decisions; run existing gates, real lock-order tests, restart/retry/cancel/small-pool tests. Only then append now-green regressions to existing CI, preserving all jobs. No merge/release is authorized here.

## Dependencies and limits

- **ADR-018 / 99d324a is not a required implementation dependency for active attempt authority.** This branch has no such commit imported. Existing active JobAttemptScope and terminal callbacks can be reused, with explicit callback veto and a Media-only coordinator; a reviewed optional normal-recovery callback and durable binding policy are additional requirements. Queued terminal cancellation and active attempt cancellation are distinct; a terminal JobCancellationScope cannot replace a current attempt scope. If the implementation later reuses ADR-018 callback guard machinery or composes its queued scan, explicitly declare/review that dependency before integrating either branch.
- **Additive Intelligence application ports require ADR + architecture review before implementation**, per AGENTS.md. This document is the review input, not an accepted ADR or an authorization to implement.
- Existing active scopes do not have ADR-018's stronger statement/nested-call guards. Proposed callbacks must be trusted, awaited, executor-only SQL with no transaction control/nested pool/Job calls/external I/O. Hardening the shared active scope is not bundled into this proposal.
- Existing withCurrentAttemptFence checks state/attempt ownership, **not lease_expires_at wall-clock validity**. The demonstrated guarantee begins once existing recovery has invalidated the old attempt, or cancellation changes Job state. A strict “no write after timestamp expiry before recovery” policy needs a separately reviewed predicate change; no such guarantee is claimed here.
- Unlinked analyzeRun keeps its public signature/behavior. Linked callers require reviewed authority constraints and explicit migration; generic Runner usage is unsupported for linked Media finalization after the proposed cutover. These compatibility decisions remain Owner decisions.
- Provider retry budgets, costs, fingerprint/config schemas, historical migrations, and EDIT_MANIFEST_V0 are unchanged. No real-provider cancellation, restart/full browser/Windows/remote CI validation is claimed.

## Required acceptance after design approval

Make the four original business regressions and eight new state-safety requirements pass through the reviewed Media owner/coordinator paths, retaining both passing controls and the raw negative-probe evidence. Changing the tested invocation to the explicit new wrapper is a required caller migration, not permission to weaken state assertions or change default generic Runner behavior. Raw negative probes must not be registered unchanged as impossible-to-green global Job API requirements. Add observed real PostgreSQL lock-order tests for recovery-before-stage and stage-before-recovery, cancellation-before-finalize and finalize-before-cancellation. Confirm rollback after partial stage writes; stale count/id/project/job linkage never invokes child writes; same-attempt duplicate generation rejection, callback veto and no generic Runner fallback for all exits; small-pool progress; durable retry/cancel and successful reuse semantics; DB rows and keyframe files remain unchanged after old success/failure/abort; no provider I/O under locks; current successes commit owner and Job together. Adopt leased cancellation scope and account explicitly for legacy reconciliation ordering. Keep existing gates and add the new now-green tests only after the implementation is reviewed and accepted.

## Remote handoff

Only reproduction tests and this proposal are committed/pushed; final SHA is verified at handoff. No fix is claimed. GitHub PR/Issue/Actions APIs remain stopped after the prior Forbidden, with no API retry or credential/proxy/connector workaround. No PR/Issue/remote CI status was obtained this round. Main and all previous branches/worktrees remain unchanged; no merge or release.
