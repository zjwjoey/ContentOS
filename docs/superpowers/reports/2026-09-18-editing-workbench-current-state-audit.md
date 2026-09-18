# ContentOS 独立剪辑工作台：当前状态审计

## 基线

- 当前分支基于 `main`，本地 HEAD：`42c9b2f1eb80fddf63bef67dd8932ec448cabcd9`。
- 本次尝试执行 `git fetch --all --prune` / `git pull --ff-only` 时 GitHub 网络不可达；本地 `main` 与已配置的 `origin/main` 已一致。

## 现有用户流程

- 根页面是 Content Project 创建与项目列表，导航只有项目中心、内容计划、设置和兼容入口“快速剪辑”。
- `/video/quick-edit` 当前重定向到 `/`；项目内 `/projects/:id/video` 承载三步式脚本、素材、生成与审核工作流。
- 项目内工作流直接暴露模板、素材扫描、Manifest 版本、渲染任务等概念；没有独立的剪辑首页、脚本剪辑、批量混剪或历史路由。

## API 与底层能力

- `apps/api/src/video-routes.ts` 已有句子预览、Project montage plan、Standalone Quick Edit session、主配音、计划、调整、渲染、素材上传、Preset 和本地素材扫描接口。
- `StandaloneQuickEditService` 已使用 `video_workspaces(type=STANDALONE)`、`video_quick_edit_sessions`、`video_workspace_assets`、Manifest、Job 和现有 Video Worker；它目前只接受 READY 的全局 Asset ID。
- Project montage plan 已支持 `SCRIPT` / `RANDOM`、本地扫描、素材使用次数、Intro/Outro、Manifest 来源元数据和 FFmpeg Render。
- 本地素材服务支持授权根目录、递归扫描、FFprobe 元数据、缩略图、索引、使用次数和来源隔离，但数据库扫描记录当前强制绑定 Project。
- Video Worker 已处理 `VIDEO_RENDER` 与 `LOCAL_MEDIA_SCAN`，渲染后继续 Promotion 为内部 Asset；尚无外部输出目录导出步骤。

## 数据模型

- 已有 `video_workspaces`、`video_quick_edit_sessions`、`video_workspace_assets`、`edit_manifests`、`renders`、`jobs`、`asset_imports`、`local_media_scans` 和 `local_media_index`。
- 已有 Manifest 来源追踪和项目历史隔离回归测试；不得破坏品牌 Intro/Outro 不进入 CONTENT 候选池的 invariant。
- 尚无批次/批次条目/外部导出记录，也没有多 source root 快照模型。

## 当前缺口与风险

1. 独立剪辑 UI 缺少；用户必须先进入 Project。
2. Standalone session 不支持脚本、多个本地素材目录、文本/音频配对、输出目录或批次。
3. 本地扫描 API 要求 Project，且 `LocalMediaSourceService` 的 `getScan/getLatestScan/getFile` 过滤条件以 Project 为边界。
4. 没有服务器端输出目录授权、原子导出、重名策略或导出失败事实记录。
5. 没有批量任务的持久化父子状态、失败重试或“生成 1 条测试”。
6. 旧 UI 可保留兼容，但新的一级“剪辑”应成为普通用户入口；工程词汇只留在内部 API/日志。

## 可直接复用

- 句子分段、SCRIPT/RANDOM montage planner、Preset、品牌素材解析、Manifest/Revision、Job/Worker、FFmpeg/FFprobe、内部 Asset Promotion、现有 Quick Edit 调整能力和回归测试。

## 需要扩展

- 独立工作台 session 的 source root 快照、脚本/音频任务、Batch/BatchItem、Export 记录。
- Project 无关的本地扫描边界、独立 planner 入口、输出路径授权和安全文件名/原子复制。
- Web 路由 `/edit`、`/edit/script`、`/edit/mix`、`/edit/history` 及简化中文状态展示。

## 运行限制

- 当前是 Web + API + Worker 本地部署；路径验证发生在 API/Worker 主机，浏览器只提交文本路径。
- 目录必须命中 `CONTENTOS_LOCAL_MEDIA_ROOTS` / 输出授权根配置；不会伪造 Windows Explorer 打开能力。
