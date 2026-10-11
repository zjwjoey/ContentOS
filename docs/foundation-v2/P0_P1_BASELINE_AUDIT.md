# P0/P1 本地基线审计

日期：2026-10-11（Asia/Shanghai）。审计对象为本地独立 worktree，业务基线为 `27d43854f0571d127bb1ed4ac01334ff294409b2`，开发起点为 Phase0 文档/CI 基线 `9f95f1d`。本报告冻结改动前事实；后续验收见 P0_P1_ACCEPTANCE_REPORT.md。

## Git 与隔离

- VERIFIED：主工作目录 `F:\ai剪辑\ContentOS` 在 `codex/main-ci-hardening-final` / `aa4a8907`，存在未跟踪 `local-media/`。未读取、删除、移动或提交该目录。
- VERIFIED：正常 `git fetch origin` 后 main 与 origin/main 均为 `c8d0dd47`；Foundation V2 / V1 desktop-intelligence 集成分支均为 `27d43854`，相对 main ahead 53 / behind 0。原主工作目录 HEAD 是集成线祖先（ahead 0 / behind 143），不能将主目录当作完整 Foundation 实现。
- VERIFIED：从已核对的 `origin/codex/fv2-phase0-baseline` 建立 `codex/foundation-v2-p0-p1-hardening`，目录 `F:\ai剪辑\.worktrees\contentos-foundation-v2-p0-p1`。桌面 worktree 工具因会话 cwd 并非 Git 仓库返回错误，改用标准 `git worktree add`，未覆盖其他 checkout。
- VERIFIED：未整合的三条可靠性分支：`codex/fv2-claim-retry-at`（`05a8379`）、`codex/fv2-media-analysis-cancel`（`99d324a`）、`codex/fv2-analysis-attempt-fence`（`26ea3d3`）。后者是未激活的分阶段 owner 端口，不能将其视作运行路径已经完成隔离。
- VERIFIED：Runtime、Desktop、Intelligence、Digital Human、production-pipeline、script-v3/v34 功能分支的已提交代码已包含于本集成基线。Git 分支名与历史报告不代替组合验收；各已有 worktree 原样保留。

## 规则、工具链与数据

已读取根 AGENTS.md、七份治理文档、架构 invariants/module dependency、Job/Asset/Video 的服务与 worker 路径、Phase0 可靠性审计及相关 ADR。根目录是唯一 AGENTS.md；模块 README 存在 Reserved 描述漂移，不用其判断功能缺失。

- VERIFIED：Node `v24.14.0`，仓库锁定 pnpm `10.32.1`、TypeScript `5.8.3`、Electron `44.5.0`、Next `14.2.21`、pg / pg-boss / Zod。默认 pnpm 是 `11.25.0`，直接运行触发不兼容 modules 检查；本轮用 `npx --yes pnpm@10.32.1`，冻结安装成功且锁文件无改动。
- VERIFIED：FFmpeg/FFprobe 在 PATH；PostgreSQL 无全局命令或已发现服务，本轮使用仓库 bundled PostgreSQL 18 与实际 PostgresRuntimeManager 启动全新临时 cluster，随机本地端口、专用 `contentos_test`。URL 只在 ignored `.test-results/`；真实开发数据库未连接。
- VERIFIED：迁移 `0001`–`0052` 共 52 个 forward 文件及兼容 rollback-only `0047_digital_human_duration.down.sql`。loader 用完整文件名记录 + advisory lock + 单次迁移事务；矩阵覆盖 clean、历史升级、rollback。未修改共享历史迁移。
- PARTIAL：Windows 中文资源/数据路径初始化触发 `invalid byte sequence for encoding UTF8`；同一 Runtime Manager 使用 ASCII 临时资源别名及数据路径成功。8.3 名称回退不能在本机完全消除此风险。需专项修复及回归；不能据成功对照声明所有中文路径可用。

## 实际模块与证据

状态仅对应下列检查范围，存在实现但没有本轮结果的部分为 IMPLEMENTED_UNVERIFIED。

| 范围 | 基线状态 | 源码/验收证据与缺口 |
| --- | --- | --- |
| API/UI 分层 | PARTIAL | `apps/api/src/app.ts` 组合 application services；`packages/modules/project/src/project-center-service.ts` 汇总 owner ports；Video/Intelligence 部分直接 Asset/Job SQL，不能宣称全仓边界干净 |
| Contract | IMPLEMENTED_UNVERIFIED | `packages/contracts/src` 的版本 schema 与 validators；`tests/contract`；保留 EDIT_MANIFEST_V0，API 多处局部错误返回，统一 handler 固定 correlationId 为 api |
| Job/Worker | PARTIAL | `packages/modules/job/src/job-service.ts` 有持久 attempts、progress、dependencies、lease、cancel、current-attempt fence；claim 未锁内复核 retry_at；连续 lease loss 的预算行为无界，defer 必须保持兼容 |
| Asset | IMPLEMENTED_UNVERIFIED | `asset-service.ts` content-addressed staging/promotion、dedupe、引用与 reconcile；`asset-catalog-service.ts` project/workspace 所有权检查；Hybrid cache 直接写 assets.metadata 是边界债 |
| Director/AI | IMPLEMENTED_UNVERIFIED | DirectorV1Service、DirectorJobService、AIService、Provider/PromptRegistry；Script/Storyboard revisions 和 accepted/approved pointers；`tests/e2e/contentos-integration-vertical-slice.test.ts` 存在组合流程，待本轮实跑 |
| Video/剪辑 | IMPLEMENTED_UNVERIFIED | VideoService、DirectorVideoService、StandaloneQuickEdit、ScriptEditingV3、Hybrid、IntelligentPlanning；Video worker 使用短事务 fence 完成 Asset+Render；FFmpeg 执行冻结 manifest |
| Media Intelligence | PARTIAL | `media-intelligence-service.ts` 持久 technical/shots/keyframes/ASR/vision/embedding；handler 丢弃 attemptId，迟到 stage/catch 可覆盖新结果；queued cancel 未传播至 run；search embedding 仍在 API 调用，后续评估 |
| Digital Human | IMPLEMENTED_UNVERIFIED | `packages/modules/digital-human`、独立 worker、avatar 页面和 provider ports；GPU/真实语音/付费模型本轮不调用 |
| Approval/Publisher | IMPLEMENTED_UNVERIFIED | 精确 revision Approval、Publisher snapshots、attempts、reconcile、disabled-by-default real adapters；Fake 验收可安全执行；禁止真实平台发布 |
| Review | IMPLEMENTED_UNVERIFIED | ReviewAnalyticsService、ReviewJobService、metric source、analysis reports、review 页面；Fake metrics 必须保持显式来源，待组合验收 |
| Runtime/Desktop | PARTIAL | RuntimeHost、ProcessManager、PostgresRuntimeManager、RuntimeClient、Electron shell 已集成；本轮 runtime unit 23/23 和 desktop unit 2/2；实际 UI/packaging/restart 尚待验收 |
| Web 可用性 | PARTIAL | project-nav 已有全模块入口；intelligence/page.tsx 的 runs 仅内存存储，刷新页面失去历史；fetch 异常可卡 busy，无持久任务恢复 UI |
| 安全与诊断 | PARTIAL | config fail-closed、structured logger 按键脱敏、fake controls 受 gate；shared serializeError 保留原始消息，JobRunner 持久化 error.message 可泄漏字符串凭证；进程 stdout 日志未经统一脱敏 |

## 改动前实际结果

| 命令 | 状态 |
| --- | --- |
| pinned pnpm install --frozen-lockfile | VERIFIED PASS，19 workspace projects，lockfile unchanged |
| format / lint / typecheck / build | VERIFIED PASS，409 文件 / 217 TS；不是完整静态依赖分析或 secret scanner |
| test:runtime（build 后） | VERIFIED PASS 23/23，真实 Windows 子进程树关闭；历史 Linux zombie 限制不能外推本机 |
| test:desktop | VERIFIED PASS 2/2，仅 manager unit，不等于 Electron 完整验收 |
| test:migrations（本轮隔离 cluster） | VERIFIED PASS 10/10；全链及 Desktop 历史兼容路径 |
| 首次组合 Job/analysis focused | FAIL：analysis closure 排序先执行，但未初始化 public schema；42P01。矩阵使用独立 schema，不能当 public 初始化。按既有 CI reset 脚本初始化本轮测试库后重跑，结果写入进度 |
| full test、Web build、browser、packaging、live GPU | 未执行于审计快照，不计 PASS |

## 按优先级开发与风险

P0：锁内 retry eligibility → queued cancellation 合同集成 → 分析 stage/result/文件隔离与 crash recovery → 安全错误/日志脱敏 → Windows Unicode 初始化 → 聚合验收门禁。P1：Asset cache 不可变 reuse → 分析历史/API/Web 恢复 → 完整三条业务链与现有模块回归。

无数据模型破坏、无第二套 Job 引擎、无 main 合并。claim/cancel 的 additive 修复可审查后复用远端已提交实现。分阶段 attempt-owner 分支存在显式 activation/drain gate；不盲目启用或将其迁移当成完整修复。预算策略变更、历史数据迁移、真实发布、付费/GPU验收单独记录，需要明确边界后推进。全部 DB reset/cleanup 仅允许本轮新建隔离实例；未提交素材和正常用户目录保持保护。
