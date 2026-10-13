# 连续崩溃重试策略验收

2026-10-13。用户授权顺序：先准备面向 `integration/contentos-foundation-v2` 的集成 PR，再实现连续崩溃策略，完成测试和报告。独立分支 `codex/foundation-v2-p0-p1-hardening`；实现源码 `5b18793`，之后仅增加锁观测测试修订至 `9fc02af4d133e97b86637b46cccdd96685c8c524`。C01–C04 计划 4 项、实际完成 4 项；当前源码本地验收和 PR/push 两轮 CI 均通过。原工作区及 `main` 保持原状，不合并任何分支。未跑或跳过不算通过。

## 策略与用户行为

沿用统一 Job 系统和 PostgreSQL 权威状态。0053 新增非负默认 0 的 `jobs.consecutive_lease_failures`，不回填历史、不删除 attempts/events、不启用 ADR-019。计数持久化；claim、heartbeat 和普通 RETRY_WAIT requeue 不重置；正常成功、失败结算、defer、取消及显式 terminal retry 重置连续失租计数，总 attempt history 继续增长。

owner 确认时，前两次失租恢复 RETRY_WAIT，连续第三次关闭匹配域状态及 Job。已注册 owner 无法确认归属时，首次拒绝就 BLOCKED（`LEASE_RECOVERY_OWNER_UNAVAILABLE`）；没有 callback 的旧兼容路径前两次重排、第三次 BLOCKED。清除 Job lease/retry_at，阻止旧结果写入。未知/外部 owner 域记录可保留原 RUNNING/成功状态待对账，不能伪称其失败。

同一 reconciler 只修复该明确诊断的 BLOCKED：计数小于 3 恢复 RETRY_WAIT，达到 3 收敛 FAILED；不新增 attempt、计数或重复耗尽事件。BLOCKED 不接受直接人工 requeue。FAILED/CANCELLED 的明确人工 retry 原子重置计数并记录事件，保留历史。取消优先，已完成输出保持。数字人保留 external task ID，人工重试先查询既有任务；Publisher 未知外部结果保留对账/人工状态，不盲目重发，已确认 post 本地补齐 PUBLISHED 且保留首次 published_at。

owner、attempt、Job、计数及事件在一个短事务提交。scope 禁止事务控制、嵌套 Job API 和关闭后查询；callback 退出时仍有 in-flight query 被拒绝，回滚前先关闭 scope 并 drain。不能判断已完成 Promise 是否 await。回调必须 literal true，拒绝后回滚其写入；异常整体回滚，不阻塞其他 Job。Provider、文件 IO、FFmpeg 和 canonical lookup 在事务外。

0054 为 Video-owned Shot run 新增 nullable JSONB `lease_authority`。不同 threshold Job 可共享旧唯一键，因此写入、derived-row 删除、错误及恢复都须行锁核验 Job ID/attempt ID/number；成功缓存保持。历史无 authority 的 RUNNING 不回填，恢复拒绝即 BLOCKED。该迁移未改变旧成功缓存忽略 threshold 的产品语义。Visual PENDING 共享缓存使用相同私有标记，READY 不携带标记；晚返回 profile/embedding 也核验结果归属。

不重定义旧 business fail/maxAttempts：它仍按总 attempt_count 判断，含 prior defer；未新增统一远程 pending 总等待时长上限。ADR-022 已经独立技术审查，没有第二套 Workflow。

## 提交和证据

- C01：已创建并关联[草稿 PR #7](https://github.com/zjwjoey/ContentOS/pull/7)，目标 `27d43854`；先核验祖先及已验收基线，再实施策略。原 `87a02e0` 的[六项成功 CI](https://github.com/zjwjoey/ContentOS/actions/runs/38110314765)不算新策略远端验收。
- C02 / `140b6b4`：持久独立预算、原子 owner scope/BLOCKED 修复、人工重试、0053 up/down、ADR-022。
- C03 / `349fc16`：Analysis owner 确认与严格 true；`e0c389c`：发布真相及无状态 Worker 恢复；`d89515f`：数字人原子结果、远程身份和取消；`5b18793`：Asset/Video/旧剪辑入口/共享缓存恢复、首次拒绝 BLOCKED、0054、诊断写前脱敏及组合门禁。
- C04：专项、迁移、Runtime、完整业务、生产浏览器、质量和构建通过；PR/push CI 各 6/6 SUCCESS，Windows installer/portable 重新构建并完成验收和上传。
- 核心先红 9/9（缺新能力及字段）后绿；scope 迟到 query 和 truthy malformed 确认分别保留先红后绿。旧实现第 4 次失租仍 RETRY_WAIT。0053/0054 up/down、约束与历史保留通过。测试 fixture 的 NOT NULL/manifest 前置缺失、Windows alias 和诊断中的非敏感用户名断言已修正，未删用例或放宽敏感凭证断言。
- Intelligence 首轮 51/53：原两条锁观测仍匹配旧 UPDATE，而原子人工 retry 改为先 SELECT FOR UPDATE。`9fc02af` 只更新观测 query prefix，保留实际 pg_blocking_pids 锁链、callback 次数、owner 状态和 replacement claim 断言。focused 2/2，完整重跑 53/53；未延长超时或删除并发断言。

## 当前组合验收

命令使用锁定 `pnpm@10.32.1`；业务门禁串行，Next build/dev 不同时写 `.next`。数据库仅本轮 owned 临时 PG / `contentos_test`（端口 53562）和独立 schema。ignored `.test-results/` 保留日志，不提交数据库 URL、凭证或临时媒体；重叠专项不相加成独立总数。

| 门禁 | 当前结果 | 日志 |
| --- | --- | --- |
| frozen install / format / lint / typecheck / build / doctor / diff --check | PASS | `lease-frozen-install-final.log` / `final-{step}.log` |
| 连续失租组合 | 101/101，fail/skip 0 | `lease-suite-final.log` |
| migration matrix | 10/10，fail/skip 0 | `migration-final.log` |
| Runtime unit | 27/27，fail/skip 0 | `test-runtime-final.log` |
| 真实 host/生命周期 | 14/14，fail/skip 0 | `test-runtime-integration-final.log` |
| full | 391/391，fail/skip 0 | `test-combined-final.log` |
| Intelligence | 53/53，fail/skip 0 | `test-intelligent-editing-v15-combined-final.log` |
| Digital Human | 63/63，fail/skip 0 | `test-digital-human-combined-final.log` |
| Production pipeline | 12/12，fail/skip 0 | `test-production-pipeline-combined-final.log` |
| integration closure | 32/32，fail/skip 0 | `test-integration-closure-combined-final.log` |
| Auto Edit V1 / V1.5 | 28/28、20/20，fail/skip 0 | `test-auto-edit-{v1,v15}-combined-final.log` |
| V3.4 | 37/37，fail/skip 0 | `test-script-editing-v34-combined-final.log` |
| 生产版 Web build + 浏览器 | PASS、11/11，fail/skip 0 | `lease-production-browser-final.log` |
| 本次六项 CI / Windows 重新打包与验收 | [PR CI](https://github.com/zjwjoey/ContentOS/actions/runs/38349943709)、[push CI](https://github.com/zjwjoey/ContentOS/actions/runs/38349937000)各 6/6 SUCCESS | head `9fc02af`，当前源码重新构建和验收 |

两轮六项均为 Quality、Build、Database and tests、Windows Runtime Startup V1、Browser and render acceptance、Desktop Windows package and smoke。Windows 新构建的 unpacked/portable/installer smoke、安装/卸载和保留数据、clean import/render/crash restart 全部通过。push 产物 `contentos-desktop-windows-9fc02af4d133e97b86637b46cccdd96685c8c524`（artifact ID 11790344303，757094440 bytes）已上传；未下载或运行本机注册安装器。本报告及后续进度收尾仅文档，不改变上述已验收实现；文档 push 自动触发的后续 CI 不是这里已完成两轮的验收对象。

101 项为核心 12、Asset/Video 27、数字人 13、Publisher 12、其他剪辑入口 16、Visual 10、Analysis 11，均在当前组合源码跑完。Asset 保留并核验 staged 输入；Video item/batch/manifest/Job 原子提交，失败 batch 不自动造替代 Job；扫描严格匹配持久 source_root；共享成功结果与导出锁归属保护；Analysis 替代 attempt 清理旧部分结果。Job/attempt/Asset/prepare/数字人及新增 Publisher scoped/Visual port 诊断写前脱敏，检查原始 PG 行；不声称历史所有非 scoped API 全已改造。

失租回归采用真实隔离 PostgreSQL、推进 lease expiry、挂起后晚返回/晚报错和 commit veto，未在每个指令位置强杀进程/断电。真实本地 FFmpeg/ffprobe 覆盖素材导入、镜头检测、独立 JPEG、数字人本地 HTTP 视频下载/探测/导入、竖屏音视频渲染及中文空格路径缩略图。AI/数字人/发布使用 Fake 或测试 Adapter；无真实 GPU、付费 API、社交平台发布，测试账单字段非真实计费。

## 当前验收状态与边界

- Export 的物理 rename 与数据库提交不原子，崩溃可遗留目标文件/锁目录。DB fence 不伪造成功，但同名目标需检查/对账或换名，不承诺文件自动回滚。
- 数字人 Asset 导入先于 Generation/Job commit，失租可留下未绑定 Asset/文件；avatar 有安全关联清理，speech 未完整清理 unbound OUTPUT；不声称跨模块/文件事务。
- 旧 queued alias 在执行前 canonical lookup 后可继续并保留历史 rootId；失租恢复不做文件 IO，路径无法确认则 BLOCKED。历史 publicRootId 前缀截断碰撞未全局重编码。
- 旧 Visual/Shot 无归属及已成功 owner/Job 不一致待成功对账，没有历史 drain/backfill。Director/Review/Benchmark 虽各自恢复明确 Job types，旧 AI/revision 写入未全部 attempt-fenced。
- Draft Preview/Jianying Import 是没有 RUNNING owner 占位的旧入口，已纳入 Job 失租限额，但旧缓存/导入文件副作用没有全程 attempt fence；不将本轮四个剪辑入口及视觉修复推广成所有 Video 路径均已改造。
- owner 恢复 callback 自身异常时事务整体回滚，保留失租记录并写安全诊断事件，需修复 owner/DB 后重新协调；不能把未确认的回滚宣称成已完成域终态。
- 其他模块 Asset 私表读取、同步 search provider 预算、真实 GPU/Provider/平台及其他 Windows/权限/杀毒环境矩阵仍需后续验收。本轮完成不等于所有 P0/P1 生产问题清零。

回滚先撤消费者/Job 策略，再依次 0054、0053 down。删除 authority/counter 不重建原并发归属，不能自动重开已停 Job；保留历史与文件，由明确 owner 工作流决定重试。只正常 push 本独立分支更新集成草稿 PR，不合并 main，不运行本机已有安装的注册安装器/卸载器。

本机测试完成后核验 owned PG 精确目录、53562 listener 及 PID 9952/可执行文件/命令行，再使用 pg_ctl fast 正常关闭；postmaster.pid 与端口消失，数据目录保留。日志 `lease-owned-postgres-stop-final.log`。没有停止其他 PostgreSQL/应用，未删除真实素材或数据库。原工作区仍为 `aa4a8907`，仅原 `local-media/` 未跟踪；main 仍为 `c8d0dd4`。
