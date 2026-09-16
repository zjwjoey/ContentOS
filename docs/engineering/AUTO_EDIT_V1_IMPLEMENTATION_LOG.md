# ContentOS 自动剪辑 V1 开发日志

## 开发前审查（2026-09-16）

当前仓库已经具备项目级 Video 与独立 Quick Edit 两条稳定的底层路径：`VideoService` 负责创建 Durable `VIDEO_RENDER` Job，`Video Worker` 负责计划 Manifest、调用 FFmpeg、提交输出并执行 attempt fencing；`VideoAdjustmentService` 已实现 TRIM、REMOVE、REORDER、REPLACE、REROLL 和版本历史；Asset Catalog 已提供项目/工作区 READY 素材查询，Director V1 已提供 Script 与 Storyboard 版本及审批前置条件。现有 `EDIT_MANIFEST_V0`、渲染器、取消、幂等和历史版本能力继续复用。

现状缺口主要在产品层：规划器按目标时长生成 Clip，尚未提供统一的“Sentence → Scene → Clip”模型；没有可复用的稳健拆句器；Standalone Quick Edit 页面仍暴露开发者术语；项目 Video 页面只有底层渲染输入，没有两个面向运营人员的剪辑入口；本地素材目录没有受授权根目录保护的扫描服务。

## 本轮方案

1. 在 `packages/modules/video` 增加统一拆句器、按脚本匹配规划器和按句随机规划器；两者输出兼容 `EDIT_MANIFEST_V0`，在 Clip 可选元数据中保存 sentenceIndex、sentenceText、sceneId 与可解释匹配信息。
2. 扩展 Manifest 的可选 provenance 字段，保持 V0 读取兼容，不改变历史 Manifest 的必填结构。
3. 增加本地目录 source provider：仅允许 `CONTENTOS_LOCAL_MEDIA_ROOTS` 配置的授权根目录，规范化 Windows 路径、防止目录穿越，扫描只返回相对路径与媒体元数据。
4. 在 API 增加面向 UI 的 sentence preview、脚本/随机方案规划入口；现有项目 Video、Standalone Quick Edit、Render 和 Quick Edit API 保持兼容。
5. 将 Video 相关 UI 收口为“视频剪辑 / 按脚本剪辑 / 随机混剪 / 剪辑方案 / 镜头设置”，统一状态中文映射；Seed 等仅保留在高级设置。
6. 增加 planner、拆句和本地目录安全测试，并执行现有完整验证门。

不引入 AI Vision、Embedding、向量数据库、TTS、BGM、多轨时间线或第二套渲染/任务系统。

## 验收记录

- `POST /api/v1/video/sentence-preview`：中文/英文混合脚本拆句，保护小数、URL、常见缩写和首字母。
- `POST /api/v1/video/local-media/scan`：授权根目录扫描；未授权路径返回 403；扫描结果只返回相对路径和媒体元数据。
- `POST /api/v1/projects/:projectId/video/montage-plans`：SCRIPT/RANDOM 均生成一条句子对应一个 Clip 的 Manifest，并持久化 revision。
- 本地样片已由 Video Worker + FFmpeg 完成真实渲染，输出为 1080×1920 H.264 MP4；TRIM 调整后再次渲染成功。
- 浏览器端已验证中文入口、拆句预览、随机文件夹扫描和随机方案生成。
- 质量门禁：完整回归 `234/234`；V1 专项 `6/6`；format、lint、typecheck、build、doctor 全部通过。

## 已知边界

- 本地目录只支持视频文件；音频仍沿用已有 Asset Import/Workspace 路径。
- 语义匹配当前为确定性的文件名、标签和元数据关键词匹配，不包含 Vision/Embedding。
- 生产部署仍需将 `CONTENTOS_LOCAL_MEDIA_ROOTS` 配置为明确的授权目录，并将 API、Video Worker、Web 作为独立进程托管。
