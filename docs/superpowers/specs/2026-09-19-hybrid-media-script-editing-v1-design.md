# Hybrid Media Script Editing V1 设计

## 数据流

创建脚本任务时只保存文案、来源目录快照和 `usePexels` 选择；不在 HTTP 请求中访问外部网络。`EDIT_PREPARE_ITEM` Worker 生成确定性的 VisualPlan，先按实体/关键词检索本地素材，再按段落去重查询 Pexels，下载并导入工作区资产，最后复用现有 manifest/render 链路。

## 关键不变量

1. API key 仅存在于 API/Worker 环境变量。
2. 实体段落没有可信本地素材时，外部通用素材只能作为显式 fallback，并记录诊断，不能伪装为实体素材。
3. 外部 URL 必须 HTTPS、主机在 `videos.pexels.com` allowlist 内、内容类型为 `video/*`，下载有大小和重定向限制。
4. 搜索按 provider/query/orientation/locale/page 缓存；下载按 provider asset/file id 缓存。
5. Provider、Planner、Retriever 均可由 Fake provider 注入，单元测试不访问真实网络。

## API 与 UI

- `POST /api/v1/edit/sessions` 增加 SCRIPT-only `usePexels`。
- `GET /api/v1/media-providers` 返回配置状态和最近限流信息。
- `POST /api/v1/media-providers/pexels/test` 使用服务端 provider 做最小连通性测试。
- 脚本页显示“本地素材优先 / Pexels 兜底”开关；未配置时在创建前给出可操作提示。
- 任务详情显示阶段、素材来源统计和 fallback 诊断。
