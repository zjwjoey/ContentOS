# Engineering Initialization Plan

This plan is design-only. It is not an execution authorization. Each stage ends with an acceptance check and a human-visible result.

## Stage 0 — Repository and tooling

Create the target repository layout, Node.js 22 LTS + TypeScript workspace, formatting/lint/typecheck/test commands, `AGENTS.md` rules and non-secret environment templates. Do not implement business features.

**Acceptance:** workspace installs on the target Windows host; format, lint, typecheck and an empty test pass; no secrets are committed.

## Stage 1 — Database and migrations

Create PostgreSQL 16 development/test databases, migration up/down tooling and ownership-aware schemas for the first entities only: `ContentProject`, `Asset`, `Job`, `JobAttempt`, `EditManifest`, `Render`, `Account`, `PublishRecord`.

**Acceptance:** fresh database migration up/down, isolated test database creation, constraints/indexes and redaction scan pass.

## Stage 2 — Core infrastructure

Add boot/config validation, correlation IDs, structured logging, error envelopes, storage/queue ports, outbox boundary and the minimum API skeleton. Implement no platform adapter.

**Acceptance:** startup fails closed for missing boot values; secrets are redacted; API returns typed validation/errors; contract tests pass.

## Stage 3 — Job system

Implement the Job contract, attempts, idempotency, dependencies, cancellation, retry classification, leases and the explicit PostgreSQL lease reconciler. Add the selected queue adapter only behind the port.

**Acceptance:** create → claim → success/fail/retry/cancel; duplicate delivery; worker crash/lease expiry; downstream dependency blocking; recovery metrics and events.

## Stage 4 — Worker bootstrap

Create separately supervised Video and Publisher Worker composition roots with bounded concurrency, graceful shutdown, per-worker staging roots and least-privilege configuration.

**Acceptance:** workers claim only their contract types, heartbeat, stop new claims on shutdown and recover expired leases without Core executing long work.

## Stage 5 — Project module

Implement only the ContentProject lifecycle, append-only revision pointers and Asset/Job references required by the first vertical slice.

**Acceptance:** project creation and lifecycle transitions are transactional, auditable and independent from Job/Render state.

## Stage 6 — Asset module

Implement staging → checksum/probe → promotion → Asset record, local storage adapter and cleanup/reconciliation. Keep object-store adapters out of the first slice.

**Acceptance:** no partial canonical Asset is visible; dedupe, Unicode paths, checksum mismatch, orphan/missing-blob scans and crash-window cleanup pass.

## Stage 7 — Video vertical slice

Implement the first closed loop: ContentProject → Asset intake → Video Job → Planner → immutable `EDIT_MANIFEST_V0` → Video Worker → pinned FFmpeg → validated Render Asset → queryable Project result.

**Acceptance:** machine-readable Manifest conformance, five seeded fixtures, structured renderer errors, pinned tool/font capabilities, deterministic output metadata and no Renderer-side creative decisions.

## Explicitly out of this initialization

Full Director, real AI generation, real Douyin/Wechat adapters, analytics Dashboard, generic workflow graphs, advanced timeline/effects, Electron packaging and broad provider integrations.
