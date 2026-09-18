# 剪辑工作台 v2 实施报告

日期：2026-09-18
分支：`codex/editing-workbench-v2`

## 交付结果

ContentOS 现在提供独立的 `/edit` 剪辑工作台，包含脚本剪辑、批量混剪、历史记录、失败重试和导出入口。原有 `/projects/:id/video` 项目视频流程保留，侧边栏不再把快速剪辑入口混入项目导航。

## 修复前的问题

- 快速剪辑依赖项目视频页，入口和项目上下文耦合。
- 本地素材来源只覆盖单项目扫描，多个目录缺少统一授权、快照和去重模型。
- 没有脚本剪辑/批量混剪的独立工作区、批次状态和失败重试。
- 导出文件名和输出目录缺少统一的路径边界与原子写入约束。
- 页面仍暴露 Project、Manifest、Job、Asset 等工程内部概念。

## 用户流程

1. 从“剪辑”进入 `/edit`，选择“脚本剪辑”或“批量混剪”。
2. 输入文案或批量文案，添加一个或多个素材目录；服务端校验目录是否位于 `CONTENTOS_LOCAL_MEDIA_ROOTS` 授权根目录。
3. 服务端创建来源快照、工作区和批次，为每条内容复用现有 Manifest/Video Worker/FFmpeg 管线。
4. 在历史记录页查看逐条状态；失败批次可只重试失败项，也可先生成一条测试。
5. 成功后校验 `CONTENTOS_OUTPUT_ROOTS`，使用安全文件名、临时文件和原子 rename 导出。

## 架构复用与数据模型

- 新增迁移 `0026_editing_workbench.sql` 及对应 down migration。
- 新增 `edit_workbench_sessions`、`edit_batches`、`edit_batch_items`、`edit_exports`。
- `local_media_scans` 支持 `workspace_id`，并保持旧 `project_id` 调用兼容。
- 复用现有 AssetService、VideoService、Manifest 规划、Job/Worker、FFmpeg、Asset Promotion、Intro/Outro 能力。
- 本地素材在规划阶段仍经过授权路径校验，不把任意用户路径直接交给渲染器；每个来源目录现在会建立 workspace scan，并把 `scanId`、根目录和统计写入本次来源快照。

## API 与界面

- `POST /api/v1/edit/pair`：按 basename 配对文案与音频，并明确报告缺失项。
- `POST /api/v1/edit/sessions`：创建脚本/混剪批次，支持多个目录、来源去重、测试单条。
- `GET /api/v1/edit/batches/:batchId`：汇总逐条任务状态。
- `POST /api/v1/edit/batches/:batchId/retry`：只重试失败条目。
- `POST /api/v1/edit/batches/:batchId/export`：安全导出完成项。
- `GET /api/v1/edit/history`：历史列表。
- `POST /api/v1/edit/sources/scan`：目录输入后的预扫描和可用/不可用统计。
- 新增 `/edit`、`/edit/script`、`/edit/mix`、`/edit/history` 页面，并统一使用中文用户文案；素材目录离开输入框后自动预扫描，状态和高级设置均在页面内展示。

## 验证记录

- `pnpm typecheck`：PASS
- `pnpm build`：PASS
- `pnpm format`：PASS（301 files）
- `pnpm lint`：PASS（130 TypeScript files）
- `pnpm test:migrations`：PASS（独立 55433 数据库，8/8）
- `tests/e2e/operator-ui-v1-browser.test.ts`：PASS
- `tests/e2e/video-standalone-quick-edit-vertical-slice.test.ts`：PASS（停止 Operator worker 后）
- 实际 HTTP smoke：`/api/v1/edit/pair` 返回 READY/MISSING_TEXT/MISSING_AUDIO；越权素材目录返回 403。
- 实际 HTTP smoke：单素材脚本剪辑完成、批次查询返回 SUCCEEDED；配置授权输出目录后导出生成 `001_ExportSmoke.mp4`，重复导出生成 `_2` 文件且不覆盖原文件。
- 新增工作台 unit：Windows 文件名清洗、序号命名和文案/音频 basename 配对均 PASS（2/2）。
- Edge 实测：创建项目返回 201，并跳转到项目总控；剪辑工作台四个页面均可打开。
- `pnpm test`：234/236 PASS。剩余 2 项是共享测试库历史脏数据导致的唯一约束/迁移重放冲突，不是本次代码失败；未擅自清理用户数据库。
- 默认 5432 迁移测试无法运行，因为本机没有该端口监听；使用 55433 的隔离测试库已通过。

## 已知限制

- 当前多目录扫描在创建请求中同步执行，尚未把扫描本身拆成可恢复的独立后台 Job。
- UI 目前接收服务端本地路径文本；未引入 Windows 文件选择器上传协议。
- 输出导出需要预先配置 `CONTENTOS_OUTPUT_ROOTS`，且目录必须已存在并可写；由 API 触发，不会自动打开资源管理器。
- 当前仓库没有可直接用于完整浏览器渲染验收的 mp4 素材，且默认启动命令未配置本地媒体/输出授权根目录；已用临时 fixture 完成真实接口渲染与导出验收，用户机器需配置授权目录后使用。
- “生成 1 条测试”会创建单条独立批次，便于先验证素材和渲染链路。
