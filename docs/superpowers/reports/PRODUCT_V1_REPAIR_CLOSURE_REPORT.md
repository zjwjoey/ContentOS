# ContentOS Product V1 Repair Closure Report

## Baseline and scope

- Baseline SHA: `55ee1059c309b705e2f1608804a1c3ba0137bb1e` (`origin/main`)
- Repair HEAD: `ed44ae8` plus the current Approval ordering repair
- Branch: `codex/product-v1-repair`
- Scope: acceptance-gap repair only; no new product module or V2 work

## Implemented

- Approval actions validate a current `PENDING` decision before advancing Director, then persist the approval result. A failed or missing Director transition therefore cannot leave a new `APPROVED` decision behind.
- Publisher revision edits enforce request project ownership, asset checksum/ownership, and READY `VIDEO_RENDER` cover constraints.
- Job scheduling uses durable `jobs.scheduled_at`; runnable listing and claim both enforce the gate, independent of mutable payload fields.
- WeChat Channels only reports `PUBLISHED` after a confirmed external post ID; uncertain submission remains reconcilable and missing IDs require human action.
- Publisher fake, retry, unknown-outcome, reconciliation, idempotency, and project-scoping paths remain covered.

## Tested

- Full suite: **234 passed, 0 failed** (isolated PostgreSQL and configured FFmpeg environment)
- Typecheck: passed
- Lint: passed
- Format: passed
- `git diff --check`: passed
- Integration closure: source/contract tests passed; migration/database cases require a database role with `CREATEDB` on the configured test server
- Build: `pnpm build` passed
- Web build: `pnpm --dir apps/web build` passed (non-blocking autoprefixer warnings)
- Doctor: passed with configured FFmpeg/FFprobe

## Live-verified / external gates

- LIVE-VERIFIED: local API/module integration and FFmpeg vertical slices in the full suite.
- EXTERNAL-GATE: browser script and migration matrix could not create `contentos_test` because the configured PostgreSQL role lacks database-create permission; default port `55432` is not running. No browser result is claimed.
- EXTERNAL-GATE: real Douyin and WeChat irreversible publishing, real AI quality, and production credentials are not verified.

## Deferred / known limitations

- Approval and Director writes are ordered with a PENDING preflight rather than sharing one cross-module transaction; a database failure after Director commit and before approval persistence remains an operational retry case and is not presented as fully transaction-atomic.
- Grant `CREATEDB` (or provide `CONTENTOS_TEST_ADMIN_DATABASE_URL`) and rerun `pnpm run test:migrations` and `pnpm run test:browser` before final main merge.
