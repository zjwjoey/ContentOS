# ContentOS Product V1 代码审查与规划完成度核查

> 修复进度：2026-08-31 已完成迁移 0016/0020、Benchmark/Review JSONB、页面参数、异步 Job 刷新、Planner 边界、审批目标解析及分析 Worker 事务范围修复；下列原始问题中已修复项保留作为审计证据，最终验收仍需重新执行完整浏览器流程及剩余业务项。

日期：2026-08-31（Asia/Shanghai）

## 结论

**NOT COMPLETE / ACCEPTANCE FAILED / NOT READY FOR MERGE**

当前分支没有按原始 Product V1 Closure 任务全部完成。实现了相当一部分 Contract、服务、页面和测试骨架，但存在阻断安装、页面访问和核心业务闭环的代码缺陷，且多项明确要求的产品能力尚未接通。此前 `PASS WITH EXTERNAL GATES` 的结论应撤回，不能继续作为合并或人工验收依据。

原任务允许留到外部验收的主要事项是真实 AI 凭证与效果、真实平台登录和不可逆发布、用户 UI 验收；不允许把 Fake E2E、数据库迁移、FFmpeg 基础渲染失败转为已完成。

## 审查范围与方法

- 分支：`feature/contentos-product-v1-closure`。
- 审查 HEAD：`2554dca713f9719f15fecbf343703cdee9823c7a`。
- 比较基线：`origin/main@9a6886e`，分支已有 14 个提交，92 个文件变更。
- 工作区：`E:/ContentOS/.worktrees/contentos-product-v1-closure`。
- 对照依据：原始 Product V1 Closure 附件、AGENTS.md、测试/验收治理规则、Product V1 Gap Audit、产品文档、实施报告和 `task_plan.md`。
- 检查 API → 服务 → Worker → 持久化以及 UI → API 的调用链；复用系统性排查方法区分环境、实现和测试缺陷。
- 运行回归、生产构建、只读查询、事务内临时表及内存测试替身。未修改业务数据、权限、应用代码，未执行真实平台操作，未提交或推送本报告。
- 浏览器检查使用现有生产构建，隔离代理仅返回一个占位项目和空列表，用于使项目布局允许子页面渲染；不是完整业务 E2E。

## 阻断和高风险发现

### R01 — P1：0020 migration 无法执行

位置：`migrations/0020_benchmark_library.sql:15`、`:37`、`:45`。

`benchmark_contents` 只有 `id` 主键，没有 `(id, project_id)` 唯一约束；后面两张表却以复合外键引用这两个字段。实际读取 0020 SQL，把新表限定为事务内临时表，并用临时项目/AI 表提供前置依赖后，PostgreSQL 返回：

```text
42830 没有唯一约束与关联表 "benchmark_contents" 给定的键值匹配
```

这说明即使补足数据库建 schema 权限，迁移仍会失败。API 与各 Worker 启动会运行迁移，因此影响整个新版本启动。需要补正确的复合唯一约束并验证 clean install、upgrade、down/up，而不是只修测试账号权限。

### R02 — P1：Benchmark / Review 页面客户端崩溃

位置：`apps/web/app/projects/[id]/benchmark/page.tsx:13`、`apps/web/app/projects/[id]/review/page.tsx:9`。

两个页面都把 `params` 声明成 Promise 并调用 `use(params)`，但当前 Next.js 14.2.21 路由传入的是普通参数对象。浏览器实际复现：

```text
Application error: a client-side exception has occurred
Minified React error #438; argument: [object Object]
```

两个页面均无法进入业务操作。HTTP 200 和 Web build 成功没有发现这个运行时错误。应与现有 Director/Assets 页一致使用当前框架的参数 Contract，再做实际浏览器回归。

### R03 — P1：JSONB 数组未正确序列化，账号和复盘报告无法可靠落库

位置：`packages/modules/benchmark/src/benchmark-service.ts:39`、`packages/modules/review/src/review-analytics-service.ts:106`。

Benchmark 的 `keywords`，Review 的 `highlights/risks/recommendations` 都直接以 JavaScript 数组交给 pg 参数，而列类型是 jsonb。pg 会按 PostgreSQL 数组编码，不会自动把顶层数组编码成 JSON 数组。

用同一测试数据库连接执行只读 `select $1::jsonb` 复现：非空标签数组、非空 insight 数组均返回 `22P02`；空数组会被解析成 JSON 对象 `{}`，也不是约定的 `[]`。结果是正常填写关键词的账号创建失败，AI Review 生成后报告保存失败。需要按 jsonb Contract 显式序列化，并以真实 pg 驱动验证读写类型。

### R04 — P1：Director 审批的 entity ID 和 revision ID 混用

位置：`apps/web/app/projects/[id]/director/page.tsx:99`；消费方 `apps/api/src/project-center.ts` 的 `currentDirectorTargets`。

`requestApproval` 把 Script/Storyboard revision ID 同时填入 `targetId` 和 `targetRevisionId`。Project Center 以 aggregate/entity ID + revision ID 匹配当前审批，因此审批页批准后，总控仍会认为当前版本缺少审批。

直接调用现有 `currentApprovalRecords`，输入 UI 生成的审批和正确 aggregate/revision 目标，返回 0 条当前审批。需要统一 UI/API/总控使用的实体、版本标识，并校验项目归属。

### R05 — P1：审批先提交，Director 后失败，留下互相矛盾的状态

位置：`apps/api/src/approval-routes.ts:67`。

代码先持久化 `APPROVED`，再调用 `acceptScript/approveStoryboard`。如果版本不属于该项目、已被替代或状态不允许，第二步失败后接口返回 409，但审批决定已永久保存为 APPROVED。再次批准又会因为“不再是 PENDING”失败。

内存依赖故障注入复现：`HTTP 409`，但审批状态已变成 `APPROVED`。这项复现验证调用顺序；持久化风险还由 ApprovalService 独立提交和 Director 独立事务的代码确认。需要在公开应用服务中建立一致的审批应用流程和失败恢复，不得跨模块私表补写。

### R06 — P1：Storyboard Planner 违反素材时长与总时长约束

位置：`packages/modules/video/src/planner.ts:115`、`:119`。

实际纯函数复现：

| 输入 | 当前结果 |
| --- | --- |
| 素材仅 1 秒，Scene 要求 3 秒 | 生成 durationMs=3000 的源 clip，超过素材边界 |
| targetDurationMs=1000，Scene 为 3 秒 | 仍生成 3000ms 时间线 |
| 一个素材、两个 Scene | 抛出 Adjacent duplicate clips are not allowed |

此外，没有关键词命中时只是标记 `fallback=true`，选择仍是按 ID 排序的候选；Scene 总时长不够时会把整条已匹配时间线替换为 Random 结果，但仍保留原 decisions。VideoService 只取 `.manifest`，丢弃 decisions，UI 因而没有计划要求的 Scene/关键词/score/匹配原因展示。

需要补足短素材、总时长、不可连续重复、单素材可行性和 fallback 语义；无法满足时在规划前给出清晰错误。决策解释必须与最终 Manifest 对应。

### R07 — P1：Benchmark Reference 只建立了关联，没有被 Director 使用

位置：`packages/modules/benchmark/src/benchmark-service.ts:56`、`:57`；`workers/director-worker/src/handler.ts:29`。

绑定动作只写 `benchmark_references`；引用读取返回原内容，Director 页面、生成服务和 Worker 没有消费 Benchmark 分析的调用。点击“作为 Director Reference”成功，后续脚本生成仍不包含这些学习结论。

原任务要求“对标分析用于 Director”，不是仅建立关联行。应通过公开读取 Contract 将所选分析的可借鉴结构和不可复制约束组成生成输入，并记录引用版本。当前 Benchmark E2E 只验证绑定提示，没有验证后续生成输入。

### R08 — P1：真实 AI 仅有 HTTP 接入，业务输入和结构化输出协议不足

位置：`workers/director-worker/src/handler.ts:29`、`:36`；`packages/modules/ai/src/prompt-registry.ts:17`、`:21`、`:25`、`:29`；`workers/review-worker/src/handler.ts:31`。

- Director 实际只传 topic/coreThesis，Brief 的受众、时长、语气、关键词、参考资料、禁止项等未进入生成 Prompt。
- Storyboard 未把选中的 Script Revision 文本传给模型，只在生成后把 scriptRevisionId 写回记录；修改脚本正文不会改变这份分镜生成输入。
- Prompt 没有声明各自必须返回的 JSON 字段结构，而 Worker 对 titleCandidates、coverText、scenes 等字段有严格验证。HTTP 层 JSON mode 只能约束 JSON 格式，不能补出业务 schema。
- Review 输入仅包含平台、时间和指标历史，缺 Project、Script、Storyboard、Render、Publisher 内容及 Benchmark；输出也只有 summary/highlights/risks/recommendations，没有完整覆盖要求的分析维度。

Fake 固定输出使目前的单测无法证明这些真实业务调用可用。无 API Key 不阻塞编写完整输入/输出协议和模拟 Provider 契约测试；本轮未调用真实 AI 服务。

### R09 — P1：新增 Worker 的结果写入不在 Job 完成事务内

位置：`workers/benchmark-worker/src/handler.ts:33`；`workers/review-worker/src/handler.ts:41`、`:54`；`packages/modules/job/src/job-service.ts:218`。

这些 Worker 虽调用 `succeedWithCurrentAttempt`，但回调忽略传入 scope，转而让 Benchmark/Review 服务使用各自 Pool 独立提交。业务报告可以已经写入，而 Job 成功更新或事务 commit 随后失败；重试可能再生成一条报告。连接池较小时也会在持有事务连接时等待另一个连接。

这是调用路径审查确认的事务范围缺口，尚未在真实 Job 集成环境做故障注入。应复用当前 attempt scope 的公开事务执行方式并补故障恢复/重投测试；“写在回调里”不等于“写在同一事务里”。

## 其余功能缺陷与可操作性问题

### R10 — P2：Benchmark 分析轮询和纯文案录入存在断点

位置：`apps/web/app/projects/[id]/benchmark/page.tsx:35`、`:39`；`apps/api/src/director-routes.ts:47`。

创建任务返回 `jobId`，GET Job 返回 `id`。轮询直接用后者替换本地对象，下一次请求将是 `/jobs/undefined`。即使第一轮已 SUCCEEDED，也没有刷新 analyses，因此最新分析不自动出现。

“链接可选”留空时，`...contentForm` 仍提交 `url:''`，后面的条件 spread 不会删除它，API 的 optional URL schema 因此拒绝纯文案录入。重复点击已绑定 Reference 也会因 `on conflict do nothing` 的 rowCount=0 被错误报告为内容不存在。

### R11 — P1：Review 没有任务完成反馈，也没有历史查看入口

位置：`apps/web/app/projects/[id]/review/page.tsx:20`、`:28`、`:37`。

采集指标只在 350ms 后刷新一次；AI Review 入队后不保存 Job ID、不轮询、不刷新结果，也不显示最终失败。页面只渲染 snapshots[0] 和 reports[0]，没有查看历史 Snapshot/Review 的列表或选择器。

即使先修页面崩溃和落库，这条 UI 流程仍不能满足原任务的“生成 → 查看结果 → 失败反馈 → 查看历史”。已有浏览器测试等待“最新复盘”，但页面没有实现对应的完成刷新。

### R12 — P2：Publisher preflight 是状态推断，不是凭据/Session 验证

位置：`apps/api/src/publisher-routes.ts:111`；`apps/web/app/projects/[id]/publisher/page.tsx`。

preflight 仅检查环境开关和数据库账号 status；开关开启就返回 Adapter READY，账号不是 REAUTH_REQUIRED 就认为 credentials 完整，甚至无账号时 `every()` 也为 true。没有凭据解析、会话校验、last check 或验证 Job。

现有真实 Adapter Worker 边界有保留，但本轮 UI 仍只提供创建 Fake 账号。真实 Account/Session 的安全配置和登录检测入口尚未完成；缺凭据与缺实现必须分开标注。校验的浏览器操作仍应交给 Worker，不能为修此问题在请求处理器直接运行浏览器。

### R13 — P2：Dashboard 的全局统计实际只计算最近 20 个项目

位置：`apps/api/src/dashboard-routes.ts:15`。

21 个活跃项目、唯一阻塞项目排第 21 的内存路由复现：total=21、active=20、blocked=0。页面“运营总览/实时汇总”未标明限制，会漏掉需要处理的旧项目。pendingActions 还把普通“进入 Director”导航建议计入待办。

需要明确全量统计与最近列表的不同口径，显示真实待审批、待发布、人工处理和失败任务，不能用任意截断样本作为总览。

### R14 — P1：验收报告、持久化规划与测试证据互相不一致

位置：`task_plan.md:333`、`:347`；`progress.md` 的 Product V1 section；`docs/superpowers/reports/CONTENTOS_PRODUCT_V1_IMPLEMENTATION_REPORT.md:47`、`:49`；`package.json`。

- 持久化计划 13 个 Phase 全部未勾选，状态仍是 baseline audit pending；progress 也停在 Phase 0。
- 实施报告却写 PASS WITH EXTERNAL GATES，并把数据库和浏览器未验收归入外部门，违反原任务的最终条件。
- 报告 Final SHA 为 de5b772，实际 HEAD 为 2554dca（后者是文档提交）；没有完整 commits 清单和逐 Gate 结果。
- 默认 test 脚本没有纳入新增 Review Analytics contract/service/API/worker 测试等；单独存在测试文件不意味着全量命令会运行它们。
- 浏览器 Scenario A 未包含要求的 Script 编辑、手动 MetricSnapshot 等全部步骤；B 停在绑定，未验证 Director 使用；D 缺完整 AI/Asset/Render/Review 失败交互；E 缺 Script/Storyboard/Review 历史查看。
- 普通用户验收文档没有具体启动方法和访问地址，还要求编辑 Scene JSON，无法作为完整的非开发者验收手册。

因此“代码已推送”只代表版本保存，不能作为“产品已完成”的依据。

## A–O 产品范围完成度

这里的“部分实现”表示有可追踪代码，不代表已经通过运行验收；不提供缺乏权重依据的完成百分比。

| 原范围 | 核查状态 | 已有能力 | 尚缺 / 不符合 |
| --- | --- | --- | --- |
| A Project Center | 部分实现 | 创建、搜索、状态、计划资料 API、阶段/Jobs、资料展示 | 编辑/归档只有 API 无 UI；缺创建时间、最新 Render/Review 完整摘要；审批识别错误 |
| B Content Plan | 部分实现 | 日期/账号/平台/状态筛选、计划列表 | 未展示独立 current stage/publish status；没有完整编辑交互验收 |
| C Director | 部分实现 | Brief 字段、AI Job、Script Body 编辑、Scene JSON 新版保存 | 缺 Title/Hook/CTA/封面等完整编辑、Scene 可视编辑、历史当前版本选择；输入未实际用于生成 |
| D Real AI | 部分实现 | env 配置、HTTP Provider、模型 Profile、AIRun | Prompt schema/业务上下文不足，四类操作未有业务级验收；AIRun latency 未形成有效证据 |
| E Benchmark | 阻断 | Contract、表/API/UI/Job/引用行 | migration、页面、JSONB、轮询阻断；没有 Director 消费；缺多选、账号 URL 和完整分析展示 |
| F Assets | 部分实现 | 多文件视频/音频上传、状态、预览、标签 API/类型标签筛选 | 素材名称搜索只有服务/API 没有 UI；category/notes 缺入口；图片需遵循现有 Contract 范围 |
| G Storyboard Planner | 有实现但不合格 | 标签评分、seed、Planner 选择器 | 素材/总时长越界，单素材失败，fallback 与 decisions 不一致，UI 无评分解释 |
| H Video 调整预览 | 主要复用既有能力 | 五类调整、Manifest 历史、Render 入口 | 本轮完整真实渲染回归未过；当前环境缺 libx264，不能声称已验收 |
| I Approval | 部分实现且有一致性缺陷 | 四类 target、批准/驳回/理由 | entity/revision 混用，跨步骤失败后留下已批准状态 |
| J Publisher UI | 部分实现 | Fake 请求/版本/Attempt/外部内容/状态 | 缺完整 hashtags/cover/schedule 编辑；账号认证/last check/人工处理入口不足 |
| K Real Publisher | 未完成安全产品入口 | 既有 Adapter 和默认关闭机制保留 | preflight 不执行验证；无真实账号/session 操作界面，不能仅以“缺账号”解释 |
| L Review | 部分实现且阻断 | 快照与报告持久化设计、手动 API、AI Job | 报告 JSONB 落库错误、上下文和分析维度不足、缺 reliability |
| M Review UI | 阻断 | 页面和手动快照表单 | 页面崩溃、无任务结果轮询、无历史选择、无完整失败反馈 |
| N Dashboard | 部分实现 | 创建项目、Quick Edit、项目列表/汇总 | 统计仅最近 20；缺待审批/待发布/人工处理/失败 Jobs/未来计划的可用列表 |
| O Settings | 部分实现 | 安全配置页、PostgreSQL select 1 | FFmpeg 仅 env 推断、Worker 固定 EXTERNAL、Storage 仅检查对象存在；不是实际 health |

## Phase 与规划核对

| Phase | 当前事实 |
| --- | --- |
| 0 Repository audit | Gap Audit 已存在，持久化计划未同步 |
| 1 Contracts/Data | 已新增，但 0020 不可执行 |
| 2 Benchmark | 不通过，存在多条阻断 |
| 3 Director / Real AI | 部分完成，审批与生成上下文未闭环 |
| 4 Asset tags | 部分完成，搜索和补充信息 UI 未齐 |
| 5 Storyboard Planner | 不通过，关键边界算法失败 |
| 6 Video UI closure | 复用基础能力，新增解释与完整验收不足 |
| 7 Publisher/config | 安全开关有，真正的配置/验证入口未完成 |
| 8 Review | 不通过，页面/持久化/异步反馈/历史均有缺口 |
| 9 Dashboard/Settings | 部分完成，统计和健康信息不完整 |
| 10 E2E | 场景覆盖不齐且完整 Fake 流程未通过 |
| 11 Polish/bug fixing | 尚未收口 |
| 12 Final gate | 未通过，不能关闭 V1 |

## 本轮验证证据

| 验证 | 结果 |
| --- | --- |
| `pnpm run format` | PASS，361 files |
| `pnpm run lint` | PASS，132 TypeScript files |
| `pnpm run typecheck` | PASS |
| `pnpm run build` | PASS |
| `pnpm --dir apps/web build` | PASS，但实际客户端仍有 R02 |
| `git diff --check` | PASS（新增报告前应用代码无改动） |
| unit/contract/静态 Web 回归组合 | 142 tests，139 PASS，3 FAIL，0 skipped |
| migration-matrix.test.ts（与 test:migrations 相同入口） | 7 tests，0 PASS，7 FAIL，42501 无 CREATE SCHEMA 权限 |
| 0020 实际 SQL，临时表隔离复现 | FAIL，42830 缺复合唯一约束 |
| JSONB 参数只读查询 | 非空数组 22P02；空数组存为对象 |
| Planner 边界复现 | 三种不符合结果，见 R06 |
| ProjectCenter/Approval/Dashboard 内存依赖复现 | 当前审批识别为 0；409 后已 APPROVED；21 项汇总只算 20 |
| 浏览器页面检查 | Benchmark/Review 均出现 React #438 和客户端异常页 |
| `pnpm run doctor` | FAIL，当前默认 FFmpeg 没有 libx264；其他 6 项通过 |
| 完整 `pnpm test` / `pnpm test:browser` | 本轮未重跑；已有确切数据库/迁移/页面阻断，不能计为 PASS |
| `pnpm install --frozen-lockfile` | 本轮未重装；前轮记录成功，本轮没有把它作为新证据 |
| 真实 AI / 真实平台发布 | 未运行，属于明确外部授权 Gate |

142 项测试执行命令：

```text
pnpm exec tsx --test --test-concurrency=1 tests/unit/*.test.ts tests/contract/*.test.ts tests/e2e/*-web.test.ts tests/e2e/operator-ui-v1-browser.test.ts
```

三项失败分类：

1. `project-navigation-web.test.ts` 仍禁止导航出现 Review，与本轮需求冲突，需要更新为明确区分 Approval 与发布后 Review 的正确契约。
2. `publisher-web.test.ts` 用关键词 credential 判断泄密，误报安全布尔字段 credentials；应验证响应中无凭据值，不得为过测删掉安全校验。
3. `video-renderer.test.ts` 真正调用的 FFmpeg 缺 libx264，返回 Unknown encoder；属于本地运行环境不满足要求。

注意：应使用 `pnpm run doctor` 调用仓库脚本。此前无输出的 `pnpm doctor` 退出 0 不能证明 `scripts/doctor.ts` 检查通过。

## 建议修复和重新验收顺序

1. **解除启动和页面阻断**：0020 migration、JSONB 序列化、两个页面参数；建立可隔离的测试库和正确 FFmpeg 配置。
2. **修业务不变量**：Approval entity/revision 与失败一致性、Worker 事务 scope、Planner 素材/总时长/fallback。
3. **接通真实输入链路**：Benchmark 分析 → Director；具体 Script Revision → Storyboard；完整上下文 → Review；版本化结构化 Prompt。
4. **补普通用户操作**：项目编辑归档、完整 Script/Scene 编辑、素材搜索、Publisher 安全预检与账号入口、Review 历史和任务反馈、真实 Dashboard/Settings 状态。
5. **执行 A–E 验收**：完整 Fake 流程必须覆盖手工修订、手动指标、调整、历史和所有失败态；新增 Review 测试纳入默认回归；不得跳过或删除测试来通过。
6. **重新收口报告**：逐 Gate 写真实结果并同步 Phase/HEAD。只有内部功能与测试全部通过，才允许标记 PASS WITH EXTERNAL GATES 并进入人工验收/合并决策。

以上仍是 V1 原范围的修复与补齐，不是 V2，也不需要重做已冻结架构。
