# ContentOS Unified Product Flow — Stage 2 Progress Report

## Scope

This review branch implements the browser-operated Fake product flow on top of
`integration/contentos-v1@0fbafee`:

`Project → Assets → Director → Video → Approval Gate → Publisher → Project Center`

Real AI providers, live Douyin/WeChat calls, Review analytics and merge to
`main` remain disabled and out of scope.

## Implemented slices

- Durable `asset_imports` persistence, bounded multipart staging and Asset Worker
  checksum/probe/promotion/dedupe lifecycle.
- Assets workspace with safe summaries, import polling and project-scoped media
  preview.
- Director handoff gate requiring an accepted Script and matching approved
  Storyboard before Video creation.
- Safe Video workspace API and page for source selection, voice/subtitle/duration
  input, durable render Job polling/cancel, output preview and exact Render
  Approval target.
- Project-scoped Approval Gate list/actions with append-only exact revisions and
  mandatory rejection reasons.
- Publisher page now requires an already-approved exact Publish Revision before
  queueing; it exposes safe attempts, human-action state and confirmed
  ExternalPost records.
- Shared five-stage product navigation vocabulary and Project Center shell.

## Verification evidence

- `pnpm typecheck`: passed.
- `pnpm --dir apps/web build`: passed with routes for Assets, Director, Video,
  Approval Gate and Publisher.
- `pnpm test` with the local PostgreSQL service on port 5432: **189 passed, 0
  failed**.
- `pnpm test:stage2-product` with
  `DATABASE_URL=postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test`
  and `CONTENTOS_OPERATOR_URL=http://127.0.0.1:3001`: **13 passed, 0 failed,
  0 skipped**.
- `pnpm test:browser` with the operator composition running on port 3001:
  **1 passed, 0 failed**. Without `CONTENTOS_OPERATOR_URL`, the command
  intentionally skips because the browser smoke is opt-in.
- `pnpm format`, `pnpm lint`, `pnpm build`, `pnpm test:migrations` (3/3), and
  `pnpm doctor`: passed.
- Acceptance found and fixed a Publisher dev-composition guard that mistakenly
  launched the production worker from `dev-main.ts`; the regression suite is
  green (`publisher-web` + Publisher Worker: **12/12 passed**).
- One acceptance rerun was invalidated because the browser-test operator was
  still consuming Jobs from the same test database. After stopping that owned
  composition and removing its two exact test residues, the focused 12/12 and
  full 189/189 suites passed with a single test executor.

## Known limits before final Stage 2 acceptance

1. The browser harness currently provides an opt-in project/stage navigation
   smoke path; it does not yet provision a UUID-isolated PostgreSQL database,
   launch every worker, or execute the complete upload-to-publish journey
   automatically.
2. Fake Publisher failure-mode selection is still composed in the Worker test
   runtime rather than exposed as a development-only operator control.
3. The final architecture/documentation gate, independent review and remote
   push are intentionally not performed until the remaining browser/composition
   work is implemented and accepted.

## Branch policy

All changes are on `codex/unified-product-flow` in
`E:\ContentOS\\.worktrees\\unified-product-flow`; no merge to `main` has been
performed.
