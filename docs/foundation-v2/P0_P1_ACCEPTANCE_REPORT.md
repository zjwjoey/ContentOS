# P0/P1 本地验收报告

2026-10-11，独立工作分支 `codex/foundation-v2-p0-p1-hardening`，基线 `9f95f1d`。本文件在最终门禁结束前为持续更新的验收记录，未列结果不算通过。

## 范围与结论

计划共8项，T01–T07完成代码、回归与分阶段提交；T08本地验收完成，远端CI发现英文Windows路径编码缺陷，修复及复验中。新增Windows进程身份、模板时序及分析重试修复均已提交。没有修改/合并main、重写远端历史、连接真实用户数据库、清理原素材、调用付费Provider或真实发布。

这轮验证的是现有模块的可靠衔接，不等于所有第三方/GPU能力已生产验收。保持模块化单体、唯一Job系统、PostgreSQL业务事实及冻结EDIT_MANIFEST_V0。没有增加业务数据库迁移或启用需要历史drain的分阶段attempt-owner方案。

## 实际改动及追溯

| 提交 | 结果 |
| --- | --- |
| d18b9ab | 实际基线审计、任务拆分与隔离记录 |
| 5fcdc3c | claim锁内重查retry_at，未来任务不执行/不增attempt；复用远端05a8379 |
| 61b1def | 未启动分析取消，同连接终态scope、rollback与公平发现；整合99d324a |
| e83d738 | Worker分析stage/错误/终态受现有attempt fence保护，迟到任务不能覆盖替代任务，Job+域结果原子提交；ADR020 |
| 1539e12 | 持久错误/API/进程逐行日志统一脱敏，请求correlation及4xx保留 |
| eb572b4 | Windows中文资源路径ASCII资源别名，真实数据目录保留，关闭清理仅本管理器junction |
| 5924a2d | Hybrid缓存复用保留canonical Asset元数据及首次下载来源 |
| c83c005 | 持久项目分析历史/API分页/页面刷新恢复/失败重试；PG微秒分页不漏记录 |
| d52c476 | Windows owned child退出后不再终止旧数字PID，避免PID复用风险 |
| 73a0f4b | Job/分析历史诊断读取时脱敏，不重写旧业务数据 |
| 7913ece | 延迟初始模板读取不覆盖用户选择，保留正确片头；生产浏览器确定性回归 |
| 4c2d5ce | 替代分析清理旧stage结果/向量；生成的attempt关键帧实际路径交给视觉adapter |
| 374bb2c | 三链Review端到端、模拟数据标记、Desktop隔离验收脚本与报告；正常push独立远端分支 |

原工作区 `F:/ai剪辑/ContentOS` 的 `codex/main-ci-hardening-final` 与未提交 `local-media/` 保持原样。工作目录 `F:/ai剪辑/.worktrees/contentos-foundation-v2-p0-p1`。基线审计是改动前快照，不回写为事后“全通过”。

## 核心业务链证据

1. `tests/e2e/contentos-integration-vertical-slice.test.ts` 实际运行Project→Brief→Fake AI Director Job→接受Script revision→批准Storyboard revision→Asset导入→Video Job→真实FFmpeg Render→精确Render Approval。结果是可probe的MP4及持久输出Asset。
2. `tests/e2e/video-standalone-quick-edit-vertical-slice.test.ts` 实际使用Asset/Video两个Worker完成本地导入、编辑计划、H.264/AAC渲染与workspace/project输出关联。
3. 扩展第一条现有E2E：精确Publish revision Approval→不可变发布payload→Fake Publisher→PUBLISHED/ExternalPost持久化→Review Metrics Job（source=FAKE）→Review Analysis Job（AI provider=fake）→报告引用同一post和snapshot。Fake报告摘要明确标注模拟。另验证网络重试、过期认证需人工处理、不确定发布对账唯一post。

组合5/5，无skip；不将模拟播放量当成真实效果，不将Fake AI/发布当成真实平台验证。

## 门禁结果

所有DB命令只使用本轮新建临时PostgreSQL18、本地随机端口、`contentos_test`；迁移矩阵/新并发历史用例另用独立schema。临时URL、日志、媒体、构建包在ignored目录，不提交凭证/用户资料。命令统一使用仓库固定 `npx --yes pnpm@10.32.1`，普通pnpm11不作为验收工具。

| 命令/场景 | 实际结果 |
| --- | --- |
| install --frozen-lockfile | PASS，lockfile无变化 |
| format / lint / typecheck / build | PASS；format/lint本身只是现有轻量检查，不宣称全仓静态架构/凭证扫描 |
| --dir apps/web build | PASS，完整Next生产构建；包括全部项目页面 |
| test:intelligent-editing-v15 | 最终PASS51/51，无skip；实际DB/FFmpeg/fence/cancel/recovery/分页及替代结果/adapter路径回归 |
| browser：intelligent-editing-v15 | PASS 1/1，本机Windows Edge headless；上传→分析→刷新恢复→网络失败重试→候选替换→渲染 |
| Windows Unicode PostgreSQL | PASS 2/2，无skip；中文资源+ASCII/中文数据，真实SQL中文读写、关闭重启保留内容 |
| Hybrid focused | PASS 22/22，无skip，真实FFmpeg回归及缓存不可变 |
| run doctor | PASS 7/7，显式调用package脚本；裸pnpm doctor未执行自定义脚本不计PASS |
| test:runtime | PASS24/24，无skip，含新增owned PID回归 |
| CONTENTOS_RUNTIME_INTEGRATION=1 test:runtime:integration | PASS14/14，无skip，实际API/Web/core启动及关闭、20循环竞态 |
| owned process/lifecycle focused | PASS16/16，无skip；包含真实进程树及12项RuntimeHost生命周期 |
| test:desktop | PASS2/2，仅manager unit，不冒充Electron验收 |
| Windows runtime lifecycle | PASS1/1，无skip |
| test:migrations | PASS10/10；52forward迁移及历史兼容 |
| full test | 最终PASS301/301，无skip；包含历史读取脱敏及完整模拟Review链 |
| test:integration-closure | PASS32/32，无skip，真实adapter fail-closed和Mock边界，不访问实际平台 |
| test:auto-edit-v1 / v15 | PASS28/28、20/20，无skip |
| test:script-edit-v2 / v3 / v34 | PASS37/37、33/33、37/37，无skip，真实FFmpeg及原导入/预览/素材锁定 |
| test:digital-human | PASS63/63，无skip；Fake语音/Avatar及真实FFmpeg handoff，不含GPU |
| test:production-pipeline | PASS12/12，无skip，含Approval/Publish/Review跳过及安全分支 |
| Windows打包 | installer和portable实际构建成功；原builder/config未放宽，ASCII临时输出目录规避本机文件占用 |
| packaged smoke | unpacked及portable PASS，PACKAGED/EMBEDDED，PG18.4、FFmpeg6.1.1及全部服务READY；未配置外部provider明确WARN |
| clean acceptance（unpacked） | PASS；导入→两份真实MP4→模拟崩溃恢复→3次额外重启→同一PG cluster→无新增ContentOS/PG进程 |
| 完整production browser | 最终PASS11/11，无skip；8个原browser文件、Windows Edge headless、Next生产版 |
| 远端Actions | [38107294536](https://github.com/zjwjoey/ContentOS/actions/runs/38107294536)，源码374bb2c；Quality/Build通过；Windows Runtime中文路径spawn ENOENT失败，修复复验中；其余运行中 |

## 失败与处理（不计通过）

- 首次public schema未初始化：42P01；用既有受保护reset脚本只初始化本轮新测试库，focused重跑成功。
- 新修复回归均先红后绿，包括迟到结果/异常、缓存元数据、错误脱敏、请求历史404、重复终止已退出PID。不是删除或放宽安全测试。
- API→Worker一致性旧fixture与遗留pending队列混用；改成独立schema，成功断言不变，整组49/49通过。
- 同时运行Next dev与production build污染.next造成ENOENT；结束dev后串行构建PASS。后续构建/浏览器串行。
- 全量第一次300/301；Fake outcome用例在未来retry_at立即第二次execute违反新的锁内保护。改用既有显式requeue，不恢复过早claim，最终301/301。
- Runtime旧压测对历史数字PID存活做断言，单次失败；20循环单独复验成功。确定性新增测试另复现已exit child旧PID被重复taskkill的风险并修复，生命周期改按全部owned child handle退出判断，不将可能被复用的历史PID当作owned进程。
- 桌面打包先遇Electron解压rename EPERM及resource edit文件占用；使用新的ASCII临时输出目录复验原builder后installer+portable成功。不禁用签名/安全校验或更改Electron。
- clean acceptance首轮port占用fixture socket未处理ECONNRESET，测试脚本崩溃；补socket error handler，仅关闭该次临时runtime；完整重跑通过，不影响原安装或其他PostgreSQL实例。
- 完整生产浏览器首轮10/11；模板初始GET迟到覆盖用户选择。增加版本保护及延迟GET回归后focused1/1，最终完整11/11。
- 远端英文Windows将cmd短路径输出中的中文转换成问号；原代码误判为有效ASCII文件名，两个Unicode资源用例spawn ENOENT。本地中文系统未复现这条错误；修复改用cmd Unicode/UTF-16LE输出，并核验realpath同一目标。原两个专项保留，远端复验中。
- 额外非BMP（emoji）数据目录实验在本机PostgreSQL原生argv编码阶段失败；没有把它算入通过。测试范围仍为原两项中文资源/中文数据，不将“Unicode通过”扩张成任意字符均支持。
- 打包验收的资源快照在73a0f4b/7913ece/4c2d5ce之前生成；只作为packaged运行与关闭证据，不作为最终修复版本发布包。远端Windows CI须重新构建当前源码。没有运行本机installer/uninstaller改写既有安装。

## 剩余风险与集成边界

| 级别 | 状态/具体限制 | 后续验收 |
| --- | --- | --- |
| P0（需架构决策） | 普通lease连续丢失可持续重排队；原ADR/audit将失败预算列needsdecision。不能用总attempt_count上限破坏maxAttempts=1远程pending defer，也不能孤立终止Job留下域RUNNING | 确定失败次数、defer例外、人工重试及各owner同步策略后独立ADR+组合回归；未宣称已解决 |
| P1 | 部分Video/Intelligence仍直接读取其他模块Asset私表；本轮移除了缓存写入与分析Job私表读取，但未全仓替换读端口 | 按模块增加窄owner read ports和consumer tests，不用通用SQL helper隐藏权限 |
| P1 | Intelligence search embedding仍同步API调用，provider实际超时/吞吐待验证；离线无Job analyzeRun保留兼容签名 | 后续明确search预算/取消，生产analysis必须经Job handler附带attempt context |
| P1 | 原分阶段owner方案有历史drain/activation前置，本轮没有运行0053/历史回填 | 有数据副本的专门迁移演练与显式批准后再启用 |
| 环境 | 本机已有ContentOS安装，运行安装器/卸载器可能改现有注册项 | 本轮只用unpacked/portable和临时userData；安装/卸载另在干净Windows VM运行 |
| 环境 | TEMP若无法获得ASCII路径/短名称，资源alias会返回明确诊断；本机该路径可用 | 不同用户名、权限/杀毒软件策略的干净机矩阵 |
| 外部 | GPU/真实ASR/Vision/数字人/付费模型及真实平台发布均未执行 | 账户、费用及审批边界明确后的独立真实环境验收 |

可准备面向 `integration/contentos-foundation-v2` 的审查分支。是否达到合并条件以最终本地/远端门禁及上述预算/边界债务的审查决定为准；不自动合并main，不把本轮8项完成等同所有P0/P1生产问题清零。
