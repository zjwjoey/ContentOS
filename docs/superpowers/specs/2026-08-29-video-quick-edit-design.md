# ContentOS Video Quick Edit 设计

## 状态

已获得用户确认，作为 Video V2 的第一个垂直切片。本文只定义 Quick Edit，
不打开 Random Montage Planner V2、单镜重抽、真实平台 Adapter 或 Review
Analytics 的实现范围。

## 目标

让操作员能够在当前 Video Manifest 的基础上，明确修改镜头裁剪、删除和顺序，
生成一个新的不可变 Manifest 版本，预览该版本并通过 Durable Job 完成真实
FFmpeg 渲染和新的 Render Approval。

## 非目标

- 不由 AI 或 Renderer 自动选择、改写或补齐镜头。
- 不支持跨项目素材引用、平台发布和发布后数据复盘。
- 不在本切片实现单镜替换、随机蒙太奇规划或新的 Manifest schema。
- 不修改已有 Manifest、Render、Approval 或已发布内容的历史记录。

## 核心用户流程

```text
打开 Video 工作台
    ↓
查看当前 Manifest 版本和时间线
    ↓
提交明确的 Quick Edit 操作
    ↓
校验项目、素材、镜头和时间范围
    ↓
写入 Manifest vN+1（vN 保留为历史）
    ↓
预览 vN+1
    ↓
从 vN+1 创建 VIDEO_RENDER Job
    ↓
Worker 按 manifestId + revision 精确渲染
    ↓
生成新的 Render Output Asset
    ↓
绑定新的 Render Approval
```

## 编辑操作契约

Quick Edit 使用显式、可序列化的操作列表。第一版支持三种操作：

```ts
type QuickEditOperation =
  | { type: 'TRIM'; clipIndex: number; sourceInMs: number; durationMs: number }
  | { type: 'REMOVE'; clipIndex: number }
  | { type: 'REORDER'; clipIndexes: number[] };
```

操作按数组顺序应用于内存中的时间线。每个 `clipIndex` 指该操作执行前的
当前时间线索引；因此操作顺序是请求语义的一部分，UI 默认一次只修改一个
镜头。一次请求中不允许对同一索引产生无法确定的多次修改。操作完成后必须
重新执行 `EDIT_MANIFEST_V0` 合同校验。

### 校验规则

- 基准 Manifest 必须属于请求项目，且是当前 `PERSISTED` 版本。
- `TRIM` 的 `sourceInMs` 和 `durationMs` 必须为整数，且均大于零；
  `sourceInMs + durationMs` 不得超过对应 READY 源视频的 `durationMs`。
- `REMOVE` 不能删除最后一个镜头。
- `REORDER` 必须是基准时间线索引的完整排列，不得重复、遗漏或越界。
- 最终时间线不得出现相邻相同素材，必须继续满足 V0 Manifest 合同。
- 所有素材必须属于项目且仍为 READY；项目边界不通过客户端输入绕过。

## 持久化和版本语义

复用 `edit_manifests` 作为事实来源，新增最小 provenance 字段：

- `parent_manifest_id`：指向产生当前版本的 Manifest；首个规划版本为 null。
- `edit_operations`：经过 schema 校验的 Quick Edit 操作 JSON。
- `created_by`：操作员标识，不保存凭据或浏览器会话信息。
- `idempotency_key` 和 `input_digest`：绑定同一项目中的重复提交，保证同一
  操作只生成一个版本；相同键但摘要不同必须冲突。

每次创建版本在一个数据库事务内完成：项目级 advisory lock、读取当前版本、
校验父版本、写入 vN+1、将上一 `PERSISTED` 版本标记为 `SUPERSEDED`。唯一约束
继续保证 `(project_id, revision)` 不重复。旧 Manifest、Render 和 Approval
只读保留；新版本不会继承旧 Render Approval，必须重新创建精确的 `RENDER`
Approval。

若相同 `idempotencyKey` 重复提交，返回已存在的版本和关联 Job，不再写入第二个
Manifest。相同键但操作内容不同必须返回冲突。

## API 和模块边界

Video 模块通过公开服务提供版本创建和精确渲染输入，API 只编排验证和响应：

- `GET /api/v1/projects/:projectId/video/manifests`：返回安全的版本摘要。
- `GET /api/v1/projects/:projectId/video/manifests/:manifestId`：返回版本和时间线。
- `POST /api/v1/projects/:projectId/video/manifests/:manifestId/quick-edit`：
  接收 `operations`、`createdBy`、`idempotencyKey`，返回新版本。
- `POST /api/v1/projects/:projectId/video/manifests/:manifestId/render`：创建
  引用精确 Manifest 版本的 `VIDEO_RENDER` Job。

API 不读取 Asset、Job 或 Render 私有表；它只调用 Asset Catalog、Video、Job
和 Approval 的公开 Contract。Renderer 和 Worker 不读取请求体中的编辑意图，
只消费已经持久化且校验过的 Manifest。

## Worker 和渲染语义

`VideoJobPayload` 增加 `manifestId`、`manifestRevision` 和 Manifest 来源信息。
当 Job 指定 Manifest 时，Video Worker 必须：

1. 在同一项目内读取指定版本；
2. 验证版本号、项目 ID、所有素材 checksum 和 READY 状态；
3. 使用该 Manifest 调用 FFmpeg；
4. 通过现有 attempt fence、取消、lease recovery 和原子 Asset promotion 完成结果。

Worker 不重新调用随机规划器，不覆盖 Manifest，也不从客户端参数推导镜头选择。
原有从 Director pair 规划 Manifest 的入口继续保留，作为兼容的创建首版本路径。

## UI 交互

Video 工作台保留现有自动规划入口，并增加 Quick Edit 区域：

- 显示当前版本、父版本和时间线镜头卡片。
- 每个镜头提供开始时间、时长、删除和顺序编辑控件。
- “生成 Quick Edit 版本”只持久化新 Manifest 并刷新预览，不自动启动 FFmpeg。
- “创建渲染 Job”只针对当前预览版本，渲染完成后显示输出并提供 Render Approval。
- 版本历史可查看，但历史版本不能被静默覆盖。
- API 错误显示安全的校验消息，不显示 SQL、路径凭据、token 或 Worker 诊断。

## 失败、幂等和并发

- 项目不存在、Manifest 不属于项目、版本过期或素材不再 READY：返回明确的
  404/409/422，不创建 Job。
- 同一 Quick Edit 请求重复投递：复用同一版本；同一版本重复 Render：复用
  同一 Job。
- 并发编辑以项目锁串行生成版本，后提交者若父版本已过期必须重新读取并返回
  `VIDEO_MANIFEST_CONFLICT`，不能覆盖前一个版本。
- FFmpeg 失败、取消、lease recovery 和 stale attempt 继续沿用现有 Job/Render
  事务边界，不产生孤立 READY 输出。

## 测试和验收

- 合同测试：三种操作的 schema、索引、时间边界、完整重排和最终 Manifest 校验。
- Video Service 集成测试：版本追加、父版本、SUPERSEDED、项目隔离、并发冲突和
  幂等重复。
- API 集成测试：安全输入、错误码、精确版本读取和 Render Job payload。
- Worker 测试：指定 Manifest 被精确消费，随机规划器不会覆盖编辑结果，旧版本
  checksum 或素材状态变化会终止失败。
- 浏览器 E2E：打开已有项目 → 修改一个镜头 → 生成 vN+1 → 预览 → 渲染 →
  新 Render Approval；重复提交和重复渲染只产生一个版本和一个 Job。
- 回归门禁：format、lint、typecheck、root/Web build、Video 聚焦测试和完整
  `pnpm test`。

## 受控演进

本切片只新增 Video 模块的公开 Contract、迁移和页面能力。若未来要支持单镜
替换或 Planner V2，必须分别定义操作契约和 ADR，不把平台或 AI 逻辑放入 Quick
Edit，也不改变 `EDIT_MANIFEST_V0` 的不可变语义。
