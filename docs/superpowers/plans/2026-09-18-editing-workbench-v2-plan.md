# 独立剪辑工作台 v2 实施计划

1. 新增迁移：工作台 session、Batch、BatchItem、Export，以及允许 standalone workspace 的本地扫描。
2. 扩展本地素材服务：workspace 边界、多 source root 快照与去重合并；保留现有 Project API 行为。
3. 增加工作台领域服务/API：预检、扫描目录、创建脚本/批量任务、生成测试项、查询进度、失败重试、历史和复制。
4. 增加外部导出安全服务：授权输出根、清洗命名、原子 rename、幂等和导出失败记录。
5. 增加 `/edit`、`/edit/script`、`/edit/mix`、`/edit/history`，左侧一级导航改为“剪辑”。
6. 复用现有 planner、Manifest、Job、Video Worker、Asset Promotion、Preset、Intro/Outro；不在 Web 直接调用 FFmpeg。
7. 补充 unit、integration、worker、browser 测试，最后执行仓库实际存在的全部 Gate 并记录结果。

## 当前执行顺序

先完成可独立验收的 API/数据模型和简化工作台 UI，再接通批次 Worker 与导出；任何暂未支持的格式或路径能力必须以中文原因返回，不能静默跳过。
