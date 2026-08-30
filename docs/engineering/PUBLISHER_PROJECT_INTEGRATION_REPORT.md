# Publisher → Content Project Integration Report

日期：2026-08-22
分支：`codex/publisher-project-integration`

## Gate result

第②步 Publisher → Content Project 集成已于 2026-08-22 正式验收通过。最终复审无 Critical、Important 或 Minor 发现。第③步 Project Center 及后续切片没有启动。

本轮验收修复已完成：未知外部状态先落持久化 `PUBLISH_RECONCILE` Job，再同步 Project；Project 发布状态更新改为数据库内单调条件更新；Worker 只允许 `READY` 账号进入真实发布；重复幂等键必须匹配原请求的项目、账号和 Revision 快照；项目摘要和请求详情的人为处理数只统计每个请求最新且未解决的人工动作；已终态 `PUBLISHED` 请求在 Job 重试时会幂等补做 Project 同步，避免业务事实与项目状态永久分叉。

## Delivered flow

```text
Content Project
  -> READY VIDEO_RENDER Asset
  -> project Publisher handoff
  -> one PublishRequest/Revision per selected account
  -> account-specific Approval Gate
  -> PUBLISH Job / Worker
  -> confirmed ExternalPost
  -> Project PUBLISHED
```

## Delivered contracts

- `PublisherProjectSummary` exposes project-scoped account/request counts, normalized status counts, confirmed external-post count and human-action count without attempt diagnostics or secrets.
- `ProjectService.syncPublishingStatus()` accepts explicit publishing facts and preserves `ARCHIVED`/`REVIEWED` states.
- `POST /api/v1/projects/:projectId/publisher/handoff` validates one project-owned READY Render Asset and multiple project-owned accounts, then creates idempotent account-specific requests.
- `GET /api/v1/projects/:projectId/publisher/summary` exposes the safe summary for later Project Center consumption.
- Publisher Worker updates Project state after publish, failure and reconciliation outcomes through public Project and Asset services; it never writes Project tables directly.
- Publisher Worker revalidates the project-owned READY Render Asset and frozen checksum before any external publish call.

## Verification

- `pnpm test`: 109 passed, 0 failed
- `pnpm typecheck`: passed
- `pnpm lint`: passed (`72` TypeScript files)
- `pnpm --dir apps/web build`: passed
- Targeted API/Worker/UI tests: passed

## Explicitly not included

- Project Center UI (Slice ③)
- Video MVP expansion (Slice ④)
- Metric Snapshot and post-publish AI Review (Slice ⑤)
- Real Douyin/WeChat adapters or credentials (Slice ⑥)
