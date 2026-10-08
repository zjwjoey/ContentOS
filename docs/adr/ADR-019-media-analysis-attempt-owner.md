# ADR-019: staged Media Analysis owner binding and coordinated recovery

Status: Accepted with Conditions, 2026-10-08; delegated technical review authorizes isolated implementation/testing, not activation, production migration or merge.

## Decision

Add nullable Analysis-owned active Job attempt id/number binding; retain attempt_count as domain generation. Reject duplicate starts when that attempt is already bound and RUNNING. Reuse unchanged-checksum SUCCEEDED results without recomputation/generation increment. Only a new authorized claimed attempt may resume FAILED/CANCELLED. Unbound legacy RUNNING/terminal rows require explicit drain/first-bind review.

JobAttemptScope exposes additive optional type/project metadata populated from each locked Job row; owner ports require it, preserving existing consumer compatibility. Owner callbacks run on JobAttemptScope: Job → Analysis → children. REUSE/TERMINAL/STALE are explicit; stale throws inside the Job transaction and must be parked by the future Media-only coordinator without generic Runner fallback. Preserve the existing recovery/cancel revocation lease policy. Heartbeat uncertainty parks; immutable attempt-specific artifacts publish only under a fence; orphan cleanup is deferred.

All four global recovery callers (Media, Asset, Video, Digital Human) use JobService.reconcileExpiredLeases. Callback registration only in Media cannot protect them. Add a persisted opt-in requires_owner_recovery flag owned by Job. JobService sets it under the current attempt lock before calling a bound owner; every recovery entry checks it. A flagged Job recovers only through a type-specific same-transaction owner handler; absent handler skips without changing Job/attempt/domain. Unflagged Jobs preserve existing callbacks/default behavior. Flag and domain start commit/rollback together; no worker is opted in during segment one.

## Compatibility / activation gates

Known production analyzeRun caller is Media handler; consumption and registered invocation both use generic JobRunner. Linked integration/reproduction tests also call that path; unlinked closure/planning/gold fixtures retain their offline API. No repository evidence establishes absence of supported external consumers. Existing linked RUNNING cross-table reconciliation remains unsafe for a bound writer. Therefore no production dispatch switch, public linked-call restriction, historical RUNNING binding/backfill or migration rollout is performed now. Activation requires explicit compatibility/drain approval and simultaneous replacement of linked legacy reconciliation at every path.

New forward migration only; existing migrations and historical rollback-only 0047 remain untouched. The Job flag defaults false and binding columns default null. No foreign key reaches across modules. First segment verifies owner start/terminal/recovery ports and Job recovery contract in isolated schemas; coordinator, stage/result publication and files are subsequent increments, not delivered claims.
