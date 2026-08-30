# ContentOS Development Workflow

## Default sequence

```text
Read context
 -> define scope and owner
 -> inspect contracts and migrations
 -> write red tests for important behavior
 -> implement the smallest vertical slice
 -> run focused tests
 -> run regression/full gate
 -> review diff and risk
 -> update docs/status
 -> commit with a meaningful message
```

## Before editing

Record the current branch, HEAD, worktree status, relevant baseline tests, owning module and migration head. Understand existing changes before touching them; do not mix unrelated cleanup into feature work.

## Scope and contracts

Write down user-visible goal, owner, inputs/outputs, transitions, failures, persistence, API/UI impact and test plan. For cross-module behavior, define or update the published contract first. Avoid hidden coupling through ad-hoc JSON or private table reads.

## Test-first behavior

Use red-first tests for state transitions, idempotency, retries, leases, cancellation, migrations, approvals, provenance, content-hash binding, adapter error normalization and unknown external outcomes. Do not delete, skip or weaken a failing test merely to pass a gate.

## Vertical slices

A slice should include the contract, application service, persistence, API/worker path and tests needed for one behavior. Long-running work belongs in durable Jobs; request handlers do not run FFmpeg, browsers or AI generation.

## Verification

Focused examples:

```bash
pnpm exec tsx --test tests/unit/<relevant>.test.ts
pnpm exec tsx --test tests/integration/<relevant>.test.ts
pnpm exec tsx --test tests/e2e/<relevant>.test.ts
```

Before branch completion:

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm doctor
pnpm --dir apps/web build
```

Run the Web build when Web code changes. Use an isolated PostgreSQL database for migration/integration evidence.

## Risk review

High risk: data loss, migration corruption, duplicate/wrong-account publishing, secret leaks, approval bypass, false success or broken recovery. These block merge. Medium risk: stale state, weak validation, missing traceability, incomplete error normalization or flaky tests. Low risk: naming and polish. Record deferred low-risk work instead of hiding it.

## Documentation and commits

Update only documents affected by reality, including `progress.md`, `NEXT_VERTICAL_SLICES.md`, ADRs/ECRs, setup and environment examples. Use focused commit messages such as `feat:`, `fix:`, `test:`, `docs:` or `chore:`. Never mark a simulated adapter as live-verified.
