# ADR-003: Durable Job Queue with PostgreSQL Truth

**Status:** Accepted with Conditions

## Context

Rendering and publishing are slow, failure-prone and must survive process restarts.

## Decision

Model work as persistent Jobs with attempts, events, leases, retries and idempotency. Use a queue adapter for delivery; evaluate pg-boss first in the initialization spike.

## Consequences

Handlers are at-least-once safe and recover expired leases. The spike may choose another adapter only if it preserves the Job contract and database truth; such a replacement requires an ADR update.

Every long-running handler renews its lease while its current attempt remains active. Job completion and failure are fenced by `attemptId` plus the persisted attempt number: a recovered or superseded attempt may finish locally, but it cannot update the Job's current state or result. Lease recovery marks the expired attempt terminal before a newer attempt can be claimed.

The Job application contract also exposes a narrow current-attempt transaction scope for module-owned side effects. It locks the Job attempt authority, verifies the current RUNNING attempt, and gives published module services one short-lived executor backed by that same PostgreSQL transaction. The scope is branded, cannot be constructed by consumers, and rejects use after the transaction closes. Orchestration code only passes the scope between public contracts; it does not issue SQL or read/write module-private tables.

Render start uses this scope to validate Job ownership and the active attempt. Finalization uses the same connection to commit Asset catalog rows, Render success, JobAttempt success, Job result and their events atomically. It does not hold one pool connection while callbacks borrow another, so concurrent attempts cannot exhaust the four-connection pool through nested acquisition. Filesystem promotion can precede the database commit; rollback may therefore leave an unreferenced content-addressed blob, but never a READY Asset row. Asset reconciliation already classifies such blobs as orphans.

Cancellation is cooperative and terminal. A running Job transitions to `CANCEL_REQUESTED`; heartbeat stops renewing the lease and aborts the handler through `AbortSignal`. The Video handler then atomically records Render, JobAttempt and Job as `CANCELLED` through the same attempt transaction. For a crashed handler, lease recovery requires a module cancellation callback and invokes it inside the current attempt transaction before closing JobAttempt and Job. The callback returns `handled`; unknown Job types and missing callbacks leave `CANCEL_REQUESTED` unchanged instead of claiming a false terminal state. Video supplies a public recovery callback that cancels its current Render without Job reading Video tables.

Expired Jobs are discovered as a batch but reconciled one Job per transaction with state and lease revalidation under row lock. A poisoned module callback rolls back only that Job, appends a safe `job.lease_recovery_failed` event when the database remains available, and does not stop unrelated expired Jobs. The composed Video Worker runs reconciliation immediately on startup and then on an independent periodic timer; shutdown stops the timer and awaits any active pass, so recovery liveness does not depend on a new delivery. Queued and retry-ready `VIDEO_RENDER` Jobs are likewise discovered from PostgreSQL on startup and by an independent bounded polling loop. Both timers are installed before the initial consumption pass starts, so a long first render cannot block lease recovery or Worker startup. Delivery remains an optional low-latency wake-up path rather than the only execution trigger. Shutdown stops both loops and awaits active passes. Queued or retry-waiting work cancels immediately. Success and failure transitions accept only a current `RUNNING` attempt, so a late handler cannot overwrite cancellation.
