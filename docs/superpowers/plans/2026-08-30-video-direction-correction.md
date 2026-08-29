# Video Direction Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Reclassify the existing project-scoped Quick Edit implementation as Video Adjustment and add a genuine no-project Standalone Quick Edit V1 while preserving immutable Manifest revisions, digest fencing, Exact Render, and the shared Video Worker.

**Architecture:** Introduce a `video_workspaces` ownership boundary with `PROJECT` and `STANDALONE` scopes. Existing project records remain compatible through nullable `workspace_id` plus legacy `project_id`; new standalone manifests, renders and jobs use the workspace scope. A single adjustment service, planner, renderer and worker serve both scopes.

**Tech Stack:** TypeScript/Node 22, Fastify, Zod, PostgreSQL migrations, React/Next.js, FFmpeg/FFprobe, node:test.

---

### Task 1: Record the correction baseline and ownership decision

**Files:**
- Create: `docs/architecture/changes/VIDEO_STANDALONE_OWNERSHIP_CHANGE.md`
- Modify: `progress.md`, `findings.md`, `task_plan.md`

- [x] Record baseline branch/SHA/worktree, audit evidence, and the decision to add `video_workspaces` while preserving legacy project columns.
- [x] Document migration, compatibility, rollback, and risks before schema edits.
- [x] Commit as `docs: record video direction correction baseline`.

### Task 2: Add shared workspace ownership schema

**Files:**
- Create: `migrations/0016_video_workspaces.sql`, `migrations/0016_video_workspaces.down.sql`
- Modify: `packages/contracts/src/edit-manifest.ts`, `packages/modules/job/src/job-service.ts`
- Test: `tests/integration/migration-matrix.test.ts`, new `tests/contract/video-standalone.test.ts`

- [x] Add `video_workspaces`, `video_workspace_assets`, and nullable `workspace_id` columns to jobs, edit_manifests and renders; backfill one PROJECT workspace per existing project and existing rows.
- [x] Extend job records/input with optional `workspaceId` without changing project callers.
- [x] Extend `EDIT_MANIFEST_V0` validation to accept either `projectId` or `workspaceId`, retaining all existing project manifests.
- [x] Add foreign-key/check constraints preventing a workspace from being both standalone and project-owned.
- [x] Test up/down migration and contract scope validation.
- [x] Commit as `feat: add video workspace ownership boundary`.

### Task 3: Reclassify Quick Edit as Video Adjustment

**Files:**
- Create: `packages/modules/video/src/video-adjustment-service.ts`
- Modify: `packages/modules/video/src/quick-edit.ts`, `packages/modules/video/src/quick-edit-service.ts`, `packages/modules/video/src/index.ts`, `apps/api/src/video-routes.ts`
- Test: existing Quick Edit contract/integration/API tests plus adjustment route tests

- [x] Move the single implementation name to `VideoAdjustmentService`, export `VideoQuickEditService` as a deprecated alias, and rename public operation/error wording to Video Adjustment while preserving compatibility.
- [x] Add `POST /api/v1/projects/:projectId/video/adjustments` as the canonical route; keep `/video/quick-edits` as a deprecated alias calling the same service.
- [x] Change project UI labels and copy from Quick Edit to 视频调整 / Video Adjustment.
- [x] Commit as `refactor: reposition quick edit as video adjustment`.

### Task 4: Add REPLACE and REROLL operations

**Files:**
- Modify: `packages/modules/video/src/quick-edit.ts`, `packages/modules/video/src/video-adjustment-service.ts`, `packages/modules/video/src/index.ts`
- Test: `tests/contract/video-quick-edit.test.ts`, `tests/integration/video-quick-edit.test.ts`

- [x] Implement deterministic bounds-checked `REPLACE` using a READY video Asset and optional `sourceInMs`, preserving timeline position and duration.
- [x] Implement seeded `REROLL` from workspace/project READY assets, avoiding the old/adjacent source when possible and preserving every non-target clip field.
- [x] Ensure every operation creates an append-only revision and old revisions remain readable.
- [x] Commit as `feat: add replace and reroll video adjustments`.

### Task 5: Upgrade planner and renderer invariants

**Files:**
- Modify: `packages/modules/video/src/planner.ts`, `packages/infrastructure/ffmpeg/src/renderer.ts`, `packages/modules/video/src/video-service.ts`
- Test: `tests/unit/video-planner.test.ts`, `tests/unit/video-renderer.test.ts`, new standalone planner tests

- [x] Add `RandomMontagePlanner` V2 with min/max clip bounds (default 2–5 seconds), exact final-duration fill, source rotation/usage penalty, and deterministic seed.
- [x] Make voice metadata duration drive standalone target duration and ensure `sourceIn + duration <= asset duration`.
- [x] Change output encoding to H.264/libx264 + AAC + MP4/yuv420p and verify with FFprobe; preserve exact Manifest render path.
- [x] Commit as `feat: enforce deterministic montage and h264 output`.

### Task 6: Implement Standalone Quick Edit session and API

**Files:**
- Create: `packages/modules/video/src/standalone-quick-edit-service.ts`
- Modify: `packages/modules/asset/src/asset-catalog-service.ts`, `packages/modules/asset/src/asset-service.ts`, `packages/modules/video/src/video-service.ts`, `packages/modules/video/src/index.ts`, `apps/api/src/video-routes.ts`
- Test: new `tests/integration/standalone-quick-edit.test.ts`, `tests/integration/standalone-quick-edit-api.test.ts`

- [x] Create standalone workspace/session without a Content Project; attach READY video/audio assets via workspace links.
- [x] Expose create/get/plan/manifests/adjustments/render endpoints under `/api/v1/video/quick-edits` with no `projectId` parameter.
- [x] Route plan output into the existing manifest persistence, Exact Render job creation, and Video Worker; do not create a fake project or a second renderer.
- [x] Commit as `feat: add standalone video quick edit api`.

### Task 7: Add standalone web flow

**Files:**
- Create: `apps/web/app/video/quick-edit/page.tsx`
- Modify: `apps/web/app/projects/[id]/video/page.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Test: `tests/e2e/standalone-quick-edit-web.test.ts`

- [x] Add Video navigation entries 快速剪辑 and 项目视频.
- [x] Implement asset selection/upload, planner settings, manifest preview and exact render.
- [x] Keep project Video Adjustment UI intact under `/projects/:id/video` with corrected terminology.
- [x] Commit as `feat: add standalone quick edit web flow`.

### Task 8: Regression, docs closure and final evidence

**Files:**
- Create: `docs/product/VIDEO_PRODUCT_MODEL.md`, `docs/product/VIDEO_ADJUSTMENT_V1.md`, `docs/product/VIDEO_QUICK_EDIT_V1.md`, `docs/superpowers/reports/2026-08-30-video-direction-correction.md`
- Modify: `docs/modules/VIDEO_MODULE_V0.md`, relevant `docs/contracts/*`, `progress.md`, `findings.md`, `task_plan.md`

- [x] Add regression coverage for no-project, deterministic seed, REROLL/REPLACE isolation, exact render identity, workspace upload queueing, cancel and lease fencing.
- [x] Scan docs/code for stale “Quick Edit = complete standalone” wording; preserve the historical 2026-08-29 report unchanged.
- [x] Run format/lint/typecheck/build/full tests and verify `git diff --check`; browser page source checks are included in the full suite.
- [ ] Commit as `docs: close video direction correction` and stop for human acceptance; do not push/merge/delete worktree without explicit authorization.
