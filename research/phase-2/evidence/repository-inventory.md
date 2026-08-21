# Phase-2 Evidence Inventory

Retrieved 2026-08-21. All source-path claims in Phase-2 documents are pinned to these revisions. Remote source was read only; no project was built or executed.

| Project | Branch | Commit SHA | License | Evidence provenance |
|---|---|---|---|---|
| OpenShorts | main | `8fb5e3b7b6c9f5661c925cb6ac1d61f33edeacc7` | repository metadata: NOASSERTION | GitHub API tree + raw `render-service/src/{server,render-worker}.ts`, `ffmpeg_utils.py`; shallow clone interrupted |
| Remotion | main | `eb83fdfe6ef579942fba82a3bc1c4614a4ea90b4` | custom Remotion License; captions package MIT | GitHub tree + raw `LICENSE.md`, `packages/{renderer,player,captions}/package.json` |
| matrix | main | `56bb5976a458e652d30e8e09314a007d34973817` | Apache-2.0 | GitHub API tree + raw `publish_video_queue.py`, `douyin_uploader/main.py` |
| douyin-web | master | `000d96628c614fa84b1f81ade452e52bd2e9fe7d` | MIT | GitHub API tree + raw `app.py`, `browser.py`, `db.py` |
| n8n | master | `b821298c73d123391c251a8fd6cfab8c13279f36` | repository metadata: NOASSERTION | raw `packages/cli/src/scaling/{job-processor,scaling.service}.ts`, `executions/execution.service.ts` |
| Open WebUI | main | `01f4282f1ffe0d6212f58d3afbeae21fffd0c4be` | repository metadata: NOASSERTION | raw `backend/open_webui/{routers/openai,routers/ollama,models/models}.py` |
| AnythingLLM | master | `c8bd6442e6b6eee8d08a761452960f7f77e334a9` | MIT | GitHub API directory evidence under `server/utils/AiProviders`, `EmbeddingEngines`, and `vectorDbProviders` |

## Retrieval exception

The local execution window terminated the OpenShorts shallow clone before checkout. It is retained only as a diagnostic remnant; remote code pinned above is the sole evidence for this analysis.
