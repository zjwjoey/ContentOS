# ContentOS Phase 1 Cross-Project Comparison

**Scope:** MatrixMedia, AI Short Video Factory, MoneyPrinterTurbo, AutoSocial, Postiz only. Conclusions are traceable to the five reports in `research/reports/` and the version inventory in `research/notes/repository-inventory.md`.

| Capability | Best reference | Second reference | ContentOS recommendation |
|---|---|---|---|
| Control plane | Postiz | AutoSocial | Web control plane with project-centric UI; never let UI own business state. |
| Content project | Postiz | MoneyPrinterTurbo | Add a first-class `ContentProject` independent of any render or post. |
| Workflow | Postiz | MoneyPrinterTurbo | Start fixed application workflows; reserve generic node graphs for a later plugin layer. |
| Task queue | Postiz / Temporal | MoneyPrinterTurbo | Use durable Job records and an external worker queue; do not rely on Electron or cron. |
| Director | MoneyPrinterTurbo | AI Short Video Factory | Separate prompt/script/storyboard services from video jobs. |
| AI provider | MoneyPrinterTurbo | Postiz | Define provider-neutral `LLMProvider` interfaces/configuration. |
| Video pipeline | MoneyPrinterTurbo | AI Short Video Factory | V1 direct FFmpeg pipeline using a deterministic Edit Manifest. |
| FFmpeg | AI Short Video Factory | MoneyPrinterTurbo | Generate, store and test FFmpeg command plans; run them only in Video Workers. |
| Video jobs | MoneyPrinterTurbo | Postiz | Persist progress, attempts, artifacts, cancellation and failure reason. |
| Publisher | Postiz | MatrixMedia | Use typed platform adapters and separate browser workers for unsupported/public APIs. |
| Multi-account | MatrixMedia | AutoSocial | Scope credentials and sessions by `Account + Platform`; encrypt secrets outside business tables. |
| Adapter | Postiz | MatrixMedia | Stable adapter contracts; registry/manifest eventually replaces static switch lists. |
| Analytics | Postiz | MatrixMedia | Store raw snapshots and normalized metrics by PublishAttempt, then build derived views. |
| Plugin | Postiz | MatrixMedia | Begin with internal extension contracts, not arbitrary third-party runtime plugins. |
| Monorepo | Postiz | — | `apps` for deployables and `packages` for contracts/domain/shared utilities. |
| Logging | Postiz | MoneyPrinterTurbo | Structured logs correlated by Project ID, Job ID and PublishAttempt ID. |
| Retry | Postiz | MoneyPrinterTurbo | Policy-based retry with idempotency keys; manual retry must create an auditable attempt. |
| Config | MoneyPrinterTurbo | MatrixMedia | Typed configuration and per-provider credentials, with configuration snapshots attached to jobs. |
| Database | Postiz | MoneyPrinterTurbo | PostgreSQL for control-plane truth; object/local storage for assets; no filesystem-as-state. |

## A. What each project contributes most

- **MatrixMedia:** browser-session/account isolation and a single publishing service shared by GUI, CLI and HTTP entry points.
- **AI Short Video Factory:** a deliberately narrow local render flow (assets + voice + subtitles + FFmpeg) and visible progress/cancellation.
- **MoneyPrinterTurbo:** staged video generation, task artifacts, optional task-manager backends and model-provider abstraction.
- **AutoSocial:** concrete operational semantics for pending/posted/failed files and moving sidecar captions atomically with their video.
- **Postiz:** the control-plane architecture: monorepo boundaries, Social Provider abstraction, persistence-backed scheduling and durable workflow execution.

## B. Designs that combine cleanly

1. Postiz-style control plane + MoneyPrinterTurbo-style stage services + AI Short Video Factory’s narrow FFmpeg V1 are compatible when jobs are the crossing point.
2. MatrixMedia’s per-account browser session handling fits behind a Postiz-style Publisher Adapter and a dedicated browser worker.
3. AutoSocial’s pending/posted/failed lifecycle can become `PublishAttempt` state transitions, with file moves replaced by database records and asset storage operations.

## C. Designs that conflict

1. Electron-local IPC/state (MatrixMedia and AI Short Video Factory) conflicts with server workers and shared durable control-plane data; it should be treated as a desktop-client concern only.
2. AutoSocial’s filesystem queue and cron scheduler conflict with idempotent multi-worker jobs and auditable retries.
3. In-process futures/thread pools (MoneyPrinterTurbo) cannot be the sole job backbone if ContentOS must survive process restarts; use them only inside a worker after a durable job claim.
4. Static provider lists (Postiz) are a transitional pattern, not the final plugin objective; a future ContentOS adapter SDK needs versioned manifests.

## D. Projects suitable for direct use

None is suitable as a ContentOS foundation. **MoneyPrinterTurbo** and **AutoSocial** are MIT and therefore potential sources for small, reviewed, dependency-light extractions only; this is not authorization to copy them. MatrixMedia (GPL), AI Short Video Factory (AGPL), and Postiz (AGPL) are design references only.

## E. Design-only references

MatrixMedia, AI Short Video Factory and Postiz must remain design references due to copyleft licensing. The architecture of all five is informative; none should be forked into ContentOS.

## F. Current recommended architecture

Adopt a **modular monolith with independent workers**, not microservices:

```text
ContentOS monorepo
├─ apps/web                 # control plane UI
├─ apps/api                 # auth, project and query APIs
├─ apps/worker-video        # FFmpeg execution only
├─ apps/worker-publisher    # API/browser adapter execution only
├─ packages/domain          # ContentProject, Asset, Job, PublishAttempt contracts
├─ packages/director        # script/storyboard use cases and AI provider ports
├─ packages/video           # EditManifest planning; no platform logic
├─ packages/publisher       # adapter contracts, account scope and publish use cases
├─ packages/review          # metric normalization and analytics queries
└─ packages/shared          # validation, observability and configuration primitives
```

PostgreSQL stores control-plane state; local/object storage holds assets and render artifacts; a durable queue/workflow layer claims jobs. The API creates `Job` records and workers report events/progress. The Video Worker returns `RenderArtifact + EditManifest`; the Publisher Worker consumes only approved artifacts and produces `PublishAttempt` records. Start with a fixed orchestration service rather than a general n8n-like designer.

## G. Recommended Phase 2 additions

1. **OpenShorts** — validate video service/worker split and long-running API task handling.
2. **Remotion** — evaluate as an optional template/preview layer, not as the V1 FFmpeg replacement.
3. **matrix** and **douyin-web** — compare Chinese platform browser-automation/account boundaries with MatrixMedia.
4. **n8n** — study workflow node/execution/credential boundaries before designing ContentOS’s later workflow extension point.
5. **Open WebUI** and **AnythingLLM** — validate AI provider/configuration design before committing Director contracts.
