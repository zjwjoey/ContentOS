# Architecture Baseline

Scope: source inspection at `27d43854f0571d127bb1ed4ac01334ff294409b2`; no architecture change proposed.

## Preserved invariants

AGENTS.md requires a modular monolith with published contracts and private module tables. Long work uses durable Jobs; request handlers must not execute FFmpeg, browsers or AI generation. PostgreSQL holds business truth; queues carry delivery state. Renderers execute immutable validated `EDIT_MANIFEST_V0`. AI vendors remain behind provider contracts; publishing behavior stays behind PublisherAdapter in the Publisher Worker. Lease recovery, idempotency, cancellation and external-state reconciliation remain required. Secrets and browser sessions must not enter logs or job payloads; core records/events require relevant project/job/attempt/correlation identifiers. Historical research/spikes are not runtime dependencies. Invariant changes need evidence, ADR and review.

## Observed topology

`apps/api/src/app.ts` is the Fastify service composition root; `apps/web` provides the operator UI. CLI, Electron desktop, runtime-core and runtime-client supply launch/control paths. `packages/modules` holds business services; `packages/contracts` and desktop-contract expose validated boundaries. Infrastructure contains PostgreSQL access, pg-boss delivery, local storage and FFmpeg rendering. Worker entrypoints own asynchronous execution; see [inventory](MODULE_INVENTORY.md).

Inspected JobService creation/idempotency and lease/cancellation methods, API composition and representative Video/ProductionRun service excerpts. This establishes implementation locations, not proof of all private-table boundaries or every recovery path. Full service/SQL dependency audit remains open.

## Migration compatibility

Read `packages/database/src/migrator.ts`, `tests/integration/migration-matrix.test.ts` and [V1 reconciliation](../integration/CONTENTOS_V1_MIGRATION_RECONCILIATION.md). Forward inventory is 0001–0046 plus Intelligence 0047–0052. Loader excludes `.down.sql`, sorts forward filenames and records the full filename in schema_migrations under an advisory lock. Desktop `0047_digital_human_duration.down.sql` is retained for historical rollback only. Existing history can coexist with Intelligence 0047; do not rename, replay or remove it. Migration matrix covers fresh installation, partial upgrade, Desktop history coexistence and selected down/reapply paths. No existing migration changes in Phase0.

## Toolchain and evidence limits

Root package pins pnpm 10.32.1; CI selects Node 24 and PostgreSQL 16. Media gates require FFmpeg/FFprobe, libx264, AAC and DejaVu; browser gate installs Playwright Chromium. Desktop embeds a separate PostgreSQL distribution: inspect its upgrade/lifecycle implications separately, rather than assuming CI PG16 proves all embedded behavior.

Windows, real publishing, AI vendor calls, all SQL ownership and crash-injection recovery remain outside this scoped source review. Historical passing CI is useful baseline evidence, not a run of this change.
