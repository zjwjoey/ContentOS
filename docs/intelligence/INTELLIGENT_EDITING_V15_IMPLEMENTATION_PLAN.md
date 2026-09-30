# ContentOS Intelligent Editing V1.5 Implementation Plan

基线：`c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6`  
分支：`feature/contentos-intelligent-editing-v15`  
原则：每个阶段独立提交并通过门禁后才进入下一阶段；不合并 `main`，最终只推送功能分支。

## Phase 0 — Audit / Baseline

已完成审计：

- 远端已 `fetch --prune`，实际 `origin/main` 为 `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6`；
- owner 工作树保持原状，仅有既有 `?? local-media/`；
- 新建独立 worktree，不修改 Desktop/V1、V3 或其他 worktree；
- 已盘点 Asset、Director/Storyboard、Video planner、`EDIT_MANIFEST_V0`、Job/Worker、DB migration 和 Web 路由；
- 已确认仓库已有 `0023_auto_edit_v15`、V3 visual analysis/shot detection/semantic index；本需求以复用为主，不复制已有功能。

Phase 0 输出：本文件及 `INTELLIGENT_EDITING_V15_ARCHITECTURE.md`。

## Phase 1 — Contracts / Configuration / Fake Providers

### 1.1 Contracts

- 新增独立 V1.5 contracts 文件，不修改旧 V0/V3 语义；
- 定义 analysis run、technical metadata、shot/keyframe、ASR segment、vision result、embedding record；
- 定义 planner candidate/reason/ranking/evaluation、preset/profile 和 API response；
- 为每个 contract 提供运行时校验、枚举限制和 unknown-field 策略。

### 1.2 Provider ports

- `TechnicalMediaProvider`：复用现有 ffprobe 边界；
- `ShotDetectionProvider`：适配现有 detector；
- `ASRProvider`、`VisionProvider`、`EmbeddingProvider`：端口与实现分离；
- Fake providers：确定性、无网络、可注入失败/超时/空结果；
- Qwen/后续真实实现只通过 adapter 接入，默认 disabled，记录 provider/model/version/prompt/analysis version。

### 1.3 Isolation config

- 增加 `CONTENTOS_INTELLIGENCE_*` 配置解析；
- 默认 DB/storage/temp/cache/embedding/artifact 路径全部带 intelligence 标识；
- config tests 验证不读取 Desktop 路径、路径 containment、真实 provider 默认关闭。

提交建议：`feat(intelligence): add v15 contracts and provider ports`。

## Phase 2 — P0 Durable Media Intelligence

### 2.1 Database

在重新读取 migration inventory 后使用下一个未占用编号，新增 up/down migration。迁移内容包括 analysis run、technical、shots、keyframes、ASR、vision、embeddings 及必要索引/ownership checks。不得重复创建 `local_media_index`、`asset_visual_profiles` 或 V3 已有表。

### 2.2 Services

- `MediaIntelligenceService`：创建/读取/取消/重试运行，幂等 key 和状态转换；
- result repository：按 run/version 保存，按 asset/project 查询；
- search service：复用既有 lexical/cosine 逻辑，增加持久化 record 和 scope filtering；
- analysis orchestrator：按能力执行 provider，单项失败可记录，不伪造成功。

### 2.3 Worker and API

- 新增 `workers/media-intelligence-worker`，只处理 `MEDIA_ANALYSIS`；
- 使用现有 JobRunner/lease/attempt 语义，但 worker id、并发、storage/cache 独立；
- API：创建分析、读取状态/结果、重试、取消、素材搜索；
- API 只校验和入队，不执行长时分析。

### 2.4 Web

- 在既有项目素材边界增加分析状态、标签/镜头摘要、语义搜索入口；
- 复用 Asset card、项目导航和状态组件；
- 不重做素材库，不复制现有 V3 编辑页面。

### 2.5 P0 gate

- contract/unit/provider tests；
- migration matrix 和 isolated integration DB；
- worker success/retry/cancel/lease-expiry/idempotency tests；
- API ownership、invalid payload、provider disabled tests；
- Web route/component tests；
- `pnpm typecheck`、格式/lint、相关测试全部通过；
- git diff 确认 Desktop 目录零修改。

提交建议：`feat(intelligence): add durable media analysis foundation`。

## Phase 3 — P1 Intelligent Planner

### 3.1 Planner input

- 接收 project/workspace、approved script/storyboard（如使用）、analysis run/version、duration/profile/config；
- 只读取 READY 且有权属的 Asset；
- 复用现有 sentence segmentation、shot/visual/semantic search，不重写检测器。

### 3.2 Candidate and ranking

- 生成每个句子/场景的候选片段；
- 记录 duration fit、semantic match、visual fit、quality、recency/repetition、manual lock 等可解释分项；
- 版本化权重和 diversity/repetition policy；
- 稳定 tie-breaker，确保同输入可复现；
- 输出候选、选择和未选择原因。

### 3.3 Manifest and evaluator

- 通过现有 `VideoQuickEditService` 或其 additive facade 创建 `EDIT_MANIFEST_V0` revision；
- 不添加第二套渲染 manifest；
- 质量 evaluator 检查覆盖率、时长、相邻重复、素材重复率、来源完整性和 provider confidence；
- evaluator 结果不能绕过 Approval gate。

### 3.4 P1 gate

- planner contract/unit/property-like deterministic tests；
- old Random/Storyboard/Script planner regression suite；
- candidate/evidence persistence integration tests；
- manifest validation and ownership tests；
- API/Web explanation tests；
- full typecheck and targeted integration/e2e tests。

提交建议：`feat(intelligence): add explainable intelligent planner`。

## Phase 4 — P2 Evidence / Presets / Recommendations

- preset/profile CRUD 或只读内置 profiles，带 schema/config version；
- 记录 recommendation inputs、alternatives、confidence、limitations；
- 支持人工锁定/替换并重新评估；
- 建立质量反馈和 replay fixture；
- 默认不自动发布、不绕过 Approval/Review。

提交建议：`feat(intelligence): add decision evidence and presets`。

## Phase 5 — Final Acceptance

最终新增 `docs/intelligence/INTELLIGENT_EDITING_V15_ACCEPTANCE.md`，填写：

- base/head SHA、分支、worktree、远端分支；
- 每个 commit、migration up/down 文件；
- P0/P1/P2 gate 结果；
- typecheck/lint/format/unit/integration/e2e 命令及实际结果；
- provider 配置和 Fake/real 行为；
- DB/storage/temp/cache/worker 隔离证明；
- Desktop diff/import 检查；
- 已知限制、未完成项和后续 AI 接口配置说明。

验收后只执行 `git push -u origin feature/contentos-intelligent-editing-v15`，核对本地 HEAD 与远端分支 SHA 一致，报告 `REMOTE BRANCH READY FOR REVIEW`。禁止在本任务内合并 `main` 或删除功能分支。

