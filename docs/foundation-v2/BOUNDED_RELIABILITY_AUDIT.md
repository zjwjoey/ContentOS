# Phase0 bounded Job / Video / Intelligence audit

审计日期：2026-10-08。源码锚点：`c1e528b8527ab349bab15a6cbc1ebbeb6ce984f3`，与基线 `27d43854f0571d127bb1ed4ac01334ff294409b2` 的业务代码一致。本轮只更新文档，不修改 runtime、测试、业务、数据库迁移或网络权限。

## 范围与证据等级

实际阅读 JobService/JobRunner（claim、idempotent creation、heartbeat、success/fail/defer、attempt fence、cancel、lease reconciliation）、Media Intelligence worker handler/runtime、MediaIntelligenceService、IntelligentPlanningService 主要入口、Video worker 的渲染开始/最终提交/取消、VideoService 的依赖与部分 Asset 访问、Hybrid cache、相关架构/Job/Asset 文档和下列测试。其他 workers 只检索恢复/取消调用位置，未逐个验证其全部业务流程。没有完成全仓 SQL、全部 Worker 或所有 provider 的审计。

- `confirmedbug`：源码路径足以确认守卫/状态传播缺口；本轮没有真实 PostgreSQL 复现，不代表已经观测到生产事故。
- `techdebt`：已确认实现与边界规则不一致，但未证明结果损坏。
- `needsdecision`：实现行为明确，但修复目标需要先确定兼容策略，不能自动当成缺陷改动。

仅实跑已有离线 focused tests：

```bash
./node_modules/.bin/tsx --test --test-concurrency=1 tests/worker/media-intelligence-worker.test.ts tests/unit/video-handler-idempotency.test.ts
```

PASS **3/3**：Media worker polling/completion/restart/cancellation mock 一项，Video completed-render idempotency/start-rejected 两项。未运行 DB suites，没有 reset 数据库。相关 DB 测试存在但本轮仅阅读；其成功不能由离线 mock 推导。原 Runtime container 对照证据保留于 [RUNTIME_PROCESS_TREE_EVIDENCE.md](RUNTIME_PROCESS_TREE_EVIDENCE.md)，不能称全 CI pass。GitHub API 受阻动作没有重试。

## 最多五个独立工程任务

| ID | 类型 | 优先级 | 最小目标 |
| --- | --- | --- | --- |
| FV2-A01 | confirmedbug（源码确认，DB 待复现） | P1 / 建议先做 | claim 在持锁时复核 RETRY_WAIT 的 retry_at |
| FV2-A02 | confirmedbug（attempt 隔离缺口，竞态待 DB 复现） | P1 | 分析域结果写入复用已有 Job attempt fence |
| FV2-A03 | confirmedbug（服务取消场景，DB 待复现） | P1 | 未开始分析的取消同步至域状态 |
| FV2-A04 | needsdecision | P1 | 明确 lease expiry 的失败预算，保留 defer 语义 |
| FV2-A05 | techdebt；Asset mutation 语义需 review | P1 | 只移除 Hybrid cache 的直接 assets 写入，并确定后续读端口范围 |

### FV2-A01 — Claim 的重试时间守卫

**源码证据：** `packages/modules/job/src/job-service.ts:108` / `:110` 的 listRunnable 检查 retry_at；`:114` / `:118` 的 claim 持行锁，但 `:120` 只检查状态、`:121` 只检查 scheduled_at，没有检查 retry_at。`:185` / `:198` 的 defer 会写未来 retry_at；`:177` 的 fail 也会写延迟。

**触发条件：** 直接调用 JobRunner.run/claim 一个未来 retry_at 的 RETRY_WAIT Job；或两个 consumers 都持有旧 runnable ID，一个 attempt 完成后改为未来 RETRY_WAIT，另一个随后 claim 同一 ID。后者不能依赖早先 listRunnable 的过滤，锁内看到的新状态必须再次满足时间条件。现代码能提前开始下一 attempt。

**现有测试与缺口：** `tests/integration/job.test.ts:270` 标题提到 retry readiness，实际只断言类型过滤；`:49` / `:66` 的重试/defer 测试先显式 requeue，不覆盖未来 retry_at 直接 claim 或旧 runnable 列表竞态。

**最小 scope：** 只在现有 JobService.claim 持锁路径复用既有 eligibility 规则，保留 QUEUED 和显式 requeue 行为；不添加抽象、queue 或 migration。补现有 Job integration 文件中的到期/未到期及 stale-consumer 回归。

**验收：** 未到期 claim 返回 null，attempt_count/history/events 不增加；到期仅一个 concurrent claim 成功；显式 requeue、原成功/重试/defer 测试仍通过。真实 DB 验收仅用隔离 contentos_test，所有六项正常 CI 仍需通过。

### FV2-A02 — Media Analysis 域写入缺少 attempt 隔离

**源码证据：** `workers/media-intelligence-worker/src/handler.ts:15` 接收 `_attemptId` 但不使用，`:20` 只传 runId/signal。`packages/modules/intelligence/src/media-intelligence-service.ts:127` 将域 run 设为 RUNNING，`:133` / `:138` / `:150` / `:162` / `:205` 按 runId 进行 upsert，`:167` success 与 `:171` catch 写状态均无当前 Job attempt 判定。JobRunner 的 heartbeat abort（`packages/modules/job/src/job-service.ts:374`）及 Job 最终 succeed 的防旧 attempt 守卫只能保护 Job 表，无法撤回已提交的分析域 SQL。

**触发条件：** attempt A 过期并被 reconcile，B 接手同一 run；A 的慢 provider 返回或取消 catch 与 B 的域写入交错。A 可以在 technical/shots 返回后继续写入；A 的 catch 可把 B 已写 SUCCEEDED 的 run 再写 CANCELLED/FAILED。signal 检查不等于持锁 attempt fence，SQL 提交与 signal/heartbeat 之间仍有竞态窗口。此域写入隔离缺口已从代码确认；未实跑 DB interleaving，不声称发生过事故。

**现有测试与缺口：** `tests/worker/media-intelligence-worker.test.ts:10` 使用 analyzeRun mock 且 heartbeat 固定 ACTIVE；`tests/integration/intelligent-analysis-closure-v15.test.ts:25` 覆盖串行 retry/ASR/VISION/keyframe cancel；`tests/integration/job.test.ts:220` 只保护 Job result。没有旧分析 attempt 在新 attempt 后迟到的域结果断言。Video 已有可复用参考：`workers/video-worker/src/video-handler.ts:383` 与 `:401` 通过现有 withCurrentAttemptFence / succeedWithCurrentAttempt 调用模块方法。

**最小 scope：** 仅 MEDIA_ANALYSIS handler 与 Intelligence 的域写入入口，复用 JobService 的当前 attempt/scope；provider 调用放在短事务外，不在外部调用期间持有 Job 行锁或另开连接造成 pool starvation。不发明新 workflow engine、attempt 表或 migration。以 deferred fake provider 制造一条真实 DB 竞态；输出文件副作用在此任务中仅核对 fence 必需范围，超出则另行限定 scope。

**验收：** A 过期后所有迟到提交及 catch 不改变 B 的域状态/有效结果，正常 retry、active cancellation 与 no-speech 保持可用；最终 Job 与 run 一致；小连接池不死锁；原 immutable manifest/模块 ownership 不变。涉及应用端口调整需架构 review，不能让 Intelligence 自行查询 Job 私有表实现新 fence。

### FV2-A03 — QUEUED 分析的取消状态没有传播

**源码证据：** `packages/modules/job/src/job-service.ts:219` / `:220` 对 QUEUED/RETRY_WAIT 直接写 CANCELLED；`packages/modules/intelligence/src/media-intelligence-service.ts:99` / `:107` 的 reconcileStaleRuns 只选 `r.status='RUNNING'`。`workers/media-intelligence-worker/src/main.ts:31` 的租约取消 callback 只收到 expired RUNNING/CANCEL_REQUESTED Job；`:40` 的 polling 不会取已 CANCELLED Job。

**触发条件：** run 为 QUEUED，已通过 attachJob 关联 MEDIA_ANALYSIS Job，业务调用 JobService.requestCancel(jobId) 后，在任何 handler 开始之前运行 worker/reconciliation。Job 已 CANCELLED，run 仍 QUEUED，现有两个恢复入口都不会修正它。这是现有服务合同路径；未发现单独的公开 Media Analysis cancel HTTP route，不声称该 UI 操作已暴露。Video 的 cancel route 会检查 VIDEO_RENDER 类型，不能据此推导能取消 Media Analysis。

**现有测试与缺口：** `tests/worker/media-intelligence-worker.test.ts:25` 从 CANCEL_REQUESTED 起步并 mock markCancelled；没有真实 QUEUED run + CANCELLED Job 对照。分析 closure cancellation 测试在 provider 执行中 abort，不覆盖未开始时的取消。

**最小 scope：** 在现有 Intelligence reconciliation/application coordination 中让已关联未开始 run 接收 terminal Job cancellation；不新增取消产品入口、不取消已成功分析。复用 Job published 查询能力，避免继续增加跨模块私表 SQL。若需新查询端口，限定字段和所有者并 review；不是新平台功能。

**验收：** QUEUED linked run 的取消最终成为 CANCELLED，有 finished_at/稳定错误码，provider 不被调用；重复 reconcile 幂等；无关联 run 与 SUCCEEDED/STALE 不被改写；active lease cancellation 仍通过。真实 contentos_test 场景必须复现和验证，离线 mock pass 不代替该证据。

### FV2-A04 — Lease expiry 是否消耗失败预算需要决策

**源码证据：** `packages/modules/job/src/job-service.ts:174` 的正常 fail 使用 max_attempts；`:332` / `:349` / `:350` 的 expired RUNNING lease 恢复无论 attempt_count/max_attempts 都写 RETRY_WAIT；`:122` 的下一次 claim 继续累加 attempt_count。`:185` 的 defer 也不终结，且 `tests/integration/job.test.ts:66` 明确要求 external pending defer 不消耗 terminal retry budget。

**触发条件：** 普通渲染/分析 worker 在每次 claim 后崩溃且无成功 heartbeat/完成，reconciliation 可以不断重新投递，次数超过 maxAttempts。此行为确认；但文档没有明确将 lease expiry 与 defer/人工重试的预算关系定死，不能简单给所有 claim 加 attempt_count cap，否则会破坏现有 remote pending 合同。

**现有测试与缺口：** Job tests 覆盖一次 lease recovery、poisoned cancellation 隔离和 defer；未覆盖连续普通崩溃超预算后应何种状态，未区分累计 attempts 与可计费/可失败次数。

**最小 scope：** 先为普通 lease loss 写明已有字段下的 retry/terminal 策略与一组状态表，说明 defer 和显式 requeueTerminal 的兼容性；ADR/review 若改变冻结 invariant。后续实现只限 JobService recovery 与其 focused tests，不改 migration，不重置 attempt history，不顺便变更所有 worker。

**验收：** 批准后的策略对 N 次 lease loss 给出有界或明确例外的状态结果；事件可追溯；defer maxAttempts=1 的既有 test 保持成功；cancel/poisoned recovery 不受影响。决策前不提交自动 terminal 行为。

### FV2-A05 — 私有表边界：优先限制 Hybrid cache 的 Asset 写入

**源码证据：** `packages/modules/video/src/hybrid-media.ts:150` 的 cache-hit 分支直接 join assets 并 `update assets set metadata=$2`，未通过 Asset 模块 application contract；随后直接维护 workspace association。`AGENTS.md:6` 禁止跨读写私表，`docs/architecture/ARCHITECTURE_INVARIANTS.md:7` 要求跨模块写走 contract；`:15` 的 canonical Asset immutability 使 metadata 可变范围需要 review，不能自行认定全部 metadata 可写。

**触发条件：** 相同外部 provider/asset/file 再次命中已缓存 READY Asset 且 storage object 存在；Video 修改 Asset metadata。确认边界技术债，不声称 media bytes/checksum 已损坏。新 import 分支 `:154` 已复用 AssetService.importFile，说明无需新 Asset 平台。

**现有测试与缺口：** `tests/unit/hybrid-media.test.ts` 主要是 ranking/provider/local-short-media/timeout；未验证 cache-hit metadata mutation 必须通过 Asset owner 或重复绑定的合同。部分已有 DB/end-to-end hybrid test 不提供 SQL ownership 断言。

**最小 scope：** 只针对 cache-hit metadata mutation，先确定 Asset 元数据/provenance 的允许变化并 review，再复用/小幅扩展 AssetService owner 方法；workspace association 保留 Video owner，不要让 Asset 为了方便获得更多 Video 表写权。不移动模块、不改变数据库、external cache key、媒体 checksum 或导出结果。批量跨读移除单独排后续，不能在这个任务内重构全部读取。

**验收：** Video cache-hit 不再直接写 assets；第一次 import 和重复命中输出/去重保持兼容；Asset owner 的校验与幂等方法有 focused regression；source checksum/storage key/media bytes 不因 reuse 改变；字段级 mutation 范围在 review 中明确。不是用一层通用 SQL helper 掩盖跨模块表权限。

## 已观察的表访问地图（不是额外任务清单）

| 调用位置 | 直接访问 / 合同 | 所有权观察 |
| --- | --- | --- |
| intelligence/media-intelligence-service.ts:79, :113, :212 | assets/project_assets | Asset reads 越过模块 contract；已有 AssetCatalogService.getProjectAsset（asset-catalog-service.ts:67）可作为后续复用起点，必须保留 READY/归属/checksum 语义 |
| intelligence/media-intelligence-service.ts:106 | from jobs | Job 私表直接读；A02/A03 必须避免继续复制 Job state machine |
| intelligence/intelligent-planning-service.ts:29, :34, :92 | assets/project_assets | Planner 的 Asset reads 仍直接 SQL，不等于契约审计通过 |
| intelligence/intelligent-planning-service.ts:53, :55 | VideoService.createManifestRevisionWithExecutor / createManifestRenderJobWithExecutor | 使用 Video owner 方法与同一 transaction executor，保留此复用方式 |
| video/hybrid-media.ts:150 | assets read/write | A05 优先写边界；external_media_assets 的 ownership 此轮未最终裁定 |
| video/standalone-quick-edit-service.ts:52, :56; video/script-editing-v3-service.ts:458 | assets reads | 已确认直接查询位置；不在本轮搬移 |
| workers/video-worker/src/video-handler.ts:401–403 | Job fence → AssetService.commitPrepared → VideoService.completeRender | 已有可用的短事务 fence/模块 owner 例子，不代表整个 Video Worker 无其他边界债 |

## 下一项最小工程建议

先做 **FV2-A01**：单一 JobService.claim eligibility 缺口，已有测试位置，兼容风险相对可控，预计不需要 schema/业务重构。限定一个功能提交及隔离 contentos_test 回归，恢复 API 后读真实 CI；不要在同一任务捆绑 budget 策略或全部 Intelligence fence 改造。A02 为后续高优先级可靠性任务，先用现有 fake provider 与真实隔离 DB 固定竞态验收。

本轮没有创建新 Issues/PR 或读取 Actions；权限/传输原因仍按已记录范围待用户处理。源码确认缺口不等于本轮修复；所有五项均保持 OPEN，最多两项并行，当前仍一个 writer。
