# ContentOS Product V1 Repair Closure Report

## Release gate result

- **Status:** PASS — branch is ready for PR review; no merge performed.
- **Branch:** `codex/product-v1-repair`
- **Baseline:** `origin/main` at `55ee1059c309b705e2f1608804a1c3ba0137bb1e`
- **Final code HEAD:** `81fcb20` (`fix: preserve uncertain publisher state`)
- **Ahead / Behind (code commits):** 16 / 0 at final verification; the branch is not behind `origin/main`.
- **Scope:** acceptance-gap repair only; no new product module or V2 work.

### Commits in the repair branch

`0463543` design spec, `2df10f9` acceptance repair plan, `88f8c7b` acceptance gaps, `ed44ae8` durable scheduling, `9920bca` Approval Gate, `028698e` lockfile sync, `f416532` final acceptance fixes, `aa717c8` publisher adapter hardening, and `81fcb20` uncertain-state safeguards, followed by closure-report documentation commits.

### Files changed versus baseline

27 files; changes are limited to approval routes/service, Director compatibility/UI flow, publisher revision/scheduling/reconciliation and adapter safety, standalone video render reuse, acceptance tests, lockfile, and the repair plan/closure report.

## Implemented acceptance repairs

- Approval actions validate a current `PENDING` decision before advancing Director, and persist the approval result only after the Director transition succeeds. `ApprovalService.create` accepts only `PENDING`, and direct Director compatibility transition endpoints fail closed with `DIRECTOR_APPROVAL_REQUIRED`.
- Publisher revision edits enforce request project ownership, asset checksum/ownership, and READY `VIDEO_RENDER` cover constraints.
- Job scheduling uses durable `jobs.scheduled_at`; runnable listing and claim both enforce the schedule gate independently of mutable payload fields.
- WeChat Channels only reports `PUBLISHED` after a confirmed external post ID; uncertain submission remains reconcilable and missing IDs require human action.
- The concrete Playwright page adapter implements the external-post-ID text extraction required by the WeChat adapter contract.
- External post identity conflicts across requests are fail-closed and become a human-action failure rather than a false `PUBLISHED` state.
- Standalone Quick Edit retries an existing render with the current resolved manifest, preserving absolute workspace media paths for FFmpeg.
- Operator browser acceptance uses the real Script/Storyboard Approval Gate and selects a valid reorder operation when random fixture ordering makes a candidate swap invalid.

## Verification evidence

All commands were run from the repair worktree with an isolated PostgreSQL 16 test cluster and explicit FFmpeg 8.1.2/FFprobe paths.

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS; lockfile up to date |
| `pnpm format` | PASS; 361 files |
| `pnpm lint` | PASS; 132 TypeScript files |
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

## Required invariant status

- **Approval consistency:** PASS with documented **LIMITATION** — PENDING preflight, non-PENDING rejection, transition-failure protection, wrong-project/revision checks, and duplicate approval checks are covered; cross-module writes are ordered rather than one atomic transaction.
- **Durable scheduling:** PASS — `jobs.scheduled_at` gates both runnable listing and claim; retry and idempotency paths are covered.
- **Publisher reconciliation:** PASS — unknown outcomes reconcile durably, deduplicate the confirmed ExternalPost, and terminate exhausted reconciliation as human action.
- **Security:** PASS — public payloads and logs exclude credentials, cookies, authorization headers, storage paths, and private diagnostics; ownership checks are project-scoped.

## Final review notes

- PostgreSQL is the business truth; browser and migration checks ran against the isolated test cluster, not a production database.
- Approval/Director state writes remain ordered across module services rather than sharing a cross-module transaction. The PENDING preflight prevents bypasses; a write failure in the ordered cross-module window remains an operational repair case. This is an acknowledged limitation, not a claim of cross-module atomicity.
- Real Douyin/WeChat irreversible publishing, production credentials, real browser sessions, and AI quality are not live-verified. The release gate covers contracts, fail-closed adapters, Fake Publisher journeys, reconciliation, and secret-safe payloads.
- `pnpm install --frozen-lockfile` reported pnpm's existing ignored-build-script warning for `esbuild`; it did not affect any gate result.

## External gates

Real Douyin publishing, irreversible WeChat Channels submission, production credentials/browser sessions, and real AI quality remain explicitly deferred. No external platform side effect was executed.
