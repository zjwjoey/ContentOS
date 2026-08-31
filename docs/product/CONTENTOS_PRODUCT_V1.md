# ContentOS Product V1

## 产品目标

ContentOS V1 是以 Content Project 为中心的浏览器生产工作台。普通用户可以从项目、Director、Benchmark、素材、Storyboard、Video、Approval、Publisher 到 Review 完成一条可追踪的生产链路；长耗时操作统一进入 Durable Job。

## 功能地图

| 区域 | V1 能力 |
| --- | --- |
| Project Center | 创建、搜索、状态/日期筛选、项目资料、阶段状态、下一步、Jobs、错误和人工处理提示 |
| Content Plan | 以项目 metadata 承载 planned date/topic/platform/account 的列表筛选 |
| Director | ContentBrief、AI/手工 Script Revision、Storyboard Scene、历史版本、精确审批 |
| Benchmark | 人工账号/内容录入、结构化 AI 分析、项目引用为 Director Reference |
| Assets | 多文件视频/音频上传、READY/FAILED、预览、标签、类型和标签筛选 |
| Video | Random 或 Storyboard Planner、可解释匹配、EDIT_MANIFEST_V0、TRIM/REMOVE/REORDER/REPLACE/REROLL、历史 Manifest、真实 FFmpeg Render |
| Approval | Script、Storyboard、Render、Publish 均绑定 entity 与具体 revision，可批准/驳回并记录理由 |
| Publisher | Fake 账号、发布 Revision（标题/描述/hashtags/可选封面/排期）、Attempt、ExternalPost、重试/人工处理/RECONCILING 状态；真实 Adapter 仅在显式开关、账号验证和人工确认后可用 |
| Review | append-only Metric Snapshot、历史趋势、Fake/Import 采集、AI Review 报告和 AI Run 证据 |
| Settings/Dashboard | 真实项目/Job 数据和安全的 AI、Publisher、PostgreSQL、FFmpeg、Worker 状态 |

## 安全和边界

PostgreSQL 是业务真相；Job 表只承担投递状态。浏览器不接触私有表、Storage Path、密钥、Cookie 或 Token。Fake Provider/Publisher 是无凭证环境的默认路径；真实 AI 由环境变量配置，真实平台最终发布仍需人工授权。

## V1 不包含

AI Vision、Embedding、向量库、大规模平台抓取、多轨编辑器、Canvas/WebGL、Waveform、Voice Cloning、TTS 必选链路、Remotion 主渲染迁移、微服务/Kubernetes、多租户、权限系统、复杂 BI、A/B Testing、自动热搜/竞品监控和自动不可逆真实发布。
