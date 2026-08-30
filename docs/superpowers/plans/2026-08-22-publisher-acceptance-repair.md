# Publisher Fake Acceptance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the Publisher Fake vertical slice acceptance gaps without opening the next ContentOS roadmap slice.

**Architecture:** Unknown publish outcomes create a durable reconciliation job; the Publisher Worker owns both `PUBLISH` and `PUBLISH_RECONCILE` execution through public Publisher contracts. Approval is the only active pre-publish decision boundary, while Review remains post-publish compatibility/history only. The project-scoped Publisher UI consumes project Asset and Publisher APIs and never accepts secrets.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, existing JobService/JobRunner, Node test runner, Next.js.

---

### Task 1: Add a durable reconciliation contract and worker path

**Files:**
- Modify: `packages/contracts/src/publisher.ts`
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `workers/publisher-worker/src/dev-main.ts`
- Modify: `tests/worker/publisher-product-worker.test.ts`

- [ ] **Step 1: Write the failing reconciliation test**

Add a test where Fake publish returns an uncertain result after recording an external post, assert the original `PUBLISH` job ends in a reconciliation state, a durable `PUBLISH_RECONCILE` job is created, the Worker registers and consumes it, `reconcile()` creates exactly one confirmed `ExternalPost`, and the request ends `PUBLISHED` with a `RECONCILE` attempt.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```powershell
$env:DATABASE_URL='postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test'; pnpm exec tsx --test tests/worker/publisher-product-worker.test.ts
```

Expected: failure because the Worker currently registers only `PUBLISH` and no code calls `reconcile()`.

- [ ] **Step 3: Implement the minimal durable path**

Add a bounded `PUBLISH_RECONCILE` job type, create it with a stable key derived from request and revision after `UNKNOWN_EXTERNAL_STATE`, and add a Worker handler that loads the same project-scoped aggregate/account, starts a `RECONCILE` attempt, calls the adapter contract, records `ExternalPost` only for `PUBLISHED`, and leaves `RECONCILING` for `UNKNOWN` or transitions to `FAILED` for `NOT_FOUND` according to the contract.

- [ ] **Step 4: Run the focused worker tests**

Run the worker test file again and confirm success, retry, human-action, unknown-state and reconciliation cases all pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/publisher.ts packages/modules/publisher/src/publisher-service.ts workers/publisher-worker/src/main.ts workers/publisher-worker/src/dev-main.ts tests/worker/publisher-product-worker.test.ts
git commit -m "fix: complete publisher reconciliation path"
```

### Task 2: Make Fake Adapter model both ambiguous external outcomes

**Files:**
- Modify: `packages/modules/publisher/src/fake-publisher.ts`
- Modify: `tests/contract/publisher.test.ts`
- Modify: `tests/integration/fake-publisher.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Cover an uncertain outcome whose side effect exists and one whose side effect does not exist. Assert `reconcile()` returns `PUBLISHED` with a stable external ID only for the first and `NOT_FOUND` for the second.

- [ ] **Step 2: Run the focused adapter tests and verify failure**

Run:

```powershell
pnpm exec tsx --test tests/contract/publisher.test.ts tests/integration/fake-publisher.test.ts
```

Expected: the new ambiguous-side-effect assertions fail because the current Fake Adapter returns unknown before persisting any side effect.

- [ ] **Step 3: Implement deterministic Fake behavior**

Add explicit Fake outcomes for `UNKNOWN_SIDE_EFFECT` and `UNKNOWN_NO_SIDE_EFFECT`, persist the deterministic external ID only in the first case, and keep all profile/credential data out of result payloads and diagnostics.

- [ ] **Step 4: Re-run focused adapter tests**

Confirm all adapter tests pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/modules/publisher/src/fake-publisher.ts tests/contract/publisher.test.ts tests/integration/fake-publisher.test.ts
git commit -m "test: model ambiguous fake publisher outcomes"
```

### Task 3: Remove active pre-publish Review writes and expose human action

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `tests/integration/review-api.test.ts`
- Modify: `tests/integration/publisher-product-api.test.ts`
- Modify: `tests/e2e/publisher-web.test.ts`
- Modify: `docs/adr/ADR-012-approval-boundary.md`

- [ ] **Step 1: Write failing boundary and human-action tests**

Assert that new Publisher queueing uses only an exact `Approval` decision, legacy `/reviews` cannot create new pre-publish PUBLISH/RENDER decisions, and an authentication failure exposes a stable `NEEDS_HUMAN_ACTION` classification in the project-scoped Publisher response/UI.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
$env:DATABASE_URL='postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test'; pnpm exec tsx --test tests/integration/review-api.test.ts tests/integration/publisher-product-api.test.ts tests/e2e/publisher-web.test.ts
```

Expected: legacy Review creation still succeeds and Publisher responses do not expose a human-action state.

- [ ] **Step 3: Implement the boundary and safe status projection**

Make legacy Review routes read-only or return a stable migration error for pre-publish targets, add Publisher attempt classification to a safe project-scoped response, and render explicit Approval Gate and `NEEDS_HUMAN_ACTION` labels without exposing credentials, cookies, tokens or profile paths.

- [ ] **Step 4: Run focused API/UI tests and build**

Run the focused tests and `pnpm --dir apps/web build`; confirm all pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/app.ts apps/web/app/projects/[id]/publisher/page.tsx apps/api/src/publisher-routes.ts packages/modules/publisher/src/publisher-service.ts tests/integration/review-api.test.ts tests/integration/publisher-product-api.test.ts tests/e2e/publisher-web.test.ts docs/adr/ADR-012-approval-boundary.md
git commit -m "fix: enforce approval gate and human action state"
```

### Task 4: Use project-scoped Render Asset selection and validation

**Files:**
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `tests/integration/publisher-product-api.test.ts`
- Modify: `tests/e2e/publisher-web.test.ts`

- [ ] **Step 1: Write failing project-scoped asset tests**

Assert that the Publisher API lists only the current project’s `VIDEO_RENDER` assets in `READY` state, rejects an asset from another project, rejects a checksum mismatch, and accepts a valid selected asset without requiring manual checksum entry in the UI.

- [ ] **Step 2: Run focused tests and verify failure**

Run the Publisher API and UI tests and confirm the current manual Asset ID/checksum flow does not satisfy these assertions.

- [ ] **Step 3: Implement public asset selection and validation**

Use the existing project-scoped Asset API/service contract to expose selectable Render Assets, validate project ownership/type/lifecycle/checksum at request creation, and update the page to select an asset and display its server-provided checksum.

- [ ] **Step 4: Run focused tests and build**

Run the focused tests and Web production build; confirm all pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/publisher-routes.ts apps/web/app/projects/[id]/publisher/page.tsx packages/modules/publisher/src/publisher-service.ts tests/integration/publisher-product-api.test.ts tests/e2e/publisher-web.test.ts
git commit -m "fix: select project render assets for publishing"
```

### Task 5: Close concurrent idempotency and final acceptance evidence

**Files:**
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `packages/modules/job/src/job-service.ts` only if the existing public create contract cannot atomically get-or-create
- Modify: `tests/integration/publisher-product-api.test.ts`
- Modify: `docs/engineering/PUBLISHER_FAKE_VERTICAL_SLICE_REPORT.md`

- [ ] **Step 1: Write the failing concurrent queue test**

Send two concurrent queue requests for the same approved request/revision and assert both return the same Job ID, one Job exists, and the request transitions only once.

- [ ] **Step 2: Run the focused test and verify failure**

Run the Publisher API integration test and confirm the current read-then-create sequence can surface a unique-constraint conflict.

- [ ] **Step 3: Implement atomic get-or-create behavior**

Catch the idempotency conflict and re-read the existing Job through `JobService`, or add a small public atomic helper that preserves the Job contract; never expose a database error to the API caller.

- [ ] **Step 4: Run full verification**

Run:

```powershell
$env:DATABASE_URL='postgresql://contentos_dev:change-me@127.0.0.1:55433/contentos_test'; pnpm test
pnpm typecheck
pnpm lint
pnpm --dir apps/web build
git diff --check
git status --short --branch
```

Expected: all tests pass, typecheck/lint/build exit 0, diff check is clean, and only the E-drive worktree branch contains changes.

- [ ] **Step 5: Update the acceptance report and commit**

Document the actual Reconcile, Approval, Asset selection, human-action and concurrent-idempotency evidence in `docs/engineering/PUBLISHER_FAKE_VERTICAL_SLICE_REPORT.md`, then commit the report.
