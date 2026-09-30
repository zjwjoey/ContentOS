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
- `f05a0a8` — `fix(intelligence): finalize v1.5 closure recovery and wiring`
- `182709c` — `test(intelligence): add cancellation gold and browser closure gates`

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

- `corepack pnpm test:intelligent-editing-v15`：14/14 passed；含真实 FFmpeg shot detection、真实 JPEG keyframe、analysis/planner/render vertical slice、failure/retry/cancel matrix、Semantic Gold、Planner Gold、decision evidence、Worker polling/restart/cancel；使用隔离 schema `intelligence_v15_test`。
- `corepack pnpm test:production-pipeline`：12/12 passed。
- `corepack pnpm test:migrations`：9/9 passed；含完整 migration chain、latest down/up 与历史边界。
- `corepack pnpm typecheck`、`corepack pnpm build`、`corepack pnpm format`、`corepack pnpm lint`：全部通过。
- `apps/web/node_modules/.bin/next build apps/web`：通过，包含 `/projects/[id]/intelligence` 页面编译。
- `corepack pnpm test:browser`（仅 `tests/e2e/intelligent-editing-v15-browser.test.ts`）：1/1 passed；真实隔离 API/Web/Asset Worker/Media Intelligence Worker/Video Worker + Playwright，覆盖上传、分析、Shot/搜索、Planner、替换证据和 Render Job/MP4。
- 独立 Worker 启动：输出 `status=READY`、注册 `MEDIA_ANALYSIS` handler。
- `git diff --check`：通过。

全仓库 `corepack pnpm test` 已在干净 `full_regression_v15_20260930` schema 上执行：287/288 通过，唯一失败为既有 `tests/integration/publisher-foundation.test.ts` 的 migration boundary 测试，因共享 `schema_migrations` 状态/测试顺序导致 `migrateDown` 计数不稳定；不是 V1.5 变更引起。首次执行曾因默认 55432 未启动失败，随后已用 `DATABASE_URL` 指向 55433 隔离 schema 重跑，排除了环境端口误判。

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

## 8. Final handoff report

- Branch: `feature/contentos-intelligent-editing-v15`
- Base SHA: `7338c9266e685d26975c928349ee13d1a589b86d`
- Final SHA: `182709c9ca2e2f4ea007a5375ccf9213fda3f19a`
- New Commits: `6428e41`, `cf5e87b`, `8a76e24`, `9aff1dd`, `cb5ba8a`, `f05a0a8`, `182709c`
- New Migrations: `0050_intelligent_editing_core_closure`, `0051_intelligent_edit_render_reference`; up/down and full-chain matrix passed
- Worker Closure: PASS — executable entrypoint, polling, claim, heartbeat through JobRunner, lease reconciliation, stale-run recovery, cancellation, restart and graceful shutdown
- Shot Detection: PASS — existing FFmpeg scene detector reused through provider adapter; no production uniform-shot fallback
- Keyframe: PASS — real FFmpeg midpoint JPEGs under configured root with READY/FAILED state and frame hash
- ASR: PASS for contract/persistence/Fake provider path; real ASR adapter intentionally reserved for later configuration
- Vision: PASS — per-shot normalized results; Qwen adapter is configurable and no network call is made by default
- Embedding: PASS — shot/input-digest/dimension/model provenance, hybrid lexical/vector retrieval; Qwen adapter is configurable
- Semantic Search: PASS — shot-level results with source ranges and semantic/lexical scores
- Shot Planner: PASS — shot/range candidates, quality/diversity/repetition features and provenance
- Manifest Integration: PASS — existing `EDIT_MANIFEST_V0` and `VideoService` revision/ownership path reused
- Render Vertical Slice: PASS — real analysis to Video Worker/FFmpeg render produced 1080x1920 MP4
- Decision Evidence: PASS — `SHOT_REPLACED` event and RecommendationBuilder evidence are durable and project-scoped
- Web Changes: intelligence page displays analysis status, shots/keyframes, search scores, planner candidates, alternatives, manifest/render references and quality evidence; Web production build passed
- Tests: V1.5 14/14; browser vertical slice 1/1; full regression 287/288 with one pre-existing publisher migration-boundary failure; production pipeline 12/12; migration matrix 9/9; typecheck/build/format/lint/Web build passed
- Known Limitations: real ASR endpoint still needs user configuration; one unrelated existing publisher migration test is not green when the full suite shares one schema
- Remote Push Status: PASS — `origin/feature/contentos-intelligent-editing-v15` equals `182709c9ca2e2f4ea007a5375ccf9213fda3f19a`
