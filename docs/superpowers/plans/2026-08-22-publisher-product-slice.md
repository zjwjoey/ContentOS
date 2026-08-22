# Publisher Product Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Publisher foundation 推进为可通过项目操作的 Fake Platform 发布垂直切片。

**Architecture:** API 只创建/查询 Publisher 记录并入队 durable `PUBLISH` Job；Publisher Worker 通过 adapter contract 执行 Fake Platform，使用绑定具体 Publish Revision 的 Approval 作为门禁，并把结果写回 Publisher attempt/request/external post。Web 只调用安全的 project-scoped API。

**Tech Stack:** TypeScript, Fastify, Zod, PostgreSQL, existing JobService/JobRunner, Node test runner, Next.js.

---

### Task 1: Extend Publisher application service for project-scoped reads and queue payloads

**Files:**
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Test: `tests/integration/publisher-product.test.ts`

- [ ] **Step 1: Write the failing service tests**

Add tests that create a project, Fake account and request, then assert project-scoped account/request listing, current revision retrieval, and a queue payload containing only IDs and correlation data. Assert a second create with the same idempotency key returns the original request and revision.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run `pnpm exec tsx --test tests/integration/publisher-product.test.ts`.
Expected: failure because the listing and queue methods do not exist.

- [ ] **Step 3: Implement the minimal service methods**

Add `listAccounts(projectId)`, `listRequests(projectId)`, `getRequestAggregate(projectId, requestId)`, and `buildPublishJobPayload(projectId, requestId, jobId, jobAttemptId)`. Each query must include `project_id` and return mapped domain records. The queue payload must not include credential refs, profile paths or asset bytes.

- [ ] **Step 4: Run the focused test and verify it passes**

Run `pnpm exec tsx --test tests/integration/publisher-product.test.ts` with the project test database available.
Expected: focused Publisher integration tests pass.

- [ ] **Step 5: Commit**

Run `git add packages/modules/publisher/src/publisher-service.ts packages/modules/publisher/src/index.ts tests/integration/publisher-product.test.ts && git commit -m "feat: expose publisher product application queries"`.

### Task 2: Add project-scoped Publisher API and Approval-gated queueing

**Files:**
- Create: `apps/api/src/publisher-routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `tests/integration/publisher-product-api.test.ts`

- [ ] **Step 1: Write the failing route tests**

Cover account creation, request creation, request listing, missing-project handling, and queueing. Queueing must return `409 PUBLISH_APPROVAL_REQUIRED` until `ApprovalService` has an approved `PUBLISH` decision for the exact current revision; after approval it must create one `PUBLISH` Job and transition the request to `QUEUED`. Repeating the queue call must return the existing Job.

- [ ] **Step 2: Run the focused route test and verify the expected failure**

Run `pnpm exec tsx --test tests/integration/publisher-product-api.test.ts`.
Expected: failure because Publisher routes are not registered.

- [ ] **Step 3: Implement the routes**

Create Fastify route registrars that validate bodies with Zod, verify the project through `ProjectService`, call `PublisherService`, call `ApprovalService.getCurrent(projectId, 'PUBLISH', requestId, revisionId)`, and use `JobService.getByIdempotencyKey/create` for queueing. Register them from `buildApi` with shared service instances. Return safe errors with no credential-shaped fields.

- [ ] **Step 4: Run the focused route test and verify it passes**

Run the focused test again and confirm all route cases pass.

- [ ] **Step 5: Commit**

Run `git add apps/api/src/publisher-routes.ts apps/api/src/app.ts tests/integration/publisher-product-api.test.ts && git commit -m "feat: add review-gated publisher API"`.

### Task 3: Replace Publisher Worker bootstrap with durable Fake publish handler

**Files:**
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Test: `tests/worker/publisher-product-worker.test.ts`

- [ ] **Step 1: Write the failing worker tests**

Assert that the composed worker registers only `PUBLISH`, runs a successful Fake publish to `PUBLISHED` and records one external post, maps `RATE_LIMIT` to retryable `FAILED`/`RETRY_WAIT`, maps `AUTH_EXPIRED` to human-action failure without retry, and maps `UNKNOWN_EXTERNAL_STATE` to `RECONCILING` with no blind retry.

- [ ] **Step 2: Run the focused worker test and verify the expected failure**

Run `pnpm exec tsx --test tests/worker/publisher-product-worker.test.ts`.
Expected: failure because the current worker only registers `publisher.publish` no-op bootstrap behavior.

- [ ] **Step 3: Implement the handler and development composition**

Add a `createPublisherWorker({ service, adapter, workerId })` composition that uses `JobRunner` and registers exactly `PUBLISH`. Load account/request/revision through PublisherService, start/finish attempts, call the adapter, record external posts, and transition requests according to the contract. Keep credentials out of logs and payloads.

- [ ] **Step 4: Run focused worker and existing worker tests**

Run `pnpm exec tsx --test tests/worker/publisher-product-worker.test.ts tests/worker/fake-publisher-worker.test.ts`.
Expected: all Publisher worker tests pass and the legacy Fake Adapter isolation test remains green.

- [ ] **Step 5: Commit**

Run `git add workers/publisher-worker/src/main.ts packages/modules/publisher/src/publisher-service.ts tests/worker/publisher-product-worker.test.ts && git commit -m "feat: execute durable fake publisher jobs"`.

### Task 4: Add the project Publisher Operator page

**Files:**
- Create: `apps/web/app/projects/[id]/publisher/page.tsx`
- Modify: `apps/web/app/projects/[id]/director/page.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `tests/e2e/publisher-web.test.ts`

- [ ] **Step 1: Write the failing static UI test**

Assert that the page calls only project-scoped Publisher endpoints, renders account/request statuses, offers Fake account/request/queue actions, links to Director, and contains no strings or fields for credential, cookie, token, authorization or browser profile.

- [ ] **Step 2: Run the focused UI test and verify the expected failure**

Run `pnpm exec tsx --test tests/e2e/publisher-web.test.ts`.
Expected: failure because the page does not exist.

- [ ] **Step 3: Implement the minimal operator page**

Create a client page that loads accounts and requests, creates a Fake account with a capability snapshot, creates a request from an existing asset ID/title, calls the Review approval endpoint, and queues the request. Display safe error messages and link between Director and Publisher project pages.

- [ ] **Step 4: Run the focused UI test and Web production build**

Run `pnpm exec tsx --test tests/e2e/publisher-web.test.ts` and `pnpm --dir apps/web build`.
Expected: static smoke and production build pass.

- [ ] **Step 5: Commit**

Run `git add apps/web/app/projects/[id]/publisher/page.tsx apps/web/app/projects/[id]/director/page.tsx apps/web/app/globals.css tests/e2e/publisher-web.test.ts && git commit -m "feat: add publisher operator page"`.

### Task 5: Full verification and documentation

**Files:**
- Modify: `docs/engineering/NEXT_VERTICAL_SLICES.md`
- Modify: `docs/modules/PUBLISHER_MODULE_V0.md`

- [ ] **Step 1: Update status documentation**

Record that Fake Publisher API, durable Worker execution, Approval-gated queueing and Operator UI are complete; retain real Douyin/WeChat adapters, metrics and post-publish Review as explicit deferred work.

- [ ] **Step 2: Run verification commands**

Run `pnpm typecheck`, `pnpm lint`, `pnpm --dir apps/web build`, and the full `pnpm test` with PostgreSQL available. Record any environment-only failures separately from code failures.

- [ ] **Step 3: Inspect the final diff and commit documentation**

Run `git diff --check`, `git status --short`, then commit the documentation with `git add docs/engineering/NEXT_VERTICAL_SLICES.md docs/modules/PUBLISHER_MODULE_V0.md && git commit -m "docs: report publisher product slice"`.
