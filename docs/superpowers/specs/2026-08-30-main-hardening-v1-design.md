# ContentOS Main Hardening V1 Design

## Scope

This hardening line stabilizes the PR #4 main baseline without expanding into AI Vision, Review Analytics, live publishing, or a generic workflow engine. The modular monolith remains the system boundary: PostgreSQL is business truth, durable Jobs carry long-running work, and renderer input is an immutable validated `EDIT_MANIFEST_V0`.

## Decisions

- Operator Web/API bind to `127.0.0.1` by default; alternate hosts require explicit environment configuration.
- Formal Approval owns only `RENDER` and `PUBLISH`. Director owns Script acceptance and Storyboard approval.
- Approval creation is pending-only and exact target validation remains at the API/domain boundary.
- Approval revision allocation and PENDING transitions use one transaction-scoped advisory lock and re-read current state under that lock.
- Project Video uses explicit `STORYBOARD_V1` scene-to-READY-project-asset bindings. Every scene must bind at least one source; no random fallback is allowed.
- Standalone Quick Edit remains `RANDOM_MONTAGE` with deterministic seeded selection.
- Storyboard-generated Manifest clips carry `sceneIndex`; scene and total durations are exact.
- Publisher profile and LocalStorage object paths are validated and contained before filesystem access.
- CI checks are stable: `quality`, `tests`, `web-build`, `browser-acceptance`.

## Compatibility

Historical SCRIPT/STORYBOARD Approval rows remain readable, but new formal Approval writes reject those target types. Existing legacy Director video callers remain supported; the Project Operator route opts into `STORYBOARD_V1` explicitly.

## Verification boundary

Unit/contract, typecheck, lint, formatting, security scan and Web/root builds can run locally. PostgreSQL migration/full integration and browser gates require the configured test database and compatible FFmpeg runtime; CI provisions those dependencies.
