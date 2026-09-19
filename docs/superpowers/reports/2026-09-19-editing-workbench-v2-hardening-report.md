# Editing Workbench V2 — Hardening Report

Date: 2026-09-19  
Branch: `codex/editing-workbench-v2`  
Baseline: `ace263275dc14b660807d5fb910816a69df5f220e`  
Implementation commits: `057d3d5`, `e2cad7c`, `4d5b409`, `4525375`, `aacbd77`, `ce9b037`, `5f02dea`

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
| `pnpm exec tsx --test tests/unit/editing-workbench.test.ts` | PASS (`7` tests) |
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
- The branch was not merged. Push the review branch when the remote is
  reachable; merging remains an explicit human/review action.

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
- Worker reconciliation now repairs prepare/render crash windows, and retry
  idempotency keys advance from the failed job id so repeated retries create a
  fresh attempt while duplicate clicks remain safe.
- Batch detail reports `BATCH_INCOMPLETE` when durable item facts do not match
  the declared total, and the history UI marks test-only runs without exposing
  internal seed or environment names.
- Export failures have a dedicated retry endpoint and history action; destination
  reservation is serialized per output root, and staged upload promotion refuses
  to overwrite an existing destination.

Final local verification on PostgreSQL 16 at `127.0.0.1:55433`:

| Gate | Result |
| --- | --- |
| `pnpm test` on a clean public test schema | PASS — 243/243 |
| `pnpm test:migrations` | PASS — 8/8 |
| `pnpm test:auto-edit-v1` | PASS — 25/25 |
| `pnpm test:auto-edit-v15` | PASS — 19/19 |
| `pnpm test:browser` with `CONTENTOS_TEST_ADMIN_DATABASE_URL` on PostgreSQL 16 (`127.0.0.1:55433`) | PASS — 2/2 |
| `pnpm build` | PASS |
| `node_modules/.bin/next build` (apps/web) | PASS |
| `node_modules/.bin/tsx scripts/format-check.ts` | PASS — 410 files |
| `node_modules/.bin/tsx scripts/lint.ts` | PASS — 147 TypeScript files |
| `pnpm doctor` | PASS with one PATH warning for the global pnpm bin directory |
| `git diff --check` | PASS |

The branch is **GO for merge from the local verification perspective**. The
latest verified HEAD is `56c1190`, and it is already pushed as
`origin/codex/editing-workbench-v2`; it is not merged. Merging remains an
explicit review action.

## Final merge-blocker review

| Finding | Status | Evidence |
| --- | --- | --- |
| Render retry generations and duplicate-click idempotency | FIXED / VERIFIED | Retry suffix includes the previous failed job id; worker recovery repairs the post-commit crash window. |
| Prepare terminal failure summary | FIXED / VERIFIED | Item failure is written by the worker and batch aggregation reports zero active items. |
| Render worker write-side item completion | FIXED / VERIFIED | VIDEO_RENDER success/final failure updates the linked editing item and batch in the attempt transaction. |
| GET batch read-only behavior | FIXED / VERIFIED | Normal GET no longer updates item or batch rows. |
| Migration 0027 down with live states | FIXED / VERIFIED | PREPARING/RENDERING normalize to RUNNING before the legacy constraint; migration test covers down/up. |
| Variant output grouping | FIXED / VERIFIED | Output uses source ordinal plus A/B/C suffix; unit coverage added. |
| Batch detail pagination and export polling | FIXED / VERIFIED | UI requests page/pageSize and waits on aggregate export counts with no queued exports. |

Local-media scan snapshot reuse remains a follow-up, and the separate hybrid
local/Pexels script-editing V1 feature is intentionally developed on its own
feature branch.

## Final audit at `d423fd1` (2026-09-19)

The earlier addendum referred to `56c1190`; the current branch has since
closed the remaining merge-blocker fixes in `d423fd1` and was re-audited from
the checked-out source. The branch is still independent of `main` and is not
merged.

| Required finding | Status | Evidence |
| --- | --- | --- |
| Render repeat retry creates a fresh generation while duplicate clicks remain idempotent | FIXED / VERIFIED | Retry suffix includes the previous failed render Job id; unit and worker recovery coverage pass. |
| Prepare terminal failure is not counted as active | FIXED / VERIFIED | Persisted FAILED/CANCELLED state wins summary/detail mapping; full test suite passes. |
| Prepare failure reaches terminal batch state and can be retried | FIXED / VERIFIED | Worker terminal failure writes the item and synchronizes batch counts; browser retry flow passes. |
| Retry crash window is recoverable | FIXED / VERIFIED | Reconciler recreates missing prepare/render jobs from durable item facts. |
| Render worker writes batch item completion without GET polling | FIXED / VERIFIED | VIDEO_RENDER attempt transaction updates output asset, item state, and batch counters. |
| GET batch is read-only in normal operation | FIXED / VERIFIED | Batch detail no longer performs normal state writes. |
| 0027 down migration handles live PREPARING/RENDERING data | FIXED / VERIFIED | State normalization precedes legacy constraint recreation; migration matrix covers down/up. |
| Variant output grouping and title de-duplication | FIXED / VERIFIED | Source ordinal plus A/B/C naming is covered by unit tests. |
| History pagination and aggregate export polling | FIXED / VERIFIED | UI requests page/pageSize and waits on aggregate export counters. |

## Re-run Gate evidence

Using an isolated PostgreSQL 16 schema on `127.0.0.1:55433`:

| Gate | Result |
| --- | --- |
| `pnpm format` | PASS — 410 files |
| `pnpm lint` | PASS — 147 TypeScript files |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 245/245, 0 failed |
| `pnpm test:migrations` | PASS — 9/9 |
| `pnpm test:auto-edit-v1` | PASS — 25/25 (fresh isolated schema) |
| `pnpm test:auto-edit-v15` | PASS — 19/19 (fresh isolated schema) |
| `pnpm test:browser` | PASS — 2/2 |
| `pnpm build` | PASS |
| `pnpm --dir apps/web exec next build` | PASS |
| `pnpm doctor` | PASS with one PATH warning for the global pnpm bin directory |
| `git diff --check` | PASS |

Remote state at audit time: `codex/editing-workbench-v2` and
`origin/codex/editing-workbench-v2` both point to `d423fd1f3c2f10aabbf0563e3edaa4231316d234`;
`origin/main` is `42c9b2f1eb80fddf63bef67dd8932ec448cabcd9`; ahead/behind is
`21/0`. Decision: **READY FOR MERGE** from the local verification
perspective. Merge remains an explicit review action.
