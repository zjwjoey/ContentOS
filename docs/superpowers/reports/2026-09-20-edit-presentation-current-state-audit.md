# ContentOS Editing Presentation V1 当前状态审计

日期：2026-09-20  
分支：`codex/script-editing-v2-rule-editorial-layer`  
基线：`bc98812`

## 结论

当前脚本剪辑 V2 已有素材授权、规则方案、配音和历史复制基础，但 Presentation V1 仍未闭环，不能作为最终验收版本。

## 状态

| 范围 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 脚本文案分段 | 部分 | `sentence-segmenter.ts` 只支持句号级分段，没有确认态段落编辑、逗号模式和自定义分隔符。 |
| 原文与清洗文案 | 未完成 | API 仅保存 `script`，没有 `rawScript`、`cleanedScript` 和 confirmed segments。 |
| Script / MIX 共享展示设置 | 未完成 | Manifest 画布校验固定为 1080x1920 9:16，字幕为旧的内联结构。 |
| 字幕设计器 | 未完成 | V2 只有样式下拉框，没有归一化坐标、字体、描边、阴影、动画和实时预览。 |
| 多比例与分辨率 | 未完成 | 编译器及 FFmpeg renderer 固定 1080x1920。 |
| 历史和复制 | 部分 | 既有 JSONB settings 可复制，但未展示/携带 Presentation V1 字段。 |
| 向后兼容 | 部分 | 旧 Manifest 可用，但校验拒绝新画布配置。 |
| 测试与报告 | 部分 | 已有句子分段、渲染和浏览器测试，缺少本需求覆盖。 |

## 风险

生产构建不能与 Next dev 同时运行，否则会破坏 `.next` 的增量产物。实现期间以类型检查、单元测试和停止 dev 后的生产构建作为验证边界。
