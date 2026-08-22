# Real Platform Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-shaped Douyin and WeChat Channels adapters behind the existing Publisher Worker without storing credentials, using private endpoints, or bypassing human verification.

**Architecture:** Douyin uses an injected HTTP transport for the official upload/create/reconcile OpenAPI flow. WeChat Channels uses a Publisher Worker-owned persistent Playwright profile and an adapter-owned page workflow against the Channels Assistant UI. Both adapters implement the existing normalized `PublisherAdapter` contract and are selected through an explicit platform registry.

**Tech Stack:** TypeScript, Node test runner, Playwright, native `fetch`, existing Publisher Worker/WorkerRuntime, Zod-compatible contract validation and redacted structured errors.

---

## Task 1: Extend the Publisher contract and credential boundary

**Files:**
- Modify: `packages/contracts/src/publisher.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Create: `packages/modules/publisher/src/credential-provider.ts`
- Test: `tests/contract/publisher-real-platform.test.ts`

- [x] **Step 1: Write failing contract tests** for `PublisherCredential`, optional `mediaPath`/`coverPath`, platform IDs (`douyin`, `wechat-channels`), and the rule that serialized `PublishResult` never contains credential fields.

  Use snapshots shaped like:

  ```ts
  const snapshot: PublishSnapshot = {
    requestId: 'request-1',
    idempotencyKey: 'publish:project:revision',
    assetId: 'asset-1',
    mediaPath: 'E:/contentos/objects/asset-1.mp4',
    title: '测试标题',
    description: '#测试',
  };
  ```

- [x] **Step 2: Run the contract test and verify it fails** because the new types do not exist.

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/publisher-real-platform.test.ts`

- [x] **Step 3: Implement the minimal contract changes.** Add:

  ```ts
  export type PublisherPlatformId = 'fake-platform' | 'douyin' | 'wechat-channels';
  export interface PublisherCredential {
    accessToken?: string;
    refreshToken?: string;
    clientKey?: string;
    clientSecret?: string;
    openId?: string;
  }

  export interface CredentialProvider {
    resolve(credentialRef: string): Promise<PublisherCredential>;
  }
  ```

  Add optional `credential` to `PublisherContext`, optional `mediaPath` and `coverPath` to `PublishSnapshot`, and export `PublisherCredential`, `PublisherPlatformId` and `CredentialProvider` from the contracts/module indexes. `CredentialProvider.resolve(ref)` returns an in-memory credential object and never appears in adapter results.

- [x] **Step 4: Run the contract test and all existing publisher tests.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/publisher-real-platform.test.ts tests/contract/publisher.test.ts tests/integration/fake-publisher.test.ts`

- [x] **Step 5: Commit the boundary.**

  ```powershell
  git add packages/contracts/src/publisher.ts packages/contracts/src/index.ts packages/modules/publisher/src/index.ts packages/modules/publisher/src/credential-provider.ts tests/contract/publisher-real-platform.test.ts
  git commit -m "feat: extend publisher credential and media boundary"
  ```

## Task 2: Build the Douyin OpenAPI adapter

**Files:**
- Create: `packages/modules/publisher/src/douyin-open-api-adapter.ts`
- Create: `packages/modules/publisher/src/douyin-http.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Test: `tests/contract/douyin-open-api-adapter.test.ts`
- Test: `tests/integration/douyin-open-api-adapter.test.ts`

- [x] **Step 1: Write failing HTTP adapter tests** using an injected `fetch` function. Cover:
  - upload request sends the access token, multipart media and no client secret in logs/results;
  - create request uses the returned encrypted `video_id`, `open_id`, title and description;
  - OAuth/expired-token errors map to `AUTH_EXPIRED`/`HUMAN_ACTION_REQUIRED`;
  - rate-limit and network errors map to `RATE_LIMIT`/`RETRYABLE`;
  - a transport failure after create returns `UNKNOWN_EXTERNAL_STATE` and calls reconcile before allowing a retry;
  - duplicate idempotency keys return the first external item ID without a second create call.

- [x] **Step 2: Run the focused tests and confirm red failure** because `DouyinOpenApiAdapter` and its transport do not exist.

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/douyin-open-api-adapter.test.ts tests/integration/douyin-open-api-adapter.test.ts`

- [x] **Step 3: Implement `DouyinHttpTransport` and `DouyinOpenApiAdapter`.** Keep endpoint paths in a `DouyinEndpointProfile` with defaults for the documented upload, create and list/data operations. Require `accessToken`, `openId` and `mediaPath`; use `FormData`/`Blob` for upload and JSON for create. Parse both HTTP errors and Douyin `data.error_code`/`extra.error_code`, then return only normalized `PublishResult`/`ExternalStateResult` values.

  The adapter shape is:

  ```ts
  export interface DouyinHttpTransport {
    request(input: { method: string; url: string; headers?: Record<string, string>; body?: BodyInit }): Promise<Response>;
  }

  export class DouyinOpenApiAdapter implements PublisherAdapter {
    capabilities(): PlatformCapabilityProfile;
    authenticate(context: PublisherContext): Promise<AuthResult>;
    publish(context: PublisherContext, snapshot: PublishSnapshot): Promise<PublishResult>;
    reconcile(context: PublisherContext, idempotencyKey: string): Promise<ExternalStateResult>;
  }
  ```

  Store idempotency only in the adapter's injected `PublishStateStore` port; do not claim process-memory idempotency is durable.

- [x] **Step 4: Run focused tests, existing Fake Publisher tests and typecheck.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/douyin-open-api-adapter.test.ts tests/integration/douyin-open-api-adapter.test.ts tests/contract/publisher.test.ts tests/integration/fake-publisher.test.ts`; then `pnpm run typecheck`.

- [x] **Step 5: Commit the Douyin adapter.**

  ```powershell
  git add packages/modules/publisher/src/douyin-open-api-adapter.ts packages/modules/publisher/src/douyin-http.ts packages/modules/publisher/src/index.ts tests/contract/douyin-open-api-adapter.test.ts tests/integration/douyin-open-api-adapter.test.ts
  git commit -m "feat: add douyin official openapi adapter"
  ```

## Task 3: Add the Publisher Worker browser session port

**Files:**
- Create: `packages/modules/publisher/src/browser-session.ts`
- Create: `packages/infrastructure/playwright/src/index.ts`
- Modify: `packages/infrastructure/playwright/README.md`
- Modify: `package.json`
- Test: `tests/contract/browser-session.test.ts`

- [x] **Step 1: Write failing browser-port tests** for persistent profile paths, headed/manual-login policy, page navigation, upload file, screenshot evidence and guaranteed close on failure.

- [x] **Step 2: Run the test and verify red** because the browser session port and implementation are absent.

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/browser-session.test.ts`

- [x] **Step 3: Add the Playwright dependency and port.** Run `pnpm add playwright`, then define a small `BrowserSession`/`BrowserSessionFactory` interface in the publisher module. Add the infrastructure implementation using `chromium.launchPersistentContext` with an explicit per-account profile directory, configurable headed mode and no anti-detection patches. The implementation must close context/browser in `finally` blocks and expose only page operations needed by the adapter.

- [x] **Step 4: Run browser-port tests without launching a real browser** by injecting a fake session, then run `pnpm run typecheck` and `pnpm run lint`.

- [x] **Step 5: Commit the browser boundary.**

  ```powershell
  git add package.json pnpm-lock.yaml packages/modules/publisher/src/browser-session.ts packages/infrastructure/playwright/src/index.ts packages/infrastructure/playwright/README.md tests/contract/browser-session.test.ts
  git commit -m "feat: add isolated publisher browser session port"
  ```

## Task 4: Build the WeChat Channels Playwright adapter

**Files:**
- Create: `packages/modules/publisher/src/wechat-channels-playwright-adapter.ts`
- Create: `packages/modules/publisher/src/wechat-channels-selectors.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Test: `tests/contract/wechat-channels-adapter.test.ts`
- Test: `tests/integration/wechat-channels-adapter.test.ts`

- [x] **Step 1: Write failing adapter tests** with a fake `BrowserSession`. Cover:
  - capabilities advertise `wechat-channels`, MP4 support and human confirmation;
  - login page maps to `AUTH_EXPIRED`;
  - verification/captcha page maps to `REQUIRES_VERIFICATION`;
  - upload, description, optional cover and pre-submit approval gate are ordered correctly;
  - selector mismatch maps to `PLATFORM_CHANGED` and emits only a redacted screenshot reference;
  - uncertain submit result maps to `UNKNOWN_EXTERNAL_STATE`;
  - two account IDs use two separate profile directories.

- [x] **Step 2: Run the focused tests and verify red.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/wechat-channels-adapter.test.ts tests/integration/wechat-channels-adapter.test.ts`

- [x] **Step 3: Implement the adapter and versioned selector profile.** Keep all selectors in `wechat-channels-selectors.ts`; use semantic selectors first, then narrow fallbacks. Require `mediaPath`, refuse to submit without an approved review flag and configured human-confirmation policy, and never read or write raw cookies. Use `BrowserSession.screenshot` only to a redacted evidence directory.

- [x] **Step 4: Run focused tests, Fake Publisher tests and typecheck.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/contract/wechat-channels-adapter.test.ts tests/integration/wechat-channels-adapter.test.ts tests/contract/publisher.test.ts tests/integration/fake-publisher.test.ts`; then `pnpm run typecheck`.

- [x] **Step 5: Commit the WeChat Channels adapter.**

  ```powershell
  git add packages/modules/publisher/src/wechat-channels-playwright-adapter.ts packages/modules/publisher/src/wechat-channels-selectors.ts packages/modules/publisher/src/index.ts tests/contract/wechat-channels-adapter.test.ts tests/integration/wechat-channels-adapter.test.ts
  git commit -m "feat: add wechat channels browser adapter"
  ```

## Task 5: Register platforms and gate Worker dispatch

**Files:**
- Create: `packages/modules/publisher/src/publisher-registry.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Modify: `workers/publisher-worker/src/main.ts`
- Modify: `packages/shared/src/worker-runtime.ts` only if handler context is required
- Test: `tests/worker/real-publisher-worker.test.ts`

- [x] **Step 1: Write failing Worker tests** for explicit `douyin`/`wechat-channels` dispatch, unsupported platform rejection, a required `reviewDecisionId` verified by an injected `ReviewApprovalProvider`, normalized result propagation and graceful shutdown. Keep the test adapters fake and never launch a browser.

- [x] **Step 2: Run the Worker test and verify red.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/worker/real-publisher-worker.test.ts`

- [x] **Step 3: Implement `PublisherAdapterRegistry` and composition-root wiring.** Registry registration must be explicit and reject duplicate platform IDs. The worker handler resolves `{ platformId, accountId, snapshot, projectId, targetId, reviewDecisionId }`, verifies that `ReviewApprovalProvider` reports an approved `PUBLISH` decision for that project/target/revision, resolves `credentialRef` through `CredentialProvider`, creates the isolated profile path, and dispatches to the selected adapter. Results and errors pass through the existing redaction boundary; a boolean supplied in the Job payload is never trusted as approval.

  Define the approval port next to the registry so the worker has no direct Review-table dependency:

  ```ts
  export interface ReviewApprovalProvider {
    isApproved(input: { projectId: string; targetType: 'PUBLISH'; targetId: string; reviewDecisionId: string }): Promise<boolean>;
  }
  ```

- [x] **Step 4: Run Worker tests, all existing Worker tests and typecheck.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/worker/real-publisher-worker.test.ts tests/worker/fake-publisher-worker.test.ts tests/unit/worker-bootstrap.test.ts`; then `pnpm run typecheck`.

- [x] **Step 5: Commit Worker registration.**

  ```powershell
  git add packages/modules/publisher/src/publisher-registry.ts packages/modules/publisher/src/index.ts workers/publisher-worker/src/main.ts packages/shared/src/worker-runtime.ts tests/worker/real-publisher-worker.test.ts
  git commit -m "feat: register real publisher adapters in worker"
  ```

## Task 6: Add opt-in smoke commands and documentation

**Files:**
- Create: `scripts/publisher-smoke.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `packages/modules/publisher/README.md`
- Modify: `docs/development/LOCAL_SETUP.md`
- Test: `tests/unit/publisher-smoke-config.test.ts`

- [x] **Step 1: Write failing smoke-config tests** proving that the command refuses to run without `CONTENTOS_REAL_PLATFORM_SMOKE=1`, refuses missing platform-specific credential refs, and never prints credential values.

- [x] **Step 2: Run the test and verify red.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/unit/publisher-smoke-config.test.ts`

- [x] **Step 3: Implement a guarded smoke command.** Accept exactly one platform (`douyin` or `wechat-channels`), require explicit account/profile/media arguments, require the opt-in environment flag, print only redacted request IDs and normalized outcomes, and stop before submission when human confirmation is not explicitly enabled. Do not make the normal `pnpm test` command call this script.

- [x] **Step 4: Document setup and risk boundaries.** Document Douyin app authorization requirements, WeChat manual login/profile setup, headed-browser requirement, verification handling, smoke-test invocation and cleanup. State that GitHub repositories were reference-only and no code/cookies were copied.

- [x] **Step 5: Run smoke-config tests and update the serial test command.**

  Run: `pnpm exec tsx --test --test-concurrency=1 tests/unit/publisher-smoke-config.test.ts`; add all new contract/integration/Worker tests to the root `package.json` test script.

## Task 7: Final verification, documentation status and push

**Files:**
- Modify: `docs/engineering/NEXT_VERTICAL_SLICES.md`
- Modify: `task_plan.md`
- Modify: `progress.md`
- Modify: `docs/superpowers/specs/2026-08-22-slice-5-real-platform-adapters-design.md` only if implementation decisions changed

- [ ] **Step 1: Run the complete verification gate.**

  ```powershell
  pnpm run format
  pnpm run lint
  pnpm run typecheck
  $env:DATABASE_URL='postgresql://contentos_dev@127.0.0.1:55432/contentos_dev'
  pnpm test
  pnpm run build
  pnpm run doctor
  git diff --check
  ```

  Expected: all checks pass, normal tests use only fakes and injected transports, and no credential-like values appear in output.

- [ ] **Step 2: Update status documents** to mark Slice 5 implementation complete only for adapter code and simulated tests; record that live platform smoke tests remain account-dependent and list any confirmed platform limitations.

- [ ] **Step 3: Review the final diff for secret and dependency leakage.** Confirm no `.env`, cookies, browser profiles, screenshot contents, private endpoint paths or external repository code were staged.

- [ ] **Step 4: Commit and push the feature branch, then open a draft PR if requested.**

  ```powershell
  git add -- <only-reviewed-files>
  git commit -m "feat: add douyin and wechat channels publisher adapters"
  git push -u origin feature/slice-5-real-platform-adapters
  ```

## Scope guard

This plan does not add scheduling, analytics, comments, metrics, generic workflow graphs, platform reverse-engineering, CAPTCHA bypass, credential persistence or automatic live publishing without a human approval gate.
