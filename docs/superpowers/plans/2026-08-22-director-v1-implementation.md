# ContentOS Director V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a versioned, auditable Director workflow that turns a ContentBrief into accepted Script and approved Storyboard revisions, runs through durable Director Jobs, and feeds the existing Video pipeline without bypassing module boundaries.

**Architecture:** Keep the modular monolith and existing `DIRECTOR_PLAN_V0` compatibility path. Add Director-owned Brief/Script/Storyboard revision records, an AI provider port with fake provider coverage, an explicit Application/Director Worker composition root, thin API routes, and a minimal Operator UI. PostgreSQL remains business truth; Job payloads contain only validated IDs and references.

**Tech Stack:** TypeScript, Node test runner, Fastify/Zod, PostgreSQL migrations, existing JobService/WorkerRuntime, existing FFmpeg Video Worker, React/Next.js for the new Web surface when the Web task begins.

---

## Scope and implementation order

The implementation is one vertical slice with independently testable tasks. No real platform call, automatic web research, TTS, semantic asset matching, analytics collector or multi-platform variant engine is included. A real Provider Sandbox is a separate gate and is reported `BLOCKED` if credentials/provider selection are not available; fake-provider and mock-transport paths must still pass.

The Publisher feature branch remains separate. This Director branch is based on `main`; Publisher changes are not cherry-picked into Director code. The eventual merge must retain migration ordering: Publisher state is `0006`, Director V1 migrations start at `0007`.

## File map

| Responsibility | Files |
|---|---|
| Stable Director/AI contracts | `packages/contracts/src/director-v1.ts`, `packages/contracts/src/ai-provider.ts`, `packages/contracts/src/index.ts` |
| Director persistence | `migrations/0007_director_v1.sql`, `migrations/0007_director_v1.down.sql`, `migrations/0008_ai_provenance.sql`, `migrations/0008_ai_provenance.down.sql` |
| Director application use cases | `packages/modules/director/src/director-v1-service.ts`, `packages/modules/director/src/index.ts` |
| AI provider boundary | `packages/modules/ai/src/ai-provider.ts`, `packages/modules/ai/src/ai-service.ts`, `packages/modules/ai/src/prompt-registry.ts`, `packages/modules/ai/src/fake-provider.ts`, `packages/modules/ai/src/index.ts` |
| Durable Director execution | `workers/director-worker/src/main.ts`, `workers/director-worker/src/handler.ts`, `workers/director-worker/package.json` |
| API surface | `apps/api/src/director-routes.ts`, `apps/api/src/app.ts`, `tests/integration/director-v1-api.test.ts` |
| Video provenance bridge | `packages/contracts/src/edit-manifest.ts`, `packages/modules/video/src/video-service.ts`, `packages/modules/video/src/director-video-service.ts`, `packages/modules/video/src/planner.ts` |
| Minimal Web operator surface | `apps/web/package.json`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/projects/[id]/director/page.tsx`, `apps/web/app/globals.css` |
| Evidence and reports | `tests/contract/director-v1.test.ts`, `tests/contract/ai-provider.test.ts`, `tests/integration/director-v1.test.ts`, `tests/worker/director-worker.test.ts`, `tests/e2e/director-video-vertical-slice.test.ts`, `docs/engineering/ENGINEERING_CHANGE_REQUESTS.md`, `docs/adr/ADR-011-application-worker.md`, `docs/engineering/DIRECTOR_VERTICAL_SLICE_REPORT.md`, `docs/product/DIRECTOR_QUALITY_BACKLOG.md` |

## Task 1: Freeze the worker/process and data evolution decisions

**Files:**
- Create: `docs/engineering/ENGINEERING_CHANGE_REQUESTS.md`
- Create: `docs/adr/ADR-011-application-worker.md`
- Modify: `docs/architecture/CONTENTOS_ARCHITECTURE_V0.md`, `docs/TECH_STACK_V0.md`, `docs/adr/ADR_STATUS_INDEX.md`
- Modify: `task_plan.md`, `findings.md`, `progress.md`

- [ ] **Step 1: Record the root cause found during the clean baseline.** Document that shared `contentos_dev` contained Publisher migration `0006`, while the Director worktree starts at `main`/`0005`; Director tests use isolated `contentos_director_dev` and do not reset the shared database.
- [ ] **Step 2: Write ADR-011.** State that `workers/director-worker` is an explicitly supervised Application Worker for Director AI Jobs only; it uses the existing `WorkerRuntime` and `JobService`, does not become a generic workflow engine, and does not import Video/Publisher private implementation.
- [ ] **Step 3: Update architecture status.** Record the new process as an accepted, bounded change with no change to the fixed `Director -> Video -> Publish -> Review` workflow or PostgreSQL/Job invariants.
- [ ] **Step 4: Run `git diff --check` and commit the architecture decision.** Commit message: `docs: record director worker architecture decision`.

## Task 2: Add Director V1 and AI contract tests first

**Files:**
- Create: `packages/contracts/src/director-v1.ts`
- Create: `packages/contracts/src/ai-provider.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `tests/contract/director-v1.test.ts`, `tests/contract/ai-provider.test.ts`

- [ ] **Step 1: Write failing Director contract tests.** Cover Chinese Brief input, bounded duration, `titleCandidates`, `coverText`, `topicKeywords`, Script origin/status, parent revision, Storyboard-to-Script binding, non-empty scenes, positive duration and duplicate scene rejection.
- [ ] **Step 2: Write failing AI contract tests.** Cover `supports`, `generateText`, `generateStructured`, `ProviderErrorCode`, `ModelProfile`, `PromptVersion`, bounded request fields and no credential fields in public results.
- [ ] **Step 3: Implement explicit types and validators.** Export `ContentBriefV1`, `ScriptRevisionV1`, `StoryboardRevisionV1`, `StoryboardSceneV1`, `AIProvider`, `AIRequest`, `AIResult`, `AIUsage`, `ModelProfile`, `PromptVersion` and deterministic validation functions. Do not import a vendor SDK.
- [ ] **Step 4: Run focused tests.** Run `pnpm exec tsx --test tests/contract/director-v1.test.ts tests/contract/ai-provider.test.ts`; expected result is all new contract tests passing.
- [ ] **Step 5: Commit.** Commit message: `feat: add director v1 and ai provider contracts`.

## Task 3: Add append-only Director and AI provenance migrations

**Files:**
- Create: `migrations/0007_director_v1.sql`, `migrations/0007_director_v1.down.sql`
- Create: `migrations/0008_ai_provenance.sql`, `migrations/0008_ai_provenance.down.sql`
- Modify: `tests/integration/database.test.ts`

- [ ] **Step 1: Add Director tables.** Create `director_briefs`, `director_scripts`, `director_script_revisions`, `director_storyboards`, `director_storyboard_revisions` and `director_project_state`. Enforce project ownership, positive revisions, immutable origin fields, unique `(aggregate_id, revision)`, unique non-null `source_job_id`, and Storyboard `script_revision_id` foreign keys.
- [ ] **Step 2: Add current-state row.** Use one Director-owned `director_project_state` row per project with active Brief, Script aggregate/revision and Storyboard aggregate/revision IDs plus counters. Service transactions lock this row before allocating a revision; no `max(revision)+1` allocation remains.
- [ ] **Step 3: Add AI tables.** Create `ai_prompt_versions`, `ai_model_profiles` and `ai_runs`; store bounded structured input/output snapshots, hashes, provider/model/profile IDs, job/attempt/correlation IDs, status, normalized error and usage. Do not store credential material or chain-of-thought.
- [ ] **Step 4: Test migration history.** Extend the database integration test to assert 0007/0008 up/down idempotency and table/constraint presence in a fresh `contentos_director_dev` database.
- [ ] **Step 5: Run migrations and focused integration tests.** Set `DATABASE_URL=postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev`; run `pnpm exec tsx --test tests/integration/database.test.ts` and require zero failures.
- [ ] **Step 6: Commit.** Commit message: `feat: add director v1 and ai provenance schema`.

## Task 4: Implement AI Provider infrastructure with a deterministic fake

**Files:**
- Create: `packages/modules/ai/src/ai-provider.ts`, `packages/modules/ai/src/ai-service.ts`, `packages/modules/ai/src/prompt-registry.ts`, `packages/modules/ai/src/fake-provider.ts`, `packages/modules/ai/src/index.ts`
- Create: `tests/unit/ai-service.test.ts`, `tests/integration/ai-run.test.ts`

- [ ] **Step 1: Write failing provider tests.** Test capability rejection, bounded input/output, normalized unavailable/rate-limit/auth/structured-output errors, deterministic Fake Provider Chinese output and structured Storyboard output.
- [ ] **Step 2: Implement `PromptRegistry`.** Register immutable `director.script.v1` and `director.storyboard.v1` versions with required variables, template hash and bounded rendering. Return only prompt key/version/hash and the rendered request to the provider boundary.
- [ ] **Step 3: Implement `AIService`.** Resolve a model profile, render a prompt, call the provider port, validate structured output, persist one `ai_runs` record per attempt and return a safe result. A repair attempt is another recorded AI Run; no default-field fabrication is allowed.
- [ ] **Step 4: Implement `FakeAIProvider`.** Return deterministic Chinese Script and Storyboard fixtures for tests; expose switches for network failure, rate limit, auth failure and invalid structure.
- [ ] **Step 5: Run unit/integration AI tests and commit.** Run `pnpm exec tsx --test tests/unit/ai-service.test.ts tests/integration/ai-run.test.ts`; commit as `feat: add provider-neutral ai service and prompts`.

## Task 5: Implement append-only Director application services

**Files:**
- Create: `packages/modules/director/src/director-v1-service.ts`
- Modify: `packages/modules/director/src/index.ts`
- Create: `tests/integration/director-v1.test.ts`

- [ ] **Step 1: Write failing service tests.** Cover create Brief, create Script aggregate/revision, AI draft persistence, manual revision parent linkage, accept Script, generate Storyboard only from an accepted Script, approve Storyboard, current pair selection and rejection of mismatched Script/Storyboard versions.
- [ ] **Step 2: Implement transaction-safe revision allocation.** Lock `director_project_state`, increment the correct counter, insert the immutable revision and commit state/pointer changes in one transaction. Unique constraints must make retries safe.
- [ ] **Step 3: Implement state transitions.** Accepting a new Script clears the active Storyboard pointer; approving a Storyboard requires an accepted source Script and sets the active pair. Historical rows remain unchanged.
- [ ] **Step 4: Implement manual revisions.** Manual edit creates a new revision with `origin=MANUAL`, `parent_revision_id`, actor and no AI Run; it never updates the old content row.
- [ ] **Step 5: Run Director integration tests and commit.** Commit as `feat: implement append-only director v1 services`.

## Task 6: Add Director Job creation and Application Worker handlers

**Files:**
- Modify: `packages/modules/job/src/job-service.ts` only for typed Director payload/result helpers if required
- Create: `packages/modules/director/src/director-job-service.ts`
- Create: `workers/director-worker/src/handler.ts`, `workers/director-worker/src/main.ts`, `workers/director-worker/package.json`
- Create: `tests/worker/director-worker.test.ts`

- [ ] **Step 1: Write failing Job/Worker tests.** Assert `DIRECTOR_GENERATE_SCRIPT` and `DIRECTOR_GENERATE_STORYBOARD` are the only Director types, payloads contain IDs/references, handlers call Fake AI, retry does not create duplicate revisions, and expired leases remain recoverable through JobService.
- [ ] **Step 2: Implement `DirectorJobService`.** Create idempotent Job records using keys `(project_id, job_type, brief/script revision)`, with `maxAttempts=3`; return `job_id` without running AI in the request path.
- [ ] **Step 3: Implement handlers.** Claim through JobRunner, load owned Director records, call AIService, validate output, persist revision and AI Run, then return only safe result IDs. Map Provider errors to retryable/permanent Job outcomes.
- [ ] **Step 4: Implement explicit worker composition.** Register only the two Director Job handlers in `WorkerRuntime('director-worker')`; require explicit DB/provider composition and fail closed when started without it.
- [ ] **Step 5: Run Worker tests and commit.** Commit as `feat: add durable director generation worker`.

## Task 7: Replace the Director API write path with thin V1 routes

**Files:**
- Create: `apps/api/src/director-routes.ts`
- Modify: `apps/api/src/app.ts`
- Create: `tests/integration/director-v1-api.test.ts`

- [ ] **Step 1: Write failing API tests.** Cover Brief creation, Script Job creation returning 202 and `job_id`, Script list/get, manual revision, Storyboard Job creation, Storyboard list/get/approve, Job status and validation/provider failure envelopes.
- [ ] **Step 2: Implement Zod request schemas.** Enforce Chinese-capable bounded strings, target platform key, duration range, required core thesis and no credential-shaped fields. Keep platform behavior out of Director routes.
- [ ] **Step 3: Implement route plugin.** Call Director/Job use cases only; do not issue SQL from route handlers. Return stable `DIRECTOR_*` error codes and preserve the old Director Plan routes as compatibility endpoints.
- [ ] **Step 4: Add `GET /api/v1/jobs/:id` only if the existing API has no equivalent.** Reuse JobService and return state/progress/result/error without secrets.
- [ ] **Step 5: Run API tests and commit.** Commit as `feat: expose director v1 api workflow`.

## Task 8: Connect approved Script/Storyboard provenance to Video

**Files:**
- Modify: `packages/contracts/src/edit-manifest.ts`
- Modify: `packages/modules/video/src/planner.ts`, `packages/modules/video/src/video-service.ts`, `packages/modules/video/src/director-video-service.ts`
- Create: `tests/contract/director-video-provenance.test.ts`, `tests/integration/director-video-v1.test.ts`

- [ ] **Step 1: Write failing provenance tests.** Assert a Video Job cannot be created from a draft/mismatched pair and that approved pair IDs survive Job payload, Manifest metadata, Render metadata and final E2E lookup.
- [ ] **Step 2: Extend `EDIT_MANIFEST_V0` compatibly.** Add optional `metadata` containing `briefId`, `scriptRevisionId` and `storyboardRevisionId`; old manifests remain valid and renderer behavior remains unchanged.
- [ ] **Step 3: Update Video bridge.** Resolve the Director current approved pair through the Director application port and pass only IDs/references into VideoService. Do not import Director private tables or call Video Worker handlers.
- [ ] **Step 4: Verify Planner/Renderer boundaries.** Planner may continue Random selection; Renderer must ignore creative metadata and only execute the validated manifest.
- [ ] **Step 5: Run focused video tests and commit.** Commit as `feat: preserve director provenance through video renders`.

## Task 9: Build the minimal Director Operator UI

**Files:**
- Modify: `apps/web/package.json`, root `package.json`, `tsconfig.json`
- Create: `apps/web/next.config.ts`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/projects/[id]/director/page.tsx`, `apps/web/app/globals.css`
- Create: `tests/e2e/director-web.test.ts` using the existing API test double strategy

- [ ] **Step 1: Add the minimal Next/React dependencies and TSX configuration.** Keep the Web app independent from domain modules; all mutations call versioned API endpoints.
- [ ] **Step 2: Build project list and Director page.** Show Brief fields, job status, Script revisions, parent/origin/provenance, Storyboard scenes and selected Script binding. Use ordinary lists and forms; no drag timeline.
- [ ] **Step 3: Add manual revision and approval actions.** Each edit posts a new revision; the UI never sends credentials or raw provider exceptions.
- [ ] **Step 4: Add API-backed smoke coverage.** Verify Project → Brief → Script Job → Script → Storyboard Job → Storyboard approval displays the expected state transitions.
- [ ] **Step 5: Run Web build/test and commit.** Commit as `feat: add director operator ui`.

## Task 10: Complete E2E, documentation and quality backlog

**Files:**
- Create: `tests/e2e/director-video-vertical-slice.test.ts`
- Create: `docs/engineering/DIRECTOR_VERTICAL_SLICE_REPORT.md`
- Create: `docs/product/DIRECTOR_QUALITY_BACKLOG.md`
- Modify: `docs/engineering/NEXT_VERTICAL_SLICES.md`, `task_plan.md`, `progress.md`, `findings.md`, `package.json`

- [ ] **Step 1: Add full fake-provider E2E.** Create Project, Brief, Script Job, Script V1, manual Script V2, Storyboard V1 based on V2, import Voice/Video Assets, create Video Job, run Planner/Video Worker/FFmpeg, and assert the final Render traces back through Storyboard, Script and Brief.
- [ ] **Step 2: Add three manual acceptance fixtures.** Record observed quality issues for commercial analysis, knowledge explanation and story expression without claiming that text quality is production-optimized.
- [ ] **Step 3: Write the report.** Include domain, AI provider mode, prompts, revisions, Jobs, API, Web, Video bridge, tests, Sandbox status, architecture deviations and known quality issues. If no credentials are available, state `REAL PROVIDER SANDBOX = BLOCKED` with the exact missing prerequisite.
- [ ] **Step 4: Update the next-slice handoff.** Keep benchmark library, analytics collector, TTS and Publisher productization out of this implementation; recommend only one next slice based on evidence.
- [ ] **Step 5: Run the complete gate.** With `DATABASE_URL=postgresql://contentos_dev@127.0.0.1:55433/contentos_director_dev`, run `pnpm run format`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, `pnpm run doctor`, and `git diff --check`; require zero automated failures.
- [ ] **Step 6: Run the credential/artifact scan.** Confirm no keys, cookies, profiles, screenshots or generated media are tracked; confirm no real provider/platform request was made unless explicitly authorized.
- [ ] **Step 7: Commit the final report and implementation.** Commit as `feat: complete director vertical slice` only if all gates and report conditions are satisfied.

## Verification and stop conditions

The implementation stops if a migration, contract, Job, API, Web, E2E or safety gate fails. Provider Sandbox is allowed to remain `BLOCKED` only when the report records the missing credential/provider choice; it cannot be reported as passed. No TTS, benchmark scraping, analytics collector, automatic feedback mutation, real platform smoke or Publisher product UI is added by this plan.

## Plan self-review

- Domain requirements map to Tasks 2–5.
- Provider and Prompt provenance map to Task 4 and the AI migrations in Task 3.
- Durable Jobs and worker boundaries map to Tasks 6 and 1.
- API and Operator UI map to Tasks 7 and 9.
- Director→Video traceability maps to Task 8 and Task 10 E2E.
- Security, bounded output, retry classification and no-secret payloads are explicit in Tasks 2, 4, 6 and 7.
- No task depends on a function name not introduced by an earlier task.
- No generated artifact or real external account is required for the automated gate.
