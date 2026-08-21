# Director Foundation Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with TDD checkpoints.

**Goal:** Add a deterministic, human-editable Director Brief/Storyboard revision flow without connecting any real AI provider.

**Architecture:** Director owns a project-linked append-only `DIRECTOR_PLAN_V0` revision. The contract validates brief and storyboard structure; the service owns revision transitions and the project’s current approved pointer. Fastify exposes only Director use cases, while PostgreSQL remains the source of truth.

**Tech Stack:** TypeScript, Node test runner, Fastify/Zod, PostgreSQL migrations, existing `pg` database client and Project module.

---

### Task 1: Freeze the Director contract

**Files:**
- Create: `packages/contracts/src/director-plan.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/contract/director-plan.test.ts`

- [x] Write tests for valid deterministic plans, duplicate scene rejection, empty brief rejection and non-positive duration rejection.
- [x] Run the contract test and observe the expected missing-module failure.
- [x] Implement `DirectorPlanV0`, `DirectorBrief`, `DirectorScene` and `validateDirectorPlan` with schema version `DIRECTOR_PLAN_V0`.
- [x] Run the contract test and typecheck until green.

### Task 2: Add append-only Director persistence

**Files:**
- Create: `migrations/0004_director_plan.sql`
- Create: `migrations/0004_director_plan.down.sql`
- Modify: `packages/database/src/migrator.ts` only if migration discovery requires it
- Test: `tests/integration/director.test.ts`

- [x] Write an integration test that creates a project, inserts two revisions, verifies immutable history, updates the approved pointer and rolls migrations down/up.
- [x] Run the integration test and observe the expected missing-table failure.
- [x] Add `director_plan_revisions` with project ownership, revision uniqueness, `DIRECTOR_PLAN_V0` check, status transitions, JSONB brief/storyboard/provenance and timestamps; add `content_projects.current_director_revision_id`.
- [x] Add the down migration in reverse foreign-key order and run the integration test green.

### Task 3: Implement Director application service

**Files:**
- Create: `packages/modules/director/src/director-service.ts`
- Create: `packages/modules/director/src/index.ts`
- Modify: `packages/modules/package.json` only if export metadata is required
- Test: `tests/integration/director.test.ts`

- [x] Add tests for create draft, revise, accept, approve, current revision query and rejection of invalid state transitions.
- [x] Implement service methods using the Director-owned table only; every mutation validates `DIRECTOR_PLAN_V0`, increments revision and preserves prior rows.
- [x] Run Director integration tests and the existing project/database tests.

### Task 4: Add thin Director API routes

**Files:**
- Modify: `apps/api/src/app.ts`
- Test: `tests/integration/director-api.test.ts`

- [x] Write API tests for create draft, get current revision, revise and approve, including 422 validation and 409 transition errors.
- [x] Implement `POST /api/v1/projects/:id/director-plans`, `GET /api/v1/projects/:id/director-plans/current`, `POST /api/v1/projects/:id/director-plans/:revision/revise`, `POST /api/v1/projects/:id/director-plans/:revision/accept` and `POST /api/v1/projects/:id/director-plans/:revision/approve`.
- [x] Keep controllers limited to Zod parsing and Director service calls; no direct mutation SQL in routes.
- [x] Run the API test green.

### Task 5: Verify and document the slice

**Files:**
- Modify: `package.json` test script
- Modify: `docs/engineering/NEXT_VERTICAL_SLICES.md` only if sequencing needs clarification
- Modify: `task_plan.md` and `progress.md`

- [x] Add contract, Director integration and Director API tests to the serial test command.
- [x] Run format, lint, typecheck and all tests; build and doctor remain in the final gate.
- [ ] Commit the slice as `feat: add director brief and storyboard foundation` and push `main`.
