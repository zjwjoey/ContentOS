# ContentOS Slice ③ Project Center

## Objective
实现已确认的 Project Center V0：A3 健康度+待处理、B2 左侧阶段栏、C1 状态摘要+快捷动作，并通过公开服务聚合真实 Project/Director/Asset/Job/Approval/Publisher 数据。

## Current phase
设计已确认，等待用户审阅设计稿。

## Phases

1. [x] 读取 Slice ② 验收结果和现有模块公开接口。
2. [x] 完成视觉设计选择：A3 + B2 + C1。
3. [ ] 用户审阅并确认设计稿。
4. [ ] 编写实施计划并获得执行方式确认。
5. [ ] 实现 Project Center 聚合 Contract/API。
6. [ ] 实现健康度、阶段状态和待处理事项推导。
7. [ ] 实现桌面横屏 Web 页面和响应式收窄布局。
8. [ ] 添加 API、规则、Web 回归测试并执行完整 Gate。

## Constraints

- 基于已验收分支 `codex/publisher-project-integration`。
- 不跨读模块私表；组合层只调用公开服务。
- 不在 Project Center 重复执行模块写操作。
- 不启动 Slice ④、⑤、⑥。
