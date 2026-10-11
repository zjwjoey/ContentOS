# P0/P1 开发进度

2026-10-11。分支 `codex/foundation-v2-p0-p1-hardening`；起点 `9f95f1d`，原工作区未提交素材受保护。

阶段 A 已完成首轮实际审计与隔离。冻结安装、format/lint/typecheck/build、Windows runtime 23/23、desktop manager 2/2、隔离 migration matrix 10/10 通过。首次 focused suite 的 public schema 前置缺失已识别，使用既有安全 reset 脚本在本轮新建测试库初始化后重跑。

| 任务 | 当前状态 |
| --- | --- |
| T01–T08 | PLANNED，详见执行计划；尚未声称开发完成 |

Windows bundled PostgreSQL 在中文路径初始化失败，ASCII对照路径成功；失败信息与测试命令记录于审计。运行产物与本地测试 URL 均在 ignored `.test-results/`。尚未 push、未创建 PR、未运行真实平台/付费API/GPU。
