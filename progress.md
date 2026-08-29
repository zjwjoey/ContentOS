# ContentOS Research Progress

## Session: 2026-08-21

### Phase 1: Research workspace and repository inventory
- **Status:** complete
- **Started:** 2026-08-21
- Actions completed:
  - Read the supplied research brief.
  - Confirmed `E:\ContentOS` is an empty, non-Git workspace.
  - Created persistent planning, findings, and progress records.
- Files created:
  - `E:\ContentOS\task_plan.md`
  - `E:\ContentOS\findings.md`
  - `E:\ContentOS\progress.md`
- Interrupted action:
  - The first clone attempt did not start because its working directory did not yet exist. No repository data was modified; the corrected operation will create directories from the workspace root first.
  - MoneyPrinterTurbo did not complete a shallow clone within the execution window. Its report uses only read-only remote source evidence pinned to its resolved SHA.

### Phase 2–4: Reports, comparison and verification
- **Status:** complete — stopped at the user-mandated Step 8.
- Actions completed:
  - Wrote five 14-section repository reports in `research/reports/`.
  - Recorded immutable repository metadata in `research/notes/repository-inventory.md`.
  - Wrote `research/architecture/comparison.md`, including requested A–G conclusions and a Phase-2 shortlist.
  - Ran a fresh validation: every report has 14 numbered sections, comparison has A–G, inventory has five projects, all SHAs match, and no ContentOS application code exists outside research.

## Session: 2026-08-21 — Phase 2 started

### Phase 5: Question-driven repository evidence
- **Status:** complete
- Actions completed:
  - Read the Phase-2 brief and preserved the Phase-1 records as historical evidence.
  - Defined the three narrow research tracks: Video Engine, durable Job/Workflow and AI Provider abstraction.
- Planned outputs:
  - `research/phase-2/{video,workflow,ai-provider,decisions}` only.

### Phase 6–7: Standards, validation and stop
- **Status:** complete — stopped at the user-mandated Phase-2 boundary.
- Actions completed:
  - Created 13 requested decision/analysis documents plus a pinned seven-repository evidence inventory.
  - Selected FFmpeg + thin internal builder for V1 and documented `EDIT_MANIFEST_V0`.
  - Selected fixed workflow services, durable Jobs and `pg-boss`/BullMQ as the two queue candidates.
  - Defined provider interface, model registry and versioned prompt provenance.
  - Reviewed all ten architecture rules and revalidated Modular Monolith + independent workers.
  - Fresh validation passed: 14 Phase-2 artifacts, seven evidence rows, ten rule decisions, preserved Phase-1 artifacts and research-only scope.

## Session: 2026-08-21 — Architecture V0 started

### Phase 8: Formal architecture design
- **Status:** complete
- Scope:
  - Produce formal design documents only under `docs/`.
  - Preserve research history and do not implement ContentOS product code.
- Actions completed:
  - Produced the V0 control-plane, module-dependency, data, asset, Job, Worker, API, configuration, observability, repository-layout and test-strategy designs.
  - Defined contracts for Video, Publisher, Director, AI and Review, including the immutable `EDIT_MANIFEST_V0` boundary.
  - Recorded ADR-001 through ADR-010, architecture invariants, the summary and a conditional human-review report.
  - Performed a design-artifact completeness and scope review; stopped before project initialization or product implementation.

## Verification log

| Check | Result |
|---|---|
| Initial workspace state | Empty; not a Git worktree. |
| Scope guard | No ContentOS application code has been created. |
| Architecture V0 scope guard | Documentation-only architecture package; no app, API, UI, migration, worker, rendering, publisher or AI implementation created. |

## Session: 2026-08-21 - Spike validation started

### Phase 11: Spike 01
- **Status:** complete - PASS WITH CONDITIONS
- Scope: disposable PostgreSQL/pg-boss/Worker validation only under `spikes/spike-01-job-worker/`.
- Guardrails: no formal ContentOS source tree, no real platform access, and no modifications to prior research/design documents unless an explicit architecture change request is recorded.
- Actions completed:
  - Installed PostgreSQL 16.15 for the local validation environment and used a disposable cluster on port 55432.
  - Installed pinned Spike dependencies `pg@8.23.0` and `pg-boss@12.27.0`.
  - Implemented and tested six scenarios: normal progress, real worker crash/recovery, retry, permanent failure, duplicate delivery/idempotency and cooperative cancellation.
  - Recorded `SPIKE_01_JOB_WORKER_REPORT.md`, environment JSON, test output and an architecture change request clarification.
  - Fresh full run: 6 tests passed, 0 failed.

### Phase 12: Spike 02
- **Status:** complete - PASS WITH CONDITIONS
- Scope: disposable Edit Manifest -> thin FFmpeg builder -> MP4 validation only under `spikes/spike-02-video-render/`.
- Actions completed:
  - Built a seeded `EDIT_MANIFEST_V0` planner over ten mixed landscape/portrait/square fixtures and a 30-second voice track.
  - Rendered five real outputs; all probed to 1080x1920 and 30 seconds with fade transitions and mapped audio.
  - Verified UTF-8 Chinese subtitles from a Chinese-named SRT and Chinese-named media path with visible extracted frames using `C:\Windows\Fonts\msyh.ttc`.
  - Verified invalid Manifest, corrupted media and interrupted render structured failures with no false-success output.
  - Recorded `SPIKE_02_VIDEO_RENDER_REPORT.md`, environment JSON, run summary, test output and an architecture change request.
  - Fresh full run: 5 tests passed, 0 failed.

### Phase 13: Spike 03
- **Status:** complete - PASS WITH CONDITIONS
- Scope: disposable asset staging and atomic promotion validation only under `spikes/spike-03-asset-promotion/`.
- Actions completed:
  - Verified SHA-256 content-addressed promotion and duplicate reuse.
  - Verified Chinese source path/metadata, checksum mismatch rejection, crash-after-copy window and stale temporary cleanup.
  - Recorded `SPIKE_03_ASSET_PROMOTION_REPORT.md`, environment JSON, run summary, test output and an architecture change request.
  - Fresh full run: 5 tests passed, 0 failed.

### Phase 14: Spike 04
- **Status:** complete - PASS WITH CONDITIONS
- Scope: fake-platform publisher worker and Playwright-style isolation validation only under `spikes/spike-04-publisher-worker/`.
- Actions completed:
  - Verified fake success, auth failure, verification challenge, DOM drift, browser crash and worker crash/retry.
  - Verified separate profile contexts/directories and secret redaction.
  - Recorded `SPIKE_04_PUBLISHER_WORKER_REPORT.md`, environment JSON, run summary, test output and an architecture change request.
  - Fresh full run: 6 tests passed, 0 failed.

### Phase 15: Spike gate
- **Status:** complete - READY FOR HUMAN ARCHITECTURE REVIEW
- Actions completed:
  - Produced `SPIKE_VALIDATION_SUMMARY.md` and `spikes/evidence/INDEX.md`.
  - Confirmed all four spikes are PASS WITH CONDITIONS with no critical blocker.
  - Confirmed verification-only scope and stopped before product initialization.

### Phase 16: Final Architecture Review and V0 Freeze
- **Status:** complete - APPROVED FOR ENGINEERING INITIALIZATION
- Scope: review and freeze documents only; no Spike changes and no product initialization.
- Completed reading: Architecture V0 summary, architecture/data/module/contract docs, all ten ADRs and all four Spike reports/evidence references.
- Initial findings: core architecture remains coherent; three named contract documents are absent and must be added; Spike conditions require explicit V0 clarifications and staged engineering gates.
- Actions completed:
  - Classified all conditions A/B/C/D and accepted all four architecture change requests.
  - Added the missing Job, AI Provider and Publisher Adapter contracts, ADR status index and Tech Stack V0.
  - Updated evidence-supported Job, Worker, Asset, Video, Publisher, invariant, structure and review documents.
  - Created the Freeze Report, review decisions, Engineering Initialization Plan and `AGENTS.md`.
  - Final document/scope validation: 22 evidence passes, 0 evidence failures, all required files present, no formal product top-level directories.

## Restart check

| Question | Answer |
|---|---|
| Where am I? | Phase 1 repository preparation. |
| What comes next? | Obtain and inventory five repositories, then analyze them. |
| What is the goal? | Deliver Phase-1 reports and comparison, then stop. |
| What have I learned? | See `findings.md`. |
| What have I done? | See this progress log. |

## Session: 2026-08-21 - Engineering initialization

### Phase 17: Formal engineering initialization and first vertical slice
- **Status:** complete; ENGINEERING INITIALIZATION PASSED.
- Stage 0: formal pnpm/TypeScript workspace, env template, tooling scripts, package/module structure and doctor checks.
- Stage 1: local PostgreSQL 16 development cluster on port 55432, advisory-locked migrations 0001-0003, traceability tests.
- Stage 2: fail-closed config, structured redacted logging and stable error envelopes.
- Stage 3: Job/Attempt state machine, idempotency, retry/cancel, lease reconciler and pg-boss adapter.
- Stage 4: separately supervised worker runtime with bounded bootstrap handlers; publisher remains no-op by scope.
- Stage 5: ContentProject service and Fastify API create/get/list endpoints with validation.
- Stage 6: Unicode-safe local staging, SHA-256 content addressing, atomic promotion, dedupe, project links and reconciliation.
- Stage 7: deterministic seeded planner, immutable EDIT_MANIFEST_V0 persistence, real FFmpeg render/probe/promote flow and E2E test.
- Latest fresh run: `pnpm run typecheck`, `pnpm run lint`, `pnpm run format`, and `pnpm test` all green (21 tests, 0 failures).
- Final gate: build and doctor pass; A-J report and next-slice handoff written; `No Architecture Deviations`; no blocker report required. Stop here for human review.

## Session: 2026-08-22 - Slice 2 Director foundation

### Phase 18: Director Brief/Storyboard foundation
- **Status:** complete; pushed as commit `c51bd42`.
- Added `DIRECTOR_PLAN_V0` contract with deterministic seed, brief, storyboard scenes, source asset references and non-secret provenance.
- Added append-only `director_plan_revisions` migration and `content_projects.current_director_revision_id` pointer.
- Added Director service transitions: DRAFT -> ACCEPTED -> APPROVED, revision creation and current approved query.
- Added API routes for create, current, revise, accept and approve with Zod validation and conflict errors.
- Fresh format/lint/typecheck/full test run: **27 passed, 0 failed**.

## Session: 2026-08-22 - Slices 3, 4 and 6

### Phase 19: Director-to-Video, Fake Publisher and Review
- **Status:** complete; implementation, final verification and remote push complete.
- Slice 3: approved Director revisions now create idempotent `VIDEO_RENDER` Jobs with brief/storyboard/source-asset provenance, plus a thin API route.
- Slice 4: added the platform-neutral Publisher Adapter contract, deterministic Fake Platform, isolated account profiles, failure taxonomy and Worker handler.
- Slice 6: added `REVIEW_V0`, append-only review decisions, guarded approval/rejection transitions and API routes for render/publish targets.
- Slice 5 real platform adapters remain explicitly deferred; no Douyin/WeChat credentials or platform calls were added.
- Final gate: format, lint, typecheck, full **41-test** suite, build and doctor all passed.
- Pushed as commit `3f89304` to `origin/main`.

## Session: 2026-08-22 — Director V1 preparation

### Phase 22: Worktree, baseline and implementation plan
- **Status:** plan ready; implementation not yet started.
- Created `E:\ContentOS\.worktrees\codex-director-v1` on branch `codex/director-v1` from `main`; brought in the approved Director V1 design document.
- The first baseline run against shared `contentos_dev` produced 39 passes and 2 migration-file failures because that database contained Publisher migration 0006 not present on `main`.
- Root cause was confirmed by querying `schema_migrations`; the shared database contained `0001` through `0006`.
- Created the isolated local database `contentos_director_dev` on the existing PostgreSQL 16 instance at port 55433; no PostgreSQL installation or production database was added.
- Fresh baseline passed: **41 tests, 0 failures**.
- Wrote `docs/superpowers/plans/2026-08-22-director-v1-implementation.md`; no Director product source code has been changed.
- Task 1 complete: added ECR-001 and ADR-011, updated Architecture/Worker/Tech Stack/ADR status documents, and recorded the isolated database baseline. No product source code or real provider/platform call was made.
- Task 2 is next and will use contract-first TDD for Director V1 and AI Provider types.
- Task 2 complete: wrote red contract tests first, then added `ContentBriefV1`, Script/Storyboard revision contracts, AI Provider/Request/Result/Profile/Prompt contracts and bounded validators. Focused gate: **7 passed, 0 failed**; typecheck passed.
- Task 3 is next: append-only Director V1 and AI provenance migrations, starting at migration 0007.
- Task 3 migration portion complete: added `0007_director_v1` and `0008_ai_provenance` with state counters, composite project-ownership FKs, append-only revision uniqueness, source Job idempotency and AI Run provenance. Migration integration gate: **4 passed, 0 failed** on `contentos_director_dev`.
- Task 4 is next: deterministic fake AI provider, prompt registry and AI Run service.
- Task 4 complete: added immutable PromptRegistry, deterministic Chinese FakeAIProvider, normalized provider errors and AIService persistence of success/failure `ai_runs` with bounded snapshots and provenance. Focused gate: **5 passed, 0 failed**; typecheck passed.
- Task 5 is next: append-only Director application services and state transitions.
- Task 5 complete: added `DirectorV1Service` with brief/script/storyboard records, state-row locking and counters, append-only manual revisions, accepted/approved transitions, current-pair pointers and mismatch guards. Focused gate: **3 passed, 0 failed**; typecheck passed.
- Task 6 is next: idempotent Director Job creation and explicit Application Worker handlers.
- Task 6 complete: added typed Director Job creation with idempotency keys, attempt-aware JobRunner errors, explicit Director Worker composition, two bounded handlers and Fake Provider execution. Worker/regression gate: **5 passed, 0 failed**; typecheck passed.
- Task 7 is next: thin Director V1 API routes while preserving legacy Director Plan endpoints.
- Task 7 complete: added thin V1 routes for Brief, Script generation/manual/accept, Storyboard generation/list/detail/approve and safe Job status, while preserving legacy Director Plan routes. API regression gate: **3 passed, 0 failed**; typecheck passed.
- Task 8 is next: carry approved Script/Storyboard IDs through Video Job, Manifest and Render metadata.
- Task 8 complete: extended `EDIT_MANIFEST_V0` compatibly, added V1 Director→Video current-pair bridge, and preserved metadata through Planner/Video Render diagnostics without changing renderer behavior. Provenance/regression gate: **8 passed, 0 failed**; typecheck passed.
- Task 9 is next: minimal API-backed Director Operator UI.
- Task 9 complete: added Next Operator project list and Director page with Brief form, Job state, Script/Storyboard revision lists, accept/manual revision/approve actions, API rewrite and static smoke coverage. Web gate: Next production build passed; root typecheck passed; UI smoke **1 passed, 0 failed**.
- Task 10 is next: full fake-provider Director→Video E2E, quality backlog and final verification report.
- Task 10 complete: added the full fake-provider Director→Video→FFmpeg E2E, quality backlog, vertical slice report and one next-slice recommendation. Fixed 0008 down/up provenance cleanup after migration gate exposed dangling references. Final automated gate: **65 passed, 0 failed**; format, lint, typecheck, root build, doctor, Web build and diff-check passed.
- Real Provider Sandbox remains `BLOCKED` because no provider choice, authorized sandbox project or credential reference was supplied; no real AI/platform request was made.


## Session: 2026-08-22 — Project Center design

### Phase 18: Slice ③ design
- **Status:** Slice ③ implementation complete; Slice ④、⑤、⑥ remain closed.
- Added ProjectCenterSnapshot Contract, safe Job summary query, deterministic rules, GET center API, project-list handoff and A3+B2+C1 desktop/compact Web page.
- Isolated PostgreSQL verification: DATABASE_URL on 55433/contentos_project_center_dev with pnpm test — 128 passed, 0 failed.
- Additional gates: pnpm typecheck passed; pnpm lint passed; pnpm --dir apps/web build passed; git diff --check passed.
- pnpm format remains blocked by the repository existing Windows CRLF checkout; the same baseline failure reproduces in publisher-project-integration; no Slice ③-specific trailing whitespace was found.
- **Status:** design written; waiting for user review before implementation planning.
- Created visual companion screens under `.superpowers/brainstorm/456-1787388765/content/` and confirmed the user choices A3 + B2 + C1.
- Wrote and committed `docs/superpowers/specs/2026-08-22-project-center-design.md` in feature worktree `E:\\ContentOS\\.worktrees\\project-center` (commit `c319e62`).
- Design defines a read-only `ProjectCenterSnapshot` composite contract, `GET /api/v1/projects/:projectId/center`, deterministic health/stage rules, no new Project Center persistence, and no private-table access.
- A planning-file preservation correction is pending: historical contents of `task_plan.md`, `findings.md`, and `progress.md` must remain intact while appending Slice ③ records.

## Session: 2026-08-23 — Project Center final review repair

- **Status:** complete; independent review passed
- 已核验独立审查的 4 个 Important 和 1 个 Minor 均可由当前代码路径触发。
- 采用 TDD：每个生产修复前先添加并运行失败回归测试。
- Project Center 3 个状态回归用例先失败后通过：Approval unavailable 不再产生 MISSING；历史 Asset 不再决定 current Video；活动 Video Job 优先显示 IN_PROGRESS。
- 成功 Render 在 SOURCE 关联删除后复用测试先失败后通过；`planJob` 现在先读取已完成结果。
- Job stale attempt 与短租约 heartbeat 测试先失败后通过；Job succeed/fail 已按 attempt number fencing。
- Render stale attempt 测试先失败后通过；新增 migration 0011、Render attempt CAS 和 attempt 独立 FFmpeg 输出路径。
- Director→Video E2E 已加入标准 test 脚本；受影响测试集 53/53 通过。
- 最新独立复审发现 lease recovery 到下一次 claim 之间仍存在旧 Render 最终化窗口；新增 Job 公共 current-attempt fence，在不跨读私表的前提下关闭窗口。
- Video 最终化把 Asset import 与 Render CAS 放入同一 Job attempt fence；旧 attempt 的回调不会执行，因此不会产生可发布的孤立 READY Asset。
- Job heartbeat 现在区分 ACTIVE/CANCEL_REQUESTED/STALE；取消通过 AbortSignal 传到 FFmpeg，Job/attempt 均进入 CANCELLED，attempt 临时输出在 finally 清理。
- 新增/受影响的并发、取消、Renderer 与 Video E2E 聚焦测试 20/20 通过；全量 Gate 待执行。
- 最终独立复审发现旧 fence callback 会持有一个 Pool 连接后让 Asset/Video 再借连接，4 路并发可耗尽连接池；该实现已替换为同一连接的 branded attempt transaction scope。
- Video 的 start/complete/fail/cancel 公开契约不再接受裸 attemptId/number，只能在 Job 当前 attempt 事务内调用。
- Asset READY 行、Render SUCCEEDED、JobAttempt/Job SUCCEEDED 与事件现为单事务提交；失败测试证明整体回滚且不留下 READY output Asset。
- 活跃取消测试证明 FFmpeg 子进程被 abort，`.part.mp4` 被删除；Video/Job/attempt 取消终态通过同一事务提交。
- lease recovery 新增模块 cancellation callback；Video 的 crashed-worker 测试证明 Render、JobAttempt、Job 同步进入 CANCELLED，并清理该 job/attempt 的 output 与 part 文件；无 callback 时保留 CANCEL_REQUESTED 等待正确编排。
- current attempt 的 Render start CAS 返回 false 现在抛 `RENDER_START_REJECTED`，回归测试证明不会正常返回给 JobRunner。
- Asset 文件准备已移出 attempt 数据库事务，事务内只提交不可变 blob 元数据和业务状态；Renderer abort 等待 child close。
- cancellation callback 现在显式返回 handled；混合 VIDEO_RENDER/PUBLISH 回归证明未处理类型保持 CANCEL_REQUESTED。
- lease recovery 逐 Job 加锁、重验和提交；poison callback 隔离测试证明其他过期 Job 仍可恢复。
- Prepared Asset handle 由 Asset 模块内部签发并绑定 storage provider；伪造 handle 回归证明无法创建 READY 行。
- 组合式 Video Worker 入口现于每次 delivery 前运行 typed lease cancellation recovery；标准 Video E2E 已改为通过该入口执行，而非直接调用 handler。
- Video recovery 已从 delivery 前触发改为启动即执行 + 独立周期 supervisor；shutdown 清 timer 并等待 active pass，真实 CLI 通过环境配置组合依赖，dev-operator 同步启动 Video Worker。
- Video Worker 现会在启动时并通过独立有界轮询消费 PostgreSQL 中的 `VIDEO_RENDER` Jobs；delivery 只保留为低延迟唤醒入口。标准 Video E2E 只创建 Job 并等待自主执行，不再调用 `worker.execute`。
- 独立复审发现首批长渲染会延迟 supervisor timer 安装；新增阻塞首轮消费的回归测试并调整启动顺序，现先安装两个 timer 再异步触发消费，lease recovery 与 Worker 启动均不被渲染阻塞。
- poison recovery 会追加不含异常详情的 `job.lease_recovery_failed` 事件，兼顾任务隔离与可诊断性。
- 最终 Gate：format、lint、typecheck、root build、Web build、doctor、diff-check 全部通过；全量测试 **180/180**。
- 最终独立复审未发现 Critical 或 Important，确认 PostgreSQL 自主消费、长首轮消费下的独立 lease recovery 和 shutdown 等待路径均满足验收要求。
- 诊断时一次 `tsx -e` 命令因 CJS top-level await 及 PowerShell `$1` 展开失败；改用 IIFE 与 PowerShell 单引号后确认 `renewLease` SQL 返回 true。

## Session: 2026-08-29 — Integration Closure and Unified Product Flow planning

- User accepted the written two-stage design and fixed the Stage 1 endpoint at a pushed `integration/contentos-v1` review branch with no automatic merge to `main`.
- Wrote `docs/superpowers/plans/2026-08-29-contentos-integration-closure.md` with exact inputs, migration matrix, real-adapter reconciliation, disabled defaults, integrated Fake vertical slice, final Gate, push, and stop conditions.
- Wrote `docs/superpowers/plans/2026-08-29-contentos-unified-product-flow.md` with durable browser upload staging, `ASSET_IMPORT` Job/Worker, Assets/Video/Approval pages, Publisher completion, unified Project Center navigation, and full browser E2E acceptance.
- Self-review corrected two sequencing hazards: the Publisher state test now lands with its production state store, and Asset Import uses `STAGED` plus `attachJob` so no runnable Job is intentionally created without a durable import record.
- The first PowerShell plan-verification command parsed `$plan:` as a scoped variable and stopped before checking files; rerunning with `${plan}` completed successfully and confirmed both required headers/invariants, no placeholders, and a clean diff.
- No business source, migration, dependency, branch integration, remote push, or live external call was performed while writing these plans.

## Session: 2026-08-29 — Integration and unified product planning

- **Status:** written design awaiting user review
- User selected the safe integration endpoint: push `integration/contentos-v1` and stop before merging to `main`.
- Verified branch heads, ancestry, migration inventory, API routes, Web pages and current E2E coverage.
- Selected Project Center head `d257229` as the integration base because it already contains Director V1 and both Publisher product lines.
- Reserved Stage 1 for branch/migration/runtime convergence and a public API/Worker combined E2E; Stage 2 remains closed until that Gate passes.
- Defined Stage 2 as a Web-operated Fake product flow with durable asset ingestion and minimal Assets/Video/Approval stages; real AI, live platform verification and Review Analytics remain out of scope.
- Added `docs/superpowers/specs/2026-08-29-contentos-integration-and-unified-flow-design.md`; no business code changed.

## Session: 2026-08-29 — Integration Closure execution

- Created `E:\ContentOS\.worktrees\integration-contentos-v1` on branch `integration/contentos-v1` from the accepted Project Center planning head `6571323` (business baseline `d257229`).
- `pnpm install --frozen-lockfile` and `pnpm typecheck` passed in the integration worktree.
- Initial `pnpm test` attempt used the test files' fallback `127.0.0.1:55432` and returned 92 connection-refused failures; no test reached product assertions. The local PostgreSQL service was verified on port 5432 with existing `contentos_test`.
- Re-run with `DATABASE_URL=postgresql://contentos_dev:change-me@127.0.0.1:5432/contentos_test`: **180/180 tests passed**, 0 failed, duration 27.1s.
- No source or migration changes have been made yet on the integration branch; next task is the explicit `main@752e8c4` convergence.

### Execution updates

- Merged `main@752e8c4` with an explicit non-fast-forward merge (`bafd081`) and verified both the accepted Project Center baseline `d257229` and main convergence commit are ancestors of `integration/contentos-v1`.
- Migration RED/GREEN gate found the reviewed Publisher state migration absent from the baseline. Added `0006_publisher_state.sql` and its down migration, then added an isolated-schema migration matrix so each run uses the existing PostgreSQL service without requiring CREATEDB privileges.
- Added Publisher contract boundaries for real platform IDs, credential references, immutable snapshot digests, browser-session lifecycle and secret-safe environment credential resolution. Playwright is isolated under the infrastructure browser package and is not called from request handlers.
- Added durable Douyin HTTP and WeChat Channels Playwright adapters with Postgres-backed publication state, idempotency and UNKNOWN_EXTERNAL_STATE reconciliation. WeChat manual confirmation maps to the current `REQUIRES_VERIFICATION` application state because the frozen 0009 constraint does not contain a separate `HUMAN_CONFIRMATION_REQUIRED` value.
- Added a disabled-by-default Publisher adapter registry and composed real adapters only in the Publisher Worker. The worker checks platform, asset checksum, credential resolution, storage and profile boundaries before invoking an adapter; Fake Publisher remains the default path.
- Added `test:integration-closure` for the new contract, adapter, state, migration and real-worker gates. The Stage 1 combined Fake Director→Video→Approval→Publisher E2E and final acceptance report remain outstanding.
