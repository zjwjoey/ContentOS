# Publisher Product Slice Design

## Goal

将现有 Publisher foundation 推进为一个可操作、可审计的 Fake Platform 产品垂直切片，并让发布请求以 `Content Project` 为边界可追踪。

## Scope

本轮覆盖：

- Publisher account 查询与创建
- 发布请求创建、列表、当前版本查看
- 发布前 Approval gate 检查
- 发布请求入队为 durable `PUBLISH` Job
- Publisher Worker 使用 Fake Adapter 执行、记录 attempt 和 external post
- 幂等、失败分类、重试/未知外部状态的安全处理
- 项目级最小 Publisher Operator UI

本轮不覆盖真实抖音/视频号调用、真实凭据、浏览器自动化、Metric Snapshot、Review AI 和多平台编排。平台字段保持可扩展，Fake Platform 继续通过 `PublisherAdapter` 隔离。

## Architecture

API 只负责校验输入、调用 Publisher application service、创建 Approval/Job 记录并返回 ID；不执行发布。Publisher Worker 只消费 `PUBLISH` Job，通过 account 的 platform/profile 信息选择 adapter，使用已批准的具体 Publish Revision Approval 作为门禁，随后将外部结果归一化写入 Publisher domain。PostgreSQL 仍是业务事实源，Job 只承载投递状态；请求、版本、attempt、external post 和 Job 都保留 project/correlation 追踪信息。

### Request lifecycle

```text
DRAFT
  -> QUEUED       (publish endpoint, only after exact Publish Revision approval)
  -> PUBLISHING   (worker claim)
  -> PUBLISHED    (fake adapter returns confirmed post)

PUBLISHING -> RECONCILING -> PUBLISHED / QUEUED / FAILED
PUBLISHING -> FAILED       (permanent or exhausted retryable failure)
```

The API must never silently bypass the Approval Gate. A request without an approved `PUBLISH` decision for its current revision is rejected with a safe conflict response.

## API contract

Add project-scoped routes:

- `GET /api/v1/projects/:projectId/publisher/accounts`
- `POST /api/v1/projects/:projectId/publisher/accounts`
- `GET /api/v1/projects/:projectId/publisher/requests`
- `POST /api/v1/projects/:projectId/publisher/requests`
- `GET /api/v1/projects/:projectId/publisher/requests/:requestId`
- `POST /api/v1/projects/:projectId/publisher/requests/:requestId/queue`

Request payloads contain IDs, title/description, asset checksum, desired publish time, account/platform identifiers, reviewer identity and correlation/idempotency keys. They never contain credentials, cookies, access tokens, browser profiles or media bytes.

## Worker contract

Register exactly one durable handler type: `PUBLISH`. The handler payload contains `projectId`, `requestId`, `revisionId`, `accountId`, `platformId`, `jobId`, `jobAttemptId` and `correlationId`. It loads the current revision and account through `PublisherService`, starts an attempt, invokes the Fake Adapter, records the normalized outcome, and transitions the request. `UNKNOWN_EXTERNAL_STATE` must enter reconciliation; it must not be blindly retried as a fresh publish.

The development composition root injects `PublisherService`, a Fake Adapter registry and `JobRunner`; the production entry point fails closed when those dependencies are absent. No adapter-specific code enters API routes or domain tables.

## UI

Add `/projects/:id/publisher` as a project-scoped operator page. It shows accounts, publish requests, status, title, target platform and safe failure text. It can create a Fake account, create a draft request, approve its exact revision through the Approval endpoint, and queue it. It does not display or accept credentials and does not implement browser controls.

## Verification

- Contract tests cover API schemas and state transitions.
- Integration tests cover account/request persistence, review-gated queueing and idempotency.
- Worker tests cover success, retryable failure, human-action failure and unknown external state.
- Web static smoke verifies the page only references safe API fields.
- Typecheck and production Web build must pass.
