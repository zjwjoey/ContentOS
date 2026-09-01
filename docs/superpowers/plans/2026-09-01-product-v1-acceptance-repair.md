# ContentOS Product V1 Acceptance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audited Product V1 gaps without weakening module boundaries, so every operator transition is revision-scoped, scheduled publishing is durable, and real-platform results are represented honestly.

**Architecture:** Keep PostgreSQL as business truth and route all long-running work through existing durable Jobs. ApprovalService remains the only approval transition authority; Publisher Worker remains the only adapter execution boundary. Existing compatibility endpoints may remain, but they must fail closed and cannot mutate Director state outside an Approval decision.

**Tech Stack:** TypeScript, Fastify, Next.js App Router, PostgreSQL migrations, node:test/tsx, Playwright, existing WorkerRuntime/JobService and PublisherAdapter contracts.

---

### Task 1: Enforce Director Approval Gate

**Files:**
- Modify: `apps/api/src/approval-routes.ts`
- Modify: `apps/api/src/director-routes.ts`
- Modify: `apps/web/app/projects/[id]/director/page.tsx`
- Modify: `packages/modules/approval/src/approval-service.ts`
- Test: `tests/integration/director-v1-api.test.ts`
- Test: `tests/integration/approval.test.ts`
- Test: `tests/e2e/director-web.test.ts`

- [ ] **Step 1: Write failing tests** asserting that approval creation with `status: APPROVED` returns a validation error, direct Script/Storyboard transition endpoints do not change state, and an unapproved pair cannot create a Video Job.
- [ ] **Step 2: Run only those tests** with `pnpm exec tsx --test --test-concurrency=1 tests/integration/director-v1-api.test.ts tests/integration/approval.test.ts tests/e2e/director-web.test.ts`; confirm failure is caused by the bypass behavior.
- [ ] **Step 3: Implement the invariant**: `ApprovalService.create` accepts only `PENDING`; Director compatibility endpoints return a migration/conflict response without calling `acceptScript`/`approveStoryboard`; approval action routes perform the Director state transition only after `ApprovalService.approve` succeeds.
- [ ] **Step 4: Remove the two shortcut buttons** and make the Director page link users to the Approval Gate; keep the current revision visible and preserve rejection reasons.
- [ ] **Step 5: Re-run the focused tests** and then `tests/integration/director-video-api.test.ts`; expected result is all pass with no unapproved Video Job.
- [ ] **Step 6: Commit** with `git add` on the touched files and `git commit -m "fix: enforce director approval gates"`.

### Task 2: Make WeChat Publish Results Durable and Honest

**Files:**
- Modify: `packages/contracts/src/publisher.ts`
- Modify: `packages/modules/publisher/src/wechat-channels-playwright-adapter.ts`
- Modify: `packages/modules/publisher/src/wechat-channels-selectors.ts`
- Modify: `packages/modules/publisher/src/publish-state-store.ts`
- Modify: `workers/publisher-worker/src/main.ts`
- Test: `tests/contract/wechat-channels-adapter.test.ts`
- Test: `tests/integration/wechat-channels-adapter.test.ts`
- Test: `tests/worker/real-publisher-worker.test.ts`

- [ ] **Step 1: Write failing tests** for a successful WeChat submit that exposes an external post ID, asserting the adapter returns it and the Worker creates exactly one `ExternalPost`; add a success-without-ID case that returns `HUMAN_ACTION_REQUIRED` and does not create an ExternalPost.
- [ ] **Step 2: Run the focused adapter/worker tests** and verify they fail because the current adapter returns `PUBLISHED` without an ID.
- [ ] **Step 3: Extend the selector profile/state contract** with a safe external-post-ID extraction hook; never log page content, credentials, cookies, or absolute paths.
- [ ] **Step 4: Implement the adapter result mapping**: confirmed ID → `PUBLISHED` with `externalPostId`; missing ID after success marker → `FAILED` with `REQUIRES_VERIFICATION` and `HUMAN_ACTION_REQUIRED`; preserve unknown-state reconciliation after submit exceptions.
- [ ] **Step 5: Re-run focused tests** and the existing real Publisher integration gate; expected result is no false PUBLISHED/FAILED state and exactly one ExternalPost on confirmed success.
- [ ] **Step 6: Commit** with `git commit -m "fix: persist confirmed wechat external posts"`.

### Task 3: Implement Durable Publisher Scheduling

**Files:**
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `workers/publisher-worker/src/dev-main.ts`
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `packages/modules/job/src/job-service.ts`
- Test: `tests/integration/publisher-product-api.test.ts`
- Test: `tests/worker/publisher-product-worker.test.ts`
- Test: `tests/e2e/publisher-web.test.ts`

- [ ] **Step 1: Write failing tests** for a future `desiredPublishAt`: handoff creates `SCHEDULED`, queue does not create a runnable publish delivery before the due time, and the worker promotes due work exactly once; past/current times remain immediately queueable.
- [ ] **Step 2: Run the focused tests** and confirm the current implementation queues future work immediately.
- [ ] **Step 3: Implement due-time semantics** using the existing `desired_publish_at` business field and durable Job payload. Add a bounded scheduler pass in the Publisher Worker/dev runner that claims due scheduled requests idempotently; do not use request-handler sleeps or in-memory timers as truth.
- [ ] **Step 4: Add a date-time control to the Publisher UI** and display `SCHEDULED` with the next due time; preserve timezone-safe ISO serialization and clear validation for past dates.
- [ ] **Step 5: Run focused scheduling tests** plus Job idempotency tests; expected result is no early publish and no duplicate delivery.
- [ ] **Step 6: Commit** with `git commit -m "feat: honor publisher scheduling"`.

### Task 4: Replace Cover ID Input with a Safe Project Asset Selector

**Files:**
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `packages/modules/asset/src/asset-catalog-service.ts`
- Modify: `packages/contracts/src/asset.ts` only if a cover-safe media kind is required by the existing contract
- Test: `tests/integration/publisher-product-api.test.ts`
- Test: `tests/e2e/publisher-web.test.ts`

- [ ] **Step 1: Write a failing browser/API test** that selects a project-owned READY cover by display name, submits the handoff without an Asset ID text field, and rejects a foreign or non-READY selection.
- [ ] **Step 2: Run the focused test** and confirm the current manual ID field cannot satisfy it.
- [ ] **Step 3: Add a project-scoped READY cover listing** with safe display metadata and no storage paths; keep server-side ownership/lifecycle validation as the final authority.
- [ ] **Step 4: Replace the text input with a selector/preview** and make unsupported platform cover behavior explicit (reject with a clear error, never silently ignore).
- [ ] **Step 5: Re-run Publisher API/UI tests** and verify no internal ID is required in the user path.
- [ ] **Step 6: Commit** with `git commit -m "fix: make publisher cover selection operator friendly"`.

### Task 5: Add Publish Revision Editing

**Files:**
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `packages/modules/publisher/src/publisher-service.ts` only for missing public aggregate/update helpers
- Test: `tests/integration/publisher-product-api.test.ts`
- Test: `tests/e2e/publisher-web.test.ts`

- [ ] **Step 1: Write a failing API/UI test** that edits a DRAFT request, creates revision 2, preserves revision 1, and creates a PENDING Approval targeting revision 2.
- [ ] **Step 2: Run the focused test** and confirm there is no operator edit route/control.
- [ ] **Step 3: Add a project/account/asset-validated revision endpoint** that accepts title, description, hashtags, cover and desired time, and rejects edits after queueing.
- [ ] **Step 4: Add an inline Publisher draft editor** showing revision history and ensuring queueing checks the selected revision’s Approval.
- [ ] **Step 5: Re-run focused integration and browser tests**; expected result is immutable history and no approval drift.
- [ ] **Step 6: Commit** with `git commit -m "feat: edit publisher draft revisions"`.

### Task 6: Close Real Reconciliation and Full-Flow Evidence Gaps

**Files:**
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Test: `tests/worker/real-publisher-worker.test.ts`
- Test: `tests/e2e/operator-browser.test.ts`
- Test: `tests/e2e/director-web.test.ts`
- Modify: `docs/superpowers/reports/CONTENTOS_PRODUCT_V1_GAP_AUDIT.md`
- Modify: `progress.md`

- [ ] **Step 1: Write failing tests** for exhausted unknown reconciliation becoming a human-action state and for a complete browser path that uses Approval Gate rather than compatibility shortcuts and includes Benchmark before Director/Video.
- [ ] **Step 2: Run the focused tests** and confirm the current behavior leaves unknown work retrying or relies on shortcut buttons.
- [ ] **Step 3: Implement a terminal human-action transition** with a durable failure code/action payload that excludes secrets; expose a clear Publisher recovery action in the UI.
- [ ] **Step 4: Replace the existing browser journey with the strict full-flow journey** and assert Review snapshot/AI report history after a confirmed Fake ExternalPost.
- [ ] **Step 5: Run all quality gates**: `pnpm test`, `pnpm run test:integration-closure`, `pnpm run test:migrations`, `pnpm run test:browser`, `pnpm run format`, `pnpm run lint`, `pnpm run typecheck`, `pnpm build`, `pnpm --dir apps/web build`, `pnpm run doctor`, and `git diff --check`.
- [ ] **Step 6: Update the audit report** with evidence and remaining explicitly deferred platform-specific policies; commit with `git commit -m "test: close product v1 acceptance evidence"`.

### Task 7: Final Review and Integration

**Files:**
- Review all commits and the final report; no source changes unless a review finding requires a focused fix.

- [ ] **Step 1: Confirm the repair branch is based on the merged `main` and the worktree is clean.**
- [ ] **Step 2: Request an independent code review against `origin/main`.**
- [ ] **Step 3: Resolve every Critical/Important finding and rerun the relevant tests.**
- [ ] **Step 4: Push the repair branch and open a PR only after all gates pass; use a regular Merge commit if approved.**
