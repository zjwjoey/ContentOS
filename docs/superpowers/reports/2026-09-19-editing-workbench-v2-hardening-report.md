# Editing Workbench V2 — Hardening Report

Date: 2026-09-19  
Branch: `codex/editing-workbench-v2`  
Baseline: `ace263275dc14b660807d5fb910816a69df5f220e`  
Implementation commit: pending final hardening commit

## Implemented

- Pairing now uses basename-only keys with trim, Unicode NFKC normalization,
  case folding, and extension-aware matching. Duplicate text/audio basenames
  are returned as explicit rows instead of being overwritten or filtered.
- Audio uploads use a target-root `.part` file followed by a same-volume rename;
  both staged and partial files are cleaned on success and failure.
- Batch/session/item facts are inserted in one database transaction before item
  preparation starts. A crash therefore leaves a complete, count-consistent
  item stub set for recovery and inspection.
- Retry claims failed rows with row locks, uses stable per-item idempotency keys,
  and restores failed state if retry preparation cannot create a render job.
- Source roots, paired files, voice files, and worker local-media paths now use
  realpath containment and file/directory type checks. The video worker validates
  the resolved path again before rendering.
- Export creates a durable queued export row, serializes destination selection
  with a lock directory, copies through a temporary file, atomically promotes,
  and cleans all temporary state on errors.
- Batch detail uses a single job join instead of per-item job reads and supports
  pagination. History also supports page/pageSize parameters.
- Pairing UI displays missing and duplicate rows explicitly. Advanced duration
  controls are shown in seconds and internal seed/environment details are hidden.

- Migration `0027_editing_workbench_hardening.sql` adds durable preparation/export
  references, persisted item settings, source ordinals, variant indexes, and the
  explicit preparation/rendering states. Its down migration is reversible.
- Settings now exposes the configured local-media and export roots read-only so
  operators can verify folder permissions without changing server configuration.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS (`129` TypeScript files) |
| `pnpm format` | PASS (`300` files) |
| `pnpm exec tsx --test tests/unit/editing-workbench.test.ts` | PASS (`5` tests) |
| `pnpm test:browser` | BLOCKED: PostgreSQL unavailable at `127.0.0.1:5432` (`ECONNREFUSED`) |
| Full `pnpm test` | NOT RUN: the browser/database gate is unavailable in this environment |
| `git diff --check` | PASS |

The new unit coverage includes cross-folder/NFKC/case-insensitive pairing,
duplicate basename reporting, and staged-upload cleanup after target-volume
promotion.

## Remaining limitations / release decision

- Browser E2E, crash/restart recovery, live retry races, and export races still
  need an environment with PostgreSQL and the operator server running.
- Preparation and scanning remain executed by the API request path; the durable
  item stubs make the state recoverable, but a separate prepare/scan Job worker
  is still a follow-up hardening task.
- The branch was not merged. A push attempt should be made when GitHub network
  access is available.

## Decision

## Final verification addendum

The remaining implementation work was completed after the initial draft of this
report:

- `EDIT_PREPARE_ITEM` is now a durable Job consumed by the existing video worker;
  it creates the workspace voice import, manifest, and normal `VIDEO_RENDER` Job.
- Prepare failures can be retried, render retries remain idempotent, and batch
  items persist source ordinal, variant index, voice reference, and settings.
- `EDIT_EXPORT` is now a durable Job. Render success and external export status
  remain separate, with worker-side output-root defense and atomic promotion.
- Migration `0027_editing_workbench_hardening.sql` and its down migration cover
  the new item/job fields and state constraints.
- `test:browser` now includes both Auto Edit V1 and Editing Workbench browser
  suites by default.

Final local verification on PostgreSQL 16 at `127.0.0.1:55433`:

| Gate | Result |
| --- | --- |
| `pnpm test` on a clean public test schema | PASS — 241/241 |
| `pnpm test:migrations` | PASS — 8/8 |
| `pnpm test:auto-edit-v1` | PASS — 25/25 |
| `pnpm test:auto-edit-v15` | PASS — 19/19 |
| `pnpm test:browser` | PASS — 2/2 |
| `pnpm build` | PASS |
| `pnpm --filter @contentos/web exec next build` | PASS |
| `pnpm format` | PASS — 329 files |
| `pnpm lint` | PASS — 136 TypeScript files |
| `pnpm doctor` | PASS with one PATH warning for the global pnpm bin directory |
| `git diff --check` | PASS |

The branch is **GO for merge from the local verification perspective**. It is
not yet pushed or merged because GitHub remains unreachable from this host; the
push must be retried when network access is restored.
