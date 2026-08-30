# Director Operator Stabilization Design

日期：2026-08-22
范围：ContentOS Director Operator 本地可运行化
分支：`codex/director-v1`

## 目标

把 Director V1 从“API、Worker 和 Web 可以分别测试”推进到“开发者执行一个命令即可启动并完整操作”的本地闭环：创建项目、填写合法 Brief、提交 Script Job、由 Fake AI Director Worker 执行、Web 轮询 Job 并显示 Script，再继续到 Storyboard。

Publisher、真实 AI、真实平台账号、抖音/视频号外部调用不属于本次范围。

## 设计

### 启动与模块边界

API、Web 和 Director Worker 仍是三个独立进程。API 只处理 HTTP、迁移和入队；Web 只调用 API；Worker 只消费 `DIRECTOR_GENERATE_SCRIPT` 和 `DIRECTOR_GENERATE_STORYBOARD`。本地开发增加 Fake AI 组合根，生产 Worker 仍要求显式依赖并在缺少依赖时 fail-closed。

根目录提供 `pnpm dev:operator`，负责为三个进程注入本地默认端口和开发配置，并在终止时回收子进程。迁移目录不再依赖启动命令的当前工作目录，而由数据库包解析固定的仓库迁移目录或显式迁移目录配置。

### Durable Job 执行

Job 模块新增按 Job 类型查询可执行 Job 的公开方法；Worker 不直接读取 `jobs` 私有表。Director Worker 轮询公开 Job 查询，调用既有 `JobRunner` 完成 claim、lease、attempt、成功/失败和幂等处理。轮询只领取 Director 的两类 Job，不改变现有 WorkerRuntime 边界。

### Operator UI

项目列表提供创建项目表单。Director Brief 表单显式包含平台、栏目定位、受众、观点、事实依据、必须包含、必须避免和 CTA 等契约字段；多行列表输入转换为数组。提交失败显示 API 的安全错误摘要。

提交 Job 后，页面按短间隔读取 `/api/v1/jobs/:jobId`，到 `SUCCEEDED` 或 `FAILED` 终止轮询；成功刷新 Script/Storyboard，失败展示状态、尝试次数和错误摘要。页面卸载和终态都清理定时器。

### 测试数据隔离

自动化测试继续使用独立测试数据库；本地 Operator 使用单独的开发数据库 URL。AI model profile 断言以 Provider + Model 的稳定身份为准，不假设一次运行中数据库记录 ID 一定等于请求 profile ID。每个集成 fixture 清理自己创建的项目、Job、Attempt、AI Run 和版本记录。

## 错误与安全

- Zod 输入错误返回 422 `DIRECTOR_VALIDATION_ERROR`。
- 项目不存在返回 404 `DIRECTOR_PROJECT_NOT_FOUND`。
- 状态/幂等冲突返回 409。
- Worker 错误通过既有 Job 错误 envelope 保存，不把 token、cookie、授权头、文件路径或原始 provider secret 写入 UI、Job payload 或普通日志。
- API 不执行 AI；请求处理器不运行长任务。

## 验收标准

1. 从仓库根目录执行 `pnpm dev:operator`，API、Web、Director Worker 都可启动。
2. 首页可以创建项目并进入 Director。
3. Brief 表单可以提交包含/避免列表，服务端返回 201。
4. Script Job 经历 `QUEUED -> RUNNING -> SUCCEEDED`，页面自动显示 Script revision。
5. 非法 Brief 返回 422 且 UI 显示具体字段问题。
6. Worker 只处理两类 Director Job，重复投递不会重复创建版本。
7. 迁移从根目录、`apps/api` 目录启动均能找到同一套迁移。
8. 全量测试、格式检查、lint、typecheck、根构建、Web 构建和真实本地预览通过。

## 非目标

不增加 Publisher 业务记录、不接真实 Provider、不实现真实平台适配器、不加入时间线/工作流图、不引入通用工作流引擎。
