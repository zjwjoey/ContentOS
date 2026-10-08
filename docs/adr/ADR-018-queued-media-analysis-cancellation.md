# ADR-018 — Job-owned terminal cancellation fence for queued Media Analysis

Status: Accepted with Conditions, 2026-10-08.

Technical review in the delegated task approved this additive application contract as compatible with existing executor patterns. The prior red regression at b1749327 proves a terminal CANCELLED Job can leave its domain run QUEUED. Review authorizes the narrow implementation below; actual acceptance tests and remote CI remain separate evidence.

## Decision and reviewed contract

- JobService owns the transaction and acquires the first row lock with SELECT FOR UPDATE. After the lock, exact id/type/project, CANCELLED state and a non-negative integer expectedAttemptCount must match before callback execution. Zero-attempt cancellation receives a terminal Job scope, never a fabricated attempt.
- The callback uses a transaction-local executor. It cannot BEGIN/COMMIT/ROLLBACK, nest/pool-call JobService, perform external I/O or leave queries in flight. Lifecycle invalidation occurs before release. Owner exceptions roll back all owner changes. Scope query validation, in-flight checking and callback-context guards protect the supported usage; external I/O prohibition remains a caller contract, not a sandbox for arbitrary callbacks.
- Intelligence updates only its own run, conditional on runId + expectedJobId + expectedProjectId + QUEUED. Fixed MEDIA_ANALYSIS_JOB_CANCELLED metadata and coalesced finished_at preserve first completion information. Attempts/results and RUNNING/SUCCEEDED/FAILED/STALE are not changed. executed=true with rowChanged=false differs from a rejected fence.
- Persisted run/job/project linkage is authoritative; job payload never selects the target run.
- Worker discovery is bounded and releases its query connection before the Job→analysis lock path. Stable id keyset continuation and a cycle high-water bound allow wraparound without starvation behind permanently pending/malformed candidates. Malformed candidate failures are isolated, and the cursor still progresses.
- attemptCount is a revalidation value, not a cancellation-generation token. Requeue/cancel without a new attempt may keep the count; the locked current terminal state and domain linkage/QUEUED condition remain necessary.

No schema, provider, defer, retry-budget, HTTP schema or existing gate is replaced. Existing unfenced analyzeRun and legacy cross-table RUNNING reconciliation are separate audit tasks; this decision does not claim to fix all analysis attempt races.

## Required acceptance

Original red case green with zero provider calls and restart idempotency; real row-lock tests for both requeue/fence orders; stale attempt/type/project/linkage/missing/malformed rejection; write-then-throw rollback; invalidated scope rejection; transaction/nested Job callback rejection; small-pool progress; fair scan past uncancelled candidates and wraparound; completed/active state and result preservation. Add the new green suite to the existing Intelligent Editing gate, retain every old gate, and record focused/associated execution honestly.

## Rejected shortcuts

Non-locking get→markCancelled and expanding Intelligence SQL over jobs do not provide the reviewed transaction/ownership contract. A new workflow engine, migration, global cancellation generation or broad provider rewrite is unnecessary and outside scope.
