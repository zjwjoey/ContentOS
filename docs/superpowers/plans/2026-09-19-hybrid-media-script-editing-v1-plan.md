# Hybrid Media Script Editing V1 实施计划

1. 添加 `VisualPlanV1`、实体保护、查询去重和本地排序模块。
2. 添加 `ExternalVideoProvider`、Pexels adapter、Fake provider、缓存/下载安全策略。
3. 将 hybrid retrieval 接入 `EDIT_PREPARE_ITEM`，保留现有幂等和重试语义。
4. 增加媒体 provider API、脚本页开关、设置页连通性测试和任务诊断。
5. 添加 migration、单元/集成/浏览器测试，运行类型检查、lint、format、构建和全量测试。
6. 更新部署文档与 `.env.example`，提交并推送 `codex/hybrid-media-script-editing-v1`；不合并 main。
