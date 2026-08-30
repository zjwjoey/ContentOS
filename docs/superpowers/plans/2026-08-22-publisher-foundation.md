# Publisher Foundation V0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the Publisher module boundary and PostgreSQL persistence for account, request, immutable revision, attempt and external-post records without adding API or Worker behavior.

**Architecture:** Keep Publisher data private to `packages/modules/publisher`; expose typed service methods for later API/Worker layers. Add one forward/down migration after `0008_ai_provenance.sql`; use explicit statuses, foreign keys, checks, indexes and unique constraints for traceability and idempotency.

**Tech Stack:** TypeScript, Node test runner, `pg`, PostgreSQL migrations, existing module/service patterns.

---

### Task 1: Add Publisher domain types and transition guards

**Files:**
- Modify: `packages/contracts/src/publisher.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Create: `packages/modules/publisher/src/publisher-service.ts`
- Test: `tests/contract/publisher-foundation.test.ts`

- [ ] Write contract tests for account statuses, request statuses, revision input and allowed transitions.
- [ ] Run `pnpm exec tsx --test tests/contract/publisher-foundation.test.ts`; confirm it fails because the new exports and validators do not exist.
- [ ] Add bounded union types, input interfaces and pure transition validator. Keep platform adapter types unchanged.
- [ ] Export the new types and validator from the Publisher module.
- [ ] Run the focused test again; confirm it passes.
- [ ] Commit `feat: define publisher foundation domain contracts`.

### Task 2: Add Publisher foundation migration

**Files:**
- Create: `migrations/0009_publisher_foundation.sql`
- Create: `migrations/0009_publisher_foundation.down.sql`
- Test: `tests/integration/publisher-foundation.test.ts`

- [ ] Write integration tests that migrate a clean test database, verify all five tables, constraints and indexes, and then run down/up idempotently.
- [ ] Run `DATABASE_URL=postgresql://contentos_dev@127.0.0.1:55433/contentos_test pnpm exec tsx --test tests/integration/publisher-foundation.test.ts`; confirm it fails because migration 0009 is absent.
- [ ] Add `publisher_accounts`, `publisher_requests`, `publisher_request_revisions`, `publisher_attempts` and `publisher_external_posts` with project/job/attempt foreign keys, bounded status checks, revision uniqueness, account/platform external-post uniqueness and lookup indexes.
- [ ] Add the down migration in reverse dependency order.
- [ ] Run the focused integration test; confirm it passes twice.
- [ ] Commit `feat: persist publisher foundation records`.

### Task 3: Implement Publisher aggregate persistence

**Files:**
- Modify: `packages/modules/publisher/src/publisher-service.ts`
- Modify: `packages/modules/publisher/src/index.ts`
- Test: `tests/integration/publisher-foundation.test.ts`

- [ ] Add tests for creating an account with only `credentialRef`, creating a request and immutable revision, stable request idempotency, guarded transitions, attempt append/finalize and external-post deduplication.
- [ ] Run the focused integration test; confirm each new behavior fails before implementation.
- [ ] Implement `PublisherService` methods using the module's own tables and transactions with `SELECT ... FOR UPDATE` for request transitions.
- [ ] Ensure returned records omit secrets and serialize timestamps consistently.
- [ ] Run focused contract and integration tests; confirm all pass.
- [ ] Commit `feat: add publisher foundation service`.

### Task 4: Regression verification and documentation

**Files:**
- Modify: `packages/modules/publisher/README.md`
- Modify: `docs/modules/PUBLISHER_MODULE_V0.md`
- Test: existing suite

- [ ] Document table ownership, statuses, immutable revision rule and unknown-state reconciliation invariant.
- [ ] Run `DATABASE_URL=postgresql://contentos_dev@127.0.0.1:55433/contentos_test pnpm test`; expect all tests including new Publisher tests to pass.
- [ ] Run `pnpm run format`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`.
- [ ] Commit `docs: document publisher foundation invariants`.
