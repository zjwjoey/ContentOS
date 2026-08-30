# ContentOS Operator UI V1 Design

## Status

**Approved for specification review; implementation has not started.**

This design turns the existing ContentOS capability pages into a continuous, desktop-first operator product. It covers the three V1 slices that were intentionally combined:

1. Global Operator Product Shell
2. Standalone Quick Edit visualization
3. Project workflow visualization

Human business acceptance remains deferred until the automated implementation gate is green and the user has viewed the resulting UI.

## Goals

- Give the product a stable global shell with clear global and project-scoped navigation.
- Let an operator complete Standalone Quick Edit without understanding Asset IDs, workspace IDs, or manifest UUIDs.
- Make existing Director, Video, Approval, and Fake Publisher capabilities discoverable and visually continuous.
- Preserve module ownership and existing backend contracts; Web remains a contract client.
- Provide loading, empty, error, success, and asynchronous-job feedback on every primary page.
- Keep the UI deterministic, information-dense, and usable at 1440, 1280, 1024, and basic 768px widths.

## Non-goals

- No Review Analytics page; Review remains deferred.
- No real Douyin or WeChat publishing enablement.
- No AI Vision, Storyboard Planner expansion, semantic matching, voice alignment, or new creative algorithms.
- No Canvas/WebGL timeline, FFmpeg WASM, client-side transcoding, waveform engine, drag-and-drop framework, or multi-track editor.
- No large UI framework, global state library, speculative workflow engine, or database migration unless a separate data-change record proves it necessary.

## Product hierarchy

```text
OperatorShell
├── 项目中心
├── 快速剪辑
└── 项目工作区
    ├── Overview
    ├── Assets
    ├── Director
    ├── Video
    ├── Approval
    └── Publisher
```

Global navigation contains only 项目中心 and 快速剪辑. Director, Approval, and Publisher are project-scoped and are not presented as orphan global destinations.

## Global Operator Shell

The root layout will host a reusable `OperatorShell` with:

- persistent left sidebar;
- top bar containing page title, optional project context, and current UI status;
- compact responsive collapse/stack behavior for 768px;
- shared primitives for `PageHeader`, `SectionHeader`, `StatusBadge`, `LoadingState`, `EmptyState`, and `ErrorState`.

The shell must not require a `projectId`. It remains renderable on the home page and standalone Quick Edit route. Visual language is dark, neutral, high-density, blue-accented, with consistent spacing and restrained motion.

## Project workspace layout

`apps/web/app/projects/[id]/layout.tsx` becomes the single project workspace frame. It obtains project context through the existing project-facing API contract and renders:

- project name and original status in the header;
- a return-to-overview affordance;
- one shared stage navigation for Overview, Assets, Director, Video, Approval, and Publisher;
- loading and error states when project context is unavailable.

Existing Project Center snapshot, stage cards, health, actions, and jobs are retained and visually reorganized rather than replaced. Individual pages must not duplicate ProjectNav markup.

## UI status model

`apps/web/app/_lib/status.ts` is the single mapping source. It maps domain status to:

- user-facing Chinese label;
- semantic tone (`neutral`, `info`, `success`, `warning`, `danger`);
- coarse UI group where useful.

Raw domain values remain available in details/debug views. No page-local status `Record` is allowed.

## Standalone Quick Edit

### Entry and session

On first entry, the page presents a clear “新建快速剪辑” action and settings for seed, minimum clip duration, maximum clip duration, and optional target duration. Activating it creates a real Standalone Quick Edit session through `POST /api/v1/video/quick-edits`; it does not create a fake project. The UI may create a draft session automatically on initial load, but must not silently select assets.

Session/workspace identifiers are placed under a debug/details affordance, not in the primary workflow.

### Three-column workspace

The approved C layout is:

```text
┌──────────────┬──────────────────────────────┬────────────────┐
│ 素材库       │ 视频预览 + Manifest 时间线   │ 镜头 Inspector  │
│ Video        │ 当前输出预览                 │ 参数与操作     │
│ Voice        │                              │                │
│ Imports      │                              │                │
└──────────────┴──────────────────────────────┴────────────────┘
```

The center timeline is a readable clip-card list, not a professional multi-track editor. On narrow widths the columns stack, and the timeline may scroll horizontally.

### Asset and voice UX

- Upload panel supports multiple video files.
- V1 treats one audio asset as the primary voice; if multiple voice files exist, the chosen primary voice is explicit.
- Asset list polls `GET /api/v1/video/quick-edits/:id/assets` while imports are active and stops high-frequency polling once assets are READY or terminally failed.
- Cards show filename, media type, duration when known, and import status.
- A selected READY video or audio asset can be previewed with native media elements.
- The UI never asks the user to type an Asset ID as the main operation.

If the audit confirms the missing Standalone content endpoint, add the smallest safe read boundary: validate session ownership, workspace ownership, READY status, supported media role, and stream through the existing storage provider without exposing storage keys or absolute paths.

### Planner, timeline, and adjustments

After READY assets exist, the operator can generate a plan and see a visual Manifest timeline with revision history. Selecting a clip opens the inspector. The Web layer emits the existing `QuickEditOperation` contract only; Video owns adjustment semantics and algorithms.

The inspector exposes the existing five operations:

```text
TRIM · REMOVE · REORDER · REPLACE · REROLL
```

Every successful adjustment refreshes the current manifest pointer and visibly increments/selects a new revision. Failed operations show a user-readable message with the domain code available in details.

V1 does not support branching from historical Manifest revisions. Historical revisions are inspectable and exactly renderable, but only the session current Manifest is mutable through Video Adjustment.

### Render closure

The page renders the selected Manifest through the existing durable Job flow, polls the Job to a terminal state, and then shows a playable output video when the output Asset is READY. It must distinguish queued, processing, failed, and completed states and retain a link to the active Manifest revision.

## Project workflow visualization

### Overview

Overview starts with project name, health, current stage, and next action; follows with the Assets → Director → Video → Approval → Publisher workflow stepper; and ends with actionable items and recent Jobs. All counts and statuses come from existing APIs or current collections, never invented dashboard numbers.

### Assets

Retain upload, import polling, and native media preview. Present them as an upload panel, import queue, and asset grid/list. Do not alter Asset Worker semantics.

### Director

Present Brief, Script, and Storyboard as a content workbench. Script cards include revision, status, origin, title, hook, body, and CTA. Storyboard scene cards include scene number, voiceover, duration hint, visual instruction, and asset keywords. Accepted Script and Approved Storyboard pairing is explicit, and the Video entry action is enabled only for a valid pair.

### Project Video

Reuse the same shared timeline, clip card, inspector, asset picker, manifest history, and media preview components as Standalone Quick Edit. Preserve the existing Planner, Render, Approval handoff, and exact-render concepts. Ensure all five adjustment operations are visible. New UI uses the formal Video Adjustment route/contract rather than a deprecated compatibility route.

### Approval

Present Render Approval and Publish Revision Approval as an Approval Queue. Each row shows type, target, exact revision, status, and available action. Rejection uses an inline form/panel instead of `window.prompt()`.

### Publisher

Keep Fake Platform as the deterministic V1 path. Organize the page into publishing summary, account, draft, approval state, requests, attempts, external post, and next action. Action guidance is state-aware: unapproved drafts point to Approval, approved drafts can enter the queue, authentication failures require human action, and published items show completion. Real adapters remain disabled.

## Shared component boundaries

Prefer a small set of reusable components under `apps/web/app/_components/` and `apps/web/components/video/` (or the existing equivalent). Components render props and callbacks; they do not read private tables or implement domain algorithms. React local state, effects, and callbacks remain sufficient for V1.

## Backend and security constraints

- PostgreSQL remains business truth; queue rows remain delivery state.
- Long-running work continues through durable Jobs; request handlers do not run FFmpeg, browsers, or AI.
- Any minimal API extension is read/action oriented and must preserve module ownership.
- Standalone content reads must reject cross-session assets, non-READY assets, and unsupported roles.
- Browser JSON and logs must not expose storage keys, staged paths, credentials, cookies, authorization headers, or tokens.
- No new migration is expected. If one becomes unavoidable, stop and add a formal data-change record before implementing it.

## Verification strategy

Baseline and final gates include format, lint, typecheck, root build, Web build, Doctor, migration matrix, full tests, and `git diff --check`. UI tests must evolve from source-string checks to behavior-oriented coverage where the existing isolated browser harness permits it.

Required browser scenarios:

1. Home → create project → navigate through every project stage.
2. Quick Edit → create session → upload at least four videos and one voice → READY → plan → timeline → REROLL → REPLACE → TRIM → REORDER → optional REMOVE → render → playable output.
3. Existing Project → Assets → Director → Video → Approval → Fake Publisher flow.

Screenshots may be generated for Home, Overview, Director, Standalone Quick Edit, and Project Video, but remain ignored test artifacts.

## Acceptance boundary

The implementation may be reported as `AUTOMATED ACCEPTANCE PASSED` / `READY FOR HUMAN ACCEPTANCE` only when the three UI slices, automated browser flows, full gates, documentation, and clean Git state all pass. It must not be reported as human accepted in this stage.
