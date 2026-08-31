# ContentOS Product V1 Gap Audit

日期：2026-08-31  
基线：`origin/main@9a6886e`（PR #4 已合并）  
审计范围：`apps/web`、`apps/api`、`packages`、`workers`、`migrations`、`tests` 及 Architecture V0 / Product V1 文档。

## 结论

当前主线已经具备可运行的 Project → Director → Video → Approval → Fake Publisher 基础链路和 Standalone Quick Edit，但还不是本任务要求的“普通用户只通过浏览器完成 Project → Director → Benchmark → Storyboard → Assets → Video → Approval → Publisher → Review”的完整产品闭环。

## 分类标准

- **SUPPORTED**：已有公开 Contract、API/UI 和自动化证据，普通用户可操作。
- **PARTIAL**：已有部分能力，但缺关键字段、页面、状态、历史版本或验收路径。
- **MISSING**：当前主线没有可用的产品能力。
- **DEFERRED**：本轮明确不做，保留架构边界，不作为缺陷修复。

## 能力矩阵

| 能力 | 状态 | 现有证据 | 本轮缺口 |
|---|---|---|---|
| Project Center | PARTIAL | `/projects/:id` 聚合页、阶段卡、健康度、Jobs | 创建/编辑归档、搜索、状态/日期筛选、计划字段、下一步和错误处理的完整入口 |
| Content Plan | MISSING | Project 只有 name/status/metadata | 最小列表、planned date、topic/platform/account/status 筛选 |
| Director | PARTIAL | Director V1 Brief、Script/Storyboard append-only revisions、Fake AI Jobs | Brief UI 缺 duration/content type/tone/keywords 等完整编辑；Script/Storyboard 缺历史选择、人工 scene 编辑/新版本和统一审批 |
| Benchmark | MISSING | 无 benchmark 表、Contract、API 或页面 | BenchmarkAccount/Content/Analysis、项目引用及 AI 分析 |
| Script | PARTIAL | AI 生成、手工 revision、接受状态 | UI 编辑字段、历史版本选择、精确 Approval Gate |
| Storyboard | PARTIAL | AI 生成、场景展示、批准 | 人工编辑新版本、历史选择、Planner 可消费的批准版本入口 |
| Assets | PARTIAL | 单文件上传、Asset Worker、READY/FAILED、预览 | 多文件/音频图片闭环、标签/分类/备注、搜索/类型/标签筛选 |
| Video Planner | PARTIAL | Random Planner V2、Edit Manifest、Adjustments | StoryboardVideoPlanner、关键词评分、deterministic fallback、UI 选择器 |
| Video Adjustment | SUPPORTED | TRIM/REMOVE/REORDER/REPLACE/REROLL、immutable revisions、历史只读 | 产品字段显示和错误反馈仍需收口 |
| Render | SUPPORTED | Durable Job、FFmpeg、状态轮询、输出预览 | 与 Storyboard Planner 统一验收 |
| Approval | PARTIAL | Render/Publish exact revision Approval Gate | Script/Storyboard Approval 统一进入 Approval 页面并支持历史/拒绝理由 |
| Publisher | PARTIAL | Fake Account、Request/Revision/Attempt/ExternalPost、重试/人工/未知状态 | UI 仍暴露内部 ID；真实配置/账号/session/preflight 入口不足 |
| Accounts | PARTIAL | Fake account CRUD 和模拟结果 | 真实 Adapter 配置状态、认证状态、人工处理入口 |
| Review | PARTIAL | Review 决策模块仅用于旧的发布前决策；Review Analytics 未在 main | Metric Snapshot、手动录入、趋势、AI Review、历史报告与项目引用 |
| Metrics | MISSING | main 无 Review Analytics migration/API/UI | append-only Snapshot、来源和可靠性 |
| AI Provider | PARTIAL | Provider Contract、Fake Provider、Prompt Registry、AI Run 证据 | 至少一个真实文本 Provider、配置状态、模型注册、Script/Storyboard/Benchmark/Review 路由 |
| Operator UI | PARTIAL | Shell、项目导航、Assets/Director/Video/Approval/Publisher、Quick Edit | Benchmark/Review/Plan/Dashboard/Settings 页面，统一中文操作和非 ID 主流程 |
| Jobs | SUPPORTED | Job/Attempt/lease/retry/cancel/reconciliation、各 Worker | 新 Benchmark/Review/Planner 操作接入既有 durable Job |
| Settings | MISSING | 无设置页面或 runtime health 聚合 | AI/Publisher/Runtime health，禁止泄露 secrets |

## 明确 Deferred（本轮不实现）

AI Vision、Embedding、Vector DB、大规模平台抓取、复杂社交爬虫、多轨编辑器、Canvas/WebGL、Waveform、Voice Cloning、TTS 必选链路、Remotion 主渲染迁移、微服务/Kubernetes、多租户、权限系统、复杂 BI、A/B Testing、自动热搜、自动竞品监控、自动真实发布点击。

## 实施优先级

1. 先补最小 Product/Benchmark/Review/AI contracts 和持久化边界。
2. 再补 Benchmark、Director 完整编辑、Asset 标签、Storyboard Planner。
3. 统一 Approval/Publisher/Review UI，并补 Dashboard、Content Plan、Settings。
4. 最后用隔离 Fake E2E 覆盖完整链路、失败状态和历史版本，再执行最终 Gate。

## 复审更新（2026-08-31）

上表记录的是本轮开始时的审计基线，不应继续被当作当前实现状态。复审后已确认以下项目已经落地并有当前证据：

- Project Center、Content Plan、Benchmark、Review Analytics、Settings 已有 project-scoped/API-backed 页面。
- Director V1 的 Brief、Script/Storyboard Job、revision、审批和 Benchmark reference 已接通；Storyboard Planner 已具备 deterministic 关键词评分与 fallback。
- Assets 支持多文件视频/音频导入、READY/FAILED、预览、标签编辑以及类型/标签筛选。
- Publisher Fake 闭环覆盖成功、重试、人工处理和未知外部状态 reconcile；真实 Adapter 默认受 feature flag 保护。
- Benchmark 空 URL 严格校验、Quick Edit 多镜头浏览器路径和 Publisher 页面安全字段已在 `770d4ae`、`e34e703` 修复。
- 当前验证证据：浏览器 3/3、单元/集成/契约 229/229、Publisher/真实 Adapter 收口门禁 29/29、迁移矩阵 8/8、doctor 全部 PASS，typecheck/lint/format/build 全部 PASS。

仍需在产品级收口前单独复核的范围：真实 Provider 在配置凭证后的人工 preflight，以及封面素材是否需要平台特定的尺寸/格式策略。Publisher hashtags、cover Asset 引用和 schedule 已进入公开 Contract、API、持久化迁移 `0021`、Worker snapshot 与 Adapter 文案；Worker 现在会将项目内 READY 封面解析为 `coverPath/coverSha256` 后交给 Adapter，且 cover 引用现在还会校验当前项目归属和 READY 状态。Project 编辑/归档和 Storyboard 场景人工编辑/历史 revision 入口也已具备。Fake、迁移、FFmpeg 和本地构建门禁已不再是当前阻塞项。
