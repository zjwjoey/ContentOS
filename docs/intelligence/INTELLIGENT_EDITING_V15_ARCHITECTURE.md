# ContentOS Intelligent Editing V1.5 Architecture

状态：Core Closure 实现完成，待第二轮人工审查（2026-09-30）

- 基线：`origin/main` / `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6`
- 分支：`feature/contentos-intelligent-editing-v15`
- 工作树：`F:\ai剪辑\.worktrees\contentos-intelligent-editing-v15`
- Desktop V1：不修改、不导入、不共享运行时状态

## 1. 目标与边界

V1.5 将 ContentOS 的“素材可理解、可检索、可解释地编排”为一个增量能力层：

1. 对已存在的 `Asset` 建立可重试、可观测、可复用的媒体分析运行；
2. 将技术探测、镜头切分、关键帧、ASR、视觉标签和 Embedding 统一为带 provenance 的结果；
3. 为智能剪辑提供候选片段、排序分数、选择理由、多样性/重复率约束和质量评估；
4. 最终继续输出并校验既有 `EDIT_MANIFEST_V0`，通过现有 VideoService revision、Render Job 和 Video Worker 进入既有渲染链；不重写 Video Render 或已有 planner；
5. 为 AI provider 预留端口，Fake provider 默认可运行，真实 provider 只有在显式配置时启用。

本阶段不包含 Electron/Desktop V1 改造、不包含真实商业 provider 凭据、不改变现有 Random/Storyboard/Script planner 的默认行为，也不把新智能规划强行接入旧渲染链路。

## 2. 现有能力审计与复用边界

| 领域 | 当前实现 | V1.5 复用 | V1.5 新增 |
| --- | --- | --- | --- |
| Asset | `AssetService`、`AssetCatalogService`、`project_assets`、`video_workspace_assets`、安全的 READY 查询 | 资产归属、生命周期、storage key、metadata 和项目/工作区边界 | `media_analysis_runs` 等智能分析持久化表及查询服务 |
| 技术媒体信息 | Asset import/ffprobe、V3 media probe metadata | 现有 ffprobe 路径和归一化字段 | 将探测结果纳入分析运行的统一结果/provenance |
| 镜头检测 | `packages/modules/video/src/shot-detection.ts`、现有 `SHOT_DETECTION_V1` | 检测算法和短镜头合并逻辑 | 运行状态、版本、关键帧引用、失败/重试记录 |
| 视觉分析 | `visual-analysis.ts` 的 Qwen 适配器及 `AssetVisualProfileV3` | controlled tags、帧证据和 Qwen 端口思路 | 通用 `VisionProvider`、Fake provider、持久化分析结果 |
| 语义索引 | `semantic-index.ts` 的词法/向量混合检索和 Qwen Embedding 适配器 | 词法 fallback、cosine 评分、embedding adapter | 持久化 embedding 记录、模型/维度校验和 API 搜索 |
| Director/Storyboard | `DirectorV1Service`、Storyboard revision、Director worker | 脚本、分镜和批准边界 | 只读取已批准输入；不复制 Director 生成流程 |
| Video planners | `buildRandomMontageManifest`、`buildStoryboardVideoManifest`、Script planner | 原有 planner 作为显式模式，保留调用合同 | 新的 intelligent candidate/ranking layer，最后编译为同一 Manifest |
| Edit Manifest | `EDIT_MANIFEST_V0`、`VideoQuickEditService`、digest/idempotency | 作为唯一渲染输入和不可变 revision | 候选/理由/质量证据作为 planner 侧记录，不改 Manifest schema |
| Job/Worker | `JobService`、`JobRunner`、video/asset/director workers | durable job、lease、attempt、cancel、idempotency 语义 | 一个独立 `media-intelligence-worker`，注册 `MEDIA_ANALYSIS` |
| Web | Next App Router、项目资产页、Video/Manifest 页面 | 既有资产卡片、Manifest timeline、项目导航 | 分析状态、标签/语义搜索、候选解释页面或独立 panel |
| Desktop | `apps/desktop` / Desktop V1 worktree | 无 | 本阶段零修改、零 import、零数据库/存储共享 |

现有 `0023_auto_edit_v15` 是本地素材索引/缩略图和自动剪辑基础，不等于本需求的 Intelligent Editing V1.5；本实现不会复制它的索引和 planner，而是在其 Asset/Video 边界上添加媒体智能层。

## 3. 逻辑架构

```text
Asset READY
   |
   v
MEDIA_ANALYSIS job -> media-intelligence-worker
   |-- technical probe (ffprobe adapter)
   |-- shot detection + keyframe references
   |-- ASR provider (fake by default, real adapter later)
   |-- Vision provider (fake/Qwen adapter)
   |-- Embedding provider (fake/Qwen adapter)
   v
durable analysis records + provenance + searchable indexes
   |
   +--> semantic/material search API
   |
   +--> intelligent planner
           |-- candidates / scores / reasons
           |-- diversity / duration / repetition constraints
           |-- quality evaluator
           v
       existing EDIT_MANIFEST_V0 revision -> existing render/approval gates
```

所有 provider 只能通过端口进入业务层。worker 和 planner 不直接读取 API key；真实 provider 的启用、model、version、prompt/analysis version、timeout 和失败分类都写入 provenance 或运行配置。

## 4. 数据与契约设计方向

最终 migration 编号必须在编码前再次读取实际 `migrations/` inventory；当前远端基线最后为 `0046`，不能假定后续编号。

拟新增的 additive records：

- `media_analysis_runs`：asset、scope、requested capabilities、status、attempt、correlation/idempotency、started/finished/error、config snapshot；
- `media_analysis_technical`：duration、dimensions、fps、codec、container、audio tracks 和 ffprobe provenance；
- `media_analysis_shots`：run、asset、shot index、source in/out、confidence、detection version；
- `media_analysis_keyframes`：shot/run、timestamp、storage reference、frame hash、generation metadata；
- `media_analysis_asr_segments`：run、speaker、text、start/end、provider/model/version、confidence；
- `media_analysis_vision_results`：run/asset/shot、normalized tags/objects/summary/evidence、provider provenance；
- `media_analysis_embeddings`：entity、text snapshot、provider/model/dimensions/vector storage strategy、status；
- `intelligent_edit_plans`、`intelligent_edit_candidates`、`intelligent_edit_evaluations`：planner config version、source analysis run IDs、candidate reasons/scores、quality evidence，并引用生成的 Manifest revision。

所有表必须以 asset/project/workspace ownership 约束查询范围，分析结果 append-only 或版本化；重复请求通过 idempotency key 复用，不覆盖历史 provenance。

## 5. 阶段与门禁

### P0：Media Intelligence Foundation

- contracts、provider ports、Fake ASR/Vision/Embedding、配置快照；
- migration 和 durable analysis state；
- `MEDIA_ANALYSIS` job 与独立 worker；
- technical/shot/keyframe/ASR/vision/embedding 结果落库；
- 项目资产分析状态、标签过滤、语义搜索 API/Web；
- contract/unit/integration/worker/security tests。

Gate P0：Fake provider 完成一次可重试的完整分析；失败不污染旧结果；跨项目访问、无权 storage、错误 provider output 均被拒绝；worker 可重启恢复；Desktop diff 为空。

### P1：Intelligent Planner

- 从现有 Asset/分析结果读取素材；
- 生成候选、分数、理由、排名和 planner config version；
- 施加目标时长、片段时长、多样性、相邻重复、素材重复率约束；
- 保留 Random/Storyboard planner，intelligent 作为显式新模式；
- 输出并校验既有 `EDIT_MANIFEST_V0`；
- 质量 evaluator、解释 API/Web、回归测试。

Gate P1：同输入/config/version 可复现；候选和最终 Manifest 可追溯；旧 planner 测试不变；不存在越权素材或未 READY 素材。

### P2：Evidence / Presets / Recommendations

- 决策证据、preset/profile、推荐配置；
- 失败/低置信度原因展示和人工覆盖；
- 不改现有 Approval/Review 语义，保留人工 gate。

Gate P2：推荐可解释、可回放、可禁用；质量评估失败不会绕过人工批准；隔离与回滚验证完成。

## 6. 隔离与配置

V1.5 仅使用独立环境变量，不读取 Desktop 专用运行时目录：

- DB：`contentos_intelligence_dev` / `contentos_intelligence_test`；
- storage：`storage/intelligence-local`；
- temp/keyframes/cache/embedding：`storage/intelligence-temp`、`storage/intelligence-keyframes`、`storage/intelligence-cache`、`storage/intelligence-embeddings`；
- worker id/concurrency：`media-intelligence-worker-v15`、单独的 `CONTENTOS_INTELLIGENCE_WORKER_CONCURRENCY`；
- AI：`CONTENTOS_INTELLIGENCE_*` 配置，真实 provider 默认关闭；
- 测试：独立数据库 URL、独立 storage root、独立 artifact root。

所有路径必须通过 config 解析并进行 root containment 校验。Fake provider 是默认测试路径；没有 key 或没有显式 enable 时，真实 provider 只能返回配置缺失，不得偷偷外呼。

## 7. 不变量与风险

- 不修改 `apps/desktop`，不新增 Desktop import；
- 不改变既有 Asset lifecycle、Director approval、Video render、Approval gate 和 Review 边界；
- 只在新 worktree 开发；owner 工作树 `F:\ai剪辑\ContentOS` 只读保护；
- migration 运行前重新读取 inventory，并为每个新 migration 提供 down 文件；
- provider 输出必须 schema validate，未知 tag/entity 不能直接写入受控字段；
- 大媒体分析不可在 API 进程内执行，必须进入 durable Job；
- 所有查询按 project/workspace/asset ownership 过滤，不能通过 assetId 旁路访问；
- 运行失败 `76b4d59` 属于旧运行上下文，不能作为 V1.5 基线；本分支以当前远端 `c8d0dd4` 为唯一基线。
