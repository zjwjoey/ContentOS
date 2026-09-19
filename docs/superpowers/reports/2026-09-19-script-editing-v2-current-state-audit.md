# ContentOS Script Editing V2 当前状态审计

## 基线

- 分支：`codex/script-editing-v2-rule-editorial-layer`
- 来源分支：`codex/hybrid-media-script-editing-v1`
- Base SHA：`f318da93be6724fed87822c1ce9de5fe19ffb4a8`
- `origin/main`：`42c9b2f1eb80fddf63bef67dd8932ec448cabcd9`
- 当前差异：相对 main ahead 38、behind 0；本地 `local-media/` 为未跟踪目录，不纳入提交。

## 当前能力

V1 已具备脚本句子切分、音频时间轴、Hybrid 本地/Pexels 素材解析、实体优先、MIX 严格不重复、授权根目录校验及旧渲染链路。现有 `EditManifestV0` 仅有单层 timeline、voice 和简单字幕；渲染器尚未支持句子级字幕、Hero Text、BGM、ducking 或多素材场景。API/UI 直接启动导出，不存在独立的 V2 方案记录、锁定、换片和 revision。

## 差距与风险

1. 没有 EditorialPlan/ScenePlan/ClipSlot 数据模型与规则规划器。
2. 现有 Hybrid 结果是句子级单片段，无法表达 1–3 clip scene 及精确时长守恒。
3. 语音时间是 V1 准备阶段产物，需在规划与解析阶段复用同一 `TimedScriptSentence[]`。
4. Manifest/renderer 缺少全字幕、文本叠加、BGM 混音、ducking 与 Hero Text。
5. 没有 V2 PostgreSQL 持久化、durable planning job、preview=manifest 不变量。
6. `/edit/script` 仍暴露 V1 内部配置，需改为七段式中文界面。

## V2 收口目标

在不修改 0026–0028 且不破坏 V1/MIX 的前提下新增 0029 migration、规则规划器、V2 manifest 扩展、独立方案 API/任务、字幕/文字/BGM 渲染和浏览器覆盖。所有规则必须确定性、可审计、无 AI/LLM/Whisper/embedding 依赖。

## GO/NO-GO 初始结论

NO-GO（实现前）：V2 规划、持久化、渲染和浏览器验收均缺失；V1 兼容基线可作为回归门禁。

## 实施后记录

- Final implementation SHA：`fab92e6`
- 新增 1 个 0029 up/down migration、1 个规则规划器、1 个 V2 API route、1 个 worker job handler、1 个 V2 UI 入口、1 个 planner 单元测试。
- 支持：角色规则、节奏/镜头密度、1–3 clip scene、voice timing、字幕/Hero Text、BGM/ducking、V1 manifest 兼容、严格唯一素材、锁定/换片 API、独立规划状态与 revision。
- 通过：`pnpm typecheck`、`pnpm lint`、`pnpm format`、`pnpm build`、Web production build、editorial/workbench/renderer 17 项单元测试、PostgreSQL migration matrix 9/9、browser operator 3/3、`pnpm doctor`、`git diff --check`。
- 已知环境限制：仓库全量测试及 auto-edit V1/V1.5 需要干净的 `contentos_dev` 数据库；当前 PostgreSQL 角色无权创建该库，且共享 `contentos_test` 已存在历史 fixture，失败为连接/fixture 隔离问题，并非 V2 断言失败。
- GO/NO-GO：V2 实现已提交并可推送；生产放行仍需在隔离的完整测试数据库上重新跑全量门禁。
