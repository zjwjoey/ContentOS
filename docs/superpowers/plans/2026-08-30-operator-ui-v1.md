# ContentOS Operator UI V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing ContentOS Web pages into a continuous Operator UI V1 with a persistent shell, a visual standalone Quick Edit workspace, and unified project workflow pages while preserving module contracts.

**Architecture:** Keep the current Next App Router and React local-state approach. Add a small shared Web component layer, a nested project layout, and one status mapping module; reuse existing API routes and Video contracts. Add only the minimum safe Asset delivery/session-setting API extensions if the audit proves the existing contracts cannot close the browser workflow.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, existing ContentOS Fastify APIs, native `<video>`/`<audio>`, existing `tsx --test` and isolated Playwright/browser harness.

---

## File map and ownership

### Create

- `apps/web/app/_components/operator-shell.tsx` — global shell composition and navigation frame.
- `apps/web/app/_components/operator-sidebar.tsx` — global navigation links and responsive collapse affordance.
- `apps/web/app/_components/operator-topbar.tsx` — page/project context header.
- `apps/web/app/_components/page-header.tsx` — reusable title, description, and action region.
- `apps/web/app/_components/status-badge.tsx` — status presentation using the centralized mapping.
- `apps/web/app/_components/feedback-state.tsx` — loading, empty, error, and inline notice primitives.
- `apps/web/app/_lib/status.ts` — one domain-to-UI status mapping source.
- `apps/web/app/projects/[id]/layout.tsx` — project workspace frame and shared ProjectNav placement.
- `apps/web/components/video/asset-card.tsx` — selectable media card with native preview affordance.
- `apps/web/components/video/media-preview.tsx` — safe video/audio/output preview.
- `apps/web/components/video/manifest-timeline.tsx` — clip-card timeline and revision selection.
- `apps/web/components/video/clip-inspector.tsx` — selected clip details and five adjustment actions.
- `apps/web/components/video/manifest-revision-picker.tsx` — current/superseded revision selector.
- `tests/e2e/operator-ui-v1-browser.test.ts` — automated shell, Quick Edit, and project-flow browser scenarios.
- `docs/product/OPERATOR_UI_V1.md` — product-facing hierarchy, scope, and non-goals.
- `docs/superpowers/reports/2026-08-30-operator-ui-v1.md` — final implementation and gate report.

### Modify

- `apps/web/app/layout.tsx` — host `OperatorShell` without requiring project context.
- `apps/web/app/globals.css` — organize tokens/layout/navigation/status/timeline/responsive styles; preserve existing classes until migrated.
- `apps/web/app/page.tsx` — dashboard header, quick actions, and real project cards.
- `apps/web/app/projects/[id]/page.tsx` — consume shared project frame/status components and retain real snapshot/actions/jobs.
- `apps/web/app/projects/[id]/project-nav.tsx` — become the single stage-nav implementation used by the nested layout.
- `apps/web/app/projects/[id]/assets/page.tsx` — upload panel, import queue, asset cards, and shared preview.
- `apps/web/app/projects/[id]/director/page.tsx` — full Script/Storyboard fields and content-workbench layout.
- `apps/web/app/projects/[id]/video/page.tsx` — shared timeline/inspector, all five operations, revision history, output preview.
- `apps/web/app/projects/[id]/approvals/page.tsx` — approval queue and inline reject form.
- `apps/web/app/projects/[id]/publisher/page.tsx` — action-oriented Fake Publisher information architecture.
- `apps/web/app/video/quick-edit/page.tsx` — three-column session/assets/timeline/inspector/render workflow.
- `tests/e2e/video-standalone-quick-edit-web.test.ts` — structural contract coverage for all visible Quick Edit capabilities.
- `tests/e2e/project-center-web.test.ts`, `tests/e2e/project-navigation-web.test.ts`, `tests/e2e/video-web.test.ts`, `tests/e2e/director-web.test.ts`, `tests/e2e/approvals-web.test.ts`, `tests/e2e/publisher-web.test.ts` — update assertions for shared shell and preserved real data.
- `apps/api/src/video-routes.ts` and/or the owning Asset service/routes — only if the safe standalone content/settings audit identifies a required gap.
- `findings.md`, `progress.md`, `task_plan.md` — append durable decisions and milestone evidence; never rewrite history.

## Implementation tasks

### Task 1: Freeze baseline and create the first failing UI contracts

**Files:**
- Modify: `tests/e2e/video-standalone-quick-edit-web.test.ts`
- Create: `tests/e2e/operator-ui-v1-browser.test.ts`
- Modify: `findings.md`, `progress.md`, `task_plan.md`

- [ ] **Step 1: Add source-level assertions for the approved UI contract.** Assert that Quick Edit contains session creation, upload, assets, voice, timeline, clip selection, REROLL, REPLACE, TRIM, REMOVE, REORDER, render, and output labels; assert the shell contains global Project Center and Quick Edit links and no Review link.
- [ ] **Step 2: Add browser scenario skeletons against the existing isolated operator server.** Define three named tests (`global shell`, `standalone quick edit`, `project workflow`) with explicit fixtures and terminal-state waits; do not weaken existing Fake Publisher assertions.
- [ ] **Step 3: Run the focused tests and record expected failures.** Run `pnpm exec tsx --test --test-concurrency=1 tests/e2e/video-standalone-quick-edit-web.test.ts tests/e2e/operator-ui-v1-browser.test.ts`; expected result is failure on missing visual selectors, proving the tests are meaningful before implementation.
- [ ] **Step 4: Commit the red tests and baseline evidence.** Run `git diff --check`, then commit with `test: define operator ui v1 acceptance contracts`.

### Task 2: Implement global shell and shared status primitives

**Files:**
- Create: `apps/web/app/_components/operator-shell.tsx`, `operator-sidebar.tsx`, `operator-topbar.tsx`, `page-header.tsx`, `status-badge.tsx`, `feedback-state.tsx`, `_lib/status.ts`
- Modify: `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Test: `tests/e2e/project-center-web.test.ts`, `tests/e2e/project-navigation-web.test.ts`

- [ ] **Step 1: Define the status mapping contract.** Export `UiStatusTone`, `UiStatusGroup`, `UiStatusView`, and `getStatusView(status: string | null | undefined): UiStatusView`; map `NOT_STARTED`, `QUEUED`, `RUNNING`, `READY`, `PENDING`, `APPROVED`, `SUCCEEDED`, `FAILED`, `REJECTED`, and `RECONCILING`, with unknown values returning a neutral raw label.
- [ ] **Step 2: Build the shell as a server-compatible component.** `OperatorShell({ children, projectContext? })` renders sidebar, topbar, and `<main>`; it must not access a database or require `projectId`. Sidebar links must be `/` and `/video/quick-edit` only.
- [ ] **Step 3: Wrap `children` in `app/layout.tsx` and preserve metadata.** Keep the existing `lang="zh-CN"` document and make all routes render inside the shell.
- [ ] **Step 4: Refactor the home page into Dashboard Header, Quick Actions, and real Projects cards.** Use only fields returned by `/api/v1/projects`; do not add invented counts or analytics.
- [ ] **Step 5: Replace page-local status records with `StatusBadge` and shared feedback primitives.** Keep raw status in a details element where the page already exposes debugging information.
- [ ] **Step 6: Organize CSS into token, layout, navigation, card, status, form, timeline, and responsive sections.** Add breakpoints for 1440/1280/1024 and a stacked 768px layout without introducing Tailwind or a UI framework.
- [ ] **Step 7: Run focused Web tests and Web build.** Run `pnpm exec tsx --test --test-concurrency=1 tests/e2e/project-center-web.test.ts tests/e2e/project-navigation-web.test.ts`, then `pnpm --dir apps/web build`; expected result PASS.
- [ ] **Step 8: Commit the shell milestone.** Run `git diff --check`; commit `feat(web): add ContentOS operator shell`.

### Task 3: Unify the project workspace layout

**Files:**
- Create: `apps/web/app/projects/[id]/layout.tsx`
- Modify: `apps/web/app/projects/[id]/project-nav.tsx`, `apps/web/app/projects/[id]/page.tsx`, `apps/web/app/projects/[id]/assets/page.tsx`, `director/page.tsx`, `video/page.tsx`, `approvals/page.tsx`, `publisher/page.tsx`
- Test: `tests/e2e/project-navigation-web.test.ts`

- [ ] **Step 1: Add the nested layout that loads project context through the existing project-facing API.** Render project name, original status, back-to-overview link, and one `ProjectNav`; show loading/error feedback without direct database access.
- [ ] **Step 2: Remove duplicated ProjectNav markup from child pages.** Keep each child responsible only for its page content and route-local actions.
- [ ] **Step 3: Make the stage rail use the frozen `PRODUCT_STAGES` model.** Render Overview, Assets, Director, Video, Approval, and Publisher with active-state styling and status badges; do not add Review.
- [ ] **Step 4: Add responsive project header behavior.** At 768px, allow horizontal stage-nav scrolling and keep the back action reachable.
- [ ] **Step 5: Run project navigation tests and commit.** Run the focused test and `pnpm --dir apps/web build`; commit `feat(web): unify project workspace navigation`.

### Task 4: Close only required Standalone Quick Edit API gaps

**Files:**
- Inspect first: `apps/api/src/video-routes.ts`, Asset route/service files, `apps/api/src/video/standalone-quick-edit-service.ts`, `apps/api/src/asset-catalog-service.ts`
- Modify only if required: owning route/service files
- Test: `tests/integration/standalone-quick-edit-api.test.ts`, `tests/integration/asset-api.test.ts`, new focused contract test if an endpoint is added

- [ ] **Step 1: Verify whether standalone asset content already exists and whether session settings/voice can be updated.** Record the endpoint and ownership evidence in `findings.md`; do not change code if existing contracts close the need.
- [ ] **Step 2: If content is missing, add `GET /api/v1/video/quick-edits/:id/assets/:assetId/content` through the Asset-owned delivery boundary.** Validate session existence, workspace ownership, Asset membership, READY status, and supported role; stream via the existing LocalStorageProvider and return no `storageKey`, absolute path, or staged path.
- [ ] **Step 3: If voice/settings update is missing, add the smallest existing-service action extension.** Support `voiceAssetId`, `seed`, `targetDurationMs`, `minClipDurationMs`, and `maxClipDurationMs` only when the current domain model already stores those fields; do not add a migration.
- [ ] **Step 4: Write tests before implementation changes.** Cover same-workspace success, cross-workspace 404, non-READY 404, and no storage-key leak; for settings cover valid update and invalid asset rejection.
- [ ] **Step 5: Run focused API/integration tests and verify no migration files changed.** Run the two focused test files and `git diff -- migrations`; expected migration diff is empty.
- [ ] **Step 6: Commit only if a backend gap was necessary.** Use `fix(video): close standalone operator ui contract gap`; otherwise record “no backend change required” and continue without a backend commit.

### Task 5: Build shared video visualization components

**Files:**
- Create: `apps/web/components/video/asset-card.tsx`, `media-preview.tsx`, `manifest-timeline.tsx`, `clip-inspector.tsx`, `manifest-revision-picker.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `tests/e2e/video-standalone-quick-edit-web.test.ts`, `tests/e2e/video-web.test.ts`

- [ ] **Step 1: Define component props from existing response shapes.** `AssetCard` accepts filename, role/type, status, duration, optional content URL, and selection callback; `MediaPreview` accepts media kind, URL, and posterless native playback; `ManifestTimeline` accepts clips, selected index, revision metadata, and selection callback; `ClipInspector` accepts selected clip and an `onOperation(operation)` callback; `ManifestRevisionPicker` accepts revisions and current revision ID.
- [ ] **Step 2: Render timeline clip cards with clip index, source asset name, start/end/duration, and selected styling.** Use a list and CSS overflow; do not implement a canvas or drag-drop engine.
- [ ] **Step 3: Render inspector controls for TRIM, REMOVE, REORDER, REPLACE, and REROLL.** Controls emit the existing `QuickEditOperation` shape and never mutate clip arrays locally as a substitute for the Video API.
- [ ] **Step 4: Add revision history states.** Distinguish current and superseded revisions and expose the manifest digest only under details.
- [ ] **Step 5: Run Web typecheck/build and focused source tests.** Expected result PASS after the pages are wired in the next tasks; commit `feat(web): add shared video workspace components` only when the components compile.

### Task 6: Implement the standalone Quick Edit three-column workflow

**Files:**
- Modify: `apps/web/app/video/quick-edit/page.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `tests/e2e/video-standalone-quick-edit-web.test.ts`, `tests/e2e/operator-ui-v1-browser.test.ts`

- [ ] **Step 1: Replace manual-ID-first entry with the approved session state machine.** Initial state shows “新建快速剪辑”; creating a session posts to `/api/v1/video/quick-edits` with seed/duration settings and then reveals the workspace.
- [ ] **Step 2: Add upload panels for multiple videos and one explicit primary voice.** Reuse the current upload/import APIs; show filename, type, import status, and native preview URL for READY assets.
- [ ] **Step 3: Poll asset imports with bounded intervals.** Poll while any asset is active, stop high-frequency polling at READY/FAILED, and show user-readable messages with raw codes in details.
- [ ] **Step 4: Replace the text manifest list with the shared three-column workspace.** Left asset library; center `MediaPreview` plus `ManifestTimeline`; right `ClipInspector` and planner/render settings.
- [ ] **Step 5: Wire all five adjustment operations to the existing Video endpoints.** After each successful action, refresh the session manifest/revision and selected clip; preserve idempotent server semantics and do not implement adjustment algorithms in the browser.
- [ ] **Step 6: Add render Job polling and output preview.** Render the selected manifest, poll until terminal, resolve the VIDEO_RENDER output through the safe content route, and display a playable `<video>` when READY.
- [ ] **Step 7: Add loading, empty, error, and success states for session, assets, plan, adjustment, and render.** Ensure no primary action exposes Asset ID, Workspace UUID, or Manifest UUID as required input.
- [ ] **Step 8: Run focused source tests, browser test with fixtures, and Web build.** Expected browser assertions: four video uploads + one voice reach READY, plan has at least one clip, each operation increments revision, render reaches SUCCEEDED, output video is playable.
- [ ] **Step 9: Commit the standalone milestone.** `feat(web): visualize standalone quick edit`.

### Task 7: Upgrade Project Center, Assets, and Director visualization

**Files:**
- Modify: `apps/web/app/projects/[id]/page.tsx`, `assets/page.tsx`, `director/page.tsx`
- Test: `tests/e2e/project-center-web.test.ts`, `tests/e2e/assets-web.test.ts`, `tests/e2e/director-web.test.ts`, `tests/e2e/operator-ui-v1-browser.test.ts`

- [ ] **Step 1: Reorganize Overview around real snapshot data.** Render project name, health, current stage, next action, workflow stepper, actionable items, and recent Jobs; calculate only from returned collections.
- [ ] **Step 2: Turn Assets into upload panel, import queue, and asset grid/list.** Use `AssetCard` and `MediaPreview`, keep one-file upload semantics if that is what the API supports, and retain import polling.
- [ ] **Step 3: Turn Director into Brief / Script / Storyboard workbench.** Show full Script fields and full Storyboard scene fields from the existing Director contracts; visually pair Accepted Script with Approved Storyboard and gate the Video action on that pair.
- [ ] **Step 4: Add explicit loading/empty/error states.** Do not hide API failures behind disabled buttons or blank panels.
- [ ] **Step 5: Run focused tests and commit.** `feat(web): visualize project overview assets and director`.

### Task 8: Upgrade Project Video, Approval, and Fake Publisher visualization

**Files:**
- Modify: `apps/web/app/projects/[id]/video/page.tsx`, `approvals/page.tsx`, `publisher/page.tsx`
- Test: `tests/e2e/video-web.test.ts`, `tests/e2e/approvals-web.test.ts`, `tests/e2e/publisher-web.test.ts`, `tests/e2e/operator-ui-v1-browser.test.ts`

- [ ] **Step 1: Refactor Project Video to reuse the shared video components.** Keep Director pair, source/voice selection, planner settings, exact render, approval handoff, and output preview; use the formal Video Adjustment route rather than a deprecated compatibility route.
- [ ] **Step 2: Expose all five adjustments and revision history.** Show current/superseded Manifest versions and update the current pointer after successful operations.
- [ ] **Step 3: Convert Approval into an Approval Queue.** Show type, target, exact revision, status, approve action, and an inline rejection form with required reason; remove `window.prompt()`.
- [ ] **Step 4: Reorganize Publisher into summary, account, draft, approval, requests, attempts, external post, and next action.** Keep Fake Platform as the only enabled route and make actions state-aware.
- [ ] **Step 5: Run focused tests and commit.** `feat(web): refine approval and publisher workflow`.

### Task 9: Add end-to-end browser acceptance

**Files:**
- Modify: `tests/e2e/operator-ui-v1-browser.test.ts`
- Inspect/reuse: `scripts/test-operator-browser.ts`, existing isolated browser fixtures
- Modify if needed: `.gitignore` for ignored screenshot/test-result paths

- [ ] **Step 1: Implement Scenario A.** Open home, assert ContentOS/Project Center/Quick Edit, create a project, and navigate Overview → Assets → Director → Video → Approval → Publisher.
- [ ] **Step 2: Implement Scenario B.** Create standalone session, upload four video fixtures and one voice, wait for READY, generate plan, assert timeline, execute REROLL/REPLACE/TRIM/REORDER and optional REMOVE, render, wait for SUCCEEDED, and assert playable output.
- [ ] **Step 3: Implement Scenario C.** Reuse the existing Fake Product Flow and assert Project → Assets → Director → Video → Approval → Fake Publisher.
- [ ] **Step 4: Capture screenshots only to ignored `test-results` or `artifacts` paths.** Capture Home, Overview, Director, Standalone Quick Edit, and Project Video for visual QA; do not commit PNGs.
- [ ] **Step 5: Run `pnpm test:browser` and the focused `tsx --test` suite.** Expected result: all three scenarios pass without enabling real platform adapters.
- [ ] **Step 6: Commit browser acceptance.** `test: add operator ui browser acceptance`.

### Task 10: Documentation, final gates, and handoff

**Files:**
- Create: `docs/product/OPERATOR_UI_V1.md`, `docs/superpowers/reports/2026-08-30-operator-ui-v1.md`
- Modify: `findings.md`, `progress.md`, `task_plan.md`

- [ ] **Step 1: Write the product document.** Define Operator UI hierarchy, global/project navigation, standalone Quick Edit workspace, project workflow, status model, shared video UI, non-goals, and Review Deferred.
- [ ] **Step 2: Append durable findings and milestone evidence.** Record shared timeline ownership, shell A, Quick Edit C, API/security decisions, test counts, and any justified backend gap; do not record cosmetic button changes.
- [ ] **Step 3: Run the complete final gate.** Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:migrations`, `pnpm build`, `pnpm --dir apps/web build`, `pnpm doctor`, and `git diff --check origin/main...HEAD`.
- [ ] **Step 4: Verify repository cleanliness and evidence.** Run `git status --short --branch`, `git diff --stat`, `git log --oneline origin/main..HEAD`; ensure no `.next`, media, database state, screenshots, or generated files are tracked.
- [ ] **Step 5: Fill the final report checklist.** Record baseline SHA, final HEAD, commits, actual full-test count, migration count, browser acceptance, Web build, security, known limitations, and `Human Acceptance Status: NOT YET PERFORMED`.
- [ ] **Step 6: Commit documentation closure.** `docs: close operator ui v1`.
- [ ] **Step 7: Push the feature branch and create a PR only after all gates pass.** Run `git push -u origin codex/operator-ui-v1`; create a PR from `codex/operator-ui-v1` to `main` titled `feat: add ContentOS Operator UI V1`, with Summary, Verification, Scope, and explicit “No Human Acceptance Yet”. Do not merge the PR, delete the branch/worktree, or start the next product stage.

## Self-review against the approved spec

- Global shell, persistent left navigation, root-layout independence, responsive behavior, and no fake metrics are covered by Tasks 2–3.
- Quick Edit session-first flow, three-column C layout, asset/voice UX, safe content boundary, visual timeline, five operations, revision history, and render output are covered by Tasks 4–6.
- Overview, Assets, Director, Project Video, Approval, and Fake Publisher visualization are covered by Tasks 7–8.
- Shared component ownership, centralized status mapping, local React state, and prohibited heavy UI technologies are explicit in Tasks 2 and 5.
- Security, module ownership, no migration by default, durable Job polling, and real adapter/Review non-goals are explicit in Tasks 4, 6, 8, and 10.
- Automated browser scenarios, full gates, ignored screenshots, documentation, push, PR creation, and the no-merge stop boundary are covered by Tasks 9–10.
- No task contains a placeholder or depends on an undefined function name; API additions are conditional on the documented audit and must be tested before implementation.
