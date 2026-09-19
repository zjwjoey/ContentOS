# Editing Presentation V1 设计规格

## 目标

让 Script 与 MIX 共用一份可持久化、可编译、可回放的展示设置，同时提供确定性的文案清洗与可确认分段。

## 合同

`PresentationSettingsV1` 包含 `schemaVersion`、`canvas`、`subtitleStyle` 和 `segmentation`。画布使用 9:16、16:9、1:1 三种比例，分辨率必须为正偶数，`fitMode` 为 FILL、CONTAIN 或 BLUR_BACKGROUND。字幕位置使用 0..1 归一化坐标，动画只允许 NONE、FADE_IN、FADE_OUT、FADE_IN_OUT、SLIDE_UP。

## 数据流

原始文案 → 确定性清洗 → 用户确认 segments → Script/MIX 计划 → `applyPresentationSettings` → 旧 Manifest 兼容的 V0 manifest → FFmpeg renderer。

## 兼容

缺少 presentation 字段的旧记录使用 9:16、1080x1920、30fps、FILL 和底部白字默认值；旧的 `subtitles` cue 仍然保留，新的 style 作为额外元数据编译。

## 验收

覆盖清洗保护（URL、数字、小数、A/B、H.264、破折号）、段落编辑操作、三种比例/三种适配模式、字幕样式字段、历史复制和旧 Manifest 校验，并通过类型检查、单元测试和浏览器验收。
