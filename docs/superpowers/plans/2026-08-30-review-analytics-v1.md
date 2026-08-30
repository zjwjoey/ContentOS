# Review Analytics V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Build a post-publish Review Analytics slice that records immutable Fake/Import metric snapshots for confirmed ExternalPosts and produces provenance-backed AI analysis reports.

**Architecture:** Review consumes a public Publisher ExternalPost read port and owns `MetricSnapshotV1` and `ReviewAnalysisReportV1` persistence. Two durable Job types (`REVIEW_COLLECT_METRICS` and `REVIEW_GENERATE_ANALYSIS`) are handled by a dedicated Review Worker; HTTP handlers only validate input and enqueue work. PostgreSQL remains business truth, and all AI calls go through the existing AI Provider contract.

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, PostgreSQL migrations, existing JobService/JobRunner, existing AIService/FakeAIProvider, React/Next.js Operator UI, Node test runner, Playwright.

---

## Task 1: Add Review Analytics contracts and validators

**Files:**

- Create: `packages/contracts/src/review-analytics.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/contract/review-analytics.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests for `validateMetricSnapshotV1` and `validateReviewAnalysisReportV1` that prove valid records pass, negative/non-integer metrics fail, invalid timestamps fail, empty snapshot references fail, unsupported schema versions fail, and recommendation priorities are limited to `HIGH|MEDIUM|LOW`.

```ts
test('accepts a complete metric snapshot and rejects unsafe metric values', () => {
  assert.doesNotThrow(() => validateMetricSnapshotV1(validSnapshot));
  assert.throws(() => validateMetricSnapshotV1({ ...validSnapshot, metrics: { ...validSnapshot.metrics, plays: -1 } }), /non-negative integer/);
  assert.throws(() => validateMetricSnapshotV1({ ...validSnapshot, capturedAt: 'not-a-date' }), /capturedAt/);
});

test('requires at least one snapshot and bounded structured recommendations', () => {
  assert.doesNotThrow(() => validateReviewAnalysisReportV1(validReport));
  assert.throws(() => validateReviewAnalysisReportV1({ ...validReport, metricSnapshotIds: [] }), /metricSnapshotIds/);
  assert.throws(() => validateReviewAnalysisReportV1({ ...validReport, recommendations: [{ priority: 'URGENT' }] }), /priority/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `pnpm exec tsx --test tests/contract/review-analytics.test.ts`.
Expected: FAIL because the new contract types and validators do not exist.

- [ ] **Step 3: Implement the minimal contracts**

Define `MetricSnapshotSource`, `MetricSnapshotV1`, `ReviewRecommendationV1`, `ReviewAnalysisReportV1`, `validateMetricSnapshotV1`, and `validateReviewAnalysisReportV1`. Bound strings to 20,000 characters, arrays to 100 entries, and metric values to safe non-negative integers. Export them from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command; expected: all contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/review-analytics.ts packages/contracts/src/index.ts tests/contract/review-analytics.test.ts
git commit -m "feat: add review analytics contracts"
```

## Task 2: Add migration 0019 and migration-matrix coverage

**Files:**

- Create: `migrations/0019_review_analytics.sql`
- Create: `migrations/0019_review_analytics.down.sql`
- Modify: `tests/integration/migration-matrix.test.ts:14-17,45-58`
- Modify: `tests/integration/database.test.ts` table inventory assertion

- [ ] **Step 1: Extend the migration tests before creating tables**

Change the migration inventory from 18 to 19 and expected applied/current names accordingly. Add a test that checks `review_metric_snapshots` and `review_analysis_reports` exist with their uniqueness/index constraints.

- [ ] **Step 2: Run migration tests and verify RED**

Run `pnpm test:migrations` with the configured PostgreSQL test URL.
Expected: FAIL because migration `0019` is missing and the expected count is 19.

- [ ] **Step 3: Create the up/down migration**

Create `review_metric_snapshots` with `id`, `project_id`, `external_post_id`, `platform_id`, `captured_at`, `published_at`, `metrics jsonb`, `source`, `source_reference`, `schema_version`, `created_at`, a non-negative integer JSON check, and unique `(external_post_id, source, captured_at)`. Create `review_analysis_reports` with `id`, `project_id`, `external_post_id`, `metric_snapshot_ids text[]`, `schema_version`, `summary`, `highlights jsonb`, `risks jsonb`, `recommendations jsonb`, `ai_run_id`, `created_at`; add project/post indexes. Use only `content_projects(id)` foreign keys so Review does not own Publisher tables. The down migration drops both tables in reverse order.

- [ ] **Step 4: Run migration tests and verify GREEN**

Run `pnpm test:migrations` and the database inventory test. Expected: all migration cases pass and the chain reports 19 migrations.

- [ ] **Step 5: Commit**

```bash
git add migrations/0019_review_analytics.sql migrations/0019_review_analytics.down.sql tests/integration/migration-matrix.test.ts tests/integration/database.test.ts
git commit -m "feat: add review analytics persistence"
```

## Task 3: Expose a public ExternalPost reader

**Files:**

- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `packages/modules/publisher/src/index.ts` if a new type export is needed
- Test: `tests/integration/publisher-external-post-reader.test.ts`

- [ ] **Step 1: Write the failing reader test**

Create two projects, accounts and ExternalPosts, then assert `publisher.getExternalPost(projectA, postA)` returns only the matching public `PublisherExternalPost` plus its project/account/platform reference, and cross-project or unknown IDs return `null`.

- [ ] **Step 2: Run the test and verify RED**

Run `pnpm exec tsx --test tests/integration/publisher-external-post-reader.test.ts`.
Expected: FAIL because the public reader method is absent.

- [ ] **Step 3: Implement the reader**

Add `getExternalPost(projectId: string, externalPostId: string): Promise<PublisherExternalPost | null>` using a project-scoped query through `publisher_requests` and `publisher_external_posts`, mapping only the existing public contract fields. Do not export database rows or credentials.

- [ ] **Step 4: Run the test and verify GREEN**

Run the focused integration test; expected: project isolation and missing-record cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/modules/publisher/src/publisher-service.ts packages/modules/publisher/src/index.ts tests/integration/publisher-external-post-reader.test.ts
git commit -m "feat: expose project-scoped external post reader"
```

## Task 4: Implement Review Analytics application service and Job creation

**Files:**

- Create: `packages/modules/review/src/review-job-service.ts`
- Create: `packages/modules/review/src/review-analytics-service.ts`
- Modify: `packages/modules/review/src/index.ts`
- Test: `tests/integration/review-analytics-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover: collection Job creation only for a confirmed project-owned ExternalPost; same idempotency key and same payload returns the existing Job; same key with a different post returns `409`-style conflict; `recordMetricSnapshot` is append-only and database-conflict idempotent; `createAnalysisJob` rejects empty or cross-post snapshot IDs; `recordAnalysisReport` appends and `listMetricSnapshots` orders newest first.

```ts
test('creates an idempotent metrics Job only for a confirmed ExternalPost', async () => {
  const first = await analytics.createMetricCollectionJob(input);
  const second = await analytics.createMetricCollectionJob(input);
  assert.equal(second.id, first.id);
  await assert.rejects(() => analytics.createMetricCollectionJob({ ...input, externalPostId: otherPostId }), /idempotency/i);
});
```

- [ ] **Step 2: Run focused integration tests and verify RED**

Run `pnpm exec tsx --test tests/integration/review-analytics-service.test.ts`; expected: FAIL because the service and tables are not implemented.

- [ ] **Step 3: Implement the service and job constants**

Define `REVIEW_COLLECT_METRICS` and `REVIEW_GENERATE_ANALYSIS`, payload schemas containing `schemaVersion`, project/post IDs, source or snapshot IDs, idempotency key and correlation ID, and max attempts `3`. Inject a `PublisherExternalPostReader` interface and `JobService`. Validate existing Jobs’ payload before returning them. Use `ON CONFLICT (external_post_id, source, captured_at)` for snapshot idempotency and transaction-safe report inserts.

- [ ] **Step 4: Run focused integration tests and verify GREEN**

Run the same test command; expected: all ownership, idempotency, append-only and ordering assertions pass.

- [ ] **Step 5: Commit**

```bash
git add packages/modules/review/src/review-job-service.ts packages/modules/review/src/review-analytics-service.ts packages/modules/review/src/index.ts tests/integration/review-analytics-service.test.ts
git commit -m "feat: add review analytics application service"
```

## Task 5: Add Fake metrics source and Review Worker collection path

**Files:**

- Create: `packages/modules/review/src/metrics-source.ts`
- Create: `packages/modules/review/src/fake-metrics-source.ts`
- Create: `workers/review-worker/package.json`
- Create: `workers/review-worker/src/main.ts`
- Create: `workers/review-worker/src/handler.ts`
- Create: `workers/review-worker/src/dev-main.ts`
- Test: `tests/worker/review-worker.test.ts`

- [ ] **Step 1: Write failing source/worker tests**

Assert Fake source output is deterministic for the same ExternalPost, all metrics are non-negative integers, a source `UNAVAILABLE` error is retryable, malformed post references are terminal, duplicate execution produces one snapshot, and JobRunner cancellation/lease fencing leaves no false success.

- [ ] **Step 2: Run worker tests and verify RED**

Run `pnpm exec tsx --test tests/worker/review-worker.test.ts`; expected: FAIL because the worker package and source do not exist.

- [ ] **Step 3: Implement the Fake source and worker**

Define `ReviewMetricsSource.collect(post)` and `FakeMetricsSource` with a constructor accepting an optional deterministic outcome. The worker must read the payload, verify project/post through the injected public reader, call the source, and use `JobRunner` with the existing `JobService` to persist either the snapshot result or normalized retry/permanent error. Register both Review Job types in `WorkerRuntime`; do not put credentials, storage keys or raw platform responses in payloads/logs.

- [ ] **Step 4: Wire the worker workspace and run tests**

Add `workers/review-worker` to the existing pnpm workspace via its package directory, run the focused worker tests and `pnpm typecheck`. Expected: all worker cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/modules/review/src/metrics-source.ts packages/modules/review/src/fake-metrics-source.ts workers/review-worker tests/worker/review-worker.test.ts
git commit -m "feat: add review metrics worker"
```

## Task 6: Extend AI provenance for Review analysis

**Files:**

- Modify: `packages/modules/ai/src/ai-service.ts` operation type
- Modify: `packages/modules/ai/src/prompt-registry.ts`
- Modify: `packages/modules/ai/src/fake-provider.ts`
- Test: `tests/unit/review-ai.test.ts`
- Test: `tests/integration/ai-run.test.ts` add Review operation provenance case

- [ ] **Step 1: Write failing AI tests**

Assert `PromptRegistry` renders `review.analysis.v1`, FakeAIProvider returns the expected structured fields, invalid structured output is rejected, and `AIService` persists operation/prompt/model provenance for `REVIEW_GENERATE_ANALYSIS`.

- [ ] **Step 2: Run tests and verify RED**

Run `pnpm exec tsx --test tests/unit/review-ai.test.ts tests/integration/ai-run.test.ts`; expected: FAIL because the operation and prompt are absent.

- [ ] **Step 3: Implement the Review prompt and output**

Add `REVIEW_GENERATE_ANALYSIS` to `AIOperation`; register prompt key `review.analysis.v1` with required variables `platformId`, `publishedAt`, `metrics`, and `history`; return deterministic Fake output containing `summary`, `highlights`, `risks`, and bounded recommendations. Keep output validation in Review Worker before report persistence.

- [ ] **Step 4: Run tests and verify GREEN**

Run the focused AI commands; expected: all prompt, provider and provenance assertions pass.

- [ ] **Step 5: Commit**

```bash
git add packages/modules/ai/src/ai-service.ts packages/modules/ai/src/prompt-registry.ts packages/modules/ai/src/fake-provider.ts tests/unit/review-ai.test.ts tests/integration/ai-run.test.ts
git commit -m "feat: add review analysis ai contract"
```

## Task 7: Add Review analysis worker path

**Files:**

- Modify: `workers/review-worker/src/handler.ts`
- Modify: `workers/review-worker/src/main.ts`
- Test: `tests/worker/review-worker.test.ts`

- [ ] **Step 1: Write failing analysis-worker tests**

Cover successful analysis from one or more same-post snapshots, rejection of mixed-post snapshots, AI schema failure with no report row, provider failure retry classification, and report append-only history.

- [ ] **Step 2: Run tests and verify RED**

Run `pnpm exec tsx --test tests/worker/review-worker.test.ts`; expected: analysis cases fail because the handler only supports collection.

- [ ] **Step 3: Implement analysis execution**

Load the snapshot records through `ReviewAnalyticsService`, build bounded AI variables from persisted numeric values, call `AIService.generateStructured` with `REVIEW_GENERATE_ANALYSIS`, validate the structured output into `ReviewAnalysisReportV1`, persist it with `aiRunId`, and return only safe IDs/status in the Job result.

- [ ] **Step 4: Run worker tests and typecheck**

Expected: collection and analysis worker tests pass and `pnpm typecheck` remains green.

- [ ] **Step 5: Commit**

```bash
git add workers/review-worker/src/handler.ts workers/review-worker/src/main.ts tests/worker/review-worker.test.ts
git commit -m "feat: add review analysis worker"
```

## Task 8: Add analytics API routes and runtime composition

**Files:**

- Create: `apps/api/src/review-analytics-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `workers/review-worker/src/dev-main.ts`
- Test: `tests/integration/review-analytics-api.test.ts`

- [ ] **Step 1: Write failing API tests**

Test overview, snapshot history, collect and analyze Job creation, report history, `404` for unknown/cross-project posts, `422` for empty snapshot IDs, and safe error envelopes. Assert handlers never call metrics or AI synchronously.

- [ ] **Step 2: Run API tests and verify RED**

Run `pnpm exec tsx --test tests/integration/review-analytics-api.test.ts`; expected: route-not-found failures.

- [ ] **Step 3: Implement routes and composition**

Register the five routes from the design document. Parse project/post IDs and JSON bodies with Zod, call `ReviewAnalyticsService`, return `201` with safe Job records for writes, and map ownership/conflict/validation errors to `404/409/422`. Compose Publisher’s public reader, Review service, Job service and Fake source in `buildApi`/Review Worker dev entrypoints.

- [ ] **Step 4: Run API tests and verify GREEN**

Run focused API tests and `pnpm typecheck`; expected: all route and composition assertions pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/review-analytics-routes.ts apps/api/src/app.ts workers/review-worker/src/dev-main.ts tests/integration/review-analytics-api.test.ts
git commit -m "feat: expose review analytics api"
```

## Task 9: Add Review Analytics Operator UI and browser acceptance

**Files:**

- Create: `apps/web/app/projects/[id]/review/page.tsx`
- Modify: `apps/web/app/projects/[id]/layout.tsx` or shared project navigation component
- Test: `tests/e2e/review-analytics-browser.test.ts`
- Modify: `scripts/test-operator-browser.ts` to start the Review Worker in the isolated composition

- [ ] **Step 1: Write the failing browser journey**

Extend the isolated browser setup to create a Fake Publisher ExternalPost, navigate to Review Analytics, click collect, wait for a snapshot, click analyze, wait for a report, and assert metrics/recommendations render. Also assert a second collect with the same idempotency key does not duplicate the snapshot.

- [ ] **Step 2: Run the browser test and verify RED**

Run `pnpm test:browser`; expected: the Review route and visible controls are missing.

- [ ] **Step 3: Implement the page and navigation**

Render a project-scoped list of confirmed ExternalPosts, snapshot history, latest report and Job status. Buttons only POST to analytics routes and poll Job state; no platform calls, AI calls or secrets run in the browser. Keep Approval Gate navigation labeled separately.

- [ ] **Step 4: Run browser acceptance and verify GREEN**

Run the isolated browser harness with PostgreSQL schema isolation and FFmpeg environment. Expected: the new Review journey and existing Publisher/Video/Quick Edit journeys pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/projects/[id]/review apps/web/app/projects/[id]/layout.tsx tests/e2e/review-analytics-browser.test.ts scripts/test-operator-browser.ts
git commit -m "feat: add review analytics workspace"
```

## Task 10: Documentation, ADR status and final verification

**Files:**

- Modify: `packages/modules/review/README.md`
- Create or modify: `docs/contracts/METRIC_SNAPSHOT_CONTRACT_V1.md`
- Create or modify: `docs/adr/ADR-014-review-analytics.md`
- Create: `docs/engineering/REVIEW_ANALYTICS_V1_REPORT.md`
- Modify: `docs/adr/ADR_STATUS_INDEX.md`
- Modify: `README.md` and `docs/governance/01_PROJECT_CONTEXT.md`
- Modify: `task_plan.md`, `findings.md`, `progress.md`

- [ ] **Step 1: Synchronize documentation**

Document the new contracts, public-port dependency, Fake/Import-only rollout gate, Job types, error classifications and the fact that real platform metrics remain disabled.

- [ ] **Step 2: Run the complete verification gate**

Run, with the isolated PostgreSQL test URL and known-good FFmpeg paths:

```bash
pnpm format:check
pnpm lint
pnpm security:scan
pnpm typecheck
pnpm test:migrations
pnpm test
pnpm --dir apps/web build
pnpm test:browser
git diff --check
```

Expected: zero failures; browser output must include the Review journey and existing acceptance journeys.

- [ ] **Step 3: Review the diff for boundary and secret safety**

Confirm Review has no imports of Publisher private persistence, no synchronous AI/metrics execution in routes, no credentials or storage keys in Job payloads/logs, and no real adapter enablement.

- [ ] **Step 4: Commit the final report and push**

```bash
git add packages/modules/review/README.md docs/contracts/METRIC_SNAPSHOT_CONTRACT_V1.md docs/adr/ADR-014-review-analytics.md docs/engineering/REVIEW_ANALYTICS_V1_REPORT.md docs/adr/ADR_STATUS_INDEX.md README.md docs/governance/01_PROJECT_CONTEXT.md task_plan.md findings.md progress.md
git commit -m "docs: close review analytics v1"
git push origin codex/review-analytics-v1
```

- [ ] **Step 5: Human review gate**

Report exact commit, test counts, migration count, browser scenarios and the explicit status `Fake/Import implemented; real platform metrics not live-verified`. Do not merge into `main` without user approval.
