# n8n: Durable Execution Evidence

## Source-backed observations

`packages/cli/src/scaling/scaling.service.ts` initializes a Bull queue backed by Redis, registers queue listeners, starts a worker with configured concurrency and pauses/drains work during shutdown. Its `JobProcessor` (`scaling/job-processor.ts`) first reloads a persisted execution, sets it running, computes a bounded execution timeout and emits lifecycle events. `executions/execution.service.ts` exposes persisted execution state, retry relationships and cancellation/stop services.

## What to learn

1. Persist an execution before enqueuing work; the worker receives an ID, reloads truth from storage and writes lifecycle transitions back.
2. Treat broker retry and application-level recovery as distinct mechanisms. `JobProcessor` explicitly guards against a crashed execution being redundantly re-enqueued by separate mechanisms.
3. Worker lifecycle matters: queue pause, running-job drain, stalled-job policy, metrics and recovery are first-class operational code—not incidental background threads.
4. A node has typed inputs/configuration, a defined execution contract and structured output/error. This is a future extension model, not a mandate to ship a visual workflow editor.

## ContentOS application

ContentOS may later define `GenerateCopyNode`, `GenerateStoryboardNode`, `TTSNode`, `RenderVideoNode`, `PublishAdapterNode`, `FetchAnalyticsNode` and `ReviewNode`. V1 instead implements the same stages as fixed application use cases and jobs. Define ports so these use cases can later be represented as workflow nodes without changing domain records.

## Do not copy

Do not introduce a generic trigger system, expression engine, credential designer, arbitrary graph editor or n8n itself. They solve a broader integration-platform problem than ContentOS V1.
