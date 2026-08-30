# Stage 2 Browser Acceptance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the complete Fake Platform product flow in a browser without allowing its workers to interfere with any other test run.

**Architecture:** The harness creates a random PostgreSQL schema inside the configured test database, migrates that schema before launching the operator, and gives every child process the schema-specific URL, temporary storage root and dynamically allocated loopback ports. Fake Publisher simulations are durable Publisher-owned development metadata keyed by Fake account; only the development composition can read them, so real adapters and production API routes remain unchanged.

**Tech Stack:** Node.js, TypeScript, PostgreSQL schemas, Fastify, Next.js, Playwright, FFmpeg, Node test runner.

## Completion record — 2026-08-29

Tasks 1–4 are complete. The final gate passed with the owned browser operator
isolated in a UUID-named PostgreSQL schema: format, lint, typecheck, root and
Web builds, migration matrix (3/3), full test suite (191/191), browser journey
(1/1), doctor and diff check. Human acceptance is still required before any
freeze, remote push, merge, or Video V2 work.

---

### Task 1: Create the isolated operator lifecycle harness

**Files:**

- Modify: `scripts/test-operator-browser.ts`
- Modify: `scripts/dev-operator.ts`
- Modify: `tests/e2e/operator-browser.test.ts`
- Test: `tests/e2e/operator-browser.test.ts`

- [ ] **Step 1: Write a failing browser-harness assertion**

  Add an assertion that `CONTENTOS_OPERATOR_URL` and `CONTENTOS_BROWSER_FIXTURE_VIDEO` are supplied by `pnpm test:browser`, rather than allowing the test to skip:

  ```ts
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  assert.ok(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO, 'test:browser must provide a playable upload fixture');
  ```

- [ ] **Step 2: Run the browser command and confirm RED**

  Run: `pnpm test:browser`

  Expected: FAIL because the existing wrapper only launches the test and does not create an operator or fixture.

- [ ] **Step 3: Implement owned-resource setup and teardown**

  In `scripts/test-operator-browser.ts`:

  ```ts
  const schema = `contentos_browser_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema "${schema}"`);
  const scopedUrl = new URL(adminUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  await migrateUp(await createDatabase(scopedUrl.toString()));
  ```

  Allocate API and Web loopback ports by binding temporary `net.createServer()` instances to port `0`. Generate one short playable MP4 fixture with the existing FFmpeg infrastructure helper. Start `scripts/dev-operator.ts` with the scoped URL, unique storage root, fixture path, `CONTENTOS_FAKE_PUBLISHER_CONTROLS=1`, and the allocated ports. Poll `/health` until it returns 200. In `finally`, stop only the process tree started by this wrapper, drop exactly the generated schema with `cascade`, and remove only the generated temporary root.

  In `scripts/dev-operator.ts`, replace the hard-coded Web port `3001` with `WEB_PORT ?? '3001'`, and derive `CONTENTOS_API_URL` from the supplied API port.

- [ ] **Step 4: Run the wrapper with the existing navigation smoke**

  Run: `pnpm test:browser`

  Expected: PASS with one browser test; a second concurrent `pnpm test` must not see any operator listener or shared-schema Job consumer.

- [ ] **Step 5: Commit the harness baseline**

  ```powershell
  git add scripts/test-operator-browser.ts scripts/dev-operator.ts tests/e2e/operator-browser.test.ts package.json
  git commit -m "test: isolate browser operator acceptance"
  ```

### Task 2: Add development-only durable Fake Publisher simulations

**Files:**

- Create: `migrations/0013_publisher_fake_simulations.sql`
- Create: `migrations/0013_publisher_fake_simulations.down.sql`
- Create: `packages/modules/publisher/src/fake-simulation-service.ts`
- Modify: `packages/modules/publisher/src/fake-publisher.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `workers/publisher-worker/src/dev-main.ts`
- Modify: `apps/api/src/publisher-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `tests/integration/migration-matrix.test.ts`
- Modify: `tests/integration/publisher-product-api.test.ts`
- Modify: `tests/worker/publisher-product-worker.test.ts`

- [ ] **Step 1: Write failing service/API tests**

  Add one test that a Fake account can store `NETWORK`, `AUTH_EXPIRED`, or `BROWSER_CRASH` only when development controls are enabled, and that a non-Fake account or disabled controls receive a safe rejection. Add one Worker test that `NETWORK` is resolved for the first attempt and a subsequent `SUCCESS` update lets the same idempotent request reach one ExternalPost.

- [ ] **Step 2: Run focused tests and confirm RED**

  Run: `pnpm tsx --test --test-concurrency=1 tests/integration/publisher-product-api.test.ts tests/worker/publisher-product-worker.test.ts`

  Expected: FAIL because there is no durable simulation record or control endpoint.

- [ ] **Step 3: Implement the Publisher-owned simulation boundary**

  Create migration `0013_publisher_fake_simulations` with `account_id` primary key referencing `publisher_accounts`, checked `outcome`, and timestamps. `FakePublisherSimulationService` owns all SQL and exposes:

  ```ts
  set(projectId: string, accountId: string, outcome: FakeOutcome): Promise<FakeOutcome>;
  get(projectId: string, accountId: string): Promise<FakeOutcome>;
  getForAccount(accountId: string): Promise<FakeOutcome>;
  ```

  It must verify Fake-account ownership inside the Publisher module and default to `SUCCESS` when no row exists. Refactor `FakePublisherService` to reuse an adapter per account and asynchronously refresh its outcome before `publish`; preserving the adapter instance is required so a `BROWSER_CRASH` side effect remains available to `reconcile` after the control changes.

  Extend `PublisherWorkerOptions` with an optional simulation resolver. Only `dev-main.ts`, gated by `CONTENTOS_FAKE_PUBLISHER_CONTROLS === '1'`, injects it. Real adapters never receive or consult simulation data.

  Add `allowFakePublisherControls` to `ApiRuntimeDependencies`, defaulting to `false`; `apps/api/src/main.ts` passes `true` only when `CONTENTOS_FAKE_PUBLISHER_CONTROLS === '1'`. Register safe `GET`/`PUT /api/v1/projects/:projectId/publisher/accounts/:accountId/fake-outcome` routes only when that dependency is true. The Web page shows the selector only after the safe GET endpoint succeeds; it never displays credentials, profile keys or diagnostics. Update the migration matrix from `0001`–`0012` to `0001`–`0013`.

- [ ] **Step 4: Run focused tests and typecheck**

  Run: `pnpm tsx --test --test-concurrency=1 tests/integration/publisher-product-api.test.ts tests/worker/publisher-product-worker.test.ts`

  Run: `pnpm typecheck`

  Expected: PASS; disabled API and real Publisher composition cannot use Fake simulations.

- [ ] **Step 5: Commit the development simulation boundary**

  ```powershell
  git add migrations packages/modules/publisher workers/publisher-worker apps/api apps/web tests
  git commit -m "feat: add development Fake Publisher simulations"
  ```

### Task 3: Replace the navigation smoke with full browser scenarios

**Files:**

- Modify: `tests/e2e/operator-browser.test.ts`
- Modify: `scripts/test-operator-browser.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the RED success journey**

  Use only visible Playwright actions to create a project, upload the fixture, wait for `可用素材`, create a full Brief, wait for Fake AI Script, accept it, wait for Storyboard, approve it, create a render, wait for the preview, create and approve the exact Render Approval, create a Fake account and Publish Revision, approve the exact Publish Revision, queue it, and wait for `ExternalPost` plus Project Center `PUBLISHED`.

  Use condition polling with a bounded timeout rather than arbitrary fixed waits. Click the queue action twice and assert the page still displays one external post.

- [ ] **Step 2: Run and confirm RED**

  Run: `pnpm test:browser`

  Expected: FAIL at the first missing development control or product-flow synchronization gap.

- [ ] **Step 3: Make only flow-level fixes revealed by the browser**

  Preserve module public contracts. Fix only browser-safe waits, route composition, UI state refresh, or Fake development-control wiring. Do not run FFmpeg, AI, or browser automation in Fastify handlers.

- [ ] **Step 4: Add the three required failure journeys**

  In three independent projects, use the visible Fake outcome selector before queueing:

  ```text
  NETWORK → visible retry attempt → change to SUCCESS → one ExternalPost
  AUTH_EXPIRED → NEEDS_HUMAN_ACTION → no automatic retry
  BROWSER_CRASH → RECONCILING → Publisher Worker reconciliation → one ExternalPost
  ```

  Assert that every Approval binds the current target revision and that neither duplicate clicks nor reconciliation create a second ExternalPost.

- [ ] **Step 5: Run browser acceptance and commit**

  Run: `pnpm test:browser`

  Expected: PASS with success, retry, human-action and reconciliation cases.

  ```powershell
  git add tests/e2e/operator-browser.test.ts scripts/test-operator-browser.ts package.json
  git commit -m "test: prove complete Fake product flow in browser"
  ```

### Task 4: Record the repaired final Gate

**Files:**

- Modify: `docs/superpowers/reports/2026-08-29-contentos-unified-product-flow.md`
- Modify: `progress.md`

- [ ] **Step 1: Run the complete verification suite without a shared operator**

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

  Expected: every command exits 0. `pnpm test:browser` owns and removes its schema/processes, so it cannot consume Jobs from `pnpm test`.

- [ ] **Step 2: Update the acceptance report**

  Record exact test counts, browser scenarios, schema-isolation behavior, the scope of the development-only fake controls, and that real adapters and Review analytics remain disabled.

- [ ] **Step 3: Commit documentation and stop for human acceptance**

  ```powershell
  git add docs/superpowers/reports/2026-08-29-contentos-unified-product-flow.md progress.md
  git commit -m "docs: close Stage 2 browser acceptance"
  ```

  Do not freeze the branch, push it, merge to `main`, or start Video V2 until the user reviews this final report.
