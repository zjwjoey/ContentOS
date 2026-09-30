# ContentOS Intelligent Editing V1.5 Acceptance

状态：`UNDER CORE CLOSURE`
验收时间：2026-09-30  
基线：`origin/main` / `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6`  
分支：`feature/contentos-intelligent-editing-v15`  
工作树：`F:\ai剪辑\.worktrees\contentos-intelligent-editing-v15`

## 1. Scope result

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| Phase 0 audit | PASS | Architecture / Implementation Plan 已提交 |
| P0 Foundation | IMPLEMENTED / CLOSURE IN PROGRESS | 已有 contracts、0047、`MEDIA_ANALYSIS`、Fake provider；本轮已开始接入可运行 Worker、FFprobe、真实 shot/keyframe，但真实闭环尚未完成验收 |
| P1 Planner / Manifest / Render | CORE CLOSURE REQUIRED | shot-level planner 与 manifest reference 已实现，真实 analysis → render vertical slice 尚未完成证据链 |
| P2 Evidence / Recommendation | CORE CLOSURE REQUIRED | 0049 的基础 preset/recommendation 存在，decision event 与自动 RecommendationBuilder 尚未完成 |
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

当前已验证：

- `node_modules/.bin/tsc -p tsconfig.json --noEmit`
- V1.5 legacy unit tests：unit tests passed；新的 core-closure integration gates仍在补充
- `node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `git diff --check`

尚未宣称通过：

- 真实 fixture shot/keyframe、shot-level semantic gold、planner/render vertical slice、Worker polling/restart/cancel、decision/recommendation 和 browser vertical slice
- 完整 regression matrix 与 `apps/web` build
- `git diff --check`

Web build 有现有 `apps/web/app/globals.css` 的 autoprefixer `flex-end` 建议 warning，不是 V1.5 编译错误。

未宣称全仓库完整 `pnpm test` 已通过：当前 pnpm wrapper 会自动触发依赖安装，并因 `esbuild` ignored build scripts 中断；只有所有 core-closure gates 完成后才能改成 accepted。

## 5. Isolation and provider behavior

- 目标配置：`CONTENTOS_INTELLIGENCE_DATABASE_URL`、`CONTENTOS_INTELLIGENCE_STORAGE_ROOT`、独立 temp/keyframe/cache/embedding roots、`CONTENTOS_INTELLIGENCE_WORKER_CONCURRENCY`；
- 默认 provider：Fake ASR/Vision/Embedding，确定性、无网络；
- 真实 provider：`CONTENTOS_INTELLIGENCE_REAL_PROVIDERS_ENABLED=0` 默认关闭；REAL 请求不会静默退回 Fake，ASR/Vision/Embedding 的后续接口保留给配置的 provider adapter；
- worker identity：`media-intelligence-worker-v15`；
- API 只入队长任务，分析在独立 `MEDIA_ANALYSIS` worker 中执行；
- 资产、项目、分析结果和 planner 查询均按 project/asset ownership 过滤；
- `EDIT_MANIFEST_V0` 仍由既有渲染/审批链消费，推荐状态默认为 `PROPOSED`，不会绕过 Approval。

本机 PostgreSQL 用户没有 `CREATEDB` 权限，无法创建两个新数据库；未提升权限、未写入主库。验收使用现有 `contentos_test` 中独立的 `intelligence_v15_test` schema 和独立 `search_path` 完成验证。部署时应由管理员创建 `contentos_intelligence_dev` 与 `contentos_intelligence_test`，再填入对应 URL。

## 6. Run failure note

用户看到的 `run failed 76b4d59` 不属于本分支的基线；该 SHA 是旧运行上下文。V1.5 实际以 fetch 后确认的 `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` 为基线，旧提示不会被复制为新实现结论。

## 7. Current handoff

当前状态：`REMOTE BRANCH NOT READY FOR MERGE`。完成所有真实 gate 后，才可推送并确认本地 `HEAD` 与 `origin/feature/contentos-intelligent-editing-v15` SHA 一致，最终状态只能是 `REMOTE BRANCH READY FOR SECOND REVIEW`。本任务不合并 `main`，不删除功能分支。
