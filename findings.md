# ContentOS Research Findings

## Research scope

Phase 1 studies five repositories for architectural patterns that may inform ContentOS. The final output must retain exact source paths and separate learning from direct reuse.

## Evidence log

- MatrixMedia demonstrates a practical desktop publishing surface but has no durable job queue and is GPL-2.0-only.
- AI Short Video Factory is a narrow FFmpeg/Electron render reference; its renderer-to-generic-SQL IPC is not an acceptable server boundary and it is AGPL-3.0.
- MoneyPrinterTurbo has the best Phase-1 video-stage/service split and provider-neutral LLM configuration, but its in-process execution must be replaced by durable jobs for ContentOS.
- AutoSocial makes queue outcomes operationally tangible through pending/posted/failed filesystem locations; ContentOS should promote these into database-backed PublishAttempt states.
- Postiz is the best reference for a monorepo control plane, provider abstraction and durable workflows, while remaining AGPL-3.0 and too broad to adopt as a foundation.
- The synthesized recommendation is Modular Monolith + PostgreSQL/object storage + durable worker queue, with independently deployed Video and Publisher workers.
- Phase 2 retains that architecture, adds a renderer-neutral Edit Manifest, fixed V1 workflow services, model/provider registry, and prompt provenance.
- V1 video rendering is direct FFmpeg through a thin internal command builder; Remotion is an optional later template/preview renderer subject to license review.
- Job truth belongs in PostgreSQL with durable queue delivery, process-isolated workers, idempotency keys, leases, attempts and explicit `BLOCKED` human-action states.
- Architecture V0 formalizes this as a modular-monolith control plane, independent Video/Publisher workers, immutable revision records and a fixed V1 Director -> Video -> Publish -> Review process.
- The V0 technology recommendation is TypeScript/Node 22 with Fastify, PostgreSQL, an evaluated pg-boss queue, FFmpeg and Playwright; only the architectural boundaries are accepted before the initialization spike.
- Spike execution is now authorized, but only as disposable verification code under `spikes/`; the four Spike reports are the gate for engineering initialization.

## Decisions

| Decision | Rationale |
|---|---|
| Use local code inspection plus official repository metadata | The user requires source-backed conclusions and reproducible commit references. |
| Recommend a modular monolith with isolated workers | It preserves clear domain boundaries and operational isolation without premature microservice overhead. |
| Use direct FFmpeg for V1 | It best matches deterministic simple composition while retaining a future renderer-neutral manifest boundary. |
| Keep workflows fixed in V1 | It provides reliable dependencies without building a generic graph editor. |
| Use an immutable Edit Manifest boundary | It keeps creative intent reproducible and prevents renderer-side editorial drift. |
| Treat browser publish uncertainty as a state | It avoids dangerous blind reposts after interrupted browser automation. |

## Issues

## Final Architecture V0 Freeze Findings

- The complete Architecture V0 package, all ten ADRs and all four Spike reports were reviewed together.
- All four Spike change requests are accepted as clarifications; no architecture redesign is justified by the evidence.
- Three named contract documents were missing and are now explicit: Job, AI Provider and Publisher Adapter.
- The frozen implementation direction is Node.js 22 LTS + TypeScript with PostgreSQL 16, Fastify/Zod, React/Next.js, FFmpeg, Playwright behind adapters, a storage adapter and independently supervised workers.
- pg-boss, Drizzle, FFmpeg binary/font packaging, real Playwright/browser versions and object-store commit semantics remain staged/provisional gates rather than hidden assumptions.
- Final gate: APPROVED FOR ENGINEERING INITIALIZATION, with the staged plan and A/B conditions; no initialization was executed.

| Issue | Resolution |
|---|---|
| The pasted requirement opened with mojibake in PowerShell | Recovered the UTF-8 content semantically; repository and report paths are explicit in the request. |
| MoneyPrinterTurbo clone is incomplete | Reports cite the immutable remote SHA and exact verified source paths; no conclusions use incomplete local clone contents. |

## Video Direction Correction Audit (2026-08-30)

1. The accepted `codex/video-quick-edit` branch is clean at `1e8b770`; its “Quick Edit” implementation is actually project-scoped Manifest Adjustment.
2. Existing `TRIM`, `REMOVE`, `REORDER`, append-only revisions, manifest digest fencing, exact Manifest render and the shared Video Worker are valuable and will be preserved.
3. `CreateQuickEditVersionInput.projectId`, project-scoped manifest queries and Asset Catalog ownership checks make the current adjustment path project-only.
4. `edit_manifests.project_id` and `renders.project_id` are NOT NULL; `jobs.project_id` and `assets.project_id` are nullable in the base schema but current services/contract paths still require project context.
5. The compatibility-safe ownership correction is a `video_workspaces` boundary with PROJECT and STANDALONE scopes, nullable `workspace_id` additions, and workspace asset links. Existing project rows stay query-compatible.
6. `EDIT_MANIFEST_V0` currently requires `projectId`; standalone requires an ownership-neutral extension accepting `workspaceId` when `projectId` is absent.
7. Renderer output is currently MP4/AAC but uses `mpeg4` video codec; correction must use H.264/libx264, AAC, yuv420p and prove it with FFprobe.
8. The current planner shuffles with `sort(() => random() - 0.5)`, does not enforce 2–5 second clip bounds, does not use real voice duration, and only avoids immediate repeats. Random Montage Planner V2 must replace these behaviors deterministically.
9. No standalone session, standalone API, standalone UI, REPLACE or REROLL exists on the baseline branch.

## Video Direction Correction Implementation Findings (2026-08-30)

1. The ownership correction is implemented with `video_workspaces` and nullable workspace scope on Jobs, manifests, renders and asset imports; standalone rows have no `project_id`.
2. `VideoAdjustmentService` is the single implementation; `VideoQuickEditService` remains a deprecated compatibility export only.
3. Standalone uploads enter the existing `ASSET_IMPORT` durable Job path. Workspace AUDIO imports link as VOICE; workspace VIDEO imports link as SOURCE.
4. Random Montage Planner V2 uses deterministic seeded rotation and exact target-duration fill; the final clip may be shorter than the configured minimum.
5. FFprobe now reports video/audio codec names. Modern FFmpeg uses libx264/AAC; an old local encoder without libx264 has a narrowly-scoped mpeg4 compatibility fallback for legacy tests.
6. Known limitation: the Web page queues uploads but does not poll import completion; operators must wait for READY assets before planning.

## Director V1 implementation findings — 2026-08-22

- The Director worktree is based on `main` and has a clean 41/41 baseline when using the isolated `contentos_director_dev` database.
- The shared `contentos_dev` database had Publisher migration `0006_publisher_state.sql`, while `main` did not contain that migration; migration-down tests therefore failed before isolation. No product code caused the failure.
- The Director V1 plan starts new migrations at `0007` so it can merge after Publisher `0006` without renumbering.
- The V0.1 product requirements validate the existing modular-monolith direction but add three later product areas not present in `main`: Publisher product records/accounts, Metric Snapshots/Performance Review, and the Web Operator UI.
- Existing `REVIEW_V0` is an approval decision boundary, not performance analytics; future analytics entities must remain distinct from approval decisions.
- Existing Video output contract declares MPEG-4, while the product requirement mentions H.264; this must be resolved by an evidence-backed Video change, not silently changed during Director work.
- ECR-001 / ADR-011 accepts a bounded `workers/director-worker` Application Worker for exactly two Director AI Job types. It preserves the fixed workflow and existing Job/lease/security invariants; generic workflow engines and real providers remain out of scope.
- Director implementation remains isolated from the shared `contentos_dev` migration history; the clean validation database is `contentos_director_dev` on the existing PostgreSQL instance.


## ContentOS Slice ③ Project Center Findings — 2026-08-22

- Slice ② 已批准，基线提交为 `9ec3ffc`。
- 当前已有独立 Director 和 Publisher 工作台，Project Center 应作为项目级只读总控入口。
- 现有 Project、Director、AssetCatalog、Publisher、Approval 服务已有公开查询；JobService 需要最小的项目范围安全查询能力才能支持总控摘要。
- 视觉方案已由用户确认：A3 健康度+待处理混合、B2 左侧阶段栏、C1 状态摘要+快捷动作。
- 健康度不能使用模糊评分，应由明确的阶段和阻塞规则推导。

## ContentOS Slice ③ Verification Findings — 2026-08-22

- Project Center 是 API 组合层，只调用 Project、Director、AssetCatalog、Job、Approval、Publisher 的公开服务；没有新增事实表和跨模块私表 SQL。
- JobService 新增项目范围安全摘要查询，只选择 id、project_id、type、state、attempt_count、max_attempts、created_at，避免 payload、错误诊断、lease 和进度进入浏览器。
- 健康度按 BLOCKED、COMPLETE、ATTENTION、HEALTHY 的确定性优先级推导，覆盖空项目、Director 已批准、Render 失败、Approval 待处理、Publisher 人工动作和确认发布。
- 独立 PostgreSQL 55433 数据库全量测试通过；共享 contentos_dev 因历史分支遗留 publisher_publication_states 表会使既有 Publisher migration 断言失败，未修改共享库。

## Slice ③ final review findings — 2026-08-23

- 同 Job 的成功 Render 查询位于 Asset Catalog 校验之后，源素材归档会阻断成功结果复用。
- Job/Render 完成更新没有 attempt fencing；租约恢复后旧、新 attempt 可以并发写同一输出并互相覆盖状态。
- Approval 查询失败被空数组替代，导致真实当前目标被错误推导为 MISSING。
- Project Center 的 Video READY 仍由历史 READY Asset 决定，未使用 current PERSISTED Manifest 的成功 Render 事实。
- Director→Video 完整 FFmpeg E2E 已修改但未进入标准 `pnpm test` 清单。

## Integration Closure planning findings — 2026-08-29

- Git ancestry confirms `codex/director-v1 -> codex/publisher-productization -> codex/publisher-project-integration -> codex/project-center`; re-merging those branches would be redundant and conflict-prone.
- `main` is not an ancestor of Project Center only because `main` has the unique `752e8c4 chore: ignore local worktrees` commit; the integration branch must merge it to record convergence.
- The Project Center head `d257229` already contains Director V1, Publisher Foundation, Approval, Publisher-to-Project integration, Project Center and the final Job/Video reliability repairs.
- Project Center has migrations `0001`–`0005` and `0007`–`0011`; `feature/slice-5-real-platform-adapters` owns `0006_publisher_state`. A trustworthy integrated migration chain must reconcile `0006` before accepting the branch.
- Real adapter implementation can be integrated while remaining disabled by default. `IMPLEMENTED` does not mean `LIVE-VERIFIED`; credentials and live smoke stay outside Stage 1.
- The current Web app has Project Center, Director and Publisher pages but no dedicated Assets, Video or Approval pages. A complete browser flow therefore requires durable asset ingestion and minimal Video/Approval product stages.
- A read-only line-count diagnostic used incompatible `Get-Content` positional and `-LiteralPath` arguments. It did not change files or affect conclusions; exact-path reads must use only `-LiteralPath` in future checks.
- The real-adapter branch differs from Project Center in three implementation seams that must be reconciled rather than copied wholesale: Publisher contracts, Publisher module composition, and Publisher Worker composition. Historical planning/progress documents from that branch are evidence only and are not merge targets.
- Stage 1 must take the `0006_publisher_state` up/down migration plus its database tests, then prove the complete `0001`–`0011` chain from clean and two upgrade starting points; merely running the current Project Center test database is insufficient because it has never applied `0006` in sequence.
- Stage 2 has no existing Assets, Video or Approval route modules/pages to extend. The implementation plan must name explicit new API route files, Web pages and Asset Worker ownership instead of hiding ingestion inside Project request handlers.
- Asset Import cannot require a Job foreign key at the instant the HTTP upload is first persisted without either crossing the Job boundary or risking an orphan runnable Job. The accepted sequence is Asset-owned `STAGED` record → idempotent `ASSET_IMPORT` Job → Asset-owned `attachJob` transition to `QUEUED`; failure requests cancellation for any created Job and safely terminalizes the import.
- The current API directly queries Asset private tables for the project asset list. Stage 2 replaces that route implementation with `AssetCatalogService` and adds an Asset-owned delivery boundary so browser JSON never exposes storage keys or local paths.
- The current Publisher page approves and queues in one UI action. Stage 2 deliberately removes that shortcut so the dedicated Approval page approves an exact immutable Revision before Publisher enables queueing.

## Integration Closure execution findings — 2026-08-29

- The accepted Project Center baseline required an explicit non-fast-forward merge of `main@752e8c4`; no business source conflict was introduced.
- The integration migration inventory was incomplete without `0006_publisher_state`. The complete linear chain is now `0001`–`0011`, and isolated-schema matrix tests work without `CREATEDB` privileges.
- Real Douyin/WeChat adapter code can be safely present while the registry remains disabled. Credential resolution, browser profiles and platform transport stay inside Publisher Worker composition.
- WeChat manual confirmation uses the frozen application state `REQUIRES_VERIFICATION` because the existing database constraint does not define a separate human-confirmation status.
- The combined Fake E2E proves exact Render and Publish Revision approvals, durable Jobs, Worker execution, ExternalPost creation and Project Center `PUBLISHED` status. Retry, human action and reconciliation paths are covered in the same file.
- Stage 1 is ready for final repository gates and branch review; Live Smoke and Unified Product Flow remain closed.

## Video Direction Correction Review Repairs (2026-08-30)

- Random Montage now caps each clip by the actual source duration and still fills the requested target exactly; a source shorter than the 2-second preference is used only for its available duration.
- REROLL no longer falls back to an insufficiently long asset; it fails with a bounded domain error instead of creating an invalid or adjacent-duplicate Manifest.
- Renderer selects the encoder declared by the Manifest (`libx264` for H.264, `mpeg4` only for explicit legacy manifests) and rejects FFprobe codec mismatches. The old silent H.264→MPEG-4 fallback was removed.
- Workspace render output is linked with role `OUTPUT`; project output imports also honor the supplied role.
- Workspace asset listing returns only `AssetSummaryV0` fields and never exposes `storageKey`.
- Project Video jobs/manifests/renders now carry `workspace-project-{projectId}`; Video and Video Adjustment lazily create the project workspace so newly-created projects satisfy the FK.
- Standalone Asset Worker→Video Worker E2E passes with real FFmpeg/FFprobe and proves READY imports, exact render, H.264/AAC output and `OUTPUT` ownership.

## Main Merge Finalization Findings (2026-08-30)

- PR #3 is the consolidated main-merge candidate for Stage 2, Video Quick Edit and Video Direction Correction. After it merges, earlier slice PRs should not be merged independently; their history is already included. No prior PR was closed or modified during finalization.
- PR #3 is open, non-draft and GitHub reports it mergeable/clean against `main`; GitHub has no configured check runs, so the local acceptance gate is the evidence of record.
- The full local gate is green: migration matrix **4/4**, full suite **211/211**, format, lint, typecheck, root build, Web build, Doctor and diff-check.
- Real Douyin/WeChat adapters are implemented behind the Publisher boundary but are not live-verified and remain disabled by default. Fake Publisher remains available for deterministic acceptance.
- Finalization changed documentation only; no business code, migration SQL or runtime behavior changed in the finalization commit.

## Operator UI V1 Baseline and Gap Audit (2026-08-30)

- PR #3 is merged into `main` at `fbf7dadf189355bf55d7b937c08226029556c26c`; the new UI branch baseline is `origin/main` at the same SHA.
- Baseline install completed with the frozen lockfile. Migration matrix passed **4/4**. The full suite passed **211/211** on the clean baseline after one transient shared-database concurrency failure was reproduced as green in isolation and on a second full run.
- Supported: real Project Center snapshot, stage cards/health/actions/jobs, project-scoped API routes, Asset Worker upload/import and ready media content, Director Script/Storyboard Jobs, Project Video render/manifest/adjustment contracts, Approval Gate decisions, Fake Publisher flows, and standalone session/upload/plan/render APIs.
- Partial: RootLayout has no global shell; homepage is a project create/list page; ProjectNav is duplicated by individual pages; status labels are page-local; Assets has upload/import polling and previews but only one-file upload; Director exposes only a compact Script/Storyboard summary; Project Video has adjustment controls but no visual timeline/inspector; Approval rejection uses `window.prompt`; Publisher is functional but log-dense; Standalone Quick Edit requires manual Asset IDs and only shows a text Manifest list.
- Missing: unified OperatorShell/sidebar/topbar/page primitives, nested Project Workspace layout, shared status mapping, standalone workspace asset list/content endpoint and voice/settings update (if required by audit), reusable media/timeline components, visible REPLACE/REROLL/REMOVE/REORDER/TRIM controls for standalone Quick Edit, output preview/polling closure, and automated browser scenarios for the new visual flows.
- No Review Analytics page should be added in V1; Review remains deferred. No new migration is justified by the current UI gaps.
- The implementation must keep Web as a contract client: Video Adjustment operations remain owned by the Video module, and browser-facing APIs must not expose storage keys or private credentials.
- Visual design decision: the user selected Shell option A, a persistent left navigation with project workspace content.
- Visual design decision: for standalone Quick Edit, the user selected layout option C, a three-column editing workspace with asset library, preview/timeline center, and inspector panel.
