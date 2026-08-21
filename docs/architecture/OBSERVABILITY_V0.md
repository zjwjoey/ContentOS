# Observability V0

## Signals

V0 uses structured JSON logs, metrics and trace/correlation propagation. Every request, Job and worker attempt carries a `correlationId`; domain records add `projectId`, `jobId`, `attemptId`, `assetId`, `renderId`, `publishRequestId`, `providerId` or `adapterId` when applicable.

| Signal | Minimum fields |
|---|---|
| API event | route, outcome code, actor ID, correlation ID, latency |
| Job event | job/attempt/type/state, worker ID, lease timing, retry class |
| Video event | manifest/render/revision, FFmpeg version, media validation summary |
| Publisher event | request/account/adapter, safe stage, external-state certainty |
| AI event | capability, provider/model, prompt version, usage/cost bucket, outcome |

## Event vocabulary

Use stable names such as `job.queued`, `job.claimed`, `job.retry_scheduled`, `render.validation_failed`, `asset.promoted`, `publish.external_state_unknown`, `ai.schema_invalid`, and `review.decision_recorded`. Events contain redacted summaries; detailed sensitive artifacts remain behind access controls or are omitted.

## Metrics and alerts

Track queue depth/age, success/failure/retry rate by type, lease recovery count, render duration and validation failure, staging disk use, publish uncertainty/re-auth rate, adapter throttle rate, AI latency/token/cost bucket and API error rate. Alert first on stuck queue age, repeated lease expiry, storage exhaustion, publish uncertainty and credential re-auth spikes.

Logs must not contain raw prompts when they may include sensitive content, media bytes, cookies, tokens, Authorization headers or absolute personal paths. Debug capture requires an authorized, time-limited policy and records its access.
