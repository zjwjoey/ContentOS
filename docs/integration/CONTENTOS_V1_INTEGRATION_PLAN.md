# ContentOS V1 Integration Plan

状态：`INTEGRATION IN PROGRESS`

本文件是 Desktop V1 与 Intelligent Editing V1.5 的 Integration Preflight Audit 结果。
本阶段只建立审计基线、冲突矩阵和执行计划；尚未合并任何 feature branch，也不会自动合并 `main`。

## 1. 审计范围与远端状态

仓库：`zjwjoey/ContentOS`

目标集成分支：`integration/contentos-v1-desktop-intelligence`

本地工作区：`F:\ai剪辑\.worktrees\contentos-v1-integration`

已执行 `git fetch origin`，但当前环境通过配置代理连接 GitHub 失败：

```text
fatal: unable to access 'https://github.com/zjwjoey/ContentOS.git/':
Failed to connect to github.com port 443 via 127.0.0.1
```

因此以下 SHA 是本地现有 `origin/*` 追踪引用的审计基线，不能表述为本次 fetch 后重新确认的远端状态。真正开始集成前必须在网络恢复后再次执行 `git fetch origin` 并重新核对三条引用。

| 标识 | 当前本地追踪引用 | SHA | 备注 |
| --- | --- | --- | --- |
| `INTEGRATION_MAIN_BASE_SHA` | `origin/main` | `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` | 集成工作区起点 |
| `DESKTOP_SOURCE_SHA` | `origin/feature/contentos-desktop-v1` | `b2ac7fcf72b2398408dffce801ae66d6d42cdb1a` | Desktop V1 验收头 |
| `INTELLIGENCE_SOURCE_SHA` | `origin/feature/contentos-intelligent-editing-v15` | `c20e6fca69c5ba74f4859b8e0ae13aee8c8b40ff` | Intelligence V1.5 验收头 |
| Desktop merge-base | `origin/main` | `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` | 无额外 main merge |
| Intelligence merge-base | `origin/main` | `c8d0dd4725fac12feb5d9f0b5d9a04ac337fc0b6` | 无额外 main merge |

## 2. Changed-file 审计

命令：

```text
git diff --stat origin/main...origin/feature/contentos-desktop-v1
git diff --stat origin/main...origin/feature/contentos-intelligent-editing-v15
```

结果：

| 分支 | 文件数 | 插入 | 删除 |
| --- | ---: | ---: | ---: |
| Desktop V1 | 120 | 6,582 | 237 |
| Intelligent Editing V1.5 | 64 | 2,984 | 31 |
| 直接重叠文件 | 10 | — | — |

直接重叠文件：

```text
.env.example
.gitignore
apps/api/src/app.ts
apps/api/src/main.ts
apps/web/app/projects/[id]/product-model.ts
apps/web/app/projects/[id]/project-nav.tsx
package.json
packages/config/src/config.ts
scripts/dev-operator.ts
scripts/test-operator-browser.ts
```

## 3. Commit ancestry matrix

| 类别 | Desktop ancestry | 集成预案 | 当前决定 |
| --- | --- | --- | --- |
| Runtime Startup | `0d8fac8`, `648a31b`, `fc396a0`, `48e920d`, `18e41fe`, `f8a2d23`, `430652f`, `697d154`, `7595f80`, `3c5bed6`, `be75327`, `aea974c` | 纳入 runtime-core、runtime-client、runtime-host、生命周期、状态、进程清理 | 必须保留 |
| Desktop shell / distribution | `a46ac6d`, `14f7d94` 及后续 Desktop packaging、doctor、portable/installer、clean acceptance 修复 | 作为 Desktop V1 分发基础纳入 | 必须保留 |
| Desktop CI / tests | `b92c54e`, `566ae22`, `4b89448`, `47d5337`, `038c7c5` 等 | 合并到 integration CI，并扩展 Intelligence gate | 必须保留并改造 |
| Digital Human business | `6f051e6`, `d261143`, `edf81d2`, `96c5c67`, `a0de147`, `b1e308a`, `034172b` | 不因 ancestry 自动纳入；逐项确认是否是本轮目标 | 暂不纳入 Desktop integration |
| Shared UI localization | `25f893e` | 与 Intelligence navigation 手工合并，不把 localization 当作 Desktop runtime 依赖 | 单独审查 |

Intelligence branch 的 V1.5 实现、transactional closure、worker、contracts、API routes、Web page、migrations 和测试均属于本轮候选输入。其 Desktop independence 证据显示该分支没有修改 `apps/desktop`。

拟采用 `mixed` 策略：先以 review 后的 Desktop Runtime/Distribution 变更为基础，逐项纳入 Intelligence；共享文件手工三方解决；Digital Human 业务 commit 不凭 ancestry 自动带入；lockfile 由最终 `package.json` 重新生成。不会对整仓库使用 `ours`/`theirs`。

## 4. Shared File Conflict Matrix

| 文件/范围 | Desktop changed | Intelligence changed | 冲突类型 | Resolution strategy | 风险 | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `package.json` | Yes | Yes | scripts、Electron/embedded PostgreSQL/FFmpeg 依赖与 Intelligence test script 合并 | 人工合并完整 scripts/dependencies；不手工拼 lockfile | High | frozen install、quality、full regression、desktop package |
| `pnpm-lock.yaml` | Yes | No direct change | Desktop lockfile 不能覆盖新增 Intelligence workspace dependency graph | 根据最终 package/workspace 删除并用仓库规范重新生成 | High | `pnpm install --frozen-lockfile` |
| `.env.example` | Yes | Yes | Desktop runtime、Digital Human、Intelligence roots/providers 默认值 | 保留统一 `DATABASE_URL`、FFmpeg paths；增加 Intelligence 配置；不写 secret | Medium | config/unit、runtime、packaged diagnostics |
| `apps/api/src/app.ts` | Yes | Yes | Desktop readiness/runtime compatibility 与 Intelligence service/routes 注册 | 逐段人工合并；保留既有 routes、Intelligence routes、Digital Human route（是否纳入业务另行决定） | High | typecheck、API integration、Intelligence tests、browser |
| `apps/api/src/main.ts` | Yes | Yes | migration skip/embedded startup 与 Intelligence provider construction | 统一 config/storage/db wiring；同一 `DATABASE_URL`；禁止第二 DB | High | migrations、runtime integration、vertical slice |
| `apps/web/**` | Yes | Yes | localization/desktop shell 与 Intelligence navigation/page | 保留 `/intelligence` 入口、现有 Video/Projects/Digital Human 页面；手工解决 product model/nav | Medium | Web build、browser E2E |
| `packages/config/src/config.ts` | Yes | Yes | runtime paths/ports/FFmpeg 与 Intelligence roots/providers/concurrency | 扩展同一 config contract；路径落到 packaged userData；默认 provider not configured/显式 fake test mode | High | config tests、runtime、clean Windows |
| `packages/contracts/**` | Digital Human contracts | edit manifest/Intelligence contracts | 共享导出边界，不是同一文件直接冲突 | 保留 `EDIT_MANIFEST_V0` 单一 render boundary；审计 exported types | Medium | contract/typecheck、render tests |
| `packages/database/**` | No direct feature diff | No direct feature diff | loader 是共同基础；编号重排影响 history/down | 集成 migration inventory 只保留一套 loader；补 migration matrix | High | fresh/upgrade/down-up |
| `packages/modules/**` | Digital Human | intelligence、job、video transaction-aware | 跨模块数据库/contract 兼容；不能用旧 Video/Job 覆盖 transactional closure | 优先保留 Intelligence 最新 transaction-aware VideoService/JobService；Desktop runtime 不进入 modules | High | transactional replacement、full tests |
| `packages/runtime-core/**` / `runtime-client/**` | Yes | No | Desktop required runtime foundation | 纳入并扩展 `RuntimePaths`/registry；不让 Intelligence fork runtime | High | runtime unit/integration、Windows |
| `workers/**` | existing workers/bootstrap | `media-intelligence-worker` | 新 worker 未进入 Desktop registry/packaged dist | 注册为 optional/on-demand；确认 built `dist/workers/...js` entry | High | worker test、packaged vertical slice、orphan check |
| `scripts/**` | Desktop packaging/acceptance | Intelligence browser/test wiring | operator/test runner 需要同时启动/覆盖 worker | 合并脚本并显式区分 test fake provider 与 production | Medium | browser、clean acceptance |
| `.github/workflows/ci.yml` | Desktop Windows jobs/triggers | no direct workflow diff | integration branch 不在 Desktop push trigger；缺 Intelligence job | 增加 `integration/**` trigger，保留 Windows jobs，加入 Intelligence/migration/vertical-slice gates | High | GitHub Actions on integration SHA |
| `migrations/**` | `0047_digital_human_duration` | `0047`–`0052` Intelligence | numeric prefix collision、down 顺序和 schema history | integration-only rename；不改 SQL semantics；保留 up/down pair | Critical | three-route migration matrix、down/reapply |

## 5. Migration Integration Matrix

### 当前 inventory

```text
main:       0001–0046
Desktop:    0001–0046 + 0047_digital_human_duration
Intelligence: 0001–0046 + 0047_intelligent_editing_v15 ... 0052_intelligent_editing_final_closure
```

已确认 Desktop `0047_digital_human_duration.sql` 修改 `avatar_generations`；Intelligence `0047`–`0052` 创建和扩展 `media_analysis_*`、`intelligent_edit_*` 表。当前 loader：

```text
readdir → numeric filename string sort → apply up SQL → schema_migrations 写入完整 filename
migrateDown → schema_migrations.name 倒序 → 对应 .down.sql
```

因此即使完整文件名不同，重复 `0047` 也会造成不明确的业务顺序、测试编号假设和 future upgrade 风险。本 integration branch 暂定保留 Intelligence `0047`–`0052`，把 Desktop duration migration 成对重命名为 `0053_digital_human_duration.sql` / `.down.sql`，但只有在确认 Digital Human duration business scope 纳入后才执行该重编号。若 Digital Human duration 不纳入，则不复制该 migration。

### 必须覆盖的 matrix

| Scenario | 起点 | 目标 | Gate |
| --- | --- | --- | --- |
| A | empty DB | main 0046 + integrated migrations | 全量 up、schema history 唯一、latest schema |
| B | main baseline DB | Intelligence migrations + Desktop migration（若纳入） | upgrade 不丢 main 数据 |
| C | main baseline DB | Desktop migration + Intelligence migrations（仅用于顺序兼容审计） | 与最终固定顺序的差异记录 |
| D | latest integrated DB | latest down 至 integration boundary，再 up | down pair、排序、可重放 |
| E | Desktop V1 schema | integration inventory | Project/Asset/Digital Human 字段（若纳入）保留 |
| F | Intelligence V1.5 schema | integration inventory | analysis/shots/plans/candidates/decision events 保留 |

需要新增或扩展 `tests/integration/integration-migration-matrix`，不能只依赖当前 `migration-matrix.test.ts` 的单分支 inventory。

## 6. Runtime integration requirements

当前 Desktop registry 有：

```text
database, migration, api, asset-worker, director-worker, video-worker,
review-worker, benchmark-worker, digital-human-worker, publisher-worker, web
```

Intelligence 新增：

```text
media-intelligence-worker
```

集成要求：

1. 将 `media-intelligence-worker` 注册为 `required: false`、`dependsOn: [database, migration]`，默认 `OPTIONAL` 或 `ON_DEMAND`。
2. 没有真实 AI provider 时 Desktop 仍启动；正常模式显示 `READY_WITH_WARNINGS` / `NOT_CONFIGURED`，不静默使用 Fake 结果。
3. 测试模式使用显式 deterministic fake provider，不能成为 production default。
4. `CONTENTOS_INTELLIGENCE_WORKER_CONCURRENCY` 默认 `1`，由统一 config 读取。
5. packaged mode 必须运行编译后的 `dist/workers/media-intelligence-worker/src/main.js`（或最终确认的 built path），不能依赖 `tsx`、`pnpm` 或 system Node。
6. 使用 Desktop Embedded PostgreSQL 的同一个 `DATABASE_URL` 和同一 cluster；不得创建第二个 Intelligence DB。
7. 使用 Desktop bundle 的 `FFMPEG_PATH` / `FFPROBE_PATH`；keyframes/cache/temp/embeddings 写到 userData，不写安装目录。
8. `safeMode` 只启动最小 core，不强制拉起 Intelligence worker。
9. worker 崩溃只能隔离 Intelligence；Project/Assets/Video Render core 继续工作；退出时加入 orphan PID 检查。

## 7. API / Web / contract resolution

API 必须同时保留：

```text
existing ContentOS routes
Desktop runtime readiness/compatibility
Intelligent Editing analysis/planning/decision routes
Video / Assets / Review / Publisher / Production Run
```

`apps/api` 不得导入 Electron/BrowserWindow/IPC；API、worker、modules 继续保持 Electron 无关。`main.ts` 统一数据库、storage、FFmpeg、provider registry，且只保留一个数据库 URL。

Web 必须保留 `/projects/[id]/intelligence` 入口，同时保留既有项目、视频、审批、生产和数字人页面。`EDIT_MANIFEST_V0` 继续是唯一 render boundary，不新增 `DESKTOP_MANIFEST` 或 `AI_RENDER_SCHEMA`。

Intelligence 的 `VideoService` / `JobService` transaction-aware implementation 属于高优先级输入，不能被 Desktop 旧版本覆盖。

## 8. Package / lockfile plan

1. 人工合并 `package.json`：Desktop 的 Electron、embedded PostgreSQL、FFmpeg、Next/React、desktop scripts 与 Intelligence 的 `test:intelligent-editing-v15`、worker/package 脚本全部保留。
2. 检查 `pnpm-workspace.yaml` 的 allowBuilds/minimumReleaseAgeExclude；确认新 worker 被 workspace 收录。
3. 删除 integration 工作区的旧 lockfile 后，按仓库规范用 `pnpm install` 重新生成，禁止手工拼接 `pnpm-lock.yaml`。
4. 执行 `pnpm install --frozen-lockfile`，并把最终 lockfile 作为单独 review 变化。

## 9. CI / test plan

CI workflow 必须：

- push trigger 包含 `integration/**` 或精确 integration branch；
- 保留 `Desktop Windows package and smoke`，包括 installer/portable/clean Windows/artifact upload；
- 新增 `pnpm test:intelligent-editing-v15` 与 replacement transaction tests；
- migration gate 先于完整回归；
- final artifact 名称使用 integration SHA，而不是旧 Desktop SHA。

最终 gate 顺序：

```text
Quality
→ Database + migration matrix
→ Runtime unit/integration
→ Intelligent Editing V1.5 + transactional replacement
→ full regression
→ Web/browser/render
→ Windows runtime
→ Desktop package/smoke
→ Desktop + Intelligence packaged vertical slice
→ clean Windows acceptance
```

Integration vertical slice：

```text
install → start → embedded PostgreSQL → migrate → project → import real video
→ analysis → shots → keyframes → deterministic test search → intelligent plan
→ EDIT_MANIFEST_V0 → real render → candidate replacement → new manifest → second render
→ restart/crash recovery → persistence → no orphan processes
```

Acceptance 文档必须区分：

```text
FAKE PROVIDER WORKFLOW VERIFIED
REAL AI PROVIDER VERIFIED
```

并重新验证中文路径下的 PostgreSQL data root；若失败，保留 short-path/ASCII-safe fallback 并记录为 limitation 或 gate。

## 10. 风险与阻塞

| 风险 | 严重度 | 当前证据 | 处理 |
| --- | --- | --- | --- |
| fetch 无法刷新远端引用 | High | 本次 fetch 通过代理失败 | 网络恢复后重新 fetch；在此之前不声称远端已同步 |
| migration 0047 collision | Critical | Desktop 与 Intelligence 同号 | integration-only 成对重编号或明确排除 Digital Human duration |
| Desktop ancestry 混入 Digital Human business | High | scope audit 与 commit stats 已确认 | 不按 ancestry 自动纳入；逐 commit 选择 |
| `media-intelligence-worker` 不在 Desktop registry/package manifest | Critical | Desktop service definitions 无该服务；worker 只存在 Intelligence branch | registry、build、manifest、smoke、orphan gate |
| shared API/config/package/Web overlap | High | 10 个直接重叠文件 | 逐文件人工合并、双线测试 |
| packaged worker 仍依赖 tsx | High | Intelligence worker package 当前 `dev/start` 使用 tsx | build entry 与 packaged launch path 必须重写/验证 |
| Fake provider 被误当生产能力 | High | Intelligence 默认 fake；Desktop 需 optional | production `NOT_CONFIGURED`，fake 仅显式 test mode |
| 中文路径 PostgreSQL | Medium | Desktop 历史限制记录 | integration clean acceptance 重测并保留 fallback |
| installer 体积 | Low | Desktop 约 756 MB | 记录，不作为本轮 blocker |
| `asar: false` | Low | Desktop 现状 | 保持现状，列为 V1.1 optimization |

## 11. 执行顺序与停止点

当前停止点是 Preflight Audit。下一步必须先确认 refreshed refs 和本计划，再按以下顺序实施：

1. 重新 fetch 并更新 SHA 记录；
2. 根据 commit matrix 选择 Runtime/Distribution 输入，明确 Digital Human 是否纳入；
3. 在本 integration branch 进行 migration reconciliation；
4. 接入 media-intelligence-worker registry、paths、packaged build；
5. 手工解决 API/config/Web/package/lockfile；
6. 加 integration migration matrix、upgrade tests、packaged vertical slice；
7. 跑局部 gates，再跑 full regression；
8. 生成 scope、migration reconciliation、acceptance 三份文档；
9. 只有 Integration Final SHA 的 CI、Windows artifact 和 clean acceptance 全部通过后，才可 push integration branch。

禁止：

```text
git checkout main
git merge ...
git push origin main
```

## 12. Preflight verdict

```text
PRE-FLIGHT AUDITED
INTEGRATION BRANCH CREATED
NOT YET INTEGRATED
NOT READY FOR MAIN MERGE REVIEW
```

本阶段没有修改 `main`、`feature/contentos-desktop-v1` 或 `feature/contentos-intelligent-editing-v15`。
