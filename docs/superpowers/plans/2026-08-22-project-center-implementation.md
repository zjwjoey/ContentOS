# ContentOS Project Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在 Slice ② 基础上交付只读的 Project Center V0，让运营人员从项目列表进入桌面横屏总控页，查看四阶段状态、健康度、待处理事项和安全的最近 Job 摘要。

**Architecture:** Project Center 由 API 组合层提供读取快照，不新增业务事实表，不直接查询其他模块私有表。组合层通过 Project、Director、AssetCatalog、Job、Approval、Publisher 的公开服务取得数据，将确定性的健康度和阶段规则映射为公开 Contract；Web 只负责展示和导航，快捷动作不执行副作用操作。

**Tech Stack:** Node.js 22、TypeScript、Fastify、Zod、PostgreSQL、现有模块服务、Next.js 14、React 18、Node test runner。

---

## 文件边界

- Create: packages/contracts/src/project-center.ts — Project Center 对外 Contract。
- Modify: packages/contracts/src/index.ts — 导出 Project Center Contract。
- Modify: packages/modules/job/src/job-service.ts — 增加项目范围安全 Job 摘要查询。
- Modify: packages/modules/job/src/index.ts — 导出新增 Job 摘要类型。
- Create: apps/api/src/project-center.ts — 组合读取服务、健康度/阶段规则和安全错误降级。
- Create: apps/api/src/project-center-routes.ts — 注册 GET /api/v1/projects/:projectId/center。
- Modify: apps/api/src/app.ts — 组装依赖并注册路由。
- Create: tests/unit/project-center.test.ts — 纯规则测试。
- Create: tests/integration/project-center-api.test.ts — PostgreSQL + Fastify API 场景测试。
- Modify: package.json — 将 Project Center 测试加入默认测试命令。
- Modify: apps/web/app/page.tsx — 项目入口改为 Project Center。
- Create: apps/web/app/projects/[id]/page.tsx — A3+B2+C1 总控页。
- Modify: apps/web/app/globals.css — 横屏布局和窄屏收窄样式。
- Create: tests/e2e/project-center-web.test.ts — Web 静态回归。
- Modify: task_plan.md, findings.md, progress.md — 追加完成记录，不覆盖历史。
- Create: docs/superpowers/reports/2026-08-22-project-center-verification.md — 最终验收报告。

## Task 1: 定义公开 Contract

**Files:** Create packages/contracts/src/project-center.ts; modify packages/contracts/src/index.ts; test tests/unit/project-center.test.ts.

- [ ] Step 1: 先写失败测试，导入将要实现的 deriveHealth 和 deriveStages，覆盖空项目、FAILED Job、PENDING Approval、Publisher 人工动作和 PUBLISHED 项目。
- [ ] Step 2: 运行 pnpm exec tsx --test tests/unit/project-center.test.ts，预期因文件不存在而失败。
- [ ] Step 3: 定义以下类型并从 contracts index 导出：

~~~ts
export type ProjectCenterHealthLevel = 'HEALTHY' | 'ATTENTION' | 'BLOCKED' | 'COMPLETE';
export type ProjectCenterStageKey = 'DIRECTOR' | 'VIDEO' | 'APPROVAL' | 'PUBLISHER';
export type ProjectCenterStageStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ACTION_REQUIRED' | 'READY' | 'COMPLETE' | 'BLOCKED';
export type ProjectCenterActionKind = 'APPROVAL' | 'JOB_FAILURE' | 'HUMAN_ACTION' | 'PUBLISH_RETRY' | 'NAVIGATION';
export type ProjectCenterSeverity = 'INFO' | 'WARNING' | 'BLOCKED';

export interface ProjectCenterSnapshot {
  project: { id: string; name: string; status: string; updatedAt: string };
  health: { level: ProjectCenterHealthLevel; reasons: string[] };
  stages: Array<{
    key: ProjectCenterStageKey;
    status: ProjectCenterStageStatus;
    label: string;
    href: string | null;
    summary: string;
  }>;
  currentStage: ProjectCenterStageKey | null;
  actions: Array<{
    id: string;
    kind: ProjectCenterActionKind;
    title: string;
    detail: string;
    severity: ProjectCenterSeverity;
    href: string | null;
  }>;
  recentJobs: Array<{
    id: string;
    type: string;
    state: string;
    attemptCount: number;
    maxAttempts: number;
    createdAt: string;
  }>;
}
~~~

- [ ] Step 4: 运行 pnpm typecheck，预期通过。
- [ ] Step 5: 提交 git commit -m "feat: define project center contract"。

## Task 2: 增加安全的项目 Job 摘要查询

**Files:** Modify packages/modules/job/src/job-service.ts and packages/modules/job/src/index.ts; test tests/unit/project-center.test.ts.

- [ ] Step 1: 写测试，确认快照可见 Job 只有 id、projectId、type、state、attemptCount、maxAttempts、createdAt，JSON 不包含 payload、result、error、leaseOwner、progress。
- [ ] Step 2: 运行单元测试，预期安全摘要方法尚未实现而失败。
- [ ] Step 3: 在 JobService 增加 JobSummary 和 listProjectSummaries(projectId, limit = 8)。SQL 只能选择 id、project_id、type、state、attempt_count、max_attempts、created_at，按 created_at desc、id desc 排序，limit 限制为 20 以内；不要复用 get 后再剥离字段。
- [ ] Step 4: 运行 pnpm exec tsx --test tests/unit/project-center.test.ts 和 pnpm typecheck，预期通过。
- [ ] Step 5: 提交 git commit -m "feat: expose safe project job summaries"。

## Task 3: 实现健康度和阶段推导

**Files:** Create apps/api/src/project-center.ts; modify tests/unit/project-center.test.ts.

- [ ] Step 1: 写规则测试，固定以下优先级和场景：
  - BLOCKED：Job 为 FAILED 或 BLOCKED、Publisher needsHumanActionCount 大于 0、或 Approval 为 REJECTED。
  - COMPLETE：项目为 PUBLISHED 且无阻塞、无人工作项。
  - ATTENTION：Approval 为 PENDING、Job 为 QUEUED/RUNNING/RETRY_WAIT，或 Publisher 有 DRAFT/SCHEDULED/FAILED 请求且没有 BLOCKED。
  - 其余为 HEALTHY。
- [ ] Step 2: 运行单元测试，预期 deriveHealth 和 deriveStages 尚未实现而失败。
- [ ] Step 3: 导出纯规则输入：

~~~ts
export interface ProjectCenterRuleInput {
  projectStatus: string;
  hasDirectorRevision: boolean;
  hasApprovedDirector: boolean;
  hasReadyVideo: boolean;
  videoJobStates: string[];
  approvalStatus: string | null;
  publisherStatusCounts: Record<string, number>;
  needsHumanActionCount: number;
  hasExternalPost: boolean;
  jobs: Array<{ state: string; type: string }>;
}
~~~

- [ ] Step 4: deriveStages 固定 Director、Video、Approval、Publisher 顺序；Director 无版本为 NOT_STARTED、存在版本为 IN_PROGRESS、存在批准版本为 COMPLETE；Video 无 Job/READY Asset 为 NOT_STARTED，Job 运行中为 IN_PROGRESS，失败为 BLOCKED，READY Asset 为 READY；Approval 无决策为 NOT_STARTED、PENDING 为 ACTION_REQUIRED、APPROVED 为 COMPLETE、REJECTED 为 BLOCKED；Publisher 无请求为 NOT_STARTED、人工动作为 ACTION_REQUIRED、队列/发布/重对账为 IN_PROGRESS、已确认外部内容为 COMPLETE。currentStage 取第一个未完成阶段，全部完成时为 PUBLISHER，空项目为 DIRECTOR。
- [ ] Step 5: 运行 pnpm exec tsx --test tests/unit/project-center.test.ts，预期六类规则全部通过。
- [ ] Step 6: 提交 git commit -m "feat: derive project center health and stages"。

## Task 4: 实现聚合读取服务和 API

**Files:** Modify apps/api/src/project-center.ts; create apps/api/src/project-center-routes.ts; modify apps/api/src/app.ts; test tests/integration/project-center-api.test.ts.

- [ ] Step 1: 写集成测试，使用现有 createDatabase、migrateUp、buildApi 和公开服务建立项目 fixture；覆盖空项目、Director 已批准、Render Job FAILED、Approval PENDING、Publisher 人工处理、Publisher PUBLISHED。
- [ ] Step 2: 先运行 pnpm exec tsx --test tests/integration/project-center-api.test.ts，预期路由未注册而失败。
- [ ] Step 3: ProjectCenterService.get(projectId) 先调用 ProjectService.get；不存在返回 null。随后只调用公开方法 DirectorService.list/getCurrent、AssetCatalogService.listPublishable、JobService.listProjectSummaries、ApprovalService.list、PublisherService.getProjectSummary。聚合层只投影 Contract 字段，不返回私有行。
- [ ] Step 4: 对单个公开查询失败，保留项目基础信息，将对应阶段标记为 BLOCKED、摘要设为暂时不可用并生成安全 NAVIGATION 动作；不返回 SQL、堆栈、凭据或内部诊断。Project Center 不新增数据库表。
- [ ] Step 5: 注册路由：

~~~ts
export interface ProjectCenterRouteDependencies {
  center: ProjectCenterService;
}

export function registerProjectCenterRoutes(app: FastifyInstance, deps: ProjectCenterRouteDependencies): void {
  app.get('/api/v1/projects/:projectId/center', async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const snapshot = await deps.center.get(projectId);
    if (!snapshot) {
      return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', details: [] } });
    }
    return snapshot;
  });
}
~~~

- [ ] Step 6: 在 app.ts 复用已经创建的服务实例，初始化 ProjectCenterService 并调用 registerProjectCenterRoutes。
- [ ] Step 7: 测试断言 200/404、六类规则、字段白名单，确认响应不含 payload、credentialRef、profileKey、diagnostics、leaseOwner。
- [ ] Step 8: 运行 pnpm exec tsx --test tests/integration/project-center-api.test.ts 和 pnpm typecheck，预期通过。
- [ ] Step 9: 提交 git commit -m "feat: add project center snapshot api"。

## Task 5: 实现项目入口和横屏总控页面

**Files:** Modify apps/web/app/page.tsx; create apps/web/app/projects/[id]/page.tsx; modify apps/web/app/globals.css; test tests/e2e/project-center-web.test.ts.

- [ ] Step 1: 先写静态回归测试，读取两个页面源文件，断言 Project Center 调用 GET /api/v1/projects/:id/center、包含 Director/Video/Approval/Publisher、health/actions/recentJobs 和 data-testid，同时断言没有 credentialRef、profileKey、accessToken、refreshToken、authorization、diagnostics。
- [ ] Step 2: 运行 pnpm exec tsx --test tests/e2e/project-center-web.test.ts，预期页面不存在且旧入口仍直达 Director，因此失败。
- [ ] Step 3: page.tsx 将创建成功后的 router.push 和项目列表 Link 改为 /projects/:id，按钮文字改为创建并进入项目总控。
- [ ] Step 4: 新页面使用现有 Client Component 模式和 useParams：首次加载显示正在读取项目；PROJECT_NOT_FOUND 显示明确错误；其他错误保留框架并提供刷新。顶部显示名称、状态、更新时间、刷新；左侧阶段栏显示总览、Director、Video、Approval、Publisher；右侧显示健康度、四阶段卡、当前阶段摘要、待处理项、最近 Job。快捷动作只能使用 href 导航，不发 POST/PUT/DELETE。
- [ ] Step 5: 页面只渲染 ProjectCenterSnapshot 白名单字段，并使用 data-testid：project-center、health-level、stage-card-DIRECTOR、stage-card-VIDEO、stage-card-APPROVAL、stage-card-PUBLISHER、project-actions、recent-jobs。
- [ ] Step 6: globals.css 增加 project-center 的桌面网格，左侧约 240px、右侧内容区和四卡片网格；900px 以下左栏改横向阶段选择器，640px 以下卡片改单列；保持深色主题，不使用固定竖屏比例。
- [ ] Step 7: 运行 pnpm exec tsx --test tests/e2e/project-center-web.test.ts 和 pnpm --dir apps/web build，预期通过。
- [ ] Step 8: 提交 git commit -m "feat: add project center operator page"。

## Task 6: 完整 Gate 和文档

**Files:** Modify package.json, task_plan.md, findings.md, progress.md; create docs/superpowers/reports/2026-08-22-project-center-verification.md.

- [ ] Step 1: 将三个 Project Center 测试加入 package.json 的 test 脚本，保持串行执行。
- [ ] Step 2: 运行完整验证：

~~~bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format
pnpm --dir apps/web build
git diff --check
~~~

预期全部退出码为 0，原有 Slice ② 测试和六类 Project Center 场景均通过。
- [ ] Step 3: 做边界审计：确认 Project Center 文件没有 publisher_*、director_plan_revisions、approval_decisions、select * from jobs 等私表读取；JobService 查询只使用白名单列；Web 没有凭据、Token 或诊断字段。
- [ ] Step 4: 在三个历史规划文件中追加完成记录，并在验收报告中记录基线、变更文件、测试命令、结果、未启动 Slice ④/⑤/⑥ 和后续限制。
- [ ] Step 5: 提交 git commit -m "docs: verify project center slice"。
- [ ] Step 6: 最终运行 git status --short 和 git log --oneline -8，预期工作树干净且仍位于 codex/project-center，不合并 main，不启动下一 Slice。

