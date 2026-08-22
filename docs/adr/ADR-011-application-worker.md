# ADR-011: Director Application Worker

**Status:** Accepted with Conditions  
**Date:** 2026-08-22  
**Owners:** ContentOS Engineering  
**Related:** ADR-001, ADR-003, ADR-007, `WORKER_ARCHITECTURE_V0`, ECR-001

## Context

Director V1 需要生成 Script 和 Storyboard。AI 调用可能耗时、失败、限流或需要重试；将其放入 HTTP request handler 会违反现有的长时任务边界，也会让请求超时成为业务状态。Architecture V0 已定义 Video Worker 和 Publisher Worker，但尚未定义 Director 生成工作的进程归属。

## Decision

增加一个明确命名且独立受监督的 `workers/director-worker` Application Worker。它复用现有 `WorkerRuntime` 与 `JobService`，只注册以下两类 Job：

- `DIRECTOR_GENERATE_SCRIPT`
- `DIRECTOR_GENERATE_STORYBOARD`

Worker 通过 Director application port 读取和追加版本，通过 AI Provider contract 执行生成，通过 Job contract 更新 attempt、lease、结果和错误。它不导入 HTTP controller、Web UI、Video/Publisher/Review 私有实现，也不直接读写其他模块的私有表。

## Invariants preserved

1. PostgreSQL 仍是业务事实源，队列只负责 Job delivery；Job lease recovery、idempotency、cancellation 和 external-state reconciliation 仍是必经路径。
2. `Director -> Video -> Approval Gate -> Publish -> post-publish Review` 仍是固定应用流程；Director Worker 不创建工作流图，也不执行 Video、发布或 Review。
3. AI Provider、Prompt、Model Profile 和 AI Run 均通过公开合同追踪；凭据、Cookie、token、完整秘密 prompt 和媒体字节不得进入 Job payload 或普通日志。
4. 同一 Job 重试必须通过 `source_job_id`/幂等约束避免重复 Director revision；非法结构不得用默认字段伪装成功。

## Conditions and operational requirements

- Worker 必须作为独立进程运行，即使开发环境与 API 共用一台主机；监督器、健康检查、优雅停机和配置入口必须显式记录。
- 组合根缺少数据库、Provider、Job runtime 或必需配置时必须 fail closed，而不是启动一个不可执行的半配置 Worker。
- Provider 网络错误/限流等临时失败可重试；输入、认证、Prompt、结构校验等确定性错误必须归类并停止无限重试。
- 本 ADR 不批准真实 AI Provider、真实平台访问或通用 Agent/Workflow Engine；这些需要独立的证据和评审。

## Consequences

正面影响是 API 延迟与生成工作解耦，崩溃和重试遵循现有 Job 事实模型，Director 生成可审计且可扩展。代价是新增进程、监督配置、运行时测试和部署文档；这些是可接受的边界成本，不能通过把生成逻辑塞回 API 来规避。

