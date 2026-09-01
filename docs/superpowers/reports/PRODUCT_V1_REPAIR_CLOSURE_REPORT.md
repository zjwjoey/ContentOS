# ContentOS Product V1 Repair Closure Report

## Release gate result

- **Status:** PASS — branch is ready for PR review; no merge performed.
- **Branch:** `codex/product-v1-repair`
- **Baseline:** `origin/main` at `55ee1059c309b705e2f1608804a1c3ba0137bb1e`
- **Final HEAD:** `f416532` (`fix: close final product v1 acceptance gaps`)
- **Divergence:** 6 commits ahead, 0 commits behind `origin/main`; `origin/main` is an ancestor of HEAD.
- **Scope:** acceptance-gap repair only; no new product module or V2 work.

## Implemented acceptance repairs

- Approval actions validate a current `PENDING` decision before advancing Director, and persist the approval result only after the Director transition succeeds. Direct Director compatibility transition endpoints fail closed with `DIRECTOR_APPROVAL_REQUIRED`.
- Publisher revision edits enforce request project ownership, asset checksum/ownership, and READY `VIDEO_RENDER` cover constraints.
- Job scheduling uses durable `jobs.scheduled_at`; runnable listing and claim both enforce the schedule gate independently of mutable payload fields.
- WeChat Channels only reports `PUBLISHED` after a confirmed external post ID; uncertain submission remains reconcilable and missing IDs require human action.
- Standalone Quick Edit retries an existing render with the current resolved manifest, preserving absolute workspace media paths for FFmpeg.
- Operator browser acceptance uses the real Script/Storyboard Approval Gate and selects a valid reorder operation when random fixture ordering makes a candidate swap invalid.

## Verification evidence

All commands were run from the repair worktree with an isolated PostgreSQL 16 test cluster and explicit FFmpeg 8.1.2/FFprobe paths.

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS; lockfile up to date |
| `pnpm format` | PASS; 333 files |
| `pnpm lint` | PASS; 130 TypeScript files |
| `pnpm typecheck` | PASS |
| `pnpm test` | **234 passed, 0 failed, 0 skipped** |
| `pnpm run test:integration-closure` | **30 passed, 0 failed** |
| `pnpm run test:migrations` | **8 passed, 0 failed, 0 skipped** |
| `pnpm run test:browser` | **3 passed, 0 failed, 0 skipped** |
| `pnpm build` | PASS |
| `pnpm --dir apps/web build` | PASS; 7 static pages generated |
| `pnpm run doctor` | PASS: runtime, storage, ffmpeg, ffprobe, filters, codecs, subtitle font |
| `git diff --check` | PASS |

Focused Standalone Quick Edit regression coverage also passed: **4/4** integration/API/vertical-slice tests.

## Final review notes

- PostgreSQL is the business truth; browser and migration checks ran against the isolated test cluster, not a production database.
- Approval/Director state writes remain ordered across module services rather than sharing a cross-module transaction. The PENDING preflight and post-transition persistence make failure states retryable, but this is an acknowledged operational limitation, not a claim of cross-module atomicity.
- Real Douyin/WeChat irreversible publishing, production credentials, real browser sessions, and AI quality are not live-verified. The release gate covers contracts, fail-closed adapters, Fake Publisher journeys, reconciliation, and secret-safe payloads.
- `pnpm install --frozen-lockfile` reported pnpm's existing ignored-build-script warning for `esbuild`; it did not affect any gate result.
