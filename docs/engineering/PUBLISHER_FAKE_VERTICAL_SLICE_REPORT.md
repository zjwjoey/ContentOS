# Publisher Fake Vertical Slice Report

日期：2026-08-22
分支：`codex/publisher-productization`

## Gate result

第①步 Publisher Fake 产品闭环已完成工程实现，等待合并前的人审确认；第②步及后续切片没有启动。

## Delivered flow

```text
Fake Account
  -> PublishRequest
  -> PublishRevision
  -> Approval(APPROVED, exact revision)
  -> PUBLISH Job
  -> Publisher Worker
  -> FakePublisherAdapter
  -> PublishAttempt
  -> confirmed ExternalPost
  -> PUBLISHED
```

Publisher API queueing checks an Approval for both `requestId` and the current `revisionId`. The same request/revision uses a stable Job idempotency key. The Worker reuses the existing JobRunner lease/attempt contract.

## Failure evidence

| Scenario | Durable result |
|---|---|
| Fake network/rate-limit | attempt `FAILED`, request `FAILED`, Job `RETRY_WAIT` |
| auth expired | attempt `FAILED`, request `FAILED`, Job `FAILED`, no blind retry |
| browser/side effect uncertain | attempt `UNKNOWN`, request `RECONCILING`, no fresh publish retry |
| duplicate delivery | existing Job/ExternalPost is reused |

`ExternalPost` is written only after the adapter returns a confirmed external ID. Unknown external state does not create an ExternalPost.

## Boundary decision

Pre-publish decisions now use `Approval / Approval Gate` and `APPROVAL_V0`, including `targetRevisionId`. `Review` is reserved for post-publish metrics and AI performance analysis. Migration `0010_approval` creates the active `approval_decisions` table. The old `review_decisions` table and `/reviews` routes remain legacy compatibility surfaces only and are not used by the new Publisher flow. See `docs/adr/ADR-012-approval-boundary.md`.

## Operator entrypoint

The local operator launcher now starts API, Web, Director Worker and Publisher Worker. Publisher development composition polls durable `PUBLISH` Jobs and uses a Fake Platform profile under the configured storage root. Production Publisher Worker startup fails closed without explicit dependencies.

## Verification

- `pnpm test`: 91 passed, 0 failed
- `pnpm typecheck`: passed
- `pnpm lint`: passed (`71` TypeScript files)
- `pnpm --dir apps/web build`: passed
- PostgreSQL test database: `contentos_test` on local PostgreSQL 16 port `55433`

## Explicitly not included

- Content Project aggregate/dashboard integration (Slice ②)
- Project Center UI (Slice ③)
- Video MVP expansion (Slice ④)
- Metric Snapshot and post-publish AI Review (Slice ⑤)
- Real Douyin/WeChat adapters or credentials (Slice ⑥)

