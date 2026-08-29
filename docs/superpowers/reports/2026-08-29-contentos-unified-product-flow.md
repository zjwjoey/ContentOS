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
- The Publisher handoff now creates one `PENDING` Approval for each immutable
  Publish Revision. An idempotent repeat preserves the current decision rather
  than replacing an approved revision with a new pending one.
- The development-only Fake Publisher selector stores safe Publisher-owned
  simulation state. It drives `SUCCESS`, retryable failure, human-action and
  reconciliation cases without changing the disabled-by-default real-adapter
  composition.
- The Publisher page polls only in-flight work and retryable failed attempts;
  it stops polling a `NEEDS_HUMAN_ACTION` result.

## Verification evidence

- `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
  `pnpm --dir apps/web build`: passed.
- `pnpm test:migrations`: **3 passed, 0 failed**.
- `pnpm test` with the local PostgreSQL service on port 5432: **191 passed, 0
  failed**.
- `pnpm test:browser`: **1 passed, 0 failed**. The harness creates a UUID-named
  schema inside the configured test database, migrates it before startup,
  gives every owned process a schema-scoped URL, temporary storage root and
  dynamically allocated loopback ports, then terminates only that process tree
  and drops only that schema.
- The browser journey uses visible UI actions to cover the full successful
  flow plus `NETWORK → retry → SUCCESS`, `AUTH_EXPIRED → NEEDS_HUMAN_ACTION →
  no automatic retry`, and `BROWSER_CRASH → reconciliation → one ExternalPost`.
  It also double-clicks queueing and verifies one external post.
- `pnpm doctor` and `git diff --check integration/contentos-v1...HEAD`:
  passed.

## Remaining product limits

Real Douyin/WeChat execution, real AI providers and post-publication Review
analytics remain deliberately disabled and outside Stage 2. This report does
not freeze, merge or push the branch; those are held for human acceptance.

## Branch policy

All changes are on `codex/unified-product-flow` in
`E:\ContentOS\\.worktrees\\unified-product-flow`; no merge to `main` has been
performed.
