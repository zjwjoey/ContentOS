# ContentOS Unified Product Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the accepted ContentOS integration branch into one browser-operated Fake Platform product flow covering Project → Assets → Director → Video → Approval → Publisher → Project Center, while preserving module boundaries and durable Job execution.

**Architecture:** Branch only from the user-accepted `integration/contentos-v1` head. Add a durable Asset Import boundary in which HTTP handlers stream uploads into a bounded staging area and enqueue `ASSET_IMPORT`; an Asset Worker performs checksum, media probing, storage promotion, deduplication, and business-state transitions. Add thin Asset/Video/Approval APIs backed by owning-module public services, then organize the existing Director and Publisher capabilities into a shared project shell. No request handler runs FFmpeg, FFprobe, browsers, or AI generation.

**Tech Stack:** Node.js 22 LTS, TypeScript 5.8, pnpm 10, PostgreSQL 16, Fastify 5, Zod 4, Next.js 14, React 18, FFmpeg/FFprobe, Playwright 1.62, Node test runner.

---

## Entry Gate and non-goals

- Required input: a user-accepted, clean, remotely pushed `integration/contentos-v1` branch.
- Output branch: `codex/unified-product-flow`.
- Output worktree: `E:\ContentOS\.worktrees\unified-product-flow`.
- Product route sequence: `/projects/:id` → `/assets` → `/director` → `/video` → `/approvals` → `/publisher`.
- `Review` remains reserved for post-publication analytics; all pre-publication decisions are `Approval` or `Approval Gate`.
- Explicitly excluded: real AI, live Douyin/WeChat calls, Review analytics, advanced timeline editor, template marketplace, generic workflow engine, multi-tenant auth, and merge to `main`.

## Task 1: Create the Stage 2 worktree from the accepted integration head

**Files:**

- Verify: `docs/superpowers/reports/2026-08-29-contentos-integration-closure.md`
- Modify: `progress.md`

- [ ] Fetch and verify that the local and remote integration heads are identical:

  ```powershell
  git fetch origin integration/contentos-v1
  git rev-parse integration/contentos-v1 origin/integration/contentos-v1
  git status --short --branch
  ```

  Expected: both SHAs match and the current worktree is clean.

- [ ] Read the Stage 1 report and verify every Gate is marked passed and the report explicitly says no Live Smoke was performed.

- [ ] Verify the target worktree and branch do not exist, then create them:

  ```powershell
  git branch --list codex/unified-product-flow
  git worktree list --porcelain
  git worktree add E:\ContentOS\.worktrees\unified-product-flow -b codex/unified-product-flow integration/contentos-v1
  ```

- [ ] Install and run the accepted baseline:

  ```powershell
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  pnpm --dir apps/web build
  ```

  Expected: the Stage 1 pass count is reproduced before product work begins.

- [ ] Append the exact accepted integration SHA and baseline result to `progress.md`, then commit:

  ```powershell
  git add progress.md
  git commit -m "docs: record unified flow baseline"
  ```

## Task 2: Freeze browser-facing contracts and the shared product vocabulary

**Files:**

- Create: `packages/contracts/src/asset.ts`
- Create: `packages/contracts/src/video.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/web/app/projects/[id]/product-model.ts`
- Create: `tests/contract/asset-import.test.ts`
- Create: `tests/contract/video-workspace.test.ts`
- Create: `tests/e2e/project-navigation-web.test.ts`
- Modify: `package.json`

- [ ] Write RED contract tests for:

  - `AssetImportV0` with `STAGED | QUEUED | PROCESSING | READY | DEDUPED | FAILED | CANCELLED`;
  - safe `AssetSummaryV0` fields with no local path;
  - `VideoWorkspaceSnapshotV0` with current Director pair, selectable READY source assets, current/historical renders, Job progress, and exact Approval target;
  - project stages named `ASSETS`, `DIRECTOR`, `VIDEO`, `APPROVALS`, `PUBLISHER`;
  - UI copy containing `Approval Gate` and never using `Review` for pre-publish confirmation.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/contract/asset-import.test.ts tests/contract/video-workspace.test.ts tests/e2e/project-navigation-web.test.ts
  ```

- [ ] Implement immutable browser-safe contracts and a Web-only product navigation model. Keep Job payload types in the owning modules; do not turn `packages/contracts` into a workflow engine.

- [ ] Export the contracts from `packages/contracts/src/index.ts` and add the three tests to the root `pnpm test` script.

- [ ] Run focused tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/contract/asset-import.test.ts tests/contract/video-workspace.test.ts tests/e2e/project-navigation-web.test.ts
  pnpm typecheck
  ```

  Expected GREEN: contracts reject unsafe paths/fields and the product vocabulary is fixed.

- [ ] Commit:

  ```powershell
  git add packages/contracts apps/web/app/projects/[id]/product-model.ts tests package.json
  git commit -m "feat: define unified operator contracts and navigation"
  ```

## Task 3: Add durable Asset Import persistence

**Files:**

- Create: `migrations/0012_asset_imports.sql`
- Create: `migrations/0012_asset_imports.down.sql`
- Create: `packages/modules/asset/src/asset-import-service.ts`
- Modify: `packages/modules/asset/src/index.ts`
- Create: `tests/integration/asset-import.test.ts`
- Modify: `tests/integration/database.test.ts`
- Modify: `tests/integration/migration-matrix.test.ts`

- [ ] Write RED tests for an Asset-owned `asset_imports` record with project scope, nullable unique Job ID during the initial `STAGED` state, sanitized original name, staged file reference, kind, byte size, state, output Asset ID, safe error code/message, and timestamps.

- [ ] Include idempotency and transition tests:

  - one import ID maps to one `ASSET_IMPORT` Job;
  - repeated completion returns the same output Asset;
  - `PROCESSING` may finish only as `READY`, `DEDUPED`, `FAILED`, or `CANCELLED`;
  - a record from Project A cannot be read or completed through Project B;
  - no credential, browser state, or authorization field is accepted.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/asset-import.test.ts tests/integration/database.test.ts
  ```

- [ ] Add migration `0012_asset_imports` with a required Project foreign key, nullable unique Job foreign key, and nullable output Asset foreign key; add indexes on `(project_id, created_at desc)` and runnable state. Permit a null Job only while the state is `STAGED`; the down migration drops only the new indexes/table.

- [ ] Implement `AssetImportService` as the sole owner of `asset_imports` SQL. Its public API must expose `createStaged`, `attachJob`, `get`, `list`, `markProcessing`, `complete`, `fail`, and `cancel`; it must not access Job private tables. `attachJob` is the only `STAGED → QUEUED` transition.

- [ ] Extend migration inventory/matrix expectations from `0001`–`0011` to `0001`–`0012`, then run:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/asset-import.test.ts tests/integration/database.test.ts
  pnpm test:migrations
  ```

  Expected GREEN: clean install and both historical upgrade paths apply `0012` after the accepted Stage 1 chain.

- [ ] Commit:

  ```powershell
  git add migrations packages/modules/asset tests/integration
  git commit -m "feat: add durable asset import records"
  ```

## Task 4: Add bounded HTTP staging and Asset Import API

**Files:**

- Create: `apps/api/src/asset-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/infrastructure/storage/src/local-storage.ts`
- Modify: `packages/infrastructure/storage/src/index.ts`
- Modify: `packages/modules/asset/src/asset-catalog-service.ts`
- Create: `tests/integration/asset-api.test.ts`
- Create: `tests/helpers/test-api.ts`
- Modify: `tests/integration/director-api.test.ts`
- Modify: `tests/integration/director-v1-api.test.ts`
- Modify: `tests/integration/director-video-api.test.ts`
- Modify: `tests/integration/project-api.test.ts`
- Modify: `tests/integration/project-center-api.test.ts`
- Modify: `tests/integration/publisher-product-api.test.ts`
- Modify: `tests/integration/review-api.test.ts`
- Modify: `tests/e2e/video-vertical-slice.test.ts`

- [ ] Add `@fastify/multipart` to `apps/api` and create RED route tests for:

  - multipart `POST /api/v1/projects/:projectId/asset-imports`;
  - `GET /api/v1/projects/:projectId/asset-imports`;
  - `GET /api/v1/projects/:projectId/assets` through `AssetCatalogService`, with no direct Asset SQL in `app.ts`;
  - `GET /api/v1/projects/:projectId/assets/:assetId/content` for a project-owned READY Asset;
  - rejection of missing project, unsupported MIME/type, empty file, filename traversal, and bytes over the configured limit.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/asset-api.test.ts
  ```

- [ ] Extend `LocalStorageProvider` with upload-staging operations that stream to a server-generated `.part` filename without hashing or probing. The route may await the upload stream, but it must not run FFmpeg/FFprobe, calculate SHA-256, or promote into object storage.

- [ ] Implement `registerAssetRoutes`. After staging succeeds, create the `STAGED` record through `AssetImportService`, create one idempotent `ASSET_IMPORT` Job whose payload contains only `schemaVersion`, `projectId`, `importId`, and `correlationId`, then call `attachJob` to enter `QUEUED`. On Job creation or attachment failure, mark the import `FAILED`, request cancellation for any Job already created, and delete only that import's staged file.

- [ ] Refactor `buildApi` to accept an explicit `ApiRuntimeDependencies` object containing storage and upload limits. Add `tests/helpers/test-api.ts` and update every existing `buildApi` caller listed above so tests use unique temporary storage roots.

- [ ] Serve Asset content only after public Asset service ownership checks. Set `content-type`, `content-length`, `accept-ranges: bytes`, and a checksum ETag; never return `storageKey`, absolute path, or upload staging path in browser JSON.

- [ ] Run API tests and regressions:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/asset-api.test.ts tests/integration/project-api.test.ts tests/integration/director-video-api.test.ts tests/integration/publisher-product-api.test.ts
  pnpm typecheck
  ```

  Expected GREEN: uploads stage and enqueue without executing media work in the handler.

- [ ] Commit:

  ```powershell
  git add apps/api packages/infrastructure/storage packages/modules/asset tests package.json pnpm-lock.yaml
  git commit -m "feat: add bounded browser asset upload API"
  ```

## Task 5: Implement the Asset Worker with lease, idempotency, cancellation, and cleanup

**Files:**

- Create: `workers/asset-worker/package.json`
- Create: `workers/asset-worker/src/asset-handler.ts`
- Create: `workers/asset-worker/src/main.ts`
- Create: `workers/asset-worker/src/dev-main.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `scripts/dev-operator.ts`
- Modify: `packages/config/src/config.ts`
- Modify: `.env.example`
- Modify: `packages/modules/asset/src/asset-service.ts`
- Modify: `packages/modules/asset/src/asset-import-service.ts`
- Create: `tests/worker/asset-worker.test.ts`
- Create: `tests/e2e/asset-import-vertical-slice.test.ts`
- Modify: `package.json`

- [ ] Write RED Worker tests for valid video/audio import, checksum dedupe, probe failure, missing staged file, duplicate delivery, stale attempt fencing, lease recovery, cancellation before promotion, cancellation after preparation, and `.part` cleanup.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/worker/asset-worker.test.ts tests/e2e/asset-import-vertical-slice.test.ts
  ```

- [ ] Implement an `ASSET_IMPORT` handler using `JobRunner`. Outside the final short transaction it must:

  1. resolve the Asset-owned import record;
  2. hash the staged bytes;
  3. run FFprobe through the infrastructure boundary;
  4. validate declared kind against probe result;
  5. promote the immutable blob.

  Inside the current Job attempt fence, it must commit the Asset row/project link, import terminal state, JobAttempt, Job terminal state, and events atomically.

- [ ] Preserve the existing branded `PreparedAssetImport` ownership checks. Extend the preparation API for a pre-staged upload without allowing arbitrary callers to forge a READY Asset.

- [ ] Add autonomous PostgreSQL polling, lease recovery, heartbeat, cancel callback, and shutdown behavior matching the Video Worker. One poison import must not block other imports.

- [ ] Add `ASSET_WORKER_CONCURRENCY`, `ASSET_UPLOAD_MAX_BYTES`, and `ASSET_UPLOAD_STAGING_ROOT` with bounded defaults; wire the Asset Worker into `pnpm dev:operator`.

- [ ] Run focused tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/worker/asset-worker.test.ts tests/e2e/asset-import-vertical-slice.test.ts
  pnpm typecheck
  ```

  Expected GREEN: one uploaded file yields one durable Asset or one safe terminal failure; duplicate delivery never duplicates the Asset.

- [ ] Commit:

  ```powershell
  git add workers/asset-worker packages/modules/asset packages/config scripts/dev-operator.ts .env.example package.json pnpm-workspace.yaml tests
  git commit -m "feat: process durable asset imports in Asset Worker"
  ```

## Task 6: Build the Assets product page

**Files:**

- Create: `apps/web/app/projects/[id]/assets/page.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `tests/e2e/assets-web.test.ts`
- Modify: `package.json`

- [ ] Write a RED Web test asserting the page uploads video/audio, polls import status, lists READY/DEDUPED assets, shows duration/dimensions/format/size, previews supported assets through the content endpoint, and links to Director.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/assets-web.test.ts
  ```

- [ ] Implement the page as an API-backed client component. Show explicit states `上传中`, `排队中`, `处理中`, `可用`, `已去重`, `失败`, `已取消`; do not expose storage paths or raw error objects.

- [ ] Add keyboard labels, disabled/busy states, safe error messages, responsive desktop layout, and an empty-state action. Do not add direct FFmpeg/browser code to Web.

- [ ] Run Web and build gates:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/assets-web.test.ts
  pnpm --dir apps/web build
  ```

  Expected GREEN: the new route compiles and all required API paths/copy are present.

- [ ] Commit:

  ```powershell
  git add apps/web tests/e2e/assets-web.test.ts package.json
  git commit -m "feat: add project Assets workspace"
  ```

## Task 7: Complete the Director handoff into Video

**Files:**

- Modify: `apps/web/app/projects/[id]/director/page.tsx`
- Modify: `apps/web/app/projects/[id]/product-model.ts`
- Modify: `tests/e2e/director-web.test.ts`
- Modify: `tests/e2e/project-navigation-web.test.ts`

- [ ] Add RED tests requiring the Director page to show the current accepted Script/approved Storyboard pair, explain blocked prerequisites, link back to Assets, and provide one `进入 Video` action only when the pair is valid.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/director-web.test.ts tests/e2e/project-navigation-web.test.ts
  ```

- [ ] Update the existing page without changing Director persistence or AI contracts. Keep Fake AI as the only default provider and preserve manual revision/accept/approve behavior.

- [ ] Run focused tests and Web build:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/director-web.test.ts tests/e2e/project-navigation-web.test.ts
  pnpm --dir apps/web build
  ```

- [ ] Commit:

  ```powershell
  git add apps/web/app/projects/[id]/director/page.tsx apps/web/app/projects/[id]/product-model.ts tests/e2e
  git commit -m "feat: hand approved Director pair to Video workspace"
  ```

## Task 8: Add safe Video workspace reads and actions

**Files:**

- Modify: `packages/modules/video/src/video-project-read-service.ts`
- Modify: `packages/modules/video/src/index.ts`
- Create: `apps/api/src/video-routes.ts`
- Modify: `apps/api/src/app.ts`
- Create: `tests/integration/video-workspace-api.test.ts`
- Modify: `tests/integration/video-project-read.test.ts`

- [ ] Write RED service/API tests for:

  - `GET /api/v1/projects/:projectId/video` returning current Director pair, READY source videos/audio, current manifest/render, output Asset, render history, safe Job progress, and exact Render Approval;
  - `POST /api/v1/projects/:projectId/video/jobs` accepting explicit source Asset IDs and optional voice/subtitle/duration/seed;
  - `POST /api/v1/projects/:projectId/video/jobs/:jobId/cancel` only for a Job owned by that Project;
  - no payload, diagnostics, lease owner, storage key, or local path in the response.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/video-project-read.test.ts tests/integration/video-workspace-api.test.ts
  ```

- [ ] Extend `VideoProjectReadService` with safe project-scoped queries owned by Video. Compose Approval and Asset public services in the API layer; do not join another module's private table from Video.

- [ ] Move the existing `/video-jobs/from-director` behavior behind `registerVideoRoutes`, preserving the old route as a compatibility alias. Use `JobService.requestCancel` only after verifying project ownership through its public record.

- [ ] Run focused tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/video-project-read.test.ts tests/integration/video-workspace-api.test.ts tests/integration/director-video-api.test.ts
  pnpm typecheck
  ```

  Expected GREEN: the API exposes enough safe state for the Video page and no long-running work runs in Fastify.

- [ ] Commit:

  ```powershell
  git add packages/modules/video apps/api tests/integration
  git commit -m "feat: add safe Video workspace API"
  ```

## Task 9: Build the Video workspace and exact Render Approval handoff

**Files:**

- Create: `apps/web/app/projects/[id]/video/page.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `tests/e2e/video-web.test.ts`
- Modify: `tests/e2e/project-navigation-web.test.ts`
- Modify: `package.json`

- [ ] Write a RED Web test requiring source selection, voice selection, target duration, subtitle text, render creation, Job polling/progress, cancellation, output preview, render history, and `送往 Approval Gate` bound to the exact `renderId` plus `outputAssetId` revision target.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/video-web.test.ts tests/e2e/project-navigation-web.test.ts
  ```

- [ ] Implement the page. Disable render creation until Director and source-asset prerequisites are satisfied. The renderer receives only the immutable persisted `EDIT_MANIFEST_V0`; the Web page never invents post-persistence creative choices.

- [ ] Preview the READY output through the project-scoped Asset content API. Display safe Job error codes/messages and a retry action that creates/reuses an idempotent Job rather than editing an in-flight Job.

- [ ] Run Web gates:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/video-web.test.ts tests/e2e/project-navigation-web.test.ts
  pnpm --dir apps/web build
  ```

- [ ] Commit:

  ```powershell
  git add apps/web tests/e2e/video-web.test.ts tests/e2e/project-navigation-web.test.ts package.json
  git commit -m "feat: add minimal Video product workspace"
  ```

## Task 10: Add the dedicated Approval Gate page

**Files:**

- Modify: `apps/api/src/approval-routes.ts`
- Create: `apps/web/app/projects/[id]/approvals/page.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `tests/integration/approval-list-api.test.ts`
- Create: `tests/e2e/approvals-web.test.ts`
- Modify: `package.json`

- [ ] Write RED tests for `GET /api/v1/projects/:projectId/approvals`, returning only current decisions for `RENDER` and `PUBLISH` with safe target summaries, and for a page that can create PENDING, approve, or reject the exact target revision.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/approval-list-api.test.ts tests/e2e/approvals-web.test.ts
  ```

- [ ] Add the project-scoped list route by calling `ApprovalService.list` and composing safe target labels through Video/Publisher public services. Do not add cross-module joins inside Approval.

- [ ] Implement two sections only: `成片 Approval Gate` and `发布 Revision Approval Gate`. Rejection requires a reason. Approved decisions are append-only and cannot be edited in place.

- [ ] Ensure route names, headings, buttons, tests, and API errors never call these decisions `Review`.

- [ ] Run focused tests and Web build:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/approval-list-api.test.ts tests/e2e/approvals-web.test.ts tests/integration/approval.test.ts
  pnpm --dir apps/web build
  ```

- [ ] Commit:

  ```powershell
  git add apps/api/src/approval-routes.ts apps/web tests/integration/approval-list-api.test.ts tests/e2e/approvals-web.test.ts package.json
  git commit -m "feat: add exact-revision Approval workspace"
  ```

## Task 11: Complete the Fake Publisher workspace without enabling real adapters

**Files:**

- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `tests/integration/publisher-product-api.test.ts`
- Modify: `tests/e2e/publisher-web.test.ts`
- Modify: `tests/worker/publisher-product-worker.test.ts`

- [ ] Add RED tests requiring the page to show Fake Account creation, Render Asset handoff, immutable Revision details, exact Approval state, queue action, Job state, every PublishAttempt, human-action reason, reconciliation state/action, confirmed ExternalPost, and the `PUBLISHED` terminal state.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/publisher-product-api.test.ts tests/e2e/publisher-web.test.ts tests/worker/publisher-product-worker.test.ts
  ```

- [ ] Extend only browser-safe Publisher API response fields. Keep credential references, profile keys, diagnostics, tokens, cookies, and browser paths out of JSON.

- [ ] Remove the current combined `Approval Gate 批准并入队` shortcut. The Publisher page must link to the dedicated Approval page and enable queueing only after the exact Revision is already approved.

- [ ] Add Fake failure-mode controls available only in development/test composition: success, network retry, auth expired, verification, and unknown external state. Persist the chosen simulation as safe Fake test metadata, never as production adapter behavior.

- [ ] Run focused tests and Web build:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/publisher-product-api.test.ts tests/e2e/publisher-web.test.ts tests/worker/publisher-product-worker.test.ts
  pnpm --dir apps/web build
  ```

- [ ] Commit:

  ```powershell
  git add apps/api/src/publisher-routes.ts apps/web tests/integration/publisher-product-api.test.ts tests/e2e/publisher-web.test.ts tests/worker/publisher-product-worker.test.ts
  git commit -m "feat: complete Fake Publisher operator lifecycle"
  ```

## Task 12: Turn Project Center into the unified project shell

**Files:**

- Modify: `apps/web/app/projects/[id]/page.tsx`
- Modify: `apps/web/app/projects/[id]/product-model.ts`
- Create: `apps/web/app/projects/[id]/project-nav.tsx`
- Modify: `apps/web/app/projects/[id]/assets/page.tsx`
- Modify: `apps/web/app/projects/[id]/director/page.tsx`
- Modify: `apps/web/app/projects/[id]/video/page.tsx`
- Modify: `apps/web/app/projects/[id]/approvals/page.tsx`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `tests/e2e/project-center-web.test.ts`
- Modify: `tests/e2e/project-navigation-web.test.ts`

- [ ] Add RED tests that every project page renders the same left-stage navigation, current stage, safe status, blocker text, and next action for `ASSETS → DIRECTOR → VIDEO → APPROVALS → PUBLISHER`.

- [ ] Run and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/project-center-web.test.ts tests/e2e/project-navigation-web.test.ts
  ```

- [ ] Extract only the shared project navigation shell into `project-nav.tsx`. Keep module forms/state in their own pages; do not create a generic component/util dumping ground.

- [ ] Update Project Center actions to point to the first actionable stage. Health remains a deterministic summary of blockers/attention/completion, never an opaque score.

- [ ] Keep the confirmed desktop layout: left stage rail, broad content area, status cards, and responsive horizontal rail on narrow screens.

- [ ] Run navigation tests and Web build:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/project-center-web.test.ts tests/e2e/project-navigation-web.test.ts
  pnpm --dir apps/web build
  ```

- [ ] Commit:

  ```powershell
  git add apps/web tests/e2e/project-center-web.test.ts tests/e2e/project-navigation-web.test.ts
  git commit -m "feat: unify ContentOS project navigation and next actions"
  ```

## Task 13: Prove the complete browser-operated Fake product flow

**Files:**

- Create: `tests/e2e/operator-browser.test.ts`
- Create: `scripts/test-operator-browser.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] Add a `test:browser` harness that creates a UUID-suffixed isolated PostgreSQL database/storage root, runs migrations, starts API/Web/Director/Asset/Video/Publisher processes on dynamically allocated loopback ports, launches Playwright Chromium, and tears down only those owned resources in `finally`.

- [ ] Write the RED success journey entirely through visible browser actions:

  ```text
  Create Project
  → upload source video/audio
  → wait for READY Assets
  → create Brief
  → Fake AI Script and Storyboard
  → accept/approve Director pair
  → select Assets and render
  → preview output
  → approve exact Render
  → create Fake Account and Publish Revision
  → approve exact Publish Revision
  → queue and wait for Publisher Worker
  → see one ExternalPost and Project Center PUBLISHED
  ```

- [ ] Add browser scenarios for network retry, auth-expired human action, and unknown state followed by reconcile. Assert duplicate button clicks do not produce duplicate Job, Attempt terminalization, or ExternalPost.

- [ ] Run and confirm RED before final UI/composition fixes:

  ```powershell
  pnpm test:browser
  ```

- [ ] Make only user-flow and composition fixes, then rerun:

  ```powershell
  pnpm test:browser
  ```

  Expected GREEN: the success path and three failure paths pass with no real AI or platform call.

- [ ] Add browser artifacts (`test-results/`, traces, screenshots, temporary profiles) to `.gitignore`; retain artifacts only on failure.

- [ ] Commit:

  ```powershell
  git add tests/e2e/operator-browser.test.ts scripts/test-operator-browser.ts package.json .gitignore
  git commit -m "test: prove unified Fake product flow in browser"
  ```

## Task 14: Documentation, full Gate, independent review, and handoff

**Files:**

- Modify: `docs/architecture/ASSET_SYSTEM_V0.md`
- Modify: `docs/architecture/WORKER_ARCHITECTURE_V0.md`
- Modify: `docs/modules/VIDEO_MODULE_V0.md`
- Modify: `docs/modules/APPROVAL_MODULE_V0.md`
- Modify: `docs/modules/PUBLISHER_MODULE_V0.md`
- Modify: `docs/development/LOCAL_SETUP.md`
- Modify: `docs/governance/02_PRODUCT_SCOPE.md`
- Modify: `docs/governance/06_TESTING_AND_ACCEPTANCE.md`
- Create: `docs/superpowers/reports/2026-08-29-contentos-unified-product-flow.md`
- Modify: `findings.md`
- Modify: `progress.md`
- Modify: `task_plan.md`

- [ ] Document Asset upload limits/staging/cleanup, Asset Worker ownership, browser routes, Job cancellation/progress, exact Approval targets, Fake Publisher failure controls, and the complete product flow.

- [ ] State explicitly that real adapters remain disabled, live platform behavior remains unverified, and Review analytics has not started.

- [ ] Run the complete Gate against isolated databases:

  ```powershell
  pnpm format
  pnpm lint
  pnpm typecheck
  pnpm build
  pnpm --dir apps/web build
  pnpm test:migrations
  pnpm test
  pnpm test:browser
  pnpm doctor
  git diff --check integration/contentos-v1...HEAD
  ```

  Expected: every command exits `0`; report exact unit/integration/worker/E2E/browser pass counts.

- [ ] Run architecture and secret scans:

  ```powershell
  rg -n --hidden -g '!node_modules/**' -g '!pnpm-lock.yaml' "accessToken|refreshToken|clientSecret|authorization|cookie|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY" .
  rg -n "ffmpeg|ffprobe|playwright|chromium" apps/api/src apps/web/app
  rg -n "from .*modules/.*/src|asset_imports|publisher_requests|approval_decisions|renders" apps workers packages/modules
  ```

  Expected: API/Web contain no FFmpeg, FFprobe, Playwright, or Chromium execution; SQL remains inside owning services; no secret values exist.

- [ ] Review the full diff for scope and product consistency:

  ```powershell
  git log --oneline --decorate integration/contentos-v1..HEAD
  git diff --stat integration/contentos-v1...HEAD
  git diff --check integration/contentos-v1...HEAD
  git status --short --branch
  ```

- [ ] Record all evidence and known limits in the report, update planning records, and commit:

  ```powershell
  git add docs findings.md progress.md task_plan.md
  git commit -m "docs: report unified ContentOS product flow"
  ```

- [ ] Push the review branch only after the user requests a remote handoff:

  ```powershell
  git push -u origin codex/unified-product-flow
  ```

- [ ] Stop for acceptance. Do not merge to `main`, enable real adapters, start Review analytics, or begin live platform validation in this plan.
