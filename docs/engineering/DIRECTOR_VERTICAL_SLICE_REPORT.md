# Director V1 Vertical Slice Report

日期：2026-08-22
分支：`codex/director-v1`
验证数据库：现有 PostgreSQL 16 实例上的 `contentos_director_dev`（端口 55433）

## 结果

Director V1 已形成一条可审计的 Fake Provider 垂直切片：

```text
ContentProject
  -> ContentBrief V1
  -> DIRECTOR_GENERATE_SCRIPT Job
  -> accepted ScriptRevision
  -> DIRECTOR_GENERATE_STORYBOARD Job
  -> approved StoryboardRevision
  -> VIDEO_RENDER Job
  -> EDIT_MANIFEST_V0 + FFmpeg Render
```

全链路 E2E 通过，最终输出为 1080x1920、带音频的 MP4。Manifest、Render diagnostics 和 Job payload 均保留 `briefId`、`scriptRevisionId`、`storyboardRevisionId`，可从最终 Render 回溯到 Director 版本。

## 已交付范围

- 保留 `DIRECTOR_PLAN_V0` 兼容路径；新增 ContentBrief、ScriptRevision、StoryboardRevision 和 Director-owned current state。
- 新增 0007 Director V1、0008 AI provenance 迁移，包含状态行锁、修订计数器、项目复合外键、source Job 唯一约束和 AI Run provenance。
- 新增 provider-neutral AI contract、PromptRegistry、FakeAIProvider、结构校验和 AI Run 成功/失败记录。
- 新增两个且仅两个 Director Job：`DIRECTOR_GENERATE_SCRIPT`、`DIRECTOR_GENERATE_STORYBOARD`。
- 新增受监督边界定义的 `workers/director-worker`；API 只入队，Worker 通过现有 JobRunner/lease/attempt 执行。
- 新增 Director V1 API 和最小 Next Operator UI；UI 不包含时间线、工作流图或凭据字段。
- approved pair 到 Video 的 provenance bridge 保持旧 Manifest 兼容，Renderer 不读取创意 metadata。

## 验证证据

| 层 | 结果 |
|---|---:|
| Director/AI contract focused tests | 7 passed, 0 failed |
| Migration integration tests | 4 passed, 0 failed |
| AI unit/integration tests | 5 passed, 0 failed |
| Director V1 integration tests | 3 passed, 0 failed |
| Worker + legacy worker regression | 5 passed, 0 failed |
| API + legacy API regression | 3 passed, 0 failed |
| Video provenance + legacy Video regression | 8 passed, 0 failed |
| Operator UI static smoke | 1 passed, 0 failed |
| Director → Video → FFmpeg E2E | 1 passed, 0 failed |
| Web production build | passed |
| Root TypeScript typecheck | passed |

## AI Provider Sandbox

**REAL PROVIDER SANDBOX = BLOCKED.** 本轮没有选定真实 Provider，也没有提供经授权的 API key、模型账号、secret reference 或沙箱项目；因此未发出任何真实 AI 请求。Fake Provider 和所有边界/失败分类测试通过，但这不代表真实 Provider 的质量、成本、限流和敏感数据策略已验证。

## 安全与边界检查

- Job payload 只包含项目/版本/聚合 ID、模型 profile 引用和 correlation ID。
- 普通日志、UI 响应和 Job 状态接口不返回 API key、Cookie、token、授权头、浏览器 profile 或完整秘密。
- PostgreSQL 是业务事实源；队列只表达 delivery state。Lease recovery、幂等、取消和错误分类仍走既有 Job contract。
- Director Worker 不读取 Video、Publisher、Review 私有表；Renderer 只执行已验证 Manifest。
- 未调用真实平台、真实 AI、TTS、benchmark scraping 或自动反馈改写全局 Prompt。

## 已知限制

- Fake Provider 的文本质量不可作为生产文案质量证明；见 `docs/product/DIRECTOR_QUALITY_BACKLOG.md`。
- 真实 Provider Sandbox、模型成本/延迟、内容安全和事实核验仍待单独授权和评审。
- Publisher 账号/发布记录、Douyin/WeChat 真实适配器、Metric Snapshot 和 Performance Review 不在本切片。
- Video 当前沿用既有 MPEG-4 输出声明；需求中的 H.264 差异未在本切片中静默修改。
