# P0/P1 开发进度

2026-10-13跟进：已按用户授权顺序完成C01集成草稿[PR #7](https://github.com/zjwjoey/ContentOS/pull/7)、C02持久连续失租策略/0053、C03各owner恢复及0054共享镜头归属；目标integration/contentos-foundation-v2，不合并main。代码正常push至9fc02af（实现5b18793，后续只修订锁等待测试观测），独立ADR-022审查通过。C04本地验收：失租101/101、full391/391、migration10/10、Intelligence53/53、数字人63/63、Production12/12、closure32/32、Auto Edit28/28及20/20、V3.4 37/37、Runtime27/27、真实host14/14、生产浏览器11/11，均无skip；冻结安装与质量/构建通过。当前源码[PR CI](https://github.com/zjwjoey/ContentOS/actions/runs/38349943709)及[push CI](https://github.com/zjwjoey/ContentOS/actions/runs/38349937000)均6/6 SUCCESS，Windows当前新包安装/卸载/数据保留/clean render/restart及上传完成。C01–C04计划4项、完成4项；后续收尾仅文档，自动新CI不替代上述源码证据。owned临时PG按目录/端口/PID身份正常关闭，数据与原工作区保留。策略、失败修复与剩余边界见[连续崩溃重试验收](CONTINUOUS_CRASH_RETRY_ACCEPTANCE.md)。下文保留2026-10-11历史快照。

2026-10-11。分支 `codex/foundation-v2-p0-p1-hardening`；起点 `9f95f1d`，原工作区未提交素材受保护。

阶段 A 已完成首轮实际审计与隔离。冻结安装、format/lint/typecheck/build、Windows runtime 23/23、desktop manager 2/2、隔离 migration matrix 10/10 通过。首次 focused suite 的 public schema 前置缺失已识别，使用既有安全 reset 脚本在本轮新建测试库初始化后重跑。

| 任务 | 当前状态 |
| --- | --- |
| T01 | VERIFIED：复用 `05a8379` 的最小实现与回归，先红（4个 readiness/并发用例失败）后绿 Job 20/20；Date/string retry_at 保留毫秒精度；无 schema变化；提交 5fcdc3c |
| T02 | VERIFIED：整合 `99d324a` 的 reviewed additive cancellation contract；本机先红 QUEUED→CANCELLED 未传播，再绿组合 33/33（20 Job + 12 cancel + 1 worker）；无 skip；typecheck通过；所有 DB fixtures 使用隔离 schema |
| T03 | VERIFIED：真实隔离DB复现迟到技术结果999覆盖640、迟到异常覆盖SUCCEEDED；已修复全部 Worker analysis写入与终态fence、Job+域结果原子提交、attempt文件路径、同连接恢复/取消；原Intelligence门禁加8项回归 48/48 PASS；无migration，保留离线签名；ADR020 |
| T04 | VERIFIED：新增4项安全测试先红后绿；统一redaction用于logger/shared errors/Job fail+defer/Analysis error和逐行Runtime日志（含跨chunk）；API生成请求correlation并保留400/422；unit 11/11、Job21/21、Runtime23/23、format/lint/typecheck通过；旧Job锁竞态fixture被其他suite残留VIDEO_RENDER前10条挤出，改用独立测试type保护场景，不放宽断言 |
| T05 | VERIFIED：资源8.3路径不可用时使用owned ASCII资源junction，cmd Unicode输出并核验目标身份；生产资源副本增加UTF-8进程声明（ADR021），保留真实数据和upstream文件；本机及英文Windows CI中文+emoji真实SQL/重启2/2，manifest安全/幂等3/3；首次init120秒、普通startup60秒、embedded readiness180秒有界预算；不递归清理junction目标 |
| T06 | VERIFIED：Hybrid命中缓存只建立Video workspace引用，保留Asset元数据及原始downloadedAt/provenance；先红后绿，Hybrid unit+真实FFmpeg integration 22/22无skip；新回归进入原full test；首次下载仍通过AssetService import；既有跨模块Asset只读SQL债务未宣称消除 |
| T07 | VERIFIED：additive项目分析历史Contract/API，limit1–100、created_at/id keyset保留PG微秒、输入校验/项目隔离；Job状态通过owner get读取并检查type/project/run，不直接SQL；UI重载恢复历史/结果，分页、持久Job状态、错误提示与busy finally；API1/1 + DB历史1/1 + Intelligence49/49 + Windows Edge browser1/1 + Web production build通过 |
| T08 | VERIFIED：核心三链组合5/5、full301/301、closure32/32、Intelligence51/51、本机及Linux production browser各11/11；最终UTF8/路径安全5/5、Runtime27/27、真实host14/14及typecheck/build/frozen install完成；617cf71远端CI 38109321696六个job全部SUCCESS，最终installer/portable及安装/卸载/clean render/restart通过，产物上传完成 |

最终代码验收对象 `617cf71f3c024efd26b25a755353ce6feb1d29e7`，之后只提交文档收尾。[最终CI](https://github.com/zjwjoey/ContentOS/actions/runs/38109321696) 6/6整体SUCCESS；计划8项实际完成8项，剩余策略决策/边界债务及真实环境未验收见最终报告。仅正常push独立分支，没有PR/main合并。本轮隔离PG核验owned data/port/PID后正常关闭，测试数据保留；原工作区HEAD与local-media未变。下面过程记录保留先前失败和等待状态，以本表及最终报告为当前结论。

T08交付链补齐：原ContentOS E2E通过Publisher公开post端口接上FAKE指标采集与Review AI Job，报告引用精确post/snapshot并明确模拟；Publisher outcome fixture用显式requeue遵守retry_at。full最终301/301、closure32/32、全部剪辑/数字人/Production gates通过。clean acceptance增加可选unpacked executable保护本机既有安装；真实导入、2份MP4、crash恢复/多次重启/单cluster/无新增残留进程通过。原installer/portable builder成功、两种packaged smoke通过。验收包是较早源码快照；最终源码需远端重新打包，不冒充最终发布产物。

T08生产浏览器发现模板选择时序缺陷：11场景首轮10/11，初始preset GET迟到覆盖手动PUT所选片头。增加选择版本保护；原Auto Edit完整流程加入延迟旧GET的确定性断言，生产构建及focused 1/1通过，不放宽片头/manifest/渲染断言。完整11场景继续复验。

T08分析重试补验：首次attempt在保存ASR/视觉结果后失败，替代attempt返回空数组，旧结果及向量仍出现在SUCCEEDED run（先红）。各stage收到新provider结果后，以现有attempt fence下同一SQL清理旧stage行/向量，替代成功结果不再混入旧片段；不修改其他run或SUCCEEDED缓存。另发现attempt关键帧目录必须传给Qwen视觉adapter，新增内部可选keyframePaths，并由实际生成路径传递，保留离线旧路径回退；adapter Mock先红后绿，无外部API调用。最终Intelligence51/51，无skip，typecheck通过。

T08首轮远端CI：Quality/Build已通过，Windows Runtime的两个中文PG用例spawn ENOENT。英文cmd编码把中文输出转换为ASCII问号，被误判为短名称；修复为cmd /u + UTF-16LE解码并验证realpath为同一目标。原两个用例完整保留，本地2/2（中文真实SQL及restart）、Runtime24/24和typecheck通过，再push复验。额外emoji数据目录实验发现原生PG argv编码限制，仅记录，不计入原中文路径通过范围。

T08两轮Linux浏览器10/11：失败在网络abort后alert刚出现时立即读取搜索按钮disabled状态；React操作finally尚未完成渲染。保留enabled=true及实际搜索score/后续plan/render断言，增加5秒有界等待finally状态完成。focused生产浏览器1/1通过，没有改动产品busy状态或移除失败恢复验收。

T08英文Windows第二轮1/2：资源路径已修复，原生argv/文件API仍丢失中文数据目录。按ADR021在现有Desktop资源准备中为复制的3个PG程序增加UTF-8进程manifest；保留其他资源/声明，拒绝重写带证书的程序，原始依赖hash不变。没有SUBST、系统locale/registry修改或数据迁移。新增固定构建依赖pe-library0.4.1（原已有transitive版本），lock仅增3行importer，冻结重装通过。保留fsync，将首次init默认预算单独设120秒，服务启动60秒不变；embedded client readiness180秒，external60秒和显式deadline保留。中文+emoji资源/数据真实SQL和重启、3项manifest安全/重复执行回归最终5/5；Runtime27/27及typecheck/build通过，真实host门禁继续收尾。前两轮CI Desktop打包、unpacked/portable/installer smoke、卸载保留数据及clean render/restart均成功，但整轮尚不通过；最终源码再次CI后才可宣称全部门禁通过。

T08追加Windows进程身份修复：确定性模拟“owned child已exit但数字PID再次显示alive”，旧实现第二次taskkill（先红2≠1）；修复后不向已exit的owned child旧PID再次kill，原真实进程树关闭和12项host生命周期压测一起16/16通过。生命周期压测对所有已退出child handle做断言，避免将被Windows复用的历史数字PID当成owned进程；保留全部state/lock/restart-budget断言。新回归加入原Runtime gate。

T08历史诊断安全复验：从旧DB error字段读取原始凭证的Job/Analysis回归先红；mapJob/mapRun读取时复用redact，保留数据库原记录、不执行历史数据重写。Job+历史组合22/22通过；Runtime完整24/24、真实host14/14、第二次full301/301已通过。后续新增读取防线仍做最终门禁复验。

隔离 public schema 初始化后原 focused suite 17/17 PASS，无 skip。迁移矩阵的 schema 临时清理不初始化 public；该前置现已按 CI 脚本补齐。

Windows bundled PostgreSQL 中文资源初始化故障已修复；本地2/2通过。中间实验：数据junction被initdb拒绝，因此放弃；30秒试验预算在中文路径刷盘阶段超时，恢复原Runtime默认60秒后完整通过。未移动、迁移或删除已有数据；TEMP无ASCII路径/短名称的环境仍提供明确诊断。运行产物与本地测试 URL 均在 ignored `.test-results/`。现已正常push独立分支，未创建PR，未运行真实平台/付费API/GPU。

T07首次整组的API→Worker一致性用例被之前测试留下的pending Job挤出单次consume范围，实际QUEUED；改为独立schema并保留全部成功断言后，单独2/2和整组49/49通过。浏览器dev与production build曾同时写.next导致ENOENT；停止dev后串行production build成功。以上失败均不计入通过。
