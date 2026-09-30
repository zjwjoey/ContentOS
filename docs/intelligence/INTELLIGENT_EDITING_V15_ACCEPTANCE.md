# ContentOS Intelligent Editing V1.5 Acceptance

状态：`READY FOR SECOND REVIEW`
验收时间：2026-09-30  
基线：`origin/main` / `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6`  
分支：`feature/contentos-intelligent-editing-v15`  
工作树：`F:\ai剪辑\.worktrees\contentos-intelligent-editing-v15`

## 1. Scope result

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| Phase 0 audit | PASS | Architecture / Implementation Plan 已提交 |
| P0 Foundation | PASS | Worker 已可启动/轮询/租约恢复/优雅关闭；FFprobe、FFmpeg scene detection、JPEG keyframe、checksum/stale、shot-level ASR/Vision/Embedding 接口均有真实 fixture 证据 |
| P1 Planner / Manifest / Render | PASS | analysis → shot-level planner → existing Video manifest revision → render job → Video Worker → 1080x1920 H.264/AAC MP4 vertical slice 通过 |
| P2 Evidence / Recommendation | PASS | `SHOT_REPLACED` decision event 可持久化，RecommendationBuilder 基于 plan quality + events 生成可审查证据 |
| Desktop independence | PRESERVED | 本分支未修改 `apps/desktop`，新增代码无 Desktop import |

既有 Random/Storyboard/Script planner、Asset Catalog、V3 visual analysis/shot detection/semantic index 和 `EDIT_MANIFEST_V0` 均被复用；没有为完成需求复制一套旧功能，也没有修改 Desktop V1。

## 2. Commits

- `c16bf0a` — `docs(intelligence): define v1.5 architecture and plan`
- `404871e` — `feat(intelligence): add durable media analysis foundation`
- `3befdeb` — `feat(intelligence): add explainable intelligent planner`
- `f3000cf` — `feat(intelligence): add decision evidence and presets`
- `6428e41` — `docs(intelligence): plan v1.5 core closure`
- `cf5e87b` — `fix(intelligence): close media analysis runtime and real providers`
- `8a76e24` — `feat(intelligence): plan edits from analyzed shots`
- `9aff1dd` — `test(intelligence): close v1.5 analysis and decision gates`
- `cb5ba8a` — `feat(intelligence): wire render and configurable AI adapters`
- `待提交` — Worker stale-run recovery, latest-analysis selection and configured embedding wiring

## 3. Database migrations

- `0047_intelligent_editing_v15.sql` / `.down.sql`
  - durable analysis runs, technical results, shots, keyframe references, ASR, vision and embeddings;
- `0048_intelligent_edit_plans.sql` / `.down.sql`
  - intelligent plans, candidate rankings/reasons/features and quality evaluations;
- `0049_intelligent_edit_decisions.sql` / `.down.sql`
  - presets and reviewable recommendations.
- `0050_intelligent_editing_core_closure.sql` / `.down.sql`
  - checksum/pipeline status, stage idempotency, normalized shot intelligence, embedding provenance, shot candidates and decision event table.
- `0051_intelligent_edit_render_reference.sql` / `.down.sql`
  - intelligent plan render job reference.

迁移前重新读取 inventory，基线最后原有 migration 为 `0046`，本分支使用 `0047`–`0049`。在隔离 schema `intelligence_v15_test` 中全量 up（49 migrations）、latest down/up 和相关集成测试均通过。

## 4. Test evidence

已验证：

- `corepack pnpm test:intelligent-editing-v15`：11/11 passed；含真实 FFmpeg shot detection、真实 JPEG keyframe、analysis/planner/render vertical slice、decision evidence、Worker polling/restart/cancel；使用隔离 schema `intelligence_v15_test`。
- `corepack pnpm test:production-pipeline`：12/12 passed。
- `corepack pnpm test:migrations`：9/9 passed；含完整 migration chain、latest down/up 与历史边界。
- `corepack pnpm typecheck`、`corepack pnpm build`、`corepack pnpm format`、`corepack pnpm lint`：全部通过。
- `apps/web/node_modules/.bin/next build apps/web`：通过，包含 `/projects/[id]/intelligence` 页面编译。
- 独立 Worker 启动：输出 `status=READY`、注册 `MEDIA_ANALYSIS` handler。
- `git diff --check`：通过。

全仓库 `corepack pnpm test` 已执行但不能作为通过项：仓库既有大部分数据库集成/e2e 测试硬编码连接 `127.0.0.1:55432`，当前环境该端口未启动，结果为 110 个环境连接失败；非 V1.5 隔离 schema 的代码断言失败。该环境问题不影响上方已使用 `55433` 隔离 schema 的 V1.5、生产管线和迁移证据。

## 5. Isolation and provider behavior

- 目标配置：`CONTENTOS_INTELLIGENCE_DATABASE_URL`、`CONTENTOS_INTELLIGENCE_STORAGE_ROOT`、独立 temp/keyframe/cache/embedding roots、`CONTENTOS_INTELLIGENCE_WORKER_CONCURRENCY`；
- 默认 provider：Fake ASR/Vision/Embedding，确定性、无网络；
- 真实 provider：`CONTENTOS_INTELLIGENCE_REAL_PROVIDERS_ENABLED=0` 默认关闭；REAL 请求不会静默退回 Fake；Qwen Vision/Embedding adapter 已接入配置入口，ASR adapter 保留接口但仍需后续配置具体服务；
- worker identity：`media-intelligence-worker-v15`；
- API 只入队长任务，分析在独立 `MEDIA_ANALYSIS` worker 中执行；
- 资产、项目、分析结果和 planner 查询均按 project/asset ownership 过滤；
- `EDIT_MANIFEST_V0` 仍由既有渲染/审批链消费，推荐状态默认为 `PROPOSED`，不会绕过 Approval。

本机 PostgreSQL 用户没有 `CREATEDB` 权限，无法创建两个新数据库；未提升权限、未写入主库。验收使用现有 `contentos_test` 中独立的 `intelligence_v15_test` schema 和独立 `search_path` 完成验证。部署时应由管理员创建 `contentos_intelligence_dev` 与 `contentos_intelligence_test`，再填入对应 URL。

## 6. Run failure note

用户看到的 `run failed 76b4d59` 不属于本分支的基线；该 SHA 是旧运行上下文。V1.5 实际以 fetch 后确认的 `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` 为基线，旧提示不会被复制为新实现结论。

## 7. Current handoff

当前状态：`REMOTE BRANCH READY FOR SECOND REVIEW`。本任务不合并 `main`，不删除功能分支。ASR 真实服务与全仓库默认 55432 测试环境仍需部署/配置后再做第二轮验证。
