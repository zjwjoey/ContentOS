# Spike 01 Job / Queue / Worker Report

## Result

**PASS WITH CONDITIONS**

All six required scenarios passed against a real local PostgreSQL 16.15 instance and pg-boss 12.27.0. The result is conditional because the spike adds an explicit database Lease Reconciler; pg-boss delivery alone is not treated as the business source of truth.

## Environment

| Item | Value |
|---|---|
| Operating system | Windows (local development host) |
| Node.js | 24.14.0 |
| PostgreSQL | 16.15, 64-bit |
| pg-boss | 12.27.0 |
| Queue schema | `spike01_queue` |
| Job schema | `spike01` |
| Normal worker count | 1 |
| Crash scenario workers | crash child + recovery worker |

## Scenario results

| Scenario | Result | Evidence |
|---|---|---|
| Long job: create -> queue -> claim -> progress -> success | PASS | 0/20/40/60/80/100 progress persisted; terminal `SUCCEEDED` |
| Worker crash | PASS | child process killed at 20%; expired DB lease reconciled; new worker completed with attempt >= 2 |
| Retry | PASS | intentional failures on attempts 1 and 2; attempt 3 succeeded; all attempt outcomes retained |
| Permanent failure | PASS | `max_attempts=3`; three failures ended in durable `FAILED` |
| Duplicate delivery | PASS | two queue deliveries produced one business execution |
| Cooperative cancellation | PASS | `CANCEL_REQUESTED` observed by worker and safely ended as `CANCELLED` before 100% |

## Findings

1. PostgreSQL reliably held Job state, progress, attempts, events and errors independently of the pg-boss queue row.
2. pg-boss delivered work and retried thrown handler failures, but a crashed process left an active queue row until maintenance. The safe ContentOS pattern is an explicit database Lease Reconciler that re-enqueues expired `RUNNING` Jobs.
3. Idempotency must be enforced in the Job handler. A second delivery is harmless when the business record is already terminal or another valid lease owns it.
4. Cancellation is cooperative and must remain a durable Job state; killing a process is not a successful cancellation acknowledgment.
5. A worker crash test must register the child exit listener immediately after spawn; otherwise Windows process timing can make the test hang while the process has already exited.

## Architecture V0 change request

No blocker requires changing the modular-monolith, PostgreSQL-truth or independent-worker decisions. The following clarification should be carried into formal engineering initialization:

- Job workers must run a database-backed lease reconciliation loop that transitions expired `RUNNING/CANCEL_REQUESTED` records to `RETRY_WAIT` and re-delivers them through the queue.
- pg-boss is a delivery/retry mechanism, not the only crash-recovery authority.
- Queue supervisor configuration and reconciliation intervals must be observable and tested under the target process supervisor.

## Decision

`pg-boss` remains the first V0 queue candidate: **PASS WITH CONDITIONS**.
