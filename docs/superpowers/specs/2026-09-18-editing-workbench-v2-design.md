# 独立剪辑工作台 v2 设计

## 用户流程

`剪辑 → 脚本剪辑/批量混剪 → 文案与音频 → 一个或多个素材文件夹 → 输出文件夹 → 开始剪辑 → 成片`。

页面只显示中文产品语言；Manifest、Job、Asset、sourceRootId 等仅出现在内部实现和诊断中。

## 架构

工作台使用现有 `video_workspaces(type=STANDALONE)`，新增工作台会话与批次记录作为编排层。规划、Manifest、渲染、Asset Promotion 继续走现有 Video/Job/Worker 链路。多目录在会话中保存授权后的 `{sourceRootId,path,scanId}` 快照，候选池按当前快照合并，品牌素材单独注入。

## 数据与任务

- `edit_workbench_sessions`：工作台模式、脚本、source root 快照、输出根、模板和安全命名设置。
- `edit_batches`：一次脚本或批量任务的总体状态、任务数和输出目录。
- `edit_batch_items`：每条文案/音频、状态、Standalone session、Render Job、输出文件和错误。
- `edit_exports`：内部 Asset 到外部 MP4 的原子导出事实，记录路径、状态和错误。

每条 item 独立排队；失败只影响自身。重试只重置失败 item，成功 item 保持不变。

## 路径安全

素材根继续通过 `CONTENTOS_LOCAL_MEDIA_ROOTS` 授权；输出根通过 `CONTENTOS_OUTPUT_ROOTS` 授权。API 使用 `resolve`、根目录包含判断、不跟随符号链接，并在同一文件系统内先写临时文件再 rename。文件名清洗 Windows 保留字符并追加 `_2` 等后缀避免覆盖。

## 兼容性

项目内 Video 与旧 Quick Edit 路由保留。新的独立入口不创建可见 Content Project；内部只使用 standalone workspace。品牌 Intro/Outro 永远不进入 CONTENT 候选池。

## 分阶段实现

第一阶段完成独立脚本/批量表单、目录扫描快照、批次状态、输出授权与 API；第二阶段接入完整批次 Worker/导出与浏览器验收；旧项目流程在每阶段回归。
