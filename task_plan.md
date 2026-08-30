# ContentOS Architecture Research Plan

## Objective
Produce the formal ContentOS Architecture V0 design package—modules, data models, contracts, process boundaries, ADRs and architecture review—without implementing ContentOS product code.

## Current phase
Architecture V0 — formal design documentation and self-review.

## Phases
### Phase 1: Research workspace and repository inventory
- [x] Create the prescribed `research/` structure.
- [x] Clone or otherwise obtain the five Phase-1 repositories.
- [x] Record commit SHA, branch, license, language, and primary frameworks.
- **Status:** complete

### Phase 2: Evidence collection and per-project reports
- [x] Trace code paths for modules, data flow, jobs, extensibility, and failure handling.
- [x] Write one report per repository under `research/reports/` using the user’s 14 required questions.
- **Status:** complete

### Phase 3: Cross-project synthesis
- [x] Create `research/architecture/comparison.md`.
- [x] Answer the requested A–G Phase-1 conclusions with citations to local reports.
- **Status:** complete

### Phase 4: Verification and handoff
- [x] Validate repository metadata, report completeness, and link/path accuracy.
- [x] Update research log and stop at Step 8; do not implement ContentOS.
- **Status:** complete

### Phase 5: Phase-2 repositories and evidence
- [x] Create the separate Phase-2 research directories without changing Phase-1 artifacts.
- [x] Obtain or source-verify OpenShorts, Remotion, matrix, douyin-web, n8n, Open WebUI and AnythingLLM.
- [x] Record exact source paths, commit SHA, branch, license and evidence provenance.
- **Status:** complete

### Phase 6: Question-driven analyses
- [x] Analyse Video Engine references and issue FFmpeg/Remotion decision plus Edit Manifest V0.
- [x] Analyse job/workflow and publisher-worker references and issue Job Model V0 plus queue decision.
- [x] Analyse provider references and issue AI Provider V0 design.
- **Status:** complete

### Phase 7: Architecture validation and stop
- [x] Review the ten required architecture rules (agree/modify/reject).
- [x] Validate the Phase-1 modular-monolith conclusion and produce all 12 requested Phase-2 documents.
- [x] Stop; do not create ContentOS application, database, UI, worker or API code.
- **Status:** complete

### Phase 8: Architecture V0 foundations
- [x] Define system/control-plane/module boundaries and allowed dependencies.
- [x] Define ContentProject, database, asset, job and worker models.
- [x] Define API, configuration, observability, directory and test architecture.
- **Status:** complete

### Phase 9: Module contracts and decisions
- [x] Define Video, Publisher, Director, AI and Review module contracts.
- [x] Record ten ADRs and architecture invariants.
- [x] Create Architecture V0 summary and self-review report.
- **Status:** complete

### Phase 10: Stop for human architecture review
- [x] Verify every required design artifact and boundary rule.
- [x] Stop without creating app/API/UI/worker/database implementation.
- **Status:** complete

### Phase 11: Spike 01 - PostgreSQL, pg-boss and Worker
- [x] Create only `spikes/spike-01-job-worker/` and its evidence/report files.
- [x] Run normal, crash-recovery, retry, terminal-failure, duplicate-delivery and cancellation scenarios.
- [x] Stop if an architecture blocker appears.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 12: Spike 02 - Edit Manifest to FFmpeg
- [x] Create only `spikes/spike-02-video-render/` and its evidence/report files.
- [x] Run seeded planner, real fixtures, subtitles, portrait output, transition, invalid input and interruption scenarios.
- [x] Capture five repeatable outputs and manual-observation notes.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 13: Spike 03 - Asset staging and promotion
- [x] Create only `spikes/spike-03-asset-promotion/` and its evidence/report files.
- [x] Run checksum/deduplication, Unicode path, crash-window and cleanup scenarios.
- [x] Record a V0 storage recommendation or architecture change request.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 14: Spike 04 - Publisher Worker isolation
- [x] Create only `spikes/spike-04-publisher-worker/` and its evidence/report files.
- [x] Run fake-platform success, auth, verification, DOM change, browser crash, worker crash, redaction and profile-isolation scenarios.
- [x] Never access a real platform/account.
- **Status:** complete; PASS WITH CONDITIONS

### Phase 15: Spike gate and handoff
- [x] Produce four reports, `SPIKE_VALIDATION_SUMMARY.md`, evidence index and any architecture change requests.
- [x] Verify only `spikes/` changed for implementation artifacts and no formal product directories were created.
- [x] Stop for human architecture review; defer engineering initialization until the four conditions are accepted.
- **Status:** complete; READY FOR HUMAN ARCHITECTURE REVIEW

### Phase 16: Final Architecture Review and V0 Freeze
- [x] Read the complete Architecture V0 package, all ADRs and all Spike reports.
- [x] Classify every Spike condition and decide every architecture change request as ACCEPT/REJECT/DEFER.
- [x] Update only evidence-supported architecture documents and add the missing contracts/status indexes.
- [x] Produce the Freeze Report, Technology Stack, Engineering Initialization Plan and AGENTS.md without executing initialization.
- **Status:** complete; APPROVED FOR ENGINEERING INITIALIZATION

### Phase 17: Engineering Initialization and first vertical slice
- [x] Complete Stage 0 formal workspace/tooling scaffold and verification gates.
- [x] Complete Stage 1 PostgreSQL development cluster, migrations and migration tests.
- [x] Complete Stage 2 config, structured logging, error envelope and redaction tests.
- [x] Complete Stage 3 Job contract, attempts, retry/cancel/reconciler and queue adapter.
- [x] Complete Stage 4 Video/Publisher worker bootstrap composition roots.
- [x] Complete Stage 5 ContentProject service/API and tests.
- [x] Complete Stage 6 local Asset staging, dedupe, promotion and reconciliation.
- [x] Complete Stage 7 deterministic video planner, EDIT_MANIFEST_V0, FFmpeg renderer and E2E vertical slice.
- [x] Produce initialization report and next-slice handoff, then stop.
- **Status:** complete; ENGINEERING INITIALIZATION PASSED

### Phase 18: Slice 2 Director foundation
- [x] Freeze `DIRECTOR_PLAN_V0` contract and validation tests.
- [x] Add append-only Director revision migration and current approved pointer.
- [x] Implement Director create/revise/accept/approve/current service use cases.
- [x] Add thin Director API routes and validation/transition tests.
- [x] Run final build/doctor, commit and push the slice.
- **Status:** complete; implementation, 27-test gate and remote push are green

### Phase 19: Slices 3, 4 and 6 implementation
- [x] Connect an approved Director revision to an idempotent Video Job and API route.
- [x] Implement the platform-neutral Fake Publisher contract, isolated fake service and Worker handler.
- [x] Implement append-only Review decisions, approval/rejection transitions and API routes.
- [x] Run the final format/lint/typecheck/test/build/doctor gate.
- [x] Commit and push.
- **Status:** complete; Slices 3, 4 and 6 are implemented, verified and pushed. Slice 5 real platform adapters explicitly deferred.

### Phase 22: Director V1 implementation
- [x] Create isolated `codex/director-v1` worktree from `main` and verify the clean 41-test baseline with `contentos_director_dev`.
- [x] Record the migration-state conflict caused by sharing `contentos_dev` across unreconciled branches.
- [x] Write and review the Director V1 professional design and implementation plan.
- [x] Freeze the Application Worker ADR and record the Director/AI contract gate.
- [x] Add append-only Director V1 and AI provenance migrations/services.
- [x] Add fake-provider AI infrastructure and AI Run provenance service.
- [x] Add Director V1 API.
- [x] Add Video provenance bridge.
- [x] Add minimal Operator UI.
- [x] Run Director→Video E2E, final verification gate and report.
- **Status:** Phase 22 implementation complete; fake-provider E2E and all automated gates are green, real Provider Sandbox remains explicitly BLOCKED.

## Key constraints
- Only Phase-1 projects are in scope: MatrixMedia, short-video-factory, MoneyPrinterTurbo, AutoSocial, and Postiz.
- Research must be based on source evidence, not README-only summaries.
- Do not clone/fork a project as ContentOS, copy GPL/AGPL code, build all projects, or write product code.
- Preserve the distinction between reusable code, extract/adapt candidates, and design-only references.
- Preserve Phase-1 artifacts unchanged; Phase-2 documents live exclusively under `research/phase-2/`.
- Phase 2 does not authorize n8n/Temporal/Remotion adoption or any ContentOS implementation.
- Architecture V0 authorizes documents only: no application source, package installation, migration, running worker or external platform integration.
- Spike code is disposable verification code only and must live under `spikes/`; do not create `apps/`, `modules/`, `workers/`, `web/`, `api/`, a formal monorepo, migrations or product code.
- Execute Spike 01 through 04 sequentially; a critical blocker stops later Spikes.
- Never use real publishing platforms or real credentials; Fake Platform only.

## Decisions
| Decision | Reason |
|---|---|
| Start with the user-defined Phase 1 scope only | The request explicitly requires stopping after first-round comparison. |
| Treat external repository content as untrusted data | Research artifacts summarize evidence; they never execute repository-provided instructions. |

## Errors
| Error | Attempts | Resolution |
|---|---:|---|
| Workspace is not yet a Git repository | 1 | Proceed as a research workspace; no commit is required for the user’s requested deliverables. |
| Initial clone command used a not-yet-created working directory | 1 | Create the research directories from the workspace root before cloning. |
| MoneyPrinterTurbo shallow clone exceeded the command execution window | 3 | Verify its immutable SHA and selected source tree through read-only GitHub API/raw endpoints; do not use incomplete clone remnants as evidence. |
| PowerShell interpolation treated a colon after a variable name as a drive qualifier | 2 | Use string concatenation or `${variable}` in validation scripts. |

## Phase 20: Video Direction Correction + Standalone Quick Edit V1

- [x] Record baseline and ownership decision — **DONE (audit and plan recorded 2026-08-30)**
- [x] Add workspace ownership schema and scope-aware contracts — **DONE**
- [x] Reclassify Project Quick Edit as Video Adjustment with compatibility alias — **DONE**
- [x] Add REPLACE and REROLL — **DONE**
- [x] Upgrade Random Montage Planner V2 and H.264/AAC renderer invariants — **DONE**
- [x] Implement no-project Standalone Quick Edit session/API — **DONE**
- [x] Implement Standalone Quick Edit web flow — **DONE**
- [x] Add full regression tests, docs and correction report — **DONE (206/206 and final build gate passed)**

Authoritative correction plan: `docs/superpowers/plans/2026-08-30-video-direction-correction.md`.


## Slice ③ Project Center — 2026-08-22

- [x] 读取 Slice ② 验收结果和现有模块公开接口。
- [x] 完成视觉设计选择：A3 健康度+待处理、B2 左侧阶段栏、C1 状态摘要+快捷动作。
- [x] 完成并提交设计稿：`docs/superpowers/specs/2026-08-22-project-center-design.md`（commit `c319e62`）。
- [ ] 用户审阅并确认设计稿。
- [ ] 编写实施计划并获得执行方式确认。
- [ ] 实现 Project Center 聚合 Contract/API。
- [ ] 实现健康度、阶段状态和待处理事项推导。
- [ ] 实现桌面横屏 Web 页面和响应式收窄布局。
- [ ] 添加 API、规则、Web 回归测试并执行完整 Gate。

- [x] Slice ③ Contract、Job 安全摘要、健康度规则、聚合 API、横屏总控页和回归测试已完成。
- [x] 隔离数据库全量 Gate：128 tests passed；typecheck、lint、Web build、diff-check 通过。
- [x] 已确认格式检查失败来自 Windows 工作区既有 CRLF，不是 Slice ③ 文件特有问题；主线工作区同样复现。

约束：基于已验收分支 `codex/publisher-project-integration`；不跨读模块私表；不在 Project Center 重复执行模块写操作；不启动 Slice ④、⑤、⑥。

## Slice ③ final review repair — 2026-08-23

- [x] RED：覆盖成功 Render 在源素材不可用时仍可复用。
- [x] RED：覆盖租约恢复后旧 attempt 不能覆盖新 attempt，并使用隔离输出路径。
- [x] RED：覆盖 Approval 读取失败时不生成伪 MISSING 动作。
- [x] RED：覆盖旧 READY Asset 不能掩盖当前 Render 运行状态。
- [x] 将 Director→Video 全链路 E2E 纳入标准测试命令。
- [x] RED/GREEN：覆盖租约恢复后、下一次 claim 前的旧 attempt 落库窗口。
- [x] RED/GREEN：Asset 导入与 Render 完成进入 Job 公共 attempt fence，旧 attempt 不产生 READY Asset。
- [x] RED/GREEN：取消信号从 JobRunner 传播到 FFmpeg，取消落为 CANCELLED 且不重试。
- [x] 清理每个 FFmpeg attempt 的临时输出文件。
- [x] RED/GREEN：4 个并发 attempt fence 不再因嵌套借连接耗尽 `max=4` 连接池。
- [x] RED/GREEN：Asset、Render、JobAttempt、Job 最终化使用同一 PostgreSQL 事务，失败整体回滚。
- [x] RED/GREEN：Video 公开 Render 转换只接受不可伪造的活跃 Job attempt scope；取消 Render 落为 CANCELLED。
- [x] RED/GREEN：正在运行的 FFmpeg 收到 abort 后终止并删除 `.part.mp4`。
- [x] RED/GREEN：崩溃 Worker 的 CANCEL_REQUESTED lease recovery 通过 Video 公共 callback 原子关闭 Render；缺 callback 时保持待取消而不伪造终态。
- [x] RED/GREEN：当前 attempt 的 startRender=false 抛出 invariant error，不再把 Job 记为成功。
- [x] 文件 hash/probe/stage/promotion 移到短数据库事务之前；abort 等待子进程 close 后再返回。
- [x] cancellation callback 返回 handled；混合 Job 类型不会被错误收敛为 CANCELLED。
- [x] lease recovery 改为逐 Job 独立事务；poison callback 只回滚自身，不阻塞其他 Job。
- [x] Prepared Asset 改为模块内部 branded capability，并验证 storage owner 与 blob 存在。
- [x] 组合式 Video Worker 启动即执行并周期运行 lease recovery，shutdown 停止并等待；真实 CLI 与 dev-operator 已接线。
- [x] Video Worker 启动即消费并周期轮询 PostgreSQL 中的待运行 `VIDEO_RENDER` Jobs；E2E 不再手工投递。
- [x] RED/GREEN：首轮消费长期运行时，lease reconciliation 仍按独立周期执行且 Worker 启动不被阻塞。
- [x] 更新 ADR/设计证据并完成格式、类型、Lint、构建、全量测试、doctor、diff-check 与独立复审。

**Status:** complete; 180/180 tests and final independent review passed

## ContentOS Integration Closure + Unified Product Flow planning — 2026-08-29

- [x] 恢复并核对现有规划文件、治理文档和分支状态。
- [x] 确认第一步终点：只推送 `integration/contentos-v1`，不自动合并 `main`。
- [x] 核验分支祖先关系和迁移编号，确认 Project Center 已包含 Director V1 与 Publisher Project Integration。
- [x] 比较三种集成方式并选择以 `codex/project-center@d257229` 为集成基线。
- [x] 确认 `0006_publisher_state` 与真实 Adapter 代码在第一步集成，但保持默认关闭且不做 Live Smoke。
- [x] 冻结第一步 Integration Closure 与第二步 Unified Product Flow 的设计边界、数据流和 Gate。
- [x] 写入设计文档 `docs/superpowers/specs/2026-08-29-contentos-integration-and-unified-flow-design.md`。
- [x] 用户审阅并确认书面设计。
- [x] 分别编写第一步和第二步实施计划并完成自检。
- [ ] 用户选择后续执行方式。

**Status:** written design and both implementation plans complete; awaiting execution-mode selection; no business code changed

## Integration Closure execution — 2026-08-29

- [x] Created `E:\ContentOS\.worktrees\integration-contentos-v1` from the accepted Project Center head and recorded the baseline.
- [x] Converged `main@752e8c4` with an explicit merge commit.
- [x] Restored Publisher migration `0006` and added clean/upgrade migration matrix coverage.
- [x] Extended Publisher contracts, browser-session and credential boundaries.
- [x] Added durable Douyin and WeChat Channels adapters with idempotency and reconciliation.
- [x] Composed the real adapters behind a disabled-by-default Publisher Worker registry.
- [x] Added the integrated Director→Video→Approval→Fake Publisher E2E and retry/auth/reconciliation scenarios.
- [x] Synchronized architecture, governance, local setup and Publisher documentation; created the acceptance report.
- [x] Run the final lint/build/doctor/secret scan and full acceptance gate.
- [ ] Push `integration/contentos-v1` and wait for user acceptance.

**Status:** implementation and final repository gate complete; push pending

## Phase 23: Video Direction Correction Review Repairs — 2026-08-30

- [x] Add regression tests for planner bounds, REROLL safety, codec enforcement, output ownership, asset API redaction, project workspace propagation and standalone worker coverage.
- [x] Fix planner and adjustment invariants without changing the frozen product scope.
- [x] Fix renderer codec contract and workspace output role.
- [x] Remove storage-key leakage and complete Project workspace propagation.
- [x] Add standalone upload/import/render worker E2E coverage.
- [x] Run final format/lint/typecheck/build/doctor/diff-check gate and commit; do not push or merge.

**Status:** complete; review repairs implemented, verified and committed as `c0943ff`; no push or merge

## Main Merge Finalization — 2026-08-30

- [x] Verify `codex/video-direction-correction` source head, `origin/main` base head and PR #3 metadata.
- [x] Confirm Stage 2, Video Quick Edit and Video Direction Correction accepted baselines are ancestors.
- [x] Recheck migrations `0001`–`0018`, up/down pairs and the `0016` rollback boundary.
- [x] Run migration matrix **4/4**, full test suite **211/211**, format, lint, typecheck, root/Web builds, Doctor and diff-check.
- [x] Check secret/artifact safety and real-adapter default-off behavior.
- [x] Synchronize finalization documentation and prepare one docs-only finalization commit.
- [x] Push the feature branch and recheck PR #3; do not merge, force-push, delete branches/worktrees or alter `main`.

**Status:** complete; PR #3 ready for human merge into `main`

## Operator UI V1

- [x] Baseline: fetch `origin/main`, verify PR #3 ancestry, create `codex/operator-ui-v1` worktree.
- [x] UI Audit: classify current Web capabilities as SUPPORTED / PARTIAL / MISSING.
- [x] Global Shell
- [x] Project Workspace Layout
- [x] Status Mapping
- [x] Standalone Asset UX
- [x] Standalone Timeline
- [x] Five Adjustments
- [x] Standalone Render Preview
- [x] Director Visualization
- [x] Project Video Visualization
- [x] Approval Visualization
- [x] Publisher Visualization
- [x] Browser Acceptance
- [x] Full Gate
- [x] Docs
- [x] Push
- [x] PR

**Status:** PR #4 acceptance repair is implemented; final local gates and browser acceptance are green, and human visual acceptance remains pending.

## Operator UI V1 Acceptance Repair

- [x] Historical Manifest read-only semantics
- [x] Formal Project Video adjustment route
- [x] Storyboard duration contract correction
- [x] Five-operation browser acceptance
- [x] Voice-driven planner defaults
- [x] Plan-time settings lock
- [x] Docs / PR truth sync
- [x] Final Gate
- [x] Push Repair
- [x] Recheck PR #4

## Operator UI V1 Final Merge Repair

- [x] Selected/current Manifest identity separation
- [x] Historical picker truth
- [x] Historical browser regression
- [x] Domain primary Voice lock
- [x] Voice lock integration/API regression
- [x] Full Gate
- [x] Docs Sync
- [x] Push
- [x] PR #4 Recheck

## Phase 24: Main Hardening V1 — P0/P1/P2 Full Repair (2026-08-30)

**Objective:** Execute the approved `ContentOS Main Hardening V1` prompt on the isolated branch `codex/main-hardening-v1`, preserving modular-monolith boundaries and leaving `main` untouched until human review.

- [x] Baseline audit and test inventory; record evidence before implementation.
- [x] P0 security/runtime hardening (Next/package audit, localhost binding, runtime secret safety).
- [x] P1 Approval target/gate architecture correction and migration compatibility (domain/API resolver, legacy-role migration mapping and full DB gate verified).
- [x] P2 Approval revision allocation uses transaction advisory locking with regression coverage.
- [x] P2 Project Center/Assets/Storyboard Planner V1 contract, manual binding UI, exact duration/provenance and UI gaps addressed in this pass.
- [x] P2 Publisher profile and LocalStorage path containment.
- [x] P2 tooling: ESLint, Prettier, test discovery and inventory.
- [x] P1 GitHub Actions CI workflow added; main-branch protection still requires repository permission assessment.
- [x] Documentation and final audit recorded; full DB/migration gate verified with the local test infrastructure (browser harness skips remain explicit).
- [ ] Create PR and stop for human merge decision; never auto-merge hardening.

**Current phase:** Local hardening verification complete; awaiting human review before commit/PR/merge.

## Phase 25: Review Analytics V1 (2026-08-30)

**Objective:** Build the approved Fake/Import post-publish analytics slice on `codex/review-analytics-v1`, preserving Approval/Publisher boundaries and leaving `main` untouched.

- [x] Audit existing ExternalPost, Job, AI Provider and legacy Review boundaries.
- [x] Approve and commit Review Analytics V1 design.
- [x] Write implementation plan with contract, migration, service, worker, API, UI and acceptance gates.
- [ ] Implement Review Analytics V1 in the isolated worktree.
- [ ] Run focused RED/GREEN tests, full regression and browser acceptance.
- [ ] Update reports/ADR status and push the feature branch for human review.

**Status:** Tasks 1–9 implemented; final documentation and verification in progress. Database/browser integration remains environment-blocked until PostgreSQL schema privileges are available.

## Phase 26: Review Analytics V1 execution closure (2026-08-30)

- [x] Contracts, validators and migration 0019.
- [x] Public Publisher ExternalPost reader and Review application services.
- [x] Fake metrics and Review Worker collection/analysis paths.
- [x] AI prompt/provenance extension, API routes and Operator UI.
- [x] Focused contract/worker/AI tests, typecheck and Web build.
- [ ] PostgreSQL migration/integration and isolated browser acceptance with a working test service.
- [ ] Final full quality gate, report and feature-branch push.
