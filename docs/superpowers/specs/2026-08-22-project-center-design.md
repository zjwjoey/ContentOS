# ContentOS Project Center V0 Design

日期：2026-08-22
状态：待用户审阅
基线：Slice ② `Publisher → Content Project` 已通过正式验收

## 1. 目标

为每个 Content Project 提供一个桌面横屏的总控入口，帮助运营人员在一个页面内回答三件事：

1. 项目目前是否顺利推进；
2. Director、Video、Approval、Publisher 各阶段处于什么状态；
3. 当前最应该处理的事项是什么。

Project Center 只负责总览、导航和安全摘要，不复制 Director、Video 或 Publisher 的编辑/执行工作台。

## 2. 已冻结的视觉决策

本次设计确认的组合为：

- A3：健康度 + 待处理事项混合首屏；
- B2：左侧固定阶段栏；
- C1：右侧状态摘要 + 快捷动作；
- 桌面横屏为主布局，目标宽度 1440px；窄屏时左侧栏折叠为阶段选择器。

页面结构：

```text
Project Center
├── 顶部：项目名称、项目状态、更新时间、刷新
├── 左侧：项目总览 / Director / Video / Approval / Publisher
└── 右侧
    ├── 四个阶段状态卡
    ├── 当前阶段摘要
    ├── 待处理事项列表
    └── 最近活动摘要
```

## 3. 范围

### 包含

- 新增项目级总控页面入口：`/projects/:id`；
- 新增项目级聚合读取接口：`GET /api/v1/projects/:projectId/center`；
- 返回项目基础状态、阶段状态、待处理事项、当前阶段摘要和安全的最近 Job 信息；
- 左侧阶段栏跳转现有 Director、Publisher 工作台；未有独立页面的阶段显示状态和下一步入口，不制造死链接；
- Project Center 在加载失败、部分数据不可用和项目不存在时显示稳定错误状态；
- API 响应不包含凭据、profile、cookies、tokens、attempt diagnostics 或私有表原始行。

### 不包含

- 不在 Project Center 内编辑 Brief、Script、Storyboard 或发布文案；
- 不在 Project Center 内执行渲染、审批、入队或平台发布；快捷动作只导航到现有模块工作台；
- 不创建新的工作流引擎、事件总线、Project Center 私有数据库表或跨模块联表查询；
- 不实现 Project Center 的实时 WebSocket 推送、拖拽看板、指标分析或 AI 复盘；
- 不启动 Video MVP、Review 或真实平台 Adapter 工作。

## 4. 数据与模块边界

Project Center 是 API 组合层的只读查询，不成为新的业务事实拥有者。组合层通过公开服务读取：

| 信息 | 来源 | 允许的公开数据 |
|---|---|---|
| 项目名称、生命周期 | `ProjectService` | `ProjectRecord` |
| Director 当前/最近版本 | `DirectorService` | `DirectorRevision` 摘要 |
| 可发布成片 | `AssetCatalogService` | READY `VIDEO_RENDER` Asset 摘要 |
| Job 状态 | `JobService` | 项目范围内最近安全 Job 摘要 |
| Approval | `ApprovalService` | 项目范围内当前决策状态 |
| Publisher 摘要与账号请求 | `PublisherService` | `PublisherProjectSummary` 和安全请求摘要 |

禁止 Project Center 直接读取 `publisher_*`、`director_plan_revisions`、`approval_decisions`、`jobs` 或其他模块私表。若现有公开服务缺少查询能力，先扩展公开服务方法和对应测试，再由组合层调用。

## 5. 聚合 Contract

接口返回 `ProjectCenterSnapshot`：

```ts
type ProjectCenterSnapshot = {
  project: {
    id: string;
    name: string;
    status: string;
    updatedAt: string;
  };
  health: {
    level: 'HEALTHY' | 'ATTENTION' | 'BLOCKED' | 'COMPLETE';
    reasons: string[];
  };
  stages: Array<{
    key: 'DIRECTOR' | 'VIDEO' | 'APPROVAL' | 'PUBLISHER';
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'ACTION_REQUIRED' | 'READY' | 'COMPLETE' | 'BLOCKED';
    label: string;
    href: string | null;
    summary: string;
  }>;
  currentStage: 'DIRECTOR' | 'VIDEO' | 'APPROVAL' | 'PUBLISHER' | null;
  actions: Array<{
    id: string;
    kind: 'APPROVAL' | 'JOB_FAILURE' | 'HUMAN_ACTION' | 'PUBLISH_RETRY' | 'NAVIGATION';
    title: string;
    detail: string;
    severity: 'INFO' | 'WARNING' | 'BLOCKED';
    href: string | null;
  }>;
  recentJobs: Array<{
    id: string;
    type: string;
    state: string;
    attemptCount: number;
    maxAttempts: number;
  }>;
};
```

Contract 只返回页面需要的摘要字段。任何底层服务异常都记录为安全的聚合错误状态，不将 SQL、凭据或内部诊断传到浏览器。

## 6. 健康度与阶段规则

规则必须是确定性的，并在测试中逐条覆盖：

- `BLOCKED`：存在失败/阻塞 Job、Publisher `needsHumanActionCount > 0` 或明确需要人工处理的当前 Approval；
- `ATTENTION`：存在待审批、排队/运行中的 Job、Publisher 草稿或待发布请求，但没有阻塞项；
- `COMPLETE`：项目状态为 `PUBLISHED`，且没有未解决的阻塞或人工动作；
- `HEALTHY`：不存在上述问题，项目可以继续推进或尚未开始但没有错误。

阶段推导采用公开事实：

- Director：无版本为 `NOT_STARTED`，有草稿/接受版本为 `IN_PROGRESS`，有批准版本为 `COMPLETE`；
- Video：无 Render Job/READY Render Asset 为 `NOT_STARTED`，Job 运行中为 `IN_PROGRESS`，Job 失败为 `BLOCKED`，存在 READY Render Asset 为 `READY`；
- Approval：无当前决策为 `NOT_STARTED`，存在 PENDING 为 `ACTION_REQUIRED`，当前目标已 APPROVED 为 `COMPLETE`，REJECTED 为 `BLOCKED`；
- Publisher：无请求为 `NOT_STARTED`，存在人工动作或失败为 `ACTION_REQUIRED`/`BLOCKED`，存在排队/发布中/重对账为 `IN_PROGRESS`，存在确认外部内容为 `COMPLETE`。

## 7. 交互和错误处理

- 页面首次加载显示骨架或明确的“正在读取项目”；
- Project 不存在显示 `PROJECT_NOT_FOUND`，不渲染空壳总控页；
- 某个公开服务失败时保留项目基础信息，相关阶段显示 `暂时不可用`，页面提供刷新；
- 快捷动作使用现有模块路径，不重复提交有副作用的 API；
- 页面展示中文状态标签，同时保留稳定的机器状态值用于测试和后续国际化；
- 刷新是幂等 GET，不改变业务状态。

## 8. 验收标准

- 从项目列表进入 `/projects/:id`，可以看到 A3+B2+C1 总控布局；
- 四个阶段状态与真实 Project、Director、Asset、Job、Approval、Publisher 数据一致；
- 至少覆盖：空项目、Director 已批准、Render Job 失败、待 Approval、Publisher 人工处理、Publisher 已发布六种状态；
- Project Center 不直接访问任何其他模块私表；
- API 和 Web 不泄露秘密、诊断字段或私有数据库结构；
- API 集成测试、健康度规则单元测试、Web 回归测试全部通过；
- `pnpm test`、`pnpm typecheck`、`pnpm lint` 和 `pnpm --dir apps/web build` 全部通过；
- Slice ③ 完成后，Slice ④、⑤、⑥仍不启动。

## 9. 后续实现决策

实现应优先复用现有服务和页面样式。只有当公开服务确实缺少项目范围查询能力时，才增加最小的公开查询方法；不为 Project Center 建立新的持久化事实表。
