# ADR-014: Director V1 as the Current Source for Project Aggregation

## Status

Accepted for Project Center V0 and Director-to-Video composition.

## Decision

Director V1's `director_project_state` is authoritative whenever a project has a V1 state row. Project Center and Director-to-Video consume the Director module's public project summary, including active Script/Storyboard aggregate and revision IDs and video readiness.

The Director public summary reads active target IDs and their readiness from one database statement, so a concurrent state transition cannot mix an old Approval target with a newer readiness result. Director-to-Video receives the current Brief, Script and Storyboard through the same single-statement snapshot; it never combines a separately-read pair with a later state check.

For projects without a V1 state row, the read path may fall back to the legacy `DIRECTOR_PLAN_V0` service. The fallback is deterministic and read-only: V1 and legacy records are never merged, and a V1 read failure is reported as unavailable rather than masked by legacy data.

## Consequences

- Project Center, Director UI and Director-to-Video agree on the same current Director pair.
- Historical legacy projects remain visible while new product paths use V1.
- A future migration may retire the legacy fallback after existing projects are migrated; no automatic lossy conversion is introduced in this slice.
