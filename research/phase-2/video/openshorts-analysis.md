# OpenShorts: Video-Engine Evidence

## Questions and source evidence

**A1 — stages.** OpenShorts separates a Python application pipeline from a Node render service. `render-service/src/server.ts` validates a render request, creates a `RenderJob`, then calls `executeRender` asynchronously. `render-worker.ts` bundles/selects the `ShortVideo` composition, renders it with `@remotion/renderer`, writes output and updates progress. `ffmpeg_utils.py` centralizes encoder selection and probes NVENC once with cached fallback.

**A2 — UI/API separation.** The Express render endpoint is independent from dashboard compositions: the API accepts serializable props and serves a shared output directory. This separation is useful. However, the render service imports its job map from the HTTP server, so it is not a true worker boundary.

**A3 — long-task state.** `server.ts` keeps `renderJobs` in a `Map`; states are only `queued`, `rendering`, `done`, `error`. A process restart loses status, progress and recovery information. It has neither retry nor cancellation.

**A4 — adoptable patterns.** Use request schema validation, render input props, output-per-job directories, explicit progress callbacks, and central GPU capability probing. In ContentOS, replace the in-memory map with `Job` + `RenderArtifact` persistence and write an Edit Manifest before rendering.

**A5 — outside V1.** Remotion compositions, hooks/effects props, cloud video access and dashboard preview are not necessary for local-material random assembly, narration, basic subtitle and five simple transitions.

## Verdict

OpenShorts supports the Planner/Renderer separation but is counter-evidence for using in-memory render state. ContentOS V1 should not reproduce its Remotion render service architecture.
