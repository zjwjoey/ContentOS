# ContentOS Product V1 Acceptance Repair Design

日期：2026-09-01  
基线：`origin/main@55ee105`（PR #5 已使用普通 Merge commit 合并）

## 目标

修复 Product V1 审查中影响真实产品闭环的状态绕过、真实视频号发布结果、排期、封面选择和 Publish Revision 编辑问题，并补齐能证明这些约束的契约、集成和浏览器测试。

## 范围与顺序

### Phase A：状态与外部结果安全

1. Script 和 Storyboard 只能通过 `ApprovalService` 的 `PENDING → APPROVED/REJECTED` 流程推进。保留旧接口以兼容已存在的调用方，但接口不得改变业务状态；新 API/UI 不再提供绕过审批的快捷操作。
2. Approval 创建接口只允许创建 `PENDING`。批准/驳回必须引用同一个 entity 和具体 revision；Video 只消费已批准的 revision 对。
3. WeChat Channels Adapter 在成功后必须返回可持久化的外部帖子 ID；如果平台没有可确认 ID，则返回需要人工处理的明确结果，不伪造 `ExternalPost`。

### Phase B：产品入口与恢复语义

1. Publisher UI 提供未来发布时间字段。未来时间的请求保持 `SCHEDULED`，由 durable Job/Worker 在到期后进入发布队列；过去或当前时间可立即入队。
2. Publisher UI 从当前项目 READY 素材中选择可用封面并显示安全的文件名/元数据，不要求输入 Asset ID。平台不支持的封面类型或策略必须在交接时明确拒绝。
3. Publisher 草稿允许编辑标题、描述、hashtags、封面和排期，编辑产生新的不可变 Publish Revision；Approval 始终指向新 revision。
4. 真实平台 reconcile 在多次未知结果后转入明确的人工处理状态，并显示恢复动作；不能无限停留在 `RECONCILING`。
5. 增加一条不使用兼容快捷按钮、覆盖 Project → Director → Benchmark → Assets → Video → Approval → Publisher → Review 的浏览器验收链路。

## 边界与安全

- 不删除旧数据库字段或破坏已有公共查询接口；旧 Director 状态接口改为兼容性错误/迁移提示，不能绕过审批。
- 不在浏览器、Job payload 或日志中传递凭据、Cookie、Token、Storage 绝对路径或私有表数据。
- 真实抖音/视频号仍受显式 feature flag、账号验证和人工确认保护；Fake 流程继续作为无凭证默认路径。
- 不猜测平台未定义的封面尺寸；先执行类型/READY/项目归属校验，平台策略由 Adapter capability 明确表达。

## 验收证据

- 每个 Phase A/B 行为先有一个会失败的自动化测试，再实现最小修复。
- 最终必须通过全量单元/集成/契约测试、迁移矩阵、完整 Operator 浏览器链路、typecheck、lint、format、root/Web build、doctor 和 diff-check。
- 报告必须区分 V1 已完成能力、真实平台受保护能力和仍属于后续平台策略的事项。
