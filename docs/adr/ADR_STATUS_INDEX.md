# ADR Status Index — Architecture V0 Freeze

| ADR | Decision | Status | Evidence/condition |
|---|---|---|---|
| ADR-001 | Modular Monolith | Accepted | No Spike contradicts the control-plane boundary |
| ADR-002 | PostgreSQL as System of Record | Accepted | Spike 01 confirms durable Job truth |
| ADR-003 | Durable Job Queue with PostgreSQL Truth | Accepted with Conditions | Mandatory lease reconciliation; pg-boss remains delivery candidate |
| ADR-004 | Direct FFmpeg Rendering for V1 | Accepted with Conditions | Pin supported FFmpeg and explicit font/codec capability checks |
| ADR-005 | Browser Publishing Behind Adapters | Accepted with Conditions | Fake isolation passes; real provider smoke test precedes adapter |
| ADR-006 | Immutable Declarative Edit Manifest | Accepted | Spike 02 confirms deterministic Planner/Renderer boundary |
| ADR-007 | Provider-neutral AI Layer | Accepted | No Spike contradicts provider isolation; real provider remains deferred |
| ADR-008 | Layered Configuration and Secret References | Accepted | Secret references and startup validation remain mandatory |
| ADR-009 | Structured Cross-boundary Observability | Accepted with Conditions | Lease recovery, publisher outcomes and redaction must be metrics/log gates |
| ADR-010 | Canonical Asset System | Accepted with Conditions | Local promotion passes; object-store commit semantics remain gated |
| ADR-011 | Director Application Worker | Accepted with Conditions | ECR-001; explicit composition, supervision, lease recovery and fake-provider gates |
| ADR-012 | Approval Gates vs Post-publish Review | Accepted | Approval binds exact revisions; Review owns MetricSnapshot and performance recommendations |
| ADR-013 | Project-Publisher Integration Through Public Contracts | Accepted | Project owns lifecycle; Publisher exposes a public project summary; handoff creates independent account requests |
| ADR-016 | Operator UI Safe Video Workspace Boundary | Accepted with Conditions | Workspace-scoped media delivery, current Manifest pointer advancement and explicit Asset selection remain contract-mediated |

## Counts

`Accepted: 7` · `Accepted with Conditions: 7` · `Proposed: 0` · `Rejected: 0` · `Superseded: 0`.

## Foundation V2 additive decisions after the freeze index

| ADR | Decision | Status | Evidence/condition |
| --- | --- | --- | --- |
| [ADR-018](ADR-018-queued-media-analysis-cancellation.md) | Job-owned terminal fence for queued Media Analysis cancellation | Accepted with Conditions | Delegated technical review approved compatibility; scoped transaction/owner/fairness regressions and existing gates required |
| [ADR-020](ADR-020-media-analysis-runtime-fencing.md) | Existing Job fences protect production Analysis stages, completion and recovery | Accepted for isolated local implementation | No schema or staged ADR019 activation; late-provider, transaction, cancellation, recovery and FFmpeg regressions required |
| [ADR-021](ADR-021-windows-postgres-process-encoding.md) | Prepare copied PostgreSQL process manifests for UTF-8 paths | Accepted for isolated implementation | Preserve resources/signature refusal and upstream/data bytes; real English Windows and packaged gates required |
| [ADR-022](ADR-022-bounded-consecutive-lease-recovery.md) | Independent durable consecutive lease-loss budget and owner recovery | Accepted with Conditions | User authorized; delegated review approved; third loss stops execution, normal defer/manual retry reset, atomic owners/BLOCKED repair and migration/regression gates required |
