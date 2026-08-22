# ContentOS Director V1 专业化设计

日期：2026-08-22
状态：待用户审阅
适用分支：`feature/slice-5-real-platform-adapters`

## 1. 目标与设计原则

Director V1 将 ContentOS 从“可保存的 Director Plan”推进为一条可追溯的内容策划链：

```text
ContentProject
  -> ContentBrief
  -> ScriptRevision
  -> StoryboardRevision
  -> approved Video Job
  -> Edit Manifest / Render
```

Director 决定内容说什么、结构是什么；Video 决定如何把已批准的内容和素材变成视频。Director 不调用 FFmpeg、不启动浏览器、不发布平台、不读取 Publisher 私有表，也不直接操作 Review 内部实现。

本设计遵循以下原则：

- PostgreSQL 是业务事实源，Job 只表达异步执行意图和执行状态。
- 创意记录和版本只追加，不覆盖历史；当前指针可以变化，但不能改变历史含义。
- AI 输出是不可信输入，必须通过结构校验、策略校验和 Director 接受后才能成为业务事实。
- Prompt、Model Profile、Provider 和 AI Run 是可追溯基础设施，不散落在业务代码中。
- 先验证工程闭环和专业工作流，再迭代文案质量；本轮不建设 Agent 平台。

## 2. 与现有实现的关系

现有 `DIRECTOR_PLAN_V0` 和 `director_plan_revisions` 已经提供了基础的 Brief/Storyboard 保存、版本和 Director 到 Video 桥接能力。它们不能被静默改造成新模型：已有记录必须仍可读取，已有 API 不能因新模型部署而失效。

V1 采用兼容演进：

1. 保留 `DIRECTOR_PLAN_V0` 合约和旧查询路径作为历史兼容层。
2. 新增独立的 `ContentBrief`、`ScriptRevision`、`StoryboardRevision` 事实记录及其正式合约。
3. 新的生成和 Video 桥接只使用新记录；旧 Plan 不自动伪装成 Script 或 Storyboard。
4. 若需要把旧 Plan 迁移为新记录，迁移必须是显式、可审计、可重复检查的转换，并保留 `legacy_plan_revision_id`。
5. 新模型稳定后，旧 API 只作为兼容读取/迁移入口，不再承载新的业务写入。

本轮不删除 `director_plan_revisions`，也不修改已渲染 Manifest 的来源含义。

## 3. 专业化 ContentBrief

ContentBrief 是生成输入事实，不是 Prompt 文本。最小正式字段如下：

| 字段 | 说明 |
|---|---|
| `id` | Brief ID |
| `project_id` | 所属项目 |
| `revision` | Brief 修订号；修订保留历史 |
| `topic` | 选题 |
| `target_platform` | 目标平台值，使用可扩展平台键，不在 Director 中硬编码平台行为 |
| `channel_positioning` | 账号/栏目定位快照，不读取 Publisher 私有 Account 表 |
| `target_duration_seconds` | 目标时长 |
| `content_type` | 商业分析、知识科普、故事等内容类型 |
| `audience` | 目标受众及其已知痛点 |
| `core_thesis` | 单一核心观点 |
| `tone` | 语气和表达风格 |
| `cta_goal` | 结尾行动目标，可为空 |
| `reference_material` | 用户提供的事实依据、素材引用或研究笔记；本轮不自动联网检索 |
| `must_include` | 必须出现的事实、观点或品牌信息 |
| `must_avoid` | 禁止表达、合规限制和敏感表述 |
| `requirements` | 有版本的扩展要求 JSON，不能承载秘密 |
| `created_at` / `updated_at` | 审计时间 |

`target_platform` 仅描述内容目标，不让 Director 直接依赖 Publisher 的账号、Cookie 或适配器。多平台变体不在本轮自动生成；不同平台需要显式创建独立 Brief 或后续的变体能力。

事实型选题必须允许用户提供参考材料。没有参考材料时系统可以生成草稿，但必须在 AI Run 和 UI 中明确“未提供事实依据”，不能把模型推测标记为已核实事实。

## 4. Script 与 Storyboard 事实模型

### ScriptRevision

Script 是被用户接受的文案事实，至少包含：

```text
id
project_id
brief_id
revision
parent_revision_id?
origin: AI | MANUAL | IMPORTED
status: DRAFT | ACCEPTED | SUPERSEDED
title
hook
body
cta?
source_job_id?
ai_run_id?
prompt_version_id?
created_by
created_at
```

AI 草稿和手工修改使用同一实体。手工修改必须产生新 Revision，不得 `UPDATE scripts SET body = ...` 覆盖历史。`parent_revision_id` 用于表达 V2 基于 V1 的关系。

### StoryboardRevision

Storyboard 必须绑定一个具体 `script_revision_id`，至少包含：

```text
id
project_id
script_revision_id
revision
origin: AI | MANUAL | IMPORTED
status: DRAFT | APPROVED | SUPERSEDED
scenes[]
source_job_id?
ai_run_id?
prompt_version_id?
created_by
created_at
```

Scene V0 保持简单：

```json
{
  "scene_index": 1,
  "voiceover_text": "这里是旁白",
  "duration_hint_seconds": 4.5,
  "visual_instruction": "展示商场或门店客流",
  "asset_keywords": ["门店", "顾客", "商场"]
}
```

Scene 不增加镜头、灯光、镜头焦段、演员、3D 或 AI 视频 Prompt。Storyboard 是 Script Revision 的派生创作记录；脚本修改不会改变旧 Storyboard，新的 Storyboard 必须明确基于新的 Script Revision 生成。

### 当前版本与接受规则

Director 维护明确的当前 Script Revision 和当前 Storyboard Revision 关系，或使用等价的 Director-owned current pointer；不得同时维护多个互相矛盾的“当前版本”来源。只有 `ACCEPTED` Script 和 `APPROVED` Storyboard 才允许创建 Director→Video Job。Storyboard 的批准必须验证它对应的 Script Revision 仍然存在且未被替换为另一条来源。

## 5. AI Provider、Prompt 与 AI Run

AI 模块只暴露冻结的 Provider Contract：

```text
supports()
generateText()
generateStructured()
streamText()  // 本轮可以不用于 Director 业务
```

Director 不导入任何供应商 SDK，也不写死模型名称。`director.copy` 和 `director.storyboard` 是两个 Model Profile key，实际 provider、model、temperature、最大输出和超时由 AI 模块配置解析。

Prompt 必须进入不可变 Prompt Registry：

```text
director.script.v1
director.storyboard.v1
```

每次 AI Run 至少记录：

```text
ai_run_id
project_id
job_id
attempt_id
provider
model
model_profile
prompt_key
prompt_version
prompt_hash
input_hash / bounded input snapshot
output / bounded output snapshot
started_at
finished_at
status
normalized_error?
usage?
```

AI Run 是生成证据，不是当前文案事实源；`ScriptRevision` 和 `StoryboardRevision` 才是业务事实。普通日志只记录 ID、Prompt key/version/hash、provider/model profile 和错误类别，不打印完整 Prompt、完整用户草稿或秘密。AI Run 的访问和保留策略必须遵守现有安全与数据保留规则。

所有输入和输出都必须有长度限制。Storyboard 使用 `generateStructured()` 和显式 schema 校验；非法结构可进行有限、可记录的 repair/retry，仍失败则 Job 失败，禁止补默认字段伪装成功。

## 6. Job 与 Worker

新增且只新增两个 Job 类型：

```text
DIRECTOR_GENERATE_SCRIPT
DIRECTOR_GENERATE_STORYBOARD
```

请求 API 只创建 Job 并返回 `job_id`，不等待 AI 生成。Job payload 仅包含 project、brief/script revision、prompt/model profile、correlation 和幂等引用，不包含 API Key、Cookie、媒体字节或未经验证的任意 UI payload。

当前架构没有 Director AI Worker，而 API 不能执行长时间生成。因此在实现前必须提交一个 Engineering Change Request，明确增加轻量 Application/Director Worker 进程。该 Worker 只消费 Director Job，不新增通用 Agent Engine，也不承载 Video、Publisher 或 Review 私有逻辑。

每次处理必须满足：

- 同一 Job 重试不会重复创建同一 Script/Storyboard Revision；使用 `source_job_id` 或等价唯一约束。
- Provider 网络错误、限流和临时服务错误可重试。
- 输入无效、Prompt 不存在、结构校验失败和权限/认证错误按错误架构分类，不能无限重试。
- Job attempt、AI Run、Script/Storyboard 和最终错误都携带 project/job/attempt/correlation 标识。
- Worker 崩溃后由现有 Job lease recovery 恢复，不依赖队列单独保存业务事实。

## 7. API 与 Operator UI

API 路由仍由 Fastify 控制器负责参数解析和用例调用，不直接读写 Director 表。推荐的正式入口为：

```text
POST /api/v1/projects/:projectId/director/brief
POST /api/v1/projects/:projectId/scripts/generate
GET  /api/v1/projects/:projectId/scripts
GET  /api/v1/scripts/:scriptId
POST /api/v1/scripts/:scriptId/revisions
POST /api/v1/scripts/:scriptId/storyboards/generate
GET  /api/v1/projects/:projectId/storyboards
GET  /api/v1/storyboards/:storyboardId
POST /api/v1/storyboards/:storyboardId/approve
```

兼容现有 Director Plan API 的时间和迁移边界必须在 API 设计中明确，不能让同一个 URL 同时返回两种无法区分的实体。

现有 Web package 目前只有壳，因此 Stage 6 定义为最小 Operator UI，而不是最终产品设计。页面只需要提供：

- Brief 表单和事实依据提示。
- Script 版本列表、版本对比、接受和手工产生新 Revision。
- Storyboard 普通列表、来源 Script 版本和批准操作。
- 复用 Job 状态：Queued、Running、Succeeded、Failed。
- 展示 provider/model/prompt version 等 provenance，但不展示凭据或完整内部错误。
- 进入 Video 时明确显示所选 Script、Storyboard、Voice Asset 和 Video Assets。

本轮不实现拖拽分镜编辑器、复杂时间线、Prompt Marketplace 或工作流搭建器。

## 8. Director → Video 集成

Video 继续使用现有 `VIDEO_RENDER` Job 和 `EDIT_MANIFEST_V0`。Director 只通过正式 Video application contract 请求 Job，不能调用 Worker handler。

Director Video 请求必须携带：

```text
project_id
script_revision_id
storyboard_revision_id
voice_asset_id
video_asset_ids
random_seed
```

Video Planner V1 仍可以使用随机素材规划；本轮不要求 Storyboard 真正决定每个素材镜头。但上述 Script/Storyboard ID 必须进入 Video Job payload、Render metadata 和 Edit Manifest metadata，使最终 Render 能反向追溯：

```text
Render
 -> Manifest
 -> StoryboardRevision
 -> ScriptRevision
 -> ContentBrief
 -> ContentProject
```

Video 只能消费已批准的版本。切换版本会创建新的幂等 Video Job，不修改已完成 Render 的来源。

## 9. 错误、安全与人工验收

AI 错误统一映射为现有 Error Architecture 可识别的类别，至少覆盖：

```text
AI_PROVIDER_UNAVAILABLE
AI_RATE_LIMITED
AI_AUTH_FAILED
AI_STRUCTURED_OUTPUT_INVALID
AI_REQUEST_FAILED
```

API Key、访问令牌、Provider 原始异常、完整 Prompt 和未经处理的 Provider 响应不得进入日志、Job payload、前端响应或普通业务记录。AI Run 只保存架构允许的受控证据。

自动测试之外，必须人工验收三个不同内容类型：

1. 商业分析：检查事实依据提示、观点明确性和 CTA。
2. 知识科普：检查结构、时长和中文表达。
3. 剧情/故事：检查 Hook、节奏和场景可执行性。

本轮不以“文案优秀”作为通过条件，但必须将 Hook 平淡、表达过度 AI 化、分镜机械、节奏问题和画面建议空泛记录到 `DIRECTOR_QUALITY_BACKLOG.md`，而不是无限调 Prompt。

## 10. 测试与 Stage Gates

按以下顺序实施和验收，每一阶段失败即停止向后扩展：

1. Domain：Brief、Script、Storyboard schema、版本、父版本和状态转换。
2. AI Provider：Fake Provider、Provider Contract、错误归一化和 bounded input/output。
3. Prompt：Registry、版本、变量完整性和稳定 hash。
4. Job：两个 Director Job、幂等、重试、lease recovery 和 AI Run provenance。
5. API：创建 Brief、生成 Job、查询/接受 Script、生成/批准 Storyboard、非法输入和 Provider 失败。
6. Web：Operator UI 的状态、版本和追溯展示。
7. E2E：Project → Brief → Script → Storyboard → Voice/Video Assets → Video Job → Manifest → FFmpeg Render。

测试分层如下：

- Unit：版本计算、schema、Prompt rendering、错误映射。
- Contract：AI Provider、Script、Storyboard 和 Video bridge contract。
- Integration：PostgreSQL 持久化、AI Run、Job handler、版本选择和 migration。
- API：Fastify 端点、错误响应和幂等。
- E2E：至少一条完整 Director→Video 链。
- Sandbox：少量真实 Provider 请求；没有凭据时明确记为 BLOCKED，不伪造 PASS。

## 11. 明确不做与停止条件

本设计不包含：热点抓取、竞品监控、爆款数据库、自动联网研究、评论分析、复盘反哺、多 Agent、统一 Agent Engine、TTS、AI 视频生成、智能素材匹配、自动发布、复杂 Prompt 工作台和多平台自动变体。

当以下产物和验证完成后立即停止：

- Director V1 实现报告。
- AI Provider/Prompt/Job/API/Web/Director→Video 各 Gate 结果。
- 真实 Provider Sandbox 结果或明确 BLOCKED 原因。
- Architecture Deviations / Engineering Change Request 结果。
- `DIRECTOR_QUALITY_BACKLOG.md`。

下一轮只基于真实结果选择 TTS 或 Publisher Product Slice，不在本轮自动扩展。

## 12. 实施前必须冻结的决策

在写 implementation plan 前必须确认：

1. Publisher 功能分支是否先合入 `main`，Director 工作从哪个基线分支开始。
2. Application/Director Worker 的进程命名、监督方式和 Engineering Change Request 编号。
3. 旧 `DIRECTOR_PLAN_V0` 的兼容读取和显式转换策略。
4. AI Run 的输入/输出保留范围与访问权限。
5. 第一个真实 Provider 和 Sandbox 凭据配置方式。

在以上五项没有明确结果前，不开始数据库迁移、Provider SDK 安装或 Web 页面实现。
