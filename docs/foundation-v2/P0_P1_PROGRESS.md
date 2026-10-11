# P0/P1 开发进度

2026-10-11。分支 `codex/foundation-v2-p0-p1-hardening`；起点 `9f95f1d`，原工作区未提交素材受保护。

阶段 A 已完成首轮实际审计与隔离。冻结安装、format/lint/typecheck/build、Windows runtime 23/23、desktop manager 2/2、隔离 migration matrix 10/10 通过。首次 focused suite 的 public schema 前置缺失已识别，使用既有安全 reset 脚本在本轮新建测试库初始化后重跑。

| 任务 | 当前状态 |
| --- | --- |
| T01 | VERIFIED：复用 `05a8379` 的最小实现与回归，先红（4个 readiness/并发用例失败）后绿 Job 20/20；Date/string retry_at 保留毫秒精度；无 schema变化；提交 5fcdc3c |
| T02 | VERIFIED：整合 `99d324a` 的 reviewed additive cancellation contract；本机先红 QUEUED→CANCELLED 未传播，再绿组合 33/33（20 Job + 12 cancel + 1 worker）；无 skip；typecheck通过；所有 DB fixtures 使用隔离 schema |
| T03 | VERIFIED：真实隔离DB复现迟到技术结果999覆盖640、迟到异常覆盖SUCCEEDED；已修复全部 Worker analysis写入与终态fence、Job+域结果原子提交、attempt文件路径、同连接恢复/取消；原Intelligence门禁加8项回归 48/48 PASS；无migration，保留离线签名；ADR020 |
| T04 | VERIFIED：新增4项安全测试先红后绿；统一redaction用于logger/shared errors/Job fail+defer/Analysis error和逐行Runtime日志（含跨chunk）；API生成请求correlation并保留400/422；unit 11/11、Job21/21、Runtime23/23、format/lint/typecheck通过；旧Job锁竞态fixture被其他suite残留VIDEO_RENDER前10条挤出，改用独立测试type保护场景，不放宽断言 |
| T05 | VERIFIED：资源8.3路径不可用时使用本管理器拥有的ASCII临时资源junction；保留真实数据目录；Windows中文资源+ASCII/中文数据两组均完成真实初始化、SQL读写、关闭、重启、中文内容保留（2/2，无skip），加入原Windows CI job；默认60秒启动预算不变；不递归清理junction目标 |
| T06 | VERIFIED：Hybrid命中缓存只建立Video workspace引用，保留Asset元数据及原始downloadedAt/provenance；先红后绿，Hybrid unit+真实FFmpeg integration 22/22无skip；新回归进入原full test；首次下载仍通过AssetService import；既有跨模块Asset只读SQL债务未宣称消除 |
| T07 | VERIFIED：additive项目分析历史Contract/API，limit1–100、created_at/id keyset保留PG微秒、输入校验/项目隔离；Job状态通过owner get读取并检查type/project/run，不直接SQL；UI重载恢复历史/结果，分页、持久Job状态、错误提示与busy finally；API1/1 + DB历史1/1 + Intelligence49/49 + Windows Edge browser1/1 + Web production build通过 |
| T08 | IN_PROGRESS：核心三链组合5/5；全量质量、其他模块门禁、Desktop打包/Smoke及最终报告继续执行 |

T08追加Windows进程身份修复：确定性模拟“owned child已exit但数字PID再次显示alive”，旧实现第二次taskkill（先红2≠1）；修复后不向已exit的owned child旧PID再次kill，原真实进程树关闭和12项host生命周期压测一起16/16通过。生命周期压测对所有已退出child handle做断言，避免将被Windows复用的历史数字PID当成owned进程；保留全部state/lock/restart-budget断言。新回归加入原Runtime gate。

隔离 public schema 初始化后原 focused suite 17/17 PASS，无 skip。迁移矩阵的 schema 临时清理不初始化 public；该前置现已按 CI 脚本补齐。

Windows bundled PostgreSQL 中文资源初始化故障已修复；最终2/2通过。中间实验：数据junction被initdb拒绝，因此放弃；30秒试验预算在中文路径刷盘阶段超时，恢复原Runtime默认60秒后完整通过。未移动、迁移或删除已有数据；TEMP无ASCII路径/短名称的环境仍提供明确诊断。运行产物与本地测试 URL 均在 ignored `.test-results/`。尚未 push、未创建 PR、未运行真实平台/付费API/GPU。

T07首次整组的API→Worker一致性用例被之前测试留下的pending Job挤出单次consume范围，实际QUEUED；改为独立schema并保留全部成功断言后，单独2/2和整组49/49通过。浏览器dev与production build曾同时写.next导致ENOENT；停止dev后串行production build成功。以上失败均不计入通过。
