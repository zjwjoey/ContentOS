# Editing Workbench V2 — Hardening Report

Date: 2026-09-19  
Branch: `codex/editing-workbench-v2`  
Baseline: `ace263275dc14b660807d5fb910816a69df5f220e`  
Implementation commit: `70fbed8`

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
- Export creates a durable RUNNING export row, serializes destination selection
  with a lock directory, copies through a temporary file, atomically promotes,
  and cleans all temporary state on errors.
- Batch detail uses a single job join instead of per-item job reads and supports
  pagination. History also supports page/pageSize parameters.
- Pairing UI displays missing and duplicate rows explicitly. Advanced duration
  controls are shown in seconds and internal seed/environment details are hidden.

No new migration was required: all changes use the existing `0026` schema and
are forward-compatible with previously created sessions and batches.

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

**NO-GO for merge in the current environment.** Local static/unit gates pass,
but the required browser/database gate and full test suite could not be verified.
Do not state READY FOR MERGE until PostgreSQL-backed E2E and the full offline
test command have passed on the pushed branch.
