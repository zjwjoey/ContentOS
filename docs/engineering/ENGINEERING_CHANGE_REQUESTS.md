# Engineering Change Requests

本文件记录 Architecture V0 Freeze 之后会影响边界、进程模型或持久化不变量的工程变更。未被明确接受的请求不得进入实现。

## ECR-001 — Director Application Worker

| 项目 | 内容 |
|---|---|
| 状态 | ACCEPTED WITH CONDITIONS |
| 对应 ADR | ADR-011 |
| 提出原因 | Director AI 生成是长时、可重试的工作；API 请求处理器不能执行生成，也不能等待生成结果。 |
| 变更 | 增加受监督的 `workers/director-worker` Application Worker，只消费 `DIRECTOR_GENERATE_SCRIPT` 和 `DIRECTOR_GENERATE_STORYBOARD` 两类 Job。 |
| 不变更 | 模块化单体边界、固定 `Director -> Video -> Publish -> Review` 流程、PostgreSQL 业务事实源、Job lease/idempotency/cancellation/reconciliation 不变。 |
| 不包含 | 通用工作流引擎、Agent 平台、Video/Publisher/Review 私有逻辑、真实平台或真实 AI Provider 调用。 |

### 接受条件

1. Worker 必须复用现有 `WorkerRuntime`、`JobService`、attempt/lease/recovery 协议，并由独立进程监督。
2. Job payload 只能包含经过校验的 ID、版本和引用；不得包含凭据、Cookie、媒体字节或未验证的任意 UI payload。
3. Director Worker 只能通过 Director、AI 和 Job 的公开 application/contract 访问数据，不得读取或写入其他模块私有表。
4. Provider 错误必须映射为稳定的可重试/不可重试类别；每次尝试都保留可审计的 AI Run 和 correlation 标识，普通日志不得包含秘密或完整生成内容。
5. Worker 的启动组合根、监督方式和配置必须在工程文档与测试中明确；缺少必要依赖时 fail closed。

### 基线数据库隔离记录

Director 分支从 `main`（当前迁移至 `0005`）开始，而共享 `contentos_dev` 已包含 Publisher 分支的 `0006`。为避免跨分支复用迁移历史，Director 验证使用同一 PostgreSQL 16 实例上的逻辑数据库 `contentos_director_dev`；这不是新的 PostgreSQL 安装，也不替换共享数据库。

