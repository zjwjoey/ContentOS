# Script Editing V2 — Rule-Based Editorial Layer 设计

## 目标

输入 `TimedScriptSentence[]`，按确定性规则生成 `EditorialPlanV1`，解析为 `ResolvedEditorialPlanV1`，再编译为现有 `EDIT_MANIFEST_V0` 扩展。V2 不调用任何 AI 服务；V1 Hybrid 和 MIX 路径原样保留。

## 数据流

`TimedScriptSentence[] → EditorialPlanV1 → ScenePlanV1 → ClipSlotV1 → Hybrid resolve → ResolvedEditorialPlanV1 → manifest → renderer`

每句对应一个 scene，顺序严格保留；每个 scene 1–3 个 clip。语音存在时句子时间是唯一真相，所有 scene/clip/subtitle 由该时间派生；无语音沿用 V1 duration 计算。帧化仅允许末尾产生一个 1-frame rounding 差异。

## 规则

角色优先级为 HOOK（首句）、ENDING（末句）、AUTHENTIC_ENTITY（已知品牌/地点/产品实体）、TURN（但是/不过/然而/问题是/实际上/所以）、EVIDENCE（例如/比如/数据显示/%/€/销售额/门店数）、CTA（欢迎/关注/评论/联系我们/到店/期待/Te esperamos），否则 BODY。节奏 SLOW/NORMAL/FAST 的目标片长分别为 4–6/2.5–4/1.5–3 秒；scene clip 数按时长计算并限制 1–3，HOOK 增密、AUTHENTIC_ENTITY 减密、ENDING 低密、EVIDENCE 1–2。

## 输出扩展

Manifest 增加 sentence-level subtitles、Hero Text overlays、backgroundMusic（本地授权路径、volume、ducking）。renderer 保持旧字段兼容，并支持 30fps、9:16、多 clip、voice/BGM 混音、字幕与文字的时间窗口。

## API/持久化

`/api/v1/edit/script-plans` 创建/读取/换片/锁定/渲染；创建与规划分离，计划和 revision 存于 0029 的 JSONB 记录。渲染只接受 READY 方案并使用 immutable resolved snapshot，绝不重新排序或重新抽取素材。

## 安全与验收

素材、音频和音乐必须 realpath 且位于 `CONTENTOS_LOCAL_MEDIA_ROOTS`/`CONTENTOS_MUSIC_ROOTS`；字幕文本经过 drawtext escape。MIX 保持严格 unique。门禁包含 V1 全套测试、V2 planner/renderer/API/browser 测试及迁移、typecheck、build、doctor、git diff --check。
