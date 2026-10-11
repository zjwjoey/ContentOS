# ADR-020 — Media Analysis runtime uses existing Job fences

Status: Accepted for isolated local implementation and regression, 2026-10-11. The current user authorizes compatible local fixes and additive ports; no production data drain, main merge, historical binding or platform permission is inferred.

## Evidence and decision

Local PostgreSQL regressions reproduce a late technical provider changing replacement width from 640 to 999, and a late provider exception changing replacement SUCCEEDED to FAILED. The staged ADR-019 branch has not activated its owner coordinator and explicitly requires a separate historical drain/activation decision. Do not silently activate that branch or its migration.

The current Media worker passes its actual claimed Job and attempt identity to the existing analyzeRun service as an additive execution context. Every analysis stage query uses JobService.withCurrentAttemptFence, locks Job before the Analysis owner row, validates persisted Job/project/asset linkage, and uses the same transaction executor. Providers, FFmpeg and file reading remain outside short transactions. No Analysis SQL reads Job private tables.

Analysis success and the existing MEDIA_ANALYSIS_RESULT_V1 Job result commit through succeedWithCurrentAttempt in the same transaction. Failure/cancellation use the existing fail/cancelAttempt owner callback. A revoked attempt has no authority to overwrite replacement stages, results or errors; generic Runner observes durable terminal/retry state after owner finalization. Physical keyframes use attempt-specific paths, so stale filesystem work cannot overwrite a replacement frame; only fenced metadata publishes it. Orphan attempt files remain diagnostic artifacts; no automatic deletion is introduced.

Existing unlinked/offline analyzeRun calls retain their signature and legacy file layout. Production dispatch always supplies execution context. Existing completed cache reads and checksum STALE behavior remain compatible. Direct legacy callers without context are not certified as concurrent-safe; they must not be used to bypass Worker dispatch.

Reconciliation discovers Analysis-owned runs, reads the published Job record and revalidates exact inactive state/type/project/attemptCount under a Job-owned transaction before the Analysis update. withInactiveJobFence reuses the terminal scope, query guards, callback isolation and invalidation from ADR-018; it never creates an artificial attempt. A newly claimed RUNNING Job vetoes stale recovery. Lease-cancel callback updates the owner using the recovery executor and persisted linkage, never an untrusted payload runId or a nested pool connection.

## Compatibility and acceptance

No migration, frozen Manifest change, provider replacement, retry/defer budget change or new Job engine. Default domain truth remains PostgreSQL. Tests must cover delayed provider return/error after replacement, atomic completion rollback, cancellation ignoring abort, linkage veto, inactive state rollback/new-claim veto, real FFmpeg attempt keyframes, original queued cancellation, all Intelligence gates and small-pool execution. Historical RUNNING data is recovered through the existing Job states; no adoption/backfill of ADR-019 binding columns occurs.
