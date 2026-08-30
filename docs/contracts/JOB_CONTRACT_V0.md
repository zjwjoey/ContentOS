# Job Contract V0

## Purpose

The Job contract represents durable asynchronous intent. PostgreSQL owns Job state, attempts, leases, dependencies and events. A queue adapter only delivers eligible Job IDs.

## Worker port

```text
create(input, idempotencyKey) -> Job
claim(jobId, workerId, lease) -> Attempt
heartbeat(jobId, attemptId, progress) -> Attempt
succeed(jobId, attemptId, resultRef) -> terminal Job
fail(jobId, attemptId, errorCategory, retryAdvice) -> retry or terminal Job
cancel(jobId, actor) -> CANCEL_REQUESTED/CANCELLED
recoverExpiredLeases(now) -> recovered Job IDs
```

`recoverExpiredLeases` is a mandatory database-backed reconciliation loop. pg-boss may wake/retry work, but it cannot be the only recovery authority.

## Invariants

1. Job creation and its domain transition use one transaction/outbox boundary.
2. Attempts are append-only; a retry never overwrites an earlier outcome.
3. Workers are at-least-once and handlers must be idempotent.
4. Expired `RUNNING`/`CANCEL_REQUESTED` leases transition through an observable recovery path.
5. Retryability is classified; validation, unsupported capability and corrupted input are terminal.
6. Cancellation is cooperative and durable.
7. Payloads contain IDs/revision references, not secrets, media bytes or unvalidated UI data.

## Error and observability contract

Every transition carries `projectId?` or `workspaceId?` as its owning scope, plus `jobId`, `attemptId`, `correlationId`, worker ID, timestamps and a redacted error/result summary. Video Jobs must carry exactly one project/workspace owner; Standalone Quick Edit never creates a fake Project. Lease recovery emits a stable event and metric.
