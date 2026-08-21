# Spike Conditions Review

## Classification

- **A — before formal engineering initialization:** architecture/runtime contract or safety rule required before the repository is initialized.
- **B — before the affected module implementation:** concrete implementation gate for the corresponding module.
- **C — engineering rule:** repeatable quality or test practice that enters normal development gates.
- **D — deferred:** useful follow-up, but not a V0 approval blocker.

| Spike | Condition | Severity | Must Fix Before Dev? | Architecture Impact | Action |
|---|---|---:|:---:|---|---|
| 01 | PostgreSQL lease reconciliation must recover expired `RUNNING`/`CANCEL_REQUESTED` Jobs; pg-boss is delivery only | A | Yes | Makes recovery authority explicit | Add to Job/Worker contracts and initialization acceptance |
| 01 | Queue supervisor, lease interval and recovery count must be observable | B | Yes | Adds operational evidence to worker infrastructure | Implement before Job infrastructure is accepted |
| 02 | Pin a supported FFmpeg distribution and declare codec/font capabilities at startup | A | Yes | Converts a host-dependent tool into a runtime contract | Add to Tech Stack and Video Worker bootstrap |
| 02 | Manifest/operation conformance and structured renderer errors are required before Video implementation | B | Yes | Preserves Planner/Renderer separation | Add renderer contract fixtures and capability checks |
| 02 | GPU throughput and production performance profile are unverified | D | No | No V0 boundary change | Re-evaluate before scale/throughput commitments |
| 03 | Staging, checksum validation, atomic promotion and stale-temp reconciliation are Asset invariants | A | Yes | Defines canonical Asset commit semantics | Add to Asset contract and initialization acceptance |
| 03 | Remote object-store conditional commit/multipart semantics remain unverified | B | Before object-store adapter | Constrains storage adapter selection | Validate when an object-store adapter is introduced |
| 04 | Stable publisher error taxonomy, profile isolation and secret redaction are mandatory | A | Yes | Makes external side effects safely observable/retryable | Add to Publisher contract, invariants and logging gates |
| 04 | Real Playwright/browser/provider smoke test is required before a real adapter | B | Before adapter | Does not block fake-platform unit tests | Run only with separately authorized sandbox credentials |
| 04 | Fake Platform remains the default unit-test boundary | C | No | Keeps CI deterministic and safe | Adopt as the normal publisher test rule |

## Review conclusion

The conditions clarify and strengthen the existing V0 boundaries. None requires a redesign of the modular monolith, PostgreSQL truth, fixed workflow, immutable Manifest or independent workers.
