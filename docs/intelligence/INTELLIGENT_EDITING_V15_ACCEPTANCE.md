# ContentOS Intelligent Editing V1.5 Acceptance

状态：`READY FOR FINAL MERGE REVIEW`
验收时间：2026-09-30  
基线：`origin/main` / `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6`  
分支：`feature/contentos-intelligent-editing-v15`  
工作树：`F:\ai剪辑\.worktrees\contentos-intelligent-editing-v15`

## 1. Scope result

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| Phase 0 audit | PASS | Architecture / Implementation Plan 已提交 |
| P0 Foundation | PASS | Worker 已可启动/轮询/租约恢复/优雅关闭；FFprobe、FFmpeg scene detection、JPEG keyframe、checksum/stale、shot-level ASR/Vision/Embedding 接口均有真实 fixture 证据 |
| F0 Database Runtime Consistency | PASS | API、Media Intelligence Worker、Video Worker、Job Service 使用同一个 `DATABASE_URL`；独立 schema 仅用于测试隔离 |
| F1 Candidate Replacement Revision | PASS | Candidate B 通过 apply API 生成新的 Plan revision、Manifest revision、VIDEO_RENDER Job 和真实 MP4，旧版本保留 |
| F2 Fingerprint / Provenance | PASS | analysis fingerprint 与 config snapshot 持久化；provider/model/prompt/pipeline/capabilities 可追溯，secret 不进入 fingerprint |
| F3 Quality Integrity | PASS | shotType/cameraMotion 真实写入 Manifest matching；unknown 不增加 diversity，duration fit 对比 requested duration |
| F4 Decision Evidence | PASS | Decision API 服务端从 Candidate 推导 shot；SHOT_REPLACED 状态约束和 Recommendation provenance 已覆盖 |
| Transactional Replacement Integrity | PASS | Manifest、VIDEO_RENDER Job、Candidate selection、Plan revision、Decision Event 共用一个 PostgreSQL transaction；回滚、并发和重复请求测试通过 |
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
- `05defd8` — `docs(intelligence): finalize closure evidence`
- `3f1458f` — `feat(intelligence): complete v1.5 final closure`
- `d0bcc72` — `fix(video): support shared replacement transactions`
- `e2e3134` — `fix(intelligence): make candidate replacement atomic`

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
- `0052_intelligent_editing_final_closure.sql` / `.down.sql`
  - analysis fingerprint/config snapshot, plan revision and unique selected-candidate invariant.

迁移前重新读取 inventory，基线最后原有 migration 为 `0046`，本分支使用 `0047`–`0052`。在隔离 schema 中全量 up（52 migrations）、latest down/up 和相关集成测试均通过。

## 4. Test evidence

已验证：

- `corepack pnpm test:intelligent-editing-v15`：21/21 passed；含同库 API→Worker DB consistency、真实 FFmpeg shot detection、真实 JPEG keyframe、analysis/planner/replacement/render vertical slice、transaction rollback/concurrency/duplicate-request matrix、failure/retry/cancel matrix、fingerprint gold、Semantic Gold、Planner Gold、decision evidence、Worker polling/restart/cancel；使用隔离 schema。
- `corepack pnpm test:production-pipeline`：12/12 passed。
- `corepack pnpm test:migrations`：9/9 passed；含完整 migration chain、latest down/up 与历史边界。
- `corepack pnpm typecheck`、`corepack pnpm build`、`corepack pnpm format`、`corepack pnpm lint`：全部通过。
- `apps/web/node_modules/.bin/next build apps/web`：通过，包含 `/projects/[id]/intelligence` 页面编译。
- `corepack pnpm test:browser`（仅 `tests/e2e/intelligent-editing-v15-browser.test.ts`）：1/1 passed；真实隔离 API/Web/Asset Worker/Media Intelligence Worker/Video Worker + Playwright，覆盖上传、分析、Shot/搜索、Planner、替换证据和 Render Job/MP4。
- 独立 Worker 启动：输出 `status=READY`、注册 `MEDIA_ANALYSIS` handler。
- `git diff --check`：通过。

全仓库 `corepack pnpm test` 已在 `intelligent_tx_full_20260930` 隔离 schema 上重跑：289/289 通过，0 failed、0 skipped；Publisher migration boundary 也在该隔离 schema 通过。另行验证 production pipeline 12/12、auto-edit-v1 28/28、auto-edit-v15 20/20、script-edit-v3 33/33。

## 5. Isolation and provider behavior

- 运行配置：API、Media Intelligence Worker、Video Worker、Job Service 统一使用 `DATABASE_URL`；测试可以通过同一数据库的 `search_path`/独立 schema 隔离；
- 可独立配置的 Intelligence 资源目录：`CONTENTOS_INTELLIGENCE_STORAGE_ROOT`、temp/keyframe/cache/embedding roots、`CONTENTOS_INTELLIGENCE_WORKER_CONCURRENCY`；
- 默认 provider：Fake ASR/Vision/Embedding，确定性、无网络；
- 真实 provider：`CONTENTOS_INTELLIGENCE_REAL_PROVIDERS_ENABLED=0` 默认关闭；REAL 请求不会静默退回 Fake；Qwen Vision/Embedding adapter 已接入配置入口，ASR adapter 保留接口但仍需后续配置具体服务；
- worker identity：`media-intelligence-worker-v15`；
- API 只入队长任务，分析在独立 `MEDIA_ANALYSIS` worker 中执行；
- 资产、项目、分析结果和 planner 查询均按 project/asset ownership 过滤；
- `EDIT_MANIFEST_V0` 仍由既有渲染/审批链消费，推荐状态默认为 `PROPOSED`，不会绕过 Approval。

本机 PostgreSQL 用户没有 `CREATEDB` 权限；验收使用现有 `contentos_test` 中独立 schema 和 `search_path` 完成验证。该 schema 隔离只属于测试，不代表生产数据库拆分。

## 6. Transactional Replacement Integrity

本轮未新增 migration。`VideoService.createManifestRevision()` 和 `createManifestRenderJob()` 保留原公共 API，并委托给 transaction-aware executor 实现；`JobService` 新增 `createWithExecutor()` / `createIdempotentWithExecutor()`，仍直接持久化现有 `jobs` 表。`pg-boss` 继续作为独立 delivery adapter，不参与业务 Job 持久化，因此不需要 Outbox。

`applyCandidateReplacement()` 现在在同一 `PoolClient` transaction 中完成 Plan/Candidate `FOR UPDATE`、Manifest revision、VIDEO_RENDER Job、Candidate selection、Plan revision 和 `SHOT_REPLACED` event。Manifest revision 的 advisory lock 也属于该 transaction；未提交的 Job 对 Worker 不可见。

事务专项结果：

- Manifest 阶段失败：Manifest、Job、Plan、Candidate、Decision 全部 rollback；
- Render Job 阶段失败：Manifest、Job、Plan、Candidate、Decision 全部 rollback；
- Decision Event 阶段失败：全部 rollback；
- 并发替换：1 个成功、1 个 selection conflict，最终仅 1 个 selected Candidate；
- 重复请求：`INTELLIGENT_CANDIDATE_ALREADY_SELECTED`，Plan revision 和 Job 数量不增加。

## 7. Run failure note

用户看到的 `run failed 76b4d59` 不属于本分支的基线；该 SHA 是旧运行上下文。V1.5 实际以 fetch 后确认的 `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` 为基线，旧提示不会被复制为新实现结论。

## 8. Current handoff

当前状态：`REMOTE BRANCH READY FOR FINAL MERGE REVIEW`。本任务不合并 `main`，不删除功能分支。真实 ASR 仍需后续配置；Qwen Vision/Embedding 适配器已接入，但真实远端调用未独立验证。

## 9. Final handoff report

- Branch: `feature/contentos-intelligent-editing-v15`
- Base SHA: `4a03544a754ac7eaf27a725f7f994ac42f88cbe2`
- Final SHA (implementation): `e2e3134` (`fix(intelligence): make candidate replacement atomic`)
- New Commits: `d0bcc72`, `e2e3134`
- New Migrations: `0050_intelligent_editing_core_closure`, `0051_intelligent_edit_render_reference`, `0052_intelligent_editing_final_closure`; up/down and full-chain matrix passed
- Database Runtime Model: PASS — one PostgreSQL database via `DATABASE_URL`; schema/search_path isolation is test-only
- Worker/API DB Consistency: PASS — API-created `MEDIA_ANALYSIS` Job was consumed and completed by Worker against the same database
- Candidate Replacement Flow: PASS — server-side Candidate ownership/state validation, replacement apply service, and durable decision event
- Transaction Design: PASS — public VideoService wrappers own standalone BEGIN/COMMIT; replacement passes one shared executor through Manifest and Job creation
- VideoService Changes: PASS — `createManifestRevisionWithExecutor()` and `createManifestRenderJobWithExecutor()` reuse the caller transaction while public APIs remain unchanged
- JobService Changes: PASS — executor-aware create and idempotent create reuse the existing `jobs` table; no pg-boss semantic changes
- Candidate Replacement Transaction: PASS — Plan/Candidate locks, Manifest, Job, selection, Plan revision and Decision Event share one transaction
- Rollback Test Results: PASS — 3 injected failure points leave no orphan Manifest/Job and preserve Plan/Candidate/Decision state
- Concurrent Replacement Result: PASS — exactly one success and one conflict; exactly one selected Candidate remains
- Duplicate Request Result: PASS — second selection returns `INTELLIGENT_CANDIDATE_ALREADY_SELECTED` without a new revision
- Manifest Integrity: PASS — failed transactions leave no new Manifest; success creates one new immutable revision
- Render Job Integrity: PASS — failed transactions leave no new VIDEO_RENDER Job; success creates one idempotent Job visible only after commit
- Decision Evidence Integrity: PASS — failed event insertion rolls back all preceding writes; successful replacement records one `SHOT_REPLACED`
- Plan Revision: PASS — plan revision increments without overwriting prior plan/Manifest history
- Manifest Revision: PASS — new immutable `EDIT_MANIFEST_V0` revision uses the alternative shot
- New Render Job: PASS — every replacement creates a new `VIDEO_RENDER` Job; old render job is not reused
- Analysis Fingerprint: PASS — checksum, analysis/pipeline versions, capabilities and stable provider config snapshot are hashed
- Provider Provenance: PASS — provider/model/prompt descriptors are persisted; secrets/endpoints are excluded
- Quality Changes: PASS — real shotType/cameraMotion provenance, unknown evidence counts, requested-vs-actual duration fit
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
- Regression Results: V1.5 21/21; browser vertical slice 1/1; full regression 289/289; production pipeline 12/12; auto-edit-v1 28/28; auto-edit-v15 20/20; script-edit-v3 33/33; migration matrix 9/9; typecheck/build/format/lint/Web build passed
- Migration Changes: none in this transactional closure; `0052_intelligent_editing_final_closure.sql` remains the latest Intelligence migration
- Desktop Independence: PASS — `apps/desktop` diff remains empty; no Desktop code was modified
- Known Limitations: real ASR endpoint still needs user configuration; Qwen Vision/Embedding adapters are configurable but real remote calls are not independently verified; Remote CI is not configured in this repository
- Remote CI Status: `NOT CONFIGURED`
- Remote Push Status: `PASS` — the remote branch was verified after the closure push; implementation commits `d0bcc72` and `e2e3134` plus the acceptance metadata are present on `origin/feature/contentos-intelligent-editing-v15`.
