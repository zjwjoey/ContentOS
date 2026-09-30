# ContentOS Intelligent Editing V1.5 Core Closure Plan

状态：`COMPLETED — READY FOR MERGE REVIEW`

本轮基线：`4a03544a754ac7eaf27a725f7f994ac42f88cbe2`

目标分支：`feature/contentos-intelligent-editing-v15`

本计划对应 V1.5 Foundation 的第二轮闭环，不扩展到 Desktop V1、P3、发布自动化或新的渲染器。完成条件是：一条真实视频能够通过已有 Job/Worker/FFmpeg 链路完成媒体分析、镜头级检索与规划、Manifest Revision 和真实 MP4 渲染，并保留可追溯的决策证据。

## 1. 现状与主要问题

### P0-A Worker Runtime

`workers/media-intelligence-worker` 目前只有 handler 注册组合，没有可运行的 `dev` 入口、数据库和配置加载、Job polling、lease reconciliation、优雅关闭或重启恢复。需要复用 `workers/video-worker` 的运行时模式，而不是引入第二套 Worker 抽象。

### P0-B/P0-C Real Media Analysis

`MediaIntelligenceService` 当前用 asset metadata 作为 technical provider 输入，用 `foundation-uniform-v1` 按约 5 秒均分 shots，并把 keyframe 写成 `REFERENCED` 数据行但不生成文件。仓库已有可复用能力：

- `packages/infrastructure/ffmpeg`：`probeMedia`、`generateRepresentativeFrames`、真实 `renderEditManifest`；
- `packages/modules/video/src/shot-detection.ts`：`detectShotsV1`，基于 FFmpeg scene change 并支持 AbortSignal；
- `workers/video-worker`：已有真实视觉分析、代表帧和 Shot Detection 的接线样例。

正式 pipeline 必须接入 source path、FFprobe、真实 shot detection 和每个 shot 的 JPEG keyframe；Fake provider 只留给测试。

### P0-D Semantic Retrieval

现有 `semantic-index.ts` 已有 embedding adapter、cosine 和 lexical 索引，但当前 Intelligence service 的 search 只对 summary/tags 做 `includes()`，且 embedding 没有 shot 绑定、input digest 或一致的维度校验。将抽取共享的 lexical/vector hybrid ranking，结果升级为 shot-level。

### P1 Planner/Manifest

当前 Planner 主要从 asset 和最近 vision 摘要构造候选，timeline 的 `sourceInMs` 固定为 0，`source_analysis_run_ids` 为空，Intelligent Plan 只有 JSONB manifest，没有实际 Video manifest revision 引用。候选必须从 `media_analysis_shots` 组装，保存 shot/range，且通过现有 `VideoService`、manifest revision、render job 和 Video Worker 继续渲染。

### P2 Evidence

现有 preset/recommendation 是基础 CRUD。需要新增 decision event 持久化与自动化 `RecommendationBuilder`，使用户从 Candidate A 换到 Candidate B 可记录 `SHOT_REPLACED`，并由 Plan quality + events 产生可审查建议。

## 2. 不变的复用边界

- 保留 `packages/modules/intelligence`、V1.5 contracts、`media_analysis_*`、`intelligent_edit_*`、`MEDIA_ANALYSIS` 和现有 Intelligence API/Web 页面；
- 保留 `EDIT_MANIFEST_V0`、`VideoService`、现有 manifest revision/approval/ownership 机制、Video Worker 和 FFmpeg renderer；
- 不修改 main 工作树，不修改 `feature/contentos-desktop-v1`，不 merge main；
- 已存在的 migration 0047–0049 视为已发布历史，采用 append-only migration；
- Intelligence 数据与主业务表存在跨表外键，因此 V1.5 使用同一 PostgreSQL database/schema 的 additive tables；隔离通过独立 worker、storage、temp、keyframe 和 embedding root 实现，不伪造一个不能满足外键约束的独立 database。

## 3. 迁移计划

开发前已重新读取 migration inventory，当前 0049 为最新。新增编号必须从实际工作树的下一个可用编号开始，并为每个 migration 提供 down 文件。预计内容：

1. media analysis closure：`source_checksum`、`pipeline_version`、`PARTIAL`/`STALE` 状态、可重试阶段字段，以及 ASR segment/Vision shot/embedding 的幂等约束；
2. embedding closure：`shot_id`、`input_digest` 与必要的 provider/model/dimension 约束；
3. planner closure：candidate `shot_id`、`source_in_ms`、`source_out_ms`，以及 intelligent plan 到现有 manifest/revision 的引用；
4. decision evidence：`editing_decision_events` 及其索引/外键；
5. 如现有表结构允许合并，将减少 migration 数量，但不修改 0047–0049。

每次新增 migration 后重新读取 inventory，并在 migration gate 中验证 up/down 与完整迁移链。

## 4. Contracts 与业务错误

补齐并在 service boundary 调用：

- vision result：summary、tags、objects、actions、location、shotType、cameraMotion、peopleCount、qualitySignals；
- embedding、keyframe、candidate、plan、preset、decision event validators；
- 对时间、confidence、summary、NaN/Infinity、dimension mismatch 和 source range 做拒绝式校验；
- embedding 保存 provider、modelVersion、dimensions、inputDigest，并可追溯到 shot；
- 统一 typed intelligence errors，至少覆盖 asset/run/provider-disabled/invalid-state/plan/shot 等错误；
- API 对 project、asset、plan、preset、recommendation 做 ownership 检查；search limit 用 zod 限制为有限正整数。

## 5. 分阶段实现顺序

### P0-A — Durable Media Intelligence Worker

仿照 Video Worker 实现 `createMediaIntelligenceWorker()`、`start()`、`consume()`、`shutdown()`：加载 config/database，创建 JobService、provider registry、MediaIntelligenceService 和 JobRunner；poll `MEDIA_ANALYSIS`；定期调用 `reconcileExpiredLeases`；在 SIGINT/SIGTERM 时停止 poll、等待 active jobs 并关闭数据库。增加 package `dev` script，确保直接启动入口不会抛出 composition-only 错误。

### P0-B/P0-C — Technical、Shots、Keyframes、Shot-aware providers

新增真实 FFprobe technical adapter，source path 由 storage root + asset storage key 安全解析并做 containment。新增 shot detector adapter，调用现有 `detectShotsV1`；删除生产路径均匀 5 秒 shots。以 shot midpoint 调用真实 FFmpeg 生成 keyframe，落在 configured keyframe root，成功为 READY、失败为 FAILED。ASR segment 按时间与 shot 做 overlap 查询；Vision 每个 shot 独立执行并持久化稳定 normalized contract；所有 provider 接收 AbortSignal。

### P0-D — Hybrid Shot Search

对 query 调用 embedding provider，对 current checksum/analysis version 的 shot candidates 加载 embedding，计算 cosine、lexical 和配置化 hybrid score，按 Top-K 返回 asset、shot、source range、semantic/lexical/total score、summary、tags。Fake provider 仅用于 unit/integration harness；real mode 在 disabled 时返回 `REAL_INTELLIGENCE_PROVIDER_DISABLED`，不得记录 REAL 却执行 Fake。

### P1-A — Shot Planner

从 shots、vision、ASR、embeddings 和 technical 数据建立 `IntelligentPlannerShot` pool。候选与 manifest 使用 shot 的 source range，duration 不得越过 shot 边界。排名包含 semantic、duration fit、quality、shot diversity、asset/shot repetition penalty；quality 包含 semantic match、duration fit、asset/shot repetition、shot type diversity、consecutive asset 和 coverage。source analysis run IDs 保存实际使用的 runs。

### P1-B/P1-C — Existing Video Domain and Real Render

通过现有 VideoService 的 ownership/revision/job API 创建 manifest revision，Plan 记录 manifest/revision reference 和 planner/analysis metadata；不新增 renderer。用真实 fixture videos 驱动 analysis → shot search → plan → manifest revision → render job → Video Worker/FFmpeg，最终以 ffprobe 验证 MP4、duration、1080x1920（或明确测试 canvas）、source ranges 和选中 shot 对应关系。

### P1-D — Minimal usable Web flow

在现有 Intelligence 页面复用布局，增加分析状态、shots/keyframes/summary/transcript、shot search、script sentences、planner、candidate/alternative、quality 和 render/preview 入口。候选替换必须调用 decision event API，至少支持选择 alternative candidate。

### P2-A/P2-B — Decision Evidence and Recommendations

增加 `SHOT_ACCEPTED`、`SHOT_REPLACED`、`SHOT_EXCLUDED`、`ASSET_EXCLUDED`、`DURATION_CHANGED` 事件，保存 plan/sentence/candidate/shot 前后引用及 evidence。实现规则型 `RecommendationBuilder`，基于 plan quality 和 events 生成 evidence-backed recommendation；preset domain service 自行校验 planner config。

## 6. Test Gates

### Unit/contract

验证 provider registry、real-disabled、technical/vision/embedding/keyframe validators、cosine+lexical hybrid、shot range、planner ranking、quality、idempotency key 和 recommendation rules。

### Integration/worker

覆盖 Worker polling、job completion、lease expiry/recovery、restart、cancel；corrupt video、no audio、no speech、short video、shot failure、ASR/Vision timeout、embedding failure、cancel during keyframe/ASR/Vision；验证 retry 不重复 shots/ASR/Vision/embeddings，checksum 变化后旧 run 为 STALE/不可作为 current。

### Real fixture/gold/vertical slice

生成包含明显红/蓝/绿场景变化的真实视频，验证 FFmpeg shot boundaries 和 JPEG 文件；用 deterministic semantic fixture 验证 query 的 Top-K；使用 entrance/product/customer shopping gold set 验证 Planner；真实 FFmpeg 验证最终 MP4。增加至少一个 browser vertical slice，真实 provider 不可用时使用 Fake provider，但保留真实 FFmpeg。

### Regression

运行 typecheck、format、lint、`test:intelligent-editing-v15`、auto-edit v1/v1.5、script-edit-v3、production-pipeline、migrations、Web build、root build 和 full `pnpm test`。若 esbuild 环境问题仍不能消除，Acceptance 明确写 `FULL TEST SUITE NOT VERIFIED`，不得写 ALL TESTS PASS。

## 7. 风险与处理

- 跨库外键：不拆独立 database，保留同库 additive tables；
- Windows path/FFmpeg：复用现有 spawn fallback、storage root containment 和 AbortSignal；
- 真实 AI provider 的网络/密钥：通过 provider registry 和 env config 注入，测试用 deterministic fake，不在业务 service 读取 key；
- 重试半成品：阶段性 upsert、稳定 ID/唯一约束和 source checksum 共同保证幂等；
- 旧 acceptance 文档过早标 PASS：在闭环完成前改为 `UNDER CORE CLOSURE`，最终只依据真实 gate 更新；
- Render 兼容性：只扩展现有 manifest contract，并使用现有 renderer，不引入第二套时间线语义。

## 8. 当前验收状态

`P0/P1/P2 CORE CLOSURE COMPLETE`，并完成 F0–F5 Final Closure 及 Candidate Replacement Transactional Integrity Closure。真实 FFmpeg fixture、Semantic Gold、Planner Gold、失败/取消/重试矩阵、同库 API→Worker gate、Candidate replacement revision、同事务回滚/并发/重复请求、隔离 Worker/API/Web/Video Worker 浏览器垂直切片均已通过。全仓库回归在独立 schema 中为 `289/289`，另行通过 production/auto-edit/script-edit gates。

当前状态：`REMOTE BRANCH READY FOR FINAL MERGE REVIEW`

本轮禁止 merge main。
