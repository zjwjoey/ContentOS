# ContentOS Architecture V0 Validation

## Phase-1 proposal review

| Proposal | Decision | Validation |
|---|---|---|
| Modular Monolith | Retain | Fixed V1 orchestration, small team and local-first deployment favor one deployable Core with strict modules. |
| PostgreSQL | Retain | Job, dependency, attempt, project and audit records need transactional durable state. |
| Unified asset storage | Retain | Assets/manifests/render artifacts must be referenced by durable IDs rather than folders. |
| Persistent Job Queue | Retain, specify | Database is system of record; choose pg-boss first or BullMQ/Redis second after a focused implementation spike. |
| Video Worker | Retain | Separate process owns FFmpeg, staging directory, GPU probe, cancellation and manifest execution. |
| Publisher Worker | Retain | Separate process owns Playwright/browser sessions, adapter limits and human-action block states. |
| AI Provider layer | Add | Required before Director code; model registry and prompt provenance are V0 contracts. |
| Video Planner + Edit Manifest | Add | Required before any renderer; makes V1 explainable and leaves Remotion/template adoption possible later. |

## Final V0 shape

```text
Web/API Core (modular monolith)
  -> PostgreSQL: Project, Asset, Job, Attempt, PublishAttempt, PromptRun
  -> asset storage: originals, narration, manifests, artifacts
  -> durable queue
      -> Video Worker: Planner output -> FFmpeg -> artifact
      -> Publisher Worker: artifact -> Adapter -> PublishAttempt
```

The core creates and observes jobs; workers claim and report them. No microservice mesh, Kubernetes, generic workflow builder, Temporal, n8n or Remotion runtime is required for V1.

## Top risks

### Technical

1. FFmpeg filter/transition behavior varies by codec and source metadata.
2. GPU encoder availability differs on Windows installations.
3. Browser automation selectors/platform policies change without notice.
4. LLM structured output is probabilistic and provider capabilities differ.
5. Asset paths, cleanup and storage capacity can corrupt reproducibility if unmanaged.

### Architecture

1. Treating the broker as truth rather than the Job table loses audit/recovery.
2. Allowing renderer/publisher to make planning decisions destroys explainability.
3. Overgeneralizing V1 into an arbitrary workflow system delays delivery.
4. Sharing browser contexts across accounts risks credential leakage and account contamination.
5. Direct module/database access erodes boundaries before worker split is needed.

### Long-term maintenance

1. Platform adapter drift and re-authentication burden.
2. Prompt/model changes break historical reproducibility without provenance.
3. Media code turns into untestable command-string sprawl without manifest fixtures.
4. Queue migration becomes expensive if job contracts are vendor-specific.
5. Copyleft/custom licensing can silently restrict integration choices.

## Is a third research round necessary?

**No prerequisite Phase 3 is required before formal ContentOS Architecture V0 design.** Evidence now supports the key boundaries and V1 choices. Only conduct focused follow-up spikes when choosing the actual backend language/queue library, validating representative FFmpeg transitions on target Windows hardware, and verifying target-platform publishing policy/permission constraints.
