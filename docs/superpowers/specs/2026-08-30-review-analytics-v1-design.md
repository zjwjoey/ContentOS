# ContentOS Review Analytics V1 Design

## Goal

在已确认的 `ExternalPost` 之上，建立可追溯的发布后数据复盘闭环：使用 Fake/导入型指标源生成标准化 `MetricSnapshot`，再通过 AI Provider 生成结构化复盘摘要和下一轮内容建议。

## Scope and non-goals

本切片只处理发布后的 Review Analytics，不改变 Approval Gate 或 Publisher 请求状态机。

包含：

- 以 `PublisherExternalPost` 为唯一复盘对象入口；
- 标准化播放、点赞、评论、收藏、分享、发布时间和采集时间；
- 通过 Durable Job 采集 Fake 指标，支持幂等、失败和重试；
- 基于已持久化快照调用 AI Provider，保存提示词、模型、输入哈希和输出来源；
- 项目级 Review 页面和 API，展示快照、趋势和 AI 建议；
- 为后续抖音/视频号数据源保留 provider/adaptor 边界。

不包含：

- 真实平台抓取、真实账号授权或浏览器自动化；
- 改写/批准 Publish Request；
- 将 Approval 决策改名为 Review；
- 通用工作流引擎、跨平台指标猜测、实时流式分析；
- 复杂 BI 图表、预测模型和自动回写 Director。

## Architecture

Review 只依赖 Project、Publisher 的公开 ExternalPost 读端口、Job 和 AI Provider 合同，不读 Publisher 私有表。采集任务的 Job payload 只携带 `projectId`、`externalPostId`、`source`、`correlationId` 和幂等键，不携带凭据、Cookie、授权头或浏览器状态。

```text
confirmed ExternalPost
        ↓
POST collect-metrics
        ↓
REVIEW_COLLECT_METRICS durable Job
        ↓
Review Metrics Source (Fake V1)
        ↓
MetricSnapshot (append-only)
        ↓
REVIEW_GENERATE_ANALYSIS durable Job
        ↓
AI Provider / review.analysis.v1
        ↓
ReviewAnalysisReport (append-only)
```

V1 使用独立 `Review Worker` 组合根。它通过 Publisher 的公开查询端口验证 ExternalPost 所属项目，再调用 Review application service；平台差异仅在未来的 metrics source/adapter 中实现。AI 供应商仍由既有 `AIService` 负责，Review 不直接导入任何 vendor SDK。

## Contracts

### MetricSnapshotV1

每条快照绑定一个已确认的 external post，并且不可更新：

```ts
interface MetricSnapshotV1 {
  schemaVersion: 'METRIC_SNAPSHOT_V1';
  id: string;
  projectId: string;
  externalPostId: string;
  platformId: string;
  capturedAt: string;
  publishedAt: string | null;
  metrics: {
    plays: number;
    likes: number;
    comments: number;
    saves: number;
    shares: number;
  };
  source: 'FAKE' | 'IMPORT';
  sourceReference: string | null;
  createdAt: string;
}
```

所有指标必须是非负整数；`capturedAt` 必须是合法 ISO 时间；同一 external post、source 和采集时间只能产生一个快照。重复 Job 返回已有快照，不创建第二条事实记录。

### ReviewAnalysisReportV1

分析报告绑定一个或多个快照，但只引用快照 ID，不复制未经验证的指标：

```ts
interface ReviewAnalysisReportV1 {
  schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1';
  id: string;
  projectId: string;
  externalPostId: string;
  metricSnapshotIds: string[];
  summary: string;
  highlights: string[];
  risks: string[];
  recommendations: Array<{ priority: 'HIGH' | 'MEDIUM' | 'LOW'; action: string; rationale: string }>;
  aiRunId: string | null;
  createdAt: string;
}
```

AI 输出必须经过结构校验；校验失败进入 Job 失败路径，不落一份看似成功的报告。报告为追加记录，最新报告通过查询排序得到，不能覆盖历史报告。

## Persistence

新增迁移 `0019_review_analytics.sql`（对应 down migration），不修改既有 `review_decisions` 表：

- `review_metric_snapshots`：快照事实、指标 JSONB、来源、采集时间、项目和 external post 引用；唯一键为 `(external_post_id, source, captured_at)`；
- `review_analysis_reports`：结构化复盘输出、引用的 snapshot ID 数组、AI provenance 字段；
- 项目和 external post 查询索引；
- 外键只指向公开稳定标识（`content_projects.id`），不建立跨模块私有表外键。

PostgreSQL 是业务事实源。队列行只传递 Job，不能作为“已采集”或“已分析”的事实判断。

## Application services

`ReviewAnalyticsService` 提供以下公开方法：

- `createMetricCollectionJob(projectId, externalPostId, source, idempotencyKey, correlationId)`：校验 ExternalPost 归属、创建幂等 Job；
- `recordMetricSnapshot(input)`：校验并幂等写入快照；
- `listMetricSnapshots(projectId, externalPostId?)`：按采集时间倒序读取；
- `createAnalysisJob(projectId, externalPostId, snapshotIds, idempotencyKey, correlationId)`：只允许已存在且属于同一 external post 的快照；
- `recordAnalysisReport(input)`：校验结构化 AI 输出并追加保存；
- `getProjectReviewOverview(projectId)`：返回 external post、最新快照和最新报告的安全读模型。

Review service 不接受平台凭据，不执行浏览器，也不从 HTTP handler 同步调用 AI。

## Jobs and workers

- `REVIEW_COLLECT_METRICS`：Review Worker 使用 `FakeMetricsSource` 生成确定性指标；模拟 `UNAVAILABLE` 时按 Job retry policy 处理，输入不合法或 ExternalPost 不存在时永久失败；
- `REVIEW_GENERATE_ANALYSIS`：Review Worker 读取快照，通过 `AIService.generateStructured` 调用 `review.analysis.v1`，结构错误或 provider 错误进入标准失败路径；
- 每次执行携带 job/attempt/correlation 标识；lease recovery、取消和幂等沿用现有 Job contract；
- Worker 不直接写其他模块私有表；ExternalPost 通过 Publisher public port 读取。

## API and UI

API 使用项目作用域并返回安全错误：

- `GET /api/v1/projects/:projectId/reviews/analytics`：项目 Review overview；
- `GET /api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/snapshots`：快照历史；
- `POST /api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/collect`：创建指标采集 Job；
- `POST /api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/analyze`：基于已有快照创建分析 Job；
- `GET /api/v1/projects/:projectId/reviews/analytics/posts/:externalPostId/reports`：报告历史。

Operator UI 增加项目级 Review Analytics 页面：先列出已确认的 ExternalPost，再展示快照表、最新报告和 Job 状态；按钮只触发 Job，不在浏览器执行采集或 AI。导航名称使用 `Review Analytics`，与 Approval Gate 保持明确区分。

## Error handling and safety

- 没有 ExternalPost、跨项目引用或空快照集合：`404/422`，不创建 Job；
- 同一幂等键和相同输入：返回既有 Job/结果；相同键但输入不同：`409`；
- Fake source 暂时不可用：可重试；结构校验、项目归属和 schema 错误：永久失败；
- AI 复盘只使用快照中已持久化的聚合数值，提示词记录非敏感输入哈希；
- 日志和 Job payload 禁止出现 credential、cookie、token、storage key 或完整平台响应。

## Testing and acceptance

验收必须覆盖：

1. Contract：指标边界、报告结构、schemaVersion 和非负整数校验；
2. Service integration：项目/ExternalPost 归属、快照幂等、报告追加和历史读取；
3. Worker：成功、可重试失败、永久失败、lease recovery、取消和重复执行；
4. API：五条 analytics 路由、错误码、项目隔离和 Job 返回；
5. Browser：从项目 Publisher 的 ExternalPost 进入 Review，采集 Fake 指标，生成报告并看到历史快照与建议；
6. Regression：既有 Approval、Publisher、Video、AI 和全量格式/typecheck/test 保持通过。

## Rollout gates

- 本切片默认只启用 `FAKE`/`IMPORT` source；真实平台 source 必须单独 ADR、授权和 live smoke gate；
- 在 Review Analytics 全量验收前，不启动真实抖音/视频号 metrics adapter；
- 若指标口径或跨模块边界改变，必须更新本设计、相关 ADR 和 architecture review。
