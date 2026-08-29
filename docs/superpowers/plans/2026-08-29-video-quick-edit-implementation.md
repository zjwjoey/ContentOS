# ContentOS Video Quick Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded Quick Edit vertical slice that creates immutable Manifest versions from explicit trim/remove/reorder operations and renders the selected version through the existing durable Video Worker.

**Architecture:** The Video module owns Quick Edit validation and append-only Manifest version persistence. The API composes public Video, Asset and Job contracts; it never reads another module’s private tables. A render Job carries an exact `manifestId` and revision, and the Worker consumes that persisted Manifest without invoking the creative planner.

**Tech Stack:** TypeScript, Fastify, PostgreSQL migrations, Node test runner, Next.js, Playwright, FFmpeg.

---

### Task 1: Define the Quick Edit contract and migration

**Files:**

- Create: `packages/modules/video/src/quick-edit.ts`
- Create: `migrations/0014_video_quick_edit.sql`
- Create: `migrations/0014_video_quick_edit.down.sql`
- Modify: `packages/modules/video/src/index.ts`
- Modify: `tests/integration/migration-matrix.test.ts`
- Create: `tests/contract/video-quick-edit.test.ts`
- Modify: `tests/integration/database.test.ts`

- [x] **Step 1: Write failing contract tests**

  Add tests for the three explicit operations and rejection of negative timing,
  duplicate reorder indexes, incomplete reorder indexes, and an empty final
  timeline. The test fixture must use a valid `EDIT_MANIFEST_V0` with three
  non-adjacent clips. The public parser must return the normalized operation
  union and never accept an unknown operation type.

- [x] **Step 2: Run the contract tests and confirm RED**

  Run:

  ```powershell
  pnpm tsx --test tests/contract/video-quick-edit.test.ts
  ```

  Expected: FAIL because `parseQuickEditOperations` and the operation types do
  not exist.

- [x] **Step 3: Implement the contract and persistence columns**

  Export `QuickEditOperation`, `QuickEditManifestInput` and
  `parseQuickEditOperations`. The parser must require integer `clipIndex`,
  `sourceInMs` and `durationMs`, and for REORDER require an integer array.
  Apply the existing `validateEditManifest` after all operations are applied.

  Add migration `0014_video_quick_edit.sql`:

  ```sql
  alter table edit_manifests
    add column parent_manifest_id text references edit_manifests(id),
    add column edit_operations jsonb not null default '[]'::jsonb,
    add column created_by text,
    add column idempotency_key text,
    add column input_digest text;

  alter table edit_manifests
    add constraint edit_manifests_created_by_check
    check (created_by is null or length(trim(created_by)) between 1 and 200);

  create unique index edit_manifests_quick_edit_idempotency_key
    on edit_manifests(project_id, idempotency_key)
    where idempotency_key is not null;
  ```

  The down migration must drop the index, constraint and five columns. Update the
  migration matrix and database migration assertions from `0013` to `0014`.

- [x] **Step 4: Run focused checks and commit**

  Run:

  ```powershell
  pnpm tsx --test tests/contract/video-quick-edit.test.ts tests/integration/migration-matrix.test.ts
  pnpm typecheck
  ```

  Expected: all focused tests pass and the migration matrix applies cleanly
  from the empty database and from the `0001`–`0006` subsets.

  ```powershell
  git add packages/modules/video/src/quick-edit.ts packages/modules/video/src/index.ts migrations tests/contract/video-quick-edit.test.ts tests/integration/migration-matrix.test.ts tests/integration/database.test.ts
  git commit -m "feat: define Video Quick Edit contract"
  ```

### Task 2: Persist immutable Quick Edit Manifest versions

**Files:**

- Create: `packages/modules/video/src/quick-edit-service.ts`
- Modify: `packages/modules/video/src/index.ts`
- Create: `tests/integration/video-quick-edit.test.ts`

- [ ] **Step 1: Write failing service tests**

  Cover:

  - a valid edit writes revision `vN+1`, points `parent_manifest_id` to `vN`,
    marks only `vN` SUPERSEDED and stores the exact operation JSON;
  - a foreign project, non-current parent or non-READY source returns a safe
    error without writing a row;
  - the same idempotency key returns the existing version, while the same key
    with different operations returns `VIDEO_MANIFEST_IDEMPOTENCY_CONFLICT`;
  - two concurrent edits serialize on the project lock and cannot produce the
    same revision number.

- [ ] **Step 2: Run the service tests and confirm RED**

  Run:

  ```powershell
  $env:DATABASE_URL='postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test'
  pnpm tsx --test --test-concurrency=1 tests/integration/video-quick-edit.test.ts
  ```

  Expected: FAIL because `VideoQuickEditService` is not implemented.

- [ ] **Step 3: Implement `VideoQuickEditService`**

  Use the public `AssetCatalogService` to resolve every clip’s current READY
  source and duration. Apply operations to a deep copy of the parent Manifest,
  rewrite each clip’s source path from the project-owned Asset summary, and run
  `validateEditManifest` before opening the database transaction.

  In one transaction, acquire
  `pg_advisory_xact_lock(hashtext('contentos:video-manifest:' || projectId))`,
  re-read the current PERSISTED parent, calculate `max(revision)+1`, mark its
  prior PERSISTED row SUPERSEDED, and insert the new row with
  `parent_manifest_id`, `edit_operations`, `created_by`, `idempotency_key` and
  `input_digest`. A unique violation on the project/key index must resolve to
  the original result only when the canonical input digest matches.

  Expose `listManifests(projectId)` and `getManifest(projectId, manifestId)`
  with safe fields only: IDs, revision, status, parent ID, operations,
  manifest, creator and timestamps. No storage credentials or diagnostics may
  cross this boundary.

- [ ] **Step 4: Run focused tests and commit**

  Run the service integration test, `tests/contract/edit-manifest.test.ts`,
  `pnpm typecheck` and `pnpm format`.

  ```powershell
  git add packages/modules/video/src/quick-edit-service.ts packages/modules/video/src/index.ts tests/integration/video-quick-edit.test.ts
  git commit -m "feat: persist immutable Quick Edit manifest versions"
  ```

### Task 3: Render an exact edited Manifest through the durable Worker

**Files:**

- Modify: `packages/modules/video/src/video-service.ts`
- Modify: `workers/video-worker/src/video-handler.ts`
- Modify: `apps/api/src/video-routes.ts`
- Modify: `tests/integration/video-workspace-api.test.ts`
- Modify: `tests/unit/video-handler-idempotency.test.ts`
- Create: `tests/e2e/video-quick-edit-vertical-slice.test.ts`

- [ ] **Step 1: Write failing exact-version tests**

  Add API assertions for Manifest list/detail, Quick Edit creation and render
  Job payload. Add a Worker test that inserts two valid Manifest versions with
  different timelines, creates a Job pointing at the second, and proves the
  rendered result uses the second timeline. Assert that a missing version,
  mismatched revision or changed source checksum fails before FFmpeg and does
  not create a READY output Asset.

- [ ] **Step 2: Run tests and confirm RED**

  Run:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/video-workspace-api.test.ts tests/unit/video-handler-idempotency.test.ts tests/e2e/video-quick-edit-vertical-slice.test.ts
  ```

  Expected: FAIL because the API has no Manifest routes and Video Worker only
  plans from `videoAssetIds`.

- [ ] **Step 3: Add exact Manifest Job support**

  Extend the Video public payload with optional `manifestId` and
  `manifestRevision`. Add `createManifestRenderJob(projectId, manifestId)` to
  `VideoService`; its idempotency key must include project, manifest ID and
  revision. Update `planJob` so the manifest branch loads the exact project row,
  checks revision and READY source checksums, and returns it without calling
  `buildVideoManifest`. Keep the existing Director-to-Video planner path
  unchanged for jobs without `manifestId`.

  Add the four Video routes described in the design document. Route handlers
  validate project ownership and delegate to `VideoQuickEditService`,
  `VideoService` and `JobService`; they must return 404/409/422 envelopes and
  never execute FFmpeg.

  Keep `createVideoJobHandler` on the same attempt fence, cancellation and
  atomic output promotion path. Only the source of the immutable Manifest
  changes.

- [ ] **Step 4: Run focused tests and commit**

  Run the exact-version API, Worker and E2E tests, then `pnpm typecheck` and
  `pnpm build`.

  ```powershell
  git add packages/modules/video/src/video-service.ts workers/video-worker/src/video-handler.ts apps/api/src/video-routes.ts tests/integration/video-workspace-api.test.ts tests/unit/video-handler-idempotency.test.ts tests/e2e/video-quick-edit-vertical-slice.test.ts
  git commit -m "feat: render exact Quick Edit manifest versions"
  ```

### Task 4: Add the operator Quick Edit UI and final acceptance

**Files:**

- Modify: `apps/web/app/projects/[id]/video/page.tsx`
- Modify: `tests/e2e/project-navigation-web.test.ts`
- Create: `tests/e2e/video-quick-edit-web.test.ts`
- Modify: `docs/superpowers/reports/2026-08-29-video-quick-edit-report.md`
- Modify: `progress.md`

- [ ] **Step 1: Write the failing UI and browser assertions**

  Add static assertions for current Manifest version, timeline operation
  controls, Quick Edit submission, Manifest preview, exact render Job and
  version history. Add a browser journey that edits one clip, saves vN+1,
  verifies the preview, renders it, and confirms the output and new approval
  target are tied to vN+1.

- [ ] **Step 2: Implement the smallest UI flow**

  Load Manifest summaries and the current version from the Video API. Render
  timeline rows with controlled trim fields, remove and move controls. Keep
  edits in local state until “生成 Quick Edit 版本” submits the operation
  list. Show the returned immutable version before enabling “创建渲染 Job”.
  Poll the returned Job with the existing bounded refresh loop. After success,
  show the output preview and create a new exact Render Approval; do not reuse
  the prior version’s approval.

- [ ] **Step 3: Run the complete verification gate**

  ```powershell
  $env:DATABASE_URL='postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test'
  $env:CONTENTOS_TEST_ADMIN_DATABASE_URL='postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test'
  pnpm format
  pnpm lint
  pnpm typecheck
  pnpm build
  pnpm --dir apps/web build
  pnpm test:migrations
  pnpm test
  pnpm test:browser
  pnpm doctor
  git diff --check
  ```

  Expected: every command exits zero; the browser harness must continue using
  its own schema and process tree.

- [ ] **Step 4: Record and commit the acceptance report**

  Record exact counts, the immutable-version behavior, the exact Worker
  payload, failed validation cases and the browser journey. State explicitly
  that Planner V2, single-clip replacement, real adapters and Review Analytics
  remain closed.

  ```powershell
  git add apps/web/app/projects/[id]/video/page.tsx tests/e2e docs/superpowers/reports/2026-08-29-video-quick-edit-report.md progress.md
  git commit -m "docs: record Video Quick Edit acceptance"
  ```

Stop after this commit for human review. Do not merge, push, freeze a new
architecture boundary or start Planner V2 until the report is accepted.
