# P0/P1 开发进度

2026-10-11。分支 `codex/foundation-v2-p0-p1-hardening`；起点 `9f95f1d`，原工作区未提交素材受保护。

阶段 A 已完成首轮实际审计与隔离。冻结安装、format/lint/typecheck/build、Windows runtime 23/23、desktop manager 2/2、隔离 migration matrix 10/10 通过。首次 focused suite 的 public schema 前置缺失已识别，使用既有安全 reset 脚本在本轮新建测试库初始化后重跑。

| 任务 | 当前状态 |
| --- | --- |
| T01 | VERIFIED：复用 `05a8379` 的最小实现与回归，先红（4个 readiness/并发用例失败）后绿 Job 20/20；Date/string retry_at 保留毫秒精度；无 schema变化；提交 5fcdc3c |
| T02 | VERIFIED：整合 `99d324a` 的 reviewed additive cancellation contract；本机先红 QUEUED→CANCELLED 未传播，再绿组合 33/33（20 Job + 12 cancel + 1 worker）；无 skip；typecheck通过；所有 DB fixtures 使用隔离 schema |
| T03 | VERIFIED：真实隔离DB复现迟到技术结果999覆盖640、迟到异常覆盖SUCCEEDED；已修复全部 Worker analysis写入与终态fence、Job+域结果原子提交、attempt文件路径、同连接恢复/取消；原Intelligence门禁加8项回归 48/48 PASS；无migration，保留离线签名；ADR020 |
| T04–T08 | PLANNED，详见执行计划 |

隔离 public schema 初始化后原 focused suite 17/17 PASS，无 skip。迁移矩阵的 schema 临时清理不初始化 public；该前置现已按 CI 脚本补齐。

Windows bundled PostgreSQL 在中文路径初始化失败，ASCII对照路径成功；失败信息与测试命令记录于审计。运行产物与本地测试 URL 均在 ignored `.test-results/`。尚未 push、未创建 PR、未运行真实平台/付费API/GPU。
