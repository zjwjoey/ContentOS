# Video Direction Correction Report

## Original Misalignment

The accepted implementation named “Quick Edit” was project-scoped manifest editing (TRIM, REMOVE, REORDER), not a standalone asset-to-video workflow.

## Preserved Work

Existing operations, immutable Manifest Revisions, Manifest Digest and Exact Render were preserved. The compatibility service alias `VideoQuickEditService` points to the single `VideoAdjustmentService` implementation.

## Reclassified Capability

Project Video now exposes Video Adjustment. The formal endpoint is `/api/v1/projects/:projectId/video/adjustments`; the old Quick Edit endpoint remains a deprecated alias.

## Standalone Design

Standalone Quick Edit uses a `STANDALONE` Video Workspace, workspace-scoped Asset Import, Random Montage Planner V2, Manifest preview, shared adjustments and shared exact render. It has no Content Project, Director, Script or Storyboard dependency.

## Ownership Change

`video_workspaces` is the ownership boundary. Project workspaces link to a Content Project; standalone workspaces have `project_id = null`. Jobs, manifests, renders and workspace asset links carry `workspace_id` where applicable.

## Database Changes

Migrations 0016–0018 add workspaces, workspace asset links, standalone sessions and workspace-scoped asset imports. Existing project rows are backfilled to project workspaces. Project columns remain compatible with existing readers.

## API Changes

Standalone routes cover session creation, workspace upload queueing, asset/import listing, planning, manifest listing, adjustments and exact render by manifest. Uploads use Asset Import/Asset Worker rather than a second upload system.

## UI Changes

`/video/quick-edit` is a standalone entry with batch Video/Voice upload, planner settings, plan generation, manifest preview and exact render. Project Video labels the old section as 视频调整 / Video Adjustment.

## Planner

Random Montage Planner V2 is deterministic by seed, rotates the asset pool using usage counts and previous-source penalties, respects source bounds, defaults to 2–5 second clips and fills the final clip to the exact target duration. Voice metadata duration is used when no explicit target is supplied.

## Adjustment Operations

TRIM, REMOVE, REORDER, REPLACE and REROLL are shared operations. REPLACE validates a READY asset and preserves the target clip's duration/position. REROLL changes only the target clip and avoids the current/adjacent asset when possible.

## Exact Render Reuse

Standalone render creates the same manifest-identity render Job consumed by the existing Video Worker. Renderer input is the persisted manifest revision and digest; it does not invoke a planner. H.264 manifests use libx264 and AAC when voice is present, and the result is verified through FFprobe against the manifest-declared codecs; legacy MPEG-4 manifests remain explicit compatibility inputs and are validated as MPEG-4.

## Tests

The correction branch adds contract coverage for standalone ownership and REPLACE/REROLL, planner determinism/rotation/exact duration and short-source bounds, workspace asset redaction, Project workspace propagation, standalone service/API flows, workspace upload queueing, and a real Asset Worker → Video Worker H.264/AAC vertical slice.

## Regression

The complete existing suite remains green after the correction work; Project Video, Director, Publisher, Review, Job and FFmpeg tests remain included.

## Git Evidence

Baseline: `codex/video-quick-edit` at `1e8b770cfbae09206c20756120d79fd0749914da`.

Correction branch: `codex/video-direction-correction`, worktree `E:\ContentOS\.worktrees\video-direction-correction`.

## Documentation Updated

Updated `VIDEO_MODULE_V0.md`, `EDIT_MANIFEST_V0.md`; added `VIDEO_PRODUCT_MODEL.md`, `VIDEO_ADJUSTMENT_V1.md` and `VIDEO_QUICK_EDIT_V1.md`. The historical 2026-08-29 report was not rewritten.

## Known Limitations

The browser flow queues uploads and requires the Asset Worker to finish them before planning; it does not perform in-browser transcoding. Real platform adapters, AI/ASR, review analytics and future planner types remain out of scope.

## Final Verdict

VIDEO DIRECTION CORRECTION APPROVED

PROJECT VIDEO ADJUSTMENT: APPROVED

STANDALONE QUICK EDIT V1: APPROVED

Final gate evidence: full test suite 211/211, format, typecheck, lint, root build, Web build, migration matrix and diff-check all passed; working tree is clean. A modern FFmpeg/FFprobe run produced MP4 with `videoCodec=h264` and `audioCodec=aac`; the standalone worker E2E also verified the workspace `OUTPUT` relation.

Pushed To Remote: NO (no push authorization was given).
