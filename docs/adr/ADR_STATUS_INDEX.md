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

## Counts

`Accepted: 5` · `Accepted with Conditions: 6` · `Proposed: 0` · `Rejected: 0` · `Superseded: 0`.
