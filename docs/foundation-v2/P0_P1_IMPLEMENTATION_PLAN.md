# P0/P1 执行计划

2026-10-11；在独立分支按依赖执行。验收状态持续维护于 P0_P1_PROGRESS.md；每项必须有代码和可重复结果，不凭文件存在宣称完成。

| ID / 优先级 | 问题、模块及目标 | 文件范围 | Contract/API/DB 影响 | 测试与完成标准 | 回滚 / 提交范围 |
| --- | --- | --- | --- | --- | --- |
| T01 P0 | Job claim 锁内复核 retry_at，保留毫秒精度和显式 requeue | JobService、job.test.ts | 无 schema/API 变化 | 未来重试不执行、不增 attempts/events；到期并发单 claim；已有 retry/defer 保持 | revert 该功能提交；fix(p0) |
| T02 P0 | 将远端已审查的 queued analysis cancellation 整合到同一分支 | Job scope、Intelligence、Media Worker、ADR018、queued-cancel tests | additive terminal-cancel executor；无 migration | 原 red 用例、row-lock/requeue 竞态、rollback、scope失效、扫描公平性、小池、原 Job 全通过 | revert 集成提交；fix(p0) |
| T03 P0 | Media analysis 每次写入及最终结果受当前 Job attempt fence 保护；provider 不占长事务；恢复不覆盖新结果 | Media service/handler/reconciler、Job owner ports、ADR、DB regressions | additive optional context/owner ports；优先无 schema 方案，保留离线无 Job fixtures；不得激活未经满足条件的旧分阶段 owner | 迟到 A stage/catch 不改 B；取消、claim前/后crash恢复、小池并发、attempt-specific keyframe；成功域结果与Job一致 | revert 独立提交；fix(p0) |
| T04 P0 | 原始错误和输出凭证脱敏，保留诊断与 correlation | logging、shared errors、JobRunner、API、ProcessManager | additive redaction helper；错误 envelope 兼容 | URL/password/bearer/query/结构化凭证不进入日志/DB/API；保持非敏感诊断；producer/consumer tests | revert 独立安全提交；fix(p0) |
| T05 P0 | Windows 中文资源/数据路径 PostgreSQL 初始化 | runtime postgres manager、Windows integration test | 无业务 schema；只新cluster及运行路径 | ASCII/Unicode本机真实初始化、读写、关闭重启；不得迁移或删除现有数据 | revert runtime提交；fix(p0) |
| T06 P1 | Hybrid cache 命中不得更新 canonical Asset 元数据/下载时间 | hybrid-media、Asset owner、integration test | 优先保持首次导入元数据不可变，无 schema | 首次导入/缓存复用/association兼容，checksum/storage/metadata不变，无重复下载 | revert独立提交；fix(p1) |
| T07 P1 | 分析历史/API/UI持久恢复、真实任务状态、失败可恢复 | Intelligence owner list、API schemas/routes、Web intelligence页 | additive project-scoped list；已有返回值兼容 | 刷新可读历史、project隔离、失败/网络恢复、busy finally、API + browser/Web build | revert独立提交；feat(p1) |
| T08 P0/P1 | 持续验收与核心业务链 | package scripts、现有tests与窄组合E2E、四份报告 | 复用既有框架，不接真实账号 | 三条链：内容→Render→Approval；素材→剪辑→项目输出；批准快照→Fake publish→模拟指标→Review；quality/full/runtime/desktop/Web门禁结果明确 | revert新增门禁/文档；test(p0)/docs(foundation) |

执行顺序 T01→T02→T03，安全/Runtime阻断按证据可提前；T06/T07依赖前面的可靠状态。任何 test failure 先定位触发，不删除测试、不放宽安全断言。新 regression 先红后绿。每项完成后 diff --check、focused tests、类型检查和必要整体回归，分阶段 Git commit，避免混入 ignored 媒体与开发者原改动。

未授权项独立保留：改变 lease-loss retry/defer 预算需要兼容策略 ADR；历史 RUNNING 数据 drain/回填、真实 GPU/平台验收、付费外部调用、main合并。它们不阻止其他安全任务。若本轮能力不足或环境阻断，以真实缺口和复现命令记录，不能把未跑/skip算通过。可将通过验证的开发分支正常 push 触发 Actions；读到实际结果后才报告远端通过。

执行中发现的阻断仍归入原任务：T03补上替代attempt清理部分结果及视觉adapter实际关键帧路径；T05依据英文Windows CI补上短路径身份验证、复制资源的UTF-8进程声明及首次建库独立预算（ADR021）；T08补上退出child的PID复用保护、历史诊断读取脱敏、模板迟到读取保护与模拟Review闭环。没有扩展成第二套架构或P2产品。具体提交、失败记录、最终门禁与后续决策见P0_P1_ACCEPTANCE_REPORT.md；基线审计保留改动前事实。

## 2026-10-13 连续崩溃收尾计划

用户授权先准备集成PR，再实施此前保留的连续失租策略；不合并main。继续使用原独立worktree/分支。

| ID | 问题/目标与文件范围 | Contract/API/DB影响 | 测试与完成标准 | 回滚/提交 |
| --- | --- | --- | --- | --- |
| C01 | 将已验收87a02e0提交为面向integration/contentos-foundation-v2的草稿PR | 无业务变化；核验目标27d43854为祖先，已有21个后续提交 | 最新CI六项成功；PR明确基线、范围和未验收边界，关联聊天 | 关闭草稿不改分支；不merge |
| C02 | Job独立连续失租预算、BLOCKED可补偿恢复及人工重试原子事件 | ADR022；0053仅新增非负默认0计数；additive typed recovery callback，固定第三次失租停止；旧business maxAttempts不重定义 | 重启/并发/heartbeat/fence、defer/人工reset、回调rollback/拒绝、安全scope、migration up/down | 先revert消费者/Job策略再down；不自动重开终态/删除历史；fix(p0) |
| C03 | Asset/Video/Media/DigitalHuman/Publisher与无RUNNING占位owner接入恢复；堵住自动替代Job和迟到Provider反写 | 各owner公开executor ports与当前attempt scope；0054 nullable Video Shot lease_authority防跨Job覆盖，不改成功缓存threshold语义；外部未知状态保留对账、staged输入和remote ID | 实际隔离PG；domain+Job一致、完成结果保护、batch不绕预算、忽略abort晚结果及错误不复活；归属不明首次BLOCKED，无回填 | 撤消费者后0054/0053依次down，不重开终态、不删除业务记录或素材；fix(p0) |
| C04 | 验收、正常push更新PR、维护报告 | 新test:lease-recovery纳入原full/CI；不加真实账号或付费调用 | focused/full/Intelligence/DigitalHuman/migration/runtime/build及完整CI；失败保留证据，最终报告区分legacy/真实资源边界 | docs/test提交；不绕CI、不mergemain |

2026-10-13执行结果：C01–C04计划4项、实际完成4项。9fc02af源码的本地组合门禁及PR/push CI各6/6通过；Windows当前新包重新构建及安装/卸载/数据保留/clean render/restart和上传完成。回滚、旧owner/文件副作用与真实环境边界见CONTINUOUS_CRASH_RETRY_ACCEPTANCE.md；没有合并integration或main，原工作区/素材保留。
