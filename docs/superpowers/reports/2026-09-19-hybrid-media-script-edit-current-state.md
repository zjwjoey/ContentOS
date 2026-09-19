# Hybrid Media Script Editing V1：当前状态

## 已具备能力

- `/edit/script` 已支持脚本文案、授权本地素材目录扫描、模板、配音和可恢复的 `EDIT_PREPARE_ITEM` 任务。
- `LocalMediaSourceService` 已输出视频时长、画幅、标签、使用次数和安全的绝对路径，适合作为本地检索器。
- 工作台渲染链路已经具备幂等、重试、批次状态修复和导出能力。

## 缺口

- 没有结构化 VisualPlan，也没有实体保护规则。
- 没有外部视频提供商抽象、Pexels 官方 API 适配器、搜索/下载缓存和 SSRF 校验。
- API、Worker、脚本页面、设置页没有“本地优先 + Pexels 兜底”的端到端协议。

## 本次实现边界

新功能只在 `codex/hybrid-media-script-editing-v1` 分支实现，范围限定为 `/edit/script` 的 SCRIPT 模式；MIX 与既有 workbench 分支不改变。外部密钥只从服务端 `PEXELS_API_KEY` 读取，浏览器永不接触密钥。
