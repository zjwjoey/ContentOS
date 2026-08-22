# Director Operator Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Director V1 local operator flow startable and executable end-to-end with a Fake AI worker, contract-aligned UI, and isolated tests.

**Architecture:** Keep API, Web, and Director Worker as separate processes. Add a Job-module query for runnable job IDs, a development-only Director composition root using FakeAIProvider, and a root process launcher. Keep API request handlers short and keep production Worker dependency injection fail-closed.

**Tech Stack:** Node.js/TypeScript, Fastify, Next.js 14, PostgreSQL 16, pnpm, node:test, existing JobRunner/WorkerRuntime/AIService contracts.

---

### Task 1: Make migration resolution independent of process cwd

**Files:**
- Modify: `packages/database/src/migrator.ts`
- Test: `tests/integration/database.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that invokes the migrator after temporarily changing `process.cwd()` to `apps/api` and asserts `migrateUp` remains idempotent. The test must use the existing database fixture and restore cwd in `finally`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
$env:DATABASE_URL='postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev'; pnpm exec tsx --test tests/integration/database.test.ts
```

Expected failure: `ENOENT` for `apps/api/migrations` or an equivalent cwd-dependent path error.

- [ ] **Step 3: Implement the minimal path resolver**

Change the migrator to accept an optional directory argument and default it by searching from the module location for the repository `migrations` directory. Keep `migrateUp(db, directory?)` and `migrateDown(db, directory?)` backwards compatible. Do not read another module's tables.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same focused command. Expected: all database tests pass with no cwd path error.

- [ ] **Step 5: Commit**

```powershell
git add packages/database/src/migrator.ts tests/integration/database.test.ts
git commit -m "fix: resolve migrations independently of process cwd"
```

### Task 2: Expose runnable Job queries and a local Director composition

**Files:**
- Modify: `packages/modules/job/src/job-service.ts`
- Modify: `workers/director-worker/src/main.ts`
- Create: `workers/director-worker/src/dev-main.ts`
- Modify: `workers/director-worker/package.json`
- Test: `tests/integration/job.test.ts`
- Test: `tests/worker/director-worker.test.ts`

- [ ] **Step 1: Write failing Job query and dev composition tests**

Add one Job test that creates two queued jobs and asserts `listRunnable(['DIRECTOR_GENERATE_SCRIPT'])` returns only the matching job. Add one Worker test that proves the development composition can start, claims a queued Director job, and leaves it `SUCCEEDED` with a Script revision.

- [ ] **Step 2: Run focused tests and verify they fail**

```powershell
$env:DATABASE_URL='postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev'; pnpm exec tsx --test tests/integration/job.test.ts tests/worker/director-worker.test.ts
```

Expected failure: missing `listRunnable` and missing development composition/polling behavior.

- [ ] **Step 3: Implement the public Job query**

Add `listRunnable(types: string[], limit = 10)` to `JobService`, selecting only `QUEUED` jobs and eligible `RETRY_WAIT` jobs whose retry time has arrived, ordered by creation time. Map rows through the existing `mapJob` function. No worker code may issue direct SQL against `jobs`.

- [ ] **Step 4: Implement the development composition**

Add a `dev-main.ts` that loads config, creates the database, migrates, composes `JobService`, `DirectorV1Service`, `AIService` with `FakeAIProvider`/`PromptRegistry`, creates the existing `createDirectorWorker` runtime, starts it, polls `listRunnable` for the two Director types, dispatches `{ jobId }`, and shuts down on SIGINT/SIGTERM. Make polling interval and lease behavior deterministic for tests. Keep `src/main.ts` fail-closed.

- [ ] **Step 5: Run focused tests and verify they pass**

Run the same focused command. Expected: Job query and Fake Director execution pass with no duplicate revision on repeated delivery.

- [ ] **Step 6: Commit**

```powershell
git add packages/modules/job/src/job-service.ts workers/director-worker/src/main.ts workers/director-worker/src/dev-main.ts workers/director-worker/package.json tests/integration/job.test.ts tests/worker/director-worker.test.ts
git commit -m "feat: add runnable local director worker composition"
```

### Task 3: Add root operator startup and startup regression tests

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/api/package.json`
- Modify: `workers/director-worker/package.json`
- Modify: `package.json`
- Create: `scripts/dev-operator.ts`
- Test: `tests/e2e/director-web.test.ts`

- [ ] **Step 1: Write failing startup contract tests**

Assert package scripts expose API dev, Web port 3001, Director development worker, and root `dev:operator`. Assert the migration test can start from the API package directory.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
pnpm exec tsx --test tests/e2e/director-web.test.ts
```

Expected failure: missing root script and worker development script.

- [ ] **Step 3: Implement scripts**

Add a Node-based `scripts/dev-operator.ts` that spawns the API, Web, and Director development worker with inherited environment, sets `PORT=3000`, `CONTENTOS_API_URL=http://127.0.0.1:3000`, and `PORT=3001` for Web, forwards child failures, and sends termination to all children. Add package scripts without introducing a process-manager dependency.

- [ ] **Step 4: Verify startup contract and process behavior**

Run the focused test, then start `pnpm dev:operator` with the test database and confirm `/health` and `/api/v1/projects` respond before stopping all children.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/package.json apps/web/package.json workers/director-worker/package.json package.json scripts/dev-operator.ts tests/e2e/director-web.test.ts
git commit -m "feat: add one-command director operator startup"
```

### Task 4: Fix Director API error classification and add project creation endpoint coverage

**Files:**
- Modify: `apps/api/src/director-routes.ts`
- Test: `tests/integration/director-v1-api.test.ts`

- [ ] **Step 1: Write failing response assertions**

Add requests for an invalid Brief with empty list fields and a nonexistent project. Assert invalid input returns 422 `DIRECTOR_VALIDATION_ERROR` and nonexistent project returns 404 `DIRECTOR_PROJECT_NOT_FOUND`.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
$env:DATABASE_URL='postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev'; pnpm exec tsx --test tests/integration/director-v1-api.test.ts
```

Expected failure: domain validation is currently mapped to the project-not-found envelope.

- [ ] **Step 3: Implement typed classification**

Check project existence before calling `createBrief`; map contract validation errors to 422 while preserving 404 for missing projects. Do not use broad message matching for validation outcomes.

- [ ] **Step 4: Verify and commit**

Run the focused test, then:

```powershell
git add apps/api/src/director-routes.ts tests/integration/director-v1-api.test.ts
git commit -m "fix: classify director validation errors accurately"
```

### Task 5: Make the Web operator flow contract-complete

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/projects/[id]/director/page.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `tests/e2e/director-web.test.ts`

- [ ] **Step 1: Write failing UI behavior assertions**

Extend the static smoke test to require project creation fields, Brief `mustInclude`/`mustAvoid` controls, API error details, job status polling, and cleanup of the polling timer.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
pnpm exec tsx --test tests/e2e/director-web.test.ts
```

Expected failure: current page has none of the required controls or polling.

- [ ] **Step 3: Implement minimal UI behavior**

Add a project creation form with loading/error state and redirect. Replace the Brief defaults with typed state containing string list inputs, convert newline-separated values to arrays on submit, and render server error details. Add `useEffect` polling that fetches `/api/v1/jobs/:id`, stops at terminal states, refreshes revisions on success, and clears the timer on unmount. Keep all API calls credential-free.

- [ ] **Step 4: Verify Web typecheck/build and focused tests**

```powershell
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
pnpm exec tsx --test tests/e2e/director-web.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add apps/web/app/page.tsx apps/web/app/projects/[id]/director/page.tsx apps/web/app/globals.css tests/e2e/director-web.test.ts
git commit -m "feat: complete director operator workflow"
```

### Task 6: Isolate test fixtures and perform full verification

**Files:**
- Modify: `tests/integration/ai-run.test.ts`
- Modify: `tests/integration/director-v1-api.test.ts`
- Modify: `tests/worker/director-worker.test.ts`
- Modify: `docs/development/LOCAL_SETUP.md`
- Modify: `.env.example`

- [ ] **Step 1: Write failing isolation assertion**

Run the full suite twice against the same test database and assert both runs produce the same result. Add cleanup assertions for AI Run fixtures and use stable Provider + Model provenance assertions.

- [ ] **Step 2: Run twice and verify the current suite is not stable**

```powershell
$env:DATABASE_URL='postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev'; pnpm test
$env:DATABASE_URL='postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev'; pnpm test
```

Expected baseline: the existing shared database can fail because persistent catalog rows change IDs and prior preview rows remain.

- [ ] **Step 3: Implement fixture cleanup and environment documentation**

Clean project-scoped records in `finally` blocks, assert catalog identity by stable provider/model fields, and document separate `contentos_operator_dev` and `contentos_test` URLs in `.env.example` and local setup instructions.

- [ ] **Step 4: Run the complete verification matrix**

```powershell
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run doctor
pnpm --filter @contentos/web build
git diff --check
```

Expected: every command exits 0; test output reports 0 failures.

- [ ] **Step 5: Start the real local stack and preview**

Run `pnpm dev:operator` with a dedicated Operator database, verify project creation, Brief submission, Script Job completion and UI refresh through the local browser, then stop the development processes while leaving PostgreSQL unchanged.

- [ ] **Step 6: Commit documentation and final evidence**

```powershell
git add tests/integration/ai-run.test.ts tests/integration/director-v1-api.test.ts tests/worker/director-worker.test.ts docs/development/LOCAL_SETUP.md .env.example
git commit -m "test: isolate director operator development fixtures"
```
