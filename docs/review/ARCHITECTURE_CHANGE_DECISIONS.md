# Architecture Change Decisions

All four Spike change requests are accepted as evidence-backed clarifications. No request is rejected. Follow-up validations are explicitly deferred rather than silently treated as complete.

| Request | Decision | Accepted V0 change | Documents updated | Deferred follow-up |
|---|---|---|---|---|
| Spike 01 — Job lease recovery | **ACCEPT** | PostgreSQL lease reconciliation is mandatory; pg-boss is delivery/retry support, not Job truth | `JOB_SYSTEM_V0`, `WORKER_ARCHITECTURE_V0`, `JOB_CONTRACT_V0`, ADR-003 | Validate supervisor timing and recovery metrics in initialization |
| Spike 02 — Manifest/FFmpeg boundary | **ACCEPT** | Keep immutable `EDIT_MANIFEST_V0`, thin deterministic builder, atomic output promotion and explicit tool/font capability checks | `VIDEO_MODULE_V0`, `TECH_STACK_V0`, ADR-004 | Benchmark a pinned supported FFmpeg build and GPU options |
| Spike 03 — Asset promotion | **ACCEPT** | Keep SHA-256 identity, staging/validation/promotion separation, atomic local commit and stale-temp reconciliation | `ASSET_SYSTEM_V0`, `TECH_STACK_V0`, ADR-010 | Validate conditional-create/complete semantics for a selected object store |
| Spike 04 — Publisher isolation | **ACCEPT** | Keep Worker → Adapter → Playwright isolation, canonical error taxonomy, profile isolation and logging redaction | `PUBLISHER_MODULE_V0`, `PUBLISHER_ADAPTER_CONTRACT_V0`, `ARCHITECTURE_INVARIANTS`, ADR-005/009 | Run a separately authorized provider sandbox smoke test with pinned Playwright/browser versions |

## Decision counts

`ACCEPT: 4` · `REJECT: 0` · `DEFER: 0` for the four submitted architecture requests. The deferred items above are implementation validations attached to accepted decisions, not unresolved architecture alternatives.
