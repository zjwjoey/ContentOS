# ContentOS Integration Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reviewable `integration/contentos-v1` branch that converges the accepted Project Center line, `main`, migration `0006`, and the Douyin/WeChat Channels adapter implementation without enabling live publishing or merging to `main`.

**Architecture:** Treat `codex/project-center@d257229` as the accepted business baseline because it already contains Director V1, Publisher Foundation, Publisher-to-Project integration, Project Center, and the final Job/Video reliability repairs. Merge only the unique `main@752e8c4` history, then adapt the real-platform code from `feature/slice-5-real-platform-adapters@39fc4cc` into the current Publisher contracts and Worker instead of merging the historical branch wholesale. PostgreSQL remains the business truth; real adapters are registered only behind an explicit disabled-by-default composition flag.

**Tech Stack:** Node.js 22 LTS, TypeScript 5.8, pnpm 10, PostgreSQL 16, Fastify 5, Zod 4, Playwright 1.62, Node test runner.

---

## Fixed inputs and non-goals

- Accepted business baseline: `d257229` on `codex/project-center`.
- Main convergence commit: `752e8c4` on `main`.
- Real-adapter evidence commit: `39fc4cc` on `feature/slice-5-real-platform-adapters`.
- Output branch: `integration/contentos-v1`.
- Output worktree: `E:\ContentOS\.worktrees\integration-contentos-v1`.
- End point: push `integration/contentos-v1`, publish an acceptance report, and stop for user review.
- Explicitly excluded: merge to `main`, real account login, credential acquisition, platform submission, Live Smoke, real AI, analytics, and Stage 2 Web work.

## Task 1: Create the dedicated integration worktree and freeze the baseline

**Files:**

- Verify: `docs/superpowers/specs/2026-08-29-contentos-integration-and-unified-flow-design.md`
- Verify: `docs/governance/04_BRANCH_INTEGRATION_STRATEGY.md`
- Modify: `progress.md`

- [ ] From `E:\ContentOS\.worktrees\project-center`, verify the accepted code is present:

  ```powershell
  git merge-base --is-ancestor d257229 codex/project-center
  git status --short --branch
  ```

  Expected: the ancestry command exits `0`; the planning worktree has no uncommitted files.

- [ ] Verify that the target branch and worktree do not already exist:

  ```powershell
  git branch --list integration/contentos-v1
  git worktree list --porcelain
  ```

  Expected: neither output contains an existing `integration/contentos-v1` checkout.

- [ ] Create the branch from the current accepted Project Center planning head:

  ```powershell
  git worktree add E:\ContentOS\.worktrees\integration-contentos-v1 -b integration/contentos-v1 codex/project-center
  ```

  Expected: Git reports a new worktree on `integration/contentos-v1`.

- [ ] In the new worktree, record the immutable input SHAs and run the baseline gates:

  ```powershell
  git rev-parse HEAD main feature/slice-5-real-platform-adapters
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  ```

  Expected: the first SHA contains `d257229` in its ancestry; typecheck passes; the existing 180-test baseline passes against the isolated test database.

- [ ] Append the exact SHAs, database name, and gate result to `progress.md`, then commit only that evidence:

  ```powershell
  git add progress.md
  git commit -m "docs: record integration baseline"
  ```

## Task 2: Converge the unique `main` history

**Files:**

- Modify: `.gitignore`
- Test: repository worktree placement

- [ ] Confirm that `752e8c4` is the only `main`-only change that must converge:

  ```powershell
  git log --oneline integration/contentos-v1..main
  git diff --stat integration/contentos-v1...main
  ```

  Expected: the log identifies `752e8c4 chore: ignore local worktrees`; no business source appears as an unmerged main-only change.

- [ ] Merge `main` with an explicit merge commit:

  ```powershell
  git merge --no-ff main -m "merge: converge main into ContentOS integration"
  ```

  Expected: `.gitignore` contains the local worktree exclusion and no runtime source conflict is introduced.

- [ ] Verify both histories are ancestors and the worktree root remains ignored:

  ```powershell
  git merge-base --is-ancestor 752e8c4 HEAD
  git merge-base --is-ancestor d257229 HEAD
  git check-ignore -v .worktrees
  git diff --check HEAD^ HEAD
  ```

  Expected: both ancestry checks exit `0`; `.worktrees` is ignored; diff check is clean.

## Task 3: Restore migration `0006` and prove the linear migration chain

**Files:**

- Create: `migrations/0006_publisher_state.sql`
- Create: `migrations/0006_publisher_state.down.sql`
- Create: `tests/integration/migration-matrix.test.ts`
- Modify: `tests/integration/database.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] Add a failing migration inventory test asserting that up/down pairs are exactly `0001` through `0011`, including `0006`:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/database.test.ts
  ```

  Expected RED: the test reports the missing `0006_publisher_state` pair.

- [ ] Recreate the `0006` up/down files with `apply_patch`, using `39fc4cc:migrations/0006_publisher_state.sql` and its down file as the reviewed source. Preserve the table name `publisher_publication_states`, its composite primary key, status constraint, and partial unknown-state index.

- [ ] Add `tests/integration/migration-matrix.test.ts` that uses `CONTENTOS_TEST_ADMIN_DATABASE_URL` to create UUID-suffixed temporary databases and proves these three paths:

  1. clean database → `0001` through `0011`;
  2. pre-applied `0001` through `0005` → `0006` through `0011`;
  3. pre-applied `0001` through `0006` → `0007` through `0011`.

  The test must drop only the database names it created in its own `finally` block.

- [ ] Add a `test:migrations` script and a documented local-only admin URL example:

  ```json
  "test:migrations": "tsx --test --test-concurrency=1 tests/integration/migration-matrix.test.ts"
  ```

  `.env.example` must contain a placeholder URL only; it must not contain a real password.

- [ ] Run the migration gates:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/database.test.ts
  pnpm test:migrations
  ```

  Expected GREEN: inventory, clean install, both upgrade paths, and down/up safety pass.

- [ ] Commit the migration unit:

  ```powershell
  git add migrations tests/integration/database.test.ts tests/integration/migration-matrix.test.ts package.json .env.example
  git commit -m "test: restore and verify publisher migration 0006"
  ```

## Task 4: Extend the Publisher contract without weakening exact-Revision approval

**Files:**

- Modify: `packages/contracts/src/publisher.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `tests/contract/publisher.test.ts`
- Create: `tests/contract/publisher-real-platform.test.ts`
- Create: `tests/contract/browser-session.test.ts`

- [ ] Write contract tests for `PublisherPlatformId`, in-memory-only `PublisherCredential`, optional immutable media fields on `PublishSnapshot`, `PublisherContext.accountId`, and deterministic snapshot digest generation.

- [ ] Run the tests and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/contract/publisher.test.ts tests/contract/publisher-real-platform.test.ts tests/contract/browser-session.test.ts
  ```

  Expected RED: the current contract has no typed real platform IDs, credential object, media checksum, or digest helper.

- [ ] Extend the contract compatibly:

  - `PublisherPlatformId = 'fake-platform' | 'douyin' | 'wechat-channels'`;
  - `PublisherCredential` exists only in process memory and never in Job payloads;
  - `PublishSnapshot` adds optional `assetSha256`, `mediaPath`, `coverPath`, and `coverSha256`;
  - `PublisherContext` adds `accountId` and optional `credential`;
  - `createPublishSnapshotDigest` hashes only immutable reviewed fields and identifiers.

- [ ] Keep `PublisherRequestRevision.assetChecksum` and `ApprovalDecision.targetRevisionId` as the authoritative approval binding. Do not introduce the historical Review-based handler or rename Approval to Review.

- [ ] Run focused contract tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/contract/publisher.test.ts tests/contract/publisher-real-platform.test.ts tests/contract/browser-session.test.ts
  pnpm typecheck
  ```

  Expected GREEN: existing Fake Publisher contracts remain source-compatible and real-platform fields validate.

- [ ] Commit:

  ```powershell
  git add packages/contracts tests/contract
  git commit -m "feat: extend publisher adapter contract for real platforms"
  ```

## Task 5: Import the browser and credential boundaries

**Files:**

- Create: `packages/modules/publisher/src/browser-session.ts`
- Create: `packages/modules/publisher/src/credential-provider.ts`
- Create: `packages/infrastructure/playwright/src/index.ts`
- Modify: `packages/infrastructure/playwright/README.md`
- Modify: `packages/modules/publisher/src/index.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/unit/publisher-safety.test.ts`

- [ ] Add RED tests proving profile paths reject unsafe account IDs, credentials resolve by reference without entering serialized payloads/errors, browser sessions close on success and failure, and logs/safe summaries contain no token values.

- [ ] Run the focused test:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/unit/publisher-safety.test.ts tests/contract/browser-session.test.ts
  ```

  Expected RED: the boundaries do not yet exist.

- [ ] Adapt the reviewed implementations from `39fc4cc` with these current-line corrections:

  - do not expose environment values in errors;
  - accept only `env://NAME` credential references;
  - isolate browser profiles under `<profileRoot>/<platformId>/<profileKey>`;
  - validate each path segment before joining;
  - always close a browser session in `finally`;
  - keep browser session state, cookies, tokens, and authorization headers out of Job payloads and ordinary logs.

- [ ] Add `playwright@1.62.1` to the root lockfile without installing browser binaries during the default test gate:

  ```powershell
  pnpm add playwright@1.62.1 -w
  ```

- [ ] Run safety tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/unit/publisher-safety.test.ts tests/contract/browser-session.test.ts
  pnpm typecheck
  ```

  Expected GREEN: all lifetime, path, and credential-redaction assertions pass.

- [ ] Commit:

  ```powershell
  git add package.json pnpm-lock.yaml packages/infrastructure/playwright packages/modules/publisher tests/unit/publisher-safety.test.ts tests/contract/browser-session.test.ts
  git commit -m "feat: add isolated publisher browser and credential boundaries"
  ```

## Task 6: Adapt durable state and real platform adapters

**Files:**

- Create: `packages/modules/publisher/src/publish-state-store.ts`
- Create: `packages/modules/publisher/src/douyin-http.ts`
- Create: `packages/modules/publisher/src/douyin-open-api-adapter.ts`
- Create: `packages/modules/publisher/src/wechat-channels-selectors.ts`
- Create: `packages/modules/publisher/src/wechat-channels-playwright-adapter.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Create: `tests/contract/douyin-open-api-adapter.test.ts`
- Create: `tests/contract/wechat-channels-adapter.test.ts`
- Create: `tests/integration/douyin-open-api-adapter.test.ts`
- Create: `tests/integration/wechat-channels-adapter.test.ts`
- Create: `tests/integration/publisher-state.test.ts`

- [ ] Port the adapter tests from `39fc4cc`, create `tests/integration/publisher-state.test.ts`, then add RED cases for current invariants: `markUnknown` never downgrades `PUBLISHED`, repeated `markPublished` is idempotent, exact SHA-256 media binding, known published key reuse, unknown state refusing a second publish, auth/verification human-action classification, and post-submit browser failure entering reconciliation.

- [ ] Run focused tests and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/publisher-state.test.ts tests/contract/douyin-open-api-adapter.test.ts tests/contract/wechat-channels-adapter.test.ts tests/integration/douyin-open-api-adapter.test.ts tests/integration/wechat-channels-adapter.test.ts
  ```

- [ ] Adapt the state store and both adapters from `39fc4cc`. Preserve all network/browser behavior inside Publisher Adapter implementations; no API route or Publisher application service may import Playwright or Douyin transport types.

- [ ] Ensure `PostgresPublishStateStore.markUnknown` cannot overwrite `PUBLISHED`, and both adapters return normalized failure classifications consumed by the current Publisher Worker state machine.

- [ ] Ensure the WeChat adapter defaults to `headed: true` and `allowSubmit: false`; selector drift writes only a hashed evidence reference into diagnostics, never a local profile path or browser state.

- [ ] Run focused tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/integration/publisher-state.test.ts tests/contract/douyin-open-api-adapter.test.ts tests/contract/wechat-channels-adapter.test.ts tests/integration/douyin-open-api-adapter.test.ts tests/integration/wechat-channels-adapter.test.ts
  pnpm typecheck
  ```

  Expected GREEN: no test calls a real platform endpoint or launches a real signed-in browser.

- [ ] Commit:

  ```powershell
  git add packages/modules/publisher tests/contract tests/integration
  git commit -m "feat: add durable Douyin and WeChat publisher adapters"
  ```

## Task 7: Reconcile Adapter Registry with the current Publisher Worker

**Files:**

- Create: `packages/modules/publisher/src/publisher-registry.ts`
- Modify: `packages/modules/publisher/src/fake-publisher.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `workers/publisher-worker/src/dev-main.ts`
- Modify: `packages/config/src/config.ts`
- Modify: `.env.example`
- Create: `tests/worker/real-publisher-worker.test.ts`
- Modify: `tests/worker/publisher-product-worker.test.ts`
- Modify: `tests/unit/config-logging.test.ts`

- [ ] Write RED Worker tests proving:

  - Fake Platform still completes the current `PublishRequest`/`PublishAttempt`/`ExternalPost` flow;
  - `douyin` and `wechat-channels` dispatch through the registry only when enabled;
  - disabled real adapters fail before credential resolution or external I/O;
  - the current immutable Revision checksum is revalidated against the READY Render Asset;
  - `UNKNOWN_EXTERNAL_STATE` creates one idempotent reconcile Job and never retries publish directly;
  - `AUTH_EXPIRED` and `REQUIRES_VERIFICATION` become human action, not automatic retry.

- [ ] Run the focused tests and confirm RED:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/worker/publisher-product-worker.test.ts tests/worker/real-publisher-worker.test.ts tests/unit/config-logging.test.ts
  ```

- [ ] Implement `PublisherAdapterRegistry` as a platform dispatch boundary, but keep the current Worker as the only owner of Request transitions, Attempt history, ExternalPost creation, retry policy, and reconcile Job creation. Do not import the historical handler composition design.

- [ ] Extend Worker composition with `LocalStorageProvider`, `CredentialProvider`, profile root, durable state store, and optional real adapters. Build `mediaPath` inside the Worker from the verified Asset `storageKey`; never place credentials or browser profile state into `PublisherPublishJobPayload`.

- [ ] Add configuration with these exact safe defaults:

  ```text
  PUBLISHER_REAL_ADAPTERS_ENABLED=false
  PUBLISHER_WECHAT_ALLOW_SUBMIT=false
  PUBLISHER_WECHAT_HEADED=true
  PUBLISHER_PROFILE_ROOT=./storage/publisher-profiles
  PUBLISHER_EVIDENCE_ROOT=./artifacts/publisher
  ```

  `loadConfig` must reject `PUBLISHER_WECHAT_ALLOW_SUBMIT=true` when real adapters are disabled.

- [ ] Run focused Worker tests and typecheck:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/worker/publisher-product-worker.test.ts tests/worker/real-publisher-worker.test.ts tests/unit/config-logging.test.ts
  pnpm typecheck
  ```

  Expected GREEN: Fake remains the default; real dispatch is composition-tested with fakes only.

- [ ] Commit:

  ```powershell
  git add .env.example packages/config packages/modules/publisher workers/publisher-worker tests/worker tests/unit/config-logging.test.ts
  git commit -m "feat: compose real adapters behind disabled publisher registry"
  ```

## Task 8: Add the integrated public-contract vertical slice

**Files:**

- Create: `tests/e2e/contentos-integration-vertical-slice.test.ts`
- Modify: `package.json`

- [ ] Write one RED E2E test using only public services/API contracts plus real Worker entry points for this exact path:

  ```text
  Content Project
  → Fake AI Brief/Script/Storyboard
  → accepted Script + approved Storyboard
  → VIDEO_RENDER Job + Video Worker
  → exact Render Approval
  → Fake Account + Publish Request Revision
  → exact Publish Revision Approval
  → PUBLISH Job + Publisher Worker
  → PublishAttempt + ExternalPost
  → Project Center reports PUBLISHED
  ```

- [ ] Add three failure scenarios to the same E2E file:

  - `NETWORK_ERROR` → `RETRY_WAIT` → success;
  - `AUTH_EXPIRED` → failed request with `NEEDS_HUMAN_ACTION` and no automatic retry;
  - unknown side effect → `RECONCILING` → reconcile confirms one ExternalPost.

- [ ] Ensure the test creates unique Project, storage root, Fake Account, and idempotency keys, and cleans only its own database rows and temporary files in `finally`.

- [ ] Run the new test and confirm RED before final composition fixes:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/contentos-integration-vertical-slice.test.ts
  ```

- [ ] Make only the smallest public-contract fixes necessary, add the E2E file to `pnpm test`, and rerun:

  ```powershell
  pnpm tsx --test --test-concurrency=1 tests/e2e/contentos-integration-vertical-slice.test.ts
  ```

  Expected GREEN: all four paths pass without direct cross-module private-table reads in production code.

- [ ] Commit:

  ```powershell
  git add tests/e2e/contentos-integration-vertical-slice.test.ts package.json
  git commit -m "test: prove integrated ContentOS fake vertical slice"
  ```

## Task 9: Synchronize architecture and operator documentation

**Files:**

- Modify: `docs/contracts/PUBLISHER_ADAPTER_CONTRACT_V0.md`
- Modify: `docs/adr/ADR-005-browser-publisher.md`
- Modify: `docs/modules/PUBLISHER_MODULE_V0.md`
- Modify: `docs/architecture/WORKER_ARCHITECTURE_V0.md`
- Modify: `docs/development/LOCAL_SETUP.md`
- Modify: `docs/governance/06_TESTING_AND_ACCEPTANCE.md`
- Create: `docs/superpowers/reports/2026-08-29-contentos-integration-closure.md`
- Modify: `findings.md`
- Modify: `progress.md`
- Modify: `task_plan.md`

- [ ] Document the distinction `IMPLEMENTED ≠ LIVE-VERIFIED`, the disabled defaults, credential reference rules, exact-Revision approval, reconciliation behavior, and the fact that Stage 1 does not authorize live platform calls.

- [ ] Record the reconciled migration chain `0001`–`0011`, input SHAs, integration commits, test database identifiers, and all focused/full gate results.

- [ ] In the report, list every retained real-adapter file and every historical branch file intentionally not merged, especially historical planning/progress records and the obsolete Review-based handler composition.

- [ ] Run documentation consistency checks:

  ```powershell
  rg -n "PUBLISHER_REAL_ADAPTERS_ENABLED=true|CONTENTOS_REAL_PLATFORM_SMOKE=1" docs .env.example
  rg -n "Approval Gate|RECONCILING|IMPLEMENTED.*LIVE-VERIFIED" docs/contracts docs/adr docs/modules docs/superpowers/reports
  git diff --check
  ```

  Expected: no document instructs default live enablement; current terms and states are present.

- [ ] Commit:

  ```powershell
  git add docs findings.md progress.md task_plan.md
  git commit -m "docs: report ContentOS integration closure"
  ```

## Task 10: Run the final Gate, review the diff, push, and stop

**Files:**

- Verify: all files changed on `integration/contentos-v1`
- Update: `docs/superpowers/reports/2026-08-29-contentos-integration-closure.md`

- [ ] Run the complete automated Gate from a clean isolated test database:

  ```powershell
  pnpm format
  pnpm lint
  pnpm typecheck
  pnpm build
  pnpm --dir apps/web build
  pnpm test:migrations
  pnpm test
  pnpm doctor
  git diff --check codex/project-center...HEAD
  ```

  Expected: every command exits `0`; no live platform smoke command is executed.

- [ ] Run a secret and architecture scan:

  ```powershell
  rg -n --hidden -g '!node_modules/**' -g '!pnpm-lock.yaml' "accessToken|refreshToken|clientSecret|authorization|cookie|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY" .
  rg -n "from .*modules/.*/src|publisher_publication_states|publisher_requests|approval_decisions" apps workers packages/modules
  ```

  Expected: matches are limited to contract field names, redaction tests, adapter-private code, and owning module SQL; no secret value or cross-module private-table access appears.

- [ ] Review the complete range:

  ```powershell
  git log --oneline --decorate codex/project-center..HEAD
  git diff --stat codex/project-center...HEAD
  git diff --check codex/project-center...HEAD
  git status --short --branch
  ```

  Expected: clean worktree; only Stage 1 scope is present.

- [ ] Add the final command outputs and exact pass counts to the report, then commit the evidence update:

  ```powershell
  git add docs/superpowers/reports/2026-08-29-contentos-integration-closure.md progress.md task_plan.md
  git commit -m "docs: finalize ContentOS integration evidence"
  ```

- [ ] Push the review branch:

  ```powershell
  git push -u origin integration/contentos-v1
  ```

  Expected: `origin/integration/contentos-v1` points at the verified head.

- [ ] Stop. Do not merge to `main`, do not delete the worktree, do not run Live Smoke, and do not begin the Unified Product Flow plan until the user accepts this branch.
